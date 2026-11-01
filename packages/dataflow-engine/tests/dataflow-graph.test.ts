/// <reference lib="es2024.promise" />
import { test } from "bun:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import fc from "fast-check";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { Snapshot } from "junco-scheduler";
import {
  context,
  parallel,
  roundRobin,
  select,
  separate,
} from "junco-scheduler";
import { type Static, Type } from "typebox";
import type {
  DataflowExecution,
  DataflowRunOptions,
  EdgeIdType,
  InputSchedule,
  MessageSchedule,
  NodeAvailability,
  NodeGenerator,
  NodeIdType,
  ParentView,
  Schedule,
} from "../src/index.ts";
import {
  DataflowDefinitionError,
  DataflowGraph,
  DataflowNodeError,
  Edge,
  EdgeId,
  EmitOnce,
  from,
  Message,
  NodeId,
  Sink,
  Source,
  StepNode,
  TriggerEntry,
  TriggerRule,
  triggerInputs,
  UNBOUNDED,
  Width,
} from "../src/index.ts";
import { queued } from "./support.ts";

const NumberSchema = Type.Number();
const StringSchema = Type.String();
type N = typeof NumberSchema;

type Graph = DataflowGraph<void, N, string, never>;

const newGraph = (): Graph =>
  new DataflowGraph<void, N, string, never>(Width.create(1), UNBOUNDED);

/** Read `count` off every edge named by the candidate's trigger. */
const fixedReader =
  (count: MessageSchedule) =>
  (_id: NodeIdType, { trigger }: NodeAvailability<N, string>): InputSchedule =>
    new Map<EdgeIdType, MessageSchedule>(
      trigger.rule.map((edgeId) => [edgeId, count]),
    );

test("a value self-edge re-arms its node: each return re-resolves outputs and the node runs again until its availability declines", async () => {
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const seed = Edge.message<N, string>("seed", NumberSchema);
  const loop = Edge.value("loop", StringSchema);
  const out = Edge.value("out", StringSchema);
  const tap = Edge.value("tap", StringSchema);
  let primes = 0;
  let activations = 0;
  const source = graph.addNode(
    new EmitOnce<void, N, string>(() => [Message.create(seed, 1)], "seed", {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const aId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.anyOf(TriggerEntry.on(seed), TriggerEntry.on(loop)),
    is_available: (_view, triggered) =>
      triggered && (graph.getNode(aId)!.status === "running" || primes < 3),
    step: async function* () {
      primes++;
      const view = yield [];
      return String(Number(view.values.get(loop.id) ?? "0") + 1);
    },
  });
  const bId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(out),
    is_available: (_view, triggered) =>
      triggered && O.toUndefined(graph.result(aId)) === "3",
    step: async function* () {
      const view = yield [];
      return view.values.get(out.id)!;
    },
  });
  const cId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(tap),
    step: async function* () {
      activations++;
      const view = yield [];
      return view.values.get(tap.id)!;
    },
  });
  graph
    .addEdge(source, aId, seed)
    .addEdge(aId, aId, loop)
    .addEdge(aId, bId, out)
    .addEdge(aId, cId, tap);
  const results = await execution.run();
  assert.equal(primes, 3);
  assert.equal(results.get(aId), "3");
  assert.equal(results.get(bId), "3");
  assert.equal(results.get(cId), "1");
  assert.equal(activations, 1);
  assert.equal(graph.available().size, 0);
});

test("value edge signals end-of-input: the squarer drains messages, then returns once the source's value lands", async () => {
  const e1 = Edge.message<N, string>("e1", NumberSchema);
  const v = Edge.value("v", StringSchema);
  const e2 = Edge.message<N, string>("e2", NumberSchema);
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const seen: number[] = [];
  const got: number[] = [];

  const src = graph.addNode(
    new EmitOnce<void, N, string>(
      () => [
        Message.create(e1, 1),
        Message.create(e1, 2),
        Message.create(e1, 3),
      ],
      "src",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );

  const sq = graph.addNode({
    state: undefined,
    trigger: TriggerRule.anyOf(TriggerEntry.on(e1), TriggerEntry.on(v)),
    step: async function* () {
      let inputs = yield [];
      while (true) {
        const batch = from(inputs, e1);
        for (const n of batch) seen.push(n);
        if (batch.length === 0 && inputs.values.has(v.id))
          return `sq:${seen.join(",")}`;
        inputs = yield batch.map((n) => Message.create(e2, n * n));
      }
    },
  });

  const sink = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(e2),
    step: async function* () {
      const view = yield [];
      for (const n of from(view, e2)) got.push(n);
      return `sink:${got.join("+")}`;
    },
  });

  graph.addEdge(src, sq, e1);
  graph.addEdge(src, sq, v);
  graph.addEdge(sq, sink, e2);

  const completed = await execution.run();
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
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const scheduled: NodeIdType[] = [];
  let turn = 0;
  const graph = newGraph();
  const execution = context({
    graph,
    scheduler() {
      const id = scheduled[turn]!;
      if (turn === 2) assert.deepEqual(queued(feed), [7]);
      turn += 1;
      return { selected: select([id]) };
    },
  });
  const received: number[] = [];

  const sourceId = graph.addNode(
    new EmitOnce<void, N, string>(() => [Message.create(feed, 7)], "source", {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const dependentId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(feed),
    step: async function* (): NodeGenerator<N, string> {
      const view = yield [];
      received.push(...from(view, feed));
      return "dependent";
    },
  });
  graph.addEdge(sourceId, dependentId, feed);
  scheduled.push(sourceId, dependentId, dependentId, sourceId);

  const completed = await execution.run();

  assert.equal(turn, 4);
  assert.deepEqual(received, [7]);
  assert.deepEqual(queued(feed), []);
  assert.deepEqual(completed.get(dependentId), "dependent");
});

test("a partially satisfied `all` rule consumes nothing", async () => {
  const fed = Edge.message<N, string>("fed", NumberSchema);
  const starved = Edge.message<N, string>("starved", NumberSchema);
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  let fired = 0;

  const src = graph.addNode(
    new EmitOnce<void, N, string>(
      () => [Message.create(fed, 1), Message.create(fed, 2)],
      "src",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const gate = graph.addNode(
    new StepNode<void, N, string>(
      () => {
        fired += 1;
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(fed),
          TriggerEntry.on(starved),
        ),
      },
    ),
  );

  graph.addEdge(src, gate, fed);
  graph.addEdge(src, gate, starved);

  await execution.run();
  assert.equal(fired, 0);
  assert.deepEqual(queued(fed), [1, 2]);
});

test("a node body's throw surfaces as DataflowNodeError and terminates that node", async () => {
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const sentinel = new Error("sentinel");
  const failingId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
    step: async function* (): NodeGenerator<N, string> {
      throw sentinel;
    },
  });

  await assert.rejects(
    () => execution.run(),
    (thrown: unknown) =>
      thrown instanceof DataflowNodeError &&
      thrown.nodeId === failingId &&
      thrown.error === sentinel &&
      thrown.cause === sentinel,
  );
  assert.equal(graph.getNode(failingId)!.status, "done");
});

test("omitted node ids continue after explicit ones without disturbing earlier nodes", async () => {
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  for (const id of ["0", "1"])
    graph.addNode(
      new EmitOnce<void, N, string>(() => [], `r${id}`, {
        state: undefined,
        id: NodeId.create(id),
        trigger: TriggerRule.always(),
      }),
    );
  await execution.run();
  const added = [0, 1].map(() =>
    graph.addNode(
      new StepNode<void, N, string>(() => [], {
        state: undefined,
        trigger: TriggerRule.never(),
      }),
    ),
  );
  assert.deepEqual(added, [NodeId.create("2"), NodeId.create("3")]);
  assert.deepEqual(graph.result(NodeId.create("0")), O.some("r0"));
  assert.deepEqual(graph.result(NodeId.create("1")), O.some("r1"));
  assert.equal(graph.getNode(NodeId.create("0"))!.status, "done");
  assert.equal(graph.getNode(NodeId.create("missing")), undefined);
});

test("definition error: a missing source or an outbound duplicate edge id is rejected; per-side ids may repeat", () => {
  const graph = newGraph();
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) =>
    graph.addNode(
      new StepNode<void, N, string>(() => [], {
        state: undefined,
        id: NodeId.create(id),
        trigger: TriggerRule.always(),
      }),
    ),
  ) as [NodeIdType, NodeIdType, NodeIdType, NodeIdType];
  graph.addEdge(a, b, Edge.message<N, string>("shared", NumberSchema));
  graph.addEdge(c, d, Edge.message<N, string>("shared", NumberSchema));
  assert.throws(
    () =>
      graph.addEdge(
        NodeId.create("ghost"),
        b,
        Edge.message<N, string>("e", NumberSchema),
      ),
    DataflowDefinitionError,
  );
  assert.throws(
    () => graph.addEdge(a, d, Edge.message<N, string>("shared", NumberSchema)),
    DataflowDefinitionError,
  );
  const links: [string, string, string][] = [];
  graph.forEachLink((from, to, edge) => links.push([from, to, edge.id]));
  assert.deepEqual(links.sort(), [
    ["a", "b", "shared"],
    ["c", "d", "shared"],
  ]);
});

test("definition error: an invalid plan rejects before any node advances or consumes, and a valid plan then advances", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const other = Edge.message<N, string>("other", NumberSchema);
  const graph = newGraph();
  const advances: Record<string, number> = { S: 0, C: 0, D: 0 };
  const counted = (name: string) =>
    async function* (): NodeGenerator<N, string> {
      while (true) {
        advances[name]! += 1;
        yield [];
      }
    };
  const s = graph.addNode({
    id: NodeId.create("S"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: counted("S"),
  });
  const c = graph.addNode({
    id: NodeId.create("C"),
    state: undefined,
    trigger: TriggerRule.when(feed),
    step: counted("C"),
  });
  const d = graph.addNode({
    id: NodeId.create("D"),
    state: undefined,
    trigger: TriggerRule.when(other),
    step: counted("D"),
  });
  graph.addEdge(s, c, feed).addEdge(s, d, other);
  graph.emit(s, Message.create(feed, 1));
  graph.emit(s, Message.create(feed, 2));
  graph.emit(s, Message.create(other, 5));

  const reads = (id: NodeIdType, edge: EdgeIdType, count: MessageSchedule) => ({
    id,
    inputs: new Map<EdgeIdType, MessageSchedule>([[edge, count]]),
  });
  const none = new Map<EdgeIdType, MessageSchedule>();
  const invalid: Schedule[] = [
    [
      [
        { id: s, inputs: none },
        { id: s, inputs: none },
      ],
    ],
    [[{ id: NodeId.create("missing"), inputs: none }]],
    [[{ id: s, inputs: none }], [{ id: s, inputs: none }]],
    [[reads(c, other.id, "all")]],
    [[reads(c, feed.id, 0)]],
    [[reads(c, feed.id, -1)]],
    [[reads(c, feed.id, 1.5)]],
  ];
  const before = graph.observe();
  const columns: (readonly NodeIdType[])[] = [];
  for (const candidate of invalid) {
    await assert.rejects(
      graph.evaluate((execute) =>
        execute(candidate, {
          onColumn: (selected) => columns.push([...selected]),
        }),
      ),
      DataflowDefinitionError,
    );
    assert.deepEqual(advances, { S: 0, C: 0, D: 0 });
    assert.deepEqual(queued(feed), [1, 2]);
    assert.deepEqual(queued(other), [5]);
    assert.equal(graph.observe().version, before.version);
    assert.deepEqual(columns, []);
    for (const id of [s, c, d])
      assert.equal(graph.getNode(id)!.status, "ready");
  }

  await graph.evaluate((execute) =>
    execute([[{ id: s, inputs: none }], [reads(c, feed.id, 1)]], {
      onColumn: (selected) => columns.push([...selected]),
    }),
  );
  assert.deepEqual(advances, { S: 1, C: 1, D: 0 });
  assert.deepEqual(queued(feed), [1, 2]);
  assert.deepEqual(columns, [[s, c]]);
});

test("definition error: an explicitly duplicated node id is rejected", () => {
  const graph = newGraph();
  graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      id: NodeId.create("dup"),
      trigger: TriggerRule.always(),
    }),
  );
  assert.throws(
    () =>
      graph.addNode(
        new StepNode<void, N, string>(() => [], {
          state: undefined,
          id: NodeId.create("dup"),
          trigger: TriggerRule.always(),
        }),
      ),
    DataflowDefinitionError,
  );
});

test("definition error: an edge endpoint that is not a registered node is rejected", () => {
  const graph = newGraph();
  const real = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  assert.throws(
    () =>
      graph.addEdge(
        real,
        NodeId.create("ghost"),
        Edge.message<N, string>("e", NumberSchema),
      ),
    DataflowDefinitionError,
  );
});

test("definition error: the same edge id twice in one node's inbound set is rejected", () => {
  const graph = newGraph();
  const a = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const b = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const sink = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  graph.addEdge(a, sink, Edge.message<N, string>("shared", NumberSchema));
  assert.throws(
    () =>
      graph.addEdge(b, sink, Edge.message<N, string>("shared", NumberSchema)),
    DataflowDefinitionError,
  );
});

test("definition error: emitting on an unwired edge id is rejected", async () => {
  const ghost = Edge.message<N, string>("ghost", NumberSchema);
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  let handled = 0;
  const source = graph.addNode(
    new StepNode<void, N, string>(() => [Message.create(ghost, 1)], {
      state: undefined,
      trigger: TriggerRule.always(),
      on_error() {
        handled += 1;
        return [];
      },
    }),
  );
  assert.throws(
    () => graph.emit(source, Message.create(ghost, 1)),
    DataflowDefinitionError,
  );
  await assert.rejects(() => execution.run(), DataflowDefinitionError);
  assert.equal(handled, 0);
});

test("definition error: emitting a message on a value edge is rejected", async () => {
  const v = Edge.value("v", StringSchema);
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  let handled = 0;
  const src = graph.addNode(
    new StepNode<void, N, string>(() => [Message.create(v, 1 as never)], {
      state: undefined,
      trigger: TriggerRule.always(),
      on_error() {
        handled += 1;
        return [];
      },
    }),
  );
  const dst = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  graph.addEdge(src, dst, v);
  assert.throws(
    () => graph.emit(src, Message.create(v, 1 as never)),
    DataflowDefinitionError,
  );
  assert.ok(E.isRight(v.transport) && O.isNone(v.transport.right));
  await assert.rejects(() => execution.run(), DataflowDefinitionError);
  assert.equal(handled, 0);
});

test("public emit enqueues FIFO without driving, consuming, or completing any node", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const done = Edge.value("done", StringSchema);
  const graph = new DataflowGraph<void, N, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const execution = context({
    graph,
    scheduler: parallel(),
    readInputs: fixedReader(2),
  });
  const batches: number[][] = [];
  const source = graph.addNode(
    new EmitOnce<void, N, string>(() => [], "source", {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const sink = graph.addNode(
    new StepNode<void, N, string>(
      (_state, view) => {
        batches.push([...from(view, feed)]);
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(feed),
      },
    ),
  );
  graph.addEdge(source, sink, feed);
  graph.addEdge(source, sink, done);

  graph.emit(source, Message.create(feed, 1));
  graph.emit(source, Message.create(feed, 2));
  graph.emit(source, Message.create(feed, 3));
  assert.throws(
    () => graph.emit(sink, Message.create(feed, 99)),
    DataflowDefinitionError,
  );
  assert.deepEqual(queued(feed), [1, 2, 3]);
  assert.deepEqual(batches, []);
  assert.equal(graph.getNode(source)!.status, "ready");
  assert.equal(graph.getNode(sink)!.status, "ready");
  assert.ok(O.isNone(graph.result(source)));
  assert.ok(E.isRight(done.transport) && O.isNone(done.transport.right));

  await execution.step();
  assert.deepEqual(queued(feed), [1, 2, 3]);
  assert.deepEqual(batches, []);

  const results = await execution.run();
  assert.deepEqual(batches, [[1, 2], [3]]);
  assert.deepEqual(queued(feed), []);
  assert.equal(results.get(source), "source");
  assert.deepEqual(done.transport, E.right(O.some("source")));
  assert.equal(results.has(sink), false);

  graph.emit(source, Message.create(feed, 4));
  await execution.run();
  assert.deepEqual(batches, [[1, 2], [3], [4]]);
  assert.deepEqual(graph.result(source), O.some("source"));
});

test("definition error: step() and run() reject re-entry from either method while one is in flight", async () => {
  for (const [first, second] of [
    ["step", "run"],
    ["run", "step"],
    ["run", "run"],
    ["step", "step"],
  ] as const) {
    const e = Edge.message<N, string>("e", NumberSchema);
    const graph = newGraph();
    const execution = context({ graph, scheduler: parallel() });
    // A gate the test opens by hand: the first call parks inside the source with no wall-clock
    // dependency, so the second call provably observes an in-flight graph.
    const gate = Promise.withResolvers<void>();
    const src = graph.addNode({
      state: undefined,
      trigger: TriggerRule.always(),
      step: async function* (): NodeGenerator<N, string> {
        await gate.promise;
        yield [Message.create(e, 1)];
        return "src";
      },
    });
    const sink = graph.addNode(
      new StepNode<void, N, string>(() => [], {
        state: undefined,
        trigger: TriggerRule.when(e),
      }),
    );
    graph.addEdge(src, sink, e);

    const inFlight = execution[first]();
    await assert.rejects(() => execution[second](), DataflowDefinitionError);
    gate.resolve();
    await inFlight;
    // The guard is released on settlement: the graph is drivable again.
    await execution.run();
    assert.deepEqual(graph.result(src), O.some("src"));
  }
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

        const feed = Edge.message<N, string>("feed", NumberSchema);
        const graph = new DataflowGraph<void, N, string, never>(
          Width.create(1),
          UNBOUNDED,
        );
        const execution = context({
          graph,
          scheduler: parallel(),
          readInputs: fixedReader(count),
        });
        const consumed: number[] = [];

        const producer = graph.addNode(
          new EmitOnce<void, N, string>(
            () => items.map((n) => Message.create(feed, n)),
            "fed",
            {
              state: undefined,
              trigger: TriggerRule.always(),
            },
          ),
        );
        const consumer = graph.addNode({
          state: undefined,
          trigger: TriggerRule.when(feed),
          step: async function* () {
            const view = yield [];
            for (const n of from(view, feed)) consumed.push(n);
            return "consumed";
          },
        });
        graph.addEdge(producer, consumer, feed);

        await execution.run();
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
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const batches: number[][] = [];

  const graph = new DataflowGraph<void, N, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const execution = context({
    graph,
    scheduler: parallel(),
    readInputs: fixedReader(2),
  });
  const srcId = graph.addNode(
    new EmitOnce<void, N, string>(
      () => [1, 2, 3, 4, 5].map((n) => Message.create(feed, n)),
      "src",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const sinkId = graph.addNode(
    new StepNode<void, N, string>(
      (_state, view) => {
        batches.push([...from(view, feed)]);
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(feed),
      },
    ),
  );
  graph.addEdge(srcId, sinkId, feed);

  await execution.run();
  assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
});

test("a depth threshold lives in `is_available`: the gate waits for three, then reads them at once", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const fires: number[][] = [];

  const srcId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<N, string> {
      yield [Message.create(feed, 1)];
      yield [Message.create(feed, 2)];
      yield [Message.create(feed, 3)];
      return "src";
    },
  });
  const gateId = graph.addNode(
    new StepNode<void, N, string>(
      (_state, view) => {
        fires.push([...from(view, feed)]);
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(feed),
        // What `TriggerEntry.on(feed, 3)` used to say. The trigger only knows "has something"; a deeper threshold
        // is the node's own business, and the probe view aliases the live queue.
        is_available: (view) => (view.messages.get(feed.id)?.length ?? 0) >= 3,
      },
    ),
  );
  graph.addEdge(srcId, gateId, feed);

  await execution.run();
  // One firing, not three: the gate stayed unavailable at depth 1 and 2.
  assert.deepEqual(fires, [[1, 2, 3]]);
  assert.deepEqual(queued(feed), []);
});

test("the graph evaluates triggers before availability: unfired and finished nodes never reach the planner", async () => {
  const empty = Edge.message<N, string>("empty", NumberSchema);
  const unfed = Edge.message<N, string>("unfed", NumberSchema);
  const planned: string[][] = [];
  const graph = new DataflowGraph<void, N, string, never>(UNBOUNDED, UNBOUNDED);
  const execution = context({
    graph,
    scheduler(snapshot) {
      planned.push([...snapshot.available]);
      return parallel()(snapshot);
    },
  });
  const hooked: boolean[] = [];
  const src = graph.addNode(
    new EmitOnce<void, N, string>(() => [], "src", {
      id: NodeId.create("src"),
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const waiting = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      id: NodeId.create("waiting"),
      state: undefined,
      trigger: TriggerRule.when(empty),
    }),
  );
  const idle = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      id: NodeId.create("never"),
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  const observed = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      id: NodeId.create("observed"),
      state: undefined,
      trigger: TriggerRule.when(unfed),
      is_available: (_view, triggered) => {
        hooked.push(triggered);
        return false;
      },
    }),
  );
  graph.addEdge(src, waiting, empty);
  graph.addEdge(src, observed, unfed);

  assert.deepEqual(
    [...graph.available()].map(([id, { status }]) => [id, status]),
    [[src, "ready"]],
  );
  await execution.step();
  assert.deepEqual(
    [...graph.available()].map(([id, { status }]) => [id, status]),
    [[src, "running"]],
  );
  await execution.run();

  // Priming and finishing `src` were the only plans; once it is done nothing remains to plan.
  assert.deepEqual(planned, [["src"], ["src"]]);
  assert.deepEqual(graph.result(src), O.some("src"));
  assert.equal(graph.available().size, 0);
  assert.ok(hooked.length > 0 && hooked.every((triggered) => !triggered));
  for (const id of [waiting, idle, observed]) {
    assert.equal(graph.getNode(id)!.status, "ready");
  }
});

test("every trigger edge is validated even when the availability hook would refuse the node", () => {
  const unwired = Edge.message<N, string>("unwired", NumberSchema);
  const graph = newGraph();
  let consulted = 0;
  graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.when(unwired),
      is_available: () => {
        consulted += 1;
        return false;
      },
    }),
  );

  assert.throws(() => graph.available(), DataflowDefinitionError);
  assert.equal(consulted, 0);
});

/** Concrete matrix fixture: one lexical plan per evaluation, with no policy binding. */
const scripted = (
  windows: readonly (readonly (readonly string[])[])[],
  resolveInputs?: NonNullable<
    Parameters<DataflowExecution<N, string>>[1]
  >["resolveInputs"],
) => {
  const graph = new DataflowGraph<void, N, string, never>(UNBOUNDED, UNBOUNDED);
  let planned = 0;
  const columns: (readonly NodeIdType[])[] = [];
  const drive = (repeat: boolean, options?: DataflowRunOptions) =>
    graph.evaluate(async (execute, signal) => {
      do {
        signal?.throwIfAborted();
        const available = graph.available();
        if (available.size === 0) break;
        const lanes = windows[planned++];
        assert.ok(lanes !== undefined, "unscripted window");
        const schedule = lanes.map((lane) =>
          lane.map((name) => {
            const id = NodeId.create(name);
            const candidate = available.get(id);
            return {
              id,
              inputs:
                candidate === undefined
                  ? new Map<EdgeIdType, MessageSchedule>()
                  : triggerInputs(candidate),
            };
          }),
        );
        await execute(schedule, {
          ...(resolveInputs === undefined ? {} : { resolveInputs }),
          onColumn: (selected) => columns.push([...selected]),
        });
      } while (repeat);
      return graph.results();
    }, options);
  return {
    graph,
    get planned() {
      return planned;
    },
    columns,
    step: (options?: DataflowRunOptions) => drive(false, options),
    run: (options?: DataflowRunOptions) => drive(true, options),
  };
};

/** An actor body that records each delivered batch per edge; its StepNode never finishes. */
const recorder =
  (edges: readonly Edge<N, string>[], seen: Record<string, number[]>[]) =>
  <S>(_state: S, view: ParentView<N, string>): Message<N>[] => {
    seen.push(
      Object.fromEntries(edges.map((edge) => [edge.id, [...from(view, edge)]])),
    );
    return [];
  };

test("a node that finished earlier in the window is skipped, keeping its result", async () => {
  const execution = scripted([[["A", "A"]]]);
  const { graph } = execution;
  let bodies = 0;
  const a = graph.addNode({
    id: NodeId.create("A"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<N, string> {
      bodies += 1;
      return "kept";
    },
  });

  const completed = await execution.step();
  assert.equal(bodies, 1);
  assert.equal(completed.get(a), "kept");
  assert.deepEqual(graph.result(a), O.some("kept"));
  assert.equal(graph.available().size, 0);
  assert.deepEqual(execution.columns, [[a]]);
});

test("a later occurrence of a node that went unavailable consumes nothing and does not advance", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const execution = scripted([[["P"]], [["C", "C", "C"]]]);
  const { graph } = execution;
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode(
    new EmitOnce<void, N, string>(() => [Message.create(feed, 7)], "p", {
      id: NodeId.create("P"),
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const c = graph.addNode(
    new StepNode<void, N, string>(recorder([feed], seen), {
      id: NodeId.create("C"),
      state: undefined,
      trigger: TriggerRule.when(feed),
    }),
  );
  graph.addEdge(p, c, feed);

  await execution.step();
  assert.equal(graph.getNode(c)!.status, "ready");
  // Column 0 primes C, column 1 drains its sole input, column 2 finds it unavailable.
  await execution.step();
  assert.deepEqual(seen, [{ feed: [7] }]);
  assert.deepEqual(queued(feed), []);
  assert.equal(execution.planned, 2);
  assert.deepEqual(execution.columns, [[p], [c], [c]]);
});

test("step() runs exactly one window; run() drives to quiescence; an idle step() never plans", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const execution = scripted([[["P"]], [["P"], ["C"]], [["C"]]]);
  const { graph } = execution;
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode(
    new EmitOnce<void, N, string>(() => [Message.create(feed, 1)], "p", {
      id: NodeId.create("P"),
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const c = graph.addNode(
    new StepNode<void, N, string>(recorder([feed], seen), {
      id: NodeId.create("C"),
      state: undefined,
      trigger: TriggerRule.when(feed),
    }),
  );
  graph.addEdge(p, c, feed);

  const afterStep = await execution.step();
  assert.equal(execution.planned, 1);
  assert.equal(afterStep.size, 0);
  assert.deepEqual(queued(feed), [1]);
  assert.deepEqual([...graph.available().keys()], [p, c]);

  const completed = await execution.run();
  assert.equal(execution.planned, 3);
  assert.deepEqual([...completed], [[p, "p"]]);
  assert.deepEqual(seen, [{ feed: [1] }]);
  assert.equal(graph.available().size, 0);

  assert.deepEqual(await execution.step(), completed);
  assert.equal(execution.planned, 3);
});

test("a column runs its lanes concurrently and the next column waits for all of them", async () => {
  const execution = scripted([[["A", "C"], ["B"]]]);
  const { graph } = execution;
  const log: string[] = [];
  const aStarted = Promise.withResolvers<void>();
  const bStarted = Promise.withResolvers<void>();
  const aDone = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();
  let cStarted = false;
  const gated = (
    name: string,
    started: () => void,
    release: Promise<void>,
    done?: () => void,
  ) =>
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    async function* (): NodeGenerator<N, string> {
      log.push(`${name}:start`);
      started();
      await release;
      log.push(`${name}:end`);
      done?.();
      return name;
    };
  graph.addNode({
    id: NodeId.create("A"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: gated("A", aStarted.resolve, releaseA.promise, aDone.resolve),
  });
  graph.addNode({
    id: NodeId.create("B"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: gated("B", bStarted.resolve, releaseB.promise),
  });
  graph.addNode({
    id: NodeId.create("C"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<N, string> {
      cStarted = true;
      log.push("C");
      return "C";
    },
  });

  const stepped = execution.step();
  await Promise.all([aStarted.promise, bStarted.promise]);
  releaseA.resolve();
  await aDone.promise;
  assert.equal(cStarted, false);
  releaseB.resolve();
  await stepped;
  assert.deepEqual(log, ["A:start", "B:start", "A:end", "B:end", "C"]);
});

test("an aborted signal lets the running column drain, then rejects with its reason before the next column", async () => {
  const execution = scripted([[["A", "B"]]]);
  const { graph } = execution;
  const aStarted = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  let bRan = false;
  const a = graph.addNode({
    id: NodeId.create("A"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<N, string> {
      aStarted.resolve();
      await releaseA.promise;
      return "A";
    },
  });
  const b = graph.addNode({
    id: NodeId.create("B"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<N, string> {
      bRan = true;
      return "B";
    },
  });

  const controller = new AbortController();
  const reason = new Error("stop");
  const stepped = execution.step({ signal: controller.signal });
  await aStarted.promise;
  controller.abort(reason);
  releaseA.resolve();
  await assert.rejects(stepped, (error) => error === reason);
  assert.deepEqual(graph.result(a), O.some("A"));
  assert.equal(bRan, false);
  assert.equal(graph.getNode(b)!.status, "ready");

  // An already-aborted signal is observed before planning.
  await assert.rejects(
    execution.run({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(execution.planned, 1);
  assert.deepEqual(execution.columns, [[a]]);
});

test("resolveInputs keeps an `all` trigger atomic for a live actor: a lone replenished edge is not drained", async () => {
  const e1 = Edge.message<N, string>("e1", NumberSchema);
  const e2 = Edge.message<N, string>("e2", NumberSchema);
  const execution = scripted(
    [
      [["P"], ["X"]],
      [["X", "X"], ["P"]],
    ],
    (_entry, live) => triggerInputs(live),
  );
  const { graph } = execution;
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode({
    id: NodeId.create("P"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<N, string> {
      yield [Message.create(e1, 1), Message.create(e2, 2)];
      // The sibling lane replenishes only e1, after X consumed column 0's batch.
      yield [Message.create(e1, 3)];
      return "p";
    },
  });
  const x = graph.addNode(
    new StepNode<void, N, string>(recorder([e1, e2], seen), {
      id: NodeId.create("X"),
      state: undefined,
      trigger: TriggerRule.allOf(TriggerEntry.on(e1), TriggerEntry.on(e2)),
      // An active actor stays resumable even when its trigger is drained.
      is_available: () => true,
    }),
  );
  graph.addEdge(p, x, e1);
  graph.addEdge(p, x, e2);

  await execution.step();
  await execution.step();
  assert.deepEqual(seen, [
    { e1: [1], e2: [2] },
    { e1: [], e2: [] },
  ]);
  assert.deepEqual(queued(e1), [3]);
});

test("resolveInputs lets a later message win over an already-delivered value on an `any` trigger", async () => {
  const v = Edge.value("v", StringSchema);
  const m = Edge.message<N, string>("m", NumberSchema);
  const delivered = new Set<EdgeIdType>();
  const execution = scripted(
    [
      [["V"], ["M"]],
      [["X", "X", "X"], ["M"]],
    ],
    (_entry, live) => {
      const edge = live.satisfied.find((id) => !delivered.has(id));
      return new Map<EdgeIdType, MessageSchedule>(
        edge === undefined ? [] : [[edge, "all"]],
      );
    },
  );
  const { graph } = execution;
  const batches: number[][] = [];
  let valueViews = 0;
  const vId = graph.addNode({
    id: NodeId.create("V"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the source returns on its first activation.
    step: async function* (): NodeGenerator<N, string> {
      return "val";
    },
  });
  const x = graph.addNode(
    new StepNode<void, N, string>(
      (_state, view) => {
        if (view.values.has(v.id) && !delivered.has(v.id)) {
          delivered.add(v.id);
          valueViews += 1;
        }
        batches.push([...from(view, m)]);
        return [];
      },
      {
        id: NodeId.create("X"),
        state: undefined,
        trigger: TriggerRule.anyOf(TriggerEntry.on(v), TriggerEntry.on(m)),
      },
    ),
  );
  const mId = graph.addNode({
    id: NodeId.create("M"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<N, string> {
      yield [];
      yield [Message.create(m, 5)];
      return "m";
    },
  });
  graph.addEdge(vId, x, v);
  graph.addEdge(mId, x, m);

  await execution.step();
  // Column 0 primes X, column 1 delivers the value, column 2 picks the message M emitted meanwhile.
  await execution.step();
  assert.equal(valueViews, 1);
  assert.deepEqual(batches, [[], [5]]);
  assert.deepEqual(queued(m), []);
});

test("an invalid resolved read map rejects before any node of that column advances or consumes", async () => {
  const ex = Edge.message<N, string>("ex", NumberSchema);
  const ey = Edge.message<N, string>("ey", NumberSchema);
  const execution = scripted(
    [[["P"]], [["X"], ["Y"]], [["X"], ["Y"]]],
    (entry, live) =>
      entry.id === NodeId.create("Y")
        ? new Map<EdgeIdType, MessageSchedule>([[ex.id, "all"]])
        : triggerInputs(live),
  );
  const { graph } = execution;
  const seen: Record<string, number[]>[] = [];
  let handled = 0;
  const on_error = () => {
    handled += 1;
    return [];
  };
  const p = graph.addNode(
    new EmitOnce<void, N, string>(
      () => [Message.create(ex, 1), Message.create(ey, 2)],
      "p",
      {
        id: NodeId.create("P"),
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const x = graph.addNode(
    new StepNode<void, N, string>(recorder([ex], seen), {
      id: NodeId.create("X"),
      state: undefined,
      trigger: TriggerRule.when(ex),
      on_error,
    }),
  );
  const y = graph.addNode(
    new StepNode<void, N, string>(recorder([ey], seen), {
      id: NodeId.create("Y"),
      state: undefined,
      trigger: TriggerRule.when(ey),
      on_error,
    }),
  );
  graph.addEdge(p, x, ex);
  graph.addEdge(p, y, ey);

  await execution.step();
  await execution.step();
  await assert.rejects(execution.step(), DataflowDefinitionError);
  assert.deepEqual(seen, []);
  assert.equal(handled, 0);
  assert.deepEqual(queued(ex), [1]);
  assert.deepEqual(queued(ey), [2]);
  assert.equal(graph.getNode(x)!.status, "running");
  assert.equal(graph.getNode(y)!.status, "running");
});

test("a throwing resolveInputs escapes unchanged before any node of that column advances or consumes", async () => {
  const ex = Edge.message<N, string>("ex", NumberSchema);
  const ey = Edge.message<N, string>("ey", NumberSchema);
  const sentinel = new Error("sentinel");
  const execution = scripted([[["P"]], [["X"], ["Y"]], [["X"], ["Y"]]], () => {
    throw sentinel;
  });
  const { graph } = execution;
  const seen: Record<string, number[]>[] = [];
  let handled = 0;
  const on_error = () => {
    handled += 1;
    return [];
  };
  const p = graph.addNode(
    new EmitOnce<void, N, string>(
      () => [Message.create(ex, 1), Message.create(ey, 2)],
      "p",
      {
        id: NodeId.create("P"),
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const x = graph.addNode(
    new StepNode<void, N, string>(recorder([ex], seen), {
      id: NodeId.create("X"),
      state: undefined,
      trigger: TriggerRule.when(ex),
      on_error,
    }),
  );
  const y = graph.addNode(
    new StepNode<void, N, string>(recorder([ey], seen), {
      id: NodeId.create("Y"),
      state: undefined,
      trigger: TriggerRule.when(ey),
      on_error,
    }),
  );
  graph.addEdge(p, x, ex);
  graph.addEdge(p, y, ey);

  await execution.step();
  await execution.step();
  await assert.rejects(execution.step(), (error) => error === sentinel);
  assert.deepEqual(seen, []);
  assert.equal(handled, 0);
  assert.deepEqual(queued(ex), [1]);
  assert.deepEqual(queued(ey), [2]);
  assert.equal(graph.getNode(x)!.status, "running");
  assert.equal(graph.getNode(y)!.status, "running");
});

test("a throwing schedule callback rejects the invocation without node work; the next invocation succeeds", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const sentinel = new Error("sentinel");
  let failing = true;
  const graph = newGraph();
  const execution = context({
    graph,
    scheduler(snapshot) {
      if (failing) throw sentinel;
      return parallel()(snapshot);
    },
  });
  const seen: Record<string, number[]>[] = [];
  let handled = 0;
  const source = graph.addNode(
    new EmitOnce<void, N, string>(() => [], "source", {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );
  const sink = graph.addNode(
    new StepNode<void, N, string>(recorder([feed], seen), {
      state: undefined,
      trigger: TriggerRule.when(feed),
      on_error() {
        handled += 1;
        return [];
      },
    }),
  );
  graph.addEdge(source, sink, feed);
  graph.emit(source, Message.create(feed, 1));

  await assert.rejects(execution.run(), (error) => error === sentinel);
  assert.deepEqual(seen, []);
  assert.equal(handled, 0);
  assert.deepEqual(queued(feed), [1]);
  assert.equal(graph.getNode(source)!.status, "ready");
  assert.equal(graph.getNode(sink)!.status, "ready");

  failing = false;
  const results = await execution.run();
  assert.equal(results.get(source), "source");
  assert.deepEqual(seen, [{ feed: [1] }]);
  assert.deepEqual(queued(feed), []);
});

test("without resolveInputs every occurrence keeps its planned partial read", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const graph = new DataflowGraph<void, N, string, never>(
    Width.create(3),
    UNBOUNDED,
  );
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode(
    new EmitOnce<void, N, string>(
      () => [
        Message.create(feed, 1),
        Message.create(feed, 2),
        Message.create(feed, 3),
      ],
      "p",
      {
        id: NodeId.create("P"),
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const c = graph.addNode(
    new StepNode<void, N, string>(recorder([feed], seen), {
      id: NodeId.create("C"),
      state: undefined,
      trigger: TriggerRule.when(feed),
    }),
  );
  graph.addEdge(p, c, feed);

  await graph.evaluate(async (execute) => {
    await execute(
      [...graph.available().keys()].map((id) => [{ id, inputs: new Map() }]),
    );
    const one = new Map<EdgeIdType, MessageSchedule>([[feed.id, 1]]);
    await execute([
      [
        { id: c, inputs: one },
        { id: c, inputs: one },
        { id: c, inputs: one },
      ],
    ]);
  });
  assert.deepEqual(seen, [{ feed: [1] }, { feed: [2] }]);
  assert.deepEqual(queued(feed), [3]);
});

test("on_error handles a synchronous step() throw and a rejected first advance once, without a result", async () => {
  const notice = Edge.message<N, string>("notice", NumberSchema);
  const graph = new DataflowGraph<{ count: number }, N, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const execution = context({ graph, scheduler: parallel() });
  const syncCause = new Error("sync");
  const asyncCause = new Error("async");
  const calls: { cause: unknown; self: unknown; count: number }[] = [];
  const syncId = graph.addNode({
    id: NodeId.create("sync"),
    state: { count: 0 },
    trigger: TriggerRule.always(),
    step(): NodeGenerator<N, string> {
      this.state.count += 1;
      throw syncCause;
    },
    on_error(cause) {
      calls.push({ cause, self: this, count: this.state.count });
      return [];
    },
  });
  const asyncId = graph.addNode({
    id: NodeId.create("async"),
    state: { count: 0 },
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must reject on its first advance.
    async *step(): NodeGenerator<N, string> {
      this.state.count += 1;
      throw asyncCause;
    },
    async on_error(cause) {
      calls.push({ cause, self: this, count: this.state.count });
      return [Message.create(notice, 7)] as const;
    },
  });
  const seen: Record<string, number[]>[] = [];
  const sink = graph.addNode(
    new StepNode(
      (_state, view) => {
        seen.push({ notice: [...from(view, notice)] });
        return [];
      },
      {
        id: NodeId.create("sink"),
        state: { count: 0 },
        trigger: TriggerRule.when(notice),
      },
    ),
  );
  graph.addEdge(asyncId, sink, notice);

  const results = await execution.run();
  await execution.run();

  assert.deepEqual(calls, [
    { cause: syncCause, self: graph.getNode(syncId), count: 1 },
    { cause: asyncCause, self: graph.getNode(asyncId), count: 1 },
  ]);
  assert.equal(calls[0]!.self, graph.getNode(syncId));
  assert.equal(calls[1]!.self, graph.getNode(asyncId));
  for (const id of [syncId, asyncId]) {
    assert.equal(graph.getNode(id)!.status, "done");
    assert.ok(O.isNone(graph.result(id)));
    assert.equal(results.has(id), false);
  }
  assert.deepEqual(seen, [{ notice: [7] }]);
});

test("on_error after a resume throw emits its batch in order and leaves the value edge unresolved", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const notice = Edge.message<N, string>("notice", NumberSchema);
  const v = Edge.value("v", StringSchema);
  const graph = new DataflowGraph<{ consumed: number[] }, N, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const execution = context({
    graph,
    scheduler: parallel(),
    readInputs: fixedReader(1),
  });
  const cause = new Error("resume");
  let handled = 0;
  let afterValue = 0;
  const seen: number[] = [];
  const source = graph.addNode(
    new StepNode<{ consumed: number[] }, N, string>(() => [], {
      id: NodeId.create("source"),
      state: { consumed: [] },
      trigger: TriggerRule.never(),
    }),
  );
  const failing = graph.addNode({
    id: NodeId.create("failing"),
    state: { consumed: [] as number[] },
    trigger: TriggerRule.when(feed),
    async *step(): NodeGenerator<N, string> {
      const view = yield [];
      this.state.consumed.push(...from(view, feed));
      throw cause;
    },
    on_error(error) {
      handled += 1;
      assert.equal(error, cause);
      assert.deepEqual(this.state.consumed, [1]);
      return [Message.create(notice, 91), Message.create(notice, 92)] as const;
    },
  });
  const consumer = graph.addNode(
    new StepNode<{ consumed: number[] }, N, string>(
      (_state, view) => {
        seen.push(...from(view, notice));
        return [];
      },
      {
        id: NodeId.create("consumer"),
        state: { consumed: [] },
        trigger: TriggerRule.when(notice),
      },
    ),
  );
  const dependent = graph.addNode(
    new StepNode<{ consumed: number[] }, N, string>(
      () => {
        afterValue += 1;
        return [];
      },
      {
        id: NodeId.create("dependent"),
        state: { consumed: [] },
        trigger: TriggerRule.when(v),
      },
    ),
  );
  graph.addEdge(source, failing, feed);
  graph.addEdge(failing, consumer, notice);
  graph.addEdge(failing, dependent, v);
  graph.emit(source, Message.create(feed, 1));
  graph.emit(source, Message.create(feed, 2));

  await execution.run();

  assert.equal(handled, 1);
  assert.deepEqual(seen, [91, 92]);
  assert.deepEqual(queued(feed), [2]);
  assert.equal(graph.getNode(failing)!.status, "done");
  assert.ok(O.isNone(graph.result(failing)));
  assert.ok(E.isRight(v.transport) && O.isNone(v.transport.right));
  assert.equal(afterValue, 0);
});

test("an unconfigured resume throw still surfaces as DataflowNodeError", async () => {
  const feed = Edge.message<N, string>("feed", NumberSchema);
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const sentinel = new Error("sentinel");
  const source = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  const failing = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(feed),
    async *step(): NodeGenerator<N, string> {
      yield [];
      throw sentinel;
    },
  });
  graph.addEdge(source, failing, feed);
  graph.emit(source, Message.create(feed, 1));
  await assert.rejects(
    execution.run(),
    (thrown: unknown) =>
      thrown instanceof DataflowNodeError &&
      thrown.nodeId === failing &&
      thrown.cause === sentinel,
  );
  assert.equal(graph.getNode(failing)!.status, "done");
});

test("a failing on_error rejects with its own cause, is never re-run, and records nothing", async () => {
  const notice = Edge.message<N, string>("notice", NumberSchema);
  const bodyCause = new Error("body");
  for (const mode of ["throw", "reject", "definition"] as const) {
    const graph = newGraph();
    const execution = context({ graph, scheduler: parallel() });
    const handlerCause =
      mode === "definition"
        ? new DataflowDefinitionError("handler wiring")
        : new Error(mode);
    let handled = 0;
    let delivered = 0;
    const failing = graph.addNode({
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
      async *step(): NodeGenerator<N, string> {
        throw bodyCause;
      },
      on_error() {
        handled += 1;
        if (mode === "reject") return Promise.reject(handlerCause);
        throw handlerCause;
      },
    });
    const sink = graph.addNode(
      new StepNode<void, N, string>(
        () => {
          delivered += 1;
          return [];
        },
        {
          state: undefined,
          trigger: TriggerRule.when(notice),
        },
      ),
    );
    graph.addEdge(failing, sink, notice);
    await assert.rejects(execution.run(), (thrown: unknown) =>
      mode === "definition"
        ? thrown === handlerCause
        : thrown instanceof DataflowNodeError &&
          thrown.nodeId === failing &&
          thrown.cause === handlerCause,
    );
    await execution.run();
    assert.equal(handled, 1);
    assert.equal(delivered, 0);
    assert.deepEqual(queued(notice), []);
    assert.equal(graph.getNode(failing)!.status, "done");
    assert.ok(O.isNone(graph.result(failing)));
  }
});

test("a body DataflowDefinitionError and a running node without a generator bypass on_error", async () => {
  const definition = new DataflowDefinitionError("body wiring");
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  let handled = 0;
  graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
    async *step(): NodeGenerator<N, string> {
      throw definition;
    },
    on_error() {
      handled += 1;
      return [];
    },
  });
  await assert.rejects(execution.run(), (thrown) => thrown === definition);

  const orphanGraph = newGraph();
  const orphanExecution = context({
    graph: orphanGraph,
    scheduler: parallel(),
  });
  const orphan = orphanGraph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.always(),
      on_error() {
        handled += 1;
        return [];
      },
    }),
  );
  (orphanGraph.getNode(orphan) as { status: string }).status = "running";
  await assert.rejects(orphanExecution.run(), DataflowDefinitionError);
  assert.equal(handled, 0);
});

test("an on_error batch with a later unwired message rejects, keeping earlier messages queued", async () => {
  const notice = Edge.message<N, string>("notice", NumberSchema);
  const ghost = Edge.message<N, string>("ghost", NumberSchema);
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  let handled = 0;
  const failing = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
    async *step(): NodeGenerator<N, string> {
      throw new Error("body");
    },
    on_error() {
      handled += 1;
      return [Message.create(notice, 1), Message.create(ghost, 2)];
    },
  });
  const sink = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(failing, sink, notice);
  await assert.rejects(execution.run(), DataflowDefinitionError);
  await execution.run();
  assert.equal(handled, 1);
  assert.deepEqual(queued(notice), [1]);
  assert.ok(O.isNone(graph.result(failing)));
});

test("an abort during on_error joins the column, never starts the next one, and never records the failed node", async () => {
  for (const cooperative of [false, true]) {
    const notice = Edge.message<N, string>("notice", NumberSchema);
    const execution = scripted([[["F", "N"], ["S"]]]);
    const { graph } = execution;
    const handlerStarted = Promise.withResolvers<void>();
    const siblingStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let nextRan = false;
    const failing = graph.addNode({
      id: NodeId.create("F"),
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
      async *step(): NodeGenerator<N, string> {
        throw new Error("body");
      },
      async on_error(_error, signal) {
        handlerStarted.resolve();
        await release.promise;
        if (cooperative) signal?.throwIfAborted();
        return [Message.create(notice, 1)];
      },
    });
    graph.addNode(
      new StepNode<void, N, string>(
        () => {
          nextRan = true;
          return [];
        },
        {
          id: NodeId.create("N"),
          state: undefined,
          trigger: TriggerRule.always(),
        },
      ),
    );
    graph.addEdge(failing, NodeId.create("N"), notice);
    const sibling = graph.addNode({
      id: NodeId.create("S"),
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: the body must return on its first activation.
      async *step(): NodeGenerator<N, string> {
        siblingStarted.resolve();
        await release.promise;
        return "S";
      },
    });
    const controller = new AbortController();
    const reason = new Error("stop");
    const stepped = execution.step({ signal: controller.signal });
    await Promise.all([handlerStarted.promise, siblingStarted.promise]);
    controller.abort(reason);
    release.resolve();
    await assert.rejects(stepped, (error) => error === reason);
    assert.equal(nextRan, false);
    assert.deepEqual(queued(notice), cooperative ? [] : [1]);
    assert.deepEqual(graph.result(sibling), O.some("S"));
    assert.ok(O.isNone(graph.result(failing)));
    assert.equal(graph.getNode(failing)!.status, "done");
    assert.equal(graph.getNode(NodeId.create("N"))!.status, "ready");
  }
});

test("a body throwing exactly the aborted signal's reason propagates it without calling on_error", async () => {
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const controller = new AbortController();
  const reason = new Error("stop");
  let handled = 0;
  const failing = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
    async *step(): NodeGenerator<N, string> {
      controller.abort(reason);
      throw reason;
    },
    on_error() {
      handled += 1;
      return [];
    },
  });
  await assert.rejects(
    execution.run({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(handled, 0);
  assert.equal(graph.getNode(failing)!.status, "done");
});

test("a StepNode reads the registered node's current state on every resumed activation", async () => {
  type Factor = { factor: number };
  const graph = new DataflowGraph<Factor, N, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const execution = context({ graph, scheduler: parallel() });
  const input = Edge.message<N, string>("input", NumberSchema);
  const output = Edge.message<N, string>("output", NumberSchema);
  let calls = 0;
  const recorded: number[] = [];
  const source = graph.addNode(
    new EmitOnce(() => [Message.create(input, 2)], "source", {
      state: { factor: 0 },
      trigger: TriggerRule.always(),
    }),
  );
  const multiplier = graph.addNode(
    new StepNode<Factor, N, string>(
      (state, view) => {
        calls++;
        return from(view, input).map((payload) =>
          Message.create(output, payload * state.factor),
        );
      },
      { state: { factor: 1 }, trigger: TriggerRule.when(input) },
    ),
  );
  const sink = graph.addNode(
    new StepNode<Factor, N, string>(
      (_state, view) => {
        recorded.push(...from(view, output));
        return [];
      },
      { state: { factor: 0 }, trigger: TriggerRule.when(output) },
    ),
  );
  graph.addEdge(source, multiplier, input).addEdge(multiplier, sink, output);

  await execution.step();
  await execution.step();
  assert.equal(graph.getNode(multiplier)!.status, "running");
  assert.equal(calls, 0);
  graph.getNode(multiplier)!.state = { factor: 3 };
  await execution.run();
  assert.equal(calls, 1);
  assert.deepEqual(recorded, [6]);
});

test("observations detach native containers, preserve borrowed payloads, and never probe readiness", async () => {
  type State = { label: string };
  const PayloadSchema = Type.Object({ value: Type.Number() });
  type Payload = typeof PayloadSchema;
  const ResultSchema = Type.Union([
    Type.Object({ text: Type.String() }),
    Type.Undefined(),
  ]);
  type Result = Static<typeof ResultSchema>;
  const graph = new DataflowGraph<State, Payload, Result, never>(
    Width.create(1),
    UNBOUNDED,
  );
  assert.equal(graph.observe().version, 0);
  const state = { label: "source" };
  const payload = { value: 7 };
  let probes = 0;
  const source = graph.addNode({
    id: NodeId.create("source"),
    description: "",
    state,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<Payload, Result> {
      yield [];
      return undefined;
    },
  });
  const target = graph.addNode({
    id: NodeId.create("target"),
    state: { label: "target" },
    trigger: TriggerRule.never(),
    is_available: () => {
      probes += 1;
      return false;
    },
    step: async function* (): NodeGenerator<Payload, Result> {
      yield [];
      return { text: "unreachable" };
    },
  });
  const feed = Edge.message<Payload, Result>("feed", PayloadSchema);
  const empty = Edge.message<Payload, Result>("empty", PayloadSchema);
  const value = Edge.value("value", ResultSchema);
  graph.addEdge(source, target, feed);
  graph.addEdge(source, target, empty);
  graph.addEdge(source, target, value);
  const beforeEmit = graph.observe();
  assert.equal(beforeEmit.version, 5);
  graph.emit(source, Message.create(feed, payload));
  const before = graph.observe();
  assert.equal(before.version, beforeEmit.version + 1);
  assert.equal(graph.observe(), before);
  assert.equal(probes, 0);
  assert.deepEqual([...before.nodes.keys()], [source, target]);
  assert.equal(before.nodes.get(source)?.description, "");
  assert.equal(before.nodes.get(source)?.state, state);
  const inputs = before.inputs.get(target)!;
  assert.deepEqual([...inputs.messages.keys()], [feed.id, empty.id]);
  assert.deepEqual(inputs.messages.get(empty.id), []);
  assert.equal(inputs.messages.get(feed.id)?.[0], payload);
  assert.ok(Object.isFrozen(inputs));
  assert.ok(Object.isFrozen(inputs.messages.get(feed.id)));
  assert.ok(Object.isFrozen(before.nodes.get(source)));
  assert.equal(Object.isFrozen(state), false);
  assert.equal(Object.isFrozen(payload), false);
  state.label = "borrowed";
  payload.value = 8;
  assert.equal(before.nodes.get(source)?.state.label, "borrowed");
  assert.equal(inputs.messages.get(feed.id)?.[0]?.value, 8);
  assert.deepEqual(beforeEmit.inputs.get(target)?.messages.get(feed.id), []);
  assert.equal(inputs.values.has(value.id), false);
  const initialResults = graph.results();
  const version = before.version;
  assert.throws(
    () => graph.emit(target, Message.create(feed, payload)),
    DataflowDefinitionError,
  );
  assert.throws(
    () =>
      graph.addNode({
        id: source,
        state,
        trigger: TriggerRule.always(),
        step: async function* (): NodeGenerator<Payload, Result> {
          yield [];
          return undefined;
        },
      }),
    DataflowDefinitionError,
  );
  assert.equal(graph.observe().version, version);
  graph.available();
  graph.results();
  assert.equal(graph.observe().version, version);
  const reports: (readonly NodeIdType[])[] = [];
  await assert.rejects(
    graph.evaluate((execute) =>
      execute([], {
        onColumn: (selected) => reports.push([...selected]),
      }),
    ),
    DataflowDefinitionError,
  );
  assert.equal(graph.observe().version, version);
  assert.equal(reports.length, 0);
  await graph.evaluate(async (execute) => {
    await execute([[{ id: source, inputs: new Map() }]], {
      onColumn: (selected) => reports.push([...selected]),
    });
    await execute([[{ id: source, inputs: new Map() }]], {
      onColumn: (selected) => reports.push([...selected]),
    });
  });
  const after = graph.observe();
  assert.equal(after.version, version + 4);
  assert.equal(graph.observe(), after);
  assert.equal(after.nodes.get(source)?.status, "done");
  assert.equal(before.nodes.get(source)?.status, "ready");
  assert.equal(initialResults.size, 0);
  assert.equal(before.results.size, 0);
  assert.equal(after.results.has(source), true);
  assert.equal(after.results.get(source), undefined);
  assert.equal(after.inputs.get(target)?.values.has(value.id), true);
  assert.equal(after.inputs.get(target)?.values.get(value.id), undefined);
  assert.equal(inputs.values.has(value.id), false);
  assert.deepEqual(reports, [[source], [source]]);
  assert.equal(E.isLeft(feed.transport) && feed.transport.left.length, 1);
  assert.equal(inputs.messages.get(feed.id)?.length, 1);
});

test("activation settlement invalidates observations captured while work is pending, including failure", async () => {
  for (const failing of [false, true]) {
    const graph = newGraph();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sentinel = new Error("activation");
    const id = graph.addNode({
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: settlement is the operation under test.
      step: async function* (): NodeGenerator<N, string> {
        started.resolve();
        await release.promise;
        if (failing) throw sentinel;
        return "result";
      },
    });
    const before = graph.observe();
    const outcome = graph
      .evaluate((execute) => execute([[{ id, inputs: new Map() }]]))
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    try {
      await started.promise;
      const during = graph.observe();
      assert.equal(during.version, before.version + 1);
      assert.equal(during.nodes.get(id)?.status, "running");
      assert.equal(graph.observe(), during);
      release.resolve();
      const settled = await outcome;
      if (failing) {
        assert.equal(settled.ok, false);
        if (!settled.ok) {
          assert.ok(settled.error instanceof DataflowNodeError);
          assert.equal(settled.error.error, sentinel);
        }
      } else assert.equal(settled.ok, true);
      const after = graph.observe();
      assert.equal(after.version, during.version + 1);
      assert.equal(after.nodes.get(id)?.status, "done");
      assert.equal(after.results.has(id), !failing);
      assert.equal(during.results.size, 0);
      assert.equal(during.nodes.get(id)?.status, "running");
    } finally {
      release.resolve();
      await outcome;
    }
  }
});

test("external composition observes native work and ordered links without adding policy members", async () => {
  const graph = new DataflowGraph<void, N, string, never>(
    Width.create(1),
    Width.create(2),
  );
  const snapshots: Snapshot<void, N, string, never>[] = [];
  const policy = separate<void, number, string, never>(
    (_snapshot, id) => id === "0",
    roundRobin(),
    parallel(),
  );
  const execution = context({
    graph,
    scheduler: (snapshot, signal) => {
      snapshots.push(snapshot);
      return policy(snapshot, signal);
    },
  });
  const zero = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<N, string> {
      yield [];
      return "0";
    },
  });
  const one = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: this node finishes on its first selection.
    step: async function* (): NodeGenerator<N, string> {
      return "1";
    },
  });
  assert.deepEqual([zero, one], ["0", "1"]);
  graph.addEdge(zero, one, Edge.message<N, string>("shared", NumberSchema));
  graph.addEdge(one, zero, Edge.value("shared", StringSchema));
  graph.addEdge(zero, zero, Edge.message<N, string>("self", NumberSchema));
  graph.addEdge(zero, one, Edge.value("parallel", StringSchema));
  const links = [
    ["0", "1", "shared", "message"],
    ["1", "0", "shared", "value"],
    ["0", "0", "self", "message"],
    ["0", "1", "parallel", "value"],
  ];
  const completed = await execution.run();
  assert.deepEqual(new Set(completed.keys()), new Set([zero, one]));
  assert.deepEqual(
    [...graph.results()],
    [
      [one, "1"],
      [zero, "0"],
    ],
  );
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) {
    assert.deepEqual([...snapshot.nodes.keys()], [zero, one]);
    assert.deepEqual(snapshot.links, links);
    assert.equal(snapshot.context.size, 0);
  }
  assert.deepEqual(
    [...snapshots[0]!.nodes.values()].map((node) => node.status),
    ["ready", "ready"],
  );
  assert.deepEqual(
    [...snapshots[1]!.nodes.values()].map((node) => node.status),
    ["running", "done"],
  );
  assert.deepEqual(snapshots[0]!.history, []);
  assert.deepEqual(snapshots[1]!.history, [{ selected: select([zero, one]) }]);
  assert.ok(Object.isFrozen(snapshots[1]!.history));
  assert.ok(Object.isFrozen(snapshots[1]!.history[0]));
  assert.ok(Object.isFrozen(snapshots[1]!.history[0]!.selected));
  assert.ok(snapshots[1]!.version > snapshots[0]!.version);
  const nativeIds: NodeIdType[] = [];
  graph.forEachNode((id) => {
    nativeIds.push(id);
  });
  assert.deepEqual(nativeIds, [zero, one]);
  assert.equal(
    graph.addNode({
      state: undefined,
      trigger: TriggerRule.never(),
      step: async function* (): NodeGenerator<N, string> {
        yield [];
        return "2";
      },
    }),
    "2",
  );
  assert.deepEqual([...snapshots[0]!.nodes.keys()], [zero, one]);
});

test("contexts sharing one native graph exclude planning and keep independent committed history", async () => {
  const graph = newGraph();
  const a = graph.addNode({
    id: NodeId.create("a"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: finish in one activation.
    step: async function* (): NodeGenerator<N, string> {
      return "a";
    },
  });
  const b = graph.addNode({
    id: NodeId.create("b"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: finish in one activation.
    step: async function* (): NodeGenerator<N, string> {
      return "b";
    },
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seenA: Snapshot<void, N, string, never>[] = [];
  const seenB: Snapshot<void, N, string, never>[] = [];
  const first = context({
    graph,
    scheduler: async (snapshot) => {
      seenA.push(snapshot);
      started.resolve();
      await release.promise;
      return { selected: select([a]) };
    },
  });
  const second = context({
    graph,
    scheduler: (snapshot) => {
      seenB.push(snapshot);
      return parallel()(snapshot);
    },
  });
  const outcome = first.step().then(
    (results) => ({ ok: true as const, results }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await started.promise;
    await assert.rejects(second.step(), DataflowDefinitionError);
    assert.equal(seenB.length, 0);
    assert.equal(graph.results().size, 0);
    release.resolve();
    const settled = await outcome;
    assert.equal(settled.ok, true);
    assert.deepEqual(
      [...(await second.step())],
      [
        [a, "a"],
        [b, "b"],
      ],
    );
    assert.deepEqual(seenA[0]!.history, []);
    assert.deepEqual(seenB[0]!.history, []);
    assert.equal(seenB[0]!.nodes.get(a)?.status, "done");
    assert.equal(seenB[0]!.results.get(a), "a");
    assert.ok(seenB[0]!.version > seenA[0]!.version);
    assert.deepEqual(seenA[0]!.results.size, 0);
  } finally {
    release.resolve();
    await outcome;
  }
});

test("evaluation drains forgotten concrete work, rejects overlap and expires its executor", async () => {
  for (const definition of [false, true]) {
    const graph = newGraph();
    const operationError = new Error("operation");
    const nodeError = definition
      ? new DataflowDefinitionError("node")
      : new Error("node");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operationStopped = Promise.withResolvers<void>();
    const executionOutcome = Promise.withResolvers<unknown>();
    let captured: DataflowExecution<N, string> | undefined;
    let cleaned = false;
    let otherStarts = 0;
    let lateStarts = 0;
    const reports: NodeIdType[][] = [];
    const other = graph.addNode({
      id: NodeId.create("other"),
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: finish on first selection.
      step: async function* (): NodeGenerator<N, string> {
        otherStarts += 1;
        return "other";
      },
    });
    const failing = graph.addNode({
      id: NodeId.create("failing"),
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: this body checks synchronous executor re-entry.
      step: async function* (): NodeGenerator<N, string> {
        try {
          assert.ok(captured);
          const reentry = captured([[{ id: other, inputs: new Map() }]]);
          started.resolve();
          await assert.rejects(reentry, DataflowDefinitionError);
          await release.promise;
          throw nodeError;
        } finally {
          cleaned = true;
        }
      },
    });
    let settled = false;
    const outcome = graph
      .evaluate(async (execute) => {
        captured = execute;
        const work = execute([[{ id: failing, inputs: new Map() }]], {
          onColumn: (selected) => {
            reports.push([...selected]);
          },
        });
        void work.then(
          () => executionOutcome.resolve(undefined),
          executionOutcome.resolve,
        );
        try {
          await started.promise;
          await assert.rejects(
            execute([[{ id: other, inputs: new Map() }]]),
            DataflowDefinitionError,
          );
          throw operationError;
        } finally {
          operationStopped.resolve();
        }
      })
      .then(
        () => {
          settled = true;
          return { ok: true as const };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );
    try {
      await operationStopped.promise;
      await nextTurn();
      assert.equal(settled, false);
      assert.equal(cleaned, false);
      assert.equal(otherStarts, 0);
      await assert.rejects(
        graph.evaluate(() => undefined),
        DataflowDefinitionError,
      );
      release.resolve();
      const result = await outcome;
      assert.equal(result.ok, false);
      const executionError = await executionOutcome.promise;
      if (!result.ok) {
        assert.ok(result.error instanceof AggregateError);
        assert.deepEqual(result.error.errors, [operationError, executionError]);
        assert.equal(result.error.errors[0], operationError);
        assert.equal(result.error.errors[1], executionError);
      }
      if (definition) assert.equal(executionError, nodeError);
      else {
        assert.ok(executionError instanceof DataflowNodeError);
        assert.equal(executionError.nodeId, failing);
        assert.equal(executionError.error, nodeError);
        assert.equal(executionError.cause, nodeError);
      }
      assert.equal(cleaned, true);
      assert.deepEqual(reports, [[failing]]);
      const late = graph.addNode({
        state: undefined,
        trigger: TriggerRule.always(),
        // biome-ignore lint/correctness/useYield: expired executors must never start this body.
        step: async function* (): NodeGenerator<N, string> {
          lateStarts += 1;
          return "late";
        },
      });
      assert.ok(captured);
      await assert.rejects(
        captured([[{ id: late, inputs: new Map() }]]),
        DataflowDefinitionError,
      );
      assert.equal(lateStarts, 0);
      assert.equal(otherStarts, 0);
    } finally {
      started.resolve();
      release.resolve();
      await outcome;
    }
  }
});

const TextSchema = Type.String();
type Mixed = N | typeof TextSchema;
const mixedGraph = () =>
  new DataflowGraph<void, Mixed, number | string, never>(
    Width.create(1),
    UNBOUNDED,
  );

test("schemas: a numeric edge accepts 7 and rejects '7' without mutating queue or version", () => {
  const graph = mixedGraph();
  const numbers = Edge.message("numbers", NumberSchema);
  const texts = Edge.message("texts", TextSchema);
  const src = graph.addNode(
    new StepNode<void, Mixed, number | string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  const dst = graph.addNode(
    new StepNode<void, Mixed, number | string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(src, dst, numbers).addEdge(src, dst, texts);
  graph.emit(src, Message.create(numbers, 7));
  const version = graph.observe().version;
  assert.throws(
    () => graph.emit(src, Message.create(numbers, "7" as never)),
    DataflowDefinitionError,
  );
  // Both payloads belong to the graph-wide union; each route still enforces its own schema.
  assert.throws(
    () => graph.emit(src, Message.create(texts, 7 as never)),
    DataflowDefinitionError,
  );
  const after = graph.observe();
  assert.equal(after.version, version);
  assert.deepEqual(after.inputs.get(dst)?.messages.get(numbers.id), [7]);
  assert.deepEqual(after.inputs.get(dst)?.messages.get(texts.id), []);
  graph.emit(src, Message.create(texts, "7"));
  assert.deepEqual(graph.observe().inputs.get(dst)?.messages.get(texts.id), [
    "7",
  ]);
});

test("schemas: a yielded batch keeps its valid prefix and the routing error bypasses on_error", async () => {
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const out = Edge.message("out", NumberSchema);
  let handled = 0;
  const src = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      yield [Message.create(out, 1), Message.create(out, "2" as never)];
      return "done";
    },
    on_error() {
      handled++;
      return [];
    },
  });
  const dst = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(src, dst, out);
  await assert.rejects(() => execution.run(), DataflowDefinitionError);
  assert.equal(handled, 0);
  assert.deepEqual(graph.observe().inputs.get(dst)?.messages.get(out.id), [1]);
});

test("schemas: an on_error recovery batch with a wrong payload is rejected", async () => {
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const out = Edge.message("out", NumberSchema);
  let handled = 0;
  const src = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<N, string> {
      yield [];
      throw new Error("boom");
    },
    on_error() {
      handled++;
      return [Message.create(out, "x" as never)];
    },
  });
  const dst = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(src, dst, out);
  await assert.rejects(() => execution.run(), DataflowDefinitionError);
  assert.equal(handled, 1);
  assert.deepEqual(graph.observe().inputs.get(dst)?.messages.get(out.id), []);
});

test("schemas: a return failing any outbound value edge publishes nothing and keeps the previous result", async () => {
  const graph = mixedGraph();
  const execution = context({ graph, scheduler: parallel() });
  const loop = Edge.value("loop", NumberSchema);
  const wide = Edge.value("wide", Type.Union([NumberSchema, TextSchema]));
  let runs = 0;
  const id = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    is_available: (_view, triggered) =>
      graph.getNode(id)!.status === "running" || (triggered && runs < 2),
    step: async function* () {
      runs++;
      yield [];
      return runs === 1 ? 1 : "two";
    },
  });
  const dst = graph.addNode(
    new StepNode<void, Mixed, number | string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(id, id, loop).addEdge(id, dst, wide);
  await assert.rejects(() => execution.run(), DataflowDefinitionError);
  assert.equal(runs, 2);
  assert.deepEqual(graph.result(id), O.some(1));
  const view = graph.observe().inputs;
  assert.equal(view.get(dst)?.values.get(wide.id), 1);
  assert.equal(view.get(id)?.values.get(loop.id), 1);
});

test("schemas: valid value returns keep raw identity", async () => {
  const ObjSchema = Type.Object({ n: Type.Number() });
  const graph = new DataflowGraph<void, never, { n: number }, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const execution = context({ graph, scheduler: parallel() });
  const out = Edge.value("out", ObjSchema);
  const payload = { n: 1, extra: true };
  const src = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      yield [];
      return payload;
    },
  });
  const dst = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(out),
    step: async function* () {
      const view = yield [];
      return view.values.get(out.id)!;
    },
  });
  graph.addEdge(src, dst, out);
  const results = await execution.run();
  assert.equal(results.get(src), payload);
  assert.equal(results.get(dst), payload);
});

test("schemas: Source and Sink admission are atomic and keep identity", () => {
  const ObjSchema = Type.Object({ n: Type.Number() });
  const source = new Source<typeof ObjSchema, never>(() => [], {
    id: NodeId.create("src"),
    schema: ObjSchema,
  });
  const good = { n: 1 };
  const e = Edge.message("e", ObjSchema).id;
  source.enqueue({
    messages: new Map([[e, [good]]]),
    values: new Map(),
  });
  const revision = source.revision;
  const pending = source.peek();
  assert.throws(
    () =>
      source.enqueue({
        messages: new Map([[e, [good, { n: "x" } as never]]]),
        values: new Map(),
      }),
    DataflowDefinitionError,
  );
  assert.equal(source.revision, revision);
  assert.equal(source.peek(), pending);
  assert.equal(pending?.messages.get(e)?.[0], good);

  const sink = new Sink<typeof ObjSchema, void>(async function* () {}, {
    id: NodeId.create("sink"),
    schema: ObjSchema,
    trigger: TriggerRule.never(),
  });
  const edge = Edge.message("s", ObjSchema);
  sink.send(Message.create(edge, good));
  assert.throws(
    () => sink.send(Message.create(edge, { n: "x" } as never)),
    DataflowDefinitionError,
  );
  const drained: unknown[] = [];
  sink.drain((m) => drained.push(m.payload));
  assert.deepEqual(drained, [good]);
  assert.equal(drained[0], good);
});

test("Source: an availability gate holds FIFO deliveries back without dropping them", async () => {
  type Port = Source<typeof NumberSchema, never>;
  const input = EdgeId.create("in");
  const out = Edge.message<typeof NumberSchema, never>("out", NumberSchema);
  const routed: number[][] = [];
  const gated: boolean[] = [];
  let open = true;
  const source: Port = new Source<typeof NumberSchema, never>(
    (view) => {
      const batch = [...(view.messages.get(input) ?? [])];
      routed.push(batch);
      return batch.map((n) => Message.create(out, n));
    },
    {
      id: NodeId.create("src"),
      schema: NumberSchema,
      is_available: (_view, triggered) => {
        gated.push(triggered);
        return open;
      },
    },
  );
  const graph = new DataflowGraph<
    Port | undefined,
    typeof NumberSchema,
    never,
    never
  >(Width.create(1), UNBOUNDED);
  const execution = context({ graph, scheduler: parallel() });
  const received: number[] = [];
  const src = graph.addNode(source);
  const dst = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(out),
    step: async function* () {
      let view = yield [];
      while (true) {
        received.push(...from(view, out));
        view = yield [];
      }
    },
  });
  graph.addEdge(src, dst, out);

  assert.equal(graph.available().has(src), false);
  assert.deepEqual(gated, []);
  open = false;
  source.enqueue({ messages: new Map([[input, [1, 2]]]), values: new Map() });
  source.enqueue({ messages: new Map([[input, [3]]]), values: new Map() });
  const first = source.peek();
  await execution.run();
  assert.deepEqual([routed, received], [[], []]);
  assert.equal(source.peek(), first);
  assert.ok(gated.length > 0 && gated.every(Boolean));

  open = true;
  await execution.run();
  assert.deepEqual(routed, [[1, 2], [3]]);
  assert.deepEqual(received, [1, 2, 3]);
  assert.equal(source.peek(), undefined);
  assert.equal(graph.available().has(src), false);
});

test("schemas: factories and ports require a TypeBox schema", () => {
  assert.throws(
    () => Edge.message("m", undefined as never),
    DataflowDefinitionError,
  );
  assert.throws(() => Edge.value("v", 1 as never), DataflowDefinitionError);
  assert.throws(
    () =>
      new Source(() => [], {
        id: NodeId.create("s"),
        schema: undefined as never,
      }),
    DataflowDefinitionError,
  );
  assert.throws(
    () =>
      new Sink<typeof NumberSchema, void>(async function* () {}, {
        id: NodeId.create("k"),
        schema: "x" as never,
        trigger: TriggerRule.never(),
      }),
    DataflowDefinitionError,
  );
});

/** Exposes the dry routing check `assertSend` uses. */
class ValidatingGraph extends DataflowGraph<
  void,
  Mixed,
  number | string,
  never
> {
  validate(fromId: NodeIdType, message: Message<Mixed>) {
    return this.messageEdge(fromId, message);
  }
}

/** Run `body` with `console.warn` counted instead of printed. */
const countingWarnings = async (body: () => Promise<void> | void) => {
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings++;
  };
  try {
    await body();
  } finally {
    console.warn = warn;
  }
  return warnings;
};

test("probes: each accepted message is observed once after it is queued; validation and rejected routes observe nothing", () => {
  const graph = new ValidatingGraph(Width.create(1), UNBOUNDED);
  const seen: [payload: unknown, queued: unknown, version: number][] = [];
  const numbers = Edge.message("numbers", NumberSchema, (payload) => {
    seen.push([
      payload,
      graph.observe().inputs.get(dst)?.messages.get(EdgeId.create("numbers")),
      graph.observe().version,
    ]);
  });
  const plain = Edge.message("plain", NumberSchema);
  const src = graph.addNode(
    new StepNode<void, Mixed, number | string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  const dst = graph.addNode(
    new StepNode<void, Mixed, number | string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(src, dst, numbers).addEdge(src, dst, plain);
  assert.equal(Object.hasOwn(plain, "probe"), false);
  const version = graph.observe().version;
  assert.equal(graph.validate(src, Message.create(numbers, 1)), numbers);
  assert.deepEqual(seen, []);
  graph.emit(src, Message.create(numbers, -2));
  graph.emit(src, Message.create(numbers, -2));
  graph.emit(src, Message.create(plain, 3));
  for (const bad of [
    Message.create(numbers, "7" as never),
    { id: EdgeId.create("missing"), payload: 7 },
  ])
    assert.throws(() => graph.emit(src, bad), DataflowDefinitionError);
  assert.deepEqual(seen, [
    [-2, [-2], version + 1],
    [-2, [-2, -2], version + 2],
  ]);
});

test("probes: every accepted return is observed per value edge after delivery, repeats included", async () => {
  const graph = mixedGraph();
  const execution = context({ graph, scheduler: parallel() });
  const seen: [edge: string, value: unknown, cell: unknown, result: unknown][] =
    [];
  // `observe()` memoizes by version, which advances only after the activation; read the cells.
  const cell = (edge: Edge<never, number>) =>
    E.isRight(edge.transport) ? edge.transport.right : undefined;
  const probe =
    (edge: string): ((value: unknown) => void) =>
    (value) => {
      seen.push([
        edge,
        value,
        cell(edge === "loop" ? loop : out),
        graph.result(id),
      ]);
    };
  const loop = Edge.value("loop", NumberSchema, probe("loop"));
  const out = Edge.value("out", NumberSchema, probe("out"));
  let runs = 0;
  const id = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    is_available: (_view, triggered) =>
      graph.getNode(id)!.status === "running" || (triggered && runs < 2),
    step: async function* () {
      runs++;
      yield [];
      return 5;
    },
  });
  const dst = graph.addNode(
    new StepNode<void, Mixed, number | string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(id, id, loop).addEdge(id, dst, out);
  await execution.run();
  assert.equal(runs, 2);
  assert.deepEqual(seen, [
    ["loop", 5, O.some(5), O.some(5)],
    ["out", 5, O.some(5), O.some(5)],
    ["loop", 5, O.some(5), O.some(5)],
    ["out", 5, O.some(5), O.some(5)],
  ]);
});

test("probes: a return rejected by any outbound value edge observes nothing and records no result", async () => {
  const graph = mixedGraph();
  const execution = context({ graph, scheduler: parallel() });
  const seen: unknown[] = [];
  const wide = Edge.value("wide", Type.Union([NumberSchema, TextSchema]), (v) =>
    seen.push(v),
  );
  const narrow = Edge.value("narrow", NumberSchema, (v) => seen.push(v));
  const id = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      yield [];
      return "two";
    },
  });
  const dst = graph.addNode(
    new StepNode<void, Mixed, number | string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph.addEdge(id, dst, wide).addEdge(id, dst, narrow);
  await assert.rejects(() => execution.run(), DataflowDefinitionError);
  assert.deepEqual(seen, []);
  assert.deepEqual(graph.result(id), O.none);
  assert.equal(graph.observe().inputs.get(dst)?.values.get(wide.id), undefined);
});

test("probes: a throwing probe neither undoes its delivery nor stops later deliveries or probes", async () => {
  const graph = newGraph();
  const execution = context({ graph, scheduler: parallel() });
  const seen: [string, unknown][] = [];
  const boom = () => {
    throw new Error("probe failed");
  };
  const sent = Edge.message<N, string>("sent", NumberSchema, boom);
  const first = Edge.value("first", StringSchema, boom);
  const second = Edge.value("second", StringSchema, (v) =>
    seen.push(["second", v]),
  );
  const after = Edge.message<N, string>("after", NumberSchema, (v) =>
    seen.push(["after", v]),
  );
  const id = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      yield [Message.create(sent, 1), Message.create(after, 2)];
      return "done";
    },
  });
  const dst = graph.addNode(
    new StepNode<void, N, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  graph
    .addEdge(id, dst, sent)
    .addEdge(id, dst, after)
    .addEdge(id, dst, first)
    .addEdge(id, dst, second);
  const warnings = await countingWarnings(async () => {
    await execution.run();
  });
  assert.equal(warnings, 2);
  assert.deepEqual(seen, [
    ["after", 2],
    ["second", "done"],
  ]);
  assert.deepEqual(graph.result(id), O.some("done"));
  const inputs = graph.observe().inputs.get(dst);
  assert.deepEqual(inputs?.messages.get(sent.id), [1]);
  assert.deepEqual(inputs?.messages.get(after.id), [2]);
  assert.equal(inputs?.values.get(first.id), "done");
  assert.equal(inputs?.values.get(second.id), "done");
});
