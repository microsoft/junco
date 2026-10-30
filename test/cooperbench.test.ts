import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { JuncoAgent } from "junco-agent";
import {
  createPair,
  type PairRequest,
  parseRequest,
} from "../examples/cooperbench/run.ts";
import type { YamlAgent } from "../examples/support.ts";
import { graph, syntax, tracer } from "../src/index.ts";
import { nativeOptions } from "./support.ts";

type Key = "agent1" | "agent2";
const SENTINEL: Record<Key, string> = {
  agent1: "ASSIGNMENT-SENTINEL-ONE",
  agent2: "ASSIGNMENT-SENTINEL-TWO",
};
const NOTE: Record<Key, string> = {
  agent1: "PEER-NOTE-FROM-ONE",
  agent2: "PEER-NOTE-FROM-TWO",
};
const LATE = "LATE-NOTE-FROM-TWO";

const request: PairRequest = {
  mode: "run",
  model: "faux/unused",
  thinking: "off",
  timeout_ms: 7_200_000,
  problem_dir: "/tmp/cooperbench-pair",
  agents: {
    agent1: {
      feature_id: 3,
      task: `Implement ${SENTINEL.agent1}.`,
      container_id: "a".repeat(64),
    },
    agent2: {
      feature_id: 7,
      task: `Implement ${SENTINEL.agent2}.`,
      container_id: "b".repeat(64),
    },
  },
};

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** The last message of a request, which must be a tool result; its text and error flag. */
function lastResult(messages: readonly Message[]): {
  text: string;
  isError: boolean;
} {
  const last = messages.at(-1);
  assert.ok(
    last?.role === "toolResult",
    `expected a tool result, got ${last?.role}`,
  );
  return { text: contentText(last.content), isError: last.isError };
}

/**
 * Real native agents over faux models. Each reads its assignment, calls info, tries `task`, sends
 * its peer one note and yields; on resumption it reads the peer's note. Agent1 then finishes;
 * Agent2 yields once more, sends a late note to the finished Agent1, and finishes.
 */
async function pair() {
  const requests: Record<Key, Message[][]> = { agent1: [], agent2: [] };
  const seen: Record<
    Key,
    Record<string, { text: string; isError: boolean }>
  > = { agent1: {}, agent2: {} };
  const script = (key: Key): FauxResponseStep[] => {
    const out = key === "agent1" ? "agent1-to-agent2" : "agent2-to-agent1";
    const step =
      (
        record: string | undefined,
        next: () => AssistantMessage,
      ): FauxResponseStep =>
      (context) => {
        requests[key].push(context.messages);
        if (record !== undefined)
          seen[key][record] = lastResult(context.messages);
        return next();
      };
    const steps = [
      step(undefined, () => call("recv", {})),
      step("assignment", () => call("info", {})),
      step("info", () => call("task", { assignment: "spawn a helper" })),
      step("task", () => call("send", { id: out, payload: NOTE[key] })),
      step("send", () => call("yield", { reason: "await peer plan" })),
      step(undefined, () => call("recv", {})),
    ];
    if (key === "agent1")
      return [
        ...steps,
        step("peer", () => fauxAssistantMessage("agent1 done")),
      ];
    return [
      ...steps,
      step("peer", () => call("yield", { reason: "let the lead finish" })),
      step(undefined, () =>
        call("send", {
          id: "agent2-to-agent1",
          payload: LATE,
        }),
      ),
      step("late", () => fauxAssistantMessage("agent2 done")),
    ];
  };
  const created: string[] = [];
  const agents: YamlAgent[] = [];
  const execution = await createPair(request, {
    tracer: new tracer.DummyTracer(),
    createAgent: async (spec) => {
      created.push(spec.node);
      const { options } = await nativeOptions(
        script(spec.node === "Agent1" ? "agent1" : "agent2"),
      );
      const agent: YamlAgent = await JuncoAgent.fromResolved({
        ...options,
        systemPrompt: spec.systemPrompt,
        tools: spec.tools as AgentTool[],
        tool_block: [
          ...new Set([
            ...(options.tool_block ?? []),
            ...(spec.tool_block ?? []),
          ]),
        ],
      });
      agents.push(agent);
      return agent;
    },
  });
  return { execution, requests, seen, created, agents };
}

test("each agent sees only its own assignment, exchanges one note, and a late note starts no further run", async () => {
  const { execution, requests, seen, created, agents } = await pair();
  try {
    const results = await execution.run();
    assert.equal(
      syntax.finalText(results.get(graph.NodeId.create("Agent1")), "Agent1"),
      "agent1 done",
    );
    assert.equal(
      syntax.finalText(results.get(graph.NodeId.create("Agent2")), "Agent2"),
      "agent2 done",
    );

    for (const [key, other] of [
      ["agent1", "agent2"],
      ["agent2", "agent1"],
    ] as const) {
      assert.ok(seen[key].assignment!.text.includes(SENTINEL[key]));
      // Nothing the model ever received — prompts, recv, info or peer notes — names the other assignment.
      for (const messages of requests[key])
        assert.ok(!JSON.stringify(messages).includes(SENTINEL[other]));
      assert.ok(
        !seen[key].info!.text.includes(SENTINEL[key]),
        "info exposes routes, not assignments",
      );
      // Recursive delegation is unavailable: the model's task call fails as an unknown tool.
      assert.equal(seen[key].task!.isError, true);
      assert.equal(seen[key].send!.isError, false);
      // send -> yield -> recv delivers exactly the one note the peer sent.
      const delivered = seen[key].peer!.text;
      assert.equal(delivered.split(NOTE[other]).length - 1, 1);
      assert.ok(!delivered.includes(NOTE[key]));
    }
    assert.equal(seen.agent2.late!.isError, false);

    const lead = requests.agent1.length;
    assert.equal(lead, 7);
    assert.ok(
      requests.agent1.every(
        (messages) => !JSON.stringify(messages).includes(LATE),
      ),
    );
    await execution.run();
    assert.equal(
      requests.agent1.length,
      lead,
      "the late note must not reopen the finished lead",
    );
    assert.equal(requests.agent2.length, 9);
    assert.deepEqual(created, ["Agent1", "Agent2"]);
  } finally {
    await execution.graph.close();
  }
  assert.ok(agents.every((agent) => agent.status === "closed"));
}, 10_000);

test("the request boundary rejects malformed, unknown or ambiguous input before any model work", () => {
  const valid = JSON.stringify(request);
  expect(parseRequest(valid)).toEqual(request);
  expect(
    parseRequest(
      '{"mode":"preflight","model":"openai/gpt-5.5","thinking":"off"}',
    ).mode,
  ).toBe("preflight");
  const variants: Record<string, unknown> = {
    "extra field": { ...request, extra: 1 },
    "other thinking": { ...request, thinking: "high" },
    "other deadline": { ...request, timeout_ms: 60_000 },
    "model without provider": { ...request, model: "gpt-5.5" },
    "relative problem_dir": { ...request, problem_dir: "logs/pair" },
    "third agent": {
      ...request,
      agents: { ...request.agents, agent3: request.agents.agent1 },
    },
    "blank task": {
      ...request,
      agents: {
        ...request.agents,
        agent2: { ...request.agents.agent2, task: " \n\t" },
      },
    },
    "short container": {
      ...request,
      agents: {
        ...request.agents,
        agent2: { ...request.agents.agent2, container_id: "abc" },
      },
    },
    "shared container": {
      ...request,
      agents: {
        ...request.agents,
        agent2: { ...request.agents.agent2, container_id: "a".repeat(64) },
      },
    },
    "shared feature": {
      ...request,
      agents: {
        ...request.agents,
        agent2: { ...request.agents.agent2, feature_id: 3 },
      },
    },
  };
  expect(() => parseRequest("{not json")).toThrow(/not JSON/);
  for (const [name, value] of Object.entries(variants))
    expect(() => parseRequest(JSON.stringify(value)), name).toThrow(
      /invalid request/,
    );
});
