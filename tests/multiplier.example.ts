import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { DataflowGraph, Width, always, messageEdge, msg, stepNode, triggerInputs, when } from "../src/index.ts";
import type { DataflowScheduler, NodeAvailability, NodeGenerator, NodeIdType, Schedule } from "../src/index.ts";

/**
 * The original's `(self) => { const ready = self.ready(); for (const id of priority) if
 * (ready.includes(id)) return [id]; return ready.slice(0, 1); }` — exactly one node per turn,
 * picked by a priority list the test fills in once the node ids exist.
 */
class PriorityScheduler implements DataflowScheduler<void, number, string> {
  readonly #priority: readonly NodeIdType[];

  constructor(priority: readonly NodeIdType[]) {
    this.#priority = priority;
  }

  create(_window: number, _threads: number): void {}

  schedule(available: ReadonlyMap<NodeIdType, NodeAvailability<void, number, string>>): Schedule {
    if (available.size === 0) return [];
    const plan = (id: NodeIdType): Schedule => [[{ id, inputs: triggerInputs(available.get(id)!) }]];
    for (const id of this.#priority) {
      if (available.has(id)) return plan(id);
    }
    return plan([...available.keys()][0]!);
  }
}

test("cookbook: end-to-end three stage multiplier graph", async () => {
  const sourceToMultiplier = messageEdge<number, string>("sourceToMultiplier");
  const multiplierToSink = messageEdge<number, string>("multiplierToSink");
  const results: number[] = [];
  const priority: NodeIdType[] = [];
  const graph = new DataflowGraph<void, number, string, never>(
    new PriorityScheduler(priority),
    Width(1),
    Width(1),
  );

  const sourceId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: async function* (): NodeGenerator<void, number, string> {
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

  const completed = await graph.run();

  assert.deepEqual(results, [2, 4, 6]);
  assert.equal(completed.get(sourceId), "source done");
  assert.equal(completed.has(multiplierId), false);
  assert.equal(completed.has(sinkId), false);
  assert.deepEqual(graph.result(multiplierId), O.none);
  assert.deepEqual(graph.result(sinkId), O.none);
});
