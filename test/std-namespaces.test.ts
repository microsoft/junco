import { test } from "bun:test";
import assert from "node:assert/strict";
import * as E from "fp-ts/lib/Either.js";
import { graph, schedulers, tracer, trigger } from "../src/index.ts";

// The root `graph`, `schedulers`, `tracer` and `trigger` namespaces compose into one runnable graph:
// constant fan-out sources feed an ordered fan-in, a persistent sink and a one-shot marker.
test("root namespaces compose a fan-out/fan-in graph that runs once to quiescence", async () => {
  type Payload = number | number[];
  const observer = new tracer.DummyTracer();
  const g = new graph.DataflowGraph<void, Payload, string, never>(
    schedulers.createRoundRobinScheduler(),
    graph.Width(1),
    graph.Width(1),
    observer,
  );
  const a = graph.messageEdge<number, string>("a");
  const b = graph.messageEdge<number, string>("b");
  const list = graph.messageEdge<number[], string>("list");

  const left = g.addNode(
    graph.nodes.ConstFanout(1, [a], { state: undefined, ret: "left" }),
  );
  const right = g.addNode(
    graph.nodes.ConstFanout(2, [b], { state: undefined, ret: "right" }),
  );
  const join = g.addNode(
    graph.nodes.ConstFanin([b, a], list, { state: undefined, ret: "joined" }),
  );
  const seen: Payload[] = [];
  const sink = g.addNode({
    state: undefined,
    trigger: trigger.when(list),
    step: graph.nodes.stepNode((_state, view) => {
      seen.push(...graph.from(view, list));
      return [];
    }),
  });
  const marker = g.addNode({
    state: undefined,
    trigger: graph.trigger.always(),
    step: graph.nodes.emitOnce(() => [], "marker"),
  });
  g.addEdge(left, join, a).addEdge(right, join, b).addEdge(join, sink, list);

  const results = await g.run();
  assert.deepEqual(seen, [[2, 1]]);
  assert.equal(results.get(left), "left");
  assert.equal(results.get(right), "right");
  assert.equal(results.get(join), "joined");
  assert.equal(results.get(marker), "marker");
  assert.ok(E.isLeft(list.transport));
  assert.deepEqual([...list.transport.left], []);

  const again = await g.run();
  assert.deepEqual(seen, [[2, 1]]);
  assert.deepEqual([...again], [...results]);
  await observer.flush();
});
