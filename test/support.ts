import { fileURLToPath } from "node:url";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxModelDefinition,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DummyTracer,
  Edge,
  Message,
  NodeId,
  type Sink,
  type Source,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
  type WidthType,
} from "dataflow-engine";
import {
  type Agentic,
  agent as agentApi,
  JuncoGraph,
  type MockAgent,
  schedules,
  tools as toolsApi,
} from "junco";
import {
  type AgenticStep,
  type JuncoAgent,
  type Agentic as JuncoAgentProtocol,
  Task,
  TaskSchema,
} from "junco-agent";
import type { SchedulerContext } from "junco-scheduler";
import { LockPolicy, type NativeModule } from "junco-tools";
import { pi, type SchedulerRequest } from "junco-scheduler/agent";
import { Type } from "typebox";

import {
  type Plan,
  runAvailable,
  scheduleCall,
  schedulerRequestOf,
  scripted,
  toolTurn,
} from "../packages/junco-scheduler/test/support.ts";
import type { AgencyNodeMetadata } from "../src/node-policy.ts";

type Chat = typeof TaskSchema;

export type AgencyContext = SchedulerContext<
  Agentic<Chat, AssistantMessage>,
  Chat,
  AssistantMessage,
  AgencyNodeMetadata,
  JuncoGraph<Chat, AssistantMessage>
>;

/** Register a graph-owned prompt with one consumable assignment, optionally joined to a result. */
export function addPromptOnce(
  graph: AgencyContext["graph"],
  id: string,
  state: JuncoAgent | MockAgent,
  prompt: string,
  description?: string,
  after?: Edge<Chat, AssistantMessage>,
) {
  const start = Edge.message(`$source~>${id}`, TaskSchema);
  const member = graph.addNode({
    id: NodeId.create(id),
    state,
    prompt,
    policy: LockPolicy,
    ...(description === undefined ? {} : { description }),
    trigger:
      after === undefined
        ? TriggerRule.when(start)
        : TriggerRule.allOf(TriggerEntry.on(start), TriggerEntry.on(after)),
  });
  graph.addEdge(graph.source.id, member, start);
  graph.emit(
    graph.source.id,
    Message.create(start, Task.create({
      kind: "prompt",
      text: `Begin ${id}'s assignment.`,
      spec: "Return a result.",
    })),
  );
  return member;
}

export const NATIVE_TOOL_BLOCK = [
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

/** A `ModelRuntime` with a saved login for a faux `provider` serving `responses` in order. */
export async function fauxRuntime(
  responses: readonly FauxResponseStep[],
  provider = "faux",
  definitions?: readonly FauxModelDefinition[],
) {
  const { faux } = scripted(responses, provider, definitions);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider, async () => ({
    type: "api_key",
    key: "fixture-login",
  }));
  const models = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  models.registerNativeProvider(faux.provider);
  return { models, faux };
}

/** One authenticated offline ladder; a factory dispatches by transcript even for concurrent roles. */
export async function offlineLadder(responses: readonly FauxResponseStep[] | FauxResponseFactory, model?: FauxModelDefinition) {
  const { models, faux } = await fauxRuntime(typeof responses === "function" ? [] : responses, "faux", model && [model]);
  if (typeof responses === "function") {
    const stream = models.streamSimple.bind(models);
    models.streamSimple = (...args) => {
      faux.appendResponses([responses]);
      return stream(...args);
    };
  }
  return new schedules.ModelLadder(models, schedules.uniformLadder({ model: `faux/${faux.getModel().id}` }));
}

/** The CopyTree addon is optional; load it only for tests exercising native bindings. */
export async function copyTreeNative(): Promise<NativeModule> {
  const native = await import(fileURLToPath(new URL(
    "../packages/junco-tools/target/native-test/index.js", import.meta.url,
  )));
  return { ...native, NativeMux: { open: native.NativeMux.openCopyTree.bind(native.NativeMux) } } as NativeModule;
}

/** Count lease, owner-binding and creator lifetimes without acquiring a mux. */
export function countedCollection(failure?: { binding: number; error: Error }) {
  const events: string[] = [];
  const active = { leases: 0, bindings: 0, creatorCloses: 0 };
  let leases = 0, bindings = 0;
  const collection = {
    policy: LockPolicy,
    tools: [],
    lease() {
      const id = ++leases;
      active.leases++;
      let closed = false;
      return { close: async () => {
        if (closed) return;
        closed = true;
        active.leases--;
        events.push(`lease-close:${id}`);
      } };
    },
    bind() {
      const id = ++bindings;
      active.bindings++;
      let closing: Promise<void> | undefined;
      return { owner: `owner-${id}`, tools: new Map(), close: () =>
        closing ??= Promise.resolve().then(() => {
          active.bindings--;
          events.push(`bind-close:${id}`);
          if (failure?.binding === id) throw failure.error;
        }) };
    },
    close: async () => {
      if (active.creatorCloses === 0) {
        active.creatorCloses++;
        events.push("creator-close");
      }
    },
  } as unknown as toolsApi.ToolCollection;
  return { collection, active, events };
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
      tool_block: NATIVE_TOOL_BLOCK,
    },
  };
}

/** A leaf JuncoAgent with a `yield` tool and `extra` tools, staged with `prompt` when given. */
export async function leaf(
  responses: readonly FauxResponseStep[],
  {
    prompt,
    tools = [],
  }: {
    readonly prompt?: string;
    readonly tools?: readonly AgentTool[];
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

export { runAvailable, scheduleCall, schedulerRequestOf, scripted, toolTurn };
export type Decision = Plan;

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
    const decision = decide(
      schedulerRequestOf<AgencyNodeMetadata>(context),
      decisions.length,
    );
    decisions.push(decision);
    return fauxAssistantMessage(
      [scheduleCall(decision.waves, `schedule-${decisions.length}`)],
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([respond]);
  return { faux, models, model, decisions };
}

export type Script =
  | ((request: SchedulerRequest<AgencyNodeMetadata>, index: number) => Decision)
  | readonly FauxResponseStep[];

export async function agencyGraph(
  source: Source<Chat, AssistantMessage>,
  sink: Sink<Chat, AssistantMessage>,
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
  const context = schedules.context({
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
  return contentText(step.message.content, "");
}

/** Let queued work run; used only to show that nothing progressed, never to wait for progress. */
export const flushMacrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
