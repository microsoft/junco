import { test } from "bun:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  always,
  anyOf,
  DataflowDefinitionError,
  DataflowGraph,
  DataflowNodeError,
  messageEdge,
  msg,
  NodeId,
  on,
  UNBOUNDED,
  valueEdge,
  when,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type Agentic, JuncoAgentError } from "junco-agent";
import { Type } from "typebox";
import { type AgenticInput, agentNode, attachAgency, type GraphInfo } from "../src/index.ts";
import {
  agencyGraph,
  drive,
  flushMacrotasks,
  graphInfoOf,
  leaf,
  newScheduler,
  runAvailable,
  type Script,
  scheduleCall,
  settledText,
} from "./support.ts";

const quiet = { receive: () => [], emit: () => [] } as const;
const textOf = (message: AssistantMessage) =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
const userTexts = (context: Context) =>
  context.messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
        ],
  );
const toolTurn = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const MEMBER = NodeId("0");

/** An agency over one member that answers `reply` to its staged prompt. */
async function singleMember(script: Script, reply = "member done") {
  const member = await leaf([fauxAssistantMessage(reply)], { prompt: "work" });
  const { graph, session, faux } = await agencyGraph(script, { prompt: "schedule it" });
  graph.addNode(agentNode(member.agent, { description: "the member", trigger: always(), ...quiet }));
  return { agency: attachAgency(graph), graph, session, faux };
}

/** Whether each finished tool call failed, in completion order. */
function toolErrors(agency: Agentic): boolean[] {
  const errors: boolean[] = [];
  agency.events.on("tool_end", ({ isError }) => {
    errors.push(isError);
  });
  return errors;
}

test("each request carries one GraphInfo snapshot as data that is never persisted or emitted", async () => {
  const infos: GraphInfo[] = [];
  const { agency, session } = await singleMember((info) => {
    infos.push(info);
    return runAvailable(info);
  });
  const emitted: string[] = [];
  agency.events.on("message_end", ({ message }) => {
    emitted.push(JSON.stringify(message));
  });

  assert.equal(settledText((await drive(agency)).last), "member done");

  assert.deepEqual(
    infos.map((info) => info.nodes.map((node) => [node.id, node.status, node.available])),
    [[["0", "ready", true]], [["0", "running", true]], [["0", "done", false]]],
  );
  assert.equal(infos[2]!.nodes[0]!.result?.text, "member done");
  assert.ok(infos.every((info) => info.window === null && info.threads === null && info.edges.length === 0));
  assert.equal(JSON.stringify(await session.findEntries(undefined, BACKGROUND_CONTEXT)).includes("GraphInfo:"), false);
  assert.equal(emitted.some((message) => message.includes("GraphInfo:")), false);
});

test("the fixed schedule tool cannot be replaced or disabled", async () => {
  const { scheduler } = await newScheduler([]);
  const [tool] = scheduler.getTools();
  assert.equal(scheduler.getTools().length, 1);
  assert.equal(tool!.name, "schedule");

  const other: AgentTool = {
    name: "other",
    label: "other",
    description: "not allowed",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  };
  const invalid = (promise: Promise<void>) =>
    assert.rejects(promise, (error) => error instanceof JuncoAgentError && error.code === "invalid_argument");
  await invalid(scheduler.setTools([other as never]));
  await invalid(scheduler.setTools([tool!, tool!]));
  await invalid(scheduler.setTools([tool!], ["other"]));
  await invalid(scheduler.setTools([]));
  await invalid(scheduler.setTools([tool!], []));
  await invalid(scheduler.setActiveTools([]));
  assert.equal(scheduler.getTools()[0], tool);
  assert.deepEqual(scheduler.getActiveTools().map((active) => active.name), ["schedule"]);
  await scheduler.setTools([tool!], ["schedule"]);
  await scheduler.setActiveTools(["schedule"]);
  assert.deepEqual(
    scheduler.getActiveTools().map((active) => active.name),
    ["schedule"],
  );
});

test("schedule calls added by a later after_response hook are rejected before any graph step", async () => {
  let graphSteps = 0;
  const stepsAtRetry: number[] = [];
  const statusAtRetry: string[] = [];
  const { agency, graph } = await singleMember([
    toolTurn(scheduleCall([["0"]], "preliminary")),
    (context) => {
      statusAtRetry.push(graphInfoOf(context).nodes[0]!.status);
      stepsAtRetry.push(graphSteps);
      return toolTurn(scheduleCall([["0"]], "prime"));
    },
    toolTurn(scheduleCall([["0"]], "run")),
    fauxAssistantMessage("finished"),
  ]);
  const step = graph.step.bind(graph);
  graph.step = (options) => {
    graphSteps++;
    return step(options);
  };
  agency.hooks.on("after_response", ({ message }) =>
    message.content.some((block) => block.type === "toolCall" && block.id === "preliminary")
      ? { message: { ...message, content: [scheduleCall([["0"]], "a"), scheduleCall([["0"]], "b")] } }
      : undefined,
  );
  const errors = toolErrors(agency);

  const { yields, last } = await drive(agency);

  assert.deepEqual(errors, [true, true, false, false]);
  assert.deepEqual(statusAtRetry, ["ready"]);
  assert.deepEqual(stepsAtRetry, [0]);
  assert.equal(graphSteps, 2);
  assert.equal(yields, 2);
  assert.equal(settledText(last), "finished");
  assert.ok(O.isSome(graph.result(MEMBER)));
});

test("a schedule call completes a real graph window through the native tool gate", async () => {
  const { agency, graph, faux } = await singleMember([
    toolTurn(scheduleCall([["0"]], "prime")),
    toolTurn(scheduleCall([["0"]], "run")),
    fauxAssistantMessage("finished"),
  ], "actual member result");
  const completed: GraphInfo[] = [];
  agency.events.on("tool_end", ({ toolName, result, isError }) => {
    if (toolName === "schedule" && !isError) completed.push(result.details as GraphInfo);
  });
  try {
    const first = await agency.next();
    assert.equal(first.done, false);
    if (first.done) throw new Error("scheduler closed before first graph window");
    assert.equal(first.value.kind, "yield");
    assert.equal(completed[0]!.nodes[0]!.status, "running");
    assert.equal(graph.getNode(MEMBER)!.status, "running");
    await flushMacrotasks();
    assert.equal(faux.state.callCount, 1);

    const second = await agency.next();
    assert.equal(second.done, false);
    if (second.done) throw new Error("scheduler closed before second graph window");
    assert.equal(second.value.kind, "yield");
    assert.equal(completed[1]!.nodes[0]!.result?.text, "actual member result");
    assert.equal(graph.getNode(MEMBER)!.status, "done");
    assert.equal(faux.state.callCount, 2);
    assert.equal(settledText((await drive(agency)).last), "finished");
    assert.equal(faux.state.callCount, 3);
    assert.ok(O.isSome(graph.result(MEMBER)));
  } finally {
    await agency.return();
  }
});

test("an invalid plan is an ordinary tool error that activates nothing", async () => {
  const statusAfter: string[] = [];
  const { agency } = await singleMember([
    toolTurn(scheduleCall([["missing"]], "bad")),
    (context) => {
      statusAfter.push(graphInfoOf(context).nodes[0]!.status);
      return toolTurn(scheduleCall([["0"]], "prime"));
    },
    toolTurn(scheduleCall([["0"]], "run")),
    fauxAssistantMessage("finished"),
  ]);
  const errors = toolErrors(agency);

  assert.equal(settledText((await drive(agency)).last), "finished");
  assert.deepEqual(errors, [true, false, false]);
  assert.deepEqual(statusAfter, ["ready"]);
});

test("with nothing available a plan is rejected, while an empty one returns GraphInfo without a pause", async () => {
  const idle = await leaf([fauxAssistantMessage("never")]);
  const { graph } = await agencyGraph(
    [toolTurn(scheduleCall([["0"]], "work")), toolTurn(scheduleCall([], "empty")), fauxAssistantMessage("nothing to do")],
    { prompt: "go" },
  );
  graph.addNode(agentNode(idle.agent, { description: "idle", trigger: always(), ...quiet }));
  const agency = attachAgency(graph);
  const errors = toolErrors(agency);

  const { yields, last } = await drive(agency);
  assert.equal(yields, 0);
  assert.equal(settledText(last), "nothing to do");
  assert.deepEqual(errors, [true, false]);
});

test("finishing while work is available fails the run, before or after a window", async () => {
  const early = await singleMember([fauxAssistantMessage("done already")]);
  const skipped = (await drive(early.agency)).last;
  assert.ok(skipped.kind === "failed" && skipped.error instanceof JuncoAgentError);
  assert.equal(skipped.error.code, "invalid_state");

  const primedOnly = await singleMember([toolTurn(scheduleCall([["0"]], "prime")), fauxAssistantMessage("done")]);
  const { yields, last } = await drive(primedOnly.agency);
  assert.equal(yields, 1);
  assert.ok(last.kind === "failed" && last.error instanceof JuncoAgentError && last.error.code === "invalid_state");
});

test("a member graph failure remains fatal even after the scheduler's final answer", async () => {
  const failing = await leaf([fauxAssistantMessage("never")], { prompt: "go" });
  const cause = new Error("member input failed");
  const { graph } = await agencyGraph(
    [toolTurn(scheduleCall([["0"]], "prime")), toolTurn(scheduleCall([["0"]], "run")), fauxAssistantMessage("all good")],
    { prompt: "go" },
  );
  graph.addNode(agentNode(failing.agent, {
    description: "failing", trigger: always(), emit: () => [],
    receive: () => { throw cause; },
  }));

  const { last } = await drive(attachAgency(graph));
  assert.ok(last.kind === "failed" && last.error instanceof DataflowNodeError);
  assert.equal(last.error.nodeId, MEMBER);
  assert.equal(last.error.error, cause);
});

test("the graph cannot be stepped without a schedule decision, and a scheduler serves one graph", async () => {
  const member = await leaf([fauxAssistantMessage("never")], { prompt: "work" });
  const { graph, scheduler } = await agencyGraph([], { prompt: "go" });
  graph.addNode(agentNode(member.agent, { description: "member", trigger: always(), ...quiet }));

  await assert.rejects(graph.step(), DataflowDefinitionError);
  assert.equal(graph.getNode(MEMBER)!.status, "ready");
  assert.throws(() => new DataflowGraph(scheduler, UNBOUNDED, UNBOUNDED), DataflowDefinitionError);
});

test("a repeated occurrence after its member returned keeps the result", async () => {
  const { agency, graph } = await singleMember(
    [toolTurn(scheduleCall([["0", "0", "0"]], "all")), fauxAssistantMessage("finished")],
    "kept",
  );

  assert.equal(settledText((await drive(agency)).last), "finished");
  const result = graph.result(MEMBER);
  assert.ok(O.isSome(result) && textOf(result.value) === "kept");
});

test("only ids available when the window starts may be planned", async () => {
  const producer = await leaf([fauxAssistantMessage("produced")], { prompt: "produce" });
  const consumer = await leaf([fauxAssistantMessage("consumed")], { prompt: "consume" });
  const plans = [[["producer"]], [["producer", "consumer"]]];
  const { graph } = await agencyGraph(
    (info, request) => (request < plans.length ? { lanes: plans[request]! } : runAvailable(info)),
    { prompt: "go" },
  );
  const edge = valueEdge<AgenticInput, AssistantMessage>("producer->consumer");
  const p = graph.addNode(
    agentNode(producer.agent, { id: NodeId("producer"), description: "producer", trigger: always(), ...quiet }),
  );
  const c = graph.addNode(
    agentNode(consumer.agent, { id: NodeId("consumer"), description: "consumer", trigger: when(edge), ...quiet }),
  );
  graph.addEdge(p, c, edge);
  const agency = attachAgency(graph);
  const errors = toolErrors(agency);

  assert.equal(settledText((await drive(agency)).last), "produced + consumed");
  assert.equal(errors[1], true);
  assert.equal(producer.faux.state.callCount, 1);
});

test("an any trigger reads a newer message rather than an already delivered result", async () => {
  const valueSource = await leaf([fauxAssistantMessage("the value")], { prompt: "value" });
  const messenger = await leaf(
    [toolTurn(fauxToolCall("yield", { reason: "send more" }, { id: "m1" })), fauxAssistantMessage("messenger done")],
    { prompt: "message" },
  );
  const requests: string[][] = [];
  const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
    requests.push(userTexts(context));
    return reply;
  };
  const reader = await leaf([
    record(toolTurn(fauxToolCall("yield", { reason: "waiting" }, { id: "r1" }))),
    record(fauxAssistantMessage("reader done")),
    record(fauxAssistantMessage("reader after more")),
  ]);
  const { graph } = await agencyGraph(runAvailable, { prompt: "go" });
  const value = valueEdge<AgenticInput, AssistantMessage>("value->reader");
  const more = messageEdge<AgenticInput, AssistantMessage>("messenger->reader");
  const v = graph.addNode(agentNode(valueSource.agent, { description: "value", trigger: always(), ...quiet }));
  const m = graph.addNode(
    agentNode(messenger.agent, {
      description: "messenger",
      trigger: always(),
      receive: () => [],
      emit: () => [msg(more, { kind: "followUp", text: "more" })],
    }),
  );
  const r = graph.addNode(
    agentNode(reader.agent, {
      description: "reader",
      trigger: anyOf(on(value), on(more)),
      receive: (view) => [
        ...[...view.values.keys()].map(
          (id): AgenticInput => ({ kind: "prompt", text: `got ${textOf(view.values.get(id)!)}` }),
        ),
        ...(view.messages.get(more.id) ?? []),
      ],
      emit: () => [],
    }),
  );
  graph.addEdge(v, r, value);
  graph.addEdge(m, r, more);

  const { last } = await drive(attachAgency(graph));

  assert.equal(settledText(last), "the value + messenger done + reader after more");
  assert.deepEqual(requests.at(-1), ["got the value", "more"]);
});
