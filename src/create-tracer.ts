import type { DataflowTracer } from "dataflow-engine";
import { StdoutTracer } from "./stdout-tracer.js";

/** The shared default tracer, built on first use. */
let shared: DataflowTracer | undefined;

/**
 * The shared default tracer: one {@link StdoutTracer} named `JuncoGraph.run` per process. Pass any
 * other {@link DataflowTracer} explicitly instead.
 */
export function createTracer(): DataflowTracer {
  shared ??= new StdoutTracer("JuncoGraph.run");
  return shared;
}
