import { RoundRobinScheduler } from "junco-scheduler";
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
import { ExampleTracer } from "./tracing.ts";

const sourceToMultiplier = Edge.message<number, string>("sourceToMultiplier");
const multiplierToSink = Edge.message<number, string>("multiplierToSink");
const results: number[] = [];
const tracer = ExampleTracer.create("examples/multiplier");
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
  await graph.run();

  console.log(JSON.stringify(results));
} finally {
  await tracer.flush();
}
