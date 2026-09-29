import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { ModelId } from "model-auth";
import { Type } from "typebox";
import type { JuncoAbort, JuncoResult } from "../src/index.ts";
import { drive, newAgent, PROMPT_TEXT, scriptedModelProvider } from "./harness.ts";

const CLOSED: JuncoResult = { text: "closed", details: { failed: true, message: "closed" } };
const LIFECYCLE_TIMEOUT_MS = 5_000;

/** A caller-supplied stateful tool that counts its executions. */
function countingTool(counter: { executions: number }): AgentTool {
  return {
    name: "mock_tool",
    label: "mock tool",
    description: "counts executions",
    parameters: Type.Object({}),
    execute: async () => {
      counter.executions += 1;
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
}

const toolTurn = () =>
  fauxAssistantMessage([fauxToolCall("mock_tool", {})], { stopReason: "toolUse" });

/** User-message texts from one model request, in context order. */
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

const abortCode = (error: unknown): unknown => (error as JuncoAbort).code;

test("starts on the first next, streams thinking then text, and returns only the answer", async () => {
  const provider = scriptedModelProvider([
    fauxAssistantMessage([fauxThinking("reason"), fauxText("hello from faux")]),
  ]);

  const { emitted, result } = await drive(newAgent(provider));

  assert.deepEqual(emitted, ["reason", "hello from faux"]);
  assert.deepEqual(result, { text: "hello from faux", details: { failed: false } });
});

test("a model stopReason:error returns a failed result without yielding the failure", async () => {
  const provider = scriptedModelProvider([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
  ]);

  const { emitted, result } = await drive(newAgent(provider));

  assert.deepEqual(result, {
    text: "prompt failed: boom",
    details: { failed: true, message: "boom" },
  });
  assert.equal(emitted.some((text) => text.includes("boom")), false);
});

test("an unknown model rejects initialization as an invariant abort", async () => {
  const provider = scriptedModelProvider([fauxAssistantMessage("unused")]);
  const agent = newAgent(provider, { model: ModelId("missing-model") });

  await assert.rejects(agent.next(), (error) => abortCode(error) === "invariant");
});

test("an empty or whitespace prompt rejects as a protocol abort", async () => {
  for (const prompt of ["", " \n\t "]) {
    const provider = scriptedModelProvider([fauxAssistantMessage("unused")]);

    await assert.rejects(
      newAgent(provider, { prompt }).next(),
      (error) => abortCode(error) === "protocol",
    );
  }
});

test("an empty system prompt rejects before any model run", async () => {
  let modelCalls = 0;
  const provider = scriptedModelProvider([
    () => {
      modelCalls += 1;
      return fauxAssistantMessage("unused");
    },
  ]);

  await assert.rejects(newAgent(provider, { systemPrompt: "" }).next(), Error);
  assert.equal(modelCalls, 0);
});

test("a tool marker precedes any side effect; resuming executes it once and continues", async () => {
  const counter = { executions: 0 };
  const provider = scriptedModelProvider([
    fauxAssistantMessage([fauxThinking("t1"), fauxToolCall("mock_tool", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("final answer")]),
  ]);
  const agent = newAgent(provider, { tools: [countingTool(counter)] });

  assert.deepEqual(await agent.next(), { value: "t1", done: false });
  assert.deepEqual(await agent.next(), { value: "[tool:mock_tool]", done: false });
  assert.equal(counter.executions, 0);
  assert.deepEqual(await agent.next(), { value: "final answer", done: false });
  assert.equal(counter.executions, 1);
  assert.deepEqual(await agent.next(), {
    value: { text: "final answer", details: { failed: false } },
    done: true,
  });
  assert.equal(counter.executions, 1);
});

/** A run that pauses at its first tool marker; records the run's model-request signal. */
function pausedToolRun() {
  const run: { executions: number; signal?: AbortSignal } = { executions: 0 };
  const provider = scriptedModelProvider([
    (_context, options) => {
      run.signal = options?.signal;
      return toolTurn();
    },
    fauxAssistantMessage("unused continuation"),
  ]);
  return { run, agent: newAgent(provider, { tools: [countingTool(run)] }) };
}

test(
  "return() at a tool marker aborts the run without executing the tool",
  async () => {
    const { run, agent } = pausedToolRun();

    assert.deepEqual(await agent.next(), { value: "[tool:mock_tool]", done: false });
    assert.deepEqual(await agent.return(CLOSED), { value: CLOSED, done: true });
    assert.equal(run.signal?.aborted, true);
    assert.equal(run.executions, 0);
    assert.deepEqual(await agent.next(), { value: undefined, done: true });
  },
  LIFECYCLE_TIMEOUT_MS,
);

test(
  "throw() at a tool marker aborts the run and rethrows without executing the tool",
  async () => {
    const { run, agent } = pausedToolRun();
    const stop = new Error("consumer stopped");

    assert.deepEqual(await agent.next(), { value: "[tool:mock_tool]", done: false });
    await assert.rejects(agent.throw(stop), (error) => error === stop);
    assert.equal(run.signal?.aborted, true);
    assert.equal(run.executions, 0);
  },
  LIFECYCLE_TIMEOUT_MS,
);

test("controls resumed at a tool marker are queued before the tool continuation", async () => {
  const counter = { executions: 0 };
  const requests: string[][] = [];
  const provider = scriptedModelProvider([
    toolTurn(),
    (context) => {
      requests.push(userTexts(context.messages));
      return fauxAssistantMessage("steered");
    },
    (context) => {
      requests.push(userTexts(context.messages));
      return fauxAssistantMessage("followed");
    },
  ]);
  const agent = newAgent(provider, { tools: [countingTool(counter)] });

  const { emitted, result } = await drive(agent, (yielded) =>
    yielded === "[tool:mock_tool]"
      ? [
          { kind: "steer", msg: "urgent" },
          { kind: "followUp", msg: "later" },
        ]
      : undefined,
  );

  assert.deepEqual(requests, [
    [PROMPT_TEXT, "urgent"],
    [PROMPT_TEXT, "urgent", "later"],
  ]);
  assert.deepEqual(emitted, ["[tool:mock_tool]", "steered", "followed"]);
  assert.deepEqual(result, { text: "steeredfollowed", details: { failed: false } });
  assert.equal(counter.executions, 1);
});

test("two agents share one provider authentication and both complete", async () => {
  const provider = scriptedModelProvider([
    fauxAssistantMessage("first"),
    fauxAssistantMessage("second"),
  ]);
  const firstAgent = newAgent(provider);
  const secondAgent = newAgent(provider);

  const firstAuthentication = provider.authenticate(ModelId("faux-1"));
  assert.strictEqual(provider.authenticate(ModelId("faux-1")), firstAuthentication);
  await firstAuthentication;

  const first = await drive(firstAgent);
  const second = await drive(secondAgent);
  assert.equal(first.result.text, "first");
  assert.equal(second.result.text, "second");
});
