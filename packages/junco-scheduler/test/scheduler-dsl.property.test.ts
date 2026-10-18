/// <reference lib="es2024.promise" />
import { test } from "bun:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import fc from "fast-check";
import { DataflowDefinitionError, DataflowGraph, NodeId, TriggerRule, UNBOUNDED, Width } from "dataflow-engine";
import { agent, choose, context, parallel, roundRobin, separate, type Decision, type Scheduler, type Snapshot } from "../src/index.ts";

type Id = ReturnType<typeof NodeId.create>;
type State = Readonly<{ priority: number }>;
type Metadata = Readonly<{ bias: number }>;
type View = Snapshot<State, number, string, Metadata>;
type Policy = Scheduler<State, number, string, Metadata>;
type Fixture = {
  ids: Id[];
  priorities: number[];
  biases: (number | undefined)[];
  available: Id[];
  owned: Id[];
  history: Id[][];
  version: number;
  threads: number;
};
type Leaf = {
  kind: "choose" | "parallel" | "roundRobin" | "agent";
  allowed: Id[];
  width: number;
  historyWidth: boolean;
  historyScore: boolean;
  order: Id[] | undefined;
  waves: Id[][];
};
const id = NodeId.create;
const pool = ["", "1", "10", "2", "a", "b", "c", "z", "é", "e\u0301", "__proto__", "\u0000"];
const frames = [0, 1, 2, 3].map(n => id(`frame:${n}`));
const options = { seed: 0x43534c, numRuns: 200, verbose: true };
const bounded = { ...options, numRuns: 100 };
const integer = fc.integer({ min: -3, max: 3 });
const subset = (ids: Id[]) => fc.subarray(ids);
const historyOf = (owned: Id[]) => owned.length === 0
  ? fc.constant<Id[][]>([])
  : fc.array(fc.shuffledSubarray(owned, { minLength: 1 }), { maxLength: 8 });
const fixtures = fc.shuffledSubarray(pool, { maxLength: 8 }).map(xs => xs.map(id)).chain(ids =>
  fc.tuple(subset(ids), subset(ids)).chain(([available, owned]) => fc.record({
    priorities: fc.array(integer, { minLength: ids.length, maxLength: ids.length }),
    biases: fc.array(fc.option(integer, { nil: undefined }), { minLength: ids.length, maxLength: ids.length }),
    history: historyOf(owned),
    version: fc.nat({ max: 32 }),
    threads: fc.oneof(fc.integer({ min: 1, max: ids.length + 2 }), fc.constant(Infinity)),
  }).map(rest => ({ ids, available, owned, ...rest }))),
);
const wavesOf = (ids: Id[]) => fc.array(fc.array(fc.constantFrom(...ids, id("missing")), { maxLength: 8 }), { maxLength: 8 });
const leaves = (ids: Id[]): fc.Arbitrary<Leaf> => fc.record({
  kind: fc.constantFrom("choose", "parallel", "roundRobin", "agent"),
  allowed: subset(ids),
  width: fc.oneof(fc.integer({ min: 0, max: ids.length + 2 }), fc.constant(Infinity)),
  historyWidth: fc.boolean(),
  historyScore: fc.boolean(),
  order: fc.oneof(fc.constant(undefined), fc.shuffledSubarray([...ids, ...frames])),
  waves: wavesOf(ids),
});
const cases = fixtures.chain(f => fc.tuple(leaves(f.ids), leaves(f.ids), leaves(f.ids), subset(f.owned), subset(f.owned))
  .map(([a, b, c, left, other]) => ({ f, a, b, c, left, other })));

function snapshot(f: Fixture): View {
  return Object.freeze({
    nodes: new Map(f.ids.map((node, i) => [node, Object.freeze({ id: node, status: "running" as const, profiles: {}, state: Object.freeze({ priority: f.priorities[i]! }) })])),
    links: Object.freeze([]),
    inputs: new Map(f.ids.map(node => [node, Object.freeze({ messages: new Map(), values: new Map() })])),
    results: new Map<Id, string>(),
    context: new Map(f.ids.flatMap((node, i) => f.biases[i] === undefined ? [] : [[node, Object.freeze({ bias: f.biases[i]! })] as const])),
    available: new Set(f.available), owned: new Set(f.owned),
    plans: new Map(),
    history: Object.freeze(f.history.map(selected => Object.freeze({ selected: Object.freeze([...selected]) }))),
    version: f.version, threads: f.threads,
  });
}
function project(f: Fixture, domain: readonly Id[]): Fixture {
  const owned = f.owned.filter(node => domain.includes(node));
  return { ...f, owned, history: f.history.map(event => event.filter(node => owned.includes(node))).filter(event => event.length > 0) };
}
function width(p: Leaf, historyLength: number): number {
  return p.width + (p.historyWidth ? historyLength % 3 : 0);
}
function count(history: readonly (readonly Id[])[], node: Id): number {
  return history.reduce((n, event) => n + Number(event.includes(node)), 0);
}
function policy(p: Leaf): Policy {
  switch (p.kind) {
    case "parallel": return parallel();
    case "roundRobin": return roundRobin(p.order, p.width);
    case "agent": return agent(async () => p.waves);
    case "choose": {
      const score = (s: View, node: Id) => s.nodes.get(node)!.state.priority + (s.context.get(node)?.bias ?? 0)
        - (p.historyScore ? count(s.history.map(d => d.selected), node) : 0);
      return choose({ where: (_s, node) => p.allowed.includes(node), rank: (s, a, b) => score(s, b) - score(s, a), width: s => width(p, s.history.length) });
    }
  }
}
// Models use only generated arrays, not production normalization/projection helpers.
function expected(f: Fixture, p: Leaf): Id[] {
  const eligible = (node: Id) => f.owned.includes(node) && f.available.includes(node);
  if (p.kind === "parallel") return f.available.filter(eligible);
  if (p.kind === "agent") {
    for (const wave of p.waves) {
      const selected: Id[] = [];
      for (const node of wave) if (eligible(node) && !selected.includes(node)) selected.push(node);
      if (selected.length) return selected;
    }
    return [];
  }
  if (p.kind === "roundRobin") {
    const order = p.order ?? f.ids.filter(node => f.owned.includes(node)).sort();
    let last = -1;
    for (const event of f.history) for (const node of event) {
      const index = order.indexOf(node);
      if (index >= 0) last = index;
    }
    const selected: Id[] = [];
    for (let n = 1; n <= order.length; n++) {
      const node = order[(last + n) % order.length]!;
      if (eligible(node) && selected.length < p.width) selected.push(node);
    }
    return selected;
  }
  const score = (node: Id) => {
    const index = f.ids.indexOf(node);
    return f.priorities[index]! + (f.biases[index] ?? 0) - (p.historyScore ? count(f.history, node) : 0);
  };
  return f.available.filter(node => eligible(node) && p.allowed.includes(node)).sort((a, b) => score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, width(p, f.history.length));
}
function safe(f: Fixture, selected: readonly Id[]): void {
  assert.equal(new Set(selected).size, selected.length);
  for (const node of selected) assert.ok(f.available.includes(node) && f.owned.includes(node));
}
function assertProjection(actual: View, parent: View, model: Fixture): void {
  assert.deepEqual([...actual.owned], model.owned);
  assert.deepEqual(actual.history.map(d => [...d.selected]), model.history);
  for (const key of ["nodes", "inputs", "results", "links", "context", "available", "version", "threads"] as const) assert.deepEqual(actual[key], parent[key]);
}
const abstain: Policy = () => ({ selected: [] });
async function scoped(s: View, domain: readonly Id[], child: Policy): Promise<Decision> {
  return separate((_s, node) => domain.includes(node), child, abstain)(s);
}
function fixed(ids: string[], history: string[][] = []): Fixture {
  const nodes = ids.map(id);
  return { ids: nodes, priorities: nodes.map(() => 0), biases: nodes.map(() => undefined), owned: [...nodes], available: [...nodes], history: history.map(event => event.map(id)), version: 0, threads: Infinity };
}
function parameters(kind: Leaf["kind"], overrides: Partial<Leaf> = {}): Leaf {
  return { kind, allowed: [], width: 1, historyWidth: false, historyScore: false, order: undefined, waves: [], ...overrides };
}
const boundary = { f: fixed(["2", "1", "10"]), a: parameters("choose", { allowed: [id("2"), id("1"), id("10")], width: Infinity }), b: parameters("parallel"), c: parameters("agent"), left: [id("1")], other: [] as Id[] };

test("CSL: projection composes", async () => {
  await fc.assert(fc.asyncProperty(cases, async ({ f, left, other }) => {
    const s = snapshot(f);
    const observe = async (parent: View, domain: Id[], model: Fixture) => {
      let seen: View | undefined;
      await scoped(parent, domain, child => { seen = child; return { selected: [] }; });
      assert.ok(seen);
      assertProjection(seen, parent, model);
      return seen;
    };
    const first = await observe(s, left, project(f, left));
    await observe(first, left, project(f, left));
    const composed = await observe(first, other, project(project(f, left), other));
    const direct = await observe(s, left.filter(node => other.includes(node)), project(f, left.filter(node => other.includes(node))));
    assert.deepEqual([...composed.owned], [...direct.owned]);
    assert.deepEqual(composed.history, direct.history);
    await observe(s, [], project(f, []));
    await observe(s, f.owned, f);
  }), { ...options, examples: [[boundary], [{ ...boundary, f: fixed(["a", "b"], [["a"], ["a", "b"], ["b"]]), left: [id("a")], other: [id("b")] }]] });
});

test("CSL: atomic decisions follow their denotations", async () => {
  await fc.assert(fc.asyncProperty(cases, async ({ f, a }) => {
    for (const kind of ["choose", "parallel", "roundRobin", "agent"] as const) {
      const p = { ...a, kind };
      const want = expected(f, p);
      const result = await policy(p)(snapshot(f));
      assert.deepEqual(result.selected, want);
      safe(f, result.selected);
    }
    const exhausted = { ...f, owned: [] };
    assert.deepEqual(await agent<State, number, string, Metadata>(async () => { throw new Error("exhausted oracle invoked"); })(snapshot(exhausted)), { selected: [] });
  }), { ...options, examples: [[boundary], [{ ...boundary, f: fixed(["a", "b"]), a: parameters("agent", { waves: [[id("missing")], [id("b"), id("b"), id("a")], [id("later")]] }) }]] });
  await fc.assert(fc.asyncProperty(wavesOf([id("a"), id("b")]), wavesOf([id("a"), id("b")]), async (first, second) => {
    const f = fixed(["a", "b"]);
    let calls = 0;
    const oracle = agent<State, number, string, Metadata>(async () => calls++ === 0 ? first : second);
    const one = await oracle(snapshot(f));
    assert.deepEqual(one.selected, expected(f, parameters("agent", { waves: first })));
    const next = { ...f, history: one.selected.length ? [[...one.selected]] : [] };
    const two = await oracle(snapshot(next));
    assert.deepEqual(two.selected, expected(next, parameters("agent", { waves: second })));
    assert.equal(calls, 2);
  }), { ...options, examples: [[[[id("a")], [id("a")]], [[id("b")]]]] });
  for (const invalid of [-1, 0.5, NaN, -Infinity]) await assert.rejects(async () => choose<State, number, string, Metadata>({ rank: () => 0, width: () => invalid })(snapshot(fixed(["a"]))), DataflowDefinitionError);
  for (const rank of [() => NaN, () => "bad"]) {
    // Deliberately malformed JavaScript callback, not a cast of an invalid payload.
    // @ts-expect-error a scheduler comparator must return a number
    const invalid: Policy = choose<State, number, string, Metadata>({ rank });
    await assert.rejects(async () => invalid(snapshot(fixed(["a", "b"]))), DataflowDefinitionError);
  }
  assert.throws(() => roundRobin([id("a"), id("a")]), DataflowDefinitionError);
});

test("CSL: parallel conserves authority", async () => {
  await fc.assert(fc.asyncProperty(cases, async ({ f, a, b, left }) => {
    const right = f.owned.filter(node => !left.includes(node));
    const l = project(f, left), r = project(f, right);
    const wantLeft = expected(l, a), wantRight = expected(r, b);
    const s = snapshot(f);
    const probe = (p: Leaf, model: Fixture): Policy => async child => {
      assertProjection(child, s, model);
      const decision = await policy(p)(child);
      safe(model, decision.selected);
      return decision;
    };
    const actual = await separate((_s, node) => left.includes(node), probe(a, l), probe(b, r))(s);
    assert.deepEqual(actual.selected, [...wantLeft, ...wantRight]);
    assert.ok(wantLeft.every(node => !wantRight.includes(node)));
    safe(f, actual.selected);
  }), { ...options, examples: [[boundary]] });
});

test("CSL: ordered composition associates and has a unit", async () => {
  await fc.assert(fc.asyncProperty(cases, async ({ f, a, b, c, left, other }) => {
    const A = left, B = other.filter(node => !A.includes(node)), C = f.owned.filter(node => !A.includes(node) && !B.includes(node));
    const S = policy(a), T = policy(b), U = policy(c);
    const inA = (_s: View, node: Id) => A.includes(node);
    const inB = (_s: View, node: Id) => B.includes(node);
    const inAB = (_s: View, node: Id) => A.includes(node) || B.includes(node);
    const want = [...expected(project(f, A), a), ...expected(project(f, B), b), ...expected(project(f, C), c)];
    const s = snapshot(f);
    assert.deepEqual((await separate(inAB, separate(inA, S, T), U)(s)).selected, want);
    assert.deepEqual((await separate(inA, S, separate(inB, T, U))(s)).selected, want);
    const ordinary = await S(s);
    assert.deepEqual(await separate(() => true, S, abstain)(s), ordinary);
    assert.deepEqual(await separate(() => false, abstain, S)(s), ordinary);
    const forward = await separate(inA, S, T)(s);
    const reversed = await separate((_s, node) => !A.includes(node), T, S)(s);
    assert.deepEqual(reversed.selected, [...expected(project(f, f.owned.filter(node => !A.includes(node))), b), ...expected(project(f, A), a)]);
    assert.deepEqual(new Set(reversed.selected), new Set(forward.selected));
  }), { ...options, examples: [[boundary]] });
});

// Fresh frame records are inserted into gaps; the relative order of existing work never changes.
function framed(f: Fixture, count: number): Fixture {
  const extra = frames.slice(0, count);
  const ids: Id[] = [], priorities: number[] = [], biases: (number | undefined)[] = [];
  for (let n = 0; n <= f.ids.length; n++) {
    if (n < extra.length) { ids.push(extra[n]!); priorities.push(-3); biases.push(3); }
    if (n < f.ids.length) { ids.push(f.ids[n]!); priorities.push(f.priorities[n]!); biases.push(f.biases[n]); }
  }
  for (const node of extra.slice(f.ids.length + 1)) { ids.push(node); priorities.push(-3); biases.push(3); }
  const history = f.history.map((event, n) => extra.length ? [extra[n % extra.length]!, ...event] : [...event]);
  if (extra.length) history.unshift([...extra]);
  return { ...f, ids, priorities, biases, owned: ids.filter(node => f.owned.includes(node) || extra.includes(node)), available: ids.filter(node => f.available.includes(node) || extra.includes(node)), history, version: f.version + 1 };
}
test("CSL: local policies satisfy the frame rule", async () => {
  await fc.assert(fc.asyncProperty(cases, fc.integer({ min: 0, max: 4 }), async ({ f, a, b, left }, n) => {
    const extension = framed(f, n);
    const policies = [policy({ ...a, kind: "choose" }), parallel(), roundRobin(undefined, a.width), roundRobin(a.order, a.width), policy({ ...a, kind: "agent" }), separate((_s: View, node: Id) => left.includes(node), policy(a), policy(b))];
    for (const p of policies) {
      const before = await scoped(snapshot(f), f.owned, p);
      const after = await scoped(snapshot(extension), f.owned, p);
      assert.deepEqual(after, before);
    }
    for (const kind of ["choose", "parallel", "roundRobin", "agent"] as const) {
      const p = { ...a, kind };
      assert.deepEqual((await scoped(snapshot(extension), f.owned, policy(p))).selected, expected(f, p));
    }
  }), { ...options, examples: [[{ ...boundary, f: fixed(["a", "b"]), a: parameters("roundRobin", { order: [id("a"), frames[0]!, id("b")] }) }, 1]] });
});

test("CSL: round-robin traces use only projected history", async () => {
  const traces = fixtures.chain(f => fc.tuple(leaves(f.ids), historyOf(f.owned), fc.array(fc.record({ available: subset(f.ids), frame: fc.shuffledSubarray(frames), stream: fc.constantFrom<0 | 1>(0, 1) }), { maxLength: 16 }))
    .map(([p, second, transitions]) => ({ f, p: { ...p, kind: "roundRobin" as const }, second, transitions })));
  await fc.assert(fc.asyncProperty(traces, async ({ f, p, second, transitions }) => {
    const histories = [f.history.map(event => [...event]), second.map(event => [...event])];
    const models = histories.map(events => events.map(event => [...event]));
    const shared = policy(p);
    for (const transition of transitions) {
      const stream = transition.stream;
      const local = { ...f, available: transition.available, history: models[stream]! };
      const want = expected(local, p);
      const extended = framed({ ...local, history: histories[stream]! }, 4);
      extended.history.push(...transition.frame.map(node => [node]));
      const decision = await scoped(snapshot(extended), f.owned, shared);
      assert.deepEqual(decision.selected, want);
      if (decision.selected.length) histories[stream]!.push([...decision.selected]);
      if (want.length) models[stream]!.push(want);
    }
  }), { ...bounded, examples: [[{ f: fixed(["1", "10", "2"]), p: { ...parameters("roundRobin", { width: 2 }), kind: "roundRobin" as const }, second: [], transitions: Array.from({ length: 3 }, () => ({ available: [id("1"), id("10"), id("2")], frame: [], stream: 0 as const })) }]] });
  const f = fixed(["1", "10", "2"]);
  let wide = snapshot(f);
  const wideSelections: (readonly Id[])[] = [];
  for (let n = 0; n < 3; n++) {
    const decision = await roundRobin(undefined, 2)(wide);
    wideSelections.push(decision.selected);
    wide = { ...wide, history: [...wide.history, decision] };
  }
  assert.deepEqual(wideSelections, [["1", "10"], ["2", "1"], ["10", "2"]]);
  const shared = roundRobin();
  const streams = [snapshot(f), snapshot(f)];
  const selections: (readonly Id[])[] = [];
  for (const stream of [0, 1, 0, 1]) {
    const s = streams[stream]!;
    const d = await shared(s);
    selections.push(d.selected);
    streams[stream] = { ...s, history: [...s.history, d] };
  }
  assert.deepEqual(selections, [["1"], ["1"], ["10"], ["10"]]);
  for (const [history, want] of [[["a", "b"], ["c"]], [["b", "a"], ["b"]]] as const) {
    const s = snapshot(fixed(["a", "b", "c"], [[...history]]));
    assert.deepEqual((await roundRobin([id("a"), id("b"), id("c")])(s)).selected, want);
  }
});

type Outcome = "return" | "throw" | "resolve" | "reject";
const outcome = fc.constantFrom<Outcome>("return", "throw", "resolve", "reject");
const asyncCases = fc.boolean().chain(cancel => fc.tuple(outcome, outcome, fc.boolean()).map(([left, right, reverse]) => ({ cancel, left: cancel && left !== "resolve" && left !== "reject" && right !== "resolve" && right !== "reject" ? "resolve" as const : left, right, reverse })));
test("CSL: async composition drains before settling", async () => {
  await fc.assert(fc.asyncProperty(asyncCases, async ({ cancel, left, right, reverse }) => {
    const kinds = [left, right];
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const errors = [new Error("left"), new Error("right")];
    const started = [false, false], cleaned = [false, false], released = [false, false];
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const child = (n: number): Policy => () => {
      started[n] = true;
      const kind = kinds[n]!;
      if (kind === "throw") { cleaned[n] = true; throw errors[n]; }
      if (kind === "return") { cleaned[n] = true; return { selected: [id(n === 0 ? "a" : "b")] }; }
      return (async () => {
        try {
          await gates[n]!.promise;
          if (kind === "reject") throw errors[n];
          return { selected: [id(n === 0 ? "a" : "b")] };
        } finally { cleaned[n] = true; }
      })();
    };
    let settled = false;
    const observation = Promise.resolve(separate((_s: View, node: Id) => node === "a", child(0), child(1))(snapshot(fixed(["a", "b"])), controller.signal))
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
      .then(result => { settled = true; return result; });
    try {
      await nextTurn();
      assert.deepEqual(started, [true, true]);
      if (cancel) controller.abort(reason);
      for (const n of reverse ? [1, 0] : [0, 1]) {
        if (kinds[n] === "resolve" || kinds[n] === "reject") {
          assert.equal(settled, false);
          gates[n]!.resolve(); released[n] = true;
          await nextTurn();
        }
        if (kinds.some((kind, index) => (kind === "resolve" || kind === "reject") && !released[index])) assert.equal(settled, false);
      }
      const result = await observation;
      assert.deepEqual(cleaned, [true, true]);
      const failed = kinds.findIndex(kind => kind === "throw" || kind === "reject");
      if (cancel || failed >= 0) {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, cancel ? reason : errors[failed]);
      } else {
        assert.ok(result.ok);
        assert.deepEqual(result.value.selected, ["a", "b"]);
      }
    } finally {
      for (const gate of gates) gate.resolve();
      await observation;
    }
  }), { ...options, examples: [[{ cancel: false, left: "throw", right: "resolve", reverse: true }], [{ cancel: true, left: "reject", right: "throw", reverse: false }]] });
  const failure = new Error("empty authority failure");
  await assert.rejects(async () => separate<State, number, string, Metadata>(() => false, () => { throw failure; }, abstain)(snapshot(fixed(["a"]))), error => error === failure);
});

test("CSL: context rejects authority or capacity violations atomically", async () => {
  const engineCases = fc.shuffledSubarray(pool, { minLength: 2, maxLength: 8 }).map(xs => xs.map(id)).chain(ids =>
    fc.tuple(fc.shuffledSubarray(ids, { minLength: 1, maxLength: ids.length - 1 }), fc.constantFrom("escape", "duplicate", "capacity"))
      .map(([left, fault]) => ({ ids, left, fault })));
  await fc.assert(fc.asyncProperty(engineCases, async ({ ids, left, fault }) => {
    const capacities = [Width.create(1), Width.create(2), Width.create(3), Width.create(4), Width.create(5), Width.create(6), Width.create(7)];
    const graph = new DataflowGraph<void, number, string, never>(Width.create(1), fault === "capacity" ? capacities[ids.length - 2]! : UNBOUNDED);
    const activations: Id[] = [];
    for (const node of ids) graph.addNode({ id: node, state: undefined, trigger: TriggerRule.always(), step: async function* () { activations.push(node); return node; } });
    const right = ids.filter(node => !left.includes(node));
    type EnginePolicy = Scheduler<void, number, string, never>;
    const faulty: EnginePolicy = separate((_s, node) => left.includes(node),
      fault === "escape" ? () => ({ selected: [right[0]!] }) : fault === "duplicate" ? () => ({ selected: [left[0]!, left[0]!] }) : parallel(),
      parallel());
    let current = faulty;
    const snapshots: Snapshot<void, number, string, never>[] = [];
    const execution = context({ graph, scheduler: (s, signal) => { snapshots.push(s); return current(s, signal); } });
    const version = graph.observe().version;
    await assert.rejects(execution.step(), DataflowDefinitionError);
    assert.deepEqual(activations, []);
    assert.equal(graph.observe().version, version);
    assert.deepEqual(snapshots[0]!.history, []);
    current = choose({ rank: () => 0 });
    await execution.step();
    assert.equal(snapshots[1]!.version, snapshots[0]!.version);
    assert.deepEqual(snapshots[1]!.history, []);
    const results = await execution.run();
    assert.deepEqual(new Map([...results].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), new Map(ids.map(node => [node, node] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    assert.equal(activations.length, ids.length);
    assert.equal(snapshots[2]!.history.length, 1);
    assert.equal(snapshots[2]!.history[0]!.selected.length, 1);
    assert.ok(snapshots[2]!.version > version);
    assert.deepEqual(snapshots[0]!.history, []);
    assert.deepEqual(snapshots[1]!.history, []);
  }), { ...bounded, examples: [[{ ids: [id(""), id("a")], left: [id("")], fault: "escape" }], [{ ids: [id("a"), id("b")], left: [id("a")], fault: "duplicate" }], [{ ids: [id("a"), id("b")], left: [id("a")], fault: "capacity" }]] });
});
