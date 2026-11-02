import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import type { Message, NodeIdType as NodeId } from "dataflow-engine";
import { type TSchema, Type } from "typebox";
import { log } from "./log.js";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import { checkToolInput } from "./tool-support.js";

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
export type Issue<N extends TSchema = TSchema> = {
  readonly nodeId: NodeId;
  readonly messages: readonly Message<N>[];
  readonly prompt: Prompt;
  readonly complaint: Complaint;
};

/** Everything a complaint tool needs besides the complaint text itself. */
export type ComplaintContext<N extends TSchema = TSchema> = Omit<
  Issue<N>,
  "complaint"
>;

/** The owner a complaint tool records through; `JuncoAgent` and `MockAgent` implement it. */
export interface ComplainToolHost {
  complain<N extends TSchema>(issue: Issue<N>): void;
}

/** Where every appended complaint goes besides the in-memory log; `issueLog.backend` holds the process-wide one. */
export interface ComplainBackend {
  complain(nodeId: NodeId, complaint: Complaint): void;
}

/** The default backend: one `{ at, nodeId, complaint }` JSON line per complaint appended to `path`. */
export class JsonlComplainBackend implements ComplainBackend {
  constructor(readonly path: string) {}

  complain(nodeId: NodeId, complaint: Complaint): void {
    appendFileSync(
      this.path,
      `${JSON.stringify({ at: new Date().toISOString(), nodeId, complaint })}\n`,
    );
  }
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
function snapshotIssue<N extends TSchema>(issue: Issue<N>): Issue {
  const prompt = deepFreeze(structuredClone(issue.prompt) as Prompt);
  const messages = Object.freeze(
    issue.messages.map(({ id, payload }) => Object.freeze({ id, payload })),
  );
  return Object.freeze({
    nodeId: issue.nodeId,
    messages,
    prompt,
    complaint: issue.complaint,
  });
}

const issues: Issue[] = [];
let backend: ComplainBackend = new JsonlComplainBackend(
  join(process.cwd(), "complaints.jsonl"),
);

/**
 * The process-wide, append-only complaint history shared by every graph, node and agent. Entries are
 * detached snapshots kept until process exit; full prompts may contain sensitive data.
 */
export const issueLog: {
  readonly length: number;
  backend: ComplainBackend;
  append<N extends TSchema>(issue: Issue<N>): void;
  snapshot(): readonly Issue[];
} = Object.freeze({
  get length(): number {
    return issues.length;
  },
  get backend(): ComplainBackend {
    return backend;
  },
  set backend(value: ComplainBackend) {
    backend = value;
  },
  /**
   * Commit a detached snapshot of `issue`, then hand the snapshot to `backend`. A snapshot failure
   * throws before insertion; a backend failure is warned and the committed issue kept.
   */
  append<N extends TSchema>(issue: Issue<N>): void {
    const stored = snapshotIssue(issue);
    issues.push(stored);
    try {
      backend.complain(stored.nodeId, stored.complaint);
    } catch (error) {
      log.warn("[junco-tools] ComplainBackend failed", error);
    }
  },
  snapshot(): readonly Issue[] {
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

type Recorder =
  | ProfileRecorder<"operations">
  | (() => ProfileRecorder<"operations"> | undefined);

/** Tools this module created, with their recorders. A same-named or copied tool is not a complaint tool. */
const complainTools = new WeakMap<object, Recorder | undefined>();

const complainOperation = {
  resource: "operations",
  category: "complain",
  tool: "complain",
  operation: "execute",
} as const;

/** Shared by executions that receive no abort signal. */
const neverAborted = new AbortController().signal;

/** The always-on `complain` tool. */
export type ComplainTool = AgentTool<typeof complainParameters, undefined>;

/**
 * Constructs a fresh, frozen {@link ComplainTool} recording through `host` with the context
 * `context` resolves at execution time. Without either, direct execution fails rather than pretend
 * success.
 */
export const ComplainTool: new <N extends TSchema = TSchema>(
  host?: ComplainToolHost,
  context?: () => ComplaintContext<N>,
  recorder?: Recorder,
) => ComplainTool = class<N extends TSchema> {
  name = "complain";
  label = "complain";
  description =
    "Report constraints, communication failures, or other obstacles you encounter. Explain the " +
    "problem in your own words. The complaint is recorded for debugging; this tool does not " +
    "pause execution or fix the problem.";
  parameters = complainParameters;
  executionMode: ComplainTool["executionMode"] = "sequential";
  execute: ComplainTool["execute"];

  constructor(
    host?: ComplainToolHost,
    context?: () => ComplaintContext<N>,
    recorder?: Recorder,
  ) {
    this.execute = (_toolCallId, input, signal) => {
      if (host === undefined || context === undefined)
        throw new Error("complain requires an agent context");
      return record(host, context, input, signal, recorder);
    };
    complainTools.set(this, recorder);
    markProfileOwned(this, () => complainOperation);
    Object.freeze(this);
  }
};

/** Whether `tool` is a `complain` tool constructed by {@link ComplainTool}. */
export function isComplainTool(tool: object): tool is ComplainTool {
  return complainTools.has(tool);
}

/** Executes a {@link ComplainTool} through `host` and `context`, ignoring its bindings. */
export function invokeComplainTool<N extends TSchema>(
  tool: ComplainTool,
  host: ComplainToolHost,
  context: ComplaintContext<N>,
  _toolCallId: string,
  input: { complaint: Complaint },
  signal: AbortSignal,
): Promise<AgentToolResult<undefined>> {
  if (!isComplainTool(tool))
    throw new TypeError("Not a complain tool constructed by ComplainTool");
  return record(host, () => context, input, signal, complainTools.get(tool));
}

function record<N extends TSchema>(
  host: ComplainToolHost,
  context: () => ComplaintContext<N>,
  input: { complaint: Complaint },
  signal: AbortSignal = neverAborted,
  recorder: Recorder | undefined,
): Promise<AgentToolResult<undefined>> {
  return profileToolCall(
    captureRecorder(recorder),
    complainOperation,
    signal,
    async () => {
      checkToolInput("complain", complainParameters, input);
      signal.throwIfAborted();
      const { nodeId, messages, prompt } = context();
      host.complain({ nodeId, messages, prompt, complaint: input.complaint });
      return {
        content: [{ type: "text", text: "Complaint recorded." }],
        details: undefined,
      };
    },
    // Resolving means the host appended the complaint.
    () => ({ counters: { complaints_recorded: 1 } }),
  );
}
