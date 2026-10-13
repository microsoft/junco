import type { DataflowGraph, Edge, NodeIdType } from "dataflow-engine";
import { ConstFanin, ConstFanout } from "dataflow-engine";

// Exported so `noUnusedLocals` does not report the fixtures as dead. Nothing imports this file; it
// exists to be compiled.

type Constant = { readonly value: number };
type Graph = DataflowGraph<void, Constant | Constant[], string, never>;
type WiderGraph = DataflowGraph<
  void,
  Constant | Constant[] | { readonly tag: "other" },
  string,
  never
>;

/** Inferred `undefined` state and narrow payloads register and wire without casts. */
export const wire = (
  graph: Graph,
  a: Edge<Constant, string>,
  b: Edge<Constant, string>,
  list: Edge<Constant[], string>,
  sink: NodeIdType,
): void => {
  const source = graph.addNode(
    new ConstFanout({ value: 1 }, [a, b], { state: undefined, ret: "source" }),
  );
  const join = graph.addNode(
    new ConstFanin([b, a], list, { state: undefined, ret: "join" }),
  );
  graph
    .addEdge(source, join, a)
    .addEdge(source, join, b)
    .addEdge(join, sink, list);
};

/** The same specs register into a graph whose message union carries an unrelated variant. */
export const wireWider = (
  graph: WiderGraph,
  a: Edge<Constant, string>,
  list: Edge<Constant[], string>,
): void => {
  const source = graph.addNode(
    new ConstFanout({ value: 1 }, [a], { state: undefined, ret: "source" }),
  );
  const join = graph.addNode(
    new ConstFanin([a], list, { state: undefined, ret: "join" }),
  );
  graph.addEdge(source, join, a).addEdge(join, source, list);
};

/** The collector's output must carry a list, not one constant. */
export const scalarOutput = (
  a: Edge<Constant, string>,
  scalar: Edge<Constant, string>,
) =>
  // @ts-expect-error the output edge must be `Edge<Constant[], string>`.
  new ConstFanin([a], scalar, { state: undefined, ret: "join" });

/** A graph whose messages cannot carry the aggregate list rejects the collector. */
export const scalarGraph = (
  graph: DataflowGraph<void, Constant, string, never>,
  a: Edge<Constant, string>,
  list: Edge<Constant[], string>,
): NodeIdType =>
  // @ts-expect-error `Constant[]` is not one of the graph's messages.
  graph.addNode(new ConstFanin([a], list, { state: undefined, ret: "join" }));
