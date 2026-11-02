import { afterEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tracer } from "junco";
import { provisionGrafanaDashboard } from "../src/grafana-recorder.ts";

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
  readonly stale?: readonly string[];
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
  const dashboards = new Map<string, Record<string, unknown>>();
  if (dashboard) {
    const metadata = dashboard.metadata as { name?: string } | undefined;
    dashboards.set(
      `${COLLECTION}/${metadata?.name ?? "junco-telemetry"}`,
      dashboard,
    );
  }
  const server = createServer(async (req, res) => {
    req.setEncoding("utf8");
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
    const pushes = seen.filter((s) =>
      s.path.startsWith("/api/telemetry/metrics"),
    );
    for (const waiter of waiters.splice(0))
      if (pushes.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    if (respond?.(request, res)) return;
    if (request.auth !== undefined)
      return send(res, 400, { message: "unexpected Authorization" });
    if (request.path.startsWith(`${COLLECTION}/`) && request.method === "GET") {
      const stored = dashboards.get(request.path);
      return stored ? send(res, 200, stored) : send(res, 404);
    }
    if (request.path === COLLECTION && request.method === "POST") {
      const posted = JSON.parse(body);
      const path = `${COLLECTION}/${posted.metadata.name}`;
      if (dashboards.has(path)) return send(res, 409);
      const stored = {
        ...posted,
        metadata: { ...posted.metadata, resourceVersion: "1" },
      };
      dashboards.set(path, stored);
      return send(res, 201, stored);
    }
    if (request.path.startsWith(`${COLLECTION}/`) && request.method === "PUT") {
      const stored = JSON.parse(body);
      dashboards.set(request.path, stored);
      return send(res, 200, stored);
    }
    if (
      request.path.startsWith("/api/telemetry/metrics") &&
      request.method === "POST"
    )
      return res.writeHead(200).end();
    send(res, 404);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const fake: Fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    pushes: () =>
      seen.filter((request) =>
        request.path.startsWith("/api/telemetry/metrics"),
      ),
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

type OtlpPoint = {
  attributes: { key: string; value: { stringValue: string } }[];
  timeUnixNano: string;
  asDouble?: number;
  flags?: number;
};
/** Decode OTLP gauges into accounting rows; stale fields stay separately observable. */
function parse(body: string): Line[] {
  const decoded = JSON.parse(body) as {
    resourceMetrics: {
      scopeMetrics: {
        metrics: { name: string; gauge: { dataPoints: OtlpPoint[] } }[];
      }[];
    }[];
  };
  const rows = new Map<string, Line>();
  for (const resource of decoded.resourceMetrics)
    for (const scope of resource.scopeMetrics)
      for (const metric of scope.metrics) {
        const match =
          /^(junco_(?:total|node|context|operation|probe))_(.+)$/.exec(
            metric.name,
          );
        assert.ok(match, metric.name);
        const measurement = match[1]!;
        const field = match[2]!;
        for (const point of metric.gauge.dataPoints) {
          const tags = Object.fromEntries(
            point.attributes.map(({ key, value }) => [key, value.stringValue]),
          );
          assert.match(tags.stream ?? "", /^junco_[0-9a-f]{32}$/);
          delete tags.stream;
          assert.match(tags.dashboard ?? "", /^[A-Za-z0-9_-]{1,40}$/);
          delete tags.dashboard;
          assert.match(point.timeUnixNano, /^\d+$/);
          const key = JSON.stringify([measurement, tags, point.timeUnixNano]);
          let row = rows.get(key);
          if (row === undefined) {
            row = {
              measurement,
              tags,
              fields: {},
              time: point.timeUnixNano,
              stale: [],
            };
            rows.set(key, row);
          }
          if (point.flags === 1) {
            assert.equal(point.asDouble, undefined);
            (row.stale as string[]).push(field);
          } else {
            assert.equal(typeof point.asDouble, "number");
            row.fields[field] = point.asDouble!;
          }
        }
      }
  return [...rows.values()];
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
  const line = lines.find(
    (candidate) =>
      candidate.measurement === measurement &&
      Object.keys(candidate.tags).length === Object.keys(tags).length &&
      Object.entries(tags).every(
        ([key, value]) => candidate.tags[key] === value,
      ),
  );
  assert.ok(line, `${measurement} ${JSON.stringify(tags)}`);
  return line.fields;
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
    ...["", "with space", "../other", 'bad"uid', "a".repeat(41)].map(
      (dashboard) => [{ dashboard }, /dashboard/] as const,
    ),
  ] as const) {
    const error = await open(fake, options).then(
      () => assert.fail("accepted"),
      (error: Error) => error,
    );
    assert.match(error.message, message);
  }
  assert.equal(fake.seen.length, 0);
});

test("selects the current session on create and update without credentials", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  assert.match(recorder.streamId, /^junco_[0-9a-f]{32}$/);
  assert.equal(
    recorder.dashboardUrl,
    `${fake.url}/d/junco-telemetry?var-stream=${recorder.streamId}`,
  );
  const create = fake.seen.find((request) => request.method === "POST");
  assert.equal(create?.path, COLLECTION);
  assert.equal(create?.auth, undefined);
  const posted = JSON.parse(create?.body ?? "");
  assert.deepEqual(posted.metadata, { name: "junco-telemetry" });
  assert.equal(posted.spec.uid, "junco-telemetry");
  assert.deepEqual(posted.spec.tags, ["junco-telemetry"]);
  const variable = posted.spec.templating.list.find(
    (variable: { name: string }) => variable.name === "stream",
  );
  assert.equal(variable.type, "textbox");
  assert.equal(variable.query, recorder.streamId);
  assert.deepEqual(variable.current, {
    text: recorder.streamId,
    value: recorder.streamId,
  });
  recordUsage(recorder, { totalTokens: 5 });
  await recorder.close();
  const point: OtlpPoint = JSON.parse(fake.pushes().at(-1)!.body)
    .resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0];
  assert.equal(
    point.attributes.find(({ key }) => key === "stream")?.value.stringValue,
    variable.current.value,
  );
  assert.equal(fieldsOf(lastPush(fake), "junco_total").tokens_used, 5);

  const next = await open(fake);
  assert.notEqual(next.streamId, recorder.streamId);
  const updated = JSON.parse(
    fake.seen.find((request) => request.method === "PUT")!.body,
  );
  assert.equal(updated.spec.templating.list[0].query, next.streamId);
  assert.deepEqual(updated.spec.templating.list[0].current, {
    text: next.streamId,
    value: next.streamId,
  });
  assert.equal(
    new URL(recorder.dashboardUrl).searchParams.get("var-stream"),
    recorder.streamId,
  );
  await next.close();
});

test("updates a tagged dashboard and rejects an untagged one", async () => {
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
});

test("creation races allow only generated session selection differences", async () => {
  const otherSession = "junco_0123456789abcdef0123456789abcdef";
  for (const difference of [
    "none",
    "session",
    "title",
    "panel",
    "type",
    "definition",
    "other-variable",
    "invalid-session",
    "inconsistent-session",
    "target",
    "tags",
  ]) {
    let intended: Record<string, unknown> | undefined;
    let attemptedSession = "";
    const raced = await fakeGrafana((request, res) => {
      if (request.method === "POST" && request.path === COLLECTION) {
        const actual = JSON.parse(request.body).spec;
        const variable = actual.templating.list[0];
        attemptedSession = variable.query;
        actual.id = 3;
        actual.version = 1;
        if (difference !== "none") {
          variable.query = otherSession;
          variable.current = {
            ...variable.current,
            text: otherSession,
            value: otherSession,
          };
        }
        switch (difference) {
          case "title":
            actual.title = "other";
            break;
          case "panel":
            actual.panels[0].type = "table";
            break;
          case "type":
            variable.type = "query";
            break;
          case "definition":
            variable.definition = "different definition";
            break;
          case "other-variable":
            actual.templating.list.push({ ...variable, name: "other" });
            break;
          case "invalid-session":
            variable.query = "junco";
            variable.current = { text: "junco", value: "junco" };
            break;
          case "inconsistent-session":
            variable.current.value = "junco";
            break;
          case "target":
            actual.panels[0].targets[0].expr = "vector(0)";
            break;
          case "tags":
            actual.tags = ["unrelated"];
            break;
        }
        intended = actual;
        send(res, 409);
        return true;
      }
      if (request.method === "GET" && request.path === ITEM) {
        if (intended === undefined) send(res, 404);
        else
          send(res, 200, {
            metadata: { name: "junco-telemetry", resourceVersion: "2" },
            spec: intended,
          });
        return true;
      }
      return false;
    });
    if (difference === "none" || difference === "session") {
      const recorder = await open(raced);
      assert.equal(recorder.streamId, attemptedSession);
      if (difference === "session")
        assert.notEqual(recorder.streamId, otherSession);
      assert.equal(
        new URL(recorder.dashboardUrl).searchParams.get("var-stream"),
        recorder.streamId,
      );
      await recorder.close();
    } else
      await assert.rejects(open(raced), /concurrently created/, difference);
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
  assert.match(
    denied.message,
    /dashboard lookup(?: \(junco-telemetry\))? failed with status 401/,
  );

  const redirect = await fakeGrafana((_request, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1:1/" }).end();
    return true;
  });
  await assert.rejects(
    open(redirect),
    /dashboard lookup(?: \(junco-telemetry\))? failed/,
  );
  assert.equal(redirect.seen.length, 1);
});

test("a hanging request times out after five seconds", async () => {
  const fake = await fakeGrafana(() => true);
  const started = performance.now();
  await assert.rejects(
    open(fake),
    /dashboard lookup(?: \(junco-telemetry\))? failed \(TimeoutError\)/,
  );
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
    lines
      .filter((line) => line.measurement === "junco_node")
      .map((line) => line.tags.node),
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

test("labels and dynamic names round-trip through anonymous JSON", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const text = "spaces ,=\\\nUnicode λ";
  const view = recorder.add_context(text);
  view.record({
    resource: "operations",
    kind: "metrics",
    category: text,
    tool: text,
    operation: text,
    gauges: { a_b: 1, a__b: 2 },
  });
  await recorder.flush();
  const push = fake.pushes().at(-1)!;
  assert.equal(push.path, "/api/telemetry/metrics");
  assert.equal(push.auth, undefined);
  assert.equal(push.type, "application/json");
  const rows = parse(push.body);
  const row = rows.find((row) => row.measurement === "junco_operation")!;
  assert.deepEqual(row.tags, {
    node: text,
    resource: "operations",
    category: text,
    tool: text,
    operation: text,
  });
  assert.equal(row.fields.a_b, 1);
  assert.equal(row.fields.a__b, 2);
  await recorder.close();
});

test("a transport failure latches once with no retries", async () => {
  let pushes = 0;
  const fake = await fakeGrafana((request, res) => {
    if (!request.path.startsWith("/api/telemetry/metrics")) return false;
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
  assert.match(error.message, /metrics push failed with status 500/);
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

test("snapshots preserve every point across bounded UTF-8 shards and keep small batches grouped", async () => {
  for (const count of [2, 600]) {
    const fake = await fakeGrafana();
    const recorder = await open(fake);
    const path = "根::枝λ";
    const view = recorder.add_context("根").add_context("枝λ");
    const clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const expected: { name: string; point: OtlpPoint }[] = [];
    const expectFields = (
      measurement: string,
      tags: Record<string, string>,
      fields: Record<string, number>,
    ) => {
      for (const [field, asDouble] of Object.entries(fields))
        expected.push({
          name: `${measurement}_${field}`,
          point: {
            attributes: Object.entries({
              stream: recorder.streamId,
              dashboard: "junco-telemetry",
              ...tags,
            }).map(([key, stringValue]) => ({ key, value: { stringValue } })),
            timeUnixNano: "1700000000000000000",
            asDouble,
          },
        });
    };
    try {
      expectFields(
        "junco_total",
        {},
        {
          tokens_used: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          tokens_per_second: 0,
          cost_input: 0,
          cost_output: 0,
          cost_cache_read: 0,
          cost_cache_write: 0,
          cost_total: 0,
        },
      );
      for (let i = 0; i < count; i++) {
        const tags = {
          node: path,
          resource: "operations",
          category: "待機λ",
          tool: `tool_${i}_${"界".repeat(200)}`,
          operation: `実行_${i}`,
        };
        view.record({
          resource: "operations",
          kind: "metrics",
          category: tags.category,
          tool: tags.tool,
          operation: tags.operation,
          gauges: { queue_depth: i + 0.25 },
          counters: { items: i + 1 },
        });
        expectFields("junco_operation", tags, {
          calls: 0,
          inflight: 0,
          success: 0,
          errors: 0,
          cancelled: 0,
          duration_ms_sum: 0,
          duration_ms_max: 0,
          duration_ms_last: 0,
          duration_ms_mean: 0,
          calls_per_second: 0,
          items: i + 1,
          queue_depth: i + 0.25,
        });
      }
      await recorder.flush();
      const pushes = fake.pushes();
      if (count === 2) assert.equal(pushes.length, 1);
      else {
        assert.ok(pushes.length > 2);
        const oneMetric = {
          name: "junco_operation_queue_depth",
          gauge: {
            dataPoints: expected
              .filter(({ name }) => name === "junco_operation_queue_depth")
              .map(({ point }) => point),
          },
        };
        assert.ok(Buffer.byteLength(JSON.stringify(oneMetric)) > 500 * 1024);
      }
      const actual = pushes.flatMap(({ body }) => {
        assert.ok(Buffer.byteLength(body) <= 500 * 1024);
        const decoded = JSON.parse(body) as {
          resourceMetrics: {
            scopeMetrics: {
              metrics: { name: string; gauge: { dataPoints: OtlpPoint[] } }[];
            }[];
          }[];
        };
        return decoded.resourceMetrics.flatMap((resource) =>
          resource.scopeMetrics.flatMap((scope) =>
            scope.metrics.flatMap(({ name, gauge }) =>
              gauge.dataPoints.map((point) => ({ name, point })),
            ),
          ),
        );
      });
      // Comparing individual points, rather than merged rows, exposes duplicates too.
      const sort = (points: typeof expected) =>
        points.map((point) => JSON.stringify(point)).sort();
      assert.deepEqual(sort(actual), sort(expected));
    } finally {
      clock.mockRestore();
      await recorder.close();
    }
  }
});

test("a single snapshot point over 500 KiB is rejected and retains its error", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  recorder.record({
    resource: "operations",
    kind: "metrics",
    category: "c",
    tool: "界".repeat(175_000),
    operation: "o",
    gauges: { queue_depth: 1 },
  });
  const error = await recorder.flush().then(
    () => assert.fail("flushed"),
    (error: Error) => error,
  );
  assert.match(error.message, /snapshot exceeds 500 KiB/);
  for (const push of fake.pushes()) {
    assert.ok(Buffer.byteLength(push.body) <= 500 * 1024);
    assert.ok(
      parse(push.body).every((row) => row.measurement !== "junco_operation"),
    );
  }
  const sent = fake.pushes().length;
  await assert.rejects(recorder.flush(), (thrown) => thrown === error);
  await assert.rejects(recorder.close(), (thrown) => thrown === error);
  assert.equal(fake.pushes().length, sent);
});

test("a failed later snapshot shard retains its error and stops all subsequent pushes", async () => {
  let pushes = 0;
  const fake = await fakeGrafana((request, res) => {
    if (!request.path.startsWith("/api/telemetry/metrics")) return false;
    send(res, ++pushes === 2 ? 500 : 200);
    return true;
  });
  const recorder = await open(fake);
  for (let i = 0; i < 600; i++)
    recorder.record({
      resource: "operations",
      kind: "metrics",
      category: "c",
      tool: `tool_${i}_${"界".repeat(200)}`,
      operation: "o",
      gauges: { queue_depth: i },
    });
  const error = await recorder.flush().then(
    () => assert.fail("flushed"),
    (error: Error) => error,
  );
  assert.match(error.message, /metrics push failed with status 500/);
  assert.equal(pushes, 2);
  for (const push of fake.pushes())
    assert.ok(Buffer.byteLength(push.body) <= 500 * 1024);
  recorder.record({
    resource: "probe",
    kind: "probe",
    edgeId: "later",
    value: 1,
  });
  await assert.rejects(recorder.flush(), (thrown) => thrown === error);
  await assert.rejects(recorder.close(), (thrown) => thrown === error);
  await assert.rejects(recorder.flush(), (thrown) => thrown === error);
  assert.equal(pushes, 2);
});

const probe = (edgeId: string, value: number) =>
  ({ resource: "probe", kind: "probe", edgeId, value }) as const;

test("probes retain repeated values with per-series monotonic receipt clocks", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const view = recorder.add_context("a b").add_context("c,d");
  const values = [1.25, -2, -2, 0];
  const clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    for (const value of values) view.record(probe("x=y z", value));
    view.record(probe("other", 9));
    await recorder.flush();
    const pushes = fake.pushes().map((push) => parse(push.body));
    assert.equal(pushes.length, 6);
    for (const [i, value] of values.entries()) {
      const row = pushes[i]![0]!;
      assert.equal(pushes[i]!.length, 1);
      assert.equal(row.measurement, "junco_probe");
      assert.deepEqual(row.tags, { node: "a b::c,d", edge_id: "x=y z" });
      assert.deepEqual(row.fields, { value });
      assert.equal(
        row.time,
        String(BigInt(1_700_000_000_000 + i) * 1_000_000n),
      );
    }
    assert.equal(pushes[4]![0]!.time, "1700000000000000000");
    const first = BigInt(pushes[5]![0]!.time);
    await recorder.flush();
    assert.equal(BigInt(lastPush(fake)[0]!.time), first + 1_000_000n);
    clock.mockReturnValue(1_699_999_999_000);
    await recorder.flush();
    assert.equal(BigInt(lastPush(fake)[0]!.time), first + 2_000_000n);
    assert.ok(lastPush(fake).every((row) => row.measurement !== "junco_probe"));
    assert.equal(fake.pushes().length, 8);
  } finally {
    clock.mockRestore();
    await recorder.close();
  }
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
    if (!request.path.startsWith("/api/telemetry/metrics")) return false;
    if (parse(request.body)[0]?.fields.value === 2) send(res, 500);
    else send(res, 200);
    return true;
  });
  const recorder = await open(fake);
  for (const value of [1, 2, 3]) recorder.record(probe("e", value));
  const error = await recorder.flush().then(
    () => assert.fail("flushed"),
    (error: Error) => error,
  );
  assert.match(error.message, /metrics push failed with status 500/);
  recorder.record(probe("e", 4));
  await assert.rejects(recorder.flush(), (thrown) => thrown === error);
  assert.deepEqual(
    fake.pushes().map((push) => parse(push.body)[0]?.fields),
    [{ value: 1 }, { value: 2 }],
  );
  await assert.rejects(recorder.close(), (thrown) => thrown === error);
});

test("deleted exported gauges emit one tombstone and reveal shadowed fields", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake);
  const labels = {
    resource: "operations",
    category: "queue",
    tool: "",
    operation: "run",
  } as const;
  const metrics = (
    gauges: Record<string, number | null>,
    counters?: Record<string, number>,
  ) =>
    recorder.record({
      ...labels,
      kind: "metrics",
      gauges,
      ...(counters === undefined ? {} : { counters }),
    });
  const operation = () =>
    lastPush(fake).find((row) => row.measurement === "junco_operation")!;
  metrics(
    { queue_depth: 7, calls: 8, items: 9, cancelled_before_export: 1 },
    { items: 3 },
  );
  metrics({ cancelled_before_export: null });
  await recorder.flush();
  assert.equal(operation().fields.queue_depth, 7);
  assert.equal(operation().fields.calls, 8);
  assert.equal(operation().fields.items, 9);
  assert.equal(
    Object.hasOwn(operation().fields, "cancelled_before_export"),
    false,
  );
  assert.deepEqual(operation().stale, []);
  metrics({ queue_depth: null, calls: null, items: null });
  await recorder.flush();
  assert.equal(Object.hasOwn(operation().fields, "queue_depth"), false);
  assert.deepEqual(operation().stale, ["queue_depth"]);
  assert.equal(operation().fields.calls, 0);
  assert.equal(operation().fields.items, 3);
  await recorder.flush();
  assert.deepEqual(operation().stale, []);
  metrics({ queue_depth: 4 });
  await recorder.flush();
  metrics({ queue_depth: null });
  metrics({ queue_depth: 6 });
  await recorder.flush();
  assert.equal(operation().fields.queue_depth, 6);
  assert.deepEqual(operation().stale, []);
  await recorder.close();
});

test("new metrics and nodes preserve accounting without inventing absent values", async () => {
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

test("container peak gauges stay independent of pipeline samples and absent hardware", async () => {
  const fake = await fakeGrafana();
  const recorder = await open(fake, { dashboard: "junco-cooperbench" });
  recordUsage(recorder, { totalTokens: 9, cost: 0.25 });
  await recorder.flush();
  let lines = lastPush(fake);
  assert.equal(fieldsOf(lines, "junco_total").peak_memory_bytes, undefined);
  assert.ok(!lines.some((line) => line.measurement === "junco_operation"));

  const operation = {
    resource: "memory",
    category: "benchmark",
    tool: "",
    operation: "container_memory",
  } as const;
  recorder.record({
    ...operation,
    kind: "metrics",
    gauges: { peak_memory_bytes: 100 },
  });
  const tags = {
    node: "::",
    resource: "memory",
    category: "benchmark",
    operation: "container_memory",
  };
  await recorder.flush();
  lines = lastPush(fake);
  assert.equal(fieldsOf(lines, "junco_operation", tags).peak_memory_bytes, 100);
  assert.equal(fieldsOf(lines, "junco_total").peak_memory_bytes, undefined);
  assert.equal(
    fieldsOf(lines, "junco_node", { node: "::" }).peak_memory_bytes,
    undefined,
  );
  for (const line of lines)
    for (const field of ["cpu_usage_ms", "pids", "memory_bytes"])
      assert.equal(line.fields[field], undefined);

  const source = {};
  for (const [index, bytes] of [70, 80].entries())
    recorder.add_context(`Agent${index + 1}`).record({
      resource: "memory",
      kind: "resource",
      source,
      event: {
        kind: "sample",
        pipelineId: index + 1,
        sample: sample({ memoryBytes: bytes, memoryPeakBytes: bytes }),
      },
    });
  await recorder.flush();
  lines = lastPush(fake);
  assert.equal(fieldsOf(lines, "junco_operation", tags).peak_memory_bytes, 100);
  assert.equal(fieldsOf(lines, "junco_total").peak_memory_bytes, 150);
  assert.equal(
    fieldsOf(lines, "junco_node", { node: "Agent1" }).peak_memory_bytes,
    70,
  );
  assert.equal(
    fieldsOf(lines, "junco_node", { node: "Agent2" }).peak_memory_bytes,
    80,
  );

  recorder.record({
    ...operation,
    kind: "metrics",
    gauges: { peak_memory_bytes: 110 },
  });
  await recorder.close();
  lines = lastPush(fake);
  assert.equal(fieldsOf(lines, "junco_operation", tags).peak_memory_bytes, 110);
  const total = fieldsOf(lines, "junco_total");
  assert.equal(total.peak_memory_bytes, 150);
  assert.equal(total.tokens_used, 9);
  assert.equal(total.cost_total, 0.25);
});

type DashboardTarget = {
  interval?: string;
  instant?: boolean;
  range?: boolean;
};
type DashboardPanel = {
  type: string;
  collapsed?: boolean;
  panels?: DashboardPanel[];
  targets?: DashboardTarget[];
};
type DashboardVariable = {
  name: string;
  type: string;
  multi?: boolean;
  includeAll?: boolean;
  allValue?: string;
  refresh?: number;
  regex?: string;
  current: { text: string; value: string | string[] };
};
type DashboardDocument = {
  metadata: { name: string; resourceVersion?: string };
  spec: {
    uid: string;
    title: string;
    tags: string[];
    time: { from: string; to: string };
    refresh: string;
    templating: { list: DashboardVariable[] };
    panels: DashboardPanel[];
  };
};

test("custom dashboard UID isolates provisioning, links, and every OTLP point", async () => {
  const fake = await fakeGrafana();
  for (const dashboard of [
    "junco-telemetry",
    "custom_UID-42",
    "junco-cooperbench",
  ]) {
    const recorder = await open(fake, { dashboard });
    assert.equal(
      recorder.dashboardUrl,
      `${fake.url}/d/${dashboard}?var-stream=${recorder.streamId}`,
    );
    recordUsage(recorder, { totalTokens: 7, cost: 0.25 });
    const operation = {
      resource: "operations",
      category: "queue",
      tool: "",
      operation: "run",
    } as const;
    recorder.record({ ...operation, kind: "metrics", gauges: { depth: 2 } });
    recorder.record(probe("edge", 1));
    await recorder.flush();
    recorder.record({ ...operation, kind: "metrics", gauges: { depth: null } });
    await recorder.close();
    const points = fake
      .pushes()
      .flatMap((push) => {
        const body = JSON.parse(push.body) as {
          resourceMetrics: {
            scopeMetrics: {
              metrics: { name: string; gauge: { dataPoints: OtlpPoint[] } }[];
            }[];
          }[];
        };
        return body.resourceMetrics.flatMap((resource) =>
          resource.scopeMetrics.flatMap((scope) =>
            scope.metrics.flatMap((metric) =>
              metric.gauge.dataPoints.map((point: OtlpPoint) => ({
                metric: metric.name,
                point,
              })),
            ),
          ),
        ) as { metric: string; point: OtlpPoint }[];
      })
      .filter(({ point }) =>
        point.attributes.some(
          ({ key, value }) =>
            key === "stream" && value.stringValue === recorder.streamId,
        ),
      );
    assert.ok(points.some(({ metric }) => metric.startsWith("junco_probe_")));
    assert.ok(points.some(({ point }) => point.flags === 1));
    assert.ok(
      points.some(
        ({ metric, point }) =>
          metric === "junco_total_tokens_used" && point.asDouble === 7,
      ),
    );
    for (const { point } of points)
      assert.deepEqual(
        point.attributes.filter(({ key }) => key === "dashboard"),
        [{ key: "dashboard", value: { stringValue: dashboard } }],
      );
  }
  const posted = fake.seen
    .filter(
      (request) => request.method === "POST" && request.path === COLLECTION,
    )
    .map((request) => JSON.parse(request.body));
  assert.deepEqual(
    posted.map((body) => body.metadata.name),
    ["junco-telemetry", "custom_UID-42", "junco-cooperbench"],
  );
  assert.deepEqual(
    posted.map((body) => body.spec.uid),
    ["junco-telemetry", "custom_UID-42", "junco-cooperbench"],
  );
});

test("benchmark provisioning retains All and historical overview and drill-down structure", async () => {
  const fake = await fakeGrafana();
  for (const dashboard of [
    "junco-cooperbench",
    "junco-swebench",
    "junco-msbench",
  ]) {
    const before = fake.pushes().length;
    await provisionGrafanaDashboard({ url: fake.url, dashboard });
    assert.equal(fake.pushes().length, before);
    const first = await open(fake, { dashboard });
    const next = await open(fake, { dashboard });
    assert.notEqual(first.streamId, next.streamId);
    const writes = fake.seen
      .filter(
        (request) =>
          (request.method === "POST" && request.path === COLLECTION) ||
          (request.method === "PUT" &&
            request.path === `${COLLECTION}/${dashboard}`),
      )
      .map((request) => JSON.parse(request.body) as DashboardDocument)
      .filter((body) => body.spec.uid === dashboard);
    assert.equal(writes.length, 3);
    for (const { spec } of writes) {
      assert.equal(spec.title, dashboard);
      assert.deepEqual(spec.time, { from: "now-15d", to: "now" });
      assert.equal(spec.refresh, "30s");
      const variable = spec.templating.list.find(
        (variable) => variable.name === "stream",
      );
      assert.ok(variable);
      assert.equal(variable.type, "query");
      assert.equal(variable.multi, true);
      assert.equal(variable.includeAll, true);
      assert.equal(variable.allValue, ".*");
      assert.equal(variable.refresh, 2);
      assert.equal(variable.regex, '/stream="([^"]+)"/');
      assert.deepEqual(variable.current.text, "All");
      assert.deepEqual([variable.current.value].flat(), ["$__all"]);
      const panels = spec.panels.flatMap((panel) => [
        panel,
        ...(panel.panels ?? []),
      ]);
      assert.ok(panels.some((panel) => panel.type === "table"));
      const detail = spec.panels.find(
        (panel) => panel.type === "row" && panel.collapsed,
      );
      assert.ok(detail?.panels?.length);
      assert.ok(detail.panels);
      for (const panel of detail.panels.filter(
        (panel) => panel.type === "stat",
      )) {
        for (const target of panel.targets ?? []) {
          assert.equal(target.instant, true);
          assert.equal(target.range, false);
        }
      }
      for (const target of detail.panels.flatMap(
        (panel) => panel.targets ?? [],
      )) {
        assert.notEqual(target.interval, "1s");
      }
    }
    await first.close();
    await next.close();
  }
});

test("custom UID ownership and concurrent creation do not overwrite a competing dashboard", async () => {
  const dashboard = "junco-cooperbench";
  const item = `${COLLECTION}/${dashboard}`;
  const untagged = await fakeGrafana(undefined, {
    metadata: { name: dashboard, resourceVersion: "7" },
    spec: { title: "theirs", tags: [] },
  });
  await assert.rejects(
    open(untagged, { dashboard }),
    /exists without tag junco-telemetry/,
  );
  assert.deepEqual(
    untagged.seen.map(({ method, path }) => [method, path]),
    [["GET", item]],
  );
  const tagged = await fakeGrafana(undefined, {
    metadata: { name: dashboard, resourceVersion: "41" },
    spec: { title: "old", tags: ["junco-telemetry"] },
  });
  await (await open(tagged, { dashboard })).close();
  const update = JSON.parse(
    tagged.seen.find(({ method }) => method === "PUT")!.body,
  );
  assert.equal(update.metadata.resourceVersion, "41");
  assert.equal(update.spec.title, dashboard);

  for (const conflict of [false, true]) {
    let winner: DashboardDocument | undefined;
    const raced = await fakeGrafana((request, res) => {
      if (request.path === COLLECTION && request.method === "POST") {
        winner = JSON.parse(request.body) as DashboardDocument;
        winner.metadata.resourceVersion = "2";
        if (conflict) winner.spec.tags = [];
        send(res, 409);
        return true;
      }
      if (request.path === item && request.method === "GET") {
        send(res, winner ? 200 : 404, winner);
        return true;
      }
      return false;
    });
    if (conflict)
      await assert.rejects(
        open(raced, { dashboard }),
        /concurrently created|exists without tag/,
      );
    else await (await open(raced, { dashboard })).close();
    assert.equal(raced.seen.filter(({ method }) => method === "PUT").length, 0);
    assert.ok(
      raced.seen
        .filter(({ method }) => method === "GET")
        .every(({ path }) => path === item),
    );
  }
});

test("provision-only validates dashboard UIDs before any HTTP request", async () => {
  const fake = await fakeGrafana();
  for (const dashboard of ["", "../other", "a".repeat(41)])
    await assert.rejects(
      provisionGrafanaDashboard({ url: fake.url, dashboard }),
      /dashboard/,
    );
  assert.equal(fake.seen.length, 0);
});

test("concurrent benchmark sessions share one managed board without selecting either session", async () => {
  const fake = await fakeGrafana();
  const dashboard = "junco-swebench";
  const recorders = await Promise.all([
    open(fake, { dashboard }),
    open(fake, { dashboard }),
  ]);
  assert.notEqual(recorders[0]!.streamId, recorders[1]!.streamId);
  for (const recorder of recorders) {
    assert.equal(new URL(recorder.dashboardUrl).pathname, `/d/${dashboard}`);
    assert.equal(
      new URL(recorder.dashboardUrl).searchParams.get("var-stream"),
      recorder.streamId,
    );
  }
  const writes = fake.seen.filter(
    ({ method, path }) =>
      (method === "POST" && path === COLLECTION) ||
      (method === "PUT" && path === `${COLLECTION}/${dashboard}`),
  );
  assert.ok(writes.length > 0);
  for (const request of writes) {
    const body = JSON.parse(request.body) as DashboardDocument;
    assert.equal(body.spec.uid, dashboard);
    const variable = body.spec.templating.list.find(
      ({ name }) => name === "stream",
    );
    assert.ok(variable);
    assert.equal(variable.current.text, "All");
    assert.deepEqual([variable.current.value].flat(), ["$__all"]);
  }
  await Promise.all(recorders.map((recorder) => recorder.close()));
});
