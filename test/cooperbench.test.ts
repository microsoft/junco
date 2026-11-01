// Offline behaviour of the CooperBench pair driver: real native agents over deterministic faux models, no credentials,
// external network or Docker. `JUNCO_DOCKER_TESTS=1` adds integration cases with real disposable task
// containers (the cached llama_index image; nothing is pulled or built).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
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
import { graph, syntax, tracer } from "junco";
import {
  type BatchDetails,
  createBenchmarkRecorder,
  createPair,
  createWorker,
  ladderOf,
  type Owner,
  type PairRequest,
  pairOutcome,
  parseRequest,
  SCOPE_LABEL,
  type WorkItem,
  type YamlAgent,
} from "../examples/cooperbench/wf.ts";

const MODELS = { worker: "faux/worker", leader: "faux/leader" } as const;
const THINKING = { worker: "off", leader: "low" } as const;

/** What one agent does next, given its transcript so far; `step` counts its previous model turns. */
type Script = (
  context: Context,
  step: number,
) => AssistantMessage | Promise<AssistantMessage>;
type Call = { agent: string; model: string; messages: Message[] };

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
  const leader = /You are (Agent[12])/.exec(text);
  if (leader) return leader[1]!;
  const job = /^Job ID: (\S+)\nJob: (.+)$/m.exec(text);
  const round = /ROUND-(\w+)/.exec(text);
  if (job) return round ? `${job[2]}@${round[1]}` : job[2]!;
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
    _options: unknown,
    _state: unknown,
    model: { id: string },
  ) => {
    const agent = agentOf(context);
    calls.push({
      agent,
      model: model.id,
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
    image_id: `sha256:${"f".repeat(64)}`,
    models: MODELS,
    thinking: THINKING,
    timeout_ms: 7_200_000,
    problem_dir: "/tmp",
    ...top,
    agents: {
      agent1: {
        feature_id: 3,
        task: "Implement feature one.",
        container_id: "a".repeat(64),
        ...overrides.agent1,
      },
      agent2: {
        feature_id: 7,
        task: "Implement feature two.",
        container_id: "b".repeat(64),
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
) {
  const { models, calls } = await fauxModels(scripts);
  const owners: Owner[] = [];
  const failure = new AbortController();
  const created = await createPair(req, {
    models,
    tracer: new tracer.DummyTracer(),
    signal,
    failure,
    createAgent: async (spec, owner) => {
      owners.push(owner);
      return syntax.createJuncoAgent(
        spec,
        ladderOf(req.models, req.thinking),
        models,
      );
    },
  });
  return { ...created, calls, owners, failure };
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

/** The production tournament's worker graphs and native committed usage, without Docker provisioning. */
async function recordedRace(recorder: tracer.ProfileRecorder<string>) {
  const sleeping = Promise.withResolvers<void>();
  const winningJob = "winning-job";
  const losingJob = "losing-job";
  const { models } = await fauxModels({
    winner: steps(
      () => call("container_bash", { command: "win" }),
      () => call("send", { id: "completion", payload: winningJob }),
      () => done("winning worker report"),
    ),
    loser: steps(() => call("container_bash", { command: "wait" })),
  });
  const workspace: AgentTool = {
    name: "container_bash",
    label: "container_bash",
    description: "fixture",
    parameters: {
      type: "object",
      required: ["command"],
      properties: { command: { type: "string" } },
    } as never,
    execute: async (_id, args, signal) => {
      if ((args as { command: string }).command === "wait") {
        assert.ok(signal);
        sleeping.resolve();
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      }
      await sleeping.promise;
      return {
        content: [{ type: "text", text: "win!" }],
        details: { exit_code: 0 },
      };
    },
  };
  const observer = new tracer.DummyTracer();
  const agents: YamlAgent[] = [];
  const committed: { node: string; usage: unknown; adjustment: boolean }[] = [];
  const executions: Awaited<ReturnType<typeof createWorker>>[] = [];
  const stopped = new AbortController();
  try {
    for (const [job, name] of [
      [winningJob, "winner"],
      [losingJob, "loser"],
    ]) {
      const view = recorder
        .add_context("agent1")
        .add_context("batch:telemetry%")
        .add_context(job!);
      assert.equal(view.root, recorder);
      assert.equal(view.add_context(""), view);
      const execution = await createWorker(
        job!,
        { name: name!, task: "Do the leaf.", check: "true" },
        workspace,
        {
          models,
          ladder: ladderOf(MODELS, THINKING),
          tracer: observer,
          recorder: view,
          createAgent: async (spec) => {
            const agent = await syntax.createJuncoAgent(
              spec,
              ladderOf(MODELS, THINKING),
              models,
            );
            agents.push(agent);
            agent.events.on("usage", ({ row }) => {
              committed.push({
                node: view.add_context("Worker").path,
                usage: structuredClone(row.usage),
                adjustment: row.adjustment,
              });
            });
            return agent;
          },
        },
      );
      executions.push(execution);
    }
    const losing = executions[1]!.run({ signal: stopped.signal }).then(
      () => "finished",
      () => "cancelled",
    );
    const winner = await executions[0]!.run();
    expect(
      syntax.finalText(winner.get(graph.NodeId.create("Collect")), "Worker"),
    ).toBe("winning worker report");
    stopped.abort(new Error("tournament winner selected"));
    expect(await losing).toBe("cancelled");
  } finally {
    stopped.abort(new Error("fixture finished"));
    const closed = await Promise.allSettled([
      ...executions.map((execution) => execution.graph.close()),
      ...agents.map((agent) => agent.return()),
    ]);
    await observer.flush();
    expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
  }
  expect(agents.every((agent) => agent.status === "closed")).toBe(true);
  return committed;
}

test.each([false, true])(
  "benchmark telemetry retains winning/cancelled workers when Live rejects=%s",
  async (rejectPush) => {
    const directory = mkdtempSync(
      join(tmpdir(), "cooperbench-telemetry-race-"),
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (
          path ===
          "/grafana/apis/dashboard.grafana.app/v1/namespaces/default/dashboards/junco-telemetry"
        )
          return new Response(null, { status: 404 });
        if (
          path ===
            "/grafana/apis/dashboard.grafana.app/v1/namespaces/default/dashboards" &&
          request.method === "POST"
        )
          return Response.json(await request.json(), { status: 201 });
        if (path.startsWith("/grafana/api/live/push/")) {
          await request.text();
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
        grafana_url: `${server.url.origin}/grafana`,
      });
      const committed = await recordedRace(recorder);
      const closing = recorder.add_context("agent1").close();
      expect(recorder.close()).toBe(closing);
      if (rejectPush)
        await assert.rejects(closing, {
          name: "AggregateError",
          message: "Benchmark telemetry incomplete",
        });
      else await closing;
      const rows = jsonl(join(directory, "profile_events.jsonl"));
      expect(rows.map((row) => row.seq)).toEqual(
        rows.map((_row, index) => index + 1),
      );
      for (const row of rows)
        expect(new Date(row.timestamp).toISOString()).toBe(row.timestamp);
      const tokens = rows.filter(
        (row) => row.event.kind === "usage" && row.event.resource === "tokens",
      );
      const costs = rows.filter(
        (row) => row.event.kind === "usage" && row.event.resource === "cost",
      );
      expect(
        tokens.map((row) => ({ node: row.node, usage: row.event.usage })),
      ).toEqual(committed.map(({ node, usage }) => ({ node, usage })));
      expect(
        costs.map((row) => ({ node: row.node, usage: row.event.usage })),
      ).toEqual(committed.map(({ node, usage }) => ({ node, usage })));
      expect(new Set(tokens.map((row) => row.node))).toEqual(
        new Set([
          "agent1::batch%3Atelemetry%25::winning-job::Worker",
          "agent1::batch%3Atelemetry%25::losing-job::Worker",
        ]),
      );
      for (const row of tokens) {
        expect(row.node_ids).toEqual([
          "agent1",
          "batch:telemetry%",
          row.node_ids[2],
          "Worker",
        ]);
        expect(costs.find((cost) => cost.node === row.node)!.event.source).toBe(
          row.event.source,
        );
        const activation = rows.find(
          (event) =>
            event.node === row.node &&
            event.event.kind === "start" &&
            event.event.activation !== undefined,
        )!;
        expect(activation.event.activation.agent).toBe(row.event.source);
        const finish = rows.find(
          (event) =>
            event.event.kind === "finish" &&
            event.event.activation_id === activation.event.activation_id,
        )!;
        expect(finish.event.activation).toEqual(activation.event.activation);
      }
      expect(new Set(tokens.map((row) => row.event.source)).size).toBe(2);
      const tools = rows.filter((row) => row.event.tool === "container_bash");
      expect(tools.filter((row) => row.event.kind === "start")).toHaveLength(2);
      expect(
        tools
          .filter((row) => row.event.kind === "finish")
          .map((row) => row.event.outcome)
          .sort(),
      ).toEqual(["cancelled", "success"]);
      const samples = jsonl(join(directory, "log.jsonl"));
      const usageSamples = samples.filter(
        (sample) => sample.resources.cost !== undefined,
      );
      expect(usageSamples.map((sample) => sample.measurement.usage)).toEqual(
        committed.map((row) => row.usage),
      );
      expect(
        samples.some(
          (sample) =>
            sample.node.endsWith("winning-job/Worker") &&
            sample.resources.tokens > 0,
        ),
      ).toBe(true);
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
        dashboard_url: live.dashboardUrl,
      });
      expect(after.errors.length > 0).toBe(rejectPush);
      if (rejectPush)
        expect(after.errors.join(";")).toContain(
          "live push failed with status 503",
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

test("each leader reads only its own assignment on the leader rung, and peer notes arrive by send, yield and recv", async () => {
  const seen: Record<string, Record<string, ToolResult>> = {
    Agent1: {},
    Agent2: {},
  };
  const leader = (key: "agent1" | "agent2") => {
    const name = key === "agent1" ? "Agent1" : "Agent2";
    const out = key === "agent1" ? "agent1-to-agent2" : "agent2-to-agent1";
    const keep =
      (label: string, next: () => AssistantMessage) => (context: Context) => {
        seen[name]![label] = lastResult(context.messages);
        return next();
      };
    return steps(
      () => call("recv", {}),
      keep("assignment", () => call("info", {})),
      keep("info", () => call("task", { assignment: "spawn a helper" })),
      keep("task", () => call("send", { id: out, payload: NOTE[key] })),
      keep("send", () => call("yield", { reason: "await peer plan" })),
      () => call("recv", {}),
      keep("peer", () => done(`${name} done`)),
    );
  };
  const req = request({
    agent1: { task: `Implement ${SENTINEL.agent1}.` },
    agent2: { task: `Implement ${SENTINEL.agent2}.` },
  });
  const { execution, calls, owners } = await pair(req, {
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
  for (const [name, key, other] of [
    ["Agent1", "agent1", "agent2"],
    ["Agent2", "agent2", "agent1"],
  ] as const) {
    const mine = calls.filter((c) => c.agent === name);
    expect(new Set(mine.map((c) => c.model))).toEqual(new Set(["leader"]));
    expect(seen[name]!.assignment!.text).toContain(SENTINEL[key]);
    for (const c of mine)
      expect(JSON.stringify(c.messages)).not.toContain(SENTINEL[other]);
    expect(seen[name]!.info!.text).not.toContain(SENTINEL[key]);
    expect(seen[name]!.task!.isError).toBe(true); // native task is blocked
    expect(seen[name]!.send!.isError).toBe(false);
    const delivered = seen[name]!.peer!.text;
    expect(delivered.split(NOTE[other]).length - 1).toBe(1);
    expect(delivered).not.toContain(NOTE[key]);
  }
  expect(owners.map((o) => [o.team, o.node_id])).toEqual([
    ["agent1", "Agent1"],
    ["agent2", "Agent2"],
  ]);
}, 20_000);

test("both leaders' own reports decide Submitted: an abnormal member report cannot hide behind the lead's sink result", async () => {
  const { execution } = await pair(request(), {
    Agent1: steps(
      () => call("recv", {}),
      () => done("Agent1 done"),
    ),
    Agent2: steps(
      () => call("recv", {}),
      () => fauxAssistantMessage("", { stopReason: "length" }),
    ),
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
  // A batch cleanup failure alone also prevents Submitted.
  expect(
    pairOutcome(
      { agent1: values.agent1, agent2: values.agent1 },
      { completed: true, errors: ["cleanup"], limited: false },
    ).status,
  ).toBe("Error");
}, 20_000);

test("malformed divide and tournament inputs fail before any container or worker exists", async () => {
  const results: Record<string, ToolResult> = {};
  const keep =
    (label: string, next: () => AssistantMessage) => (context: Context) => {
      results[label] = lastResult(context.messages);
      return next();
    };
  const job = (name: string): WorkItem => ({ name, task: "t", check: "true" });
  const { execution, calls, batches } = await pair(request(), {
    Agent1: steps(
      () => call("divide", { tasks: [job("same"), job("same")] }),
      keep("duplicate", () => call("divide", { tasks: [] })),
      keep("empty", () => call("tournament", { task: "t", check: " \n" })),
      keep("blank", () =>
        call("divide", { tasks: [{ name: "x", task: "t" }] }),
      ),
      keep("missing", () => done("Agent1 done")),
    ),
    Agent2: steps(() => done("Agent2 done")),
  });
  await closed(execution, () => execution.run());
  expect(results.duplicate!.isError).toBe(true);
  expect(results.duplicate!.text).toContain("unique");
  for (const label of ["empty", "blank", "missing"])
    expect(results[label]!.isError).toBe(true);
  // Validation failed before any snapshot: no Docker diagnostic, no worker, no batch left running.
  for (const r of Object.values(results))
    expect(r.text).not.toMatch(/docker|snapshot|batch-/i);
  expect(batches.workers).toBe(0);
  expect(batches.active.size).toBe(0);
  expect(calls.every((c) => c.agent === "Agent1" || c.agent === "Agent2")).toBe(
    true,
  );
}, 20_000);

describe("Collect", () => {
  const item: WorkItem = { name: "leaf", task: "Do the leaf.", check: "true" };
  const workspace: AgentTool = {
    name: "container_bash",
    label: "container_bash",
    description: "fixture",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
    } as never,
    execute: async () => ({
      content: [{ type: "text", text: "exit_code: 0" }],
      details: undefined,
    }),
  };

  /** Run one worker graph whose Worker follows `script`; the sink's report or the failure. */
  async function worker(script: (job: string) => Script) {
    const job = randomUUID();
    const { models, calls } = await fauxModels({ leaf: script(job) });
    const execution = await createWorker(job, item, workspace, {
      models,
      ladder: ladderOf(MODELS, THINKING),
      tracer: new tracer.DummyTracer(),
      createAgent: (spec) =>
        syntax.createJuncoAgent(spec, ladderOf(MODELS, THINKING), models),
    });
    const outcome = await closed(execution, async () => {
      try {
        const results = await execution.run();
        return {
          report: syntax.finalText(
            results.get(graph.NodeId.create("Collect")),
            "Worker",
          ),
        };
      } catch (error) {
        const chain = (e: unknown): string =>
          e instanceof Error
            ? `${e.message}${e.cause ? `: ${chain(e.cause)}` : ""}`
            : String(e);
        return { error: chain(error) };
      }
    });
    return { ...outcome, calls, job };
  }

  test("accepts exactly one completion naming the job plus a normal report, on the worker rung", async () => {
    let routes = "";
    const { report, calls, job } = await worker((id) =>
      steps(
        () => call("info", {}),
        (context) => {
          routes = lastResult(context.messages).text;
          return call("send", { id: "completion", payload: id });
        },
        () => done("leaf report"),
      ),
    );
    expect(report).toBe("leaf report");
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["worker"]));
    const first = calls[0]!.messages.find((m) => m.role === "user")!;
    expect(contentText(first.content as never)).toContain(`Job ID: ${job}`);
    expect(routes).toContain("completion");
    expect(routes).not.toMatch(
      /agent1-to-agent2|agent2-to-agent1|assignment-1|assignment-2/,
    );
  }, 20_000);

  test.each([
    [
      "no completion",
      (_id: string) => steps(() => done("I am done, tests pass")),
    ],
    [
      "a duplicate completion",
      (id: string) =>
        steps(
          () => call("send", { id: "completion", payload: id }),
          () => call("send", { id: "completion", payload: id }),
          () => done("leaf report"),
        ),
    ],
    [
      "a completion for another job",
      (_id: string) =>
        steps(
          () => call("send", { id: "completion", payload: randomUUID() }),
          () => done("leaf report"),
        ),
    ],
    [
      "a blank report",
      (id: string) =>
        steps(
          () => call("send", { id: "completion", payload: id }),
          () => done("  "),
        ),
    ],
    [
      "an abnormal report",
      (id: string) =>
        steps(
          () => call("send", { id: "completion", payload: id }),
          () => fauxAssistantMessage("partial", { stopReason: "length" }),
        ),
    ],
  ] as const)(
    "rejects %s",
    async (name, script) => {
      const outcome = await worker(script);
      expect(outcome.report).toBeUndefined();
      const reason = {
        "no completion": /no final message/,
        "a duplicate completion": /exactly one completion/,
        "a completion for another job": /exactly one completion/,
        "a blank report": /empty report/,
        "an abnormal report": /did not finish normally/,
      }[name];
      expect(outcome.error).toMatch(reason);
    },
    20_000,
  );
});

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
    "other thinking": { ...valid, thinking: "high" },
    "other deadline": { ...valid, timeout_ms: 60_000 },
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
      thinking: { worker: "off", leader: "extreme" },
    },
  };
  expect(() => parseRequest("{not json")).toThrow(/not JSON/);
  for (const [name, value] of Object.entries(variants))
    expect(() => parseRequest(JSON.stringify(value)), name).toThrow(
      /invalid request/,
    );
});

test("thinking levels reach their role's rungs, with off as an omitted level", () => {
  const thinking = { worker: "medium", leader: "off" } as const;
  const valid = { ...request(), thinking };
  expect(parseRequest(JSON.stringify(valid))).toEqual(valid);
  const worker = { model: MODELS.worker, thinking: "medium" } as const;
  const leader = { model: MODELS.leader };
  expect(ladderOf(MODELS, thinking)).toEqual({
    smol: worker,
    low: worker,
    med: worker,
    high: leader,
    xhigh: leader,
  });
});

// ## Real containers (JUNCO_DOCKER_TESTS=1)
//
// Each primary is a disposable container of the cached llama_index task image whose repository is
// replaced by a small fixture: an ignored build asset, a committed base, a dirty tracked file, an
// untracked file, a binary file, a staged rename and deletion, and a future commit removed the way
// the launcher's sanitization removes it. Workers are faux models issuing real container commands.

const IMAGE =
  "sha256:f132e04e941b80f65b80b0c84525f31df888e9e97e6a6ebb3cc20762dfcdb23b";
const DOCKER = process.env.JUNCO_DOCKER_TESTS === "1";

async function sh(
  container: string,
  script: string,
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "-w",
      "/workspace/repo",
      container,
      "bash",
      "-c",
      script,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

function dockerSync(...args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const scoped = (scope: string) =>
  dockerSync(
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=${SCOPE_LABEL}=${scope}`,
  )
    .split("\n")
    .filter(Boolean);

const FIXTURE = String.raw`set -e
image_head=$(git rev-parse HEAD)
cd / && rm -rf /workspace/repo && mkdir /workspace/repo && cd /workspace/repo
git init -q -b main .
git config user.email fixture@test && git config user.name fixture
printf 'build/\n' > .gitignore
printf 'alpha\n' > a.txt
printf 'gone\n' > del.txt
printf 'old\n' > 'old name.txt'
printf 'keep\n' > shared.txt
head -c 3000 /dev/urandom > bin.dat
git add -A && git commit -qm base
git checkout -qb future && printf 'THE ANSWER\n' > answer.txt && git add -A && git commit -qm future
future=$(git rev-parse HEAD)
git checkout -q main && git branch -qD future && git reflog expire --expire=now --all && git gc -q --prune=now
! git cat-file -e "$future" 2>/dev/null
printf 'alpha dirty\n' > a.txt
printf 'untracked\n' > new.txt
git rm -q del.txt
git mv 'old name.txt' 'new name.txt'
mkdir -p build && printf 'asset' > build/asset.bin
echo "$image_head $future"`;

describe.skipIf(!DOCKER)("batches in real task containers", () => {
  const scope = randomUUID().replaceAll("-", "");
  // Bun evaluates a skipped describe body while collecting, so external resources start in beforeAll.
  let problem = "";
  const bystanders: string[] = [];
  beforeAll(() => {
    problem = mkdtempSync(join(tmpdir(), "cb-junco-"));
    for (const label of [["--label", `${SCOPE_LABEL}=${"e".repeat(32)}`], []])
      bystanders.push(
        dockerSync(
          "run",
          "-d",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          ...label,
          "--entrypoint",
          "/bin/bash",
          IMAGE,
          "-c",
          "sleep 3600s",
        ),
      );
  });
  afterAll(() => {
    for (const id of [...scoped(scope), ...bystanders])
      spawnSync("docker", ["rm", "-f", id]);
    rmSync(problem, { recursive: true, force: true });
  });

  /** A labelled primary holding the fixture; its original image HEAD and the removed future commit. */
  const primaries: string[] = [];
  async function primary() {
    const id = dockerSync(
      "run",
      "-d",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--platform",
      "linux/amd64",
      "--label",
      `${SCOPE_LABEL}=${scope}`,
      "--workdir",
      "/workspace/repo",
      "--entrypoint",
      "/bin/bash",
      IMAGE,
      "-c",
      "sleep 3600s",
    );
    const setup = await sh(id, FIXTURE);
    assert.equal(setup.code, 0, setup.out);
    const [imageHead, future] = setup.out.trim().split("\n").at(-1)!.split(" ");
    primaries.push(id);
    return { id, imageHead: imageHead!, future: future! };
  }

  /** Run one pair over real primaries; returns each leader's tool results in order. */
  async function run(
    primaries: { agent1: string; agent2?: string },
    scripts: Record<string, Script>,
    leaders: { Agent1: unknown[]; Agent2?: unknown[] },
    signal?: AbortSignal,
  ) {
    const results: Record<"Agent1" | "Agent2", ToolResult[]> = {
      Agent1: [],
      Agent2: [],
    };
    const leader =
      (name: "Agent1" | "Agent2", calls: unknown[]): Script =>
      (context, step) => {
        if (step > 0) results[name].push(lastResult(context.messages));
        const next = calls[step] as
          | [string, Parameters<typeof fauxToolCall>[1]]
          | undefined;
        return next ? call(next[0], next[1]) : done(`${name} done`);
      };
    const req = request(
      {
        agent1: {
          container_id: primaries.agent1,
          task: `Implement ${SENTINEL.agent1}.`,
        },
        agent2: {
          container_id: primaries.agent2 ?? "b".repeat(64),
          task: `Implement ${SENTINEL.agent2}.`,
        },
      },
      { run_id: scope, image_id: IMAGE, problem_dir: problem },
    );
    const controller = new AbortController();
    const pairSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const created = await pair(
      req,
      {
        ...scripts,
        Agent1: leader("Agent1", leaders.Agent1),
        Agent2: leader("Agent2", leaders.Agent2 ?? []),
      },
      pairSignal,
    );
    const started = Date.now();
    await closed(created.execution, async () => {
      await created.execution
        .run({ signal: pairSignal })
        .catch(() => undefined);
      controller.abort(); // like runPair: end every batch, then join them before closing
      await Promise.allSettled([...created.batches.active]);
    });
    return { ...created, results, seconds: (Date.now() - started) / 1000 };
  }

  /** Worker children still present: every scope container except the tests' primaries. */
  const children = () => scoped(scope).filter((id) => !primaries.includes(id));
  // Pi resolves every returned tool result as a non-error, so a batch's outcome lives in its details.
  const applied = (result: ToolResult) =>
    (result.details as BatchDetails).applied;
  /** Poll an external Docker state until `condition` holds: containers and processes emit no event a test could await. */
  async function until(
    condition: () => boolean | Promise<boolean>,
  ): Promise<void> {
    while (!(await condition())) await Bun.sleep(50);
  }
  const status = async (id: string) =>
    (
      await sh(
        id,
        "git add -A >/dev/null && git status --porcelain && cat shared.txt a.txt",
      )
    ).out;
  const jobId = (context: Context) =>
    /^Job ID: (\S+)$/m.exec(firstUser(context))![1]!;
  const bash = (command: string) => call("container_bash", { command });
  const complete = (context: Context) =>
    call("send", { id: "completion", payload: jobId(context) });

  test("divide composes private jobs from the exact sanitized snapshot, and promotes only after every job passes", async () => {
    const one = await primary();
    const two = await primary();
    const before = await status(one.id);
    const betaWrote = Promise.withResolvers<void>();
    const betaDone = Promise.withResolvers<void>();
    const seen: Record<string, ToolResult> = {};
    let duringBeta = "";
    const evidence =
      `cat a.txt new.txt build/asset.bin 'new name.txt' && test ! -e del.txt && test ! -e 'old name.txt' && test ! -e beta.txt && ` +
      `! git cat-file -e ${one.future} 2>/dev/null && ! git cat-file -e ${one.imageHead} 2>/dev/null && git log --format=%s`;
    const alphaWork =
      "head -c 100000 /dev/urandom | base64 > big.txt && head -c 5000 /dev/urandom > 'bin 2.dat' && printf 'alpha edited\\n' > a.txt && " +
      "git mv 'new name.txt' 'renamed again.txt' && git rm -q bin.dat && git add -A && " +
      "git -c user.name=w -c user.email=w@w commit -qm 'worker commit' && sha256sum big.txt 'bin 2.dat'";
    const scripts: Record<string, Script> = {
      alpha: steps(
        async () => {
          await betaWrote.promise;
          return bash(evidence);
        },
        async (context) => {
          seen.evidence = lastResult(context.messages);
          await betaDone.promise;
          duringBeta = await status(one.id);
          return bash(alphaWork);
        },
        (context) => {
          seen.work = lastResult(context.messages);
          return complete(context);
        },
        () => done("alpha report"),
      ),
      beta: steps(
        () =>
          bash(
            "printf 'beta\\n' > beta.txt && printf 'shared beta\\n' > shared.txt",
          ),
        (context) => {
          betaWrote.resolve();
          return complete(context);
        },
        () => {
          betaDone.resolve();
          return done("beta report");
        },
      ),
      gamma: steps(
        () => bash("printf 'gamma\\n' > gamma.txt"),
        complete,
        () => done("gamma report"),
      ),
    };
    const alphaCheck =
      "test \"$(wc -c < big.txt)\" -gt 65536 && test -f 'bin 2.dat' && grep -qx 'alpha edited' a.txt && test -e 'renamed again.txt' && test ! -e bin.dat";
    const { results, calls, owners, batches } = await run(
      { agent1: one.id, agent2: two.id },
      scripts,
      {
        Agent1: [
          [
            "divide",
            {
              tasks: [
                { name: "alpha", task: "Alpha edits.", check: alphaCheck },
                {
                  name: "beta",
                  task: "Beta edits.",
                  check:
                    "grep -qx beta beta.txt && grep -qx 'shared beta' shared.txt",
                },
              ],
            },
          ],
        ],
        Agent2: [
          [
            "divide",
            {
              tasks: [
                {
                  name: "gamma",
                  task: `Gamma for ${SENTINEL.agent2}.`,
                  check: "grep -qx gamma gamma.txt",
                },
              ],
            },
          ],
        ],
      },
    );

    expect(applied(results.Agent1[0]!)).toBe(true);
    expect(results.Agent1[0]!.text).toContain("applied");
    expect(applied(results.Agent2[0]!)).toBe(true);
    // The faster job finishing first changed nothing; the frozen snapshot included every kind of state.
    expect(duringBeta).toBe(before);
    expect(seen.evidence!.text).toStartWith("exit_code: 0");
    for (const text of ["alpha dirty", "untracked", "asset", "old", "base"])
      expect(seen.evidence!.text).toContain(text);
    expect(seen.evidence!.text).not.toContain("future");
    // The promoted patch reproduces both jobs exactly: >64 KiB text, binary, commit, rename and delete.
    const sums = seen
      .work!.text.split("\n")
      .filter((line) => /^[0-9a-f]{64} /.test(line));
    expect(sums).toHaveLength(2);
    expect((await sh(one.id, "sha256sum big.txt 'bin 2.dat'")).out.trim()).toBe(
      sums.join("\n"),
    );
    const promoted = await sh(
      one.id,
      `${alphaCheck} && grep -qx beta beta.txt && grep -qx 'shared beta' shared.txt && test ! -e 'new name.txt' && cat new.txt build/asset.bin && git log --format=%s`,
    );
    expect(promoted.code).toBe(0);
    expect(promoted.out).toContain("untracked");
    expect(promoted.out).toContain("asset");
    expect(promoted.out).not.toContain("worker commit"); // promotion edits the tree, never the primary's history
    expect((await sh(two.id, "cat gamma.txt && test ! -e beta.txt")).code).toBe(
      0,
    );
    // Teams stay private down to their workers; models follow the ladder.
    for (const c of calls) {
      const team =
        c.agent === "Agent2" || c.agent === "gamma" ? "agent2" : "agent1";
      expect(JSON.stringify(c.messages)).not.toContain(
        SENTINEL[team === "agent1" ? "agent2" : "agent1"],
      );
      expect(c.model).toBe(c.agent.startsWith("Agent") ? "leader" : "worker");
    }
    expect(
      owners.filter((o) =>
        /^agent1\/batch-[0-9a-f-]+\/[0-9a-f-]+\/Worker$/.test(o.node_id),
      ),
    ).toHaveLength(2);
    expect(
      owners.filter(
        (o) => o.team === "agent2" && o.node_id.endsWith("/Worker"),
      ),
    ).toHaveLength(1);
    expect(batches.workers).toBe(3);
    expect(batches.errors).toEqual([]);
    expect(children()).toEqual([]);
    for (const id of bystanders)
      expect(dockerSync("inspect", "-f", "{{.State.Running}}", id)).toBe(
        "true",
      );
  }, 300_000);

  test("divide applies nothing when a real check fails, patches conflict, or the combined tree fails", async () => {
    const one = await primary();
    const before = await status(one.id);
    const writer = (command: string) =>
      steps(
        () => bash(command),
        complete,
        () => done("done; all tests pass"),
      );
    const { results, batches } = await run(
      { agent1: one.id },
      {
        good: writer("printf 'good\\n' > good.txt"),
        bad: writer("printf 'bad\\n' > bad.txt"),
        c1: writer("printf 'one\\n' > shared.txt"),
        c2: writer("printf 'two\\n' > shared.txt"),
        x: writer("touch x.flag"),
        y: writer("touch y.flag"),
      },
      {
        Agent1: [
          [
            "divide",
            {
              tasks: [
                { name: "good", task: "g", check: "test -e good.txt" },
                { name: "bad", task: "b", check: "grep -q never bad.txt" },
              ],
            },
          ],
          [
            "divide",
            {
              tasks: [
                { name: "c1", task: "c", check: "grep -qx one shared.txt" },
                { name: "c2", task: "c", check: "grep -qx two shared.txt" },
              ],
            },
          ],
          [
            "divide",
            {
              tasks: [
                {
                  name: "x",
                  task: "x",
                  check: "test -e x.flag && test ! -e y.flag",
                },
                { name: "y", task: "y", check: "test -e y.flag" },
              ],
            },
          ],
        ],
      },
    );
    const [failed, conflict, combined] = results.Agent1;
    expect(applied(failed!)).toBe(false);
    expect(failed!.text).toContain("1 of 2 jobs failed");
    expect(failed!.text).toContain("host rerun of the check failed (exit 1)");
    expect(applied(conflict!)).toBe(false);
    expect(conflict!.text).toContain("conflicts with earlier jobs");
    expect(applied(combined!)).toBe(false);
    expect(combined!.text).toContain("fails on the combined tree");
    expect(await status(one.id)).toBe(before);
    expect(batches.errors).toEqual([]);
    expect(children()).toEqual([]);
  }, 300_000);

  test("tournament selects the first validated success: a fast plausible failure loses, a sleeping contender is cancelled", async () => {
    const one = await primary();
    const fastDone = Promise.withResolvers<void>();
    const sleeping = Promise.withResolvers<void>();
    let loserSent = false;
    const { results, seconds, batches } = await run(
      { agent1: one.id },
      {
        "attempt-1@A": steps(
          () => bash("printf 'wrong\\n' > t.txt"),
          complete,
          () => {
            fastDone.resolve();
            return done("Implemented; all tests pass.");
          },
        ),
        "attempt-2@A": steps(
          async () => {
            await fastDone.promise;
            return bash("printf 'right\\n' > t.txt");
          },
          complete,
          () => done("attempt 2 report"),
        ),
        "attempt-1@B": steps(
          () => {
            sleeping.resolve();
            return bash("printf 'lose\\n' > u.txt && sleep 600");
          },
          (context) => {
            loserSent = true;
            return complete(context);
          },
          () => done("too late"),
        ),
        "attempt-2@B": steps(
          async () => {
            await sleeping.promise;
            return bash("printf 'win\\n' > u.txt");
          },
          complete,
          () => done("winner report"),
        ),
      },
      {
        Agent1: [
          [
            "tournament",
            { task: "ROUND-A: write t.txt", check: "grep -qx right t.txt" },
          ],
          [
            "tournament",
            { task: "ROUND-B: write u.txt", check: "grep -qx win u.txt" },
          ],
        ],
      },
    );
    const [first, second] = results.Agent1;
    expect(applied(first!)).toBe(true);
    expect(
      (first!.details as BatchDetails).jobs.map((j) => [j.name, j.status]),
    ).toEqual([
      ["attempt-1", "failed"],
      ["attempt-2", "passed"],
    ]);
    expect(applied(second!)).toBe(true);
    expect(
      (second!.details as BatchDetails).jobs.map((j) => [j.name, j.status]),
    ).toEqual([
      ["attempt-1", "cancelled"],
      ["attempt-2", "passed"],
    ]);
    expect(loserSent).toBe(false);
    expect(seconds).toBeLessThan(300); // the loser's `sleep 600` was stopped, not awaited
    expect((await sh(one.id, "cat t.txt u.txt")).out).toBe("right\nwin\n");
    expect(batches.errors).toEqual([]);
    expect(children()).toEqual([]);
  }, 300_000);

  test("both failed attempts return both diagnostics: a wrong completion ID and a missing completion", async () => {
    const one = await primary();
    const before = await status(one.id);
    const { results } = await run(
      { agent1: one.id },
      {
        "attempt-1": steps(
          () => bash("touch t.txt"),
          () => call("send", { id: "completion", payload: randomUUID() }),
          () => done("done"),
        ),
        "attempt-2": steps(
          () => bash("touch t.txt"),
          () => done("done, no completion needed"),
        ),
      },
      {
        Agent1: [
          ["tournament", { task: "write t.txt", check: "test -e t.txt" }],
        ],
      },
    );
    expect(applied(results.Agent1[0]!)).toBe(false);
    expect(results.Agent1[0]!.text).toContain("both attempts failed");
    expect(results.Agent1[0]!.text).toContain("exactly one completion");
    expect(results.Agent1[0]!.text).toContain("no final message");
    expect(await status(one.id)).toBe(before);
    expect(children()).toEqual([]);
  }, 300_000);

  test("a primary that drifted after the snapshot rejects promotion", async () => {
    const one = await primary();
    const { results } = await run(
      { agent1: one.id },
      {
        leaf: steps(
          async () => {
            assert.equal(
              (await sh(one.id, "printf 'drift\\n' >> a.txt")).code,
              0,
            );
            return bash("touch leaf.txt");
          },
          complete,
          () => done("leaf report"),
        ),
      },
      {
        Agent1: [
          [
            "divide",
            { tasks: [{ name: "leaf", task: "l", check: "test -e leaf.txt" }] },
          ],
        ],
      },
    );
    expect(applied(results.Agent1[0]!)).toBe(false);
    expect(results.Agent1[0]!.text).toContain(
      "changed since the batch snapshot",
    );
    expect((await sh(one.id, "test ! -e leaf.txt && tail -1 a.txt")).out).toBe(
      "drift\n",
    );
    expect(children()).toEqual([]);
  }, 300_000);

  test("an interrupt during provisioning or during work removes every container the batch owned", async () => {
    const one = await primary();
    const before = await status(one.id);
    // During provisioning: abort as soon as the first child container exists.
    const early = new AbortController();
    void until(() => children().length > 0).then(() =>
      early.abort(new Error("interrupted")),
    );
    const provisioning = await run(
      { agent1: one.id },
      {},
      {
        Agent1: [
          [
            "divide",
            {
              tasks: ["p", "q", "r"].map((name) => ({
                name,
                task: name,
                check: "true",
              })),
            },
          ],
        ],
      },
      early.signal,
    );
    expect(early.signal.aborted).toBe(true);
    expect(provisioning.batches.active.size).toBe(0);
    expect(children()).toEqual([]);
    // During work: abort while a worker runs `sleep 600`.
    const late = new AbortController();
    const working = await run(
      { agent1: one.id },
      {
        sleeper: steps(() => {
          void until(async () => {
            // The image has no pgrep; the bracket keeps this probe from matching its own command line.
            const probe =
              "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ' | grep -q 'slee[p] 600'";
            // A one-job divide owns two children: the worker's and the integration container.
            const found = await Promise.all(
              children().map(
                async (child) => (await sh(child, probe)).code === 0,
              ),
            );
            return found.includes(true);
          }).then(() => late.abort(new Error("interrupted")));
          return bash("touch half.txt && sleep 600");
        }),
      },
      {
        Agent1: [
          [
            "divide",
            { tasks: [{ name: "sleeper", task: "s", check: "true" }] },
          ],
        ],
      },
      late.signal,
    );
    expect(working.seconds).toBeLessThan(120);
    expect(working.batches.active.size).toBe(0);
    expect(working.batches.errors).toEqual([]);
    expect(children()).toEqual([]);
    expect(await status(one.id)).toBe(before);
  }, 300_000);

  test("a host check that outlives the command timeout fails its job", async () => {
    const one = await primary();
    const { results } = await run(
      { agent1: one.id },
      {
        slow: steps(complete, () => done("observed; nothing to change")),
      },
      {
        Agent1: [
          [
            "divide",
            { tasks: [{ name: "slow", task: "observe", check: "sleep 130" }] },
          ],
        ],
      },
    );
    expect(applied(results.Agent1[0]!)).toBe(false);
    expect(results.Agent1[0]!.text).toContain("timed out");
    expect(children()).toEqual([]);
  }, 400_000);
});
