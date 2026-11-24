import { test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
  admitToolCall,
  DataflowGraph,
  Edge,
  FinalMessages,
  Message,
  TriggerEntry,
  TriggerRule,
  UsageBudget,
  UsageLimitError,
  Width,
} from "../src/index.ts";
import { nativeReads, queued } from "./support.ts";

const number = Type.Number();
const graphOf = () =>
  new DataflowGraph<void, typeof number, number, never>(
    Width.create(1),
    Width.create(4),
  );

function terminal<T>(finish: () => T) {
  // biome-ignore lint/correctness/useYield: these nodes settle on their first advance.
  return async function* () {
    return finish();
  };
}

test("a continuation cannot consume a partial all-of, even with explicit native reads", async () => {
  const graph = graphOf();
  const drive = nativeReads(graph, "all");
  const a = Edge.message("a", number),
    b = Edge.message("b", number);
  const history = Edge.value("history", number);
  const source = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: terminal(() => 12),
  });
  const waiter = graph.addNode({
    state: undefined,
    trigger: TriggerRule.allOf(TriggerEntry.on(a), TriggerEntry.on(b)),
    async *step() {
      const first = yield [];
      assert.deepEqual(first.messages.get(a.id), [1]);
      assert.equal(first.values.get(history.id), 12);
      const continuing = yield { resume: [] };
      assert.deepEqual([...continuing.messages.keys()], []);
      assert.deepEqual([...continuing.values.keys()], []);
      yield [];
      throw Error("ordinary yield must park");
    },
  });
  graph
    .addEdge(source, waiter, a)
    .addEdge(source, waiter, b)
    .addEdge(source, waiter, history);
  graph.emit(source, Message.create(a, 1));
  graph.emit(source, Message.create(b, 1));
  await drive.step();
  await drive.step();
  graph.emit(source, Message.create(a, 2));
  assert.equal(graph.available().get(waiter)?.continuationOnly, true);
  assert.deepEqual(graph.observe().inputs.get(waiter)?.messages.get(a.id), [2]);
  await drive.step();
  assert.deepEqual(queued(a), [2]);
  assert.equal(graph.available().size, 0);
});

test("a terminal message batch publishes once without a result or value resolution", async () => {
  const graph = graphOf();
  const out = Edge.message("out", number),
    value = Edge.value("value", number);
  const settlement = Edge.returned("settlement", number);
  let closed = 0;
  const producer = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: terminal(() => {
      try {
        return new FinalMessages([Message.create(out, 17)]);
      } finally {
        closed++;
      }
    }),
  });
  const parked = graph.addNode({
    state: undefined,
    trigger: TriggerRule.never(),
    step: terminal(() => 0),
  });
  graph
    .addEdge(producer, parked, out)
    .addEdge(producer, parked, value)
    .addEdge(producer, parked, settlement);
  const drive = nativeReads(graph, "all");
  await drive.run();
  await drive.run();
  assert.deepEqual(queued(out), [17]);
  assert.deepEqual(queued(settlement), []);
  assert.equal(closed, 1);
  assert.equal(graph.results().has(producer), false);
  assert.equal(graph.observe().inputs.get(parked)?.values.has(value.id), false);
  assert.equal(graph.available().size, 0);
});

test("an invalid return cannot update a cell, enqueue a settlement, or report a probe", async () => {
  const graph = graphOf();
  const probes: unknown[] = [];
  const cell = Edge.value("cell", number, (x) => probes.push(x));
  const settled = Edge.returned("settled", number, (x) => probes.push(x));
  const positive = Edge.returned("positive", Type.Number({ minimum: 1 }));
  const producer = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: terminal(() => 0),
  });
  const parked = graph.addNode({
    state: undefined,
    trigger: TriggerRule.never(),
    step: terminal(() => 1),
  });
  graph
    .addEdge(producer, parked, cell)
    .addEdge(producer, parked, settled)
    .addEdge(producer, parked, positive);
  assert.throws(
    () => graph.emit(producer, Message.create(settled, 9)),
    /cannot emit on return-message edge/,
  );
  await assert.rejects(
    nativeReads(graph, "all").step(),
    /Invalid payload for return-message edge "positive"/,
  );
  assert.equal(graph.results().has(producer), false);
  assert.equal(graph.observe().inputs.get(parked)?.values.has(cell.id), false);
  assert.deepEqual(queued(settled), []);
  assert.deepEqual(probes, []);
});

test("return queues publish the very same object on each return", async () => {
  const schema = Type.Object({ n: number });
  const graph = new DataflowGraph<void, typeof schema, { n: number }, never>(
    Width.create(1),
    Width.create(2),
  );
  const repeat = Edge.value("again", schema),
    events = Edge.returned("events", schema);
  const product = { n: 1 };
  const producer = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: terminal(() => product),
  });
  const parked = graph.addNode({
    state: undefined,
    trigger: TriggerRule.never(),
    step: terminal(() => product),
  });
  graph.addEdge(producer, producer, repeat).addEdge(producer, parked, events);
  const drive = nativeReads(graph, "all");
  await drive.step();
  await drive.step();
  const observed = queued(events);
  assert.equal(observed.length, 2);
  assert.equal(observed[0], product);
  assert.equal(observed[1], product);
});

test("the post-advance budget check suppresses a caught failure's return notification", async () => {
  const graph = graphOf(),
    event = Edge.returned("settled", number);
  const node = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: terminal(() => {
      assert.throws(admitToolCall, UsageLimitError);
      return 19;
    }),
  });
  graph.addEdge(node, node, event);
  await assert.rejects(
    graph.evaluate((execute) =>
      execute([[{ id: node, inputs: new Map() }]], {
        usageBudgets: new Map([
          [node, [new UsageBudget("activation", { tools: 0 })]],
        ]),
      }),
    ),
    UsageLimitError,
  );
  assert.deepEqual(queued(event), []);
  assert.equal(graph.results().has(node), false);
});

test("a yielded message cannot impersonate a return", async () => {
  const graph = graphOf(),
    event = Edge.returned("settled", number);
  const node = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    async *step() {
      yield [Message.create(event, 42)];
      return 1;
    },
  });
  graph.addEdge(node, node, event);
  await assert.rejects(
    nativeReads(graph, "all").run(),
    /cannot emit on return-message edge/,
  );
  assert.deepEqual(queued(event), []);
});

test("ordinary products, including undefined and objects with messages, remain results", async () => {
  const graph = new DataflowGraph<void, typeof number, unknown, never>(
    Width.create(1),
    Width.create(2),
  );
  const value = { messages: [1] };
  const a = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: terminal(() => undefined),
  });
  const b = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: terminal(() => value),
  });
  const results = await nativeReads(graph, "all").run();
  assert.equal(results.has(a), true);
  assert.equal(results.get(a), undefined);
  assert.equal(results.get(b), value);
});
