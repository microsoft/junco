import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import { context, parallel } from "junco-scheduler";
import type { DataflowTracer } from "../src/index.ts";
import {
  DataflowGraph,
  Edge,
  EmitOnce,
  from,
  Message,
  StepNode,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";
import { ExampleTracer } from "./tracing.ts";

type Pair = {
  readonly kind: "pair";
  readonly key: string;
  readonly value: number;
};
type Result = {
  readonly kind: "result";
  readonly key: string;
  readonly value: number;
};
type Msg = Pair | Result;

const sumInEdge = Edge.message<Msg, string>("sumIn");
const multiplyInEdge = Edge.message<Msg, string>("multiplyIn");
const sumOutEdge = Edge.message<Msg, string>("sumOut");
const multiplyOutEdge = Edge.message<Msg, string>("multiplyOut");

const inputPairs: [string, number][] = [
  ["a", 1],
  ["b", 10],
  ["a", 2],
  ["a", 3],
  ["b", 20],
  ["c", 100],
];

export async function runCombinePerKey(tracer?: DataflowTracer) {
  const sums: Result[] = [];
  const products: Result[] = [];
  const graph = new DataflowGraph<void, Msg, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const sourceId = graph.addNode(
    new EmitOnce<void, Msg, string>(
      () => {
        const events: Message<Msg>[] = [];
        for (const [key, value] of inputPairs) {
          const pair: Pair = { kind: "pair", key, value };
          events.push(
            Message.create(sumInEdge, pair),
            Message.create(multiplyInEdge, pair),
          );
        }
        return events;
      },
      "source done",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );

  const makeCombine = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
    init: number,
    reduce: (acc: number, v: number) => number,
  ) => {
    const id = graph.addNode(
      new StepNode<void, Msg, string>(
        (_state, view) => {
          const groups = pipe(
            from(view, inputEdge),
            RA.filter((m): m is Pair => m.kind === "pair"),
            RNEA.groupBy((p) => p.key),
          );
          const events: Message<Msg>[] = [];
          for (const key of Object.keys(groups).sort(S.Ord.compare)) {
            const group = groups[key]!;
            events.push(
              Message.create(outputEdge, {
                kind: "result",
                key,
                value: pipe(
                  group,
                  RA.reduce(init, (a, p) => reduce(a, p.value)),
                ),
              }),
            );
          }
          return events;
        },
        {
          state: undefined,
          trigger: TriggerRule.when(inputEdge),
        },
      ),
    );
    return id;
  };

  const sumCombineId = makeCombine(sumInEdge, sumOutEdge, 0, (a, b) => a + b);
  const multiplyCombineId = makeCombine(
    multiplyInEdge,
    multiplyOutEdge,
    1,
    (a, b) => a * b,
  );

  const sumSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, sumOutEdge)) {
          if (m.kind === "result") sums.push(m);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(sumOutEdge),
      },
    ),
  );

  const multiplySinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, multiplyOutEdge)) {
          if (m.kind === "result") products.push(m);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(multiplyOutEdge),
      },
    ),
  );

  graph.addEdge(sourceId, sumCombineId, sumInEdge);
  graph.addEdge(sourceId, multiplyCombineId, multiplyInEdge);
  graph.addEdge(sumCombineId, sumSinkId, sumOutEdge);
  graph.addEdge(multiplyCombineId, multiplySinkId, multiplyOutEdge);

  const execution = context({ scheduler: parallel(), graph });
  const completed = await execution.run();
  return { sums, products, completed, sourceId };
}

if (import.meta.main) {
  const tracer = ExampleTracer.create("examples/combine-per-key");
  try {
    const r = await runCombinePerKey(tracer);
    console.log(
      JSON.stringify({
        sums: r.sums.map((r) => [r.key, r.value]),
        products: r.products.map((r) => [r.key, r.value]),
      }),
    );
  } finally {
    await tracer.flush();
  }
}
