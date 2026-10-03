import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AssistantMessage,
  type Context,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  always,
  anyOf,
  messageEdge,
  msg,
  NodeId,
  type NodeIdType,
  on,
  valueEdge,
  when,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticStep, JuncoAgentError } from "junco-agent";
import type { PiScheduler, SchedulerInfo } from "junco-scheduler/agent";
import {
  type AgenticInput,
  agentNode,
  Deterministic,
  deterministicNode,
  graphNode,
  type JuncoGraph,
} from "../src/index.ts";
import {
  agencyGraph,
  drive,
  leaf,
  newScheduler,
  runAvailable,
  type Script,
  scheduleCall,
  settledText,
} from "./support.ts";

// Agency-specific scheduling: candidate member metadata, per-member input fairness and nested Pi
// graphs. The generic schedule tool, plan validation and lifetime cases live with PiScheduler in
// junco-scheduler.

const textOf = (message: AssistantMessage) =>
  message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
const userTexts = (context: Context) =>
  context.messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join(""),
        ],
  );
const toolTurn = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });
const MEMBER = NodeId("0");
const resultOf = (graph: JuncoGraph, id: NodeIdType) => {
  const result = graph.result(id);
  return O.isSome(result) ? textOf(result.value) : undefined;
};
const invalidState = (error: unknown) =>
  error instanceof JuncoAgentError && error.code === "invalid_state";

/** An agency over one member that answers `reply` to its staged prompt. */
async function singleMember(script: Script, reply = "member done") {
  const member = await leaf([fauxAssistantMessage(reply)], { prompt: "work" });
  const { graph, scheduler, session, faux } = await agencyGraph(script, {
    prompt: "schedule it",
  });
  graph.addNode(
    agentNode(member.agent, { description: "the member", trigger: always() }),
  );
  return { scheduler, graph, session, faux };
}

/** Whether each finished tool call failed, in completion order. */
function toolErrors(
  scheduler: PiScheduler<AgenticInput, AssistantMessage>,
): boolean[] {
  const errors: boolean[] = [];
  scheduler.events.on("tool_end", ({ isError }) => {
    errors.push(isError);
  });
  return errors;
}

/** The failure of a failed step, unwrapped from node-error causes. */
function failureOf(step: AgenticStep): unknown {
  assert.equal(step.kind, "failed");
  let error: unknown = step.kind === "failed" ? step.error : undefined;
  while (
    error instanceof Error &&
    !(error instanceof JuncoAgentError) &&
    error.cause !== undefined
  )
    error = error.cause;
  return error;
}

test("SchedulerInfo describes only candidate members: native description, Agentic status and pause reasons", async () => {
  const IDLE = "IDLE-DESCRIPTION-91f";
  const RESULT = "WORKER-RESULT-7d1";
  const worker = await leaf(
    [
      toolTurn(fauxToolCall("yield", { reason: "need review" }, { id: "y1" })),
      fauxAssistantMessage(RESULT),
    ],
    { prompt: "work" },
  );
  const idle = await leaf([fauxAssistantMessage("never")]);
  const infos: SchedulerInfo[] = [];
  const transcripts: string[] = [];
  const { graph, scheduler } = await agencyGraph(
    (info) => {
      infos.push(info);
      return runAvailable(info);
    },
    { prompt: "go" },
  );
  graph.addNode(
    agentNode(worker.agent, { description: "the worker", trigger: always() }),
  );
  graph.addNode(
    agentNode(idle.agent, { description: IDLE, trigger: always() }),
  );
  const raw = graph.addNode({
    description: "a raw step",
    trigger: always(),
    state: new Deterministic<AgenticInput, AssistantMessage>(
      // biome-ignore lint/correctness/useYield: an inert state; the node's own step runs instead.
      async function* () {
        return fauxAssistantMessage("unused");
      },
    ),
    step: async function* () {
      yield [];
      return fauxAssistantMessage("raw done");
    },
  });
  const quiet = graph.addNode(
    deterministicNode(
      new Deterministic<AgenticInput, AssistantMessage>(async function* () {
        yield [];
        return fauxAssistantMessage("quiet done");
      }),
      { trigger: always() },
    ),
  );
  scheduler.hooks.on("transform_context", ({ messages }) => {
    transcripts.push(JSON.stringify(messages));
    return undefined;
  });

  assert.equal(settledText((await drive(scheduler)).last), "graph quiescent");

  const pause = [
    {
      kind: "tool",
      toolCallId: "y1",
      toolName: "yield",
      reason: "need review",
    },
  ];
  assert.deepEqual(
    infos.map((info) =>
      info.nodes.map(({ id, status, details }) => ({ id, status, details })),
    ),
    [
      [
        {
          id: "0",
          status: "ready",
          details: { description: "the worker", agentStatus: "ready" },
        },
        { id: "2", status: "ready", details: { description: "a raw step" } },
        { id: "3", status: "ready", details: undefined },
      ],
      [
        {
          id: "0",
          status: "running",
          details: { description: "the worker", agentStatus: "ready" },
        },
        { id: "2", status: "running", details: { description: "a raw step" } },
        { id: "3", status: "running", details: undefined },
      ],
      [
        {
          id: "0",
          status: "running",
          details: {
            description: "the worker",
            agentStatus: "suspended",
            lastYield: pause,
          },
        },
      ],
      [],
    ],
  );
  assert.equal(transcripts.length, infos.length);
  for (const transcript of transcripts) {
    assert.equal(transcript.includes(IDLE), false);
    assert.equal(transcript.includes(RESULT), false);
  }
  assert.equal(resultOf(graph, MEMBER), RESULT);
  assert.equal(resultOf(graph, raw), "raw done");
  assert.equal(resultOf(graph, quiet), "quiet done");
  assert.equal(idle.faux.state.callCount, 0);
  await graph.close();
});

test("a repeated occurrence after its member returned keeps the result", async () => {
  const { scheduler, graph } = await singleMember(
    [
      toolTurn(scheduleCall([["0", "0", "0"]], "all")),
      fauxAssistantMessage("finished"),
    ],
    "kept",
  );

  assert.equal(settledText((await drive(scheduler)).last), "finished");
  assert.equal(resultOf(graph, MEMBER), "kept");
  await graph.close();
});

test("only ids available when the window starts may be planned", async () => {
  const producer = await leaf([fauxAssistantMessage("produced")], {
    prompt: "produce",
  });
  const consumer = await leaf([fauxAssistantMessage("consumed")], {
    prompt: "consume",
  });
  const plans = [[["producer"]], [["producer", "consumer"]]];
  const { graph, scheduler } = await agencyGraph(
    (info, request) =>
      request < plans.length ? { lanes: plans[request]! } : runAvailable(info),
    { prompt: "go" },
  );
  const edge = valueEdge<AgenticInput, AssistantMessage>("producer->consumer");
  const p = graph.addNode(
    agentNode(producer.agent, {
      id: NodeId("producer"),
      description: "producer",
      trigger: always(),
    }),
  );
  const c = graph.addNode(
    agentNode(consumer.agent, {
      id: NodeId("consumer"),
      description: "consumer",
      trigger: when(edge),
    }),
  );
  graph.addEdge(p, c, edge);
  const errors = toolErrors(scheduler);

  assert.equal(settledText((await drive(scheduler)).last), "graph quiescent");
  assert.equal(errors[1], true);
  assert.equal(producer.faux.state.callCount, 1);
  assert.deepEqual(
    [resultOf(graph, p), resultOf(graph, c)],
    ["produced", "consumed"],
  );
  await graph.close();
});

test("an any trigger reads a newer message rather than an already delivered result", async () => {
  const valueSource = await leaf([fauxAssistantMessage("the value")], {
    prompt: "value",
  });
  const messenger = await leaf(
    [
      toolTurn(fauxToolCall("yield", { reason: "send more" }, { id: "m1" })),
      fauxAssistantMessage("messenger done"),
    ],
    { prompt: "message" },
  );
  const requests: string[][] = [];
  const record = (reply: AssistantMessage) => (context: Context) => {
    requests.push(userTexts(context));
    return reply;
  };
  const reader = await leaf([
    record(
      toolTurn(fauxToolCall("yield", { reason: "waiting" }, { id: "r1" })),
    ),
    record(fauxAssistantMessage("reader done")),
    record(fauxAssistantMessage("reader after more")),
  ]);
  const { graph, scheduler } = await agencyGraph(runAvailable, {
    prompt: "go",
  });
  const value = valueEdge<AgenticInput, AssistantMessage>("value->reader");
  const more = messageEdge<AgenticInput, AssistantMessage>("messenger->reader");
  const v = graph.addNode(
    agentNode(valueSource.agent, { description: "value", trigger: always() }),
  );
  const m = graph.addNode(
    agentNode(
      messenger.agent,
      { description: "messenger", trigger: always() },
      { emit: () => [msg(more, { kind: "followUp", text: "more" })] },
    ),
  );
  const r = graph.addNode(
    agentNode(
      reader.agent,
      { description: "reader", trigger: anyOf(on(value), on(more)) },
      {
        receive: (view) => [
          ...[...view.values.keys()].map(
            (id): AgenticInput => ({
              kind: "prompt",
              text: `got ${textOf(view.values.get(id)!)}`,
            }),
          ),
          ...(view.messages.get(more.id) ?? []),
        ],
      },
    ),
  );
  graph.addEdge(v, r, value);
  graph.addEdge(m, r, more);

  const { last } = await drive(scheduler);

  assert.equal(settledText(last), "graph quiescent");
  assert.deepEqual(
    [v, m, r].map((id) => resultOf(graph, id)),
    ["the value", "messenger done", "reader after more"],
  );
  assert.deepEqual(requests.at(-1), ["got the value", "more"]);
  await graph.close();
});

test("a node added between completed windows is described and executed", async () => {
  const first = await leaf([fauxAssistantMessage("first done")], {
    prompt: "first",
  });
  const late = await leaf([fauxAssistantMessage("late done")], {
    prompt: "late",
  });
  const infos: SchedulerInfo[] = [];
  let lateId: NodeIdType | undefined;
  const { graph, scheduler } = await agencyGraph(
    (info) => {
      infos.push(info);
      if (infos.length === 2) {
        lateId = graph.addNode(
          agentNode(late.agent, {
            id: NodeId("late"),
            description: "late member",
            trigger: always(),
          }),
        );
      }
      return runAvailable(info);
    },
    { prompt: "go" },
  );
  graph.addNode(
    agentNode(first.agent, { description: "first member", trigger: always() }),
  );

  assert.equal(settledText((await drive(scheduler)).last), "graph quiescent");
  assert.ok(lateId !== undefined);
  const described = infos
    .slice(2)
    .flatMap((info) => info.nodes)
    .find(({ id }) => id === "late");
  assert.deepEqual(described?.details, {
    description: "late member",
    agentStatus: "ready",
  });
  assert.deepEqual(
    [resultOf(graph, MEMBER), resultOf(graph, lateId)],
    ["first done", "late done"],
  );
  await graph.close();
});

test("a nested Pi graph consumes its completion response before its parent publishes the selected result", async () => {
  const member = await leaf([fauxAssistantMessage("leaf result")], {
    prompt: "work",
  });
  const child = await agencyGraph(runAvailable, { prompt: "run child" });
  const leafId = child.graph.addNode(
    agentNode(member.agent, { description: "leaf", trigger: always() }),
  );
  const parent = await agencyGraph(runAvailable, { prompt: "run parent" });
  const edge = valueEdge<AgenticInput, AssistantMessage>("child->consumer");
  let childRequestsAtDelivery: number | undefined;
  const consumer = await leaf([fauxAssistantMessage("consumed")]);
  const nested = parent.graph.addNode(
    graphNode(
      child.graph,
      { description: "child", trigger: always() },
      { result: leafId },
    ),
  );
  const c = parent.graph.addNode(
    agentNode(
      consumer.agent,
      { description: "consumer", trigger: when(edge) },
      {
        receive: (view) => {
          childRequestsAtDelivery = child.faux.state.callCount;
          return [
            {
              kind: "prompt",
              text: `got ${textOf(view.values.get(edge.id)!)}`,
            },
          ];
        },
      },
    ),
  );
  parent.graph.addEdge(nested, c, edge);

  assert.equal(
    settledText((await drive(parent.scheduler)).last),
    "graph quiescent",
  );
  assert.equal(childRequestsAtDelivery, child.faux.state.callCount);
  assert.equal(child.scheduler.status, "idle");
  assert.deepEqual(
    [resultOf(parent.graph, nested), resultOf(parent.graph, c)],
    ["leaf result", "consumed"],
  );
  await parent.graph.close();
  assert.equal(child.scheduler.status, "closed");
});

test("an already settled idle Pi child returns its retained result without another provider request", async () => {
  const member = await leaf([fauxAssistantMessage("leaf result")], {
    prompt: "work",
  });
  const child = await agencyGraph(runAvailable, { prompt: "run child" });
  const leafId = child.graph.addNode(
    agentNode(member.agent, { description: "leaf", trigger: always() }),
  );
  assert.equal(
    settledText((await drive(child.scheduler)).last),
    "graph quiescent",
  );
  const childRequests = child.faux.state.callCount;

  const parent = await agencyGraph(runAvailable, { prompt: "run parent" });
  const nested = parent.graph.addNode(
    graphNode(
      child.graph,
      { description: "child", trigger: always() },
      { result: leafId },
    ),
  );
  assert.equal(
    settledText((await drive(parent.scheduler)).last),
    "graph quiescent",
  );

  assert.equal(resultOf(parent.graph, nested), "leaf result");
  assert.equal(child.faux.state.callCount, childRequests);
  assert.equal(member.faux.state.callCount, 1);
  await parent.graph.close();
});

test("a triggered idle Pi child without a result or staged prompt fails instead of hanging", async () => {
  const member = await leaf([fauxAssistantMessage("never")]);
  const child = await agencyGraph(runAvailable);
  const leafId = child.graph.addNode(
    agentNode(member.agent, { description: "leaf", trigger: always() }),
  );
  const parent = await agencyGraph(runAvailable, { prompt: "run parent" });
  const nested = parent.graph.addNode(
    graphNode(
      child.graph,
      { description: "child", trigger: always() },
      { result: leafId },
    ),
  );

  const error = failureOf((await drive(parent.scheduler)).last);
  assert.ok(invalidState(error) && error instanceof JuncoAgentError);
  assert.ok(O.isNone(parent.graph.result(nested)));
  assert.equal(child.faux.state.callCount + member.faux.state.callCount, 0);
  await parent.graph.close();
});

test("a missing or foreign graph getter fails before provider work and touches no unrelated members", async () => {
  const missing = await newScheduler(() => undefined, runAvailable, {
    prompt: "go",
  });
  assert.ok(invalidState(failureOf((await drive(missing.scheduler)).last)));
  assert.equal(missing.faux.state.callCount, 0);
  await missing.scheduler.abort();
  await missing.scheduler.return();
  assert.equal(missing.scheduler.status, "closed");

  const bystander = await leaf([fauxAssistantMessage("never")], {
    prompt: "go",
  });
  const other = await agencyGraph(runAvailable, { prompt: "other" });
  other.graph.addNode(
    agentNode(bystander.agent, { description: "bystander", trigger: always() }),
  );
  const foreign = await newScheduler(() => other.graph, runAvailable, {
    prompt: "go",
  });
  assert.ok(invalidState(failureOf((await drive(foreign.scheduler)).last)));
  assert.equal(foreign.faux.state.callCount, 0);

  const abortError = await foreign.scheduler.abort().then(
    () => undefined,
    (error: unknown) => error,
  );
  const closeError = await foreign.scheduler.return().then(
    () => undefined,
    (error: unknown) => error,
  );
  for (const error of [abortError, closeError]) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    assert.ok(errors.length > 0 && errors.every(invalidState));
  }
  assert.equal(foreign.scheduler.status, "closed");
  assert.equal(other.graph.signal.aborted, false);
  assert.equal(bystander.agent.status, "ready");
  assert.equal(other.scheduler.status, "ready");
  await other.graph.close();
  assert.equal(bystander.agent.status, "closed");
});
