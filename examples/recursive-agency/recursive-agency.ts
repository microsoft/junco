// Offline recursive agency: root → child → grandchild → a leaf that yields once, plus a root sibling.
// Scheduler models select one current wave from SchedulerSnapshot; only work graphs own members.
// recursive-agency.yml declares the topology; this module supplies Join and the faux agents.
// Run: bun run examples/recursive-agency/recursive-agency.ts

import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentTool, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
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
import { AssistantMessageSchema, agent, graph as graphApi, JuncoGraph, schedules, syntax, tracer } from "junco";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { problemRecorder, runCli, type YamlAgent } from "../support.ts";
import source from "./recursive-agency.yml" with { type: "text" };

const { JuncoAgent } = agent;
const { NodeId } = graphApi;
type Request = schedules.SchedulerRequest<schedules.AgencyNodeMetadata>;
type Plan = { readonly waves: readonly (readonly string[])[] };

/** Start both root branches with one null control value each. */
const Start: syntax.DeterministicNode = ({ policy }) => ({
  state: new graphApi.nodes.Deterministic<TSchema, unknown>(async function* () {
    yield [];
    return null;
  }, policy),
});

/** Join both root branches, retaining the child's exact result after validating both reports. */
const Join: syntax.DeterministicNode = ({ policy }) => {
  return {
    state: new graphApi.nodes.Deterministic<TSchema, unknown>(async function* () {
      const inputs = yield [];
      for (const id of ["0->Join", "1->Join"]) {
        const result = inputs.values.get(graphApi.EdgeId.create(id));
        if (!Value.Check(AssistantMessageSchema, result) || result.stopReason !== "stop" || !contentText(result.content).trim())
          throw new Error(`${id} did not produce a complete report`);
      }
      return inputs.values.get(graphApi.EdgeId.create("0->Join"));
    }, policy),
  };
};


const NATIVE_TOOL_BLOCK = [
  "read",
  "bash",
  "edit",
  "release",
  "grep",
  "find",
  "ast_grep",
  "ast_edit",
  "diff",
  "code_graph",
] as const;
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
    tool_block: NATIVE_TOOL_BLOCK,
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

/** The text of a dynamic YAML result, after checking it is a native assistant message. */
function textOf(message: unknown): string {
  assert.ok(Value.Check(AssistantMessageSchema, message));
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}


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
  // Disposed when main returns, after the graph below has closed.
  await using recording = new AsyncDisposableStack();
  const recorder = recording.adopt(await problemRecorder(process.cwd()), (owned) => owned.close());
  const log: string[] = [];
  const leafResponses = [
    fauxAssistantMessage([fauxToolCall("yield", { reason: "waiting once" }, { id: "leaf-yield" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("leaf-result"),
  ];
  const siblingResponses = [fauxAssistantMessage("sibling-result")];
  const actors = new Map<string, { faux: Awaited<ReturnType<typeof nativeOptions>>["faux"]; agent: YamlAgent }>();
  const decisions: string[][] = [];
  const decide: Record<string, (request: Request) => Plan> = {
    grandchild: runAvailable,
    child: (request) => {
      log.push("child decision");
      return runAvailable(request);
    },
    root: (request) => {
      const ids = new Set<string>(request.nodes.map((node) => node.id));
      if (ids.has("Start")) return { waves: [["Start"]] };
      if (ids.has("0") && ids.has("1")) return { waves: [["0", "1"]] };
      if (ids.has("0")) return { waves: [["0"]] };
      return runAvailable(request);
    },
  };
  const observer = tracer.TuiTracer.shared();
  const root = {
    context: await JuncoGraph.fromYaml(source, {
      cwd: process.cwd(),
      scheduler: (name) => fauxScheduler(name, decide[name]!, name === "root" ? decisions : []),
      code: { Start, Join },
      recorder,
      tracer: observer,
      createAgent: async (spec) => {
        const { faux, options } = await nativeOptions(spec.node === "0" ? leafResponses : siblingResponses);
        const agent: YamlAgent = await JuncoAgent.fromResolved({
          ...options,
          systemPrompt: spec.systemPrompt,
          tools: spec.tools as AgentTool[],
          tool_block: [
            ...new Set([
              ...(options.tool_block ?? []),
              ...(spec.tool_block ?? []),
            ]),
          ],
          recorder: spec.recorder,
          recorderNodeId: spec.recorderNodeId,
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
    // LIFO: join a pending abort, then close the graph, then finish the TUI.
    await using lifetime = new AsyncDisposableStack();
    lifetime.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
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

  const childGraph = root.context.graph.getNode(NodeId.create("0"))!.state as JuncoGraph<TSchema, unknown>;
  const grandchildGraph = childGraph.getNode(NodeId.create("0"))!.state as JuncoGraph<TSchema, unknown>;
  const resultOf = (graph: JuncoGraph<TSchema, unknown>, id: string) => {
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
  assert.deepEqual(root.decisions[0], ["Start"]);
  // Both branches run together whenever both are available: priming, then execution.
  const paired = root.decisions.filter((wave) => wave.includes("0") && wave.includes("1"));
  assert.ok(paired.length >= 2, JSON.stringify(root.decisions));
  const firstChild = log.indexOf("child decision");
  assert.ok(firstChild >= 0 && firstChild < log.indexOf("sibling done"), log.join(", "));
  assert.equal(leaf.faux.state.callCount, 2);
  assert.equal(sibling.faux.state.callCount, 1);
  for (const actor of [leaf.agent, sibling.agent]) assert.equal(actor.status, "closed");
  console.log(`root complete; ${leafResult} + ${siblingResult}; ${root.decisions.length} root decisions`);
}

if (import.meta.main) await runCli(main);
