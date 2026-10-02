import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { createRoundRobinScheduler } from "junco-scheduler";
import { createExampleTracer } from "../examples/tracing.ts";
import type { NodeGenerator } from "../src/index.ts";
import {
  always,
  DataflowGraph,
  from,
  messageEdge,
  msg,
  stepNode,
  Width,
  when,
} from "../src/index.ts";

test("cookbook: end-to-end three stage multiplier graph", async () => {
  const sourceToMultiplier = messageEdge<number, string>("sourceToMultiplier");
  const multiplierToSink = messageEdge<number, string>("multiplierToSink");
  const results: number[] = [];
  const tracer = createExampleTracer("cookbook/multiplier");
  const graph = new DataflowGraph<void, number, string, never>(
    createRoundRobinScheduler<number, string>(),
    Width(1),
    Width(1),
    tracer,
  );

  const sourceId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: async function* (): NodeGenerator<number, string> {
      yield [msg(sourceToMultiplier, 1)];
      yield [msg(sourceToMultiplier, 2)];
      yield [msg(sourceToMultiplier, 3)];
      return "source done";
    },
  });

  // Multiplier & sink: T = never. Never return — the pure step function is invoked
  // per firing until the trigger stops firing (upstream drains). `graph.result(id)`
  // is `O.none` in that state.
  const multiplierId = graph.addNode({
    state: undefined,
    trigger: when(sourceToMultiplier),
    step: stepNode<void, number, string>((_state, view) =>
      from(view, sourceToMultiplier).map((value) =>
        msg(multiplierToSink, value * 2),
      ),
    ),
  });

  const sinkId = graph.addNode({
    state: undefined,
    trigger: when(multiplierToSink),
    step: stepNode<void, number, string>((_state, view) => {
      results.push(...from(view, multiplierToSink));
      return [];
    }),
  });

  graph.addEdge(sourceId, multiplierId, sourceToMultiplier);
  graph.addEdge(multiplierId, sinkId, multiplierToSink);

  try {
    const completed = await graph.run();

    assert.deepEqual(results, [2, 4, 6]);
    assert.equal(completed.get(sourceId), "source done");
    assert.equal(completed.has(multiplierId), false);
    assert.equal(completed.has(sinkId), false);
    assert.deepEqual(graph.result(multiplierId), O.none);
    assert.deepEqual(graph.result(sinkId), O.none);
  } finally {
    await tracer.flush();
  }
});
