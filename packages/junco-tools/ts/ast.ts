import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AstFindResult,
  AstMatchStrictness,
  AstReplaceResult,
  NativeMux,
} from "../native/index.js";
import type { ToolCollection } from "./collection.js";
import type { NativeModule } from "./native.js";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import {
  type BoundedToolDetails,
  boundedToolResult,
  NATIVE_U32_MAX,
  requireU32,
  resolveToolPath,
  throwIfAborted,
  withNativeSignal,
} from "./tool-support.js";

const STRICTNESS_VALUES = [
  "cst",
  "smart",
  "ast",
  "relaxed",
  "signature",
  "template",
] as const;

const strictnessSchema = Type.Optional(
  Type.Union(
    STRICTNESS_VALUES.map((value) => Type.Literal(value)),
    { description: "Pattern strictness; defaults to smart matching." },
  ),
);

const scopeSchema = {
  path: Type.Optional(
    Type.String({
      description: "File or directory to scan (default: current directory)",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description: "Glob filter relative to the search root, e.g. '**/*.ts'",
    }),
  ),
  lang: Type.Optional(
    Type.String({
      description: "Language override; otherwise inferred per file extension",
    }),
  ),
  selector: Type.Optional(
    Type.String({
      description: "Rule selector for multi-rule ast-grep configurations",
    }),
  ),
  strictness: strictnessSchema,
};

const astGrepSchema = Type.Object({
  patterns: Type.Array(Type.String(), {
    description: "ast-grep patterns; a file matches when any pattern matches",
  }),
  ...scopeSchema,
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: NATIVE_U32_MAX,
      description: "Maximum matches (default: 50)",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: NATIVE_U32_MAX,
      description: "Matches to skip (default: 0)",
    }),
  ),
  includeMeta: Type.Optional(
    Type.Boolean({
      description: "Include meta-variable bindings per match (default: false)",
    }),
  ),
});

const astEditSchema = Type.Object({
  rewrites: Type.Record(Type.String(), Type.String(), {
    description:
      "Map of ast-grep pattern to replacement template; an empty template deletes",
  }),
  ...scopeSchema,
  dryRun: Type.Optional(
    Type.Boolean({ description: "Preview without writing (default: true)" }),
  ),
  maxReplacements: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: NATIVE_U32_MAX,
      description: "Cap on applied replacements",
    }),
  ),
  maxFiles: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: NATIVE_U32_MAX,
      description: "Cap on modified files",
    }),
  ),
  failOnParseError: Type.Optional(
    Type.Boolean({
      description: "Fail the run when a file cannot be parsed (default: false)",
    }),
  ),
});

/**
 * Structural search over files with ast-grep patterns, as a routed marsh read
 * through `mux`, which `native` created.
 *
 * Match slices are spans, not full-line reads, so they intentionally grant no
 * hashline provenance: the model still needs `read` or `grep` for edit anchors.
 */
export const AstGrepTool = {
  create(
    cwd: string,
    _native: NativeModule,
    mux: NativeMux,
    recorder?:
      | ProfileRecorder<"operations">
      | (() => ProfileRecorder<"operations"> | undefined),
  ): AgentTool<typeof astGrepSchema, BoundedToolDetails<AstFindResult>> {
    const operation = {
      resource: "operations",
      category: "AstGrep",
      tool: "ast_grep",
      operation: "search",
    } as const;
    const tool = {
      name: "ast_grep",
      label: "AST Grep",
      description:
        "Search files with AST structural patterns; use read or grep for hashline edit anchors.",
      promptSnippet: "Search code by AST structure instead of text",
      parameters: astGrepSchema,
      execute(_toolCallId, params, signal) {
        const scope = captureRecorder(recorder);
        let responseBytes = 0;
        return profileToolCall(
          scope,
          operation,
          signal,
          async () => {
            throwIfAborted(signal);
            const patterns = params.patterns.filter(
              (pattern) => pattern.trim() !== "",
            );
            if (patterns.length === 0)
              throw new Error("patterns must contain at least one pattern");
            if (params.limit !== undefined)
              requireU32("limit", params.limit, 1);
            if (params.offset !== undefined)
              requireU32("offset", params.offset, 0);

            const result = await withNativeSignal(signal, (nativeSignal) =>
              mux.astGrep(cwd, {
                patterns,
                path: resolveToolPath(cwd, params.path ?? "."),
                glob: params.glob,
                lang: params.lang,
                selector: params.selector,
                strictness: params.strictness as AstMatchStrictness | undefined,
                limit: params.limit,
                offset: params.offset,
                includeMeta: params.includeMeta,
                signal: nativeSignal,
              }),
            );
            throwIfAborted(signal);
            const text = JSON.stringify(result, null, 2);
            if (scope !== undefined)
              responseBytes = Buffer.byteLength(text, "utf8");
            return boundedToolResult(text, result);
          },
          ({ details: { result } }) => ({
            counters: {
              matches_returned: result.matches.length,
              matches: result.totalMatches,
              files_with_matches: result.filesWithMatches,
              files_searched: result.filesSearched,
              limit_reached: Number(result.limitReached),
              ...(result.parseErrors === undefined
                ? {}
                : { parse_errors: result.parseErrors.length }),
              response_bytes: responseBytes,
            },
          }),
        );
      },
    } satisfies ToolDefinition<
      typeof astGrepSchema,
      BoundedToolDetails<AstFindResult>
    >;
    return markProfileOwned(tool, () => operation);
  },
};

/**
 * Structural rewrite of files with ast-grep patterns.
 *
 * Previews by default; only an explicit `dryRun: false` writes. There is no
 * proposal queue in this package, so an applying call is a routed marsh edit
 * through `mux`: the mux's policy may run it in a private snapshot whose
 * changes publish only when marsh authorizes them. Either way it invalidates
 * the walker's scan cache for the search root.
 */
export const AstEditTool = {
  create(
    cwd: string,
    native: NativeModule,
    mux: NativeMux,
    recorder?:
      | ProfileRecorder<"edits">
      | (() => ProfileRecorder<"edits"> | undefined),
  ): AgentTool<typeof astEditSchema, BoundedToolDetails<AstReplaceResult>> {
    // Only an explicit `dryRun: false` writes; anything else is a preview.
    const operationOf = (args: unknown) =>
      ({
        resource: "edits",
        category: "AstEdit",
        tool: "ast_edit",
        operation:
          typeof args === "object" &&
          args !== null &&
          (args as { dryRun?: unknown }).dryRun === false
            ? "apply"
            : "preview",
      }) as const;
    const tool = {
      name: "ast_edit",
      label: "AST Edit",
      description:
        "Preview structural rewrites by default; set dryRun to false to apply them.",
      promptSnippet: "Rewrite code by AST structure",
      parameters: astEditSchema,
      executionMode: "sequential",
      execute(_toolCallId, params, signal) {
        const scope = captureRecorder(recorder);
        let responseBytes = 0;
        return profileToolCall(
          scope,
          operationOf(params),
          signal,
          async () => {
            throwIfAborted(signal);
            const rewrites: Record<string, string> = {};
            for (const [pattern, replacement] of Object.entries(
              params.rewrites,
            )) {
              if (pattern.trim() !== "") rewrites[pattern] = replacement;
            }
            if (Object.keys(rewrites).length === 0) {
              throw new Error("rewrites must contain at least one pattern");
            }
            if (params.maxReplacements !== undefined)
              requireU32("maxReplacements", params.maxReplacements, 1);
            if (params.maxFiles !== undefined)
              requireU32("maxFiles", params.maxFiles, 1);

            const root = resolveToolPath(cwd, params.path ?? ".");
            const applying = params.dryRun === false;
            let result: AstReplaceResult;
            try {
              result = await withNativeSignal(signal, (nativeSignal) =>
                mux.astEdit(cwd, {
                  rewrites,
                  path: root,
                  glob: params.glob,
                  lang: params.lang,
                  selector: params.selector,
                  strictness: params.strictness as
                    | AstMatchStrictness
                    | undefined,
                  dryRun: params.dryRun,
                  maxReplacements: params.maxReplacements,
                  maxFiles: params.maxFiles,
                  failOnParseError: params.failOnParseError,
                  signal: nativeSignal,
                }),
              );
            } finally {
              // Runs even on failure: a partially applied rewrite must not leave the
              // walker cache advertising pre-edit bytes.
              if (applying) native.invalidateFsScanCache(root);
            }
            throwIfAborted(signal);
            const text = JSON.stringify(result, null, 2);
            if (scope !== undefined)
              responseBytes = Buffer.byteLength(text, "utf8");
            return boundedToolResult(text, result);
          },
          ({ details: { result } }) => {
            let deleted = 0;
            let inserted = 0;
            for (const change of result.changes) {
              deleted += change.deletedLength;
              inserted += Buffer.byteLength(change.after, "utf8");
            }
            return {
              counters: {
                replacements: result.totalReplacements,
                files_touched: result.filesTouched,
                files_searched: result.filesSearched,
                change_records: result.changes.length,
                file_change_records: result.fileChanges.length,
                deleted_bytes: deleted,
                inserted_bytes: inserted,
                net_bytes: inserted - deleted,
                limit_reached: Number(result.limitReached),
                ...(result.parseErrors === undefined
                  ? {}
                  : { parse_errors: result.parseErrors.length }),
                response_bytes: responseBytes,
              },
            };
          },
        );
      },
    } satisfies ToolDefinition<
      typeof astEditSchema,
      BoundedToolDetails<AstReplaceResult>
    >;
    return markProfileOwned(tool, operationOf);
  },
};

/** Exact, 1-based baseline lines, without line terminators; an empty beforeLines inserts. */
export type SourceEdit = {
  readonly path: string;
  readonly startLine: number;
  readonly beforeLines: readonly string[];
  readonly afterLines: readonly string[];
} & ({ readonly kind: "replace" } | { readonly kind: "create" });

/** A POSIX path inside the repository: relative, no empty, `.`, or `..` segments. */
export function isRepoRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** Resolve the deepest existing ancestor before any host read; dangling symlinks are not absence. */
async function sourcePath(
  root: string,
  rootReal: string,
  path: string,
): Promise<string> {
  if (!isRepoRelativePath(path))
    throw new Error(`${path} is not a repo-relative path`);
  const absolute = join(root, path);
  for (let probe = absolute; ; probe = dirname(probe)) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || probe === root) throw error;
      try {
        await lstat(probe);
      } catch (missing) {
        if (errorCode(missing) !== "ENOENT") throw missing;
        continue;
      }
      throw new Error(
        `${path}: ${probe === absolute ? "target" : "ancestor"} is a dangling symlink`,
      );
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep))
      throw new Error(`${path} resolves outside the repository`);
    if (probe !== absolute && !(await stat(real)).isDirectory())
      throw new Error(`${path}: ancestor is not a directory`);
    return absolute;
  }
}

/** Capture each path's full-byte SHA-256 (`null` when absent), refusing repository escapes. */
export async function captureBaseline(
  root: string,
  paths: Iterable<string>,
): Promise<ReadonlyMap<string, string | null>> {
  root = resolve(root);
  const rootReal = await realpath(root);
  const files = new Map<string, string | null>();
  for (const path of paths) {
    const absolute = await sourcePath(root, rootReal, path);
    try {
      files.set(path, sha256(await readFile(absolute)));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      files.set(path, null);
    }
  }
  return files;
}

/** UTF-16LE after its BOM, else UTF-8 without a leading BOM; malformed text is refused. */
function decodeSource(bytes: Uint8Array, path: string): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    throw new Error(`${path}: UTF-16BE source is unsupported`);
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${path}: malformed ${encoding} source`, { cause: error });
  }
}

/** Read current source within the repository, refusing escapes and changes to captured baselines. */
export function repositorySourceReader(
  root: string,
  baseline: ReadonlyMap<string, string | null>,
): (path: string) => Promise<string | undefined> {
  root = resolve(root);
  const rootReal = realpathSync(root);
  return async (path: string): Promise<string | undefined> => {
    const absolute = await sourcePath(root, rootReal, path);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    const expected = baseline.get(path);
    if (expected !== undefined && sha256(bytes) !== expected)
      throw new Error(`${path} changed since this batch's baseline`);
    return decodeSource(bytes, path);
  };
}

/** Require a Git working-tree root through the collection's sandboxed native bash tool. */
export async function requireWorkTreeRoot(
  collection: ToolCollection,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const bash = collection.tools.find((tool) => tool.name === "bash");
  if (bash === undefined)
    throw new Error("The native tool collection has no bash tool");
  const result = await bash.execute(
    "git-root-preflight",
    { command: "git rev-parse --is-inside-work-tree --show-prefix" },
    signal,
  );
  signal?.throwIfAborted();
  const output = contentText(result.content);
  // At the root, --show-prefix prints an empty line.
  if (
    ("isError" in result && result.isError === true) ||
    !/^true\r?\n\r?\n$/.test(output)
  ) {
    throw new Error("A Git working-tree root is required", {
      cause: new Error(`git rev-parse: ${output}`),
    });
  }
}

/**
 * Apply exact baseline edits through `mux`'s routed `astApply`, then release exactly their sorted
 * unique paths. The borrowed mux must use sandbox "always": a refused application publishes
 * nothing. `baseline` contains full-byte SHA-256 hashes, or null for absent files. The operation's
 * `label` is diagnostic text.
 */
export async function applySourceEdits(
  root: string,
  mux: NativeMux,
  edits: readonly SourceEdit[],
  baseline: ReadonlyMap<string, string | null>,
  options: { readonly label: string; readonly signal?: AbortSignal },
): Promise<readonly string[]> {
  const { label, signal } = options;
  signal?.throwIfAborted();
  if (mux.sandbox !== "always")
    throw new Error(`Applying ${label} requires sandbox "always"`);
  const paths = [...new Set(edits.map((edit) => edit.path))].sort();
  if (paths.length === 0)
    throw new Error(`Operation ${label} has no edits to apply`);
  const files = paths.map((path) => {
    if (!isRepoRelativePath(path))
      throw new Error(
        `Operation ${label}: ${path} is not a repo-relative path`,
      );
    const hash = baseline.get(path);
    if (edits.some((edit) => edit.path === path && edit.kind === "create")) {
      if (hash != null)
        throw new Error(
          `Operation ${label}: ${path} existed at its batch baseline and cannot be created`,
        );
      return { path };
    }
    if (typeof hash !== "string")
      throw new Error(`Operation ${label}: ${path} has no batch baseline hash`);
    return { path, sha256: hash };
  });
  for (const edit of edits) {
    if (!Number.isInteger(edit.startLine) || edit.startLine < 1)
      throw new Error(
        `Operation ${label}: ${edit.path}:${edit.startLine} is not a positive integer line`,
      );
  }
  const applied = await withNativeSignal(signal, (nativeSignal) =>
    mux.astApply(root, { files, edits, label, signal: nativeSignal }),
  );
  signal?.throwIfAborted();
  return applied;
}
