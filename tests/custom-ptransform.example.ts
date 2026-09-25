import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import type { Edge, Message } from "../src/index.ts";
import {
  always,
  DataflowGraph,
  emitOnce,
  messageEdge,
  msg,
  ReadyScheduler,
  stepNode,
  UNBOUNDED,
  Width,
  when,
} from "../src/index.ts";

type WordMsg = { readonly kind: "word"; readonly word: string };
type CountMsg = {
  readonly kind: "count";
  readonly word: string;
  readonly count: number;
};
type Msg = WordMsg | CountMsg;

test("cookbook: custom-ptransform reusable count helper", async () => {
  const wordsForCount1Edge = messageEdge<Msg, string>("wordsForCount1");
  const wordsForCount2Edge = messageEdge<Msg, string>("wordsForCount2");
  const count1OutEdge = messageEdge<Msg, string>("count1Out");
  const count2OutEdge = messageEdge<Msg, string>("count2Out");

  const inputWords = ["apple", "banana", "apple", "cherry", "apple", "banana"];
  const counts1: [string, number][] = [];
  const counts2: [string, number][] = [];

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
      for (const word of inputWords) {
        const payload: WordMsg = { kind: "word", word };
        events.push(
          msg(wordsForCount1Edge, payload),
          msg(wordsForCount2Edge, payload),
        );
      }
      return events;
    }, "source done"),
  });

  const attachCount = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
    factor: number,
  ) => {
    const id = graph.addNode({
      state: undefined,
      trigger: when(inputEdge),
      step: stepNode<void, Msg, string>((_state, view) => {
        const groups = pipe(
          view.messages.get(inputEdge.id) ?? [],
          RA.filter((m): m is WordMsg => m.kind === "word"),
          RNEA.groupBy((m) => m.word),
        );
        const events: Message<Msg>[] = [];
        for (const word of Object.keys(groups).sort(S.Ord.compare)) {
          events.push(
            msg(outputEdge, {
              kind: "count",
              word,
              count: groups[word]!.length * factor,
            }),
          );
        }
        return events;
      }),
    });
    return id;
  };

  const count1Id = attachCount(wordsForCount1Edge, count1OutEdge, 1);
  const count2Id = attachCount(wordsForCount2Edge, count2OutEdge, 2);

  const sink1Id = graph.addNode({
    state: undefined,
    trigger: when(count1OutEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of view.messages.get(count1OutEdge.id) ?? []) {
        if (m.kind === "count") counts1.push([m.word, m.count]);
      }
      return [];
    }),
  });

  const sink2Id = graph.addNode({
    state: undefined,
    trigger: when(count2OutEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of view.messages.get(count2OutEdge.id) ?? []) {
        if (m.kind === "count") counts2.push([m.word, m.count]);
      }
      return [];
    }),
  });

  graph.addEdge(sourceId, count1Id, wordsForCount1Edge);
  graph.addEdge(sourceId, count2Id, wordsForCount2Edge);
  graph.addEdge(count1Id, sink1Id, count1OutEdge);
  graph.addEdge(count2Id, sink2Id, count2OutEdge);

  const completed = await graph.run();

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
