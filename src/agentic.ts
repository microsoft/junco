import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { EdgeIdType, NodeSpec } from "dataflow-engine";
import type { JuncoAgent } from "junco-agent";
import type { Contract, ToolCollectionOptions } from "junco-tools";
import type { Deterministic } from "./deterministic.js";
import type { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";

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
 * Every state a junco-agency graph node may hold: a prompt agent (real or mock), a nested graph or
 * a deterministic coroutine. `N`/`T` are the graph's message and result wire types.
 */
export type Agentic<N = AgenticInput, T = AssistantMessage> =
  | JuncoAgent
  | JuncoGraph<N, T>
  | MockAgent
  | Deterministic<N, T>;

/**
 * A native node spec whose state is {@link Agentic}, registered under an authorization policy.
 * `contract` is the receiver's own description of what it expects on each incoming edge, which
 * graph-aware agents read through `info`; graphs never require it.
 */
export type AgenticNode<N = AgenticInput, T = AssistantMessage> = NodeSpec<
  Agentic<N, T>,
  N,
  T
> & {
  readonly policy: ToolCollectionOptions["policy"];
  readonly contract?: (edgeId: EdgeIdType) => Contract;
};
