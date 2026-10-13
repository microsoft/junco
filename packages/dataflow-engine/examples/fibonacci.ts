import { ParallelScheduler } from "junco-scheduler";
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
import { ExampleTracer } from "./tracing.ts";

const fibSeed = Edge.message<number, string>("fibSeed");
const fibLoop = Edge.message<number, string>("fibLoop");
const fibOut = Edge.message<number, string>("fibOut");

const results: number[] = [];
const tracer = ExampleTracer.create("examples/fibonacci");
const graph = new DataflowGraph<void, number, string, never>(
  new ParallelScheduler(),
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
  await graph.run();

  console.log(JSON.stringify(results));
} finally {
  await tracer.flush();
}
