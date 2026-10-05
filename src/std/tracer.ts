// `tracer`: the execution observer. A direct `JuncoGraph` takes one explicitly; `createTracer()`
// selects the shared automatic one (the Opik adapter under the `opik` Bun feature, otherwise
// `StdoutTracer`). `DummyTracer` is the shipped no-op.

export {
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  DummyTracer,
} from "dataflow-engine";
export { createTracer } from "../create-tracer.js";
export { StdoutTracer } from "../stdout-tracer.js";
