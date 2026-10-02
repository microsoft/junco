import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { createParallelScheduler, createScheduler } from "junco-scheduler";
import type {
  DataflowRunTrace,
  DataflowTracer,
  EdgeIdType,
  MessageSchedule,
  NodeGenerator,
  NodeIdType,
  ParentView,
} from "../src/index.ts";
import {
  allOf,
  always,
  DataflowDefinitionError,
  DataflowGraph,
  DataflowNodeError,
  DummyTracer,
  emitOnce,
  from,
  messageEdge,
  msg,
  never,
  on,
  stepNode,
  UNBOUNDED,
  valueEdge,
  Width,
  when,
} from "../src/index.ts";

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

const snapshot = <N, T>(view: ParentView<N, T> | undefined) => {
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

  startRun<S, N, T, EH>(
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

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/** One lane per available node, reading `count` off every edge that node's trigger names. */
const fixedReader = (count: MessageSchedule) =>
  createScheduler<undefined, number, string>({
    state: undefined,
    schedule: (available) =>
      [...available].map(([id, { trigger }]) => [
        {
          id,
          inputs: new Map<EdgeIdType, MessageSchedule>(
            trigger.rule.map((edgeId) => [edgeId, count]),
          ),
        },
      ]),
  });

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
  const feed = messageEdge<number, string>("feed");
  const tracer = new RecordingTracer();
  const graph = new DataflowGraph<void, number, string, never>(
    fixedReader(2),
    Width(1),
    UNBOUNDED,
    tracer,
  );
  const consumed: number[] = [];
  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [7, 8, 9].map((n) => msg(feed, n)), "src"),
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: when(feed),
    step: stepNode<void, number, string>((_state, view) => {
      consumed.push(...from(view, feed));
      return [];
    }),
  });
  graph.addEdge(src, sink, feed);

  const results = await graph.run();

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
      flush: () => Promise.resolve(),
    };

    const ok = new DataflowGraph<void, number, number, Error>(
      createParallelScheduler(),
      Width(1),
      UNBOUNDED,
      throwing,
    );
    const answer = ok.addNode({
      state: undefined,
      trigger: always(),
      // biome-ignore lint/correctness/useYield: the body must return on its first activation.
      step: async function* (): NodeGenerator<number, number> {
        return 42;
      },
    });
    assert.equal((await ok.run()).get(answer), 42);

    const boom = new Error("boom");
    const bad = new DataflowGraph<void, number, number, Error>(
      createParallelScheduler(),
      Width(1),
      UNBOUNDED,
      throwing,
    );
    const failing = bad.addNode({
      state: undefined,
      trigger: always(),
      // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
      step: async function* (): NodeGenerator<number, number> {
        throw boom;
      },
    });
    await assert.rejects(
      () => bad.run(),
      (error: unknown) =>
        error instanceof DataflowNodeError && error.error === boom,
    );
    assert.equal(bad.getNode(failing)!.status, "done");
  });
});

test("a concurrent failure settles the root only after its column settles, keeping the sibling's result", async () => {
  const tracer = new RecordingTracer();
  const graph = new DataflowGraph<void, number, string, Error>(
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
    tracer,
  );
  const gate = Promise.withResolvers<void>();
  const firstFailed = Promise.withResolvers<void>();
  const first = graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must throw before its first yield.
    step: async function* (): NodeGenerator<number, string> {
      firstFailed.resolve();
      throw new Error("first");
    },
  });
  const second = graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<number, string> {
      await gate.promise;
      return "second";
    },
  });

  let settled = false;
  const running = graph.run().finally(() => {
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
  const graph = new DataflowGraph<void, number, number, never>(
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
    tracer,
  );
  const v = valueEdge<number, number>("v");
  let enabled = false;
  const seen: unknown[] = [];
  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    // biome-ignore lint/correctness/useYield: the source returns on its first activation.
    step: async function* (): NodeGenerator<number, number> {
      return 7;
    },
  });
  const dependent = graph.addNode({
    state: undefined,
    trigger: allOf(on(v)),
    is_available: (view) => enabled && view.values.has(v.id),
    step: async function* (): NodeGenerator<number, number> {
      const view = yield [];
      seen.push(view.values.get(v.id));
      return 8;
    },
  });
  graph.addEdge(src, dependent, v);

  await graph.run();
  enabled = true;
  const isolated = graph.addNode({
    state: undefined,
    trigger: never(),
    step: stepNode(() => []),
  });
  const results = await graph.run();

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
  const graph = new DataflowGraph<void, number, string, never>(
    { create() {}, schedule: () => [] },
    Width(1),
    UNBOUNDED,
    tracer,
  );
  graph.addNode({
    state: undefined,
    trigger: always(),
    step: stepNode(() => []),
  });

  const rejection = await graph.run().then(
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
    const feed = messageEdge<number, number>("feed");
    const v = valueEdge<number, number>("v");
    const graph = new DataflowGraph<void, number, number, never>(
      createParallelScheduler(),
      Width(1),
      UNBOUNDED,
      tracer,
    );
    const consumed: number[] = [];
    const src = graph.addNode({
      state: undefined,
      trigger: always(),
      step: emitOnce(() => [msg(feed, 1), msg(feed, 2)], 7),
    });
    const dependent = graph.addNode({
      state: undefined,
      trigger: allOf(on(feed), on(v)),
      step: async function* (): NodeGenerator<number, number> {
        const view = yield [];
        consumed.push(...from(view, feed));
        return consumed.reduce((sum, n) => sum + n, view.values.get(v.id)!);
      },
    });
    graph.addEdge(src, dependent, feed).addEdge(src, dependent, v);
    const results = await graph.run();
    return { consumed, results: [...results] };
  };

  const dummy = new DummyTracer();
  const untraced = await execute(undefined);
  const traced = await execute(dummy);
  await dummy.flush();
  assert.deepEqual(traced, untraced);
  assert.deepEqual(untraced.consumed, [1, 2]);
  assert.deepEqual(
    untraced.results.map(([, value]) => value),
    [7, 10],
  );

  type Cyclic = { self?: Cyclic };
  const cyclic: Cyclic = {};
  cyclic.self = cyclic;
  const feed = messageEdge<Cyclic, string>("feed");
  const graph = new DataflowGraph<void, Cyclic, string, never>(
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
    dummy,
  );
  let received: Cyclic | undefined;
  const src = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce(() => [msg(feed, cyclic)], "sent"),
  });
  const sink = graph.addNode({
    state: undefined,
    trigger: when(feed),
    step: async function* (): NodeGenerator<Cyclic, string> {
      const view = yield [];
      received = from(view, feed)[0];
      return "received";
    },
  });
  graph.addEdge(src, sink, feed);
  const results = await graph.run();
  await dummy.flush();
  assert.equal(received, cyclic);
  assert.deepEqual(
    results,
    new Map([
      [src, "sent"],
      [sink, "received"],
    ]),
  );
});
