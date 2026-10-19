import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import {
  agent as agentApi,
  graph,
  schedules,
  tracer,
  workflows,
} from "junco-agency";
import { build, parse } from "junco-syntax";
import { nativeOptions } from "./support.ts";

const assignment = "Cover every section.\nKeep the original constraints.";
const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

async function ralphWorkflow(
  rounds: number,
  responses: readonly (string | AssistantMessage)[],
) {
  const prompts: string[] = [];
  const { options } = await nativeOptions(
    responses.map(
      (reply): FauxResponseStep =>
        (context) => {
          const last = context.messages.at(-1);
          if (last?.role === "user")
            prompts.push(
              typeof last.content === "string"
                ? last.content
                : contentText(last.content),
            );
          return typeof reply === "string"
            ? fauxAssistantMessage(reply)
            : reply;
        },
    ),
  );
  let agent: agentApi.JuncoAgent | undefined;
  try {
    const execution = await build(
      parse(workflows.ralph, { params: { model: "faux/ralph" } }),
      {
        cwd: process.cwd(),
        scheduler: () => schedules.parallel(),
        tracer: new tracer.DummyTracer(),
        createAgent: async (spec) => {
          agent = await agentApi.JuncoAgent.fromResolved({
            ...options,
            systemPrompt: spec.systemPrompt,
            tools: spec.tools as AgentTool[],
          });
          return agent;
        },
        ...schedules.ralph({ rounds }),
      },
    );
    assert.ok(agent);
    execution.graph.source.enqueue({
      messages: new Map([
        [
          graph.EdgeId.create("assignment"),
          [{ kind: "prompt", text: assignment }],
        ],
      ]),
      values: new Map(),
    });
    return { execution, agent, prompts };
  } catch (error) {
    await agent?.return();
    throw error;
  }
}

test("three rounds revise in one session and only the last draft is the result", async () => {
  const { execution, agent, prompts } = await ralphWorkflow(3, [
    "draft-1",
    "draft-2",
    "draft-3",
  ]);
  try {
    const results = await execution.run();
    assert.deepEqual(prompts, [
      assignment,
      revision("draft-1"),
      revision("draft-2"),
    ]);
    const final = results.get(graph.NodeId.create("Ralph"));
    assert.ok(final);
    assert.equal(contentText(final.content), "draft-3");
    assert.equal(results.get(execution.graph.sink.id), final);
    await execution.run();
    assert.deepEqual(prompts, [
      assignment,
      revision("draft-1"),
      revision("draft-2"),
    ]);
  } finally {
    await execution.graph.close();
  }
  assert.equal(agent.status, "closed");
}, 10_000);

test("rounds: 1 asks once", async () => {
  const { execution, prompts } = await ralphWorkflow(1, ["draft-1"]);
  try {
    const results = await execution.run();
    assert.deepEqual(prompts, [assignment]);
    assert.equal(
      contentText(results.get(execution.graph.sink.id)!.content),
      "draft-1",
    );
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("a native yield resumes within a round and never counts as one", async () => {
  const { execution, prompts } = await ralphWorkflow(2, [
    fauxAssistantMessage(
      [fauxToolCall("yield", { reason: "continue" }, { id: "y1" })],
      {
        stopReason: "toolUse",
      },
    ),
    "draft-1",
    "draft-2",
  ]);
  try {
    const results = await execution.run();
    assert.deepEqual(prompts, [assignment, revision("draft-1")]);
    assert.equal(
      contentText(results.get(execution.graph.sink.id)!.content),
      "draft-2",
    );
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("a blank intermediate draft fails before the next round", async () => {
  const { execution, prompts } = await ralphWorkflow(3, [
    "draft-1",
    "  ",
    "unreachable",
  ]);
  try {
    await assert.rejects(
      execution.run(),
      (error: unknown) =>
        error instanceof graph.DataflowNodeError &&
        error.nodeId === graph.NodeId.create("Ralph") &&
        error.error instanceof Error &&
        /^Ralph produced an empty report$/.test(error.error.message),
    );
    assert.deepEqual(prompts, [assignment, revision("draft-1")]);
    assert.ok(O.isNone(execution.graph.result(execution.graph.sink.id)));
  } finally {
    await execution.graph.close();
  }
}, 10_000);
