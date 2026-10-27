// Both JuncoAgent factories with real MCP stdio servers on one shared ToolCollection, over a
// CopyTree seed of the test-fs addon. The model is Pi's faux provider; the servers are the
// junco-mcp fixture, launched natively.

import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { McpAbortError, McpClient } from "@earendil-works/pi-mcp";
import {
  getJuncoMcpToolIdentity,
  type JuncoMcpConnection,
  type JuncoMcpConnectOptions,
  JuncoMcpTools,
} from "junco-mcp";
import { LockPolicy, type NativeModule, ToolCollection, TaskTool } from "junco-tools";
import { errorGraph, isMarshPolicyDenied } from "junco-tools/errors";
import * as testAddon from "../../../junco-tools/target/native-test/index.js";
import { JuncoAgent, JuncoAgentError } from "../../src/index.ts";
import { countingTool, settledText } from "../harness.ts";
import { fauxRuntime, scripted, toolTurn } from "../../../../test/support.ts";
import { withNativeCleanup } from "../../../../test/native-support.ts";

const SERVER = fileURLToPath(
  new URL("../../../junco-mcp/test/stdio-server.ts", import.meta.url),
);
const TIMEOUT = 60_000;

const copyTree = {
  ...testAddon,
  NativeMux: { open: testAddon.NativeMux.openCopyTree.bind(testAddon.NativeMux) },
} as unknown as NativeModule;

let root: string;
let seed: string;
let collection: ToolCollection;

beforeAll(async () => {
  root = await mkdtemp(
    fileURLToPath(new URL("../../../junco-tools/target/agent-mcp-", import.meta.url)),
  );
  seed = join(root, "seed");
  // A server cwd below the seed; it must exist before the CopyTree mux opens.
  await mkdir(join(seed, "work"), { recursive: true });
  collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy });
});

afterAll(async () => {
  try {
    await collection?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fixture = (name = "fx", env: Record<string, string> = {}) =>
  JuncoMcpTools.add({
    name,
    type: "stdio",
    command: process.execPath,
    args: [SERVER],
    env,
  });

/** A final reply listing every tool result the model saw, in order. */
const reportResults: FauxResponseStep = (context: Context) =>
  fauxAssistantMessage(
    context.messages
      .flatMap((message) =>
        message.role === "toolResult"
          ? [
              `${message.toolName}:${message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("")}`,
            ]
          : [],
      )
      .join("|"),
  );

function contains(error: unknown, predicate: (error: Error) => boolean): boolean {
  return [...errorGraph(error)].filter((v): v is Error => v instanceof Error).some(predicate);
}

test("create runs an MCP tool beside an ordinary tool", async () => {
  const ordinary = countingTool("ordinary");
  const { models } = await fauxRuntime([
    toolTurn(
      fauxToolCall("mcp__fx__echo", { text: "from mcp" }, { id: "m1" }),
      fauxToolCall("ordinary", {}, { id: "o1" }),
    ),
    reportResults,
  ]);
  const agent = await JuncoAgent.create({
    models,
    provider: "faux",
    model: "faux-1",
    cwd: seed,
    collection,
    tools: [fixture(), ordinary.tool],
    prompt: "go",
  });
  try {
    expect(agent.getTools().map((tool) => tool.name)).toContain("mcp__fx__echo");
    expect(settledText(await agent.next())).toBe("mcp__fx__echo:from mcp|ordinary:ok");
    expect(ordinary.state.executions).toBe(1);
  } finally {
    await agent.return();
  }
}, TIMEOUT);

test("fromResolved accepts a lone definition and several definitions in order", async () => {
  const { models, model } = scripted([
    toolTurn(
      fauxToolCall("mcp__a__echo", { text: "A" }, { id: "a" }),
      fauxToolCall("mcp__b__echo", { text: "B" }, { id: "b" }),
    ),
    reportResults,
  ]);
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  const agent = await JuncoAgent.fromResolved({
    session,
    models,
    model,
    cwd: seed,
    collection,
    tools: [fixture("a"), fixture("b")],
    prompt: "go",
  });
  try {
    const names = agent.getTools().map((tool) => tool.name);
    expect(names.indexOf("mcp__a__echo")).toBeLessThan(names.indexOf("mcp__b__echo"));
    expect(settledText(await agent.next())).toBe("mcp__a__echo:A|mcp__b__echo:B");
  } finally {
    await agent.return();
  }
  const single = await JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model,
    cwd: seed,
    collection,
    tools: fixture("solo"),
  });
  try {
    expect(single.getTools().some((tool) => tool.name === "mcp__solo__echo")).toBe(true);
  } finally {
    await single.return();
  }
}, TIMEOUT);

test("two agents reusing one definition get their own servers; closing one leaves the other working", () =>
  withNativeCleanup(async (defer) => {
    const definition = fixture("shared");
    const responses = (id: string) => [
      toolTurn(fauxToolCall("mcp__shared__read_state", {}, { id })),
      reportResults,
    ];
    const first = await JuncoAgent.create({
      models: (await fauxRuntime(responses("f"))).models,
      provider: "faux",
      model: "faux-1",
      cwd: seed,
      collection,
      tools: [definition],
      prompt: "go",
    });
    const forgetFirst = defer(() => first.return());
    const second = await JuncoAgent.create({
      models: (await fauxRuntime(responses("s"))).models,
      provider: "faux",
      model: "faux-1",
      cwd: seed,
      collection,
      tools: [definition],
      prompt: "go",
    });
    defer(() => second.return());
    const firstPid = JSON.parse(settledText(await first.next()).split(":").slice(1).join(":")).pid;
    await first.return().finally(forgetFirst);
    const secondPid = JSON.parse(
      settledText(await second.next()).split(":").slice(1).join(":"),
    ).pid;
    expect(secondPid).not.toBe(firstPid);
  }), TIMEOUT);

test("a failing source, a name conflict or an unknown active tool closes only that factory's resources", async () => {
  const { models } = await fauxRuntime([]);
  const tracker = trackConnections();
  try {
    // The good definition connects first; the failing one rejects initialization.
    await expect(
      JuncoAgent.create({
        models,
        provider: "faux",
        model: "faux-1",
        cwd: seed,
        collection,
        tools: [fixture("good"), fixture("bad", { JUNCO_MCP_FIXTURE_MODE: "list-failure" })],
      }),
    ).rejects.toThrow('JuncoMcpTools: failed to initialize server "bad"');

    await assert.rejects(
      JuncoAgent.create({
        models,
        provider: "faux",
        model: "faux-1",
        cwd: seed,
        collection,
        tools: [fixture("fx"), countingTool("mcp__fx__echo").tool],
      }),
      (error) => error instanceof JuncoAgentError && /Duplicate tool name/.test(error.message),
    );

    const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
    const { models: resolvedModels, model } = scripted([]);
    await assert.rejects(
      JuncoAgent.fromResolved({
        session,
        models: resolvedModels,
        model,
        cwd: seed,
        collection,
        tools: [fixture("selected")],
        activeToolNames: ["mcp__selected__missing"],
      }),
      (error) => error instanceof JuncoAgentError && /Unknown active tool/.test(error.message),
    );
    await expect(session.beginMutation(BACKGROUND_CONTEXT)).rejects.toThrow();
  } finally {
    tracker.restore();
  }
  // Every connection the failed factories opened was closed: retained tools reject.
  for (const connection of tracker.connections) await expectClosed(connection);
  // The collection still serves a new agent.
  const after = await JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    ...scripted([]),
    cwd: seed,
    collection,
    tools: [fixture("after")],
  });
  await after.return();
}, TIMEOUT);

test("a late Marsh denial surfaces from agent disposal", () =>
  withNativeCleanup(async (defer) => {
    const owner = await JuncoMcpTools.add({
      name: "owner",
      type: "stdio",
      command: process.execPath,
      args: [SERVER],
    }).connect({ cwd: seed, collection });
    const forgetOwner = defer(() => owner.close());
    const writer = owner.tools.find((tool) => tool.name === "mcp__owner__write_file");
    await writer!.execute("own", { path: "agent-owned.txt", content: "first\n" } as never);
    await owner.close().finally(forgetOwner);

    const { models } = await fauxRuntime([
      toolTurn(
        fauxToolCall(
          "mcp__intruder__write_file",
          { path: "agent-owned.txt", content: "stolen\n" },
          { id: "w" },
        ),
      ),
      reportResults,
    ]);
    const agent = await JuncoAgent.create({
      models,
      provider: "faux",
      model: "faux-1",
      cwd: seed,
      collection,
      tools: [fixture("intruder")],
      prompt: "go",
    });
    const forgetAgent = defer(() => agent.return());
    expect(settledText(await agent.next())).toContain("wrote agent-owned.txt");
    const disposal = await agent
      .return()
      .finally(forgetAgent)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(contains(disposal, isMarshPolicyDenied), String(disposal));
    expect(await readFile(join(seed, "agent-owned.txt"), "utf8")).toBe("first\n");
  }), TIMEOUT);

// Subagents (createSubagents) inheriting the caller's registered MCP definitions -----------------

type ServerState = {
  pid: number;
  cwd: string;
  argv: string[];
  marker: string | null;
  calls: number;
};

/** A fromResolved agent over `responses` in the shared seed. */
async function resolvedAgent(
  responses: readonly FauxResponseStep[],
  tools: Parameters<typeof JuncoAgent.fromResolved>[0]["tools"],
  activeToolNames?: string[],
) {
  const { models, model } = scripted(responses);
  return JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model,
    cwd: seed,
    collection,
    tools,
    ...(activeToolNames === undefined ? {} : { activeToolNames }),
  });
}

const toolNamed = (tools: readonly AgentTool[], name: string) =>
  tools.find((tool) => tool.name === name);
const namesOf = (tools: readonly AgentTool[]) => tools.map((tool) => tool.name);

/** Executes `tool` directly with no arguments and returns its text. */
async function callText(tool: AgentTool | undefined): Promise<string> {
  assert.ok(tool, "tool exists");
  const result = await tool.execute("probe", {} as never);
  return contentText(result.content);
}
const readState = async (tool: AgentTool | undefined) =>
  JSON.parse(await callText(tool)) as ServerState;

/** The JSON a {@link reportResults} reply carries for its only tool result. */
const reportedState = (message: AssistantMessage) =>
  JSON.parse(contentText(message.content).split(":").slice(1).join(":")) as ServerState;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Every connection `JuncoMcpTools#connect` returned; `hook` may substitute the definition. */
function trackConnections(
  hook?: (
    index: number,
    source: JuncoMcpTools,
    connect: (source: JuncoMcpTools) => Promise<JuncoMcpConnection>,
  ) => Promise<JuncoMcpConnection>,
) {
  const original = JuncoMcpTools.prototype.connect;
  const connections: JuncoMcpConnection[] = [];
  let attempts = 0;
  JuncoMcpTools.prototype.connect = async function (
    this: JuncoMcpTools,
    options?: JuncoMcpConnectOptions,
  ) {
    const index = attempts++;
    const connect = (source: JuncoMcpTools) => original.call(source, options);
    const connection = await (hook ? hook(index, this, connect) : connect(this));
    connections.push(connection);
    return connection;
  };
  return {
    connections,
    restore() {
      JuncoMcpTools.prototype.connect = original;
    },
  };
}

async function expectClosed(connection: JuncoMcpConnection): Promise<void> {
  assert.ok(connection.tools.length > 0);
  for (const tool of connection.tools) {
    await expect(tool.execute("late", {} as never)).rejects.toThrow();
  }
}

test("a failing native-test scope still closes every resource and keeps the body's error", async () => {
  const owner = await fixture("cleanup").connect({ cwd: seed, collection });
  try {
    const writer = toolNamed(owner.tools, "mcp__cleanup__write_file");
    assert.ok(writer);
    await writer.execute("own", { path: "cleanup-owned.txt", content: "first\n" } as never);
  } finally {
    await owner.close();
  }

  const sentinel = new Error("native test body failed");
  const pids: number[] = [];
  const failure = await withNativeCleanup(async (defer) => {
    const survivor = await fixture("survivor").connect({ cwd: seed, collection });
    defer(() => survivor.close());
    const intruder = await resolvedAgent([], [fixture("intruder")]);
    defer(() => intruder.return());
    pids.push((await readState(toolNamed(survivor.tools, "mcp__survivor__read_state"))).pid);
    const tools = intruder.getTools();
    pids.push((await readState(toolNamed(tools, "mcp__intruder__read_state"))).pid);
    const steal = toolNamed(tools, "mcp__intruder__write_file");
    assert.ok(steal);
    await steal.execute("steal", { path: "cleanup-owned.txt", content: "stolen\n" } as never);
    throw sentinel;
  }).then(
    () => assert.fail("the body's error was lost"),
    (error: unknown) => error,
  );

  assert.ok(failure instanceof AggregateError, String(failure));
  expect(failure.errors[0]).toBe(sentinel);
  expect(failure.cause).toBe(sentinel);
  assert.ok(contains(failure, isMarshPolicyDenied), String(failure));
  expect(pids.length).toBe(2);
  for (const pid of pids) expect(alive(pid)).toBe(false);
  expect(await readFile(join(seed, "cleanup-owned.txt"), "utf8")).toBe("first\n");

  // The same collection still serves a fresh server.
  const fresh = await fixture("fresh").connect({ cwd: seed, collection });
  try {
    const echo = toolNamed(fresh.tools, "mcp__fresh__echo");
    assert.ok(echo);
    const reply = await echo.execute("echo", { text: "after cleanup" } as never);
    expect(contentText(reply.content)).toBe("after cleanup");
  } finally {
    await fresh.close();
  }
}, TIMEOUT);

test("subagents of a lone definition reach their own server with its args, env and cwd", () =>
  withNativeCleanup(async (defer) => {
    const definition = JuncoMcpTools.add({
      name: "solo",
      type: "stdio",
      command: process.execPath,
      args: [SERVER, "--solo-arg"],
      env: { JUNCO_MCP_FIXTURE_MARKER: "solo-marker" },
      cwd: "work",
    });
    const readTurn = (id: string) => [
      toolTurn(fauxToolCall("mcp__solo__read_state", {}, { id })),
      reportResults,
    ];
    const parent = await resolvedAgent([...readTurn("p"), ...readTurn("c")], definition);
    defer(() => parent.return());
    const parentState = reportedState(await parent.prompt("go"));
    const [child] = await parent.createSubagents([{}]);
    defer(() => child!.return());
    expect(namesOf(child!.getTools())).toEqual(namesOf(parent.getTools()));
    const childState = reportedState(await child!.prompt("go"));

    expect(childState.pid).not.toBe(parentState.pid);
    for (const state of [parentState, childState]) {
      expect(state.marker).toBe("solo-marker");
      expect(state.argv).toEqual(["--solo-arg"]);
      expect(state.cwd.endsWith(`${sep}work`)).toBe(true);
    }
  }), TIMEOUT);

test("subagents of a mixed list share ordinary tools and reconnect every definition", () =>
  withNativeCleanup(async (defer) => {
    const ordinary = countingTool("ordinary");
    const task = new TaskTool();
    const { models } = await fauxRuntime([
      toolTurn(
        fauxToolCall("mcp__b__read_state", {}, { id: "b" }),
        fauxToolCall("ordinary", {}, { id: "o" }),
      ),
      reportResults,
    ]);
    const parent = await JuncoAgent.create({
      models,
      provider: "faux",
      model: "faux-1",
      cwd: seed,
      collection,
      tools: [
        task,
        ordinary.tool,
        fixture("a", { JUNCO_MCP_FIXTURE_MARKER: "A" }),
        fixture("b", { JUNCO_MCP_FIXTURE_MARKER: "B" }),
      ],
    });
    defer(() => parent.return());
    const children = await parent.createSubagents([{}, {}]);
    for (const child of children) defer(() => child.return());

    const pids: number[] = [];
    for (const agent of [parent, ...children]) {
      const tools = agent.getTools();
      expect(namesOf(tools)).toEqual(namesOf(parent.getTools()));
      expect(tools).toContain(ordinary.tool);
      expect(TaskTool.is(toolNamed(tools, "task")!)).toBe(true);
      const a = await readState(toolNamed(tools, "mcp__a__read_state"));
      const b = await readState(toolNamed(tools, "mcp__b__read_state"));
      expect([a.marker, b.marker]).toEqual(["A", "B"]);
      pids.push(a.pid, b.pid);
    }
    expect(new Set(pids).size).toBe(6);

    // The model's call goes through the second child's own server, beside the shared tool.
    const second = children[1]!;
    const reply = contentText((await second.prompt("go")).content);
    expect(reply).toContain("|ordinary:ok");
    const viaModel = JSON.parse(reply.split("|")[0]!.split(":").slice(1).join(":"));
    expect(viaModel.pid).toBe(pids[5]);
    expect(ordinary.state.executions).toBe(1);
  }), TIMEOUT);

test("a tool subset only narrows inherited MCP capabilities", () =>
  withNativeCleanup(async (defer) => {
    const definition = fixture("fx");
    const parent = await resolvedAgent(
      [
        // `none` tries a tool it was not given; `inherit` tries one its caller had inactive.
        toolTurn(fauxToolCall("mcp__fx__read_state", {}, { id: "n" })),
        reportResults,
        toolTurn(fauxToolCall("mcp__fx__echo", { text: "x" }, { id: "e" })),
        reportResults,
      ],
      [new TaskTool(), definition],
      ["task", "mcp__fx__read_state"],
    );
    defer(() => parent.return());
    const tracker = trackConnections();
    try {
      for (const batch of [[{ tools: ["mcp__fx__echo"] }], [{}, { tools: ["mcp__fx__echo"] }]]) {
        await assert.rejects(
          parent.createSubagents(batch),
          (error) =>
            error instanceof JuncoAgentError &&
            error.message.includes("Unknown active tool: mcp__fx__echo"),
        );
      }

      const [inherit, none] = await parent.createSubagents([{}, { tools: [] }]);
      defer(() => inherit!.return());
      defer(() => none!.return());
      expect(namesOf(inherit!.getTools())).toEqual(["task", "mcp__fx__read_state", "complain", "release"]);
      expect(namesOf(inherit!.getActiveTools())).toEqual([
        "task",
        "mcp__fx__read_state",
        "complain",
        "release",
      ]);
      expect(namesOf(none!.getTools())).toEqual(["complain", "release"]);

      // Neither model call reaches a server: each child's server counts only the probe.
      await none!.prompt("go");
      await inherit!.prompt("go");
      const [inheritServer, noneServer] = tracker.connections.map((connection) =>
        toolNamed(connection.tools, "mcp__fx__read_state"),
      );
      expect((await readState(noneServer)).calls).toBe(1);
      expect((await readState(inheritServer)).calls).toBe(1);

      // A server added to the caller's definition later is connected by a later batch, not exposed.
      definition.add({
        name: "extra",
        type: "stdio",
        command: process.execPath,
        args: [SERVER],
      });
      const inherited = ["task", "mcp__fx__read_state", "complain", "release"];
      expect(namesOf(inherit!.getTools())).toEqual(inherited);
      const [later] = await parent.createSubagents([{}]);
      defer(() => later!.return());
      expect(namesOf(later!.getTools())).toEqual(inherited);
    } finally {
      tracker.restore();
    }
  }), TIMEOUT);

test("one batch inherits one definition snapshot; later batches see later changes, grandchildren keep theirs", () =>
  withNativeCleanup(async (defer) => {
    const env: Record<string, string> = { JUNCO_MCP_FIXTURE_MARKER: "before" };
    const definition = JuncoMcpTools.add({
      name: "snap",
      type: "stdio",
      command: process.execPath,
      args: [SERVER],
      env,
    });
    const parent = await resolvedAgent([], definition);
    defer(() => parent.return());
    // The original declaration changes while the batch's first child is connecting.
    const tracker = trackConnections(async (index, source, connect) => {
      if (index === 0) {
        env.JUNCO_MCP_FIXTURE_MARKER = "after";
        definition.add({ name: "late", type: "stdio", command: process.execPath, args: [SERVER] });
      }
      return connect(source);
    });
    const marker = async (agent: { getTools(): AgentTool[] }) =>
      (await readState(toolNamed(agent.getTools(), "mcp__snap__read_state"))).marker;
    try {
      const batch = await parent.createSubagents([{}, {}]);
      for (const child of batch) defer(() => child.return());
      expect(await Promise.all(batch.map(marker))).toEqual(["before", "before"]);

      const [grandchild] = await batch[0]!.createSubagents([{}]);
      defer(() => grandchild!.return());
      expect(await marker(grandchild!)).toBe("before");

      const [later] = await parent.createSubagents([{}]);
      defer(() => later!.return());
      expect(await marker(later!)).toBe("after");
      expect(namesOf(later!.getTools())).toEqual(namesOf(parent.getTools()));
      expect(await marker(parent)).toBe("before");
    } finally {
      tracker.restore();
    }
  }), TIMEOUT);

test("a child keeps its own server after its parent closes; closing the child stops it", () =>
  withNativeCleanup(async (defer) => {
    const parent = await resolvedAgent([], [fixture("life")]);
    const forgetParent = defer(() => parent.return());
    const parentTool = toolNamed(parent.getTools(), "mcp__life__read_state");
    const parentPid = (await readState(parentTool)).pid;
    const [child] = await parent.createSubagents([{}]);
    const forgetChild = defer(() => child!.return());
    const childTool = toolNamed(child!.getTools(), "mcp__life__read_state");

    await parent.return().finally(forgetParent);
    expect(alive(parentPid)).toBe(false);
    await expect(parentTool!.execute("late", {} as never)).rejects.toThrow();
    const childPid = (await readState(childTool)).pid;
    expect(childPid).not.toBe(parentPid);
    expect(alive(childPid)).toBe(true);

    await child!.return().finally(forgetChild);
    await expect(childTool!.execute("late", {} as never)).rejects.toThrow();
    expect(alive(childPid)).toBe(false);
  }), TIMEOUT);

test("a failing later child connection closes every new sibling and connection, not the caller", () =>
  withNativeCleanup(async (defer) => {
    const parent = await resolvedAgent([], [fixture("good"), fixture("second")]);
    defer(() => parent.return());
    // The second child's second server fails discovery.
    const tracker = trackConnections((index, source, connect) =>
      connect(index === 3 ? fixture("second", { JUNCO_MCP_FIXTURE_MODE: "list-failure" }) : source),
    );
    try {
      await expect(parent.createSubagents([{}, {}])).rejects.toThrow(
        'JuncoMcpTools: failed to initialize server "second"',
      );
      for (const connection of tracker.connections) await expectClosed(connection);
      for (const name of ["mcp__good__read_state", "mcp__second__read_state"]) {
        expect(typeof (await readState(toolNamed(parent.getTools(), name))).pid).toBe("number");
      }
    } finally {
      tracker.restore();
    }
  }), TIMEOUT);

test("aborting admission cancels child acquisition; returned children ignore a later abort", () =>
  withNativeCleanup(async (defer) => {
    const parent = await resolvedAgent([], [fixture("gate")]);
    defer(() => parent.return());
    const tracker = trackConnections();
    const listTools = McpClient.prototype.listTools;
    try {
      await assert.rejects(parent.createSubagents([{}], AbortSignal.abort()));

      // Abort exactly when the second child's server is asked for its tools.
      const controller = new AbortController();
      let lists = 0;
      McpClient.prototype.listTools = function (this: McpClient, ...args) {
        if (++lists === 2) controller.abort();
        return listTools.apply(this, args);
      };
      const failure = await parent.createSubagents([{}, {}], controller.signal).then(
        () => assert.fail("admission was not cancelled"),
        (error: unknown) => error,
      );
      McpClient.prototype.listTools = listTools;
      assert.ok(contains(failure, (error) => error instanceof McpAbortError), String(failure));
      await expectClosed(tracker.connections[0]!);
      expect(
        typeof (await readState(toolNamed(parent.getTools(), "mcp__gate__read_state"))).pid,
      ).toBe("number");

      const admission = new AbortController();
      const [child] = await parent.createSubagents([{}], admission.signal);
      defer(() => child!.return());
      admission.abort();
      expect(
        typeof (await readState(toolNamed(child!.getTools(), "mcp__gate__read_state"))).pid,
      ).toBe("number");
    } finally {
      McpClient.prototype.listTools = listTools;
      tracker.restore();
    }
  }), TIMEOUT);

test("subagents rebind MCP tools by original identity, not by published name", () =>
  withNativeCleanup(async (defer) => {
    const env: Record<string, string> = { JUNCO_MCP_FIXTURE_MODE: "alias-dash" };
    const definition = JuncoMcpTools.add({
      name: "al",
      type: "stdio",
      command: process.execPath,
      args: [SERVER],
      env,
    });
    const parent = await resolvedAgent([], definition);
    defer(() => parent.return());
    const tracker = trackConnections();
    const aliases = (tools: readonly AgentTool[]) =>
      tools.filter((tool) =>
        ["a-b", "a_b"].includes(getJuncoMcpToolIdentity(tool)?.originalToolName ?? ""),
      );
    try {
      const parentAlias = toolNamed(parent.getTools(), "mcp__al__a_b");
      expect(await callText(parentAlias)).toBe("a-b");

      // `a-b` disappears; a different `a_b` now publishes the identical name.
      env.JUNCO_MCP_FIXTURE_MODE = "alias-underscore";
      await assert.rejects(
        parent.createSubagents([{}]),
        (error) =>
          error instanceof JuncoAgentError &&
          error.message === "Inherited MCP tool unavailable: mcp__al__a_b",
      );
      await expectClosed(tracker.connections[0]!);

      // Both exist and collide: the child gets `a-b` under its new published name, and never `a_b`.
      env.JUNCO_MCP_FIXTURE_MODE = "alias-both";
      const [child] = await parent.createSubagents([{}]);
      defer(() => child!.return());
      const [alias, ...others] = aliases(child!.getTools());
      expect(others).toEqual([]);
      expect(getJuncoMcpToolIdentity(alias!)?.originalToolName).toBe("a-b");
      expect(alias!.name).not.toBe("mcp__al__a_b");
      expect(toolNamed(child!.getTools(), "mcp__al__a_b")).toBeUndefined();
      expect(await callText(alias)).toBe("a-b");
      expect(child!.getTools().length).toBe(parent.getTools().length);
      expect(await callText(parentAlias)).toBe("a-b");
    } finally {
      tracker.restore();
    }
  }), TIMEOUT);
