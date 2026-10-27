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
} from "junco-agency";
import { Value } from "typebox/value";
import { userTexts } from "./deterministic-support.ts";
import { fauxRuntime, scripted } from "./support.ts";

const assignment = "Cover every section.\nKeep the original constraints.";
const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

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
const ladder = schedules.uniformLadder({
  model: `${model.provider}/${model.id}`,
});
// createAgent keeps the smoke collection-free: no ShellMux, so no Btrfs seed is needed.
const execution = await JuncoGraph.fromYaml(workflows.ralph, {
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  createAgent: (spec) => syntax.createJuncoAgent(spec, ladder, models),
  ladder,
  tracer: new tracerApi.DummyTracer(),
  ...schedules.ralph({ rounds: 3 }),
});
const graph = execution.graph;
const agent = graph.getNode(graphApi.NodeId.create("Ralph"))!.state;
assert.ok(agent instanceof agentApi.JuncoAgent);
try {
  graph.source.enqueue({
    messages: new Map([
      [
        graphApi.EdgeId.create("assignment"),
        [{ kind: "prompt", text: assignment }],
      ],
    ]),
    values: new Map(),
  });
  for (let windows = 0; requests.length < 3; windows++) {
    assert.ok(windows < 64, "Ralph did not complete within 64 graph windows");
    assert.ok(O.isNone(graph.result(graph.sink.id)));
    await execution.step();
  }
  await execution.run();
  await execution.run();
  assert.deepEqual(
    requests.map((request) => request.users.at(-1)),
    [assignment, revision("draft-1"), revision("draft-2")],
  );
  const result = graph.result(graph.sink.id);
  assert.ok(O.isSome(result));
  assert.ok(Value.Check(AssistantMessageSchema, result.value));
  assert.equal(contentText(result.value.content), "draft-3");
} finally {
  await graph.close();
}
assert.equal(agent.status, "closed");
console.log(
  JSON.stringify({ rounds: 3, delivered: ["draft-3"], closed: true }),
);
