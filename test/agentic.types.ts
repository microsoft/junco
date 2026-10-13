// Compile-only: one engine-owned NodeOptions value registers every node kind with execution
// bindings kept apart; JuncoGraph is the runtime graph state preserving its wire types and concrete
// scheduler; specialized skills, prompt templates and tools survive JuncoAgent and both agency
// scheduler factories. Covered by tsconfig.typecheck.json; never executed.

import type {
  AgentMessage,
  AgentTool,
  NavigationResult,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
  type DataflowGraph,
  type DataflowScheduler,
  type DataflowTracer,
  Edge,
  EdgeId,
  type EdgeIdType,
  Message,
  NodeId,
  type NodeIdType,
  type NodeOptions,
  type ParentView,
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
import { ParallelScheduler } from "junco-scheduler";
import type {
  PiScheduler,
  PiSchedulerOptions,
  ScheduleTool,
} from "junco-scheduler/agent";
import {
  type ComplainTool,
  type Contract,
  EmptyPolicy,
  type Issue,
  isComplainTool,
  LockPolicy,
  type Policy,
  type ToolCollection,
} from "junco-tools";
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
} from "../src/index.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };
type TaggedTranscript = MockTranscript<TaggedSkill, TaggedTemplate, TaggedTool>;
type TaggedScheduler = PiScheduler<
  AgenticInput,
  AssistantMessage,
  TaggedSkill,
  TaggedTemplate
>;

export function protocolComplainTakesCompleteIssues(
  protocol: JuncoAgentProtocol<TaggedSkill, TaggedTemplate, TaggedTool>,
  scheduler: TaggedScheduler,
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
  const inherited: void = scheduler.complain(issue, {
    complain: (_id: NodeIdType, _text: string) => {},
  });
  // @ts-expect-error a complaint string alone is not an issue
  protocol.complain("blocked");
  // @ts-expect-error an issue carries its node, messages and prompt
  protocol.complain({ nodeId, complaint: "blocked" });
  return [recorded, inherited];
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
  resolved: Omit<
    PiSchedulerOptions<
      AgenticInput,
      AssistantMessage,
      TaggedSkill,
      TaggedTemplate
    >,
    "adapter"
  >,
  opus: Omit<
    PiSchedulerOptions<
      AgenticInput,
      AssistantMessage,
      TaggedSkill,
      TaggedTemplate
    >,
    "adapter"
  >,
  tracer: DataflowTracer,
  collection: NonNullable<JuncoGraph["collection"]>,
) {
  const made = JuncoGraph.pi({
    ...resolved,
    policy: LockPolicy,
    tracer,
    window: Width.create(1),
    collection,
  });
  const fixed = JuncoGraph.pi({ ...opus, policy: LockPolicy });
  const constructed = await made;
  const scheduler: TaggedScheduler = constructed.scheduler;
  const specialized: TaggedScheduler = (await fixed).scheduler;
  // @ts-expect-error a Pi graph requires a policy
  void JuncoGraph.pi({ ...opus });
  // @ts-expect-error graph bounds are checked widths
  void JuncoGraph.pi({ ...opus, policy: LockPolicy, window: 2 });
  const skill: "skill" | undefined =
    specialized.getResources().skills?.[0]?.tag;
  const template: "template" | undefined = (
    await fixed
  ).scheduler.getResources().promptTemplates?.[0]?.tag;
  const tools: (ScheduleTool | ComplainTool)[] = specialized.getTools();
  const iterator: AsyncGenerator<
    AgenticStep,
    void,
    ParentView<AgenticInput, AssistantMessage> | undefined
  > = specialized;
  const settlement: Promise<AssistantMessage> = specialized.prompt("typed");
  const bounds: readonly [WidthType, WidthType, DataflowTracer] = [
    constructed.window,
    constructed.threads,
    constructed.tracer,
  ];
  // @ts-expect-error a direct JuncoGraph requires a tracer
  void new JuncoGraph(scheduler, Width.create(1), UNBOUNDED);
  void new JuncoGraph(
    scheduler,
    Width.create(1),
    UNBOUNDED,
    // @ts-expect-error an undefined tracer is not a tracer
    undefined,
    LockPolicy,
  );
  // @ts-expect-error a direct JuncoGraph requires a policy
  void new JuncoGraph(scheduler, Width.create(1), UNBOUNDED, tracer);
  void new JuncoGraph(
    scheduler,
    Width.create(1),
    UNBOUNDED,
    tracer,
    // @ts-expect-error a policy is a Policy object, not its name
    "gitpolicy",
  );
  // @ts-expect-error JuncoGraph.parallel requires a policy
  void graphApi.JuncoGraph.parallel();
  // @ts-expect-error a coroutine requires a policy
  void new Deterministic(async function* () {});
  const created: Promise<JuncoGraph> = JuncoGraph.create(
    ".",
    { policy: EmptyPolicy, sandbox: "always" },
    (shared) => graphApi.JuncoGraph.parallel(EmptyPolicy, tracer, shared),
  );
  // An omitted collection policy is LockPolicy, read back from the collection.
  void JuncoGraph.create(".", {}, (shared) =>
    graphApi.JuncoGraph.parallel(shared.policy, tracer, shared),
  );
  const injected = new Deterministic<AgenticInput, string>(
    async function* (signal, borrowed) {
      signal.throwIfAborted();
      yield [];
      return borrowed === undefined ? "pure" : "borrowed";
    },
    LockPolicy,
    collection,
  );
  return [
    skill,
    template,
    tools,
    iterator,
    settlement,
    bounds,
    created,
    injected,
  ];
}

export function everyKindSharesOneNodeOptions(
  graph: JuncoGraph<AgenticInput, AssistantMessage, unknown, TaggedScheduler>,
  junco: JuncoAgent,
  mock: MockAgent,
  child: JuncoGraph,
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
    result,
    receive: () => undefined,
    afterStep: async () => undefined,
    contract,
  } satisfies AgenticNode;
  const raw: AgenticNode = {
    ...options,
    ...policy,
    state: mock,
    contract,
    // biome-ignore lint/correctness/useYield: compile-only step that completes without yielding.
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
  void graph.addNode({ ...options, state: child, result, policy: LockPolicy });
  // Compiles (no exactOptionalPropertyTypes); rejected at runtime as an own field.
  void graph.addNode({ ...options, state: coroutine, policy: undefined });
  // @ts-expect-error an agent node without a step carries its policy
  void graph.addNode({ ...options, state: junco });
  // @ts-expect-error an explicit-step managed node carries its policy
  void graph.addNode({ ...options, state: coroutine, step: raw.step });
  // @ts-expect-error a managed node still requires a trigger
  void graph.addNode({ state: coroutine });
  // @ts-expect-error a nested node still requires a trigger
  void graph.addNode({ state: child, result });
  // @ts-expect-error a step-less nested graph must select its result
  void graph.addNode({ ...options, state: child });
  // @ts-expect-error only a nested graph node carries execution fields
  void graph.addNode({ ...options, state: coroutine, result });
  // @ts-expect-error only a nested graph node carries execution fields
  void graph.addNode({ ...options, state: mock, receive: () => undefined });
  const concrete: TaggedScheduler = graph.scheduler;
  return [ids, concrete, agreed, later];
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
  child: JuncoGraph,
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
  const nested: AgenticNode = {
    trigger: TriggerRule.always(),
    state: child,
    result,
  };
  // @ts-expect-error a step-less nested graph node requires its result
  const unbound: AgenticNode = {
    trigger: TriggerRule.always(),
    state: child,
  };
  // @ts-expect-error a trigger is required
  const untriggered: NodeOptions<AgenticInput, AssistantMessage> = {
    description: "no trigger",
  };
  return [prompted, selected, received, agent, nested, unbound, untriggered];
}

export function wireTypesAndSchedulerArePreserved(
  graph: JuncoGraph<number, string, unknown, PiScheduler<number, string>>,
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
  const child = new JuncoGraph<number, string>(
    new ParallelScheduler<number, string>(),
    Width.create(1),
    UNBOUNDED,
    tracer,
    LockPolicy,
  );
  const childId = child.addNode({ ...options, state: fibonacci });
  const raw: AgenticNode<number, string> = {
    ...options,
    policy: LockPolicy,
    state: mock,
    // biome-ignore lint/correctness/useYield: compile-only step that completes without yielding.
    step: async function* () {
      return "raw";
    },
  };
  const nodes: AgenticNode<number, string>[] = [
    {
      ...options,
      state: child,
      result: childId,
      receive: (view) => void view.messages,
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
  const concrete: PiScheduler<number, string> = graph.scheduler;
  const selected: O.Option<string> = child.result(childId);
  const results: Promise<ReadonlyMap<NodeIdType, string>>[] = [
    graph.run(),
    graph.step({ signal: graph.signal }),
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
    // biome-ignore lint/correctness/useYield: compile-only step that completes without yielding.
    step: async function* () {
      return "custom";
    },
  });
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
  const constructed = new JuncoGraph(
    new ParallelScheduler<AgenticInput, AssistantMessage>(),
    Width.create(1),
    UNBOUNDED,
    tracer,
    EmptyPolicy,
  );
  const states: Agentic[] = [junco, mock, coroutine, graph, constructed];
  const native: DataflowGraph<
    Agentic,
    AgenticInput,
    AssistantMessage,
    unknown,
    DataflowScheduler<AgenticInput, AssistantMessage>
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
  scheduler: PiScheduler<AgenticInput, AssistantMessage>,
) {
  const state = graph.getNode(id)!.state;
  // @ts-expect-error graphs and coroutines have no maintenance methods
  void state.context_size();
  const sizes: Promise<number>[] = [
    junco.context_size(),
    scheduler.context_size(),
  ];
  const compactions: Promise<void>[] = [
    junco.compact({ customInstructions: "focus" }),
    scheduler.compact(),
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
  child: JuncoGraph<number, string>,
  childResult: NodeIdType,
  tracer: DataflowTracer,
) {
  const options: NodeOptions<number, string> = {
    trigger: graphApi.trigger.TriggerRule.always(),
  };
  const graph: JuncoGraph<number, string> = graphApi.JuncoGraph.parallel<
    number,
    string
  >(LockPolicy, tracer);
  const coroutine = new graphApi.nodes.Deterministic<number, string>(
    async function* () {
      const view = yield [];
      return `${[...view.messages.keys()].length}`;
    },
    LockPolicy,
  );
  const nodes: graphApi.nodes.AgenticNode<number, string>[] = [
    {
      ...options,
      state: child,
      result: childResult,
      receive: (view) =>
        void view.values.get(graphApi.EdgeId.create("numbers")),
    },
    { ...options, state: coroutine },
  ];
  const rejected: graphApi.nodes.AgenticNode<number, string>[] = [
    // @ts-expect-error a step-less coroutine's policy is owned by its state
    { ...options, state: coroutine, policy: LockPolicy },
    // @ts-expect-error a step-less nested graph's policy is owned by its state
    { ...options, state: child, result: childResult, policy: LockPolicy },
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  const states: graphApi.nodes.Agentic<number, string>[] = [child, coroutine];
  mock.stagePrompt("go");
  // @ts-expect-error a chat-typed prompt-agent node cannot join a numeric graph
  graph.addNode({
    state: mock,
    trigger: graphApi.trigger.TriggerRule.always(),
    policy: LockPolicy,
  });
  // @ts-expect-error a namespaced nested graph node still requires its result
  const unbound: graphApi.nodes.AgenticNode<number, string> = {
    ...options,
    state: child,
  };
  return [ids, states, unbound, rejected];
}
