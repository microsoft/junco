import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Context, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DataflowNodeError } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import { createGoalProgressTool, createMixedGraph, goalsPrompt } from "../examples/mixed.ts";
import { nativeOptions } from "./support.ts";

type Role = "Ralph" | "Direct" | "Reviewer";

/** The most recent user message of a model request, including array-form Pi content. */
function latestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.type === "text" ? block.text : "").join("");
  }
  throw new Error("Scripted request has no user message");
}

/**
 * Real agents over faux models. Ralph's run r reports `snapshots[r]` through `report_goals` and then
 * returns `draft-(r+1)`; `undefined` returns the draft without reporting. Dispose it to close every
 * agent.
 */
async function mixedWorkflow(snapshots: readonly (readonly number[] | undefined)[]) {
  const progress = createGoalProgressTool();
  const prompts: Record<Role, string[]> = { Ralph: [], Direct: [], Reviewer: [] };
  const events: string[] = [];
  const updates: string[] = [];
  /** Record each fresh user prompt `role` receives, then answer with `response`. */
  const recording = (role: Role, response: AssistantMessage): FauxResponseStep => (context) => {
    if (context.messages.at(-1)?.role === "user") {
      prompts[role].push(latestUserText(context));
      events.push(`${role} prompt`);
    }
    return response;
  };
  const ralphResponses = snapshots.flatMap((completed, index) => {
    const draft = fauxAssistantMessage(`draft-${index + 1}`);
    return completed === undefined
      ? [recording("Ralph", draft)]
      : [
          recording("Ralph", fauxAssistantMessage(
            [fauxToolCall("report_goals", { completed }, { id: `progress-${index + 1}` })],
            { stopReason: "toolUse" },
          )),
          recording("Ralph", draft),
        ];
  });

  const agents: JuncoAgent[] = [];
  const agent = async (responses: readonly FauxResponseStep[], tools: AgentTool[]) => {
    const { options } = await nativeOptions(responses);
    const created = await JuncoAgent.fromResolved({ ...options, tools });
    agents.push(created);
    return created;
  };
  try {
    const members = {
      Ralph: await agent(ralphResponses, [progress.tool]),
      Direct: await agent([recording("Direct", fauxAssistantMessage("direct-answer"))], []),
      Reviewer: await agent([recording("Reviewer", fauxAssistantMessage("Ralph: clearer coverage."))], []),
    };
    const { graph, reviewerId } = createMixedGraph(members, progress, (text) => {
      updates.push(text);
      events.push("update");
    });
    return {
      graph,
      reviewerId,
      agents,
      updates,
      prompts,
      events,
      async [Symbol.asyncDispose]() {
        await Promise.all(agents.map((created) => created.return()));
      },
    };
  } catch (error) {
    await Promise.allSettled(agents.map((created) => created.return()));
    throw error;
  }
}

/** Step the graph until `done`, failing instead of spinning once nothing can run. */
async function stepUntil(
  graph: { available(): ReadonlyMap<unknown, unknown>; step(): Promise<unknown> },
  done: () => boolean,
) {
  while (!done()) {
    if (graph.available().size === 0) throw new Error("Graph stalled before the expected update");
    await graph.step();
  }
}

test("Ralph keeps iterating through no progress and partial progress, and only its final draft is reviewed", async () => {
  let agents: readonly JuncoAgent[];
  {
    await using flow = await mixedWorkflow([[], [1], [1, 2, 3]]);
    agents = flow.agents;
    const { graph, reviewerId, updates, prompts } = flow;

    await stepUntil(graph, () => updates.length === 1);
    assert.equal(prompts.Reviewer.length, 0);
    assert.ok(O.isNone(graph.result(reviewerId)));
    await stepUntil(graph, () => updates.length === 2);
    assert.equal(prompts.Reviewer.length, 0);
    assert.ok(O.isNone(graph.result(reviewerId)));
    await stepUntil(graph, () => updates.length === 3);

    const results = await graph.run();
    assert.ok(results.get(reviewerId) !== undefined);
    updates.forEach((text, index) => assert.ok(text.includes(`draft-${index + 1}`), text));

    assert.equal(prompts.Ralph.length, 3);
    assert.equal(prompts.Ralph[0], goalsPrompt);
    assert.deepEqual(prompts.Direct, [goalsPrompt]);
    assert.ok(prompts.Ralph[1]!.includes("Remaining goal numbers: 1, 2, 3"));
    assert.ok(prompts.Ralph[2]!.includes("Remaining goal numbers: 2, 3"));

    assert.equal(prompts.Reviewer.length, 1);
    const review = prompts.Reviewer[0]!;
    assert.ok(review.includes("direct-answer"));
    assert.ok(review.includes("draft-3"));
    assert.ok(!review.includes("draft-1") && !review.includes("draft-2"));
    assert.ok(flow.events.indexOf("Reviewer prompt") > flow.events.lastIndexOf("update"));
  }
  assert.ok(agents.every((agent) => agent.status === "closed"));
}, 5_000);

test("goals completed on the first run end the loop without another Ralph run", async () => {
  let agents: readonly JuncoAgent[];
  {
    await using flow = await mixedWorkflow([[1, 2, 3]]);
    agents = flow.agents;
    const results = await flow.graph.run();
    assert.ok(results.get(flow.reviewerId) !== undefined);
    assert.equal(flow.updates.length, 1);
    assert.ok(flow.updates[0]!.includes("draft-1"));
    assert.equal(flow.prompts.Ralph.length, 1);
    assert.equal(flow.prompts.Reviewer.length, 1);
  }
  assert.ok(agents.every((agent) => agent.status === "closed"));
}, 5_000);

test("a draft without a goal report fails the graph even after earlier progress", async () => {
  let agents: readonly JuncoAgent[];
  {
    await using flow = await mixedWorkflow([[1], undefined]);
    agents = flow.agents;
    await assert.rejects(flow.graph.run(), (error: unknown) => {
      assert.ok(error instanceof DataflowNodeError);
      assert.equal(error.nodeId, "Ralph");
      const inner: unknown = error.error;
      assert.ok(inner instanceof DataflowNodeError);
      assert.equal(inner.nodeId, "RalphStep");
      assert.ok(inner.error instanceof Error);
      assert.equal(inner.error.message, "Ralph did not report completed goals");
      return true;
    });
    assert.equal(flow.updates.length, 1);
    assert.ok(flow.updates[0]!.includes("draft-1"));
    assert.equal(flow.prompts.Reviewer.length, 0);
  }
  assert.ok(agents.every((agent) => agent.status === "closed"));
}, 5_000);
