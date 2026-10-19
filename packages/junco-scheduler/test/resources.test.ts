import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  EdgeId,
  type FeatureVector,
  gibibytes,
  gigabytes,
  type InputSchedule,
  megabytes,
  NodeId,
  type NodeIdType,
  type ParentView,
  type PortFeature,
  type ProfileData,
  type ProfileSet,
  type ResourceKind,
  type ResourceUnit,
  tokens,
} from "dataflow-engine";
import {
  choose,
  highest,
  limit,
  lowest,
  parallel,
  type Scheduler,
  type Snapshot,
} from "../src/index.ts";

const id = NodeId.create;
const port = EdgeId.create;
type View = Snapshot<void, string, string, never>;
type Policy = Scheduler<void, string, string, never>;

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
    const view: ParentView<string, string> = {
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
      (await choose({ rank: comparator, width: () => 3 })(s)).selected,
      expected.map(id),
    );
    assert.deepEqual(
      calls.map((c) => c.length),
      [1, 1, 1],
    );
    assert.deepEqual(
      (await choose({ rank: comparator, width: () => 1 })(s)).selected,
      [id(expected[0])],
    );
    assert.deepEqual(
      calls.map((c) => c.length),
      [1, 1, 1],
    );
    const ties = snapshot({ b: tokenCost(100), a: tokenCost(100) });
    assert.deepEqual(
      (await choose({ rank: rank("tokens"), width: () => 2 })(ties)).selected,
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
    (await choose({ rank: lowest("memory"), width: () => 2 })(s)).selected,
    [id("a"), id("b")],
  );
  assert.deepEqual(
    (await choose({ rank: highest("memory"), width: () => 2 })(s)).selected,
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
  assert.deepEqual((await limited(s)).selected, [id("A"), id("D")]);
  const ranked: Policy = choose({
    rank: (s, a, b) => b.localeCompare(a),
    width: () => 4,
  });
  assert.deepEqual(
    (await limit({ memory: gigabytes(4) }, ranked)(s)).selected,
    [id("D"), id("C")],
  );
  assert.deepEqual(
    (await limited(snapshot({ C: memory(2000), D: memory(1000) }))).selected,
    [id("C"), id("D")],
  );
  assert.deepEqual(
    (
      await limited(
        snapshot({
          A: memory(3000),
          B: { memory: stub("memory", gibibytes, [], () => 3) },
        }),
      )
    ).selected,
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
      limit({ memory: gigabytes(4) }, () => ({ selected: [id("unowned")] }))(s),
    /unowned/,
  );
  assert.deepEqual(
    await limit({ memory: gigabytes(4) }, () => ({ selected: [] }))(s),
    { selected: [] },
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
    assert.deepEqual((await scheduler(view)).selected, [id(expected)]);
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
    (await limit({ memory: gigabytes(4) }, parallel())(s)).selected,
    [id("a")],
  );
  assert.deepEqual(
    (await choose({ rank: lowest("tokens"), width: () => 1 })(s)).selected,
    [id("b")],
  );
  assert.deepEqual(
    (await choose({ rank: highest("tokens"), width: () => 1 })(s)).selected,
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
        return { selected: [id("a")] };
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
    return { selected: [id("a")] };
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
