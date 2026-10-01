import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type DataflowTracer, UNBOUNDED, Width } from "dataflow-engine";
import { createParallelScheduler } from "junco-scheduler";
import type { AgenticInput } from "./agentic.js";
import { JuncoGraph } from "./junco-graph.js";
import { nodeInputs } from "./node-policy.js";

/**
 * A graph that runs every available node in each window: junco-scheduler's parallel policy with
 * the one-turn window and unbounded threads that policy requires. A running node re-reads its live
 * inputs with the agency rule, so a delivered result never starves a newer message.
 */
export function createParallelAgentGraph<N = AgenticInput, T = AssistantMessage>(
  tracer?: DataflowTracer,
): JuncoGraph<N, T> {
  let graph: JuncoGraph<N, T> | undefined;
  const scheduler = createParallelScheduler<N, T>();
  scheduler.resolveInputs = (entry, live) => nodeInputs(graph?.getNode(entry.id)?.step, live);
  const constructed = new JuncoGraph<N, T>(scheduler, Width(1), UNBOUNDED, tracer);
  graph = constructed;
  return constructed;
}
