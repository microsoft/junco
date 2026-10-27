import { test } from "bun:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { parseSamples } from "dataflow-profile";
import { JuncoGraph, schedules, type tools, tracer } from "junco-agency";
import { JuncoAgent } from "junco-agent";
import { LockPolicy, type NativeModule, ToolCollection } from "junco-tools";
import { nativeOptions } from "./support.ts";
import { Constant } from "./syntax-code-nodes.fixture.ts";

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

// Touched memory held for one second: real pipeline memory, sampled every 100 ms.
// The size prints only after the workload completes.
const PROGRAM =
  "import sys, time\ndata = bytearray(int(sys.argv[1]) * 1024 * 1024)\nfor i in range(0, len(data), 4096):\n    data[i] = 1\ntime.sleep(1)\nprint(len(data))\n";
const COMMAND = `/usr/bin/python3 -c '${PROGRAM}' 4`;

const PROMPT = {
  type: "object",
  required: ["kind", "text"],
  properties: { kind: { const: "prompt" }, text: { type: "string" } },
};
const DOCUMENT = {
  graph: {
    nodes: {
      Start: { kind: "emit", text: "measure" },
      Worker: {
        prompt: "Measure resources",
        tools: ["bash"],
        contracts: { "Start~>Worker": "One text prompt to measure." },
      },
    },
    edges: [
      { from: "Start", to: "Worker", kind: "message", schema: PROMPT },
      {
        from: "Worker",
        to: "$sink",
        schema: {
          type: "object",
          required: ["role", "content"],
          properties: { role: { const: "assistant" } },
        },
      },
    ],
  },
};

type Run = { readonly tokens: number };

/** Run the real Start~>Worker->$sink graph once, attributing everything to `recorder`. */
async function runRecorded(
  recorder: tools.ProfileRecorder<
    "memory" | "tokens" | "edits" | "operations" | "probe"
  >,
  seed: string,
): Promise<Run> {
  let bashResult: AgentMessage | undefined;
  let tokens = 0;
  const lastResult: FauxResponseFactory = (context) => {
    const last = context.messages.at(-1) as AgentMessage | undefined;
    if (last?.role === "toolResult") bashResult = last;
    return fauxAssistantMessage("done");
  };
  const collection = await ToolCollection.create(seed, {
    native: copyTree,
    policy: LockPolicy,
    sandbox: "always",
    resources: { monitorIntervalMs: 100 },
    recorder,
  });
  try {
    const execution = await JuncoGraph.fromYaml(DOCUMENT, {
      cwd: seed,
      collection,
      recorder,
      tracer: new tracer.DummyTracer(),
      scheduler: () => schedules.parallel(),
      createAgent: async (spec) => {
        const agent = await JuncoAgent.fromResolved({
          ...(
            await nativeOptions([
              fauxAssistantMessage(fauxToolCall("recv", {}), {
                stopReason: "toolUse",
              }),
              fauxAssistantMessage(fauxToolCall("bash", { command: COMMAND }), {
                stopReason: "toolUse",
              }),
              lastResult,
            ])
          ).options,
          systemPrompt: "leaf",
          tools: spec.tools,
          collection: spec.collection,
          recorder: spec.recorder,
          recorderNodeId: spec.recorderNodeId,
        });
        agent.events.on("usage", ({ row }) => {
          tokens += row.usage.totalTokens;
        });
        return agent;
      },
    });
    try {
      await execution.run();
    } finally {
      await execution.graph.close();
    }
  } finally {
    await collection.close();
  }
  assert.ok(
    bashResult?.role === "toolResult",
    "expected measured bash tool result",
  );
  assert.equal(bashResult.toolName, "bash");
  // The agent harness reports any resolved tool call with isError: false, so
  // require the workload's own completion output; failures append an exit status.
  assert.equal(contentText(bashResult.content), `${4 * 1024 * 1024}\n`);
  return { tokens };
}

async function seeded(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const seed = join(root, "seed");
  await mkdir(join(seed, "src"), { recursive: true });
  await writeFile(join(seed, "src/seed.ts"), "const value = 1;\n");
  return { root, seed };
}

test("JsonlRecorder records real Worker pipeline memory and committed tokens", async () => {
  const { root, seed } = await seeded("junco-profile-native-");
  const path = join(root, "samples.jsonl");
  const recorder = new tracer.JsonlRecorder({ path, monitored: true });
  try {
    try {
      const run = await runRecorded(recorder, seed);
      await recorder.flush();
      const samples = parseSamples(await readFile(path, "utf8"));
      const workers = samples.filter((sample) => sample.node === "Worker");
      // The prime activation awaits input; the delivered message drives the measured one.
      const worker = workers.find(
        (sample) => "Start~>Worker" in sample.features,
      );
      assert.ok(worker, JSON.stringify(workers));
      assert.equal(
        workers.reduce(
          (sum, sample) => sum + (sample.resources.tokens ?? 0),
          0,
        ),
        run.tokens,
        "committed tokens are attributed once",
      );
      console.log(`JSONL Worker peak memory: ${worker.resources.memory} B`);
      assert.ok((worker.resources.memory ?? 0) > 0);
      assert.ok(run.tokens > 0);
      assert.equal(worker.resources.tokens, run.tokens);
      assert.deepEqual(worker.features, { "Start~>Worker": { count: 1 } });
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
      await recorder.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

type Line = {
  readonly measurement: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, number>>;
};

/** Parse one Live push of Influx line protocol (escaped tags, float fields). */
function parseLines(body: string): Line[] {
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [series, fields] = line.split(/(?<!\\) /) as [string, string];
      const [measurement, ...tags] = series.split(/(?<!\\),/);
      return {
        measurement: measurement!,
        tags: Object.fromEntries(
          tags.map((tag) => {
            const [key, value] = tag.split(/(?<!\\)=/) as [string, string];
            return [key, value.replace(/\\(.)/g, "$1")];
          }),
        ),
        fields: Object.fromEntries(
          fields.split(",").map((field) => {
            const [key, value] = field.split("=") as [string, string];
            return [key, Number(value)];
          }),
        ),
      };
    });
}

test("GrafanaRecorder exports the same real Worker run over Live push", async () => {
  const pushes: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = request.url ?? "";
    if (request.method === "GET" && url.includes("/dashboards/"))
      response.writeHead(404).end("{}");
    else if (request.method === "POST" && url.endsWith("/dashboards"))
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    else if (request.method === "POST" && url.startsWith("/api/live/push/")) {
      pushes.push(body);
      response.writeHead(200).end("{}");
    } else response.writeHead(500).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { root, seed } = await seeded("junco-grafana-native-");
  try {
    const recorder = await tracer.GrafanaRecorder.create({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      intervalMs: 60_000,
    });
    try {
      const run = await runRecorded(recorder, seed);
      await recorder.flush();
      const lines = parseLines(pushes.at(-1)!);
      const worker = lines.find(
        (line) =>
          line.measurement === "junco_node" && line.tags.node === "Worker",
      );
      assert.ok(worker, "Worker node series");
      console.log(
        `Grafana Worker peak memory: ${worker.fields.memory_peak_bytes} B`,
      );
      assert.ok(worker.fields.memory_peak_bytes! > 0);
      assert.equal(worker.fields.memory_bytes ?? 0, 0);
      assert.ok(run.tokens > 0);
      assert.equal(worker.fields.tokens_used, run.tokens);
      const operation = (match: Readonly<Record<string, string>>) =>
        lines.find(
          (line) =>
            line.measurement === "junco_operation" &&
            Object.entries(match).every(
              ([key, value]) => line.tags[key] === value,
            ),
        );
      const expected: Readonly<Record<string, string>>[] = [
        {
          node: "Worker",
          resource: "memory",
          category: "shell",
          operation: "exec",
        },
        { node: "Worker", resource: "memory", tool: "bash" },
        { node: "Worker", resource: "operations", category: "recv" },
        {
          node: "Worker",
          resource: "operations",
          category: "graph",
          operation: "prime",
        },
      ];
      for (const match of expected) {
        const line = operation(match);
        assert.ok(line, `missing operation ${JSON.stringify(match)}`);
        assert.ok(line.fields.calls! >= 1);
        assert.equal(line.fields.inflight, 0);
      }
    } finally {
      await recorder.close();
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("graph resources reach bash as cgroup pid limits", async () => {
  const { root, seed } = await seeded("junco-pids-native-");
  try {
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
              nodes: {
                Start: { kind: "emit", text: "resource probe" },
                Terminal: { kind: "code", trigger: "never" },
              },
              edges: [
                {
                  from: "Start",
                  to: "Terminal",
                  kind: "message",
                  schema: PROMPT,
                },
                { from: "Terminal", to: "$sink", schema: { type: "null" } },
              ],
            },
          },
          {
            cwd: seed,
            collection,
            tracer: new tracer.DummyTracer(),
            scheduler: () => schedules.parallel(),
            code: { Terminal: Constant(null) },
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
      assert.ok(!first.isError, text);
      assert.equal(text, "8\n");
    } finally {
      await limited.graph.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
