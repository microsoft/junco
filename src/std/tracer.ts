// `tracer`: the optional execution observer. Pass a `DataflowTracer` to a graph to enable tracing
// (or select the Opik adapter with the `opik` Bun feature, see JuncoGraph); omit it to run
// untraced. `DummyTracer` is the shipped no-op.

export {
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  DummyTracer,
} from "dataflow-engine";
