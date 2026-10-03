import type { DataflowGraph, Message, NodeIdType } from "../src/index.ts";

// Exported so `noUnusedLocals` does not report the fixtures as dead. Nothing imports this file; it
// exists to be compiled.

/** `emit` takes a branded node id and a message of the graph's own wire type. */
export function emissionKeepsWireTypes(
  graph: DataflowGraph<void, number, string, never>,
  source: NodeIdType,
  message: Message<number>,
  wrong: Message<string>,
): void {
  const emitted: void = graph.emit(source, message);
  // @ts-expect-error a raw string is not a node id.
  graph.emit("source", message);
  // @ts-expect-error the payload must match the graph's message type.
  graph.emit(source, wrong);
  void emitted;
}
