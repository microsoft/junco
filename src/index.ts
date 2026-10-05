// The standard library for building junco workflows, indexed by namespace.
export * as agent from "junco-agent";
export * as mcp from "junco-mcp";
export * as tools from "junco-tools";
export {
  LspTool,
  type LspToolDetails,
  type LspToolInput,
  type LspToolOptions,
} from "junco-tools";
export { createAgencyScheduler } from "./agency.js";
export { type AgentNodeBinding, agentNode } from "./agent-node.js";
export type { Agentic, AgenticInput, AgenticNode } from "./agentic.js";
export * as compaction from "./compaction.js";
export { type CompactionPolicy, compactGraph } from "./compaction.js";
export { Deterministic } from "./deterministic.js";
export { deterministicNode } from "./deterministic-node.js";
export { type GraphNodeBinding, graphNode } from "./graph-node.js";
export { JuncoGraph } from "./junco-graph.js";
export {
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
} from "./mock-agent.js";
export { createParallelAgentGraph } from "./parallel-agent-graph.js";
export * as graph from "./std/graph.js";
export * as schedulers from "./std/schedulers.js";
export * as tracer from "./std/tracer.js";
export * as trigger from "./std/trigger.js";
