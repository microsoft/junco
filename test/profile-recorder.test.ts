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
    const recorder = new tracer.ProfileRecorder({ path, monitored: true });
    const doc = document();
    const execution = await JuncoGraph.fromYaml(doc, {
      ...options(directory),
      tracer: recorder,
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
    const recorder = new tracer.ProfileRecorder({ path });
    const cause = new Error("provider down");
    const execution = await JuncoGraph.fromYaml(document(), {
      ...options(directory),
      tracer: recorder,
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
    const recorder = new tracer.ProfileRecorder({ path: directory });
    const execution = await JuncoGraph.fromYaml(document(), {
      ...options(directory),
      tracer: recorder,
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
