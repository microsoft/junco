import { test } from "bun:test";
import assert from "node:assert/strict";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { always, NodeId } from "dataflow-engine";
import { type Agentic, type AgenticOptions, JuncoAgent, JuncoAgentError } from "junco-agent";
import { agentNode, attachAgency } from "../src/index.ts";
import {
  agencyGraph,
  drive,
  flushMacrotasks,
  leaf,
  nativeOptions,
  newScheduler,
  runAvailable,
  type Script,
  scheduleCall,
  settledText,
  waitingTool,
} from "./support.ts";

const TIMEOUT_MS = 30_000;
const quiet = { receive: () => [], emit: () => [] } as const;
const toolTurn = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const member = (agent: Agentic, description = "member") =>
  agentNode(agent, { description, trigger: always(), ...quiet });

/** An agency over `members`, planned by `script`, staged with a prompt unless `idle`. */
async function agency(members: readonly Agentic[], script: Script = runAvailable, { idle = false } = {}) {
  const { graph, scheduler, faux } = await agencyGraph(script, idle ? {} : { prompt: "run the graph" });
  for (const [index, agent] of members.entries()) graph.addNode(member(agent, `member ${index}`));
  return { agency: attachAgency(graph), graph, scheduler, faux };
}

/** Planned lanes for the first requests, then every available member. */
const plan =
  (...lanes: string[][][]): Script =>
  (info, request) =>
    request < lanes.length ? { lanes: lanes[request]! } : runAvailable(info);

const invalidArgument = (error: unknown) => error instanceof JuncoAgentError && error.code === "invalid_argument";

test("attachment validates the whole membership before claiming any of it", async () => {
  const shared = await leaf([fauxAssistantMessage("shared")], { prompt: "go" });

  const withRaw = await agencyGraph([]);
  const raw = await newScheduler([]);
  withRaw.graph.addNode(member(shared.agent));
  withRaw.graph.addNode(member(raw.scheduler));
  assert.throws(() => attachAgency(withRaw.graph), invalidArgument);

  const withOwnScheduler = await agencyGraph([]);
  withOwnScheduler.graph.addNode(member(withOwnScheduler.scheduler));
  assert.throws(() => attachAgency(withOwnScheduler.graph), invalidArgument);

  const duplicate = await agencyGraph([]);
  duplicate.graph.addNode(member(shared.agent));
  duplicate.graph.addNode(member(shared.agent));
  assert.throws(() => attachAgency(duplicate.graph), invalidArgument);

  const handWritten = await agencyGraph([]);
  handWritten.graph.addNode({
    state: shared.agent,
    trigger: always(),
    step: async function* () {
      return fauxAssistantMessage("unused");
    },
  });
  assert.throws(() => attachAgency(handWritten.graph), invalidArgument);

  const pending = await leaf([fauxAssistantMessage("old")]);
  await pending.agent.prompt("an unread old run");
  assert.equal(pending.agent.status, "pending");
  const withPending = await agencyGraph([]);
  withPending.graph.addNode(member(pending.agent));
  assert.throws(() => attachAgency(withPending.graph), invalidArgument);

  // Every rejection above claimed nothing: the shared member still joins one agency, and only one.
  const first = await agencyGraph([]);
  first.graph.addNode(member(shared.agent));
  attachAgency(first.graph);
  assert.throws(() => attachAgency(first.graph), invalidArgument);
  const second = await agencyGraph([]);
  second.graph.addNode(member(shared.agent));
  assert.throws(() => attachAgency(second.graph), invalidArgument);
});

test("an attached child cannot be adopted through its scheduler alias or claim a failed parent's other member", async () => {
  const shared = await leaf([fauxAssistantMessage("shared child")], { prompt: "go" });
  const free = await leaf([fauxAssistantMessage("free child")], { prompt: "go" });
  const child = await agencyGraph(runAvailable, { prompt: "run child" });
  const parentA = await agencyGraph(runAvailable, { prompt: "run parent A" });
  const parentB = await agencyGraph([]);
  const separate = await agencyGraph(runAvailable, { prompt: "run separate" });
  try {
    child.graph.addNode(member(shared.agent));
    const childAgency = attachAgency(child.graph);
    assert.equal(childAgency, child.graph.scheduler);
    parentA.graph.addNode(member(childAgency));
    const root = attachAgency(parentA.graph);
    assert.equal(root, parentA.scheduler);

    parentB.graph.addNode(member(free.agent));
    parentB.graph.addNode(member(child.graph.scheduler));
    assert.throws(() => attachAgency(parentB.graph), invalidArgument);
    separate.graph.addNode(member(free.agent));
    assert.equal(attachAgency(separate.graph), separate.scheduler);

    assert.equal(settledText((await drive(root)).last), "shared child");
    assert.equal(settledText((await drive(separate.scheduler)).last), "free child");
    await root.return();
    assert.equal(childAgency.status, "closed");
    assert.equal(shared.agent.status, "closed");
  } finally {
    const failures: unknown[] = [];
    for (const actor of [parentA.scheduler, parentB.scheduler, separate.scheduler, child.scheduler, shared.agent, free.agent]) {
      try {
        await actor.return();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Failed to close attachment test actors");
  }
});

test("a graph changed after attachment is rejected before it is scheduled again", async () => {
  const original = await leaf([fauxAssistantMessage("original")], { prompt: "go" });
  const late = await leaf([fauxAssistantMessage("late")], { prompt: "go" });
  const { agency: root, graph } = await agency([original.agent], [
    toolTurn(scheduleCall([["0"]], "after-change")),
    fauxAssistantMessage("stopped"),
  ]);
  graph.addNode(member(late.agent));
  const errors: boolean[] = [];
  root.events.on("tool_end", (event) => {
    errors.push(event.isError);
  });

  const { last } = await drive(root);
  assert.deepEqual(errors, [true]);
  assert.equal(graph.getNode(NodeId("0"))!.status, "ready");
  assert.ok(last.kind === "failed" && last.error instanceof JuncoAgentError && last.error.code === "invalid_state");
});

test(
  "thirty-two nested agencies deliver the innermost result",
  async () => {
    const innermost = await leaf([fauxAssistantMessage("deep")], { prompt: "go" });
    let current: Agentic = innermost.agent;
    for (let depth = 0; depth < 32; depth++) current = (await agency([current])).agency;

    const { last } = await drive(current);
    assert.equal(settledText(last), "deep");
    assert.equal(innermost.faux.state.callCount, 1);
    await current.return();
    assert.equal(innermost.agent.status, "closed");
  },
  TIMEOUT_MS,
);

test(
  "abort and close cascade through 4096 idle nested agencies without growing the stack",
  async () => {
    const innermost = await leaf([]);
    let current: Agentic = innermost.agent;
    for (let depth = 0; depth < 4096; depth++) current = (await agency([current], runAvailable, { idle: true })).agency;

    assert.deepEqual(await current.abort(), { clearedSteer: [], clearedFollowUp: [] });
    await current.return();
    assert.equal(current.status, "closed");
    assert.equal(innermost.agent.status, "closed");
  },
  TIMEOUT_MS * 4,
);

test(
  "a root abort reaches a live grandchild while its sibling still runs",
  async () => {
    const grandchildTool = waitingTool("grandchild_work", { endOnAbort: true });
    const grandchild = await leaf([toolTurn(fauxToolCall("grandchild_work", {}, { id: "g1" })), fauxAssistantMessage("unused")], {
      prompt: "go",
      tools: [grandchildTool.tool],
    });
    const siblingTool = waitingTool("sibling_work");
    const sibling = await leaf([toolTurn(fauxToolCall("sibling_work", {}, { id: "s1" })), fauxAssistantMessage("unused")], {
      prompt: "go",
      tools: [siblingTool.tool],
    });
    const child = await agency([grandchild.agent], plan([["0"]], [["0"]]));
    const { agency: root } = await agency([child.agency, sibling.agent], plan([["0"], ["1"]], [["0"]], [["0"], ["1"]]));
    let finalTurn: AssistantMessage | undefined;
    root.events.on("turn_end", ({ message }) => { finalTurn = message; });

    assert.equal((await root.next()).value?.kind, "yield"); // primes both members
    assert.equal((await root.next()).value?.kind, "yield"); // the child primes the grandchild
    const running = root.next(); // the child runs the grandchild while the sibling runs
    await Promise.all([grandchildTool.started, siblingTool.started]);

    let aborted = false;
    const aborting = root.abort().then((result) => {
      aborted = true;
      return result;
    });
    await grandchildTool.aborted;
    await siblingTool.aborted;
    await flushMacrotasks();
    assert.equal(aborted, false);
    siblingTool.release();
    assert.deepEqual(await aborting, { clearedSteer: [], clearedFollowUp: [] });
    const settled = (await running).value;
    assert.ok(settled?.kind === "settled" && finalTurn !== undefined);
    if (settled?.kind === "settled") assert.deepEqual(settled.message, finalTurn);
  },
  TIMEOUT_MS,
);

test(
  "a failing member abort never skips its gated sibling, and the root reports it",
  async () => {
    const failure = new Error("member abort failed");
    class FailingAbort extends JuncoAgent {
      static async make(options: AgenticOptions): Promise<FailingAbort> {
        const agent = new FailingAbort(options);
        await agent.initialize();
        return agent;
      }
      protected override abortDependents(): Promise<void> {
        return Promise.reject(failure);
      }
    }
    const failing = await FailingAbort.make({ ...(await nativeOptions([])).options, prompt: "go" });
    const siblingTool = waitingTool("sibling_work", { endOnAbort: true });
    const sibling = await leaf([toolTurn(fauxToolCall("sibling_work", {}, { id: "s1" })), fauxAssistantMessage("unused")], {
      prompt: "go",
      tools: [siblingTool.tool],
    });
    const { agency: root } = await agency([failing, sibling.agent], plan([["0"], ["1"]], [["1"]]));
    let finalTurn: AssistantMessage | undefined;
    root.events.on("turn_end", ({ message }) => { finalTurn = message; });

    assert.equal((await root.next()).value?.kind, "yield");
    const running = root.next();
    await siblingTool.started;

    const error = await root.abort().catch((thrown: unknown) => thrown);
    await siblingTool.aborted;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    const settled = (await running).value;
    assert.ok(settled?.kind === "settled" && finalTurn !== undefined);
    if (settled?.kind === "settled") assert.deepEqual(settled.message, finalTurn);
  },
  TIMEOUT_MS,
);

test(
  "closing a suspended root closes each member once, without aborting it, before the root is closed",
  async () => {
    const calls: string[] = [];
    class Counting extends JuncoAgent {
      static async make(options: AgenticOptions): Promise<Counting> {
        const agent = new Counting(options);
        await agent.initialize();
        return agent;
      }
      override abort() {
        calls.push("abort");
        return super.abort();
      }
      override return(value?: void | PromiseLike<void>) {
        calls.push("return");
        return super.return(value);
      }
    }
    const counted = await Counting.make({ ...(await nativeOptions([])).options });
    const grandchild = await leaf(
      [toolTurn(fauxToolCall("yield", { reason: "hold" }, { id: "y1" })), fauxAssistantMessage("unused")],
      { prompt: "go" },
    );
    const child = await agency([grandchild.agent], plan([["0"]], [["0"]]));
    const { agency: root } = await agency([child.agency, counted], plan([["0"]], [["0"]], [["0"]]));

    assert.equal((await root.next()).value?.kind, "yield");
    assert.equal((await root.next()).value?.kind, "yield");
    assert.equal((await root.next()).value?.kind, "yield");
    assert.equal(grandchild.agent.status, "suspended");
    assert.equal(root.status, "suspended");

    assert.deepEqual(await root.return(), { value: undefined, done: true });
    assert.deepEqual(calls, ["return"]);
    for (const agentic of [root, child.agency, grandchild.agent, counted]) assert.equal(agentic.status, "closed");
    assert.deepEqual(await root.next(), { value: undefined, done: true });
  },
  TIMEOUT_MS,
);
