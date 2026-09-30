import { tmpdir } from "node:os";
import { type AgentTool, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  type Context,
  createModels,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DataflowGraph, UNBOUNDED, type WidthType } from "dataflow-engine";
import { type Agentic, type AgenticStep, createYieldTool, JuncoAgent } from "junco-agent";
import { Type } from "typebox";
import { type AgencyGraph, type GraphInfo, PiScheduler, type PiSchedulerOptions } from "../src/index.ts";

// Offline scaffolding: every agent gets its own faux provider in an explicit Models collection and
// an in-memory session. Scheduler scripts read the GraphInfo of the request they answer.

let providers = 0;

/** A faux model serving `responses` in order. */
export function scripted(responses: readonly FauxResponseStep[] = []) {
  const name = `faux-${++providers}`;
  const faux = fauxProvider({ api: name, provider: name, tokenSize: { min: 4, max: 4 } });
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

/** Native options over `responses` with a fresh in-memory session. */
export async function nativeOptions(responses: readonly FauxResponseStep[] = []) {
  const { faux, models, model } = scripted(responses);
  return {
    faux,
    options: {
      env: new NodeExecutionEnv({ cwd: tmpdir() }),
      session: await new InMemorySessionRepo().create(),
      models,
      model,
    },
  };
}

/** A leaf JuncoAgent with a `yield` tool and `extra` tools, staged with `prompt` when given. */
export async function leaf(
  responses: readonly FauxResponseStep[],
  { prompt, tools = [] }: { readonly prompt?: string; readonly tools?: readonly AgentTool[] } = {},
): Promise<{ faux: FauxProviderHandle; agent: JuncoAgent }> {
  const { faux, options } = await nativeOptions(responses);
  return {
    faux,
    agent: new JuncoAgent({
      ...options,
      systemPrompt: "leaf",
      tools: [createYieldTool(), ...tools],
      ...(prompt === undefined ? {} : { prompt }),
    }),
  };
}

/**
 * A tool that waits until released — or, with `endOnAbort`, until its call is aborted — and records
 * that it started and whether its signal was aborted.
 */
export function waitingTool(name: string, { endOnAbort = false }: { readonly endOnAbort?: boolean } = {}) {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const tool: AgentTool = {
    name,
    label: name,
    description: `${name} waits`,
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, signal) => {
      started.resolve();
      const onAbort = () => aborted.resolve();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      await (endOnAbort ? Promise.race([released.promise, aborted.promise]) : released.promise);
      return { content: [{ type: "text", text: `${name} finished` }], details: undefined };
    },
  };
  return { tool, started: started.promise, aborted: aborted.promise, release: () => released.resolve() };
}

/** The GraphInfo appended to the request that `context` belongs to. */
export function graphInfoOf(context: Context): GraphInfo {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role === "user" && typeof message.content === "string" && message.content.startsWith("GraphInfo:\n")) {
      return JSON.parse(message.content.slice("GraphInfo:\n".length)) as GraphInfo;
    }
  }
  throw new Error("request carries no GraphInfo");
}

export type Decision = { readonly lanes: readonly (readonly string[])[] } | { readonly text: string };

/** Schedule every available member in its own lane; once quiescent, report the results in order. */
export const runAvailable = (info: GraphInfo): Decision => {
  const available = info.nodes.filter((node) => node.available).map((node) => [node.id]);
  if (available.length > 0) return { lanes: available };
  return { text: info.nodes.map((node) => node.result?.text ?? `(${node.id} ${node.status})`).join(" + ") };
};

/** A faux scheduler model answering every request with `decide(GraphInfo)`. */
export function schedulerModel(decide: (info: GraphInfo, request: number) => Decision = runAvailable) {
  const { faux, models, model } = scripted();
  const decisions: Decision[] = [];
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const decision = decide(graphInfoOf(context), decisions.length);
    decisions.push(decision);
    return "lanes" in decision
      ? fauxAssistantMessage([scheduleCall(decision.lanes, `schedule-${decisions.length}`)], { stopReason: "toolUse" })
      : fauxAssistantMessage(decision.text);
  };
  faux.setResponses([respond]);
  return { faux, models, model, decisions };
}

/** One `schedule` tool call. */
export const scheduleCall = (lanes: readonly (readonly string[])[], id: string) =>
  fauxToolCall("schedule", { lanes }, { id });

/** A scheduler script: a GraphInfo-driven decision, or explicit faux responses. */
export type Script = ((info: GraphInfo, request: number) => Decision) | readonly FauxResponseStep[];

/** A PiScheduler over `script`, staged with `prompt` when given. */
export async function newScheduler(
  script: Script = runAvailable,
  { prompt, systemPrompt }: { readonly prompt?: string; readonly systemPrompt?: PiSchedulerOptions["systemPrompt"] } = {},
) {
  const { faux, models, model } = typeof script === "function" ? schedulerModel(script) : scripted(script);
  const session = await new InMemorySessionRepo().create();
  const scheduler = new PiScheduler({
    env: new NodeExecutionEnv({ cwd: tmpdir() }),
    session,
    models,
    model,
    ...(prompt === undefined ? {} : { prompt }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  });
  return { scheduler, faux, session };
}

/** An agency graph over a fresh scheduler, for wiring before `attachAgency(graph)`. */
export async function agencyGraph(
  script?: Script,
  {
    prompt,
    window = UNBOUNDED,
    threads = UNBOUNDED,
  }: { readonly prompt?: string; readonly window?: WidthType; readonly threads?: WidthType } = {},
) {
  const { scheduler, faux, session } = await newScheduler(script, { prompt });
  const graph: AgencyGraph = new DataflowGraph(scheduler, window, threads);
  return { graph, scheduler, faux, session };
}

/** Resume through every pause until the current run settles or fails; returns that step. */
export async function drive(agentic: Agentic): Promise<{ readonly yields: number; readonly last: AgenticStep }> {
  let yields = 0;
  while (true) {
    const result = await agentic.next();
    if (result.done) throw new Error("iterator finished before its run settled");
    if (result.value.kind !== "yield") return { yields, last: result.value };
    yields++;
  }
}

/** The text of a settled step. */
export function settledText(step: AgenticStep): string {
  if (step.kind !== "settled") throw new Error(`expected a settled step, got ${step.kind}`);
  return step.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Let queued work run; used only to show that nothing progressed, never to wait for progress. */
export const flushMacrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));
