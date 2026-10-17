import type { DataflowGraph } from "./dataflow-graph.js";
import type { NodeId } from "./identity.js";
import type { Message, ParentView } from "./node.js";

/**
 * Pluggable execution observer. {@link DataflowGraph.evaluate} calls `startRun` once around the
 * complete planning/execution scope and reports every actual generator activation through the
 * returned handle. `complain` receives complaints recorded on behalf of a node, at any time.
 *
 * CONTRACT: every run/step/complain callback is a SYNCHRONOUS observer. It MUST NOT mutate the graph,
 * the views, the messages or the results it receives; anything retained past the callback must be
 * snapshotted before it returns. A throwing callback is reported with `console.warn` and otherwise
 * ignored, so an observer can never alter the computation or mask its failure. `flush` is the only
 * asynchronous operation and is caller-owned: the graph never awaits it.
 */
export interface DataflowTracer {
  /** Begin observing one evaluation, after its re-entry check and before planning. */
  startRun<S, N, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T>;
  /**
   * A complaint was recorded for node `nodeId`, before, during or after any run. The producer
   * isolates a throwing implementation.
   */
  complain(nodeId: NodeId, complaint: string): void;
  /** Deliver whatever the tracer has buffered. Never called by the graph. */
  flush(): Promise<void>;
}

/** Observer for one evaluation scope. */
export type DataflowRunTrace<N, T> = {
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
  end(results: ReadonlyMap<NodeId, T>): void;
  /** The invocation rejects with exactly `error`. */
  fail(error: unknown): void;
};

/** Observer for one generator activation. */
export type DataflowStepTrace<N, T> = {
  /** The activation yielded (after routing) or returned (after value-edge propagation). */
  end(step: IteratorResult<readonly Message<N>[], T>): void;
  /** The generator threw, or its yield could not be routed; `error` is the raw cause. */
  fail(error: unknown): void;
};
