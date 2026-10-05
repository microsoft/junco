import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  createModels,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DummyTracer, UNBOUNDED, type WidthType } from "dataflow-engine";
import type {
  AgenticStep,
  JuncoAgent,
  Agentic as JuncoAgentProtocol,
} from "junco-agent";
import type {
  PiScheduler,
  PiSchedulerOptions,
  SchedulerInfo,
} from "junco-scheduler/agent";
import { Type } from "typebox";
import {
  type AgenticInput,
  agent as agentApi,
  JuncoGraph,
  schedulers,
  tools as toolsApi,
} from "../src/index.ts";

/** A graph driven by an agency `PiScheduler`, as every native-suite agency is. */
export type PiGraph = JuncoGraph<
  AgenticInput,
  AssistantMessage,
  unknown,
  PiScheduler<AgenticInput, AssistantMessage>
>;

// Offline scaffolding: every agent gets its own faux provider in an explicit Models collection and
// an in-memory session. Scheduler scripts read the SchedulerInfo of the request they answer.

let providers = 0;

/** A faux model serving `responses` in order. */
export function scripted(responses: readonly FauxResponseStep[] = []) {
  const name = `faux-${++providers}`;
  const faux = fauxProvider({
    api: name,
    provider: name,
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

/** Native options over `responses` with a fresh in-memory session. */
export async function nativeOptions(
  responses: readonly FauxResponseStep[] = [],
) {
  const { faux, models, model } = scripted(responses);
  return {
    faux,
    options: {
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models,
      model,
    },
  };
}

/** A leaf JuncoAgent with a `yield` tool and `extra` tools, staged with `prompt` when given. */
export async function leaf(
  responses: readonly FauxResponseStep[],
  {
    prompt,
    tools = [],
  }: { readonly prompt?: string; readonly tools?: readonly AgentTool[] } = {},
): Promise<{ faux: FauxProviderHandle; agent: JuncoAgent }> {
  const { faux, options } = await nativeOptions(responses);
  return {
    faux,
    agent: await agentApi.JuncoAgent.fromResolved({
      ...options,
      systemPrompt: "leaf",
      tools: [toolsApi.createYieldTool(), ...tools],
      ...(prompt === undefined ? {} : { prompt }),
    }),
  };
}

/**
 * A tool that waits until released — or, with `endOnAbort`, until its call is aborted — and records
 * that it started and whether its signal was aborted.
 */
export function waitingTool(
  name: string,
  { endOnAbort = false }: { readonly endOnAbort?: boolean } = {},
) {
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
      await (endOnAbort
        ? Promise.race([released.promise, aborted.promise])
        : released.promise);
      return {
        content: [{ type: "text", text: `${name} finished` }],
        details: undefined,
      };
    },
  };
  return {
    tool,
    started: started.promise,
    aborted: aborted.promise,
    release: () => released.resolve(),
  };
}

/** The SchedulerInfo appended to the request that `context` belongs to. */
export function schedulerInfoOf(context: Context): SchedulerInfo {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
    if (content.startsWith("SchedulerInfo:\n")) {
      return JSON.parse(
        content.slice("SchedulerInfo:\n".length),
      ) as SchedulerInfo;
    }
  }
  throw new Error("request carries no SchedulerInfo");
}

export type Decision =
  | { readonly lanes: readonly (readonly string[])[] }
  | { readonly text: string };

/** Schedule every candidate in its own lane; once quiescent, answer a fixed completion. */
export const runAvailable = (info: SchedulerInfo): Decision =>
  info.nodes.length > 0
    ? { lanes: info.nodes.map((node) => [node.id]) }
    : { text: "graph quiescent" };

/** A faux scheduler model answering every request with `decide(SchedulerInfo)`. */
export function schedulerModel(
  decide: (info: SchedulerInfo, request: number) => Decision = runAvailable,
) {
  const { faux, models, model } = scripted();
  const decisions: Decision[] = [];
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const decision = decide(schedulerInfoOf(context), decisions.length);
    decisions.push(decision);
    return "lanes" in decision
      ? fauxAssistantMessage(
          [scheduleCall(decision.lanes, `schedule-${decisions.length}`)],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage(decision.text);
  };
  faux.setResponses([respond]);
  return { faux, models, model, decisions };
}

/** One `schedule` tool call. */
export const scheduleCall = (
  lanes: readonly (readonly string[])[],
  id: string,
) => fauxToolCall("schedule", { lanes }, { id });

/** A scheduler script: a SchedulerInfo-driven decision, or explicit faux responses. */
export type Script =
  | ((info: SchedulerInfo, request: number) => Decision)
  | readonly FauxResponseStep[];

/** An agency scheduler over `script` for the graph `getGraph()` returns, staged with `prompt` when given. */
export async function newScheduler(
  getGraph: () => JuncoGraph | undefined,
  script: Script = runAvailable,
  {
    prompt,
    systemPrompt,
  }: {
    readonly prompt?: string;
    readonly systemPrompt?: PiSchedulerOptions["systemPrompt"];
  } = {},
) {
  const { faux, models, model } =
    typeof script === "function" ? schedulerModel(script) : scripted(script);
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  const scheduler = await schedulers.createAgencyScheduler(getGraph, {
    session,
    models,
    model,
    ...(prompt === undefined ? {} : { prompt }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  });
  return { scheduler, faux, session };
}

/** An agency graph over a fresh scheduler, ready for wiring. */
export async function agencyGraph(
  script?: Script,
  {
    prompt,
    window = UNBOUNDED,
    threads = UNBOUNDED,
  }: {
    readonly prompt?: string;
    readonly window?: WidthType;
    readonly threads?: WidthType;
  } = {},
) {
  let current: PiGraph | undefined;
  const { scheduler, faux, session } = await newScheduler(
    () => current,
    script,
    { prompt },
  );
  const graph: PiGraph = new JuncoGraph(
    scheduler,
    window,
    threads,
    new DummyTracer(),
  );
  current = graph;
  return { graph, scheduler, faux, session };
}

/** Resume through every pause until the current run settles or fails; returns that step. */
export async function drive(
  agentic: JuncoAgentProtocol,
): Promise<{ readonly yields: number; readonly last: AgenticStep }> {
  let yields = 0;
  while (true) {
    const result = await agentic.next();
    if (result.done)
      throw new Error("iterator finished before its run settled");
    if (result.value.kind !== "yield") return { yields, last: result.value };
    yields++;
  }
}

/** The text of a settled step. */
export function settledText(step: AgenticStep): string {
  if (step.kind !== "settled")
    throw new Error(`expected a settled step, got ${step.kind}`);
  return step.message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/** Let queued work run; used only to show that nothing progressed, never to wait for progress. */
export const flushMacrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
