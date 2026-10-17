import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as S from "fp-ts/lib/string.js";
import { context, parallel } from "junco-scheduler";
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
  const linesEdge = Edge.message<Msg, string>("lines");
  const pairsEdge = Edge.message<Msg, string>("pairs");
  const totalsEdge = Edge.message<Msg, string>("totals");

  const inputLines = ["Alice,10", "Bob,5", "Alice,20", "Bob,15", "Alice,3"];
  const results: [string, number][] = [];

  const tracer = ExampleTracer.create("cookbook/group-with-coder");
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

  const parseId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const lines = from(view, linesEdge).filter(
          (m): m is Line => m.kind === "line",
        );
        return lines.map((l) => {
          const [name, scoreText] = l.text.split(",", 2);
          return Message.create(pairsEdge, {
            kind: "pair",
            player: new Player(name ?? ""),
            score: Number(scoreText),
          });
        });
      },
      {
        state: undefined,
        trigger: TriggerRule.when(linesEdge),
      },
    ),
  );

  const sumByPlayerId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const groups = pipe(
          from(view, pairsEdge),
          RA.filter((m): m is Pair => m.kind === "pair"),
          RNEA.groupBy((p) => p.player.name),
        );
        const events: Message<Msg>[] = [];
        for (const playerName of Object.keys(groups).sort(S.Ord.compare)) {
          const group = groups[playerName]!;
          events.push(
            Message.create(totalsEdge, {
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
      },
      {
        state: undefined,
        trigger: TriggerRule.when(pairsEdge),
      },
    ),
  );

  const sinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, totalsEdge)) {
          if (m.kind === "total") results.push([m.playerName, m.total]);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(totalsEdge),
      },
    ),
  );

  graph.addEdge(sourceId, parseId, linesEdge);
  graph.addEdge(parseId, sumByPlayerId, pairsEdge);
  graph.addEdge(sumByPlayerId, sinkId, totalsEdge);

  try {
    const execution = context({ scheduler: parallel(), graph });
    const completed = await execution.run();

    assert.deepEqual(results, [
      ["Alice", 33],
      ["Bob", 20],
    ]);
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
