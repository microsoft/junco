// Compile-only: one engine-owned NodeOptions value registers every node kind with execution
// bindings kept apart; JuncoGraph is the runtime graph state preserving its wire types and concrete
// context; specialized skills, prompt templates and tools survive JuncoAgent and agency
// construction. Covered by tsconfig.typecheck.json; never executed.

import type {
  AgentMessage,
  AgentTool,
  NavigationResult,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  DataflowGraph,
  type DataflowTracer,
  Edge,
  EdgeId,
  Message,
  type NodeGenerator,
  NodeId,
  type NodeIdType,
  type NodeOptions,
  type NodeSpec,
  type ParentView,
  Sink,
  Source,
  TriggerRule,
  UNBOUNDED,
  Width,
  type WidthType,
} from "dataflow-engine";
import type * as O from "fp-ts/lib/Option.js";
import {
  type AgenticStep,
  JuncoAgent,
  type Agentic as JuncoAgentProtocol,
} from "junco-agent";
import {
  choose,
  context as nativeContext,
  agent as oracleAgent,
  parallel,
  roundRobin,
  type Scheduler,
  type SchedulerContext,
  select,
  separate,
} from "junco-scheduler";
import { type PiOptions, pi } from "junco-scheduler/agent";
import {
  beginOperation,
  captureRecorder,
  EmptyPolicy,
  type Issue,
  LockPolicy,
  type Policy,
  type ProfileActivation,
  type ProfileRecorder,
  SendTool,
  ShellMuxLease,
  ShellMuxOperations,
  ToolCollection,
} from "junco-tools";
import type { Graph } from "ngraph.graph";
import { type Static, type TSchema, Type } from "typebox";
import {
  type Agentic,
  type AgenticInput,
  type AgenticInputSchema,
  type AgenticNode,
  type AssistantMessageSchema,
  type CompactionPolicy,
  Deterministic,
  graph as graphApi,
  JuncoGraph,
  MockAgent,
  type MockCall,
  type MockFrame,
  type MockHook,
  type MockHookResult,
  type MockMaintenance,
  type MockRequest,
  type MockRun,
  type MockTerminal,
  type MockTranscript,
  schedules,
  tracer,
} from "../src/index.ts";
import type { NodePolicy, NodeRegistration } from "../src/node-policy.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };
type TaggedTranscript = MockTranscript<TaggedSkill, TaggedTemplate, TaggedTool>;
const NumberSchema = Type.Number();
const StringSchema = Type.String();
type Num = typeof NumberSchema;
type Str = typeof StringSchema;
type Chat = typeof AgenticInputSchema;
/** Exact type equality: `any`, `unknown` and `never` cannot pass by mere assignability. */
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
const exact = <A, B>(_proof: Equal<A, B>): void => undefined;
type NestedContext<
  N extends TSchema = Chat,
  T = AssistantMessage,
> = SchedulerContext<Agentic<N, T>, N, T, never, JuncoGraph<N, T>>;

export function protocolComplainTakesCompleteIssues(
  protocol: JuncoAgentProtocol<TaggedSkill, TaggedTemplate, TaggedTool>,
  nodeId: NodeIdType,
  messages: readonly Message<Num>[],
) {
  const issue: Issue<Num> = {
    nodeId,
    messages,
    prompt: { systemPrompt: "s", messages: [] },
    complaint: "blocked",
  };
  const recorded = protocol.complain(issue);
  exact<typeof recorded, void>(true);
  // @ts-expect-error a complaint string alone is not an issue
  protocol.complain("blocked");
  // @ts-expect-error an issue carries its node, messages and prompt
  protocol.complain({ nodeId, complaint: "blocked" });
  return recorded;
}

export function juncoAgentKeepsSpecializations(
  agent: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
) {
  const runtimeTools: AgentTool[] = agent.getTools();
  const activeTools: AgentTool[] = agent.getActiveTools();
  const skill: "skill" | undefined = agent.getResources().skills?.[0]?.tag;
  const template: "template" | undefined =
    agent.getResources().promptTemplates?.[0]?.tag;
  return [runtimeTools, activeTools, skill, template];
}

export function agentFactoriesUseCollection(
  native: Omit<Parameters<typeof JuncoAgent.fromResolved>[0], "collection">,
  collection: ToolCollection,
  agent: JuncoAgent,
) {
  const free = JuncoAgent.fromResolved(native);
  const borrowed = JuncoAgent.fromResolved({ ...native, collection });
  const created = JuncoAgent.create({ provider: "p", model: "m", tools: [] });
  void JuncoAgent.fromResolved({
    ...native,
    // @ts-expect-error authorization comes only from the collection
    policy: LockPolicy,
  });
  void JuncoAgent.create({
    provider: "p",
    model: "m",
    // @ts-expect-error authorization comes only from the collection
    policy: LockPolicy,
  });
  // @ts-expect-error an agent has no policy of its own
  void agent.policy;
  const policy: Policy | undefined = agent.collection?.policy;
  return [free, borrowed, created, policy];
}

export async function factoriesKeepSpecializations(
  options: PiOptions,
  source: Source<Chat, AssistantMessage>,
  sink: Sink<Chat, AssistantMessage>,
  tracer: DataflowTracer,
  collection: ToolCollection,
) {
  const graph = new JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
    collection,
  );
  const execution = schedules.context({ scheduler: pi(options), graph });
  const retained: JuncoGraph = execution.graph;
  const bounds: readonly [WidthType, WidthType, DataflowTracer] = [
    graph.window,
    graph.threads,
    graph.tracer,
  ];
  // @ts-expect-error source and sink are mandatory positional ports
  void new JuncoGraph(Width.create(1), UNBOUNDED, tracer, LockPolicy);
  void new JuncoGraph(
    // @ts-expect-error ports cannot be reversed
    sink,
    source,
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
  );
  // @ts-expect-error a direct graph requires its policy
  void new JuncoGraph(source, sink, Width.create(1), UNBOUNDED, tracer);
  void new JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    // @ts-expect-error a policy is an object, not its name
    "gitpolicy",
  );
  // @ts-expect-error a coroutine requires a policy
  void new Deterministic(async function* () {});
  const created: Promise<
    SchedulerContext<
      Agentic,
      Chat,
      AssistantMessage,
      schedules.AgencyNodeMetadata,
      JuncoGraph
    >
  > = JuncoGraph.create(
    ".",
    { policy: EmptyPolicy, sandbox: "always" },
    (shared) =>
      schedules.context({
        scheduler: parallel(),
        graph: new JuncoGraph(
          source,
          sink,
          Width.create(1),
          UNBOUNDED,
          undefined,
          shared.policy,
          shared,
        ),
      }),
  );
  const custom = JuncoGraph.create<
    Chat,
    AssistantMessage,
    never,
    { priority: number }
  >(".", {}, (shared) =>
    nativeContext({
      graph: new JuncoGraph(
        source,
        sink,
        Width.create(1),
        UNBOUNDED,
        tracer,
        shared.policy,
        shared,
      ),
      scheduler: parallel(),
      describeNode: () => ({ priority: 7 }),
    }),
  );
  const exactCustom: SchedulerContext<
    Agentic,
    Chat,
    AssistantMessage,
    { priority: number },
    JuncoGraph
  > = await custom;
  // @ts-expect-error collection builders return contexts, not bare graphs
  void JuncoGraph.create(".", {}, () => graph);
  const injected = new Deterministic<Chat, string>(
    async function* (signal, borrowed) {
      signal.throwIfAborted();
      yield [];
      return borrowed === undefined ? "pure" : "borrowed";
    },
    LockPolicy,
    collection,
  );
  return [execution, retained, bounds, created, exactCustom, injected];
}

export function everyKindSharesOneNodeOptions(
  graph: JuncoGraph<Chat, AssistantMessage, unknown>,
  junco: JuncoAgent,
  mock: MockAgent,
  child: NestedContext,
  result: NodeIdType,
  message: AssistantMessage,
) {
  const options: NodeOptions<Chat, AssistantMessage> = {
    trigger: TriggerRule.always(),
  };
  const policy = { policy: LockPolicy } as const;
  const coroutine = new Deterministic<Chat, AssistantMessage>(async function* (
    signal,
  ) {
    const view = yield [];
    signal.throwIfAborted();
    return [...view.values.keys()].length === 0 ? message : message;
  }, LockPolicy);
  mock.stagePrompt("go");
  const nestedNode = {
    ...options,
    state: child,
  } satisfies AgenticNode;
  const raw: AgenticNode = {
    ...options,
    ...policy,
    state: mock,
    step: async function* () {
      return message;
    },
  };
  const nodes: AgenticNode[] = [
    { ...options, ...policy, state: junco },
    { ...options, ...policy, state: mock },
    { ...options, state: coroutine },
    nestedNode,
    raw,
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  // @ts-expect-error every node spec carries its policy
  void graph.addNode({ trigger: TriggerRule.always(), state: mock });
  // @ts-expect-error raw node specs carry their policy too
  void graph.addNode({
    trigger: TriggerRule.always(),
    state: mock,
    step: raw.step,
  });
  // @ts-expect-error a prompt lives on the agent, not the registration
  void graph.addNode({ ...options, ...policy, state: mock, prompt: "go" });
  void graph.addNode({ ...options, state: coroutine });
  // @ts-expect-error a step-less coroutine's policy is owned by its state
  void graph.addNode({ ...options, state: coroutine, policy: LockPolicy });
  // @ts-expect-error a step-less nested graph's policy is owned by its state
  void graph.addNode({ ...options, state: child, policy: LockPolicy });
  // Compiles (no exactOptionalPropertyTypes); rejected at runtime as an own field.
  void graph.addNode({ ...options, state: coroutine, policy: undefined });
  // @ts-expect-error an agent node without a step carries its policy
  void graph.addNode({ ...options, state: junco });
  // @ts-expect-error an explicit-step managed node carries its policy
  void graph.addNode({ ...options, state: coroutine, step: raw.step });
  // @ts-expect-error a managed node still requires a trigger
  void graph.addNode({ state: coroutine });
  // @ts-expect-error a nested node still requires a trigger
  void graph.addNode({ state: child });
  // @ts-expect-error a bare graph has no execution capability
  void graph.addNode({ ...options, state: child.graph });
  // @ts-expect-error nested output is exclusively the sink result
  void graph.addNode({ ...options, state: child, result });
  // @ts-expect-error nested input is exclusively the source port
  void graph.addNode({ ...options, state: child, receive: () => undefined });
  // @ts-expect-error nested completion has no side-effect hook
  void graph.addNode({ ...options, state: child, afterStep: () => undefined });
  // @ts-expect-error only a nested graph node carries execution fields
  void graph.addNode({ ...options, state: coroutine, result });
  // @ts-expect-error only a nested graph node carries execution fields
  void graph.addNode({ ...options, state: mock, receive: () => undefined });
  return [ids];
}

export async function promptsLiveOnAgents(
  native: Omit<Parameters<typeof JuncoAgent.fromResolved>[0], "prompt">,
  junco: JuncoAgent,
  mock: MockAgent,
  transcript: TaggedTranscript,
  view: ParentView<Chat, AssistantMessage>,
  image: ImageContent,
) {
  const id = EdgeId.create("in");
  const built = await JuncoAgent.fromResolved({
    ...native,
    prompt: (inputs) => {
      const messages: readonly AgenticInput[] | undefined =
        inputs.messages.get(id);
      const value: AssistantMessage | undefined = inputs.values.get(id);
      return `${messages?.length}:${value?.role}`;
    },
  });
  const scripted: TaggedTranscript = {
    ...transcript,
    prompt: (inputs) => `${inputs.values.get(id)?.role}`,
  };
  const staged = [
    junco.stagePrompt("go"),
    junco.stagePrompt((inputs) => `${inputs.messages.get(id)?.length}`, {
      images: [image],
    }),
    mock.stagePrompt("go"),
    mock.stagePrompt((inputs) => `${inputs.values.get(id)?.role}`),
  ];
  exact<(typeof staged)[number], void>(true);
  // @ts-expect-error a prompt callback is synchronous
  junco.stagePrompt(async () => "late");
  void (await JuncoAgent.fromResolved({
    ...native,
    // @ts-expect-error a constructor prompt callback is synchronous
    prompt: async () => "late",
  }));
  const steps: Promise<IteratorResult<AgenticStep, void>>[] = [
    built.next(view),
    built.next(),
    mock.next(view),
    mock.next(),
  ];
  return [scripted, staged, steps];
}

export function bindingsStayOutOfNodeOptions(
  mock: MockAgent,
  child: NestedContext,
  result: NodeIdType,
  graph: JuncoGraph,
) {
  const prompted: NodeOptions<Chat, AssistantMessage> = {
    trigger: TriggerRule.always(),
    // @ts-expect-error a prompt is execution, not a registration option
    prompt: "go",
  };
  const selected: NodeOptions<Chat, AssistantMessage> = {
    trigger: TriggerRule.always(),
    // @ts-expect-error a graph result selection is execution, not a registration option
    result,
  };
  const received: NodeOptions<Chat, AssistantMessage> = {
    trigger: TriggerRule.always(),
    // @ts-expect-error input adaptation is execution, not a registration option
    receive: () => [],
  };
  const agent = graph.addNode({
    state: mock,
    trigger: TriggerRule.always(),
    policy: LockPolicy,
    // @ts-expect-error a prompt lives on the agent, not the registration
    prompt: "go",
  });
  const nested: AgenticNode = { trigger: TriggerRule.always(), state: child };
  // @ts-expect-error step-less nesting requires a context rather than a bare graph
  const unbound: AgenticNode = {
    trigger: TriggerRule.always(),
    state: child.graph,
  };
  // @ts-expect-error a trigger is required
  const untriggered: NodeOptions<Chat, AssistantMessage> = {
    description: "no trigger",
  };
  return [prompted, selected, received, agent, nested, unbound, untriggered];
}

export function persistenceIsANestedOptIn(
  mock: MockAgent,
  coroutine: Deterministic,
  child: NestedContext,
  graph: JuncoGraph,
) {
  const persistent: AgenticNode = {
    trigger: TriggerRule.always(),
    state: child,
    persistent: true,
  };
  const finite: AgenticNode = {
    trigger: TriggerRule.always(),
    state: child,
    // @ts-expect-error persistence is a literal opt-in; there is no false mode
    persistent: false,
  };
  const agent = graph.addNode({
    state: mock,
    trigger: TriggerRule.always(),
    policy: LockPolicy,
    // @ts-expect-error only a nested graph context can persist
    persistent: true,
  });
  // @ts-expect-error a coroutine is not a nested graph
  const parked: AgenticNode = {
    trigger: TriggerRule.always(),
    state: coroutine,
    persistent: true,
  };
  const stepped: AgenticNode = {
    trigger: TriggerRule.always(),
    state: child.graph,
    policy: LockPolicy,
    step: child.graph.source.step,
    // @ts-expect-error an explicit step is never a persistent nested context
    persistent: true,
  };
  return [persistent, finite, agent, parked, stepped];
}

export function wireTypesAndContextsArePreserved(
  graph: JuncoGraph<Num, string, unknown>,
  mock: MockAgent,
  tracer: DataflowTracer,
) {
  const options: NodeOptions<Num, string> = {
    trigger: TriggerRule.always(),
  };
  const fibonacci = new Deterministic<Num, string>(async function* (signal) {
    let view = yield [];
    signal.throwIfAborted();
    const counts: number[] = [...view.messages.keys()].map(
      (edge) => view.messages.get(edge)?.length ?? 0,
    );
    view = yield [];
    return `${counts.length}:${[...view.values.keys()].length}`;
  }, LockPolicy);
  const ports: { source: Source<Num, string>; sink: Sink<Num, string> } = {
    source: new Source<Num, string>(
      () => {
        throw new DataflowDefinitionError(
          "Typed fixture does not accept external input",
        );
      },
      { id: NodeId.create("$source"), schema: NumberSchema },
    ),
    sink: new Sink<Num, string>(
      async function* (): NodeGenerator<Num, string> {
        yield [];
        const value = child.result(childId);
        if (value._tag === "None") throw new Error("Missing terminal result");
        return value.value;
      },
      {
        id: NodeId.create("$sink"),
        schema: NumberSchema,
        trigger: TriggerRule.when(Edge.value("member->$sink", StringSchema)),
      },
    ),
  };
  const child: JuncoGraph<Num, string> = new JuncoGraph<Num, string>(
    ports.source,
    ports.sink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
  );
  const childId = child.addNode({ ...options, state: fibonacci });
  child.addEdge(
    childId,
    child.sink.id,
    Edge.value("member->$sink", StringSchema),
  );
  const childContext = schedules.context({
    graph: child,
    scheduler: parallel(),
  });
  const raw: AgenticNode<Num, string> = {
    ...options,
    policy: LockPolicy,
    state: mock,
    step: async function* () {
      return "raw";
    },
  };
  const nodes: AgenticNode<Num, string>[] = [
    {
      ...options,
      state: childContext,
    },
    raw,
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  graph.emit(
    ids[0]!,
    Message.create(Edge.message("typed-output", NumberSchema), 1),
  );
  const chat: Message<Str> = Message.create(
    Edge.message("chat-output", StringSchema),
    "hi",
  );
  // @ts-expect-error a chat message cannot be emitted on a numeric graph
  graph.emit(ids[0]!, chat);
  const execution = schedules.context({ graph, scheduler: parallel() });
  const selected: O.Option<string> = child.result(childId);
  const results: Promise<ReadonlyMap<NodeIdType, string>>[] = [
    execution.run(),
    execution.step({ signal: graph.signal }),
  ];
  const compaction: Promise<void> = JuncoGraph.compact(
    graph,
    "more-than-forty-available",
  );
  // @ts-expect-error compaction requires a policy
  void JuncoGraph.compact(graph);
  // @ts-expect-error a policy outside CompactionPolicy is rejected
  void JuncoGraph.compact(graph, "most");
  // @ts-expect-error a chat-typed node cannot join a numeric graph
  graph.addNode({
    state: mock,
    trigger: TriggerRule.always(),
    policy: LockPolicy,
  });
  graph.addNode({
    state: mock,
    policy: LockPolicy,
    trigger: TriggerRule.always(),
    step: async function* () {
      return "custom";
    },
  });
  return [ids, execution, selected, results, compaction];
}

export function juncoGraphIsTheRuntimeGraphState(
  junco: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
  mock: MockAgent,
  coroutine: Deterministic,
  graph: JuncoGraph,
  bare: DataflowGraph<Agentic, Chat, AssistantMessage, unknown>,
  protocol: JuncoAgentProtocol,
  tracer: DataflowTracer,
  source: Source<Chat, AssistantMessage>,
  sink: Sink<Chat, AssistantMessage>,
) {
  const constructed = new JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    EmptyPolicy,
  );
  const states: Agentic[] = [
    junco,
    mock,
    coroutine,
    graph,
    constructed,
    source,
    sink,
  ];
  const native: DataflowGraph<Agentic, Chat, AssistantMessage, unknown> =
    constructed;
  // @ts-expect-error a bare native graph has no lifecycle, so it is not a node state
  const bareState: Agentic = bare;
  // @ts-expect-error the upstream protocol alone is not one of the four node kinds
  const protocolState: Agentic = protocol;
  // @ts-expect-error an arbitrary object is not a node state
  const randomState: Agentic = { step: () => undefined };
  const signal: AbortSignal = graph.signal;
  const lifecycle: Promise<void>[] = [
    graph.abort(),
    graph.abort(new Error("why")),
    graph.close(),
    graph[Symbol.asyncDispose](),
  ];
  const coroutineLifecycle: Promise<void>[] = [
    coroutine.abort(),
    coroutine.close(),
    coroutine[Symbol.asyncDispose](),
  ];
  return [
    states,
    native,
    bareState,
    protocolState,
    randomState,
    signal,
    lifecycle,
    coroutineLifecycle,
  ];
}

export function maintenanceUsesNarrowedActors(
  graph: JuncoGraph,
  id: NodeIdType,
  junco: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
) {
  const state = graph.getNode(id)!.state;
  // @ts-expect-error graphs and coroutines have no maintenance methods
  void state.context_size();
  const sizes: Promise<number>[] = [junco.context_size()];
  const compactions: Promise<void>[] = [
    junco.compact({ customInstructions: "focus" }),
  ];
  if (state instanceof JuncoAgent || state instanceof MockAgent) {
    sizes.push(state.context_size());
    compactions.push(state.compact());
  }
  const requests = state instanceof MockAgent ? state.requests : [];
  return [sizes, compactions, requests];
}

export function everyAgenticInputKindIsTyped(
  message: AgentMessage,
  image: ImageContent,
) {
  const inputs: AgenticInput[] = [
    { kind: "prompt", text: "start", images: [image] },
    { kind: "steer", text: "steer" },
    { kind: "followUp", text: "follow", images: [image] },
    { kind: "nextTurn", text: "next" },
    { kind: "error", text: "failed", images: [image] },
    { kind: "appendMessage", message },
  ];
  const described: string[] = inputs.map((input) =>
    input.kind === "appendMessage"
      ? input.message.role
      : `${input.kind}:${input.text}:${input.images?.length ?? 0}`,
  );
  // @ts-expect-error a text input requires its text
  const untexted: AgenticInput = { kind: "prompt", images: [image] };
  // @ts-expect-error an input kind outside the declared commands is rejected
  const unknown: AgenticInput = { kind: "interrupt", text: "stop" };
  // @ts-expect-error appendMessage carries a message, not text
  const malformed: AgenticInput = { kind: "appendMessage", text: "hello" };
  return [described, untexted, unknown, malformed];
}

function policyFraction(policy: CompactionPolicy): number {
  switch (policy) {
    case "all":
    case "all-available":
      return 0;
    case "more-than-forty":
    case "more-than-forty-available":
      return 0.4;
    default: {
      const exhausted: never = policy;
      return exhausted;
    }
  }
}

export async function compactionPoliciesThroughBothRoutes(graph: JuncoGraph) {
  const flat: CompactionPolicy[] = ["all", "more-than-forty"];
  const routed: graphApi.nodes.CompactionPolicy[] = [
    "all-available",
    "more-than-forty-available",
  ];
  for (const policy of flat) await JuncoGraph.compact(graph, policy);
  for (const policy of routed) await JuncoGraph.compact(graph, policy);
  const fractions: number[] = [...flat, ...routed].map(policyFraction);
  // @ts-expect-error the namespaced policy type rejects an unknown policy
  const unknown: graphApi.nodes.CompactionPolicy = "half";
  return [fractions, unknown];
}

export async function mockTranscriptTypesKeepSpecializations(
  skill: TaggedSkill,
  template: TaggedTemplate,
  tool: TaggedTool,
  plainSkill: Skill,
  plainTool: AgentTool,
  message: AssistantMessage,
  prompt: AgentMessage[],
  navigation: NavigationResult,
  image: ImageContent,
) {
  const settled: MockTerminal = { kind: "settled", message };
  const failed: MockTerminal = { kind: "failed", error: new Error("scripted") };
  // @ts-expect-error a yield is not a terminal
  const yieldTerminal: MockTerminal = { kind: "yield", reasons: [] };

  const beforeRun: MockHook = {
    name: "before_run",
    event: { prompt, resources: {}, lane: "main", runId: "run-1" },
    results: [{ messages: prompt }, undefined],
  };
  const beforeTool: MockHook = {
    name: "before_tool",
    event: {
      toolCallId: "call-1",
      toolName: tool.name,
      args: {},
      lane: "main",
      runId: "run-1",
    },
    results: [{ block: { reason: "denied" } }],
  };
  const mismatchedEvent: MockHook = {
    name: "before_drive",
    // @ts-expect-error a hook's event must belong to its name
    event: { prompt, resources: {}, lane: "main", runId: "run-1" },
    results: [],
  };
  const mismatchedResult: MockHook = {
    name: "before_tool",
    event: beforeTool.event,
    // @ts-expect-error a hook's results must belong to its name
    results: [{ messages: prompt }],
  };
  const blocked: (string | undefined)[] = [beforeRun, beforeTool].map((hook) =>
    hook.name === "before_tool"
      ? (hook.results[0]?.block?.reason ?? hook.event.toolName)
      : undefined,
  );

  const yieldFrame: MockFrame = {
    step: {
      kind: "yield",
      reasons: [
        {
          kind: "tool",
          toolCallId: "call-1",
          toolName: "yield",
          reason: "pause",
        },
      ],
    },
    drain: ["steer", "followUp"],
    hooks: [beforeRun, beforeTool],
    messages: prompt,
    events: [],
  };
  const terminalFrame: MockFrame<MockTerminal> = { step: settled };
  const yieldingTerminal: MockFrame<MockTerminal> = {
    // @ts-expect-error a terminal frame cannot pause at a yield
    step: { kind: "yield", reasons: [] },
  };
  const run: MockRun = {
    frames: [yieldFrame, terminalFrame],
    interrupted: { step: failed, messages: [] },
  };
  const yieldingInterrupt: MockRun = {
    frames: [terminalFrame],
    // @ts-expect-error an interrupted run ends at a terminal, never a yield
    interrupted: { step: { kind: "yield", reasons: [] } },
  };
  const drainingInterrupt: MockRun = {
    frames: [terminalFrame],
    // @ts-expect-error an interruption drains no queues
    interrupted: { step: failed, drain: ["steer"] },
  };

  const compactOutcome: MockMaintenance = {
    method: "compact",
    args: [{ customInstructions: "focus" }],
    result: { ok: false, error: new Error("busy") },
    tipId: null,
  };
  const navigateOutcome: MockMaintenance = {
    method: "navigateTree",
    args: ["entry-1", { summarize: true }],
    result: navigation,
    history: prompt,
  };
  // @ts-expect-error navigation needs its target
  const untargeted: MockMaintenance = {
    method: "navigateTree",
    args: [],
    result: navigation,
  };
  const outcomes: boolean[] = [compactOutcome, navigateOutcome].map((entry) =>
    entry.method === "compact"
      ? entry.result.ok
      : entry.result.ok && entry.result.value.navigation !== undefined,
  );

  const transcript: MockTranscript<TaggedSkill, TaggedTemplate, TaggedTool> = {
    prompt: "start",
    images: [image],
    history: prompt,
    tools: [tool],
    activeToolNames: [tool.name],
    resources: { skills: [skill], promptTemplates: [template] },
    thinkingLevel: "high",
    streamOptions: { timeoutMs: 1000 },
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    runs: [run],
    maintenance: [compactOutcome, navigateOutcome],
  };
  const untaggedTool: TaggedTranscript = {
    // @ts-expect-error a specialized transcript rejects an untagged tool
    tools: [plainTool],
    runs: [],
  };
  const untaggedSkill: TaggedTranscript = {
    // @ts-expect-error a specialized transcript rejects an untagged skill
    resources: { skills: [plainSkill] },
    runs: [],
  };

  const mock = new MockAgent(transcript);
  const requests: readonly MockRequest<TaggedTool>[] = mock.requests;
  const requestTags: ("tool" | undefined)[] = requests.map(
    (request) => request.tools[0]?.tag,
  );
  const requestTimeouts: (number | undefined)[] = requests.map(
    (request) => request.streamOptions.timeoutMs,
  );
  const skillTag: "skill" | undefined = mock.getResources().skills?.[0]?.tag;
  const templateTag: "template" | undefined =
    mock.getResources().promptTemplates?.[0]?.tag;
  const toolTag: "tool" | undefined = mock.getActiveTools()[0]?.tag;
  const calls: readonly MockCall[] = mock.calls;
  const methods: string[] = calls.map(
    (call) => `${call.method}/${call.args.length}`,
  );
  const hookResults: readonly MockHookResult[] = mock.hookResults;
  const hookNames: string[] = hookResults.map(
    (result) => `${result.name}/${result.results.length}`,
  );
  // @ts-expect-error a specialized mock only accepts its own tool type
  void mock.setTools([plainTool]);
  const kinds: string[] = [];
  for await (const step of mock)
    kinds.push(
      step.kind === "yield" ? (step.reasons[0]?.reason ?? "") : step.kind,
    );
  return [
    yieldTerminal,
    mismatchedEvent,
    mismatchedResult,
    blocked,
    yieldingTerminal,
    yieldingInterrupt,
    drainingInterrupt,
    untargeted,
    outcomes,
    untaggedTool,
    untaggedSkill,
    requestTags,
    requestTimeouts,
    skillTag,
    templateTag,
    toolTag,
    methods,
    hookNames,
    kinds,
  ];
}

export function namespacedNodeBindingsKeepWireTypes(
  mock: MockAgent,
  child: NestedContext<Num, string>,
  source: Source<Num, string>,
  sink: Sink<Num, string>,
  tracer: DataflowTracer,
) {
  const options: NodeOptions<Num, string> = {
    trigger: graphApi.trigger.TriggerRule.always(),
  };
  const graph = new graphApi.JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
  );
  const coroutine = new graphApi.nodes.Deterministic<Num, string>(
    async function* () {
      const view = yield [];
      return `${[...view.messages.keys()].length}`;
    },
    LockPolicy,
  );
  const nodes: graphApi.nodes.AgenticNode<Num, string>[] = [
    { ...options, state: child },
    { ...options, state: coroutine },
    source,
    sink,
  ];
  const rejected: graphApi.nodes.AgenticNode<Num, string>[] = [
    // @ts-expect-error a step-less coroutine owns its policy
    { ...options, state: coroutine, policy: LockPolicy },
    // @ts-expect-error a nested context owns its graph's policy
    { ...options, state: child, policy: LockPolicy },
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  const states: graphApi.nodes.Agentic<Num, string>[] = [
    child.graph,
    coroutine,
    source,
    sink,
  ];
  mock.stagePrompt("go");
  // @ts-expect-error chat-typed agents cannot join a numeric graph
  graph.addNode({
    state: mock,
    trigger: graphApi.trigger.TriggerRule.always(),
    policy: LockPolicy,
  });
  // @ts-expect-error a bare graph is not a nested execution context
  const unbound: graphApi.nodes.AgenticNode<Num, string> = {
    ...options,
    state: child.graph,
  };
  return [ids, states, unbound, rejected];
}

export function typedContextsPreserveNativeAndCallerData(id: NodeIdType) {
  type State = Readonly<{ group: "a" | "b" }>;
  class SpecializedGraph extends DataflowGraph<State, Num, string, Error> {
    subtypeOnly(): "specialized" {
      return "specialized";
    }
  }
  const graph = new SpecializedGraph(Width.create(1), UNBOUNDED);
  const ranked: Scheduler<State, Num, string, { priority: number }> = choose({
    rank: (snapshot, left, right) => {
      const state: State | undefined = snapshot.nodes.get(left)?.state;
      const inputs: readonly number[] | undefined = snapshot.inputs
        .get(left)
        ?.messages.get(EdgeId.create("input"));
      const result: string | undefined = snapshot.results.get(left);
      const priority: number | undefined = snapshot.context.get(left)?.priority;
      // @ts-expect-error native state is exact, not an erased object
      const wrongState: string | undefined = state;
      // @ts-expect-error native input payloads are numbers
      const wrongInput: readonly string[] | undefined = inputs;
      // @ts-expect-error native retained results are strings
      const wrongResult: number | undefined = result;
      // @ts-expect-error caller metadata retains its declared fields
      snapshot.context.get(left)?.label;
      // @ts-expect-error native node maps are read-only
      snapshot.nodes.set(left, snapshot.nodes.get(left)!);
      // @ts-expect-error input queues are read-only
      inputs?.push(1);
      // @ts-expect-error retained result maps are read-only
      snapshot.results.set(left, "changed");
      // @ts-expect-error metadata maps are read-only
      snapshot.context.set(left, { priority: 0 });
      void [wrongState, wrongInput, wrongResult];
      return (priority ?? 0) - (snapshot.context.get(right)?.priority ?? 0);
    },
  });
  const execution = nativeContext({
    graph,
    scheduler: ranked,
    describeNode: () => ({ priority: 7 }),
  });
  const exact: SchedulerContext<
    State,
    Num,
    string,
    { priority: number },
    SpecializedGraph
  > = execution;
  const concrete: "specialized" = execution.graph.subtypeOnly();
  const absent = nativeContext({
    graph,
    scheduler: (snapshot) => {
      const metadata: ReadonlyMap<NodeIdType, never> = snapshot.context;
      void metadata;
      return { selected: [] };
    },
  });
  const defaultMetadata: SchedulerContext<
    State,
    Num,
    string,
    never,
    SpecializedGraph
  > = absent;
  const zero: SchedulerContext<State, Num, string, number, SpecializedGraph> =
    nativeContext({ graph, scheduler: parallel(), describeNode: () => 0 });
  const falsy: SchedulerContext<State, Num, string, boolean, SpecializedGraph> =
    nativeContext({
      graph,
      scheduler: parallel(),
      describeNode: () => false,
    });
  const nullable: SchedulerContext<State, Num, string, null, SpecializedGraph> =
    nativeContext({ graph, scheduler: parallel(), describeNode: () => null });
  const explicitlyEmpty = nativeContext<
    State,
    Num,
    string,
    { priority: number },
    SpecializedGraph
  >({ graph, scheduler: ranked });
  const wrongMetadata: Scheduler<
    State,
    Num,
    string,
    { label: string }
  > = () => ({ selected: [] });
  nativeContext({
    graph,
    // @ts-expect-error a policy cannot widen the hook's metadata domain
    scheduler: wrongMetadata,
    describeNode: () => ({ priority: 7 }),
  });
  const wrongData: Scheduler<
    State,
    Str,
    number,
    { priority: number }
  > = () => ({ selected: [] });
  nativeContext({
    graph,
    // @ts-expect-error a policy cannot widen native message/result domains
    scheduler: wrongData,
    describeNode: () => ({ priority: 7 }),
  });
  const all = parallel();
  const rotation = roundRobin();
  const other = new DataflowGraph<boolean, Str, number, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const reuse = [
    nativeContext({ graph, scheduler: all, describeNode: () => 0 }),
    nativeContext({
      graph: other,
      scheduler: all,
      describeNode: () => "metadata",
    }),
    nativeContext({ graph, scheduler: rotation, describeNode: () => false }),
    nativeContext({
      graph: other,
      scheduler: rotation,
      describeNode: () => null,
    }),
  ];
  const composed: Scheduler<State, Num, string, { priority: number }> =
    separate(
      (snapshot, node) => snapshot.nodes.get(node)?.state.group === "a",
      ranked,
      oracleAgent(async (snapshot, signal) => {
        signal?.throwIfAborted();
        return [
          [...snapshot.owned].filter((node) => snapshot.available.has(node)),
        ];
      }),
    );
  const ordinary: Scheduler<State, Num, string, { priority: number }> = async (
    snapshot,
  ) => ({ selected: select(snapshot, [id]) });
  const unbranded: Scheduler<
    State,
    Num,
    string,
    { priority: number }
  > = () => ({
    // @ts-expect-error selections use branded native IDs
    selected: [{ nodeId: "raw", modelStrength: 2, readEdges: [] }],
  });
  // @ts-expect-error policy association is external
  graph.scheduler;
  // @ts-expect-error passive native graphs do not drive policies
  graph.run();
  // @ts-expect-error passive native graphs do not drive policies
  graph.step();
  return [
    exact,
    concrete,
    defaultMetadata,
    zero,
    falsy,
    nullable,
    explicitlyEmpty,
    reuse,
    composed,
    ordinary,
    unbranded,
  ];
}

export function typedPortsAndNestedContexts(
  source: Source<Num, string>,
  sink: Sink<Num, string>,
  wrongSink: Sink<Str, string>,
  wrongResult: Sink<Num, number>,
  tracer: DataflowTracer,
) {
  const graph = new JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
  );
  const sourceSpec: NodeSpec<Agentic<Num, string>, Num, string> = source;
  const sinkSpec: NodeSpec<Agentic<Num, string>, Num, string> = sink;
  const sourceState: Source<Num, string> = source.state;
  const sinkState: Sink<Num, string> = sink.state;
  const view: ParentView<Num, string> | undefined = source.peek();
  const result: O.Option<string> = graph.result(sink.id);
  const owner = nativeContext({
    graph,
    scheduler: parallel(),
    describeNode: () => ({ priority: 7 }),
  });
  const nested: NestedContext<Num, string> = owner;
  const exactOwner: SchedulerContext<
    Agentic<Num, string>,
    Num,
    string,
    { priority: number },
    JuncoGraph<Num, string>
  > = owner;
  const nativeState: Agentic<Num, string> = owner.graph;
  const advance: Promise<ReadonlyMap<NodeIdType, string>> = owner.step();
  // @ts-expect-error contexts are execution capabilities, not native node state
  const contextState: Agentic<Num, string> = owner;
  // @ts-expect-error a passive graph is not an execution capability
  const bare: NestedContext<Num, string> = graph;
  const metadataFree: Scheduler<
    Agentic<Num, string>,
    Num,
    string,
    never
  > = () => ({ selected: [] });
  // @ts-expect-error the reverse assignment cannot promise rich metadata
  const metadataRich: Scheduler<
    Agentic<Num, string>,
    Num,
    string,
    { priority: number }
  > = metadataFree;
  // @ts-expect-error result domains remain exact through nested contexts
  const incompatibleResult: NestedContext<Num, number> = owner;
  new JuncoGraph(
    source,
    // @ts-expect-error message types must agree at both ports
    wrongSink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
  );
  new JuncoGraph(
    source,
    // @ts-expect-error result types must agree at both ports
    wrongResult,
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
  );
  // @ts-expect-error source IDs must be branded
  new Source<Num, string>(() => [], { id: "raw", schema: NumberSchema });
  new Sink<Num, string>(
    async function* () {
      return "unused";
    },
    // @ts-expect-error sink IDs are mandatory
    { trigger: TriggerRule.never(), schema: NumberSchema },
  );
  const agency = schedules.context({
    graph,
    scheduler: (snapshot) => {
      const metadata: ReadonlyMap<NodeIdType, schedules.AgencyNodeMetadata> =
        snapshot.context;
      const inputs: ParentView<Num, string> | undefined = snapshot.inputs.get(
        source.id,
      );
      const output: string | undefined = snapshot.results.get(sink.id);
      void [metadata, inputs, output];
      return { selected: [] };
    },
  });
  const concrete: JuncoGraph<Num, string> = agency.graph;
  // @ts-expect-error agency graphs also keep policy association external
  agency.graph.scheduler;
  // @ts-expect-error policy driving lives on the external context
  agency.graph.run();
  // @ts-expect-error policy driving lives on the external context
  agency.graph.step();
  return [
    sourceSpec,
    sinkSpec,
    sourceState,
    sinkState,
    view,
    result,
    nested,
    exactOwner,
    nativeState,
    advance,
    contextState,
    bare,
    metadataRich,
    incompatibleResult,
    concrete,
  ];
}

export function mappingRetainsLinkTypesAndRequiresPorts(
  skeleton: Pick<
    Graph<{ readonly value: number }, { readonly tag: string }>,
    "forEachNode" | "forEachLink" | "getLinks"
  >,
  source: Source<Num, string>,
  sink: Sink<Num, string>,
  wrongSink: Sink<Str, string>,
) {
  const execution = JuncoGraph.map(
    skeleton,
    (state) =>
      new Deterministic<Num, string>(async function* () {
        yield [];
        return String(state.value);
      }, LockPolicy),
    { source, sink, policy: LockPolicy },
  );
  const exact: SchedulerContext<
    Agentic<Num, string>,
    Num,
    string,
    schedules.AgencyNodeMetadata,
    JuncoGraph<Num, string>
  > = execution;
  const link: { readonly tag: string } | undefined = skeleton
    .getLinks("member")
    ?.values()
    .next().value?.data;
  // @ts-expect-error map requires explicit source and sink nodes
  JuncoGraph.map(skeleton, () => source, { policy: LockPolicy });
  JuncoGraph.map(skeleton, () => source, {
    source,
    // @ts-expect-error the sink payload domain cannot widen the mapped source
    sink: wrongSink,
    policy: LockPolicy,
  });
  JuncoGraph.map(
    skeleton,
    () => ({
      // @ts-expect-error a bare graph is not a mapped nested execution capability
      state: execution.graph,
      trigger: TriggerRule.always<Num, string>(),
    }),
    { source, sink, policy: LockPolicy },
  );
  return [exact, link];
}

export function agencyMetadataIsSourceExact(
  metadata: schedules.AgencyNodeMetadata,
) {
  const status: NonNullable<NodePolicy["agent"]>["status"] | undefined =
    metadata.agentStatus;
  const lastYield: NodePolicy["lastYield"] = metadata.lastYield;
  // @ts-expect-error statuses retain the actual agent status domain
  const numericStatus: number | undefined = metadata.agentStatus;
  // @ts-expect-error metadata is readonly
  metadata.lastYield = undefined;
  return [status, lastYield, numericStatus];
}

export async function profileRecordersNarrowByResource(
  jsonl: tracer.JsonlRecorder,
  grafana: tracer.GrafanaRecorder,
  three: ProfileRecorder<"memory" | "tokens" | "edits">,
  activation: ProfileActivation,
  agent: JuncoAgent,
  source: Source<Chat, AssistantMessage>,
  sink: Sink<Chat, AssistantMessage>,
) {
  // Both concrete sinks satisfy the identical full producer union.
  const sinks: ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >[] = [jsonl, grafana, jsonl.add_context("a"), grafana.add_context("a")];
  const full = sinks[0];
  // Narrowing is plain assignment; add_context preserves the narrowed union.
  const memory: ProfileRecorder<"memory"> = three;
  const leaf: ProfileRecorder<"memory"> = memory.add_context("leaf");
  const edits: ProfileRecorder<"edits"> = full.add_context("x");
  const jsonlCost: ProfileRecorder<"cost"> = jsonl;
  const grafanaCost: ProfileRecorder<"cost"> = grafana;
  const capturedCost: ProfileRecorder<"cost"> | undefined =
    captureRecorder(grafanaCost);
  const tokenOnly: ProfileRecorder<"tokens"> = full;
  jsonlCost.record({
    resource: "cost",
    kind: "usage",
    source: agent,
    usage: {} as never,
  });
  jsonlCost.record({
    // @ts-expect-error cost-only cannot record token usage
    resource: "tokens",
    kind: "usage",
    source: agent,
    usage: {} as never,
  });
  tokenOnly.record({
    // @ts-expect-error token-only cannot record cost usage
    resource: "cost",
    kind: "usage",
    source: agent,
    usage: {} as never,
  });
  memory.record({
    // @ts-expect-error memory-only cannot record cost usage
    resource: "cost",
    kind: "usage",
    source: agent,
    usage: {} as never,
  });
  three.record({
    resource: "tokens",
    kind: "usage",
    source: agent,
    usage: {} as never,
  });
  three.record({
    resource: "edits",
    kind: "start",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
    activation,
  });
  three.record({
    resource: "edits",
    kind: "finish",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
    activation,
    outcome: "success",
    durationMs: 1,
  });
  const finish = beginOperation(memory, {
    resource: "memory",
    category: "shell",
    tool: "",
    operation: "exec",
  });
  finish?.("cancelled");
  const captured: ProfileRecorder<"edits"> | undefined = captureRecorder(edits);

  // The same full handle feeds every source dependency, whatever its backend.
  const lease = await ShellMuxLease.create("/tmp", { recorder: memory });
  const operations = new ShellMuxOperations({ recorder: () => leaf });
  const collection = await ToolCollection.create("/tmp", { recorder: full });
  const binding = collection.bind(() => grafana);
  const graph = new JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    new tracer.DummyTracer(),
    LockPolicy,
    collection,
    full,
    "root",
  );
  const graphView: ProfileRecorder<"tokens"> | undefined = graph.recorder;
  const agentView: ProfileRecorder<"edits"> | undefined = agent.recorder;
  // A full recorder narrows to probes, which carry one number per published edge value.
  const probes: ProfileRecorder<"probe"> = full.add_context("p");
  probes.record({ resource: "probe", kind: "probe", edgeId: "A->B", value: 1 });
  probes.record({
    resource: "probe",
    kind: "probe",
    edgeId: "A->B",
    // @ts-expect-error probe values are numbers
    value: "1",
  });
  memory.record({
    // @ts-expect-error memory-only cannot record probes
    resource: "probe",
    kind: "probe",
    edgeId: "A->B",
    value: 1,
  });
  // @ts-expect-error nor widen to include them
  const withProbe: ProfileRecorder<"memory" | "probe"> = memory;

  memory.record({
    // @ts-expect-error memory-only cannot record token usage
    resource: "tokens",
    kind: "usage",
    source: agent,
    usage: {} as never,
  });
  // @ts-expect-error a usage payload is never memory
  memory.record({
    resource: "memory",
    kind: "usage",
    source: agent,
    usage: {} as never,
  });
  memory.record({
    // @ts-expect-error memory-only cannot record edits metrics
    resource: "edits",
    kind: "metrics",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
    counters: {},
  });
  memory.record({
    // @ts-expect-error memory-only cannot record operations events
    resource: "operations",
    kind: "start",
    category: "graph",
    tool: "",
    operation: "evaluate",
  });
  // @ts-expect-error narrowing never widens back
  const wider: ProfileRecorder<"memory" | "tokens"> = memory;
  // @ts-expect-error nor erases to every resource
  const erased: ProfileRecorder<string> = memory;
  // @ts-expect-error add_context keeps the narrow union
  const widerChild: ProfileRecorder<"memory" | "edits"> =
    memory.add_context("c");
  // @ts-expect-error capture never widens a supplied view
  const widerCapture: ProfileRecorder<"memory" | "edits"> | undefined =
    captureRecorder(memory);
  // @ts-expect-error the session identity is not a recorder
  const fromRoot: ProfileRecorder<"memory"> = memory.root;
  beginOperation(memory, {
    // @ts-expect-error an operation cannot widen the recorder's capability
    resource: "edits",
    category: "AstEdit",
    tool: "ast_edit",
    operation: "apply",
  });
  // @ts-expect-error memory-only cannot satisfy a collection's full requirement
  await ToolCollection.create("/tmp", { recorder: memory });
  await JuncoAgent.fromResolved({
    ...({} as Parameters<typeof JuncoAgent.fromResolved>[0]),
    // @ts-expect-error nor an agent's
    recorder: memory,
  });
  return [
    lease,
    operations,
    binding,
    graph,
    graphView,
    agentView,
    captured,
    wider,
    erased,
    widerChild,
    widerCapture,
    fromRoot,
    withProbe,
    jsonlCost,
    grafanaCost,
    capturedCost,
    tokenOnly,
  ];
}

type Native<N extends TSchema, V> = JuncoAgent<
  Skill,
  PromptTemplate,
  AgentTool,
  N,
  V
>;

export async function schemaDomainsStayExact(
  numericAgent: Native<Num, AssistantMessage>,
  numericMock: MockAgent<Skill, PromptTemplate, AgentTool, Num>,
  numeric: JuncoGraph<Num, AssistantMessage>,
  mixedAgent: Native<Num, AssistantMessage | string>,
  mixed: JuncoGraph<Num, AssistantMessage | string>,
  yamlAgent: Native<TSchema, unknown>,
  yaml: JuncoGraph<TSchema, unknown>,
  textAgent: Native<Num, string>,
  textOnly: JuncoGraph<Num, string>,
  numberAgent: Native<Num, number>,
  numberOnly: JuncoGraph<Num, number>,
  config: Parameters<typeof JuncoGraph.fromYaml>[1],
  registration: NodeRegistration<Num, string>,
  signal: AbortSignal,
) {
  const id = EdgeId.create("numbers");
  const policy = { trigger: TriggerRule.always(), policy: LockPolicy };
  // Numeric inboxes stage numeric payloads; parent values keep their own domain.
  numericAgent.stagePrompt((inputs) => {
    const payloads = inputs.messages.get(id);
    exact<typeof payloads, readonly number[] | undefined>(true);
    const parent = inputs.values.get(id);
    exact<typeof parent, AssistantMessage | undefined>(true);
    return `${payloads?.length}`;
  });
  numericMock.stagePrompt((inputs) => {
    const payloads = inputs.messages.get(id);
    exact<typeof payloads, readonly number[] | undefined>(true);
    return `${payloads?.[0]}`;
  });
  // @ts-expect-error a callback over another input domain is rejected
  numericAgent.stagePrompt((_inputs: ParentView<Str, AssistantMessage>) => "");
  // Dynamic YAML inputs stay unknown until narrowed.
  yamlAgent.stagePrompt((inputs) => {
    const payloads = inputs.messages.get(id);
    exact<typeof payloads, readonly unknown[] | undefined>(true);
    const parent = inputs.values.get(id);
    exact<typeof parent, unknown>(true);
    return typeof parent === "number" ? `${parent + 1}` : "";
  });
  // Native agents join result domains containing AssistantMessage, unknown included.
  const registered: NodeIdType[] = [
    numeric.addNode({ ...policy, state: numericAgent }),
    numeric.addNode({ ...policy, state: numericMock }),
    mixed.addNode({ ...policy, state: mixedAgent }),
    yaml.addNode({ ...policy, state: yamlAgent }),
    textOnly.addNode({
      ...policy,
      state: textAgent,
      step: async function* () {
        return "text";
      },
    }),
    numberOnly.addNode({
      ...policy,
      state: numberAgent,
      step: async function* () {
        return 7;
      },
    }),
  ];
  // @ts-expect-error a string-only result graph requires an explicit step
  textOnly.addNode({ ...policy, state: textAgent });
  // @ts-expect-error a number-only result graph requires an explicit step
  numberOnly.addNode({ ...policy, state: numberAgent });
  // fromYaml promises only the runtime-loaded domains.
  const loaded = await JuncoGraph.fromYaml("", config);
  exact<
    typeof loaded,
    SchedulerContext<
      Agentic<TSchema, unknown>,
      TSchema,
      unknown,
      schedules.AgencyNodeMetadata,
      JuncoGraph<TSchema, unknown>
    >
  >(true);
  exact<Static<typeof AssistantMessageSchema>, AssistantMessage>(true);
  await SendTool.invoke(
    new SendTool(),
    registration,
    "s",
    { id: "numbers", payload: 7 },
    signal,
  );
  await SendTool.invoke(
    new SendTool(),
    registration,
    "s",
    // @ts-expect-error a numeric registration sends numbers
    { id: "numbers", payload: "7" },
    signal,
  );
  return registered;
}
