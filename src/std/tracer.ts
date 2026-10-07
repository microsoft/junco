// `tracer`: the execution observer. A direct `JuncoGraph` takes one explicitly; `createTracer()`
// returns the shared default `StdoutTracer`. `DummyTracer` is the shipped no-op.

export {
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  DummyTracer,
} from "dataflow-engine";
export { createTracer } from "../create-tracer.js";
export { StdoutTracer } from "../stdout-tracer.js";
