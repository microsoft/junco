import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { NodeSpec } from "dataflow-engine";
import type { JuncoAgent } from "junco-agent";
import type { Deterministic } from "./deterministic.js";
import type { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";

/**
 * One input for a prompt-agent member, dispatched through the native method of the same name. An
 * `error` is a failure notification, delivered through the native follow-up queue.
 */
export type AgenticInput =
  | {
      readonly kind: "prompt" | "steer" | "followUp" | "nextTurn" | "error";
      readonly text: string;
      readonly images?: ImageContent[];
    }
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };

/**
 * Every state a junco-agency graph node may hold: a prompt agent (real or mock), a nested graph or
 * a deterministic coroutine. `N`/`T` are the graph's message and result wire types.
 */
export type Agentic<N = AgenticInput, T = AssistantMessage> =
  | JuncoAgent
  | JuncoGraph<N, T>
  | MockAgent
  | Deterministic<N, T>;

/** A native node spec whose state is {@link Agentic}. */
export type AgenticNode<N = AgenticInput, T = AssistantMessage> = NodeSpec<
  Agentic<N, T>,
  N,
  T
>;
