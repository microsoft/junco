/** Thresholds of a {@link LoopGuard}; each default is TokenEconomizer's. */
export type LoopGuardOptions = {
  /** Redirects per run before a stuck run is held (TE `loopguard_nudges`); default 1. */
  readonly redirects?: number;
  /** Tool calls a segment needs before it can count as stuck (TE `min_turns`); default 20. */
  readonly minCalls?: number;
  /** Edits of one file that count as churn (TE `edit_churn`); default 4. */
  readonly editChurn?: number;
  /** Or distinct files edited (TE `distinct_edit_files`); default 3. */
  readonly distinctFiles?: number;
  /** Failing tool results in the segment (TE `error_outputs`); default 6. */
  readonly failures?: number;
  /** Share of failures repeating an earlier failure signature (TE `stagnation`); default 0.2. */
  readonly stagnation?: number;
};

/** One completed tool call of a run: its name, arguments, result text and error flag. */
export type LoopGuardCall = {
  readonly toolName: string;
  readonly args: unknown;
  readonly text: string;
  readonly isError: boolean;
};

/** What the guard does after one call: append `text` to its result, or hold the run with `reason`. */
export type LoopGuardVerdict =
  | { readonly kind: "redirect"; readonly text: string }
  | { readonly kind: "hold"; readonly reason: string };

type Segment = {
  calls: number;
  readonly edits: Map<string, number>;
  errors: number;
  readonly sigs: Map<string, number>;
  repeats: number;
};

// shortcut: edits made through bash (sed, heredocs) are not counted; port TE shell_edits.py if agents edit that way
const EDIT_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
  ast_edit: true,
};
const ERR_RE =
  /error|fail|exception|traceback|not found|cannot|unable|denied|refused|no such file/i;
const HASHLINE_HEADER = /^\[([^\]#]+)#[0-9A-Fa-f]{4}\]/gm;

/**
 * TokenEconomizer's rule-based failure-loop guard (`loopguard/{state,rules}.py`), without model
 * calls. `run()` starts one run's fold: every completed tool call adds to the current segment's
 * signals (tool calls, edits per file, failing results, failure signatures repeating an earlier
 * one). When TE's strict stuck rule holds — at least `minCalls` calls, edit churn on one file or
 * edits across `distinctFiles` files, at least `failures` failing results and a repeated-failure
 * share of at least `stagnation` — the guard answers a `redirect` (up to `redirects` per run) and
 * starts a fresh segment; a segment stuck after the last redirect answers `hold`, after which the
 * guard stays quiet for the rest of the run. One guard may serve many runs and agents.
 * @throws {RangeError} when an option is out of range.
 */
export class LoopGuard {
  readonly options: Readonly<Required<LoopGuardOptions>>;

  constructor(options: LoopGuardOptions = {}) {
    const resolved = {
      redirects: options.redirects ?? 1,
      minCalls: options.minCalls ?? 20,
      editChurn: options.editChurn ?? 4,
      distinctFiles: options.distinctFiles ?? 3,
      failures: options.failures ?? 6,
      stagnation: options.stagnation ?? 0.2,
    };
    if (!Number.isSafeInteger(resolved.redirects) || resolved.redirects < 0)
      throw new RangeError(
        "LoopGuard redirects must be a non-negative safe integer",
      );
    for (const name of [
      "minCalls",
      "editChurn",
      "distinctFiles",
      "failures",
    ] as const)
      if (!Number.isSafeInteger(resolved[name]) || resolved[name] < 1)
        throw new RangeError(
          `LoopGuard ${name} must be a positive safe integer`,
        );
    if (
      !Number.isFinite(resolved.stagnation) ||
      resolved.stagnation < 0 ||
      resolved.stagnation > 1
    )
      throw new RangeError(
        "LoopGuard stagnation must be a number between 0 and 1",
      );
    this.options = Object.freeze(resolved);
  }

  /** Start folding one run; the returned function takes each completed tool call and answers its verdict, if any. */
  run(): (call: LoopGuardCall) => LoopGuardVerdict | undefined {
    const options = this.options;
    let segment = newSegment();
    let redirects = 0;
    let quiet = false;
    return (call) => {
      if (quiet) return undefined;
      fold(segment, call);
      if (!isStuck(segment, options)) return undefined;
      if (redirects < options.redirects) {
        redirects++;
        const text = redirect(segment);
        segment = newSegment();
        return { kind: "redirect", text };
      }
      quiet = true;
      return {
        kind: "hold",
        reason: `loop guard: stuck after ${redirects} redirect(s): ${segment.errors} failing tool result(s), ${segment.repeats} repeated failure(s), ${sum(segment.edits)} edit(s) across ${segment.edits.size} file(s)`,
      };
    };
  }
}

function newSegment(): Segment {
  return { calls: 0, edits: new Map(), errors: 0, sigs: new Map(), repeats: 0 };
}

/** TE `SpiralState.update`, reduced to the signals `isStuck` reads. */
function fold(segment: Segment, call: LoopGuardCall): void {
  segment.calls++;
  if (EDIT_TOOLS[call.toolName] === true) {
    const files = editedFiles(call.args);
    for (const file of files.length === 0 ? [call.toolName] : files)
      segment.edits.set(file, (segment.edits.get(file) ?? 0) + 1);
  }
  if (!call.isError) return;
  segment.errors++;
  const lines = call.text.split("\n");
  const line =
    lines.find((l) => ERR_RE.test(l)) ??
    lines.find((l) => l.trim() !== "") ??
    "?";
  const sig = line
    .replace(/0x[0-9a-f]+|\d+|\/\S+/g, "")
    .trim()
    .slice(0, 200);
  if (segment.sigs.has(sig)) segment.repeats++;
  segment.sigs.set(sig, (segment.sigs.get(sig) ?? 0) + 1);
}

function editedFiles(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const record = args as Record<string, unknown>;
  const files: string[] = [];
  for (const key of ["path", "file_path"])
    if (typeof record[key] === "string") files.push(record[key]);
  if (typeof record.input === "string")
    for (const match of record.input.matchAll(HASHLINE_HEADER))
      files.push(match[1] as string);
  return files;
}

/** TE `is_stuck` (`rules.py`), the strict rule. */
function isStuck(
  segment: Segment,
  options: Readonly<Required<LoopGuardOptions>>,
): boolean {
  const failures = sum(segment.sigs);
  return (
    segment.calls >= options.minCalls &&
    (Math.max(0, ...segment.edits.values()) >= options.editChurn ||
      segment.edits.size >= options.distinctFiles) &&
    segment.errors >= options.failures &&
    failures > 0 &&
    segment.repeats / failures >= options.stagnation
  );
}

/** TE `nudge_text` (`rules.py`). */
function redirect(segment: Segment): string {
  let busiest = "one file";
  let most = 0;
  for (const [file, count] of segment.edits)
    if (count > most) [busiest, most] = [file, count];
  return `Process check (automated): so far this run made ${sum(segment.edits)} edit(s) across ${segment.edits.size} file(s) (most to \`${busiest}\`), ${segment.errors} tool call(s) failed, and the same failure recurred ${segment.repeats} time(s). This looks like a repetitive loop. Do NOT stop — instead step back and try a MATERIALLY DIFFERENT hypothesis: re-read the failing output's expectation, consider a different file or root cause than the ones you've been editing, and verify the new hypothesis directly before editing again.`;
}

function sum(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}
