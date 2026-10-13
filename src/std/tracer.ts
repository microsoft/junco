// `tracer`: the execution observer. A direct `JuncoGraph` takes one explicitly;
// `StdoutTracer.shared()` returns the shared default. `DummyTracer` is the shipped no-op.

export {
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  DummyTracer,
} from "dataflow-engine";
export { StdoutTracer } from "../stdout-tracer.js";
