import { context, parallel } from "junco-scheduler";
import { Type } from "typebox";
import type { DataflowTracer, NodeGenerator } from "../src/index.ts";
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
import { ExampleTracer } from "./tracing.ts";

const NumberSchema = Type.Number();

const fibSeed = Edge.message<typeof NumberSchema, string>(
  "fibSeed",
  NumberSchema,
);
const fibLoop = Edge.message<typeof NumberSchema, string>(
  "fibLoop",
  NumberSchema,
);
const fibOut = Edge.message<typeof NumberSchema, string>(
  "fibOut",
  NumberSchema,
);

export async function runFibonacci(tracer?: DataflowTracer) {
  const results: number[] = [];
  const graph = new DataflowGraph<void, typeof NumberSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const seedId = graph.addNode(
    new EmitOnce<void, typeof NumberSchema, string>(
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
    step: async function* (): NodeGenerator<typeof NumberSchema, string> {
      let inputs = yield [];
      for (let i = 0; i < 10; i++) {
        const pair =
          inputs.messages.get(fibSeed.id) ?? inputs.messages.get(fibLoop.id);
        if (pair === undefined) throw new Error("fibonacci: no input pair");
        const [a, b] = pair;
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
    new StepNode<void, typeof NumberSchema, string>(
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

  const execution = context({ scheduler: parallel(), graph });
  const completed = await execution.run();
  return { results, completed, graph, fibId, sinkId };
}

if (import.meta.main) {
  const tracer = ExampleTracer.create("examples/fibonacci");
  try {
    const r = await runFibonacci(tracer);
    console.log(JSON.stringify(r.results));
  } finally {
    await tracer.flush();
  }
}
