import type { AssistantMessage } from "@earendil-works/pi-ai";
import { messageEdge, type NodeIdType } from "dataflow-engine";
import type { AgenticInput, AgenticNode } from "./agentic.js";
import type { JuncoGraph } from "./junco-graph.js";
import { createParallelAgentGraph } from "./parallel-agent-graph.js";

/**
 * A parallel graph holding `root` and one child per element of `inputs`, built by `spawn` in
 * order. Each child gets two fresh message edges: `${rootId}->${childId}` from the root and
 * `${childId}->${rootId}` back to it; children are never linked to each other. The graph takes
 * `root.policy` and borrows no collection.
 *
 * Construction only registers nodes and queues: it never steps a member, sends `inputs` as
 * messages, or forwards results. Members exchange messages through their own triggers and yields.
 * Node ids are whatever `addNode` returns, so omitted ids draw the engine's auto ids and a
 * duplicate explicit id throws its `DataflowDefinitionError`. Any factory or registration error
 * propagates synchronously; the supplied and already-created members stay caller-owned.
 */
export function Spawn<T, N = AgenticInput, R = AssistantMessage>(
  root: AgenticNode<N, R>,
  inputs: readonly T[],
  spawn: (input: T) => AgenticNode<N, R>,
): JuncoGraph<N, R> {
  const graph = createParallelAgentGraph<N, R>(root.policy);
  appendSpawnChildren(graph, graph.addNode(root), inputs, spawn);
  return graph;
}

/**
 * Register one child per element of `inputs` under the already registered `rootId`, each with
 * {@link Spawn}'s paired message edges. Errors propagate synchronously; children registered before
 * the failure stay in `graph`. Package-internal.
 */
export function appendSpawnChildren<T, N = AgenticInput, R = AssistantMessage>(
  graph: JuncoGraph<N, R>,
  rootId: NodeIdType,
  inputs: readonly T[],
  spawn: (input: T) => AgenticNode<N, R>,
): void {
  for (const input of inputs) {
    const childId = graph.addNode(spawn(input));
    graph
      .addEdge(rootId, childId, messageEdge<N, R>(`${rootId}->${childId}`))
      .addEdge(childId, rootId, messageEdge<N, R>(`${childId}->${rootId}`));
  }
}
