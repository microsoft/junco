import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import {
  AssistantMessageSchema,
  agent as agentApi,
  graph,
  JuncoGraph,
  schedules,
  tracer,
  workflows,
} from "junco";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { nativeOptions } from "./support.ts";

const assignment = "Cover every section.\nKeep the original constraints.";
const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;
/** The text of a retained YAML result, which must be an assistant message. */
function textOf(result: unknown): string {
  assert.ok(Value.Check(AssistantMessageSchema, result));
  return contentText(result.content);
}

async function ralphWorkflow(
  ralph: schedules.RalphOptions,
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
  let agent:
    | agentApi.JuncoAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>
    | undefined;
  try {
    const execution = await JuncoGraph.fromYaml(workflows.ralph, {
      cwd: process.cwd(),
      scheduler: () => schedules.parallel(),
      tracer: new tracer.DummyTracer(),
      createAgent: async (spec) => {
        agent = await agentApi.JuncoAgent.fromResolved({
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
        return agent;
      },
      ...schedules.ralph(ralph),
    });
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
  const { execution, agent, prompts } = await ralphWorkflow({ rounds: 3 }, [
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
    assert.equal(textOf(final), "draft-3");
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
  const { execution, prompts } = await ralphWorkflow({ rounds: 1 }, [
    "draft-1",
  ]);
  try {
    const results = await execution.run();
    assert.deepEqual(prompts, [assignment]);
    assert.equal(textOf(results.get(execution.graph.sink.id)), "draft-1");
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("a native yield resumes within a round and never counts as one", async () => {
  const { execution, prompts } = await ralphWorkflow({ rounds: 2 }, [
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
    assert.equal(textOf(results.get(execution.graph.sink.id)), "draft-2");
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("until judges only completed drafts and publishes the accepted one", async () => {
  const judged: string[] = [];
  const { execution, prompts } = await ralphWorkflow(
    {
      until: (result) => {
        judged.push(contentText(result.content));
        return judged.length === 2;
      },
    },
    [
      fauxAssistantMessage(
        [fauxToolCall("yield", { reason: "continue" }, { id: "y1" })],
        { stopReason: "toolUse" },
      ),
      "draft-1",
      "draft-2",
      "unreachable",
    ],
  );
  try {
    const results = await execution.run();
    assert.deepEqual(judged, ["draft-1", "draft-2"]);
    assert.deepEqual(prompts, [assignment, revision("draft-1")]);
    assert.equal(textOf(results.get(execution.graph.sink.id)), "draft-2");
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("a blank intermediate draft fails before the next round", async () => {
  const { execution, prompts } = await ralphWorkflow({ rounds: 3 }, [
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
