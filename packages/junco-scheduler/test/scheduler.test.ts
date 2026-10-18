/// <reference lib="es2024.promise" />
import { test } from "bun:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  DataflowDefinitionError,
  DataflowGraph,
  Edge,
  EdgeId,
  type EdgeIdType,
  EmitOnce,
  from,
  Message,
  type MessageSchedule,
  NodeId,
  type NodeIdType,
  type ParentView,
  type StepFn,
  StepNode,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
  type WidthType,
} from "dataflow-engine";
import {
  agent,
  choose,
  context,
  type Decision,
  parallel,
  roundRobin,
  type Scheduler,
  separate,
  type Snapshot,
} from "../src/index.ts";

type Graph = DataflowGraph<void, number, string, never>;
type Policy = Scheduler<void, number, string, never>;
type View = Snapshot<void, number, string, never>;
const id = NodeId.create;
const ids = (names: readonly string[]) => names.map(id);
const selections = (snapshot: View) => snapshot.history.map((event) => [...event.selected]);

const actor = (ran: string[]): StepFn<void, number, string> =>
  async function* (this) {
    while (true) {
      ran.push(this.id);
      yield [];
    }
  };

function actors(
  scheduler: Policy,
  names: readonly string[],
  { window = Width.create(1), threads = UNBOUNDED }:
    { readonly window?: WidthType; readonly threads?: WidthType } = {},
) {
  const ran: string[] = [];
  const graph: Graph = new DataflowGraph(window, threads);
  const execution = context({ graph, scheduler });
  for (const name of names)
    graph.addNode({ id: id(name), state: undefined, trigger: TriggerRule.always(), step: actor(ran) });
  return { graph, execution, ran };
}

function snapshot(
  names: readonly string[],
  options: {
    readonly available?: readonly string[];
    readonly owned?: readonly string[];
    readonly history?: readonly (readonly string[])[];
  } = {},
): View {
  const nodes: View["nodes"] extends ReadonlyMap<NodeIdType, infer V> ? Map<NodeIdType, V> : never = new Map();
  for (const node of ids(names)) nodes.set(node, Object.freeze({ id: node, status: "running", state: undefined, profiles: {} }));
  return Object.freeze({
    nodes,
    inputs: new Map<NodeIdType, ParentView<number, string>>(),
    links: Object.freeze([]),
    results: new Map<NodeIdType, string>(),
    version: 0,
    available: new Set(ids(options.available ?? names)),
    owned: new Set(ids(options.owned ?? names)),
    context: new Map<NodeIdType, never>(),
    plans: new Map(),
    history: Object.freeze((options.history ?? []).map((event) => Object.freeze({ selected: Object.freeze(ids(event)) }))),
    threads: Infinity,
  });
}

test("choose filters before callbacks, evaluates width once and uses string-ID ties", async () => {
  const seen: string[] = [];
  let widths = 0;
  const policy: Policy = choose({
    where: (_snapshot, node) => { seen.push(node); return true; },
    rank: (_snapshot, left, right) => {
      assert.ok(["1", "10", "2"].includes(left));
      assert.ok(["1", "10", "2"].includes(right));
      return 0;
    },
    width: () => { widths++; return Infinity; },
  });
  const view = snapshot(["foreign", "2", "1", "10", "unavailable"], {
    available: ["foreign", "2", "1", "10"], owned: ["2", "1", "10", "unavailable"],
  });
  assert.deepEqual(await policy(view), { selected: ids(["1", "10", "2"]) });
  assert.deepEqual(seen, ["2", "1", "10"]);
  assert.equal(widths, 1);
  const composed: Policy = separate(
    (_s, node) => node === id("1"),
    choose({ rank: () => 0, width: () => 0 }),
    parallel(),
  );
  assert.deepEqual(await composed(snapshot(["1", "2"])), { selected: ids(["2"]) });
});

test("invalid widths and ranks reject before any work", async () => {
  for (const width of [-1, 0.5, NaN, -Infinity]) {
    const { execution, ran } = actors(choose({ rank: () => 0, width: () => width }), ["a", "b"]);
    await assert.rejects(execution.step(), DataflowDefinitionError);
    assert.deepEqual(ran, []);
  }
  // @ts-expect-error runtime malformed callback declaration, not an asserted payload
  const missingWidth: Policy = choose({ rank: () => 0, width: () => undefined });
  // @ts-expect-error runtime malformed callback declaration, not an asserted payload
  const textualRank: Policy = choose({ rank: () => "first" });
  for (const policy of [missingWidth, textualRank, choose<void, number, string, never>({ rank: () => NaN })]) {
    const { execution, ran } = actors(policy, ["a", "b"]);
    await assert.rejects(execution.step(), DataflowDefinitionError);
    assert.deepEqual(ran, []);
  }
});

test("parallel starts every candidate concurrently and advances exactly once", async () => {
  const gate = Promise.withResolvers<void>();
  const allStarted = Promise.withResolvers<void>();
  const started: string[] = [];
  const advanced: string[] = [];
  const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  const execution = context({ graph, scheduler: parallel() });
  for (const node of ["a", "b", "c"])
    graph.addNode({
      id: id(node), state: undefined, trigger: TriggerRule.always(),
      step: async function* () {
        started.push(node);
        if (started.length === 3) allStarted.resolve();
        await gate.promise;
        advanced.push(node);
        while (true) yield [];
      },
    });
  const stepping = execution.step();
  try {
    await allStarted.promise;
    assert.deepEqual(started, ["a", "b", "c"]);
    assert.deepEqual(advanced, []);
  } finally {
    gate.resolve();
    await stepping;
  }
  assert.deepEqual(advanced, ["a", "b", "c"]);
  for (const node of ids(started)) assert.equal(graph.getNode(node)!.status, "running");
});

test("parallel does not throttle finite capacity and rejected plans commit no history", async () => {
  const captured: View[] = [];
  let policy: Policy = parallel();
  const { graph, execution, ran } = actors((view, signal) => {
    captured.push(view);
    return policy(view, signal);
  }, ["a", "b", "c"], { threads: Width.create(2) });
  const version = graph.observe().version;
  await assert.rejects(execution.step(), DataflowDefinitionError);
  assert.deepEqual(ran, []);
  assert.equal(graph.observe().version, version);
  policy = choose({ rank: () => 0 });
  await execution.step();
  await execution.step();
  assert.deepEqual(selections(captured[0]!), []);
  assert.deepEqual(selections(captured[1]!), []);
  assert.deepEqual(selections(captured[2]!), [["a"]]);
  assert.equal(captured[1]!.version, version);
  assert.ok(captured[2]!.version > version);
  assert.deepEqual(await parallel()(snapshot([])), { selected: [] });
});

test("round robin uses committed string-order history, not shared mutable state", async () => {
  const policy = roundRobin();
  const one = actors(policy, ["2", "1", "10"], { window: Width.create(8), threads: Width.create(8) });
  const two = actors(policy, ["2", "1", "10"]);
  await one.execution.step();
  await two.execution.step();
  await one.execution.step();
  await two.execution.step();
  await one.execution.step();
  await one.execution.step();
  assert.deepEqual(one.ran, ["1", "10", "2", "1"]);
  assert.deepEqual(two.ran, ["1", "10"]);
});

test("round robin preserves selection order, unavailable cursor IDs and explicit order ownership", async () => {
  const order = ids(["a", "b", "c"]);
  const rotation = roundRobin(order);
  order.reverse(); // construction copied caller storage
  assert.deepEqual(await rotation(snapshot(["a", "b", "c"], { history: [["a", "b"]] })), { selected: ids(["c"]) });
  assert.deepEqual(await rotation(snapshot(["a", "b", "c"], { history: [["b", "a"]] })), { selected: ids(["b"]) });
  assert.deepEqual(await rotation(snapshot(["a", "b", "c"], { available: ["a", "c"], history: [["b"]] })), { selected: ids(["c"]) });
  assert.deepEqual(await roundRobin([])(snapshot(["a"])), { selected: [] });
  assert.throws(() => roundRobin(ids(["", ""])), DataflowDefinitionError);
  const pairs = roundRobin(ids(["1", "10", "2"]), 2);
  const history: string[][] = [];
  for (const expected of [["1", "10"], ["2", "1"], ["10", "2"]]) {
    const decision = await pairs(snapshot(["2", "1", "10"], { history }));
    assert.deepEqual(decision.selected, expected);
    history.push([...decision.selected]);
  }
  const { graph, execution, ran } = actors(roundRobin(), ["a", "c"]);
  await execution.step();
  graph.addNode({ id: id("b"), state: undefined, trigger: TriggerRule.always(), step: actor(ran) });
  await execution.step();
  await execution.step();
  assert.deepEqual(ran, ["a", "b", "c"]);
});

test("separate projects authority/history only and prevents sibling authority escapes", async () => {
  const ambient = snapshot(["a", "b", "c"], { history: [["b"], ["a", "b"], ["c", "a"]] });
  const probed: View[] = [];
  let partitions = 0;
  const policy: Policy = separate(
    (_snapshot, node) => { partitions++; return node !== id("b"); },
    (view, signal) => { probed.push(view); return roundRobin()(view, signal); },
    (view) => { probed.push(view); return { selected: [] }; },
  );
  assert.deepEqual(await policy(ambient), { selected: ids(["c"]) });
  assert.equal(partitions, 3);
  assert.deepEqual([...probed[0]!.owned], ids(["a", "c"]));
  assert.deepEqual(selections(probed[0]!), [["a"], ["c", "a"]]);
  assert.deepEqual(selections(probed[1]!), [["b"], ["b"]]);
  for (const view of probed) {
    assert.equal(view.nodes, ambient.nodes);
    assert.equal(view.links, ambient.links);
    assert.equal(view.inputs, ambient.inputs);
    assert.equal(view.results, ambient.results);
    assert.equal(view.context, ambient.context);
    assert.equal(view.available, ambient.available);
    assert.equal(view.version, ambient.version);
    assert.equal(view.threads, ambient.threads);
  }
  const escape: Policy = separate((_s, node) => node === id("a"), () => ({ selected: ids(["b"]) }), parallel());
  await assert.rejects(Promise.resolve(escape(ambient)), DataflowDefinitionError);
  const local: Policy = separate((_s, node) => node !== id("b"), roundRobin(), () => ({ selected: [] }));
  assert.deepEqual(await local(snapshot(["a", "b", "c"], { history: [["b"]] })), { selected: ids(["a"]) });
});

test("separate starts and drains both children, with leftmost failure and cancellation precedence", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("cancelled composition");
    const leftError = new Error("left");
    const rightError = new Error("right");
    const gate = Promise.withResolvers<void>();
    const started: string[] = [];
    const cleaned: string[] = [];
    let settled = false;
    const policy: Policy = separate(
      () => false, // the empty-domain child must still run and may fail
      () => { started.push("left"); throw leftError; },
      async () => {
        started.push("right");
        try { await gate.promise; throw rightError; }
        finally { cleaned.push("right"); }
      },
    );
    const observed = Promise.resolve(policy(snapshot(["a"]), controller.signal)).then(
      () => { settled = true; return { ok: true as const }; },
      (error: unknown) => { settled = true; return { ok: false as const, error }; },
    );
    try {
      await nextTurn();
      assert.deepEqual(started, ["left", "right"]);
      assert.equal(settled, false);
      if (abort) controller.abort(reason);
      await nextTurn();
      assert.equal(settled, false);
    } finally {
      gate.resolve();
      await observed;
    }
    const result = await observed;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, abort ? reason : leftError);
    assert.deepEqual(cleaned, ["right"]);
  }
});

test("agent normalizes each current response and never invokes an exhausted oracle", async () => {
  let calls = 0;
  const policy: Policy = agent(async () => {
    calls++;
    return calls === 1 ? [ids(["missing"]), ids(["b", "b", "a"]), ids(["a"])] : [ids(["a"])];
  });
  const first = await policy(snapshot(["a", "b", "unowned"], { owned: ["a", "b"] }));
  assert.deepEqual(first, { selected: ids(["b", "a"]) });
  assert.deepEqual(await policy(snapshot(["a", "b"], { history: [first.selected] })), { selected: ids(["a"]) });
  assert.equal(calls, 2);
  const never: Policy = agent(async () => { throw new Error("must not invoke"); });
  assert.deepEqual(await never(snapshot(["a"], { owned: [] })), { selected: [] });
  assert.deepEqual(await policy(snapshot([""])), { selected: [] });
  const emptyId: Policy = agent(async () => [ids(["", "", "missing"])]);
  assert.deepEqual(await emptyId(snapshot([""])), { selected: ids([""]) });
});

test("context validates malformed, duplicate, unavailable and unowned decisions before effects", async () => {
  // @ts-expect-error deliberately invalid JavaScript callback declaration
  const missing: Policy = () => ({});
  // @ts-expect-error deliberately invalid JavaScript callback declaration
  const numeric: Policy = () => ({ selected: [7] });
  // @ts-expect-error deliberately invalid JavaScript callback declaration
  const absent: Policy = () => undefined;
  const sparse: Policy = () => ({ selected: Array<NodeIdType>(1) });
  const duplicates: Policy = () => ({ selected: ids(["a", "a"]) });
  const foreign: Policy = () => ({ selected: ids(["missing"]) });
  const unavailable: Policy = () => ({ selected: ids(["dormant"]) });
  const escaped: Policy = separate((_s, node) => node === id("a"), () => ({ selected: ids(["b"]) }), parallel());
  for (const bad of [missing, numeric, absent, sparse, duplicates, foreign, unavailable, escaped]) {
    const captured: View[] = [];
    let policy = bad;
    const { graph, execution, ran } = actors((view, signal) => {
      captured.push(view);
      return policy(view, signal);
    }, ["a", "b"]);
    graph.addNode({ id: id("dormant"), state: undefined, trigger: TriggerRule.always(), is_available: () => false, step: actor(ran) });
    const version = graph.observe().version;
    await assert.rejects(execution.step(), DataflowDefinitionError);
    assert.deepEqual(ran, []);
    assert.equal(graph.observe().version, version);
    policy = choose({ rank: () => 0 });
    await execution.step();
    assert.deepEqual(selections(captured[1]!), []);
    assert.equal(captured[1]!.version, version);
    assert.deepEqual(ran, ["a"]);
  }
});

test("top-level abstention rejects while a quiescent context does not invoke its policy", async () => {
  const { execution, ran } = actors(() => ({ selected: [] }), ["a"]);
  await assert.rejects(execution.step(), DataflowDefinitionError);
  assert.deepEqual(ran, []);
  const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  let calls = 0;
  const empty = context({ graph, scheduler: () => { calls++; throw new Error("quiescent"); } });
  assert.deepEqual([...await empty.step()], []);
  assert.deepEqual([...await empty.run()], []);
  assert.equal(calls, 0);
});

test("context construction is a passive reusable pair with no provider or observation work", () => {
  class ObservedGraph extends DataflowGraph<void, number, string, never> {
    observations = 0;
    override observe() { this.observations++; return super.observe(); }
  }
  const graph = new ObservedGraph(Width.create(1), UNBOUNDED);
  let policies = 0;
  let descriptions = 0;
  const scheduler: Scheduler<void, number, string, number> = () => {
    policies++;
    return { selected: [] };
  };
  const first = context({ graph, scheduler, describeNode: () => { descriptions++; return 0; } });
  const second = context({ graph, scheduler, describeNode: () => { descriptions++; return 0; } });
  assert.equal(first.graph, graph);
  assert.equal(second.graph, graph);
  assert.equal(first.scheduler, scheduler);
  assert.equal(second.scheduler, scheduler);
  assert.equal(graph.observations, 0);
  assert.equal(policies, 0);
  assert.equal(descriptions, 0);
});

test("readInputs preserves FIFO pairs [1,2], [3,4], [5] and prime does not consume", async () => {
  const feed = Edge.message<number, string>("feed");
  let target = id("P");
  const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  const execution = context({
    graph, scheduler: () => ({ selected: [target] }),
    readInputs: (_node, candidate) =>
      new Map<EdgeIdType, MessageSchedule>(candidate.trigger.rule.map((edge) => [edge, 2])),
  });
  const producer = graph.addNode(new EmitOnce<void, number, string>(
    () => [1, 2, 3, 4, 5].map((n) => Message.create(feed, n)), "p",
    { id: id("P"), state: undefined, trigger: TriggerRule.always() },
  ));
  const batches: number[][] = [];
  const consumer = graph.addNode(new StepNode<void, number, string>((_state, view) => {
    batches.push([...from(view, feed)]);
    return [];
  }, { id: id("C"), state: undefined, trigger: TriggerRule.when(feed) }));
  graph.addEdge(producer, consumer, feed);
  await execution.step();
  target = consumer;
  await execution.step();
  assert.deepEqual(batches, []);
  for (let turn = 0; turn < 3; turn++) await execution.step();
  assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
  assert.equal(graph.available().has(consumer), false);
});

for (const [name, make] of [["parallel", parallel], ["round robin", roundRobin]] as const) {
  test(`${name}: anyOf consumes only the first satisfied edge, leaving its sibling queued`, async () => {
    const a = Edge.message<number, string>("a");
    const b = Edge.message<number, string>("b");
    const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
    const execution = context({ graph, scheduler: make() });
    const source = graph.addNode(new EmitOnce<void, number, string>(
      () => [Message.create(a, 1), Message.create(b, 2)], "p",
      { id: id("P"), state: undefined, trigger: TriggerRule.always() },
    ));
    const seen: { a: number[]; b: number[] }[] = [];
    const sink = graph.addNode(new StepNode<void, number, string>((_state, view) => {
      seen.push({ a: [...from(view, a)], b: [...from(view, b)] });
      return [];
    }, { id: id("S"), state: undefined, trigger: TriggerRule.anyOf(TriggerEntry.on(b), TriggerEntry.on(a)) }));
    graph.addEdge(source, sink, a);
    graph.addEdge(source, sink, b);
    while (seen.length === 0) await execution.step();
    assert.deepEqual(seen, [{ a: [], b: [2] }]);
    assert.ok(graph.available().has(sink));
    await execution.step();
    assert.deepEqual(seen, [{ a: [], b: [2] }, { a: [1], b: [] }]);
    assert.equal(graph.available().has(sink), false);
  });
}

test("allOf waits for the atomic join and observations/planning do not consume inputs", async () => {
  const a = Edge.message<number, string>("a");
  const b = Edge.message<number, string>("b");
  const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  const source = graph.addNode({ id: id("source"), state: undefined, trigger: TriggerRule.always(), is_available: () => false, step: async function* () { return "source"; } });
  const received: number[][] = [];
  const sink = graph.addNode({
    id: id("sink"), state: undefined, trigger: TriggerRule.allOf(TriggerEntry.on(a), TriggerEntry.on(b)),
    step: async function* () {
      const view = yield [];
      received.push([...from(view, a), ...from(view, b)]);
      return "both";
    },
  });
  graph.addEdge(source, sink, a);
  graph.addEdge(source, sink, b);
  const captured: View[] = [];
  const execution = context({ graph, scheduler: (view, signal) => { captured.push(view); return parallel()(view, signal); } });
  graph.emit(source, Message.create(a, 1));
  await execution.run();
  assert.equal(captured.length, 0);
  assert.deepEqual(graph.observe().inputs.get(sink)!.messages.get(a.id), [1]);
  graph.emit(source, Message.create(b, 2));
  assert.deepEqual([...await execution.run()], [[sink, "both"]]);
  assert.deepEqual(received, [[1, 2]]);
  assert.deepEqual(captured[0]!.inputs.get(sink)!.messages.get(a.id), [1]);
  assert.deepEqual(captured[0]!.inputs.get(sink)!.messages.get(b.id), [2]);
  assert.deepEqual(selections(captured[1]!), [["sink"]]);
});

test("invalid read maps reject the entire column before primes or queue consumption", async () => {
  const feed = Edge.message<number, string>("feed");
  const captured: View[] = [];
  let invalid = true;
  const { graph, ran } = actors(parallel(), ["a", "b"]);
  graph.addEdge(id("a"), id("b"), feed);
  graph.emit(id("a"), Message.create(feed, 7));
  const execution = context({
    graph,
    scheduler: (view, signal) => { captured.push(view); return parallel()(view, signal); },
    readInputs: () => invalid ? new Map([[EdgeId.create("not-an-edge"), 1]]) : new Map(),
  });
  const version = graph.observe().version;
  await assert.rejects(execution.step(), DataflowDefinitionError);
  assert.deepEqual(ran, []);
  assert.equal(graph.observe().version, version);
  assert.deepEqual(graph.observe().inputs.get(id("b"))!.messages.get(feed.id), [7]);
  invalid = false;
  await execution.step();
  assert.deepEqual(selections(captured[1]!), []);
});

test("external pairing excludes overlapping planners without binding policies or graph members", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const graph: Graph = new DataflowGraph(Width.create(1), Width.create(2));
  const ran: string[] = [];
  for (const node of ["a", "b"])
    graph.addNode({ id: id(node), state: undefined, trigger: TriggerRule.always(), step: async function* () { ran.push(node); return node; } });
  const first = context({ graph, scheduler: async () => { entered.resolve(); await gate.promise; return { selected: ids(["a"]) }; } });
  const snapshots: View[] = [];
  const second = context({ graph, scheduler: (view) => { snapshots.push(view); return { selected: ids(["b"]) }; } });
  const pending = first.step();
  try {
    await entered.promise;
    await assert.rejects(second.step(), DataflowDefinitionError);
    assert.deepEqual(ran, []);
    assert.equal(snapshots.length, 0);
  } finally {
    gate.resolve();
    await pending;
  }
  assert.deepEqual([...await second.step()], [[id("a"), "a"], [id("b"), "b"]]);
  assert.deepEqual(selections(snapshots[0]!), []);
  assert.equal(snapshots[0]!.nodes.get(id("a"))!.status, "done");
  assert.deepEqual([...graph.observe().nodes.keys()], ids(["a", "b"]));
});

for (const mutation of ["addNode", "emit"] as const) {
  test(`an async decision made stale by ${mutation} cannot activate or consume work`, async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const captured: View[] = [];
    const { graph, ran } = actors(parallel(), ["a", "b"]);
    const feed = Edge.message<number, string>("feed");
    graph.addEdge(id("a"), id("b"), feed);
    const execution = context({ graph, scheduler: async (view) => {
      captured.push(view); entered.resolve(); await gate.promise;
      return { selected: ids(["a"]) };
    } });
    const pending = execution.step();
    const rejected = assert.rejects(pending, DataflowDefinitionError);
    try {
      await entered.promise;
      if (mutation === "addNode") graph.addNode({ state: undefined, trigger: TriggerRule.always(), step: actor(ran) });
      else graph.emit(id("a"), Message.create(feed, 9));
    } finally { gate.resolve(); }
    await rejected;
    assert.deepEqual(ran, []);
    assert.ok(graph.observe().version > captured[0]!.version);
    if (mutation === "emit") assert.deepEqual(graph.observe().inputs.get(id("b"))!.messages.get(feed.id), [9]);
    await execution.step();
    assert.deepEqual(selections(captured[1]!), []);
    assert.deepEqual(ran, ["a"]);
  });
}

test("live availability and mutation inside read lowering also invalidate a decision", async () => {
  for (const loweringMutation of [false, true]) {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let available = true;
    let mutate = loweringMutation;
    const ran: string[] = [];
    const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
    graph.addNode({ id: id("a"), state: undefined, trigger: TriggerRule.always(), is_available: () => available, step: actor(ran) });
    const execution = context({
      graph,
      scheduler: async () => { entered.resolve(); await gate.promise; return { selected: ids(["a"]) }; },
      readInputs: () => {
        if (mutate) { mutate = false; graph.addNode({ state: undefined, trigger: TriggerRule.always(), step: actor(ran) }); }
        return new Map();
      },
    });
    const version = graph.observe().version;
    const rejected = assert.rejects(execution.step(), DataflowDefinitionError);
    await entered.promise;
    if (!loweringMutation) available = false;
    gate.resolve();
    await rejected;
    assert.deepEqual(ran, []);
    if (!loweringMutation) assert.equal(graph.observe().version, version);
  }
});

test("fresh external metadata is detached independently of native version and failed history", async () => {
  const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  const ran: string[] = [];
  for (const node of ["a", "b"])
    graph.addNode({ id: id(node), state: undefined, trigger: TriggerRule.always(), step: actor(ran) });
  const priorities = new Map([[id("a"), 0], [id("b"), 1]]);
  const captured: Snapshot<void, number, string, number>[] = [];
  const sentinel = new Error("planning failed");
  let fail = true;
  const ascending: Scheduler<void, number, string, number> = choose({ rank: (view, left, right) => view.context.get(left)! - view.context.get(right)! });
  const execution = context({
    graph, describeNode: (node) => priorities.get(node),
    scheduler: (view, signal) => {
      captured.push(view);
      if (fail) throw sentinel;
      return ascending(view, signal);
    },
  });
  await assert.rejects(execution.step(), (error) => error === sentinel);
  priorities.set(id("a"), 1);
  priorities.set(id("b"), 0);
  fail = false;
  await execution.step();
  assert.deepEqual(ran, ["b"]);
  assert.equal(captured[0]!.version, captured[1]!.version);
  assert.deepEqual(captured.map((view) => view.history), [[], []]);
  assert.deepEqual([...captured[0]!.context], [[id("a"), 0], [id("b"), 1]]);
  assert.deepEqual([...captured[1]!.context], [[id("a"), 1], [id("b"), 0]]);
});

test("metadata preserves falsy domains and borrowed opaque identity without freezing application objects", async () => {
  type State = { count: number };
  type Metadata = 0 | false | null | "";
  const state: State = { count: 0 };
  const graph = new DataflowGraph<State, number, string, never>(Width.create(1), UNBOUNDED);
  const names = ["zero", "false", "null", "empty", "absent"];
  for (const node of names)
    graph.addNode({ id: id(node), state, trigger: TriggerRule.always(), step: async function* () { return node; } });
  const metadata = new Map<NodeIdType, Metadata>([[id("zero"), 0], [id("false"), false], [id("null"), null], [id("empty"), ""]]);
  const captured: Snapshot<State, number, string, Metadata>[] = [];
  const execution = context({ graph, describeNode: (node) => metadata.get(node), scheduler: (view, signal) => { captured.push(view); return parallel()(view, signal); } });
  await execution.run();
  assert.deepEqual([...captured[0]!.context], [...metadata]);
  assert.equal(captured[0]!.nodes.get(id("zero"))!.state, state);
  state.count = 1;
  assert.equal(captured[0]!.nodes.get(id("zero"))!.state.count, 1);
  assert.equal(captured[0]!.nodes.get(id("zero"))!.status, "ready");
});

test("drained failed columns commit actual lane-order history before propagating failure", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const sentinel = new DataflowDefinitionError("work failed");
  const graph: Graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  graph.addNode({ id: id("bad"), state: undefined, trigger: TriggerRule.always(), step: async function* () { throw sentinel; } });
  graph.addNode({ id: id("slow"), state: undefined, trigger: TriggerRule.always(), step: async function* () { entered.resolve(); await gate.promise; yield []; return "slow"; } });
  const captured: View[] = [];
  const execution = context({ graph, scheduler: (view, signal) => { captured.push(view); return parallel()(view, signal); } });
  let settled = false;
  const observed = execution.step().then(
    () => { settled = true; return undefined; },
    (error: unknown) => { settled = true; return error; },
  );
  try {
    await entered.promise;
    await nextTurn();
    assert.equal(settled, false);
  } finally {
    gate.resolve();
    await observed;
  }
  assert.equal(await observed, sentinel);
  assert.deepEqual([...await execution.run()], [[id("slow"), "slow"]]);
  assert.deepEqual(selections(captured[0]!), []);
  assert.deepEqual(selections(captured[1]!), [["bad", "slow"]]);
  assert.equal(Object.isFrozen(captured[1]!.history), true);
  assert.equal(Object.isFrozen(captured[1]!.history[0]), true);
  assert.equal(Object.isFrozen(captured[1]!.history[0]!.selected), true);
});

test("cancellation after either policy settlement wins without committing work", async () => {
  for (const rejectedPolicy of [false, true]) {
    const gate = Promise.withResolvers<Decision>();
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("original cancellation");
    let waiting = true;
    const captured: View[] = [];
    const { graph, ran } = actors(parallel(), ["a"]);
    const execution = context({ graph, scheduler: async (view) => {
      captured.push(view);
      if (waiting) { entered.resolve(); return gate.promise; }
      return { selected: ids(["a"]) };
    } });
    const version = graph.observe().version;
    const rejected = assert.rejects(execution.step({ signal: controller.signal }), (error) => error === reason);
    await entered.promise;
    controller.abort(reason);
    if (rejectedPolicy) gate.reject(new Error("provider error"));
    else gate.resolve({ selected: ids(["a"]) });
    await rejected;
    assert.deepEqual(ran, []);
    assert.equal(graph.observe().version, version);
    waiting = false;
    await execution.step();
    assert.deepEqual(selections(captured[1]!), []);
  }
});

test("policies/compositions remain outside native topology, identities and retained results", async () => {
  const graph: Graph = new DataflowGraph(Width.create(1), Width.create(2));
  const captured: View[] = [];
  const hybrid: Policy = separate((_s, node) => node === id("0"), roundRobin(), parallel());
  const execution = context({ graph, scheduler: (view, signal) => { captured.push(view); return hybrid(view, signal); } });
  const zero = graph.addNode({ description: "", state: undefined, trigger: TriggerRule.always(), step: async function* () { yield []; return "0"; } });
  const one = graph.addNode({ state: undefined, trigger: TriggerRule.always(), step: async function* () { return "1"; } });
  assert.deepEqual([zero, one], ids(["0", "1"]));
  graph.addEdge(zero, one, Edge.message<number, string>("shared"));
  graph.addEdge(one, zero, Edge.value<number, string>("shared"));
  graph.addEdge(zero, zero, Edge.message<number, string>("self"));
  graph.addEdge(zero, one, Edge.value<number, string>("parallel"));
  const result = await execution.run();
  assert.deepEqual(new Set(result.keys()), new Set(ids(["0", "1"])));
  assert.deepEqual([...captured[1]!.nodes].map(([node, fields]) => [node, fields.status]), [["0", "running"], ["1", "done"]]);
  assert.equal(captured[0]!.nodes.get(zero)!.description, "");
  assert.deepEqual(captured[1]!.links, [["0", "1", "shared", "message"], ["1", "0", "shared", "value"], ["0", "0", "self", "message"], ["0", "1", "parallel", "value"]]);
  assert.deepEqual(selections(captured[1]!), [["0", "1"]]);
  assert.equal(graph.addNode({ state: undefined, trigger: TriggerRule.always(), step: async function* () { return "2"; } }), id("2"));
  assert.deepEqual([...captured[0]!.nodes.keys()], ids(["0", "1"]));
});
