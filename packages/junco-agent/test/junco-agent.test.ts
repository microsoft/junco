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
  type AssistantMessage,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ImageContent,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createYieldTool, isComplainTool, issueLog } from "junco-tools";
import { MARSH_POLICY_DENIED } from "junco-tools/errors";
import { Type } from "typebox";
import { type AgenticStep, JuncoAgent, JuncoAgentError } from "../src/index.ts";
import { countingTool, nativeOptions, newAgent, scripted } from "./harness.ts";

const TIMEOUT = 5_000;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const toolTurn = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });
const yieldCall = (reason: string, id: string) =>
  fauxToolCall("yield", { reason }, { id });

function step(result: IteratorResult<AgenticStep, void>): AgenticStep {
  assert.equal(result.done, false);
  return result.value as AgenticStep;
}

function settledText(result: IteratorResult<AgenticStep, void>): string {
  const value = step(result);
  assert.equal(value.kind, "settled");
  return value.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function userTexts(messages: Context["messages"]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    return [
      typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join(""),
    ];
  });
}

const isCode =
  (code: JuncoAgentError["code"]) =>
  (error: unknown): boolean =>
    error instanceof JuncoAgentError && error.code === code;

/** Asserts the optional tools in order, followed by exactly one genuine complain tool. */
function assertTools(actual: readonly object[], expected: readonly object[]) {
  assert.deepEqual(actual.slice(0, -1), expected);
  assert.equal(isComplainTool(actual.at(-1)!), true);
  assert.equal(actual.filter((tool) => isComplainTool(tool)).length, 1);
}

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
    assertTools(agent.getTools(), [first.tool, second.tool]);
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
  const shared = createYieldTool();
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
    await tick();
    assert.equal(faux.state.callCount, 0);
    assert.equal(settledText(await agent.next()), "staged done");
    assert.equal(agent.status, "idle");
  } finally {
    await agent.return();
  }
});

test("turn_end subscribers see the full successful yield result before the next request is gated", async () => {
  const { faux, agent } = await newAgent(
    [toolTurn(yieldCall("review", "y1")), fauxAssistantMessage("resumed")],
    { tools: [createYieldTool()], prompt: "go" },
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
    await tick();
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
      { tools: [mutate, deny, createYieldTool()], prompt: "go" },
    );
    const ended: string[][] = [];
    agent.events.on("turn_end", ({ toolResults }) =>
      ended.push(toolResults.map((result) => result.toolCallId)),
    );
    try {
      const pending = agent.next();
      await started.promise;
      await tick();
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
  "edit and ast_edit mutate a file in source order without overlap",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "junco-agent-serial-"));
    const file = join(directory, "state.txt");
    const started: string[] = [];
    const firstStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const edit: AgentTool = {
      name: "edit",
      label: "edit",
      description: "first file mutation",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        started.push("edit");
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
      name: "ast_edit",
      label: "ast_edit",
      description: "dependent file mutation",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        started.push("ast_edit");
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
          fauxToolCall("edit", {}, { id: "e1" }),
          fauxToolCall("ast_edit", {}, { id: "a1" }),
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
      await tick();
      assert.deepEqual(started, ["edit"]);
      release.resolve();
      assert.equal((await prompt).content[0]?.type, "text");
      assert.equal(settledText(await agent.next()), "finished");
      assert.deepEqual(started, ["edit", "ast_edit"]);
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
    { tools: [fake.tool], prompt: "go" },
  );
  const { agent: blocked } = await newAgent(
    [toolTurn(yieldCall("denied", "y2")), fauxAssistantMessage("continued")],
    { tools: [createYieldTool()], prompt: "go" },
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
      policy: "GitPolicy",
      model,
      tools: [first.tool],
      activeToolNames: ["first", "first"],
    }),
    isCode("invalid_argument"),
  );
  await assert.rejects(
    JuncoAgent.fromResolved({
      session: await repo.create({}, BACKGROUND_CONTEXT),
      models,
      policy: "GitPolicy",
      model,
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
    assertTools(agent.getTools(), [first.tool, second.tool]);
    assertTools(agent.getActiveTools(), [first.tool, second.tool]);
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
    policy: "GitPolicy",
    model,
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
    policy: "GitPolicy",
    model,
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
      { tools: [createYieldTool()], prompt: "go" },
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
      { tools: [createYieldTool()] },
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
      policy: "GitPolicy",
    });
    const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
    try {
      const pending = agent.prompt("held").catch((error: unknown) => error);
      await tick();
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
    const { tool } = countingTool("read");
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
      assertTools(agent.getTools(), [tool]);
      assertTools(agent.getActiveTools(), [tool]);
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
      await tick();
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
  const { faux } = scripted([fauxAssistantMessage("created")]);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("faux", async () => ({
    type: "api_key",
    key: "fixture-login",
  }));
  const models = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  const agent = await JuncoAgent.create({
    models,
    policy: "GitPolicy",
    provider: "faux",
    model: "faux-1",
    tools: [],
    prompt: "go",
  });
  try {
    assert.equal(settledText(await agent.next()), "created");
  } finally {
    await agent.return();
  }
  const duplicate = countingTool("same").tool;
  await assert.rejects(
    JuncoAgent.create({
      models,
      policy: "GitPolicy",
      provider: "faux",
      model: "faux-1",
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
      policy: "GitPolicy",
      provider: "faux",
      model: "faux-1",
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
          policy: "GitPolicy",
          provider: "github-copilot",
          model: "claude-opus-5.5",
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
      policy: "GitPolicy",
      provider: "github-copilot",
      model: "claude-opus-5.5",
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
      policy: "GitPolicy",
      provider: "github-copilot",
      model: "claude-opus-5.5",
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
        tools: [createYieldTool()],
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
      await tick();
      await tick();
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
      await tick();
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
      await tick();
      const compaction = agent.compact();
      await tick();
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
      { tools: [createYieldTool()], prompt: "go", compaction: COMPACTION },
    );
    try {
      assert.equal(step(await agent.next()).kind, "yield");
      const compaction = agent.compact();
      await tick();
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
      tools: [createYieldTool()],
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
      await tick();
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
      tools: [createYieldTool()],
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
      await tick();
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
      policy: "GitPolicy",
      model: faux.getModel("plain")!,
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
      { tools: [createYieldTool()] },
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
      await tick();
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
      { tools: [createYieldTool()] },
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
