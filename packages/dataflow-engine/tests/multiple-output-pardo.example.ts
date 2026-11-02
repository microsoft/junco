import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import { context, parallel } from "junco-scheduler";
import { type Static, Type } from "typebox";
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

const SourceLineSchema = Type.Object({
  kind: Type.Literal("line"),
  text: Type.String(),
});
const CharCountSchema = Type.Object({
  kind: Type.Literal("chars"),
  length: Type.Number(),
});
const WordMsgSchema = Type.Object({
  kind: Type.Literal("word"),
  word: Type.String(),
});
const PairSchema = Type.Object({
  kind: Type.Literal("pair"),
  word: Type.String(),
  count: Type.Number(),
});
const MsgSchema = Type.Union([
  SourceLineSchema,
  CharCountSchema,
  WordMsgSchema,
  PairSchema,
]);
type SourceLine = Static<typeof SourceLineSchema>;
type CharCount = Static<typeof CharCountSchema>;
type WordMsg = Static<typeof WordMsgSchema>;
type Msg = typeof MsgSchema;

test("cookbook: multiple output pardo split lines to words", async () => {
  const linesEdge = Edge.message<Msg, string>("lines", MsgSchema);
  const charCountEdge = Edge.message<Msg, string>("charCount", MsgSchema);
  const shortWordsEdge = Edge.message<Msg, string>("shortWords", MsgSchema);
  const longWordsEdge = Edge.message<Msg, string>("longWords", MsgSchema);
  const charSumEdge = Edge.message<Msg, string>("charSum", MsgSchema);
  const shortCountsEdge = Edge.message<Msg, string>("shortCounts", MsgSchema);
  const longCountsEdge = Edge.message<Msg, string>("longCounts", MsgSchema);

  const inputLines = ["A whole new world", "A new fantastic point of view"];
  const shortCounts: [string, number][] = [];
  const longCounts: [string, number][] = [];
  const totalChars: number[] = [];
  const splitterFirings: number[] = [];

  const tracer = ExampleTracer.create("cookbook/multiple-output-pardo");
  const graph = new DataflowGraph<void, Msg, string, never>(
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
        const lines = from(view, linesEdge).filter(
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
        splitterFirings.push(events.length);
        return events;
      },
      {
        state: undefined,
        trigger: TriggerRule.when(linesEdge),
      },
    ),
  );

  const charSumId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const chars = from(view, charCountEdge).filter(
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

  const attachCountWords = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
  ) => {
    const id = graph.addNode(
      new StepNode<void, Msg, string>(
        (_state, view) => {
          const groups = pipe(
            from(view, inputEdge),
            RA.filter((m): m is WordMsg => m.kind === "word"),
            RNEA.groupBy((m) => m.word),
          );
          const events: Message<Msg>[] = [];
          for (const word of Object.keys(groups).sort(S.Ord.compare)) {
            events.push(
              Message.create(outputEdge, {
                kind: "pair",
                word,
                count: groups[word]!.length,
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

  const shortCountId = attachCountWords(shortWordsEdge, shortCountsEdge);
  const longCountId = attachCountWords(longWordsEdge, longCountsEdge);

  const shortSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, shortCountsEdge)) {
          if (m.kind === "pair") shortCounts.push([m.word, m.count]);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(shortCountsEdge),
      },
    ),
  );

  const longSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, longCountsEdge)) {
          if (m.kind === "pair") longCounts.push([m.word, m.count]);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(longCountsEdge),
      },
    ),
  );

  const charSumSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, charSumEdge)) {
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
  graph.addEdge(splitterId, charSumId, charCountEdge);
  graph.addEdge(splitterId, shortCountId, shortWordsEdge);
  graph.addEdge(splitterId, longCountId, longWordsEdge);
  graph.addEdge(charSumId, charSumSinkId, charSumEdge);
  graph.addEdge(shortCountId, shortSinkId, shortCountsEdge);
  graph.addEdge(longCountId, longSinkId, longCountsEdge);

  const execution = context({ scheduler: parallel(), graph });
  const completed = await execution.run();

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
});
