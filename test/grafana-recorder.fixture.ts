// Interactive retained-metrics smoke: `bun run ./test/grafana-recorder.fixture.ts` (anonymous Grafana).
// Real nested graph, real faux-provider JuncoAgents, real owner-bound shell pipelines holding touched
// memory; every metric reaches Grafana only through the threaded recorder.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { JuncoGraph, schedules, tracer } from "junco";
import { JuncoAgent } from "junco-agent";
import { LockPolicy, type NativeModule, ToolCollection } from "junco-tools";
import { nativeOptions } from "./support.ts";

// Runtime-built artifact (`bun run build:native:test` in packages/junco-tools); absent until built.
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

const PYTHON =
  "import sys, time\ndata = bytearray(int(sys.argv[1]) * 1024 * 1024)\nfor i in range(0, len(data), 4096):\n    data[i] = 1\ntime.sleep(20)\n";
/** A shell command holding `mib` MiB of touched memory for 20 seconds. */
const hold = (mib: number) =>
  existsSync("/usr/bin/python3")
    ? `/usr/bin/python3 -c '${PYTHON}' ${mib}`
    : `${process.execPath} -e 'const b = Buffer.alloc(${mib} * 1024 * 1024, 1); setTimeout(() => b.length, 20000)'`;

type Result = {
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
};
const seen: Record<string, Result[]> = { A: [], B: [] };
const userMessages: Record<string, string[]> = { A: [], B: [] };
const tokens: Record<string, number> = { A: 0, B: 0 };
const agents: Record<string, JuncoAgent> = {};

/** A faux step that first records `node`'s latest real tool result, then answers via `next`. */
const step =
  (
    node: string,
    next: (results: Result[]) => AssistantMessage,
  ): FauxResponseFactory =>
  (context) => {
    userMessages[node] = context.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : contentText(message.content),
      );
    const last = context.messages.at(-1) as AgentMessage | undefined;
    if (last?.role === "toolResult")
      seen[node]!.push({
        name: last.toolName,
        text: contentText(last.content),
        isError: last.isError,
      });
    return next(seen[node]!);
  };
const call = (name: string, args: ToolCall["arguments"]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const json = <T>(results: Result[], name: string): T[] =>
  results.filter((r) => r.name === name).map((r) => JSON.parse(r.text) as T);

const A_SCRIPT = [
  () => call("bash", { command: hold(16) }),
  () =>
    call("ast_edit", {
      rewrites: { "1": "22" },
      path: "src/a.ts",
      dryRun: true,
    }),
  () =>
    call("ast_edit", {
      rewrites: { "1": "22" },
      path: "src/a.ts",
      dryRun: false,
    }),
  () => call("release", { file: "src/a.ts" }),
  () => call("info", {}),
  (results: Result[]) => {
    type Route = { edgeId: string; kind: string };
    const info = json<{ children: Route[] }>(results, "info").at(-1)!;
    const route = info.children.find((child) => child.kind === "message");
    if (!route) throw new Error("A has no message route");
    return call("send", {
      id: route.edgeId,
      payload: { kind: "prompt", text: "src/a.ts edited and released" },
    });
  },
  () => call("yield", { reason: "sent to B" }),
  () => fauxAssistantMessage("A done"),
].map((next) => step("A", next));

const b = (results: Result[]) => {
  const names = results.map((r) => r.name);
  if (!names.includes("bash")) return call("bash", { command: hold(32) });
  if (!names.includes("yield"))
    return call("yield", { reason: "waiting for A" });
  if (!userMessages.B!.includes("src/a.ts edited and released"))
    return call("yield", { reason: "still waiting for A" });
  const graphs = results.filter((r) => r.name === "code_graph");
  type List = { clusters: { cluster: { id: string } }[] };
  const clusterId = () => {
    const list = JSON.parse(graphs[3]!.text) as List;
    const first = list.clusters[0];
    if (!first) throw new Error("code_graph cluster list is empty");
    return first.cluster.id;
  };
  switch (graphs.length) {
    case 0:
      return call("code_graph", { action: "map" });
    case 1:
      return call("code_graph", { action: "search", query: "ping" });
    case 2:
      return call("code_graph", {
        action: "deps",
        symbol: "ping",
        symbolPath: "src/a.ts",
        direction: "in",
      });
    case 3:
      return call("code_graph", { action: "cluster", clusterView: "list" });
    case 4:
      return call("code_graph", {
        action: "cluster",
        clusterView: "members",
        clusterId: clusterId(),
      });
    case 5:
      return call("code_graph", {
        action: "cluster",
        clusterView: "neighbors",
        clusterId: clusterId(),
      });
    default:
      return fauxAssistantMessage("B done");
  }
};
const B_SCRIPT = Array.from({ length: 32 }, () => step("B", b));

const root = await mkdtemp(join(tmpdir(), "junco-grafana-live-"));
const seed = join(root, "seed");
await mkdir(join(seed, "src"), { recursive: true });
await writeFile(
  join(seed, "src/a.ts"),
  "export function ping() { return 1; }\n",
);
await writeFile(
  join(seed, "src/b.ts"),
  'import { ping } from "./a.ts";\nexport function run() { return ping(); }\n',
);
await writeFile(
  join(seed, "src/main.ts"),
  'import { run } from "./b.ts";\nrun();\n',
);
const yaml = await readFile(
  fileURLToPath(new URL("./grafana-recorder.fixture.yml", import.meta.url)),
  "utf8",
);
const prompt = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const recorder = await tracer.GrafanaRecorder.create({
  url: process.env.GRAFANA_URL ?? "http://localhost:8000",
  intervalMs: 1000,
});
try {
  console.log(`dashboard: ${recorder.dashboardUrl}`);
  await prompt.question("Open the dashboard, then press Enter to start… ");
  const sampled = new Set<string>();
  let started = false;
  const collection = await ToolCollection.create(seed, {
    native: copyTree,
    policy: LockPolicy,
    sandbox: "always",
    resources: { monitorIntervalMs: 100 },
    recorder,
    // Caller callback composed with the recorder: only detects overlap for the log marker.
    onResourceEvent: (event) => {
      if (!event.owner || !(event.sample && event.sample.memoryBytes > 0))
        return;
      sampled.add(event.owner);
      if (!started && sampled.size >= 2) {
        started = true;
        console.log("sampling started");
      }
    },
  });
  try {
    const execution = await JuncoGraph.fromYaml(yaml, {
      cwd: seed,
      collection,
      recorder,
      tracer: new tracer.DummyTracer(),
      scheduler: () => schedules.parallel(),
      createAgent: async (spec) => {
        const agent = await JuncoAgent.fromResolved({
          ...(await nativeOptions(spec.node === "A" ? A_SCRIPT : B_SCRIPT))
            .options,
          systemPrompt: "leaf",
          tools: spec.tools,
          tool_block: spec.tool_block ?? [],
          collection: spec.collection,
          recorder: spec.recorder,
          recorderNodeId: spec.recorderNodeId,
        });
        agent.events.on("usage", ({ row }) => {
          tokens[spec.node]! += row.usage.totalTokens;
        });
        agents[spec.node] = agent;
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

  // Independent validation of the real results the dashboard must reflect.
  for (const node of ["A", "B"])
    for (const result of seen[node]!)
      assert.equal(
        result.isError,
        false,
        `${node} ${result.name}: ${result.text}`,
      );
  assert.ok(agents.A && agents.B && agents.A.owner !== agents.B.owner);
  assert.equal(
    await readFile(join(seed, "src/a.ts"), "utf8"),
    "export function ping() { return 22; }\n",
  );
  assert.equal(
    userMessages.B!.filter((text) => text === "src/a.ts edited and released")
      .length,
    1,
  );
  const count = (node: string, name: string) =>
    seen[node]!.filter((r) => r.name === name).length;
  assert.equal(count("A", "ast_edit"), 2);
  assert.equal(count("B", "code_graph"), 6);
  assert.ok(started, "both owners produced nonzero memory samples");

  console.log("expected (compare with Grafana inspector values):");
  console.log(`  tokens_used nodeId1::nodeId2::A = ${tokens.A}`);
  console.log(`  tokens_used nodeId1::nodeId2::B = ${tokens.B}`);
  console.log(`  tokens_used total = ${tokens.A! + tokens.B!}`);
  console.log(`  ast_edit preview = 1, apply = 1 (deleted 1 B, inserted 2 B)`);
  console.log(
    `  code_graph calls = 6 (map, search, deps, cluster.list/members/neighbors)`,
  );
  console.log(`  send = ${count("A", "send")}, delivered user messages = 1`);
  console.log(
    `  yield tool calls A = ${count("A", "yield")}, B = ${count("B", "yield")}`,
  );
  await recorder.flush();
  await prompt.question(
    "Inspect the final snapshot, then press Enter to close… ",
  );
} finally {
  try {
    await recorder.close();
  } finally {
    prompt.close();
    await rm(root, { recursive: true, force: true });
  }
}
