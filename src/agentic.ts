import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EdgeIdType, NodeSpec, Sink, Source } from "dataflow-engine";
import type { AgenticInput, JuncoAgent } from "junco-agent";
import type { SchedulerContext } from "junco-scheduler";
import type { Contract, ToolCollection } from "junco-tools";
import type { Deterministic } from "./deterministic.js";
import type { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";

export type { AgenticInput } from "junco-agent";

/** Native work states; policies and execution contexts are never graph members. */
export type Agentic<N = AgenticInput, T = AssistantMessage> =
  | JuncoAgent
  | JuncoGraph<N, T>
  | MockAgent
  | Deterministic<N, T>
  | Source<N, T>
  | Sink<N, T>;

/** Every registration option except its state and body. */
type StepLess<N, T> = Omit<NodeSpec<Agentic<N, T>, N, T>, "state" | "step">;

/**
 * Complete bodies require their authorization policy. Builtin ports use the graph's policy;
 * step-less coroutines and nested contexts use their state's policy. A nested context advances
 * once per parent activation, admits input through its source and returns only its sink result.
 * Its native node state remains the actual child graph, never the context.
 */
export type AgenticNode<N = AgenticInput, T = AssistantMessage> = (
  | (NodeSpec<Agentic<N, T>, N, T> & {
      readonly policy: ToolCollection["policy"];
    })
  | (NodeSpec<Agentic<N, T>, N, T> & {
      readonly state: Source<N, T> | Sink<N, T>;
      readonly policy?: never;
    })
  | (StepLess<N, T> & {
      readonly state: Deterministic<N, T>;
      readonly step?: never;
      readonly policy?: never;
    })
  | (StepLess<N, T> & {
      readonly state: SchedulerContext<
        Agentic<N, T>,
        N,
        T,
        never,
        JuncoGraph<N, T>
      >;
      readonly step?: never;
      readonly policy?: never;
    })
  | ([N] extends [AgenticInput]
      ? [AgenticInput] extends [N]
        ? [T] extends [AssistantMessage]
          ? [AssistantMessage] extends [T]
            ? StepLess<N, T> & {
                readonly state: JuncoAgent | MockAgent;
                readonly step?: never;
                readonly policy: ToolCollection["policy"];
              }
            : never
          : never
        : never
      : never)
) & {
  readonly contract?: (edgeId: EdgeIdType) => Contract;
};

/**
 * Which direct prompt-agent node states `JuncoGraph.compact` compacts:
 * - `"all"`: every node's member, including finished and unavailable nodes;
 * - `"more-than-forty"`: every node's member whose context exceeds 40% of its model's context window;
 * - `"all-available"`: the members of the nodes in one `graph.available()` snapshot;
 * - `"more-than-forty-available"`: the available nodes' members whose context exceeds 40% of their
 *   context window.
 */
export type CompactionPolicy =
  | "all"
  | "more-than-forty"
  | "all-available"
  | "more-than-forty-available";
