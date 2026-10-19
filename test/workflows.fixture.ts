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
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as O from "fp-ts/lib/Option.js";
import {
  agent as agentApi,
  graph as graphApi,
  schedules,
  tools as toolsApi,
  tracer as tracerApi,
  workflows,
} from "junco-agency";

const assignment = "Cover every section.\nKeep the original constraints.";
const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

/** Every user text in one provider request. */
type Request = { readonly users: string[] };
const requests: Request[] = [];
const recording =
  (reply: string) =>
  (context: Context): AssistantMessage => {
    const users: string[] = [];
    for (const message of context.messages) {
      if (message.role === "user") {
        users.push(
          typeof message.content === "string"
            ? message.content
            : contentText(message.content),
        );
      }
    }
    requests.push({ users });
    return fauxAssistantMessage(reply);
  };

/**
 * The root `tools` yield factory and the agent's classifier must share one registry: a genuine
 * yield holds the run at exactly one provider request until the next explicit `next()`.
 */
async function assertPublicYieldBoundary(): Promise<void> {
  const yieldFaux = fauxProvider({
    api: "yield-workflow-smoke",
    provider: "yield-workflow-smoke",
    tokenSize: { min: 4, max: 4 },
  });
  yieldFaux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("yield", { reason: "review" }, { id: "public-yield" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("resumed"),
  ]);
  const yieldModels = createModels();
  yieldModels.setProvider(yieldFaux.provider);
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

if (typeof Bun === "undefined") {
  console.log(
    JSON.stringify({
      yieldBoundary: true,
      ralph: "skipped: parse needs Bun.YAML",
    }),
  );
  process.exit(0);
}

const { build, parse } = await import("junco-syntax");
const faux = fauxProvider({
  api: "ralph-workflow-smoke",
  provider: "ralph-workflow-smoke",
  tokenSize: { min: 4, max: 4 },
});
faux.setResponses(["draft-1", "draft-2", "draft-3"].map(recording));
const credentials = new InMemoryCredentialStore();
await credentials.modify(faux.getModel().provider, async () => ({
  type: "api_key",
  key: "fixture-login",
}));
const models = await ModelRuntime.create({
  credentials,
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
models.registerNativeProvider(faux.provider);
const model = faux.getModel();
const doc = parse(workflows.ralph, {
  params: { model: `${model.provider}/${model.id}` },
});
const execution = await build(doc, {
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  models,
  tracer: new tracerApi.DummyTracer(),
  ...schedules.ralph({ rounds: 3 }),
});
const graph = execution.graph;
const agent = graph.getNode(graphApi.NodeId.create("Ralph"))!
  .state as agentApi.JuncoAgent;
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
  assert.equal(contentText(result.value.content), "draft-3");
} finally {
  await graph.close();
}
assert.equal(agent.status, "closed");
console.log(
  JSON.stringify({ rounds: 3, delivered: ["draft-3"], closed: true }),
);
