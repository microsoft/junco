import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DataflowGraph,
  Edge,
  EmitOnce,
  from,
  Message,
  StepNode,
  TriggerRule,
  triggerInputs,
  UNBOUNDED,
} from "dataflow-engine";
import { Type } from "typebox";
import { context, parallel, reads, select } from "../src/index.ts";

const StringSchema = Type.String();

test("snapshot plans choose message edges but selected reads consume the whole queue", async () => {
  const graph = new DataflowGraph<void, typeof StringSchema, string, never>(
    UNBOUNDED,
    UNBOUNDED,
  );
  const edge = Edge.message<typeof StringSchema, string>("in", StringSchema);
  const source = graph.addNode(
    new EmitOnce<void, typeof StringSchema, string>(
      () => ["a", "b", "c"].map((s) => Message.create(edge, s)),
      "done",
      { state: undefined, trigger: TriggerRule.always() },
    ),
  );
  const consumed: string[][] = [];
  const sink = graph.addNode(
    new StepNode<void, typeof StringSchema, string>(
      (_state, view) => {
        consumed.push([...from(view, edge)]);
        return [];
      },
      { state: undefined, trigger: TriggerRule.when(edge) },
    ),
  );
  graph.addEdge(source, sink, edge);
  const predicted: number[] = [];
  await context({
    graph,
    readInputs: (id, candidate) =>
      id === sink && candidate.status === "running"
        ? new Map([[edge.id, 2]])
        : triggerInputs(candidate),
    scheduler: (snapshot) => {
      if (
        snapshot.available.has(sink) &&
        snapshot.nodes.get(sink)!.status === "running"
      ) {
        const queue = snapshot.inputs.get(sink)!.messages.get(edge.id)!;
        const plan = snapshot.plans.get(sink)!.get(edge.id);
        assert.equal(plan, 2);
        predicted.push(Math.min(plan as number, queue.length));
      }
      return { selected: select(snapshot, snapshot.available) };
    },
  }).run();
  assert.deepEqual(predicted, [2]);
  assert.deepEqual(consumed, [["a", "b", "c"]]);
});

test("reads can run a node without popping any of its queued messages", async () => {
  const graph = new DataflowGraph<void, typeof StringSchema, string, never>(
    UNBOUNDED,
    UNBOUNDED,
  );
  const edge = Edge.message<typeof StringSchema, string>("in", StringSchema);
  const source = graph.addNode(
    new EmitOnce<void, typeof StringSchema, string>(
      () => ["a", "b", "c"].map((text) => Message.create(edge, text)),
      "done",
      { state: undefined, trigger: TriggerRule.always() },
    ),
  );
  const consumed: string[][] = [];
  const sink = graph.addNode(
    new StepNode<void, typeof StringSchema, string>(
      (_state, view) => {
        consumed.push([...from(view, edge)]);
        return [];
      },
      { state: undefined, trigger: TriggerRule.when(edge) },
    ),
  );
  graph.addEdge(source, sink, edge);
  const execution = context({ graph, scheduler: reads(() => [], parallel()) });
  await execution.step();
  await execution.step();
  await execution.step();
  assert.deepEqual(consumed, [[]]);
  assert.deepEqual(graph.observe().inputs.get(sink)!.messages.get(edge.id), [
    "a",
    "b",
    "c",
  ]);
});
