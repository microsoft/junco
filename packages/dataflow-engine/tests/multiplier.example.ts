import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { RoundRobinScheduler } from "junco-scheduler";
import { ExampleTracer } from "../examples/tracing.ts";
import type { NodeGenerator } from "../src/index.ts";
import {
  DataflowGraph,
  Edge,
  from,
  Message,
  StepNode,
  TriggerRule,
  Width,
} from "../src/index.ts";

test("cookbook: end-to-end three stage multiplier graph", async () => {
  const sourceToMultiplier = Edge.message<number, string>("sourceToMultiplier");
  const multiplierToSink = Edge.message<number, string>("multiplierToSink");
  const results: number[] = [];
  const tracer = ExampleTracer.create("cookbook/multiplier");
  const graph = new DataflowGraph<void, number, string, never>(
    new RoundRobinScheduler<number, string>(),
    Width.create(1),
    Width.create(1),
    tracer,
  );

  const sourceId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<number, string> {
      yield [Message.create(sourceToMultiplier, 1)];
      yield [Message.create(sourceToMultiplier, 2)];
      yield [Message.create(sourceToMultiplier, 3)];
      return "source done";
    },
  });

  // Multiplier & sink: T = never. Never return — the pure step function is invoked
  // per firing until the trigger stops firing (upstream drains). `graph.result(id)`
  // is `O.none` in that state.
  const multiplierId = graph.addNode(
    new StepNode<void, number, string>(
      (_state, view) =>
        from(view, sourceToMultiplier).map((value) =>
          Message.create(multiplierToSink, value * 2),
        ),
      {
        state: undefined,
        trigger: TriggerRule.when(sourceToMultiplier),
      },
    ),
  );

  const sinkId = graph.addNode(
    new StepNode<void, number, string>(
      (_state, view) => {
        results.push(...from(view, multiplierToSink));
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(multiplierToSink),
      },
    ),
  );

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
