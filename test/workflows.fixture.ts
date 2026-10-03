// Built-package smoke for `junco-agency/workflows`, run by Node's TypeScript stripping against the
// compiled entrypoints (`bun run build` first): a three-round Ralph over a real native agent on a
// faux model inside a real parent graph. It proves the workflows bundle shares JuncoGraph with the
// root bundle, so recursive close reaches the nested graph and the lent agent.

import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { always, type Edge, from, messageEdge, msg, type NodeGenerator, type NodeIdType, when } from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import { type AgenticInput, createParallelAgentGraph, Deterministic, deterministicNode, JuncoGraph } from "junco-agency";
import { ralph } from "junco-agency/workflows";

const assignment = "Cover every section.\nKeep the original constraints.";
const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

const queued = (edge: Edge<AgenticInput, AssistantMessage>): AgenticInput[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

/** Every user text and offered tool name in one provider request. */
type Request = { readonly users: string[]; readonly tools: string[] };
const requests: Request[] = [];
const recording = (reply: string) => (context: Context): AssistantMessage => {
  const users: string[] = [];
  const tools: string[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      users.push(typeof message.content === "string" ? message.content : contentText(message.content));
    } else if (message.role === "system") {
      tools.push(...(message.toolsAdded?.map((tool) => tool.name) ?? []));
    }
  }
  requests.push({ users, tools });
  return fauxAssistantMessage(reply);
};

const faux = fauxProvider({ api: "ralph-workflow-smoke", provider: "ralph-workflow-smoke", tokenSize: { min: 4, max: 4 } });
faux.setResponses(["draft-1", "draft-2", "draft-3"].map(recording));
const models = createModels();
models.setProvider(faux.provider);

let agent: JuncoAgent | undefined;
let parent: JuncoGraph | undefined;
let owned = false;
let closed = false;
try {
  agent = await JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model: faux.getModel(),
    tools: [],
  });
  const graph = createParallelAgentGraph();
  parent = graph;

  const input = messageEdge<AgenticInput, AssistantMessage>("source->ralph");
  const output = messageEdge<AgenticInput, AssistantMessage>("ralph->sink");
  const sourceId = graph.addNode(deterministicNode(
    new Deterministic<AgenticInput, AssistantMessage>(async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
      while (true) yield [];
    }),
    { trigger: always(), is_available: () => false },
  ));
  const delivered: string[] = [];
  const sinkId = graph.addNode(deterministicNode(
    new Deterministic<AgenticInput, AssistantMessage>(async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
      const view = yield [];
      for (const value of from(view, output)) delivered.push(value.kind === "appendMessage" ? "" : value.text);
      return fauxAssistantMessage("received");
    }),
    { trigger: when(output) },
  ));
  const id: NodeIdType = ralph(graph, agent, { input, output, rounds: 3 });
  owned = true;
  graph.addEdge(sourceId, id, input).addEdge(id, sinkId, output);

  const child = graph.getNode(id)?.state;
  assert.ok(child instanceof JuncoGraph, "the workflow's nested graph is the root package's JuncoGraph");

  graph.emit(sourceId, msg(input, { kind: "prompt", text: assignment }));
  for (let windows = 0; O.isNone(graph.result(id)); windows++) {
    assert.ok(windows < 64, "Ralph did not complete within 64 graph windows");
    assert.deepEqual(queued(output), []);
    await graph.step();
  }
  assert.deepEqual(queued(output), [{ kind: "prompt", text: "draft-3" }]);
  const result = graph.result(id);
  assert.ok(O.isSome(result) && contentText(result.value.content) === "draft-3");

  await graph.run();
  await graph.run();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.users.at(-1)), [
    assignment,
    revision("draft-1"),
    revision("draft-2"),
  ]);
  assert.deepEqual(requests.map((request) => request.tools), [[], [], []]);
  assert.deepEqual(delivered, ["draft-3"]);

  await graph.close();
  closed = true;
  assert.ok(child.signal.aborted);
  assert.equal(agent.status, "closed");
  console.log(JSON.stringify({ rounds: requests.length, delivered, sharedGraphIdentity: true, closed: true }));
} finally {
  if (!closed) {
    await parent?.close().catch(() => undefined);
    if (!owned) await agent?.return().catch(() => undefined);
  }
}
