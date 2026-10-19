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
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import type { EdgeIdType, ParentView } from "dataflow-engine";
import type { ComplainToolHost, Contract, ToolCollection } from "junco-tools";
import type { JuncoAgent } from "./junco-agent.js";

/**
 * The message payload of agent graphs. A prompt-agent node retains delivered payloads as data for
 * its model's `recv`; it never dispatches them as native commands. Task subagent reports use
 * `followUp` (completed) and `error` (failed) on their private return edges.
 */
export type AgenticInput =
  | {
      readonly kind: "prompt" | "steer" | "followUp" | "nextTurn" | "error";
      readonly text: string;
      readonly images?: ImageContent[];
    }
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };

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

/** Why a run paused: its explicit `yield` tool, or a typed Marsh policy denial of one tool call. */
export type AgenticYieldReason = {
  readonly kind: "tool" | "policy";
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
 * `complain(issue, tracer?)` synchronously appends a complete issue to the shared `issueLog`.
 */
export interface Agentic<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> extends AsyncGenerator<
      AgenticStep,
      void,
      ParentView<AgenticInput, AssistantMessage> | undefined
    >,
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
    prompt: NonNullable<AgenticOptions<S, P, T>["prompt"]>,
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
  /**
   * What this agent, as a graph receiver, expects on its incoming edge `edgeId`. A metadata query:
   * it never starts or resumes a run.
   */
  contract(edgeId: EdgeIdType): Contract;
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
    agent: JuncoAgent,
    totals: Usage,
    delta: { readonly tokens: number; readonly cost: number },
  ) => void;
};

/**
 * Native harness options plus an optional initial prompt staged until the first `next()`. A prompt
 * function runs once, synchronously, on that `next(inputs)`'s graph view.
 */
export type AgenticOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Omit<
  AgentHarnessOptions<undefined>,
  "tools" | "resources" | "toolExecution"
> & {
  readonly tools?: T[];
  readonly resources?: AgentHarnessResources<S, P>;
  readonly prompt?:
    | string
    | ((inputs: ParentView<AgenticInput, AssistantMessage>) => string);
  readonly images?: ImageContent[];
  /**
   * Borrowed collection selecting the agent's authorization policy and native lifetime: the agent
   * holds a lease until closed, and closes only that lease, never the collection. Grants no tools
   * by itself.
   */
  readonly collection?: ToolCollection;
  /** This agent's receiver contract per incoming graph edge; see {@link Agentic.contract}. */
  readonly contract?: (edgeId: EdgeIdType) => Contract;
  /** Usage growth reports for this agent and every subagent it creates; see {@link TokenMonitorConfig}. */
  readonly tokenMonitor?: TokenMonitorConfig;
};
