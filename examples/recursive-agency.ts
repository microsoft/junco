// Offline recursive agency: root → child → grandchild → a leaf that yields once, plus a root sibling.
// Scheduler models select one current wave from SchedulerSnapshot; only work graphs own members.
// Run: bun run examples/recursive-agency.ts

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
import { Edge, NodeId, type NodeOptions, TriggerRule, UNBOUNDED, Width } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import type { SchedulerRequest } from "junco-scheduler/agent";
import { LockPolicy, type ToolCollection, YieldTool } from "junco-tools";
import { type AgenticInput, graph as graphApi, schedulers, tracer } from "../src/index.ts";
import { ctrlC } from "./cancellation.ts";

type AgencyContext = ReturnType<typeof schedulers.context<AgenticInput, AssistantMessage, graphApi.JuncoGraph>>;
type Request = SchedulerRequest<schedulers.AgencyNodeMetadata>;
type Plan = { readonly waves: readonly (readonly string[])[] };

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

function schedulerRequestOf(context: Context): Request {
  const last = context.messages.at(-1);
  const text = last?.role === "user"
    ? typeof last.content === "string"
      ? last.content
      : last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : "";
  assert.ok(text.startsWith("SchedulerSnapshot:\n"));
  return JSON.parse(text.slice("SchedulerSnapshot:\n".length)) as Request;
}

const textOf = (message: AssistantMessage) =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/** One simultaneous wave, recomputed from the current request, including scheduled sink work. */
const runAvailable = (request: Request): Plan => ({ waves: [request.nodes.map((node) => node.id)] });

function agency(
  name: string,
  policy: ToolCollection["policy"],
  members: readonly (JuncoAgent | AgencyContext)[],
  decide: (request: Request) => Plan,
) {
  const provider = `faux-${++providers}`;
  const faux = fauxProvider({ api: provider, provider });
  const models = createModels();
  models.setProvider(faux.provider);
  const decisions: string[][] = [];
  const respond: FauxResponseFactory = (requestContext) => {
    faux.appendResponses([respond]);
    const decision = decide(schedulerRequestOf(requestContext));
    decisions.push([...(decision.waves[0] ?? [])]);
    return fauxAssistantMessage([
      fauxToolCall("schedule", { waves: decision.waves }, { id: `${name}-${decisions.length}` }),
    ], { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  const finalResult = Edge.value<AgenticInput, AssistantMessage>("0->$sink");
  const source = new graphApi.nodes.Source<AgenticInput, AssistantMessage>(() => {
    throw new graphApi.DataflowDefinitionError(`${name} does not accept external input`);
  }, { id: NodeId.create("$source") });
  const sink: graphApi.nodes.Sink<AgenticInput, AssistantMessage> = new graphApi.nodes.Sink<AgenticInput, AssistantMessage>(async function* (): graphApi.NodeGenerator<AgenticInput, AssistantMessage> {
    yield [];
    const result = graph.result(NodeId.create("0"));
    if (O.isNone(result)) throw new Error(`${name} member 0 did not produce a result`);
    return result.value;
  }, { id: NodeId.create("$sink"), trigger: TriggerRule.when(finalResult) });
  const graph: graphApi.JuncoGraph<AgenticInput, AssistantMessage> = new graphApi.JuncoGraph(source, sink, Width.create(1), UNBOUNDED, tracer.TuiTracer.shared(), policy);
  const context = schedulers.context({
    scheduler: schedulers.pi({ models, model: faux.getModel(), systemPrompt: `You schedule ${name}.`, prompt: `Run ${name}.` }),
    graph,
  });
  for (const [index, member] of members.entries()) {
    const options: NodeOptions<AgenticInput, AssistantMessage> = {
      description: `${name} member ${index}`,
      trigger: TriggerRule.always(),
    };
    graph.addNode(member instanceof JuncoAgent
      ? { ...options, policy, state: member }
      : { ...options, state: member });
  }
  graph.addEdge(NodeId.create("0"), sink.id, finalResult);
  return { context, decisions };
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

  const grandchild = agency("grandchild", LockPolicy, [leaf.agent], runAvailable);
  const child = agency("child", LockPolicy, [grandchild.context], (request) => {
    log.push("child decision");
    return runAvailable(request);
  });
  const root = agency("root", LockPolicy, [child.context, sibling.agent], (request) => {
    if (request.history.length === 0) return { waves: [["0", "1"]] };
    if (request.nodes.some((node) => node.id === "0")) return { waves: [["0"]] };
    return runAvailable(request);
  });
  const failures: unknown[] = [];
  let abortWork: Promise<void> | undefined;
  const interrupt = () => {
    abortWork = root.context.graph.abort(signal.reason).catch((error) => {
      failures.push(error);
    });
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    signal.throwIfAborted();
    await root.context.run({ signal });
    signal.throwIfAborted();
  } catch (error) {
    failures.push(error);
  } finally {
    signal.removeEventListener("abort", interrupt);
    await abortWork;
    for (const release of [() => root.context.graph.close(), () => root.context.graph.tracer.flush()]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Recursive agency failed", { cause: failures[0] });
  signal.throwIfAborted();

  const resultOf = (context: AgencyContext, id: string) => {
    const result = context.graph.result(NodeId.create(id));
    assert.ok(O.isSome(result), `Missing retained result ${id}`);
    return result.value;
  };
  const final = resultOf(grandchild.context, "0");
  const leafResult = textOf(final);
  const siblingResult = textOf(resultOf(root.context, "1"));
  assert.equal(leafResult, "leaf-result");
  assert.equal(siblingResult, "sibling-result");
  for (const execution of [grandchild.context, child.context, root.context]) {
    assert.equal(resultOf(execution, execution.graph.sink.id), final);
    assert.equal(resultOf(execution, "0"), final);
  }
  assert.deepEqual(root.decisions, [
    ["0", "1"], ["0"], ["0"], ["0"], ["0"], ["0"], ["0"], ["0"], ["0"], ["$sink", "1"], ["$sink"],
  ]);
  const siblingDone = log.indexOf("sibling done");
  assert.ok(siblingDone > 0 && log.lastIndexOf("child decision") < siblingDone, log.join(", "));
  assert.equal(leaf.faux.state.callCount, 2);
  assert.equal(sibling.faux.state.callCount, 1);
  for (const actor of [leaf.agent, sibling.agent]) assert.equal(actor.status, "closed");
  console.log(`root complete; ${leafResult} + ${siblingResult}; ${root.decisions.length} root decisions`);
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
