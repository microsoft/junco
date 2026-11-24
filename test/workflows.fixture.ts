// Smoke for the std `workflows`/`schedules` namespaces through the public entrypoints.
// Node's TypeScript stripping resolves compiled entrypoints; Bun resolves source entrypoints.

import assert from "node:assert/strict";
import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import {
  AssistantMessageSchema,
  agent as agentApi,
  graph as graphApi,
  JuncoGraph,
  schedules,
  syntax,
  tools as toolsApi,
  tracer as tracerApi,
  workflows,
} from "junco";
import { Value } from "typebox/value";
import { renderTask } from "../src/agent-node.ts";
import { userTexts } from "./deterministic-support.ts";
import { fauxRuntime, NATIVE_TOOL_BLOCK, scripted } from "./support.ts";

const assignment = "Cover every section.\nKeep the original constraints.";
function workflowPrompt(source: string, id: string): string {
  const role = syntax.parse(source).graph.nodes[id];
  assert.ok(role && "prompt" in role);
  return role.prompt;
}

/** Every user text in one provider request. */
type Request = { readonly users: string[] };
const requests: Request[] = [];
const recording =
  (reply: string) =>
  (context: Context): AssistantMessage => {
    requests.push({ users: userTexts(context.messages) });
    return fauxAssistantMessage(reply);
  };

/**
 * The root `tools` yield factory and the agent's classifier must share one registry: a genuine
 * yield holds the run at exactly one provider request until the next explicit `next()`.
 */
async function assertPublicYieldBoundary(): Promise<void> {
  const { faux: yieldFaux, models: yieldModels } = scripted(
    [
      fauxAssistantMessage(
        [fauxToolCall("yield", { reason: "review" }, { id: "public-yield" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("resumed"),
    ],
    "yield-workflow-smoke",
  );
  const sessions = new MemorySessionRepo();
  let member: agentApi.JuncoAgent | undefined;
  try {
    member = await agentApi.JuncoAgent.fromResolved({
      session: await sessions.create({}, BACKGROUND_CONTEXT),
      models: yieldModels,
      model: yieldFaux.getModel(),
      tools: [new toolsApi.YieldTool()],
      tool_block: NATIVE_TOOL_BLOCK,
      prompt: "handoff",
    });
    const turns: { ids: string[]; errors: boolean[] }[] = [];
    member.events.on("turn_end", ({ toolResults }) => {
      turns.push({
        ids: toolResults.map((result) => result.toolCallId),
        errors: toolResults.map((result) => result.isError),
      });
    });

    assert.deepEqual(await member.next(), {
      done: false,
      value: {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "public-yield",
            toolName: "yield",
            reason: "review",
          },
        ],
      },
    });
    assert.equal(yieldFaux.state.callCount, 1);
    assert.equal(member.status, "suspended");
    assert.deepEqual(turns, [{ ids: ["public-yield"], errors: [false] }]);

    const resumed = await member.next();
    if (resumed.done || resumed.value.kind !== "settled") {
      throw new Error(
        `Expected a settled step, got ${JSON.stringify(resumed)}`,
      );
    }
    assert.equal(resumed.value.message.stopReason, "stop");
    assert.equal(contentText(resumed.value.message.content), "resumed");
    assert.equal(yieldFaux.state.callCount, 2);

    await member.return();
    assert.equal(member.status, "closed");
    assert.equal((await member.next()).done, true);
  } finally {
    try {
      await member?.return();
    } finally {
      await sessions.close(BACKGROUND_CONTEXT);
    }
  }
}

await assertPublicYieldBoundary();

const { models, faux } = await fauxRuntime(
  ["draft-1", "draft-2", "draft-3"].map(recording),
  "ralph-workflow-smoke",
);
const model = faux.getModel();
const ladder = new schedules.ModelLadder(
  models,
  schedules.uniformLadder({ model: `${model.provider}/${model.id}` }),
);
// createAgent keeps the smoke collection-free: no ShellMux, so no Btrfs seed is needed.
const judged: number[] = [];
const execution = await JuncoGraph.fromYaml(workflows.ralph, {
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  createAgent: (spec) =>
    syntax.createJuncoAgent(
      {
        ...spec,
        tool_block: [
          ...new Set([...NATIVE_TOOL_BLOCK, ...(spec.tool_block ?? [])]),
        ],
      },
      ladder,
    ),
  ladder,
  tracer: new tracerApi.DummyTracer(),
  // Uncapped: only the predicate ends the loop; the window watchdog below is the fixture's guard.
  ...schedules.ralph({
    until: (result, { round }) => {
      judged.push(round);
      return contentText(result.content) === "draft-3";
    },
  }),
});
const graph = execution.graph;
const agent = graph.getNode(graphApi.NodeId.create("Ralph"))!.state;
assert.ok(agent instanceof agentApi.JuncoAgent);
const task = graphApi.nodes.Task.create({
  kind: "prompt",
  text: assignment,
  spec: "",
});
try {
  graph.source.enqueue({
    messages: new Map([[graphApi.EdgeId.create("assignment"), [task]]]),
    values: new Map(),
  });
  for (let windows = 0; requests.length < 3; windows++) {
    assert.ok(windows < 64, "Ralph did not complete within 64 graph windows");
    assert.ok(O.isNone(graph.result(graph.sink.id)));
    await execution.step();
  }
  await execution.run();
  await execution.run();
  const prompt = workflowPrompt(workflows.ralph, "Ralph");
  const expected = [prompt, renderTask(task)];
  assert.deepEqual(requests[0]?.users, expected);
  for (const round of [2, 3]) {
    const users = requests[round - 1]!.users;
    assert.deepEqual(users.slice(0, -1), [...expected, prompt]);
    const control = users.at(-1)!;
    assert.deepEqual(JSON.parse(control), {
      id: "RalphControl~>Ralph",
      payload: { phase: "revise", round, objectives: [assignment] },
    });
    expected.push(prompt, control);
  }
  assert.deepEqual(judged, [1, 2, 3]);
  const result = graph.result(graph.sink.id);
  assert.ok(O.isSome(result));
  assert.ok(Value.Check(AssistantMessageSchema, result.value));
  assert.equal(contentText(result.value.content), "draft-3");
} finally {
  await graph.close();
}
assert.equal(agent.status, "closed");
console.log(
  JSON.stringify({
    mode: "until",
    rounds: judged.length,
    delivered: ["draft-3"],
    closed: true,
  }),
);

// Fan-in selectors on one scripted runtime: AllFanIn's single selection, then two AnyFanIn batches.
const selections: Request[] = [];
const fanIn = await fauxRuntime(
  ["best", "x-complete", "y-complete"].map(
    (reply) =>
      (context: Context): AssistantMessage => {
        selections.push({ users: userTexts(context.messages) });
        return fauxAssistantMessage(reply);
      },
  ),
  "fan-in-workflow-smoke",
);
const fanInModel = fanIn.faux.getModel();
const fanInLadder = new schedules.ModelLadder(
  fanIn.models,
  schedules.uniformLadder({ model: `${fanInModel.provider}/${fanInModel.id}` }),
);
const fanInOptions = {
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  createAgent: async (spec: syntax.AgentSpec) => {
    const agent = await syntax.createJuncoAgent(
      {
        ...spec,
        tool_block: [
          ...new Set([...NATIVE_TOOL_BLOCK, ...(spec.tool_block ?? [])]),
        ],
      },
      fanInLadder,
    );
    await agent.setSteeringMode("all");
    return agent;
  },
  ladder: fanInLadder,
  tracer: new tracerApi.DummyTracer(),
};
const candidates = graphApi.EdgeId.create("candidates");

const all = await JuncoGraph.fromYaml(workflows.allFanIn, fanInOptions);
try {
  all.graph.source.enqueue({
    messages: new Map([
      [candidates, ["worse", "best"].map((text) => fauxAssistantMessage(text))],
    ]),
    values: new Map(),
  });
  await all.run();
  const selected = all.graph.result(all.graph.sink.id);
  assert.ok(O.isSome(selected));
  assert.ok(Value.Check(AssistantMessageSchema, selected.value));
  assert.equal(contentText(selected.value.content), "best");
  assert.equal(selections[0]?.users.length, 3);
  assert.equal(selections[0]?.users[0], workflowPrompt(workflows.allFanIn, "AllFanIn"));
  assert.deepEqual(
    selections[0]?.users
      .slice(1)
      .map((text) => JSON.parse(text).payload.content),
    [
      fauxAssistantMessage("worse").content,
      fauxAssistantMessage("best").content,
    ],
  );
} finally {
  await all.graph.close();
}

const any = await JuncoGraph.fromYaml(workflows.anyFanIn, {
  ...fanInOptions,
  ...schedules.anyFanIn(),
});
const streamed: string[] = [];
let previousUsers = 0;
try {
  for (const batch of [
    ["x-short", "x-complete"],
    ["y-short", "y-complete"],
  ]) {
    const tasks = batch.map((text) =>
      graphApi.nodes.Task.create({ kind: "prompt", text, spec: "" }),
    );
    any.graph.source.enqueue({
      messages: new Map([[candidates, tasks]]),
      values: new Map(),
    });
    await any.run();
    any.graph.sink.drain((message) => {
      assert.equal(message.id, "AnyFanInPublish~>$sink");
      assert.ok(Value.Check(AssistantMessageSchema, message.payload));
      streamed.push(contentText(message.payload.content));
    });
    const users = selections.at(-1)!.users;
    assert.deepEqual(users.slice(previousUsers), [
      workflowPrompt(workflows.anyFanIn, "AnyFanIn"),
      ...tasks.map((task) => renderTask(task)),
    ]);
    previousUsers = users.length;
  }
  assert.deepEqual(streamed, ["x-complete", "y-complete"]);
  // A streaming selector parks instead of returning.
  assert.ok(O.isNone(any.graph.result(any.graph.sink.id)));
} finally {
  await any.graph.close();
}
console.log(
  JSON.stringify({ allFanIn: "best", anyFanIn: streamed, closed: true }),
);
