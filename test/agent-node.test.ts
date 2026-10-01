import { test } from "bun:test";
import assert from "node:assert/strict";
import { JuncoAgentError, type Agentic } from "junco-agent";
import { type AssistantMessage, type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  always,
  DataflowGraph,
  DataflowNodeError,
  messageEdge,
  msg,
  ReadyScheduler,
  UNBOUNDED,
  valueEdge,
  when,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticInput, agentNode } from "../src/index.ts";
import { leaf } from "./support.ts";

// The adapter is scheduler-agnostic: these graphs run on the engine's own ReadyScheduler.

const graphOf = () =>
  new DataflowGraph<Agentic, AgenticInput, AssistantMessage, unknown>(new ReadyScheduler(), UNBOUNDED, UNBOUNDED);

const textOf = (message: AssistantMessage) =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

const userTexts = (context: Context) =>
  context.messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")],
  );

const toolTurn = (reason: string, id: string) =>
  fauxAssistantMessage([fauxToolCall("yield", { reason }, { id })], { stopReason: "toolUse" });

const quiet = { receive: () => [], emit: () => [] } as const;

test("a dependent gets its parent's result once, before its staged prompt, and priming loses nothing", async () => {
  const upstream = await leaf([fauxAssistantMessage("upstream result")], { prompt: "produce" });
  const requests: string[][] = [];
  const recordThen = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
    requests.push(userTexts(context));
    return reply;
  };
  const dependent = await leaf(
    [
      recordThen(toolTurn("first pause", "d1")),
      recordThen(toolTurn("second pause", "d2")),
      recordThen(fauxAssistantMessage("dependent done")),
    ],
    { prompt: "use it" },
  );
  const graph = graphOf();
  const edge = valueEdge<AgenticInput, AssistantMessage>("upstream->dependent");
  const u = graph.addNode(agentNode(upstream.agent, { description: "upstream", trigger: always(), ...quiet }));
  const d = graph.addNode(
    agentNode(dependent.agent, {
      description: "dependent",
      trigger: when(edge),
      receive: (view) =>
        [...view.values.keys()].map((id) => ({ kind: "nextTurn", text: `upstream: ${textOf(view.values.get(id)!)}` })),
      emit: () => [],
    }),
  );
  graph.addEdge(u, d, edge);

  assert.deepEqual([...graph.available().keys()], [u]);
  await graph.step(); // primes the upstream
  await graph.step(); // runs it to its result
  assert.ok(O.isSome(graph.result(u)));
  assert.equal(dependent.faux.state.callCount, 0);
  await graph.step(); // primes the dependent: no request, input kept
  assert.equal(dependent.faux.state.callCount, 0);
  assert.equal(graph.getNode(d)!.status, "running");
  await graph.run();

  assert.deepEqual(requests, [
    ["upstream: upstream result", "use it"],
    ["upstream: upstream result", "use it"],
    ["upstream: upstream result", "use it"],
  ]);
  const result = graph.result(d);
  assert.ok(O.isSome(result) && textOf(result.value) === "dependent done");
});

test("message-edge controls keep their order and reach only the wired recipient", async () => {
  const sender = await leaf([toolTurn("handoff", "s1"), fauxAssistantMessage("sender done")], { prompt: "start" });
  const requests: string[][] = [];
  const recipient = await leaf([
    (context: Context) => {
      requests.push(userTexts(context));
      return fauxAssistantMessage("recipient done");
    },
  ]);
  const bystander = await leaf([fauxAssistantMessage("never")]);
  const graph = graphOf();
  const toRecipient = messageEdge<AgenticInput, AssistantMessage>("sender->recipient");
  const toBystander = messageEdge<AgenticInput, AssistantMessage>("sender->bystander");
  const s = graph.addNode(
    agentNode(sender.agent, {
      description: "sender",
      trigger: always(),
      receive: () => [],
      emit: () => [
        msg(toRecipient, { kind: "nextTurn", text: "context first" }),
        msg(toRecipient, { kind: "prompt", text: "then work" }),
      ],
    }),
  );
  const byMessages = (edge: typeof toRecipient) => ({
    trigger: when(edge),
    receive: (view: Parameters<Parameters<typeof agentNode>[1]["receive"]>[0]) => view.messages.get(edge.id) ?? [],
    emit: () => [],
  });
  const r = graph.addNode(agentNode(recipient.agent, { description: "recipient", ...byMessages(toRecipient) }));
  const b = graph.addNode(agentNode(bystander.agent, { description: "bystander", ...byMessages(toBystander) }));
  graph.addEdge(s, r, toRecipient);
  graph.addEdge(s, b, toBystander);

  await graph.run();

  assert.deepEqual(requests, [["context first", "then work"]]);
  assert.equal(bystander.faux.state.callCount, 0);
  assert.equal(graph.getNode(b)!.status, "ready");
  const result = graph.result(r);
  assert.ok(O.isSome(result) && textOf(result.value) === "recipient done");
});

test("a member with neither a staged nor a received prompt is quiescent", async () => {
  const idle = await leaf([fauxAssistantMessage("never")]);
  const graph = graphOf();
  graph.addNode(agentNode(idle.agent, { description: "idle", trigger: always(), ...quiet }));

  assert.equal(graph.available().size, 0);
  await graph.run();
  assert.equal(idle.faux.state.callCount, 0);
});

test("a control-only delivery leaves the member idle without blocking the graph", async () => {
  const sender = await leaf([toolTurn("hand over a note", "s1"), fauxAssistantMessage("sent")], { prompt: "go" });
  const requests: string[][] = [];
  const member = await leaf([
    (context: Context) => {
      requests.push(userTexts(context));
      return fauxAssistantMessage("later");
    },
  ]);
  const graph = graphOf();
  const edge = messageEdge<AgenticInput, AssistantMessage>("sender->member");
  const s = graph.addNode(
    agentNode(sender.agent, {
      description: "sender",
      trigger: always(),
      receive: () => [],
      emit: () => [
        msg(edge, { kind: "appendMessage", message: { role: "user", content: "remember this", timestamp: 1 } }),
      ],
    }),
  );
  const m = graph.addNode(
    agentNode(member.agent, {
      description: "member",
      trigger: when(edge),
      receive: (view) => view.messages.get(edge.id) ?? [],
      emit: () => [],
    }),
  );
  graph.addEdge(s, m, edge);

  await graph.run();

  assert.equal(member.faux.state.callCount, 0);
  assert.equal(member.agent.status, "idle");
  assert.equal(graph.getNode(m)!.status, "running");
  assert.equal(graph.available().size, 0);
  await member.agent.prompt("and now");
  assert.deepEqual(requests, [["remember this", "and now"]]);
});

test("an error final message is returned as a node result without closing the member", async () => {
  const erring = await leaf(
    [fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }), fauxAssistantMessage("recovered")],
    { prompt: "go" },
  );
  const graph = graphOf();
  const id = graph.addNode(agentNode(erring.agent, { description: "erring", trigger: always(), ...quiet }));

  await graph.run();
  const result = graph.result(id);
  assert.ok(O.isSome(result) && result.value.stopReason === "error");
  assert.equal(erring.agent.status, "idle");
  assert.equal(textOf(await erring.agent.prompt("still usable")), "recovered");
});

test("a member closed before its run settles fails its node as invalid_state", async () => {
  const member = await leaf([toolTurn("pause", "p1"), fauxAssistantMessage("never")], { prompt: "go" });
  const graph = graphOf();
  graph.addNode(agentNode(member.agent, { description: "member", trigger: always(), ...quiet }));

  await graph.step(); // prime
  await graph.step(); // starts the run, which pauses
  assert.equal(member.agent.status, "suspended");
  await member.agent.return();
  const error = await graph.step().catch((thrown: unknown) => thrown);
  assert.ok(error instanceof DataflowNodeError);
  assert.ok(error.error instanceof JuncoAgentError && error.error.code === "invalid_state");
});

test("a node runs one prompt: a received prompt conflicts with a staged one", async () => {
  const upstream = await leaf([fauxAssistantMessage("up")], { prompt: "produce" });
  const member = await leaf([fauxAssistantMessage("never")], { prompt: "staged" });
  const graph = graphOf();
  const edge = valueEdge<AgenticInput, AssistantMessage>("up->member");
  const u = graph.addNode(agentNode(upstream.agent, { description: "upstream", trigger: always(), ...quiet }));
  const m = graph.addNode(
    agentNode(member.agent, {
      description: "member",
      trigger: when(edge),
      receive: () => [{ kind: "prompt", text: "received" }],
      emit: () => [],
    }),
  );
  graph.addEdge(u, m, edge);

  const error = await graph.run().catch((thrown: unknown) => thrown);
  assert.ok(error instanceof DataflowNodeError && error.nodeId === m);
  assert.ok(error.error instanceof JuncoAgentError && error.error.code === "invalid_state");
  assert.equal(member.faux.state.callCount, 0);
  assert.equal(member.agent.status, "ready");
});
