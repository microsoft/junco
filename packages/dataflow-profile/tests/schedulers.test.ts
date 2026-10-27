import { test } from "bun:test";
import { Type } from "typebox";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constantProfile, DataflowGraph, Edge, EmitOnce, from, Message, NodeId, StepNode, TriggerEntry, TriggerRule, UNBOUNDED, mebibytes, megabytes, tokens } from "dataflow-engine";
import { choose, context, limit, lowest, nodeIds, parallel, type Scheduler } from "junco-scheduler";
import { makeProfile, profilesOf } from "../src/predict.ts";
import { parseProfiles } from "../src/schema.ts";
import type { ProfileRecord } from "../src/types.ts";

const StringSchema = Type.String();
test("few-samples fallback charges each rare activation its 130 MiB bound", async () => {
  const text = readFileSync(new URL("../fixtures/profiles.json", import.meta.url), "utf8");
  const rare = profilesOf(parseProfiles(text), "rare", ["memory"]).memory;
  assert.equal(rare.fit.n, 3);
  const estimate = rare.predict([2]);
  assert.equal(estimate.source, "fallback");
  assert.equal(estimate.reason, "few_samples");
  assert.equal(estimate.safe, 130);
  for (const allowance of [200, 300]) {
    const graph = new DataflowGraph<void, typeof StringSchema, string, never, "memory">(UNBOUNDED, UNBOUNDED);
    const consumed: string[] = [];
    const rares = ["rareX", "rareY"].map((name, i) => {
      const edge = Edge.message<typeof StringSchema, string>("in", StringSchema);
      const source = graph.addNode(new EmitOnce<void, typeof StringSchema, string, "memory">(() => [Message.create(edge, "a"), Message.create(edge, "b")], "done", { id: NodeId.create(`source${i}`), state: undefined, trigger: TriggerRule.always(), profiles: { memory: constantProfile("memory", megabytes(0)) } }));
      const node = graph.addNode(new StepNode<void, typeof StringSchema, string, "memory">((_state, view) => { assert.deepEqual(from(view, edge), ["a", "b"]); consumed.push(name); return []; }, { id: NodeId.create(name), state: undefined, trigger: TriggerRule.when(edge), profiles: { memory: rare } }));
      graph.addEdge(source, node, edge);
      return node;
    });
    const waves: string[][] = [];
    const inner = limit<void, typeof StringSchema, string, never>({ memory: mebibytes(allowance) }, parallel());
    const scheduler: Scheduler<void, typeof StringSchema, string, never> = async (s, signal) => { const d = await inner(s, signal); waves.push(nodeIds(d.selected)); return d; };
    await context({ graph, scheduler }).run();
    assert.deepEqual(consumed, ["rareX", "rareY"]);
    assert.equal(waves.some(wave => rares.every(node => wave.includes(node))), allowance === 300);
  }
});

test("fitted count features rank the one-message racer ahead of the nine-message racer", async () => {
  const graph = new DataflowGraph<void, typeof StringSchema, string, never, "tokens">(UNBOUNDED, UNBOUNDED);
  const prompts = [Edge.message<typeof StringSchema, string>("promptR1", StringSchema), Edge.message<typeof StringSchema, string>("promptR2", StringSchema)];
  const arrivals = [Edge.message<typeof StringSchema, string>("R1->join", StringSchema), Edge.message<typeof StringSchema, string>("R2->join", StringSchema)];
  const record = (port: (typeof prompts)[number]["id"]): ProfileRecord<"tokens"> => ({ resource: "tokens", unit: "tok", features: [{ port, measure: "count" }], model: { kind: "linear", base: 20, coef: [10] }, fit: { n: 20, r2: 0.95, residP95: 5, fittedAt: "2026-10-12" }, range: [[0, 50]], bound: 600 });
  const profiles = prompts.map(edge => makeProfile(record(edge.id)));
  assert.equal(profiles[0]!.predict([9]).safe, 115);
  assert.equal(profiles[1]!.predict([1]).safe, 35);
  const source = graph.addNode(new EmitOnce<void, typeof StringSchema, string, "tokens">(() => [...Array.from({ length: 9 }, () => Message.create(prompts[0]!, "p")), Message.create(prompts[1]!, "p")], "done", { id: NodeId.create("prompter"), state: undefined, trigger: TriggerRule.always(), profiles: { tokens: constantProfile("tokens", tokens(0)) } }));
  const racers = ["R1", "R2"].map((name, i) => {
    const racer = graph.addNode({ id: NodeId.create(name), state: undefined, trigger: TriggerRule.when(prompts[i]!), profiles: { tokens: profiles[i]! }, step: async function* () { const view = yield []; assert.equal(from(view, prompts[i]!).length, i === 0 ? 9 : 1); yield [Message.create(arrivals[i]!, name)]; return name; } });
    graph.addEdge(source, racer, prompts[i]!);
    return racer;
  });
  const join = graph.addNode({ id: NodeId.create("join"), state: undefined, trigger: TriggerRule.anyOf(...arrivals.map(edge => TriggerEntry.on(edge))), profiles: { tokens: constantProfile("tokens", tokens(0)) }, step: async function* () { const view = yield []; return arrivals.flatMap(edge => [...from(view, edge)])[0]!; } });
  racers.forEach((racer, i) => graph.addEdge(racer, join, arrivals[i]!));
  const waves: string[][] = [];
  const inner = choose<void, typeof StringSchema, string, never>({ rank: lowest("tokens"), width: () => 1 });
  const scheduler: Scheduler<void, typeof StringSchema, string, never> = async (s, signal) => { const d = await inner(s, signal); waves.push(nodeIds(d.selected)); return d; };
  const results = await context({ graph, scheduler }).run();
  assert.equal(results.get(join), "R2");
  assert.ok(waves.findIndex(w => w.includes("R2")) < waves.findIndex(w => w.includes("R1")));
});
