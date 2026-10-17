import { test } from "bun:test";
import assert from "node:assert/strict";
import { context, parallel } from "junco-scheduler";
import { ExampleTracer } from "../examples/tracing.ts";
import {
  DataflowGraph,
  Edge,
  EmitOnce,
  from,
  Message,
  StepNode,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
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
  const rowsForMonthFilterEdge = Edge.message<Msg, string>(
    "rowsForMonthFilter",
  );
  const rowsForMeanEdge = Edge.message<Msg, string>("rowsForMean");
  const monthFilteredEdge = Edge.message<Msg, string>("monthFiltered");
  const meanEdge = Edge.message<Msg, string>("mean");
  const outEdge = Edge.message<Msg, string>("out");

  const monthFilterValue = 1;
  const inputRows: Row[] = [
    { kind: "row", year: 2010, month: 1, day: 1, mean_temp: 3 },
    { kind: "row", year: 2012, month: 1, day: 2, mean_temp: 3 },
    { kind: "row", year: 2011, month: 1, day: 3, mean_temp: 5 },
    { kind: "row", year: 2013, month: 2, day: 1, mean_temp: 3 },
    { kind: "row", year: 2011, month: 3, day: 3, mean_temp: 5 },
  ];

  const results: Row[] = [];
  const tracer = ExampleTracer.create("cookbook/filters-cold-days");
  const graph = new DataflowGraph<void, Msg, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const sourceId = graph.addNode(
    new EmitOnce<void, Msg, string>(
      () => {
        const events: Message<Msg>[] = [];
        for (const row of inputRows) {
          events.push(
            Message.create(rowsForMonthFilterEdge, row),
            Message.create(rowsForMeanEdge, row),
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

  const monthFilterId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const rows = from(view, rowsForMonthFilterEdge).filter(
          (m): m is Row => m.kind === "row",
        );
        return rows
          .filter((r) => r.month === monthFilterValue)
          .map((r) => Message.create(monthFilteredEdge, r));
      },
      {
        state: undefined,
        trigger: TriggerRule.when(rowsForMonthFilterEdge),
      },
    ),
  );

  const meanCombineId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const rows = from(view, rowsForMeanEdge).filter(
          (m): m is Row => m.kind === "row",
        );
        if (rows.length === 0) return [];
        const total = rows.reduce((acc, r) => acc + r.mean_temp, 0);
        const value = total / rows.length;
        return [Message.create(meanEdge, { kind: "mean", value })];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(rowsForMeanEdge),
      },
    ),
  );

  const belowMeanFilterId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
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
          .map((r) => Message.create(outEdge, r));
      },
      {
        state: undefined,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(monthFilteredEdge),
          TriggerEntry.on(meanEdge),
        ),
      },
    ),
  );

  const sinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, outEdge)) {
          if (m.kind === "row") results.push(m);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(outEdge),
      },
    ),
  );

  graph.addEdge(sourceId, monthFilterId, rowsForMonthFilterEdge);
  graph.addEdge(sourceId, meanCombineId, rowsForMeanEdge);
  graph.addEdge(monthFilterId, belowMeanFilterId, monthFilteredEdge);
  graph.addEdge(meanCombineId, belowMeanFilterId, meanEdge);
  graph.addEdge(belowMeanFilterId, sinkId, outEdge);

  try {
    const execution = context({ scheduler: parallel(), graph });
    const completed = await execution.run();

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
