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
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";

const KVSchema = Type.Object({
  kind: Type.Literal("kv"),
  source: Type.Union([
    Type.Literal("email"),
    Type.Literal("phone"),
    Type.Literal("snailmail"),
  ]),
  name: Type.String(),
  value: Type.String(),
});
const GroupedSchema = Type.Object({
  kind: Type.Literal("grouped"),
  name: Type.String(),
  emails: Type.Array(Type.String()),
  phones: Type.Array(Type.String()),
  snailmails: Type.Array(Type.String()),
});
const CountSchema = Type.Object({
  kind: Type.Literal("count"),
  label: Type.String(),
  value: Type.Number(),
});
const MsgSchema = Type.Union([KVSchema, GroupedSchema, CountSchema]);
type KV = Static<typeof KVSchema>;
type Grouped = Static<typeof GroupedSchema>;
type Count = Static<typeof CountSchema>;
type Msg = typeof MsgSchema;

test("cookbook: mergecontacts co-group-by-key 3-way", async () => {
  const emailEdge = Edge.message<Msg, string>("email", MsgSchema);
  const phoneEdge = Edge.message<Msg, string>("phone", MsgSchema);
  const snailmailEdge = Edge.message<Msg, string>("snailmail", MsgSchema);
  const groupedForTsvEdge = Edge.message<Msg, string>(
    "groupedForTsv",
    MsgSchema,
  );
  const groupedForLudditesEdge = Edge.message<Msg, string>(
    "groupedForLuddites",
    MsgSchema,
  );
  const groupedForWritersEdge = Edge.message<Msg, string>(
    "groupedForWriters",
    MsgSchema,
  );
  const groupedForNomadsEdge = Edge.message<Msg, string>(
    "groupedForNomads",
    MsgSchema,
  );
  const ludditesCountEdge = Edge.message<Msg, string>(
    "ludditesCount",
    MsgSchema,
  );
  const writersCountEdge = Edge.message<Msg, string>("writersCount", MsgSchema);
  const nomadsCountEdge = Edge.message<Msg, string>("nomadsCount", MsgSchema);

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

  const tracer = ExampleTracer.create("cookbook/mergecontacts");
  const graph = new DataflowGraph<void, Msg, string, never>(
    Width.create(1),
    UNBOUNDED,
    tracer,
  );

  const makeKVSource = (
    edge: Edge<Msg, string>,
    source: "email" | "phone" | "snailmail",
    rows: readonly [string, string][],
    label: string,
  ) => {
    const id = graph.addNode(
      new EmitOnce<void, Msg, string>(
        () =>
          rows.map(([name, value]) =>
            Message.create(edge, { kind: "kv", source, name, value }),
          ),
        `${label} done`,
        {
          state: undefined,
          trigger: TriggerRule.always(),
        },
      ),
    );
    return id;
  };

  const emailSourceId = makeKVSource(emailEdge, "email", emailInputs, "email");
  const phoneSourceId = makeKVSource(phoneEdge, "phone", phoneInputs, "phone");
  const snailmailSourceId = makeKVSource(
    snailmailEdge,
    "snailmail",
    snailmailInputs,
    "snailmail",
  );

  const groupByNameId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        const kvs = <Src extends KV["source"]>(
          edge: Edge<Msg, string>,
          src: Src,
        ): readonly KV[] =>
          from(view, edge).filter(
            (m): m is KV => m.kind === "kv" && m.source === src,
          );
        const allKvs: readonly KV[] = [
          ...kvs(emailEdge, "email"),
          ...kvs(phoneEdge, "phone"),
          ...kvs(snailmailEdge, "snailmail"),
        ];
        const groups = pipe(
          allKvs,
          RNEA.groupBy((kv) => kv.name),
        );
        const events: Message<Msg>[] = [];
        for (const name of Object.keys(groups).sort(S.Ord.compare)) {
          const group = groups[name]!;
          const bySource = (src: KV["source"]): string[] => [
            ...pipe(
              group,
              RA.filter((kv) => kv.source === src),
              RA.map((kv) => kv.value),
            ),
          ];
          const grouped: Grouped = {
            kind: "grouped",
            name,
            emails: bySource("email"),
            phones: bySource("phone"),
            snailmails: bySource("snailmail"),
          };
          events.push(
            Message.create(groupedForTsvEdge, grouped),
            Message.create(groupedForLudditesEdge, grouped),
            Message.create(groupedForWritersEdge, grouped),
            Message.create(groupedForNomadsEdge, grouped),
          );
        }
        return events;
      },
      {
        state: undefined,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(emailEdge),
          TriggerEntry.on(phoneEdge),
          TriggerEntry.on(snailmailEdge),
        ),
      },
    ),
  );

  const tsvSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const m of from(view, groupedForTsvEdge)) {
          if (m.kind === "grouped") tsvRows.push(m);
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.when(groupedForTsvEdge),
      },
    ),
  );

  const makeFilterCount = (
    inputEdge: Edge<Msg, string>,
    outputEdge: Edge<Msg, string>,
    label: string,
    predicate: (g: Grouped) => boolean,
  ) => {
    const id = graph.addNode(
      new StepNode<void, Msg, string>(
        (_state, view) => {
          const groups = from(view, inputEdge).filter(
            (m): m is Grouped => m.kind === "grouped",
          );
          const count = groups.filter(predicate).length;
          return [
            Message.create(outputEdge, { kind: "count", label, value: count }),
          ];
        },
        {
          state: undefined,
          trigger: TriggerRule.when(inputEdge),
        },
      ),
    );
    return id;
  };

  const ludditesFilterCountId = makeFilterCount(
    groupedForLudditesEdge,
    ludditesCountEdge,
    "luddites",
    (g) => g.emails.length === 0,
  );
  const writersFilterCountId = makeFilterCount(
    groupedForWritersEdge,
    writersCountEdge,
    "writers",
    (g) => g.phones.length === 0,
  );
  const nomadsFilterCountId = makeFilterCount(
    groupedForNomadsEdge,
    nomadsCountEdge,
    "nomads",
    (g) => g.snailmails.length === 0,
  );

  const statsSinkId = graph.addNode(
    new StepNode<void, Msg, string>(
      (_state, view) => {
        for (const edge of [
          ludditesCountEdge,
          writersCountEdge,
          nomadsCountEdge,
        ]) {
          for (const m of from(view, edge)) {
            if (m.kind === "count") stats.push(m);
          }
        }
        return [];
      },
      {
        state: undefined,
        trigger: TriggerRule.anyOf(
          TriggerEntry.on(ludditesCountEdge),
          TriggerEntry.on(writersCountEdge),
          TriggerEntry.on(nomadsCountEdge),
        ),
      },
    ),
  );

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

  try {
    const execution = context({ scheduler: parallel(), graph });
    const completed = await execution.run();

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
      [
        ["luddites", 1],
        ["nomads", 1],
        ["writers", 1],
      ].sort(),
    );

    assert.equal(completed.get(emailSourceId), "email done");
    assert.equal(completed.get(phoneSourceId), "phone done");
    assert.equal(completed.get(snailmailSourceId), "snailmail done");
  } finally {
    await tracer.flush();
  }
});
