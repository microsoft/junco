import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type ImageContent,
} from "@earendil-works/pi-ai";
import {
  always,
  DataflowNodeError,
  type Edge,
  from,
  messageEdge,
  msg,
  type NodeGenerator,
  type NodeIdType,
  when,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { createYieldTool, JuncoAgent, JuncoAgentError } from "junco-agent";
import {
  type AgenticInput,
  createParallelAgentGraph,
  Deterministic,
  deterministicNode,
  JuncoGraph,
} from "../src/index.ts";
import { ralph } from "../src/workflows/index.ts";
import { nativeOptions, waitingTool } from "./support.ts";

// The Ralph workflow over real native agents on faux models, inside real parent graphs. A dormant
// source stands in for the caller's upstream node and a recording sink for its downstream one.

const TIMEOUT_MS = 10_000;
const assignment = "Cover every section.\nKeep the original constraints.";
const prompt = (text: string): AgenticInput => ({ kind: "prompt", text });

/** What one provider request saw: every user and assistant text in its transcript, and offered tools. */
type Request = { readonly users: string[]; readonly assistants: string[]; readonly tools: string[] };
type Reply = string | AssistantMessage | (() => AssistantMessage);

function record(context: Context): Request {
  const users: string[] = [];
  const assistants: string[] = [];
  const tools: string[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      users.push(typeof message.content === "string" ? message.content : contentText(message.content));
    } else if (message.role === "assistant") {
      assistants.push(contentText(message.content));
    } else if (message.role === "system") {
      tools.push(...(message.toolsAdded?.map((tool) => tool.name) ?? []));
    }
  }
  return { users, assistants, tools };
}

/** A native agent answering `replies` in order and recording every request it serves. */
async function member(
  replies: readonly Reply[],
  { tools = [], staged }: { readonly tools?: readonly AgentTool[]; readonly staged?: string } = {},
) {
  const requests: Request[] = [];
  const { options } = await nativeOptions(replies.map((reply): FauxResponseStep => (context) => {
    requests.push(record(context));
    if (typeof reply === "string") return fauxAssistantMessage(reply);
    return typeof reply === "function" ? reply() : reply;
  }));
  const agent = await JuncoAgent.fromResolved({
    ...options,
    tools: [...tools],
    ...(staged === undefined ? {} : { prompt: staged }),
  });
  return { agent, requests };
}

/** The messages currently queued on message edge `edge`. */
const queued = (edge: Edge<AgenticInput, AssistantMessage>): AgenticInput[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

/** Step the graph until `done` holds; a bounded loop, so a regression fails instead of spinning. */
async function stepUntil(graph: Pick<JuncoGraph, "step">, done: () => boolean): Promise<void> {
  for (let windows = 0; windows < 64; windows++) {
    if (done()) return;
    await graph.step();
  }
  assert.ok(done(), "condition not reached within 64 graph windows");
}

const resultText = (graph: JuncoGraph, id: NodeIdType): string | undefined => {
  const result = graph.result(id);
  return O.isSome(result) ? contentText(result.value.content) : undefined;
};

/** `error` with every node-error wrapper removed. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (current instanceof DataflowNodeError) current = current.cause;
  return current;
}

let edges = 0;

/**
 * Register a Ralph over `agent` in `parent` between a dormant source and a recording sink. If
 * registration fails, the agent never became the graph's and is closed here.
 */
function attach(parent: JuncoGraph, agent: JuncoAgent, rounds?: number) {
  const tag = ++edges;
  const input = messageEdge<AgenticInput, AssistantMessage>(`source->ralph-${tag}`);
  const output = messageEdge<AgenticInput, AssistantMessage>(`ralph->sink-${tag}`);
  const sourceId = parent.addNode(deterministicNode(
    new Deterministic<AgenticInput, AssistantMessage>(async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
      while (true) yield [];
    }),
    { trigger: always(), is_available: () => false },
  ));
  const delivered: string[] = [];
  let sinkRuns = 0;
  const sinkId = parent.addNode(deterministicNode(
    new Deterministic<AgenticInput, AssistantMessage>(async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
      const view = yield [];
      sinkRuns++;
      for (const value of from(view, output)) delivered.push(value.kind === "appendMessage" ? "" : value.text);
      return fauxAssistantMessage("received");
    }),
    { trigger: when(output) },
  ));
  let id: NodeIdType;
  try {
    id = ralph(parent, agent, { input, output, ...(rounds === undefined ? {} : { rounds }) });
  } catch (error) {
    void agent.return();
    throw error;
  }
  parent.addEdge(sourceId, id, input).addEdge(id, sinkId, output);
  return {
    id,
    input,
    output,
    delivered,
    sinkRuns: () => sinkRuns,
    send: (...inputs: AgenticInput[]) => {
      for (const value of inputs) parent.emit(sourceId, msg(input, value));
    },
  };
}

const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

describe("ralph workflow", () => {
  test("runs two rounds by default and queues only the final draft on its completing step", async () => {
    await using parent = createParallelAgentGraph();
    const { agent, requests } = await member(["draft-1", "draft-2"]);
    const flow = attach(parent, agent);

    await parent.run();
    assert.equal(requests.length, 0);
    assert.ok(O.isNone(parent.result(flow.id)));
    assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);

    flow.send(prompt(assignment));
    await stepUntil(parent, () => requests.length === 1);
    assert.equal(requests[0]!.users.at(-1), assignment);
    assert.ok(O.isNone(parent.result(flow.id)));
    assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);

    for (let windows = 0; O.isNone(parent.result(flow.id)); windows++) {
      assert.ok(windows < 64, "Ralph did not complete within 64 graph windows");
      assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
      await parent.step();
    }
    // The completing activation both emitted and published its result: no extra step.
    assert.equal(resultText(parent, flow.id), "draft-2");
    assert.deepEqual(queued(flow.output), [prompt("draft-2")]);
    assert.deepEqual(flow.delivered, []);

    await parent.run();
    assert.deepEqual(flow.delivered, ["draft-2"]);
    assert.deepEqual([queued(flow.input), queued(flow.output)], [[], []]);
    await parent.run();
    assert.equal(requests.length, 2);
    assert.deepEqual(flow.delivered, ["draft-2"]);

    const second = requests[1]!;
    assert.equal(second.users.at(-1), revision("draft-1"));
    assert.deepEqual(second.users, [assignment, revision("draft-1")]);
    assert.deepEqual(second.assistants, ["draft-1"]);
    assert.deepEqual(requests.map((request) => request.tools), [[], []]);
  }, TIMEOUT_MS);

  for (const rounds of [1, 3]) {
    test(`rounds: ${rounds} runs exactly ${rounds} full rounds and publishes only the last`, async () => {
      await using parent = createParallelAgentGraph();
      const drafts = Array.from({ length: rounds }, (_, index) => `draft-${index + 1}`);
      const { agent, requests } = await member(drafts);
      const flow = attach(parent, agent, rounds);

      flow.send(prompt(assignment));
      for (let round = 1; round <= rounds; round++) {
        await stepUntil(parent, () => requests.length === round);
        if (round < rounds) assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
      }
      await parent.run();
      await parent.run();

      assert.equal(requests.length, rounds);
      assert.equal(resultText(parent, flow.id), drafts.at(-1));
      assert.deepEqual(flow.delivered, [drafts.at(-1)]);
      requests.forEach((request, index) => {
        const latest = request.users.at(-1)!;
        assert.ok(latest.startsWith(assignment));
        assert.equal(latest, index === 0 ? assignment : revision(drafts[index - 1]!));
        assert.deepEqual(request.assistants, drafts.slice(0, index));
      });
      if (rounds === 3) {
        const latest = requests[2]!.users.at(-1)!;
        assert.ok(latest.includes("draft-2") && !latest.includes("draft-1"));
        assert.deepEqual(requests[2]!.users, [assignment, revision("draft-1"), revision("draft-2")]);
      }
    }, TIMEOUT_MS);
  }

  test("an invalid round count throws before registering anything", async () => {
    await using parent = createParallelAgentGraph();
    const input = messageEdge<AgenticInput, AssistantMessage>("in");
    const output = messageEdge<AgenticInput, AssistantMessage>("out");
    const nodes = () => {
      const ids: NodeIdType[] = [];
      parent.forEachNode((id) => ids.push(id));
      return ids;
    };
    for (const rounds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const { agent, requests } = await member(["unused"]);
      try {
        const before = nodes();
        assert.throws(() => ralph(parent, agent, { input, output, rounds }), RangeError);
        assert.deepEqual(nodes(), before);
        assert.equal(requests.length, 0);
      } finally {
        await agent.return();
      }
    }
  }, TIMEOUT_MS);

  const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
  const malformed: ReadonlyArray<readonly [string, readonly AgenticInput[]]> = [
    ["two prompts in one batch", [prompt(assignment), prompt("another")]],
    ["a followUp instead of a prompt", [{ kind: "followUp", text: assignment }]],
    ["a prompt with images", [{ kind: "prompt", text: assignment, images: [image] }]],
  ];
  for (const [name, inputs] of malformed) {
    test(`rejects ${name} before any model work`, async () => {
      await using parent = createParallelAgentGraph();
      const { agent, requests } = await member(["draft-1", "draft-2"]);
      const flow = attach(parent, agent);

      flow.send(...inputs);
      await assert.rejects(parent.run(), DataflowNodeError);
      assert.equal(requests.length, 0);
      assert.ok(O.isNone(parent.result(flow.id)));
      assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
    }, TIMEOUT_MS);
  }

  test("a second assignment after the first round is rejected, not restarted", async () => {
    await using parent = createParallelAgentGraph();
    const { agent, requests } = await member(["draft-1", "draft-2", "draft-3"]);
    const flow = attach(parent, agent, 3);

    flow.send(prompt(assignment));
    await stepUntil(parent, () => requests.length === 1);
    flow.send(prompt("a replacement assignment"));
    await assert.rejects(parent.run(), DataflowNodeError);
    assert.equal(requests.length, 1);
    assert.ok(O.isNone(parent.result(flow.id)));
    assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
  }, TIMEOUT_MS);

  const failures: ReadonlyArray<readonly [string, readonly Reply[], number]> = [
    ["a thrown second request", ["draft-1", () => { throw new Error("second round failed"); }], 2],
    ["a whitespace-only final reply", ["draft-1", "  \n "], 2],
    ["a blank first round", [" ", "draft-2"], 1],
    ["a non-stop final reply", ["draft-1", fauxAssistantMessage("draft-2", { stopReason: "length" })], 2],
  ];
  for (const [name, replies, attempted] of failures) {
    test(`${name} rejects without publishing an earlier draft`, async () => {
      await using parent = createParallelAgentGraph();
      const { agent, requests } = await member(replies);
      const flow = attach(parent, agent);

      flow.send(prompt(assignment));
      await assert.rejects(parent.run(), DataflowNodeError);
      await parent.run().catch(() => undefined);
      assert.equal(requests.length, attempted);
      assert.ok(O.isNone(parent.result(flow.id)));
      assert.deepEqual([queued(flow.output), flow.delivered, flow.sinkRuns()], [[], [], 0]);
    }, TIMEOUT_MS);
  }

  test("native yields resume within a round and never count as one", async () => {
    await using parent = createParallelAgentGraph();
    const { agent, requests } = await member([
      fauxAssistantMessage([fauxToolCall("yield", { reason: "continue" }, { id: "y1" })], { stopReason: "toolUse" }),
      "draft-1",
      "draft-2",
    ], { tools: [createYieldTool()] });
    const flow = attach(parent, agent);

    flow.send(prompt(assignment));
    await parent.run();
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.at(-1)!.users, [assignment, revision("draft-1")]);
    assert.equal(resultText(parent, flow.id), "draft-2");
    assert.deepEqual(flow.delivered, ["draft-2"]);
  }, TIMEOUT_MS);

  test("a staged agent is not idle and is rejected before its staged prompt runs", async () => {
    await using parent = createParallelAgentGraph();
    const { agent, requests } = await member(["staged answer"], { staged: "staged" });
    const flow = attach(parent, agent);

    flow.send(prompt(assignment));
    const failure = await parent.run().then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof DataflowNodeError);
    const cause = rootCause(failure);
    assert.ok(cause instanceof JuncoAgentError && cause.code === "invalid_state");
    assert.equal(requests.length, 0);
    assert.deepEqual(flow.delivered, []);
  }, TIMEOUT_MS);

  test("aborting the parent mid-round cancels Ralph with the abort reason", async () => {
    await using parent = createParallelAgentGraph();
    const hold = waitingTool("hold", { endOnAbort: true });
    const { agent, requests } = await member([
      fauxAssistantMessage([fauxToolCall("hold", {}, { id: "h1" })], { stopReason: "toolUse" }),
      "draft-1",
      "draft-2",
    ], { tools: [hold.tool] });
    const flow = attach(parent, agent);

    flow.send(prompt(assignment));
    const pending = parent.run().then(() => undefined, (error: unknown) => error);
    await hold.started;
    const reason = new Error("caller cancelled");
    await parent.abort(reason);
    const failure = await pending;
    assert.ok(failure instanceof DataflowNodeError);
    assert.equal(rootCause(failure), reason);
    assert.equal(requests.length, 1);
    assert.ok(O.isNone(parent.result(flow.id)));
    assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
  }, TIMEOUT_MS);

  test("independent Ralphs in one parent share nothing and close with it", async () => {
    const parent = createParallelAgentGraph();
    let children: unknown[] = [];
    let agents: JuncoAgent[] = [];
    try {
      const a = await member(["a-1"]);
      const flowA = attach(parent, a.agent, 1);
      const b = await member(["b-1", "b-2"]);
      const flowB = attach(parent, b.agent, 2);
      agents = [a.agent, b.agent];
      assert.notEqual(flowA.id, flowB.id);
      children = [flowA.id, flowB.id].map((id) => parent.getNode(id)?.state);

      flowA.send(prompt("assignment A"));
      flowB.send(prompt("assignment B"));
      await parent.run();

      assert.deepEqual(a.requests.map((request) => request.users), [["assignment A"]]);
      assert.equal(b.requests.length, 2);
      assert.ok(b.requests.every((request) => request.users[0] === "assignment B"));
      assert.ok(b.requests.flatMap((request) => request.users).every((text) => !text.includes("assignment A") && !text.includes("a-1")));
      assert.deepEqual([flowA.delivered, flowB.delivered], [["a-1"], ["b-2"]]);
      assert.equal(resultText(parent, flowA.id), "a-1");
      assert.equal(resultText(parent, flowB.id), "b-2");
    } finally {
      await parent.close();
    }
    assert.ok(children.length === 2 && children.every((child) => child instanceof JuncoGraph && child.signal.aborted));
    assert.ok(agents.every((agent) => agent.status === "closed"));
  }, TIMEOUT_MS);
});
