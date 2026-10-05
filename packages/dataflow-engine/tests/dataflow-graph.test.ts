import { test } from "bun:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { createParallelScheduler, createScheduler } from "junco-scheduler";
import type {
  DataflowScheduler,
  Edge,
  EdgeIdType,
  MessageSchedule,
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
  never,
  on,
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
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
  );

/** The live backlog still queued on `edge`, for asserting what a firing did and did not consume. */
const queued = (edge: Edge<number, string>): readonly number[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

/** One lane per available node, reading `count` off every edge that node's trigger names. */
const fixedReader = (count: MessageSchedule) =>
  createScheduler<undefined, number, string>({
    state: undefined,
    schedule: (available): Schedule =>
      [...available].map(([id, { trigger }]) => [
        {
          id,
          inputs: new Map<EdgeIdType, MessageSchedule>(
            trigger.rule.map((edgeId) => [edgeId, count]),
          ),
        },
      ]),
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
  const sentinel = new Error("sentinel");
  const failingId = graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
    step: async function* (): NodeGenerator<number, string> {
      throw sentinel;
    },
  });

  await assert.rejects(
    () => graph.run(),
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
  for (const id of ["0", "1"])
    graph.addNode({
      state: undefined,
      id: NodeId(id),
      trigger: always(),
      step: emitOnce(() => [], `r${id}`),
    });
  await graph.run();
  const added = [0, 1].map(() =>
    graph.addNode({
      state: undefined,
      trigger: never(),
      step: stepNode(() => []),
    }),
  );
  assert.deepEqual(added, [NodeId("2"), NodeId("3")]);
  assert.deepEqual(graph.result(NodeId("0")), O.some("r0"));
  assert.deepEqual(graph.result(NodeId("1")), O.some("r1"));
  assert.equal(graph.getNode(NodeId("0"))!.status, "done");
  assert.equal(graph.getNode(NodeId("missing")), undefined);
});

test("definition error: a missing source or an outbound duplicate edge id is rejected; per-side ids may repeat", () => {
  const graph = newGraph();
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) =>
    graph.addNode({
      state: undefined,
      id: NodeId(id),
      trigger: always(),
      step: stepNode(() => []),
    }),
  ) as [NodeIdType, NodeIdType, NodeIdType, NodeIdType];
  graph.addEdge(a, b, messageEdge<number, string>("shared"));
  graph.addEdge(c, d, messageEdge<number, string>("shared"));
  assert.throws(
    () => graph.addEdge(NodeId("ghost"), b, messageEdge<number, string>("e")),
    DataflowDefinitionError,
  );
  assert.throws(
    () => graph.addEdge(a, d, messageEdge<number, string>("shared")),
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
  const feed = messageEdge<number, string>("feed");
  const other = messageEdge<number, string>("other");
  let plan: Schedule = [];
  const scheduler: DataflowScheduler<number, string> = {
    create(): void {},
    schedule: () => plan,
  };
  const graph = new DataflowGraph<void, number, string, never>(
    scheduler,
    Width(1),
    UNBOUNDED,
  );
  const advances: Record<string, number> = { S: 0, C: 0, D: 0 };
  const counted = (name: string) =>
    async function* (): NodeGenerator<number, string> {
      while (true) {
        advances[name]! += 1;
        yield [];
      }
    };
  const s = graph.addNode({
    id: NodeId("S"),
    state: undefined,
    trigger: always(),
    step: counted("S"),
  });
  const c = graph.addNode({
    id: NodeId("C"),
    state: undefined,
    trigger: when(feed),
    step: counted("C"),
  });
  const d = graph.addNode({
    id: NodeId("D"),
    state: undefined,
    trigger: when(other),
    step: counted("D"),
  });
  graph.addEdge(s, c, feed).addEdge(s, d, other);
  graph.emit(s, msg(feed, 1));
  graph.emit(s, msg(feed, 2));
  graph.emit(s, msg(other, 5));

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
    [[{ id: NodeId("missing"), inputs: none }]],
    [[{ id: s, inputs: none }], [{ id: s, inputs: none }]],
    [[reads(c, other.id, "all")]],
    [[reads(c, feed.id, 0)]],
    [[reads(c, feed.id, -1)]],
    [[reads(c, feed.id, 1.5)]],
  ];
  for (const candidate of invalid) {
    plan = candidate;
    await assert.rejects(graph.step(), DataflowDefinitionError);
    assert.deepEqual(advances, { S: 0, C: 0, D: 0 });
    assert.deepEqual(queued(feed), [1, 2]);
    assert.deepEqual(queued(other), [5]);
    for (const id of [s, c, d])
      assert.equal(graph.getNode(id)!.status, "ready");
  }

  plan = [[{ id: s, inputs: none }], [reads(c, feed.id, 1)]];
  await graph.step();
  assert.deepEqual(advances, { S: 1, C: 1, D: 0 });
  assert.deepEqual(queued(feed), [1, 2]);
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
  let handled = 0;
  const source = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => [msg(ghost, 1)]),
    on_error() {
      handled += 1;
      return [];
    },
  });
  assert.throws(
    () => graph.emit(source, msg(ghost, 1)),
    DataflowDefinitionError,
  );
  await assert.rejects(() => graph.run(), DataflowDefinitionError);
  assert.equal(handled, 0);
});

test("definition error: emitting a message on a value edge is rejected", async () => {
  const v = valueEdge<number, string>("v");
  const graph = newGraph();
  let handled = 0;
  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => [msg(v, 1)]),
    on_error() {
      handled += 1;
      return [];
    },
  });
  const dst = graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
  });
  graph.addEdge(src, dst, v);
  assert.throws(() => graph.emit(src, msg(v, 1)), DataflowDefinitionError);
  assert.ok(E.isRight(v.transport) && O.isNone(v.transport.right));
  await assert.rejects(() => graph.run(), DataflowDefinitionError);
  assert.equal(handled, 0);
});

test("public emit enqueues FIFO without driving, consuming, or completing any node", async () => {
  const feed = messageEdge<number, string>("feed");
  const done = valueEdge<number, string>("done");
  const graph = new DataflowGraph<void, number, string, never>(
    fixedReader(2),
    Width(1),
    UNBOUNDED,
  );
  const batches: number[][] = [];
  const source = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [], "source"),
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: when(feed),
    step: stepNode((_state, view) => {
      batches.push([...from(view, feed)]);
      return [];
    }),
  });
  graph.addEdge(source, sink, feed);
  graph.addEdge(source, sink, done);

  graph.emit(source, msg(feed, 1));
  graph.emit(source, msg(feed, 2));
  graph.emit(source, msg(feed, 3));
  assert.throws(() => graph.emit(sink, msg(feed, 99)), DataflowDefinitionError);
  assert.deepEqual(queued(feed), [1, 2, 3]);
  assert.deepEqual(batches, []);
  assert.equal(graph.getNode(source)!.status, "ready");
  assert.equal(graph.getNode(sink)!.status, "ready");
  assert.ok(O.isNone(graph.result(source)));
  assert.ok(E.isRight(done.transport) && O.isNone(done.transport.right));

  await graph.step();
  assert.deepEqual(queued(feed), [1, 2, 3]);
  assert.deepEqual(batches, []);

  const results = await graph.run();
  assert.deepEqual(batches, [[1, 2], [3]]);
  assert.deepEqual(queued(feed), []);
  assert.equal(results.get(source), "source");
  assert.deepEqual(done.transport, E.right(O.some("source")));
  assert.equal(results.has(sink), false);

  graph.emit(source, msg(feed, 4));
  await graph.run();
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
    const e = messageEdge<number, string>("e");
    const graph = newGraph();
    // A gate the test opens by hand: the first call parks inside the source with no wall-clock
    // dependency, so the second call provably observes an in-flight graph.
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

    const inFlight = graph[first]();
    await assert.rejects(() => graph[second](), DataflowDefinitionError);
    gate.resolve();
    await inFlight;
    // The guard is released on settlement: the graph is drivable again.
    await graph.run();
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

test("the graph evaluates triggers before availability: unfired and finished nodes never reach the planner", async () => {
  const empty = messageEdge<number, string>("empty");
  const unfed = messageEdge<number, string>("unfed");
  const planned: string[][] = [];
  const graph = new DataflowGraph<void, number, string, never>(
    createScheduler<undefined, number, string>({
      state: undefined,
      schedule: (available): Schedule => {
        planned.push([...available.keys()]);
        return [...available].map(([id, candidate]) => [
          { id, inputs: triggerInputs(candidate) },
        ]);
      },
    }),
    UNBOUNDED,
    UNBOUNDED,
  );
  const hooked: boolean[] = [];
  const src = graph.addNode({
    id: NodeId("src"),
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [], "src"),
  });
  const waiting = graph.addNode({
    id: NodeId("waiting"),
    state: undefined,
    trigger: when(empty),
    step: stepNode(() => []),
  });
  const idle = graph.addNode({
    id: NodeId("never"),
    state: undefined,
    trigger: never(),
    step: stepNode(() => []),
  });
  const observed = graph.addNode({
    id: NodeId("observed"),
    state: undefined,
    trigger: when(unfed),
    is_available: (_view, triggered) => {
      hooked.push(triggered);
      return false;
    },
    step: stepNode(() => []),
  });
  graph.addEdge(src, waiting, empty);
  graph.addEdge(src, observed, unfed);

  assert.deepEqual(
    [...graph.available()].map(([id, { status }]) => [id, status]),
    [[src, "ready"]],
  );
  await graph.step();
  assert.deepEqual(
    [...graph.available()].map(([id, { status }]) => [id, status]),
    [[src, "running"]],
  );
  await graph.run();

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
  const unwired = messageEdge<number, string>("unwired");
  const graph = newGraph();
  let consulted = 0;
  graph.addNode({
    state: undefined,
    trigger: when(unwired),
    is_available: () => {
      consulted += 1;
      return false;
    },
    step: stepNode(() => []),
  });

  assert.throws(() => graph.available(), DataflowDefinitionError);
  assert.equal(consulted, 0);
});

/**
 * Plans window `k` from `windows[k]` (lanes of node ids), each entry reading its default trigger
 * inputs as planned; `state.planned` counts how often the graph consulted it.
 */
const scripted = (
  windows: readonly (readonly (readonly string[])[])[],
  resolveInputs?: DataflowScheduler<number, string>["resolveInputs"],
) =>
  createScheduler<{ planned: number }, number, string>({
    state: { planned: 0 },
    schedule(available, state): Schedule {
      const lanes = windows[state.planned++];
      assert.ok(lanes !== undefined, "unscripted window");
      return lanes.map((lane) =>
        lane.map((name) => {
          const id = NodeId(name);
          const availability = available.get(id);
          return {
            id,
            inputs:
              availability === undefined
                ? new Map<EdgeIdType, MessageSchedule>()
                : triggerInputs(availability),
          };
        }),
      );
    },
    ...(resolveInputs === undefined ? {} : { resolveInputs }),
  });

const scriptedGraph = (scheduler: ReturnType<typeof scripted>) =>
  new DataflowGraph<void, number, string, never, ReturnType<typeof scripted>>(
    scheduler,
    UNBOUNDED,
    UNBOUNDED,
  );

/** An actor that records each delivered batch per edge and never finishes. */
const recorder = (
  edges: readonly Edge<number, string>[],
  seen: Record<string, number[]>[],
) =>
  stepNode<void, number, string>((_state, view) => {
    seen.push(
      Object.fromEntries(edges.map((edge) => [edge.id, [...from(view, edge)]])),
    );
    return [];
  });

test("a node that finished earlier in the window is skipped, keeping its result", async () => {
  const scheduler = scripted([[["A", "A"]]]);
  const graph = scriptedGraph(scheduler);
  let bodies = 0;
  const a = graph.addNode({
    id: NodeId("A"),
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<number, string> {
      bodies += 1;
      return "kept";
    },
  });

  const completed = await graph.step();
  assert.equal(bodies, 1);
  assert.equal(completed.get(a), "kept");
  assert.deepEqual(graph.result(a), O.some("kept"));
  assert.equal(graph.available().size, 0);
});

test("a later occurrence of a node that went unavailable consumes nothing and does not advance", async () => {
  const feed = messageEdge<number, string>("feed");
  const scheduler = scripted([[["P"]], [["C", "C", "C"]]]);
  const graph = scriptedGraph(scheduler);
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode({
    id: NodeId("P"),
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(feed, 7)], "p"),
  });
  const c = graph.addNode({
    id: NodeId("C"),
    state: undefined,
    trigger: when(feed),
    step: recorder([feed], seen),
  });
  graph.addEdge(p, c, feed);

  await graph.step();
  assert.equal(graph.getNode(c)!.status, "ready");
  // Column 0 primes C, column 1 drains its sole input, column 2 finds it unavailable.
  await graph.step();
  assert.deepEqual(seen, [{ feed: [7] }]);
  assert.deepEqual(queued(feed), []);
  assert.equal(scheduler.state.planned, 2);
});

test("step() runs exactly one window; run() drives to quiescence; an idle step() never plans", async () => {
  const feed = messageEdge<number, string>("feed");
  const scheduler = scripted([[["P"]], [["P"], ["C"]], [["C"]]]);
  const graph = scriptedGraph(scheduler);
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode({
    id: NodeId("P"),
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(feed, 1)], "p"),
  });
  const c = graph.addNode({
    id: NodeId("C"),
    state: undefined,
    trigger: when(feed),
    step: recorder([feed], seen),
  });
  graph.addEdge(p, c, feed);

  const afterStep = await graph.step();
  assert.equal(scheduler.state.planned, 1);
  assert.equal(afterStep.size, 0);
  assert.deepEqual(queued(feed), [1]);
  assert.deepEqual([...graph.available().keys()], [p, c]);

  const completed = await graph.run();
  assert.equal(scheduler.state.planned, 3);
  assert.deepEqual([...completed], [[p, "p"]]);
  assert.deepEqual(seen, [{ feed: [1] }]);
  assert.equal(graph.available().size, 0);

  assert.equal(await graph.step(), completed);
  assert.equal(scheduler.state.planned, 3);
});

test("a column runs its lanes concurrently and the next column waits for all of them", async () => {
  const scheduler = scripted([[["A", "C"], ["B"]]]);
  const graph = scriptedGraph(scheduler);
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
    async function* (): NodeGenerator<number, string> {
      log.push(`${name}:start`);
      started();
      await release;
      log.push(`${name}:end`);
      done?.();
      return name;
    };
  graph.addNode({
    id: NodeId("A"),
    state: undefined,
    trigger: always(),
    step: gated("A", aStarted.resolve, releaseA.promise, aDone.resolve),
  });
  graph.addNode({
    id: NodeId("B"),
    state: undefined,
    trigger: always(),
    step: gated("B", bStarted.resolve, releaseB.promise),
  });
  graph.addNode({
    id: NodeId("C"),
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<number, string> {
      cStarted = true;
      log.push("C");
      return "C";
    },
  });

  const stepped = graph.step();
  await Promise.all([aStarted.promise, bStarted.promise]);
  releaseA.resolve();
  await aDone.promise;
  assert.equal(cStarted, false);
  releaseB.resolve();
  await stepped;
  assert.deepEqual(log, ["A:start", "B:start", "A:end", "B:end", "C"]);
});

test("an aborted signal lets the running column drain, then rejects with its reason before the next column", async () => {
  const scheduler = scripted([[["A", "B"]]]);
  const graph = scriptedGraph(scheduler);
  const aStarted = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  let bRan = false;
  const a = graph.addNode({
    id: NodeId("A"),
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<number, string> {
      aStarted.resolve();
      await releaseA.promise;
      return "A";
    },
  });
  const b = graph.addNode({
    id: NodeId("B"),
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<number, string> {
      bRan = true;
      return "B";
    },
  });

  const controller = new AbortController();
  const reason = new Error("stop");
  const stepped = graph.step({ signal: controller.signal });
  await aStarted.promise;
  controller.abort(reason);
  releaseA.resolve();
  await assert.rejects(stepped, (error) => error === reason);
  assert.deepEqual(graph.result(a), O.some("A"));
  assert.equal(bRan, false);
  assert.equal(graph.getNode(b)!.status, "ready");

  // An already-aborted signal is observed before planning.
  await assert.rejects(
    graph.run({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(scheduler.state.planned, 1);
});

test("resolveInputs keeps an `all` trigger atomic for a live actor: a lone replenished edge is not drained", async () => {
  const e1 = messageEdge<number, string>("e1");
  const e2 = messageEdge<number, string>("e2");
  const scheduler = scripted(
    [
      [["P"], ["X"]],
      [["X", "X"], ["P"]],
    ],
    (_entry, live) => triggerInputs(live),
  );
  const graph = scriptedGraph(scheduler);
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode({
    id: NodeId("P"),
    state: undefined,
    trigger: always(),
    step: async function* (): NodeGenerator<number, string> {
      yield [msg(e1, 1), msg(e2, 2)];
      // The sibling lane replenishes only e1, after X consumed column 0's batch.
      yield [msg(e1, 3)];
      return "p";
    },
  });
  const x = graph.addNode({
    id: NodeId("X"),
    state: undefined,
    trigger: allOf(on(e1), on(e2)),
    // An active actor stays resumable even when its trigger is drained.
    is_available: () => true,
    step: recorder([e1, e2], seen),
  });
  graph.addEdge(p, x, e1);
  graph.addEdge(p, x, e2);

  await graph.step();
  await graph.step();
  assert.deepEqual(seen, [
    { e1: [1], e2: [2] },
    { e1: [], e2: [] },
  ]);
  assert.deepEqual(queued(e1), [3]);
});

test("resolveInputs lets a later message win over an already-delivered value on an `any` trigger", async () => {
  const v = valueEdge<number, string>("v");
  const m = messageEdge<number, string>("m");
  const delivered = new Set<EdgeIdType>();
  const scheduler = scripted(
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
  const graph = scriptedGraph(scheduler);
  const batches: number[][] = [];
  let valueViews = 0;
  const vId = graph.addNode({
    id: NodeId("V"),
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the source returns on its first activation.
    step: async function* (): NodeGenerator<number, string> {
      return "val";
    },
  });
  const x = graph.addNode({
    id: NodeId("X"),
    state: undefined,
    trigger: anyOf(on(v), on(m)),
    step: stepNode<void, number, string>((_state, view) => {
      if (view.values.has(v.id) && !delivered.has(v.id)) {
        delivered.add(v.id);
        valueViews += 1;
      }
      batches.push([...from(view, m)]);
      return [];
    }),
  });
  const mId = graph.addNode({
    id: NodeId("M"),
    state: undefined,
    trigger: always(),
    step: async function* (): NodeGenerator<number, string> {
      yield [];
      yield [msg(m, 5)];
      return "m";
    },
  });
  graph.addEdge(vId, x, v);
  graph.addEdge(mId, x, m);

  await graph.step();
  // Column 0 primes X, column 1 delivers the value, column 2 picks the message M emitted meanwhile.
  await graph.step();
  assert.equal(valueViews, 1);
  assert.deepEqual(batches, [[], [5]]);
  assert.deepEqual(queued(m), []);
});

test("an invalid resolved read map rejects before any node of that column advances or consumes", async () => {
  const ex = messageEdge<number, string>("ex");
  const ey = messageEdge<number, string>("ey");
  const scheduler = scripted(
    [[["P"]], [["X"], ["Y"]], [["X"], ["Y"]]],
    (entry, live) =>
      entry.id === NodeId("Y")
        ? new Map<EdgeIdType, MessageSchedule>([[ex.id, "all"]])
        : triggerInputs(live),
  );
  const graph = scriptedGraph(scheduler);
  const seen: Record<string, number[]>[] = [];
  let handled = 0;
  const on_error = () => {
    handled += 1;
    return [];
  };
  const p = graph.addNode({
    id: NodeId("P"),
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(ex, 1), msg(ey, 2)], "p"),
  });
  const x = graph.addNode({
    id: NodeId("X"),
    state: undefined,
    trigger: when(ex),
    step: recorder([ex], seen),
    on_error,
  });
  const y = graph.addNode({
    id: NodeId("Y"),
    state: undefined,
    trigger: when(ey),
    step: recorder([ey], seen),
    on_error,
  });
  graph.addEdge(p, x, ex);
  graph.addEdge(p, y, ey);

  await graph.step();
  await graph.step();
  await assert.rejects(graph.step(), DataflowDefinitionError);
  assert.deepEqual(seen, []);
  assert.equal(handled, 0);
  assert.deepEqual(queued(ex), [1]);
  assert.deepEqual(queued(ey), [2]);
  assert.equal(graph.getNode(x)!.status, "running");
  assert.equal(graph.getNode(y)!.status, "running");
});

test("a throwing resolveInputs escapes unchanged before any node of that column advances or consumes", async () => {
  const ex = messageEdge<number, string>("ex");
  const ey = messageEdge<number, string>("ey");
  const sentinel = new Error("sentinel");
  const scheduler = scripted([[["P"]], [["X"], ["Y"]], [["X"], ["Y"]]], () => {
    throw sentinel;
  });
  const graph = scriptedGraph(scheduler);
  const seen: Record<string, number[]>[] = [];
  let handled = 0;
  const on_error = () => {
    handled += 1;
    return [];
  };
  const p = graph.addNode({
    id: NodeId("P"),
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(ex, 1), msg(ey, 2)], "p"),
  });
  const x = graph.addNode({
    id: NodeId("X"),
    state: undefined,
    trigger: when(ex),
    step: recorder([ex], seen),
    on_error,
  });
  const y = graph.addNode({
    id: NodeId("Y"),
    state: undefined,
    trigger: when(ey),
    step: recorder([ey], seen),
    on_error,
  });
  graph.addEdge(p, x, ex);
  graph.addEdge(p, y, ey);

  await graph.step();
  await graph.step();
  await assert.rejects(graph.step(), (error) => error === sentinel);
  assert.deepEqual(seen, []);
  assert.equal(handled, 0);
  assert.deepEqual(queued(ex), [1]);
  assert.deepEqual(queued(ey), [2]);
  assert.equal(graph.getNode(x)!.status, "running");
  assert.equal(graph.getNode(y)!.status, "running");
});

test("a throwing schedule callback rejects the invocation without node work; the next invocation succeeds", async () => {
  const feed = messageEdge<number, string>("feed");
  const sentinel = new Error("sentinel");
  let failing = true;
  const scheduler = createScheduler<undefined, number, string>({
    state: undefined,
    schedule(available): Schedule {
      if (failing) throw sentinel;
      return [...available].map(([id, availability]) => [
        { id, inputs: triggerInputs(availability) },
      ]);
    },
  });
  const graph = new DataflowGraph<void, number, string, never>(
    scheduler,
    Width(1),
    UNBOUNDED,
  );
  const seen: Record<string, number[]>[] = [];
  let handled = 0;
  const source = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [], "source"),
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: when(feed),
    step: recorder([feed], seen),
    on_error() {
      handled += 1;
      return [];
    },
  });
  graph.addEdge(source, sink, feed);
  graph.emit(source, msg(feed, 1));

  await assert.rejects(graph.run(), (error) => error === sentinel);
  assert.deepEqual(seen, []);
  assert.equal(handled, 0);
  assert.deepEqual(queued(feed), [1]);
  assert.equal(graph.getNode(source)!.status, "ready");
  assert.equal(graph.getNode(sink)!.status, "ready");

  failing = false;
  const results = await graph.run();
  assert.equal(results.get(source), "source");
  assert.deepEqual(seen, [{ feed: [1] }]);
  assert.deepEqual(queued(feed), []);
});

test("without resolveInputs every occurrence keeps its planned partial read", async () => {
  const feed = messageEdge<number, string>("feed");
  const scheduler = createScheduler<{ window: number }, number, string>({
    state: { window: 0 },
    schedule(available, state) {
      state.window += 1;
      if (state.window === 1)
        return [...available.keys()].map((id) => [{ id, inputs: new Map() }]);
      const one = new Map<EdgeIdType, MessageSchedule>([[feed.id, 1]]);
      return [
        [
          { id: NodeId("C"), inputs: one },
          { id: NodeId("C"), inputs: one },
          { id: NodeId("C"), inputs: one },
        ],
      ];
    },
  });
  const graph = new DataflowGraph<void, number, string, never>(
    scheduler,
    Width(3),
    UNBOUNDED,
  );
  const seen: Record<string, number[]>[] = [];
  const p = graph.addNode({
    id: NodeId("P"),
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(feed, 1), msg(feed, 2), msg(feed, 3)], "p"),
  });
  const c = graph.addNode({
    id: NodeId("C"),
    state: undefined,
    trigger: when(feed),
    step: recorder([feed], seen),
  });
  graph.addEdge(p, c, feed);

  await graph.step();
  await graph.step();
  assert.deepEqual(seen, [{ feed: [1] }, { feed: [2] }]);
  assert.deepEqual(queued(feed), [3]);
});

test("on_error handles a synchronous step() throw and a rejected first advance once, without a result", async () => {
  const notice = messageEdge<number, string>("notice");
  const graph = new DataflowGraph<{ count: number }, number, string, never>(
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
  );
  const syncCause = new Error("sync");
  const asyncCause = new Error("async");
  const calls: { cause: unknown; self: unknown; count: number }[] = [];
  const syncId = graph.addNode({
    id: NodeId("sync"),
    state: { count: 0 },
    trigger: always(),
    step(): NodeGenerator<number, string> {
      this.state.count += 1;
      throw syncCause;
    },
    on_error(cause) {
      calls.push({ cause, self: this, count: this.state.count });
      return [];
    },
  });
  const asyncId = graph.addNode({
    id: NodeId("async"),
    state: { count: 0 },
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must reject on its first advance.
    async *step(): NodeGenerator<number, string> {
      this.state.count += 1;
      throw asyncCause;
    },
    async on_error(cause) {
      calls.push({ cause, self: this, count: this.state.count });
      return [msg(notice, 7)] as const;
    },
  });
  const seen: Record<string, number[]>[] = [];
  const sink = graph.addNode({
    id: NodeId("sink"),
    state: { count: 0 },
    trigger: when(notice),
    step: stepNode((_state, view) => {
      seen.push({ notice: [...from(view, notice)] });
      return [];
    }),
  });
  graph.addEdge(asyncId, sink, notice);

  const results = await graph.run();
  await graph.run();

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
  const feed = messageEdge<number, string>("feed");
  const notice = messageEdge<number, string>("notice");
  const v = valueEdge<number, string>("v");
  const graph = new DataflowGraph<
    { consumed: number[] },
    number,
    string,
    never
  >(fixedReader(1), Width(1), UNBOUNDED);
  const cause = new Error("resume");
  let handled = 0;
  let afterValue = 0;
  const seen: number[] = [];
  const source = graph.addNode({
    id: NodeId("source"),
    state: { consumed: [] },
    trigger: never(),
    step: stepNode(() => []),
  });
  const failing = graph.addNode({
    id: NodeId("failing"),
    state: { consumed: [] as number[] },
    trigger: when(feed),
    async *step(): NodeGenerator<number, string> {
      const view = yield [];
      this.state.consumed.push(...from(view, feed));
      throw cause;
    },
    on_error(error) {
      handled += 1;
      assert.equal(error, cause);
      assert.deepEqual(this.state.consumed, [1]);
      return [msg(notice, 91), msg(notice, 92)] as const;
    },
  });
  const consumer = graph.addNode({
    id: NodeId("consumer"),
    state: { consumed: [] },
    trigger: when(notice),
    step: stepNode((_state, view) => {
      seen.push(...from(view, notice));
      return [];
    }),
  });
  const dependent = graph.addNode({
    id: NodeId("dependent"),
    state: { consumed: [] },
    trigger: when(v),
    step: stepNode(() => {
      afterValue += 1;
      return [];
    }),
  });
  graph.addEdge(source, failing, feed);
  graph.addEdge(failing, consumer, notice);
  graph.addEdge(failing, dependent, v);
  graph.emit(source, msg(feed, 1));
  graph.emit(source, msg(feed, 2));

  await graph.run();

  assert.equal(handled, 1);
  assert.deepEqual(seen, [91, 92]);
  assert.deepEqual(queued(feed), [2]);
  assert.equal(graph.getNode(failing)!.status, "done");
  assert.ok(O.isNone(graph.result(failing)));
  assert.ok(E.isRight(v.transport) && O.isNone(v.transport.right));
  assert.equal(afterValue, 0);
});

test("an unconfigured resume throw still surfaces as DataflowNodeError", async () => {
  const feed = messageEdge<number, string>("feed");
  const graph = newGraph();
  const sentinel = new Error("sentinel");
  const source = graph.addNode({
    state: undefined,
    trigger: never(),
    step: stepNode(() => []),
  });
  const failing = graph.addNode({
    state: undefined,
    trigger: when(feed),
    async *step(): NodeGenerator<number, string> {
      yield [];
      throw sentinel;
    },
  });
  graph.addEdge(source, failing, feed);
  graph.emit(source, msg(feed, 1));
  await assert.rejects(
    graph.run(),
    (thrown: unknown) =>
      thrown instanceof DataflowNodeError &&
      thrown.nodeId === failing &&
      thrown.cause === sentinel,
  );
  assert.equal(graph.getNode(failing)!.status, "done");
});

test("a failing on_error rejects with its own cause, is never re-run, and records nothing", async () => {
  const notice = messageEdge<number, string>("notice");
  const bodyCause = new Error("body");
  for (const mode of ["throw", "reject", "definition"] as const) {
    const graph = newGraph();
    const handlerCause =
      mode === "definition"
        ? new DataflowDefinitionError("handler wiring")
        : new Error(mode);
    let handled = 0;
    let delivered = 0;
    const failing = graph.addNode({
      state: undefined,
      trigger: always(),
      // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
      async *step(): NodeGenerator<number, string> {
        throw bodyCause;
      },
      on_error() {
        handled += 1;
        if (mode === "reject") return Promise.reject(handlerCause);
        throw handlerCause;
      },
    });
    const sink = graph.addNode({
      state: undefined,
      trigger: when(notice),
      step: stepNode(() => {
        delivered += 1;
        return [];
      }),
    });
    graph.addEdge(failing, sink, notice);
    await assert.rejects(graph.run(), (thrown: unknown) =>
      mode === "definition"
        ? thrown === handlerCause
        : thrown instanceof DataflowNodeError &&
          thrown.nodeId === failing &&
          thrown.cause === handlerCause,
    );
    await graph.run();
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
  let handled = 0;
  graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
    async *step(): NodeGenerator<number, string> {
      throw definition;
    },
    on_error() {
      handled += 1;
      return [];
    },
  });
  await assert.rejects(graph.run(), (thrown) => thrown === definition);

  const orphanGraph = newGraph();
  const orphan = orphanGraph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
    on_error() {
      handled += 1;
      return [];
    },
  });
  (orphanGraph.getNode(orphan) as { status: string }).status = "running";
  await assert.rejects(orphanGraph.run(), DataflowDefinitionError);
  assert.equal(handled, 0);
});

test("an on_error batch with a later unwired message rejects, keeping earlier messages queued", async () => {
  const notice = messageEdge<number, string>("notice");
  const ghost = messageEdge<number, string>("ghost");
  const graph = newGraph();
  let handled = 0;
  const failing = graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
    async *step(): NodeGenerator<number, string> {
      throw new Error("body");
    },
    on_error() {
      handled += 1;
      return [msg(notice, 1), msg(ghost, 2)];
    },
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: never(),
    step: stepNode(() => []),
  });
  graph.addEdge(failing, sink, notice);
  await assert.rejects(graph.run(), DataflowDefinitionError);
  await graph.run();
  assert.equal(handled, 1);
  assert.deepEqual(queued(notice), [1]);
  assert.ok(O.isNone(graph.result(failing)));
});

test("an abort during on_error joins the column, never starts the next one, and never records the failed node", async () => {
  for (const cooperative of [false, true]) {
    const notice = messageEdge<number, string>("notice");
    const scheduler = scripted([[["F", "N"], ["S"]]]);
    const graph = scriptedGraph(scheduler);
    const handlerStarted = Promise.withResolvers<void>();
    const siblingStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let nextRan = false;
    const failing = graph.addNode({
      id: NodeId("F"),
      state: undefined,
      trigger: always(),
      // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
      async *step(): NodeGenerator<number, string> {
        throw new Error("body");
      },
      async on_error(_error, signal) {
        handlerStarted.resolve();
        await release.promise;
        if (cooperative) signal?.throwIfAborted();
        return [msg(notice, 1)];
      },
    });
    graph.addNode({
      id: NodeId("N"),
      state: undefined,
      trigger: always(),
      step: stepNode(() => {
        nextRan = true;
        return [];
      }),
    });
    graph.addEdge(failing, NodeId("N"), notice);
    const sibling = graph.addNode({
      id: NodeId("S"),
      state: undefined,
      trigger: always(),
      // biome-ignore lint/correctness/useYield: the body must return on its first activation.
      async *step(): NodeGenerator<number, string> {
        siblingStarted.resolve();
        await release.promise;
        return "S";
      },
    });
    const controller = new AbortController();
    const reason = new Error("stop");
    const stepped = graph.step({ signal: controller.signal });
    await Promise.all([handlerStarted.promise, siblingStarted.promise]);
    controller.abort(reason);
    release.resolve();
    await assert.rejects(stepped, (error) => error === reason);
    assert.equal(nextRan, false);
    assert.deepEqual(queued(notice), cooperative ? [] : [1]);
    assert.deepEqual(graph.result(sibling), O.some("S"));
    assert.ok(O.isNone(graph.result(failing)));
    assert.equal(graph.getNode(failing)!.status, "done");
    assert.equal(graph.getNode(NodeId("N"))!.status, "ready");
  }
});

test("a body throwing exactly the aborted signal's reason propagates it without calling on_error", async () => {
  const graph = newGraph();
  const controller = new AbortController();
  const reason = new Error("stop");
  let handled = 0;
  const failing = graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
    async *step(): NodeGenerator<number, string> {
      controller.abort(reason);
      throw reason;
    },
    on_error() {
      handled += 1;
      return [];
    },
  });
  await assert.rejects(
    graph.run({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(handled, 0);
  assert.equal(graph.getNode(failing)!.status, "done");
});
