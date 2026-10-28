import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import { admitToolCall } from "dataflow-engine";
import type { NativeResourceEvent } from "../native/index.js";

/**
 * One profiling session (`root`) seen at one node context (`path`), able to record only the
 * resource singletons in `R`. Narrowing `R` is plain assignment: `record` is a function property,
 * so a narrow handle never widens. `add_context("")` is this view; contexts emit nothing until
 * recorded into. Only the application closes the session.
 */
export interface ProfileRecorder<R extends string> {
  /** Session identity: views of one session share it. */
  readonly root: object;
  /** Escaped node IDs joined with `::`; `""` at the root. */
  readonly path: string;
  add_context(nodeId: string): ProfileRecorder<R>;
  /** Synchronous, non-throwing, no I/O: failures latch for `flush`/`close`. */
  readonly record: (event: ProfileEvent<R>) => void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** One graph activation of a node, shared by its start and finish events. */
export type ProfileActivation = {
  readonly runId: string;
  readonly firedAt: string;
  readonly features: Readonly<Record<string, { readonly count: number }>>;
  /** Opaque agent identity, the same object as its usage events' `source`. */
  readonly agent: object | undefined;
  /** Native policy owner of the agent's tools. */
  readonly owner: string | undefined;
};

export type ProfileOperation<R extends string> = {
  readonly resource: R;
  readonly category: string;
  /** Registered tool name; `""` for none. */
  readonly tool: string;
  readonly operation: string;
  readonly activation?: ProfileActivation;
};

export type ProfileOutcome = "success" | "error" | "cancelled";

export type ProfileMetrics = {
  readonly counters?: Readonly<Record<string, number>>;
  /** Latest values; `null` removes the field. */
  readonly gauges?: Readonly<Record<string, number | null>>;
};

export type ProfileEvent<R extends string> =
  | {
      readonly resource: R & ("tokens" | "cost");
      readonly kind: "usage";
      /** Opaque agent identity. */
      readonly source: object;
      /** One committed increment; this event accounts only for its selected resource. */
      readonly usage: Usage;
    }
  | {
      readonly resource: R & "memory";
      readonly kind: "resource";
      /** Opaque per-lease identity: pipeline IDs are unique only within it. */
      readonly source: object;
      readonly event: NativeResourceEvent;
    }
  | {
      readonly resource: R & "probe";
      readonly kind: "probe";
      /** The probed edge's ID within the recording graph. */
      readonly edgeId: string;
      /** One value published on that edge. */
      readonly value: number;
    }
  | ({ readonly kind: "start" } & ProfileOperation<R>)
  | ({
      readonly kind: "finish";
      readonly outcome: ProfileOutcome;
      readonly durationMs: number;
    } & ProfileOperation<R>)
  | ({ readonly kind: "metrics" } & ProfileMetrics & ProfileOperation<R>);

/** The `::`-joined path of unescaped node IDs `ids`, `%` and `:` escaped per segment. */
export const profilePath = (ids: readonly string[]): string =>
  ids.map((id) => id.replaceAll("%", "%25").replaceAll(":", "%3A")).join("::");

/**
 * The interned context views of one sink `root` (path `""`). Each view is a frozen object sharing
 * `root`'s identity and lifecycle whose `record` calls `record(ids, path, event)` with its
 * unescaped ID segments. `assertOpen` throws once the sink closed.
 */
export function profileContexts(
  root: ProfileRecorder<string>,
  record: (
    ids: readonly string[],
    path: string,
    event: ProfileEvent<string>,
  ) => void,
  assertOpen: () => void,
): {
  /** The view of `ids` extended by `nodeId` (`""` extends nothing). */
  readonly add: (
    ids: readonly string[],
    nodeId: string,
  ) => ProfileRecorder<string>;
  readonly clear: () => void;
} {
  const views = new Map<string, ProfileRecorder<string>>();
  const add = (
    parent: readonly string[],
    nodeId: string,
  ): ProfileRecorder<string> => {
    assertOpen();
    const ids = nodeId === "" ? parent : [...parent, nodeId];
    if (ids.length === 0) return root;
    const path = profilePath(ids);
    let view = views.get(path);
    if (view === undefined) {
      view = Object.freeze({
        root,
        path,
        add_context: (child: string) => add(ids, child),
        record: (event: ProfileEvent<string>) => record(ids, path, event),
        flush: () => root.flush(),
        close: () => root.close(),
      });
      views.set(path, view);
    }
    return view;
  };
  return { add, clear: () => views.clear() };
}

// The full handle of graphs, agents and collections; boxed, so an explicitly disabled
// invocation masks an enclosing one.
const invocation = new AsyncLocalStorage<{
  readonly recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
}>();

/** Runs `work` with `recorder` as the invocation recorder every nested {@link captureRecorder} sees. */
export function runWithRecorder<T>(
  recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined,
  work: () => T,
): T {
  return invocation.run({ recorder }, work);
}

/**
 * The recorder of this call: the current invocation's, else `recorder` (or its getter's result),
 * else none. Capture once before awaiting; native callbacks never use this.
 */
export function captureRecorder<
  R extends "memory" | "tokens" | "cost" | "edits" | "operations" | "probe",
>(
  recorder?: ProfileRecorder<R> | (() => ProfileRecorder<R> | undefined),
): ProfileRecorder<R> | undefined {
  const scope = invocation.getStore();
  // The full handle narrows to any of its singletons.
  if (scope !== undefined)
    return scope.recorder as ProfileRecorder<R> | undefined;
  return typeof recorder === "function" ? recorder() : recorder;
}

/** How each source-instrumented tool labels a call from its raw arguments. */
const owned = new WeakMap<
  object,
  (
    args: unknown,
  ) => ProfileOperation<"memory" | "tokens" | "edits" | "operations">
>();

/**
 * Marks `tool` as accounting its own calls, labelled by `describe` from raw arguments; returns
 * `tool` itself, so brands and identities survive.
 */
export function markProfileOwned<T extends object>(
  tool: T,
  describe: (
    args: unknown,
  ) => ProfileOperation<"memory" | "tokens" | "edits" | "operations">,
): T {
  owned.set(tool, describe);
  return tool;
}

/** Whether `tool` accounts its own calls; generic instrumentation must then not count it again. */
export function hasProfileOwner(tool: object): boolean {
  return owned.has(tool);
}

/** The labels a source-instrumented `tool` gives a call with `args`; undefined for others. */
export function profileOperationOf(
  tool: object,
  args: unknown,
): ProfileOperation<"memory" | "tokens" | "edits" | "operations"> | undefined {
  return owned.get(tool)?.(args);
}

/** Records `operation`'s start; the returned function records its one terminal outcome. */
export function beginOperation<R extends string>(
  recorder: ProfileRecorder<R> | undefined,
  operation: ProfileOperation<NoInfer<R>>,
): ((outcome: ProfileOutcome) => void) | undefined {
  if (recorder === undefined) return undefined;
  const { record } = recorder;
  record({ kind: "start", ...operation });
  const started = performance.now();
  let finished = false;
  return (outcome) => {
    if (finished) return;
    finished = true;
    record({
      kind: "finish",
      outcome,
      durationMs: performance.now() - started,
      ...operation,
    });
  };
}

/** The typed details fields generic accounting reads; any other shape counts as absent. */
type ResultDetails = {
  readonly truncation?: TruncationResult;
  readonly success?: boolean;
};

/** Output sizes of a completed tool result, plus its typed truncation record when present. */
export function recordToolResult<R extends string>(
  recorder: ProfileRecorder<R> | undefined,
  operation: ProfileOperation<NoInfer<R>>,
  result: AgentToolResult<unknown>,
): void {
  if (recorder === undefined) return;
  let text = 0;
  let images = 0;
  for (const part of result.content) {
    if (part.type === "text") text += Buffer.byteLength(part.text, "utf8");
    else if (part.type === "image") images++;
  }
  const counters: Record<string, number> = {
    output_text_bytes: text,
    output_parts: result.content.length,
    output_images: images,
  };
  const details =
    typeof result.details === "object" && result.details !== null
      ? (result.details as ResultDetails)
      : undefined;
  const truncation = details?.truncation;
  if (typeof truncation?.truncated === "boolean") {
    counters.truncations = Number(truncation.truncated);
    counters.truncation_total_bytes = truncation.totalBytes;
    counters.truncation_output_bytes = truncation.outputBytes;
    counters.truncation_total_lines = truncation.totalLines;
    counters.truncation_output_lines = truncation.outputLines;
    counters.partial_lines = Number(truncation.lastLinePartial);
    counters.oversized_first_lines = Number(truncation.firstLineExceedsLimit);
    if (truncation.truncatedBy === "lines") counters.truncation_by_lines = 1;
    if (truncation.truncatedBy === "bytes") counters.truncation_by_bytes = 1;
  }
  recorder.record({ kind: "metrics", counters, ...operation });
}

/**
 * One exactly-once tool call boundary: admission against the current usage budgets, then start,
 * output sizes, `metrics(result)` and the terminal outcome. A denied call rejects with a
 * `UsageLimitError` before `execute` or any record; an admitted one counts even if it fails. A
 * rejection under an aborted `signal` is cancelled, any other an error. Without a recorder
 * `execute` runs alone.
 */
export async function profileToolCall<R extends string, T>(
  recorder: ProfileRecorder<R> | undefined,
  operation: ProfileOperation<NoInfer<R>>,
  signal: AbortSignal | undefined,
  execute: () => Promise<AgentToolResult<T>>,
  metrics?: (result: AgentToolResult<T>) => ProfileMetrics | undefined,
): Promise<AgentToolResult<T>> {
  admitToolCall();
  const finish = beginOperation(recorder, operation);
  if (finish === undefined) return execute();
  let result: AgentToolResult<T>;
  try {
    result = await execute();
  } catch (error) {
    finish(signal?.aborted ? "cancelled" : "error");
    throw error;
  }
  recordToolResult(recorder, operation, result);
  const extra = metrics?.(result);
  if (extra !== undefined)
    recorder?.record({ kind: "metrics", ...extra, ...operation });
  // A resolved failure: `isError`, or a typed `details.success === false`.
  const details = result.details as ResultDetails | null | undefined;
  finish(
    result.isError === true ||
      (typeof details === "object" && details?.success === false)
      ? "error"
      : "success",
  );
  return result;
}
