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
import type * as O from "fp-ts/lib/Option.js";
import {
  type AgenticStep,
  JuncoAgent,
  type Agentic as JuncoAgentProtocol,
} from "junco-agent";
import { createParallelScheduler } from "junco-scheduler";
import type {
  PiScheduler,
  PiSchedulerOptions,
  ScheduleTool,
} from "junco-scheduler/agent";
import {
  type ComplainTool,
  type Issue,
  isComplainTool,
  type ToolCollection,
} from "junco-tools";
import {
  type Agentic,
  type AgenticInput,
  type AgenticNode,
  type AgentNodeBinding,
  agentNode,
  type CompactionPolicy,
  compactGraph,
  compaction,
  createAgencyScheduler,
  Deterministic,
  deterministicNode,
  type GraphNodeBinding,
  graph as graphApi,
  graphNode,
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

export function agentFactoriesRequirePolicy(
  native: Omit<
    Parameters<typeof JuncoAgent.fromResolved>[0],
    "policy" | "collection"
  >,
  collection: ToolCollection,
  agent: JuncoAgent,
) {
  const borrowed = JuncoAgent.fromResolved({
    ...native,
    policy: "GitPolicy",
    collection,
  });
  const permissive = JuncoAgent.create({
    provider: "p",
    model: "m",
    policy: "EmptyPolicy",
    tools: [],
  });
  // @ts-expect-error the policy is required
  void JuncoAgent.fromResolved(native);
  // @ts-expect-error policies are the two case-sensitive literals
  void JuncoAgent.create({ provider: "p", model: "m", policy: "gitpolicy" });
  const bound: [ToolCollection | undefined, "GitPolicy" | "EmptyPolicy"] = [
    agent.collection,
    agent.policy,
  ];
  return [borrowed, permissive, bound];
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
  let graph: JuncoGraph | undefined;
  const made: Promise<TaggedScheduler> = createAgencyScheduler(
    () => graph,
    resolved,
  );
  const fixed: Promise<TaggedScheduler> = createAgencyScheduler(
    () => graph,
    opus,
  );
  const scheduler = await made;
  const constructed = new JuncoGraph(
    scheduler,
    Width(1),
    UNBOUNDED,
    tracer,
    "GitPolicy",
    collection,
  );
  graph = constructed;
  const specialized: TaggedScheduler = constructed.scheduler;
  const skill: "skill" | undefined =
    specialized.getResources().skills?.[0]?.tag;
  const template: "template" | undefined = (await fixed).getResources()
    .promptTemplates?.[0]?.tag;
  const tools: (ScheduleTool | ComplainTool)[] = specialized.getTools();
  const iterator: AsyncGenerator<AgenticStep, void, void> = specialized;
  const settlement: Promise<AssistantMessage> = specialized.prompt("typed");
  const bounds: readonly [WidthType, WidthType, DataflowTracer] = [
    constructed.window,
    constructed.threads,
    constructed.tracer,
  ];
  // @ts-expect-error a direct JuncoGraph requires a tracer
  void new JuncoGraph(scheduler, Width(1), UNBOUNDED);
  // @ts-expect-error an undefined tracer is not a tracer
  void new JuncoGraph(scheduler, Width(1), UNBOUNDED, undefined, "GitPolicy");
  // @ts-expect-error a direct JuncoGraph requires a policy
  void new JuncoGraph(scheduler, Width(1), UNBOUNDED, tracer);
  // @ts-expect-error policies are the two case-sensitive literals
  void new JuncoGraph(scheduler, Width(1), UNBOUNDED, tracer, "gitpolicy");
  // @ts-expect-error createParallelAgentGraph requires a policy
  void graphApi.createParallelAgentGraph();
  // @ts-expect-error a coroutine requires a policy
  void new Deterministic(async function* () {});
  const created: Promise<JuncoGraph> = JuncoGraph.create(
    ".",
    { policy: "EmptyPolicy", sandbox: "always" },
    (shared) =>
      graphApi.createParallelAgentGraph("EmptyPolicy", tracer, shared),
  );
  // @ts-expect-error JuncoGraph.create requires a policy
  void JuncoGraph.create(".", {}, () => constructed);
  const injected = new Deterministic<AgenticInput, string>(
    async function* (signal, borrowed) {
      signal.throwIfAborted();
      yield [];
      return borrowed?.policy ?? "pure";
    },
    "GitPolicy",
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
  const options: NodeOptions<AgenticInput, AssistantMessage> & {
    readonly policy: "GitPolicy";
  } = { trigger: always(), policy: "GitPolicy" };
  const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
    async function* (signal) {
      const view = yield [];
      signal.throwIfAborted();
      return [...view.values.keys()].length === 0 ? message : message;
    },
    "GitPolicy",
  );
  const agentBinding: AgentNodeBinding = {
    prompt: "go",
    receive: (view) =>
      [...view.messages.keys()].flatMap(
        (edge) => view.messages.get(edge) ?? [],
      ),
  };
  const graphBinding: GraphNodeBinding = {
    result,
    receive: () => undefined,
    afterStep: async () => undefined,
  };
  const raw: AgenticNode = {
    ...options,
    state: mock,
    // biome-ignore lint/correctness/useYield: compile-only step that completes without yielding.
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
  // @ts-expect-error every node spec carries its policy
  void agentNode(mock, { trigger: always() });
  // @ts-expect-error raw node specs carry their policy too
  void graph.addNode({ trigger: always(), state: mock, step: raw.step });
  const concrete: TaggedScheduler = graph.scheduler;
  return [ids, concrete];
}

export function bindingsStayOutOfNodeOptions(
  mock: MockAgent,
  child: JuncoGraph,
  result: NodeIdType,
) {
  const prompted: NodeOptions<AgenticInput, AssistantMessage> = {
    trigger: always(),
    // @ts-expect-error a prompt is execution, not a registration option
    prompt: "go",
  };
  const selected: NodeOptions<AgenticInput, AssistantMessage> = {
    trigger: always(),
    // @ts-expect-error a graph result selection is execution, not a registration option
    result,
  };
  const received: NodeOptions<AgenticInput, AssistantMessage> = {
    trigger: always(),
    // @ts-expect-error input adaptation is execution, not a registration option
    receive: () => [],
  };
  const agent = agentNode(mock, {
    trigger: always(),
    policy: "GitPolicy",
    // @ts-expect-error agentNode takes its prompt in the binding
    prompt: "go",
  });
  const nested = graphNode(
    child,
    // @ts-expect-error graphNode takes its result in the binding
    { trigger: always(), policy: "GitPolicy", result },
    { result },
  );
  // @ts-expect-error graphNode requires its result-selecting binding
  const unbound = graphNode(child, { trigger: always(), policy: "GitPolicy" });
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
  const options: NodeOptions<number, string> & {
    readonly policy: "GitPolicy";
  } = { trigger: always(), policy: "GitPolicy" };
  const fibonacci = new Deterministic<number, string>(async function* (signal) {
    let view = yield [];
    signal.throwIfAborted();
    const counts: number[] = [...view.messages.keys()].map(
      (edge) => view.messages.get(edge)?.length ?? 0,
    );
    view = yield [];
    return `${counts.length}:${[...view.values.keys()].length}`;
  }, "GitPolicy");
  const child = new JuncoGraph<number, string>(
    createParallelScheduler<number, string>(),
    Width(1),
    UNBOUNDED,
    tracer,
    "GitPolicy",
  );
  const childId = child.addNode(deterministicNode(fibonacci, options));
  const raw: AgenticNode<number, string> = {
    ...options,
    state: mock,
    // biome-ignore lint/correctness/useYield: compile-only step that completes without yielding.
    step: async function* () {
      return "raw";
    },
  };
  const nodes: AgenticNode<number, string>[] = [
    graphNode(child, options, {
      result: childId,
      receive: (view) => void view.messages,
    }),
    raw,
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  graph.emit(ids[0]!, msg(messageEdge<number, string>("typed-output"), 1));
  const chat: Message<string> = msg(
    messageEdge<string, string>("chat-output"),
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
  const compaction: Promise<void> = compactGraph(
    graph,
    "more-than-forty-available",
  );
  // @ts-expect-error compaction requires a policy
  void compactGraph(graph);
  // @ts-expect-error a policy outside CompactionPolicy is rejected
  void compactGraph(graph, "most");
  // @ts-expect-error a chat-typed node cannot join a numeric graph
  graph.addNode(agentNode(mock, { trigger: always(), policy: "GitPolicy" }));
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
    createParallelScheduler<AgenticInput, AssistantMessage>(),
    Width(1),
    UNBOUNDED,
    tracer,
    "EmptyPolicy",
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
  const routed: compaction.CompactionPolicy[] = [
    "all-available",
    "more-than-forty-available",
  ];
  for (const policy of flat) await compactGraph(graph, policy);
  for (const policy of routed) await compaction.compactGraph(graph, policy);
  const fractions: number[] = [...flat, ...routed].map(policyFraction);
  // @ts-expect-error the namespaced policy type rejects an unknown policy
  const unknown: compaction.CompactionPolicy = "half";
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
  const options: NodeOptions<number, string> & {
    readonly policy: "GitPolicy";
  } = { trigger: graphApi.trigger.always(), policy: "GitPolicy" };
  const graph: JuncoGraph<number, string> = graphApi.createParallelAgentGraph<
    number,
    string
  >("GitPolicy", tracer);
  const coroutine = new graphApi.nodes.Deterministic<number, string>(
    async function* () {
      const view = yield [];
      return `${[...view.messages.keys()].length}`;
    },
    "GitPolicy",
  );
  const binding: graphApi.nodes.GraphNodeBinding<number, string> = {
    result: childResult,
    receive: (view) => void view.values.get(graphApi.EdgeId("numbers")),
  };
  const nodes: graphApi.nodes.AgenticNode<number, string>[] = [
    graphApi.nodes.graphNode(child, options, binding),
    graphApi.nodes.deterministicNode(coroutine, options),
  ];
  const ids: NodeIdType[] = nodes.map((node) => graph.addNode(node));
  const states: graphApi.nodes.Agentic<number, string>[] = [child, coroutine];
  const promptBinding: graphApi.nodes.AgentNodeBinding = {
    prompt: "go",
    receive: (view) =>
      [...view.messages.keys()].flatMap(
        (edge): graphApi.nodes.AgenticInput[] => [
          ...(view.messages.get(edge) ?? []),
        ],
      ),
  };
  const chat: graphApi.nodes.AgenticNode = graphApi.nodes.agentNode(
    mock,
    { trigger: graphApi.trigger.always(), policy: "GitPolicy" },
    promptBinding,
  );
  // @ts-expect-error a chat-typed prompt-agent node cannot join a numeric graph
  graph.addNode(chat);
  // @ts-expect-error the namespaced graphNode still requires its result-selecting binding
  const unbound = graphApi.nodes.graphNode(child, options);
  return [ids, states, unbound];
}
