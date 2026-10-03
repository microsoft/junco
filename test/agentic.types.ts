// Compile-only: one engine-owned NodeOptions value registers every node kind with execution
// bindings kept apart; JuncoGraph is the runtime graph state preserving its wire types and concrete
// scheduler; specialized skills, prompt templates and tools survive JuncoAgent and both agency
// scheduler factories. Covered by tsconfig.typecheck.json; never executed.

import type { AgentTool, PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  always,
  type DataflowGraph,
  type DataflowScheduler,
  type DataflowTracer,
  type Message,
  messageEdge,
  msg,
  type NodeIdType,
  type NodeOptions,
  type NodeSpec,
  UNBOUNDED,
  Width,
  type WidthType,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticStep, JuncoAgent, type Agentic as JuncoAgentProtocol } from "junco-agent";
import { createParallelScheduler } from "junco-scheduler";
import type { PiScheduler, PiSchedulerOptions, ScheduleTool } from "junco-scheduler/agent";
import * as api from "../src/index.ts";
import {
  type Agentic,
  type AgenticInput,
  type AgenticNode,
  type AgentNodeBinding,
  agentNode,
  compactGraph,
  createAgencyScheduler,
  Deterministic,
  deterministicNode,
  type GraphNodeBinding,
  graphNode,
  JuncoGraph,
  MockAgent,
} from "../src/index.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };
type TaggedScheduler = PiScheduler<AgenticInput, AssistantMessage, TaggedSkill, TaggedTemplate>;

export function juncoAgentKeepsSpecializations(agent: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>) {
  const tool: "tool" | undefined = agent.getTools()[0]?.tag;
  const skill: "skill" | undefined = agent.getResources().skills?.[0]?.tag;
  const template: "template" | undefined = agent.getResources().promptTemplates?.[0]?.tag;
  return [tool, skill, template];
}

export async function factoriesKeepSpecializations(
  resolved: Omit<PiSchedulerOptions<AgenticInput, AssistantMessage, TaggedSkill, TaggedTemplate>, "adapter">,
  opus: Omit<PiSchedulerOptions<AgenticInput, AssistantMessage, TaggedSkill, TaggedTemplate>, "adapter">,
  tracer: DataflowTracer,
) {
  let graph: JuncoGraph | undefined;
  const made: Promise<TaggedScheduler> = createAgencyScheduler(() => graph, resolved);
  const fixed: Promise<TaggedScheduler> = createAgencyScheduler(() => graph, opus);
  const scheduler = await made;
  const constructed = new JuncoGraph(scheduler, Width(1), UNBOUNDED, tracer);
  graph = constructed;
  const specialized: TaggedScheduler = constructed.scheduler;
  const skill: "skill" | undefined = specialized.getResources().skills?.[0]?.tag;
  const template: "template" | undefined = (await fixed).getResources().promptTemplates?.[0]?.tag;
  const tools: ScheduleTool[] = specialized.getTools();
  const iterator: AsyncGenerator<AgenticStep, void, void> = specialized;
  const settlement: Promise<AssistantMessage> = specialized.prompt("typed");
  const bounds: readonly [WidthType, WidthType, DataflowTracer | undefined] = [
    constructed.window,
    constructed.threads,
    constructed.tracer,
  ];
  return [skill, template, tools, iterator, settlement, bounds];
}

export function everyKindSharesOneNodeOptions(
  graph: JuncoGraph<AgenticInput, AssistantMessage, unknown, TaggedScheduler>,
  junco: JuncoAgent,
  mock: MockAgent,
  child: JuncoGraph,
  result: NodeIdType,
  message: AssistantMessage,
) {
  const options: NodeOptions<AgenticInput, AssistantMessage> = { trigger: always() };
  const coroutine = new Deterministic<AgenticInput, AssistantMessage>(async function* (signal) {
    const view = yield [];
    signal.throwIfAborted();
    return [...view.values.keys()].length === 0 ? message : message;
  });
  const agentBinding: AgentNodeBinding = {
    prompt: "go",
    receive: (view) => [...view.messages.keys()].flatMap((edge) => view.messages.get(edge) ?? []),
  };
  const graphBinding: GraphNodeBinding = { result, receive: () => undefined, afterStep: async () => undefined };
  const raw: NodeSpec<Agentic, AgenticInput, AssistantMessage> = {
    ...options,
    state: mock,
    step: async function* () {
      return message;
    },
  };
  const nodes: AgenticNode[] = [
    agentNode(junco, options),
    agentNode(mock, options, agentBinding),
    deterministicNode(coroutine, options),
    graphNode(child, options, graphBinding),
    raw,
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  const concrete: TaggedScheduler = graph.scheduler;
  return [ids, concrete];
}

export function bindingsStayOutOfNodeOptions(mock: MockAgent, child: JuncoGraph, result: NodeIdType) {
  // @ts-expect-error a prompt is execution, not a registration option
  const prompted: NodeOptions<AgenticInput, AssistantMessage> = { trigger: always(), prompt: "go" };
  // @ts-expect-error a graph result selection is execution, not a registration option
  const selected: NodeOptions<AgenticInput, AssistantMessage> = { trigger: always(), result };
  // @ts-expect-error input adaptation is execution, not a registration option
  const received: NodeOptions<AgenticInput, AssistantMessage> = { trigger: always(), receive: () => [] };
  // @ts-expect-error agentNode takes its prompt in the binding
  const agent = agentNode(mock, { trigger: always(), prompt: "go" });
  // @ts-expect-error graphNode takes its result in the binding
  const nested = graphNode(child, { trigger: always(), result }, { result });
  // @ts-expect-error graphNode requires its result-selecting binding
  const unbound = graphNode(child, { trigger: always() });
  // @ts-expect-error a trigger is required
  const untriggered: NodeOptions<AgenticInput, AssistantMessage> = { description: "no trigger" };
  return [prompted, selected, received, agent, nested, unbound, untriggered];
}

export function wireTypesAndSchedulerArePreserved(
  graph: JuncoGraph<number, string, unknown, PiScheduler<number, string>>,
  mock: MockAgent,
  tracer: DataflowTracer,
) {
  const options: NodeOptions<number, string> = { trigger: always() };
  const fibonacci = new Deterministic<number, string>(async function* (signal) {
    let view = yield [];
    signal.throwIfAborted();
    const counts: number[] = [...view.messages.keys()].map((edge) => view.messages.get(edge)?.length ?? 0);
    view = yield [];
    return `${counts.length}:${[...view.values.keys()].length}`;
  });
  const child = new JuncoGraph<number, string>(createParallelScheduler<number, string>(), Width(1), UNBOUNDED, tracer);
  const childId = child.addNode(deterministicNode(fibonacci, options));
  const raw: NodeSpec<Agentic<number, string>, number, string> = {
    ...options,
    state: mock,
    step: async function* () {
      return "raw";
    },
  };
  const nodes: AgenticNode<number, string>[] = [
    graphNode(child, options, { result: childId, receive: (view) => void view.messages }),
    raw,
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  graph.emit(ids[0]!, msg(messageEdge<number, string>("typed-output"), 1));
  const chat: Message<string> = msg(messageEdge<string, string>("chat-output"), "hi");
  // @ts-expect-error a chat message cannot be emitted on a numeric graph
  graph.emit(ids[0]!, chat);
  const concrete: PiScheduler<number, string> = graph.scheduler;
  const selected: O.Option<string> = child.result(childId);
  const results: Promise<ReadonlyMap<NodeIdType, string>>[] = [graph.run(), graph.step({ signal: graph.signal })];
  const compaction: Promise<void> = compactGraph(graph, "more-than-forty-available");
  // @ts-expect-error compaction requires a policy
  void compactGraph(graph);
  // @ts-expect-error a policy outside CompactionPolicy is rejected
  void compactGraph(graph, "most");
  // @ts-expect-error a chat-typed node cannot join a numeric graph
  graph.addNode(agentNode(mock, { trigger: always() }));
  return [ids, concrete, selected, results, compaction];
}

export function juncoGraphIsTheRuntimeGraphState(
  junco: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
  mock: MockAgent,
  coroutine: Deterministic,
  graph: JuncoGraph,
  bare: DataflowGraph<Agentic, AgenticInput, AssistantMessage, unknown>,
  protocol: JuncoAgentProtocol,
  tracer: DataflowTracer,
) {
  const constructed = new JuncoGraph(createParallelScheduler<AgenticInput, AssistantMessage>(), Width(1), UNBOUNDED, tracer);
  const states: Agentic[] = [junco, mock, coroutine, graph, constructed];
  const native: DataflowGraph<Agentic, AgenticInput, AssistantMessage, unknown, DataflowScheduler<AgenticInput, AssistantMessage>> =
    constructed;
  // @ts-expect-error a bare native graph has no lifecycle, so it is not a node state
  const bareState: Agentic = bare;
  // @ts-expect-error the upstream protocol alone is not one of the four node kinds
  const protocolState: Agentic = protocol;
  // @ts-expect-error an arbitrary object is not a node state
  const randomState: Agentic = { step: () => undefined };
  const signal: AbortSignal = graph.signal;
  const lifecycle: Promise<void>[] = [graph.abort(), graph.abort(new Error("why")), graph.close(), graph[Symbol.asyncDispose]()];
  const coroutineLifecycle: Promise<void>[] = [coroutine.abort(), coroutine.close(), coroutine[Symbol.asyncDispose]()];
  // @ts-expect-error the internal cascade entrypoints are not public API
  const internal = api.cascadeMembers;
  return [states, native, bareState, protocolState, randomState, signal, lifecycle, coroutineLifecycle, internal];
}

export function maintenanceUsesNarrowedActors(
  graph: JuncoGraph,
  id: NodeIdType,
  junco: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
  scheduler: PiScheduler<AgenticInput, AssistantMessage>,
) {
  const state = graph.getNode(id)!.state;
  // @ts-expect-error graphs and coroutines have no maintenance methods
  void state.context_size();
  const sizes: Promise<number>[] = [junco.context_size(), scheduler.context_size()];
  const compactions: Promise<void>[] = [junco.compact({ customInstructions: "focus" }), scheduler.compact()];
  if (state instanceof JuncoAgent || state instanceof MockAgent) {
    sizes.push(state.context_size());
    compactions.push(state.compact());
  }
  const requests = state instanceof MockAgent ? state.requests : [];
  return [sizes, compactions, requests];
}
