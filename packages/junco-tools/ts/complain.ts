import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import type {
  DataflowTracer,
  Message,
  NodeIdType as NodeId,
} from "dataflow-engine";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { log } from "./log.js";

/** Free-form complaint text, in the reporting agent's own words. */
export type Complaint = string;

/**
 * The complete provider-neutral request an agent sent to its model: resolved system instructions,
 * converted conversation, and advertised tool declarations. Excludes auth and transport options.
 */
export type Prompt = {
  readonly systemPrompt?: string;
  readonly messages: readonly Context["messages"][number][];
  readonly tools?: readonly NonNullable<Context["tools"]>[number][];
};

/** One recorded complaint, with the node, delivered messages and request it arose in. */
export type Issue<N = unknown> = {
  readonly nodeId: NodeId;
  readonly messages: readonly Message<N>[];
  readonly prompt: Prompt;
  readonly complaint: Complaint;
};

/** Everything a complaint tool needs besides the complaint text itself. */
export type ComplaintContext<N = unknown> = Omit<Issue<N>, "complaint"> & {
  readonly tracer?: Pick<DataflowTracer, "complain">;
};

/** The owner a complaint tool records through; `JuncoAgent` and `MockAgent` implement it. */
export interface ComplainToolHost {
  complain<N>(issue: Issue<N>, tracer?: Pick<DataflowTracer, "complain">): void;
}

/** Recursively freeze `value`, visiting each object once so shared or cyclic graphs terminate. */
function deepFreeze<V>(value: V, seen: WeakSet<object> = new WeakSet()): V {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  )
    return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined && "value" in descriptor)
      deepFreeze(descriptor.value, seen);
  }
  Object.freeze(object);
  return value;
}

/** Detach `issue` from caller-owned containers; opaque node payloads stay references. */
function snapshotIssue<N>(issue: Issue<N>): Issue<unknown> {
  const prompt = deepFreeze(structuredClone(issue.prompt) as Prompt);
  const messages = Object.freeze(
    issue.messages.map(({ id, payload }) =>
      Object.freeze({ id, payload: payload as unknown }),
    ),
  );
  return Object.freeze({
    nodeId: issue.nodeId,
    messages,
    prompt,
    complaint: issue.complaint,
  });
}

const issues: Issue<unknown>[] = [];

/**
 * The process-wide, append-only complaint history shared by every graph, node and agent. Entries are
 * detached snapshots kept until process exit; full prompts may contain sensitive data.
 */
export const issueLog: {
  readonly length: number;
  append<N>(issue: Issue<N>, tracer?: Pick<DataflowTracer, "complain">): void;
  snapshot(): readonly Issue<unknown>[];
} = Object.freeze({
  get length(): number {
    return issues.length;
  },
  /**
   * Commit a detached snapshot of `issue`, then notify `tracer`. A snapshot failure throws before
   * insertion; an observer failure is reported and the committed issue kept.
   */
  append<N>(issue: Issue<N>, tracer?: Pick<DataflowTracer, "complain">): void {
    const stored = snapshotIssue(issue);
    issues.push(stored);
    if (tracer === undefined) return;
    try {
      tracer.complain(stored.nodeId, stored.complaint);
    } catch (error) {
      log.warn("[dataflow-engine] DataflowTracer callback failed", error);
    }
  },
  snapshot(): readonly Issue<unknown>[] {
    return Object.freeze(issues.slice());
  },
});

const complainParameters = deepFreeze(
  Type.Object(
    {
      complaint: Type.String({
        pattern: "\\S",
        description:
          "Describe what is constraining your work or preventing communication.",
      }),
    },
    { additionalProperties: false },
  ),
);

/** Tools this module created. A same-named or copied tool is not a complaint tool. */
const complainTools = new WeakSet<object>();

/** Shared by executions that receive no abort signal. */
const neverAborted = new AbortController().signal;

/** The always-on `complain` tool. */
export type ComplainTool = AgentTool<typeof complainParameters, undefined>;

/**
 * Constructs a fresh, frozen {@link ComplainTool} recording through `host` with the context
 * `context` resolves at execution time. Without either, direct execution fails rather than pretend
 * success.
 */
export const ComplainTool: new <N = unknown>(
  host?: ComplainToolHost,
  context?: () => ComplaintContext<N>,
) => ComplainTool = class<N> {
  name = "complain";
  label = "complain";
  description =
    "Report constraints, communication failures, or other obstacles you encounter. Explain the " +
    "problem in your own words. The complaint is recorded for debugging; this tool does not " +
    "pause execution or fix the problem.";
  parameters = complainParameters;
  executionMode: ComplainTool["executionMode"] = "sequential";
  execute: ComplainTool["execute"];

  constructor(host?: ComplainToolHost, context?: () => ComplaintContext<N>) {
    this.execute = (_toolCallId, input, signal) => {
      if (host === undefined || context === undefined)
        throw new Error("complain requires an agent context");
      return record(host, context, input, signal);
    };
    complainTools.add(this);
    Object.freeze(this);
  }
};

/** Whether `tool` is a `complain` tool constructed by {@link ComplainTool}. */
export function isComplainTool(tool: object): tool is ComplainTool {
  return complainTools.has(tool);
}

/** Executes a {@link ComplainTool} through `host` and `context`, ignoring its bindings. */
export function invokeComplainTool<N>(
  tool: ComplainTool,
  host: ComplainToolHost,
  context: ComplaintContext<N>,
  _toolCallId: string,
  input: { complaint: Complaint },
  signal: AbortSignal,
): Promise<AgentToolResult<undefined>> {
  if (!isComplainTool(tool))
    throw new TypeError("Not a complain tool constructed by ComplainTool");
  return record(host, () => context, input, signal);
}

async function record<N>(
  host: ComplainToolHost,
  context: () => ComplaintContext<N>,
  input: { complaint: Complaint },
  signal: AbortSignal = neverAborted,
): Promise<AgentToolResult<undefined>> {
  if (!Value.Check(complainParameters, input)) {
    const [error] = Value.Errors(complainParameters, input);
    throw new Error(
      `Invalid complain input${error ? `: ${error.instancePath} ${error.message}` : ""}`,
    );
  }
  signal.throwIfAborted();
  const { nodeId, messages, prompt, tracer } = context();
  host.complain(
    { nodeId, messages, prompt, complaint: input.complaint },
    tracer,
  );
  return {
    content: [{ type: "text", text: "Complaint recorded." }],
    details: undefined,
  };
}
