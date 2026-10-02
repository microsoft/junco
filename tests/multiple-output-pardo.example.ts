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

type SourceLine = { readonly kind: "line"; readonly text: string };
type CharCount = { readonly kind: "chars"; readonly length: number };
type WordMsg = { readonly kind: "word"; readonly word: string };
type Pair = {
  readonly kind: "pair";
  readonly word: string;
  readonly count: number;
};
type Msg = SourceLine | CharCount | WordMsg | Pair;

test("cookbook: multiple output pardo split lines to words", async () => {
  const linesEdge = messageEdge<Msg, string>("lines");
  const charCountEdge = messageEdge<Msg, string>("charCount");
  const shortWordsEdge = messageEdge<Msg, string>("shortWords");
  const longWordsEdge = messageEdge<Msg, string>("longWords");
  const charSumEdge = messageEdge<Msg, string>("charSum");
  const shortCountsEdge = messageEdge<Msg, string>("shortCounts");
  const longCountsEdge = messageEdge<Msg, string>("longCounts");

  const inputLines = ["A whole new world", "A new fantastic point of view"];
  const shortCounts: [string, number][] = [];
  const longCounts: [string, number][] = [];
  const totalChars: number[] = [];
  const splitterFirings: number[] = [];

  const tracer = createExampleTracer("cookbook/multiple-output-pardo");
  const graph = new DataflowGraph<void, Msg, string, never>(
    createParallelScheduler(),
    Width(1),
    UNBOUNDED,
    tracer,
  );

  const sourceId = graph.addNode({
    state: undefined,
    trigger: always(),
    step: emitOnce<void, Msg, string>(
      () => inputLines.map((text) => msg(linesEdge, { kind: "line", text })),
      "source done",
    ),
  });

  const splitterId = graph.addNode({
    state: undefined,
    trigger: when(linesEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const lines = from(view, linesEdge).filter(
        (m): m is SourceLine => m.kind === "line",
      );
      const events: Message<Msg>[] = [];
      for (const line of lines) {
        events.push(
          msg(charCountEdge, { kind: "chars", length: line.text.length }),
        );
        for (const match of line.text.matchAll(/[A-Za-z']+/g)) {
          const word = match[0]!;
          const targetEdge = word.length <= 3 ? shortWordsEdge : longWordsEdge;
          events.push(msg(targetEdge, { kind: "word", word }));
        }
      }
      splitterFirings.push(events.length);
      return events;
    }),
  });

  const charSumId = graph.addNode({
    state: undefined,
    trigger: when(charCountEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const chars = from(view, charCountEdge).filter(
        (m): m is CharCount => m.kind === "chars",
      );
      const total = chars.reduce((acc, c) => acc + c.length, 0);
      return [msg(charSumEdge, { kind: "chars", length: total })];
    }),
  });

  const attachCountWords = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
  ) => {
    const id = graph.addNode({
      state: undefined,
      trigger: when(inputEdge),
      step: stepNode<void, Msg, string>((_state, view) => {
        const groups = pipe(
          from(view, inputEdge),
          RA.filter((m): m is WordMsg => m.kind === "word"),
          RNEA.groupBy((m) => m.word),
        );
        const events: Message<Msg>[] = [];
        for (const word of Object.keys(groups).sort(S.Ord.compare)) {
          events.push(
            msg(outputEdge, {
              kind: "pair",
              word,
              count: groups[word]!.length,
            }),
          );
        }
        return events;
      }),
    });
    return id;
  };

  const shortCountId = attachCountWords(shortWordsEdge, shortCountsEdge);
  const longCountId = attachCountWords(longWordsEdge, longCountsEdge);

  const shortSinkId = graph.addNode({
    state: undefined,
    trigger: when(shortCountsEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, shortCountsEdge)) {
        if (m.kind === "pair") shortCounts.push([m.word, m.count]);
      }
      return [];
    }),
  });

  const longSinkId = graph.addNode({
    state: undefined,
    trigger: when(longCountsEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, longCountsEdge)) {
        if (m.kind === "pair") longCounts.push([m.word, m.count]);
      }
      return [];
    }),
  });

  const charSumSinkId = graph.addNode({
    state: undefined,
    trigger: when(charSumEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, charSumEdge)) {
        if (m.kind === "chars") totalChars.push(m.length);
      }
      return [];
    }),
  });

  graph.addEdge(sourceId, splitterId, linesEdge);
  graph.addEdge(splitterId, charSumId, charCountEdge);
  graph.addEdge(splitterId, shortCountId, shortWordsEdge);
  graph.addEdge(splitterId, longCountId, longWordsEdge);
  graph.addEdge(charSumId, charSumSinkId, charSumEdge);
  graph.addEdge(shortCountId, shortSinkId, shortCountsEdge);
  graph.addEdge(longCountId, longSinkId, longCountsEdge);

  try {
    const completed = await graph.run();

    assert.deepEqual(totalChars, [46]);
    assert.deepEqual(
      [...shortCounts].sort(),
      (
        [
          ["A", 2],
          ["new", 2],
          ["of", 1],
        ] as [string, number][]
      ).sort(),
    );
    assert.deepEqual(
      [...longCounts].sort(),
      (
        [
          ["whole", 1],
          ["world", 1],
          ["fantastic", 1],
          ["point", 1],
          ["view", 1],
        ] as [string, number][]
      ).sort(),
    );
    assert.deepEqual(splitterFirings, [12]);
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
