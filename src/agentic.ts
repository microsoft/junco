import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NodeSpec, Sink, Source } from "dataflow-engine";
import type { JuncoAgent, TaskSchema } from "junco-agent";
import type { SchedulerContext } from "junco-scheduler";
import type { ToolCollection } from "junco-tools";
import type { TSchema } from "typebox";
import type { Deterministic } from "./deterministic.js";
import type { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";

export {
  AssistantMessageSchema,
  Task,
  TaskSchema,
} from "junco-agent";

// biome-ignore-start lint/suspicious/noExplicitAny: agents are not contravariant in their input domains (`never` fails to typecheck); erased for lifecycle storage only.
/** Lifecycle-only storage of agents whose prompt callbacks admit different input domains. */
export type AnyJuncoAgent = JuncoAgent<
  Skill,
  PromptTemplate,
  AgentTool,
  any,
  any
>;
/** Lifecycle-only storage of mock agents whose prompt callbacks admit different input domains. */
export type AnyMockAgent = MockAgent<
  Skill,
  PromptTemplate,
  AgentTool,
  any,
  any
>;
// biome-ignore-end lint/suspicious/noExplicitAny: end of lifecycle-only erasure.

/** Native work states; policies and execution contexts are never graph members. */
export type Agentic<
  N extends TSchema = typeof TaskSchema,
  T = AssistantMessage,
> =
  | AnyJuncoAgent
  | JuncoGraph<N, T>
  | AnyMockAgent
  | Deterministic<N, T>
  | Source<N, T>
  | Sink<N, T>;

/** Every registration option except its state and body. */
type StepLess<N extends TSchema, T> = Omit<
  NodeSpec<Agentic<N, T>, N, T>,
  "state" | "step"
>;

/**
 * Complete bodies require their authorization policy. Builtin ports use the graph's policy;
 * step-less coroutines and nested contexts use their state's policy. A nested context advances
 * once per parent activation, admits input through its source and returns only its sink result;
 * a `persistent` one never returns: it parks when its child quiesces, resumes on its next trigger
 * message and exchanges only messages with its parent. Its native node state remains the actual
 * child graph, never the context. A step-less native agent reads exactly this graph's inputs and
 * returns its native message, so the graph's result domain must contain `AssistantMessage`.
 */
export type AgenticNode<
  N extends TSchema = typeof TaskSchema,
  T = AssistantMessage,
> =
  | (NodeSpec<Agentic<N, T>, N, T> & {
      readonly policy: ToolCollection["policy"];
      readonly persistent?: never;
    })
  | (NodeSpec<Agentic<N, T>, N, T> & {
      readonly state: Source<N, T> | Sink<N, T>;
      readonly policy?: never;
      readonly persistent?: never;
    })
  | (StepLess<N, T> & {
      readonly state: Deterministic<N, T>;
      readonly step?: never;
      readonly policy?: never;
      readonly persistent?: never;
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
      readonly persistent?: true;
    })
  | ([AssistantMessage] extends [T]
      ? StepLess<N, T> & {
          readonly state:
            | JuncoAgent<Skill, PromptTemplate, AgentTool, N, T>
            | MockAgent<Skill, PromptTemplate, AgentTool, N, T>;
          readonly step?: never;
          readonly on_error?: never;
          readonly policy: ToolCollection["policy"];
          readonly persistent?: never;
        }
      : never);

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
