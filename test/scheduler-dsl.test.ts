import { test } from "bun:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Edge, NodeId, TriggerRule } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { AssistantMessageSchema, JuncoAgentError } from "junco-agent";
import type { SchedulerRequest } from "junco-scheduler/agent";
import { LockPolicy } from "junco-tools";
import type { AgencyNodeMetadata } from "../src/node-policy.ts";
import { resultText, terminalPorts } from "./deterministic-support.ts";
import {
  addPromptOnce,
  agencyGraph,
  leaf,
  runAvailable,
  type Script,
} from "./support.ts";

const MEMBER = NodeId.create("0");

async function singleMember(script: Script, reply = "member done") {
  const member = await leaf([fauxAssistantMessage(reply)]);
  const ports = terminalPorts();
  const fixture = await agencyGraph(ports.source, ports.sink, script, {
    prompt: "schedule it",
  });
  const graph = fixture.context.graph;
  const id = addPromptOnce(graph, MEMBER, member.agent, "work", "the member");
  ports.connect(graph, id);
  return { ...fixture, member };
}

test("a repeated ID in an oracle wave runs once and retains the exact sink result", async () => {
  const { context, member, faux } = await singleMember(
    (request) => ({
      waves: [request.nodes.flatMap((node) => [node.id, node.id, node.id])],
    }),
    "kept",
  );
  try {
    await context.run();
    const graph = context.graph;
    assert.equal(resultText(graph, MEMBER), "kept");
    assert.deepEqual(graph.result(graph.sink.id), graph.result(MEMBER));
    assert.equal(member.faux.state.callCount, 1);
    const calls = faux.state.callCount;
    await context.run();
    assert.equal(faux.state.callCount, calls);
  } finally {
    await context.graph.close();
  }
});

test("speculative unavailable IDs are filtered and reconsidered from a fresh decision", async () => {
  const producer = await leaf([fauxAssistantMessage("produced")]);
  const consumer = await leaf([fauxAssistantMessage("consumed")]);
  const ports = terminalPorts();
  const requests: SchedulerRequest<AgencyNodeMetadata>[] = [];
  const { context } = await agencyGraph(ports.source, ports.sink, (request) => {
    requests.push(request);
    return { waves: [["producer", "consumer", "$sink"]] };
  });
  const graph = context.graph;
  const edge = Edge.value("producer->consumer", AssistantMessageSchema);
  const p = addPromptOnce(graph, "producer", producer.agent, "produce", "producer");
  const c = addPromptOnce(
    graph, "consumer", consumer.agent, "consume", "consumer", edge,
  );
  graph.addEdge(p, c, edge);
  ports.connect(graph, c);
  try {
    await context.run();
    assert.equal(
      requests[0]!.nodes.some(({ id }) => id === c),
      false,
    );
    assert.ok(
      requests.some((request) => request.nodes.some(({ id }) => id === c)),
    );
    assert.equal(producer.faux.state.callCount, 1);
    assert.deepEqual(
      [resultText(graph, p), resultText(graph, c)],
      ["produced", "consumed"],
    );
  } finally {
    await graph.close();
  }
});

test("a node added between decisions is described with fresh typed metadata", async () => {
  const first = await leaf([fauxAssistantMessage("first done")]);
  const late = await leaf([fauxAssistantMessage("late done")]);
  const ports = terminalPorts();
  const requests: SchedulerRequest<AgencyNodeMetadata>[] = [];
  const { context } = await agencyGraph(ports.source, ports.sink, (request) => {
    requests.push(request);
    return runAvailable(request);
  });
  const graph = context.graph;
  const firstId = addPromptOnce(
    graph, MEMBER, first.agent, "first", "first member",
  );
  ports.connect(graph, firstId);
  await context.step();
  const lateId = addPromptOnce(graph, "late", late.agent, "late", "late member");
  try {
    await context.run();
    const request = requests.find((entry) =>
      entry.nodes.some(({ id }) => id === lateId),
    );
    assert.equal(
      request?.nodes.find(({ id }) => id === lateId)?.description,
      "late member",
    );
    assert.equal(new Map(request?.context).get(lateId)?.agentStatus, "idle");
    assert.deepEqual(
      [resultText(graph, MEMBER), resultText(graph, lateId)],
      ["first done", "late done"],
    );
  } finally {
    await graph.close();
  }
});

test("a nested context publishes its sink result after all child decisions", async () => {
  const child = await singleMember(runAvailable, "leaf result");
  const ports = terminalPorts();
  const parent = await agencyGraph(ports.source, ports.sink);
  const graph = parent.context.graph;
  const edge = Edge.value("child->consumer", AssistantMessageSchema);
  let childRequestsAtDelivery: number | undefined;
  const consumer = await leaf([
    () => {
      childRequestsAtDelivery = child.faux.state.callCount;
      return fauxAssistantMessage("consumed");
    },
  ]);
  const nested = graph.addNode({
    description: "child",
    trigger: TriggerRule.always(),
    state: child.context,
  });
  const c = addPromptOnce(
    graph, "consumer", consumer.agent, "consume", "consumer", edge,
  );
  graph.addEdge(nested, c, edge);
  ports.connect(graph, c);
  try {
    assert.equal(graph.getNode(nested)?.state, child.context.graph);
    await parent.context.run();
    assert.equal(childRequestsAtDelivery, child.faux.state.callCount);
    assert.deepEqual(
      [resultText(graph, nested), resultText(graph, c)],
      ["leaf result", "consumed"],
    );
    assert.deepEqual(
      graph.result(nested),
      child.context.graph.result(child.context.graph.sink.id),
    );
  } finally {
    await graph.close();
  }
  assert.equal(child.member.agent.status, "closed");
});

test("an already quiescent child returns its retained sink result without another request", async () => {
  const child = await singleMember(runAvailable, "leaf result");
  await child.context.run();
  const calls = child.faux.state.callCount;
  const ports = terminalPorts();
  const parent = await agencyGraph(ports.source, ports.sink);
  const graph = parent.context.graph;
  const nested = graph.addNode({
    description: "child",
    trigger: TriggerRule.always(),
    state: child.context,
  });
  ports.connect(graph, nested);
  try {
    await parent.context.run();
    assert.equal(resultText(graph, nested), "leaf result");
    assert.equal(child.faux.state.callCount, calls);
    assert.equal(child.member.faux.state.callCount, 1);
  } finally {
    await graph.close();
  }
});

test("a quiescent nested graph without its sink result fails before dependent work", async () => {
  const childPorts = terminalPorts();
  const child = await agencyGraph(childPorts.source, childPorts.sink);
  const blocked = await leaf([fauxAssistantMessage("must remain blocked")]);
  const terminal = child.context.graph.addNode({
    description: "blocked terminal",
    prompt: "Wait for work",
    trigger: TriggerRule.never(),
    policy: LockPolicy,
    state: blocked.agent,
  });
  childPorts.connect(child.context.graph, terminal);
  const parentPorts = terminalPorts();
  const parent = await agencyGraph(parentPorts.source, parentPorts.sink);
  const graph = parent.context.graph;
  const nested = graph.addNode({
    description: "child",
    trigger: TriggerRule.always(),
    state: child.context,
  });
  parentPorts.connect(graph, nested);
  try {
    await assert.rejects(parent.context.run(), (thrown: unknown) => {
      let error = thrown;
      while (
        error instanceof Error &&
        !(error instanceof JuncoAgentError) &&
        error.cause !== undefined
      )
        error = error.cause;
      return error instanceof JuncoAgentError && error.code === "invalid_state";
    });
    assert.ok(O.isNone(graph.result(nested)));
    assert.equal(child.faux.state.callCount, 0);
    assert.equal(blocked.faux.state.callCount, 0);
  } finally {
    await graph.close();
  }
});
