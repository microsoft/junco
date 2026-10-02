import { test } from "bun:test";
import assert from "node:assert/strict";
import { createParallelScheduler } from "junco-scheduler";
import {
  always,
  DataflowGraph,
  emitOnce,
  messageEdge,
  NodeId,
  renderPretty,
  UNBOUNDED,
  valueEdge,
  Width,
} from "../src/index.ts";

test("renderPretty renders the current graph topology as Mermaid", () => {
  const graph = new DataflowGraph<void, number, string, never>(
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
  );
  assert.equal(renderPretty(graph), "");

  const add = (id: string) =>
    graph.addNode({
      id: NodeId(id),
      state: undefined,
      trigger: always(),
      step: emitOnce(() => [], "done"),
    });
  const first = add('A"#\n');
  const second = add("B&|");
  graph.addEdge(first, second, messageEdge<number, string>("m%"));
  graph.addEdge(first, second, valueEdge<number, string>("v|"));

  assert.equal(
    renderPretty(graph),
    `graph TD;
n0["A#34;#35;#10;"];
n1["B#38;#124;"];
n0 -->|"m#37; (message)"| n1;
n0 -->|"v#124; (value)"| n1;`,
  );

  add("C");
  assert.equal(
    renderPretty(graph),
    `graph TD;
n0["A#34;#35;#10;"];
n1["B#38;#124;"];
n2["C"];
n0 -->|"m#37; (message)"| n1;
n0 -->|"v#124; (value)"| n1;`,
  );
});
