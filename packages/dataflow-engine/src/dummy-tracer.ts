import type { TSchema } from "typebox";
import type { DataflowGraph } from "./dataflow-graph.js";
import type {
  DataflowRunTrace,
  DataflowStepTrace,
  DataflowTracer,
} from "./dataflow-tracer.js";
import type { NodeId } from "./identity.js";

const noop = (): void => {};

/** Shared stateless activation handle: records nothing. */
const STEP: DataflowStepTrace<TSchema, unknown> = { end: noop, fail: noop };

/** Shared stateless run handle: every activation receives {@link STEP}. */
const RUN: DataflowRunTrace<TSchema, unknown> = {
  startNode: () => STEP,
  end: noop,
  fail: noop,
};

const FLUSHED: Promise<void> = Promise.resolve();

/**
 * A {@link DataflowTracer} that deliberately traces nothing: no serialization, timestamps, retained
 * payloads, logging or I/O, and no allocation per run, activation or flush.
 */
export class DummyTracer implements DataflowTracer {
  startRun<S, N extends TSchema, T, EH>(
    _graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    return RUN;
  }

  complain(_nodeId: NodeId, _complaint: string): void {}

  flush(): Promise<void> {
    return FLUSHED;
  }
}
