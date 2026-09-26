import { test } from "bun:test";
import assert from "node:assert/strict";
import { createExampleTracer } from "../examples/tracing.ts";
import type { Message } from "../src/index.ts";
import {
  always,
  anyOf,
  DataflowGraph,
  emitOnce,
  messageEdge,
  msg,
  on,
  ReadyScheduler,
  stepNode,
  UNBOUNDED,
  Width,
  when,
} from "../src/index.ts";

type SourceLine = { readonly kind: "line"; readonly text: string };
type CharCount = { readonly kind: "chars"; readonly length: number };
type WordMsg = { readonly kind: "word"; readonly word: string };
type Msg = SourceLine | CharCount | WordMsg;

test("cookbook: OR-trigger unified word counter from split outputs", async () => {
  const linesEdge = messageEdge<Msg, string>("lines");
  const charCountEdge = messageEdge<Msg, string>("charCount");
  const shortWordsEdge = messageEdge<Msg, string>("shortWords");
  const longWordsEdge = messageEdge<Msg, string>("longWords");
  const charSumEdge = messageEdge<Msg, string>("charSum");

  const inputLines = ["A whole new world", "A new fantastic point of view"];
  const totalChars: number[] = [];
  const unifiedCounts = new Map<string, number>();
  let unifiedFireCount = 0;

  const tracer = createExampleTracer("cookbook/or-unified-counter");
  const graph = new DataflowGraph<void, Msg, string, never>(
    new ReadyScheduler(),
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
      const lines = (view.messages.get(linesEdge.id) ?? []).filter(
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
      return events;
    }),
  });

  const unifiedCounterId = graph.addNode({
    state: undefined,
    trigger: anyOf(on(shortWordsEdge), on(longWordsEdge)),
    step: stepNode<void, Msg, string>((_state, view) => {
      unifiedFireCount += 1;
      const shortBatch = (view.messages.get(shortWordsEdge.id) ?? []).filter(
        (m): m is WordMsg => m.kind === "word",
      );
      const longBatch = (view.messages.get(longWordsEdge.id) ?? []).filter(
        (m): m is WordMsg => m.kind === "word",
      );
      for (const { word } of [...shortBatch, ...longBatch]) {
        unifiedCounts.set(word, (unifiedCounts.get(word) ?? 0) + 1);
      }
      return [];
    }),
  });

  const charSumId = graph.addNode({
    state: undefined,
    trigger: when(charCountEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const chars = (view.messages.get(charCountEdge.id) ?? []).filter(
        (m): m is CharCount => m.kind === "chars",
      );
      const total = chars.reduce((acc, c) => acc + c.length, 0);
      return [msg(charSumEdge, { kind: "chars", length: total })];
    }),
  });

  const charSumSinkId = graph.addNode({
    state: undefined,
    trigger: when(charSumEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of view.messages.get(charSumEdge.id) ?? []) {
        if (m.kind === "chars") totalChars.push(m.length);
      }
      return [];
    }),
  });

  graph.addEdge(sourceId, splitterId, linesEdge);
  graph.addEdge(splitterId, unifiedCounterId, shortWordsEdge);
  graph.addEdge(splitterId, unifiedCounterId, longWordsEdge);
  graph.addEdge(splitterId, charSumId, charCountEdge);
  graph.addEdge(charSumId, charSumSinkId, charSumEdge);

  try {
    const completed = await graph.run();

    const expected: [string, number][] = [
      ["A", 2],
      ["fantastic", 1],
      ["new", 2],
      ["of", 1],
      ["point", 1],
      ["view", 1],
      ["whole", 1],
      ["world", 1],
    ];
    assert.deepEqual([...unifiedCounts.entries()].sort(), expected.sort());
    assert.deepEqual(totalChars, [46]);
    assert.equal(unifiedFireCount, 2);
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
