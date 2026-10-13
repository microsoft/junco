import { test } from "bun:test";
import assert from "node:assert/strict";
import { ParallelScheduler } from "junco-scheduler";
import { ExampleTracer } from "../examples/tracing.ts";
import {
  DataflowGraph,
  Edge,
  EmitOnce,
  Message,
  StepNode,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";

type SourceLine = { readonly kind: "line"; readonly text: string };
type CharCount = { readonly kind: "chars"; readonly length: number };
type WordMsg = { readonly kind: "word"; readonly word: string };
type Msg = SourceLine | CharCount | WordMsg;

test("cookbook: OR-trigger unified word counter from split outputs", async () => {
  const linesEdge = Edge.message<Msg, string>("lines");
  const charCountEdge = Edge.message<Msg, string>("charCount");
  const shortWordsEdge = Edge.message<Msg, string>("shortWords");
  const longWordsEdge = Edge.message<Msg, string>("longWords");
  const charSumEdge = Edge.message<Msg, string>("charSum");

  const inputLines = ["A whole new world", "A new fantastic point of view"];
  const totalChars: number[] = [];
  const unifiedCounts = new Map<string, number>();
  let unifiedFireCount = 0;

  const tracer = ExampleTracer.create("cookbook/or-unified-counter");
  const graph = new DataflowGraph<void, Msg, string, never>(
    new ParallelScheduler(),
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const sourceId = graph.addNode(
    new EmitOnce<void, Msg, string>(
      () =>
        inputLines.map((text) =>
          Message.create(linesEdge, { kind: "line", text }),
        ),
      "source done",
      {
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );

  const splitterId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const lines = (view.messages.get(linesEdge.id) ?? []).filter(
          (m): m is SourceLine => m.kind === "line",
        );
        const events: Message<Msg>[] = [];
        for (const line of lines) {
          events.push(
            Message.create(charCountEdge, {
              kind: "chars",
              length: line.text.length,
            }),
          );
          for (const match of line.text.matchAll(/[A-Za-z']+/g)) {
            const word = match[0]!;
            const targetEdge =
              word.length <= 3 ? shortWordsEdge : longWordsEdge;
            events.push(Message.create(targetEdge, { kind: "word", word }));
          }
        }
        return events;
      },
      {
        state: undefined,
        trigger: TriggerRule.when(linesEdge),
      },
    ),
  );

  const unifiedCounterId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
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
      },
      {
        state: undefined,
        trigger: TriggerRule.anyOf(
          TriggerEntry.on(shortWordsEdge),
          TriggerEntry.on(longWordsEdge),
        ),
      },
    ),
  );

  const charSumId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const chars = (view.messages.get(charCountEdge.id) ?? []).filter(
          (m): m is CharCount => m.kind === "chars",
        );
        const total = chars.reduce((acc, c) => acc + c.length, 0);
        return [Message.create(charSumEdge, { kind: "chars", length: total })];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(charCountEdge),
      },
    ),
  );

  const charSumSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of view.messages.get(charSumEdge.id) ?? []) {
          if (m.kind === "chars") totalChars.push(m.length);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(charSumEdge),
      },
    ),
  );

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
