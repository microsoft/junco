// Offline recursive agency: root → child → grandchild → a leaf that yields once, plus a root sibling.
// Scheduler models select one current wave from SchedulerSnapshot; only work graphs own members.
// Start sends the assignment to both branches; the nested source routes carry it to the grandchild.
// Join checks both reports and returns the grandchild's exact result.
// Run in a writable native Btrfs seed: bun run /path/to/junco/examples/recursive-agency/recursive-agency.ts

import assert from "node:assert/strict";
import {
  type Context,
  contentText,
  createModels,
  type FauxResponseFactory,
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as O from "fp-ts/lib/Option.js";
import { AssistantMessageSchema, agent, graph as graphApi, JuncoGraph, schedules, syntax, tracer } from "junco";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { problemRecorder, runCli } from "../support.ts";
import source from "./recursive-agency.yml" with { type: "text" };

const { JuncoAgent } = agent;
const { NodeId } = graphApi;
type Request = schedules.SchedulerRequest<schedules.AgencyNodeMetadata>;
type Plan = { readonly waves: readonly (readonly string[])[] };

/** Join both root branches, retaining the child's exact result after validating both reports. */
const Join: syntax.DeterministicNode = ({ policy }) =>
  new graphApi.nodes.Deterministic<TSchema, unknown>(async function* () {
    const inputs = yield [];
    for (const id of ["0->Join", "1->Join"]) {
      const result = inputs.values.get(graphApi.EdgeId.create(id));
      if (!Value.Check(AssistantMessageSchema, result) || result.stopReason !== "stop" || !contentText(result.content).trim())
        throw new Error(`${id} did not produce a complete report`);
    }
    return inputs.values.get(graphApi.EdgeId.create("0->Join"));
  }, policy);

let providers = 0;

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
  const faux = fauxProvider({ api: "faux", provider: "faux" });
  const calls = { leaf: 0, sibling: 0 };
  const respond: FauxResponseFactory = (context) => {
    const first = context.messages.find((m) => m.role === "user");
    assert.ok(first);
    if (contentText(first.content).startsWith("Complete the sibling assignment")) {
      calls.sibling++;
      return fauxAssistantMessage("sibling-result");
    }
    assert.ok(contentText(first.content).startsWith("Complete the grandchild assignment"));
    return ++calls.leaf === 1
      ? fauxAssistantMessage(fauxToolCall("yield", { reason: "waiting once" }, { id: "leaf-yield" }), { stopReason: "toolUse" })
      : fauxAssistantMessage("leaf-result");
  };
  faux.setResponses([respond, respond, respond]);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("faux", async () => ({ type: "api_key", key: "offline" }));
  const models = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  models.registerNativeProvider(faux.provider);
  const ladder = new schedules.ModelLadder(models, schedules.uniformLadder({ model: `faux/${faux.getModel().id}` }));
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
  await using lifetime = new AsyncDisposableStack();
  lifetime.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
  const root = {
    context: await JuncoGraph.fromYaml(source, {
      cwd: process.cwd(),
      scheduler: (name) => fauxScheduler(name, decide[name]!, name === "root" ? decisions : []),
      code: { Join },
      recorder,
      tracer: observer,
      ladder,
      signal,
    }),
    decisions,
  };
  lifetime.defer(() => root.context.graph.close());
  const childGraph = root.context.graph.getNode(NodeId.create("0"))!.state;
  assert.ok(childGraph instanceof JuncoGraph);
  const grandchildGraph = childGraph.getNode(NodeId.create("0"))!.state;
  assert.ok(grandchildGraph instanceof JuncoGraph);
  const leaf = grandchildGraph.getNode(NodeId.create("0"))!.state;
  const sibling = root.context.graph.getNode(NodeId.create("1"))!.state;
  assert.ok(leaf instanceof JuncoAgent && sibling instanceof JuncoAgent);
  sibling.events.on("run_end", (event) => {
    if (event.status === "completed") log.push("sibling done");
  });
  {
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

  await lifetime.disposeAsync();
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
  assert.deepEqual(calls, { leaf: 2, sibling: 1 });
  for (const actor of [leaf, sibling]) assert.equal(actor.status, "closed");
  console.log(`root complete; ${leafResult} + ${siblingResult}; ${root.decisions.length} root decisions`);
}

if (import.meta.main) await runCli(main);
