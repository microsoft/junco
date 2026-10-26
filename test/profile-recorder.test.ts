import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataflowNodeError, megabytes } from "dataflow-engine";
import { fitProfiles, parseSamples } from "dataflow-profile";
import { JuncoGraph, MockAgent, schedules, tracer } from "junco-agency";
import type { AgentSpec } from "../src/syntax/build.ts";
import { parse } from "../src/syntax/parse.ts";
import {
  assistant,
  failed,
  run,
  settle,
  textOf,
} from "./deterministic-support.ts";

const document = () =>
  parse({
    graph: {
      nodes: {
        Start: { kind: "emit", text: "go" },
        Inner: {
          kind: "graph",
          trigger: "Start~>Inner",
          graph: {
            source: { routes: { "Start~>Inner": ["$source~>Worker"] } },
            nodes: { Worker: { trigger: "$source~>Worker" } },
            edges: [
              { from: "$source", to: "Worker", kind: "message" },
              { from: "Worker", to: "$sink" },
            ],
          },
        },
        Final: {
          trigger: "Inner~>Final",
          prompt: "got: {{Inner~>Final}}",
        },
      },
      edges: [
        { from: "Start", to: "Inner", kind: "message" },
        { from: "Inner", to: "Final", kind: "message" },
        { from: "Final", to: "$sink" },
      ],
    },
  });

const createAgent = async ({ node }: AgentSpec) =>
  new MockAgent({
    prompt: node === "Worker" ? "work" : undefined,
    runs: [
      run([settle(assistant(node === "Worker" ? "WORKER-OUT" : "FINAL-OUT"))]),
    ],
  });
const options = (cwd: string) => ({
  cwd,
  createAgent,
  scheduler: () => schedules.parallel(),
  tracer: new tracer.DummyTracer(),
});

test("recorded nested activations fit profiles that admit a strict memory schedule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junco-profile-recorder-"));
  try {
    const path = join(directory, "samples.jsonl");
    const recorder = new tracer.JsonlRecorder({ path, monitored: true });
    const doc = document();
    const execution = await JuncoGraph.fromYaml(doc, {
      ...options(directory),
      recorder,
    });
    try {
      const results = await execution.run();
      assert.equal(textOf(results.get(execution.graph.sink.id)!), "FINAL-OUT");
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
      const fitted = await JuncoGraph.fromYaml(doc, {
        ...options(directory),
        profiles: file,
        scheduler: () =>
          schedules.limit({ memory: megabytes(1) }, schedules.parallel()),
      });
      try {
        const results = await fitted.run();
        assert.equal(textOf(results.get(fitted.graph.sink.id)!), "FINAL-OUT");
      } finally {
        await fitted.graph.close();
      }
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
          ? new MockAgent({ runs: [run([{ step: failed(cause) }])] })
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
    const usage = (source: object, totalTokens: number) =>
      view.record({
        resource: "tokens",
        kind: "usage",
        source,
        usage: {
          input: totalTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
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

    usage(agentA, 100); // history before the activation is not its usage
    const a = activation(agentA, "owner-a");
    const b = activation(agentB, "owner-b");
    start(a);
    start(b);
    usage(agentA, 3);
    usage(agentB, 7);
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
        sample.resources.memory,
      ]),
      [
        ["Inner/Work:er", 3, 40],
        ["Inner/Work:er", 7, 90],
        ["Inner/Work:er", 0, 0],
        ["Inner/Work:er", undefined, 0],
      ],
    );
    assert.deepEqual(samples[0]?.units, {
      runtime: "ms",
      tokens: "tok",
      memory: "B",
    });
    assert.deepEqual(samples[3]?.units, { runtime: "ms", memory: "B" });
    assert.equal(samples[0]?.resources.runtime, 5);
    assert.deepEqual(samples[0]?.features, { "Start~>Worker": { count: 1 } });

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
