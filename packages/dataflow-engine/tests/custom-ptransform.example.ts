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
  Message,
  StepNode,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";

const WordMsgSchema = Type.Object({
  kind: Type.Literal("word"),
  word: Type.String(),
});
const CountMsgSchema = Type.Object({
  kind: Type.Literal("count"),
  word: Type.String(),
  count: Type.Number(),
});
const MsgSchema = Type.Union([WordMsgSchema, CountMsgSchema]);
type WordMsg = Static<typeof WordMsgSchema>;
type Msg = typeof MsgSchema;

test("cookbook: custom-ptransform reusable count helper", async () => {
  const wordsForCount1Edge = Edge.message<Msg, string>(
    "wordsForCount1",
    MsgSchema,
  );
  const wordsForCount2Edge = Edge.message<Msg, string>(
    "wordsForCount2",
    MsgSchema,
  );
  const count1OutEdge = Edge.message<Msg, string>("count1Out", MsgSchema);
  const count2OutEdge = Edge.message<Msg, string>("count2Out", MsgSchema);

  const inputWords = ["apple", "banana", "apple", "cherry", "apple", "banana"];
  const counts1: [string, number][] = [];
  const counts2: [string, number][] = [];

  const tracer = ExampleTracer.create("cookbook/custom-ptransform");
  const graph = new DataflowGraph<void, Msg, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const sourceId = graph.addNode(
    new EmitOnce<void, Msg, string>(
      () => {
        const events: Message<Msg>[] = [];
        for (const word of inputWords) {
          const payload: WordMsg = { kind: "word", word };
          events.push(
            Message.create(wordsForCount1Edge, payload),
            Message.create(wordsForCount2Edge, payload),
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

  const attachCount = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
    factor: number,
  ) => {
    const id = graph.addNode(
      new StepNode<void, Msg, string>(
        (_state, view) => {
          const groups = pipe(
            view.messages.get(inputEdge.id) ?? [],
            RA.filter((m): m is WordMsg => m.kind === "word"),
            RNEA.groupBy((m) => m.word),
          );
          const events: Message<Msg>[] = [];
          for (const word of Object.keys(groups).sort(S.Ord.compare)) {
            events.push(
              Message.create(outputEdge, {
                kind: "count",
                word,
                count: groups[word]!.length * factor,
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

  const count1Id = attachCount(wordsForCount1Edge, count1OutEdge, 1);
  const count2Id = attachCount(wordsForCount2Edge, count2OutEdge, 2);

  const sink1Id = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of view.messages.get(count1OutEdge.id) ?? []) {
          if (m.kind === "count") counts1.push([m.word, m.count]);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(count1OutEdge),
      },
    ),
  );

  const sink2Id = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of view.messages.get(count2OutEdge.id) ?? []) {
          if (m.kind === "count") counts2.push([m.word, m.count]);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(count2OutEdge),
      },
    ),
  );

  graph.addEdge(sourceId, count1Id, wordsForCount1Edge);
  graph.addEdge(sourceId, count2Id, wordsForCount2Edge);
  graph.addEdge(count1Id, sink1Id, count1OutEdge);
  graph.addEdge(count2Id, sink2Id, count2OutEdge);

  const execution = context({ scheduler: parallel(), graph });
  const completed = await execution.run();

  assert.deepEqual(counts1, [
    ["apple", 3],
    ["banana", 2],
    ["cherry", 1],
  ]);
  assert.deepEqual(counts2, [
    ["apple", 6],
    ["banana", 4],
    ["cherry", 2],
  ]);
  assert.notEqual(count1Id, count2Id);
  assert.equal(completed.get(sourceId), "source done");
});
