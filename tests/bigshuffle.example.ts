import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import type { Message } from "../src/index.ts";
import {
  always,
  DataflowGraph,
  emitOnce,
  from,
  messageEdge,
  msg,
  ReadyScheduler,
  stepNode,
  UNBOUNDED,
  Width,
  when,
} from "../src/index.ts";

type Line = { readonly kind: "line"; readonly text: string };
type KV = { readonly kind: "kv"; readonly key: string; readonly value: string };
type LenMsg = { readonly kind: "len"; readonly total: number };
type Msg = Line | KV | LenMsg;

test("cookbook: bigshuffle with input and output checksums", async () => {
  const linesForMainEdge = messageEdge<Msg, string>("linesForMain");
  const linesForInputCsumEdge = messageEdge<Msg, string>("linesForInputCsum");
  const kvEdge = messageEdge<Msg, string>("kv");
  const formattedForSinkEdge = messageEdge<Msg, string>("formattedForSink");
  const formattedForOutputCsumEdge = messageEdge<Msg, string>(
    "formattedForOutputCsum",
  );
  const inputCsumEdge = messageEdge<Msg, string>("inputCsum");
  const outputCsumEdge = messageEdge<Msg, string>("outputCsum");

  const inputLines = [
    "AAAAAAAAAAvalue-1a",
    "AAAAAAAAAAvalue-2a",
    "BBBBBBBBBBvalue-1b",
    "CCCCCCCCCCvalue-1c",
  ];

  const mainOutput: string[] = [];
  const inputSum: number[] = [];
  const outputSum: number[] = [];

  const graph = new DataflowGraph<void, Msg, string, never>(
    new ReadyScheduler(),
    Width(1),
    UNBOUNDED,
  );

  const sourceId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce<void, Msg, string>(() => {
      const events: Message<Msg>[] = [];
      for (const text of inputLines) {
        const line: Line = { kind: "line", text };
        events.push(msg(linesForMainEdge, line));
        events.push(msg(linesForInputCsumEdge, line));
      }
      return events;
    }, "source done"),
  });

  const splitId = graph.addNode({
    state: undefined,
    trigger: when(linesForMainEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const lines = from(view, linesForMainEdge).filter(
        (m): m is Line => m.kind === "line",
      );
      return lines.map((l) =>
        msg(kvEdge, {
          kind: "kv",
          key: l.text.slice(0, 10),
          value: l.text.slice(10, 99),
        }),
      );
    }),
  });

  const groupAndFlattenId = graph.addNode({
    state: undefined,
    trigger: when(kvEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
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
            msg(formattedForSinkEdge, line),
            msg(formattedForOutputCsumEdge, line),
          );
        }
      }
      return events;
    }),
  });

  const inputCsumId = graph.addNode({
    state: undefined,
    trigger: when(linesForInputCsumEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const lines = from(view, linesForInputCsumEdge).filter(
        (m): m is Line => m.kind === "line",
      );
      const total = lines.reduce((acc, l) => acc + l.text.length, 0);
      return [msg(inputCsumEdge, { kind: "len", total })];
    }),
  });

  const outputCsumId = graph.addNode({
    state: undefined,
    trigger: when(formattedForOutputCsumEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const lines = from(view, formattedForOutputCsumEdge).filter(
        (m): m is Line => m.kind === "line",
      );
      const total = lines.reduce((acc, l) => acc + l.text.length, 0);
      return [msg(outputCsumEdge, { kind: "len", total })];
    }),
  });

  const mainSinkId = graph.addNode({
    state: undefined,
    trigger: when(formattedForSinkEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, formattedForSinkEdge)) {
        if (m.kind === "line") mainOutput.push(m.text);
      }
      return [];
    }),
  });

  const inputCsumSinkId = graph.addNode({
    state: undefined,
    trigger: when(inputCsumEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, inputCsumEdge)) {
        if (m.kind === "len") inputSum.push(m.total);
      }
      return [];
    }),
  });

  const outputCsumSinkId = graph.addNode({
    state: undefined,
    trigger: when(outputCsumEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, outputCsumEdge)) {
        if (m.kind === "len") outputSum.push(m.total);
      }
      return [];
    }),
  });

  graph.addEdge(sourceId, splitId, linesForMainEdge);
  graph.addEdge(sourceId, inputCsumId, linesForInputCsumEdge);
  graph.addEdge(splitId, groupAndFlattenId, kvEdge);
  graph.addEdge(groupAndFlattenId, mainSinkId, formattedForSinkEdge);
  graph.addEdge(groupAndFlattenId, outputCsumId, formattedForOutputCsumEdge);
  graph.addEdge(inputCsumId, inputCsumSinkId, inputCsumEdge);
  graph.addEdge(outputCsumId, outputCsumSinkId, outputCsumEdge);

  const completed = await graph.run();

  assert.deepEqual(mainOutput, [
    "AAAAAAAAAAvalue-1a",
    "AAAAAAAAAAvalue-2a",
    "BBBBBBBBBBvalue-1b",
    "CCCCCCCCCCvalue-1c",
  ]);
  assert.deepEqual(inputSum, [72]);
  assert.deepEqual(outputSum, [72]);
  assert.equal(completed.get(sourceId), "source done");
});
