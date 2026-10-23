// Offline recursive agency: root → child → grandchild → a leaf that yields once, plus a root sibling.
// Scheduler models select one current wave from SchedulerSnapshot; only work graphs own members.
// recursive-agency.yml declares the topology; this module supplies Join and the faux agents.
// Run: bun run examples/recursive-agency/recursive-agency.ts

import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentTool, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  createModels,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import { agent, graph as graphApi, JuncoGraph, schedules, syntax } from "junco-agency";
import { runCli } from "../support.ts";
import source from "./recursive-agency.yml" with { type: "text" };

const { JuncoAgent } = agent;
const { NodeId } = graphApi;
type Request = schedules.SchedulerRequest<schedules.AgencyNodeMetadata>;
type Plan = { readonly waves: readonly (readonly string[])[] };

/** Join both root branches, retaining the child's exact result after validating both reports. */
const Join: syntax.DeterministicNode = ({ policy }) => {
  return {
    state: new graphApi.nodes.Deterministic<graphApi.nodes.AgenticInput, AssistantMessage>(async function* () {
      const inputs = yield [];
      for (const id of ["0->Join", "1->Join"]) {
        const result = inputs.values.get(graphApi.EdgeId.create(id));
        if (result?.stopReason !== "stop" || !contentText(result.content).trim())
          throw new Error(`${id} did not produce a complete report`);
      }
      return inputs.values.get(graphApi.EdgeId.create("0->Join"))!;
    }, policy),
  };
};

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

function fauxScheduler(
  name: string,
  decide: (request: Request) => Plan,
  decisions: string[][] = [],
) {
  const provider = `faux-${++providers}`;
  const faux = fauxProvider({ api: provider, provider });
  const models = createModels();
  models.setProvider(faux.provider);
  const respond: FauxResponseFactory = (requestContext) => {
    faux.appendResponses([respond]);
    const decision = decide(schedulerRequestOf(requestContext));
    decisions.push([...(decision.waves[0] ?? [])]);
    return fauxAssistantMessage([
      fauxToolCall("schedule", { waves: decision.waves }, { id: `${name}-${decisions.length}` }),
    ], { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  return schedules.pi({ models, model: faux.getModel(), systemPrompt: `You schedule ${name}.`, prompt: `Run ${name}.` });
}

async function main(signal: AbortSignal) {
  const log: string[] = [];
  const leafResponses = [
    fauxAssistantMessage([fauxToolCall("yield", { reason: "waiting once" }, { id: "leaf-yield" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("leaf-result"),
  ];
  const siblingResponses = [fauxAssistantMessage("sibling-result")];
  const actors = new Map<string, { faux: Awaited<ReturnType<typeof nativeOptions>>["faux"]; agent: agent.JuncoAgent }>();
  const decisions: string[][] = [];
  const decide: Record<string, (request: Request) => Plan> = {
    grandchild: runAvailable,
    child: (request) => {
      log.push("child decision");
      return runAvailable(request);
    },
    root: (request) => {
      if (request.history.length === 0) return { waves: [["0", "1"]] };
      if (request.nodes.some((node) => node.id === "0")) return { waves: [["0"]] };
      return runAvailable(request);
    },
  };
  const root = {
    context: await JuncoGraph.fromYaml(source, {
      cwd: process.cwd(),
      scheduler: (name) => fauxScheduler(name, decide[name]!, name === "root" ? decisions : []),
      code: { Join },
      createAgent: async (spec) => {
        const { faux, options } = await nativeOptions(spec.node === "0" ? leafResponses : siblingResponses);
        const agent = await JuncoAgent.fromResolved({
          ...options,
          systemPrompt: spec.systemPrompt,
          tools: spec.tools as AgentTool[],
        });
        actors.set(spec.node, { faux, agent });
        if (spec.node === "1") {
          agent.events.on("run_end", (event) => {
            if (event.status === "completed") log.push("sibling done");
          });
        }
        return agent;
      },
    }),
    decisions,
  };
  const leaf = actors.get("0")!;
  const sibling = actors.get("1")!;
  {
    // LIFO: join a pending abort, then close the graph, then flush its tracer.
    await using lifetime = new AsyncDisposableStack();
    lifetime.defer(() => root.context.graph.tracer.flush());
    lifetime.adopt(root.context.graph, (graph) => graph.close());
    let abortWork: Promise<void> | undefined;
    const interrupt = () => {
      abortWork = root.context.graph.abort(signal.reason);
    };
    signal.addEventListener("abort", interrupt, { once: true });
    lifetime.defer(async () => {
      signal.removeEventListener("abort", interrupt);
      await abortWork;
    });
    if (signal.aborted) interrupt();
    signal.throwIfAborted();
    await root.context.run({ signal });
    signal.throwIfAborted();
  }

  const childGraph = root.context.graph.getNode(NodeId.create("0"))!.state as graphApi.JuncoGraph;
  const grandchildGraph = childGraph.getNode(NodeId.create("0"))!.state as graphApi.JuncoGraph;
  const resultOf = (graph: graphApi.JuncoGraph, id: string) => {
    const result = graph.result(NodeId.create(id));
    assert.ok(O.isSome(result), `Missing retained result ${id}`);
    return result.value;
  };
  const final = resultOf(grandchildGraph, "0");
  const leafResult = textOf(final);
  const siblingResult = textOf(resultOf(root.context.graph, "1"));
  assert.equal(leafResult, "leaf-result");
  assert.equal(siblingResult, "sibling-result");
  for (const graph of [grandchildGraph, childGraph, root.context.graph]) {
    assert.equal(resultOf(graph, graph.sink.id), final);
    assert.equal(resultOf(graph, "0"), final);
  }
  assert.ok(root.decisions.some((wave) => wave.includes("Join")));
  const siblingDone = log.indexOf("sibling done");
  assert.ok(siblingDone > 0 && log.lastIndexOf("child decision") < siblingDone, log.join(", "));
  assert.equal(leaf.faux.state.callCount, 2);
  assert.equal(sibling.faux.state.callCount, 1);
  for (const actor of [leaf.agent, sibling.agent]) assert.equal(actor.status, "closed");
  console.log(`root complete; ${leafResult} + ${siblingResult}; ${root.decisions.length} root decisions`);
}

if (import.meta.main) await runCli(main);
