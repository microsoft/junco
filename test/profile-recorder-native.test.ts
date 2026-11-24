import { test } from "bun:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { parseSamples } from "dataflow-profile";
import { graph, JuncoGraph, schedules, type tools, tracer } from "junco";
import { JuncoAgent } from "junco-agent";
import { LockPolicy, ToolCollection } from "junco-tools";
import { copyTreeNative, offlineLadder } from "./support.ts";
import { Constant } from "./syntax-code-nodes.fixture.ts";

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
      Start: { kind: "emit", text: "measure", spec: "done" },
      Worker: { prompt: "Measure resources" },
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
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
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
    native: await copyTreeNative(),
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
      ladder: await offlineLadder([
        (context) => {
          const texts = context.messages
            .filter((message) => message.role === "user")
            .map((message) => typeof message.content === "string" ? message.content : contentText(message.content));
          assert.equal(texts.length, 2);
          assert.equal(texts[0], "Measure resources");
          assert.match(
            texts[1]!,
            /^measure\n\nTask: \{"taskId":"[0-9a-f-]{36}","spec":"done","deps":\[\],"history":\[\]\}$/,
          );
          return fauxAssistantMessage(fauxToolCall("bash", { command: COMMAND }), { stopReason: "toolUse" });
        },
        lastResult,
      ]),
    });
    try {
      const worker = execution.graph.getNode(graph.NodeId.create("Worker"))?.state;
      assert.ok(worker instanceof JuncoAgent);
      worker.events.on("usage", ({ row }) => { tokens += row.usage.totalTokens; });
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

test("JsonlRecorder records real Worker pipeline memory and committed usage", async () => {
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
      assert.equal(worker.resources.cost, 0);
      assert.deepEqual(worker.features, { "Start~>Worker": { count: 1 } });
      assert.deepEqual(worker.units, {
        runtime: "ms",
        tokens: "tok",
        cost: "USD",
        memory: "B",
      });
      const sink = samples.find((sample) => sample.node === "$sink");
      assert.ok(sink, "$sink must have a recorded activation");
      assert.equal(sink.resources.memory, 0);
      assert.equal(sink.resources.tokens, undefined);
      assert.equal(sink.resources.cost, undefined);
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

/** Decode native-run OTLP gauges into accounting rows. */
function parseLines(body: string): Line[] {
  const decoded = JSON.parse(body) as {
    resourceMetrics: {
      scopeMetrics: {
        metrics: {
          name: string;
          gauge: {
            dataPoints: {
              attributes: { key: string; value: { stringValue: string } }[];
              asDouble?: number;
              flags?: number;
            }[];
          };
        }[];
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
        for (const point of metric.gauge.dataPoints) {
          const tags = Object.fromEntries(
            point.attributes.map(({ key, value }) => [key, value.stringValue]),
          );
          assert.match(tags.stream ?? "", /^junco_[0-9a-f]{32}$/);
          const key = JSON.stringify([match[1], tags]);
          let row = rows.get(key);
          if (row === undefined) {
            row = { measurement: match[1]!, tags, fields: {} };
            rows.set(key, row);
          }
          if (point.flags !== 1) {
            assert.equal(typeof point.asDouble, "number");
            (row.fields as Record<string, number>)[match[2]!] = point.asDouble!;
          }
        }
      }
  return [...rows.values()];
}

test("GrafanaRecorder exports the same real Worker run over OTLP JSON", async () => {
  const pushes: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = request.url ?? "";
    if (request.method === "GET" && url.includes("/dashboards/"))
      response.writeHead(404).end("{}");
    else if (request.method === "POST" && url.endsWith("/dashboards"))
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    else if (request.method === "POST" && url === "/api/telemetry/metrics") {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["content-type"], "application/json");
      pushes.push(body);
      response.writeHead(200).end();
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
        native: await copyTreeNative(),
        policy: LockPolicy,
        sandbox: "always",
        resources: { pids: 8 },
      },
      (collection) =>
        JuncoGraph.fromYaml(
          {
            graph: {
              sink: { trigger: "never" },
              nodes: {
                Start: { kind: "emit", text: "resource probe", spec: "done" },
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
