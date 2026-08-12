import { test } from "bun:test";
import assert from "node:assert/strict";
import { DataflowGraph, ReadyScheduler, UNBOUNDED, Width, allOf, always, emitOnce, from, messageEdge, msg, on, stepNode, when } from "../src/index.ts";
import type { Edge } from "../src/index.ts";

type StringMsg = { readonly kind: "str"; readonly value: string };
type GroupMsg = { readonly kind: "group"; readonly id: string; readonly corpus: string; readonly word: string };
type Msg = StringMsg | GroupMsg;

test("cookbook: bigquery side inputs attach corpus and word", async () => {
  const groupIdsEdge = messageEdge<Msg, string>("groupIds");
  const corpusEdge = messageEdge<Msg, string>("corpus");
  const wordEdge = messageEdge<Msg, string>("word");
  const ignoreCorpusEdge = messageEdge<Msg, string>("ignoreCorpus");
  const ignoreWordEdge = messageEdge<Msg, string>("ignoreWord");
  const resultsEdge = messageEdge<Msg, string>("results");

  const groupIds = ["A", "B", "C"];
  const corpus = ["corpus1", "corpus2", "corpus3"];
  const words = ["word1", "word2", "word3"];
  const ignoreCorpus = "corpus1";
  const ignoreWord = "word1";

  const groups: GroupMsg[] = [];
  const graph = new DataflowGraph<void, Msg, string, never>(
    new ReadyScheduler(),
    Width(1),
    UNBOUNDED,
  );

  const makeStringSource = (edge: Edge<Msg, string>, values: readonly string[], label: string) =>
    graph.addNode({
      state: undefined,
      trigger: always(),
      step: emitOnce<void, Msg, string>(
        () => values.map((value) => msg(edge, { kind: "str", value })),
        `${label} done`,
      ),
    });

  const groupIdsSourceId = makeStringSource(groupIdsEdge, groupIds, "groupIds");
  const corpusSourceId = makeStringSource(corpusEdge, corpus, "corpus");
  const wordSourceId = makeStringSource(wordEdge, words, "word");
  const ignoreCorpusSourceId = makeStringSource(ignoreCorpusEdge, [ignoreCorpus], "ignoreCorpus");
  const ignoreWordSourceId = makeStringSource(ignoreWordEdge, [ignoreWord], "ignoreWord");

  const attachId = graph.addNode({
    state: undefined,
    trigger: allOf(on(groupIdsEdge), on(corpusEdge), on(wordEdge), on(ignoreCorpusEdge), on(ignoreWordEdge)),
    step: stepNode<void, Msg, string>((_state, view) => {
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
        msg(resultsEdge, {
          kind: "group",
          id,
          corpus: firstCorpus,
          word: firstWord,
        }));
    }),
  });

  const sinkId = graph.addNode({
    state: undefined,
    trigger: when(resultsEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, resultsEdge)) {
        if (m.kind === "group") groups.push(m);
      }
      return [];
    }),
  });

  graph.addEdge(groupIdsSourceId, attachId, groupIdsEdge);
  graph.addEdge(corpusSourceId, attachId, corpusEdge);
  graph.addEdge(wordSourceId, attachId, wordEdge);
  graph.addEdge(ignoreCorpusSourceId, attachId, ignoreCorpusEdge);
  graph.addEdge(ignoreWordSourceId, attachId, ignoreWordEdge);
  graph.addEdge(attachId, sinkId, resultsEdge);

  const completed = await graph.run();

  assert.deepEqual(
    groups.map((g) => [g.id, g.corpus, g.word]),
    [["A", "corpus2", "word2"], ["B", "corpus2", "word2"], ["C", "corpus2", "word2"]],
  );
  assert.equal(completed.get(groupIdsSourceId), "groupIds done");
  assert.equal(completed.get(corpusSourceId), "corpus done");
  assert.equal(completed.get(wordSourceId), "word done");
});
