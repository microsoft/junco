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
  type EdgeIdType,
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
  type Snapshot,
  select,
  separate,
} from "junco-scheduler";
import { type PiOptions, pi } from "junco-scheduler/agent";
import {
  type Contract,
  EmptyPolicy,
  type Issue,
  isComplainTool,
  LockPolicy,
  type Policy,
  type ToolCollection,
} from "junco-tools";
import type { Graph } from "ngraph.graph";
import {
  type Agentic,
  type AgenticInput,
  type AgenticNode,
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
} from "../src/index.ts";
import type { NodePolicy } from "../src/node-policy.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };
type TaggedTranscript = MockTranscript<TaggedSkill, TaggedTemplate, TaggedTool>;
type NestedContext<N = AgenticInput, T = AssistantMessage> = SchedulerContext<
  Agentic<N, T>,
  N,
  T,
  never,
  JuncoGraph<N, T>
>;

export function protocolComplainTakesCompleteIssues(
  protocol: JuncoAgentProtocol<TaggedSkill, TaggedTemplate, TaggedTool>,
  nodeId: NodeIdType,
  messages: readonly Message<number>[],
) {
  const issue: Issue<number> = {
    nodeId,
    messages,
    prompt: { systemPrompt: "s", messages: [] },
    complaint: "blocked",
  };
  const recorded: void = protocol.complain(issue);
  // @ts-expect-error a complaint string alone is not an issue
  protocol.complain("blocked");
  // @ts-expect-error an issue carries its node, messages and prompt
  protocol.complain({ nodeId, complaint: "blocked" });
  return recorded;
}

export function juncoAgentKeepsSpecializations(
  agent: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
) {
  const [first] = agent.getTools();
  const tool: "tool" | undefined =
    first === undefined || isComplainTool(first) ? undefined : first.tag;
  const skill: "skill" | undefined = agent.getResources().skills?.[0]?.tag;
  const template: "template" | undefined =
    agent.getResources().promptTemplates?.[0]?.tag;
  return [tool, skill, template];
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
  source: Source<AgenticInput, AssistantMessage>,
  sink: Sink<AgenticInput, AssistantMessage>,
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
      AgenticInput,
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
    AgenticInput,
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
    AgenticInput,
    AssistantMessage,
    { priority: number },
    JuncoGraph
  > = await custom;
  // @ts-expect-error collection builders return contexts, not bare graphs
  void JuncoGraph.create(".", {}, () => graph);
  const injected = new Deterministic<AgenticInput, string>(
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
  graph: JuncoGraph<AgenticInput, AssistantMessage, unknown>,
  junco: JuncoAgent,
  mock: MockAgent,
  child: NestedContext,
  result: NodeIdType,
  message: AssistantMessage,
) {
  const options: NodeOptions<AgenticInput, AssistantMessage> = {
    trigger: TriggerRule.always(),
  };
  const policy = { policy: LockPolicy } as const;
  const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
    async function* (signal) {
      const view = yield [];
      signal.throwIfAborted();
      return [...view.values.keys()].length === 0 ? message : message;
    },
    LockPolicy,
  );
  mock.stagePrompt("go");
  const contract = (edgeId: EdgeIdType) => ({ expect: `data on ${edgeId}` });
  const nestedNode = {
    ...options,
    state: child,
    contract,
  } satisfies AgenticNode;
  const raw: AgenticNode = {
    ...options,
    ...policy,
    state: mock,
    contract,
    step: async function* () {
      return message;
    },
  };
  const nodes: AgenticNode[] = [
    { ...options, ...policy, state: junco },
    { ...options, ...policy, state: mock },
    { ...options, contract, state: coroutine },
    nestedNode,
    raw,
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  const agreed: Contract[] = [
    junco.contract(EdgeId.create("in")),
    mock.contract(EdgeId.create("in")),
  ];
  // @ts-expect-error a contract is queried by edge, not node
  void junco.contract(NodeId.create("in"));
  // @ts-expect-error a contract is synchronous metadata
  const later: Promise<Contract> = mock.contract(EdgeId.create("in"));
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
  return [ids, agreed, later];
}

export async function promptsLiveOnAgents(
  native: Omit<Parameters<typeof JuncoAgent.fromResolved>[0], "prompt">,
  junco: JuncoAgent,
  mock: MockAgent,
  transcript: TaggedTranscript,
  view: ParentView<AgenticInput, AssistantMessage>,
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
  const staged: void[] = [
    junco.stagePrompt("go"),
    junco.stagePrompt((inputs) => `${inputs.messages.get(id)?.length}`, {
      images: [image],
    }),
    mock.stagePrompt("go"),
    mock.stagePrompt((inputs) => `${inputs.values.get(id)?.role}`),
  ];
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
  const prompted: NodeOptions<AgenticInput, AssistantMessage> = {
    trigger: TriggerRule.always(),
    // @ts-expect-error a prompt is execution, not a registration option
    prompt: "go",
  };
  const selected: NodeOptions<AgenticInput, AssistantMessage> = {
    trigger: TriggerRule.always(),
    // @ts-expect-error a graph result selection is execution, not a registration option
    result,
  };
  const received: NodeOptions<AgenticInput, AssistantMessage> = {
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
  const untriggered: NodeOptions<AgenticInput, AssistantMessage> = {
    description: "no trigger",
  };
  return [prompted, selected, received, agent, nested, unbound, untriggered];
}

export function wireTypesAndContextsArePreserved(
  graph: JuncoGraph<number, string, unknown>,
  mock: MockAgent,
  tracer: DataflowTracer,
) {
  const options: NodeOptions<number, string> = {
    trigger: TriggerRule.always(),
  };
  const fibonacci = new Deterministic<number, string>(async function* (signal) {
    let view = yield [];
    signal.throwIfAborted();
    const counts: number[] = [...view.messages.keys()].map(
      (edge) => view.messages.get(edge)?.length ?? 0,
    );
    view = yield [];
    return `${counts.length}:${[...view.values.keys()].length}`;
  }, LockPolicy);
  const ports: { source: Source<number, string>; sink: Sink<number, string> } =
    {
      source: new Source<number, string>(
        () => {
          throw new DataflowDefinitionError(
            "Typed fixture does not accept external input",
          );
        },
        { id: NodeId.create("$source") },
      ),
      sink: new Sink<number, string>(
        async function* (): NodeGenerator<number, string> {
          yield [];
          const value = child.result(childId);
          if (value._tag === "None") throw new Error("Missing terminal result");
          return value.value;
        },
        {
          id: NodeId.create("$sink"),
          trigger: TriggerRule.when(
            Edge.value<number, string>("member->$sink"),
          ),
        },
      ),
    };
  const child: JuncoGraph<number, string> = new JuncoGraph<number, string>(
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
    Edge.value<number, string>("member->$sink"),
  );
  const childContext = schedules.context({
    graph: child,
    scheduler: parallel(),
  });
  const raw: AgenticNode<number, string> = {
    ...options,
    policy: LockPolicy,
    state: mock,
    step: async function* () {
      return "raw";
    },
  };
  const nodes: AgenticNode<number, string>[] = [
    {
      ...options,
      state: childContext,
    },
    raw,
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  graph.emit(
    ids[0]!,
    Message.create(Edge.message<number, string>("typed-output"), 1),
  );
  const chat: Message<string> = Message.create(
    Edge.message<string, string>("chat-output"),
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
  bare: DataflowGraph<Agentic, AgenticInput, AssistantMessage, unknown>,
  protocol: JuncoAgentProtocol,
  tracer: DataflowTracer,
  source: Source<AgenticInput, AssistantMessage>,
  sink: Sink<AgenticInput, AssistantMessage>,
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
  const native: DataflowGraph<
    Agentic,
    AgenticInput,
    AssistantMessage,
    unknown
  > = constructed;
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
  for (const policy of routed) await graph.compact(policy);
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
  child: NestedContext<number, string>,
  source: Source<number, string>,
  sink: Sink<number, string>,
  tracer: DataflowTracer,
) {
  const options: NodeOptions<number, string> = {
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
  const coroutine = new graphApi.nodes.Deterministic<number, string>(
    async function* () {
      const view = yield [];
      return `${[...view.messages.keys()].length}`;
    },
    LockPolicy,
  );
  const nodes: graphApi.nodes.AgenticNode<number, string>[] = [
    { ...options, state: child },
    { ...options, state: coroutine },
    source,
    sink,
  ];
  const rejected: graphApi.nodes.AgenticNode<number, string>[] = [
    // @ts-expect-error a step-less coroutine owns its policy
    { ...options, state: coroutine, policy: LockPolicy },
    // @ts-expect-error a nested context owns its graph's policy
    { ...options, state: child, policy: LockPolicy },
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  const states: graphApi.nodes.Agentic<number, string>[] = [
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
  const unbound: graphApi.nodes.AgenticNode<number, string> = {
    ...options,
    state: child.graph,
  };
  return [ids, states, unbound, rejected];
}

export function typedContextsPreserveNativeAndCallerData(id: NodeIdType) {
  type State = Readonly<{ group: "a" | "b" }>;
  class SpecializedGraph extends DataflowGraph<State, number, string, Error> {
    subtypeOnly(): "specialized" {
      return "specialized";
    }
  }
  const graph = new SpecializedGraph(Width.create(1), UNBOUNDED);
  const ranked: Scheduler<State, number, string, { priority: number }> = choose(
    {
      rank: (snapshot, left, right) => {
        const state: State | undefined = snapshot.nodes.get(left)?.state;
        const inputs: readonly number[] | undefined = snapshot.inputs
          .get(left)
          ?.messages.get(EdgeId.create("input"));
        const result: string | undefined = snapshot.results.get(left);
        const priority: number | undefined =
          snapshot.context.get(left)?.priority;
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
    },
  );
  const execution = nativeContext({
    graph,
    scheduler: ranked,
    describeNode: () => ({ priority: 7 }),
  });
  const exact: SchedulerContext<
    State,
    number,
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
    number,
    string,
    never,
    SpecializedGraph
  > = absent;
  const zero: SchedulerContext<
    State,
    number,
    string,
    number,
    SpecializedGraph
  > = nativeContext({ graph, scheduler: parallel(), describeNode: () => 0 });
  const falsy: SchedulerContext<
    State,
    number,
    string,
    boolean,
    SpecializedGraph
  > = nativeContext({
    graph,
    scheduler: parallel(),
    describeNode: () => false,
  });
  const nullable: SchedulerContext<
    State,
    number,
    string,
    null,
    SpecializedGraph
  > = nativeContext({ graph, scheduler: parallel(), describeNode: () => null });
  const explicitlyEmpty = nativeContext<
    State,
    number,
    string,
    { priority: number },
    SpecializedGraph
  >({ graph, scheduler: ranked });
  const wrongMetadata: Scheduler<
    State,
    number,
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
    string,
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
  const other = new DataflowGraph<boolean, string, number, never>(
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
  const composed: Scheduler<State, number, string, { priority: number }> =
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
  const ordinary: Scheduler<
    State,
    number,
    string,
    { priority: number }
  > = async () => ({ selected: select([id]) });
  const unbranded: Scheduler<
    State,
    number,
    string,
    { priority: number }
    // @ts-expect-error selections use branded native IDs
  > = () => ({ selected: [{ nodeId: "raw", modelStrength: 2 }] });
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
  source: Source<number, string>,
  sink: Sink<number, string>,
  wrongSink: Sink<string, string>,
  wrongResult: Sink<number, number>,
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
  const sourceSpec: NodeSpec<Agentic<number, string>, number, string> = source;
  const sinkSpec: NodeSpec<Agentic<number, string>, number, string> = sink;
  const sourceState: Source<number, string> = source.state;
  const sinkState: Sink<number, string> = sink.state;
  const view: ParentView<number, string> | undefined = source.peek();
  const result: O.Option<string> = graph.result(sink.id);
  const owner = nativeContext({
    graph,
    scheduler: parallel(),
    describeNode: () => ({ priority: 7 }),
  });
  const nested: NestedContext<number, string> = owner;
  const exactOwner: SchedulerContext<
    Agentic<number, string>,
    number,
    string,
    { priority: number },
    JuncoGraph<number, string>
  > = owner;
  const nativeState: Agentic<number, string> = owner.graph;
  const advance: Promise<ReadonlyMap<NodeIdType, string>> = owner.step();
  // @ts-expect-error contexts are execution capabilities, not native node state
  const contextState: Agentic<number, string> = owner;
  // @ts-expect-error a passive graph is not an execution capability
  const bare: NestedContext<number, string> = graph;
  const metadataFree: Scheduler<
    Agentic<number, string>,
    number,
    string,
    never
  > = () => ({ selected: [] });
  // @ts-expect-error the reverse assignment cannot promise rich metadata
  const metadataRich: Scheduler<
    Agentic<number, string>,
    number,
    string,
    { priority: number }
  > = metadataFree;
  // @ts-expect-error result domains remain exact through nested contexts
  const incompatibleResult: NestedContext<number, number> = owner;
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
  new Source<number, string>(() => [], { id: "raw" });
  new Sink<number, string>(
    async function* () {
      return "unused";
    },
    // @ts-expect-error sink IDs are mandatory
    { trigger: TriggerRule.never() },
  );
  const agency = schedules.context({
    graph,
    scheduler: (snapshot) => {
      const metadata: ReadonlyMap<NodeIdType, schedules.AgencyNodeMetadata> =
        snapshot.context;
      const inputs: ParentView<number, string> | undefined =
        snapshot.inputs.get(source.id);
      const output: string | undefined = snapshot.results.get(sink.id);
      void [metadata, inputs, output];
      return { selected: [] };
    },
  });
  const concrete: JuncoGraph<number, string> = agency.graph;
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
  source: Source<number, string>,
  sink: Sink<number, string>,
  wrongSink: Sink<string, string>,
) {
  const execution = JuncoGraph.map(
    skeleton,
    (state) =>
      new Deterministic<number, string>(async function* () {
        yield [];
        return String(state.value);
      }, LockPolicy),
    { source, sink, policy: LockPolicy },
  );
  const exact: SchedulerContext<
    Agentic<number, string>,
    number,
    string,
    schedules.AgencyNodeMetadata,
    JuncoGraph<number, string>
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
      trigger: TriggerRule.always<number, string>(),
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
