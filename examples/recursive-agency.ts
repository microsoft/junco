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
import { NodeId, type NodeOptions, TriggerRule, UNBOUNDED } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import type { SchedulerInfo } from "junco-scheduler/agent";
import { LockPolicy, type ToolCollection, YieldTool } from "junco-tools";
import { type AgenticInput, JuncoGraph, tracer } from "../src/index.ts";
import { ctrlC } from "./cancellation.ts";

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

async function agency(
  name: string,
  policy: ToolCollection["policy"],
  members: readonly (JuncoAgent | JuncoGraph)[],
  decide: (info: SchedulerInfo, request: number) => Decision,
) {
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
  const graph = await JuncoGraph.pi({
    ...options,
    systemPrompt: `You schedule ${name}.`,
    prompt: `Run ${name}.`,
    policy,
    tracer: tracer.StdoutTracer.shared(),
    window: UNBOUNDED,
    threads: UNBOUNDED,
  });
  const scheduler = graph.scheduler;
  for (const [index, member] of members.entries()) {
    const options: NodeOptions<AgenticInput, AssistantMessage> = {
      description: `${name} member ${index}`,
      trigger: TriggerRule.always(),
    };
    graph.addNode(
      member instanceof JuncoGraph
        ? { ...options, state: member, result: NodeId.create("0") }
        : { ...options, policy, state: member },
    );
  }
  return { graph, scheduler };
}

async function leafAgent(responses: readonly FauxResponseStep[], tools: readonly AgentTool[] = []) {
  const { faux, options } = await nativeOptions(responses);
  const agent = await JuncoAgent.fromResolved({ ...options, systemPrompt: "leaf", tools: [...tools], prompt: "Do your part." });
  return { faux, agent };
}

async function main(signal: AbortSignal) {
  const log: string[] = [];
  const leaf = await leafAgent(
    [
      fauxAssistantMessage([fauxToolCall("yield", { reason: "waiting once" }, { id: "leaf-yield" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("leaf-result"),
    ],
    [new YieldTool()],
  );
  const sibling = await leafAgent([fauxAssistantMessage("sibling-result")]);
  sibling.agent.events.on("run_end", (event) => {
    if (event.status === "completed") log.push("sibling done");
  });

  const grandchild = await agency("grandchild", LockPolicy, [leaf.agent], runAvailable("grandchild"));
  const child = await agency("child", LockPolicy, [grandchild.graph], runAvailable("child"));
  child.scheduler.events.on("tool_start", (event) => {
    if (event.toolName === "schedule") log.push("child window");
  });
  // The root primes both members, runs the child (all its windows), then the sibling, then the rest.
  const rootPlan = [[["0"], ["1"]], [["0"]], [["1"]]];
  const root = await agency("root", LockPolicy, [child.graph, sibling.agent], (info, request) =>
    request < rootPlan.length ? { lanes: rootPlan[request]! } : runAvailable("root")(info),
  );
  // Every nested graph shares the automatically selected tracer.
  let windows = 0;
  let settled: string | undefined;
  const failures: unknown[] = [];
  let abortWork: Promise<void> | undefined;
  const interrupt = () => {
    abortWork = root.graph.abort(signal.reason).catch((error) => {
      failures.push(error);
    });
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    root.scheduler.events.on("tool_end", (event) => {
      if (event.toolName === "schedule" && !event.isError) windows++;
    });
    // Schedule windows run inside one public next(); only settlement ends it.
    signal.throwIfAborted();
    const step = await root.scheduler.next();
    signal.throwIfAborted();
    assert.ok(!step.done && step.value.kind === "settled", "root scheduler settled in one next()");
    settled = textOf(step.value.message);
  } catch (error) {
    failures.push(error);
  } finally {
    signal.removeEventListener("abort", interrupt);
    await abortWork;
    for (const release of [() => root.graph.close(), () => root.graph.tracer.flush()]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Recursive agency failed", { cause: failures[0] });
  signal.throwIfAborted();

  const resultOf = (graph: JuncoGraph, id: string) => {
    const result = graph.result(NodeId.create(id));
    return O.isSome(result) ? textOf(result.value) : undefined;
  };
  const leafResult = resultOf(grandchild.graph, "0");
  const siblingResult = resultOf(root.graph, "1");
  assert.equal(settled, "root complete");
  assert.equal(leafResult, "leaf-result");
  assert.equal(siblingResult, "sibling-result");
  assert.equal(windows, 3);
  const siblingDone = log.indexOf("sibling done");
  assert.ok(siblingDone > 0 && log.lastIndexOf("child window") < siblingDone, log.join(", "));
  assert.equal(leaf.faux.state.callCount, 2);
  assert.equal(sibling.faux.state.callCount, 1);
  for (const actor of [root.scheduler, child.scheduler, grandchild.scheduler, leaf.agent, sibling.agent]) {
    assert.equal(actor.status, "closed");
  }
  console.log(`${settled}; ${leafResult} + ${siblingResult}; ${windows} root windows`);
}

if (import.meta.main) {
  using cancellation = ctrlC();
  try {
    await main(cancellation.signal);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = cancellation.signal.aborted ? 130 : 1;
  }
}
