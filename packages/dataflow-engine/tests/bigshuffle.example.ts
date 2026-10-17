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

type Line = { readonly kind: "line"; readonly text: string };
type KV = { readonly kind: "kv"; readonly key: string; readonly value: string };
type LenMsg = { readonly kind: "len"; readonly total: number };
type Msg = Line | KV | LenMsg;

test("cookbook: bigshuffle with input and output checksums", async () => {
  const linesForMainEdge = Edge.message<Msg, string>("linesForMain");
  const linesForInputCsumEdge = Edge.message<Msg, string>("linesForInputCsum");
  const kvEdge = Edge.message<Msg, string>("kv");
  const formattedForSinkEdge = Edge.message<Msg, string>("formattedForSink");
  const formattedForOutputCsumEdge = Edge.message<Msg, string>(
    "formattedForOutputCsum",
  );
  const inputCsumEdge = Edge.message<Msg, string>("inputCsum");
  const outputCsumEdge = Edge.message<Msg, string>("outputCsum");

  const inputLines = [
    "AAAAAAAAAAvalue-1a",
    "AAAAAAAAAAvalue-2a",
    "BBBBBBBBBBvalue-1b",
    "CCCCCCCCCCvalue-1c",
  ];

  const mainOutput: string[] = [];
  const inputSum: number[] = [];
  const outputSum: number[] = [];

  const tracer = ExampleTracer.create("cookbook/bigshuffle");
  const graph = new DataflowGraph<void, Msg, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const sourceId = graph.addNode(
    new EmitOnce<void, Msg, string>(
      () => {
        const events: Message<Msg>[] = [];
        for (const text of inputLines) {
          const line: Line = { kind: "line", text };
          events.push(Message.create(linesForMainEdge, line));
          events.push(Message.create(linesForInputCsumEdge, line));
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

  const splitId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const lines = from(view, linesForMainEdge).filter(
          (m): m is Line => m.kind === "line",
        );
        return lines.map((l) =>
          Message.create(kvEdge, {
            kind: "kv",
            key: l.text.slice(0, 10),
            value: l.text.slice(10, 99),
          }),
        );
      },
      {
        state: undefined,
        trigger: TriggerRule.when(linesForMainEdge),
      },
    ),
  );

  const groupAndFlattenId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const groups = pipe(
          from(view, kvEdge),
          RA.filter((m): m is KV => m.kind === "kv"),
          RNEA.groupBy((kv) => kv.key),
        );
        const events: Message<Msg>[] = [];
        for (const key of Object.keys(groups).sort(S.Ord.compare)) {
          for (const kv of groups[key]!) {
            const line: Line = { kind: "line", text: key + kv.value };
            events.push(
              Message.create(formattedForSinkEdge, line),
              Message.create(formattedForOutputCsumEdge, line),
            );
          }
        }
        return events;
      },
      {
        state: undefined,
        trigger: TriggerRule.when(kvEdge),
      },
    ),
  );

  const inputCsumId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const lines = from(view, linesForInputCsumEdge).filter(
          (m): m is Line => m.kind === "line",
        );
        const total = lines.reduce((acc, l) => acc + l.text.length, 0);
        return [Message.create(inputCsumEdge, { kind: "len", total })];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(linesForInputCsumEdge),
      },
    ),
  );

  const outputCsumId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const lines = from(view, formattedForOutputCsumEdge).filter(
          (m): m is Line => m.kind === "line",
        );
        const total = lines.reduce((acc, l) => acc + l.text.length, 0);
        return [Message.create(outputCsumEdge, { kind: "len", total })];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(formattedForOutputCsumEdge),
      },
    ),
  );

  const mainSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, formattedForSinkEdge)) {
          if (m.kind === "line") mainOutput.push(m.text);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(formattedForSinkEdge),
      },
    ),
  );

  const inputCsumSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, inputCsumEdge)) {
          if (m.kind === "len") inputSum.push(m.total);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(inputCsumEdge),
      },
    ),
  );

  const outputCsumSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, outputCsumEdge)) {
          if (m.kind === "len") outputSum.push(m.total);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(outputCsumEdge),
      },
    ),
  );

  graph.addEdge(sourceId, splitId, linesForMainEdge);
  graph.addEdge(sourceId, inputCsumId, linesForInputCsumEdge);
  graph.addEdge(splitId, groupAndFlattenId, kvEdge);
  graph.addEdge(groupAndFlattenId, mainSinkId, formattedForSinkEdge);
  graph.addEdge(groupAndFlattenId, outputCsumId, formattedForOutputCsumEdge);
  graph.addEdge(inputCsumId, inputCsumSinkId, inputCsumEdge);
  graph.addEdge(outputCsumId, outputCsumSinkId, outputCsumEdge);

  try {
    const execution = context({ scheduler: parallel(), graph });
    const completed = await execution.run();

    assert.deepEqual(mainOutput, [
      "AAAAAAAAAAvalue-1a",
      "AAAAAAAAAAvalue-2a",
      "BBBBBBBBBBvalue-1b",
      "CCCCCCCCCCvalue-1c",
    ]);
    assert.deepEqual(inputSum, [72]);
    assert.deepEqual(outputSum, [72]);
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
