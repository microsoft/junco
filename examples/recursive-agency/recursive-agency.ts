// Offline recursive agency: root → child → grandchild → a leaf that yields once, plus a root sibling.
// Scheduler models select one current wave from SchedulerSnapshot; only work graphs own members.
// Run: bun run examples/recursive-agency/recursive-agency.ts

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
import { NodeId } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import type { SchedulerRequest } from "junco-scheduler/agent";
import { build, parse } from "junco-syntax";
import { graph as graphApi, schedulers } from "../../src/index.ts";
import { ctrlC } from "../cancellation/cancellation.ts";
import source from "./recursive-agency.yml" with { type: "text" };

const document = parse(source);
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
  return schedulers.pi({ models, model: faux.getModel(), systemPrompt: `You schedule ${name}.`, prompt: `Run ${name}.` });
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
  const actors = new Map<string, { faux: Awaited<ReturnType<typeof nativeOptions>>["faux"]; agent: JuncoAgent }>();
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
    context: await build(document, {
      cwd: process.cwd(),
      scheduler: (name) => fauxScheduler(name, decide[name]!, name === "root" ? decisions : []),
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
