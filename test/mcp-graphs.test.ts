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
import {
  DummyTracer,
  NodeId,
  type NodeIdType,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import { JuncoMcpTools, McpBuilder } from "junco-mcp";
import { pi } from "junco-scheduler/agent";
import {
  LockPolicy,
  TaskTool,
  ToolCollection,
} from "junco-tools";
import { JuncoGraph, schedules, syntax } from "../src/index.ts";
import { TriggerRule } from "../src/std/trigger.ts";
import { terminalPorts } from "./deterministic-support.ts";
import { withNativeCleanup } from "./native-support.ts";
import {
  addPromptOnce,
  type AgencyContext,
  copyTreeNative,
  NATIVE_TOOL_BLOCK,
  nativeOptions,
  offlineLadder,
  schedulerModel,
} from "./support.ts";

// Agents with real MCP stdio servers in a shared root graph, its nested graph and an independent
// graph, each collection on its own ShellMux of junco-tools' CopyTree test addon. Build it once in
// packages/junco-tools with `bun run build:native:test`.
const copyTree = await copyTreeNative();
const SERVER = fileURLToPath(
  new URL("../packages/junco-mcp/test/stdio-server.ts", import.meta.url),
);

let root: string;
let seed: string;

beforeAll(async () => {
  root = await mkdtemp(
    fileURLToPath(
      new URL("../packages/junco-tools/target/graph-mcp-", import.meta.url),
    ),
  );
  seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh Git-policy collection over the fixture seed. */
const openCollection = () =>
  ToolCollection.create(seed, { native: copyTree, policy: LockPolicy });

const fixture = JuncoMcpTools.add({
  name: "fx",
  type: "stdio",
  command: process.execPath,
  args: [SERVER],
});

/** Calls the server's `read_state`, then answers with its process id. */
const readPid = [
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
] as const;

async function member(collection: ToolCollection): Promise<JuncoAgent> {
  const { options } = await nativeOptions(readPid);
  return JuncoAgent.fromResolved({
    ...options,
    cwd: seed,
    tools: [fixture],
    collection,
  });
}

function single(agent: JuncoAgent, collection: ToolCollection) {
  const ports = terminalPorts();
  const graph = new JuncoGraph(
    ports.source,
    ports.sink,
    Width.create(1),
    UNBOUNDED,
    new DummyTracer(),
    LockPolicy,
    collection,
  );
  const context = schedules.context({
    graph,
    scheduler: schedules.parallel(),
  });
  const id = addPromptOnce(graph, "member", agent, "go");
  ports.connect(graph, id);
  return { context, id };
}

function pidOf(message: AssistantMessage | undefined): number {
  assert.ok(message, "graph node produced a message");
  return Number(contentText(message.content));
}

test(
  "a shared root graph and its nested graph run on one collection; closing the root closes only its mux",
  () =>
    withNativeCleanup(async (defer) => {
      // The independent collection and its graph: an unrelated owner on the same seed.
      const independent = await openCollection();
      defer(() => independent.close());
      const separateMember = await member(independent);
      const forgetSeparateMember = defer(() => separateMember.return());
      const separate = single(separateMember, independent);
      const forgetSeparate = defer(() => separate.context.graph.close());
      forgetSeparateMember();

      // Each actor is the test's until a graph owns it; `create` owns the returned root.
      let shared: ToolCollection | undefined;
      let rootId: NodeIdType | undefined;
      let nestedId: NodeIdType | undefined;
      const rootGraph = await JuncoGraph.create(
        seed,
        { native: copyTree, policy: LockPolicy },
        async (collection) => {
          shared = collection;
          const rootMember = await member(collection);
          const forgetRootMember = defer(() => rootMember.return());
          const nestedMember = await member(collection);
          const forgetNestedMember = defer(() => nestedMember.return());
          const nested = single(nestedMember, collection);
          forgetNestedMember();
          const forgetNested = defer(() => nested.context.graph.close());
          const ports = terminalPorts();
          const graph = new JuncoGraph(
            ports.source,
            ports.sink,
            Width.create(1),
            UNBOUNDED,
            new DummyTracer(),
            LockPolicy,
            collection,
          );
          const execution = schedules.context({
            graph,
            scheduler: schedules.parallel(),
          });
          const forgetGraph = defer(() => graph.close());
          rootId = addPromptOnce(graph, "root", rootMember, "go");
          forgetRootMember();
          nestedId = graph.addNode({
            id: NodeId.create("nested"),
            trigger: TriggerRule.always(),
            state: nested.context,
          });
          ports.connect(graph, rootId);
          forgetNested();
          forgetGraph();
          return execution;
        },
      );
      const forgetRoot = defer(() => rootGraph.graph.close());
      assert.ok(shared && rootId && nestedId);
      expect(rootGraph.graph.collection).toBe(shared);
      expect(shared.mux).not.toBe(independent.mux);
      expect(shared.policy).toBe(LockPolicy);

      // The independent graph runs and closes first, closing its agent and that agent's server.
      const separatePid = pidOf(
        (await separate.context.run()).get(separate.id),
      );
      await separate.context.graph.close().finally(forgetSeparate);
      // Its collection is still the test's: the graph released only its own lease.
      await independent.mux.validateCwd(seed);

      // The shared root and nested agents' servers started before that close and still answer.
      const results = await rootGraph.run();
      const rootPid = pidOf(results.get(rootId));
      const nestedPid = pidOf(results.get(nestedId));
      expect(new Set([separatePid, rootPid, nestedPid]).size).toBe(3);
      for (const pid of [separatePid, rootPid, nestedPid]) {
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
      }

      // Closing the root releases the last hold on the shared collection and closes its mux.
      await rootGraph.graph.close().finally(forgetRoot);
      await assert.rejects(shared.mux.validateCwd(seed));

      // The independent collection still serves a fresh graph and server.
      const lateMember = await member(independent);
      const forgetLateMember = defer(() => lateMember.return());
      const late = single(lateMember, independent);
      const forgetLate = defer(() => late.context.graph.close());
      forgetLateMember();
      const latePid = pidOf((await late.context.run()).get(late.id));
      expect(latePid).not.toBe(rootPid);
      await late.context.graph.close().finally(forgetLate);
      await independent.mux.validateCwd(seed);
    }),
  60_000,
);

test(
  "McpBuilder's collection gives every agent the server's tools and one shared server",
  () =>
    withNativeCleanup(async (defer) => {
      const built = await new McpBuilder()
        .add({
          name: "fx",
          type: "stdio",
          command: process.execPath,
          args: [SERVER],
        })
        .build(seed, { native: copyTree, policy: LockPolicy });
      const forgetBuilt = defer(() => built.close());
      const runs = [];
      const ladder = await offlineLadder((context) =>
        context.messages.at(-1)?.role === "toolResult" ? readPid[1](context) : readPid[0]);
      const document = { graph: {
        nodes: {
          Start: { kind: "emit", text: "Read the fixture pid", spec: "Return the server process id." },
          Member: { prompt: "Read the server pid.", tool_block: NATIVE_TOOL_BLOCK },
        },
        edges: [
          { from: "Start", to: "Member", kind: "message", schema: {} },
          { from: "Member", to: "$sink", schema: {} },
        ],
      } };
      for (let index = 0; index < 2; index++) {
        const context = await JuncoGraph.fromYaml(document, {
          cwd: seed, collection: built, ladder, scheduler: () => schedules.parallel(), tracer: new DummyTracer(),
        });
        const forgetGraph = defer(() => context.graph.close());
        runs.push({ context, forgetGraph });
      }
      const pids = await Promise.all(
        runs.map(async ({ context }) => Number(syntax.finalText((await context.run()).get(context.graph.sink.id), "Member"))),
      );
      expect(Number.isInteger(pids[0]) && pids[0]! > 0).toBe(true);
      expect(pids[1]).toBe(pids[0]);
      for (const run of runs)
        await run.context.graph.close().finally(run.forgetGraph);
      // The creator's hold is still outstanding.
      await built.mux.validateCwd(seed);
      await built.close().finally(forgetBuilt);
      await assert.rejects(built.mux.validateCwd(seed));
    }),
  60_000,
);

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

test(
  "a task child and grandchild inherit the shared MCP collection; graph close releases its mux last",
  () =>
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

      let shared: ToolCollection | undefined;
      let caller: JuncoAgent | undefined;
      let id: NodeIdType | undefined;
      const outer: AgencyContext = await JuncoGraph.create(
        seed,
        { native: copyTree, policy: LockPolicy },
        async (collection) => {
          shared = collection;
          const decider = schedulerModel();
          const ports = terminalPorts();
          const graph = new JuncoGraph(
            ports.source,
            ports.sink,
            Width.create(1),
            UNBOUNDED,
            new DummyTracer(),
            LockPolicy,
            collection,
          );
          const execution = schedules.context({
            graph,
            scheduler: pi({
              models: decider.models,
              model: decider.model,
              prompt: "Run the caller.",
            }),
          });
          const forgetGraph = defer(() => graph.close());
          caller = await JuncoAgent.fromResolved({
            session: await new MemorySessionRepo().create(
              {},
              BACKGROUND_CONTEXT,
            ),
            models,
            model: models.getModels("caller")[0]!,
            systemPrompt: "sys",
            cwd: seed,
            tools: [new TaskTool(), fixture],
            tool_block: NATIVE_TOOL_BLOCK,
            collection,
          });
          const callerAgent = caller;
          const forgetCaller = defer(() => callerAgent.return());
          id = addPromptOnce(graph, "caller", caller, "go");
          ports.connect(graph, id);
          forgetCaller();
          forgetGraph();
          return execution;
        },
      );
      const forgetOuter = defer(() => outer.graph.close());
      assert.ok(shared && caller && id);
      expect(caller.collection).toBe(shared);

      await outer.run();
      const final = outer.graph.result(id);
      assert.ok(O.isSome(final), "the caller's node produced a message");
      const parts = contentText(final.value.content).split("|");
      expect(parts.map((part) => part.split(":")[0])).toEqual([
        "caller",
        "worker",
        "grand",
      ]);
      const pids = parts.map((part) => Number(part.split(":")[1]));
      expect(new Set(pids).size).toBe(3);
      for (const pid of pids)
        expect(Number.isInteger(pid) && pid > 0).toBe(true);

      // Graph close joins members before releasing the final collection hold.
      await outer.graph.close().finally(forgetOuter);
      expect(caller.status).toBe("closed");
      expect(outer.graph.signal.aborted).toBe(true);
      await assert.rejects(shared.mux.validateCwd(seed));
    }),
  60_000,
);
