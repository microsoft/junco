import { isAbsolute, resolve as resolveNodePath } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createGrepToolDefinition as createPiGrepToolDefinition,
  formatSize,
  type GrepToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EditStore, GrepMatch, NativeMux } from "../native/index.js";
import type { NativeModule } from "./native.js";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import {
  DEFAULT_MAX_BYTES,
  displayToolPath,
  requireU32,
  resolveToolPath,
  throwIfAborted,
  truncateHead,
  truncateLine,
  withNativeSignal,
} from "./tool-support.js";

const GREP = {
  resource: "operations",
  category: "grep",
  tool: "grep",
  operation: "search",
} as const;

function grepMetrics({ details }: AgentToolResult<NativeGrepToolDetails>) {
  const counters: Record<string, number> = {
    matches: details.totalMatches,
    files_with_matches: details.filesWithMatches,
    files_searched: details.filesSearched,
    match_limit_reached: Number(details.matchLimitReached !== undefined),
    lines_truncated: Number(details.linesTruncated === true),
  };
  if (details.skippedOversized !== undefined)
    counters.skipped_oversized = details.skippedOversized;
  return { counters };
}

const DEFAULT_LIMIT = 100;

/** Native `maxColumns`; rows longer than this come back as a `...`-suffixed prefix. */
const NATIVE_MAX_COLUMNS = 500;

/** Native grep emits `str::trim_end`ed lines, which trims Unicode White_Space. */
const TRAILING_WHITESPACE = /\p{White_Space}+$/u;

const SNAPSHOT_MISMATCH =
  "Search output does not match the current snapshot; read before editing.";

const DESCRIPTION =
  "Search file contents using Rust regex with PCRE2 fallback. Complete displayed lines include " +
  "hashline edit anchors. Defaults: 100 matches, 500 UTF-8 bytes per native line, 50 KiB output. " +
  "Respects .gitignore and includes hidden files.";

/** Pi's grep details plus the native engine's own scalar counters. */
export interface NativeGrepToolDetails extends GrepToolDetails {
  totalMatches: number;
  filesWithMatches: number;
  filesSearched: number;
  skippedOversized?: number;
}

interface Section {
  displayPath: string;
  absolutePath: string;
  tag?: string;
  eligible: number[];
}

interface CollectedRow {
  lineNumber: number;
  nativeLine: string;
  isMatch: boolean;
  nativeTruncated: boolean;
}

type Entry =
  | { kind: "blank" | "notice" | "gap"; text: string }
  | { kind: "header"; text: string; section: Section }
  | { kind: "row"; text: string; section: Section; eligibleLine?: number };

/**
 * Merge a native row into a file's line map.
 *
 * Context windows around adjacent matches overlap; a line that is both a match
 * and someone else's context must render as a match.
 */
function mergeRow(rows: Map<number, CollectedRow>, row: CollectedRow): void {
  const existing = rows.get(row.lineNumber);
  if (existing && !(row.isMatch && !existing.isMatch)) return;
  rows.set(row.lineNumber, row);
}

function collectRows(matches: GrepMatch[]): CollectedRow[] {
  const rows = new Map<number, CollectedRow>();
  for (const match of matches) {
    for (const context of match.contextBefore ?? []) {
      mergeRow(rows, {
        lineNumber: context.lineNumber,
        nativeLine: context.line,
        isMatch: false,
        nativeTruncated: false,
      });
    }
    mergeRow(rows, {
      lineNumber: match.lineNumber,
      nativeLine: match.line,
      isMatch: true,
      nativeTruncated: match.truncated === true,
    });
    for (const context of match.contextAfter ?? []) {
      mergeRow(rows, {
        lineNumber: context.lineNumber,
        nativeLine: context.line,
        isMatch: false,
        nativeTruncated: false,
      });
    }
  }
  return [...rows.values()].sort(
    (left, right) => left.lineNumber - right.lineNumber,
  );
}

interface RenderedRow {
  text: string;
  eligible: boolean;
  shortened: boolean;
}

/**
 * Render one native row against the recorded snapshot.
 *
 * Returns `undefined` when a row the snapshot says is complete disagrees with
 * what native emitted, which invalidates the whole file's anchor.
 */
function renderRow(
  row: CollectedRow,
  snapshotLines: string[] | undefined,
): RenderedRow | undefined {
  const prefix = row.isMatch ? "*" : " ";
  const shortenedNative = {
    text: `${prefix}${row.lineNumber}:${row.nativeLine}`,
    eligible: false,
  };
  if (!snapshotLines)
    return { ...shortenedNative, shortened: row.nativeTruncated };

  const source = snapshotLines[row.lineNumber - 1];
  if (source === undefined) return undefined;
  const trimmed = source.replace(TRAILING_WHITESPACE, "");
  // The snapshot has its BOM stripped; a native reader may still emit it.
  const emitted =
    row.lineNumber === 1 && row.nativeLine.startsWith("\ufeff")
      ? row.nativeLine.slice(1)
      : row.nativeLine;
  // Context rows carry no `truncated` flag, so infer it the same way native
  // decided: byte length of the trimmed line against `maxColumns`.
  const shortened = row.isMatch
    ? row.nativeTruncated
    : Buffer.byteLength(trimmed, "utf-8") > NATIVE_MAX_COLUMNS;
  if (shortened) return { ...shortenedNative, shortened: true };
  if (emitted !== trimmed) return undefined;

  const rendered = truncateLine(source);
  return {
    text: `${prefix}${row.lineNumber}:${rendered.text}`,
    eligible: !rendered.wasTruncated,
    shortened: rendered.wasTruncated,
  };
}

/**
 * Pi's grep tool backed by the native Rust engine.
 *
 * `GrepOperations` only swaps stat/context reads — Pi still spawns `rg` — so
 * `execute` is replaced outright. The search is a routed marsh read through
 * `mux`, which also records each matched file's snapshot from the bytes it
 * searched. Displayed rows that provably match that snapshot carry hashline
 * provenance; anything native shortened, could not verify, or that did not
 * survive the output cap does not.
 */
export const GrepTool = {
  create(
    cwd: string,
    store: EditStore,
    native: NativeModule,
    mux: NativeMux,
    recorder?:
      | ProfileRecorder<"operations">
      | (() => ProfileRecorder<"operations"> | undefined),
  ): AgentTool<
    ReturnType<typeof createPiGrepToolDefinition>["parameters"],
    NativeGrepToolDetails
  > {
    const base = createPiGrepToolDefinition(cwd);
    const tool = {
      ...base,
      description: DESCRIPTION,
      execute(_toolCallId, params, signal) {
        return profileToolCall(
          captureRecorder(recorder),
          GREP,
          signal,
          async () => {
            throwIfAborted(signal);
            const limit =
              params.limit === undefined
                ? DEFAULT_LIMIT
                : requireU32("limit", params.limit, 1);
            const context =
              params.context === undefined
                ? undefined
                : requireU32("context", params.context, 0);
            const root = resolveToolPath(cwd, params.path ?? ".");
            const pattern = params.literal
              ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              : params.pattern;

            const { result, snapshots } = await withNativeSignal(
              signal,
              (nativeSignal) =>
                mux.grep(
                  cwd,
                  {
                    pattern,
                    path: root,
                    glob: params.glob,
                    ignoreCase: params.ignoreCase,
                    mode: native.GrepOutputMode.Content,
                    hidden: true,
                    gitignore: true,
                    maxColumns: NATIVE_MAX_COLUMNS,
                    maxCount: limit,
                    context,
                    signal: nativeSignal,
                  },
                  store,
                ),
            );
            throwIfAborted(signal);
            const tags = new Map<string, string | undefined>(
              snapshots.map((snapshot) => [snapshot.path, snapshot.tag]),
            );

            const details: NativeGrepToolDetails = {
              totalMatches: result.totalMatches,
              filesWithMatches: result.filesWithMatches,
              filesSearched: result.filesSearched,
            };
            if (result.skippedOversized != null)
              details.skippedOversized = result.skippedOversized;
            if (result.limitReached) details.matchLimitReached = limit;
            if (result.matches.length === 0) {
              return {
                content: [{ type: "text", text: "No matches found" }],
                details,
              };
            }

            const byPath = new Map<string, GrepMatch[]>();
            for (const match of result.matches) {
              const existing = byPath.get(match.path);
              if (existing) existing.push(match);
              else byPath.set(match.path, [match]);
            }

            const entries: Entry[] = [];
            const sections: Section[] = [];
            let linesTruncated = false;
            for (const [nativePath, matches] of byPath) {
              const absolutePath = isAbsolute(nativePath)
                ? nativePath
                : resolveNodePath(root, nativePath);
              const section: Section = {
                displayPath: displayToolPath(cwd, absolutePath),
                absolutePath,
                eligible: [],
              };
              // Native omits notebooks from snapshots: raw JSON cannot anchor decoded cells.
              const tag = tags.get(nativePath) ?? null;
              const snapshot = tag ? store.byHashText(absolutePath, tag) : null;
              let snapshotLines =
                snapshot !== null && !snapshot.includes("\0")
                  ? snapshot.split("\n")
                  : undefined;
              if (snapshotLines) section.tag = tag ?? undefined;

              const rows = collectRows(matches);
              let rendered = rows.map((row) => renderRow(row, snapshotLines));
              if (rendered.some((row) => row === undefined)) {
                // A row the snapshot claims is complete did not match what native
                // read: the file changed under us, so no anchor from this section.
                section.tag = undefined;
                snapshotLines = undefined;
                rendered = rows.map((row) => renderRow(row, undefined));
              }

              if (entries.length > 0) entries.push({ kind: "blank", text: "" });
              entries.push({
                kind: "header",
                text: headerText(section, native),
                section,
              });
              if (!snapshotLines && tag)
                entries.push({ kind: "notice", text: SNAPSHOT_MISMATCH });
              let previousLine: number | undefined;
              rows.forEach((row, index) => {
                const view = rendered[index];
                if (!view) return;
                if (
                  previousLine !== undefined &&
                  row.lineNumber > previousLine + 1
                ) {
                  entries.push({ kind: "gap", text: "..." });
                }
                previousLine = row.lineNumber;
                if (view.shortened) linesTruncated = true;
                entries.push({
                  kind: "row",
                  text: view.text,
                  section,
                  eligibleLine: view.eligible ? row.lineNumber : undefined,
                });
              });
              sections.push(section);
            }

            const truncation = truncateHead(
              entries.map((entry) => entry.text).join("\n"),
              {
                maxLines: Number.MAX_SAFE_INTEGER,
                maxBytes: DEFAULT_MAX_BYTES,
              },
            );
            // One entry is exactly one output line: native rows are line-based and
            // snapshot lines never contain a newline.
            const survivors = entries.slice(0, truncation.outputLines);
            for (const entry of survivors) {
              if (entry.kind === "row" && entry.eligibleLine !== undefined) {
                entry.section.eligible.push(entry.eligibleLine);
              }
            }
            // A tagged header whose anchorable rows all fell past the cap would
            // advertise provenance the model never received.
            for (const section of sections) {
              if (section.eligible.length === 0) section.tag = undefined;
              else if (section.tag) {
                store.recordSeenLines(
                  section.absolutePath,
                  section.tag,
                  section.eligible,
                );
              }
            }

            let text = survivors
              .map((entry) =>
                entry.kind === "header"
                  ? headerText(entry.section, native)
                  : entry.text,
              )
              .join("\n");
            const notices: string[] = [];
            if (result.limitReached)
              notices.push(`${limit} match limit reached`);
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }
            if (linesTruncated) details.linesTruncated = true;
            if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
            return { content: [{ type: "text", text }], details };
          },
          grepMetrics,
        );
      },
    } satisfies ToolDefinition<
      ReturnType<typeof createPiGrepToolDefinition>["parameters"],
      NativeGrepToolDetails
    >;
    return markProfileOwned(tool, () => GREP);
  },
};

function headerText(section: Section, native: NativeModule): string {
  return section.tag
    ? native.hashlineFormatHeader(section.displayPath, section.tag)
    : `[${section.displayPath}]`;
}
