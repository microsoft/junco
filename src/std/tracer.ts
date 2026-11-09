// `tracer`: the execution observer. A direct `JuncoGraph` takes one explicitly;
// `TuiTracer.shared()` selects interactive TUI or the stateless `DummyTracer` no-op.
// Profile recorders are a separate `recorder` dependency, never a tracer.

export {
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  DummyTracer,
} from "dataflow-engine";
export type {
  ProfileActivation,
  ProfileEvent,
  ProfileOperation,
  ProfileRecorder,
} from "junco-tools";
export type { AgentObserver } from "../agent-node.js";
export {
  type GrafanaPanel,
  GrafanaRecorder,
  type GrafanaRecorderOptions,
} from "../grafana-recorder.js";
export { JsonlRecorder, type JsonlRecorderOptions } from "../jsonl-recorder.js";
export { TuiTracer } from "../tui-tracer.js";
