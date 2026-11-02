import type { TSchema } from "typebox";
import type { DataflowGraph } from "./dataflow-graph.js";
import type { NodeId } from "./identity.js";
import type { Message, ParentView } from "./node.js";

/**
 * Pluggable execution observer. {@link DataflowGraph.evaluate} calls `startRun` once around the
 * complete planning/execution scope and reports every actual generator activation through the
 * returned handle.
 *
 * CONTRACT: every callback is invoked synchronously and MUST NOT mutate the graph, the views, the
 * messages or the results it receives; anything retained past the callback must be snapshotted
 * before it returns. `startRun` and `startNode` return their handles synchronously. A completion
 * (`end`/`fail`) MAY return a promise for asynchronous delivery: the graph never awaits it inline,
 * but `evaluate` joins every returned promise before it settles, so a settled `run()` means delivery
 * finished. A throwing callback or a rejecting promise is reported with `console.warn` and otherwise
 * ignored, so an observer can never alter the computation or mask its failure.
 */
export interface DataflowTracer {
  /** Begin observing one evaluation, after its re-entry check and before planning. */
  startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T>;
}

/** Observer for one evaluation scope. */
export type DataflowRunTrace<N extends TSchema, T> = {
  /**
   * One generator activation is about to advance. `"prime"` activations receive no view;
   * `"resume"` activations receive exactly the view delivered to `next(view)`.
   */
  startNode(
    id: NodeId,
    phase: "prime" | "resume",
    inputs: ParentView<N, T> | undefined,
  ): DataflowStepTrace<N, T>;
  /**
   * The evaluation and its admitted concrete work finished.
   * `results` is the graph's cumulative completed-node map.
   */
  end(results: ReadonlyMap<NodeId, T>): void | Promise<void>;
  /** The invocation rejects with exactly `error`. */
  fail(error: unknown): void | Promise<void>;
};

/** Observer for one generator activation. */
export type DataflowStepTrace<N extends TSchema, T> = {
  /** The activation yielded (after routing) or returned (after value-edge propagation). */
  end(step: IteratorResult<readonly Message<N>[], T>): void | Promise<void>;
  /** The generator threw, or its yield could not be routed; `error` is the raw cause. */
  fail(error: unknown): void | Promise<void>;
};
