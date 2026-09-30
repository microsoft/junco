import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  AgentHarness,
  AgentHarnessError,
  type AgentHarnessEvent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  type Context,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type ImageContent,
} from "@earendil-works/pi-ai";
import { MARSH_POLICY_DENIED } from "junco-tools/errors";
import { ModelId, ModelProvider } from "model-auth";
import { Type } from "typebox";
import { type AgenticStep, createYieldTool, JuncoAgent } from "../src/index.ts";
import { countingTool, gatedTool, nativeOptions, newAgent, scripted } from "./harness.ts";

const LIFECYCLE_TIMEOUT_MS = 5_000;

/** Let queued work run; used only to show that nothing progressed, never to wait for progress. */
const flushMacrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

const userTexts = (messages: Context["messages"]): string[] =>
  messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const { content } = message;
    return [
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    ];
  });

const yieldCall = (reason: string, id: string) => fauxToolCall("yield", { reason }, { id });
const toolTurn = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

function step(result: IteratorResult<AgenticStep, void>): AgenticStep {
  assert.equal(result.done, false);
  return result.value as AgenticStep;
}

function settledText(result: IteratorResult<AgenticStep, void>): string {
  const value = step(result);
  assert.equal(value.kind, "settled");
  if (value.kind !== "settled") throw new Error("unreachable");
  return value.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// -------------------------------------------------------------------------------------------------
// Native fidelity

/** Fields that differ between otherwise identical runs: clocks, generated ids and session entry ids. */
const VOLATILE = new Set([
  "timestamp",
  "responseId",
  "id",
  "parentId",
  "sessionId",
  "newLeafId",
  "oldLeafId",
  "targetId",
  "firstKeptEntryId",
  "fromId",
]);
const normalize = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, field) =>
      VOLATILE.has(key) && (typeof field === "string" || typeof field === "number") ? "<volatile>" : field,
    ),
  );

const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

/**
 * One scripted conversation driven only through the native API: images, thinking, a tool with
 * updates, hook overrides, steering and follow-up queued mid-tool, a thinking-level change that the
 * same run's next request sees, a prompt template, compaction and tree navigation.
 */
async function nativeScenario(
  construct: (options: Awaited<ReturnType<typeof nativeOptions>>) => AgentHarness,
): Promise<unknown> {
  const requests: unknown[] = [];
  const record = (context: Context, options: unknown) => {
    requests.push({
      userTexts: userTexts(context.messages),
      systemPrompt: context.systemPrompt,
      tools: context.tools?.map((tool) => tool.name),
      optionKeys: Object.keys(options ?? {}).sort(),
      reasoning: (options as { reasoning?: unknown } | undefined)?.reasoning,
      headers: (options as { headers?: unknown } | undefined)?.headers,
    });
  };
  const options = await nativeOptions([
    (context, streamOptions) => {
      record(context, streamOptions);
      return fauxAssistantMessage([fauxThinking("plan"), fauxToolCall("echo", { text: "hi" }, { id: "call-1" })], {
        stopReason: "toolUse",
      });
    },
    (context, streamOptions) => {
      record(context, streamOptions);
      return fauxAssistantMessage([fauxText("after steer")]);
    },
    (context, streamOptions) => {
      record(context, streamOptions);
      return fauxAssistantMessage([fauxText("after follow-up")]);
    },
    (context, streamOptions) => {
      record(context, streamOptions);
      return fauxAssistantMessage([fauxText("templated")]);
    },
    (context, streamOptions) => {
      record(context, streamOptions);
      return fauxAssistantMessage([fauxText("summary of the conversation")]);
    },
  ]);
  let harness: AgentHarness | undefined;
  const echo: AgentTool = {
    name: "echo",
    label: "echo",
    description: "echoes text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params, _signal, onUpdate) => {
      onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { step: 1 } });
      await harness!.steer("urgent");
      await harness!.followUp("later");
      await harness!.setThinkingLevel("low");
      return { content: [{ type: "text", text: `echo:${(params as { text: string }).text}` }], details: { ok: true } };
    },
  };
  harness = construct({
    ...options,
    tools: [echo],
    resources: { promptTemplates: [{ name: "greet", content: "Hello $1" }] },
  });
  const events: unknown[] = [];
  harness.subscribe((event) => {
    events.push(normalize(event));
  });
  harness.on("tool_result", (event) => (event.toolName === "echo" ? { details: { patched: true } } : undefined));
  harness.on("before_provider_request", () => ({ streamOptions: { headers: { "x-test": "1" } } }));
  const first = await harness.prompt("look", { images: [IMAGE] });
  const second = await harness.promptFromTemplate("greet", ["world"]);
  const compacted = await harness.compact().then(
    (value) => ({ ok: true, value }),
    (error: AgentHarnessError) => ({ ok: false, code: error.code, message: error.message }),
  );
  const entries = await options.session.getEntries();
  const firstUser = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
  const navigated = await harness.navigateTree(firstUser!.id);
  const context = await options.session.buildContext();
  return normalize({
    events,
    requests,
    first,
    second,
    compacted,
    navigated,
    context,
    thinkingLevel: harness.getThinkingLevel(),
  });
}

test("JuncoAgent reproduces the raw harness's native events, requests, results and session", async () => {
  const raw = await nativeScenario(({ faux: _faux, ...options }) => new AgentHarness(options));
  const junco = await nativeScenario(({ faux: _faux, ...options }) => new JuncoAgent(options));
  assert.deepEqual(junco, raw);
});

test("tools, getters, systemPrompt and provider requests keep the caller's live objects", async () => {
  const shared: AgentTool = countingTool("shared").tool;
  const seen: { tools: unknown[]; optionKeys: string[][]; receivers: unknown[]; promptThis: unknown[] } = {
    tools: [],
    optionKeys: [],
    receivers: [],
    promptThis: [],
  };
  const respond = [
    (context: Context, options: unknown) => {
      seen.tools.push(context.tools?.[0]);
      seen.optionKeys.push(Object.keys(options ?? {}).sort());
      return toolTurn(fauxToolCall("shared", {}, { id: "s1" }));
    },
    fauxAssistantMessage("done"),
  ];
  const systemPrompt = function (this: unknown) {
    seen.promptThis.push(this);
    return "sys";
  };
  const rawOptions = await nativeOptions(respond, { tools: [shared], systemPrompt });
  const juncoOptions = await nativeOptions(respond, { tools: [shared], systemPrompt });
  const raw = new AgentHarness(rawOptions);
  const agent = new JuncoAgent(juncoOptions);

  // Replace the live implementation and schema after installation.
  const schema = Type.Object({});
  shared.parameters = schema;
  shared.execute = async function (this: unknown) {
    seen.receivers.push(this);
    return { content: [{ type: "text", text: "live" }], details: undefined };
  };

  await raw.prompt("go");
  await agent.prompt("go");

  assert.equal(agent.getTools()[0], shared);
  assert.equal(agent.getActiveTools()[0], shared);
  assert.equal(agent.getModel(), juncoOptions.model);
  assert.equal(agent.models, juncoOptions.models);
  assert.equal(agent.env, juncoOptions.env);
  assert.deepEqual(seen.tools, [shared, shared]);
  assert.equal((seen.tools[1] as AgentTool).parameters, schema);
  assert.deepEqual(seen.receivers, [shared, shared]);
  const half = seen.promptThis.length / 2;
  assert.ok(half >= 1);
  assert.deepEqual(seen.promptThis, [...Array(half).fill(raw), ...Array(half).fill(agent)]);
  assert.deepEqual(seen.optionKeys[1], seen.optionKeys[0]);
});

test("a yield tool shared by two agents suspends only the agent whose run called it", async () => {
  const yieldTool = createYieldTool();
  const first = await newAgent([toolTurn(yieldCall("mine", "y1")), fauxAssistantMessage("first done")], {
    tools: [yieldTool],
    prompt: "first",
  });
  const second = await newAgent([toolTurn(yieldCall("theirs", "y2")), fauxAssistantMessage("second done")], {
    tools: [yieldTool],
    prompt: "second",
  });

  const mine = step(await first.agent.next());
  const theirs = step(await second.agent.next());
  assert.deepEqual(mine.kind === "yield" && mine.reasons.map((reason) => reason.toolCallId), ["y1"]);
  assert.deepEqual(theirs.kind === "yield" && theirs.reasons.map((reason) => reason.toolCallId), ["y2"]);
  assert.equal(first.agent.status, "suspended");
  assert.equal(second.agent.status, "suspended");
  assert.equal(settledText(await second.agent.next()), "second done");
  assert.equal(first.agent.status, "suspended");
  assert.equal(settledText(await first.agent.next()), "first done");
});

// -------------------------------------------------------------------------------------------------
// Iterator lifetime

test("settlement leaves the iterator open and the next prompt continues the same session", async () => {
  const requests: string[][] = [];
  const { agent } = await newAgent(
    [
      fauxAssistantMessage("one"),
      (context) => {
        requests.push(userTexts(context.messages));
        return fauxAssistantMessage("two");
      },
    ],
    { prompt: "first" },
  );

  assert.equal(settledText(await agent.next()), "one");
  assert.equal(agent.status, "idle");
  const message = await agent.prompt("second");
  const settled = step(await agent.next());
  assert.equal(settled.kind === "settled" && settled.message, message);
  assert.deepEqual(requests, [["first", "second"]]);
});

test("an unread settlement is consumed before a later run's yield, which resumes only on the next demand", async () => {
  const { faux, agent } = await newAgent(
    [fauxAssistantMessage("A done"), toolTurn(yieldCall("pause B", "y1")), fauxAssistantMessage("B done")],
    { tools: [createYieldTool()] },
  );

  await agent.prompt("A");
  const b = agent.prompt("B");
  assert.equal(settledText(await agent.next()), "A done");
  const paused = step(await agent.next());
  assert.deepEqual(paused, {
    kind: "yield",
    reasons: [{ kind: "tool", toolCallId: "y1", toolName: "yield", reason: "pause B" }],
  });
  assert.equal(agent.status, "suspended");
  await flushMacrotasks();
  assert.equal(faux.state.callCount, 2);
  assert.equal(settledText(await agent.next()), "B done");
  assert.equal(faux.state.callCount, 3);
  assert.equal((await b).role, "assistant");
});

test("busy rejections publish nothing; admitted failures publish exactly one failed step", async () => {
  const slow = gatedTool("slow");
  const { agent } = await newAgent([toolTurn(fauxToolCall("slow", {}, { id: "s1" })), fauxAssistantMessage("done")], {
    tools: [slow.tool],
  });

  const running = agent.prompt("go");
  await slow.state.started;
  await assert.rejects(agent.prompt("overlap"), (error) => error instanceof AgentHarnessError && error.code === "busy");
  slow.release();
  await running;
  assert.equal(settledText(await agent.next()), "done");
  assert.equal(agent.status, "idle");

  const missing = agent.skill("missing");
  const missingError = await missing.catch((error: unknown) => error);
  assert.ok(missingError instanceof AgentHarnessError && missingError.code === "invalid_argument");
  assert.deepEqual(step(await agent.next()), { kind: "failed", error: missingError });
  assert.equal(agent.status, "idle");

  const busyHook = new AgentHarnessError("busy", "hook reports busy");
  const off = agent.on("before_agent_start", () => {
    throw busyHook;
  });
  const hooked = await agent.prompt("again").catch((error: unknown) => error);
  off();
  assert.equal(hooked, busyHook);
  assert.deepEqual(step(await agent.next()), { kind: "failed", error: busyHook });
  assert.equal(agent.status, "idle");
});

test("error and aborted final messages are native settlements, not failures", async () => {
  const { agent } = await newAgent([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
    fauxAssistantMessage([], { stopReason: "aborted" }),
  ]);

  const failed = await agent.prompt("one");
  assert.deepEqual(step(await agent.next()), { kind: "settled", message: failed });
  assert.equal(failed.stopReason, "error");
  const aborted = await agent.prompt("two");
  assert.deepEqual(step(await agent.next()), { kind: "settled", message: aborted });
  assert.equal(aborted.stopReason, "aborted");
});

test("a staged prompt waits for the first demand and blocks explicit runs without being replaced", async () => {
  const requests: string[][] = [];
  const { faux, agent } = await newAgent(
    [
      (context) => {
        requests.push(userTexts(context.messages));
        return fauxAssistantMessage("staged done");
      },
    ],
    { prompt: "staged", images: [IMAGE] },
  );

  assert.equal(agent.status, "ready");
  await assert.rejects(
    agent.prompt("explicit"),
    (error) => error instanceof AgentHarnessError && error.code === "busy",
  );
  await flushMacrotasks();
  assert.equal(faux.state.callCount, 0);
  assert.equal(agent.status, "ready");
  assert.equal(settledText(await agent.next()), "staged done");
  assert.deepEqual(requests, [["staged"]]);
});

// -------------------------------------------------------------------------------------------------
// Cooperative suspension

test("a yield pauses after turn_end and save_point, before any second request, and resumes once", async () => {
  const yieldTool = createYieldTool();
  let executions = 0;
  const execute = yieldTool.execute;
  yieldTool.execute = (...args) => {
    executions += 1;
    return execute(...args);
  };
  const { faux, agent } = await newAgent(
    [toolTurn(yieldCall("waiting for review", "y1")), fauxAssistantMessage("resumed")],
    { tools: [yieldTool], prompt: "go" },
  );
  const events: string[] = [];
  agent.subscribe(async (event) => {
    events.push(event.type);
  });

  const paused = step(await agent.next());
  assert.equal(paused.kind, "yield");
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(events.slice(-2), ["turn_end", "save_point"]);
  assert.equal(agent.status, "suspended");
  await flushMacrotasks();
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(events.slice(-2), ["turn_end", "save_point"]);

  assert.equal(settledText(await agent.next()), "resumed");
  assert.equal(faux.state.callCount, 2);
  assert.equal(executions, 1);
});

test("a tool batch finishes before its pause, and reasons follow assistant order", async () => {
  const slow = gatedTool("slow");
  const denial = Object.assign(new Error("owned by another principal"), { code: MARSH_POLICY_DENIED });
  const denyGate = Promise.withResolvers<void>();
  const deny: AgentTool = {
    name: "deny",
    label: "deny",
    description: "denied by policy after a gate",
    parameters: Type.Object({}),
    execute: async () => {
      await denyGate.promise;
      throw denial;
    },
  };
  const { agent } = await newAgent(
    [
      toolTurn(
        fauxToolCall("deny", {}, { id: "d1" }),
        yieldCall("first reason", "y1"),
        fauxToolCall("slow", {}, { id: "s1" }),
        yieldCall("second reason", "y2"),
      ),
      fauxAssistantMessage("resumed"),
    ],
    { tools: [deny, createYieldTool(), slow.tool], prompt: "go" },
  );
  const ended: string[] = [];
  const yieldsEnded = Promise.withResolvers<void>();
  agent.subscribe((event) => {
    if (event.type !== "tool_execution_end") return;
    ended.push(event.toolCallId);
    if (ended.includes("y1") && ended.includes("y2")) yieldsEnded.resolve();
  });

  let delivered = false;
  const demand = agent.next().then((result) => {
    delivered = true;
    return result;
  });
  await yieldsEnded.promise;
  await slow.state.started;
  denyGate.resolve();
  await flushMacrotasks();
  assert.equal(delivered, false);
  slow.release();
  assert.deepEqual(step(await demand), {
    kind: "yield",
    reasons: [
      { kind: "policy", toolCallId: "d1", toolName: "deny", reason: denial.message },
      { kind: "tool", toolCallId: "y1", toolName: "yield", reason: "first reason" },
      { kind: "tool", toolCallId: "y2", toolName: "yield", reason: "second reason" },
    ],
  });
  assert.equal(settledText(await agent.next()), "resumed");
});

test("ordinary failures and a hook-blocked yield never suspend", async () => {
  const failing: AgentTool = {
    name: "failing",
    label: "failing",
    description: "throws an ordinary error",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("ordinary failure");
    },
  };
  const results: boolean[] = [];
  const { agent } = await newAgent(
    [
      toolTurn(fauxToolCall("failing", {}, { id: "f1" }), yieldCall("blocked", "y1")),
      fauxAssistantMessage("finished"),
    ],
    { tools: [failing, createYieldTool()], prompt: "go" },
  );
  agent.on("tool_call", (event) => (event.toolName === "yield" ? { block: true, reason: "not now" } : undefined));
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") results.push(event.isError);
  });

  assert.equal(settledText(await agent.next()), "finished");
  assert.deepEqual(results, [true, true]);
});

test("a throwing tool event listener reports a native failure, not a synthetic pause", async () => {
  const { agent } = await newAgent([toolTurn(yieldCall("never delivered", "y1")), fauxAssistantMessage("unused")], {
    tools: [createYieldTool()],
    prompt: "go",
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") throw new Error("listener failure");
  });

  const settled = step(await agent.next());
  assert.equal(settled.kind, "settled");
  assert.equal(settled.kind === "settled" && settled.message.stopReason, "error");
  assert.equal(agent.status, "idle");
});

// -------------------------------------------------------------------------------------------------
// Cancellation and terminal close

test(
  "abort notifies the run before releasing its gate, and the agent stays reusable",
  async () => {
    const seen: { abortedAtRequest?: boolean } = {};
    const { agent } = await newAgent(
      [
        toolTurn(yieldCall("pause", "y1")),
        (_context, options) => {
          seen.abortedAtRequest = options?.signal?.aborted;
          return fauxAssistantMessage("unused");
        },
        fauxAssistantMessage("again"),
      ],
      { tools: [createYieldTool()], prompt: "go" },
    );
    const aborts: unknown[] = [];
    agent.subscribe((event) => {
      if (event.type === "abort") aborts.push(event);
    });

    assert.equal(step(await agent.next()).kind, "yield");
    assert.deepEqual(await agent.abort(), { clearedSteer: [], clearedFollowUp: [] });
    assert.equal(seen.abortedAtRequest, true);
    const settled = step(await agent.next());
    assert.equal(settled.kind === "settled" && settled.message.stopReason, "aborted");
    assert.equal(aborts.length, 1);
    assert.equal((await agent.prompt("next")).stopReason, "stop");
    assert.equal(settledText(await agent.next()), "again");
  },
  LIFECYCLE_TIMEOUT_MS,
);

test(
  "return rejects new operations at once, joins the admitted run and hands a waiting demand its result",
  async () => {
    const slow = gatedTool("slow");
    const { agent } = await newAgent([toolTurn(fauxToolCall("slow", {}, { id: "s1" })), fauxAssistantMessage("unused")], {
      tools: [slow.tool],
      prompt: "go",
    });

    const waiting = agent.next();
    await slow.state.started;
    let closed = false;
    const closing = agent.return().then((result) => {
      closed = true;
      return result;
    });
    assert.equal(agent.status, "closed");
    for (const operation of [
      () => agent.prompt("late"),
      () => agent.steer("late"),
      () => agent.setThinkingLevel("low"),
      () => agent.appendMessage({ role: "user", content: "late", timestamp: 0 }),
    ]) {
      await assert.rejects(operation(), (error) => error instanceof AgentHarnessError && error.code === "invalid_state");
    }
    assert.equal(agent.getThinkingLevel(), "off");
    await flushMacrotasks();
    assert.equal(closed, false);
    slow.release();
    assert.deepEqual(await closing, { value: undefined, done: true });
    const settled = step(await waiting);
    assert.equal(settled.kind === "settled" && settled.message.stopReason, "aborted");
    assert.deepEqual(await agent.next(), { value: undefined, done: true });
    assert.deepEqual(await agent.return(), { value: undefined, done: true });
  },
  LIFECYCLE_TIMEOUT_MS,
);

test(
  "throw rejects with its own error after closing a suspended run without a stale pause",
  async () => {
    const { agent } = await newAgent([toolTurn(yieldCall("pause", "y1")), fauxAssistantMessage("unused")], {
      tools: [createYieldTool()],
      prompt: "go",
    });
    const stop = new Error("consumer stopped");

    assert.equal(step(await agent.next()).kind, "yield");
    await assert.rejects(agent.throw(stop), (error) => error === stop);
    assert.deepEqual(await agent.next(), { value: undefined, done: true });
  },
  LIFECYCLE_TIMEOUT_MS,
);

test(
  "close failures aggregate behind throw's own error and are shared by repeated closes",
  async () => {
    const dependentFailure = new Error("dependent close failed");
    class FailingDependents extends JuncoAgent {
      protected override closeDependents(): Promise<void> {
        return Promise.reject(dependentFailure);
      }
    }
    const { faux: _faux, ...options } = await nativeOptions([]);
    const agent = new FailingDependents(options);
    const stop = new Error("stop");

    const thrown = await agent.throw(stop).catch((error: unknown) => error);
    assert.ok(thrown instanceof AggregateError);
    assert.deepEqual(thrown.errors, [stop, dependentFailure]);
    const returned = await agent.return().catch((error: unknown) => error);
    assert.ok(returned instanceof AggregateError);
    assert.deepEqual(returned.errors, [dependentFailure]);
  },
  LIFECYCLE_TIMEOUT_MS,
);

for (const hold of ["systemPrompt", "before_agent_start"] as const) {
  test(
    `native limit: abort during startup held in ${hold} does not stop the run, but no gate blocks it`,
    async () => {
      const gate = Promise.withResolvers<void>();
      const { faux: _faux, ...options } = await nativeOptions([
        toolTurn(yieldCall("pause", "y1")),
        fauxAssistantMessage("final"),
      ]);
      const agent = new JuncoAgent({
        ...options,
        tools: [createYieldTool()],
        ...(hold === "systemPrompt"
          ? {
              systemPrompt: async () => {
                await gate.promise;
                return "sys";
              },
            }
          : {}),
      });
      if (hold === "before_agent_start") {
        agent.on("before_agent_start", async () => {
          await gate.promise;
          return undefined;
        });
      }
      const events: string[] = [];
      agent.subscribe((event) => {
        events.push(event.type);
      });

      const run = agent.prompt("go");
      const aborting = agent.abort();
      gate.resolve();
      await aborting;
      const message = await run;
      assert.equal(message.stopReason, "stop");
      assert.equal(events.filter((type) => type === "abort").length, 1);
      assert.deepEqual(step(await agent.next()), { kind: "settled", message });
      assert.equal(agent.status, "idle");
    },
    LIFECYCLE_TIMEOUT_MS,
  );
}

test(
  "native limit: a run started from agent_end escapes abort, but close still joins it",
  async () => {
    const slow = gatedTool("slow");
    const { agent } = await newAgent(
      [fauxAssistantMessage("A done"), toolTurn(fauxToolCall("slow", {}, { id: "s1" })), fauxAssistantMessage("B done")],
      { tools: [slow.tool] },
    );
    let b: Promise<unknown> | undefined;
    agent.subscribe((event) => {
      if (event.type === "agent_end" && b === undefined) b = agent.prompt("B");
    });

    await agent.prompt("A");
    await slow.state.started;
    await agent.abort();
    let closed = false;
    const closing = agent.return().then(() => {
      closed = true;
    });
    await flushMacrotasks();
    assert.equal(closed, false);
    slow.release();
    await closing;
    assert.equal((await b) !== undefined, true);
  },
  LIFECYCLE_TIMEOUT_MS,
);

test(
  "native fail-fast settlement keeps its early result, and close waits for the gated sibling",
  async () => {
    const fast = countingTool("fast");
    const slow = gatedTool("slow");
    const { agent } = await newAgent(
      [toolTurn(fauxToolCall("fast", {}, { id: "f1" }), fauxToolCall("slow", {}, { id: "s1" })), fauxAssistantMessage("unused")],
      { tools: [fast.tool, slow.tool], prompt: "go" },
    );
    const ends: string[] = [];
    agent.subscribe((event: AgentHarnessEvent) => {
      if (event.type !== "tool_execution_end") return;
      ends.push(event.toolCallId);
      if (event.toolName === "fast") throw new Error("listener failure");
    });

    const settled = step(await agent.next());
    assert.equal(settled.kind === "settled" && settled.message.stopReason, "error");
    await slow.state.started;
    let closed = false;
    const closing = agent.return().then(() => {
      closed = true;
    });
    await flushMacrotasks();
    assert.equal(closed, false);
    slow.release();
    await closing;
    assert.deepEqual(ends, ["f1", "s1"]);
  },
  LIFECYCLE_TIMEOUT_MS,
);

// -------------------------------------------------------------------------------------------------
// Factory ownership

function fauxModelProvider(responses: Parameters<FauxProviderHandle["setResponses"]>[0]) {
  const { faux } = scripted(responses);
  return ModelProvider.custom({ provider: faux.provider });
}

test("create resolves the model, owns only its environment, and releases it once on close", async () => {
  const provider = fauxModelProvider([fauxAssistantMessage("created")]);
  const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");
  const cleanup = NodeExecutionEnv.prototype.cleanup;
  let released = 0;
  NodeExecutionEnv.prototype.cleanup = async function (this: InstanceType<typeof NodeExecutionEnv>) {
    released += 1;
    return cleanup.call(this);
  };
  try {
    const agent = await JuncoAgent.create({ provider, model: ModelId("faux-1"), tools: [], prompt: "go" });
    assert.equal(settledText(await agent.next()), "created");
    await agent.return();
    await agent.return();
    assert.equal(released, 1);

    const supplied = new NodeExecutionEnv({ cwd: process.cwd() });
    const borrowed = await JuncoAgent.create({
      provider: fauxModelProvider([]),
      model: ModelId("faux-1"),
      env: supplied,
      tools: [],
    });
    await borrowed.return();
    assert.equal(released, 1);
  } finally {
    NodeExecutionEnv.prototype.cleanup = cleanup;
  }
});

test("create keeps the original construction failure and rejects an env without tools", async () => {
  const duplicate = countingTool("same").tool;
  await assert.rejects(
    JuncoAgent.create({
      provider: fauxModelProvider([]),
      model: ModelId("faux-1"),
      tools: [duplicate, countingTool("same").tool],
    }),
    (error) => error instanceof AgentHarnessError && error.code === "invalid_argument",
  );
  const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");
  await assert.rejects(
    JuncoAgent.create({
      provider: fauxModelProvider([]),
      model: ModelId("faux-1"),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
    } as never),
    (error) => error instanceof AgentHarnessError && error.code === "invalid_argument",
  );
});
