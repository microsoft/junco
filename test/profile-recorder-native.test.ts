import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { parseSamples } from "dataflow-profile";
import { JuncoGraph, schedules, tracer } from "junco-agency";
import { JuncoAgent } from "junco-agent";
import { LockPolicy, type NativeModule, ToolCollection } from "junco-tools";
import { Type } from "typebox";
import { nativeOptions } from "./support.ts";

// Build the CopyTree test addon with `bun run build:native:test` in packages/junco-tools.
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

test("ProfileRecorder attributes native agent memory and tokens, and graph resources reach bash", async () => {
  const root = await mkdtemp(join(tmpdir(), "junco-profile-native-"));
  const seed = join(root, "seed");
  const path = join(root, "samples.jsonl");
  try {
    await mkdir(join(seed, "src"), { recursive: true });
    await writeFile(join(seed, "src/seed.ts"), "const value = 1;\n");
    const recorder = new tracer.ProfileRecorder({ path, monitored: true });
    const collection = await ToolCollection.create(seed, {
      native: copyTree,
      policy: LockPolicy,
      sandbox: "always",
    });
    try {
      let agent: JuncoAgent;
      const probe: AgentTool = {
        name: "resource_probe",
        label: "Resource probe",
        description: "Report an owner-attributed pipeline peak",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          recorder.onResourceEvent({
            kind: "finished",
            pipelineId: 1,
            owner: agent.owner!,
            sample: {
              elapsedMs: 5,
              memoryBytes: 10,
              memoryPeakBytes: 4096,
              cpuUsageMs: 1,
              cpuUserMs: 1,
              cpuSystemMs: 0,
              cpuThrottledMs: 0,
              pids: 0,
              oomKills: 0,
            },
          });
          return { content: [{ type: "text", text: "measured" }], details: {} };
        },
      };
      const probeCall = fauxAssistantMessage(
        [fauxToolCall(probe.name, {}, { id: "probe-1" })],
        { stopReason: "toolUse" },
      );
      agent = await JuncoAgent.fromResolved({
        ...(await nativeOptions([probeCall, fauxAssistantMessage("done")]))
          .options,
        systemPrompt: "leaf",
        collection,
        tools: [probe],
      });
      let execution:
        | Awaited<ReturnType<typeof JuncoGraph.fromYaml>>
        | undefined;
      try {
        assert.equal(typeof agent.owner, "string");
        execution = await JuncoGraph.fromYaml(
          {
            graph: {
              nodes: {
                Worker: { prompt: "Measure resources" },
              },
              edges: [{ from: "Worker", to: "$sink" }],
            },
          },
          {
            cwd: seed,
            collection,
            createAgent: async () => agent,
            tracer: recorder,
            scheduler: () => schedules.parallel(),
          },
        );
        await execution.run();
        await recorder.flush();
        const samples = parseSamples(await readFile(path, "utf8"));
        const worker = samples.find(
          (sample) =>
            sample.node === "Worker" && sample.resources.memory === 4096,
        );
        assert.ok(
          worker,
          "Worker must record the tool's owner-attributed peak",
        );
        assert.equal(worker.resources.memory, 4096);
        assert.ok((worker.resources.tokens ?? 0) > 0);
        assert.deepEqual(worker.units, {
          runtime: "ms",
          tokens: "tok",
          memory: "B",
        });
        const sink = samples.find((sample) => sample.node === "$sink");
        assert.ok(sink, "$sink must have a recorded activation");
        assert.equal(sink.resources.memory, 0);
        assert.equal(sink.resources.tokens, undefined);
      } finally {
        try {
          if (execution) await execution.graph.close();
          else await agent[Symbol.asyncDispose]();
        } finally {
          await recorder.flush();
        }
      }
    } finally {
      await collection.close();
    }

    const limited = await JuncoGraph.create(
      seed,
      {
        native: copyTree,
        policy: LockPolicy,
        sandbox: "always",
        resources: { pids: 8 },
      },
      (collection) =>
        JuncoGraph.fromYaml(
          {
            graph: {
              nodes: { Start: { kind: "emit", text: "resource probe" } },
              edges: [{ from: "Start", to: "$sink", kind: "message" }],
            },
          },
          {
            cwd: seed,
            collection,
            tracer: new tracer.DummyTracer(),
            scheduler: () => schedules.parallel(),
          },
        ),
    );
    try {
      const bash = limited.graph.collection!.tools.find(
        (tool) => tool.name === "bash",
      );
      assert.ok(bash);
      const first = await bash.execute(
        "resource-probe",
        {
          command:
            "/bin/sh -c 'd=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); cat $d/pids.max'",
        },
        undefined,
      );
      const text = contentText(first.content);
      if (text.includes("cgroup resource control unavailable")) {
        assert.equal(first.isError, true);
        assert.doesNotMatch(text, /^\d+$/m);
        console.log("skipping: cgroup delegation unavailable");
        return;
      }
      assert.equal(text, "8\n");
    } finally {
      await limited.graph.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
