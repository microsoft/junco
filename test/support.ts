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
import {
  DummyTracer,
  type EdgeIdType,
  type Sink,
  type Source,
  UNBOUNDED,
  Width,
  type WidthType,
} from "dataflow-engine";
import {
  type Agentic,
  type AgenticInput,
  agent as agentApi,
  JuncoGraph,
  schedulers,
  tools as toolsApi,
} from "junco-agency";
import type {
  AgenticStep,
  JuncoAgent,
  Agentic as JuncoAgentProtocol,
} from "junco-agent";
import type { SchedulerContext } from "junco-scheduler";
import { pi, type SchedulerRequest } from "junco-scheduler/agent";
import { LockPolicy } from "junco-tools";
import { Type } from "typebox";

import type { AgencyNodeMetadata } from "../src/node-policy.ts";

export type AgencyContext = SchedulerContext<
  Agentic<AgenticInput, AssistantMessage>,
  AgenticInput,
  AssistantMessage,
  AgencyNodeMetadata,
  JuncoGraph<AgenticInput, AssistantMessage>
>;

// Every real agent has an in-memory session; scheduler requests are stateless snapshots.
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

/** Native options over `responses` with a fresh in-memory session, under `LockPolicy`. */
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
    contract,
  }: {
    readonly prompt?: string;
    readonly tools?: readonly AgentTool[];
    readonly contract?: (edgeId: EdgeIdType) => toolsApi.Contract;
  } = {},
): Promise<{ faux: FauxProviderHandle; agent: JuncoAgent }> {
  const { faux, options } = await nativeOptions(responses);
  return {
    faux,
    agent: await agentApi.JuncoAgent.fromResolved({
      ...options,
      systemPrompt: "leaf",
      tools: [new toolsApi.YieldTool(), ...tools],
      ...(prompt === undefined ? {} : { prompt }),
      ...(contract === undefined ? {} : { contract }),
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

/** The typed snapshot appended to the model request. */
export function schedulerRequestOf(
  context: Context,
): SchedulerRequest<AgencyNodeMetadata> {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
    if (content.startsWith("SchedulerSnapshot:\n")) {
      return JSON.parse(
        content.slice("SchedulerSnapshot:\n".length),
      ) as SchedulerRequest<AgencyNodeMetadata>;
    }
  }
  throw new Error("request carries no SchedulerSnapshot");
}

export type Decision = { readonly waves: readonly (readonly string[])[] };

export const runAvailable = (
  request: SchedulerRequest<AgencyNodeMetadata>,
): Decision => ({
  waves: [request.nodes.map((node) => node.id)],
});

export function schedulerModel(
  decide: (
    request: SchedulerRequest<AgencyNodeMetadata>,
    index: number,
  ) => Decision = runAvailable,
) {
  const { faux, models, model } = scripted();
  const decisions: Decision[] = [];
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const decision = decide(schedulerRequestOf(context), decisions.length);
    decisions.push(decision);
    return fauxAssistantMessage(
      [scheduleCall(decision.waves, `schedule-${decisions.length}`)],
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([respond]);
  return { faux, models, model, decisions };
}

export const scheduleCall = (
  waves: readonly (readonly string[])[],
  id: string,
) => fauxToolCall("schedule", { waves }, { id });

export type Script =
  | ((request: SchedulerRequest<AgencyNodeMetadata>, index: number) => Decision)
  | readonly FauxResponseStep[];

export async function agencyGraph(
  source: Source<AgenticInput, AssistantMessage>,
  sink: Sink<AgenticInput, AssistantMessage>,
  script: Script = runAvailable,
  {
    prompt,
    threads = UNBOUNDED,
  }: {
    readonly prompt?: string;
    readonly threads?: WidthType;
  } = {},
): Promise<{ context: AgencyContext; faux: FauxProviderHandle }> {
  const { faux, models, model } =
    typeof script === "function" ? schedulerModel(script) : scripted(script);
  const graph = new JuncoGraph(
    source,
    sink,
    Width.create(1),
    threads,
    new DummyTracer(),
    LockPolicy,
  );
  const context = schedulers.context({
    graph,
    scheduler: pi({
      models,
      model,
      ...(prompt === undefined ? {} : { prompt }),
    }),
  });
  return { context, faux };
}

/** Resume through every pause until the current run settles or fails; returns that step. */
export async function drive(agentic: JuncoAgentProtocol): Promise<AgenticStep> {
  while (true) {
    const result = await agentic.next();
    if (result.done)
      throw new Error("iterator finished before its run settled");
    if (result.value.kind !== "yield") return result.value;
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
