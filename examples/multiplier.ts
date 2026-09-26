import type {
  DataflowScheduler,
  NodeAvailability,
  NodeGenerator,
  NodeIdType,
  Schedule,
} from "../src/index.ts";
import {
  always,
  DataflowGraph,
  messageEdge,
  msg,
  stepNode,
  triggerInputs,
  Width,
  when,
} from "../src/index.ts";
import { createExampleTracer } from "./tracing.ts";

/**
 * Exactly one node per turn, picked by a priority list filled in once the node ids exist.
 * Example-local demonstration scheduler; not part of the library API.
 */
class PriorityScheduler implements DataflowScheduler<number, string> {
  readonly #priority: readonly NodeIdType[];

  constructor(priority: readonly NodeIdType[]) {
    this.#priority = priority;
  }

  create(_window: number, _threads: number): void {}

  schedule(
    available: ReadonlyMap<NodeIdType, NodeAvailability<number, string>>,
  ): Schedule {
    if (available.size === 0) return [];
    const plan = (id: NodeIdType): Schedule => [
      [{ id, inputs: triggerInputs(available.get(id)!) }],
    ];
    for (const id of this.#priority) {
      if (available.has(id)) return plan(id);
    }
    return plan([...available.keys()][0]!);
  }
}

const sourceToMultiplier = messageEdge<number, string>("sourceToMultiplier");
const multiplierToSink = messageEdge<number, string>("multiplierToSink");
const results: number[] = [];
const priority: NodeIdType[] = [];
const tracer = createExampleTracer("examples/multiplier");
const graph = new DataflowGraph<void, number, string, never>(
  new PriorityScheduler(priority),
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
  step: stepNode<void, number, string>((_state, view) => {
    const value = view.messages.get(sourceToMultiplier.id)![0]!;
    return [msg(multiplierToSink, value * 2)];
  }),
});

const sinkId = graph.addNode({
  state: undefined,
  trigger: when(multiplierToSink),
  step: stepNode<void, number, string>((_state, view) => {
    results.push(view.messages.get(multiplierToSink.id)![0]!);
    return [];
  }),
});

priority.push(sinkId, multiplierId, sourceId);

graph.addEdge(sourceId, multiplierId, sourceToMultiplier);
graph.addEdge(multiplierId, sinkId, multiplierToSink);

try {
  await graph.run();

  console.log(JSON.stringify(results));
} finally {
  await tracer.flush();
}
