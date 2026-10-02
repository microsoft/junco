import { createRoundRobinScheduler } from "junco-scheduler";
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
import { createExampleTracer } from "./tracing.ts";

const sourceToMultiplier = messageEdge<number, string>("sourceToMultiplier");
const multiplierToSink = messageEdge<number, string>("multiplierToSink");
const results: number[] = [];
const tracer = createExampleTracer("examples/multiplier");
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
  await graph.run();

  console.log(JSON.stringify(results));
} finally {
  await tracer.flush();
}
