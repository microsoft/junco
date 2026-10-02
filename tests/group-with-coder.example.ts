import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import { createParallelScheduler } from "junco-scheduler";
import { createExampleTracer } from "../examples/tracing.ts";
import type { Message } from "../src/index.ts";
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

class Player {
  constructor(readonly name: string) {}
}

type Line = { readonly kind: "line"; readonly text: string };
type Pair = {
  readonly kind: "pair";
  readonly player: Player;
  readonly score: number;
};
type Total = {
  readonly kind: "total";
  readonly playerName: string;
  readonly total: number;
};
type Msg = Line | Pair | Total;

test("cookbook: group with coder — parse and sum by player name", async () => {
  const linesEdge = messageEdge<Msg, string>("lines");
  const pairsEdge = messageEdge<Msg, string>("pairs");
  const totalsEdge = messageEdge<Msg, string>("totals");

  const inputLines = ["Alice,10", "Bob,5", "Alice,20", "Bob,15", "Alice,3"];
  const results: [string, number][] = [];

  const tracer = createExampleTracer("cookbook/group-with-coder");
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

  const parseId = graph.addNode({
    state: undefined,
    trigger: when(linesEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const lines = from(view, linesEdge).filter(
        (m): m is Line => m.kind === "line",
      );
      return lines.map((l) => {
        const [name, scoreText] = l.text.split(",", 2);
        return msg(pairsEdge, {
          kind: "pair",
          player: new Player(name ?? ""),
          score: Number(scoreText),
        });
      });
    }),
  });

  const sumByPlayerId = graph.addNode({
    state: undefined,
    trigger: when(pairsEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      const groups = pipe(
        from(view, pairsEdge),
        RA.filter((m): m is Pair => m.kind === "pair"),
        RNEA.groupBy((p) => p.player.name),
      );
      const events: Message<Msg>[] = [];
      for (const playerName of Object.keys(groups).sort(S.Ord.compare)) {
        const group = groups[playerName]!;
        events.push(
          msg(totalsEdge, {
            kind: "total",
            playerName,
            total: pipe(
              group,
              RA.reduce(0, (acc, p) => acc + p.score),
            ),
          }),
        );
      }
      return events;
    }),
  });

  const sinkId = graph.addNode({
    state: undefined,
    trigger: when(totalsEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, totalsEdge)) {
        if (m.kind === "total") results.push([m.playerName, m.total]);
      }
      return [];
    }),
  });

  graph.addEdge(sourceId, parseId, linesEdge);
  graph.addEdge(parseId, sumByPlayerId, pairsEdge);
  graph.addEdge(sumByPlayerId, sinkId, totalsEdge);

  try {
    const completed = await graph.run();

    assert.deepEqual(results, [
      ["Alice", 33],
      ["Bob", 20],
    ]);
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
