import { test } from "bun:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type {
  DataflowScheduler,
  Edge,
  EdgeIdType,
  MessageSchedule,
  NodeAvailability,
  NodeGenerator,
  NodeIdType,
  Schedule,
} from "../src/index.ts";
import {
  allOf,
  always,
  anyOf,
  DataflowDefinitionError,
  DataflowGraph,
  DataflowNodeError,
  emitOnce,
  from,
  messageEdge,
  msg,
  NodeId,
  on,
  ReadyScheduler,
  stepNode,
  triggerInputs,
  UNBOUNDED,
  valueEdge,
  Width,
  when,
} from "../src/index.ts";

type Graph = DataflowGraph<void, number, string, never>;

const newGraph = (): Graph =>
  new DataflowGraph<void, number, string, never>(
    new ReadyScheduler(),
    Width(1),
    UNBOUNDED,
  );

/** The live backlog still queued on `edge`, for asserting what a firing did and did not consume. */
const queued = (edge: Edge<number, string>): readonly number[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

/** One lane per available node, reading `count` off every edge that node's trigger names. */
const fixedReader = (
  count: MessageSchedule,
): DataflowScheduler<number, string> => ({
  create(_window: number, _threads: number): void {},
  schedule(
    available: ReadonlyMap<NodeIdType, NodeAvailability<number, string>>,
  ): Schedule {
    return [...available].map(([id, { trigger }]) => [
      {
        id,
        inputs: new Map<EdgeIdType, MessageSchedule>(
          trigger.rule.map((edgeId) => [edgeId, count]),
        ),
      },
    ]);
  },
});

test("value edge signals end-of-input: the squarer drains messages, then returns once the source's value lands", async () => {
  const e1 = messageEdge<number, string>("e1");
  const v = valueEdge<number, string>("v");
  const e2 = messageEdge<number, string>("e2");
  const graph = newGraph();
  const seen: number[] = [];
  const got: number[] = [];

  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(e1, 1), msg(e1, 2), msg(e1, 3)], "src"),
  });

  const sq = graph.addNode({
    state: undefined,
    trigger: anyOf(on(e1), on(v)),
    step: async function* () {
      let inputs = yield [];
      while (true) {
        const batch = from(inputs, e1);
        for (const n of batch) seen.push(n);
        if (batch.length === 0 && inputs.values.has(v.id))
          return `sq:${seen.join(",")}`;
        inputs = yield batch.map((n) => msg(e2, n * n));
      }
    },
  });

  const sink = graph.addNode({
    state: undefined,
    trigger: when(e2),
    step: async function* () {
      const view = yield [];
      for (const n of from(view, e2)) got.push(n);
      return `sink:${got.join("+")}`;
    },
  });

  graph.addEdge(src, sq, e1);
  graph.addEdge(src, sq, v);
  graph.addEdge(sq, sink, e2);

  const completed = await graph.run();
  assert.deepEqual(
    [...completed],
    [
      [src, "src"],
      [sq, "sq:1,2,3"],
      [sink, "sink:1+4+9"],
    ],
  );
  assert.deepEqual(graph.result(sq), O.some("sq:1,2,3"));
  assert.deepEqual(queued(e1), []);
  assert.deepEqual(queued(e2), []);
});

test("a ready dependent is primed without consuming its queued activation batch", async () => {
  const feed = messageEdge<number, string>("feed");
  const scheduled: NodeIdType[] = [];
  let turn = 0;
  const scheduler: DataflowScheduler<number, string> = {
    create(_window: number, _threads: number): void {},
    schedule(available) {
      const id = scheduled[turn]!;
      if (turn === 2) assert.deepEqual(queued(feed), [7]);
      turn += 1;
      return [[{ id, inputs: triggerInputs(available.get(id)!) }]];
    },
  };
  const graph = new DataflowGraph<void, number, string, never>(
    scheduler,
    Width(1),
    UNBOUNDED,
  );
  const received: number[] = [];

  const sourceId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(feed, 7)], "source"),
  });
  const dependentId = graph.addNode({
    state: undefined,
    trigger: when(feed),
    step: async function* (): NodeGenerator<number, string> {
      const view = yield [];
      received.push(...from(view, feed));
      return "dependent";
    },
  });
  graph.addEdge(sourceId, dependentId, feed);
  scheduled.push(sourceId, dependentId, dependentId, sourceId);

  const completed = await graph.run();

  assert.equal(turn, 4);
  assert.deepEqual(received, [7]);
  assert.deepEqual(queued(feed), []);
  assert.deepEqual(completed.get(dependentId), "dependent");
});

test("a partially satisfied `all` rule consumes nothing", async () => {
  const fed = messageEdge<number, string>("fed");
  const starved = messageEdge<number, string>("starved");
  const graph = newGraph();
  let fired = 0;

  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(fed, 1), msg(fed, 2)], "src"),
  });
  const gate = graph.addNode({
    state: undefined,
    trigger: allOf(on(fed), on(starved)),
    step: stepNode(() => {
      fired += 1;
      return [];
    }),
  });

  graph.addEdge(src, gate, fed);
  graph.addEdge(src, gate, starved);

  await graph.run();
  assert.equal(fired, 0);
  assert.deepEqual(queued(fed), [1, 2]);
});

test("a node body's throw surfaces as DataflowNodeError and terminates that node", async () => {
  const graph = newGraph();
  const failingId = graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
    step: async function* (): NodeGenerator<number, string> {
      throw new Error("boom");
    },
  });

  await assert.rejects(
    () => graph.run(),
    (thrown: unknown) =>
      thrown instanceof DataflowNodeError &&
      thrown.nodeId === failingId &&
      (thrown.error as Error).message === "boom",
  );
  assert.equal(graph.getNode(failingId)!.status, "done");
});

test("definition error: an explicitly duplicated node id is rejected", () => {
  const graph = newGraph();
  graph.addNode({
    state: undefined,
    id: NodeId("dup"),
    trigger: always(),
    step: stepNode(() => []),
  });
  assert.throws(
    () =>
      graph.addNode({
        state: undefined,
        id: NodeId("dup"),
        trigger: always(),
        step: stepNode(() => []),
      }),
    DataflowDefinitionError,
  );
});

test("definition error: an edge endpoint that is not a registered node is rejected", () => {
  const graph = newGraph();
  const real = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
  });
  assert.throws(
    () =>
      graph.addEdge(real, NodeId("ghost"), messageEdge<number, string>("e")),
    DataflowDefinitionError,
  );
});

test("definition error: the same edge id twice in one node's inbound set is rejected", () => {
  const graph = newGraph();
  const a = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
  });
  const b = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
  });
  graph.addEdge(a, sink, messageEdge<number, string>("shared"));
  assert.throws(
    () => graph.addEdge(b, sink, messageEdge<number, string>("shared")),
    DataflowDefinitionError,
  );
});

test("definition error: emitting on an unwired edge id is rejected", async () => {
  const ghost = messageEdge<number, string>("ghost");
  const graph = newGraph();
  graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => [msg(ghost, 1)]),
  });
  await assert.rejects(() => graph.run(), DataflowDefinitionError);
});

test("definition error: emitting a message on a value edge is rejected", async () => {
  const v = valueEdge<number, string>("v");
  const graph = newGraph();
  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => [msg(v, 1)]),
  });
  const dst = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
  });
  graph.addEdge(src, dst, v);
  await assert.rejects(() => graph.run(), DataflowDefinitionError);
});

test("definition error: run() is not re-entrant", async () => {
  const e = messageEdge<number, string>("e");
  const graph = newGraph();
  // A gate the test opens by hand: `run()` parks inside the source with no wall-clock dependency,
  // so the second `run()` provably observes an in-flight graph.
  const gate = Promise.withResolvers<void>();
  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    step: async function* (): NodeGenerator<number, string> {
      await gate.promise;
      yield [msg(e, 1)];
      return "src";
    },
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: when(e),
    step: stepNode(() => []),
  });
  graph.addEdge(src, sink, e);

  const inFlight = graph.run();
  await assert.rejects(() => graph.run(), DataflowDefinitionError);
  gate.resolve();
  await inFlight;
});

test("one firing reads exactly its planned count and leaves the rest queued", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 999 }), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.oneof(
        fc.constant<MessageSchedule>("all"),
        fc.constant<MessageSchedule>("none"),
        fc.integer({ min: 1, max: 8 }),
      ),
      async (items, count) => {
        fc.pre(typeof count !== "number" || count <= items.length);

        const feed = messageEdge<number, string>("feed");
        const graph = new DataflowGraph<void, number, string, never>(
          fixedReader(count),
          Width(1),
          UNBOUNDED,
        );
        const consumed: number[] = [];

        const producer = graph.addNode({
          state: undefined,
          trigger: always(),
          step: emitOnce(() => items.map((n) => msg(feed, n)), "fed"),
        });
        const consumer = graph.addNode({
          state: undefined,
          trigger: when(feed),
          step: async function* () {
            const view = yield [];
            for (const n of from(view, feed)) consumed.push(n);
            return "consumed";
          },
        });
        graph.addEdge(producer, consumer, feed);

        await graph.run();
        const remaining = queued(feed);
        assert.deepEqual([...consumed, ...remaining], items);
        assert.equal(
          consumed.length,
          count === "all" ? items.length : count === "none" ? 0 : count,
        );
      },
    ),
  );
});

test("the scheduler sizes each read: a pair-reading plan drains an `all` trigger two at a time", async () => {
  const feed = messageEdge<number, string>("feed");
  const batches: number[][] = [];

  const graph = new DataflowGraph<void, number, string, never>(
    fixedReader(2),
    Width(1),
    UNBOUNDED,
  );
  const srcId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [1, 2, 3, 4, 5].map((n) => msg(feed, n)), "src"),
  });
  const sinkId = graph.addNode({
    state: undefined,
    trigger: when(feed),
    step: stepNode<void, number, string>((_state, view) => {
      batches.push([...from(view, feed)]);
      return [];
    }),
  });
  graph.addEdge(srcId, sinkId, feed);

  await graph.run();
  assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
});

test("a depth threshold lives in `is_available`: the gate waits for three, then reads them at once", async () => {
  const feed = messageEdge<number, string>("feed");
  const graph = newGraph();
  const fires: number[][] = [];

  const srcId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: async function* (): NodeGenerator<number, string> {
      yield [msg(feed, 1)];
      yield [msg(feed, 2)];
      yield [msg(feed, 3)];
      return "src";
    },
  });
  const gateId = graph.addNode({
    state: undefined,
    trigger: when(feed),
    // What `on(feed, 3)` used to say. The trigger only knows "has something"; a deeper threshold
    // is the node's own business, and the probe view aliases the live queue.
    is_available: (view) => (view.messages.get(feed.id)?.length ?? 0) >= 3,
    step: stepNode<void, number, string>((_state, view) => {
      fires.push([...from(view, feed)]);
      return [];
    }),
  });
  graph.addEdge(srcId, gateId, feed);

  await graph.run();
  // One firing, not three: the gate stayed unavailable at depth 1 and 2.
  assert.deepEqual(fires, [[1, 2, 3]]);
  assert.deepEqual(queued(feed), []);
});
