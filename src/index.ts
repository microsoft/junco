// The standard library for building junco workflows, indexed by namespace.
export * as agent from "junco-agent";
export * as mcp from "junco-mcp";
export * as tools from "junco-tools";
export {
  type Agentic,
  type AgenticInput,
  AgenticInputSchema,
  type AgenticNode,
  AssistantMessageSchema,
  type CompactionPolicy,
} from "./agentic.js";
export { Deterministic } from "./deterministic.js";
export { JuncoGraph } from "./junco-graph.js";
export {
  constantProfiles,
  MockAgent,
  type MockCall,
  type MockFrame,
  type MockHook,
  type MockHookResult,
  type MockMaintenance,
  type MockRequest,
  type MockRun,
  type MockTerminal,
  type MockTranscript,
  type MockUsage,
  NO_USAGE,
} from "./mock-agent.js";
export { MockJuncoGraph } from "./mock-junco-graph.js";
export * as graph from "./std/graph.js";
export * as schedules from "./std/schedules/index.js";
export * as tracer from "./std/tracer.js";
export * as trigger from "./std/trigger.js";
export * as workflows from "./std/workflows/index.js";
export * as syntax from "./syntax/index.js";
