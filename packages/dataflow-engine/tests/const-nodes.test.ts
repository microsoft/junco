import { test } from "bun:test";
import assert from "node:assert/strict";
import * as E from "fp-ts/lib/Either.js";
import { context, parallel } from "junco-scheduler";
import type {
  EdgeIdType,
  MessageSchedule,
  NodeIdType,
} from "../src/index.ts";
import {
  ConstFanin,
  ConstFanout,
  DataflowDefinitionError,
  DataflowGraph,
  Edge,
  EmitOnce,
  from,
  Message,
  StepNode,
  TriggerRule,
  triggerInputs,
  UNBOUNDED,
  Width,
} from "../src/index.ts";

type Payload = { readonly value: number };

const newGraph = <N>(): DataflowGraph<void, N, string, never> =>
  new DataflowGraph<void, N, string, never>(
    Width.create(1),
    UNBOUNDED,
  );

/** Register a never-finishing sink on `edge` that records every payload it receives. */
const addSink = <N>(
  graph: DataflowGraph<void, N, string, never>,
  edge: Edge<N, string>,
  seen: N[],
): NodeIdType =>
  graph.addNode(
    new StepNode<void, N, string>(
      (_state, view) => {
        seen.push(...from(view, edge));
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(edge),
      },
    ),
  );

/** A never-firing node that only serves as the origin of public `graph.emit` calls. */
const addExternal = <N>(
  graph: DataflowGraph<void, N, string, never>,
): NodeIdType =>
  graph.addNode(
    new EmitOnce<void, N, string>(() => [], "external", {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );

test("ConstFanout sends the same payload once per captured output, then returns its ret", async () => {
  const graph = newGraph<Payload>();
  const payload: Payload = { value: 7 };
  const a = Edge.message<Payload, string>("a");
  const b = Edge.message<Payload, string>("b");
  const c = Edge.message<Payload, string>("c");
  const outputs = [a, b, c];
  const source = graph.addNode(
    new ConstFanout(payload, outputs, { state: undefined, ret: "source done" }),
  );
  outputs.reverse();
  outputs.pop();

  const seenA: Payload[] = [];
  const seenB: Payload[] = [];
  const seenC: Payload[] = [];
  graph
    .addEdge(source, addSink(graph, a, seenA), a)
    .addEdge(source, addSink(graph, b, seenB), b)
    .addEdge(source, addSink(graph, c, seenC), c);

  const results = await context({ graph, scheduler: parallel() }).run();
  await context({ graph, scheduler: parallel() }).run();

  for (const seen of [seenA, seenB, seenC]) {
    assert.equal(seen.length, 1);
    assert.equal(seen[0], payload);
  }
  assert.equal(graph.getNode(source)?.status, "done");
  assert.equal(results.get(source), "source done");
});

test("ConstFanout with no outputs emits nothing and completes", async () => {
  const graph = newGraph<number>();
  const source = graph.addNode(
    new ConstFanout(1, [], { state: undefined, ret: "empty" }),
  );
  const results = await context({ graph, scheduler: parallel() }).run();
  assert.equal(graph.getNode(source)?.status, "done");
  assert.equal(results.get(source), "empty");
  assert.equal((await context({ graph, scheduler: parallel() }).run()).size, 1);
});

test("ConstFanout rejects value edges and repeated output ids", () => {
  const a = Edge.message<number, string>("a");
  assert.throws(
    () => new ConstFanout(1, [a, a], { state: undefined, ret: "" }),
    DataflowDefinitionError,
  );
  assert.throws(
    () =>
      new ConstFanout(1, [a, Edge.value<number, string>("v")], {
        state: undefined,
        ret: "",
      }),
    DataflowDefinitionError,
  );
});

test("ConstFanin sends one list in configured input order only after every input contributed", async () => {
  type Constant = number[];
  const graph = newGraph<Constant | Constant[]>();
  const a = Edge.message<Constant, string>("a");
  const b = Edge.message<Constant, string>("b");
  const c = Edge.message<Constant, string>("c");
  const list = Edge.message<Constant[], string>("list");
  const constA = [1];
  const constB = [2];
  const constC = [3];
  const inputs = [c, a, b];
  const join = graph.addNode(
    new ConstFanin(inputs, list, { state: undefined, ret: "join done" }),
  );
  inputs.reverse();
  inputs.pop();

  const sourceA = addExternal(graph);
  const sourceB = addExternal(graph);
  const sourceC = addExternal(graph);
  const seen: (Constant | Constant[])[] = [];
  graph
    .addEdge(sourceA, join, a)
    .addEdge(sourceB, join, b)
    .addEdge(sourceC, join, c)
    .addEdge(join, addSink(graph, list, seen), list);

  graph.emit(sourceA, Message.create(a, constA));
  await context({ graph, scheduler: parallel() }).run();
  assert.deepEqual(seen, []);
  graph.emit(sourceB, Message.create(b, constB));
  await context({ graph, scheduler: parallel() }).run();
  assert.deepEqual(seen, []);
  assert.equal(graph.getNode(join)?.status, "running");

  graph.emit(sourceC, Message.create(c, constC));
  const results = await context({ graph, scheduler: parallel() }).run();
  assert.equal(seen.length, 1);
  const [collected] = seen as Constant[][];
  assert.equal(collected?.length, 3);
  assert.equal(collected[0], constC);
  assert.equal(collected[1], constA);
  assert.equal(collected[2], constB);
  assert.equal(graph.getNode(join)?.status, "done");
  assert.equal(results.get(join), "join done");

  graph.emit(sourceA, Message.create(a, [4]));
  graph.emit(sourceB, Message.create(b, [5]));
  graph.emit(sourceC, Message.create(c, [6]));
  await context({ graph, scheduler: parallel() }).run();
  assert.equal(seen.length, 1);
});

test("ConstFanin survives empty and one-edge-at-a-time deliveries", async () => {
  const a = Edge.message<number, string>("a");
  const b = Edge.message<number, string>("b");
  const c = Edge.message<number, string>("c");
  const list = Edge.message<number[], string>("list");
  const scripted: Map<EdgeIdType, MessageSchedule>[] = [
    new Map(),
    new Map([[c.id, 1]]),
    new Map([[b.id, 1]]),
    new Map([[a.id, 1]]),
  ];
  let join: NodeIdType | undefined;
  const graph = new DataflowGraph<void, number | number[], string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const advance = () => graph.evaluate(async (execute) => {
    const schedule = [...graph.available()].map(([id, availability]) => [{
      id,
      inputs: id === join && availability.status === "running"
        ? (scripted.shift() ?? triggerInputs(availability))
        : triggerInputs(availability),
    }]);
    await execute(schedule);
  });
  join = graph.addNode(
    new ConstFanin([a, b, c], list, { state: undefined, ret: "join done" }),
  );
  const source = addExternal(graph);
  const seen: (number | number[])[] = [];
  graph
    .addEdge(source, join, a)
    .addEdge(source, join, b)
    .addEdge(source, join, c)
    .addEdge(join, addSink(graph, list, seen), list);
  graph.emit(source, Message.create(a, 1));
  graph.emit(source, Message.create(b, 2));
  graph.emit(source, Message.create(c, 3));

  for (let turn = 0; scripted.length > 0; turn++) {
    assert.ok(turn < 10, "scripted reads were never all consumed");
    await advance();
    if (scripted.length > 0) {
      assert.deepEqual(seen, []);
      assert.ok(E.isLeft(list.transport) && list.transport.left.length === 0);
    }
  }
  const results = await context({ graph, scheduler: parallel() }).run();
  assert.deepEqual(seen, [[1, 2, 3]]);
  assert.equal(graph.getNode(join)?.status, "done");
  assert.equal(results.get(join), "join done");
});

test("separately constructed collectors keep independent progress", async () => {
  const graph = newGraph<number | number[]>();
  const a1 = Edge.message<number, string>("a1");
  const b1 = Edge.message<number, string>("b1");
  const a2 = Edge.message<number, string>("a2");
  const b2 = Edge.message<number, string>("b2");
  const list1 = Edge.message<number[], string>("list1");
  const list2 = Edge.message<number[], string>("list2");
  const options = { state: undefined, ret: "done" };
  const join1 = graph.addNode(new ConstFanin([a1, b1], list1, options));
  const join2 = graph.addNode(new ConstFanin([a2, b2], list2, options));
  const source = addExternal(graph);
  const seen1: (number | number[])[] = [];
  const seen2: (number | number[])[] = [];
  graph
    .addEdge(source, join1, a1)
    .addEdge(source, join1, b1)
    .addEdge(source, join2, a2)
    .addEdge(source, join2, b2)
    .addEdge(join1, addSink(graph, list1, seen1), list1)
    .addEdge(join2, addSink(graph, list2, seen2), list2);

  graph.emit(source, Message.create(a1, 1));
  graph.emit(source, Message.create(b1, 2));
  graph.emit(source, Message.create(a2, 3));
  await context({ graph, scheduler: parallel() }).run();
  assert.deepEqual(seen1, [[1, 2]]);
  assert.deepEqual(seen2, []);
  assert.equal(graph.getNode(join1)?.status, "done");
  assert.equal(graph.getNode(join2)?.status, "running");

  graph.emit(source, Message.create(b2, 4));
  await context({ graph, scheduler: parallel() }).run();
  assert.deepEqual(seen2, [[3, 4]]);
  assert.equal(graph.getNode(join2)?.status, "done");
});

test("ConstFanin with no inputs sends one empty list and completes", async () => {
  const graph = newGraph<number | number[]>();
  const list = Edge.message<number[], string>("list");
  const join = graph.addNode(
    new ConstFanin<undefined, number, string>([], list, {
      state: undefined,
      ret: "empty",
    }),
  );
  const seen: (number | number[])[] = [];
  graph.addEdge(join, addSink(graph, list, seen), list);
  const results = await context({ graph, scheduler: parallel() }).run();
  await context({ graph, scheduler: parallel() }).run();
  assert.deepEqual(seen, [[]]);
  assert.equal(graph.getNode(join)?.status, "done");
  assert.equal(results.get(join), "empty");
});

test("ConstFanin rejects value edges and repeated input ids", () => {
  const a = Edge.message<number, string>("a");
  const list = Edge.message<number[], string>("list");
  const options = { state: undefined, ret: "" };
  assert.throws(
    () => new ConstFanin([a, a], list, options),
    DataflowDefinitionError,
  );
  assert.throws(
    () => new ConstFanin([a, Edge.value<number, string>("v")], list, options),
    DataflowDefinitionError,
  );
  assert.throws(
    () => new ConstFanin([a], Edge.value<number[], string>("vl"), options),
    DataflowDefinitionError,
  );
});
