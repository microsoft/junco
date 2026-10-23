import { context, roundRobin } from "junco-scheduler";
import type { DataflowTracer, NodeGenerator } from "../src/index.ts";
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
export async function runMultiplier(tracer?: DataflowTracer) {
  const results: number[] = [];
  const graph = new DataflowGraph<void, number, string, never>(
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

  const execution = context({ scheduler: roundRobin(), graph });
  const completed = await execution.run();
  return { results, completed, graph, sourceId, multiplierId, sinkId };
}

if (import.meta.main) {
  const tracer = ExampleTracer.create("examples/multiplier");
  try {
    const r = await runMultiplier(tracer);
    console.log(JSON.stringify(r.results));
  } finally {
    await tracer.flush();
  }
}
