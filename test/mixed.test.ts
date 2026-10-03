import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AssistantMessage,
  type Context,
  type FauxResponseStep,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { NodeId } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import { createMixedGraph, goalsPrompt } from "../examples/mixed.ts";
import { Deterministic } from "../src/index.ts";
import { nativeOptions } from "./support.ts";

type Role = "Ralph" | "Direct" | "Reviewer";

/** The most recent user message of a model request, including array-form Pi content. */
function latestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
  }
  throw new Error("Scripted request has no user message");
}

/**
 * Real toolless agents over faux models. Ralph's run r returns `draft-r`; with `failSecond` its
 * second request throws instead. Dispose it to close the graph and every agent.
 */
async function mixedWorkflow(failSecond = false) {
  const prompts: Record<Role, string[]> = {
    Ralph: [],
    Direct: [],
    Reviewer: [],
  };
  const offeredTools: string[][] = [];
  /** Record each fresh user prompt `role` receives and the tools offered, then answer with `response`. */
  const recording =
    (role: Role, response: () => AssistantMessage): FauxResponseStep =>
    (context) => {
      offeredTools.push(
        context.messages.flatMap((message) =>
          message.role === "system"
            ? (message.toolsAdded?.map((tool) => tool.name) ?? [])
            : [],
        ),
      );
      if (context.messages.at(-1)?.role === "user")
        prompts[role].push(latestUserText(context));
      return response();
    };
  const ralphResponses = [
    recording("Ralph", () => fauxAssistantMessage("draft-1")),
    recording("Ralph", () => {
      if (failSecond) throw new Error("second Ralph round failed");
      return fauxAssistantMessage("draft-2");
    }),
  ];

  const agents: JuncoAgent[] = [];
  const agent = async (responses: readonly FauxResponseStep[]) => {
    const { options } = await nativeOptions(responses);
    const created = await JuncoAgent.fromResolved({ ...options, tools: [] });
    agents.push(created);
    return created;
  };
  try {
    const members = {
      Ralph: await agent(ralphResponses),
      Direct: await agent([
        recording("Direct", () => fauxAssistantMessage("direct-answer")),
      ]),
      Reviewer: await agent([
        recording("Reviewer", () =>
          fauxAssistantMessage("Ralph: clearer coverage."),
        ),
      ]),
    };
    const { graph, reviewerId } = createMixedGraph(members);
    return {
      graph,
      reviewerId,
      agents,
      prompts,
      offeredTools,
      async [Symbol.asyncDispose]() {
        await graph.close();
      },
    };
  } catch (error) {
    await Promise.allSettled(agents.map((created) => created.return()));
    throw error;
  }
}

/** Step the graph until `done`, failing instead of spinning once nothing can run. */
async function stepUntil(
  graph: {
    available(): ReadonlyMap<unknown, unknown>;
    step(): Promise<unknown>;
  },
  done: () => boolean,
) {
  while (!done()) {
    if (graph.available().size === 0)
      throw new Error("Graph stalled before the expected request");
    await graph.step();
  }
}

const ralphId = NodeId("Ralph");

test("Ralph runs two full-assignment rounds and only its final draft is reviewed", async () => {
  let agents: readonly JuncoAgent[];
  let goalsSource: unknown;
  {
    await using flow = await mixedWorkflow();
    agents = flow.agents;
    const { graph, reviewerId, prompts } = flow;
    goalsSource = graph.getNode(NodeId("Goals"))?.state;

    await stepUntil(graph, () => prompts.Ralph.length === 1);
    assert.equal(prompts.Reviewer.length, 0);
    assert.ok(O.isNone(graph.result(ralphId)));
    assert.ok(O.isNone(graph.result(reviewerId)));

    const results = await graph.run();
    assert.ok(results.get(reviewerId) !== undefined);
    assert.equal(prompts.Ralph.length, 2);
    assert.equal(prompts.Ralph[0], goalsPrompt);
    assert.ok(prompts.Ralph[1]!.includes(goalsPrompt));
    assert.ok(prompts.Ralph[1]!.includes("draft-1"));
    assert.deepEqual(prompts.Direct, [goalsPrompt]);

    assert.equal(prompts.Reviewer.length, 1);
    const review = prompts.Reviewer[0]!;
    assert.ok(review.includes("direct-answer"));
    assert.ok(review.includes("draft-2"));
    assert.ok(!review.includes("draft-1"));
    assert.ok(flow.offeredTools.every((tools) => tools.length === 0));

    await graph.run();
    assert.deepEqual(
      [prompts.Ralph.length, prompts.Direct.length, prompts.Reviewer.length],
      [2, 1, 1],
    );
  }
  assert.ok(agents.every((agent) => agent.status === "closed"));
  assert.ok(goalsSource instanceof Deterministic && goalsSource.signal.aborted);
}, 5_000);

test("a failed second Ralph round rejects the graph and never reaches the Reviewer", async () => {
  await using flow = await mixedWorkflow(true);
  const { graph, reviewerId, prompts } = flow;

  await assert.rejects(() => graph.run());
  assert.equal(prompts.Ralph.length, 2);
  assert.ok(O.isNone(graph.result(ralphId)));
  assert.ok(O.isNone(graph.result(reviewerId)));
  assert.equal(prompts.Reviewer.length, 0);
  assert.ok(
    flow.offeredTools.length > 0 &&
      flow.offeredTools.every((tools) => tools.length === 0),
  );
}, 5_000);
