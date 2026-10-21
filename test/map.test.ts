import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DummyTracer,
  Edge,
  Message,
  NodeId,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import { LockPolicy } from "junco-tools";
import createGraph from "ngraph.graph";
import { Deterministic, JuncoGraph, schedules } from "../src/index.ts";
import { terminalPorts } from "./deterministic-support.ts";

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
    const ports = terminalPorts<number, number>();
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
      { ...options, source: ports.source, sink: ports.sink },
    );
    ports.connect(execution.graph, NodeId.create("worker"));
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
  const childPorts = terminalPorts<number, string>();
  const child = schedules.context({
    scheduler: schedules.parallel(),
    graph: new JuncoGraph(
      childPorts.source,
      childPorts.sink,
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
  childPorts.connect(child.graph, member);
  const ports = terminalPorts<number, string>();
  const mapped = JuncoGraph.map(
    skeleton,
    () => ({
      id: NodeId.create("ignored"),
      state: child,
      trigger: TriggerRule.always<number, string>(),
    }),
    { ...options, source: ports.source, sink: ports.sink },
  );
  await using graph = mapped.graph;
  ports.connect(graph, NodeId.create("loop"));
  const results = await mapped.run();
  assert.equal(results.get(NodeId.create("loop")), "selected");
  assert.equal(results.get(ports.sink.id), "selected");
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
  const ports = terminalPorts<number, number>();
  assert.throws(
    () =>
      JuncoGraph.map(
        skeleton,
        (text) => {
          visited.push(text);
          if (text === "fail") throw failure;
          return state;
        },
        { ...options, source: ports.source, sink: ports.sink },
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
    { ...options, source: ports.source, sink: ports.sink },
  );
  await using graph = retry.graph;
  ports.connect(graph, NodeId.create("first"));
  assert.equal((await retry.run()).get(ports.sink.id), 1);
});
