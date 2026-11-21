import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessResources,
  AgentHarnessStreamOptions,
  AgentMessage,
  AgentTool,
  ModelIdentity,
  NavigationResult,
  PromptTemplate,
  QueueMode,
  Skill,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  JsonObject,
  JsonValue,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import type { Message, ParentView } from "dataflow-engine";
import type {
  ComplainToolHost,
  ProfileRecorder,
  ToolCollection,
} from "junco-tools";
import { type TSchema, Type } from "typebox";
import { type JuncoAgent, JuncoAgentError } from "./junco-agent.js";
import type { LoopGuard } from "./loop-guard.js";

/**
 * The task payload of agent graphs: a description, a readonly completion spec, subtask deps and the
 * history of its holders. A prompt-agent node steers delivered payloads into its model as user
 * messages; it never dispatches them as native commands.
 */
export type Task =
  | {
      readonly kind: "prompt" | "steer" | "followUp" | "nextTurn" | "error";
      /** What the receiver is asked to do. */
      readonly text: string;
      readonly images?: ImageContent[];
      /** Task identity: a UID minted by {@link Task.create} or by the sending node's `send`. */
      readonly taskId: string;
      /** When the task counts as complete; fixed at creation, copied unchanged on every handoff. */
      readonly spec: string;
      /** Ids of the subtasks created while this task was held. */
      readonly deps: readonly string[];
      /** Prior holders, oldest first: the node, the description it received, what it did. */
      readonly history: readonly {
        readonly node: string;
        readonly desc: string;
        readonly handoff: string;
      }[];
    }
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };

/** Construction of `Task`s: `create` mints a new task's UID; it has no subtasks and no holders yet. */
export const Task = {
  create: (
    task: Omit<
      Extract<Task, { readonly text: string }>,
      "taskId" | "deps" | "history"
    >,
  ): Extract<Task, { readonly text: string }> => ({
    ...task,
    taskId: crypto.randomUUID(),
    deps: [],
    history: [],
  }),
};

const ImageContentSchema = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});

/**
 * Runtime schema of Task. Pi's `AgentMessage` is declaration-merge extensible and has no runtime
 * schema, so an appended message is checked as an object with a string `role`. Structural extras
 * are allowed throughout.
 */
export const TaskSchema = Type.Unsafe<Task>(
  Type.Union([
    Type.Object({
      kind: Type.Union([
        Type.Literal("prompt"),
        Type.Literal("steer"),
        Type.Literal("followUp"),
        Type.Literal("nextTurn"),
        Type.Literal("error"),
      ]),
      text: Type.String(),
      images: Type.Optional(Type.Array(ImageContentSchema)),
      taskId: Type.String(),
      spec: Type.String(),
      deps: Type.Array(Type.String()),
      history: Type.Array(
        Type.Object({
          node: Type.String(),
          desc: Type.String(),
          handoff: Type.String(),
        }),
      ),
    }),
    Type.Object({
      kind: Type.Literal("appendMessage"),
      message: Type.Object({ role: Type.String() }),
    }),
  ]),
);

// ponytail: Pi's JSON values are checked one level deep; recursive TypeBox `Cyclic` refs collide
// across embedded resources in 1.3.34. Add a full JSON walk if nested non-JSON data matters.
const JsonObjectSchema = Type.Unsafe<JsonObject>(Type.Object({}));
const JsonValueSchema = Type.Unsafe<JsonValue>(
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Unknown()),
    JsonObjectSchema,
  ]),
);

/**
 * Runtime schema of Pi's native {@link AssistantMessage}: its content, usage/cost, diagnostics and
 * deferred handle, with required fields, literal alternatives and optional fields. Structural
 * extras are allowed.
 */
export const AssistantMessageSchema = Type.Unsafe<AssistantMessage>(
  Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(
      Type.Union([
        Type.Object({
          type: Type.Literal("text"),
          text: Type.String(),
          textSignature: Type.Optional(Type.String()),
        }),
        Type.Object({
          type: Type.Literal("thinking"),
          thinking: Type.String(),
          thinkingSignature: Type.Optional(Type.String()),
          redacted: Type.Optional(Type.Boolean()),
        }),
        Type.Object({
          type: Type.Literal("toolCall"),
          id: Type.String(),
          name: Type.String(),
          arguments: JsonObjectSchema,
          thoughtSignature: Type.Optional(Type.String()),
          namespace: Type.Optional(Type.String()),
        }),
      ]),
    ),
    api: Type.String(),
    provider: Type.String(),
    model: Type.String(),
    responseModel: Type.Optional(Type.String()),
    responseId: Type.Optional(Type.String()),
    providerThinkingLevel: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    diagnostics: Type.Optional(
      Type.Array(
        Type.Object({
          type: Type.String(),
          timestamp: Type.Number(),
          error: Type.Optional(
            Type.Object({
              name: Type.Optional(Type.String()),
              message: Type.String(),
              stack: Type.Optional(Type.String()),
              code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
            }),
          ),
          details: Type.Optional(JsonObjectSchema),
        }),
      ),
    ),
    usage: Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
      cacheWrite1h: Type.Optional(Type.Number()),
      reasoning: Type.Optional(Type.Number()),
      totalTokens: Type.Number(),
      cost: Type.Object({
        input: Type.Number(),
        output: Type.Number(),
        cacheRead: Type.Number(),
        cacheWrite: Type.Number(),
        total: Type.Number(),
      }),
    }),
    stopReason: Type.Union([
      Type.Literal("pending"),
      Type.Literal("stop"),
      Type.Literal("length"),
      Type.Literal("toolUse"),
      Type.Literal("error"),
      Type.Literal("aborted"),
      Type.Literal("deferred"),
    ]),
    deferred: Type.Optional(
      Type.Object({
        provider: Type.String(),
        modelId: Type.String(),
        api: Type.String(),
        id: Type.String(),
        expiresAt: Type.Optional(Type.Number()),
        pollAfterMs: Type.Optional(Type.Number()),
        data: Type.Optional(JsonValueSchema),
      }),
    ),
    errorMessage: Type.Optional(Type.String()),
    rawStopReason: Type.Optional(Type.String()),
    endTurn: Type.Optional(Type.Boolean()),
    timestamp: Type.Number(),
  }),
);

/**
 * Lifecycle of an {@link Agentic}, computed from all of its records rather than from the last
 * consumed step:
 *
 * - `closed`: terminal close (`return`/`throw`) has started.
 * - `pending`: a step is waiting to be read by `next()`.
 * - `suspended`: a consumed `yield` step still holds its run before the next model request.
 * - `running`: admitted native operations or their workers remain.
 * - `ready`: only a staged initial prompt waits for the first `next()`.
 * - `idle`: none of the above.
 */
export type AgenticStatus =
  | "ready"
  | "pending"
  | "running"
  | "suspended"
  | "idle"
  | "closed";

/** Why a run paused: its explicit `yield` tool, a typed Marsh policy denial of one tool call, or the agent's `LoopGuard` holding a stuck run after that call. */
export type AgenticYieldReason = {
  readonly kind: "tool" | "policy" | "guard";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: string;
};

/**
 * One cooperative scheduling boundary. `yield` holds its run after the turn's tool batch and
 * before the next model request, until a later `next()` resumes it; `settled` carries the run's
 * native final message and `failed` its native rejection.
 */
export type AgenticStep =
  | { readonly kind: "yield"; readonly reasons: readonly AgenticYieldReason[] }
  | { readonly kind: "settled"; readonly message: AssistantMessage }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * A cooperative iterator around one native Pi lane. The conversation/control surface delegates
 * without a Context argument; the native lane is deliberately not public because a subclass can
 * constrain tool configuration. `next(inputs?)` is the scheduling plane: its optional graph view
 * only feeds a staged prompt function and is never a command payload.
 * `complain(issue)` synchronously appends a complete issue to the shared `issueLog`.
 */
export interface Agentic<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> extends AsyncGenerator<AgenticStep, void, ParentView<N, V> | undefined>,
    ComplainToolHost {
  readonly status: AgenticStatus;
  readonly events: AgentHarness<undefined>["events"];
  readonly hooks: AgentHarness<undefined>["hooks"];

  prompt(
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<AssistantMessage>;
  /**
   * Arm one prompt for the next `next()` without starting it. A function receives that `next`'s
   * graph view and returns the prompt text; busy unless the agent is idle with no queued demand.
   */
  stagePrompt(
    prompt: NonNullable<AgenticOptions<S, P, T, N, V>["prompt"]>,
    options?: { images?: ImageContent[] },
  ): void;
  skill(
    name: string,
    additionalInstructions?: string,
  ): Promise<AssistantMessage>;
  promptFromTemplate(name: string, args?: string[]): Promise<AssistantMessage>;
  steer(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  followUp(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  appendMessage(message: AgentMessage): Promise<void>;
  abort(): Promise<{
    readonly clearedSteer: AgentMessage[];
    readonly clearedFollowUp: AgentMessage[];
  }>;

  getTools(): T[];
  getActiveTools(): T[];
  getResources(): AgentHarnessResources<S, P>;
  setTools(tools: T[], activeToolNames?: string[]): Promise<void>;
  setActiveTools(names: string[]): Promise<void>;
  setResources(resources: AgentHarnessResources<S, P>): Promise<void>;
  setModel(model: ModelIdentity): Promise<void>;
  getModel(): Promise<Model<Api> | undefined>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  getThinkingLevel(): Promise<ThinkingLevel>;
  setStreamOptions(options: AgentHarnessStreamOptions): Promise<void>;
  setSteeringMode(mode: QueueMode): Promise<void>;
  setFollowUpMode(mode: QueueMode): Promise<void>;
  /**
   * Estimated tokens of the current main-lane conversation context (not capacity; compare with
   * `getModel()`'s `contextWindow`). Committed current-branch context only.
   */
  context_size(): Promise<number>;
  /**
   * Queue Pi's compaction of the main lane after the admitted run ends, without aborting or
   * resuming it. Requests run FIFO; new runs and navigation are busy while any is pending.
   */
  compact(options?: { customInstructions?: string }): Promise<void>;
  /**
   * Move the main lane's branch through Pi's native navigation only: no prompt starts and queued
   * input stays for the next explicit or staged prompt, so the result never has a `run`. Native
   * `completed`, `declined`, `failed` and `aborted` records are results; busy while a compaction
   * is pending.
   */
  navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      label?: string;
      customInstructions?: string;
    },
  ): Promise<NavigationResult>;
}

/**
 * Reports growth of the agent's session usage (Pi's cumulative `usage` event totals). Fires when
 * tokens or dollars accumulated since the previous report reach a threshold, then re-marks.
 */
export type TokenMonitorConfig = {
  /** Report once `totalTokens` grown since the last report reaches this many; omit to ignore tokens. */
  readonly tokenThreshold?: number;
  /** Report once `cost.total` (dollars) grown since the last report reaches this amount; omit to ignore cost. */
  readonly costThreshold?: number;
  /** Must not throw: a throw is isolated by Pi and surfaces only as a `handler_error` event. */
  readonly onThreshold: (
    // biome-ignore lint/suspicious/noExplicitAny: identity-only erasure of the agent's input domains.
    agent: JuncoAgent<Skill, PromptTemplate, AgentTool, any, any>,
    totals: Usage,
    delta: { readonly tokens: number; readonly cost: number },
  ) => void;
};

/**
 * Failure policy of the graph node driving an agent. Called with each failure of the node's run:
 * a thrown error, or a settlement with `stopReason: "error"` as an `Error` whose `cause` is that
 * message. Return messages to route them on the node's outbound message edges instead of a result
 * (soft error), `{ retryAfterMs }` to re-prompt the same agent after that many milliseconds, or
 * throw to reject the run with `DataflowNodeError` carrying the thrown value (hard error).
 */
export type ErrorHandler<
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> = (failure: {
  readonly error: unknown;
  /** Failures of the node's current run so far, this one included; resets when the run returns a result. */
  readonly attempt: number;
  readonly agent: Agentic<Skill, PromptTemplate, AgentTool, N, V>;
  /** The owning graph's recorder at this node (`add_context(nodeId)`), when the graph records. */
  readonly recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
  /** The owning graph's signal; undefined outside a `JuncoGraph`. */
  readonly signal: AbortSignal | undefined;
}) =>
  | readonly Message<N>[]
  | { readonly retryAfterMs: number }
  | Promise<readonly Message<N>[] | { readonly retryAfterMs: number }>;

/**
 * Native harness options plus an optional initial prompt staged until the first `next()`. A prompt
 * function runs once, synchronously, on that `next(inputs)`'s graph view.
 */
export type AgenticOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> = Omit<
  AgentHarnessOptions<undefined>,
  "tools" | "resources" | "toolExecution"
> & {
  /** Base directory for native tools and MCP connections; default `process.cwd()`. */
  readonly cwd?: string;
  /** Exact, case-sensitive default tool names to exclude; must not overlap `tools`. */
  readonly tool_block?: readonly string[];
  /** Concrete additions; enabled defaults are composed during initialization. */
  readonly tools?: T[];
  /** Display-ready declaration module path for explicitly supplied tools. */
  readonly toolSource?: string;
  readonly resources?: AgentHarnessResources<S, P>;
  readonly prompt?: string | ((inputs: ParentView<N, V>) => string);
  readonly images?: ImageContent[];
  /** Failure policy of the node driving this agent; without it a thrown failure crashes the node and a `stopReason: "error"` settlement is the node's result. */
  readonly errorHandler?: ErrorHandler<N, V>;
  /** Failure-loop guard of this agent's runs; see {@link LoopGuard}. */
  readonly loopGuard?: LoopGuard;
  /**
   * Borrowed collection selecting authorization, native defaults and lifetime. The agent holds
   * and closes only its binding, never the caller's creator hold.
   */
  readonly collection?: ToolCollection;
  /** Usage growth reports for this agent and every subagent it creates; see {@link TokenMonitorConfig}. */
  readonly tokenMonitor?: TokenMonitorConfig;
  /**
   * Profiling session view this agent records into outside a graph placement, at
   * `recorder.add_context(recorderNodeId ?? nodeId)`. Subagents inherit it; a graph activation
   * places the agent under that graph's view of the same session.
   */
  readonly recorder?: ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  /** This agent's node ID under `recorder`; default its own `nodeId`. */
  readonly recorderNodeId?: string;
};

/** Reject duplicate tool names and duplicate or unknown active names. */
export function validateActiveTools(
  tools: readonly AgentTool[],
  names: readonly string[],
): void {
  const available = new Set<string>();
  for (const tool of tools) {
    if (available.has(tool.name)) {
      throw new JuncoAgentError(
        "invalid_argument",
        `Duplicate tool name: ${tool.name}`,
      );
    }
    available.add(tool.name);
  }
  const active = new Set<string>();
  for (const name of names) {
    if (active.has(name))
      throw new JuncoAgentError(
        "invalid_argument",
        `Duplicate active tool: ${name}`,
      );
    if (!available.has(name))
      throw new JuncoAgentError(
        "invalid_argument",
        `Unknown active tool: ${name}`,
      );
    active.add(name);
  }
}

/** A staged prompt's text: a function reads, without draining, the graph view of its `next`. */
export function resolveStagedPrompt<N extends TSchema, V>(
  prompt: NonNullable<
    AgenticOptions<Skill, PromptTemplate, AgentTool, N, V>["prompt"]
  >,
  inputs: ParentView<N, V> | undefined,
): string {
  if (typeof prompt === "string") return prompt;
  if (inputs === undefined)
    throw new JuncoAgentError(
      "invalid_state",
      "A prompt function requires ParentView inputs",
    );
  const text: unknown = prompt(inputs);
  if (typeof text !== "string")
    throw new JuncoAgentError(
      "invalid_argument",
      "A prompt function must return a string",
    );
  return text;
}
