import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import { DataflowNodeError } from "dataflow-engine";
import { fitProfiles, parseSamples } from "dataflow-profile";
import { JuncoGraph, MockAgent, schedules, tracer } from "junco";
import { AssistantMessageSchema } from "junco-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentSpec } from "../src/syntax/build.ts";
import { parse } from "../src/syntax/parse.ts";
import {
  assistant,
  failed,
  run,
  settle,
  textOf,
} from "./deterministic-support.ts";

const prompt = {
  type: "object",
  required: ["kind", "text"],
  properties: { kind: { const: "prompt" }, text: { type: "string" } },
};
const reply = {
  type: "object",
  required: ["role", "content"],
  properties: { role: { const: "assistant" }, content: { type: "array" } },
};

const document = () =>
  parse({
    graph: {
      nodes: {
        Start: { kind: "emit", text: "go", spec: "done" },
        Inner: {
          kind: "graph",
          trigger: "Start~>Inner",
          graph: {
            source: { routes: { "Start~>Inner": ["$source~>Worker"] } },
            nodes: { Worker: { trigger: "$source~>Worker" } },
            edges: [
              {
                from: "$source",
                to: "Worker",
                kind: "message",
                schema: prompt,
              },
              { from: "Worker", to: "$sink", schema: reply },
            ],
          },
        },
        Final: {
          trigger: "Inner~>Final",
          prompt:
            "Process the report in the user message following this prompt.",
        },
      },
      edges: [
        { from: "Start", to: "Inner", kind: "message", schema: prompt },
        { from: "Inner", to: "Final", kind: "message", schema: reply },
        { from: "Final", to: "$sink", schema: reply },
      ],
    },
  });

const mock = (transcript: ConstructorParameters<typeof MockAgent>[0]) =>
  new MockAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>(transcript);
const text = (value: unknown) => {
  assert.ok(Value.Check(AssistantMessageSchema, value));
  return textOf(value);
};
const createAgent = async ({ node }: AgentSpec) =>
  mock({
    prompt: node === "Worker" ? "work" : undefined,
    runs: [
      run([
        settle(assistant(node === "Worker" ? "WORKER-OUT" : "FINAL-OUT"), {
          drain: ["steer"],
        }),
      ]),
    ],
  });
const options = (cwd: string) => ({
  cwd,
  createAgent,
  scheduler: () => schedules.parallel(),
  tracer: new tracer.DummyTracer(),
});

test("recorded nested activations fit offline profiles by node path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junco-profile-recorder-"));
  try {
    const path = join(directory, "samples.jsonl");
    const recorder = new tracer.JsonlRecorder({ path, monitored: true });
    const doc = document();
    const execution = await JuncoGraph.fromYaml(doc, {
      ...options(directory),
      recorder,
      measurementWindows: new Map([["memory", 1]]),
      scheduler: () => (snapshot) => {
        // Offline monitored rows include zero for these mocks; no native pipeline measured it.
        assert.equal(snapshot.measurements.size, 0);
        return { selected: schedules.select(snapshot, snapshot.available) };
      },
    });
    try {
      const results = await execution.run();
      assert.equal(text(results.get(execution.graph.sink.id)), "FINAL-OUT");
      await recorder.flush();
      const samples = parseSamples(readFileSync(path, "utf8"));
      const keys = new Set(samples.map((sample) => sample.node));
      for (const key of [
        "Start",
        "Inner",
        "Inner/Worker",
        "Inner/$sink",
        "Final",
        "$sink",
      ])
        assert.ok(keys.has(key), `missing sample for ${key}`);
      const resumedFinal = samples.filter(
        (sample) =>
          sample.node === "Final" &&
          Object.hasOwn(sample.features, "Inner~>Final"),
      );
      assert.equal(resumedFinal.length, 1);
      assert.deepEqual(resumedFinal[0]!.features, {
        "Inner~>Final": { count: 1 },
      });
      for (const sample of samples) {
        const runtime = sample.resources.runtime;
        assert.ok(
          runtime !== undefined && Number.isFinite(runtime) && runtime >= 0,
        );
        assert.equal(sample.resources.memory, 0);
        assert.deepEqual(sample.units, { runtime: "ms", memory: "B" });
        assert.equal(Object.hasOwn(sample.resources, "tokens"), false);
      }

      const { file } = fitProfiles(samples, { fittedAt: "2026-10-20" });
      assert.ok(file.nodes["Inner/Worker"]?.memory);
      assert.ok(file.nodes["Inner/Worker"]?.runtime);
    } finally {
      await execution.graph.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed activations are excluded while successful activations survive a failed run", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junco-profile-recorder-failure-"),
  );
  try {
    const path = join(directory, "samples.jsonl");
    const recorder = new tracer.JsonlRecorder({ path });
    const cause = new Error("provider down");
    const execution = await JuncoGraph.fromYaml(document(), {
      ...options(directory),
      recorder,
      createAgent: async (spec) =>
        spec.node === "Final"
          ? mock({ runs: [run([{ step: failed(cause), drain: ["steer"] }])] })
          : createAgent(spec),
    });
    try {
      await assert.rejects(
        execution.run(),
        (error: unknown) =>
          error instanceof DataflowNodeError &&
          error.nodeId === "Final" &&
          error.error === cause,
      );
      await recorder.flush();
      const samples = parseSamples(readFileSync(path, "utf8"));
      assert.ok(samples.some((sample) => sample.node === "Inner/Worker"));
      assert.deepEqual(
        samples
          .filter((sample) => sample.node === "Final")
          .map((sample) => sample.features),
        [{}],
      );
      for (const sample of samples) {
        assert.deepEqual(sample.units, { runtime: "ms" });
        assert.equal(Object.hasOwn(sample.resources, "memory"), false);
      }
    } finally {
      await execution.graph.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("flush reports an append failure queued at run end", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junco-profile-recorder-append-"),
  );
  try {
    const recorder = new tracer.JsonlRecorder({ path: directory });
    const execution = await JuncoGraph.fromYaml(document(), {
      ...options(directory),
      recorder,
    });
    try {
      await execution.run();
      await assert.rejects(recorder.flush(), { code: "EISDIR" });
    } finally {
      await execution.graph.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL reduction keeps same-path agent activations independent", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junco-profile-recorder-reduce-"),
  );
  try {
    const path = join(directory, "samples.jsonl");
    const recorder = new tracer.JsonlRecorder({ path, monitored: true });
    const graph = recorder.add_context("Inner");
    const view = graph.add_context("Work:er");
    assert.equal(view.path, "Inner::Work%3Aer");
    assert.equal(view.root, recorder);
    const lease = {};
    const [agentA, agentB] = [{}, {}];
    const usage = (source: object, totalTokens: number, cost = 0) => {
      const payload = {
        input: totalTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: {
          input: cost,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: cost,
        },
      };
      view.record({
        resource: "tokens",
        kind: "usage",
        source,
        usage: payload,
      });
      view.record({
        resource: "cost",
        kind: "usage",
        source,
        usage: payload,
      });
    };
    const memory = (owner: string | undefined, memoryBytes: number) =>
      view.record({
        resource: "memory",
        kind: "resource",
        source: lease,
        event: {
          kind: "sample",
          pipelineId: 1,
          owner,
          sample: {
            elapsedMs: 1,
            memoryBytes,
            memoryPeakBytes: memoryBytes,
            cpuUsageMs: 0,
            cpuUserMs: 0,
            cpuSystemMs: 0,
            cpuThrottledMs: 0,
            pids: 1,
            oomKills: 0,
          },
        },
      });
    const activation = (
      agent: object | undefined,
      owner: string | undefined,
    ): tracer.ProfileActivation => ({
      runId: "run-1",
      firedAt: "2026-10-26T00:00:00.000Z",
      features: { "Start~>Worker": { count: 1 } },
      agent,
      owner,
    });
    const op = { resource: "operations", category: "graph", tool: "" } as const;
    const start = (act: tracer.ProfileActivation) =>
      view.record({
        ...op,
        kind: "start",
        operation: "prime",
        activation: act,
      });
    const finish = (
      act: tracer.ProfileActivation,
      outcome: "success" | "error" = "success",
    ) =>
      view.record({
        ...op,
        kind: "finish",
        operation: "prime",
        activation: act,
        outcome,
        durationMs: 5,
      });
    const evaluated = () =>
      graph.record({
        ...op,
        kind: "finish",
        operation: "evaluate",
        outcome: "success",
        durationMs: 9,
      });
    const rows = () => parseSamples(readFileSync(path, "utf8"));

    usage(agentA, 100, 10); // history before the activation is not its usage
    const a = activation(agentA, "owner-a");
    const b = activation(agentB, "owner-b");
    start(a);
    start(b);
    usage(agentA, 3, 0.125);
    usage(agentB, 7, 0.375);
    memory("owner-a", 30);
    memory("owner-b", 90);
    memory("owner-unknown", 500);
    memory(undefined, 600);
    finish(a);
    finish(b);
    memory("owner-a", 40); // late, before serialization
    evaluated();
    await recorder.flush();
    memory("owner-a", 1000); // late, after serialization: dropped

    const c = activation(agentA, "owner-a");
    const plain = activation(undefined, undefined);
    const failedRun = activation(agentB, "owner-b");
    start(c);
    start(plain);
    start(failedRun);
    finish(c);
    finish(plain);
    finish(failedRun, "error");
    memory("owner-b", 700); // the failed activation keeps it from b
    evaluated();
    await recorder.flush();
    await recorder.flush();
    const samples = rows();
    assert.deepEqual(
      samples.map((sample) => [
        sample.node,
        sample.resources.tokens,
        sample.resources.cost,
        sample.resources.memory,
      ]),
      [
        ["Inner/Work:er", 3, 0.125, 40],
        ["Inner/Work:er", 7, 0.375, 90],
        ["Inner/Work:er", 0, 0, 0],
        ["Inner/Work:er", undefined, undefined, 0],
      ],
    );
    assert.deepEqual(samples[0]?.units, {
      runtime: "ms",
      tokens: "tok",
      cost: "USD",
      memory: "B",
    });
    assert.deepEqual(samples[3]?.units, { runtime: "ms", memory: "B" });
    assert.equal(samples[0]?.resources.runtime, 5);
    assert.deepEqual(samples[0]?.features, { "Start~>Worker": { count: 1 } });
    const { file } = fitProfiles(samples, { fittedAt: "2026-10-20" });
    assert.equal(file.nodes["Inner/Work:er"]?.cost?.unit, "USD");
    assert.equal(file.nodes["Inner/Work:er"]?.cost?.bound, 0.375);

    const negative = activation(agentB, "owner-b");
    start(negative);
    usage(agentB, -20);
    finish(negative);
    evaluated();
    await assert.rejects(
      recorder.flush(),
      /JsonlRecorder: invalid tokens sample/,
    );
    assert.equal(rows().length, 4);
    const closing = recorder.close();
    assert.equal(recorder.close(), closing);
    await assert.rejects(closing, /JsonlRecorder: invalid tokens sample/);
    start(activation(agentA, "owner-a")); // ignored after close
    assert.throws(() => recorder.add_context("x"), /JsonlRecorder: closed/);
    assert.equal(rows().length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL invalid costs exclude their successful activations and latch", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junco-profile-recorder-invalid-cost-"),
  );
  const path = join(directory, "samples.jsonl");
  const recorder = new tracer.JsonlRecorder({ path });
  const operation = {
    resource: "operations",
    category: "graph",
    tool: "",
    operation: "prime",
  } as const;
  const invalid = [
    undefined,
    { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, total: -1 },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN },
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Number.POSITIVE_INFINITY,
    },
  ];
  try {
    for (const [index, cost] of invalid.entries()) {
      const agent = {};
      const activation: tracer.ProfileActivation = {
        runId: `invalid-${index}`,
        firedAt: "2026-10-26T00:00:00.000Z",
        features: {},
        agent,
        owner: undefined,
      };
      recorder.record({ ...operation, kind: "start", activation });
      assert.doesNotThrow(() =>
        recorder.record({
          resource: "cost",
          kind: "usage",
          source: agent,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: cost!,
          },
        }),
      );
      recorder.record({
        ...operation,
        kind: "finish",
        activation,
        outcome: "success",
        durationMs: 1,
      });
    }
    const plain: tracer.ProfileActivation = {
      runId: "plain",
      firedAt: "2026-10-26T00:00:00.000Z",
      features: {},
      agent: undefined,
      owner: undefined,
    };
    recorder.record({ ...operation, kind: "start", activation: plain });
    recorder.record({
      ...operation,
      kind: "finish",
      activation: plain,
      outcome: "success",
      durationMs: 1,
    });
    await assert.rejects(
      recorder.flush(),
      /JsonlRecorder: invalid cost sample/,
    );
    assert.deepEqual(
      parseSamples(readFileSync(path, "utf8")).map((sample) => sample.runId),
      ["plain"],
    );
    await assert.rejects(
      recorder.close(),
      /JsonlRecorder: invalid cost sample/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL usage costs include standalone, scheduler and failed requests exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junco-profile-usage-cost-"));
  const path = join(directory, "samples.jsonl");
  const recorder = new tracer.JsonlRecorder({ path, costMode: "usage" });
  try {
    const worker = recorder.add_context("Worker");
    const agent = {};
    const usage = (total: number) => ({
      input: 2,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
    });
    // A standalone baseline has no graph lifecycle at all.
    recorder.record({
      resource: "cost",
      kind: "usage",
      source: agent,
      usage: usage(0.125),
    });
    await recorder.flush();
    const operation = {
      resource: "operations",
      category: "graph",
      tool: "",
      operation: "prime",
    } as const;
    for (const [index, outcome] of (
      ["success", "error", "cancelled"] as const
    ).entries()) {
      const activation: tracer.ProfileActivation = {
        runId: `usage-${index}`,
        firedAt: "2026-10-28T00:00:00.000Z",
        features: { input: { count: 1 } },
        agent,
        owner: undefined,
      };
      worker.record({ ...operation, kind: "start", activation });
      const payload = usage(0.25);
      worker.record({
        resource: "tokens",
        kind: "usage",
        source: agent,
        usage: payload,
      });
      worker.record({
        resource: "cost",
        kind: "usage",
        source: agent,
        usage: payload,
      });
      worker.record({
        ...operation,
        kind: "finish",
        activation,
        outcome,
        durationMs: 1,
      });
    }
    // The scheduler need not share an agent identity or have an activation.
    recorder.add_context("Scheduler").record({
      resource: "cost",
      kind: "usage",
      source: {},
      usage: usage(0.5),
    });
    // Late usage, after all activations ended, still counts; token events do not.
    worker.record({
      resource: "cost",
      kind: "usage",
      source: agent,
      usage: usage(0),
    });
    worker.record({
      resource: "tokens",
      kind: "usage",
      source: agent,
      usage: usage(99),
    });
    await recorder.close();
    const samples = parseSamples(readFileSync(path, "utf8"));
    const costs = samples.filter(
      (sample) => sample.resources.cost !== undefined,
    );
    assert.deepEqual(
      costs.map((sample) => sample.resources.cost),
      [0.125, 0.25, 0.25, 0.25, 0.5, 0],
    );
    assert.deepEqual(
      costs.map((sample) => sample.node),
      ["", "Worker", "Worker", "Worker", "Scheduler", "Worker"],
    );
    for (const sample of costs) {
      assert.deepEqual(sample.units, { cost: "USD" });
      assert.deepEqual(sample.features, {});
      assert.deepEqual(Object.keys(sample.resources), ["cost"]);
    }
    const activations = samples.filter((sample) => sample.runId !== undefined);
    assert.equal(activations.length, 1);
    assert.equal(activations[0]?.runId, "usage-0");
    assert.deepEqual(activations[0]?.resources, { runtime: 1, tokens: 3 });
    assert.deepEqual(activations[0]?.units, { runtime: "ms", tokens: "tok" });
  } finally {
    await recorder.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL usage mode rejects every invalid cost without needing an activation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junco-profile-usage-invalid-"),
  );
  try {
    for (const [index, total] of [
      undefined,
      Number.NaN,
      Infinity,
      -1,
      "0",
    ].entries()) {
      const path = join(directory, `${index}.jsonl`);
      const recorder = new tracer.JsonlRecorder({ path, costMode: "usage" });
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost:
          total === undefined
            ? undefined!
            : {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: total as number,
              },
      };
      // Invalid cost data on a token event is not a dollar contribution.
      recorder.record({ resource: "tokens", kind: "usage", source: {}, usage });
      await recorder.flush();
      assert.doesNotThrow(() =>
        recorder.record({ resource: "cost", kind: "usage", source: {}, usage }),
      );
      await assert.rejects(
        recorder.flush(),
        /JsonlRecorder: invalid cost sample/,
      );
      // A valid increment cannot clear the accounting failure.
      recorder.record({
        resource: "cost",
        kind: "usage",
        source: {},
        usage: {
          ...usage,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      await assert.rejects(
        recorder.close(),
        /JsonlRecorder: invalid cost sample/,
      );
      assert.deepEqual(
        parseSamples(readFileSync(path, "utf8")).map(
          (sample) => sample.resources.cost,
        ),
        [0],
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL samples sum edits and operations events into their activation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junco-profile-recorder-operations-"),
  );
  try {
    const path = join(directory, "samples.jsonl");
    const recorder = new tracer.JsonlRecorder({ path });
    const view = recorder.add_context("Worker");
    const graph = {
      resource: "operations",
      category: "graph",
      tool: "",
      operation: "prime",
    } as const;
    const edit = {
      resource: "edits",
      category: "edit",
      tool: "edit",
      operation: "apply",
    } as const;
    const read = {
      resource: "operations",
      category: "read",
      tool: "read",
      operation: "execute",
    } as const;
    const activation = (runId: string): tracer.ProfileActivation => ({
      runId,
      firedAt: "2026-10-26T00:00:00.000Z",
      features: {},
      agent: undefined,
      owner: undefined,
    });
    const a = activation("a");
    recorder.add_context("Other").record({ ...read, kind: "start" }); // no live activation there
    view.record({ ...graph, kind: "start", activation: a });
    view.record({
      ...graph,
      kind: "metrics",
      activation: a,
      counters: { input_messages: 2 },
    });
    view.record({ ...edit, kind: "start" });
    view.record({
      ...edit,
      kind: "metrics",
      counters: { output_text_bytes: 3 },
      gauges: { kept: 1, gone: 1 },
    });
    view.record({ ...edit, kind: "finish", outcome: "success", durationMs: 4 });
    view.record({ ...edit, kind: "start" });
    view.record({
      ...edit,
      kind: "metrics",
      counters: { output_text_bytes: 4 },
      gauges: { kept: 2, gone: null },
    });
    view.record({
      ...edit,
      kind: "finish",
      outcome: "cancelled",
      durationMs: 3,
    });
    view.record({ ...read, kind: "start" });
    view.record({ ...read, kind: "finish", outcome: "error", durationMs: 2 });
    // Other resources are not edits/operations metrics.
    view.record({ ...read, resource: "memory", kind: "start" });
    view.record({ ...read, resource: "tokens", kind: "start" });
    view.record({
      ...graph,
      kind: "finish",
      activation: a,
      outcome: "success",
      durationMs: 5,
    });
    view.record({ ...read, kind: "start" }); // after the activation: dropped

    // Concurrent same-path activations: only events stamped with an activation are attributed.
    const [b, c] = [activation("b"), activation("c")];
    view.record({ ...graph, kind: "start", activation: b });
    view.record({ ...graph, kind: "start", activation: c });
    view.record({ ...read, kind: "start" });
    view.record({
      ...graph,
      kind: "finish",
      activation: b,
      outcome: "success",
      durationMs: 1,
    });
    view.record({
      ...graph,
      kind: "finish",
      activation: c,
      outcome: "success",
      durationMs: 1,
    });
    recorder.record({
      ...graph,
      operation: "evaluate",
      kind: "finish",
      outcome: "success",
      durationMs: 9,
    });
    await recorder.close();

    const row = (
      labels: { category: string; tool: string; operation: string },
      values: Record<string, unknown>,
    ) => ({
      category: labels.category,
      tool: labels.tool,
      operation: labels.operation,
      calls: 1,
      success: 0,
      error: 0,
      cancelled: 0,
      durationMs: 0,
      counters: {},
      gauges: {},
      ...values,
    });
    const samples = parseSamples(readFileSync(path, "utf8"));
    assert.deepEqual(
      samples.map((sample) => [sample.runId, sample.measurement]),
      [
        [
          "a",
          {
            operations: [
              row(graph, {
                success: 1,
                durationMs: 5,
                counters: { input_messages: 2 },
              }),
              row(read, { error: 1, durationMs: 2 }),
            ],
            edits: [
              row(edit, {
                calls: 2,
                success: 1,
                cancelled: 1,
                durationMs: 7,
                counters: { output_text_bytes: 7 },
                gauges: { kept: 2 },
              }),
            ],
          },
        ],
        ["b", { operations: [row(graph, { success: 1, durationMs: 1 })] }],
        ["c", { operations: [row(graph, { success: 1, durationMs: 1 })] }],
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const probeEvent = (edgeId: string, value: number) =>
  ({ resource: "probe", kind: "probe", edgeId, value }) as const;

test("JSONL probe events become standalone samples in record order, written once", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "junco-profile-recorder-probe-"),
  );
  try {
    const path = join(directory, "samples.jsonl");
    const recorder = new tracer.JsonlRecorder({ path });
    const root = recorder.add_context("root");
    const child = root.add_context("Child");
    root.record(probeEvent("A->B", 1.25));
    child.record(probeEvent("$source~>Echo", -2));
    root.record(probeEvent("A->B", 0));
    root.record(probeEvent("A->B", -2));
    const op = { resource: "operations", category: "graph", tool: "" } as const;
    const activation = (runId: string): tracer.ProfileActivation => ({
      runId,
      firedAt: "2026-10-26T00:00:00.000Z",
      features: {},
      agent: undefined,
      owner: undefined,
    });
    // An unrelated failed activation, then an ordinary successful one.
    const failed = activation("failed");
    child.record({
      ...op,
      kind: "start",
      operation: "prime",
      activation: failed,
    });
    child.record({
      ...op,
      kind: "finish",
      operation: "prime",
      activation: failed,
      outcome: "error",
      durationMs: 1,
    });
    const ok = activation("ok");
    root.record({ ...op, kind: "start", operation: "prime", activation: ok });
    root.record({
      ...op,
      kind: "finish",
      operation: "prime",
      activation: ok,
      outcome: "success",
      durationMs: 4,
    });
    await recorder.flush();
    await recorder.flush();
    await recorder.close();
    const samples = parseSamples(readFileSync(path, "utf8"));
    assert.deepEqual(
      samples.map((sample) => [
        sample.node,
        sample.runId,
        sample.resources,
        sample.units,
        sample.features,
        sample.measurement?.probe,
      ]),
      [
        ["root", undefined, {}, {}, {}, [{ edgeId: "A->B", value: 1.25 }]],
        [
          "root/Child",
          undefined,
          {},
          {},
          {},
          [{ edgeId: "$source~>Echo", value: -2 }],
        ],
        ["root", undefined, {}, {}, {}, [{ edgeId: "A->B", value: 0 }]],
        ["root", undefined, {}, {}, {}, [{ edgeId: "A->B", value: -2 }]],
        ["root", "ok", { runtime: 4 }, { runtime: "ms" }, {}, undefined],
      ],
    );
    for (const sample of samples)
      assert.ok(Number.isFinite(Date.parse(sample.firedAt ?? "")));
    // Probe samples carry no resource, so they never become profile training rows.
    const report = (rows: typeof samples) =>
      fitProfiles(rows, { fittedAt: "2026-10-20" }).report;
    assert.deepEqual(
      report(samples),
      report(samples.filter((sample) => sample.runId !== undefined)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const value of [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
])
  test(`JSONL latches a ${value} probe value without writing it`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "junco-profile-recorder-probe-invalid-"),
    );
    try {
      const path = join(directory, "samples.jsonl");
      const recorder = new tracer.JsonlRecorder({ path });
      recorder.record(probeEvent("e", value));
      recorder.record(probeEvent("e", 1));
      await assert.rejects(
        recorder.flush(),
        /^Error: JsonlRecorder: invalid probe value$/,
      );
      await assert.rejects(
        recorder.close(),
        /JsonlRecorder: invalid probe value/,
      );
      assert.deepEqual(
        parseSamples(readFileSync(path, "utf8")).map(
          (sample) => sample.measurement?.probe,
        ),
        [[{ edgeId: "e", value: 1 }]],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
