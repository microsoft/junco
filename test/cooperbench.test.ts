// Offline shared-worktree driver tests: real native agents, faux models, and the CopyTree Marsh addon.
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type Context,
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type Message,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, schedules, syntax, tools, tracer } from "junco";
import type { NativeModule } from "junco-tools";
import {
  createBenchmarkRecorder,
  createContainerMemorySampler,
  createPair,
  document,
  isTestPath,
  ladderOf,
  marshOptions,
  type Owner,
  type PairRequest,
  pairOutcome,
  parseRequest,
  readContainerMemoryPeak,
  verdicts,
  type YamlAgent,
} from "../examples/cooperbench/wf.ts";
import { userTexts } from "./deterministic-support.ts";

const MODELS = { worker: "faux/worker", leader: "faux/leader" } as const;
const THINKING = "medium" as const;
const native = await import(
  fileURLToPath(
    new URL(
      "../packages/junco-tools/target/native-test/index.js",
      import.meta.url,
    ),
  )
);
const copyTree = {
  ...native,
  NativeMux: { open: native.NativeMux.openCopyTree.bind(native.NativeMux) },
} as unknown as NativeModule;

/** What one agent does next, given its transcript so far; `step` counts its previous model turns. */
type Script = (
  context: Context,
  step: number,
) => AssistantMessage | Promise<AssistantMessage>;
type Call = {
  agent: string;
  model: string;
  reasoning: unknown;
  system: string | undefined;
  messages: Message[];
};

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const done = (text: string) => fauxAssistantMessage(text);

type ToolResult = { text: string; isError: boolean; details: unknown };

/** The text and error flag of the last tool result in `messages`. */
function lastResult(messages: readonly Message[]): ToolResult {
  const last = messages.at(-1);
  assert.ok(
    last?.role === "toolResult",
    `expected a tool result, got ${last?.role}`,
  );
  return {
    text: contentText(last.content),
    isError: last.isError,
    details: last.details,
  };
}

const firstUser = (context: Context) => {
  const first = context.messages.find((m) => m.role === "user");
  return first ? contentText(first.content as never) : "";
};

/** Who a transcript belongs to: the leader its first user message names, or the worker's job (`name@ROUND` when its task names a round). */
function agentOf(context: Context): string {
  const text = firstUser(context);
  const member =
    /You are (?:the )?(Architect|Tester[12]|Implementer[12]|Agent[12])/.exec(
      text,
    );
  if (member) return member[1]!;
  const child = /CHILD-[a-z]+/.exec(text);
  if (child) return child[0];
  throw new Error(`unknown agent: ${text.slice(0, 200)}`);
}

/**
 * One faux provider serving both ladder models, a saved in-memory login, and a dispatcher that
 * routes every request to the script of the agent it belongs to.
 */
async function fauxModels(scripts: Record<string, Script>) {
  const calls: Call[] = [];
  const faux = fauxProvider({
    api: "faux",
    provider: "faux",
    models: [
      { id: "worker", reasoning: true },
      { id: "leader", reasoning: true },
    ],
    tokenSize: { min: 4, max: 4 },
  });
  const respond = async (
    context: Context,
    options: { reasoning?: unknown } | undefined,
    _state: unknown,
    model: { id: string },
  ) => {
    const agent = agentOf(context);
    calls.push({
      agent,
      model: model.id,
      reasoning: options?.reasoning,
      system: context.messages
        .filter((message) => message.role === "system")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : contentText(message.content),
        )
        .join("\n"),
      messages: structuredClone(context.messages),
    });
    const script = scripts[agent];
    if (!script) throw new Error(`no script for ${agent}`);
    return script(
      context,
      context.messages.filter((m) => m.role === "assistant").length,
    );
  };
  faux.setResponses(Array.from({ length: 2000 }, () => respond));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("faux", async () => ({
    type: "api_key",
    key: "fixture-login",
  }));
  const models = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  models.registerNativeProvider(faux.provider);
  return { models, calls };
}

/** A script from a list of steps; each step sees the transcript, so it can inspect the last tool result. */
const steps =
  (
    ...list: ((
      context: Context,
    ) => AssistantMessage | Promise<AssistantMessage>)[]
  ): Script =>
  (context, step) => {
    const next = list[step];
    if (!next) throw new Error(`script exhausted at step ${step}`);
    return next(context);
  };

function request(
  overrides: Partial<
    Record<"agent1" | "agent2", Partial<PairRequest["agents"]["agent1"]>>
  > = {},
  top: Partial<Omit<PairRequest, "agents">> = {},
): PairRequest {
  return {
    mode: "run",
    run_id: "0".repeat(32),
    models: MODELS,
    thinking: THINKING,
    timeout_ms: 7_200_000,
    problem_dir: "/tmp",
    ...top,
    agents: {
      agent1: {
        feature_id: 3,
        task: "Implement feature one.",
        ...overrides.agent1,
      },
      agent2: {
        feature_id: 7,
        task: "Implement feature two.",
        ...overrides.agent2,
      },
    },
  };
}

/** createPair over faux models with real native agents created through the ladder, as runPair creates them. */
async function pair(
  req: PairRequest,
  scripts: Record<string, Script>,
  signal = new AbortController().signal,
  recorder?: tracer.ProfileRecorder<string>,
) {
  const { models, calls } = await fauxModels({
    ...Object.fromEntries(
      ["Architect", "Tester1", "Tester2", "Implementer1", "Implementer2"].map(
        (name) => [name, steps(() => done(`${name} report`))],
      ),
    ),
    ...scripts,
  });
  const ladder = new schedules.ModelLadder(
    models,
    ladderOf(req.models, req.thinking),
  );
  const owners: Owner[] = [];
  const leaders = new Map<string, YamlAgent>();
  const directory = mkdtempSync(join(tmpdir(), "cooperbench-native-"));
  const collection = await tools.ToolCollection.create(directory, {
    ...marshOptions,
    native: copyTree,
  });
  const created = await createPair(req, {
    ladder,
    tracer: new tracer.DummyTracer(),
    recorder,
    signal,
    collection,
    cwd: directory,
    createAgent: async (spec, owner) => {
      owners.push(owner);
      // Descendant lifecycle fixtures deliberately enable task; the canonical graph blocks it.
      const fixtureSpec = Object.keys(scripts).some((name) =>
        name.startsWith("CHILD-"),
      )
        ? { ...spec, tool_block: [] }
        : spec;
      const created = await syntax.createJuncoAgent(fixtureSpec, ladder);
      leaders.set(spec.node, created);
      return created;
    },
  });
  const closeGraph = created.execution.graph.close.bind(
    created.execution.graph,
  );
  created.execution.graph.close = async () => {
    try {
      await closeGraph();
    } finally {
      try {
        await collection.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  };
  return { ...created, calls, owners, directory, leaders };
}

async function closed<T>(
  execution: { graph: { close(): Promise<void> } },
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    await execution.graph.close();
  }
}
const jsonl = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test.each([false, true])(
  "benchmark telemetry retains winning/cancelled native-path events when Live rejects=%s",
  async (rejectPush) => {
    const directory = mkdtempSync(
      join(tmpdir(), "cooperbench-telemetry-race-"),
    );
    const pushes: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (
          path ===
          "/grafana/apis/dashboard.grafana.app/v1/namespaces/default/dashboards/junco-cooperbench"
        )
          return new Response(null, { status: 404 });
        if (
          path ===
            "/grafana/apis/dashboard.grafana.app/v1/namespaces/default/dashboards" &&
          request.method === "POST"
        )
          return Response.json(await request.json(), { status: 201 });
        if (path === "/grafana/api/telemetry/metrics") {
          pushes.push(await request.text());
          return new Response(null, { status: rejectPush ? 503 : 200 });
        }
        return new Response(null, { status: 404 });
      },
    });
    let recorder: tracer.ProfileRecorder<string> | undefined;
    let live: tracer.GrafanaRecorder | undefined;
    try {
      live = await tracer.GrafanaRecorder.create({
        url: `${server.url.origin}/grafana`,
        dashboard: "junco-cooperbench",
        intervalMs: 60_000,
      });
      recorder = await createBenchmarkRecorder(directory, "0".repeat(32), live);
      const before = JSON.parse(
        readFileSync(join(directory, "telemetry.json"), "utf8"),
      );
      expect(before).toMatchObject({
        raw_complete: false,
        profile_complete: false,
        grafana_complete: false,
      });
      const interrupt = new AbortController();
      const won = Promise.withResolvers<void>();
      const sleeping = Promise.withResolvers<void>();
      const run = await pair(
        request(),
        {
          Agent1: steps(
            () =>
              call("task", {
                context: "Native accounting race.",
                tasks: ["CHILD-winning", "CHILD-loser"].map((name) => ({
                  name,
                  task: name,
                  model: { provider: "faux", modelId: "worker" },
                })),
              }),
            () => done("interim"),
            () => done("leader completed"),
          ),
          Agent2: idleLeader,
          "CHILD-winning": steps(
            () => bash("/bin/true"),
            () => {
              won.resolve();
              return done("winning worker report");
            },
          ),
          "CHILD-loser": () => {
            sleeping.resolve();
            return bash("sleep 60");
          },
        },
        interrupt.signal,
        recorder,
      );
      await closed(run.execution, async () => {
        const running = run.execution.run().catch((error) => {
          if (!interrupt.signal.aborted) throw error;
        });
        try {
          await Promise.all([won.promise, sleeping.promise]);
          const deadline = Date.now() + 10_000;
          for (;;) {
            await recorder!.flush().catch(() => undefined);
            const childUsage = jsonl(
              join(directory, "profile_events.jsonl"),
            ).filter(
              (row) =>
                row.node_ids.length === 2 &&
                row.event.kind === "usage" &&
                row.event.resource === "tokens",
            );
            if (childUsage.length === 3) break;
            assert.ok(
              Date.now() < deadline,
              "native child usage was not committed",
            );
            await Bun.sleep(1);
          }
        } finally {
          interrupt.abort(new Error("winning child completed"));
          await run.execution.graph.close();
          await running;
        }
        expect(run.stats.workers).toBe(2);
        expect(
          run.calls.filter((call) => call.agent === "CHILD-winning"),
        ).toHaveLength(2);
        expect(
          run.calls.filter((call) => call.agent === "CHILD-loser"),
        ).toHaveLength(1);
      });
      const closing = recorder.add_context("agent1").close();
      expect(recorder.close()).toBe(closing);
      if (rejectPush)
        await assert.rejects(closing, {
          name: "AggregateError",
          message: "Benchmark telemetry incomplete",
        });
      else await closing;
      expect(pushes.length).toBeGreaterThan(0);
      for (const body of pushes) {
        const payload = JSON.parse(body);
        for (const resource of payload.resourceMetrics)
          for (const scope of resource.scopeMetrics)
            for (const metric of scope.metrics)
              for (const point of metric.gauge.dataPoints) {
                const labels = Object.fromEntries(
                  point.attributes.map(
                    (attribute: {
                      key: string;
                      value: { stringValue: string };
                    }) => [attribute.key, attribute.value.stringValue],
                  ),
                );
                expect(labels.dashboard).toBe("junco-cooperbench");
                expect(labels.stream).toBe(live.streamId);
              }
      }
      const rows = jsonl(join(directory, "profile_events.jsonl"));
      expect(rows.map((row) => row.seq)).toEqual(
        rows.map((_row, index) => index + 1),
      );
      for (const row of rows)
        expect(new Date(row.timestamp).toISOString()).toBe(row.timestamp);
      const tokens = rows.filter(
        (row) =>
          row.node_ids.length === 2 &&
          row.event.kind === "usage" &&
          row.event.resource === "tokens",
      );
      const costs = rows.filter(
        (row) =>
          row.node_ids.length === 2 &&
          row.event.kind === "usage" &&
          row.event.resource === "cost",
      );
      expect(tokens).toHaveLength(3);
      expect(
        costs.map((row) => ({ node: row.node, usage: row.event.usage })),
      ).toEqual(
        tokens.map((row) => ({ node: row.node, usage: row.event.usage })),
      );
      expect(new Set(tokens.map((row) => row.node)).size).toBe(2);
      expect(
        [...new Set(tokens.map((row) => row.node))]
          .map((node) => tokens.filter((row) => row.node === node).length)
          .sort(),
      ).toEqual([1, 2]);
      for (const row of tokens) {
        expect(row.node_ids).toEqual(["Agent1", row.node.split("::")[1]]);
        expect(costs.find((cost) => cost.node === row.node)!.event.source).toBe(
          row.event.source,
        );
      }
      expect(new Set(tokens.map((row) => row.event.source)).size).toBe(2);
      const tools = rows.filter(
        (row) =>
          row.node_ids.length === 2 &&
          row.event.tool === "bash" &&
          row.event.operation === "execute",
      );
      expect(tools.filter((row) => row.event.kind === "start")).toHaveLength(2);
      expect(
        tools
          .filter((row) => row.event.kind === "finish")
          .map((row) => row.event.outcome)
          .sort(),
      ).toEqual(["cancelled", "success"]);
      const samples = jsonl(join(directory, "log.jsonl"));
      const usageSamples = samples.filter(
        (sample) =>
          sample.node.startsWith("Agent1/task-") &&
          sample.resources.cost !== undefined,
      );
      expect(usageSamples.map((sample) => sample.measurement.usage)).toEqual(
        tokens.map((row) => row.event.usage),
      );
      expect(
        tokens.reduce((total, row) => total + row.event.usage.totalTokens, 0),
      ).toBeGreaterThan(0);
      expect(rows.some((row) => row.event.kind === "resource")).toBe(false);
      const after = JSON.parse(
        readFileSync(join(directory, "telemetry.json"), "utf8"),
      );
      expect(after).toMatchObject({
        version: 1,
        run_id: "0".repeat(32),
        raw_complete: true,
        profile_complete: true,
        grafana_complete: !rejectPush,
        stream_id: live.streamId,
        grafana_url: before.grafana_url,
        dashboard_url: before.dashboard_url,
      });
      expect(after.errors.length > 0).toBe(rejectPush);
      if (rejectPush)
        expect(after.errors.join(";")).toContain(
          "metrics push failed with status 503",
        );
    } finally {
      await recorder?.close().catch(() => undefined);
      await live?.close().catch(() => undefined);
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test("benchmark raw snapshots preserve context, activation, usage and metrics at receipt time without Live", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "cooperbench-telemetry-snapshot-"),
  );
  const recorder = await createBenchmarkRecorder(directory, "1".repeat(32));
  try {
    const view = recorder.add_context("a:%").add_context("b");
    const source = {};
    const activation = {
      runId: "activation-run",
      firedAt: "2026-11-01T00:00:00.000Z",
      features: { incoming: { count: 2 } },
      agent: source,
      owner: "owner",
    };
    const operation = {
      resource: "operations",
      category: "graph",
      tool: "",
      operation: "activate",
      activation,
    };
    const usage = {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      totalTokens: 14,
      reasoning: 1,
      cacheWrite1h: 2,
      cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.3,
        cacheWrite: 0.4,
        total: 1,
      },
    };
    const counters = { requested: 2 };
    const gauges = { inflight: 2 };
    view.record({ kind: "start", ...operation });
    view.record({ kind: "usage", resource: "tokens", source, usage });
    view.record({ kind: "usage", resource: "cost", source, usage });
    view.record({ kind: "metrics", ...operation, counters, gauges });
    activation.features.incoming.count = 99;
    usage.input = 99;
    counters.requested = 99;
    gauges.inflight = 99;
    view.record({ kind: "metrics", ...operation, gauges: { inflight: null } });
    view.record({
      kind: "probe",
      resource: "probe",
      edgeId: "probe-edge",
      value: 7,
    });
    const native = {
      kind: "finished" as const,
      pipelineId: 4,
      owner: "owner",
      command: "fixture",
      sample: {
        elapsedMs: 8,
        memoryBytes: 9,
        memoryPeakBytes: 10,
        cpuUsageMs: 11,
        cpuUserMs: 12,
        cpuSystemMs: 13,
        cpuThrottledMs: 14,
        pids: 15,
        oomKills: 16,
      },
    };
    view.record({
      kind: "resource",
      resource: "memory",
      source,
      event: native,
    });
    native.sample.memoryBytes = 99;
    view.record({
      kind: "finish",
      ...operation,
      outcome: "cancelled",
      durationMs: 20,
    });
    await Bun.sleep(1200);
    expect(jsonl(join(directory, "profile_events.jsonl"))).toHaveLength(8);
    const closing = view.close();
    expect(recorder.close()).toBe(closing);
    await closing;
    const rows = jsonl(join(directory, "profile_events.jsonl"));
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.every((row) => row.node === "a%3A%25::b")).toBe(true);
    expect(
      rows.every(
        (row) => JSON.stringify(row.node_ids) === JSON.stringify(["a:%", "b"]),
      ),
    ).toBe(true);
    expect(rows[0]!.event.activation.features.incoming.count).toBe(2);
    expect(rows[1]!.event.usage).toMatchObject({
      input: 2,
      reasoning: 1,
      cacheWrite1h: 2,
      totalTokens: 14,
    });
    expect(rows[3]!.event.counters.requested).toBe(2);
    expect(rows[3]!.event.gauges.inflight).toBe(2);
    expect(rows[4]!.event.gauges.inflight).toBeNull();
    expect(rows[5]!.event).toEqual({
      kind: "probe",
      resource: "probe",
      edgeId: "probe-edge",
      value: 7,
    });
    expect(rows[6]!.event).toMatchObject({
      kind: "resource",
      resource: "memory",
      event: {
        kind: "finished",
        pipelineId: 4,
        owner: "owner",
        command: "fixture",
        sample: { memoryBytes: 9, oomKills: 16 },
      },
    });
    expect(rows[7]!.event.activation_id).toBe(rows[0]!.event.activation_id);
    expect(rows[1]!.event.source).toBe(rows[0]!.event.activation.agent);
    expect(rows[2]!.event.source).toBe(rows[1]!.event.source);
    expect(typeof rows[0]!.event.activation_id).toBe("string");
    expect(source).toEqual({});
    expect(activation.agent).toBe(source);
    expect("activation_id" in activation).toBe(false);
    expect(
      JSON.parse(readFileSync(join(directory, "telemetry.json"), "utf8")),
    ).toMatchObject({
      raw_complete: true,
      profile_complete: true,
      grafana_complete: null,
      grafana_url: null,
      stream_id: null,
      dashboard_url: null,
      errors: [],
    });
    expect(() => readFileSync(join(directory, "memory.json"))).toThrow();
    const retained = readFileSync(
      join(directory, "profile_events.jsonl"),
      "utf8",
    );
    await assert.rejects(createBenchmarkRecorder(directory, "2".repeat(32)), {
      name: "AggregateError",
      message: "Benchmark recorder construction failed",
    });
    expect(readFileSync(join(directory, "profile_events.jsonl"), "utf8")).toBe(
      retained,
    );
  } finally {
    await recorder.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a raw serialization failure still forwards the original usage once and redacts metadata errors", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "cooperbench-telemetry-serialization-"),
  );
  const recorder = await createBenchmarkRecorder(directory, "3".repeat(32));
  try {
    const reported = {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.3,
      },
    };
    let failed = false;
    const usage = {
      ...reported,
      toJSON: () => {
        if (!failed) {
          failed = true;
          throw new Error(
            "snapshot failed http://name:secret@localhost:8000?token=secret",
          );
        }
        return reported;
      },
    };
    expect(() =>
      recorder.record({ kind: "usage", resource: "cost", source: {}, usage }),
    ).not.toThrow();
    recorder.record({
      kind: "probe",
      resource: "probe",
      edgeId: "after-failure",
      value: 4,
    });
    await assert.rejects(recorder.flush(), {
      name: "AggregateError",
      message: "Benchmark telemetry incomplete",
    });
    await assert.rejects(recorder.close(), {
      name: "AggregateError",
      message: "Benchmark telemetry incomplete",
    });
    const raw = jsonl(join(directory, "profile_events.jsonl"));
    expect(raw.map((row) => row.seq)).toEqual([2]);
    expect(raw[0]!.event).toEqual({
      kind: "probe",
      resource: "probe",
      edgeId: "after-failure",
      value: 4,
    });
    const samples = jsonl(join(directory, "log.jsonl"));
    expect(
      samples
        .filter((sample) => sample.resources.cost !== undefined)
        .map((sample) => sample.measurement.usage),
    ).toEqual([reported]);
    const metadata = JSON.parse(
      readFileSync(join(directory, "telemetry.json"), "utf8"),
    );
    expect(metadata).toMatchObject({
      raw_complete: false,
      profile_complete: true,
      grafana_complete: null,
    });
    expect(metadata.errors.join(";")).toContain("snapshot failed");
    expect(metadata.errors.join(";")).not.toContain("secret");
    expect(metadata.errors.join(";")).not.toContain("name:");
  } finally {
    await recorder.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("large UTF-8 protocol and diagnostic pipes drain intact before exit", () => {
  const module = new URL("../examples/cooperbench/wf.ts", import.meta.url)
    .pathname;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { emit, emitLog, flushEvents } = await import(${JSON.stringify(module)});
    const text = "λ🙂".repeat(40000);
    for (let id = 0; id < 8; id++) emit({ type: "message", id, text });
    await flushEvents();
    for (let id = 0; id < 8; id++) emitLog(JSON.stringify({ type: "diagnostic", id, text }));
    emit({ type: "result" });
    await flushEvents();
    process.exit();
  `,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.endsWith("\n")).toBe(true);
  const records = result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.slice(0, -1).map(({ id, text }) => [id, text])).toEqual(
    Array.from({ length: 8 }, (_, id) => [id, "λ🙂".repeat(40000)]),
  );
  expect(records.at(-1).type).toBe("result");
  expect(result.stderr.endsWith("\n")).toBe(true);
  const diagnostics = result.stderr
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(diagnostics).toEqual(
    Array.from({ length: 8 }, (_, id) => ({
      type: "diagnostic",
      id,
      text: "λ🙂".repeat(40000),
    })),
  );
});

test.each([
  "",
  " ",
  "not-a-url",
  "file:///tmp/grafana",
  "http://name:secret@localhost:8000",
  "http://localhost:8000?token=secret",
  "http://localhost:8000#secret",
])("GRAFANA_URL rejects unsafe explicit value %s before preflight", (value) => {
  const result = spawnSync(
    process.execPath,
    [new URL("../examples/cooperbench/wf.ts", import.meta.url).pathname],
    {
      input: JSON.stringify({
        mode: "preflight",
        models: MODELS,
        thinking: THINKING,
      }),
      encoding: "utf8",
      env: { ...process.env, GRAFANA_URL: value },
      timeout: 10_000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("GRAFANA_URL must be");
  expect(result.stderr).not.toContain("secret");
});

const SENTINEL = {
  agent1: "ASSIGNMENT-SENTINEL-ONE",
  agent2: "ASSIGNMENT-SENTINEL-TWO",
} as const;
const NOTE = {
  agent1: "PEER-NOTE-FROM-ONE",
  agent2: "PEER-NOTE-FROM-TWO",
} as const;

test("the Architect receives both assignments, teams receive only theirs, and peer notes arrive as steered user messages after send and yield", async () => {
  const seen: Record<string, Record<string, ToolResult>> = {
    Agent1: {},
    Agent2: {},
  };
  const assignments: Record<string, string[]> = {};
  const peerMessages: Record<string, string[]> = {};
  const leader = (key: "agent1" | "agent2") => {
    const name = key === "agent1" ? "Agent1" : "Agent2";
    const out = key === "agent1" ? "agent1-to-agent2" : "agent2-to-agent1";
    const keep =
      (label: string, next: () => AssistantMessage) => (context: Context) => {
        seen[name]![label] = lastResult(
          context.messages.filter((message) => message.role === "toolResult"),
        );
        return next();
      };
    return steps(
      (context) => {
        assignments[name] = userTexts(context.messages).slice(1);
        return call("info", {});
      },
      // `send` requires the held task's id (the assignment's `Task:` line), even for a plain note.
      keep("info", () =>
        call("send", {
          id: out,
          payload: NOTE[key],
          task: JSON.parse(
            assignments[name]!.at(-1)!.split("\n\nTask: ").at(-1)!,
          ).taskId,
          spec: "",
          handoff: "",
        }),
      ),
      keep("send", () => call("yield", { reason: "await peer plan" })),
      (context) => {
        peerMessages[name] = userTexts(context.messages).slice(
          1 + assignments[name]!.length,
        );
        return done(`${name} done`);
      },
    );
  };
  const req = request({
    agent1: { task: `Implement ${SENTINEL.agent1}.` },
    agent2: { task: `Implement ${SENTINEL.agent2}.` },
  });
  const { execution, calls, owners, stats } = await pair(req, {
    Agent1: leader("agent1"),
    Agent2: leader("agent2"),
  });
  await closed(execution, async () => {
    const results = await execution.run();
    expect(
      syntax.finalText(results.get(graph.NodeId.create("Agent1")), "Agent1"),
    ).toBe("Agent1 done");
    expect(
      syntax.finalText(results.get(graph.NodeId.create("Agent2")), "Agent2"),
    ).toBe("Agent2 done");
  });
  const architect = calls.filter((c) => c.agent === "Architect");
  expect(architect.length).toBeGreaterThan(0);
  for (const sentinel of Object.values(SENTINEL))
    expect(JSON.stringify(architect[0]!.messages)).toContain(sentinel);
  for (const name of [
    "Architect",
    "Tester1",
    "Implementer1",
    "Agent1",
    "Tester2",
    "Implementer2",
    "Agent2",
  ]) {
    const mine = calls.filter((c) => c.agent === name);
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((c) => c.model))).toEqual(new Set(["worker"]));
    expect(document.graph.nodes[name]).toMatchObject({ tool_block: ["task"] });
    if (name !== "Architect") {
      const [own, other] = name.endsWith("1")
        ? [SENTINEL.agent1, SENTINEL.agent2]
        : [SENTINEL.agent2, SENTINEL.agent1];
      expect(JSON.stringify(mine[0]!.messages)).toContain(own);
      for (const c of mine)
        expect(JSON.stringify(c.messages)).not.toContain(other);
    }
  }
  expect(stats).toEqual({ agents: 7, workers: 0 });
  for (const [name, key, other] of [
    ["Agent1", "agent1", "agent2"],
    ["Agent2", "agent2", "agent1"],
  ] as const) {
    const mine = calls.filter((c) => c.agent === name);
    expect(assignments[name]!.join("\n")).toContain(SENTINEL[key]);
    for (const c of mine)
      expect(JSON.stringify(c.messages)).not.toContain(SENTINEL[other]);
    expect(seen[name]!.info!.text).not.toContain(SENTINEL[key]);
    expect(seen[name]!.send!.isError).toBe(false);
    const delivered = peerMessages[name]!.join("\n");
    expect(delivered.split(NOTE[other]).length - 1).toBe(1);
    expect(delivered).not.toContain(NOTE[key]);
  }
  expect(owners.map((o) => [o.team, o.node_id])).toEqual([
    ["agent1", "Architect"],
    ["agent1", "Tester1"],
    ["agent1", "Implementer1"],
    ["agent1", "Agent1"],
    ["agent2", "Tester2"],
    ["agent2", "Implementer2"],
    ["agent2", "Agent2"],
  ]);
}, 20_000);

test("both leaders' own reports decide Submitted: an abnormal member report cannot hide behind the lead's sink result", async () => {
  const { execution } = await pair(request(), {
    Agent1: steps(() => done("Agent1 done")),
    Agent2: steps(() => fauxAssistantMessage("", { stopReason: "length" })),
  });
  const values = await closed(execution, async () => {
    const results = await execution.run();
    // The sink retains Agent1's report even though Agent2 ended abnormally.
    expect(execution.graph.result(execution.graph.sink.id)._tag).toBe("Some");
    return {
      agent1: results.get(graph.NodeId.create("Agent1")),
      agent2: results.get(graph.NodeId.create("Agent2")),
    };
  });
  const outcome = pairOutcome(values, {
    completed: true,
    errors: [],
    limited: false,
  });
  expect(outcome.status).toBe("Error");
  expect(outcome.agents.agent1.status).toBe("Submitted");
  expect(outcome.agents.agent2.status).toBe("Error");
  expect(
    pairOutcome(
      { agent1: values.agent1 },
      { completed: true, errors: [], limited: false },
    ).status,
  ).toBe("Error");
  expect(
    pairOutcome(
      { agent1: values.agent1, agent2: values.agent1 },
      { completed: true, errors: [], limited: false },
    ).status,
  ).toBe("Submitted");
  // A cleanup failure alone also prevents Submitted.
  expect(
    pairOutcome(
      { agent1: values.agent1, agent2: values.agent1 },
      { completed: true, errors: ["cleanup"], limited: false },
    ).status,
  ).toBe("Error");
}, 20_000);

test("the request boundary rejects malformed, unknown or ambiguous input", () => {
  const valid = request();
  expect(parseRequest(JSON.stringify(valid))).toEqual(valid);
  expect(
    parseRequest(
      JSON.stringify({ mode: "preflight", models: MODELS, thinking: THINKING }),
    ).mode,
  ).toBe("preflight");
  const agents = valid.agents;
  const variants: Record<string, unknown> = {
    "extra field": { ...valid, extra: 1 },
    "single model field": { ...valid, model: "faux/leader" },
    "missing leader model": { ...valid, models: { worker: "faux/worker" } },
    "model without provider": {
      ...valid,
      models: { ...MODELS, leader: "opus" },
    },
    "role-specific thinking": {
      ...valid,
      thinking: { worker: "off", leader: "low" },
    },
    "zero deadline": { ...valid, timeout_ms: 0 },
    "negative deadline": { ...valid, timeout_ms: -1 },
    "fractional deadline": { ...valid, timeout_ms: 1.5 },
    "short run id": { ...valid, run_id: "abc" },
    "image tag instead of id": {
      ...valid,
      image_id: "akhatua/cooperbench-llama-index:task17244",
    },
    "relative problem_dir": { ...valid, problem_dir: "logs/pair" },
    "third agent": { ...valid, agents: { ...agents, agent3: agents.agent1 } },
    "blank task": {
      ...valid,
      agents: { ...agents, agent2: { ...agents.agent2, task: " \n\t" } },
    },
    "short container": {
      ...valid,
      agents: { ...agents, agent2: { ...agents.agent2, container_id: "abc" } },
    },
    "shared container": {
      ...valid,
      agents: {
        ...agents,
        agent2: { ...agents.agent2, container_id: "a".repeat(64) },
      },
    },
    "shared feature": {
      ...valid,
      agents: { ...agents, agent2: { ...agents.agent2, feature_id: 3 } },
    },
    "preflight with run fields": {
      mode: "preflight",
      models: MODELS,
      thinking: THINKING,
      run_id: valid.run_id,
    },
    "unknown thinking level": {
      ...valid,
      thinking: "extreme",
    },
  };
  expect(() => parseRequest("{not json")).toThrow(/not JSON/);
  for (const [name, value] of Object.entries(variants))
    expect(() => parseRequest(JSON.stringify(value)), name).toThrow(
      /invalid request/,
    );
});

test("one thinking level reaches both model rungs; off omits thinking", () => {
  expect(
    parseRequest(JSON.stringify(request({}, { timeout_ms: 60_000 }))),
  ).toMatchObject({ timeout_ms: 60_000 });
  for (const thinking of ["medium", "off"] as const) {
    const rung = (model: string) =>
      thinking === "off" ? { model } : { model, thinking };
    expect(ladderOf(MODELS, thinking)).toEqual({
      smol: rung(MODELS.worker),
      low: rung(MODELS.worker),
      med: rung(MODELS.worker),
      high: rung(MODELS.leader),
      xhigh: rung(MODELS.leader),
    });
  }
});

test.each([
  ["tests/test_x.py", true],
  ["pkg/foo_test.go", true],
  ["src/a.spec.ts", true],
  ["src/tests_util.py", false],
  ["pkg/testing.go", false],
])("grader test path %s is %s", (path, expected) => {
  expect(isTestPath(path)).toBe(expected);
});

test("role verdict checks require structural completion evidence", () => {
  expect(
    verdicts.Architect(
      "## Interfaces\n## Ownership\n## Shared-file protocol\n## Conflicts\n## Test setup\n## Risks",
    ),
  ).toBe(true);
  expect(verdicts.Architect("## Interfaces\n## Ownership")).toBe(false);
  expect(
    verdicts.Tester(
      "- tests/test_x.py — AC-1\nTEST_COMMAND: pytest -q\nSUITE_COMMAND: pytest\nRED: yes",
    ),
  ).toBe(true);
  expect(
    verdicts.Tester(
      "- src/main.py — AC-1\nTEST_COMMAND: pytest -q\nSUITE_COMMAND: pytest\nRED: yes",
    ),
  ).toBe(false);
  expect(
    verdicts.Implementer(
      "TEST_COMMAND: pytest -q exit=0\nSUITE_COMMAND: pytest exit=0",
    ),
  ).toBe(true);
  expect(
    verdicts.Implementer(
      "TEST_COMMAND: pytest -q exit=1\nSUITE_COMMAND: pytest exit=0",
    ),
  ).toBe(false);
});

const task = (name: string, model = { provider: "faux", modelId: "worker" }) =>
  call("task", {
    context: "Self-contained fixture context.",
    tasks: [{ name, task: name, model }],
  });
const bash = (command: string) => call("bash", { command });
const reports = (context: Context) =>
  context.messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const text = contentText(message.content as never);
    return text.startsWith('{"type":"task_result"') ? [JSON.parse(text)] : [];
  });
const idleLeader = steps(() => done("Agent2 done"));

test("leaders deny competing writes, keep disjoint files, and release permits handoff", async () => {
  const cache =
    "mkdir -p .cache && (test ! -f .cache/generated || cat .cache/generated) && printf cached > .cache/generated";
  const run = await pair(request(), {
    Agent1: steps(
      () => bash("printf original > shared.txt"),
      () => bash(cache),
      () => done("claimed"),
      () => call("release", { file: "shared.txt" }),
      () => call("release", { file: ".cache/generated" }),
      () => done("released"),
    ),
    Agent2: steps(
      () => bash("printf stolen > shared.txt"),
      (context) => {
        expect(lastResult(context.messages).isError).toBe(true);
        expect(readFileSync(join(run.directory, "shared.txt"), "utf8")).toBe(
          "original",
        );
        return bash("printf independent > other.txt");
      },
      () => bash(cache),
      (context) => {
        expect(lastResult(context.messages).isError).toBe(true);
        expect(
          readFileSync(join(run.directory, ".cache/generated"), "utf8"),
        ).toBe("cached");
        return done("denied competitor; independent write completed");
      },
      () => bash("cat shared.txt; printf handed-off > shared.txt"),
      (context) => {
        expect(lastResult(context.messages).isError).toBe(false);
        return bash(cache);
      },
      (context) => {
        expect(lastResult(context.messages).isError).toBe(false);
        return call("release", { file: "shared.txt" });
      },
      () => call("release", { file: ".cache/generated" }),
      () => call("release", { file: "other.txt" }),
      () => done("handoff complete"),
    ),
  });
  const drive = async (name: string) => {
    const agent = run.leaders.get(name)!;
    if (agent.status === "idle")
      agent.stagePrompt(`You are ${name}; exercise the ownership boundary.`);
    for (;;) {
      const step = await agent.next({ values: new Map(), messages: new Map() });
      assert.equal(step.done, false);
      if (step.value?.kind === "failed") throw step.value.error;
      if (step.value?.kind === "settled")
        return syntax.finalText(step.value.message, name);
    }
  };
  await closed(run.execution, async () => {
    expect(await drive("Agent1")).toBe("claimed");
    expect(await drive("Agent2")).toBe(
      "denied competitor; independent write completed",
    );
    expect(await drive("Agent1")).toBe("released");
    expect(await drive("Agent2")).toBe("handoff complete");
    expect(readFileSync(join(run.directory, "shared.txt"), "utf8")).toBe(
      "handed-off",
    );
    expect(readFileSync(join(run.directory, "other.txt"), "utf8")).toBe(
      "independent",
    );
    expect(readFileSync(join(run.directory, ".cache/generated"), "utf8")).toBe(
      "cached",
    );
  });
}, 30_000);

test("native descendants use the worker model and common thinking, inherit policy, and grandchildren can read", async () => {
  let childDenied = false;
  let grandchildRead = false;
  const run = await pair(request(), {
    Agent1: steps(
      () => bash("printf leader-owned > owned.txt"),
      () => task("CHILD-worker"),
      () => done("leader interim"),
      () => call("release", { file: "owned.txt" }),
      () => done("Agent1 done"),
    ),
    Agent2: idleLeader,
    "CHILD-worker": steps(
      () => bash("printf overwritten > owned.txt"),
      (context) => {
        childDenied = lastResult(context.messages).isError;
        return task("CHILD-grandchild");
      },
      () => done("child interim"),
      () => done("child final"),
    ),
    "CHILD-grandchild": steps(
      () => call("read", { path: "owned.txt" }),
      (context) => {
        const result = lastResult(context.messages);
        expect(result.isError).toBe(false);
        grandchildRead = result.text.includes("leader-owned");
        return done("grandchild read completed");
      },
    ),
  });
  await closed(run.execution, async () => {
    await run.execution.run();
    expect(childDenied).toBe(true);
    expect(grandchildRead).toBe(true);
    expect(run.stats.workers).toBe(2);
    expect(readFileSync(join(run.directory, "owned.txt"), "utf8")).toBe(
      "leader-owned",
    );
    for (const name of ["CHILD-worker", "CHILD-grandchild"]) {
      const calls = run.calls.filter((call) => call.agent === name);
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls.map((call) => call.model))).toEqual(
        new Set(["worker"]),
      );
      expect(new Set(calls.map((call) => call.reasoning))).toEqual(
        new Set([THINKING]),
      );
    }
  });
}, 30_000);

test.each([
  undefined,
  { provider: "faux", modelId: "leader" },
  { provider: "other", modelId: "worker" },
])(
  "canonical task blocking rejects task model %j without acquiring a child",
  async (model) => {
    let rejection: ToolResult | undefined;
    const run = await pair(request(), {
      Agent1: steps(
        () =>
          call("task", {
            context: "fixture",
            tasks: [
              {
                name: "CHILD-forbidden",
                task: "CHILD-forbidden",
                ...(model === undefined ? {} : { model }),
              },
            ],
          }),
        (context) => {
          rejection = lastResult(context.messages);
          return done("Agent1 done");
        },
      ),
      Agent2: idleLeader,
    });
    await closed(run.execution, () => run.execution.run());
    expect(rejection?.isError).toBe(true);
    expect(rejection?.text).toMatch(/task|unknown tool/i);
    expect(run.calls.some((call) => call.agent === "CHILD-forbidden")).toBe(
      false,
    );
    expect(run.stats.workers).toBe(0);
  },
  30_000,
);

test("a failed worker leaves its published data owned; its parent cannot edit or release it", async () => {
  let phase = 0;
  let editDenied = false;
  let releaseDenied = false;
  const run = await pair(request(), {
    Agent1: (context, step) => {
      if (step === 0) return task("CHILD-abandon");
      const failed = reports(context).find((report) => report.decisionRequired);
      if (phase === 0 && failed) {
        phase++;
        return call("task", {
          action: "ignore",
          id: failed.id,
          attempt: failed.attempt,
        });
      }
      if (phase === 1) {
        phase++;
        return bash("printf repaired > abandoned.txt");
      }
      if (phase === 2) {
        phase++;
        editDenied = lastResult(context.messages).isError;
        return call("release", { file: "abandoned.txt" });
      }
      if (phase === 3) {
        phase++;
        releaseDenied = lastResult(context.messages).isError;
      }
      return done("Agent1 done");
    },
    Agent2: idleLeader,
    "CHILD-abandon": steps(
      () => bash("printf abandoned-data > abandoned.txt"),
      () =>
        fauxAssistantMessage("worker failed without releasing", {
          stopReason: "length",
        }),
    ),
  });
  await closed(run.execution, async () => {
    await run.execution.run();
    expect(editDenied).toBe(true);
    expect(releaseDenied).toBe(true);
    expect(readFileSync(join(run.directory, "abandoned.txt"), "utf8")).toBe(
      "abandoned-data",
    );
  });
}, 30_000);

test("pair completion waits for a live native child even after its leader gives an interim final answer", async () => {
  const active = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const interim = Promise.withResolvers<void>();
  const run = await pair(request(), {
    Agent1: steps(
      () => task("CHILD-held"),
      () => {
        interim.resolve();
        return done("interim final answer");
      },
      () => done("Agent1 done after child"),
    ),
    Agent2: idleLeader,
    "CHILD-held": async () => {
      active.resolve();
      await release.promise;
      return done("child completed");
    },
  });
  await closed(run.execution, async () => {
    let complete = false;
    const running = run.execution.run().finally(() => {
      complete = true;
    });
    try {
      await Promise.all([active.promise, interim.promise]);
      await Bun.sleep(20);
      expect(complete).toBe(false);
    } finally {
      release.resolve();
      await running;
    }
    expect(complete).toBe(true);
  });
}, 30_000);

const memoryFiles = () =>
  new Map([
    ["/.dockerenv", ""],
    ["/proc/self/cgroup", "0::/\n"],
    ["/proc/1/cgroup", "0::/\n"],
    [
      "/proc/self/mountinfo",
      "30 20 0:29 / /sys/fs/cgroup ro,nosuid,nodev,noexec - cgroup2 cgroup rw\n",
    ],
    ["/sys/fs/cgroup/memory.peak", "123456\n"],
  ]);

test("container peak requires the private Docker cgroup root and exact integer bytes", async () => {
  const files = memoryFiles();
  const read = async (path: string) => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return files.get(path)!;
  };
  expect(await readContainerMemoryPeak(read)).toBe(123456);
  for (const invalid of [
    "",
    "-1",
    "1.5",
    "1e3",
    "NaN",
    "Infinity",
    "9007199254740992",
  ]) {
    files.set("/sys/fs/cgroup/memory.peak", invalid);
    await assert.rejects(
      readContainerMemoryPeak(read),
      /finite nonnegative safe-integer/,
    );
  }
  files.set("/sys/fs/cgroup/memory.peak", "0");
  expect(await readContainerMemoryPeak(read)).toBe(0);
  for (const path of ["/.dockerenv", "/sys/fs/cgroup/memory.peak"]) {
    const saved = files.get(path)!;
    files.delete(path);
    await assert.rejects(
      readContainerMemoryPeak(read),
      /Container memory prerequisite failed.*ENOENT/,
    );
    files.set(path, saved);
  }
  for (const path of ["/proc/self/cgroup", "/proc/1/cgroup"]) {
    files.set(path, "0::/docker/sibling\n");
    await assert.rejects(
      readContainerMemoryPeak(read),
      /private Docker cgroup/,
    );
    files.set(path, "0::/\n");
  }
  for (const mount of [
    "30 20 0:29 /docker/host /sys/fs/cgroup ro - cgroup2 cgroup rw",
    "30 20 0:29 / /sys/fs/cgroup rw - tmpfs tmpfs rw",
  ]) {
    files.set("/proc/self/mountinfo", mount);
    await assert.rejects(
      readContainerMemoryPeak(read),
      /private cgroup v2 root/,
    );
  }
});

test("container sampler final root metric follows all owned shutdown and precedes sink close", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cooperbench-memory-"));
  const order: string[] = [];
  let peak = 100;
  try {
    {
      await using lifetime = new AsyncDisposableStack();
      const recorder = lifetime.adopt(
        await createBenchmarkRecorder(directory, "4".repeat(32)),
        async (owned) => {
          order.push("recorder");
          await owned.close();
        },
      );
      const sampler = lifetime.adopt(
        await createContainerMemorySampler(
          directory,
          "4".repeat(32),
          recorder,
          async () => {
            order.push("sample");
            return peak;
          },
        ),
        (owned) => owned.close(),
      );
      lifetime.defer(() => {
        order.push("opik");
        peak = 900;
      });
      lifetime.defer(() => {
        order.push("collection");
      });
      lifetime.defer(() => {
        order.push("agents");
      });
      lifetime.defer(() => {
        order.push("graph");
      });
      expect(sampler).toBeDefined();
    }
    expect(order).toEqual([
      "sample",
      "graph",
      "agents",
      "collection",
      "opik",
      "sample",
      "recorder",
    ]);
    const rows = readFileSync(join(directory, "profile_events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.node_ids)).toEqual([[], []]);
    expect(rows.at(-1).event).toEqual({
      resource: "memory",
      kind: "metrics",
      category: "benchmark",
      tool: "",
      operation: "container_memory",
      gauges: { peak_memory_bytes: 900 },
    });
    expect(
      JSON.parse(readFileSync(join(directory, "memory.json"), "utf8")),
    ).toEqual({
      version: 1,
      run_id: "4".repeat(32),
      scope: "container",
      source: "cgroup_v2",
      peak_memory_bytes: 900,
      complete: true,
      errors: [],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("container sampler preserves failed and decreasing final reads without inventing zero", async () => {
  for (const final of [
    NaN,
    -1,
    0.5,
    50,
    new Error("memory.peak disappeared"),
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "cooperbench-memory-error-"));
    const recorder = await createBenchmarkRecorder(directory, "5".repeat(32));
    let reads = 0;
    try {
      const sampler = await createContainerMemorySampler(
        directory,
        "5".repeat(32),
        recorder,
        async () => {
          if (++reads === 1) return 100;
          if (final instanceof Error) throw final;
          return final;
        },
      );
      const closing = sampler.close();
      expect(sampler.close()).toBe(closing);
      await assert.rejects(closing, /Container memory incomplete/);
      const memory = JSON.parse(
        readFileSync(join(directory, "memory.json"), "utf8"),
      );
      expect(memory).toMatchObject({ peak_memory_bytes: 100, complete: false });
      expect(memory.errors).toHaveLength(1);
    } finally {
      await recorder.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("an unsupported initial memory read leaves an honest unavailable sidecar", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cooperbench-memory-missing-"));
  const recorder = await createBenchmarkRecorder(directory, "6".repeat(32));
  try {
    await assert.rejects(
      createContainerMemorySampler(
        directory,
        "6".repeat(32),
        recorder,
        async () => {
          throw new Error("private Docker cgroup required");
        },
      ),
      /Container memory incomplete/,
    );
    expect(
      JSON.parse(readFileSync(join(directory, "memory.json"), "utf8")),
    ).toMatchObject({
      peak_memory_bytes: null,
      complete: false,
      errors: ["private Docker cgroup required"],
    });
  } finally {
    await recorder.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("container sampler drains the in-flight periodic read before its final sample", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cooperbench-memory-drain-"));
  const recorder = await createBenchmarkRecorder(directory, "7".repeat(32));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  let sampler:
    | Awaited<ReturnType<typeof createContainerMemorySampler>>
    | undefined;
  try {
    sampler = await createContainerMemorySampler(
      directory,
      "7".repeat(32),
      recorder,
      async () => {
        reads++;
        if (reads === 2) {
          started.resolve();
          await release.promise;
          throw new Error("transient periodic failure");
        }
        return reads * 100;
      },
    );
    await started.promise;
    let closed = false;
    const closing = sampler.close().finally(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(reads).toBe(2);
    release.resolve();
    await assert.rejects(closing, /Container memory incomplete/);
    expect(reads).toBe(3);
    expect(
      JSON.parse(readFileSync(join(directory, "memory.json"), "utf8")),
    ).toMatchObject({
      peak_memory_bytes: 300,
      complete: false,
      errors: ["transient periodic failure"],
    });
  } finally {
    release.resolve();
    await sampler?.close().catch(() => undefined);
    await recorder.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
