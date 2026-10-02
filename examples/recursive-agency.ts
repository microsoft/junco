// Offline recursive agency: root → child → grandchild → a leaf that yields once, plus a root sibling.
// Every member has its own faux model; each scheduler model reads the SchedulerInfo of the request it
// answers and, once nothing is available, reports completion. Member results are read from the
// retained graphs, never through a scheduler. Run: bun run examples/recursive-agency.ts

import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentTool, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  createModels,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { always, NodeId, type NodeOptions, UNBOUNDED } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { createYieldTool, JuncoAgent } from "junco-agent";
import type { SchedulerInfo } from "junco-scheduler/agent";
import { type AgenticInput, agentNode, createAgencyScheduler, graphNode, JuncoGraph } from "../src/index.ts";

let providers = 0;
async function nativeOptions(responses: readonly FauxResponseStep[]) {
  const name = `faux-${++providers}`;
  const faux = fauxProvider({ api: name, provider: name });
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model: faux.getModel(),
  };
  return { faux, options };
}

function schedulerInfoOf(context: Context): SchedulerInfo {
  const last = context.messages.at(-1);
  const text = last?.role === "user"
    ? typeof last.content === "string"
      ? last.content
      : last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : "";
  assert.ok(text.startsWith("SchedulerInfo:\n"));
  return JSON.parse(text.slice("SchedulerInfo:\n".length)) as SchedulerInfo;
}

const textOf = (message: AssistantMessage) =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

type Decision = { readonly lanes: string[][] } | { readonly text: string };

/** Run every available member; once nothing is available, report this scheduler's completion. */
const runAvailable = (name: string) => (info: SchedulerInfo): Decision =>
  info.nodes.length > 0 ? { lanes: info.nodes.map((node) => [node.id]) } : { text: `${name} complete` };

async function agency(name: string, members: readonly (JuncoAgent | JuncoGraph)[], decide: (info: SchedulerInfo, request: number) => Decision) {
  let requests = 0;
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const decision = decide(schedulerInfoOf(context), requests++);
    return "lanes" in decision
      ? fauxAssistantMessage([fauxToolCall("schedule", { lanes: decision.lanes }, { id: `${name}-${requests}` })], {
          stopReason: "toolUse",
        })
      : fauxAssistantMessage(decision.text);
  };
  const { faux, options } = await nativeOptions([respond]);
  let current: JuncoGraph | undefined;
  const scheduler = await createAgencyScheduler(() => current, {
    ...options,
    systemPrompt: `You schedule ${name}.`,
    prompt: `Run ${name}.`,
  });
  const graph = new JuncoGraph(scheduler, UNBOUNDED, UNBOUNDED);
  current = graph;
  for (const [index, member] of members.entries()) {
    const options: NodeOptions<AgenticInput, AssistantMessage> = { description: `${name} member ${index}`, trigger: always() };
    graph.addNode(
      member instanceof JuncoGraph
        ? graphNode(member, options, { result: NodeId("0") })
        : agentNode(member, options),
    );
  }
  return { graph, scheduler };
}

async function leafAgent(responses: readonly FauxResponseStep[], tools: readonly AgentTool[] = []) {
  const { faux, options } = await nativeOptions(responses);
  const agent = await JuncoAgent.fromResolved({ ...options, systemPrompt: "leaf", tools: [...tools], prompt: "Do your part." });
  return { faux, agent };
}

const log: string[] = [];
const leaf = await leafAgent(
  [
    fauxAssistantMessage([fauxToolCall("yield", { reason: "waiting once" }, { id: "leaf-yield" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("leaf-result"),
  ],
  [createYieldTool()],
);
const sibling = await leafAgent([fauxAssistantMessage("sibling-result")]);
sibling.agent.events.on("run_end", (event) => {
  if (event.status === "completed") log.push("sibling done");
});

const grandchild = await agency("grandchild", [leaf.agent], runAvailable("grandchild"));
const child = await agency("child", [grandchild.graph], runAvailable("child"));
child.scheduler.events.on("tool_start", (event) => {
  if (event.toolName === "schedule") log.push("child window");
});
// The root primes both members, runs one child window, then the sibling, then the rest.
const rootPlan = [[["0"], ["1"]], [["0"]], [["1"]]];
const root = await agency("root", [child.graph, sibling.agent], (info, request) =>
  request < rootPlan.length ? { lanes: rootPlan[request]! } : runAvailable("root")(info),
);
const publicTools: string[] = [];
root.scheduler.events.on("tool_start", (event) => {
  if (event.toolName === "schedule") publicTools.push(event.toolName);
});

let windows = 0;
let settled: string | undefined;
for await (const step of root.scheduler) {
  if (step.kind === "yield") {
    windows++;
    continue;
  }
  assert.equal(step.kind, "settled");
  if (step.kind !== "settled") break;
  settled = textOf(step.message);
  break;
}
await root.graph.close();

const resultOf = (graph: JuncoGraph, id: string) => {
  const result = graph.result(NodeId(id));
  return O.isSome(result) ? textOf(result.value) : undefined;
};
const leafResult = resultOf(grandchild.graph, "0");
const siblingResult = resultOf(root.graph, "1");
assert.equal(settled, "root complete");
assert.equal(leafResult, "leaf-result");
assert.equal(siblingResult, "sibling-result");
assert.equal(windows, 8);
assert.ok(publicTools.length === windows && publicTools.every((name) => name === "schedule"));
const siblingDone = log.indexOf("sibling done");
assert.ok(log.indexOf("child window") < siblingDone && log.lastIndexOf("child window") > siblingDone, log.join(", "));
assert.equal(leaf.faux.state.callCount, 2);
assert.equal(sibling.faux.state.callCount, 1);
for (const actor of [root.scheduler, child.scheduler, grandchild.scheduler, leaf.agent, sibling.agent]) {
  assert.equal(actor.status, "closed");
}
console.log(`${settled}; ${leafResult} + ${siblingResult}; ${windows} root windows`);
