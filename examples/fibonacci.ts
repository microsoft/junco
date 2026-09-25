import type { NodeGenerator } from "../src/index.ts";
import {
  always,
  anyOf,
  DataflowGraph,
  emitOnce,
  from,
  messageEdge,
  msg,
  on,
  ReadyScheduler,
  stepNode,
  UNBOUNDED,
  Width,
  when,
} from "../src/index.ts";

const fibSeed = messageEdge<number, string>("fibSeed");
const fibLoop = messageEdge<number, string>("fibLoop");
const fibOut = messageEdge<number, string>("fibOut");

const results: number[] = [];
const graph = new DataflowGraph<void, number, string, never>(
  new ReadyScheduler(),
  Width(1),
  UNBOUNDED,
);

const seedId = graph.addNode({
  state: undefined,
  trigger: always(),
  step: emitOnce<void, number, string>(
    () => [msg(fibSeed, 0), msg(fibSeed, 1)],
    "seeded",
  ),
});

const fibId = graph.addNode({
  state: undefined,
  trigger: anyOf(on(fibSeed), on(fibLoop)),
  step: async function* (): NodeGenerator<number, string> {
    let inputs = yield [];
    for (let i = 0; i < 10; i++) {
      const pair = (inputs.messages.get(fibSeed.id) ??
        inputs.messages.get(fibLoop.id))!;
      const a = pair[0]!;
      const b = pair[1]!;
      inputs = yield [msg(fibOut, a), msg(fibLoop, b), msg(fibLoop, a + b)];
    }
    return "emitted 10 fibs";
  },
});

const sinkId = graph.addNode({
  state: undefined,
  trigger: when(fibOut),
  step: stepNode<void, number, string>((_state, view) => {
    for (const v of from(view, fibOut)) results.push(v);
    return [];
  }),
});

graph.addEdge(seedId, fibId, fibSeed);
graph.addEdge(fibId, fibId, fibLoop);
graph.addEdge(fibId, sinkId, fibOut);

await graph.run();

console.log(JSON.stringify(results));
