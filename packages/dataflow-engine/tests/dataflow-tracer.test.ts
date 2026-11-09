import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { context, parallel } from "junco-scheduler";
import { type TSchema, Type } from "typebox";
import type {
  DataflowRunTrace,
  DataflowTracer,
  EdgeIdType,
  NodeGenerator,
  NodeIdType,
  ParentView,
} from "../src/index.ts";
import {
  DataflowDefinitionError,
  DataflowGraph,
  DataflowNodeError,
  DummyTracer,
  Edge,
  EmitOnce,
  from,
  Message,
  NodeId,
  StepNode,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";
import { nativeReads } from "./support.ts";

const NumberSchema = Type.Number();

type Activation = {
  readonly id: NodeIdType;
  readonly phase: "prime" | "resume";
  /** Snapshot of the delivered batch; `undefined` for a prime. */
  readonly messages: ReadonlyMap<EdgeIdType, readonly unknown[]> | undefined;
  readonly values: ReadonlyMap<EdgeIdType, unknown> | undefined;
  outcome?:
    | { readonly done: false; readonly messages: readonly unknown[] }
    | { readonly done: true; readonly value: unknown }
    | { readonly error: unknown };
};

type RunRecord = {
  readonly nodes: readonly NodeIdType[];
  readonly activations: Activation[];
  results?: ReadonlyMap<NodeIdType, unknown>;
  error?: unknown;
};

const snapshot = <N extends TSchema, T>(view: ParentView<N, T> | undefined) => {
  if (view === undefined) return { messages: undefined, values: undefined };
  const messages = new Map<EdgeIdType, readonly unknown[]>();
  for (const key of view.messages.keys())
    messages.set(key, [...view.messages.get(key)!]);
  const values = new Map<EdgeIdType, unknown>();
  for (const key of view.values.keys()) values.set(key, view.values.get(key));
  return { messages, values };
};

/** Records every run and activation the graph reports, snapshotting views synchronously. */
class RecordingTracer implements DataflowTracer {
  readonly runs: RunRecord[] = [];

  startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const nodes: NodeIdType[] = [];
    graph.forEachNode((id) => nodes.push(id));
    const run: RunRecord = { nodes, activations: [] };
    this.runs.push(run);
    return {
      startNode(id, phase, inputs) {
        const activation: Activation = { id, phase, ...snapshot(inputs) };
        run.activations.push(activation);
        return {
          end(step) {
            activation.outcome = step.done
              ? { done: true, value: step.value }
              : { done: false, messages: step.value.map((m) => m.payload) };
          },
          fail(error) {
            activation.outcome = { error };
          },
        };
      },
      end(results) {
        run.results = new Map(results);
      },
      fail(error) {
        run.error = error;
      },
    };
  }
}

/** Run `body` with `console.warn` silenced, restoring it afterwards. */
const quietly = async (body: () => Promise<void>): Promise<void> => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await body();
  } finally {
    console.warn = warn;
  }
};

test("primes receive no view; resumes receive exactly the scheduler-sized delivered batches", async () => {
  const feed = Edge.message<typeof NumberSchema, string>("feed", NumberSchema);
  const tracer = new RecordingTracer();
  const graph = new DataflowGraph<void, typeof NumberSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );
  const consumed: number[] = [];
  const src = graph.addNode(
    new EmitOnce<void, typeof NumberSchema, string>(
      () => [7, 8, 9].map((n) => Message.create(feed, n)),
      "src",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const sink = graph.addNode(
    new StepNode<void, typeof NumberSchema, string>(
      (_state, view) => {
        consumed.push(...from(view, feed));
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(feed),
      },
    ),
  );
  graph.addEdge(src, sink, feed);

  const results = await nativeReads(graph, 2).run();

  const [run] = tracer.runs;
  assert.equal(tracer.runs.length, 1);
  for (const a of run!.activations.filter((a) => a.phase === "prime"))
    assert.equal(a.messages, undefined);
  assert.deepEqual(
    run!.activations
      .filter((a) => a.id === sink && a.phase === "resume")
      .map((a) => a.messages!.get(feed.id)),
    [[7, 8], [9]],
  );
  assert.deepEqual(consumed, [7, 8, 9]);
  assert.deepEqual(
    run!.activations.filter((a) => a.id === src).map((a) => a.outcome),
    [
      { done: false, messages: [7, 8, 9] },
      { done: true, value: "src" },
    ],
  );
  assert.ok(
    run!.activations
      .filter((a) => a.id === sink)
      .every((a) => a.outcome !== undefined && !("value" in a.outcome)),
  );
  assert.equal(results.has(sink), false);
  assert.deepEqual(run!.results, new Map([[src, "src"]]));
});

test("a throwing observer can neither replace a node's return nor its failure", async () => {
  await quietly(async () => {
    const throwing: DataflowTracer = {
      startRun: () => ({
        startNode: () => ({
          end() {
            throw new Error("observer end");
          },
          fail() {
            throw new Error("observer fail");
          },
        }),
        end() {
          throw new Error("observer run end");
        },
        fail() {
          throw new Error("observer run fail");
        },
      }),
    };

    const ok = new DataflowGraph<void, typeof NumberSchema, number, Error>(
      Width.create(1),
      UNBOUNDED,
      throwing,
    );
    const answer = ok.addNode({
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: the body must return on its first activation.
      step: async function* (): NodeGenerator<typeof NumberSchema, number> {
        return 42;
      },
    });
    assert.equal(
      (await context({ graph: ok, scheduler: parallel() }).run()).get(answer),
      42,
    );

    const boom = new Error("boom");
    const bad = new DataflowGraph<void, typeof NumberSchema, number, Error>(
      Width.create(1),
      UNBOUNDED,
      throwing,
    );
    const failing = bad.addNode({
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
      step: async function* (): NodeGenerator<typeof NumberSchema, number> {
        throw boom;
      },
    });
    await assert.rejects(
      () => context({ graph: bad, scheduler: parallel() }).run(),
      (error: unknown) =>
        error instanceof DataflowNodeError && error.error === boom,
    );
    assert.equal(bad.getNode(failing)!.status, "done");
  });
});

test("a concurrent failure settles the root only after its column settles, keeping the sibling's result", async () => {
  const tracer = new RecordingTracer();
  const graph = new DataflowGraph<void, typeof NumberSchema, string, Error>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );
  const gate = Promise.withResolvers<void>();
  const firstFailed = Promise.withResolvers<void>();
  const first = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
    step: async function* (): NodeGenerator<typeof NumberSchema, string> {
      firstFailed.resolve();
      throw new Error("first");
    },
  });
  const second = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<typeof NumberSchema, string> {
      await gate.promise;
      return "second";
    },
  });

  let settled = false;
  const running = context({ graph, scheduler: parallel() })
    .run()
    .finally(() => {
      settled = true;
    });
  await firstFailed.promise;
  assert.equal(settled, false);
  assert.equal(tracer.runs[0]!.error, undefined);
  gate.resolve();

  const rejection = await running.then(
    () => assert.fail("run() must reject"),
    (error: unknown) => error,
  );
  assert.ok(rejection instanceof DataflowNodeError);
  assert.equal(rejection.nodeId, first);
  assert.ok(rejection.error instanceof Error);
  assert.equal(rejection.error.message, "first");
  assert.deepEqual(graph.result(second), O.some("second"));

  const [run] = tracer.runs;
  assert.equal(run!.error, rejection);
  assert.equal(run!.results, undefined);
  const outcomes = new Map(run!.activations.map((a) => [a.id, a.outcome]));
  const failure = outcomes.get(first);
  assert.ok(failure !== undefined && "error" in failure);
  assert.equal(failure.error, rejection.error);
  assert.deepEqual(outcomes.get(second), { done: true, value: "second" });
});

test("each run snapshots current topology and resumes from resolved values without restarting sources", async () => {
  const tracer = new RecordingTracer();
  const graph = new DataflowGraph<void, typeof NumberSchema, number, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );
  const v = Edge.value("v", NumberSchema);
  let enabled = false;
  const seen: unknown[] = [];
  const src = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the source returns on its first activation.
    step: async function* (): NodeGenerator<typeof NumberSchema, number> {
      return 7;
    },
  });
  const dependent = graph.addNode({
    state: undefined,
    trigger: TriggerRule.allOf(TriggerEntry.on(v)),
    is_available: (view) => enabled && view.values.has(v.id),
    step: async function* (): NodeGenerator<typeof NumberSchema, number> {
      const view = yield [];
      seen.push(view.values.get(v.id));
      return 8;
    },
  });
  graph.addEdge(src, dependent, v);

  await context({ graph, scheduler: parallel() }).run();
  enabled = true;
  const isolated = graph.addNode(
    new StepNode<void, typeof NumberSchema, number>(() => [], {
      state: undefined,
      trigger: TriggerRule.never(),
    }),
  );
  const results = await context({ graph, scheduler: parallel() }).run();

  const [firstRun, secondRun] = tracer.runs;
  assert.equal(tracer.runs.length, 2);
  assert.deepEqual(firstRun!.nodes, [src, dependent]);
  assert.deepEqual(
    firstRun!.activations.map((a) => a.id),
    [src],
  );
  assert.deepEqual(secondRun!.nodes, [src, dependent, isolated]);
  assert.deepEqual(
    secondRun!.activations.map((a) => [a.id, a.phase]),
    [
      [dependent, "prime"],
      [dependent, "resume"],
    ],
  );
  assert.equal(secondRun!.activations[1]!.values!.get(v.id), 7);
  assert.deepEqual(seen, [7]);
  assert.deepEqual(
    results,
    new Map([
      [src, 7],
      [dependent, 8],
    ]),
  );
});

test("a definition error fails the root trace without inventing activations", async () => {
  const tracer = new RecordingTracer();
  const graph = new DataflowGraph<void, typeof NumberSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );
  graph.addNode(
    new StepNode<void, typeof NumberSchema, string>(() => [], {
      state: undefined,
      trigger: TriggerRule.always(),
    }),
  );

  const rejection = await context({
    graph,
    scheduler: () => ({ selected: [] }),
  })
    .run()
    .then(
      () => assert.fail("run() must reject"),
      (error: unknown) => error,
    );
  assert.ok(rejection instanceof DataflowDefinitionError);
  assert.equal(tracer.runs.length, 1);
  assert.equal(tracer.runs[0]!.error, rejection);
  assert.deepEqual(tracer.runs[0]!.activations, []);
});

test("DummyTracer runs exactly like an untraced graph and never touches payloads", async () => {
  const execute = async (tracer: DataflowTracer | undefined) => {
    const feed = Edge.message<typeof NumberSchema, number>(
      "feed",
      NumberSchema,
    );
    const v = Edge.value("v", NumberSchema);
    const graph = new DataflowGraph<void, typeof NumberSchema, number, never>(
      Width.create(1),
      UNBOUNDED,
      tracer,
    );
    const consumed: number[] = [];
    const src = graph.addNode(
      new EmitOnce<void, typeof NumberSchema, number>(
        () => [Message.create(feed, 1), Message.create(feed, 2)],
        7,
        {
          state: undefined,
          trigger: TriggerRule.always(),
        },
      ),
    );
    const dependent = graph.addNode({
      state: undefined,
      trigger: TriggerRule.allOf(TriggerEntry.on(feed), TriggerEntry.on(v)),
      step: async function* (): NodeGenerator<typeof NumberSchema, number> {
        const view = yield [];
        consumed.push(...from(view, feed));
        return consumed.reduce((sum, n) => sum + n, view.values.get(v.id)!);
      },
    });
    graph.addEdge(src, dependent, feed).addEdge(src, dependent, v);
    const results = await context({ graph, scheduler: parallel() }).run();
    return { consumed, results: [...results] };
  };

  const dummy = new DummyTracer();
  const untraced = await execute(undefined);
  const traced = await execute(dummy);
  assert.deepEqual(traced, untraced);
  assert.deepEqual(untraced.consumed, [1, 2]);
  assert.deepEqual(
    untraced.results.map(([, value]) => value),
    [7, 10],
  );

  type Cyclic = { self?: Cyclic };
  const CyclicSchema = Type.Unsafe<Cyclic>(Type.Object({}));
  const cyclic: Cyclic = {};
  cyclic.self = cyclic;
  const feed = Edge.message<typeof CyclicSchema, string>("feed", CyclicSchema);
  const graph = new DataflowGraph<void, typeof CyclicSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
    dummy,
  );
  let received: Cyclic | undefined;
  const src = graph.addNode(
    new EmitOnce<void, typeof CyclicSchema, string>(
      () => [Message.create(feed, cyclic)],
      "sent",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const sink = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(feed),
    step: async function* (): NodeGenerator<typeof CyclicSchema, string> {
      const view = yield [];
      received = from(view, feed)[0];
      return "received";
    },
  });
  graph.addEdge(src, sink, feed);
  const results = await context({ graph, scheduler: parallel() }).run();
  assert.equal(received, cyclic);
  assert.deepEqual(
    results,
    new Map([
      [src, "sent"],
      [sink, "received"],
    ]),
  );
});

/** A one-node graph whose node returns 42, observed by `tracer`. */
const answerGraph = (tracer: DataflowTracer) => {
  const graph = new DataflowGraph<void, typeof NumberSchema, number, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );
  const answer = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<typeof NumberSchema, number> {
      return 42;
    },
  });
  return { graph, answer };
};

test("a failing startRun or startNode observer leaves the node's result intact", async () => {
  await quietly(async () => {
    const failingRun = new (class extends RecordingTracer {
      override startRun<N extends TSchema, T>(): DataflowRunTrace<N, T> {
        throw new Error("startRun observer");
      }
    })();
    const failingNode = new (class extends RecordingTracer {
      override startRun<S, N extends TSchema, T, EH>(
        graph: DataflowGraph<S, N, T, EH>,
      ): DataflowRunTrace<N, T> {
        const run = super.startRun(graph);
        return {
          startNode() {
            throw new Error("startNode observer");
          },
          end: (results) => run.end(results),
          fail: (error) => run.fail(error),
        };
      }
    })();
    for (const tracer of [failingRun, failingNode]) {
      const { graph, answer } = answerGraph(tracer);
      const results = await context({ graph, scheduler: parallel() }).run();
      assert.equal(results.get(answer), 42);
      assert.deepEqual(graph.result(answer), O.some(42));
    }
    assert.equal(failingNode.runs[0]!.results!.get(NodeId.create("0")), 42);
  });
});

test("a throwing node fails identically with no tracer and with DummyTracer", async () => {
  const sentinel = new Error("sentinel");
  const execute = async (tracer: DataflowTracer | undefined) => {
    const graph = new DataflowGraph<void, typeof NumberSchema, number, Error>(
      Width.create(1),
      UNBOUNDED,
      tracer,
    );
    const failing = graph.addNode({
      state: undefined,
      trigger: TriggerRule.always(),
      step: async function* (): NodeGenerator<typeof NumberSchema, number> {
        yield [];
        throw sentinel;
      },
    });
    const error = await context({ graph, scheduler: parallel() })
      .run()
      .then(
        () => assert.fail("run() must reject"),
        (thrown: unknown) => thrown,
      );
    assert.ok(error instanceof DataflowNodeError);
    return {
      nodeId: error.nodeId,
      cause: error.cause,
      error: error.error,
      status: graph.getNode(failing)!.status,
      result: graph.result(failing),
    };
  };
  const dummy = new DummyTracer();
  const untraced = await execute(undefined);
  const traced = await execute(dummy);
  assert.deepEqual(traced, untraced);
  assert.equal(untraced.cause, sentinel);
  assert.equal(untraced.error, sentinel);
  assert.equal(untraced.nodeId, NodeId.create("0"));
  assert.equal(untraced.status, "done");
  assert.ok(O.isNone(untraced.result));
});

test("run() settles only after every promise a completion returned; a rejecting one is warned and ignored", async () => {
  await quietly(async () => {
    const settled: string[] = [];
    const later = (label: string, reject = false) =>
      new Promise<void>((resolve, fail) =>
        setTimeout(() => {
          settled.push(label);
          if (reject) fail(new Error(label));
          else resolve();
        }, 10),
      );
    const tracer: DataflowTracer = {
      startRun: () => ({
        startNode: () => ({
          end: () => later("step end"),
          fail: () => later("step fail"),
        }),
        end: () => later("run end", true),
        fail: () => later("run fail", true),
      }),
    };
    const { graph, answer } = answerGraph(tracer);
    const results = await context({ graph, scheduler: parallel() }).run();
    assert.equal(results.get(answer), 42);
    assert.deepEqual(settled, ["step end", "run end"]);

    settled.length = 0;
    const boom = new Error("boom");
    const bad = new DataflowGraph<void, typeof NumberSchema, number, Error>(
      Width.create(1),
      UNBOUNDED,
      tracer,
    );
    bad.addNode({
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
      step: async function* (): NodeGenerator<typeof NumberSchema, number> {
        throw boom;
      },
    });
    const rejection = await context({ graph: bad, scheduler: parallel() })
      .run()
      .then(
        () => assert.fail("run() must reject"),
        (error: unknown) => error,
      );
    assert.ok(rejection instanceof DataflowNodeError);
    assert.equal(rejection.error, boom);
    assert.deepEqual(settled, ["step fail", "run fail"]);
  });
});

test("a handled failure traces one raw activation fail and a normal run end without the failed node", async () => {
  const notice = Edge.message<typeof NumberSchema, string>(
    "notice",
    NumberSchema,
  );
  const tracer = new RecordingTracer();
  const graph = new DataflowGraph<void, typeof NumberSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );
  const cause = new Error("source exploded");
  const consumed: number[] = [];
  const src = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must throw on its first advance.
    async *step(): NodeGenerator<typeof NumberSchema, string> {
      throw cause;
    },
    on_error: () => [Message.create(notice, 5)],
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: TriggerRule.when(notice),
    async *step(): NodeGenerator<typeof NumberSchema, string> {
      const view = yield [];
      consumed.push(...from(view, notice));
      return "sink";
    },
  });
  graph.addEdge(src, sink, notice);

  const results = await context({ graph, scheduler: parallel() }).run();

  const [run] = tracer.runs;
  assert.equal(tracer.runs.length, 1);
  assert.deepEqual(
    run!.activations.filter((a) => a.id === src).map((a) => a.outcome),
    [{ error: cause }],
  );
  const outcome = run!.activations.find((a) => a.id === src)!.outcome!;
  assert.ok("error" in outcome && outcome.error === cause);
  assert.deepEqual(consumed, [5]);
  assert.equal(run!.error, undefined);
  assert.deepEqual(run!.results, new Map([[sink, "sink"]]));
  assert.deepEqual(results, new Map([[sink, "sink"]]));
});
