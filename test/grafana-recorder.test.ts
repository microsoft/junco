import { afterEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tracer } from "junco";

const COLLECTION =
  "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards";
const ITEM = `${COLLECTION}/junco-telemetry`;

type Seen = {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly type: string | undefined;
  readonly body: string;
};
type Line = {
  readonly measurement: string;
  readonly tags: Record<string, string>;
  readonly fields: Record<string, number>;
  readonly time: string;
};
type Fake = {
  readonly url: string;
  readonly seen: Seen[];
  readonly pushes: () => Seen[];
  /** Resolves once `count` pushes arrived (the response may still be in flight). */
  readonly pushed: (count: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

const servers: Fake[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const send = (res: ServerResponse, status: number, body: unknown = {}) =>
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));

/** A Grafana stand-in at the HTTP boundary; `respond` may answer a request first. */
async function fakeGrafana(
  respond?: (seen: Seen, res: ServerResponse) => boolean,
  dashboard?: Record<string, unknown>,
): Promise<Fake> {
  const seen: Seen[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  let stored = dashboard;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = {
      method: req.method ?? "",
      path: req.url ?? "",
      auth: req.headers.authorization,
      type: req.headers["content-type"],
      body,
    };
    seen.push(request);
    const pushes = seen.filter((s) => s.path.startsWith("/api/live/push/"));
    for (const waiter of waiters.splice(0))
      if (pushes.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    if (respond?.(request, res)) return;
    if (request.auth !== undefined)
      return send(res, 400, { message: "unexpected Authorization" });
    if (request.path === ITEM && request.method === "GET")
      return stored ? send(res, 200, stored) : send(res, 404);
    if (request.path === COLLECTION && request.method === "POST") {
      stored = {
        ...JSON.parse(body),
        metadata: { name: "junco-telemetry", resourceVersion: "1" },
      };
      return send(res, 201, stored);
    }
    if (request.path === ITEM && request.method === "PUT") {
      stored = JSON.parse(body);
      return send(res, 200, stored);
    }
    if (request.path.startsWith("/api/live/push/") && request.method === "POST")
      return send(res, 200);
    send(res, 404);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const fake: Fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    pushes: () =>
      seen.filter((request) => request.path.startsWith("/api/live/push/")),
    pushed: (count: number) => {
      const waiter = Promise.withResolvers<void>();
      if (fake.pushes().length >= count) waiter.resolve();
      else waiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
  servers.push(fake);
  return fake;
}

/** `text` split at unescaped `separator`s, escapes kept. */
function split(text: string, separator: string): string[] {
  const parts = [""];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (char === "\\") parts[parts.length - 1] += char + (text[++i] ?? "");
    else if (char === separator) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts;
}
const unescapeTag = (text: string) => text.replace(/\\([\\,= ])/g, "$1");

/** Influx line protocol, as Grafana Live parses it. */
function parse(body: string): Line[] {
  assert.ok(body.endsWith("\n"));
  return body
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const [head = "", fields = "", time = "", ...rest] = split(line, " ");
      assert.equal(rest.length, 0, line);
      const [measurement = "", ...tags] = split(head, ",");
      return {
        measurement,
        tags: Object.fromEntries(
          tags.map((pair) => split(pair, "=").map(unescapeTag)),
        ),
        fields: Object.fromEntries(
          fields.split(",").map((pair) => {
            const [name = "", value = ""] = pair.split("=");
            assert.match(name, /^[a-z][a-z0-9_]*$/);
            assert.match(value, /^-?[0-9.e+-]+$/);
            return [name, Number(value)];
          }),
        ),
        time,
      };
    });
}

const lastPush = (fake: Fake) => {
  const push = fake.pushes().at(-1);
  assert.ok(push);
  return parse(push.body);
};
const fieldsOf = (
  lines: readonly Line[],
  measurement: string,
  tags: Record<string, string> = {},
) => {
  const matches = lines.filter(
    (candidate) =>
      candidate.measurement === measurement &&
      Object.keys(candidate.tags).length === Object.keys(tags).length + 1 &&
      Object.entries(tags).every(
        ([key, value]) => candidate.tags[key] === value,
      ),
  );
  assert.ok(matches.length, `${measurement} ${JSON.stringify(tags)}`);
  return Object.fromEntries(
    matches.map((line) => [line.tags.metric, line.fields.value]),
  );
};

const open = (
  fake: Fake,
  options: Partial<tracer.GrafanaRecorderOptions> = {},
) =>
  tracer.GrafanaRecorder.create({
    url: fake.url,
    intervalMs: 3_600_000,
    ...options,
  });

const sample = (values: Partial<Record<string, number>> = {}) => ({
  elapsedMs: 0,
  memoryBytes: 0,
  memoryPeakBytes: 0,
  cpuUsageMs: 0,
  cpuUserMs: 0,
  cpuSystemMs: 0,
  cpuThrottledMs: 0,
  pids: 0,
  oomKills: 0,
  ...values,
});
const usage = (values: {
  totalTokens: number;
  input?: number;
  output?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  cost?: number;
  costInput?: number;
}) => ({
  input: values.input ?? 0,
  output: values.output ?? 0,
  cacheRead: 0,
  cacheWrite: values.cacheWrite1h ?? 0,
  ...(values.cacheWrite1h === undefined
    ? {}
    : { cacheWrite1h: values.cacheWrite1h }),
  ...(values.reasoning === undefined ? {} : { reasoning: values.reasoning }),
  totalTokens: values.totalTokens,
  cost: {
    input: values.costInput ?? values.cost ?? 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: values.cost ?? 0,
  },
});
const recordUsage = (
  view: tracer.ProfileRecorder<"tokens" | "cost">,
  values: Parameters<typeof usage>[0],
) => {
  const source = {};
  const payload = usage(values);
  view.record({ resource: "tokens", kind: "usage", source, usage: payload });
  view.record({ resource: "cost", kind: "usage", source, usage: payload });
};

test("validates options without contacting Grafana", async () => {
  const fake = await fakeGrafana();
  for (const [options, message] of [
    [{ url: "http://admin:secret@127.0.0.1" }, /without credentials/],
    [{ url: "ftp://127.0.0.1" }, /http\(s\) URL/],
    [{ url: "not a url" }, /http\(s\) URL/],
    [{ intervalMs: 0 }, /intervalMs/],
    [{ intervalMs: Number.NaN }, /intervalMs/],
  ] as const) {
    const error = await open(fake, options).then(
      () => assert.fail("accepted"),
      (error: Error) => error,
    );
    assert.match(error.message, message);
  }
  assert.equal(fake.seen.length, 0);
});

test("updates a tagged dashboard and rejects untagged or differing ones", async () => {
  const tagged = await fakeGrafana(undefined, {
    metadata: { name: "junco-telemetry", resourceVersion: "41" },
    spec: { title: "old", tags: ["junco-telemetry"] },
  });
  await (await open(tagged)).close();
  const put = tagged.seen.find((request) => request.method === "PUT");
  assert.equal(put?.path, ITEM);
  const body = JSON.parse(put?.body ?? "");
  assert.equal(body.metadata.resourceVersion, "41");
  assert.equal(body.spec.title, "Junco telemetry");

  const untagged = await fakeGrafana(undefined, {
    metadata: { name: "junco-telemetry", resourceVersion: "7" },
    spec: { title: "theirs", tags: [] },
  });
  await assert.rejects(open(untagged), /exists without tag junco-telemetry/);
  assert.deepEqual(
    untagged.seen.map((request) => request.method),
    ["GET"],
  );

  // A creation race: reuse only an identical tagged dashboard.
  for (const same of [true, false]) {
    let intended: Record<string, unknown> | undefined;
    const raced = await fakeGrafana((request, res) => {
      if (request.method === "POST" && request.path === COLLECTION) {
        intended = JSON.parse(request.body).spec;
        send(res, 409);
        return true;
      }
      if (request.method === "GET" && request.path === ITEM) {
        if (intended === undefined) send(res, 404);
        else
          send(res, 200, {
            metadata: { name: "junco-telemetry", resourceVersion: "2" },
            spec: same
              ? { ...intended, id: 3, version: 1 }
              : { ...intended, title: "other" },
          });
        return true;
      }
      return false;
    });
    if (same) await (await open(raced)).close();
    else await assert.rejects(open(raced), /concurrently created/);
    assert.equal(
      raced.seen.filter((request) => request.method === "PUT").length,
      0,
    );
  }
});

test("setup errors carry only an operation and status", async () => {
  const fake = await fakeGrafana((_request, res) => {
    send(res, 401);
    return true;
  });
  const denied = await open(fake).then(
    () => assert.fail("accepted"),
    (error: Error) => error,
  );
  assert.match(denied.message, /dashboard lookup failed with status 401/);

  const redirect = await fakeGrafana((_request, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1:1/" }).end();
    return true;
  });
  await assert.rejects(open(redirect), /dashboard lookup failed/);
  assert.equal(redirect.seen.length, 1);
});

test("a hanging request times out after five seconds", async () => {
  const fake = await fakeGrafana(() => true);
  const started = performance.now();
  await assert.rejects(open(fake), /dashboard lookup failed \(TimeoutError\)/);
  expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
}, 15_000);

test("resources roll up through nested contexts without double counting", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const outer: tracer.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  > = recorder.add_context("nodeId1");
  const inner = outer.add_context("nodeId2");
  const full = inner.add_context("NodeId_f");
  assert.equal(full.path, "nodeId1::nodeId2::NodeId_f");
  assert.equal(full.root, recorder);
  const memory: tracer.ProfileRecorder<"memory"> = full;
  const usageRecorder: tracer.ProfileRecorder<"tokens" | "cost"> = full;
  const edits: tracer.ProfileRecorder<"edits"> = full;
  const operations: tracer.ProfileRecorder<"operations"> = full;
  const lease: tracer.ProfileRecorder<"memory"> = recorder;
  assert.equal(memory, full);
  for (const graph of [outer, inner])
    graph.record({
      resource: "operations",
      kind: "start",
      category: "graph",
      tool: "",
      operation: "evaluate",
    });
  const [source1, source2] = [{}, {}];
  const event = (
    source: object,
    kind: "started" | "sample" | "finished",
    pipelineId: number,
    values?: Partial<Record<string, number>>,
    owner: string | undefined = "owner-f",
  ) =>
    memory.record({
      resource: "memory",
      kind: "resource",
      source,
      event: {
        kind,
        pipelineId,
        owner,
        ...(values === undefined ? {} : { sample: sample(values) }),
      },
    });
  const leaf = { node: "nodeId1::nodeId2::NodeId_f" };

  event(source1, "started", 1);
  event(source1, "sample", 1, {
    memoryBytes: 40,
    memoryPeakBytes: 90,
    cpuUsageMs: 5,
    pids: 2,
    elapsedMs: 10,
  });
  event(source1, "sample", 2, {
    memoryBytes: 60,
    memoryPeakBytes: 80,
    pids: 3,
    elapsedMs: 20,
  });
  recordUsage(usageRecorder, {
    totalTokens: 12,
    cost: 0.125,
    costInput: 0.5,
  });
  await recorder.flush();
  let lines = lastPush(fake);
  for (const fields of [
    fieldsOf(lines, "junco_node", leaf),
    fieldsOf(lines, "junco_context", { node: "nodeId1" }),
    fieldsOf(lines, "junco_context", { node: "nodeId1::nodeId2" }),
    fieldsOf(lines, "junco_total"),
  ]) {
    assert.equal(fields.memory_bytes, 100);
    assert.equal(fields.memory_peak_bytes, 90);
    assert.equal(fields.peak_memory_bytes, 100);
    assert.equal(fields.pids, 5);
    assert.equal(fields.cpu_usage_ms, 5);
    assert.equal(fields.elapsed_ms, 30);
    assert.equal(fields.tokens_used, 12);
    assert.equal(fields.cost_total, 0.125);
  }
  // Context creation alone emits no node series; no shell child path.
  assert.deepEqual(
    [
      ...new Set(
        lines
          .filter((line) => line.measurement === "junco_node")
          .map((line) => line.tags.node),
      ),
    ],
    [leaf.node],
  );
  assert.equal(new Set(lines.map((line) => line.time)).size, 1);

  event(source1, "sample", 1, {
    memoryBytes: 40,
    memoryPeakBytes: 90,
    cpuUsageMs: 7,
    pids: 2,
    elapsedMs: 11,
  });
  event(source1, "sample", 1); // an empty periodic event changes nothing
  memory.record({
    resource: "memory",
    kind: "resource",
    source: source1,
    event: { kind: "sample", pipelineId: 1, owner: "owner-f" },
  });
  await recorder.flush();
  assert.equal(fieldsOf(lastPush(fake), "junco_node", leaf).cpu_usage_ms, 7);

  event(source1, "finished", 1, {
    memoryBytes: 40,
    memoryPeakBytes: 90,
    cpuUsageMs: 7,
    cpuUserMs: 4,
    cpuSystemMs: 3,
    cpuThrottledMs: 1,
    pids: 2,
    elapsedMs: 12,
    oomKills: 1,
  });
  event(source2, "sample", 1, {
    memoryBytes: 10,
    memoryPeakBytes: 10,
    cpuUsageMs: 2,
    pids: 1,
    elapsedMs: 5,
  });
  await recorder.flush();
  let fields = fieldsOf(lastPush(fake), "junco_node", leaf);
  assert.equal(fields.memory_bytes, 70);
  assert.equal(fields.pids, 4);
  assert.equal(fields.cpu_usage_ms, 9);
  assert.equal(fields.oom_kills, 1);

  event(source2, "finished", 1); // finalizes its last known sample
  await recorder.flush();
  fields = fieldsOf(lastPush(fake), "junco_node", leaf);
  assert.equal(fields.memory_bytes, 60);
  assert.equal(fields.cpu_usage_ms, 9);

  event(source1, "finished", 2);
  lease.record({
    resource: "memory",
    kind: "resource",
    source: source2,
    event: {
      kind: "finished",
      pipelineId: 9,
      owner: "unknown",
      sample: sample({ memoryBytes: 5, memoryPeakBytes: 5, elapsedMs: 1 }),
    },
  });
  edits.record({
    resource: "edits",
    kind: "start",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
  });
  edits.record({
    resource: "edits",
    kind: "metrics",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
    counters: { deleted_bytes: 1, inserted_bytes: 2 },
  });
  edits.record({
    resource: "edits",
    kind: "finish",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
    outcome: "success",
    durationMs: 4,
  });
  operations.record({
    resource: "operations",
    kind: "metrics",
    category: "graphTool",
    tool: "code_graph",
    operation: "cluster.list",
    gauges: { next_offset_last: 10 },
  });
  operations.record({
    resource: "operations",
    kind: "metrics",
    category: "graphTool",
    tool: "code_graph",
    operation: "cluster.list",
    gauges: { next_offset_last: null, k_last: 3 },
  });
  await recorder.flush();
  lines = lastPush(fake);
  fields = fieldsOf(lines, "junco_node", leaf);
  assert.deepEqual(fields, {
    tokens_used: 12,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_input: 0.5,
    cost_output: 0,
    cost_cache_read: 0,
    cost_cache_write: 0,
    cost_total: 0.125,
    tokens_per_second: 0,
    elapsed_ms: 37,
    memory_bytes: 0,
    memory_peak_bytes: 90,
    cpu_usage_ms: 9,
    cpu_user_ms: 4,
    cpu_system_ms: 3,
    cpu_throttled_ms: 1,
    pids: 0,
    oom_kills: 1,
    peak_memory_bytes: 100,
  });
  // The lease's own (root) scope holds the unattributed pipeline; totals count it once.
  assert.equal(fieldsOf(lines, "junco_node", { node: "::" }).elapsed_ms, 1);
  const total = fieldsOf(lines, "junco_total");
  assert.equal(total.elapsed_ms, 38);
  assert.equal(total.memory_peak_bytes, 90);
  assert.equal(
    fieldsOf(lines, "junco_context", { node: "nodeId1" }).elapsed_ms,
    37,
  );
  const edit = fieldsOf(lines, "junco_operation", {
    ...leaf,
    resource: "edits",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
  });
  assert.equal(edit.calls, 1);
  assert.equal(edit.inflight, 0);
  assert.equal(edit.success, 1);
  assert.equal(edit.duration_ms_mean, 4);
  assert.equal(edit.inserted_bytes - edit.deleted_bytes, 1);
  const graph = fieldsOf(lines, "junco_operation", {
    ...leaf,
    resource: "operations",
    category: "graphTool",
    tool: "code_graph",
    operation: "cluster.list",
  });
  assert.equal(graph.k_last, 3);
  assert.equal(Object.hasOwn(graph, "next_offset_last"), false);
  const evaluate = fieldsOf(lines, "junco_operation", {
    node: "nodeId1",
    resource: "operations",
    category: "graph",
    operation: "evaluate",
  });
  assert.equal(evaluate.inflight, 1);
  await recorder.close();
});

test("usage sums committed increments and rates over the reporting clock", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const a: tracer.ProfileRecorder<"tokens" | "cost"> =
      recorder.add_context("A");
    const b: tracer.ProfileRecorder<"tokens" | "cost"> =
      recorder.add_context("B");
    const tokenOnly: tracer.ProfileRecorder<"tokens"> =
      recorder.add_context("token-only");
    const costOnly: tracer.ProfileRecorder<"cost"> =
      recorder.add_context("cost-only");
    await recorder.flush();
    let total = fieldsOf(lastPush(fake), "junco_total");
    assert.equal(total.tokens_used, 0);
    assert.equal(total.tokens_per_second, 0);
    assert.equal(total.cost_total, 0);
    assert.equal(Object.hasOwn(total, "memory_bytes"), false);

    // Provider-authoritative totals differ from the component sum.
    recordUsage(a, {
      totalTokens: 10,
      input: 3,
      output: 4,
      cost: 0.125,
      costInput: 0.5,
    });
    recordUsage(b, { totalTokens: 4, input: 1, output: 1 });
    const isolated = usage({ totalTokens: 1, cost: 0.25 });
    tokenOnly.record({
      resource: "tokens",
      kind: "usage",
      source: {},
      usage: isolated,
    });
    costOnly.record({
      resource: "cost",
      kind: "usage",
      source: {},
      usage: isolated,
    });
    now = 3000;
    await recorder.flush();
    let lines = lastPush(fake);
    assert.equal(
      fieldsOf(lines, "junco_node", { node: "A" }).tokens_per_second,
      5,
    );
    assert.equal(
      fieldsOf(lines, "junco_node", { node: "B" }).tokens_per_second,
      2,
    );
    total = fieldsOf(lines, "junco_total");
    assert.equal(total.tokens_per_second, 7.5);
    assert.equal(total.tokens_used, 15);
    assert.equal(total.input_tokens, 4);
    assert.equal(total.output_tokens, 5);
    assert.equal(total.cost_input, 0.75);
    assert.equal(total.cost_total, 0.375);
    assert.equal(Object.hasOwn(total, "reasoning_tokens"), false);
    assert.equal(Object.hasOwn(total, "cache_write_1h_tokens"), false);
    const aFields = fieldsOf(lines, "junco_node", { node: "A" });
    assert.equal(aFields.tokens_used, 10);
    assert.equal(aFields.cost_total, 0.125);
    const tokenFields = fieldsOf(lines, "junco_node", { node: "token-only" });
    assert.equal(tokenFields.tokens_used, 1);
    assert.equal(Object.hasOwn(tokenFields, "cost_total"), false);
    const costFields = fieldsOf(lines, "junco_node", { node: "cost-only" });
    assert.equal(costFields.cost_total, 0.25);
    assert.equal(Object.hasOwn(costFields, "tokens_used"), false);
    assert.equal(Object.hasOwn(costFields, "tokens_per_second"), false);

    now = 5000;
    await recorder.flush();
    assert.equal(fieldsOf(lastPush(fake), "junco_total").tokens_per_second, 0);
    assert.equal(fieldsOf(lastPush(fake), "junco_total").cost_total, 0.375);

    // A nonpositive interval reports zero and keeps the pending increment.
    recordUsage(a, { totalTokens: 6, reasoning: 2, cacheWrite1h: 1 });
    recordUsage(a, { totalTokens: -2 });
    await recorder.flush();
    lines = lastPush(fake);
    assert.equal(fieldsOf(lines, "junco_total").tokens_per_second, 0);
    let fields = fieldsOf(lines, "junco_node", { node: "A" });
    assert.equal(fields.tokens_used, 14);
    assert.equal(fields.reasoning_tokens, 2);
    assert.equal(fields.cache_write_1h_tokens, 1);
    now = 6000;
    await recorder.flush();
    fields = fieldsOf(lastPush(fake), "junco_node", { node: "A" });
    assert.equal(fields.tokens_per_second, 4);
    assert.equal(fields.reasoning_tokens, 2);

    const op: tracer.ProfileRecorder<"operations"> = recorder.add_context("A");
    op.record({
      resource: "operations",
      kind: "start",
      category: "send",
      tool: "send",
      operation: "execute",
    });
    op.record({
      resource: "operations",
      kind: "start",
      category: "send",
      tool: "send",
      operation: "execute",
    });
    now = 6500;
    await recorder.flush();
    const send = fieldsOf(lastPush(fake), "junco_operation", {
      node: "A",
      resource: "operations",
      category: "send",
      tool: "send",
      operation: "execute",
    });
    assert.equal(send.calls_per_second, 4);
    assert.equal(send.inflight, 2);
    assert.equal(send.duration_ms_mean, 0);
  } finally {
    clock.mockRestore();
  }
  await recorder.close();
});

test("invalid values latch atomically without changing accounting", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const view = recorder.add_context("n");
  view.record({
    resource: "tokens",
    kind: "usage",
    source: {},
    usage: usage({ totalTokens: 5 }),
  });
  assert.doesNotThrow(() =>
    view.record({
      resource: "cost",
      kind: "usage",
      source: {},
      usage: { ...usage({ totalTokens: 0 }), cost: undefined! },
    }),
  );
  assert.doesNotThrow(() =>
    view.record({
      resource: "cost",
      kind: "usage",
      source: {},
      usage: {
        ...usage({ totalTokens: 0 }),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: Number.NaN,
        },
      },
    }),
  );
  view.record({
    resource: "memory",
    kind: "resource",
    source: {},
    event: {
      kind: "sample",
      pipelineId: 1,
      sample: sample({ memoryBytes: Number.POSITIVE_INFINITY }),
    },
  });
  view.record({
    resource: "operations",
    kind: "metrics",
    category: "c",
    tool: "",
    operation: "o",
    counters: { good: 1, bad: Number.NaN },
  });
  view.record({
    resource: "operations",
    kind: "metrics",
    category: "c",
    tool: "",
    operation: "o",
    counters: { "Bad-Name": 1 },
  });
  await assert.rejects(recorder.flush(), /GrafanaRecorder: invalid usage/);
  const lines = lastPush(fake);
  assert.equal(fieldsOf(lines, "junco_total").tokens_used, 5);
  assert.equal(fieldsOf(lines, "junco_total").cost_total, 0);
  const valid = fieldsOf(lines, "junco_node", { node: "n" });
  assert.equal(valid.tokens_used, 5);
  assert.equal(Object.hasOwn(valid, "cost_total"), false);
  await assert.rejects(recorder.close(), /invalid usage/);
});

test("labels are escaped and requests omit Authorization", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const view = recorder
    .add_context("a,b=c d")
    .add_context("x::y%z")
    .add_context("line\nbreak\r");
  view.record({
    resource: "operations",
    kind: "start",
    category: "cat egory",
    tool: "my,tool",
    operation: "op=1",
  });
  await recorder.flush();
  const push = fake.pushes().at(-1);
  assert.ok(push);
  assert.equal(push.path, `/api/live/push/${recorder.streamId}`);
  assert.equal(push.auth, undefined);
  assert.equal(push.type, "text/plain; charset=utf-8");
  assert.ok(
    push.body.includes("node=a\\,b\\=c\\ d::x%3A%3Ay%25z::line\\nbreak\\r,"),
  );
  const lines = parse(push.body);
  assert.deepEqual(
    lines.find((line) => line.measurement === "junco_operation")?.tags,
    {
      node: "a,b=c d::x%3A%3Ay%25z::line\\nbreak\\r",
      resource: "operations",
      category: "cat egory",
      tool: "my,tool",
      operation: "op=1",
      metric: "calls",
    },
  );
  assert.match(lines[0]?.time ?? "", /^\d{19}$/);
  await recorder.close();
});

test("a transport failure latches once with no retries", async () => {
  let pushes = 0;
  const fake = await fakeGrafana((request, res) => {
    if (!request.path.startsWith("/api/live/push/")) return false;
    pushes++;
    send(res, 500, { message: "internal-server-detail" });
    return true;
  });
  const recorder = await open(fake, { intervalMs: 10 });
  recorder.record({
    resource: "operations",
    kind: "start",
    category: "c",
    tool: "",
    operation: "o",
  });
  const error = await recorder.flush().then(
    () => assert.fail("flushed"),
    (error: Error) => error,
  );
  assert.match(error.message, /live push failed with status 500/);
  assert.ok(!error.message.includes("internal-server-detail"));
  // Absence of retries has no event to await: give the 10 ms timer several real chances.
  await Bun.sleep(60);
  await assert.rejects(recorder.flush(), (thrown) => thrown === error);
  await assert.rejects(recorder.close(), (thrown) => thrown === error);
  assert.equal(pushes, 1);
});

test("the periodic snapshot starts at first record and close stops it", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake, { intervalMs: 10 });
  // Absence of a push has no event to await: give the 10 ms timer several real chances.
  await Bun.sleep(40);
  assert.equal(fake.pushes().length, 0);
  recorder.record({
    resource: "operations",
    kind: "start",
    category: "c",
    tool: "",
    operation: "o",
  });
  await fake.pushed(2);
  const closing = recorder.close();
  assert.equal(recorder.close(), closing);
  await closing;
  const sent = fake.pushes().length;
  await recorder.close();
  await recorder.flush();
  recorder.record({
    resource: "operations",
    kind: "start",
    category: "c",
    tool: "",
    operation: "late",
  });
  assert.throws(() => recorder.add_context("x"), /GrafanaRecorder: closed/);
  await Bun.sleep(40); // as above: a stopped timer sends nothing
  assert.equal(fake.pushes().length, sent);
});

test("an oversized snapshot is rejected rather than truncated", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const view: tracer.ProfileRecorder<"operations"> = recorder;
  for (let i = 0; i < 2000; i++)
    view.record({
      resource: "operations",
      kind: "start",
      category: "c",
      tool: `tool_${i}_${"x".repeat(200)}`,
      operation: "o",
    });
  await assert.rejects(recorder.flush(), /snapshot exceeds 500 KiB/);
  assert.equal(fake.pushes().length, 0);
  await assert.rejects(recorder.close(), /snapshot exceeds 500 KiB/);
});

const probe = (edgeId: string, value: number) =>
  ({ resource: "probe", kind: "probe", edgeId, value }) as const;

test("each probe is pushed alone, once, before the snapshot, at its receipt time", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const view = recorder.add_context("a b").add_context("c,d");
  const values = [1.25, -2, -2, 0];
  const now = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    for (const value of values) view.record(probe("x=y z", value));
  } finally {
    now.mockRestore();
  }
  await recorder.flush();
  // Same-millisecond points of one series survive only in separate pushes.
  const pushes = fake.pushes().map((push) => parse(push.body));
  assert.equal(pushes.length, values.length + 1);
  assert.deepEqual(
    pushes.slice(0, values.length),
    values.map((value) => [
      {
        measurement: "junco_probe",
        tags: { node: "a b::c,d", edge_id: "x=y z" },
        fields: { value },
        time: "1700000000000000000",
      },
    ]),
  );
  assert.ok(pushes.at(-1)?.every((line) => line.measurement !== "junco_probe"));
  await recorder.flush();
  assert.equal(fake.pushes().length, values.length + 2);
  assert.ok(lastPush(fake).every((line) => line.measurement !== "junco_probe"));
  await recorder.close();
});

test("invalid probe values latch without producing a line", async () => {
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    const fake = await fakeGrafana();
    const recorder = await open(fake);
    recorder.record(probe("e", value));
    recorder.record(probe("e", 3));
    await assert.rejects(
      recorder.flush(),
      /GrafanaRecorder: invalid probe value/,
    );
    assert.deepEqual(
      fake
        .pushes()
        .flatMap((push) => parse(push.body))
        .filter((line) => line.measurement === "junco_probe")
        .map((line) => line.fields),
      [{ value: 3 }],
    );
    await assert.rejects(recorder.close(), /invalid probe value/);
  }
});

test("a probe point over 500 KiB is rejected rather than pushed", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  recorder.record(probe("e".repeat(500 * 1024), 1));
  await assert.rejects(recorder.flush(), /probe exceeds 500 KiB/);
  assert.equal(fake.pushes().length, 0);
  await assert.rejects(recorder.close(), /probe exceeds 500 KiB/);
});

test("a failed probe push stops every later probe and snapshot push", async () => {
  const fake = await fakeGrafana((request, res) => {
    if (!request.path.startsWith("/api/live/push/")) return false;
    if (request.body.includes("value=2 ")) send(res, 500);
    else send(res, 200);
    return true;
  });
  const recorder = await open(fake);
  for (const value of [1, 2, 3]) recorder.record(probe("e", value));
  const error = await recorder.flush().then(
    () => assert.fail("flushed"),
    (error: Error) => error,
  );
  assert.match(error.message, /live push failed with status 500/);
  recorder.record(probe("e", 4));
  await assert.rejects(recorder.flush(), (thrown) => thrown === error);
  assert.deepEqual(
    fake.pushes().map((push) => parse(push.body)[0]?.fields),
    [{ value: 1 }, { value: 2 }],
  );
  await assert.rejects(recorder.close(), (thrown) => thrown === error);
});

test("new metrics and nodes keep Live schemas stable without inventing absent values", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const operation = {
    resource: "operations",
    category: "custom",
    tool: "container_bash",
    operation: "execute",
  } as const;
  const leader = recorder.add_context("Agent1");
  leader.record({ ...operation, kind: "start" });
  recordUsage(leader, { totalTokens: 3, cost: 0.1 });
  await recorder.flush();
  const before = lastPush(fake);
  assert.equal(
    fieldsOf(before, "junco_node", { node: "Agent1" }).reasoning_tokens,
    undefined,
  );
  leader.record({
    ...operation,
    kind: "metrics",
    counters: { requested: 1, output_text_bytes: 4 },
    gauges: { pending: 1 },
  });
  leader.record({
    ...operation,
    kind: "finish",
    outcome: "cancelled",
    durationMs: 20,
  });
  leader.record({ ...operation, kind: "metrics", gauges: { pending: null } });
  const worker = recorder.add_context("agent1").add_context("Worker");
  recordUsage(worker, {
    totalTokens: 7,
    reasoning: 2,
    cacheWrite1h: 1,
    cost: 0.3,
  });
  await recorder.close();
  const after = lastPush(fake);
  for (const line of [...before, ...after]) {
    assert.deepEqual(Object.keys(line.fields), ["value"]);
    assert.ok(line.tags.metric);
  }
  const tools = fieldsOf(after, "junco_operation", {
    node: "Agent1",
    ...operation,
  });
  assert.equal(tools.calls, 1);
  assert.equal(tools.cancelled, 1);
  assert.equal(tools.requested, 1);
  assert.equal(tools.duration_ms_sum, 20);
  assert.equal(tools.output_text_bytes, 4);
  assert.equal(tools.pending, undefined);
  const tokens = fieldsOf(after, "junco_node", { node: "agent1::Worker" });
  assert.equal(tokens.tokens_used, 7);
  assert.equal(tokens.reasoning_tokens, 2);
  assert.equal(tokens.cache_write_1h_tokens, 1);
  assert.equal(fieldsOf(after, "junco_total").tokens_used, 10);
});
