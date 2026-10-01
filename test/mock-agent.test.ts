import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AgentMessage,
  type AgentTool,
  awaitWithContext,
  type Context,
  estimateTokens,
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  type HarnessEvent,
  type PromptTemplate,
  type Skill,
  UnknownTarget,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import { type AgenticStep, JuncoAgentError } from "junco-agent";
import { Type } from "typebox";
import { MockAgent, type MockHook, type MockMaintenance, type MockRun, type MockTranscript } from "../src/index.ts";
import {
  ABORTED,
  assistant,
  failed,
  pause,
  reason,
  requestTexts,
  run,
  settle,
  textOf,
  user,
  userTexts,
  yieldsThen,
} from "./deterministic-support.ts";

// The MockAgent's complete Agentic surface, driven only by constant transcripts and
// Promise.withResolvers/Context barriers.

type Transcript = MockTranscript<Skill, PromptTemplate, AgentTool>;
type Code = JuncoAgentError["code"];

const hasCode = (code: Code) => (error: unknown) => error instanceof JuncoAgentError && error.code === code;

/** The rejection of `promise`, which must reject. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection");
}

/** The next step of `agent`, which must not be done. */
async function stepOf(agent: MockAgent): Promise<AgenticStep> {
  const result = await agent.next();
  if (result.done) return assert.fail("expected a step");
  return result.value;
}

function settledMessage(step: AgenticStep): AssistantMessage {
  if (step.kind !== "settled") return assert.fail(`expected settled, got ${step.kind}`);
  return step.message;
}

function failedError(step: AgenticStep): unknown {
  if (step.kind !== "failed") return assert.fail(`expected failed, got ${step.kind}`);
  return step.error;
}

const ABORTED_MESSAGE = settledMessage(ABORTED.step);
const image = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const runStart: HarnessEvent = { type: "run_start", runId: "r1", startedAt: 0, lane: "main" };
const runResume: HarnessEvent = { type: "run_resume", runId: "r1", lane: "main" };
const driveHook: MockHook = { name: "before_drive", event: { operation: "run", lane: "main", runId: "r1" }, results: [undefined] };

/** The images carried by `message`, in order. */
const imagesOf = (message: AgentMessage | undefined): unknown[] =>
  message !== undefined && message.role === "user" && typeof message.content !== "string"
    ? message.content.filter((block) => block.type === "image")
    : [];

/** The history entry whose user text is `text`. */
const userMessage = (agent: MockAgent, text: string): AgentMessage | undefined =>
  agent.history.find((message) => userTexts([message])[0] === text);

/**
 * A cooperative hook barrier: it reports its Context, then waits until that Context is cancelled.
 * `exited` turns true only once the handler has finished.
 */
function barrier() {
  const entered = Promise.withResolvers<Context>();
  const state = { exited: false };
  const handler = async (_event: unknown, context: Context): Promise<undefined> => {
    entered.resolve(context);
    try {
      await awaitWithContext(new Promise<never>(() => {}), context);
    } finally {
      state.exited = true;
    }
  };
  return { entered: entered.promise, handler, exited: () => state.exited };
}

const INTERRUPTED = assistant("interrupted", "aborted");
/** A run whose only frame waits in a `before_drive` hook; cancellation records a note and INTERRUPTED. */
const barrierRun = (): MockRun =>
  run([settle(assistant("unreached"), { hooks: [driveHook] })], {
    step: { kind: "settled", message: INTERRUPTED },
    messages: [user("cancelled note")],
  });

/** A MockAgent whose dependent cascades are scripted and counted. */
class Owner extends MockAgent {
  aborts = 0;
  closes = 0;
  readonly #onAbort: () => Promise<void> | undefined;
  readonly #onClose: () => Promise<void> | undefined;

  constructor(
    transcript: Transcript,
    {
      onAbort = () => undefined,
      onClose = () => undefined,
    }: { onAbort?: () => Promise<void> | undefined; onClose?: () => Promise<void> | undefined } = {},
  ) {
    super(transcript);
    this.#onAbort = onAbort;
    this.#onClose = onClose;
  }

  protected override abortDependents(): Promise<void> | undefined {
    this.aborts++;
    return this.#onAbort();
  }

  protected override closeDependents(): Promise<void> | undefined {
    this.closes++;
    return this.#onClose();
  }
}

describe("transcript runs and the scheduling iterator", () => {
  const FIRST = assistant("first");
  const SECOND = assistant("second");
  const SHARED: Transcript = {
    prompt: "staged",
    runs: [run([pause([reason("hold", "y1")]), settle(FIRST)]), run([settle(SECOND)])],
  };

  test("two agents share one transcript with independent cursors through every status", async () => {
    const a = new MockAgent(SHARED);
    const b = new MockAgent(SHARED);
    assert.equal(a.status, "ready");
    assert.deepEqual(a.requests, []);

    // The staged prompt holds the admission gate without running.
    for (const admit of [() => a.prompt("early"), () => a.skill("any"), () => a.promptFromTemplate("any")]) {
      assert.ok(hasCode("busy")(await rejection(admit())));
    }
    assert.deepEqual(a.requests, []);

    const first = a.next();
    assert.equal(a.status, "running");
    assert.deepEqual(await first, { value: { kind: "yield", reasons: [reason("hold", "y1")] }, done: false });
    assert.equal(a.status, "suspended");
    assert.ok(hasCode("busy")(await rejection(a.prompt("while held"))));

    const second = a.next();
    assert.equal(a.status, "running");
    const released = await second;
    assert.ok(!released.done);
    assert.equal(settledMessage(released.value), FIRST);
    assert.equal(a.status, "idle");

    const explicit = a.prompt("explicit");
    assert.equal(a.status, "running");
    const message = await explicit;
    assert.equal(message, SECOND);
    assert.equal(a.status, "pending");
    assert.equal(settledMessage(await stepOf(a)), message);
    assert.equal(a.status, "idle");

    // Two runs scripted: a third admission fails as exhausted instead of hanging.
    const exhausted = await rejection(a.prompt("third"));
    assert.ok(hasCode("invalid_state")(exhausted));
    assert.equal(a.status, "pending");
    assert.equal(failedError(await stepOf(a)), exhausted);
    assert.equal(a.status, "idle");
    assert.deepEqual(userTexts(a.history), ["staged", "explicit", "third"]);
    assert.deepEqual(requestTexts(a.requests), [["staged"], ["staged"], ["staged", "explicit"]]);
    assert.deepEqual(
      a.history.filter((message) => message.role === "assistant"),
      [FIRST, SECOND],
    );

    assert.equal(b.status, "ready");
    assert.deepEqual(b.history, []);
    assert.equal((await stepOf(b)).kind, "yield");
    assert.equal(settledMessage(await stepOf(b)), FIRST);
    assert.deepEqual(userTexts(b.history), ["staged"]);
  });

  test("a scripted event finishes before its boundary becomes visible", async () => {
    const DONE = assistant("done");
    const agent = new MockAgent({ runs: [run([settle(DONE, { events: [runStart] })])] });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const observed: string[] = [];
    agent.events.on("run_start", async () => {
      assert.equal(agent.history.at(-1), DONE);
      entered.resolve();
      await gate.promise;
    });
    const settled = agent.prompt("go").then((message) => {
      observed.push("run");
      return message;
    });
    const step = agent.next().then((result) => {
      observed.push("next");
      return result;
    });
    await entered.promise;
    assert.equal(agent.status, "running");
    assert.deepEqual(observed, []);
    gate.resolve();
    const result = await step;
    assert.equal(await settled, DONE);
    assert.ok(!result.done);
    assert.equal(settledMessage(result.value), DONE);
  });

  test("queued demands receive boundaries in order and an idle demand waits for later work", async () => {
    const LATER = assistant("later");
    const agent = new MockAgent({ prompt: "go", runs: [yieldsThen(1, "staged done"), run([settle(LATER)])] });
    const order: string[] = [];
    const record = (name: string) => (result: IteratorResult<AgenticStep, void>) => {
      order.push(`${name}:${result.done ? "done" : result.value.kind}`);
      return result;
    };
    const d1 = agent.next().then(record("d1"));
    const d2 = agent.next().then(record("d2"));
    const d3 = agent.next().then(record("d3"));
    await d2;
    assert.deepEqual(order, ["d1:yield", "d2:settled"]);
    assert.equal(agent.status, "idle");

    const message = await agent.prompt("more");
    const late = await d3;
    assert.ok(!late.done);
    assert.equal(settledMessage(late.value), message);
    assert.equal(message, LATER);
    assert.deepEqual(order, ["d1:yield", "d2:settled", "d3:settled"]);
    await d1;
  });

  test("an active run rejects admission without consuming the script; an unread terminal does not", async () => {
    const ONE = assistant("one");
    const TWO = assistant("two");
    const agent = new MockAgent({ runs: [yieldsThen(1, "x"), run([settle(ONE)]), run([settle(TWO)])] });
    const held = agent.prompt("hold");
    assert.ok(hasCode("busy")(await rejection(agent.prompt("overlap"))));
    assert.equal((await stepOf(agent)).kind, "yield");
    assert.ok(hasCode("busy")(await rejection(agent.skill("overlap"))));
    assert.equal(settledMessage(await stepOf(agent)), await held);

    assert.equal(await agent.prompt("one"), ONE);
    assert.equal(agent.status, "pending");
    assert.equal(await agent.prompt("two"), TWO);
    assert.equal(settledMessage(await stepOf(agent)), ONE);
    assert.equal(settledMessage(await stepOf(agent)), TWO);
    assert.deepEqual(userTexts(agent.history), ["hold", "one", "two"]);
  });

  test("a scripted failure is the identical error on the run promise and the iterator", async () => {
    const error = new Error("scripted");
    const agent = new MockAgent({ runs: [run([pause([reason("first", "y1")]), { step: failed(error) }])] });
    const outcome = rejection(agent.prompt("go"));
    assert.equal((await stepOf(agent)).kind, "yield");
    assert.equal(failedError(await stepOf(agent)), error);
    assert.equal(await outcome, error);
    assert.equal(agent.status, "idle");
  });
});

describe("tools, resources and configuration", () => {
  const tool = (name: string): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: () => Promise.reject(new Error("MockAgent never executes tools")),
  });
  const model = (id: string): Model<Api> => ({
    id,
    name: id,
    api: "mock",
    provider: "mock",
    baseUrl: "",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1000,
    maxTokens: 100,
  });
  const skill = (content: string): Skill => ({ name: "review", description: "review", content, filePath: "/skills/review/SKILL.md" });
  const template = (content: string): PromptTemplate => ({ name: "greet", content });

  test("configuration mutated during a held run reaches the next request and later resource runs", async () => {
    const READ = tool("read");
    const WRITE = tool("write");
    const SEARCH = tool("search");
    const MOCK_A = model("mock-a");
    const MOCK_B = model("mock-b");
    const SKILL_DONE = assistant("skill done");
    const TEMPLATE_DONE = assistant("template done");
    const agent = new MockAgent({
      tools: [READ, WRITE],
      resources: { skills: [skill("v1 skill")], promptTemplates: [template("v1 $1")] },
      models: [MOCK_A, MOCK_B],
      model: { provider: "mock", modelId: "mock-a" },
      runs: [yieldsThen(1, "configured"), run([settle(SKILL_DONE)]), run([settle(TEMPLATE_DONE)])],
    });
    assert.deepEqual(
      agent.getActiveTools().map((t) => t.name),
      ["read", "write"],
    );
    agent.getTools().push(SEARCH);
    assert.deepEqual(agent.getTools(), [READ, WRITE]);
    assert.equal(await agent.getModel(), MOCK_A);
    assert.equal(await agent.getThinkingLevel(), "off");

    const configured = agent.prompt("configure");
    assert.equal((await stepOf(agent)).kind, "yield");
    assert.equal(agent.status, "suspended");

    for (const invalid of [
      () => agent.setTools([READ, READ]),
      () => agent.setTools([READ, WRITE], ["read", "read"]),
      () => agent.setTools([READ], ["write"]),
      () => agent.setActiveTools(["missing"]),
      () => agent.setActiveTools(["write", "write"]),
    ]) {
      assert.ok(hasCode("invalid_argument")(await rejection(invalid())));
    }
    assert.deepEqual(agent.getTools(), [READ, WRITE]);
    assert.deepEqual(agent.getActiveTools(), [READ, WRITE]);
    await agent.setActiveTools(["write"]);
    assert.deepEqual(agent.getActiveTools(), [WRITE]);

    await agent.setTools([READ, WRITE, SEARCH], ["search", "read"]);
    await agent.setModel({ provider: "mock", modelId: "absent" });
    assert.equal(await agent.getModel(), undefined);
    await agent.setModel({ provider: "mock", modelId: "mock-b" });
    await agent.setThinkingLevel("high");
    const streamOptions = { maxRetries: 2, headers: { "x-mock": "1" } };
    await agent.setStreamOptions(streamOptions);
    const resources = { skills: [skill("v2 skill")], promptTemplates: [template("v2 hello $1")] };
    await agent.setResources(resources);
    assert.equal(agent.status, "suspended");
    assert.deepEqual(agent.getActiveTools(), [SEARCH, READ]);
    assert.equal(await agent.getModel(), MOCK_B);
    assert.equal(await agent.getThinkingLevel(), "high");
    assert.equal(agent.getResources(), resources);

    assert.equal(settledMessage(await stepOf(agent)), await configured);
    const [before, after] = agent.requests;
    assert.ok(before !== undefined && after !== undefined);
    assert.deepEqual(
      [before.model, before.thinkingLevel, before.tools, before.streamOptions],
      [MOCK_A, "off", [READ, WRITE], {}],
    );
    assert.equal(after.model, MOCK_B);
    assert.equal(after.thinkingLevel, "high");
    assert.deepEqual(after.tools, [SEARCH, READ]);
    assert.equal(after.streamOptions, streamOptions);

    // Unknown resources fail through a boundary, consuming neither a run nor queued next-turn input.
    await agent.nextTurn("context first");
    for (const unknown of [() => agent.skill("missing"), () => agent.promptFromTemplate("missing", ["x"])]) {
      const error = await rejection(unknown());
      assert.ok(hasCode("invalid_argument")(error));
      assert.equal(failedError(await stepOf(agent)), error);
    }
    assert.equal(agent.requests.length, 2);

    assert.equal(await agent.skill("review", "focus"), SKILL_DONE);
    const skillPrompt = formatSkillInvocation(resources.skills[0]!, "focus");
    assert.deepEqual(requestTexts(agent.requests).at(-1)?.slice(-2), ["context first", skillPrompt]);
    assert.ok(skillPrompt.includes("v2 skill"));

    assert.equal(await agent.promptFromTemplate("greet", ["Ada"]), TEMPLATE_DONE);
    const templatePrompt = formatPromptTemplateInvocation(resources.promptTemplates[0]!, ["Ada"]);
    assert.equal(templatePrompt, "v2 hello Ada");
    assert.equal(requestTexts(agent.requests).at(-1)?.at(-1), templatePrompt);
    await agent.return();
  });
});

describe("queues and conversation controls", () => {
  test("drain points follow queue modes, and next-turn input reaches only the next run before its prompt", async () => {
    const DRAINED = assistant("drained");
    const AGAIN = assistant("again done");
    const note = user("note", 7);
    const steerImage = image("steer");
    const followImage = image("follow");
    const promptImage = image("prompt");
    const agent = new MockAgent({
      runs: [
        run([
          pause([reason("hold", "y1")], { drain: ["steer", "followUp"] }),
          settle(DRAINED, { drain: ["steer", "followUp"] }),
        ]),
        run([settle(AGAIN, { drain: ["steer", "followUp"] })]),
      ],
    });
    await agent.appendMessage(note);
    assert.equal(agent.status, "idle");
    await agent.steer("s1", { images: [steerImage] });
    await agent.steer("s2");
    await agent.followUp("f1");
    await agent.followUp("f2", { images: [followImage] });
    await agent.nextTurn("n1");
    assert.deepEqual(agent.requests, []);
    assert.equal(agent.history.at(-1), note);

    const first = agent.prompt("work", { images: [promptImage] });
    assert.equal((await stepOf(agent)).kind, "yield");
    assert.deepEqual(requestTexts(agent.requests), [["note", "n1", "work", "s1", "f1"]]);

    await agent.setSteeringMode("all");
    await agent.setFollowUpMode("all");
    assert.equal(settledMessage(await stepOf(agent)), await first);
    assert.deepEqual(requestTexts(agent.requests)[1], ["note", "n1", "work", "s1", "f1", "s2", "f2"]);

    await agent.nextTurn("n2");
    assert.equal(await agent.prompt("again"), AGAIN);
    assert.deepEqual(userTexts(agent.history), ["note", "n1", "work", "s1", "f1", "s2", "f2", "n2", "again"]);
    assert.equal(agent.history[0], note);
    assert.deepEqual(imagesOf(userMessage(agent, "s1")), [steerImage]);
    assert.equal(imagesOf(userMessage(agent, "s1"))[0], steerImage);
    assert.equal(imagesOf(userMessage(agent, "f2"))[0], followImage);
    assert.equal(imagesOf(userMessage(agent, "work"))[0], promptImage);
  });

  test("idle abort returns undelivered steering and follow-ups and keeps next-turn input", async () => {
    const AFTER = assistant("after");
    const steerImage = image("a");
    const agent = new MockAgent({
      followUpMode: "all",
      steeringMode: "all",
      runs: [run([settle(AFTER, { drain: ["steer", "followUp"] })])],
    });
    await agent.steer("a", { images: [steerImage] });
    await agent.steer("b");
    await agent.followUp("c");
    await agent.followUp("d");
    await agent.nextTurn("kept");
    const { clearedSteer, clearedFollowUp } = await agent.abort();
    assert.deepEqual(userTexts(clearedSteer), ["a", "b"]);
    assert.equal(imagesOf(clearedSteer[0])[0], steerImage);
    assert.deepEqual(userTexts(clearedFollowUp), ["c", "d"]);
    assert.equal(agent.status, "idle");

    assert.equal(await agent.prompt("after"), AFTER);
    assert.deepEqual(requestTexts(agent.requests), [["kept", "after"]]);
  });
});

describe("subscriptions, hooks and cancellation", () => {
  test("hooks run in registration order with the run Context; ids do not deduplicate and removal is idempotent", async () => {
    const DONE = assistant("done");
    const endHook: MockHook = {
      name: "before_run_end",
      event: { runId: "r1", messages: [], lane: "main" },
      results: [{ followUp: "more" }, undefined],
    };
    const agent = new MockAgent({ runs: [run([settle(DONE, { hooks: [endHook] })])] });
    const seen: { readonly name: string; readonly event: unknown; readonly context: Context }[] = [];
    agent.hooks.on(
      "before_run_end",
      (event, context) => {
        seen.push({ name: "first", event, context });
        return { followUp: "more" };
      },
      { id: "same" },
    );
    const remove = agent.hooks.on("before_run_end", () => ({ followUp: "stale" }), { id: "removed" });
    agent.hooks.on(
      "before_run_end",
      (event, context) => {
        seen.push({ name: "second", event, context });
        return undefined;
      },
      { id: "same" },
    );
    remove();
    remove();

    assert.equal(await agent.prompt("go"), DONE);
    assert.deepEqual(
      seen.map((entry) => entry.name),
      ["first", "second"],
    );
    assert.ok(seen.every((entry) => entry.event === endHook.event && entry.context === seen[0]!.context));
    assert.equal(seen[0]!.context.abortSignal?.aborted, false);
    assert.deepEqual(agent.hookResults, [{ name: "before_run_end", results: [{ followUp: "more" }, undefined] }]);
  });

  test("an unexpected hook result or a hook rejection fails the run", async () => {
    const expecting: MockHook = {
      name: "before_run_end",
      event: { runId: "r1", messages: [], lane: "main" },
      results: [{ followUp: "more" }],
    };
    const agent = new MockAgent({
      runs: [run([settle(assistant("unreached"), { hooks: [expecting] })]), run([settle(assistant("x"), { hooks: [expecting] })])],
    });
    const remove = agent.hooks.on("before_run_end", () => ({ followUp: "other" }));
    const mismatch = await rejection(agent.prompt("go"));
    assert.ok(hasCode("invalid_state")(mismatch));
    assert.equal(failedError(await stepOf(agent)), mismatch);
    assert.deepEqual(agent.hookResults, [{ name: "before_run_end", results: [{ followUp: "other" }] }]);
    assert.deepEqual(agent.requests, []);

    remove();
    const thrown = new Error("hook failed");
    agent.hooks.on("before_run_end", () => {
      throw thrown;
    });
    assert.equal(await rejection(agent.prompt("again")), thrown);
    assert.equal(failedError(await stepOf(agent)), thrown);
  });

  test("a failing passive listener is recorded without suppressing later listeners or the terminal", async () => {
    const DONE = assistant("done");
    const agent = new MockAgent({ runs: [run([settle(DONE, { events: [runStart, runResume] })])] });
    const boom = new Error("listener failed");
    const log: string[] = [];
    let listenerContext: Context | undefined;
    agent.events.on("run_start", () => {
      log.push("failing");
      throw boom;
    });
    agent.events.on("run_start", (event, context) => {
      assert.equal(event, runStart);
      listenerContext = context;
      log.push(`start:${event.startedAt}`);
    });
    const remove = agent.events.on("run_start", () => {
      log.push("removed");
    });
    remove();
    remove();
    agent.events.on("run_resume", (event) => {
      log.push(`resume:${event.runId}`);
    });

    assert.equal(await agent.prompt("go"), DONE);
    assert.equal(settledMessage(await stepOf(agent)), DONE);
    assert.deepEqual(log, ["failing", "start:0", "resume:r1"]);
    assert.deepEqual(agent.listenerErrors, [boom]);
    assert.equal(listenerContext?.abortSignal?.aborted, false);
  });

  test("abort cancels a hook barrier, joins it, publishes only the interrupted terminal and stays reusable", async () => {
    const AFTER = assistant("after");
    const hook = barrier();
    const agent = new MockAgent({ runs: [barrierRun(), run([settle(AFTER)])] });
    const removeHook = agent.hooks.on("before_drive", hook.handler);
    const interrupted = agent.prompt("go");
    const context = await hook.entered;
    assert.equal(context.abortSignal?.aborted, false);

    const cleared = await agent.abort();
    assert.deepEqual(cleared, { clearedSteer: [], clearedFollowUp: [] });
    assert.ok(hook.exited());
    assert.equal(context.abortSignal?.aborted, true);
    assert.equal(await interrupted, INTERRUPTED);
    assert.equal(agent.status, "pending");
    assert.equal(settledMessage(await stepOf(agent)), INTERRUPTED);
    assert.equal(agent.status, "idle");
    assert.deepEqual(agent.requests, []);
    assert.deepEqual(userTexts(agent.history), ["go", "cancelled note"]);
    assert.equal(agent.history.filter((message) => message === INTERRUPTED).length, 1);

    removeHook();
    assert.equal(await agent.prompt("again"), AFTER);
  });

  test("abort of a held yield skips the remaining frames", async () => {
    const agent = new MockAgent({ prompt: "go", runs: [yieldsThen(2, "unreached")] });
    assert.equal((await stepOf(agent)).kind, "yield");
    await agent.abort();
    assert.equal(settledMessage(await stepOf(agent)), ABORTED_MESSAGE);
    assert.equal(agent.status, "idle");
    assert.equal(agent.requests.length, 1);
  });

  test("abort is single-flight, joins dependents and propagates their failure after cancelling the run", async () => {
    const release = Promise.withResolvers<void>();
    const dependentFailure = new Error("dependent abort failed");
    let onAbort = (): Promise<void> | undefined => release.promise;
    const hook = barrier();
    const agent = new Owner({ runs: [barrierRun()] }, { onAbort: () => onAbort() });
    agent.hooks.on("before_drive", hook.handler);

    const first = agent.abort();
    assert.ok(hasCode("busy")(await rejection(agent.abort())));
    assert.ok(hasCode("busy")(await rejection(agent.prompt("during abort"))));
    let joined = false;
    const settledFirst = first.then((value) => {
      joined = true;
      return value;
    });
    assert.equal(joined, false);
    release.resolve();
    await settledFirst;

    onAbort = () => Promise.reject(dependentFailure);
    const interrupted = agent.prompt("go");
    await hook.entered;
    assert.equal(await rejection(agent.abort()), dependentFailure);
    assert.ok(hook.exited());
    assert.equal(await interrupted, INTERRUPTED);
    assert.equal(agent.aborts, 2);
    assert.equal(agent.closes, 0);
  });

  test("return interrupts and joins work, delivers queued terminals, then finishes every demand once", async () => {
    const hook = barrier();
    const agent = new Owner({ runs: [barrierRun()] });
    agent.hooks.on("before_drive", hook.handler);
    const waiting = agent.next();
    const extra = agent.next();
    const interrupted = agent.prompt("go");
    await hook.entered;

    const closing = agent.return();
    assert.equal(agent.status, "closed");
    const again = agent.return();
    assert.deepEqual(await closing, { value: undefined, done: true });
    assert.deepEqual(await again, { value: undefined, done: true });
    assert.ok(hook.exited());
    assert.equal(agent.closes, 1);
    assert.equal(agent.aborts, 0);

    const delivered = await waiting;
    assert.ok(!delivered.done);
    assert.equal(settledMessage(delivered.value), INTERRUPTED);
    assert.equal(await interrupted, INTERRUPTED);
    assert.deepEqual(await extra, { value: undefined, done: true });
    assert.deepEqual(await agent.next(), { value: undefined, done: true });
    assert.deepEqual(await agent.return(), { value: undefined, done: true });
    assert.equal(agent.closes, 1);
  });

  test("a closed agent rejects every async command and subscription but keeps synchronous getters", async () => {
    const READ: AgentTool = {
      name: "read",
      label: "read",
      description: "read",
      parameters: Type.Object({}),
      execute: () => Promise.reject(new Error("never")),
    };
    const resources = { skills: [] };
    const agent = new MockAgent({ prompt: "never", tools: [READ], resources, history: [user("kept")], runs: [] });
    await agent.return();
    assert.equal(agent.status, "closed");
    const commands: (() => Promise<unknown>)[] = [
      () => agent.prompt("x"),
      () => agent.skill("x"),
      () => agent.promptFromTemplate("x"),
      () => agent.steer("x"),
      () => agent.followUp("x"),
      () => agent.nextTurn("x"),
      () => agent.appendMessage(user("x")),
      () => agent.abort(),
      () => agent.setTools([READ]),
      () => agent.setActiveTools([]),
      () => agent.setResources({}),
      () => agent.setModel({ provider: "mock", modelId: "mock-a" }),
      () => agent.getModel(),
      () => agent.setThinkingLevel("low"),
      () => agent.getThinkingLevel(),
      () => agent.setStreamOptions({}),
      () => agent.setSteeringMode("all"),
      () => agent.setFollowUpMode("all"),
      () => agent.context_size(),
      () => agent.compact(),
      () => agent.navigateTree("x"),
    ];
    for (const command of commands) assert.ok(hasCode("closed")(await rejection(command())));
    assert.throws(() => agent.events.on("run_start", () => {}), hasCode("closed"));
    assert.throws(() => agent.hooks.on("before_drive", () => undefined), hasCode("closed"));
    assert.deepEqual(agent.getTools(), [READ]);
    assert.deepEqual(agent.getActiveTools(), [READ]);
    assert.equal(agent.getResources(), resources);
    assert.deepEqual(userTexts(agent.history), ["kept"]);
    assert.deepEqual(agent.requests, []);
    assert.deepEqual(await agent.next(), { value: undefined, done: true });
  });

  test("for-await early exit closes the agent and interrupts its held run", async () => {
    const agent = new MockAgent({ prompt: "go", runs: [yieldsThen(2, "unreached")] });
    const kinds: string[] = [];
    for await (const step of agent) {
      kinds.push(step.kind);
      break;
    }
    assert.deepEqual(kinds, ["yield"]);
    assert.equal(agent.status, "closed");
    assert.equal(agent.requests.length, 1);
    assert.equal(agent.history.at(-1), ABORTED_MESSAGE);
    assert.deepEqual(await agent.next(), { value: undefined, done: true });
  });

  test("throw closes and rejects the original error, aggregating a close failure after it", async () => {
    const original = new Error("thrown in");
    const plain = new MockAgent({ prompt: "never", runs: [] });
    assert.equal(await rejection(plain.throw(original)), original);
    assert.equal(plain.status, "closed");
    assert.deepEqual(await plain.next(), { value: undefined, done: true });

    const closeFailure = new Error("close failed");
    const failing = new Owner({ runs: [] }, { onClose: () => Promise.reject(closeFailure) });
    const aggregate = await rejection(failing.throw(original));
    assert.ok(aggregate instanceof AggregateError);
    assert.equal(aggregate.errors[0], original);
    assert.ok(aggregate.errors.includes(closeFailure));
    assert.equal(failing.closes, 1);
  });

  test("async disposal closes the agent", async () => {
    const owner = new Owner({ prompt: "never", runs: [] });
    {
      await using agent = owner;
      assert.equal(agent.status, "ready");
    }
    assert.equal(owner.status, "closed");
    assert.equal(owner.closes, 1);
    assert.deepEqual(await owner.next(), { value: undefined, done: true });
  });

  test("a close failure rejects waiting demands only after queued terminals are delivered", async () => {
    const closeFailure = new Error("close failed");
    const hook = barrier();
    const agent = new Owner({ runs: [barrierRun()] }, { onClose: () => Promise.reject(closeFailure) });
    agent.hooks.on("before_drive", hook.handler);
    const order: string[] = [];
    const first = agent.next().then((result) => {
      order.push("first");
      return result;
    });
    const second = rejection(agent.next()).then((error) => {
      order.push("second");
      return error;
    });
    const interrupted = agent.prompt("go");
    await hook.entered;

    const failure = await rejection(agent.return());
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [closeFailure]);
    const delivered = await first;
    assert.ok(!delivered.done);
    assert.equal(settledMessage(delivered.value), INTERRUPTED);
    assert.equal(await second, failure);
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(await interrupted, INTERRUPTED);
    assert.deepEqual(await agent.next(), { value: undefined, done: true });
  });
});

describe("maintenance and transcript validation", () => {
  test("compaction and navigation replay scripted outcomes, replacing history only on success", async () => {
    const summaryFailed = new Error("summary failed");
    const missing = new UnknownTarget({ targetId: "missing", message: "unknown target" });
    const compactFailure: MockMaintenance = { method: "compact", args: [], result: { ok: false, error: summaryFailed } };
    const compactSuccess: MockMaintenance = {
      method: "compact",
      args: [{ customInstructions: "focus" }],
      result: { ok: true },
      history: [user("summary")],
      tipId: "summary",
    };
    const navigateFailure: MockMaintenance = {
      method: "navigateTree",
      args: ["missing"],
      result: { ok: false, error: missing },
    };
    const navigateSuccess: MockMaintenance = {
      method: "navigateTree",
      args: ["branch-1", { summarize: false }],
      result: {
        ok: true,
        value: {
          navigation: {
            operationId: "navigate-1",
            kind: "navigation",
            status: "completed",
            fromTipId: "summary",
            tipId: "branch-1",
            startedAt: 2,
            endedAt: 3,
          },
        },
      },
      history: [user("branch start")],
      tipId: "branch-1",
    };
    const nothingToCompact: MockMaintenance = { method: "compact", args: [], result: { ok: true } };
    const agent = new MockAgent({
      history: [user("discarded".repeat(4))],
      maintenance: [compactFailure, compactSuccess, navigateFailure, navigateSuccess, nothingToCompact],
      runs: [run([settle(assistant("after compact"))]), run([settle(assistant("after navigation"))])],
    });
    assert.equal(await agent.context_size(), 9);

    // Mismatches consume nothing.
    assert.ok(hasCode("invalid_state")(await rejection(agent.navigateTree("branch-1"))));
    assert.ok(hasCode("invalid_state")(await rejection(agent.compact({ customInstructions: "focus" }))));

    assert.equal(await rejection(agent.compact()), summaryFailed);
    assert.deepEqual(userTexts(agent.history), ["discarded".repeat(4)]);
    assert.equal(await agent.context_size(), 9);
    assert.equal(agent.tipId, null);

    // The options object is captured when the request is made.
    const options = { customInstructions: "focus" };
    const compacted = agent.compact(options);
    options.customInstructions = "changed";
    assert.equal(await compacted, undefined);
    assert.equal(agent.tipId, "summary");
    assert.equal(await agent.context_size(), estimateTokens(user("summary")));
    await agent.prompt("next");
    assert.deepEqual(requestTexts(agent.requests), [["summary", "next"]]);

    const unknown = await agent.navigateTree("missing");
    assert.ok(!unknown.ok);
    assert.equal(unknown.error, missing);
    assert.deepEqual(userTexts(agent.history), ["summary", "next"]);
    assert.equal(agent.tipId, "summary");

    // Navigation is structural only: next-turn input waits for the next explicit prompt.
    await agent.nextTurn("queued");
    assert.equal(await agent.navigateTree("branch-1", { summarize: false }), navigateSuccess.result);
    assert.equal(agent.tipId, "branch-1");
    assert.equal(agent.requests.length, 1);
    assert.deepEqual(userTexts(agent.history), ["branch start"]);
    await agent.prompt("continue");
    assert.deepEqual(requestTexts(agent.requests)[1], ["branch start", "queued", "continue"]);

    const before = agent.history;
    assert.equal(await agent.compact(), undefined);
    assert.deepEqual(agent.history, before);
    assert.ok(hasCode("invalid_state")(await rejection(agent.compact())));
  });

  test("compaction waits for the admitted run and delays a staged prompt; new runs are busy", async () => {
    const compacted: MockMaintenance = { method: "compact", args: [], result: { ok: true }, history: [user("x")] };
    const agent = new MockAgent({
      prompt: "go",
      history: [user("old history")],
      maintenance: [compacted, compacted],
      runs: [yieldsThen(1, "first done"), run([settle(assistant("unused"))])],
    });
    assert.equal((await stepOf(agent)).kind, "yield");
    const first = agent.compact();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(userTexts(agent.history), ["old history", "go"]);
    assert.ok(hasCode("busy")(await rejection(agent.prompt("late"))));
    assert.ok(hasCode("busy")(await rejection(agent.navigateTree("x"))));
    // The held yield still resumes; compaction follows its terminal without consuming it.
    assert.equal(textOf(settledMessage(await stepOf(agent))), "first done");
    assert.equal(await first, undefined);
    assert.deepEqual(userTexts(agent.history), ["x"]);
    assert.equal(await agent.context_size(), 1);

    const staged = new MockAgent({
      prompt: "staged",
      history: [user("old history")],
      maintenance: [compacted],
      runs: [run([settle(assistant("staged done"))])],
    });
    const queued = staged.compact();
    const demand = stepOf(staged);
    assert.equal(await queued, undefined);
    assert.equal(textOf(settledMessage(await demand)), "staged done");
    assert.deepEqual(requestTexts(staged.requests), [["x", "staged"]]);

    const closing = new MockAgent({ prompt: "go", maintenance: [compacted], runs: [yieldsThen(1, "unreached")] });
    assert.equal((await stepOf(closing)).kind, "yield");
    const rejected = closing.compact();
    await closing.return();
    assert.ok(hasCode("closed")(await rejection(rejected)));
    assert.ok(!userTexts(closing.history).includes("x"));
  });

  test("construction rejects malformed runs; an empty run list is an idle member", () => {
    const done = settle(assistant("done"));
    const yielding = pause([reason("hold", "y1")]);
    const malformed: MockRun[] = [
      run([]),
      run([yielding]),
      run([done, yielding]),
      run([done, done]),
      run([done], { step: { kind: "yield", reasons: [] } } as unknown as MockRun["interrupted"]),
    ];
    for (const script of malformed) {
      assert.throws(() => new MockAgent({ runs: [script] }), hasCode("invalid_argument"));
    }
    assert.throws(() => new MockAgent({ tools: [], activeToolNames: ["missing"], runs: [] }), hasCode("invalid_argument"));
    assert.equal(new MockAgent({ runs: [] }).status, "idle");
  });
});
