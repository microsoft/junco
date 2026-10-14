// `tracer`: the execution observer. A direct `JuncoGraph` takes one explicitly;
// `TuiTracer.shared()` selects interactive TUI or the stateless `DummyTracer` no-op.

export {
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  DummyTracer,
} from "dataflow-engine";
export { TuiTracer } from "../tui-tracer.js";
