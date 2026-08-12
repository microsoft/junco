import { test } from "bun:test";
import assert from "node:assert/strict";
import { pipe } from "fp-ts/lib/function.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import {
  DataflowGraph,
  ReadyScheduler,
  UNBOUNDED,
  Width,
  allOf,
  always,
  anyOf,
  emitOnce,
  from,
  messageEdge,
  msg,
  on,
  stepNode,
  when,
} from "../src/index.ts";
import type { Edge, Message } from "../src/index.ts";

type KV = { readonly kind: "kv"; readonly source: "email" | "phone" | "snailmail"; readonly name: string; readonly value: string };
type Grouped = {
  readonly kind: "grouped";
  readonly name: string;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly snailmails: readonly string[];
};
type Count = { readonly kind: "count"; readonly label: string; readonly value: number };
type Msg = KV | Grouped | Count;

test("cookbook: mergecontacts co-group-by-key 3-way", async () => {
  const emailEdge = messageEdge<Msg, string>("email");
  const phoneEdge = messageEdge<Msg, string>("phone");
  const snailmailEdge = messageEdge<Msg, string>("snailmail");
  const groupedForTsvEdge = messageEdge<Msg, string>("groupedForTsv");
  const groupedForLudditesEdge = messageEdge<Msg, string>("groupedForLuddites");
  const groupedForWritersEdge = messageEdge<Msg, string>("groupedForWriters");
  const groupedForNomadsEdge = messageEdge<Msg, string>("groupedForNomads");
  const ludditesCountEdge = messageEdge<Msg, string>("ludditesCount");
  const writersCountEdge = messageEdge<Msg, string>("writersCount");
  const nomadsCountEdge = messageEdge<Msg, string>("nomadsCount");

  const emailInputs: [string, string][] = [
    ["Nathan Nomad", "nathan@example.com"],
    ["Robert B", "robert@example.com"],
    ["Tom S", "tom@example.com"],
    ["Wally Writer", "wally@example.com"],
  ];
  const phoneInputs: [string, string][] = [
    ["Larry Luddite", "724-228-3529"],
    ["Nathan Nomad", "412-466-8968"],
    ["Robert B", "814-865-8799"],
    ["Tom S", "570-368-3420"],
  ];
  const snailmailInputs: [string, string][] = [
    ["Larry Luddite", "1949 Westcott St"],
    ["Robert B", "601 N 34th St"],
    ["Tom S", "6425 Penn Ave"],
    ["Wally Writer", "101 Ridge Rd"],
  ];

  const tsvRows: Grouped[] = [];
  const stats: Count[] = [];

  const graph = new DataflowGraph<void, Msg, string, never>(
    new ReadyScheduler(),
    Width(1),
    UNBOUNDED,
  );

  const makeKVSource = (
    edge: Edge<Msg, string>,
    source: "email" | "phone" | "snailmail",
    rows: readonly [string, string][],
    label: string,
  ) => {
    const id = graph.addNode({
      state: undefined,
      trigger: always(),
      step: emitOnce<void, Msg, string>(
        () => rows.map(([name, value]) => msg(edge, { kind: "kv", source, name, value })),
        `${label} done`,
      ),
    });
    return id;
  };

  const emailSourceId = makeKVSource(emailEdge, "email", emailInputs, "email");
  const phoneSourceId = makeKVSource(phoneEdge, "phone", phoneInputs, "phone");
  const snailmailSourceId = makeKVSource(snailmailEdge, "snailmail", snailmailInputs, "snailmail");

  const groupByNameId = graph.addNode({
    state: undefined,
    trigger: allOf(on(emailEdge), on(phoneEdge), on(snailmailEdge)),
    step: stepNode<void, Msg, string>((_state, view) => {
      const kvs = <Src extends KV["source"]>(edge: Edge<Msg, string>, src: Src): readonly KV[] =>
        from(view, edge).filter((m): m is KV => m.kind === "kv" && m.source === src);
      const allKvs: readonly KV[] = [
        ...kvs(emailEdge, "email"),
        ...kvs(phoneEdge, "phone"),
        ...kvs(snailmailEdge, "snailmail"),
      ];
      return pipe(
        allKvs,
        RNEA.groupBy((kv) => kv.name),
        RR.collect(S.Ord)((name, group): readonly Message<Msg>[] => {
          const bySource = (src: KV["source"]): readonly string[] =>
            pipe(
              group,
              RA.filter((kv) => kv.source === src),
              RA.map((kv) => kv.value),
            );
          const grouped: Grouped = {
            kind: "grouped",
            name,
            emails: bySource("email"),
            phones: bySource("phone"),
            snailmails: bySource("snailmail"),
          };
          return [
            msg(groupedForTsvEdge, grouped),
            msg(groupedForLudditesEdge, grouped),
            msg(groupedForWritersEdge, grouped),
            msg(groupedForNomadsEdge, grouped),
          ];
        }),
        RA.flatten,
      );
    }),
  });

  const tsvSinkId = graph.addNode({
    state: undefined,
    trigger: when(groupedForTsvEdge),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const m of from(view, groupedForTsvEdge)) {
        if (m.kind === "grouped") tsvRows.push(m);
      }
      return [];
    }),
  });

  const makeFilterCount = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
    label: string,
    predicate: (g: Grouped) => boolean,
  ) => {
    const id = graph.addNode({
      state: undefined,
      trigger: when(inputEdge),
      step: stepNode<void, Msg, string>((_state, view) => {
        const groups = from(view, inputEdge).filter((m): m is Grouped => m.kind === "grouped");
        const count = groups.filter(predicate).length;
        return [msg(outputEdge, { kind: "count", label, value: count })];
      }),
    });
    return id;
  };

  const ludditesFilterCountId = makeFilterCount(
    groupedForLudditesEdge, ludditesCountEdge, "luddites",
    (g) => g.emails.length === 0,
  );
  const writersFilterCountId = makeFilterCount(
    groupedForWritersEdge, writersCountEdge, "writers",
    (g) => g.phones.length === 0,
  );
  const nomadsFilterCountId = makeFilterCount(
    groupedForNomadsEdge, nomadsCountEdge, "nomads",
    (g) => g.snailmails.length === 0,
  );

  const statsSinkId = graph.addNode({
    state: undefined,
    trigger: anyOf(on(ludditesCountEdge), on(writersCountEdge), on(nomadsCountEdge)),
    step: stepNode<void, Msg, string>((_state, view) => {
      for (const edge of [ludditesCountEdge, writersCountEdge, nomadsCountEdge]) {
        for (const m of from(view, edge)) {
          if (m.kind === "count") stats.push(m);
        }
      }
      return [];
    }),
  });

  graph.addEdge(emailSourceId, groupByNameId, emailEdge);
  graph.addEdge(phoneSourceId, groupByNameId, phoneEdge);
  graph.addEdge(snailmailSourceId, groupByNameId, snailmailEdge);
  graph.addEdge(groupByNameId, tsvSinkId, groupedForTsvEdge);
  graph.addEdge(groupByNameId, ludditesFilterCountId, groupedForLudditesEdge);
  graph.addEdge(groupByNameId, writersFilterCountId, groupedForWritersEdge);
  graph.addEdge(groupByNameId, nomadsFilterCountId, groupedForNomadsEdge);
  graph.addEdge(ludditesFilterCountId, statsSinkId, ludditesCountEdge);
  graph.addEdge(writersFilterCountId, statsSinkId, writersCountEdge);
  graph.addEdge(nomadsFilterCountId, statsSinkId, nomadsCountEdge);

  const completed = await graph.run();

  assert.equal(tsvRows.length, 5);

  const larry = tsvRows.find((r) => r.name === "Larry Luddite");
  assert(larry !== undefined);
  assert.equal(larry.emails.length, 0);
  assert.equal(larry.phones.length, 1);
  assert.equal(larry.snailmails.length, 1);

  const nathan = tsvRows.find((r) => r.name === "Nathan Nomad");
  assert(nathan !== undefined);
  assert.equal(nathan.emails.length, 1);
  assert.equal(nathan.phones.length, 1);
  assert.equal(nathan.snailmails.length, 0);

  const wally = tsvRows.find((r) => r.name === "Wally Writer");
  assert(wally !== undefined);
  assert.equal(wally.emails.length, 1);
  assert.equal(wally.phones.length, 0);
  assert.equal(wally.snailmails.length, 1);

  assert.deepEqual(
    stats.map((c) => [c.label, c.value]).sort(),
    [["luddites", 1], ["nomads", 1], ["writers", 1]].sort(),
  );

  assert.equal(completed.get(emailSourceId), "email done");
  assert.equal(completed.get(phoneSourceId), "phone done");
  assert.equal(completed.get(snailmailSourceId), "snailmail done");
});
