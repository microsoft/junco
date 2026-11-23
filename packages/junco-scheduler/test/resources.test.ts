import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  admitToolCall,
  chargeTokenUsage,
  DataflowDefinitionError,
  DataflowGraph,
  gibibytes,
  gigabytes,
  isUsageLimitError,
  megabytes,
  NodeId,
  type NodeIdType,
  type ResourceKind,
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
type View = Snapshot<void, typeof StringSchema, string, never>;
type Policy = Scheduler<void, typeof StringSchema, string, never>;

const memory = (...mb: number[]) =>
  new Map([["memory" as const, mb.map((n) => n * megabytes.scale)]]);

function snapshot(
  histories: Record<
    string,
    ReadonlyMap<ResourceKind, readonly number[]> | undefined
  >,
): View {
  const names = Object.keys(histories).map(id);
  return Object.freeze({
    nodes: new Map(
      names.map((node) => [
        node,
        {
          id: node,
          status: "running" as const,
          state: undefined,
        },
      ]),
    ),
    measurements: new Map(
      names.flatMap((node) => {
        const samples = histories[node];
        return samples === undefined ? [] : [[node, samples] as const];
      }),
    ),
    inputs: new Map(),
    links: [],
    results: new Map(),
    version: 0,
    available: new Set(names),
    owned: new Set(names),
    context: new Map<NodeIdType, never>(),
    plans: new Map(names.map((node) => [node, new Map()])),
    history: [],
    threads: Infinity,
  });
}

test("rank by latest observation, then unmeasured nodes; ties break by raw ID", async () => {
  for (const kind of ["cost", "tokens", "runtime", "memory"] as const) {
    const s = snapshot({
      d: new Map([[kind, [0, 20]]]),
      z: undefined,
      c: new Map([[kind, [100, 5]]]),
      b: new Map([[kind, [5]]]),
      a: new Map([[kind, []]]),
      e: new Map([[kind, [0]]]),
    });
    for (const [rank, order] of [
      [lowest, ["e", "b", "c", "d", "a", "z"]],
      [highest, ["d", "b", "c", "e", "a", "z"]],
    ] as const) {
      const decision = await choose({ rank: rank(kind), width: () => 6 })(s);
      assert.deepEqual(nodeIds(decision.selected), order);
    }
  }
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
            B: new Map([["memory", [3 * gibibytes.scale]]]),
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
  assert.deepEqual(
    nodeIds((await limited(snapshot({ n: undefined }))).selected),
    [id("n")],
  );
  assert.throws(
    () => limit({ memory: megabytes(0) }, parallel()),
    /must be a positive quantity/,
  );
  await assert.rejects(
    async () =>
      limit({ memory: gigabytes(4) }, (view) => ({
        selected: select(view, [id("unowned")]),
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
    { selected: select(s, [id("A"), id("D")], 3) },
  );
});

test("memory admission uses the retained peak, never pairs unknowns, and honors measured zero", async () => {
  const policy = limit({ memory: megabytes(10) }, parallel());
  for (const [samples, expected] of [
    [{ a: memory(8, 1), b: memory(3), c: memory(2) }, ["a", "c"]],
    [{ a: undefined, b: memory(0), c: undefined }, ["a"]],
    [{ a: memory(0), b: memory(), c: memory(10) }, ["a", "c"]],
    [{ a: memory(20), b: undefined, c: memory(0) }, ["b"]],
  ] as const) {
    assert.deepEqual(
      nodeIds((await policy(snapshot(samples))).selected),
      expected,
    );
  }
});

test("calibrated byte floors cannot reduce observed memory or pair an uncalibrated cold start", async () => {
  const s = snapshot({
    a: memory(1),
    b: memory(6),
    c: undefined,
    d: undefined,
  });
  const floors: Record<string, number> = { a: 8e6, b: 0, d: 2e6 };
  const options = {
    memory: megabytes(10),
    memoryFloor: (node: NodeIdType) => floors[node],
  };
  assert.deepEqual(nodeIds((await limit(options, parallel())(s)).selected), [
    "a",
    "d",
  ]);
  for (const invalid of [-1, 0.5, Infinity, NaN, 2 ** 53])
    await assert.rejects(
      async () =>
        limit({ ...options, memoryFloor: () => invalid }, parallel())(s),
      /non-negative safe integer in bytes/,
    );
});

test("limit checks cancellation before invocation and after awaited inner work", async () => {
  const calls: NodeIdType[] = [];
  const s = snapshot({ a: memory(1) });
  const options = {
    memory: gigabytes(4),
    memoryFloor: (node: NodeIdType) => {
      calls.push(node);
      return 0;
    },
  };
  const reason = new Error("cancel resource scheduling");
  const before = new AbortController();
  before.abort(reason);
  let invoked = false;
  await assert.rejects(
    async () =>
      limit(options, (view) => {
        invoked = true;
        return { selected: select(view, [id("a")]) };
      })(s, before.signal),
    (error) => error === reason,
  );
  assert.equal(invoked, false);
  const after = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = limit(options, async (view) => {
    entered.resolve();
    await release.promise;
    return { selected: select(view, [id("a")]) };
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
 * returning after the last.
 */
function callers(
  scheduler: UsagePolicy,
  plan: Record<string, readonly number[]>,
) {
  const graph = new DataflowGraph<void, never, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const calls: string[] = [];
  for (const [name, activations] of Object.entries(plan)) {
    graph.addNode({
      id: id(name),
      state: undefined,
      trigger: TriggerRule.always(),
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

test("memory admission beside a hard usage budget charges only admitted work", async () => {
  const perBatch = callers(
    limit({ memory: megabytes(10), tools: 1, scope: "batch" }, parallel()),
    { a: [1], b: [1] },
  );
  await perBatch.execution.run();
  assert.deepEqual(perBatch.calls, ["a", "b"]);
  const perRun = callers(
    limit({ memory: megabytes(10), tools: 1 }, parallel()),
    { a: [1], b: [1] },
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
    { tools: 1, memoryFloor: () => 1 },
    { memory: gigabytes(1), memoryFloor: 1 },
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
