import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import { context, parallel } from "junco-scheduler";
import { ExampleTracer } from "../examples/tracing.ts";
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

type Row = {
  readonly kind: "row";
  readonly month: number;
  readonly day: number;
  readonly tornado: boolean;
};
type Pair = {
  readonly kind: "pair";
  readonly month: number;
  readonly count: number;
};
type Result = {
  readonly kind: "result";
  readonly month: number;
  readonly tornado_count: number;
};
type Msg = Row | Pair | Result;

test("cookbook: bigquery tornadoes count per month", async () => {
  const rowsEdge = Edge.message<Msg, string>("rows");
  const pairsEdge = Edge.message<Msg, string>("pairs");
  const resultsEdge = Edge.message<Msg, string>("results");

  const results: Result[] = [];
  const tracer = ExampleTracer.create("cookbook/bigquery-tornadoes");
  const graph = new DataflowGraph<void, Msg, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const inputRows: Row[] = [
    { kind: "row", month: 1, day: 1, tornado: false },
    { kind: "row", month: 1, day: 2, tornado: true },
    { kind: "row", month: 1, day: 3, tornado: true },
    { kind: "row", month: 2, day: 1, tornado: true },
  ];

  const sourceId = graph.addNode(
    new EmitOnce<void, Msg, string>(
      () => inputRows.map((row) => Message.create(rowsEdge, row)),
      "source done",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );

  const filterAndPairId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const rows = from(view, rowsEdge).filter(
          (m): m is Row => m.kind === "row",
        );
        return rows
          .filter((r) => r.tornado)
          .map((r) =>
            Message.create(pairsEdge, {
              kind: "pair",
              month: r.month,
              count: 1,
            }),
          );
      },
      {
        state: undefined,
        trigger: TriggerRule.when(rowsEdge),
      },
    ),
  );

  const combinePerKeyId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const groups = pipe(
          from(view, pairsEdge),
          RA.filter((m): m is Pair => m.kind === "pair"),
          RNEA.groupBy((p) => String(p.month)),
        );
        const events: Message<Msg>[] = [];
        for (const month of Object.keys(groups).sort(S.Ord.compare)) {
          const group = groups[month]!;
          events.push(
            Message.create(resultsEdge, {
              kind: "result",
              month: Number(month),
              tornado_count: pipe(
                group,
                RA.reduce(0, (acc, p) => acc + p.count),
              ),
            }),
          );
        }
        return events;
      },
      {
        state: undefined,
        trigger: TriggerRule.when(pairsEdge),
      },
    ),
  );

  const sinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, resultsEdge)) {
          if (m.kind === "result") results.push(m);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(resultsEdge),
      },
    ),
  );

  graph.addEdge(sourceId, filterAndPairId, rowsEdge);
  graph.addEdge(filterAndPairId, combinePerKeyId, pairsEdge);
  graph.addEdge(combinePerKeyId, sinkId, resultsEdge);

  try {
    const execution = context({ scheduler: parallel(), graph });
    const completed = await execution.run();

    assert.deepEqual(results, [
      { kind: "result", month: 1, tornado_count: 2 },
      { kind: "result", month: 2, tornado_count: 1 },
    ]);
    assert.equal(completed.get(sourceId), "source done");
    assert.equal(completed.has(filterAndPairId), false);
    assert.equal(completed.has(combinePerKeyId), false);
    assert.equal(completed.has(sinkId), false);
  } finally {
    await tracer.flush();
  }
});
