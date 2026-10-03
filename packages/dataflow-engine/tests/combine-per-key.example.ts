import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import { createParallelScheduler } from "junco-scheduler";
import { createExampleTracer } from "../examples/tracing.ts";
import type { Edge, Message } from "../src/index.ts";
import {
  always,
  DataflowGraph,
  emitOnce,
  from,
  messageEdge,
  msg,
  stepNode,
  UNBOUNDED,
  Width,
  when,
} from "../src/index.ts";

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

test("cookbook: combine-per-key sum and multiply from same source", async () => {
  const sumInEdge = messageEdge<Msg, string>("sumIn");
  const multiplyInEdge = messageEdge<Msg, string>("multiplyIn");
  const sumOutEdge = messageEdge<Msg, string>("sumOut");
  const multiplyOutEdge = messageEdge<Msg, string>("multiplyOut");

  const inputPairs: [string, number][] = [
    ["a", 1],
    ["b", 10],
    ["a", 2],
    ["a", 3],
    ["b", 20],
    ["c", 100],
  ];

  const sums: Result[] = [];
  const products: Result[] = [];
  const tracer = createExampleTracer("cookbook/combine-per-key");
  const graph = new DataflowGraph<void, Msg, string, never>(
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
    tracer,
  );

  const sourceId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce<void, Msg, string>(() => {
      const events: Message<Msg>[] = [];
      for (const [key, value] of inputPairs) {
        const pair: Pair = { kind: "pair", key, value };
        events.push(msg(sumInEdge, pair), msg(multiplyInEdge, pair));
      }
      return events;
    }, "source done"),
  });

  const makeCombine = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
    init: number,
    reduce: (acc: number, v: number) => number,
  ) => {
    const id = graph.addNode({
      state: undefined,
      trigger: when(inputEdge),
      step: stepNode<void, Msg, string>((_state, view) => {
        const groups = pipe(
          from(view, inputEdge),
          RA.filter((m): m is Pair => m.kind === "pair"),
          RNEA.groupBy((p) => p.key),
        );
        const events: Message<Msg>[] = [];
        for (const key of Object.keys(groups).sort(S.Ord.compare)) {
          const group = groups[key]!;
          events.push(
            msg(outputEdge, {
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
      }),
    });
    return id;
  };

  const sumCombineId = makeCombine(sumInEdge, sumOutEdge, 0, (a, b) => a + b);
  const multiplyCombineId = makeCombine(
    multiplyInEdge,
    multiplyOutEdge,
    1,
    (a, b) => a * b,
  );

  const sumSinkId = graph.addNode({
    state: undefined,
    trigger: when(sumOutEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, sumOutEdge)) {
        if (m.kind === "result") sums.push(m);
      }
      return [];
    }),
  });

  const multiplySinkId = graph.addNode({
    state: undefined,
    trigger: when(multiplyOutEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, multiplyOutEdge)) {
        if (m.kind === "result") products.push(m);
      }
      return [];
    }),
  });

  graph.addEdge(sourceId, sumCombineId, sumInEdge);
  graph.addEdge(sourceId, multiplyCombineId, multiplyInEdge);
  graph.addEdge(sumCombineId, sumSinkId, sumOutEdge);
  graph.addEdge(multiplyCombineId, multiplySinkId, multiplyOutEdge);

  try {
    const completed = await graph.run();

    assert.deepEqual(
      sums.map((r) => [r.key, r.value]),
      [
        ["a", 6],
        ["b", 30],
        ["c", 100],
      ],
    );
    assert.deepEqual(
      products.map((r) => [r.key, r.value]),
      [
        ["a", 6],
        ["b", 200],
        ["c", 100],
      ],
    );
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
