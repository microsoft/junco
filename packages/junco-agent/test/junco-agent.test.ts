import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentMessage,
  type AgentTool,
  awaitWithContext,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type Session,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type ImageContent,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  EdgeId,
  isUsageLimitError,
  runWithUsageBudgets,
  UsageBudget,
  type UsageLimitError,
} from "dataflow-engine";
import {
  issueLog,
  type ProfileEvent,
  type ProfileRecorder,
  profileContexts,
  RecvTool,
  SendTool,
  YieldTool,
} from "junco-tools";
import { errorGraph, MARSH_POLICY_DENIED } from "junco-tools/errors";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { userTexts } from "../../../test/deterministic-support.ts";
import {
  fauxRuntime,
  flushMacrotasks,
  NATIVE_TOOL_BLOCK,
  scripted,
  toolTurn,
} from "../../../test/support.ts";
import {
  AgenticInputSchema,
  type AgenticStep,
  AssistantMessageSchema,
  JuncoAgent,
  JuncoAgentError,
  SYSTEM_INSTRUCTION,
  type TokenMonitorConfig,
} from "../src/index.ts";
import {
  assertTools,
  countingTool,
  isCode,
  nativeOptions,
  newAgent,
  settledText,
  step,
} from "./harness.ts";

const TIMEOUT = 5_000;
const yieldCall = (reason: string, id: string) =>
  fauxToolCall("yield", { reason }, { id });
test("the caller's tools remain inspectable and active selection governs execution", async () => {
  const first = countingTool("first");
  const second = countingTool("second");
  const { agent } = await newAgent(
    [
      toolTurn(fauxToolCall("second", {}, { id: "s1" })),
      fauxAssistantMessage("done"),
    ],
    {
      tools: [first.tool, second.tool],
      activeToolNames: ["first"],
    },
  );
  try {
    assert.ok(agent.getTools().includes(first.tool));
    assert.ok(agent.getTools().includes(second.tool));
    assertTools(agent.getActiveTools(), [first.tool]);
    await agent.setActiveTools(["second"]);
    assertTools(agent.getActiveTools(), [second.tool]);
    assert.equal((await agent.prompt("go")).stopReason, "stop");
    assert.equal(first.state.executions, 0);
    assert.equal(second.state.executions, 1);
    assert.equal(settledText(await agent.next()), "done");
  } finally {
    await agent.return();
  }
});

test("the same yield tool is isolated between agents, and a later prompt retains session history", async () => {
  const shared = new YieldTool();
  const history: string[][] = [];
  const first = await newAgent(
    [
      toolTurn(yieldCall("mine", "y1")),
      fauxAssistantMessage("first done"),
      (context) => {
        history.push(userTexts(context.messages));
        return fauxAssistantMessage("later");
      },
    ],
    { tools: [shared], prompt: "first" },
  );
  const second = await newAgent(
    [toolTurn(yieldCall("theirs", "y2")), fauxAssistantMessage("second done")],
    {
      tools: [shared],
      prompt: "second",
    },
  );
  try {
    assert.deepEqual(step(await first.agent.next()), {
      kind: "yield",
      reasons: [
        { kind: "tool", toolCallId: "y1", toolName: "yield", reason: "mine" },
      ],
    });
    assert.deepEqual(step(await second.agent.next()), {
      kind: "yield",
      reasons: [
        { kind: "tool", toolCallId: "y2", toolName: "yield", reason: "theirs" },
      ],
    });
    assert.equal(settledText(await second.agent.next()), "second done");
    assert.equal(first.agent.status, "suspended");
    assert.equal(settledText(await first.agent.next()), "first done");
    assert.equal((await first.agent.prompt("again")).stopReason, "stop");
    assert.equal(settledText(await first.agent.next()), "later");
    assert.deepEqual(history, [["first", "again"]]);
  } finally {
    await Promise.all([first.agent.return(), second.agent.return()]);
  }
});

test("a staged prompt starts only on demand and blocks an explicit overlapping prompt", async () => {
  const { faux, agent } = await newAgent(
    [fauxAssistantMessage("staged done")],
    { prompt: "staged" },
  );
  try {
    assert.equal(agent.status, "ready");
    await assert.rejects(agent.prompt("explicit"), isCode("busy"));
    await flushMacrotasks();
    assert.equal(faux.state.callCount, 0);
    assert.equal(settledText(await agent.next()), "staged done");
    assert.equal(agent.status, "idle");
  } finally {
    await agent.return();
  }
});

test("a callback prompt runs once on demand with the supplied view and static images", async () => {
  const image = { type: "image" as const, data: "aW1n", mimeType: "image/png" };
  const view = { messages: new Map(), values: new Map() };
  const seen: unknown[] = [];
  let sent: Context["messages"] = [];
  const { faux, agent } = await newAgent(
    [
      (context) => {
        sent = context.messages;
        return fauxAssistantMessage("done");
      },
    ],
    {
      images: [image],
      prompt: (inputs) => {
        seen.push(inputs);
        return "from view";
      },
    },
  );
  try {
    assert.equal(agent.status, "ready");
    await flushMacrotasks();
    assert.equal(seen.length, 0);
    assert.equal(faux.state.callCount, 0);
    assert.equal(settledText(await agent.next(view)), "done");
    assert.equal(seen.length, 1);
    assert.equal(seen[0], view);
    assert.deepEqual(userTexts(sent), ["from view"]);
    const user = sent.find((message) => message.role === "user");
    assert.ok(user !== undefined && typeof user.content !== "string");
    assert.deepEqual(
      user.content.filter((block) => block.type === "image"),
      [image],
    );
    assert.equal(agent.status, "idle");
    let extra = false;
    const waiting = agent.next(view).then((result) => {
      extra = true;
      return result;
    });
    await flushMacrotasks();
    assert.equal(extra, false);
    await agent.return();
    assert.deepEqual(await waiting, { value: undefined, done: true });
    assert.equal(seen.length, 1);
    assert.equal(faux.state.callCount, 1);
  } finally {
    await agent.return();
  }
});

test("AgenticInputSchema and AssistantMessageSchema check the native payloads they describe", async () => {
  for (const input of [
    { kind: "prompt", text: "hi" },
    {
      kind: "error",
      text: "x",
      images: [{ type: "image", data: "d", mimeType: "image/png" }],
    },
    { kind: "appendMessage", message: { role: "custom", extra: 1 } },
  ])
    assert.equal(Value.Check(AgenticInputSchema, input), true);
  for (const input of [
    7,
    { kind: "prompt" },
    { kind: "nope", text: "x" },
    {
      kind: "steer",
      text: "x",
      images: [{ type: "file", data: "d", mimeType: "m" }],
    },
    { kind: "appendMessage", message: { content: "no role" } },
  ])
    assert.equal(Value.Check(AgenticInputSchema, input), false);
  const { agent } = await newAgent([fauxAssistantMessage("native")]);
  try {
    const message = await agent.prompt("go");
    assert.equal(Value.Check(AssistantMessageSchema, message), true);
    assert.equal(
      Value.Check(AssistantMessageSchema, { ...message, stopReason: "done" }),
      false,
    );
    const { usage: _usage, ...withoutUsage } = message;
    assert.equal(Value.Check(AssistantMessageSchema, withoutUsage), false);
  } finally {
    await agent.return();
  }
});

test("shared send/recv tools advertise each bound activation's live edge schemas", async () => {
  const send = new SendTool();
  const recv = new RecvTool();
  const unboundParameters = send.parameters;
  const unboundDescription = recv.description;
  const requests: { send: unknown; recv: unknown }[] = [];
  const capture = (context: Context) => {
    const tools = getCurrentTools(context.messages);
    requests.push({
      send: tools.find(({ name }) => name === "send")?.parameters,
      recv: tools.find(({ name }) => name === "recv")?.description,
    });
    return fauxAssistantMessage("done");
  };
  const route = (id: string, schema: TSchema) =>
    [EdgeId.create(id), schema] as const;
  let outbound = route("numbers", Type.Number());
  const numeric = {
    view: { messages: new Map(), values: new Map() },
    get sendParameters() {
      return SendTool.parametersFor([outbound]);
    },
    recvOutputSchema: RecvTool.outputSchemaFor(
      [route("numbers-in", Type.Number())],
      [],
    ),
    consume() {},
    send() {},
    info: () => ({ children: [], parents: [] }),
  };
  const text = {
    ...numeric,
    sendParameters: SendTool.parametersFor([route("texts", Type.String())]),
    recvOutputSchema: RecvTool.outputSchemaFor(
      [],
      [route("texts-in", Type.String())],
    ),
  };
  const a = await newAgent([capture, capture], { tools: [send, recv] });
  const b = await newAgent([capture, capture], { tools: [send, recv] });
  try {
    await a.agent.runWithNodeContext({ messaging: numeric }, () =>
      a.agent.prompt("first"),
    );
    await b.agent.runWithNodeContext({ messaging: text }, () =>
      b.agent.prompt("second"),
    );
    // A route added after an activation is visible to the next request without reinstalling tools.
    outbound = route("later", Type.Boolean());
    await a.agent.runWithNodeContext({ messaging: numeric }, () =>
      a.agent.prompt("third"),
    );
    await b.agent.prompt("unbound");
    const checks = (schema: unknown, id: string, payloads: unknown[]) =>
      payloads.map((payload) =>
        Value.Check(schema as TSchema, { id, payload }),
      );
    assert.deepEqual(checks(requests[0]?.send, "numbers", [7, "7"]), [
      true,
      false,
    ]);
    assert.deepEqual(checks(requests[1]?.send, "texts", [7, "7"]), [
      false,
      true,
    ]);
    assert.deepEqual(checks(requests[2]?.send, "later", [true, 7]), [
      true,
      false,
    ]);
    assert.deepEqual(checks(requests[2]?.send, "numbers", [7]), [false]);
    assert.deepEqual(requests[3]?.send, unboundParameters);
    assert.equal(
      requests[0]?.recv,
      RecvTool.describe(numeric.recvOutputSchema),
    );
    assert.equal(requests[1]?.recv, RecvTool.describe(text.recvOutputSchema));
    assert.equal(requests[3]?.recv, unboundDescription);
    // The shared originals keep their own schemas and identities.
    assert.equal(send.parameters, unboundParameters);
    assert.equal(recv.description, unboundDescription);
    assert.ok(a.agent.getTools().includes(send));
    assert.ok(b.agent.getActiveTools().includes(recv));
  } finally {
    await a.agent.return();
    await b.agent.return();
  }
});

test("a callback prompt without inputs fails invalid_state; a later string stage recovers", async () => {
  let calls = 0;
  const history: string[][] = [];
  const { faux, agent } = await newAgent(
    [
      (context) => {
        history.push(userTexts(context.messages));
        return fauxAssistantMessage("recovered done");
      },
    ],
    {
      prompt: () => {
        calls++;
        return "unused";
      },
    },
  );
  try {
    const failure = step(await agent.next());
    assert.equal(failure.kind, "failed");
    assert.ok(
      isCode("invalid_state")(failure.kind === "failed" && failure.error),
    );
    assert.equal(calls, 0);
    assert.equal(faux.state.callCount, 0);
    assert.equal(agent.status, "idle");
    agent.stagePrompt("recovered");
    assert.equal(settledText(await agent.next()), "recovered done");
    assert.deepEqual(history, [["recovered"]]);
  } finally {
    await agent.return();
  }
});

test("callback throws and non-string returns fail before any request", async () => {
  const view = { messages: new Map(), values: new Map() };
  const cause = new Error("cause");
  const { faux, agent } = await newAgent([fauxAssistantMessage("after")], {
    prompt: () => {
      throw cause;
    },
  });
  try {
    const thrown = step(await agent.next(view));
    assert.ok(thrown.kind === "failed" && thrown.error === cause);
    for (const bad of [() => 42, async () => "promised"]) {
      agent.stagePrompt(bad as unknown as () => string);
      const failure = step(await agent.next(view));
      assert.ok(
        failure.kind === "failed" && isCode("invalid_argument")(failure.error),
      );
    }
    assert.equal(faux.state.callCount, 0);
    agent.stagePrompt("works");
    assert.equal(settledText(await agent.next()), "after");
  } finally {
    await agent.return();
  }
});

test("stagePrompt is busy while staged, suspended or awaited, and closed after return", async () => {
  let other = 0;
  const otherCallback = () => {
    other++;
    return "other";
  };
  const { agent } = await newAgent(
    [
      toolTurn(yieldCall("hold", "y1")),
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
    ],
    { tools: [new YieldTool()], prompt: "original" },
  );
  try {
    assert.throws(() => agent.stagePrompt(otherCallback), isCode("busy"));
    await assert.rejects(agent.prompt("explicit"), isCode("busy"));
    assert.equal(agent.status, "ready");
    assert.equal(step(await agent.next()).kind, "yield");
    assert.throws(() => agent.stagePrompt("suspended"), isCode("busy"));
    assert.equal(settledText(await agent.next()), "first");
    agent.stagePrompt("round two");
    assert.equal(settledText(await agent.next()), "second");
    assert.equal(other, 0);
    const queued = agent.next();
    await flushMacrotasks();
    assert.throws(() => agent.stagePrompt("queued"), isCode("busy"));
    await agent.return();
    assert.deepEqual(await queued, { value: undefined, done: true });
    assert.throws(() => agent.stagePrompt("closed"), isCode("closed"));
  } finally {
    await agent.return();
  }
});

test("turn_end subscribers see the full successful yield result before the next request is gated", async () => {
  const { faux, agent } = await newAgent(
    [toolTurn(yieldCall("review", "y1")), fauxAssistantMessage("resumed")],
    { tools: [new YieldTool()], prompt: "go" },
  );
  const turns: { ids: string[]; errors: boolean[] }[] = [];
  agent.events.on("turn_end", ({ toolResults }) => {
    turns.push({
      ids: toolResults.map((result) => result.toolCallId),
      errors: toolResults.map((result) => result.isError),
    });
  });
  try {
    const paused = step(await agent.next());
    assert.deepEqual(paused, {
      kind: "yield",
      reasons: [
        { kind: "tool", toolCallId: "y1", toolName: "yield", reason: "review" },
      ],
    });
    assert.deepEqual(turns[0], { ids: ["y1"], errors: [false] });
    await flushMacrotasks();
    assert.equal(faux.state.callCount, 1);
    assert.equal(agent.status, "suspended");
    assert.equal(settledText(await agent.next()), "resumed");
    assert.equal(faux.state.callCount, 2);
  } finally {
    await agent.return();
  }
});

test(
  "all mutating tools finish sequentially; policy denial and two yields retain source order",
  async () => {
    const denial = Object.assign(new Error("not permitted"), {
      code: MARSH_POLICY_DENIED,
    });
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const mutate: AgentTool = {
      name: "mutate",
      label: "mutate",
      description: "mutates a file",
      parameters: Type.Object({}),
      execute: async () => {
        order.push("mutate:start");
        started.resolve();
        await release.promise;
        order.push("mutate:end");
        return {
          content: [{ type: "text", text: "updated" }],
          details: undefined,
        };
      },
    };
    const deny: AgentTool = {
      name: "deny",
      label: "deny",
      description: "denied by policy",
      parameters: Type.Object({}),
      execute: async () => {
        order.push("deny");
        throw denial;
      },
    };
    const { faux, agent } = await newAgent(
      [
        toolTurn(
          fauxToolCall("mutate", {}, { id: "m1" }),
          fauxToolCall("deny", {}, { id: "d1" }),
          yieldCall("first", "y1"),
          yieldCall("second", "y2"),
        ),
        fauxAssistantMessage("after batch"),
      ],
      { tools: [mutate, deny, new YieldTool()], prompt: "go" },
    );
    const ended: string[][] = [];
    agent.events.on("turn_end", ({ toolResults }) =>
      ended.push(toolResults.map((result) => result.toolCallId)),
    );
    try {
      const pending = agent.next();
      await started.promise;
      await flushMacrotasks();
      assert.deepEqual(order, ["mutate:start"]);
      release.resolve();
      assert.deepEqual(step(await pending), {
        kind: "yield",
        reasons: [
          {
            kind: "policy",
            toolCallId: "d1",
            toolName: "deny",
            reason: denial.message,
          },
          {
            kind: "tool",
            toolCallId: "y1",
            toolName: "yield",
            reason: "first",
          },
          {
            kind: "tool",
            toolCallId: "y2",
            toolName: "yield",
            reason: "second",
          },
        ],
      });
      assert.deepEqual(order, ["mutate:start", "mutate:end", "deny"]);
      assert.deepEqual(ended[0], ["m1", "d1", "y1", "y2"]);
      assert.equal(faux.state.callCount, 1);
      assert.equal(settledText(await agent.next()), "after batch");
    } finally {
      release.resolve();
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "sequential mutation tools mutate a file in source order without overlap",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "junco-agent-serial-"));
    const file = join(directory, "state.txt");
    const started: string[] = [];
    const firstStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const edit: AgentTool = {
      name: "first_mutation",
      label: "first_mutation",
      description: "first file mutation",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        started.push("first_mutation");
        await writeFile(file, "first");
        firstStarted.resolve();
        await release.promise;
        await writeFile(file, "first complete");
        return {
          content: [{ type: "text", text: "edited" }],
          details: undefined,
        };
      },
    };
    const astEdit: AgentTool = {
      name: "dependent_mutation",
      label: "dependent_mutation",
      description: "dependent file mutation",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        started.push("dependent_mutation");
        const previous = await readFile(file, "utf8");
        if (previous !== "first complete")
          throw new Error(`Overlapping edits saw ${previous}`);
        await writeFile(file, `${previous} + second`);
        return {
          content: [{ type: "text", text: "updated" }],
          details: undefined,
        };
      },
    };
    const { agent } = await newAgent(
      [
        toolTurn(
          fauxToolCall("first_mutation", {}, { id: "e1" }),
          fauxToolCall("dependent_mutation", {}, { id: "a1" }),
        ),
        (context) => {
          const results = context.messages.filter(
            (message) => message.role === "toolResult",
          );
          return fauxAssistantMessage(
            results.length === 2 && results.every((result) => !result.isError)
              ? "finished"
              : "mutation failed",
          );
        },
      ],
      { tools: [edit, astEdit] },
    );
    try {
      const prompt = agent.prompt("apply both edits");
      await firstStarted.promise;
      await flushMacrotasks();
      assert.deepEqual(started, ["first_mutation"]);
      release.resolve();
      assert.equal((await prompt).content[0]?.type, "text");
      assert.equal(settledText(await agent.next()), "finished");
      assert.deepEqual(started, ["first_mutation", "dependent_mutation"]);
      assert.equal(await readFile(file, "utf8"), "first complete + second");
    } finally {
      release.resolve();
      try {
        await agent.return();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  TIMEOUT,
);

test("a failed or spoofed yield never pauses the provider", async () => {
  const fake = countingTool("yield");
  const { agent: spoofed } = await newAgent(
    [toolTurn(yieldCall("pretend", "y1")), fauxAssistantMessage("continued")],
    { prompt: "go" },
  );
  await spoofed.setTools([fake.tool], ["yield"]);
  const { agent: blocked } = await newAgent(
    [toolTurn(yieldCall("denied", "y2")), fauxAssistantMessage("continued")],
    { tools: [new YieldTool()], prompt: "go" },
  );
  blocked.hooks.on("before_tool", ({ toolName }) =>
    toolName === "yield" ? { block: { reason: "denied" } } : undefined,
  );
  try {
    assert.equal(settledText(await spoofed.next()), "continued");
    assert.equal(fake.state.executions, 1);
    assert.equal(settledText(await blocked.next()), "continued");
  } finally {
    await Promise.all([spoofed.return(), blocked.return()]);
  }
});

test("an overlapping prompt is busy even while admission is pending; later prompts proceed", async () => {
  const { faux, agent } = await newAgent([
    fauxAssistantMessage("one"),
    fauxAssistantMessage("two"),
  ]);
  try {
    const first = agent.prompt("one");
    await assert.rejects(agent.prompt("overlap"), isCode("busy"));
    assert.equal((await first).stopReason, "stop");
    assert.equal(settledText(await agent.next()), "one");
    assert.equal((await agent.prompt("two")).stopReason, "stop");
    assert.equal(settledText(await agent.next()), "two");
    assert.equal(faux.state.callCount, 2);
  } finally {
    await agent.return();
  }
});

test("duplicate and unknown active tools are rejected without changing the usable configuration", async () => {
  const first = countingTool("first");
  const second = countingTool("second");
  const { models, model } = scripted([]);
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  await assert.rejects(
    JuncoAgent.fromResolved({
      session,
      models,
      model,
      tool_block: NATIVE_TOOL_BLOCK,
      tools: [first.tool],
      activeToolNames: ["first", "first"],
    }),
    isCode("invalid_argument"),
  );
  await assert.rejects(
    JuncoAgent.fromResolved({
      session: await repo.create({}, BACKGROUND_CONTEXT),
      models,
      model,
      tool_block: NATIVE_TOOL_BLOCK,
      tools: [first.tool],
      activeToolNames: ["missing"],
    }),
    isCode("invalid_argument"),
  );
  const { agent } = await newAgent([fauxAssistantMessage("ok")], {
    tools: [first.tool, second.tool],
  });
  try {
    for (const names of [["first", "first"], ["missing"]]) {
      await assert.rejects(
        agent.setActiveTools(names),
        isCode("invalid_argument"),
      );
      await assert.rejects(
        agent.setTools([first.tool], names),
        isCode("invalid_argument"),
      );
    }
    assert.ok(agent.getTools().includes(first.tool));
    assert.ok(agent.getTools().includes(second.tool));
    assert.ok(agent.getActiveTools().includes(first.tool));
    assert.ok(agent.getActiveTools().includes(second.tool));
    await agent.setTools([second.tool], ["second"]);
    assertTools(agent.getActiveTools(), [second.tool]);
    assert.equal((await agent.prompt("continue")).stopReason, "stop");
  } finally {
    await agent.return();
  }
});

test("an idle reopened session restores its selected tool without advertising other tools", async () => {
  const one = countingTool("one");
  const two = countingTool("two");
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const { faux, models, model } = scripted([fauxAssistantMessage("first")]);
  const first = await JuncoAgent.fromResolved({
    session,
    models,
    model,
    tool_block: NATIVE_TOOL_BLOCK,
    tools: [one.tool, two.tool],
  });
  try {
    await first.setActiveTools(["two"]);
    assert.equal((await first.prompt("first")).stopReason, "stop");
  } finally {
    await first.return();
  }
  const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
  const requests: string[][] = [];
  faux.setResponses([
    (context) => {
      requests.push(
        context.messages.flatMap((message) =>
          message.role === "system"
            ? (message.toolsAdded?.map((tool) => tool.name) ?? [])
            : [],
        ),
      );
      return toolTurn(fauxToolCall("two", {}, { id: "t2" }));
    },
    (context) => {
      const result = context.messages.findLast(
        (message) => message.role === "toolResult",
      );
      const text = result?.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      return fauxAssistantMessage(
        result && !result.isError && text === "ok"
          ? "reopened via tool"
          : "missing native tool result",
      );
    },
  ]);
  const second = await JuncoAgent.fromResolved({
    session: reopened,
    models,
    model,
    tool_block: NATIVE_TOOL_BLOCK,
    tools: [one.tool, two.tool],
  });
  try {
    assertTools(second.getActiveTools(), [two.tool]);
    assert.equal((await second.prompt("again")).stopReason, "stop");
    assert.equal(settledText(await second.next()), "reopened via tool");
    assert.deepEqual(requests, [["two", "complain"]]);
    assert.equal(one.state.executions, 0);
    assert.equal(two.state.executions, 1);
  } finally {
    await second.return();
  }
});

test("idle abort cancels queued steering and follow-ups without breaking a later prompt", async () => {
  const { agent } = await newAgent([fauxAssistantMessage("still usable")]);
  try {
    await agent.steer("urgent");
    await agent.followUp("later");
    const cleared = await agent.abort();
    assert.deepEqual(userTexts(cleared.clearedSteer), ["urgent"]);
    assert.deepEqual(userTexts(cleared.clearedFollowUp), ["later"]);
    assert.equal((await agent.prompt("new")).stopReason, "stop");
  } finally {
    await agent.return();
  }
});

test(
  "active abort releases a held yield and allows a subsequent run",
  async () => {
    const { agent } = await newAgent(
      [toolTurn(yieldCall("pause", "y1")), fauxAssistantMessage("next")],
      { tools: [new YieldTool()], prompt: "go" },
    );
    try {
      assert.equal(step(await agent.next()).kind, "yield");
      assert.deepEqual(await agent.abort(), {
        clearedSteer: [],
        clearedFollowUp: [],
      });
      const ended = step(await agent.next());
      assert.equal(ended.kind, "settled");
      assert.equal(ended.message.role, "assistant");
      assert.equal((await agent.prompt("again")).stopReason, "stop");
      assert.equal(settledText(await agent.next()), "next");
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "terminal close delivers a final assistant message to a waiting iterator",
  async () => {
    const { agent } = await newAgent(
      [toolTurn(yieldCall("pause", "y1")), fauxAssistantMessage("unused")],
      { tools: [new YieldTool()] },
    );
    try {
      const prompt = agent.prompt("go");
      assert.equal(step(await agent.next()).kind, "yield");
      const waiting = agent.next();
      const closing = agent.return();
      const message = await prompt;
      const observed = step(await waiting);
      assert.equal(observed.kind, "settled");
      if (observed.kind === "settled") assert.equal(observed.message, message);
      await closing;
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "return during an admission held by session mutation stops late work and closes the session",
  async () => {
    const { models, model } = scripted([
      fauxAssistantMessage("must not be used"),
    ]);
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const agent = await JuncoAgent.fromResolved({
      session,
      models,
      model,
      tool_block: NATIVE_TOOL_BLOCK,
    });
    const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
    try {
      const pending = agent.prompt("held").catch((error: unknown) => error);
      await flushMacrotasks();
      const closing = agent.return();
      assert.equal(agent.status, "closed");
      await assert.rejects(agent.prompt("late"), isCode("closed"));
      await mutation.end(BACKGROUND_CONTEXT);
      await closing;
      assert.equal(isCode("closed")(await pending), true);
      assert.deepEqual(await agent.next(), { value: undefined, done: true });
      assert.deepEqual(await agent.return(), { value: undefined, done: true });
      await assert.rejects(session.beginMutation(BACKGROUND_CONTEXT));
    } finally {
      await mutation.end(BACKGROUND_CONTEXT).catch(() => {});
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "closed: every async command rejects closed while close joins and after it completes",
  async () => {
    const { tool } = countingTool("closed_tool");
    const { faux, session, ...native } = await nativeOptions([
      fauxAssistantMessage("must not be used"),
    ]);
    const resources = { skills: [] };
    const agent = await JuncoAgent.fromResolved({
      ...native,
      session,
      tools: [tool],
      resources,
    });
    const commands: (() => Promise<unknown>)[] = [
      () => agent.prompt("x"),
      () => agent.skill("x"),
      () => agent.promptFromTemplate("x"),
      () => agent.steer("x"),
      () => agent.followUp("x"),
      () => agent.nextTurn("x"),
      () => agent.appendMessage(userMessage("x")),
      () => agent.abort(),
      () => agent.setTools([tool]),
      () => agent.setActiveTools([]),
      () => agent.setResources({}),
      () => agent.setModel({ provider: "faux", modelId: "faux-1" }),
      () => agent.getModel(),
      () => agent.setThinkingLevel("off"),
      () => agent.getThinkingLevel(),
      () => agent.setStreamOptions({}),
      () => agent.setSteeringMode("all"),
      () => agent.setFollowUpMode("all"),
      () => agent.context_size(),
      () => agent.compact(),
      () => agent.navigateTree("x"),
    ];
    const assertClosedSurface = async () => {
      for (const command of commands)
        await assert.rejects(command(), isCode("closed"));
      assert.equal(agent.status, "closed");
      const before = issueLog.length;
      assert.throws(
        () =>
          agent.complain({
            nodeId: agent.nodeId,
            messages: [],
            prompt: { messages: [] },
            complaint: "late",
          }),
        isCode("closed"),
      );
      assert.equal(issueLog.length, before);
      assert.ok(agent.getTools().includes(tool));
      assert.ok(agent.getActiveTools().includes(tool));
      assert.equal(agent.getResources(), resources);
    };
    const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
    try {
      let closed = false;
      const closing = agent.return().then((result) => {
        closed = true;
        return result;
      });
      await assertClosedSurface();
      await flushMacrotasks();
      assert.equal(closed, false);
      await mutation.end(BACKGROUND_CONTEXT);
      assert.deepEqual(await closing, { value: undefined, done: true });
      await assertClosedSurface();
      assert.deepEqual(await agent.next(), { value: undefined, done: true });
      assert.deepEqual(await agent.return(), { value: undefined, done: true });
      assert.equal(faux.state.callCount, 0);
    } finally {
      await mutation.end(BACKGROUND_CONTEXT).catch(() => {});
      await agent.return();
    }
  },
  TIMEOUT,
);

test("the resolving factory accepts explicit tools and rejects duplicate tool names", async () => {
  const { models } = await fauxRuntime([fauxAssistantMessage("created")]);
  const agent = await JuncoAgent.create({
    models,
    provider: "faux",
    model: "faux-1",
    tool_block: NATIVE_TOOL_BLOCK,
    tools: [],
    prompt: "go",
  });
  try {
    assert.equal(agent.collection, undefined);
    assert.equal(settledText(await agent.next()), "created");
  } finally {
    await agent.return();
  }
  const duplicate = countingTool("same").tool;
  await assert.rejects(
    JuncoAgent.create({
      models,
      provider: "faux",
      model: "faux-1",
      tool_block: NATIVE_TOOL_BLOCK,
      tools: [duplicate, countingTool("same").tool],
    }),
    isCode("invalid_argument"),
  );
});

test("create rejects an unsupported thinking level before reading credentials", async () => {
  const { faux } = scripted([]);
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  await assert.rejects(
    JuncoAgent.create({
      models,
      provider: "faux",
      model: "faux-1",
      tool_block: NATIVE_TOOL_BLOCK,
      tools: [],
      thinkingLevel: "high",
    }),
    isCode("invalid_argument"),
  );
});

test("create requires the selected provider's saved Pi login and closes a transferred session on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junco-pi-login-"));
  const authPath = join(directory, "auth.json");
  const repo = new MemorySessionRepo();
  try {
    for (const stored of [
      undefined,
      { anthropic: { type: "api_key", key: "unrelated-login" } },
    ]) {
      if (stored !== undefined)
        await writeFile(authPath, JSON.stringify(stored));
      const models = await ModelRuntime.create({
        authPath,
        modelsPath: null,
        refreshOnCreate: false,
      });
      const session = await repo.create({}, BACKGROUND_CONTEXT);
      await assert.rejects(
        JuncoAgent.create({
          models,
          provider: "github-copilot",
          model: "claude-opus-5.5",
          tool_block: NATIVE_TOOL_BLOCK,
          session,
          tools: [],
        }),
        (error: unknown) => {
          assert.ok(error instanceof JuncoAgentError);
          assert.equal(error.code, "invalid_state");
          assert.match(error.message, /github-copilot/);
          assert.match(error.message, /\/login/);
          return true;
        },
      );
      await assert.rejects(session.beginMutation(BACKGROUND_CONTEXT));
    }
  } finally {
    await repo.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("create reuses Pi's saved OAuth login without starting a login flow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junco-pi-login-"));
  const authPath = join(directory, "auth.json");
  let agent: JuncoAgent | undefined;
  try {
    await writeFile(
      authPath,
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          access: "pi-fixture-access",
          refresh: "pi-fixture-refresh",
          expires: Number.MAX_SAFE_INTEGER,
        },
      }),
    );
    const models = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    agent = await JuncoAgent.create({
      models,
      provider: "github-copilot",
      model: "claude-opus-5.5",
      tool_block: NATIVE_TOOL_BLOCK,
      tools: [],
    });
    const selected = await agent.getModel();
    assert.equal(selected?.provider, "github-copilot");
    assert.equal(selected?.id, "claude-opus-5.5");
    assert.equal(
      (await models.getAuth(selected!))?.auth.apiKey,
      "pi-fixture-access",
    );
  } finally {
    await agent?.return();
    await rm(directory, { recursive: true, force: true });
  }
});

test("create rejects an account-unavailable model and closes a transferred session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junco-pi-login-"));
  const authPath = join(directory, "auth.json");
  const repo = new MemorySessionRepo();
  try {
    await writeFile(
      authPath,
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          access: "pi-fixture-access",
          refresh: "pi-fixture-refresh",
          expires: Number.MAX_SAFE_INTEGER,
          availableModelIds: [],
        },
      }),
    );
    const models = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    assert.ok(models.getModel("github-copilot", "claude-opus-5.5"));
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    await assert.rejects(
      JuncoAgent.create({
        models,
        provider: "github-copilot",
        model: "claude-opus-5.5",
        session,
        tool_block: NATIVE_TOOL_BLOCK,
        tools: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof JuncoAgentError);
        assert.equal(error.code, "invalid_argument");
        assert.match(error.message, /github-copilot\/claude-opus-5\.5/);
        return true;
      },
    );
    await assert.rejects(session.beginMutation(BACKGROUND_CONTEXT));
  } finally {
    await repo.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unrefreshable Pi login fails with login guidance before creating an agent", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("github-copilot", async () => ({
    type: "oauth",
    access: "expired-access",
    refresh: "revoked-refresh",
    expires: 0,
  }));
  const models = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const provider = models.getProvider("github-copilot")!;
  models.registerNativeProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...provider.auth.oauth!,
        refresh: async () => {
          throw new Error("Fixture login has been revoked");
        },
      },
    },
  });
  await assert.rejects(
    JuncoAgent.create({
      models,
      provider: "github-copilot",
      model: "claude-opus-5.5",
      tool_block: NATIVE_TOOL_BLOCK,
      tools: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof JuncoAgentError);
      assert.equal(error.code, "invalid_state");
      assert.match(error.message, /\/login/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});

// Context sizing and deferred compaction ---------------------------------------------------------

const COMPACTION = {
  enabled: false,
  reserveTokens: 1024,
  keepRecentTokens: 8,
} as const;
const NO_RETRY = { enabled: false, maxRetries: 0, baseDelayMs: 0 };

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: 1,
});
function assistantMessage(
  text: string,
  totalTokens: number,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

/** Old turns whose usage is far larger than anything a short summary and recent tail can reach. */
async function seedLargeHistory(agent: JuncoAgent): Promise<void> {
  await agent.appendMessage(userMessage("old question ".repeat(20)));
  await agent.appendMessage(assistantMessage("old answer", 90_000));
  await agent.appendMessage(userMessage("recent question"));
  await agent.appendMessage(assistantMessage("recent answer", 90_010));
}

test("context_size: counts committed context only and prefers valid usage", async () => {
  const { agent } = await newAgent([], {
    prompt: "staged text that is never counted",
  });
  try {
    assert.equal(await agent.context_size(), 0);
    await agent.appendMessage(userMessage("abcdefgh"));
    await agent.nextTurn("inbox text that is never counted");
    await agent.followUp("follow-up text that is never counted");
    assert.equal(await agent.context_size(), 2);
    await agent.appendMessage(assistantMessage("reply", 100));
    await agent.appendMessage(userMessage("zzzz"));
    assert.equal(await agent.context_size(), 101);
    for (const stopReason of ["error", "aborted", "deferred"] as const) {
      await agent.appendMessage(assistantMessage("", 5_000, stopReason));
    }
    assert.equal(await agent.context_size(), 101);
  } finally {
    await agent.return();
  }
  await assert.rejects(agent.context_size(), isCode("closed"));
});

test("context_size: navigation to an older entry measures that branch", async () => {
  const { agent } = await newAgent([]);
  const ids: string[] = [];
  agent.events.on("entry_added", ({ entry }) => {
    ids.push(entry.id);
  });
  try {
    await agent.appendMessage(userMessage("abcdefgh"));
    await agent.appendMessage(assistantMessage("reply", 100));
    await agent.appendMessage(userMessage("zzzz"));
    assert.equal(await agent.context_size(), 101);
    assert.ok((await agent.navigateTree(ids[0]!, { summarize: false })).ok);
    assert.equal(await agent.context_size(), 2);
  } finally {
    await agent.return();
  }
});

test("compact: the compacted context replaces retained pre-compaction usage until a new reply", async () => {
  const requests: Context["messages"][] = [];
  const { faux, session, ...native } = await nativeOptions([
    fauxAssistantMessage("short summary"),
    (context) => {
      requests.push(context.messages);
      return fauxAssistantMessage("after compaction");
    },
  ]);
  const agent = await JuncoAgent.fromResolved({
    ...native,
    session,
    compaction: COMPACTION,
  });
  try {
    await seedLargeHistory(agent);
    assert.equal(await agent.context_size(), 90_010);
    assert.equal(await agent.compact(), undefined);
    assert.equal(faux.state.callCount, 1);
    const compacted = await agent.context_size();
    assert.ok(
      compacted > 0 && compacted < 1_000,
      `compacted context measured ${compacted}`,
    );

    const [entry] = await session.findEntries(
      { type: "compaction" },
      BACKGROUND_CONTEXT,
    );
    assert.equal(entry?.type, "compaction");
    if (entry?.type !== "compaction") return;
    assert.equal(entry.summary, "short summary");
    assert.ok(
      entry.retainedTail.some(
        (message) =>
          message.role === "assistant" && message.usage.totalTokens === 90_010,
      ),
    );

    const reply = await agent.prompt("next");
    const sent = userTexts(requests[0]!);
    assert.ok(sent.some((text) => text.includes("short summary")));
    assert.ok(sent.includes("recent question"));
    assert.ok(!sent.some((text) => text.includes("old question")));
    await agent.appendMessage(userMessage("zzzz"));
    assert.equal(await agent.context_size(), reply.usage.totalTokens + 1);
  } finally {
    await agent.return();
  }
});

test(
  "compact: waits for a held yield without aborting it, then emits no boundary of its own",
  async () => {
    const { faux, agent } = await newAgent(
      [
        toolTurn(yieldCall("pause", "y1")),
        fauxAssistantMessage("resumed"),
        fauxAssistantMessage("short summary"),
      ],
      {
        tools: [new YieldTool()],
        prompt: "go ".repeat(64),
        compaction: COMPACTION,
      },
    );
    let compactions = 0;
    agent.events.on("compaction_start", () => {
      compactions++;
    });
    try {
      assert.equal(step(await agent.next()).kind, "yield");
      const before = await agent.context_size();
      const compaction = agent.compact();
      await flushMacrotasks();
      await flushMacrotasks();
      assert.equal(faux.state.callCount, 1);
      assert.equal(compactions, 0);
      assert.equal(agent.status, "suspended");
      assert.equal(settledText(await agent.next()), "resumed");
      assert.equal(await compaction, undefined);
      assert.equal(compactions, 1);
      assert.equal(faux.state.callCount, 3);
      assert.ok((await agent.context_size()) < before);
      let extra = false;
      const waiting = agent.next().then((result) => {
        extra = true;
        return result;
      });
      await flushMacrotasks();
      assert.equal(extra, false);
      await agent.return();
      assert.deepEqual(await waiting, { value: undefined, done: true });
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "compact: a prompt held at admission settles first, and its terminal stays unread",
  async () => {
    let summarized: Context["messages"] = [];
    const { faux, session, ...native } = await nativeOptions([
      fauxAssistantMessage("held reply"),
      (context) => {
        summarized = context.messages;
        return fauxAssistantMessage("short summary");
      },
    ]);
    const agent = await JuncoAgent.fromResolved({
      ...native,
      session,
      compaction: COMPACTION,
    });
    const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
    try {
      const prompt = agent.prompt("held ".repeat(64));
      await flushMacrotasks();
      const compaction = agent.compact();
      await flushMacrotasks();
      assert.equal(faux.state.callCount, 0);
      await mutation.end(BACKGROUND_CONTEXT);
      assert.equal((await prompt).stopReason, "stop");
      assert.equal(await compaction, undefined);
      // The compaction covers the settled reply: summarized or retained.
      const [entry] = await session.findEntries(
        { type: "compaction" },
        BACKGROUND_CONTEXT,
      );
      assert.equal(entry?.type, "compaction");
      if (entry?.type !== "compaction") return;
      assert.ok(
        JSON.stringify([summarized, entry.retainedTail]).includes("held reply"),
      );
      assert.equal(settledText(await agent.next()), "held reply");
    } finally {
      await mutation.end(BACKGROUND_CONTEXT).catch(() => {});
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "compact: FIFO requests are independent; runs and navigation are busy while one is pending",
  async () => {
    const instructions: boolean[] = [];
    const { faux, session, ...native } = await nativeOptions([
      (context) => {
        instructions.push(
          JSON.stringify(context.messages).includes("first focus"),
        );
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "summary failed",
        });
      },
      fauxAssistantMessage("second summary"),
    ]);
    const agent = await JuncoAgent.fromResolved({
      ...native,
      session,
      compaction: COMPACTION,
      retry: NO_RETRY,
    });
    const ids: string[] = [];
    agent.events.on("entry_added", ({ entry }) => {
      ids.push(entry.id);
    });
    try {
      await seedLargeHistory(agent);
      const first = agent.compact({ customInstructions: "first focus" });
      const second = agent.compact();
      await assert.rejects(agent.prompt("late"), isCode("busy"));
      await assert.rejects(agent.skill("late"), isCode("busy"));
      await assert.rejects(agent.promptFromTemplate("late"), isCode("busy"));
      await assert.rejects(
        agent.navigateTree(ids[0]!, { summarize: false }),
        isCode("busy"),
      );
      const failure = await first.then(
        () => assert.fail("first compaction succeeded"),
        (error: unknown) => error,
      );
      assert.ok(isCode("invalid_state")(failure));
      assert.match((failure as Error).message, /summary failed/);
      assert.equal(await second, undefined);
      assert.deepEqual(instructions, [true]);
      assert.equal(faux.state.callCount, 2);
      const entries = await session.findEntries(
        { type: "compaction" },
        BACKGROUND_CONTEXT,
      );
      assert.deepEqual(
        entries.map((entry) =>
          entry.type === "compaction" ? entry.summary : "",
        ),
        ["second summary"],
      );
      assert.ok((await agent.context_size()) < 1_000);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "compact: a staged prompt waits for queued compaction, then starts from its original demand",
  async () => {
    const order: string[] = [];
    const { faux, agent } = await newAgent(
      [
        () => {
          order.push("summary");
          return fauxAssistantMessage("short summary");
        },
        (context) => {
          order.push("staged");
          return fauxAssistantMessage(
            userTexts(context.messages).some((text) =>
              text.includes("short summary"),
            )
              ? "compacted"
              : "uncompacted",
          );
        },
      ],
      { prompt: "staged", compaction: COMPACTION },
    );
    try {
      await seedLargeHistory(agent);
      const compaction = agent.compact();
      const demand = agent.next();
      assert.equal(await compaction, undefined);
      assert.equal(settledText(await demand), "compacted");
      assert.deepEqual(order, ["summary", "staged"]);
      assert.equal(faux.state.callCount, 2);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "compact: return rejects a request queued behind a held prompt without summarizing",
  async () => {
    const { faux, agent } = await newAgent(
      [
        toolTurn(yieldCall("pause", "y1")),
        fauxAssistantMessage("unused"),
        fauxAssistantMessage("unused summary"),
      ],
      { tools: [new YieldTool()], prompt: "go", compaction: COMPACTION },
    );
    try {
      assert.equal(step(await agent.next()).kind, "yield");
      const compaction = agent.compact();
      await flushMacrotasks();
      await agent.return();
      await assert.rejects(compaction, isCode("closed"));
      assert.equal(faux.state.callCount, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "compact: close during an accepted summary aborts and joins it; queued requests reject closed",
  async () => {
    const { faux, session, ...native } = await nativeOptions([
      fauxAssistantMessage("unused summary"),
    ]);
    const agent = await JuncoAgent.fromResolved({
      ...native,
      session,
      compaction: COMPACTION,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ended: string[] = [];
    let summaries = 0;
    let cancelled = false;
    agent.events.on("compaction_end", ({ status }) => {
      ended.push(status);
    });
    agent.hooks.on("before_request", async (event, context) => {
      if (event.step !== "compaction") return undefined;
      summaries++;
      entered.resolve();
      try {
        await awaitWithContext(release.promise, context);
      } catch (error) {
        cancelled = true;
        throw error;
      }
      return undefined;
    });
    try {
      await seedLargeHistory(agent);
      const first = agent.compact().then(
        () => undefined,
        (error: unknown) => error,
      );
      const second = agent.compact().then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      await agent.return();
      assert.ok(isCode("closed")(await first));
      assert.ok(isCode("closed")(await second));
      assert.equal(cancelled, true);
      assert.equal(summaries, 1);
      assert.deepEqual(ended, ["aborted"]);
      assert.equal(faux.state.callCount, 0);
      await assert.rejects(session.beginMutation(BACKGROUND_CONTEXT));
    } finally {
      release.resolve();
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "compact: close in the same turn rejects requests queued on an idle agent",
  async () => {
    const { faux, agent } = await newAgent(
      [fauxAssistantMessage("unused summary")],
      { compaction: COMPACTION },
    );
    try {
      const first = agent.compact().then(
        () => undefined,
        (error: unknown) => error,
      );
      const second = agent.compact().then(
        () => undefined,
        (error: unknown) => error,
      );
      const closing = agent.return();
      assert.ok(isCode("closed")(await first));
      assert.ok(isCode("closed")(await second));
      assert.deepEqual(await closing, { value: undefined, done: true });
      assert.equal(faux.state.callCount, 0);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "compact: ordinary abort of an accepted summary rejects invalid_state and keeps the agent usable",
  async () => {
    const { faux, agent } = await newAgent(
      [fauxAssistantMessage("unused summary")],
      { compaction: COMPACTION },
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ended: string[] = [];
    agent.events.on("compaction_end", ({ status }) => {
      ended.push(status);
    });
    agent.hooks.on("before_request", async (event, context) => {
      if (event.step !== "compaction") return undefined;
      entered.resolve();
      await awaitWithContext(release.promise, context);
      return undefined;
    });
    try {
      await seedLargeHistory(agent);
      const before = await agent.context_size();
      const compaction = agent.compact().then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      await agent.abort();
      const failure = await compaction;
      assert.ok(isCode("invalid_state")(failure));
      assert.deepEqual(ended, ["aborted"]);
      assert.equal(faux.state.callCount, 0);
      assert.equal(await agent.context_size(), before);
      faux.setResponses([fauxAssistantMessage("after abort")]);
      assert.equal((await agent.prompt("again")).stopReason, "stop");
      assert.equal(settledText(await agent.next()), "after abort");
    } finally {
      release.resolve();
      await agent.return();
    }
  },
  TIMEOUT,
);

test("compact: empty and already-compacted contexts resolve without a provider call", async () => {
  const { faux, agent } = await newAgent(
    [fauxAssistantMessage("short summary")],
    { compaction: COMPACTION },
  );
  try {
    assert.equal(await agent.compact(), undefined);
    assert.equal(faux.state.callCount, 0);
    await seedLargeHistory(agent);
    assert.equal(await agent.compact(), undefined);
    assert.equal(faux.state.callCount, 1);
    const compacted = await agent.context_size();
    assert.equal(await agent.compact(), undefined);
    assert.equal(faux.state.callCount, 1);
    assert.equal(await agent.context_size(), compacted);
  } finally {
    await agent.return();
  }
});

test("compact: a declined compaction rejects and leaves the context unchanged", async () => {
  const { faux, agent } = await newAgent(
    [fauxAssistantMessage("unused summary")],
    { compaction: COMPACTION },
  );
  agent.hooks.on("before_compaction", () => ({ decline: true }));
  try {
    await seedLargeHistory(agent);
    const before = await agent.context_size();
    await assert.rejects(agent.compact(), isCode("invalid_state"));
    assert.equal(await agent.context_size(), before);
    assert.equal(faux.state.callCount, 0);
  } finally {
    await agent.return();
  }
});

test("compact: next-turn input stays queued for the next explicit prompt", async () => {
  let later: string[] = [];
  const { faux, agent } = await newAgent(
    [
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("short summary"),
      (context) => {
        later = userTexts(context.messages);
        return fauxAssistantMessage("later done");
      },
    ],
    { compaction: COMPACTION },
  );
  let runs = 0;
  agent.events.on("run_start", () => {
    runs++;
  });
  try {
    assert.equal((await agent.prompt("first ".repeat(64))).stopReason, "stop");
    await agent.nextTurn("queued only for next prompt");
    assert.equal(await agent.compact(), undefined);
    assert.equal(runs, 1);
    assert.equal(faux.state.callCount, 2);
    assert.equal((await agent.prompt("later")).stopReason, "stop");
    assert.ok(later.includes("queued only for next prompt"));
    assert.equal(runs, 2);
  } finally {
    await agent.return();
  }
});

// Structural-only navigation ----------------------------------------------------------------------

/** Entry IDs of committed string-content user messages, by text. */
function userEntryIds(agent: JuncoAgent): Map<string, string> {
  const ids = new Map<string, string>();
  agent.events.on("entry_added", ({ entry }) => {
    if (
      entry.type === "message" &&
      entry.message.role === "user" &&
      typeof entry.message.content === "string"
    ) {
      ids.set(entry.message.content, entry.id);
    }
  });
  return ids;
}

async function mainTip(session: Session): Promise<string | null> {
  const branch = await session.branch("main", BACKGROUND_CONTEXT);
  assert.ok(branch !== undefined);
  return branch.getTipId(BACKGROUND_CONTEXT);
}

test(
  "navigateTree: moves the branch without a prompt; queued input waits for the next explicit prompt",
  async () => {
    let firstRequest: string[] = [];
    const { faux, session, ...native } = await nativeOptions([
      (context) => {
        firstRequest = userTexts(context.messages);
        return toolTurn(yieldCall("pause", "y1"));
      },
      fauxAssistantMessage("next done"),
    ]);
    const agent = await JuncoAgent.fromResolved({
      ...native,
      session,
      tools: [new YieldTool()],
    });
    const ids = userEntryIds(agent);
    let runs = 0;
    agent.events.on("run_start", () => {
      runs++;
    });
    try {
      await agent.appendMessage(userMessage("abcdefgh"));
      await agent.appendMessage(userMessage("discarded branch"));
      await agent.nextTurn("queued only for next prompt");
      const target = ids.get("abcdefgh")!;
      let demanded = false;
      const demand = agent.next().then((result) => {
        demanded = true;
        return result;
      });
      const navigation = await agent.navigateTree(target, {
        summarize: false,
        label: "kept",
      });
      assert.ok(navigation.ok);
      assert.equal(navigation.value.navigation.kind, "navigation");
      assert.equal(navigation.value.navigation.status, "completed");
      assert.equal(navigation.value.navigation.tipId, target);
      assert.equal(navigation.value.run, undefined);
      assert.equal(await mainTip(session), target);
      assert.equal(await session.getLabel(target, BACKGROUND_CONTEXT), "kept");
      assert.equal(await agent.context_size(), 2);
      await flushMacrotasks();
      assert.equal(demanded, false);
      assert.equal(runs, 0);
      assert.equal(faux.state.callCount, 0);

      const prompt = agent.prompt("explicit next");
      assert.deepEqual(step(await demand), {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "y1",
            toolName: "yield",
            reason: "pause",
          },
        ],
      });
      assert.equal(settledText(await agent.next()), "next done");
      assert.equal((await prompt).stopReason, "stop");
      assert.equal(
        firstRequest.filter((text) => text === "queued only for next prompt")
          .length,
        1,
      );
      assert.ok(firstRequest.includes("abcdefgh"));
      assert.ok(!firstRequest.includes("discarded branch"));
      assert.equal(runs, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "navigateTree: native admission errors are results; a held prompt makes navigation LaneBusy",
  async () => {
    const { faux, session, ...native } = await nativeOptions([
      toolTurn(yieldCall("pause", "y1")),
      fauxAssistantMessage("resumed"),
    ]);
    const agent = await JuncoAgent.fromResolved({
      ...native,
      session,
      tools: [new YieldTool()],
    });
    const ids = userEntryIds(agent);
    try {
      await agent.appendMessage(userMessage("abcdefgh"));
      await agent.appendMessage(userMessage("zzzz"));
      const tip = await mainTip(session);
      const before = await agent.context_size();
      const unknown = await agent.navigateTree("missing", { summarize: false });
      assert.ok(!unknown.ok);
      assert.equal(unknown.error._tag, "UnknownTarget");
      const current = await agent.navigateTree(ids.get("zzzz")!, {
        summarize: false,
      });
      assert.ok(!current.ok);
      assert.equal(current.error._tag, "InvalidNavigation");
      assert.equal(await mainTip(session), tip);
      assert.equal(await agent.context_size(), before);

      const prompt = agent.prompt("go");
      assert.equal(step(await agent.next()).kind, "yield");
      const busy = await agent.navigateTree(ids.get("abcdefgh")!, {
        summarize: false,
      });
      assert.ok(!busy.ok);
      assert.equal(busy.error._tag, "LaneBusy");
      assert.equal(agent.status, "suspended");
      assert.equal(faux.state.callCount, 1);
      assert.equal(settledText(await agent.next()), "resumed");
      assert.equal((await prompt).stopReason, "stop");
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

/** A non-root target followed by turns the navigation abandons. */
async function seedBranch(agent: JuncoAgent): Promise<void> {
  await agent.appendMessage(userMessage("target question"));
  await agent.appendMessage(assistantMessage("target answer", 10));
  await agent.appendMessage(userMessage("discarded question"));
  await agent.appendMessage(assistantMessage("discarded answer", 20));
}

test(
  "navigateTree: summarized navigation commits a branch summary and label without a prompt",
  async () => {
    let summaryRequest = "";
    let later: string[] = [];
    const { faux, session, ...native } = await nativeOptions([
      (context) => {
        summaryRequest = JSON.stringify(context);
        return fauxAssistantMessage("branch summary");
      },
      (context) => {
        later = userTexts(context.messages);
        return fauxAssistantMessage("later done");
      },
    ]);
    const agent = await JuncoAgent.fromResolved({ ...native, session });
    const ids = userEntryIds(agent);
    let runs = 0;
    agent.events.on("run_start", () => {
      runs++;
    });
    try {
      await seedBranch(agent);
      await agent.nextTurn("queued only for next prompt");
      const target = ids.get("target question")!;
      const navigation = await agent.navigateTree(target, {
        summarize: true,
        label: "summarized",
        customInstructions: "focus on discarded work",
      });
      assert.ok(navigation.ok);
      assert.equal(navigation.value.navigation.status, "completed");
      assert.equal(navigation.value.run, undefined);
      assert.equal(faux.state.callCount, 1);
      assert.ok(summaryRequest.includes("focus on discarded work"));
      assert.ok(summaryRequest.includes("discarded question"));
      assert.equal(runs, 0);
      const summaries = await session.findEntries(
        { type: "branch_summary" },
        BACKGROUND_CONTEXT,
      );
      assert.equal(summaries.length, 1);
      assert.ok(
        summaries[0]?.type === "branch_summary" &&
          summaries[0].summary.endsWith("\n\nbranch summary"),
      );
      assert.equal(await mainTip(session), navigation.value.navigation.tipId);
      assert.equal(
        await session.getLabel(target, BACKGROUND_CONTEXT),
        "summarized",
      );

      assert.equal((await agent.prompt("later")).stopReason, "stop");
      assert.equal(
        later.filter((text) => text === "queued only for next prompt").length,
        1,
      );
      assert.ok(later.some((text) => text.includes("branch summary")));
      assert.ok(!later.includes("discarded question"));
      assert.equal(runs, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

for (const variant of ["declined", "failed"] as const) {
  test(
    `navigateTree: a ${variant} summary is a result that leaves the branch and inbox unchanged`,
    async () => {
      const { faux, session, ...native } = await nativeOptions([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "summary failed",
        }),
      ]);
      const agent = await JuncoAgent.fromResolved({
        ...native,
        session,
        retry: NO_RETRY,
      });
      if (variant === "declined")
        agent.hooks.on("before_navigation", () => ({ decline: true }));
      const ids = userEntryIds(agent);
      let runs = 0;
      agent.events.on("run_start", () => {
        runs++;
      });
      try {
        await seedBranch(agent);
        await agent.nextTurn("queued only for next prompt");
        const tip = await mainTip(session);
        const navigation = await agent.navigateTree(
          ids.get("target question")!,
          { summarize: true },
        );
        assert.ok(navigation.ok);
        assert.equal(navigation.value.navigation.status, variant);
        assert.equal(navigation.value.run, undefined);
        assert.equal(await mainTip(session), tip);
        assert.equal(runs, 0);
        assert.equal(faux.state.callCount, variant === "declined" ? 0 : 1);
        assert.deepEqual(
          await session.findEntries(
            { type: "branch_summary" },
            BACKGROUND_CONTEXT,
          ),
          [],
        );
      } finally {
        await agent.return();
      }
    },
    TIMEOUT,
  );
}

/** Gate the branch summary request until cancelled; `cancelled` records the hook's exit. */
function gateBranchSummary(agent: JuncoAgent) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const state = { cancelled: false };
  agent.hooks.on("before_request", async (event, context) => {
    if (event.step !== "branch_summary") return undefined;
    entered.resolve();
    try {
      await awaitWithContext(release.promise, context);
    } catch (error) {
      state.cancelled = true;
      throw error;
    }
    return undefined;
  });
  return { entered: entered.promise, release: () => release.resolve(), state };
}

test(
  "navigateTree: ordinary abort of a summary returns the aborted record and keeps the agent usable",
  async () => {
    const { faux, session, ...native } = await nativeOptions([
      fauxAssistantMessage("unused summary"),
    ]);
    const agent = await JuncoAgent.fromResolved({ ...native, session });
    const ids = userEntryIds(agent);
    const gate = gateBranchSummary(agent);
    try {
      await seedBranch(agent);
      const tip = await mainTip(session);
      const navigation = agent.navigateTree(ids.get("target question")!, {
        summarize: true,
      });
      await gate.entered;
      await agent.abort();
      const result = await navigation;
      assert.ok(result.ok);
      assert.equal(result.value.navigation.status, "aborted");
      assert.equal(gate.state.cancelled, true);
      assert.equal(faux.state.callCount, 0);
      assert.equal(await mainTip(session), tip);
      faux.setResponses([fauxAssistantMessage("after abort")]);
      assert.equal((await agent.prompt("again")).stopReason, "stop");
      assert.equal(settledText(await agent.next()), "after abort");
    } finally {
      gate.release();
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "navigateTree: close during a summary rejects closed after joining the native operation",
  async () => {
    const { faux, session, ...native } = await nativeOptions([
      fauxAssistantMessage("unused summary"),
    ]);
    const agent = await JuncoAgent.fromResolved({ ...native, session });
    const ids = userEntryIds(agent);
    const gate = gateBranchSummary(agent);
    try {
      await seedBranch(agent);
      const navigation = agent
        .navigateTree(ids.get("target question")!, { summarize: true })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await gate.entered;
      await agent.return();
      assert.ok(isCode("closed")(await navigation));
      assert.equal(gate.state.cancelled, true);
      assert.equal(faux.state.callCount, 0);
      await assert.rejects(session.beginMutation(BACKGROUND_CONTEXT));
    } finally {
      gate.release();
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "navigateTree: close during admission held by a session mutation rejects closed and cleans up",
  async () => {
    const { faux, session, ...native } = await nativeOptions([]);
    const agent = await JuncoAgent.fromResolved({ ...native, session });
    const ids = userEntryIds(agent);
    let mutation: Awaited<ReturnType<Session["beginMutation"]>> | undefined;
    try {
      await seedBranch(agent);
      mutation = await session.beginMutation(BACKGROUND_CONTEXT);
      const navigation = agent
        .navigateTree(ids.get("target question")!, { summarize: false })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await flushMacrotasks();
      const closing = agent.return();
      await mutation.end(BACKGROUND_CONTEXT);
      assert.deepEqual(await closing, { value: undefined, done: true });
      assert.ok(isCode("closed")(await navigation));
      assert.equal(faux.state.callCount, 0);
      await assert.rejects(session.beginMutation(BACKGROUND_CONTEXT));
    } finally {
      await mutation?.end(BACKGROUND_CONTEXT).catch(() => {});
      await agent.return();
    }
  },
  TIMEOUT,
);

// Agent controls observed in actual provider requests ------------------------------------------

/** The last user message's text in a provider context. */
function lastUserText(messages: Context["messages"]): string {
  const texts = userTexts(messages);
  assert.ok(texts.length > 0);
  return texts[texts.length - 1]!;
}

const replyText = (message: AssistantMessage): string =>
  message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

test(
  "setResources replaces the skill and template used by later explicit invocations",
  async () => {
    const requests: string[] = [];
    const capture = (reply: string) => (context: Context) => {
      requests.push(lastUserText(context.messages));
      return fauxAssistantMessage(reply);
    };
    const { faux, agent } = await newAgent(
      [capture("skill done"), capture("template done")],
      {
        resources: {
          skills: [
            {
              name: "review",
              description: "review code",
              content: "OLD-SKILL",
              filePath: "/virtual/old/SKILL.md",
            },
          ],
          promptTemplates: [
            {
              name: "draft",
              description: "draft text",
              content: "OLD-TEMPLATE $1",
            },
          ],
        },
      },
    );
    try {
      await agent.setResources({
        skills: [
          {
            name: "review",
            description: "review code",
            content: "NEW-SKILL",
            filePath: "/virtual/new/SKILL.md",
          },
        ],
        promptTemplates: [
          {
            name: "draft",
            description: "draft text",
            content: "Review $1 with $2",
          },
        ],
      });
      const [skill] = agent.getResources().skills ?? [];
      assert.ok(skill !== undefined);
      assert.equal(
        replyText(await agent.skill(skill.name, "EXTRA-INSTRUCTIONS")),
        "skill done",
      );
      assert.equal(settledText(await agent.next()), "skill done");
      assert.equal(
        replyText(await agent.promptFromTemplate("draft", ["parser", "tests"])),
        "template done",
      );
      assert.equal(settledText(await agent.next()), "template done");

      assert.equal(faux.state.callCount, 2);
      const [skillRequest, templateRequest] = requests as [string, string];
      const body = skillRequest.indexOf("NEW-SKILL");
      assert.ok(body >= 0);
      assert.ok(skillRequest.indexOf("EXTRA-INSTRUCTIONS") > body);
      for (const stale of ["OLD-SKILL", "/virtual/old/SKILL.md"])
        assert.equal(skillRequest.includes(stale), false);
      assert.equal(templateRequest, "Review parser with tests");
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "model, thinking level and stream options change the actual provider request",
  async () => {
    const faux = fauxProvider({
      api: "faux-config",
      provider: "faux-config",
      tokenSize: { min: 4, max: 4 },
      models: [
        { id: "plain", reasoning: false, input: ["text", "image"] },
        { id: "reasoning", reasoning: true, input: ["text", "image"] },
      ],
    });
    const observed: {
      model: string;
      reasoning: unknown;
      timeoutMs: unknown;
      header: unknown;
    }[] = [];
    faux.setResponses([
      (_context, options, _state, model) => {
        observed.push({
          model: model.id,
          reasoning: options?.reasoning,
          timeoutMs: options?.timeoutMs,
          header: options?.headers?.["x-junco-test"],
        });
        return fauxAssistantMessage("configured");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models,
      model: faux.getModel("plain")!,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
    });
    try {
      assert.equal((await agent.getModel())?.id, "plain");
      await agent.setModel({ provider: "faux-config", modelId: "reasoning" });
      await agent.setThinkingLevel("high");
      await agent.setStreamOptions({
        timeoutMs: 1234,
        headers: { "x-junco-test": "present" },
      });
      const selected = await agent.getModel();
      assert.deepEqual(
        [selected?.provider, selected?.id],
        ["faux-config", "reasoning"],
      );
      assert.equal(await agent.getThinkingLevel(), "high");
      assert.equal(replyText(await agent.prompt("configured?")), "configured");
      assert.equal(settledText(await agent.next()), "configured");
      assert.deepEqual(observed, [
        {
          model: "reasoning",
          reasoning: "high",
          timeoutMs: 1234,
          header: "present",
        },
      ]);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

const queueImage = (data: string): ImageContent => ({
  type: "image",
  data,
  mimeType: "image/png",
});
const QUEUE_IMAGES: Record<string, string> = {
  s1: "czE=",
  s2: "czI=",
  f1: "ZjE=",
  f2: "ZjI=",
  n1: "bjE=",
  work: "d29yaw==",
};

/** Each user message's text and the image data attached to that same message. */
function userInputs(
  messages: Context["messages"],
): { text: string; images: string[] }[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    if (typeof message.content === "string")
      return [{ text: message.content, images: [] }];
    return [
      {
        text: message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join(""),
        images: message.content.flatMap((block) =>
          block.type === "image" ? [block.data] : [],
        ),
      },
    ];
  });
}

// Pi accepts the run with one steer/follow-up per one-at-a-time queue plus every next-turn input;
// the first request boundary then drains one more steer, and the next boundary one more follow-up.
for (const { from, to, expected } of [
  {
    from: "all",
    to: "one-at-a-time",
    expected: [
      ["s1", "f1", "n1", "work", "s2"],
      ["s1", "f1", "n1", "work", "s2", "f2"],
    ],
  },
  {
    from: "one-at-a-time",
    to: "all",
    expected: [["s1", "s2", "f1", "f2", "n1", "work"]],
  },
] as const) {
  test(
    `queue modes switched from ${from} to ${to} govern delivery of queued image inputs`,
    async () => {
      const requests: { text: string; images: string[] }[][] = [];
      const replies = ["turn-1", "turn-2", "turn-3"].map(
        (reply) => (context: Context) => {
          requests.push(userInputs(context.messages));
          return fauxAssistantMessage(reply);
        },
      );
      const { faux, agent } = await newAgent(replies, {
        steeringMode: from,
        followUpMode: from,
      });
      try {
        await agent.setSteeringMode(to);
        await agent.setFollowUpMode(to);
        const options = (text: string) => ({
          images: [queueImage(QUEUE_IMAGES[text]!)],
        });
        await agent.steer("s1", options("s1"));
        await agent.steer("s2", options("s2"));
        await agent.followUp("f1", options("f1"));
        await agent.followUp("f2", options("f2"));
        await agent.nextTurn("n1", options("n1"));
        const settled = await agent.prompt("work", options("work"));
        const last = `turn-${expected.length}`;
        assert.equal(replyText(settled), last);
        assert.equal(settledText(await agent.next()), last);
        assert.equal(
          faux.getPendingResponseCount(),
          replies.length - expected.length,
        );
        assert.deepEqual(
          requests,
          expected.map((texts) =>
            texts.map((text) => ({ text, images: [QUEUE_IMAGES[text]!] })),
          ),
        );
      } finally {
        await agent.return();
      }
    },
    TIMEOUT,
  );
}

test(
  "breaking for-await after a yield pause drains the held run and closes without another request",
  async () => {
    const { faux, agent } = await newAgent(
      [
        toolTurn(yieldCall("pause", "y1")),
        fauxAssistantMessage("must not be requested"),
      ],
      { tools: [new YieldTool()] },
    );
    try {
      const prompt = agent.prompt("go");
      const seen: AgenticStep["kind"][] = [];
      for await (const value of agent) {
        seen.push(value.kind);
        if (value.kind === "yield") break;
      }
      assert.deepEqual(seen, ["yield"]);
      assert.equal(agent.status, "closed");
      const message = await prompt;
      assert.equal(message.role, "assistant");
      await flushMacrotasks();
      assert.equal(faux.state.callCount, 1);
      assert.deepEqual(await agent.next(), { value: undefined, done: true });
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "throw closes an open agent and rejects with the injected error",
  async () => {
    const { faux, agent } = await newAgent([
      fauxAssistantMessage("must not be requested"),
    ]);
    const sentinel = new Error("sentinel");
    try {
      await assert.rejects(
        agent.throw(sentinel),
        (error: unknown) => error === sentinel,
      );
      assert.equal(agent.status, "closed");
      assert.deepEqual(await agent.next(), { value: undefined, done: true });
      await assert.rejects(agent.prompt("late"), isCode("closed"));
      assert.equal(faux.state.callCount, 0);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "concurrent and repeated async disposal of a held agent joins cleanup once closed",
  async () => {
    const { faux, agent } = await newAgent(
      [
        toolTurn(yieldCall("pause", "y1")),
        fauxAssistantMessage("must not be requested"),
      ],
      { tools: [new YieldTool()] },
    );
    try {
      let drained = false;
      const prompt = agent.prompt("go").finally(() => {
        drained = true;
      });
      assert.equal(step(await agent.next()).kind, "yield");
      assert.equal(agent.status, "suspended");
      const disposals = [
        agent[Symbol.asyncDispose](),
        agent[Symbol.asyncDispose](),
      ];
      await Promise.all(disposals);
      assert.equal(drained, true);
      assert.equal((await prompt).role, "assistant");
      await agent[Symbol.asyncDispose]();
      assert.equal(agent.status, "closed");
      assert.deepEqual(await agent.next(), { value: undefined, done: true });
      await assert.rejects(agent.prompt("late"), isCode("closed"));
      assert.equal(faux.state.callCount, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "every model request carries the system instruction exactly once, never persisted",
  async () => {
    const prompts: string[] = [];
    // The provider sees the system prompt as the transcript's system message text.
    const record = (context: Context) => {
      prompts.push(
        context.messages
          .flatMap((message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content !== ""
              ? [message.content]
              : [],
          )
          .join("\n---\n"),
      );
    };
    const one = countingTool("one");
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const { faux, models, model } = scripted([
      (context) => {
        record(context);
        return toolTurn(fauxToolCall("one", {}, { id: "o1" }));
      },
      (context) => {
        record(context);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "overloaded",
        });
      },
      (context) => {
        record(context);
        return fauxAssistantMessage("done");
      },
      (context) => {
        record(context);
        return fauxAssistantMessage("summary");
      },
    ]);
    const agent = await JuncoAgent.fromResolved({
      session,
      models,
      model,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
      tools: [one.tool],
      compaction: COMPACTION,
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    });
    // A context hook replacing the system prompt still gets the instruction appended.
    agent.hooks.on("transform_context", () => ({ systemPrompt: "hooked" }));
    try {
      // Initial request, tool continuation and retry.
      assert.equal((await agent.prompt("go")).stopReason, "stop");
      assert.equal(settledText(await agent.next()), "done");
      assert.equal(one.state.executions, 1);
      assert.deepEqual(prompts, [
        `hooked\n\n${SYSTEM_INSTRUCTION}`,
        `hooked\n\n${SYSTEM_INSTRUCTION}`,
        `hooked\n\n${SYSTEM_INSTRUCTION}`,
      ]);
      await seedLargeHistory(agent);
      assert.equal(await agent.compact(), undefined);
      assert.equal(faux.state.callCount, 4);
      assert.equal(prompts.length, 4);
      assert.equal(prompts[3]!.split(SYSTEM_INSTRUCTION).length, 2);
      assert.ok(prompts[3]!.endsWith(SYSTEM_INSTRUCTION));
    } finally {
      await agent.return();
    }

    // A restored session and a child of it: each request carries one copy, the stored history none.
    const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
    faux.setResponses([
      (context) => {
        record(context);
        return fauxAssistantMessage("restored");
      },
      (context) => {
        record(context);
        return fauxAssistantMessage("child");
      },
    ]);
    const restored = await JuncoAgent.fromResolved({
      session: reopened,
      models,
      model,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
      tools: [one.tool],
    });
    try {
      assert.equal((await restored.prompt("again")).stopReason, "stop");
      assert.equal(settledText(await restored.next()), "restored");
      const [child] = await restored.createSubagents([{ tools: [] }]);
      try {
        assert.equal((await child!.prompt("child task")).stopReason, "stop");
        assert.equal(settledText(await child!.next()), "child");
      } finally {
        await child!.return();
      }
      assert.deepEqual(prompts.slice(4), [
        `sys\n\n${SYSTEM_INSTRUCTION}`,
        `sys\n\n${SYSTEM_INSTRUCTION}`,
      ]);
    } finally {
      await restored.return();
    }
  },
  TIMEOUT,
);

test(
  "tokenMonitor: reports usage growth since the last report, per agent, including restored sessions and children",
  async () => {
    const reports: {
      agent: JuncoAgent;
      tokens: number;
      cost: number;
      total: number;
    }[] = [];
    const record = (tokenThreshold: number): TokenMonitorConfig => ({
      tokenThreshold,
      onThreshold: (agent, totals, delta) => {
        reports.push({ agent, ...delta, total: totals.totalTokens });
      },
    });
    const { onThreshold } = record(1);
    await assert.rejects(
      JuncoAgent.fromResolved({
        ...(await nativeOptions([])),
        tokenMonitor: { onThreshold },
      }),
      isCode("invalid_argument"),
    );
    await assert.rejects(
      JuncoAgent.fromResolved({
        ...(await nativeOptions([])),
        tokenMonitor: { tokenThreshold: 0, onThreshold },
      }),
      isCode("invalid_argument"),
    );
    await assert.rejects(
      JuncoAgent.fromResolved({
        ...(await nativeOptions([])),
        tokenMonitor: {
          tokenThreshold: 5,
          costThreshold: Number.NaN,
          onThreshold,
        },
      }),
      isCode("invalid_argument"),
    );

    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const { faux, models, model } = scripted([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
    ]);
    const first = await JuncoAgent.fromResolved({
      session,
      models,
      model,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
      tokenMonitor: record(1),
    });
    try {
      await first.prompt("a");
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.agent, first);
      assert.equal(reports[0]!.tokens, reports[0]!.total);
      assert.ok(reports[0]!.tokens > 0);
      assert.equal(reports[0]!.cost, 0);
      await first.prompt("b");
      assert.equal(reports.length, 2);
      assert.equal(reports[1]!.tokens, reports[1]!.total - reports[0]!.total);
      assert.ok(reports[1]!.tokens > 0);
    } finally {
      await first.return();
    }

    const { agent: accumulated } = await newAgent(
      [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
      { tokenMonitor: record(reports[1]!.total) },
    );
    try {
      await accumulated.prompt("a");
      assert.equal(reports.length, 2);
      await accumulated.prompt("b");
      assert.equal(reports.length, 3);
      assert.equal(reports[2]!.tokens, reports[2]!.total);
      assert.equal(reports[2]!.total, reports[1]!.total);
      assert.equal(reports[2]!.cost, 0);
    } finally {
      await accumulated.return();
    }

    const { agent: costOnly } = await newAgent([fauxAssistantMessage("free")], {
      tokenMonitor: { costThreshold: 0.001, onThreshold },
    });
    try {
      assert.equal((await costOnly.prompt("go")).stopReason, "stop");
      assert.equal(reports.length, 3);
    } finally {
      await costOnly.return();
    }

    const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
    faux.setResponses([
      fauxAssistantMessage("three"),
      fauxAssistantMessage("child"),
    ]);
    const restored = await JuncoAgent.fromResolved({
      session: reopened,
      models,
      model,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
      tokenMonitor: record(1),
    });
    try {
      assert.equal(reports.length, 3);
      await restored.prompt("c");
      assert.equal(reports.length, 4);
      assert.equal(reports[3]!.agent, restored);
      assert.equal(reports[3]!.tokens, reports[3]!.total - reports[1]!.total);
      assert.ok(reports[3]!.total > reports[3]!.tokens);
      const [child] = await restored.createSubagents([{ tools: [] }]);
      try {
        await child!.prompt("child task");
        assert.equal(reports.length, 5);
        assert.equal(reports[4]!.agent, child);
        assert.equal(reports[4]!.tokens, reports[4]!.total);
        assert.equal(settledText(await child!.next()), "child");
      } finally {
        await child!.return();
      }
    } finally {
      await restored.return();
    }
  },
  TIMEOUT,
);

// Profiling ----------------------------------------------------------------------------------------

type Recorded = { readonly path: string; readonly event: ProfileEvent<string> };

/** One in-memory profiling session recording every event with its context path. */
function profileRecorder() {
  const events: Recorded[] = [];
  const recorder: ProfileRecorder<string> = {
    get root() {
      return recorder;
    },
    path: "",
    add_context: (nodeId) => contexts.add([], nodeId),
    record: (event) => {
      events.push({ path: "", event });
    },
    flush: async () => {},
    close: async () => {},
  };
  const contexts = profileContexts(
    recorder,
    (_ids, path, event) => {
      events.push({ path, event });
    },
    () => {},
  );
  return { recorder, events };
}

function profileUsage(
  events: readonly Recorded[],
  resource: "tokens" | "cost",
  source: object,
  path: string,
): number {
  let total = 0;
  for (const row of events)
    if (
      row.path === path &&
      row.event.kind === "usage" &&
      row.event.resource === resource &&
      row.event.source === source
    )
      total +=
        resource === "tokens"
          ? row.event.usage.totalTokens
          : (row.event.usage.cost?.total ?? Number.NaN);
  return total;
}

type Labels = {
  readonly category: string;
  readonly tool: string;
  readonly operation: string;
};
const AGENT_RUN = { category: "agent", tool: "", operation: "run" };
const HANDOFF = { category: "agent", tool: "yield", operation: "handoff" };

const labelled = (event: ProfileEvent<string>, labels: Labels) =>
  event.kind !== "usage" &&
  event.kind !== "resource" &&
  event.kind !== "probe" &&
  event.category === labels.category &&
  event.tool === labels.tool &&
  event.operation === labels.operation;

/** The summed counter `name` of `labels`. */
function counter(events: readonly Recorded[], labels: Labels, name: string) {
  let total = 0;
  for (const { event } of events)
    if (event.kind === "metrics" && labelled(event, labels))
      total += event.counters?.[name] ?? 0;
  return total;
}

/** Start count and terminal outcomes of `labels`, in order. */
function calls(events: readonly Recorded[], labels: Labels) {
  return {
    starts: events.filter(
      ({ event }) => event.kind === "start" && labelled(event, labels),
    ).length,
    outcomes: events.flatMap(({ event }) =>
      event.kind === "finish" && labelled(event, labels) ? [event.outcome] : [],
    ),
  };
}

test(
  "recorder: committed usage rows only, at the agent's own context, inherited by subagents",
  async () => {
    const fixed = fixedUsage([
      [fauxAssistantMessage("old"), 100, 10],
      [fauxAssistantMessage("new"), 3, 0.125],
      [fauxAssistantMessage("child"), 7, 0.375],
    ]);
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const first = await JuncoAgent.fromResolved({
      session,
      models: fixed.models,
      model: fixed.model,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
    });
    try {
      await first.prompt("history");
    } finally {
      await first.return();
    }
    const { recorder, events } = profileRecorder();
    const agent = await JuncoAgent.fromResolved({
      session: await repo.open(session.metadata, BACKGROUND_CONTEXT),
      models: fixed.models,
      model: fixed.model,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
      recorder,
      recorderNodeId: "solo",
    });
    try {
      assert.deepEqual(events, []);
      assert.equal(agent.recorder?.path, "solo");
      assert.equal(agent.recorder?.root, recorder);
      await agent.prompt("now");
      assert.equal(profileUsage(events, "tokens", agent, "solo"), 3);
      assert.equal(profileUsage(events, "cost", agent, "solo"), 0.125);
      assert.deepEqual(calls(events, AGENT_RUN), {
        starts: 1,
        outcomes: ["success"],
      });
      assert.deepEqual(
        calls(events, {
          category: "agent",
          tool: "",
          operation: "model_request",
        }),
        { starts: 1, outcomes: ["success"] },
      );
      assert.equal(
        counter(
          events,
          { category: "agent", tool: "", operation: "turn" },
          "turns_completed",
        ),
        1,
      );
      assert.ok(events.every(({ path }) => path === "solo"));
      const [child] = await agent.createSubagents([{ tools: [] }]);
      try {
        assert.ok(child);
        assert.equal(child.recorder?.root, recorder);
        assert.equal(child.recorder?.path, child.nodeId);
        await child.prompt("child task");
        assert.equal(profileUsage(events, "tokens", child, child.nodeId), 7);
        assert.equal(profileUsage(events, "cost", child, child.nodeId), 0.375);
        assert.equal(profileUsage(events, "tokens", agent, "solo"), 3);
        assert.equal(profileUsage(events, "cost", agent, "solo"), 0.125);
      } finally {
        await child?.return();
      }
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "recorder: two yields in one batch hand off one turn and resume once",
  async () => {
    const { recorder, events } = profileRecorder();
    const { agent } = await newAgent(
      [
        toolTurn(yieldCall("first", "y1"), yieldCall("second", "y2")),
        fauxAssistantMessage("after"),
      ],
      { tools: [new YieldTool()], prompt: "go", recorder },
    );
    try {
      assert.equal(step(await agent.next()).kind, "yield");
      // Two successful yield tool calls, however the yield tool is instrumented.
      assert.deepEqual(
        events.flatMap(({ event }) =>
          event.kind === "finish" && event.tool === "yield"
            ? [event.outcome]
            : [],
        ),
        ["success", "success"],
      );
      assert.equal(counter(events, HANDOFF, "yield_recognized"), 1);
      assert.equal(counter(events, HANDOFF, "turns_yielded"), 1);
      assert.equal(counter(events, HANDOFF, "tool_yield_reasons"), 2);
      assert.equal(counter(events, HANDOFF, "policy_yield_reasons"), 0);
      assert.equal(counter(events, HANDOFF, "yield_resumed"), 0);
      assert.equal(settledText(await agent.next()), "after");
      assert.equal(counter(events, HANDOFF, "yield_resumed"), 1);
      assert.ok(counter(events, HANDOFF, "yield_wait_ms") >= 0);
      assert.equal(
        events.filter(
          ({ event }) =>
            event.kind === "metrics" &&
            labelled(event, HANDOFF) &&
            event.counters?.yield_wait_ms !== undefined,
        ).length,
        1,
      );
      assert.equal(counter(events, HANDOFF, "turns_yielded"), 1);
      assert.deepEqual(calls(events, AGENT_RUN), {
        starts: 1,
        outcomes: ["success"],
      });
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "recorder: an aborted unread yield is recognized but never handed off; the run is cancelled once",
  async () => {
    const { recorder, events } = profileRecorder();
    const { agent } = await newAgent(
      [toolTurn(yieldCall("wait", "y1")), fauxAssistantMessage("never")],
      { tools: [new YieldTool()], recorder },
    );
    const ended = Promise.withResolvers<void>();
    agent.events.on("turn_end", () => ended.resolve());
    try {
      const run = agent.prompt("go");
      await ended.promise;
      assert.equal(counter(events, HANDOFF, "yield_recognized"), 1);
      await agent.abort();
      await run.catch(() => {});
      assert.equal(counter(events, HANDOFF, "turns_yielded"), 0);
      assert.equal(counter(events, HANDOFF, "yield_resumed"), 0);
      assert.ok(
        events.some(
          ({ event }) =>
            event.kind === "metrics" &&
            labelled(event, HANDOFF) &&
            event.counters?.yield_wait_ms !== undefined,
        ),
      );
      assert.deepEqual(calls(events, AGENT_RUN), {
        starts: 1,
        outcomes: ["cancelled"],
      });
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "recorder: custom tools count requested calls separately from executed calls, exactly once",
  async () => {
    const { recorder, events } = profileRecorder();
    const custom = countingTool("custom");
    const blocked: AgentTool = {
      ...countingTool("prepared").tool,
      prepareArguments: () => {
        throw new Error("bad arguments");
      },
    };
    const { agent } = await newAgent(
      [
        toolTurn(
          fauxToolCall("custom", {}, { id: "c1" }),
          fauxToolCall("prepared", {}, { id: "p1" }),
          fauxToolCall("ghost", {}, { id: "g1" }),
        ),
        fauxAssistantMessage("done"),
      ],
      { tools: [custom.tool, blocked], recorder },
    );
    const CUSTOM = { category: "custom", tool: "custom", operation: "execute" };
    const PREPARED = {
      category: "custom",
      tool: "prepared",
      operation: "execute",
    };
    try {
      assert.equal((await agent.prompt("go")).stopReason, "stop");
      assert.equal(custom.state.executions, 1);
      assert.equal(counter(events, CUSTOM, "requested"), 1);
      assert.deepEqual(calls(events, CUSTOM), {
        starts: 1,
        outcomes: ["success"],
      });
      assert.equal(counter(events, CUSTOM, "output_text_bytes"), 2);
      assert.equal(counter(events, PREPARED, "requested"), 1);
      assert.deepEqual(calls(events, PREPARED), { starts: 0, outcomes: [] });
      assert.equal(
        counter(
          events,
          { category: "custom", tool: "unregistered", operation: "invalid" },
          "requested",
        ),
        1,
      );
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "recorder: a node context places the agent under the graph's view of the same session only",
  async () => {
    const { recorder, events } = profileRecorder();
    const { agent } = await fixedAgent(
      [[fauxAssistantMessage("placed"), 5, 0.25]],
      { recorder, recorderNodeId: "own" },
    );
    const { agent: bare } = await newAgent([]);
    const other = profileRecorder().recorder;
    try {
      const graph = recorder.add_context("nodeId1").add_context("nodeId2");
      await agent.runWithNodeContext(
        { recorder: graph, recorderNodeId: "NodeId_f" },
        async () => {
          assert.equal(agent.recorder?.path, "nodeId1::nodeId2::NodeId_f");
          await assert.rejects(
            agent.runWithNodeContext({}, async () => {}),
            isCode("busy"),
          );
          await agent.prompt("go");
        },
      );
      assert.equal(agent.recorder?.path, "own");
      assert.ok(events.length > 0);
      assert.ok(
        events.every(({ path }) => path === "nodeId1::nodeId2::NodeId_f"),
      );
      assert.equal(
        profileUsage(events, "tokens", agent, "nodeId1::nodeId2::NodeId_f"),
        5,
      );
      assert.equal(
        profileUsage(events, "cost", agent, "nodeId1::nodeId2::NodeId_f"),
        0.25,
      );
      assert.equal(profileUsage(events, "tokens", agent, "own"), 0);
      assert.equal(profileUsage(events, "cost", agent, "own"), 0);
      let ran = false;
      for (const [target, context] of [
        [agent, { recorder: other.add_context("g") }],
        [bare, { recorder: graph }],
      ] as const)
        await assert.rejects(
          target.runWithNodeContext(context, async () => {
            ran = true;
          }),
          /ProfileRecorder instance mismatch/,
        );
      assert.equal(ran, false);
      assert.equal(agent.recorder?.path, "own");
      assert.equal(bare.recorder, undefined);
    } finally {
      await Promise.all([agent.return(), bare.return()]);
    }
  },
  TIMEOUT,
);

// Usage limits -----------------------------------------------------------------------------------

const usageOf = (totalTokens: number, cost = 0) => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

/**
 * Models whose one model answers request k with `steps[k]`, settled at once with exactly its
 * token count; faux recomputes usage from the prompt, which no exact threshold survives.
 */
function fixedUsage(
  steps: readonly (readonly [AssistantMessage, number, number?])[],
) {
  const pending = [...steps];
  const state = { requests: 0 };
  const model: Model<Api> = {
    ...fauxProvider().getModel(),
    provider: "fixed",
    api: "fixed",
  };
  const respond = (requestModel: Model<Api>) => {
    state.requests++;
    const step = pending.shift();
    if (step === undefined) throw new Error("No fixed response queued");
    const settled: AssistantMessage = {
      ...step[0],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      usage: usageOf(step[1], step[2]),
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: settled });
      if (settled.stopReason === "error")
        stream.push({ type: "error", reason: "error", error: settled });
      else
        stream.push({
          type: "done",
          reason: settled.stopReason as "stop" | "toolUse",
          message: settled,
        });
      stream.end(settled);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "fixed",
      auth: {
        apiKey: { name: "Fixed", resolve: async () => ({ auth: {} }) },
      },
      models: [model],
      api: { stream: respond, streamSimple: respond },
    }),
  );
  return { models, model, state, pending };
}

async function fixedAgent(
  steps: readonly (readonly [AssistantMessage, number, number?])[],
  options: Partial<Parameters<typeof JuncoAgent.fromResolved>[0]> = {},
) {
  const fixed = fixedUsage(steps);
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const agent = await JuncoAgent.fromResolved({
    session,
    models: fixed.models,
    model: fixed.model,
    systemPrompt: "sys",
    ...options,
    tool_block: [
      ...new Set([...NATIVE_TOOL_BLOCK, ...(options.tool_block ?? [])]),
    ],
  });
  return { ...fixed, agent, repo, session };
}

/** `work` inside graph node `node` whose activation holds `budgets`. */
const within = <R>(budgets: readonly UsageBudget[], work: () => R): R =>
  runWithUsageBudgets(budgets, "node", work);

async function usageFailure(work: Promise<unknown>): Promise<UsageLimitError> {
  const error = await work.then(
    () => assert.fail("expected a usage limit failure"),
    (failure: unknown) => failure,
  );
  assert.ok(isUsageLimitError(error), String(error));
  return error;
}

test(
  "usage limits: a denied tool call stops the run before any later effect or provider request",
  async () => {
    const counted = countingTool("mock_tool");
    const { agent, faux } = await newAgent(
      [
        toolTurn(
          fauxToolCall("mock_tool", {}, { id: "a" }),
          fauxToolCall("mock_tool", {}, { id: "b" }),
          fauxToolCall("mock_tool", {}, { id: "c" }),
        ),
        fauxAssistantMessage("after the limit"),
      ],
      { tools: [counted.tool] },
    );
    try {
      const budget = new UsageBudget("evaluation", { tools: 1 });
      const error = await usageFailure(
        within([budget], () => agent.prompt("go")),
      );
      assert.equal(counted.state.executions, 1);
      assert.equal(budget.usedTools, 1);
      assert.equal(faux.state.callCount, 1);
      assert.deepEqual(
        { ...error.details },
        {
          resource: "tools",
          scope: "evaluation",
          limit: 1,
          used: 1,
          requested: 1,
          attempted: 2,
          exceededBy: 1,
          nodePath: ["node"],
        },
      );
      // The harness is not faulted: a later unbudgeted run settles normally.
      assert.equal((await agent.prompt("again")).stopReason, "stop");
      assert.equal(counted.state.executions, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "usage limits: source-owned yield counts like any tool and the iterator fails with the typed error",
  async () => {
    const counted = countingTool("mock_tool");
    const { agent, faux } = await newAgent(
      [
        toolTurn(
          yieldCall("pause", "y1"),
          fauxToolCall("mock_tool", {}, { id: "a" }),
        ),
        fauxAssistantMessage("unreached"),
      ],
      { tools: [new YieldTool(), counted.tool], prompt: "go" },
    );
    try {
      const budget = new UsageBudget("evaluation", { tools: 1 });
      const failed = step(await within([budget], () => agent.next()));
      assert.equal(failed.kind, "failed");
      if (failed.kind !== "failed") return;
      assert.ok(isUsageLimitError(failed.error));
      assert.equal(failed.error.details.used, 1);
      assert.equal(counted.state.executions, 0);
      assert.equal(faux.state.callCount, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "usage limits: failed admitted calls count; unavailable and schema-rejected calls do not",
  async () => {
    let failures = 0;
    const failing: AgentTool = {
      name: "failing",
      label: "failing",
      description: "always fails",
      parameters: Type.Object({}),
      execute: async () => {
        failures++;
        throw new Error("boom");
      },
    };
    const strict = countingTool("strict");
    strict.tool.parameters = Type.Object({ n: Type.Number() });
    const { agent } = await newAgent(
      [
        toolTurn(
          fauxToolCall("missing", {}, { id: "m" }),
          fauxToolCall("strict", { n: "not a number" }, { id: "s1" }),
          fauxToolCall("failing", {}, { id: "f" }),
          fauxToolCall("strict", { n: 1 }, { id: "s2" }),
        ),
        fauxAssistantMessage("unreached"),
      ],
      { tools: [failing, strict.tool] },
    );
    try {
      const budget = new UsageBudget("evaluation", { tools: 1 });
      const error = await usageFailure(
        within([budget], () => agent.prompt("go")),
      );
      assert.equal(failures, 1);
      assert.equal(strict.state.executions, 0);
      assert.equal(budget.usedTools, 1);
      assert.equal(error.details.attempted, 2);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "usage limits: token caps deny requests at zero, stop tool effects after an overrun, and admit an exact final response",
  async () => {
    const zero = await fixedAgent([[fauxAssistantMessage("unreached"), 1]]);
    try {
      const error = await usageFailure(
        within([new UsageBudget("evaluation", { tokens: 0 })], () =>
          zero.agent.prompt("go"),
        ),
      );
      assert.equal(error.details.requested, 0);
      assert.equal(zero.state.requests, 0);
    } finally {
      await zero.agent.return();
    }

    const counted = countingTool("mock_tool");
    const over = await fixedAgent(
      [
        [toolTurn(fauxToolCall("mock_tool", {}, { id: "a" })), 12],
        [fauxAssistantMessage("unreached"), 1],
      ],
      { tools: [counted.tool] },
    );
    try {
      const budget = new UsageBudget("evaluation", { tokens: 10, tools: 5 });
      const error = await usageFailure(
        within([budget], () => over.agent.prompt("go")),
      );
      assert.deepEqual(
        { ...error.details },
        {
          resource: "tokens",
          scope: "evaluation",
          limit: 10,
          used: 0,
          requested: 12,
          attempted: 12,
          exceededBy: 2,
          nodePath: ["node"],
        },
      );
      // Cancelled by the native effect gate before any executor: no tool counts.
      assert.equal(counted.state.executions, 0);
      assert.equal(budget.usedTools, 0);
      assert.equal(over.state.requests, 1);
    } finally {
      await over.agent.return();
    }

    const exact = await fixedAgent([
      [fauxAssistantMessage("exact"), 10],
      [fauxAssistantMessage("over"), 11],
    ]);
    try {
      const budget = new UsageBudget("evaluation", { tokens: 10 });
      assert.equal(
        (await within([budget], () => exact.agent.prompt("go"))).stopReason,
        "stop",
      );
      const denied = await usageFailure(
        within([budget], () => exact.agent.prompt("again")),
      );
      assert.equal(denied.details.attempted, 10);
      assert.equal(exact.state.requests, 1);
      // Over the cap, even a final response fails its run.
      const final = await usageFailure(
        within([new UsageBudget("evaluation", { tokens: 10 })], () =>
          exact.agent.prompt("third"),
        ),
      );
      assert.equal(final.details.exceededBy, 1);
    } finally {
      await exact.agent.return();
    }
  },
  TIMEOUT,
);

test(
  "usage limits: each committed row charges once, retries and restored history included",
  async () => {
    const first = await fixedAgent(
      [
        [
          fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "overloaded",
          }),
          3,
        ],
        [fauxAssistantMessage("done"), 4],
        [fauxAssistantMessage("unbudgeted"), 6],
      ],
      { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
    );
    const budget = new UsageBudget("evaluation", { tokens: 100 });
    try {
      assert.equal(
        (await within([budget], () => first.agent.prompt("go"))).stopReason,
        "stop",
      );
      assert.equal(first.state.requests, 2);
      assert.equal(budget.usedTokens, 7);
      // The binding ended with its operation: a later unbudgeted run charges nothing here.
      await first.agent.prompt("free");
      assert.equal(budget.usedTokens, 7);
    } finally {
      await first.agent.return();
    }
    const reopened = await first.repo.open(
      first.session.metadata,
      BACKGROUND_CONTEXT,
    );
    const restored = fixedUsage([[fauxAssistantMessage("restored"), 5]]);
    const agent = await JuncoAgent.fromResolved({
      session: reopened,
      models: restored.models,
      model: restored.model,
      tool_block: NATIVE_TOOL_BLOCK,
      systemPrompt: "sys",
    });
    try {
      const fresh = new UsageBudget("evaluation", { tokens: 6 });
      await within([fresh], () => agent.prompt("after restore"));
      assert.equal(fresh.usedTokens, 5);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "usage limits: a resumed run charges its new activation, tool-reported usage included",
  async () => {
    const report: AgentTool = {
      name: "report",
      label: "report",
      description: "reports its own usage",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "reported" }],
        details: undefined,
        usage: usageOf(7),
      }),
    };
    const { agent } = await fixedAgent(
      [
        [toolTurn(yieldCall("pause", "y1")), 5],
        [toolTurn(fauxToolCall("report", {}, { id: "r1" })), 6],
        [fauxAssistantMessage("done"), 4],
      ],
      { tools: [new YieldTool(), report], prompt: "go" },
    );
    try {
      const activation = (budget: UsageBudget) =>
        within([budget], () =>
          agent.runWithNodeContext({}, () => agent.next()),
        );
      const first = new UsageBudget("activation", { tokens: 100, tools: 1 });
      const second = new UsageBudget("activation", { tokens: 100, tools: 1 });
      assert.equal(step(await activation(first)).kind, "yield");
      assert.equal(settledText(await activation(second)), "done");
      assert.deepEqual([first.usedTokens, first.usedTools], [5, 1]);
      assert.deepEqual([second.usedTokens, second.usedTools], [6 + 7 + 4, 1]);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "usage limits: explicit and automatic compaction and navigation summaries charge their caller",
  async () => {
    const explicit = await fixedAgent(
      [
        [fauxAssistantMessage("summary"), 9],
        [fauxAssistantMessage("second summary"), 9],
      ],
      { compaction: COMPACTION },
    );
    try {
      await seedLargeHistory(explicit.agent);
      await usageFailure(
        within([new UsageBudget("evaluation", { tokens: 0 })], () =>
          explicit.agent.compact(),
        ),
      );
      assert.equal(explicit.state.requests, 0);
      const budget = new UsageBudget("evaluation", { tokens: 100 });
      await within([budget], () => explicit.agent.compact());
      assert.ok(explicit.state.requests > 0);
      assert.equal(budget.usedTokens, 9 * explicit.state.requests);
    } finally {
      await explicit.agent.return();
    }

    const counted = countingTool("mock_tool");
    const automatic = await fixedAgent(
      [
        [toolTurn(fauxToolCall("mock_tool", {}, { id: "a" })), 127_500],
        [fauxAssistantMessage("summary"), 9],
        [fauxAssistantMessage("done"), 4],
      ],
      {
        tools: [counted.tool],
        compaction: { ...COMPACTION, enabled: true },
      },
    );
    let compactions = 0;
    automatic.agent.events.on("compaction_start", () => {
      compactions++;
    });
    try {
      const budget = new UsageBudget("evaluation", { tokens: 200_000 });
      await within([budget], () => automatic.agent.prompt("go"));
      assert.equal(compactions, 1);
      assert.equal(automatic.state.requests, 3);
      assert.equal(budget.usedTokens, 127_500 + 9 + 4);
    } finally {
      await automatic.agent.return();
    }

    const navigated = await fixedAgent([
      [fauxAssistantMessage("first"), 2],
      [fauxAssistantMessage("branch summary"), 3],
    ]);
    const ids: string[] = [];
    navigated.agent.events.on("entry_added", ({ entry }) => {
      ids.push(entry.id);
    });
    try {
      await navigated.agent.prompt("go");
      const budget = new UsageBudget("evaluation", { tokens: 100 });
      const result = await within([budget], () =>
        navigated.agent.navigateTree(ids[0]!, { summarize: true }),
      );
      assert.ok(result.ok);
      assert.equal(budget.usedTokens, 3);
    } finally {
      await navigated.agent.return();
    }
  },
  TIMEOUT,
);

test(
  "usage limits: closing during a budget stop settles without hanging",
  async () => {
    const counted = countingTool("mock_tool");
    const { agent } = await fixedAgent(
      [[toolTurn(fauxToolCall("mock_tool", {}, { id: "a" })), 12]],
      { tools: [counted.tool] },
    );
    let closing: Promise<unknown> | undefined;
    agent.events.on("usage", () => {
      closing ??= agent.return();
    });
    const failure: unknown = await within(
      [new UsageBudget("evaluation", { tokens: 10 })],
      () => agent.prompt("go"),
    ).then(
      () => assert.fail("expected the run to fail"),
      (error: unknown) => error,
    );
    await closing;
    assert.ok(
      [...errorGraph(failure)].some(
        (value) => isUsageLimitError(value) || isCode("closed")(value),
      ),
      String(failure),
    );
    assert.equal(counted.state.executions, 0);
  },
  TIMEOUT,
);
