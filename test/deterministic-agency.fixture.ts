import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { always, anyOf, messageEdge, msg, NodeId, on, valueEdge } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticInput, agentNode, MockAgent } from "../src/index.ts";
import { policyGraph, type Strategy, STRATEGIES, textOf, userTexts, yieldsThen } from "./deterministic-support.ts";

// Directly executable deterministic smoke: one producer/worker JuncoGraph per policy, real graph
// windows over MockAgent members, closed through the graph's recursive close. No provider or credentials.

export type DeterministicSummary = {
  readonly scheduler: Strategy;
  readonly producer: string;
  readonly worker: string;
  readonly inputs: readonly string[];
  readonly closed: boolean;
};

/** Run the producer/worker agency on `strategy` to quiescence, close it, and summarize it. */
export async function runDeterministicFixture(strategy: Strategy): Promise<DeterministicSummary> {
  const producer = new MockAgent({ prompt: "produce", runs: [yieldsThen(1, "seed")] });
  const worker = new MockAgent({ runs: [yieldsThen(1, "done")] });
  await using graph = policyGraph(strategy);
  const handoff = messageEdge<AgenticInput, AssistantMessage>("producer->worker");
  const value = valueEdge<AgenticInput, AssistantMessage>("producer=>worker");
  const p = graph.addNode(
    agentNode(
      producer,
      { id: NodeId("producer"), description: "produces the seed", trigger: always() },
      {
        emit: () => [
          msg(handoff, { kind: "nextTurn", text: "context first" }),
          msg(handoff, { kind: "prompt", text: "then work" }),
        ],
      },
    ),
  );
  const w = graph.addNode(
    agentNode(
      worker,
      { id: NodeId("worker"), description: "works from the seed", trigger: anyOf(on(handoff), on(value)) },
      {
        receive: (view) => [
          ...[...view.values.keys()].map(
            (id): AgenticInput => ({
              kind: "appendMessage",
              message: { role: "user", content: `upstream: ${textOf(view.values.get(id)!)}`, timestamp: 0 },
            }),
          ),
          ...(view.messages.get(handoff.id) ?? []),
        ],
      },
    ),
  );
  graph.addEdge(p, w, handoff).addEdge(p, w, value);

  await graph.run();

  const results = [p, w].map((id) => {
    const result = graph.result(id);
    assert.ok(O.isSome(result), `${id} has no result`);
    return textOf(result.value);
  });
  assert.deepEqual(results, ["seed", "done"]);
  const inputs = userTexts(worker.requests.at(-1)?.messages ?? []);
  assert.deepEqual(inputs, ["upstream: seed", "context first", "then work"]);
  await graph.close();
  const closed = graph.signal.aborted && [producer, worker].every((agent) => agent.status === "closed");
  assert.ok(closed);
  return { scheduler: strategy, producer: results[0]!, worker: results[1]!, inputs, closed };
}

if (import.meta.main) {
  for (const strategy of STRATEGIES) console.log(JSON.stringify(await runDeterministicFixture(strategy)));
}
