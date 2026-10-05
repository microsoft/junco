import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { NodeId } from "dataflow-engine";
import { JuncoAgent } from "junco-agent";
import { JuncoMcpTools } from "junco-mcp";
import {
  acquireShellMux,
  createTaskTool,
  type NativeModule,
  type ShellMuxLease,
  shutdownShellMux,
} from "junco-tools";
import {
  agentNode,
  createParallelAgentGraph,
  graphNode,
  type JuncoGraph,
} from "../src/index.ts";
import { always } from "../src/std/trigger.ts";
import { withNativeCleanup } from "./native-support.ts";
import { nativeOptions } from "./support.ts";

// Agents with real MCP stdio servers in a root graph, a nested graph and a separate graph, all on
// the one ShellMux of junco-tools' CopyTree test addon. Build it once in packages/junco-tools with
// `bun run build:native:test`.
const testAddon = await import(
  fileURLToPath(
    new URL(
      "../packages/junco-tools/target/native-test/index.js",
      import.meta.url,
    ),
  )
);
const SERVER = fileURLToPath(
  new URL("../packages/junco-mcp/test/stdio-server.ts", import.meta.url),
);

const opens: string[] = [];
const copyTree = {
  ...testAddon,
  NativeMux: {
    async open(root: string, options?: { sandbox?: string }) {
      opens.push(root);
      return testAddon.NativeMux.openCopyTree(root, options);
    },
  },
} as NativeModule;

let root: string;
let seed: string;
let observer: ShellMuxLease;

beforeAll(async () => {
  root = await mkdtemp(
    fileURLToPath(
      new URL("../packages/junco-tools/target/graph-mcp-", import.meta.url),
    ),
  );
  seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  observer = await acquireShellMux(seed, { native: copyTree });
});

afterAll(async () => {
  observer?.release();
  try {
    await shutdownShellMux();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fixture = JuncoMcpTools.add({
  name: "fx",
  type: "stdio",
  command: process.execPath,
  args: [SERVER],
});

/** Calls the server's `read_state`, then answers with its process id. */
const readPid: FauxResponseStep[] = [
  fauxAssistantMessage([fauxToolCall("mcp__fx__read_state", {}, { id: "s" })], {
    stopReason: "toolUse",
  }),
  (context: Context) => {
    const result = [...context.messages]
      .reverse()
      .find((message) => message.role === "toolResult");
    const text =
      result?.role === "toolResult" && result.content[0]?.type === "text"
        ? result.content[0].text
        : "{}";
    return fauxAssistantMessage(String(JSON.parse(text).pid));
  },
];

async function member(): Promise<JuncoAgent> {
  const { options } = await nativeOptions(readPid);
  return JuncoAgent.fromResolved({
    ...options,
    cwd: seed,
    tools: [fixture],
  });
}

function single(agent: JuncoAgent): {
  graph: JuncoGraph;
  id: ReturnType<typeof NodeId>;
} {
  const graph = createParallelAgentGraph();
  const id = graph.addNode(
    agentNode(
      agent,
      { id: NodeId("member"), trigger: always() },
      { prompt: "go" },
    ),
  );
  return { graph, id };
}

function pidOf(message: AssistantMessage | undefined): number {
  assert.ok(message, "graph node produced a message");
  return Number(contentText(message.content));
}

test("root, nested and separate graphs share one ShellMux; closing one graph leaves the others' servers working", () =>
  withNativeCleanup(async (defer) => {
    // Each member is the test's until a graph owns it; each graph is the test's until closed.
    const separateMember = await member();
    const forgetSeparateMember = defer(() => separateMember.return());
    const separate = single(separateMember);
    const forgetSeparate = defer(() => separate.graph.close());
    forgetSeparateMember();

    const nestedMember = await member();
    const forgetNestedMember = defer(() => nestedMember.return());
    const nested = single(nestedMember);
    const forgetNested = defer(() => nested.graph.close());
    forgetNestedMember();

    const rootMember = await member();
    const forgetRootMember = defer(() => rootMember.return());
    const rootGraph = createParallelAgentGraph();
    const forgetRoot = defer(() => rootGraph.close());
    const rootId = rootGraph.addNode(
      agentNode(
        rootMember,
        { id: NodeId("root"), trigger: always() },
        { prompt: "go" },
      ),
    );
    forgetRootMember();
    const nestedId = rootGraph.addNode(
      graphNode(
        nested.graph,
        { id: NodeId("nested"), trigger: always() },
        { result: nested.id },
      ),
    );
    forgetNested();

    // The separate graph runs and closes first, closing its agent and that agent's server.
    const separatePid = pidOf((await separate.graph.run()).get(separate.id));
    await separate.graph.close().finally(forgetSeparate);

    // The root and nested agents' servers started before that close and still answer.
    const results = await rootGraph.run();
    const rootPid = pidOf(results.get(rootId));
    const nestedPid = pidOf(results.get(nestedId));
    expect(new Set([separatePid, rootPid, nestedPid]).size).toBe(3);
    for (const pid of [separatePid, rootPid, nestedPid]) {
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
    }
    await rootGraph.close().finally(forgetRoot);

    // Every agent in every graph acquired the observer's one raw open; no close shut it down.
    expect(opens).toEqual([seed]);
    const again = await acquireShellMux(seed);
    defer(() => again.release());
    expect(again.mux).toBe(observer.mux);
  }), 60_000);

/** The text of every tool result for `name` in `context`. */
const toolTexts = (context: Context, name: string) =>
  context.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === name
      ? [contentText(message.content)]
      : [],
  );

/** Task reports that entered `context` as user messages. */
const reportsIn = (context: Context) =>
  context.messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : contentText(message.content);
    return text.startsWith('{"type":"task_result"')
      ? [JSON.parse(text) as { id: string; output: string; status: string }]
      : [];
  });

/**
 * Reads its server's pid, delegates one task to `delegate` (if any), and answers
 * `<label>:<pid>` followed by its task report's output once that report arrived.
 */
function mcpScript(label: string, delegate?: string): FauxResponseStep[] {
  const answer = (context: Context) => {
    const pid = JSON.parse(toolTexts(context, "mcp__fx__read_state")[0]!).pid;
    const reports = reportsIn(context);
    if (delegate !== undefined && reports.length === 0)
      return fauxAssistantMessage(`${label}: waiting`);
    return fauxAssistantMessage(
      [`${label}:${pid}`, ...reports.map(({ output }) => output)].join("|"),
    );
  };
  return [
    fauxAssistantMessage(
      [fauxToolCall("mcp__fx__read_state", {}, { id: `${label}-s` })],
      {
        stopReason: "toolUse",
      },
    ),
    ...(delegate === undefined
      ? []
      : [
          fauxAssistantMessage(
            [
              fauxToolCall(
                "task",
                {
                  context: "Each server keeps its own state.",
                  tasks: [
                    {
                      name: delegate,
                      task: "Read your server state",
                      model: { provider: delegate, modelId: "faux-1" },
                    },
                  ],
                },
                { id: `${label}-t` },
              ),
            ],
            { stopReason: "toolUse" },
          ),
        ]),
    answer,
    answer,
    answer,
  ];
}

test("a task child and grandchild call the inherited MCP tool on their own servers; reports finish the original node", () =>
  withNativeCleanup(async (defer) => {
    const models = createModels();
    const scripts: Record<string, FauxResponseStep[]> = {
      caller: mcpScript("caller", "worker"),
      worker: mcpScript("worker", "grand"),
      grand: mcpScript("grand"),
    };
    for (const [name, responses] of Object.entries(scripts)) {
      const faux = fauxProvider({
        api: name,
        provider: name,
        tokenSize: { min: 4, max: 4 },
      });
      faux.setResponses(responses);
      models.setProvider(faux.provider);
    }
    const caller = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models,
      model: models.getModels("caller")[0]!,
      systemPrompt: "sys",
      cwd: seed,
      tools: [createTaskTool(), fixture],
    });
    const forgetCaller = defer(() => caller.return());
    const outer = createParallelAgentGraph();
    const forgetOuter = defer(() => outer.close());
    const id = outer.addNode(
      agentNode(
        caller,
        { id: NodeId("caller"), trigger: always() },
        { prompt: "go" },
      ),
    );
    forgetCaller();

    const final = (await outer.run()).get(id);
    assert.ok(final, "the caller's node produced a message");
    const parts = contentText(final.content).split("|");
    expect(parts.map((part) => part.split(":")[0])).toEqual([
      "caller",
      "worker",
      "grand",
    ]);
    const pids = parts.map((part) => Number(part.split(":")[1]));
    expect(new Set(pids).size).toBe(3);
    for (const pid of pids) expect(Number.isInteger(pid) && pid > 0).toBe(true);

    await outer.close().finally(forgetOuter);
    expect(caller.status).toBe("closed");
  }), 60_000);
