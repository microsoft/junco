import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { context, parallel } from "junco-scheduler";
import { ExampleTracer } from "../examples/tracing.ts";
import type { NodeGenerator } from "../src/index.ts";
import {
  DataflowGraph,
  Edge,
  EmitOnce,
  from,
  Message,
  StepNode,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";

test("cookbook: fibonacci via self-loop", async () => {
  const fibSeed = Edge.message<number, string>("fibSeed");
  const fibLoop = Edge.message<number, string>("fibLoop");
  const fibOut = Edge.message<number, string>("fibOut");

  const results: number[] = [];
  const tracer = ExampleTracer.create("cookbook/fibonacci");
  const graph = new DataflowGraph<void, number, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const seedId = graph.addNode(
    new EmitOnce<void, number, string>(
      () => [Message.create(fibSeed, 0), Message.create(fibSeed, 1)],
      "seeded",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );

  const fibId = graph.addNode({
    state: undefined,
    trigger: TriggerRule.anyOf(
      TriggerEntry.on(fibSeed),
      TriggerEntry.on(fibLoop),
    ),
    step: async function* (): NodeGenerator<number, string> {
      let inputs = yield [];
      for (let i = 0; i < 10; i++) {
        const pair = (inputs.messages.get(fibSeed.id) ??
          inputs.messages.get(fibLoop.id))!;
        const a = pair[0]!;
        const b = pair[1]!;
        inputs = yield [
          Message.create(fibOut, a),
          Message.create(fibLoop, b),
          Message.create(fibLoop, a + b),
        ];
      }
      return "emitted 10 fibs";
    },
  });

  const sinkId = graph.addNode(
    new StepNode<void, number, string>(
      (_state, view) => {
        for (const v of from(view, fibOut)) results.push(v);
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(fibOut),
      },
    ),
  );

  graph.addEdge(seedId, fibId, fibSeed);
  graph.addEdge(fibId, fibId, fibLoop);
  graph.addEdge(fibId, sinkId, fibOut);

  try {
    const execution = context({ scheduler: parallel(), graph });
    const completed = await execution.run();

    assert.deepEqual(results, [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
    assert.equal(completed.get(fibId), "emitted 10 fibs");
    assert.equal(completed.has(sinkId), false);
    assert.deepEqual(graph.result(sinkId), O.none);
  } finally {
    await tracer.flush();
  }
});
