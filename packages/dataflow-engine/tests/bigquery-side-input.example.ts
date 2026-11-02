import { test } from "bun:test";
import assert from "node:assert/strict";
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
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";

const StringMsgSchema = Type.Object({
  kind: Type.Literal("str"),
  value: Type.String(),
});
const GroupMsgSchema = Type.Object({
  kind: Type.Literal("group"),
  id: Type.String(),
  corpus: Type.String(),
  word: Type.String(),
});
const MsgSchema = Type.Union([StringMsgSchema, GroupMsgSchema]);
type StringMsg = Static<typeof StringMsgSchema>;
type GroupMsg = Static<typeof GroupMsgSchema>;
type Msg = typeof MsgSchema;

test("cookbook: bigquery side inputs attach corpus and word", async () => {
  const groupIdsEdge = Edge.message<Msg, string>("groupIds", MsgSchema);
  const corpusEdge = Edge.message<Msg, string>("corpus", MsgSchema);
  const wordEdge = Edge.message<Msg, string>("word", MsgSchema);
  const ignoreCorpusEdge = Edge.message<Msg, string>("ignoreCorpus", MsgSchema);
  const ignoreWordEdge = Edge.message<Msg, string>("ignoreWord", MsgSchema);
  const resultsEdge = Edge.message<Msg, string>("results", MsgSchema);

  const groupIds = ["A", "B", "C"];
  const corpus = ["corpus1", "corpus2", "corpus3"];
  const words = ["word1", "word2", "word3"];
  const ignoreCorpus = "corpus1";
  const ignoreWord = "word1";

  const groups: GroupMsg[] = [];
  const tracer = ExampleTracer.create("cookbook/bigquery-side-input");
  const graph = new DataflowGraph<void, Msg, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const makeStringSource = (
    edge: Edge<Msg, string>,
    values: readonly string[],
    label: string,
  ) =>
    graph.addNode(
      new EmitOnce<void, Msg, string>(
        () =>
          values.map((value) => Message.create(edge, { kind: "str", value })),
        `${label} done`,
        {
          state: undefined,
          trigger: TriggerRule.always(),
        },
      ),
    );

  const groupIdsSourceId = makeStringSource(groupIdsEdge, groupIds, "groupIds");
  const corpusSourceId = makeStringSource(corpusEdge, corpus, "corpus");
  const wordSourceId = makeStringSource(wordEdge, words, "word");
  const ignoreCorpusSourceId = makeStringSource(
    ignoreCorpusEdge,
    [ignoreCorpus],
    "ignoreCorpus",
  );
  const ignoreWordSourceId = makeStringSource(
    ignoreWordEdge,
    [ignoreWord],
    "ignoreWord",
  );

  const attachId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const strings = (edge: Edge<Msg, string>): string[] =>
          from(view, edge)
            .filter((m): m is StringMsg => m.kind === "str")
            .map((m) => m.value);
        const ids = strings(groupIdsEdge);
        const corpusBatch = strings(corpusEdge);
        const wordBatch = strings(wordEdge);
        const ignoreCorpusBatch = strings(ignoreCorpusEdge);
        const ignoreWordBatch = strings(ignoreWordEdge);
        const ignoreCorpusValue = ignoreCorpusBatch[0];
        const ignoreWordValue = ignoreWordBatch[0];
        const firstCorpus = corpusBatch.find((c) => c !== ignoreCorpusValue);
        const firstWord = wordBatch.find((w) => w !== ignoreWordValue);
        if (firstCorpus === undefined || firstWord === undefined) return [];
        return ids.map((id) =>
          Message.create(resultsEdge, {
            kind: "group",
            id,
            corpus: firstCorpus,
            word: firstWord,
          }),
        );
      },
      {
        state: undefined,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(groupIdsEdge),
          TriggerEntry.on(corpusEdge),
          TriggerEntry.on(wordEdge),
          TriggerEntry.on(ignoreCorpusEdge),
          TriggerEntry.on(ignoreWordEdge),
        ),
      },
    ),
  );

  const sinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, resultsEdge)) {
          if (m.kind === "group") groups.push(m);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(resultsEdge),
      },
    ),
  );

  graph.addEdge(groupIdsSourceId, attachId, groupIdsEdge);
  graph.addEdge(corpusSourceId, attachId, corpusEdge);
  graph.addEdge(wordSourceId, attachId, wordEdge);
  graph.addEdge(ignoreCorpusSourceId, attachId, ignoreCorpusEdge);
  graph.addEdge(ignoreWordSourceId, attachId, ignoreWordEdge);
  graph.addEdge(attachId, sinkId, resultsEdge);

  const execution = context({ scheduler: parallel(), graph });
  const completed = await execution.run();

  assert.deepEqual(
    groups.map((g) => [g.id, g.corpus, g.word]),
    [
      ["A", "corpus2", "word2"],
      ["B", "corpus2", "word2"],
      ["C", "corpus2", "word2"],
    ],
  );
  assert.equal(completed.get(groupIdsSourceId), "groupIds done");
  assert.equal(completed.get(corpusSourceId), "corpus done");
  assert.equal(completed.get(wordSourceId), "word done");
});
