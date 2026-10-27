import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve as resolveNodePath,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** Mirrors Pi's `UNICODE_SPACES` set from `utils/paths.js`. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Largest value a NAPI `u32` field can carry. */
export const NATIVE_U32_MAX = 4_294_967_295;

/** Reject a caller signal that already aborted, with Pi's cancellation text. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

interface NormalizeOptions {
  normalizeUnicodeSpaces?: boolean;
  stripAtPrefix?: boolean;
}

/**
 * Pure port of Pi's `normalizePath`: Unicode-space folding, one leading `@`,
 * `~`/`~/` expansion, and `file://` decoding. Pi's process helpers are
 * deliberately not reproduced.
 */
function normalizePath(input: string, options: NormalizeOptions = {}): string {
  let normalized = input;
  if (options.normalizeUnicodeSpaces)
    normalized = normalized.replace(UNICODE_SPACES, " ");
  if (options.stripAtPrefix && normalized.startsWith("@"))
    normalized = normalized.slice(1);
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/")) return join(home, normalized.slice(2));
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** Pure port of Pi's `resolveToCwd`, with the argument order flipped to (cwd, input). */
export function resolveToolPath(cwd: string, input: string): string {
  const normalized = normalizePath(input, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
  });
  return isAbsolute(normalized)
    ? resolveNodePath(normalized)
    : resolveNodePath(normalizePath(cwd), normalized);
}

/** Cwd-relative POSIX path when `absolutePath` is inside `cwd`, else the absolute path. */
export function displayToolPath(cwd: string, absolutePath: string): string {
  const resolvedCwd = resolveNodePath(normalizePath(cwd));
  const resolvedPath = resolveNodePath(resolvedCwd, absolutePath);
  const relativePath = relative(resolvedCwd, resolvedPath);
  const insideCwd =
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath));
  return (insideCwd ? relativePath || "." : resolvedPath).split(sep).join("/");
}

/**
 * The editable view pi-edit snapshots: one leading BOM removed and every CRLF
 * or lone CR folded to LF. Writes keep the original representation; this is
 * only what the model addresses by line number.
 */
export function normalizeEditableText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n");
}

export interface BoundedToolDetails<T> {
  result: T;
  truncation?: TruncationResult;
}

/**
 * The bounded single-text envelope the structural tools share: one text part
 * over `content`, and the native `result` preserved by reference beside the
 * truncation record it produced, if any.
 */
export function boundedToolResult<T>(
  content: string,
  result: T,
): {
  content: [{ type: "text"; text: string }];
  details: BoundedToolDetails<T>;
} {
  const truncation = truncateHead(content);
  let text = truncation.content;
  if (truncation.truncated) {
    const notice =
      truncation.truncatedBy === "lines"
        ? `${DEFAULT_MAX_LINES} line limit reached`
        : `${formatSize(DEFAULT_MAX_BYTES)} limit reached`;
    text = `${text === "" ? "" : `${text}\n\n`}[${notice}]`;
  }
  return {
    content: [{ type: "text", text }],
    details: truncation.truncated ? { result, truncation } : { result },
  };
}

/**
 * Validate a caller-supplied number before it becomes a NAPI `u32`.
 *
 * NAPI silently truncates/wraps out-of-range JavaScript numbers, which would
 * change the requested search boundary instead of failing.
 */
export function requireU32(field: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min || value > NATIVE_U32_MAX) {
    throw new Error(
      `${field} must be an integer between ${min} and ${NATIVE_U32_MAX}`,
    );
  }
  return value;
}

/**
 * Run native work under a private AbortSignal forwarded from `signal`.
 *
 * The pinned napi runtime's AbortSignal conversion assigns to the supplied
 * signal's `onabort` property, which would clobber a caller-installed handler.
 * A fresh per-call controller keeps the caller's signal untouched while still
 * cancelling the worker. The native call is always awaited to settlement: a
 * `Promise.race` would leave a live worker writing into freed state.
 */
export async function withNativeSignal<T>(
  signal: AbortSignal | undefined,
  run: (nativeSignal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return run(undefined);
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal.addEventListener("abort", forward, { once: true });
  try {
    return await run(controller.signal);
  } catch (error) {
    if (signal.aborted) throw new Error("Operation aborted");
    throw error;
  } finally {
    signal.removeEventListener("abort", forward);
  }
}

/** Add `promise` to `pending` until it settles; returns `promise`. */
export function trackPromise<T>(
  pending: Set<Promise<unknown>>,
  promise: Promise<T>,
): Promise<T> {
  pending.add(promise);
  const settled = () => pending.delete(promise);
  promise.then(settled, settled);
  return promise;
}

/** `input` typed by `schema`, or an `Invalid <tool> input` error naming the first violation. */
export function checkToolInput<S extends TSchema>(
  tool: string,
  schema: S,
  input: unknown,
): Static<S> {
  if (Value.Check(schema, input)) return input;
  const [error] = Value.Errors(schema, input);
  throw new Error(
    `Invalid ${tool} input${error ? `: ${error.instancePath} ${error.message}` : ""}`,
  );
}

/** `output` typed by `schema`, or an `Invalid <name> output` error naming the first violation. */
export function checkToolOutput<T extends TSchema>(
  name: string,
  schema: T,
  output: unknown,
): Static<T> {
  if (Value.Check(schema, output)) return output;
  const [error] = Value.Errors(schema, output);
  throw new Error(
    `Invalid ${name} output${error ? `: ${error.instancePath} ${error.message}` : ""}`,
  );
}

export { DEFAULT_MAX_BYTES, truncateHead, truncateLine };
