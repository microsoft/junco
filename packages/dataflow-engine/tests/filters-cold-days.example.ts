import { test } from "bun:test";
import assert from "node:assert/strict";
import { createParallelScheduler } from "junco-scheduler";
import { createExampleTracer } from "../examples/tracing.ts";
import type { Message } from "../src/index.ts";
import {
  allOf,
  always,
  DataflowGraph,
  emitOnce,
  from,
  messageEdge,
  msg,
  on,
  stepNode,
  UNBOUNDED,
  Width,
  when,
} from "../src/index.ts";

type Row = {
  readonly kind: "row";
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly mean_temp: number;
};
type Mean = { readonly kind: "mean"; readonly value: number };
type Msg = Row | Mean;

test("cookbook: filters cold days with global mean AND-trigger", async () => {
  const rowsForMonthFilterEdge = messageEdge<Msg, string>("rowsForMonthFilter");
  const rowsForMeanEdge = messageEdge<Msg, string>("rowsForMean");
  const monthFilteredEdge = messageEdge<Msg, string>("monthFiltered");
  const meanEdge = messageEdge<Msg, string>("mean");
  const outEdge = messageEdge<Msg, string>("out");

  const monthFilterValue = 1;
  const inputRows: Row[] = [
    { kind: "row", year: 2010, month: 1, day: 1, mean_temp: 3 },
    { kind: "row", year: 2012, month: 1, day: 2, mean_temp: 3 },
    { kind: "row", year: 2011, month: 1, day: 3, mean_temp: 5 },
    { kind: "row", year: 2013, month: 2, day: 1, mean_temp: 3 },
    { kind: "row", year: 2011, month: 3, day: 3, mean_temp: 5 },
  ];

  const results: Row[] = [];
  const tracer = createExampleTracer("cookbook/filters-cold-days");
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
      for (const row of inputRows) {
        events.push(
          msg(rowsForMonthFilterEdge, row),
          msg(rowsForMeanEdge, row),
        );
      }
      return events;
    }, "source done"),
  });

  const monthFilterId = graph.addNode({
    state: undefined,
    trigger: when(rowsForMonthFilterEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const rows = from(view, rowsForMonthFilterEdge).filter(
        (m): m is Row => m.kind === "row",
      );
      return rows
        .filter((r) => r.month === monthFilterValue)
        .map((r) => msg(monthFilteredEdge, r));
    }),
  });

  const meanCombineId = graph.addNode({
    state: undefined,
    trigger: when(rowsForMeanEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const rows = from(view, rowsForMeanEdge).filter(
        (m): m is Row => m.kind === "row",
      );
      if (rows.length === 0) return [];
      const total = rows.reduce((acc, r) => acc + r.mean_temp, 0);
      const value = total / rows.length;
      return [msg(meanEdge, { kind: "mean", value })];
    }),
  });

  const belowMeanFilterId = graph.addNode({
    state: undefined,
    trigger: allOf(on(monthFilteredEdge), on(meanEdge)),
    step: stepNode<void, Msg, string>((_state, view) => {
      const rows = from(view, monthFilteredEdge).filter(
        (m): m is Row => m.kind === "row",
      );
      const means = from(view, meanEdge).filter(
        (m): m is Mean => m.kind === "mean",
      );
      const mean = means[0];
      if (mean === undefined) return [];
      return rows
        .filter((r) => r.mean_temp < mean.value)
        .map((r) => msg(outEdge, r));
    }),
  });

  const sinkId = graph.addNode({
    state: undefined,
    trigger: when(outEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, outEdge)) {
        if (m.kind === "row") results.push(m);
      }
      return [];
    }),
  });

  graph.addEdge(sourceId, monthFilterId, rowsForMonthFilterEdge);
  graph.addEdge(sourceId, meanCombineId, rowsForMeanEdge);
  graph.addEdge(monthFilterId, belowMeanFilterId, monthFilteredEdge);
  graph.addEdge(meanCombineId, belowMeanFilterId, meanEdge);
  graph.addEdge(belowMeanFilterId, sinkId, outEdge);

  try {
    const completed = await graph.run();

    assert.deepEqual(
      results.map((r) => [r.year, r.month, r.day]),
      [
        [2010, 1, 1],
        [2012, 1, 2],
      ],
    );
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
