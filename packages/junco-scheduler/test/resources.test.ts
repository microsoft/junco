import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  admitToolCall,
  chargeTokenUsage,
  constantProfile,
  DataflowDefinitionError,
  DataflowGraph,
  EdgeId,
  type FeatureVector,
  gibibytes,
  gigabytes,
  type InputSchedule,
  isUsageLimitError,
  megabytes,
  NodeId,
  type NodeIdType,
  type ParentView,
  type PortFeature,
  type ProfileData,
  type ProfileSet,
  type ResourceKind,
  type ResourceUnit,
  TriggerRule,
  tokens,
  UNBOUNDED,
  type UsageLimitError,
  Width,
} from "dataflow-engine";
import { Type } from "typebox";
import {
  choose,
  context,
  highest,
  type LimitOptions,
  limit,
  lowest,
  nodeIds,
  parallel,
  type Scheduler,
  type Snapshot,
  select,
  separate,
  strength,
} from "../src/index.ts";

const StringSchema = Type.String();

const id = NodeId.create;
const port = EdgeId.create;
type View = Snapshot<void, typeof StringSchema, string, never>;
type Policy = Scheduler<void, typeof StringSchema, string, never>;

function stub<R extends ResourceKind>(
  resource: R,
  unit: ResourceUnit<R>,
  features: PortFeature[],
  safe: (x: FeatureVector) => number,
  calls?: FeatureVector[],
  predictedValue?: number,
): ProfileData<R> {
  return {
    resource,
    unit,
    features,
    predict: (x) => {
      calls?.push([...x]);
      const value = safe(x);
      return { value: predictedValue ?? value, safe: value, source: "model" };
    },
  };
}
const memory = (safe: number) => ({
  memory: stub("memory", megabytes, [], () => safe),
});
const tokenCost = (safe: number, calls?: FeatureVector[]) => ({
  tokens: stub("tokens", tokens, [], () => safe, calls),
});

function snapshot(
  profiles: Record<string, ProfileSet>,
  inputs: View["inputs"] = new Map(),
  plans?: View["plans"],
): View {
  const names = Object.keys(profiles).map(id);
  return Object.freeze({
    nodes: new Map(
      names.map((node) => [
        node,
        {
          id: node,
          status: "running" as const,
          state: undefined,
          profiles: profiles[node]!,
        },
      ]),
    ),
    inputs: new Map(
      names.map((node) => [
        node,
        inputs.get(node) ?? { messages: new Map(), values: new Map() },
      ]),
    ),
    links: [],
    results: new Map(),
    version: 0,
    available: new Set(names),
    owned: new Set(names),
    context: new Map<NodeIdType, never>(),
    plans: plans ?? new Map(names.map((node) => [node, new Map()])),
    history: [],
    threads: Infinity,
  });
}

test("resource features estimate only the planned count batch", async () => {
  const cases: {
    features: PortFeature[];
    queues: Record<string, string[]>;
    plan: InputSchedule;
    expected: number;
  }[] = [
    {
      features: [{ port: port("in"), measure: "count" }],
      queues: { in: ["a", "b", "c"] },
      plan: new Map([[port("in"), 2]]),
      expected: 2,
    },
    {
      features: [{ port: port("in"), measure: "count" }],
      queues: { in: ["a", "b", "c"] },
      plan: new Map([[port("in"), "all"]]),
      expected: 3,
    },
    {
      features: [{ port: port("in"), measure: "count" }],
      queues: { in: ["a", "b", "c"] },
      plan: new Map(),
      expected: 0,
    },
    {
      features: [{ port: port("in"), measure: "count" }],
      queues: { in: ["a"] },
      plan: new Map([[port("in"), 9]]),
      expected: 1,
    },
    {
      features: [{ port: port("in"), measure: "count" }],
      queues: { in: ["a"] },
      plan: new Map([[port("in"), "none"]]),
      expected: 0,
    },
    ...(["sum", "max"] as const).map((derived) => ({
      features: [
        { derived, measure: "count" as const, ports: [port("a"), port("b")] },
      ],
      queues: { a: ["a"], b: ["b", "c"] },
      plan: new Map([
        [port("a"), "all" as const],
        [port("b"), "all" as const],
      ]),
      expected: derived === "sum" ? 3 : 2,
    })),
  ];
  for (const row of cases) {
    const calls: FeatureVector[] = [];
    const view: ParentView<typeof StringSchema, string> = {
      messages: new Map(
        Object.entries(row.queues).map(([p, q]) => [port(p), q]),
      ),
      values: new Map(),
    };
    const s = snapshot(
      {
        n: { memory: stub("memory", megabytes, row.features, () => 1, calls) },
      },
      new Map([[id("n"), view]]),
      new Map([[id("n"), row.plan]]),
    );
    await limit({ memory: gigabytes(1) }, parallel())(s);
    assert.deepEqual(calls, [[row.expected]]);
  }
  for (const measure of ["bytes", "tokens"] as const) {
    const s = snapshot({
      n: {
        memory: stub(
          "memory",
          megabytes,
          [{ port: port("in"), measure }],
          () => 1,
        ),
      },
    });
    await assert.rejects(
      async () => limit({ memory: gigabytes(1) }, parallel())(s),
      /only "count" features/,
    );
  }
});

test("lowest and highest rank safe estimates, cache predictions and break ties by raw ID", async () => {
  for (const [rank, expected] of [
    [lowest, ["b", "a", "c"]],
    [highest, ["c", "a", "b"]],
  ] as const) {
    const calls = [[], [], []] as FeatureVector[][];
    const s = snapshot({
      a: tokenCost(300, calls[0]),
      b: tokenCost(100, calls[1]),
      c: tokenCost(900, calls[2]),
    });
    const comparator = rank("tokens");
    assert.deepEqual(
      nodeIds((await choose({ rank: comparator, width: () => 3 })(s)).selected),
      expected.map(id),
    );
    assert.deepEqual(
      calls.map((c) => c.length),
      [1, 1, 1],
    );
    assert.deepEqual(
      nodeIds((await choose({ rank: comparator, width: () => 1 })(s)).selected),
      [id(expected[0])],
    );
    assert.deepEqual(
      calls.map((c) => c.length),
      [1, 1, 1],
    );
    const ties = snapshot({ b: tokenCost(100), a: tokenCost(100) });
    assert.deepEqual(
      nodeIds(
        (await choose({ rank: rank("tokens"), width: () => 2 })(ties)).selected,
      ),
      [id("a"), id("b")],
    );
    await assert.rejects(
      async () =>
        choose({ rank: rank("tokens") })(
          snapshot({ a: tokenCost(100), b: {} }),
        ),
      new RegExp(`${rank.name}: node "b" has no tokens profile`),
    );
  }
  const s = snapshot({
    a: { memory: stub("memory", gibibytes, [], () => 1) },
    b: memory(3000),
  });
  assert.deepEqual(
    nodeIds(
      (await choose({ rank: lowest("memory"), width: () => 2 })(s)).selected,
    ),
    [id("a"), id("b")],
  );
  assert.deepEqual(
    nodeIds(
      (await choose({ rank: highest("memory"), width: () => 2 })(s)).selected,
    ),
    [id("b"), id("a")],
  );
});

test("limit preserves inner order, skips oversized work and rejects invalid decisions", async () => {
  const s = snapshot({
    A: memory(3000),
    B: memory(3000),
    C: memory(2000),
    D: memory(1000),
  });
  const limited = limit({ memory: gigabytes(4) }, parallel());
  assert.deepEqual(nodeIds((await limited(s)).selected), [id("A"), id("D")]);
  const ranked: Policy = choose({
    rank: (_s, a, b) => b.localeCompare(a),
    width: () => 4,
  });
  assert.deepEqual(
    nodeIds((await limit({ memory: gigabytes(4) }, ranked)(s)).selected),
    [id("D"), id("C")],
  );
  assert.deepEqual(
    nodeIds(
      (await limited(snapshot({ C: memory(2000), D: memory(1000) }))).selected,
    ),
    [id("C"), id("D")],
  );
  assert.deepEqual(
    nodeIds(
      (
        await limited(
          snapshot({
            A: memory(3000),
            B: { memory: stub("memory", gibibytes, [], () => 3) },
          }),
        )
      ).selected,
    ),
    [id("A")],
  );
  await assert.rejects(
    async () => limited(snapshot({ n: memory(5000) })),
    /alone, exceeding/,
  );
  await assert.rejects(
    async () => limited(snapshot({ n: {} })),
    /has no memory profile/,
  );
  assert.throws(
    () => limit({ memory: megabytes(0) }, parallel()),
    /must be a positive quantity/,
  );
  await assert.rejects(
    async () =>
      limit({ memory: gigabytes(4) }, () => ({
        selected: select([id("unowned")]),
      }))(s),
    /unowned/,
  );
  assert.deepEqual(
    await limit({ memory: gigabytes(4) }, () => ({ selected: [] }))(s),
    { selected: [] },
  );
  assert.deepEqual(
    await limit(
      { memory: gigabytes(4) },
      strength(() => "high", parallel()),
    )(s),
    { selected: select([id("A"), id("D")], 3) },
  );
});

test("one rank comparator caches each snapshot independently", async () => {
  const calls = [[], [], [], []] as FeatureVector[][];
  const first = snapshot({
    a: tokenCost(300, calls[0]),
    b: tokenCost(100, calls[1]),
  });
  const second = snapshot({
    a: tokenCost(10, calls[2]),
    b: tokenCost(200, calls[3]),
  });
  const scheduler = choose({ rank: lowest("tokens"), width: () => 1 });
  for (const [view, expected] of [
    [first, "b"],
    [second, "a"],
    [first, "b"],
  ] as const)
    assert.deepEqual(nodeIds((await scheduler(view)).selected), [id(expected)]);
  assert.deepEqual(
    calls.map((c) => c.length),
    [1, 1, 1, 1],
  );
});

test("memory admission and token ranking use safe rather than value", async () => {
  const s = snapshot({
    a: {
      memory: stub("memory", megabytes, [], () => 3000, undefined, 0),
      tokens: stub("tokens", tokens, [], () => 900, undefined, 1),
    },
    b: {
      memory: stub("memory", megabytes, [], () => 3000, undefined, 0),
      tokens: stub("tokens", tokens, [], () => 100, undefined, 900),
    },
  });
  assert.deepEqual(
    nodeIds((await limit({ memory: gigabytes(4) }, parallel())(s)).selected),
    [id("a")],
  );
  assert.deepEqual(
    nodeIds(
      (await choose({ rank: lowest("tokens"), width: () => 1 })(s)).selected,
    ),
    [id("b")],
  );
  assert.deepEqual(
    nodeIds(
      (await choose({ rank: highest("tokens"), width: () => 1 })(s)).selected,
    ),
    [id("a")],
  );
});

test("limit checks cancellation before invocation and after awaited inner work", async () => {
  const calls: FeatureVector[] = [];
  const s = snapshot({
    a: { memory: stub("memory", megabytes, [], () => 1, calls) },
  });
  const reason = new Error("cancel resource scheduling");
  const before = new AbortController();
  before.abort(reason);
  let invoked = false;
  await assert.rejects(
    async () =>
      limit({ memory: gigabytes(4) }, () => {
        invoked = true;
        return { selected: select([id("a")]) };
      })(s, before.signal),
    (error) => error === reason,
  );
  assert.equal(invoked, false);
  const after = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = limit({ memory: gigabytes(4) }, async () => {
    entered.resolve();
    await release.promise;
    return { selected: select([id("a")]) };
  })(s, after.signal);
  await entered.promise;
  after.abort(reason);
  release.resolve();
  await assert.rejects(
    async () => pending,
    (error) => error === reason,
  );
  assert.deepEqual(calls, []);
});

// Usage budgets on real engine graphs ------------------------------------------------------------

type UsageGraph = DataflowGraph<void, never, string, never>;
type UsagePolicy = Scheduler<void, never, string, never>;

/**
 * One node per `plan` entry, making `plan[name][k]` tool calls in its k-th activation and
 * returning after the last, with a constant memory profile of `memory[name]` megabytes (default 0).
 */
function callers(
  scheduler: UsagePolicy,
  plan: Record<string, readonly number[]>,
  memory: Record<string, number> = {},
) {
  const graph = new DataflowGraph<void, never, string, never, "memory">(
    Width.create(1),
    UNBOUNDED,
  );
  const calls: string[] = [];
  for (const [name, activations] of Object.entries(plan)) {
    graph.addNode({
      id: id(name),
      state: undefined,
      trigger: TriggerRule.always(),
      profiles: {
        memory: constantProfile("memory", megabytes(memory[name] ?? 0)),
      },
      step: async function* () {
        for (const [index, count] of activations.entries()) {
          for (let call = 0; call < count; call++) {
            await Promise.resolve();
            admitToolCall();
            calls.push(name);
          }
          if (index === activations.length - 1) return name;
          yield [];
        }
        return name;
      },
    });
  }
  return { calls, execution: context({ graph, scheduler }) };
}

async function exhausted(work: Promise<unknown>): Promise<UsageLimitError> {
  try {
    await work;
  } catch (error) {
    assert.ok(isUsageLimitError(error), String(error));
    return error;
  }
  assert.fail("expected a usage limit failure");
}

test("an evaluation budget spans activations and decisions of one run; each step is fresh", async () => {
  const run = callers(limit({ tools: 1 }, parallel()), { a: [1, 1] });
  const error = await exhausted(run.execution.run());
  assert.deepEqual(run.calls, ["a"]);
  assert.deepEqual(
    { ...error.details },
    {
      resource: "tools",
      scope: "evaluation",
      limit: 1,
      used: 1,
      requested: 1,
      attempted: 2,
      exceededBy: 1,
      nodePath: ["a"],
    },
  );
  const activation = callers(
    limit({ tools: 1, scope: "activation" }, parallel()),
    { a: [1, 1] },
  );
  await activation.execution.run();
  assert.deepEqual(activation.calls, ["a", "a"]);
  const stepped = callers(limit({ tools: 1 }, parallel()), { a: [1, 1] });
  await stepped.execution.step();
  await stepped.execution.step();
  assert.deepEqual(stepped.calls, ["a", "a"]);
});

test("a batch budget is shared by one decision's nodes and resets for the next", async () => {
  const column = callers(limit({ tools: 1, scope: "batch" }, parallel()), {
    a: [1],
    b: [1],
  });
  const error = await exhausted(column.execution.step());
  assert.equal(column.calls.length, 1);
  assert.equal(error.details.scope, "batch");
  const each = callers(limit({ tools: 1, scope: "activation" }, parallel()), {
    a: [1],
    b: [1],
  });
  await each.execution.step();
  assert.deepEqual(each.calls.sort(), ["a", "b"]);
  const later = callers(limit({ tools: 1, scope: "batch" }, parallel()), {
    a: [1, 1],
  });
  await later.execution.run();
  assert.deepEqual(later.calls, ["a", "a"]);
});

test("ledgers belong to limit instances and invocations, never to a scheduler shared by contexts", async () => {
  const shared = limit({ tools: 1 }, parallel());
  const first = callers(shared, { a: [1] });
  const second = callers(shared, { b: [1] });
  await Promise.all([first.execution.run(), second.execution.run()]);
  assert.deepEqual([...first.calls, ...second.calls], ["a", "b"]);

  const ownsA = (_snapshot: unknown, node: NodeIdType) => node === id("a");
  const distinct = callers(
    separate(
      ownsA,
      limit({ tools: 1 }, parallel()),
      limit({ tools: 1 }, parallel()),
    ),
    { a: [1], b: [1] },
  );
  await distinct.execution.run();
  assert.equal(distinct.calls.length, 2);
  const reused = limit({ tools: 1 }, parallel());
  const branches = callers(separate(ownsA, reused, reused), {
    a: [1],
    b: [1],
  });
  await exhausted(branches.execution.run());
  assert.equal(branches.calls.length, 1);

  for (const scheduler of [
    strength(() => "high", limit({ tools: 1 }, parallel())),
    limit(
      { tools: 1 },
      strength(() => "high", parallel()),
    ),
  ]) {
    const strong = callers(scheduler, { a: [1], b: [1] });
    await exhausted(strong.execution.run());
    assert.equal(strong.calls.length, 1);
  }
});

test("nested limits each count every call exactly once", async () => {
  const nested = () =>
    limit({ tools: 3 }, limit({ tools: 1, scope: "activation" }, parallel()));
  const fits = callers(nested(), { a: [1], b: [1], c: [1] });
  await fits.execution.run();
  assert.equal(fits.calls.length, 3);
  const outer = callers(nested(), { a: [1], b: [1], c: [1], d: [1] });
  const outerError = await exhausted(outer.execution.run());
  assert.equal(outer.calls.length, 3);
  assert.equal(outerError.details.scope, "evaluation");
  assert.equal(outerError.details.limit, 3);
  const inner = callers(nested(), { a: [2] });
  const innerError = await exhausted(inner.execution.run());
  assert.deepEqual(inner.calls, ["a"]);
  assert.equal(innerError.details.scope, "activation");
});

test("memory stays a per-decision prediction beside usage budgets; skipped work consumes nothing", async () => {
  const perBatch = callers(
    limit({ memory: megabytes(10), tools: 1, scope: "batch" }, parallel()),
    { a: [1], b: [1] },
    { a: 6, b: 6 },
  );
  await perBatch.execution.run();
  assert.deepEqual(perBatch.calls, ["a", "b"]);
  const perRun = callers(
    limit({ memory: megabytes(10), tools: 1 }, parallel()),
    { a: [1], b: [1] },
    { a: 6, b: 6 },
  );
  await exhausted(perRun.execution.run());
  assert.deepEqual(perRun.calls, ["a"]);
});

test("token limits normalize their unit; invalid usage options are rejected", async () => {
  const graph: UsageGraph = new DataflowGraph(Width.create(1), UNBOUNDED);
  graph.addNode({
    id: id("a"),
    state: undefined,
    trigger: TriggerRule.always(),
    // Two activations of one run share its evaluation ledger.
    step: async function* () {
      chargeTokenUsage(6);
      yield [];
      chargeTokenUsage(5);
      return "a";
    },
  });
  const execution = context({
    graph,
    scheduler: limit(
      { tokens: tokens.withSiPrefix("k")(0.01) },
      parallel() as UsagePolicy,
    ),
  });
  const error = await exhausted(execution.run());
  assert.equal(error.details.limit, 10);
  assert.equal(error.details.exceededBy, 1);

  for (const options of [
    {},
    { tool: 1 },
    { tools: { read: 1 } },
    { tools: -1 },
    { tools: 1, scope: "global" },
    { memory: gigabytes(1), scope: "batch" },
    { tokens: megabytes(1) },
    { tokens: tokens(1.5) },
    { tokens: tokens(-1) },
  ])
    assert.throws(
      () => limit(options as LimitOptions, parallel()),
      DataflowDefinitionError,
    );
  // Zero is a deny-all budget.
  const denied = callers(limit({ tools: 0 }, parallel()), { a: [1] });
  assert.equal((await exhausted(denied.execution.run())).details.used, 0);
});

test("a usage failure inside a cleanup aggregate bypasses on_error and keeps both errors", async () => {
  const graph: UsageGraph = new DataflowGraph(Width.create(1), UNBOUNDED);
  const cleanup = new Error("cleanup failed");
  let recovered = false;
  graph.addNode({
    id: id("a"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      yield [];
      try {
        admitToolCall();
      } catch (error) {
        throw new AggregateError([error, cleanup], "work and cleanup failed", {
          cause: error,
        });
      }
      return "a";
    },
    on_error: async () => {
      recovered = true;
      return [];
    },
  });
  const execution = context({
    graph,
    scheduler: limit({ tools: 0 }, parallel() as UsagePolicy),
  });
  const error: unknown = await execution.run().then(
    () => assert.fail("expected the aggregate"),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof AggregateError);
  assert.ok(isUsageLimitError(error.errors[0]));
  assert.equal(error.errors[1], cleanup);
  assert.equal(recovered, false);
});
