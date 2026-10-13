import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  EdgeIdType,
  NodeIdType,
  NodeSpec,
  ParentView,
} from "dataflow-engine";
import type { AgenticInput, JuncoAgent } from "junco-agent";
import type { Contract, ToolCollection } from "junco-tools";
import type { Deterministic } from "./deterministic.js";
import type { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";

export type { AgenticInput } from "junco-agent";

/**
 * Every state a junco-agency graph node may hold: a prompt agent (real or mock), a nested graph or
 * a deterministic coroutine. `N`/`T` are the graph's message and result wire types.
 */
export type Agentic<N = AgenticInput, T = AssistantMessage> =
  | JuncoAgent
  | JuncoGraph<N, T>
  | MockAgent
  | Deterministic<N, T>;

/** Execution fields only a step-less nested-graph node carries. */
type NotNested = {
  readonly result?: never;
  readonly receive?: never;
  readonly afterStep?: never;
};

/** Every registration option of an Agentic node except its state and body. */
type StepLess<N, T> = Omit<NodeSpec<Agentic<N, T>, N, T>, "state" | "step">;

/**
 * A native node spec whose state is {@link Agentic}. A spec with a `step` registers unchanged under
 * its own required authorization `policy`. Without one, the graph drives the state itself:
 * - a {@link Deterministic} coroutine runs as its own body;
 * - a nested {@link JuncoGraph} advances once per activation and returns the retained result of
 *   its already registered child node `result`. `receive` is called on every delivery before the
 *   child advances, with the consumed batch and only parent results not delivered before (use it
 *   to feed the child); `afterStep` after each successful child advance, before completion is
 *   tested;
 * - on chat wires, a prompt agent runs with its own staged prompt under the spec's required
 *   `policy`.
 *
 * A step-less coroutine or nested graph is authorized by the policy its state was constructed
 * with, so its spec takes no `policy`.
 *
 * `contract` is the receiver's own description of what it expects on each incoming edge, which
 * graph-aware agents read through `info`; graphs never require it. A nested node's contract is
 * this node's own, unrelated to the selected inner node's edges.
 */
export type AgenticNode<N = AgenticInput, T = AssistantMessage> = (
  | (NodeSpec<Agentic<N, T>, N, T> &
      NotNested & { readonly policy: ToolCollection["policy"] })
  | (StepLess<N, T> &
      NotNested & {
        readonly state: Deterministic<N, T>;
        readonly step?: never;
        readonly policy?: never;
      })
  | (StepLess<N, T> & {
      readonly state: JuncoGraph<N, T>;
      readonly step?: never;
      readonly policy?: never;
      readonly result: NodeIdType;
      readonly receive?: (view: ParentView<N, T>) => void | Promise<void>;
      readonly afterStep?: () => void | Promise<void>;
    })
  | ([N] extends [AgenticInput]
      ? [AgenticInput] extends [N]
        ? [T] extends [AssistantMessage]
          ? [AssistantMessage] extends [T]
            ? StepLess<N, T> &
                NotNested & {
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
