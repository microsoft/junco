import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type Context,
  contentText,
  type FauxResponseFactory,
  fauxAssistantMessage,
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
import { renderTask } from "../src/agent-node.ts";
import { AssistantMessageSchema, Deterministic, JuncoGraph, syntax } from "../src/index.ts";
import { userTexts } from "./deterministic-support.ts";
import { countedCollection, offlineLadder } from "./support.ts";

/** Asserts `rendered` is the Goals task with its `Task.create`-minted UUID, and returns that id. */
function goalsTaskId(rendered: string): string {
  const { taskId } = JSON.parse(
    rendered.slice(rendered.lastIndexOf("Task: ") + 6),
  );
  assert.match(taskId, /^[0-9a-f-]{36}$/);
  assert.equal(
    rendered,
    renderTask({
      kind: "prompt",
      text: goalsPrompt,
      taskId,
      spec: "All three goals are answered.",
      deps: [],
      history: [],
    }),
  );
  return taskId;
}

/** Records the raw nested result before validation and its delivery to Reviewer. */
class ReviewerInbox extends DummyTracer {
  readonly received: unknown[] = [];
  readonly validated: unknown[] = [];

  override startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const run = super.startRun(graph);
    return {
      ...run,
      startNode: (id, phase, inputs) => {
        if (String(id) === "ValidateDraft")
          this.validated.push(...(inputs?.messages.get(EdgeId.create("Ralph~>Reviewer")) ?? []));
        if (String(id) === "Reviewer")
          this.received.push(
            ...(inputs?.messages.get(EdgeId.create("ValidateDraft~>Reviewer")) ?? []),
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
 * its goals through steered user messages and answers `directAnswer`; Reviewer sees its value
 * inputs in the prompt and Ralph's draft in a following message. Ralph's run r returns `draft-r`.
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
  const respond: FauxResponseFactory = (context) => {
    const texts = userTexts(context.messages);
    const first = texts[0]!;
    if (first.startsWith("On the first round,")) {
      if (!prompts.Ralph.length) {
        assert.equal(texts.length, 2);
        assert.equal(first, 'On the first round, achieve the objectives in the following task messages, in order. On phase "revise", take another try at the ordered objectives, building on your last answer in this session. On phase "retry", the previous attempt ended with a provider error: continue the same round from where you left off. Focus on depth: finish objectives well rather than attempting more of them. Return the complete answer.');
        goalsTaskId(texts[1]!);
      }
      prompts.Ralph.push(latestUserText(context));
      if (failSecond && prompts.Ralph.length === 2) throw new Error("second Ralph round failed");
      return fauxAssistantMessage(`draft-${prompts.Ralph.length}`);
    }
    assert.equal(texts.length, 2);
    if (first.startsWith("Complete every goal")) {
      prompts.Direct.push(texts[1]!);
      return fauxAssistantMessage(directAnswer);
    }
    assert.ok(first.startsWith("Goals:"));
    const delivered = JSON.parse(texts[1]!);
    assert.equal(delivered.id, "ValidateDraft~>Reviewer");
    assert.ok(Value.Check(AssistantMessageSchema, delivered.payload));
    assert.equal(contentText(delivered.payload.content), "draft-2");
    prompts.Reviewer.push(texts.join("\n"));
    return fauxAssistantMessage("Ralph: clearer coverage.");
  };
  const inbox = new ReviewerInbox();
  await using setup = new AsyncDisposableStack();
  const collection = setup.adopt(countedCollection().collection, (c) => c.close());
  const { execution, reviewerId } = await MixedGraph.create({
    ladder: await offlineLadder(respond), collection, tracer: inbox,
  });
  setup.defer(() => execution.graph.close());
  const nested = execution.graph.getNode(ralphId)!.state;
  assert.ok(nested instanceof JuncoGraph);
  const agents = [
    nested.getNode(ralphId)!.state,
    execution.graph.getNode(NodeId.create("Direct"))!.state,
    execution.graph.getNode(reviewerId)!.state,
  ].map((member) => {
    assert.ok(member instanceof JuncoAgent);
    return member;
  });
  const owned = setup.move();
  return { execution, reviewerId, agents, prompts, inbox, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

/** Step the graph until `done`, failing instead of spinning once nothing can run. */
async function stepUntil(
  execution: {
    graph: { available(): ReadonlyMap<unknown, unknown> };
    step(): Promise<unknown>;
  },
  done: () => boolean,
) {
  for (let turns = 0; !done(); turns++) {
    assert.ok(turns < 100, "Graph did not reach the expected request");
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
    assert.equal(draft, inbox.validated[0]);
    assert.ok(Value.Check(AssistantMessageSchema, draft));
    assert.equal(contentText(draft.content), "draft-2");
    assert.equal(prompts.Ralph.length, 2);
    const taskId = goalsTaskId(prompts.Ralph[0]!);
    assert.deepEqual(JSON.parse(prompts.Ralph[1]!), {
      id: "RalphControl~>Ralph", payload: { phase: "revise", round: 2, objectives: [goalsPrompt] },
    });
    assert.equal(prompts.Direct.length, 1);
    // Goals broadcasts one task: both competitors receive the same id.
    assert.equal(goalsTaskId(prompts.Direct[0]!), taskId);

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
  const { execution, reviewerId, prompts } = flow;
  const graph = execution.graph;

  const failure = await execution.run().then(
    () => assert.fail("graph should reject"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DataflowNodeError);
  assert.equal(failure.nodeId, NodeId.create("ValidateDraft"));
  assert.match(String(failure.cause), /Ralph~>Reviewer did not finish normally: error/);
  assert.equal(prompts.Ralph.length, 2);
  const [draft] = flow.inbox.validated;
  assert.equal(flow.inbox.received.length, 0);
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
  assert.equal(prompts.Direct.length, 1);
  goalsTaskId(prompts.Direct[0]!);
  assert.equal(prompts.Reviewer.length, 0);
  assert.ok(O.isNone(graph.result(reviewerId)));
}, 5_000);
