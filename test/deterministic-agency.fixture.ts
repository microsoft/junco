import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  Edge,
  type EdgeIdType,
  NodeId,
  TriggerEntry,
  TriggerRule,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticInput, tools } from "../src/index.ts";
import {
  policyGraph,
  STRATEGIES,
  type Strategy,
  textOf,
} from "./deterministic-support.ts";
import { leaf } from "./support.ts";

// Directly executable deterministic smoke: one producer/worker JuncoGraph per policy over real
// faux-backed JuncoAgents. The producer discovers its route through `info` and `send`s on it; the
// worker discovers its parents and consumes its retained inbox through `recv`. No credentials.

export type DeterministicSummary = {
  readonly scheduler: Strategy;
  readonly producer: string;
  readonly worker: string;
  readonly inputs: readonly string[];
  readonly closed: boolean;
};

type Route = {
  readonly id: string;
  readonly edgeId: string;
  readonly kind: "message" | "value";
  readonly expect: string;
};
type Info = { readonly parents: Route[]; readonly children: Route[] };
type Received = {
  readonly messages: { id: string; payload: AgenticInput }[];
  readonly values: { id: string; payload: AssistantMessage }[];
};

/** Parsed JSON results of every `name` tool call in `context`, in order. */
function results<R>(messages: readonly AgentMessage[], name: string): R[] {
  return messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === name
      ? [
          JSON.parse(
            message.content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join(""),
          ) as R,
        ]
      : [],
  );
}

const MESSAGE_EXPECT =
  "AgenticInput text messages retained in FIFO order for the worker's input list.";
const VALUE_EXPECT =
  "The producer's final assistant seed, consumed once before the worker finishes.";

/** Run the producer/worker agency on `strategy` to quiescence, close it, and summarize it. */
export async function runDeterministicFixture(
  strategy: Strategy,
): Promise<DeterministicSummary> {
  const handoff = Edge.message<AgenticInput, AssistantMessage>(
    "producer->worker",
  );
  const value = Edge.value<AgenticInput, AssistantMessage>("producer=>worker");
  const infos: Record<"producer" | "worker", Info[]> = {
    producer: [],
    worker: [],
  };

  const sendOnRoute: FauxResponseFactory = (context) => {
    const info = results<Info>(context.messages, "info").at(-1)!;
    infos.producer.push(info);
    const route = info.children.find((child) => child.kind === "message");
    if (!route) return fauxAssistantMessage("no message route");
    return fauxAssistantMessage(
      [
        { kind: "nextTurn", text: "context first" },
        { kind: "prompt", text: "then work" },
      ].map((payload, index) =>
        fauxToolCall(
          "send",
          { id: route.edgeId, payload },
          { id: `send-${index}` },
        ),
      ),
      { stopReason: "toolUse" },
    );
  };
  const producer = await leaf(
    [
      fauxAssistantMessage(fauxToolCall("info", {}, { id: "info" }), {
        stopReason: "toolUse",
      }),
      sendOnRoute,
      fauxAssistantMessage(
        fauxToolCall("yield", { reason: "sent" }, { id: "y" }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("seed"),
    ],
    { prompt: "produce", tools: [new tools.InfoTool(), new tools.SendTool()] },
  );

  let received: Received[] = [];
  const work: FauxResponseFactory = (context) => {
    const info = results<Info>(context.messages, "info");
    if (info.length === 0)
      return fauxAssistantMessage(fauxToolCall("info", {}), {
        stopReason: "toolUse",
      });
    if (infos.worker.length === 0) infos.worker.push(info[0]!);
    const got = results<Received>(context.messages, "recv");
    const messages = got.flatMap((r) => r.messages);
    const values = got.flatMap((r) => r.values);
    if (messages.length >= 2 && values.length >= 1) {
      received = got;
      return fauxAssistantMessage("done");
    }
    return fauxAssistantMessage(
      context.messages.at(-1)?.role === "toolResult" &&
        (context.messages.at(-1) as { toolName?: string }).toolName === "recv"
        ? fauxToolCall("yield", { reason: "waiting for the seed" })
        : fauxToolCall("recv", {}),
      { stopReason: "toolUse" },
    );
  };
  const contracts: Record<string, tools.Contract> = {
    [handoff.id]: { expect: MESSAGE_EXPECT },
    [value.id]: { expect: VALUE_EXPECT },
  };
  const worker = await leaf(
    Array.from({ length: 12 }, () => work),
    {
      prompt: "work",
      tools: [new tools.InfoTool(), new tools.RecvTool()],
      contract: (edgeId: EdgeIdType) => {
        const contract = contracts[edgeId];
        if (!contract) throw new Error(`No contract for edge "${edgeId}"`);
        return contract;
      },
    },
  );

  await using graph = policyGraph(strategy);
  const p = graph.addNode({
    id: NodeId.create("producer"),
    state: producer.agent,
    description: "produces the seed",
    policy: tools.LockPolicy,
    trigger: TriggerRule.always(),
  });
  const w = graph.addNode({
    id: NodeId.create("worker"),
    state: worker.agent,
    policy: tools.LockPolicy,
    description: "works from the seed",
    trigger: TriggerRule.anyOf(
      TriggerEntry.on(handoff),
      TriggerEntry.on(value),
    ),
  });
  graph.addEdge(p, w, handoff).addEdge(p, w, value);

  await graph.run();

  const outputs = [p, w].map((id) => {
    const result = graph.result(id);
    assert.ok(O.isSome(result), `${id} has no result`);
    return textOf(result.value);
  });
  assert.deepEqual(outputs, ["seed", "done"]);

  const routes: Route[] = [
    { id: w, edgeId: handoff.id, kind: "message", expect: MESSAGE_EXPECT },
    { id: w, edgeId: value.id, kind: "value", expect: VALUE_EXPECT },
  ];
  const byEdge = (a: Route, b: Route) => a.edgeId.localeCompare(b.edgeId);
  const [producerInfo] = infos.producer;
  assert.deepEqual(producerInfo?.parents, []);
  assert.deepEqual(
    [...(producerInfo?.children ?? [])].sort(byEdge),
    [...routes].sort(byEdge),
  );
  assert.deepEqual(
    [...(infos.worker[0]?.parents ?? [])].sort(byEdge),
    routes.map((route) => ({ ...route, id: p })).sort(byEdge),
  );
  assert.deepEqual(infos.worker[0]?.children, []);

  // Parent result first, then message FIFO, from what recv actually returned.
  const inputs = [
    ...received
      .flatMap((r) => r.values)
      .map((v) => `upstream: ${textOf(v.payload)}`),
    ...received
      .flatMap((r) => r.messages)
      .map((m) => ("text" in m.payload ? m.payload.text : "")),
  ];
  assert.deepEqual(inputs, ["upstream: seed", "context first", "then work"]);

  await graph.close();
  const closed =
    graph.signal.aborted &&
    [producer.agent, worker.agent].every((agent) => agent.status === "closed");
  assert.ok(closed);
  return {
    scheduler: strategy,
    producer: outputs[0]!,
    worker: outputs[1]!,
    inputs,
    closed,
  };
}

if (import.meta.main) {
  for (const strategy of STRATEGIES)
    console.log(JSON.stringify(await runDeterministicFixture(strategy)));
}
