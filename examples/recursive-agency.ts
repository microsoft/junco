// Offline recursive agency: root → child → grandchild → a leaf that yields once, plus a root sibling.
// Every member has its own faux model; each scheduler model reads the GraphInfo of the request it
// answers. Run: bun run examples/recursive-agency.ts

import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentTool, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  type Context,
  createModels,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { always, DataflowGraph, UNBOUNDED } from "dataflow-engine";
import { type Agentic, createYieldTool, JuncoAgent } from "junco-agent";
import { type AgencyGraph, agentNode, attachAgency, type GraphInfo, PiScheduler } from "../src/index.ts";

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

function graphInfoOf(context: Context): GraphInfo {
  const last = context.messages.at(-1);
  const text = last?.role === "user"
    ? typeof last.content === "string"
      ? last.content
      : last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : "";
  assert.ok(text.startsWith("GraphInfo:\n"));
  return JSON.parse(text.slice("GraphInfo:\n".length)) as GraphInfo;
}

type Decision = { readonly lanes: string[][] } | { readonly text: string };

/** Run every available member; once quiescent, report the member results in node order. */
const runAvailable = (info: GraphInfo): Decision => {
  const available = info.nodes.filter((node) => node.available).map((node) => [node.id]);
  return available.length > 0 ? { lanes: available } : { text: info.nodes.map((node) => node.result?.text).join(" + ") };
};

async function agency(name: string, members: readonly Agentic[], decide: (info: GraphInfo, request: number) => Decision) {
  let requests = 0;
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const decision = decide(graphInfoOf(context), requests++);
    return "lanes" in decision
      ? fauxAssistantMessage([fauxToolCall("schedule", { lanes: decision.lanes }, { id: `${name}-${requests}` })], {
          stopReason: "toolUse",
        })
      : fauxAssistantMessage(decision.text);
  };
  const { faux, options } = await nativeOptions([respond]);
  const scheduler = await PiScheduler.make({ ...options, systemPrompt: `You schedule ${name}.`, prompt: `Run ${name}.` });
  const graph: AgencyGraph = new DataflowGraph(scheduler, UNBOUNDED, UNBOUNDED);
  for (const [index, member] of members.entries()) {
    graph.addNode(
      agentNode(member, {
        description: `${name} member ${index}`,
        trigger: always(),
        receive: () => [],
        emit: () => [],
      }),
    );
  }
  return attachAgency(graph);
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

const grandchild = await agency("grandchild", [leaf.agent], runAvailable);
const child = await agency("child", [grandchild], runAvailable);
child.events.on("tool_start", (event) => {
  if (event.toolName === "schedule") log.push("child window");
});
// The root primes both members, runs one child window, then the sibling, then the rest.
const rootPlan = [[["0"], ["1"]], [["0"]], [["1"]]];
const root = await agency("root", [child, sibling.agent], (info, request) =>
  request < rootPlan.length ? { lanes: rootPlan[request]! } : runAvailable(info),
);
const publicTools: string[] = [];
root.events.on("tool_start", (event) => {
  if (event.toolName === "schedule") publicTools.push(event.toolName);
});

let windows = 0;
let settled: string | undefined;
for await (const step of root) {
  if (step.kind === "yield") {
    windows++;
    continue;
  }
  assert.equal(step.kind, "settled");
  if (step.kind !== "settled") break;
  settled = step.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  break;
}
await root.return();

assert.equal(settled, "leaf-result + sibling-result");
assert.ok(windows > 0 && publicTools.length === windows && publicTools.every((name) => name === "schedule"));
const siblingDone = log.indexOf("sibling done");
assert.ok(log.indexOf("child window") < siblingDone && log.lastIndexOf("child window") > siblingDone, log.join(", "));
assert.equal(leaf.faux.state.callCount, 2);
assert.equal(sibling.faux.state.callCount, 1);
assert.equal(root.status, "closed");
assert.equal(leaf.agent.status, "closed");
console.log(`${settled} after ${windows} root windows (${log.join(" → ")})`);
