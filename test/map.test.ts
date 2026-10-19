import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DataflowDefinitionError,
  DummyTracer,
  Edge,
  Message,
  type NodeGenerator,
  NodeId,
  Sink,
  Source,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { LockPolicy } from "junco-tools";
import createGraph from "ngraph.graph";
import { Deterministic, JuncoGraph, schedules } from "../src/index.ts";

const options = { policy: LockPolicy, tracer: new DummyTracer() };

test("mapped skeletons execute parallel queues, feedback and isolated nodes independently", async () => {
  const skeleton = createGraph<string, void>({ multigraph: true });
  skeleton.addNode("source", "publish");
  skeleton.addNode("worker", "sum");
  skeleton.addNode(7, "isolated");
  const first = Edge.message<number, number>(
    skeleton.addLink("source", "worker").id,
  );
  const second = Edge.message<number, number>(
    skeleton.addLink("source", "worker").id,
  );
  const feedback = Edge.message<number, number>(
    skeleton.addLink("worker", "worker").id,
  );
  const closed: string[] = [];
  const map = () => {
    const final = Edge.value<number, number>("worker->$sink");
    const source = new Source<number, number>(
      () => {
        throw new DataflowDefinitionError(
          "Mapped fixture does not accept external input",
        );
      },
      { id: NodeId.create("$source") },
    );
    const sink: Sink<number, number> = new Sink<number, number>(
      async function* (): NodeGenerator<number, number> {
        yield [];
        const result = execution.graph.result(NodeId.create("worker"));
        assert.ok(O.isSome(result));
        return result.value;
      },
      { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) },
    );
    const execution = JuncoGraph.map(
      skeleton,
      (text) =>
        new Deterministic<number, number>(async function* () {
          try {
            if (text === "isolated") return 0;
            let view = yield text === "publish"
              ? [Message.create(first, 2), Message.create(second, 3)]
              : [];
            if (text === "publish") return 5;
            let total = 0;
            let received = 0;
            while (true) {
              for (const id of view.messages.keys()) {
                for (const value of view.messages.get(id) ?? []) {
                  total += value;
                  received++;
                }
              }
              if (received === 3) return total;
              view = yield received === 2 ? [Message.create(feedback, 10)] : [];
            }
          } finally {
            closed.push(text);
          }
        }, LockPolicy),
      { ...options, source, sink },
    );
    execution.graph.addEdge(NodeId.create("worker"), sink.id, final);
    return execution;
  };
  const a = map();
  const b = map();
  await using graphA = a.graph;
  await using graphB = b.graph;
  for (const execution of [a, b]) {
    const results = await execution.run();
    assert.deepEqual([...results].filter(([id]) => id !== "$sink").sort(), [
      ["7", 0],
      ["source", 5],
      ["worker", 15],
    ]);
    assert.equal(results.get(NodeId.create("$sink")), 15);
  }
  assert.deepEqual(closed.sort(), [
    "isolated",
    "isolated",
    "publish",
    "publish",
    "sum",
    "sum",
  ]);
  assert.equal(skeleton.getNode("worker")?.data, "sum");
});

test("mapped node specs seed cycles and preserve nested sink results", async () => {
  const skeleton = createGraph<string, void>();
  skeleton.addNode("loop", "nested");
  skeleton.addLink("loop", "loop");
  const final = Edge.value<number, string>("member->$sink");
  const childSource = new Source<number, string>(
    () => {
      throw new DataflowDefinitionError(
        "Child fixture does not accept external input",
      );
    },
    { id: NodeId.create("$source") },
  );
  const childSink: Sink<number, string> = new Sink<number, string>(
    async function* (): NodeGenerator<number, string> {
      yield [];
      const result = child.graph.result(member);
      assert.ok(O.isSome(result));
      return result.value;
    },
    { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) },
  );
  const child = schedules.context({
    scheduler: schedules.parallel(),
    graph: new JuncoGraph(
      childSource,
      childSink,
      Width.create(1),
      UNBOUNDED,
      options.tracer,
      LockPolicy,
    ),
  });
  const member = child.graph.addNode({
    trigger: TriggerRule.always(),
    state: new Deterministic<number, string>(async function* () {
      yield [];
      return "selected";
    }, LockPolicy),
  });
  child.graph.addEdge(member, childSink.id, final);
  const mappedFinal = Edge.value<number, string>("loop->$sink");
  const source = new Source<number, string>(
    () => {
      throw new DataflowDefinitionError(
        "Mapped fixture does not accept external input",
      );
    },
    { id: NodeId.create("$source") },
  );
  const sink: Sink<number, string> = new Sink<number, string>(
    async function* (): NodeGenerator<number, string> {
      yield [];
      const result = mapped.graph.result(NodeId.create("loop"));
      assert.ok(O.isSome(result));
      return result.value;
    },
    { id: NodeId.create("$sink"), trigger: TriggerRule.when(mappedFinal) },
  );
  const mapped = JuncoGraph.map(
    skeleton,
    () => ({
      id: NodeId.create("ignored"),
      state: child,
      trigger: TriggerRule.always<number, string>(),
    }),
    { ...options, source, sink },
  );
  await using graph = mapped.graph;
  graph.addEdge(NodeId.create("loop"), sink.id, mappedFinal);
  const results = await mapped.run();
  assert.equal(results.get(NodeId.create("loop")), "selected");
  assert.equal(results.get(sink.id), "selected");
  assert.equal(graph.getNode(NodeId.create("loop"))?.state, child.graph);
  await graph.close();
  assert.ok(child.graph.signal.aborted);
});

test("mapper failure preserves caller-owned members and permits retrying unpublished ports", async () => {
  const skeleton = createGraph<string, void>();
  skeleton.addNode("first", "first");
  skeleton.addNode("fail", "fail");
  skeleton.addNode("last", "last");
  const failure = new Error("mapping failed");
  const visited: string[] = [];
  await using state = new Deterministic<number, number>(async function* () {
    yield [];
    return 1;
  }, LockPolicy);
  const source = new Source<number, number>(
    () => {
      throw new DataflowDefinitionError(
        "Retry fixture does not accept external input",
      );
    },
    { id: NodeId.create("$source") },
  );
  const final = Edge.value<number, number>("first->$sink");
  const sink: Sink<number, number> = new Sink<number, number>(
    async function* (): NodeGenerator<number, number> {
      yield [];
      const result = retry.graph.result(NodeId.create("first"));
      assert.ok(O.isSome(result));
      return result.value;
    },
    { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) },
  );
  assert.throws(
    () =>
      JuncoGraph.map(
        skeleton,
        (text) => {
          visited.push(text);
          if (text === "fail") throw failure;
          return state;
        },
        { ...options, source, sink },
      ),
    (error) => error === failure,
  );
  assert.deepEqual(visited, ["first", "fail"]);
  assert.equal(state.signal.aborted, false);
  const retrySkeleton = createGraph<string, void>();
  retrySkeleton.addNode("first", "first");
  const retry = JuncoGraph.map(
    retrySkeleton,
    () => ({ state, trigger: TriggerRule.always<number, number>() }),
    { ...options, source, sink },
  );
  await using graph = retry.graph;
  graph.addEdge(NodeId.create("first"), sink.id, final);
  assert.equal((await retry.run()).get(sink.id), 1);
});
