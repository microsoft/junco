// Package smoke for `junco-agency/workflows` through the root namespaces: Node's TypeScript
// stripping resolves the compiled entrypoints (`bun run build` first), Bun the source entrypoints.
// First, a `tools`-owned yield suspends and resumes a real native agent through the public
// entrypoints. Then a three-round Ralph runs over a real native agent on a faux model inside a real
// parent graph. It proves the workflows bundle shares JuncoGraph with the root bundle, so recursive
// close reaches the nested graph and the lent agent.

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
} from "@earendil-works/pi-ai";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import {
  agent as agentApi,
  graph as graphApi,
  tools as toolsApi,
  trigger,
} from "junco-agency";
import { ralph } from "junco-agency/workflows";

type AgenticInput = graphApi.nodes.AgenticInput;

const assignment = "Cover every section.\nKeep the original constraints.";
const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

const queued = (
  edge: graphApi.Edge<AgenticInput, AssistantMessage>,
): AgenticInput[] => (E.isLeft(edge.transport) ? [...edge.transport.left] : []);

/** Every user text and offered tool name in one provider request. */
type Request = { readonly users: string[]; readonly tools: string[] };
const requests: Request[] = [];
const recording =
  (reply: string) =>
  (context: Context): AssistantMessage => {
    const users: string[] = [];
    const tools: string[] = [];
    for (const message of context.messages) {
      if (message.role === "user") {
        users.push(
          typeof message.content === "string"
            ? message.content
            : contentText(message.content),
        );
      } else if (message.role === "system") {
        tools.push(...(message.toolsAdded?.map((tool) => tool.name) ?? []));
      }
    }
    requests.push({ users, tools });
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
      tools: [toolsApi.createYieldTool()],
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

const faux = fauxProvider({
  api: "ralph-workflow-smoke",
  provider: "ralph-workflow-smoke",
  tokenSize: { min: 4, max: 4 },
});
faux.setResponses(["draft-1", "draft-2", "draft-3"].map(recording));
const models = createModels();
models.setProvider(faux.provider);

let agent: agentApi.JuncoAgent | undefined;
let parent: graphApi.JuncoGraph | undefined;
let owned = false;
let closed = false;
try {
  agent = await agentApi.JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model: faux.getModel(),
    tools: [],
  });
  const graph = graphApi.createParallelAgentGraph();
  parent = graph;

  const input = graphApi.messageEdge<AgenticInput, AssistantMessage>(
    "source->ralph",
  );
  const output = graphApi.messageEdge<AgenticInput, AssistantMessage>(
    "ralph->sink",
  );
  const sourceId = graph.addNode(
    graphApi.nodes.deterministicNode(
      new graphApi.nodes.Deterministic<AgenticInput, AssistantMessage>(
        async function* (): graphApi.NodeGenerator<
          AgenticInput,
          AssistantMessage
        > {
          while (true) yield [];
        },
      ),
      { trigger: trigger.always(), is_available: () => false },
    ),
  );
  const delivered: string[] = [];
  const sinkId = graph.addNode(
    graphApi.nodes.deterministicNode(
      new graphApi.nodes.Deterministic<AgenticInput, AssistantMessage>(
        async function* (): graphApi.NodeGenerator<
          AgenticInput,
          AssistantMessage
        > {
          const view = yield [];
          for (const value of graphApi.from(view, output))
            delivered.push(value.kind === "appendMessage" ? "" : value.text);
          return fauxAssistantMessage("received");
        },
      ),
      { trigger: trigger.when(output) },
    ),
  );
  const id: graphApi.NodeIdType = ralph(graph, agent, {
    input,
    output,
    rounds: 3,
  });
  owned = true;
  graph.addEdge(sourceId, id, input).addEdge(id, sinkId, output);

  const child = graph.getNode(id)?.state;
  assert.ok(
    child instanceof graphApi.JuncoGraph,
    "the workflow's nested graph is the root package's JuncoGraph",
  );

  graph.emit(
    sourceId,
    graphApi.msg(input, { kind: "prompt", text: assignment }),
  );
  for (let windows = 0; O.isNone(graph.result(id)); windows++) {
    assert.ok(windows < 64, "Ralph did not complete within 64 graph windows");
    assert.deepEqual(queued(output), []);
    await graph.step();
  }
  assert.deepEqual(queued(output), [{ kind: "prompt", text: "draft-3" }]);
  const result = graph.result(id);
  assert.ok(
    O.isSome(result) && contentText(result.value.content) === "draft-3",
  );

  await graph.run();
  await graph.run();
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((request) => request.users.at(-1)),
    [assignment, revision("draft-1"), revision("draft-2")],
  );
  assert.deepEqual(
    requests.map((request) => request.tools),
    [[], [], []],
  );
  assert.deepEqual(delivered, ["draft-3"]);

  await graph.close();
  closed = true;
  assert.ok(child.signal.aborted);
  assert.equal(agent.status, "closed");
  console.log(
    JSON.stringify({
      rounds: requests.length,
      delivered,
      sharedGraphIdentity: true,
      closed: true,
    }),
  );
} finally {
  if (!closed) {
    await parent?.close().catch(() => undefined);
    if (!owned) await agent?.return().catch(() => undefined);
  }
}
