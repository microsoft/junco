import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";

/**
 * The complete public instance API of the pinned Pi `AgentHarness`, with its native generic
 * parameters. Protected integration hooks are not part of it.
 */
export type AgentHarnessApi<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Pick<AgentHarness<S, P, T>, keyof AgentHarness<S, P, T>>;

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
export type AgenticStatus = "ready" | "pending" | "running" | "suspended" | "idle" | "closed";

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
 * A native Pi harness that is also its own cooperative scheduling iterator. The native API is the
 * conversation/control plane; `next()` is the scheduling plane and carries no command payload.
 */
export interface Agentic<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> extends AgentHarnessApi<S, P, T>,
    AsyncGenerator<AgenticStep, void, void> {
  readonly status: AgenticStatus;
}

/** Native harness options plus an optional initial prompt staged until the first `next()`. */
export interface AgenticOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> extends AgentHarnessOptions<S, P, T> {
  readonly prompt?: string;
  readonly images?: ImageContent[];
}

/** Construction contract of an {@link Agentic} implementation. */
export interface AgenticConstructor<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
  O = AgenticOptions<S, P, T>,
> {
  new (options: O): Agentic<S, P, T>;
}
