import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type DataflowGraph,
  DataflowNodeError,
  type DataflowRunTrace,
  DummyTracer,
  EdgeId,
  NodeId,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { goalsPrompt, MixedGraph } from "../examples/mixed/mixed.ts";
import type { YamlAgent } from "../examples/support.ts";
import { AssistantMessageSchema, Deterministic, syntax } from "../src/index.ts";
import type { AgentSpec } from "../src/syntax/build.ts";
import { nativeOptions } from "./support.ts";

/** Records every raw message Reviewer is activated with on the nested graph's `Ralph~>Reviewer`. */
class ReviewerInbox extends DummyTracer {
  readonly received: unknown[] = [];

  override startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const run = super.startRun(graph);
    return {
      ...run,
      startNode: (id, phase, inputs) => {
        if (String(id) === "Reviewer")
          this.received.push(
            ...(inputs?.messages.get(EdgeId.create("Ralph~>Reviewer")) ?? []),
          );
        return run.startNode(id, phase, inputs);
      },
    };
  }
}

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
 * Real agents over faux models, built from the example's own construction options: Direct reads
 * its goals through recv and answers `directAnswer`; Reviewer's prompt is composed from the graph
 * inputs. Ralph's run r returns `draft-r`; with `failSecond` its second request throws instead.
 * Dispose it to close the graph and every agent.
 */
async function mixedWorkflow(
  failSecond = false,
  directAnswer = "direct-answer",
) {
  const prompts: Record<Role, string[]> = {
    Ralph: [],
    Direct: [],
    Reviewer: [],
  };
  /** Record each fresh user prompt `role` receives, then answer with `response`. */
  const recording =
    (role: Role, response: () => AssistantMessage): FauxResponseStep =>
    (context) => {
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

  /** Call recv, then record the one received prompt `role` was given and answer with `answer`. */
  const receiving = (role: Role, answer: string): FauxResponseStep[] => [
    () =>
      fauxAssistantMessage([fauxToolCall("recv", {}, { id: `${role}-recv` })], {
        stopReason: "toolUse",
      }),
    (context) => {
      const result = context.messages.at(-1);
      assert.ok(
        result?.role === "toolResult" && result.content[0]?.type === "text",
      );
      const { messages } = JSON.parse(result.content[0].text) as {
        messages: { payload: { kind: string; text: string } }[];
      };
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.payload.kind, "prompt");
      prompts[role].push(messages[0]!.payload.text);
      return fauxAssistantMessage(answer);
    },
  ];

  const agents: YamlAgent[] = [];
  const createAgent = async (spec: AgentSpec) => {
    const responses =
      spec.node === "Ralph"
        ? ralphResponses
        : spec.node === "Direct"
          ? receiving("Direct", directAnswer)
          : [
              recording("Reviewer", () =>
                fauxAssistantMessage("Ralph: clearer coverage."),
              ),
            ];
    const { options } = await nativeOptions(responses);
    const created: YamlAgent = await JuncoAgent.fromResolved({
      ...options,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools as AgentTool[],
    });
    agents.push(created);
    return created;
  };
  const inbox = new ReviewerInbox();
  try {
    const { execution, reviewerId } = await MixedGraph.create({
      tracer: inbox,
      createAgent,
    });
    return {
      execution,
      reviewerId,
      agents,
      prompts,
      inbox,
      async [Symbol.asyncDispose]() {
        await execution.graph.close();
      },
    };
  } catch (error) {
    await Promise.allSettled(agents.map((created) => created.return()));
    throw error;
  }
}

/** Step the graph until `done`, failing instead of spinning once nothing can run. */
async function stepUntil(
  execution: {
    graph: { available(): ReadonlyMap<unknown, unknown> };
    step(): Promise<unknown>;
  },
  done: () => boolean,
) {
  while (!done()) {
    if (execution.graph.available().size === 0)
      throw new Error("Graph stalled before the expected request");
    await execution.step();
  }
}

const ralphId = NodeId.create("Ralph");

test("Ralph runs two full-assignment rounds and only its final draft is reviewed", async () => {
  let agents: readonly YamlAgent[];
  let goalsSource: unknown;
  {
    await using flow = await mixedWorkflow();
    agents = flow.agents;
    const { execution, reviewerId, prompts, inbox } = flow;
    const graph = execution.graph;
    goalsSource = graph.getNode(NodeId.create("Goals"))?.state;

    await stepUntil(execution, () => prompts.Ralph.length === 1);
    assert.equal(prompts.Reviewer.length, 0);
    assert.ok(O.isNone(graph.result(ralphId)));
    assert.ok(O.isNone(graph.result(reviewerId)));

    const results = await execution.run();
    assert.equal(
      syntax.finalText(results.get(reviewerId), "Reviewer"),
      "Ralph: clearer coverage.",
    );
    // The nested graph's sink forwards Ralph's raw final assistant result, not a prompt wrapper.
    assert.equal(inbox.received.length, 1);
    const [draft] = inbox.received;
    assert.ok(Value.Check(AssistantMessageSchema, draft));
    assert.equal(contentText(draft.content), "draft-2");
    assert.equal(prompts.Ralph.length, 2);
    assert.equal(prompts.Ralph[0], goalsPrompt);
    assert.ok(prompts.Ralph[1]!.includes(goalsPrompt));
    assert.ok(prompts.Ralph[1]!.includes("draft-1"));
    assert.deepEqual(prompts.Direct, [goalsPrompt]);

    assert.equal(prompts.Reviewer.length, 1);
    const review = prompts.Reviewer[0]!;
    assert.ok(review.includes(goalsPrompt));
    assert.ok(review.includes("direct-answer"));
    assert.ok(review.includes("draft-2"));
    assert.ok(!review.includes("draft-1"));

    await execution.run();
    assert.deepEqual(
      [prompts.Ralph.length, prompts.Direct.length, prompts.Reviewer.length],
      [2, 1, 1],
    );
  }
  assert.ok(agents.every((agent) => agent.status === "closed"));
  assert.ok(goalsSource instanceof Deterministic && goalsSource.signal.aborted);
}, 5_000);

test("a failed second Ralph round forwards its raw abnormal draft, which the Reviewer rejects before any request", async () => {
  await using flow = await mixedWorkflow(true);
  const { execution, reviewerId, prompts, inbox } = flow;
  const graph = execution.graph;

  const failure = await execution.run().then(
    () => assert.fail("graph should reject"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DataflowNodeError);
  assert.equal(failure.nodeId, reviewerId);
  assert.equal(prompts.Ralph.length, 2);
  const [draft] = inbox.received;
  assert.ok(Value.Check(AssistantMessageSchema, draft));
  assert.equal(draft.stopReason, "error");
  assert.ok(O.isNone(graph.result(reviewerId)));
  assert.equal(prompts.Reviewer.length, 0);
}, 5_000);

test("a blank Direct answer fails the Reviewer before any Reviewer request", async () => {
  await using flow = await mixedWorkflow(false, " ");
  const { execution, reviewerId, prompts } = flow;
  const graph = execution.graph;

  const failure = await execution.run().then(
    () => assert.fail("graph should reject"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DataflowNodeError);
  assert.equal(failure.nodeId, reviewerId);
  assert.equal(prompts.Ralph.length, 2);
  assert.deepEqual(prompts.Direct, [goalsPrompt]);
  assert.equal(prompts.Reviewer.length, 0);
  assert.ok(O.isNone(graph.result(reviewerId)));
}, 5_000);
