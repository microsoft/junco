import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  always,
  NodeId,
  type NodeIdType,
  valueEdge,
  when,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticStep, JuncoAgentError } from "junco-agent";
import type { PiScheduler, SchedulerInfo } from "junco-scheduler/agent";
import {
  type AgenticInput,
  agentNode,
  graphNode,
  type JuncoGraph,
} from "../src/index.ts";
import {
  agencyGraph,
  drive,
  leaf,
  runAvailable,
  type Script,
  scheduleCall,
  settledText,
} from "./support.ts";

// Agency scheduling over Pi members: repeated plans, window availability, dynamic nodes and nested
// Pi graphs. The agency adapter's own contracts live in agency.test.ts; the generic schedule tool,
// plan validation and lifetime cases live with PiScheduler in junco-scheduler.

const textOf = (message: AssistantMessage) =>
  message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
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
    agentNode(member.agent, {
      description: "the member",
      trigger: always(),
      policy: "LockPolicy",
    }),
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

test("a repeated occurrence after its member returned keeps the result", async () => {
  const { scheduler, graph } = await singleMember(
    [
      toolTurn(scheduleCall([["0", "0", "0"]], "all")),
      fauxAssistantMessage("finished"),
    ],
    "kept",
  );

  assert.equal(settledText(await drive(scheduler)), "finished");
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
      policy: "LockPolicy",
    }),
  );
  const c = graph.addNode(
    agentNode(consumer.agent, {
      id: NodeId("consumer"),
      description: "consumer",
      trigger: when(edge),
      policy: "LockPolicy",
    }),
  );
  graph.addEdge(p, c, edge);
  const errors = toolErrors(scheduler);

  assert.equal(settledText(await drive(scheduler)), "graph quiescent");
  assert.equal(errors[1], true);
  assert.equal(producer.faux.state.callCount, 1);
  assert.deepEqual(
    [resultOf(graph, p), resultOf(graph, c)],
    ["produced", "consumed"],
  );
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
            policy: "LockPolicy",
          }),
        );
      }
      return runAvailable(info);
    },
    { prompt: "go" },
  );
  graph.addNode(
    agentNode(first.agent, {
      description: "first member",
      trigger: always(),
      policy: "LockPolicy",
    }),
  );

  assert.equal(settledText(await drive(scheduler)), "graph quiescent");
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
    agentNode(member.agent, {
      description: "leaf",
      trigger: always(),
      policy: "LockPolicy",
    }),
  );
  const parent = await agencyGraph(runAvailable, { prompt: "run parent" });
  const edge = valueEdge<AgenticInput, AssistantMessage>("child->consumer");
  let childRequestsAtDelivery: number | undefined;
  const consumer = await leaf([
    () => {
      childRequestsAtDelivery = child.faux.state.callCount;
      return fauxAssistantMessage("consumed");
    },
  ]);
  const nested = parent.graph.addNode(
    graphNode(
      child.graph,
      { description: "child", trigger: always(), policy: "LockPolicy" },
      { result: leafId },
    ),
  );
  const c = parent.graph.addNode(
    agentNode(
      consumer.agent,
      {
        description: "consumer",
        trigger: when(edge),
        policy: "LockPolicy",
      },
      { prompt: "consume" },
    ),
  );
  parent.graph.addEdge(nested, c, edge);

  assert.equal(
    settledText(await drive(parent.scheduler)),
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
    agentNode(member.agent, {
      description: "leaf",
      trigger: always(),
      policy: "LockPolicy",
    }),
  );
  assert.equal(
    settledText(await drive(child.scheduler)),
    "graph quiescent",
  );
  const childRequests = child.faux.state.callCount;

  const parent = await agencyGraph(runAvailable, { prompt: "run parent" });
  const nested = parent.graph.addNode(
    graphNode(
      child.graph,
      { description: "child", trigger: always(), policy: "LockPolicy" },
      { result: leafId },
    ),
  );
  assert.equal(
    settledText(await drive(parent.scheduler)),
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
    agentNode(member.agent, {
      description: "leaf",
      trigger: always(),
      policy: "LockPolicy",
    }),
  );
  const parent = await agencyGraph(runAvailable, { prompt: "run parent" });
  const nested = parent.graph.addNode(
    graphNode(
      child.graph,
      { description: "child", trigger: always(), policy: "LockPolicy" },
      { result: leafId },
    ),
  );

  const error = failureOf(await drive(parent.scheduler));
  assert.ok(invalidState(error) && error instanceof JuncoAgentError);
  assert.ok(O.isNone(parent.graph.result(nested)));
  assert.equal(child.faux.state.callCount + member.faux.state.callCount, 0);
  await parent.graph.close();
});
