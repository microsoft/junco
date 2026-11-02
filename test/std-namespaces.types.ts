// Compile-only: every type exported through the root `graph`, `trigger`, `tracer`, `schedules`,
// `workflows`, `agent`, `tools` and `mcp` namespaces, plus the flat LSP types, used as a consumer would: typed
// construction, callbacks and narrowing, with deliberate rejections. Detailed generic rules stay in
// the engine and scheduler fixtures. Covered by tsconfig.typecheck.json; never executed.

import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
  type InputSchedule,
  type MessageSchedule,
  triggerInputs,
} from "dataflow-engine";
import type * as O from "fp-ts/lib/Option.js";
import { context as nativeContext } from "junco-scheduler";
import { type TSchema, Type } from "typebox";
import {
  agent,
  graph,
  mcp,
  schedules,
  type syntax,
  tools,
  tracer,
  trigger,
  workflows,
} from "../src/index.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };
type TaggedCreateTools = agent.JuncoAgentCreateOptions<
  Skill,
  PromptTemplate,
  TaggedTool
>["tools"];

type Counter = { count: number };
const NumberSchema = Type.Number();
const StringSchema = Type.String();
type Num = typeof NumberSchema;
type Str = typeof StringSchema;
type Chat = typeof agent.AgenticInputSchema;

// --- graph: typed node construction and reading ---------------------------------------------------

export async function graphTypesBuildAndReadTypedNodes(
  g: graph.DataflowGraph<Counter, Num, string, never>,
  source: graph.NodeIdType,
) {
  const numbers: graph.Edge<Num, string> = graph.Edge.message<Num, string>(
    "numbers",
    NumberSchema,
  );
  const done: graph.Edge<never, string> = graph.Edge.value(
    "done",
    StringSchema,
  );
  const numbersId: graph.EdgeIdType = numbers.id;
  const doneId: graph.EdgeId = graph.EdgeId.create("done");
  const sinkId: graph.NodeId = graph.NodeId.create("sink");
  const window: graph.Width = graph.Width.create(2);
  const threads: graph.WidthType = graph.UNBOUNDED;
  const queued: graph.Queue<number> = graph.Queue.from([1, 2]);
  const empty: graph.Queue<number> = graph.Queue.empty<number>();
  queued.push(3);
  const sent: graph.Message<Num> = graph.Message.create(
    numbers,
    queued.shift() ?? empty.length,
  );

  const bounded = <W extends number>(width: graph.ValidWidth<W>): graph.Width =>
    graph.Width.create<W>(width);
  const widths: graph.WidthType[] = [window, threads, bounded(4)];

  const messages: graph.Lookup<graph.EdgeIdType, readonly number[]> = new Map([
    [numbersId, [1, 2]],
  ]);
  const values: graph.Lookup<graph.EdgeIdType, string> = new Map([
    [doneId, "finished"],
  ]);
  const view: graph.ParentView<Num, string> = { messages, values };
  const fromView: readonly number[] = graph.from(view, numbers);

  const availability: graph.AvailabilityFn<Num, string> = (
    current,
    triggered,
  ) => triggered && graph.from(current, numbers).length > 0;
  const step: graph.StepFn<Counter, Num, string> = async function* (
    this: graph.Node<Counter, Num, string>,
  ): graph.NodeGenerator<Num, string> {
    let current: graph.ParentView<Num, string> = yield [];
    while (current.values.get(doneId) === undefined) {
      this.state.count += graph.from(current, numbers).length;
      const status: graph.NodeStatus = this.status;
      current = yield status === "running"
        ? [graph.Message.create(numbers, this.state.count)]
        : [];
    }
    return `${this.state.count}`;
  };
  const options: graph.NodeOptions<Num, string> = {
    id: sinkId,
    description: "counts numbers until done",
    trigger: graph.trigger.TriggerRule.anyOf<Num, string>(
      trigger.TriggerEntry.on(numbers),
      trigger.TriggerEntry.on(done),
    ),
    is_available: availability,
  };
  const recover: graph.ErrorFn<Counter, Num, string> = async function (
    this: graph.Node<Counter, Num, string>,
    error: unknown,
    signal: AbortSignal | undefined,
  ): Promise<readonly graph.Message<Num>[]> {
    signal?.throwIfAborted();
    return error instanceof Error
      ? [graph.Message.create(numbers, this.state.count)]
      : [];
  };
  const spec: graph.NodeSpec<Counter, Num, string> = {
    ...options,
    state: { count: 0 },
    step,
    on_error: recover,
  };
  const notice: graph.nodes.AgenticInput = {
    kind: "error",
    text: "upstream failed",
  };
  const id: graph.NodeIdType = g.addNode(spec);
  g.addEdge(source, id, numbers).addEdge(source, id, done);
  g.emit(source, sent);

  const node: graph.Node<Counter, Num, string> | undefined = g.getNode(id);
  const identified: graph.Identifiable<graph.NodeIdType> | undefined = node;
  const counted: number | undefined = node?.state.count;
  const generator: graph.NodeGenerator<Num, string> | undefined =
    node?.generator;
  const runOptions: graph.DataflowRunOptions = {
    signal: new AbortController().signal,
  };
  const execution = nativeContext({
    graph: g,
    scheduler: schedules.parallel(),
  });
  const results: ReadonlyMap<graph.NodeIdType, string> =
    await execution.run(runOptions);
  const result: O.Option<string> = g.result(id);
  const finalStatus: graph.NodeStatus | undefined = node?.status;

  const leaf: graph.Pretty = { pretty: () => "leaf" };
  const rendered: string[] = [graph.renderPretty(leaf), graph.renderPretty(g)];

  try {
    await execution.step();
  } catch (error) {
    if (error instanceof graph.DataflowNodeError) {
      const failed: graph.NodeIdType = error.nodeId;
      void failed;
    } else if (error instanceof graph.DataflowDefinitionError) {
      const definition: Error = error;
      void definition;
    }
  }

  // @ts-expect-error an edge ID is not a node ID
  g.getNode(numbersId);
  // @ts-expect-error a raw string is not a node ID
  g.result("sink");
  // @ts-expect-error a bare array is not a queue
  const bareQueue: graph.Queue<number> = [1, 2];
  // @ts-expect-error a bare number is not a width
  const bareWidth: graph.Width = 2;
  // @ts-expect-error zero is not a valid width
  bounded(0);
  // @ts-expect-error a numeric message cannot carry a string payload
  const wrongPayload: graph.Message<Num> = { id: numbersId, payload: "one" };
  // @ts-expect-error msg rejects a payload of the wrong type
  graph.Message.create(numbers, "one");
  // @ts-expect-error a node spec requires its step
  const incomplete: graph.NodeSpec<Counter, Num, string> = {
    trigger: graph.trigger.TriggerRule.always(),
    state: { count: 0 },
  };
  // @ts-expect-error a node spec's state must match the graph's state type
  g.addNode({ ...options, state: { total: 0 }, step });
  return [
    widths,
    fromView,
    identified,
    counted,
    generator,
    results,
    result,
    finalStatus,
    rendered,
    bareQueue,
    bareWidth,
    wrongPayload,
    incomplete,
    notice,
  ];
}

type Task = { readonly label: string };

export function spawnBuildsTypedStars(
  root: graph.nodes.AgenticNode<Num, string>,
  child: (label: string) => graph.nodes.AgenticNode<Num, string>,
  stringChild: graph.nodes.AgenticNode<Str, string>,
  bare: graph.nodes.Agentic<Num, string>,
  state: graph.nodes.Deterministic<Num, string>,
  lead: agent.JuncoAgent,
  worker: agent.JuncoAgent,
  source: graph.nodes.Source<Num, string>,
  sink: graph.nodes.Sink<Num, string>,
  agentSource: graph.nodes.Source<Chat, AssistantMessage>,
  agentSink: graph.nodes.Sink<Chat, AssistantMessage>,
) {
  const tasks: readonly Task[] = [{ label: "a" }, { label: "b" }];
  const typed: schedules.SchedulerContext<
    graph.nodes.Agentic<Num, string>,
    Num,
    string,
    schedules.AgencyNodeMetadata,
    graph.JuncoGraph<Num, string>
  > = graph.JuncoGraph.spawn(source, sink, root, tasks, (task) => {
    const inferred: Task = task;
    // @ts-expect-error the factory input is the list's element type
    task.missing;
    return child(inferred.label);
  });
  const explicit = graph.JuncoGraph.spawn(
    source,
    sink,
    root,
    tasks,
    (task) => child(task.label),
    new tracer.DummyTracer(),
  );
  const defaults = graph.JuncoGraph.spawn(
    agentSource,
    agentSink,
    {
      state: lead,
      trigger: trigger.TriggerRule.never(),
      policy: tools.LockPolicy,
    },
    tasks,
    () => ({
      state: worker,
      trigger: trigger.TriggerRule.never(),
      policy: tools.LockPolicy,
    }),
  );
  // @ts-expect-error the root must be an adapted node, not a bare state
  graph.JuncoGraph.spawn(source, sink, bare, tasks, (task) =>
    child(task.label),
  );
  // @ts-expect-error the factory must return an adapted node, not a bare state
  graph.JuncoGraph.spawn(source, sink, root, tasks, () => state);
  // @ts-expect-error the factory must return a node, not an arbitrary value
  graph.JuncoGraph.spawn(source, sink, root, tasks, (task) => task.label);
  graph.JuncoGraph.spawn<Task, Num, string>(
    source,
    sink,
    root,
    tasks,
    // @ts-expect-error a string-message child cannot join a number-wired star
    () => stringChild,
  );
  const managed: graph.nodes.AgenticNode<Num, string> = {
    state,
    trigger: trigger.TriggerRule.never(),
  };
  const managedStar = graph.JuncoGraph.spawn(
    source,
    sink,
    managed,
    tasks,
    () => ({
      state,
      trigger: trigger.TriggerRule.never(),
    }),
  );
  // @ts-expect-error a step-less coroutine's policy is owned by its state
  const owned: graph.nodes.AgenticNode<Num, string> = {
    state,
    trigger: trigger.TriggerRule.never(),
    policy: tools.LockPolicy,
  };
  const typedGraph: graph.JuncoGraph<Num, string> = typed.graph;
  const defaultGraph: graph.JuncoGraph = defaults.graph;
  // @ts-expect-error spawn requires both positional ports
  graph.JuncoGraph.spawn(root, tasks, (task: Task) => child(task.label));
  return [
    typed,
    typedGraph,
    defaultGraph,
    explicit,
    defaults,
    managedStar,
    owned,
  ];
}

// --- trigger and tracer ----------------------------------------------------------------------------

export function triggerRulesDriveTypedNodes(
  left: graph.Edge<Num, string>,
  right: graph.Edge<Num, string>,
) {
  const kind: trigger.TriggerKind = "any";
  const leftEntry: trigger.TriggerEntry<Num, string> =
    trigger.TriggerEntry.on(left);
  const literal: trigger.TriggerRule<Num, string> = {
    kind,
    rule: [leftEntry, trigger.TriggerEntry.on(right)],
  };
  const nested: graph.trigger.TriggerRule<Num, string> =
    graph.trigger.TriggerRule.allOf(leftEntry);
  const rules: trigger.TriggerRule<Num, string>[] = [
    literal,
    nested,
    trigger.TriggerRule.when(right),
    trigger.TriggerRule.always(),
    trigger.TriggerRule.never(),
  ];
  const inbound = new Map<graph.EdgeIdType, graph.Edge<Num, string>>([
    [left.id, left],
    [right.id, right],
  ]);
  const sink = graph.NodeId.create("sink");
  const ready: boolean[] = rules.map((rule) =>
    trigger.evaluateTrigger(rule, inbound, sink),
  );
  const satisfied: (readonly graph.EdgeIdType[])[] = rules.map((rule) =>
    trigger.satisfiedEdges(rule, inbound, sink),
  );
  const spec: graph.NodeSpec<undefined, Num, string> = new graph.nodes.EmitOnce(
    () => [graph.Message.create(left, 1)],
    "once",
    {
      trigger: literal,
      state: undefined,
    },
  );
  const invalidKind: trigger.TriggerRule<Num, string> = {
    // @ts-expect-error a trigger kind is "all" or "any"
    kind: "some",
    rule: [],
  };
  const rawRule: graph.trigger.TriggerRule<Num, string> = {
    kind: "all",
    // @ts-expect-error a rule lists edge IDs, not raw strings
    rule: ["left"],
  };
  // @ts-expect-error a number-message entry does not build a string-message rule
  const wrongMessage: trigger.TriggerRule<Str, string> =
    trigger.TriggerRule.allOf(leftEntry);
  // @ts-expect-error a string-result entry does not build a Date-result rule
  const wrongResult: graph.trigger.TriggerRule<Num, Date> =
    graph.trigger.TriggerRule.anyOf(leftEntry);
  return [
    ready,
    satisfied,
    spec,
    invalidKind,
    rawRule,
    wrongMessage,
    wrongResult,
  ];
}

/** A consumer tracer: its handles see the traced graph's own message and result payloads. */
class CountingTracer implements tracer.DataflowTracer {
  readonly events: string[] = [];

  startRun<S, N extends TSchema, T, EH>(
    traced: graph.DataflowGraph<S, N, T, EH>,
  ): tracer.DataflowRunTrace<N, T> {
    const events = this.events;
    events.push(`run:${traced.window}`);
    return {
      startNode(id, phase, inputs): tracer.DataflowStepTrace<N, T> {
        const edges: graph.EdgeIdType[] =
          inputs === undefined ? [] : [...inputs.messages.keys()];
        events.push(`${id}:${phase}:${edges.length}`);
        return {
          end(step) {
            const batch: readonly graph.Message<N>[] | undefined = step.done
              ? undefined
              : step.value;
            events.push(
              step.done ? "returned" : `emitted:${batch?.length ?? 0}`,
            );
          },
          fail(error) {
            events.push(`step-failed:${String(error)}`);
          },
        };
      },
      end(results) {
        events.push(`ended:${results.size}`);
      },
      fail(error) {
        events.push(`run-failed:${String(error)}`);
      },
    };
  }
}

export async function tracerHandlesRetainPayloadTypes(
  g: graph.DataflowGraph<Counter, Num, string, never>,
  id: graph.NodeIdType,
  view: graph.ParentView<Num, string>,
  edge: graph.Edge<Num, string>,
  source: graph.nodes.Source<Chat, AssistantMessage>,
  sink: graph.nodes.Sink<Chat, AssistantMessage>,
) {
  const counting = new CountingTracer();
  const tui: tracer.TuiTracer = await tracer.TuiTracer.create();
  const shared: tracer.TuiTracer | tracer.DummyTracer = tracer.TuiTracer.shared();
  const tracers: tracer.DataflowTracer[] = [
    counting,
    new tracer.DummyTracer(),
    tui,
    shared,
  ];
  const run: tracer.DataflowRunTrace<Num, string> = counting.startRun(g);
  const primed: tracer.DataflowStepTrace<Num, string> = run.startNode(
    id,
    "prime",
    undefined,
  );
  primed.end({ done: false, value: [] });
  const resumed: tracer.DataflowStepTrace<Num, string> = run.startNode(
    id,
    "resume",
    view,
  );
  resumed.end({ done: false, value: [graph.Message.create(edge, 2)] });
  resumed.end({ done: true, value: "two" });
  run.end(new Map([[id, "two"]]));
  // @ts-expect-error a step result is the node's string result type
  resumed.end({ done: true, value: 2 });
  // @ts-expect-error a run result map holds the node's result type
  run.end(new Map([[id, 2]]));
  // @ts-expect-error a step phase is "prime" or "resume"
  run.startNode(id, "restart", undefined);
  const traced = new graph.DataflowGraph<Counter, Num, string, never>(
    graph.Width.create(1),
    graph.UNBOUNDED,
    counting,
  );
  await tui.finish();
  // The caller retains the shared default it hands a factory-built graph, and narrows it to finish.
  const selected = tracer.TuiTracer.shared();
  new graph.JuncoGraph(
    source,
    sink,
    graph.Width.create(1),
    graph.UNBOUNDED,
    selected,
    tools.LockPolicy,
  );
  if (selected instanceof tracer.TuiTracer) await selected.finish();
  await tui.close();
  await tui[Symbol.asyncDispose]();
  return traced;
}

// --- schedules ------------------------------------------------------------------------------------

export async function typedSchedulerPolicyReadsPerEdge(
  edge: graph.Edge<Num, string>,
) {
  const g = new graph.DataflowGraph<Counter, Num, string, never>(
    graph.Width.create(1),
    graph.Width.create(2),
  );
  const choose: schedules.Scheduler<
    Counter,
    Num,
    string,
    { priority: number }
  > = schedules.choose({
    where: (snapshot, id) =>
      (snapshot.inputs.get(id)?.messages.get(edge.id)?.length ?? 0) > 0,
    rank: (snapshot, a, b) =>
      (snapshot.context.get(b)?.priority ?? 0) -
      (snapshot.context.get(a)?.priority ?? 0),
    width: (snapshot) => snapshot.threads,
  });
  const policy: schedules.Scheduler<
    Counter,
    Num,
    string,
    { priority: number }
  > = schedules.separate(
    (snapshot, id) => (snapshot.nodes.get(id)?.state.count ?? 0) > 0,
    choose,
    schedules.agent(async (snapshot) => [
      [...snapshot.available].filter((id) => snapshot.owned.has(id)),
    ]),
  );
  const execution = nativeContext({
    graph: g,
    scheduler: policy,
    describeNode: (_id, candidate) => ({
      priority: graph.from(candidate.view, edge).length,
    }),
    readInputs: (_id, candidate): InputSchedule =>
      candidate.status === "ready" ? new Map() : new Map([[edge.id, 2]]),
  });
  const selection: schedules.Decision = await policy({
    ...g.observe(),
    available: new Set(g.available().keys()),
    owned: new Set(g.observe().nodes.keys()),
    context: new Map(),
    plans: new Map(),
    history: [],
    threads: g.threads,
  });
  const results: ReadonlyMap<graph.NodeIdType, string> = await execution.run();
  const reads: InputSchedule[] = [...g.available().values()].map(triggerInputs);
  const rotation: schedules.Scheduler<
    Counter,
    number,
    string,
    { priority: number }
  > = schedules.roundRobin();
  const rawId: schedules.Decision = {
    // @ts-expect-error selected IDs are branded native IDs
    selected: [{ nodeId: "a", modelStrength: 2 }],
  };
  // @ts-expect-error a read is a count, "all" or "none"
  const unknownRead: MessageSchedule = "some";
  const wrongPayload: schedules.Scheduler<
    Counter,
    Str,
    string,
    { priority: number }
  > = () => ({ selected: [] });
  nativeContext({
    graph: g,
    // @ts-expect-error graph data types are inferred from the graph, not widened by the policy
    scheduler: wrongPayload,
    describeNode: () => ({ priority: 1 }),
  });
  return [selection, results, reads, rotation, rawId, unknownRead];
}

export function modelPolicyAndRequestPreserveCallerMetadata(
  options: schedules.PiOptions,
  request: schedules.SchedulerRequest<{ readonly priority: number }>,
  numeric: graph.JuncoGraph<Num, string>,
  textual: graph.JuncoGraph<Str, number>,
) {
  const policy = schedules.pi(options);
  const numbers = schedules.context({ graph: numeric, scheduler: policy });
  const strings = schedules.context({ graph: textual, scheduler: policy });
  const version: number = request.version;
  const threads: number | null = request.threads;
  const priorities: readonly (readonly [
    graph.NodeIdType,
    { readonly priority: number },
  ])[] = request.context;
  const selections: readonly schedules.Decision[] = request.history;
  const nativeFields: (string | undefined)[] = request.nodes.map(
    (node) => node.description,
  );
  // @ts-expect-error requests do not expose native state
  request.nodes[0]?.state;
  // @ts-expect-error metadata preserves its declared fields
  request.context[0]?.[1].label;
  // @ts-expect-error scheduler options are model-call options, not a session or tool harness
  const invalid: schedules.PiOptions = { ...options, tools: [] };
  return [
    numbers,
    strings,
    version,
    threads,
    priorities,
    selections,
    nativeFields,
    invalid,
  ];
}

// --- agent -----------------------------------------------------------------------------------------

function describeStep(step: agent.AgenticStep): string {
  switch (step.kind) {
    case "yield":
      return step.reasons
        .map((reason: agent.AgenticYieldReason) =>
          reason.kind === "policy"
            ? `denied:${reason.toolName}`
            : reason.reason,
        )
        .join(",");
    case "settled":
      return step.message.stopReason;
    case "failed":
      return String(step.error);
    default: {
      const exhausted: never = step;
      return exhausted;
    }
  }
}

/** A consumer subclass validating settlements by the admitted run's kind. */
class AuditedAgent extends agent.JuncoAgent<
  TaggedSkill,
  TaggedTemplate,
  TaggedTool
> {
  protected override validateSettlement(
    run: agent.AgenticRun,
    message: AssistantMessage,
  ): AssistantMessage {
    if (
      run.kind === "prompt_template" &&
      run.stopping &&
      run.signal?.aborted === true
    ) {
      throw new agent.JuncoAgentError("invalid_state", "template run stopped");
    }
    return message;
  }
}

export async function agentProtocolNarrowsSteps(
  protocol: agent.Agentic<TaggedSkill, TaggedTemplate, TaggedTool>,
  image: ImageContent,
) {
  const status: agent.AgenticStatus = protocol.status;
  const settlement: Promise<AssistantMessage> = protocol.prompt("look", {
    images: [image],
  });
  const queued: Promise<void>[] = [
    protocol.steer("steer", { images: [image] }),
    protocol.followUp("follow"),
    protocol.nextTurn("next", { images: [image] }),
  ];
  const tags: ("tool" | "skill" | "template" | undefined)[] = [
    protocol.getTools()[0]?.tag,
    protocol.getResources().skills?.[0]?.tag,
    protocol.getResources().promptTemplates?.[0]?.tag,
  ];
  const described: string[] = [];
  for await (const step of protocol) described.push(describeStep(step));
  const next: IteratorResult<agent.AgenticStep, void> = await protocol.next();
  if (!next.done) described.push(describeStep(next.value));
  const closing: Promise<IteratorResult<agent.AgenticStep, void>>[] = [
    protocol.return(),
    protocol.throw(new Error("stop")),
  ];
  try {
    await settlement;
  } catch (error) {
    if (error instanceof agent.JuncoAgentError) {
      const code: "invalid_argument" | "invalid_state" | "busy" | "closed" =
        error.code;
      described.push(code);
    }
  }
  const complaint: tools.Complaint = "blocked";
  const issue: tools.Issue<Num> = {
    nodeId: graph.NodeId.create("n"),
    messages: [],
    prompt: { messages: [] },
    complaint,
  };
  const complained = protocol.complain(issue);
  // @ts-expect-error a complaint string alone is not an issue
  protocol.complain("blocked");
  // @ts-expect-error an issue carries its messages and prompt
  protocol.complain({ nodeId: graph.NodeId.create("n"), complaint: "blocked" });
  described.push(String(complained));

  // @ts-expect-error a settled step carries its message
  const bareSettled: agent.AgenticStep = { kind: "settled" };
  // @ts-expect-error a failed step carries its error
  const bareFailed: agent.AgenticStep = { kind: "failed" };
  // @ts-expect-error an unknown lifecycle status is rejected
  const stopped: agent.AgenticStatus = "stopped";
  const timeout: agent.AgenticYieldReason = {
    // @ts-expect-error a yield reason is a tool or a policy denial
    kind: "timeout",
    toolCallId: "c",
    toolName: "t",
    reason: "r",
  };
  const toolRun: agent.AgenticRun = {
    // @ts-expect-error a run is a prompt, skill or prompt template
    kind: "tool",
    signal: undefined,
    stopping: false,
  };
  // @ts-expect-error JuncoAgentError codes are closed
  const unknownCode = new agent.JuncoAgentError("timeout", "late");
  return [
    status,
    queued,
    tags,
    described,
    closing,
    bareSettled,
    bareFailed,
    stopped,
    timeout,
    toolRun,
    unknownCode,
  ];
}

export async function agentFactoriesKeepSpecializations(
  native: agent.AgenticOptions<TaggedSkill, TaggedTemplate, TaggedTool>,
  skill: TaggedSkill,
  template: TaggedTemplate,
  tool: TaggedTool,
  plainSkill: Skill,
  image: ImageContent,
) {
  const options: agent.AgenticOptions<TaggedSkill, TaggedTemplate, TaggedTool> =
    {
      ...native,
      tools: [tool],
      resources: { skills: [skill], promptTemplates: [template] },
      prompt: "start",
      images: [image],
      tool_block: ["bash"],
    };
  const resolved: agent.JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool> =
    await agent.JuncoAgent.fromResolved(options);
  const yieldTool: tools.YieldTool = new tools.YieldTool();
  const createOptions: agent.JuncoAgentCreateOptions<
    Skill,
    PromptTemplate,
    tools.YieldTool
  > & {
    readonly tools: tools.YieldTool[];
  } = {
    provider: "faux",
    model: "plain",
    tools: [yieldTool],
    thinkingLevel: "high",
  };
  const explicit: agent.JuncoAgent<Skill, PromptTemplate, tools.YieldTool> =
    await agent.JuncoAgent.create(createOptions);
  const owned: agent.JuncoAgent<TaggedSkill, TaggedTemplate, AgentTool> =
    await agent.JuncoAgent.create<TaggedSkill, TaggedTemplate>({
      provider: "faux",
      model: "plain",
      cwd: "/tmp",
      resources: { skills: [skill] },
    });
  const paused = await yieldTool.execute("call-1", { reason: "waiting" });
  const details: tools.YieldToolDetails = paused.details;
  const reason: string = details.reason;
  const audited: typeof AuditedAgent = AuditedAgent;
  const agents: agent.Agentic[] = [resolved, explicit, owned];

  // @ts-expect-error yield requires its reason
  await yieldTool.execute("call-2", {});
  // @ts-expect-error create requires a provider
  const noProvider: agent.JuncoAgentCreateOptions = {
    model: "plain",
  };
  const minimal: agent.JuncoAgentCreateOptions = {
    provider: "faux",
    model: "plain",
  };
  const malformedBlock: agent.AgenticOptions = {
    ...native,
    // @ts-expect-error tool_block entries are tool-name strings
    tool_block: [1],
  };
  const malformedResources: agent.AgenticOptions<TaggedSkill>["resources"] = {
    // @ts-expect-error specialized resources reject an untagged skill
    skills: [plainSkill],
  };
  // @ts-expect-error specialized tools reject an untagged tool
  const malformedTools: TaggedCreateTools = [yieldTool];
  // @ts-expect-error an image-bearing command takes image content, not a path
  await resolved.prompt("look", { images: ["image.png"] });
  return [
    reason,
    audited,
    agents,
    noProvider,
    minimal,
    malformedResources,
    malformedTools,
    malformedBlock,
  ];
}

// --- tools and flat LSP ----------------------------------------------------------------------------

export async function toolFactoriesAreConsumerAgentTools(
  cwd: string,
  native: tools.NativeModule,
  mux: tools.NativeMux,
  store: tools.EditStore,
  base: agent.AgenticOptions,
  signal: AbortSignal,
) {
  const operations: tools.ShellMuxOperations = new tools.ShellMuxOperations({
    principal: "typed",
    native,
    mux,
  });
  const chunks: Buffer[] = [];
  const exit: { exitCode: number | null } = await operations.exec(
    "printf ok",
    cwd,
    {
      onData: (data: Buffer) => void chunks.push(data),
      signal,
      timeout: 5,
    },
  );
  const failed: boolean = exit.exitCode === null || exit.exitCode !== 0;
  const bashOptions = {
    operations,
    commandPrefix: "set -e",
  } satisfies tools.BashToolOptions;
  const bashInput: tools.BashToolInput = { command: "printf ok", timeout: 5 };
  const bash = tools.BashTool.create(cwd, bashOptions);
  const bashResult = await bash.execute("bash-1", bashInput, signal);
  const bashDetails: tools.BashToolDetails | undefined = bashResult.details;
  const truncated: string | undefined = bashDetails?.fullOutputPath;

  const edit = tools.EditTool.create(cwd, store, native, mux);
  const edited = await edit.execute("edit-1", {
    input: "[a.ts#ABCD]\nPUT 1.=1:\n+x",
  });
  const editDetails: tools.HashlineEditDetails = edited.details;
  const outcomes: string[] = editDetails.files.map(
    (file) => `${file.op}:${file.displayPath}:${file.warnings.length}`,
  );

  const collection: tools.ToolCollection = await tools.ToolCollection.create(
    cwd,
    {
      bash: bashOptions,
      native,
      policy: tools.LockPolicy,
      principal: "typed",
    },
  );
  const borrowed: { close(): Promise<void> } = collection.lease();
  const collectionPolicy: tools.Policy = collection.policy;
  // Policies are open: any implementation composes with the shipped ones.
  const denyAll: tools.Policy = {
    toNative: (native) => native.NativePolicy.not(native.NativePolicy.empty()),
  };
  const composed: tools.Policy = tools.Policy.and(
    tools.Policy.or(tools.LockPolicy, denyAll),
    tools.Policy.not(tools.EmptyPolicy),
  );
  const collectionOptions: tools.ToolCollectionOptions = {
    sandbox: "always",
    policy: tools.EmptyPolicy,
    principal: "owned",
  };
  const unselected: tools.ToolCollectionOptions = { sandbox: "always" };
  // @ts-expect-error a collection opens its own mux
  await tools.ToolCollection.create(cwd, { policy: tools.LockPolicy, mux });
  await tools.ToolCollection.create(cwd);
  const agentTools: AgentTool[] = [new tools.YieldTool()];
  const nativeAgent = await agent.JuncoAgent.fromResolved({
    ...base,
    collection,
    tools: agentTools,
  });

  try {
    await borrowed.close();
    await collection.close();
  } catch (error) {
    if (tools.isMarshPolicyDenied(error)) {
      const denied: tools.MarshPolicyDeniedError = error;
      const code: "MARSH_POLICY_DENIED" = denied.code;
      void code;
    }
  }
  const deniedCode: typeof tools.MARSH_POLICY_DENIED = "MARSH_POLICY_DENIED";

  // @ts-expect-error bash requires a command
  const noCommand: tools.BashToolInput = { timeout: 5 };
  // @ts-expect-error a bash timeout is a number of seconds
  const stringTimeout: tools.BashToolInput = { command: "true", timeout: "5" };
  // @ts-expect-error a command prefix is a string
  const numericPrefix: tools.BashToolOptions = { commandPrefix: 1 };
  const invalidSandbox: tools.ToolCollectionOptions = {
    policy: tools.LockPolicy,
    // @ts-expect-error a collection sandbox is "shared" or "always"
    sandbox: "never",
  };
  // @ts-expect-error streamed output is a Buffer
  await operations.exec("true", cwd, { onData: (data: string) => void data });
  return [
    chunks,
    failed,
    truncated,
    outcomes,
    collectionOptions,
    unselected,
    collectionPolicy,
    composed,
    nativeAgent,
    deniedCode,
    noCommand,
    stringTimeout,
    numericPrefix,
    invalidSandbox,
  ];
}

export async function lspToolTypesThroughBothRoutes(
  cwd: string,
  base: agent.AgenticOptions,
  native?: tools.NativeModule,
  mux?: tools.NativeMux,
) {
  const options: tools.LspToolOptions = { readOnly: true, native, mux };
  const routedOptions: tools.LspToolOptions = { readOnly: false, native, mux };
  const flat: tools.LspTool = await tools.LspTool.create(cwd, options);
  const routed: tools.LspTool = await tools.LspTool.create(cwd, routedOptions);
  const execute: tools.LspTool["execute"] = flat.execute;
  const routedExecute: tools.LspTool["execute"] = routed.execute;
  if (native) {
    const handle = await native.NativeLsp.open(cwd, { readOnly: true }, mux);
    const call: InstanceType<tools.NativeModule["NativeLspCall"]> =
      handle.start({ action: "status" });
    const result = await call.wait();
    const success: boolean = result.details.success;
    call.abort();
    await handle.close();
    void success;
  }
  const status: tools.LspToolInput = { action: "status" };
  const diagnostics: tools.LspToolInput = {
    action: "diagnostics",
    file: "src/index.ts",
    timeout: 20,
  };
  const results = [
    await execute("status-1", status),
    await routedExecute("diagnostics-1", diagnostics),
  ];
  const details: (tools.LspToolDetails | undefined)[] = results.map(
    (result) => result.details,
  );
  const succeeded: boolean[] = details.map(
    (each) => each?.success === true && each.action.length > 0,
  );
  const routedDetails: tools.LspToolDetails | undefined = details[0];
  const lspAgent = await agent.JuncoAgent.fromResolved({
    ...base,
    tools: [flat, routed],
  });
  await tools.LspTool.shutdown();
  await tools.LspTool.shutdown();

  // @ts-expect-error an LSP action outside the supported set is rejected
  const unknownAction: tools.LspToolInput = { action: "format" };
  const textLine: tools.LspToolInput = {
    action: "hover",
    file: "a.ts",
    // @ts-expect-error an LSP line is one-based numeric
    line: "1",
    symbol: "x",
  };
  // @ts-expect-error readOnly is a boolean
  const textReadOnly: tools.LspToolOptions = { readOnly: "yes" };
  return [
    succeeded,
    routedDetails,
    lspAgent,
    unknownAction,
    textLine,
    textReadOnly,
  ];
}

// --- shared ShellMux and MCP definitions -------------------------------------------------------------

export async function independentShellMuxLeases(
  cwd: string,
  native: tools.NativeModule,
) {
  const lease: tools.ShellMuxLease = await tools.ShellMuxLease.create(cwd, {
    native,
    policy: tools.LockPolicy,
  });
  const other: tools.ShellMuxLease = await tools.ShellMuxLease.create(cwd, {
    native,
    sandbox: "always",
    policy: tools.EmptyPolicy,
  });
  const independent: boolean = lease.mux !== other.mux && !lease.closed;
  const mode: "shared" | "always" = lease.mux.sandbox;
  await lease.mux.validateCwd(cwd);
  const process: tools.NativeProcess = await lease.mux.spawn(
    { command: "true", cwd, principal: "typed", env: {} },
    (error: Error | null, data: Buffer) => void [error, data],
    (error: Error | null, data: Buffer) => void [error, data],
  );
  const finished: tools.NativeRunResult = await process.finish(500);
  const processOptions: tools.NativeProcessOptions = {
    command: "true",
    args: ["a"],
    cwd,
    principal: "typed",
    env: {},
  };
  const released: Promise<void> = lease.release();
  await released;
  await other.release();

  // @ts-expect-error a lease's sandbox is "shared" or "always"
  await tools.ShellMuxLease.create(cwd, { sandbox: "never" });
  await tools.ShellMuxLease.create(cwd, { native });
  // @ts-expect-error a lease opens its own mux
  await tools.ShellMuxLease.create(cwd, { mux: other.mux });
  // @ts-expect-error a lease is released, not closed
  await lease.close();
  return [independent, mode, finished, processOptions];
}

export async function mcpDefinitionsComposeWithAgentFactories(
  cwd: string,
  base: agent.AgenticOptions,
  tool: TaggedTool,
  lsp: tools.LspTool,
  collection: tools.ToolCollection,
) {
  const server: mcp.JuncoMcpServerOptions = {
    name: "graft",
    type: "stdio",
    command: "npx",
    args: ["-y", "@nanonets/graft", "mcp"],
    cwd: ".",
    env: { GRAFT: "1" },
    inheritEnv: true,
    stderr: "pipe",
    onStderr: (chunk: string) => void chunk,
    closeTimeoutMs: 2_000,
    clientOptions: { requestTimeoutMs: 60_000 },
  };
  const graft: mcp.JuncoMcpTools = mcp.JuncoMcpTools.add(server);
  const chained: mcp.JuncoMcpTools = new mcp.JuncoMcpTools()
    .add(server)
    .add({ ...server, name: "second" });
  const connectOptions: mcp.JuncoMcpConnectOptions = { cwd, collection };
  const connectionLifetime: mcp.JuncoMcpConnectOptions = {
    cwd,
    collection,
    toolLifetime: "connection",
  };
  const callLifetime: mcp.JuncoMcpConnectOptions = {
    cwd,
    collection,
    toolLifetime: "call",
  };
  // @ts-expect-error only connection and call lifetimes are supported
  const unknownLifetime: mcp.JuncoMcpConnectOptions = { toolLifetime: "batch" };
  const connection: mcp.JuncoMcpConnection =
    await graft.connect(connectOptions);
  const discovered: AgentTool[] = connection.tools;
  await connection.close();

  const sources: agent.JuncoAgentTools = [graft, lsp, ...collection.tools];
  const mcpOnly: agent.JuncoAgent<Skill, PromptTemplate, AgentTool> =
    await agent.JuncoAgent.create({
      provider: "faux",
      model: "plain",
      cwd,
      tools: graft,
    });
  const mixed: agent.JuncoAgent = await agent.JuncoAgent.create({
    provider: "faux",
    model: "plain",
    cwd,
    tools: [graft, lsp, ...collection.tools, tool],
    collection,
  });
  const resolvedOptions: agent.JuncoAgentResolvedOptions = {
    ...base,
    cwd,
    tools: sources,
  };
  const resolved: agent.JuncoAgent =
    await agent.JuncoAgent.fromResolved(resolvedOptions);
  // Ordinary arrays keep their specialization through both factories.
  const specialized: agent.JuncoAgent<Skill, PromptTemplate, TaggedTool> =
    await agent.JuncoAgent.fromResolved({ ...base, cwd, tools: [tool] });

  // @ts-expect-error a stdio server needs its command
  const noCommand: mcp.JuncoMcpServerOptions = { name: "x", type: "stdio" };
  const unknownTransport: mcp.JuncoMcpServerOptions = {
    name: "x",
    // @ts-expect-error stdio is the only transport
    type: "sse",
    command: "server",
  };
  // @ts-expect-error definitions are factory-only sources, not concrete tools
  await mixed.setTools([graft]);
  const narrowed: agent.JuncoAgent<Skill, PromptTemplate, AgentTool> = mixed;
  return [
    chained,
    connectionLifetime,
    callLifetime,
    unknownLifetime,
    discovered,
    mcpOnly,
    resolved,
    specialized,
    noCommand,
    unknownTransport,
    narrowed,
  ];
}

export async function taskToolsAndSubagentsKeepTheirContracts(
  specialized: agent.JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
  definition: mcp.JuncoMcpTools,
  signal: AbortSignal,
) {
  const host: tools.TaskToolHost = async (_toolCallId, input, hostSignal) => {
    hostSignal.throwIfAborted();
    if ("action" in input)
      return input.action === "retry" ? [{ id: input.id }] : [];
    return input.tasks.map(({ name }, index) => ({
      id: `task-${index}`,
      ...(name === undefined ? {} : { name }),
    }));
  };
  const task = new tools.TaskTool(host);
  const precise: AgentTool<typeof task.parameters, tools.TaskToolDetails> =
    task;
  const unhosted: AgentTool = new tools.TaskTool();
  const branded: boolean = tools.TaskTool.is(unhosted);
  const admitted = await task.invoke(
    host,
    "call-1",
    {
      context: "shared",
      tasks: [
        { task: "a", name: "a", model: { provider: "p", modelId: "m" } },
        { task: "b", tools: [] },
      ],
    },
    signal,
  );
  const details: tools.TaskToolDetails = admitted.details;
  const firstId: string | undefined = details.tasks[0]?.id;
  const overrides: agent.TaskAgentOptions[] = [
    { model: { provider: "p", modelId: "m" } },
    { tools: ["read"] },
  ];
  // Children carry dynamically discovered MCP tools, so they are broad AgentTool agents.
  const children: agent.JuncoAgent<TaggedSkill, TaggedTemplate, AgentTool>[] =
    await specialized.createSubagents(overrides, signal);
  const bound: number = await specialized.runWithNodeContext(
    { briefing: () => undefined },
    async () => 1,
  );
  const batch: tools.TaskInput = { context: "c", tasks: [{ task: "x" }] };
  const assigned: tools.AssignedTaskTool = new tools.AssignedTaskTool(
    batch,
    host,
  );
  const assignedTool: AgentTool<
    typeof assigned.parameters,
    tools.TaskToolDetails
  > = assigned;
  const assignedOnly: boolean = tools.AssignedTaskTool.is(unhosted);
  const explicit: tools.TaskToolHost | undefined = assigned.host;
  const launched = await assigned.invoke(host, "call-6", {}, signal);
  const decision: tools.TaskDecision = { action: "retry", id: "t", attempt: 1 };
  const call: tools.TaskCall = decision;
  const retried = await task.invoke(host, "call-7", call, signal);
  const configured: Promise<void> = specialized.setTaskBatch(batch);
  const failurePolicy: agent.TaskFailurePolicy =
    specialized.getTaskFailurePolicy();
  specialized.setTaskFailurePolicy("ignore");
  specialized.setTaskFailurePolicy({ retries: 2 });
  const snapshot: mcp.JuncoMcpTools = definition.snapshot();
  const identity: mcp.JuncoMcpToolIdentity | undefined =
    mcp.getJuncoMcpToolIdentity(unhosted);
  const cancellable: mcp.JuncoMcpConnectOptions = { signal };

  await task.invoke(
    host,
    "call-2",
    // @ts-expect-error a task needs its instructions
    { context: "c", tasks: [{ name: "x" }] },
    signal,
  );
  await task.invoke(
    host,
    "call-3",
    // @ts-expect-error a model override names its provider and model ID
    { context: "c", tasks: [{ task: "x", model: { provider: "p" } }] },
    signal,
  );
  await task.invoke(
    host,
    "call-4",
    // @ts-expect-error a tool subset lists tool names
    { context: "c", tasks: [{ task: "x", tools: [1] }] },
    signal,
  );
  await task.invoke(
    host,
    "c",
    // @ts-expect-error a decision retries or ignores
    { action: "redo", id: "x", attempt: 1 },
    signal,
  );
  // @ts-expect-error a failure policy ignores or bounds retries
  specialized.setTaskFailurePolicy("retry");
  // @ts-expect-error hosts receive the input directly, not a request wrapper
  await task.invoke(host, { toolCallId: "c", input: {} }, signal);
  // @ts-expect-error a handle ID is a string
  const badHandles: tools.TaskToolDetails = { tasks: [{ id: 1 }] };
  const narrowedChildren: agent.JuncoAgent<
    TaggedSkill,
    TaggedTemplate,
    AgentTool
  >[] = children;
  return [
    branded,
    assignedOnly,
    precise,
    assignedTool,
    launched,
    retried,
    configured,
    failurePolicy,
    firstId,
    bound,
    explicit,
    snapshot,
    identity,
    cancellable,
    badHandles,
    narrowedChildren,
  ];
}

export async function messagingToolsAreNominalAgentTools(
  _specialized: agent.JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
  view: graph.ParentView<Num, string>,
  signal: AbortSignal,
) {
  const numbersRoute = [graph.EdgeId.create("numbers"), NumberSchema] as const;
  const host = {
    view,
    sendParameters: tools.SendTool.parametersFor([numbersRoute]),
    recvOutputSchema: tools.RecvTool.outputSchemaFor(
      [numbersRoute],
      [[graph.EdgeId.create("done"), StringSchema]],
    ),
    consume: () => {},
    send: (_message: graph.Message<Num>) => {},
    info: () => ({
      parents: [
        {
          id: graph.NodeId.create("source"),
          edgeId: graph.EdgeId.create("numbers"),
          kind: "message" as const,
        },
      ],
      children: [],
    }),
  };
  const recv: tools.RecvTool<Num, string> = new tools.RecvTool(host);
  const send: tools.SendTool<Num> = new tools.SendTool(host);
  const info: tools.InfoTool = new tools.InfoTool(host);
  const unhosted: tools.RecvTool = new tools.RecvTool();
  // Constructed values are AgentTools without unwrapping.
  const loadout: AgentTool[] = [recv, send, info, unhosted];
  const recognized: boolean[] = [
    tools.RecvTool.is(loadout[0]!),
    tools.SendTool.is(loadout[1]!),
    tools.InfoTool.is(loadout[2]!),
  ];
  const received = await tools.RecvTool.invoke<Num, string>(
    recv,
    host,
    "recv-1",
    {},
    signal,
  );
  const messages: readonly graph.Message<Num>[] = received.details.messages;
  const values: readonly {
    readonly id: graph.EdgeIdType;
    readonly payload: string;
  }[] = received.details.values;
  await tools.SendTool.invoke(
    send,
    host,
    "send-1",
    { id: "numbers", payload: 1 },
    signal,
  );
  const described = await tools.InfoTool.invoke(
    info,
    host,
    "info-1",
    {},
    signal,
  );
  const route = described.details.parents[0];
  const routeId: graph.NodeIdType | undefined = route?.id;
  const routeEdge: graph.EdgeIdType | undefined = route?.edgeId;
  const routeKind: "message" | "value" | undefined = route?.kind;

  // @ts-expect-error a copied carrier is not a nominal recv tool
  const plainRecv: tools.RecvTool<Num, string> = { ...recv };
  // @ts-expect-error a copied carrier is not a nominal send tool
  const plainSend: tools.SendTool = { ...send };
  // @ts-expect-error a copied carrier is not a nominal info tool
  const plainInfo: tools.InfoTool = { ...info };
  // @ts-expect-error the constructors require new
  void tools.RecvTool();
  // @ts-expect-error send names its edge
  await tools.SendTool.invoke(send, host, "send-2", { payload: 1 }, signal);
  return [
    recognized,
    messages,
    values,
    routeId,
    routeEdge,
    routeKind,
    plainRecv,
    plainSend,
    plainInfo,
  ];
}

export async function profileRecordersAreOneSharedInterface(
  jsonl: tracer.JsonlRecorder,
) {
  const grafana: tracer.GrafanaRecorder = await tracer.GrafanaRecorder.create();
  const full: tracer.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  > = grafana;
  const fromJsonl: tracer.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  > = new tracer.JsonlRecorder({ path: "samples.jsonl", monitored: true });
  // The `tools` and `tracer` names are the same imported interface.
  const memory: tools.ProfileRecorder<"memory"> =
    full.add_context("standalone");
  const same: tracer.ProfileRecorder<"memory"> = memory;
  const url: string = grafana.dashboardUrl;
  const stream: string = grafana.streamId;
  // @ts-expect-error ProfileRecorder is type-only
  void new tracer.ProfileRecorder();
  return [jsonl, fromJsonl, same, url, stream];
}

export async function profileOptimizerIsAStandardWorkflow(signal: AbortSignal) {
  const yaml: string = workflows.optimizer;
  const request: schedules.OptimizationRequest = {
    target: {
      yaml: "/work/workflow.yml",
      ts: "/work/workflow.ts",
      cwd: "/work",
      argv: ["bun", "run", "workflow.ts"],
    },
    sessionDir: "/work/.junco/profile-optimizer/session-1",
    workloadId: "fixed-corpus",
    objective: { metric: { kind: "tokens" }, direction: "minimize" },
    constraints: [
      {
        metric: {
          kind: "probe",
          node: "",
          edgeId: "quality",
          reduce: "single",
        },
        op: ">=",
        threshold: 0.9,
      },
    ],
    qualityConstraint: 0,
    repeats: 3,
    stop: { improvement: { kind: "relative", value: 0.2 } },
    axes: ["scheduler", "ladder", "limits"],
    allowedModels: [{ model: "provider/model", thinking: "low" }],
    limitBounds: { tokens: 20_000 },
  };
  const state: schedules.OptimizationState = await schedules.runOptimizer(
    request,
    {
      signal,
      editorRung: { model: "provider/editor" },
    },
  );
  const kind:
    | "converged"
    | "cancelled"
    | "budget"
    | "blocked"
    | "failed"
    | undefined = state.stop?.kind;
  const incumbent: number | null = state.anchor.score;
  const spread: number | undefined =
    state.anchor.stats?.objective.standardDeviation;
  const key: string = state.anchor.candidate.key;
  const invalid: schedules.OptimizationRequest = {
    ...request,
    // @ts-expect-error an objective direction is "minimize" or "maximize"
    objective: { metric: { kind: "memory" }, direction: "lower" },
  };
  return [yaml, kind, incumbent, spread, key, invalid];
}

export function ralphSuccessModeTypes() {
  const until: schedules.RalphPredicate = (result, context) => {
    const message: AssistantMessage = result;
    const assignment: string = context.assignment;
    const round: number = context.round;
    const label: string = context.label;
    return message.stopReason === "stop" && round > 0 && label !== assignment;
  };
  const uncapped: schedules.RalphOptions = { until };
  const capped: schedules.RalphOptions = { until, rounds: 5 };
  const fixed: schedules.RalphOptions = { rounds: 3 };
  // @ts-expect-error until is synchronous; a Promise is not a decision
  const asynchronous: schedules.RalphPredicate = async () => true;
  return [
    schedules.ralph(uncapped),
    schedules.ralph(capped),
    schedules.ralph(fixed),
    asynchronous,
  ];
}

export function fanInSelectorTypes() {
  const all: string = workflows.allFanIn;
  const any: string = workflows.anyFanIn;
  // The controller spreads into `JuncoGraph.fromYaml` options beside Ralph's hooks.
  const controller: Pick<syntax.FromYamlOptions, "available" | "code"> =
    schedules.anyFanIn();
  const ralph: Pick<syntax.FromYamlOptions, "available"> = schedules.ralph();
  const merged: Pick<syntax.FromYamlOptions, "available" | "code"> = {
    ...controller,
    available: { ...ralph.available, ...controller.available },
  };
  return [all, any, merged];
}

export function scopedMemoryTypes(tool: AgentTool, nodeId: graph.NodeIdType) {
  const options: tools.JuncoMemoryOptions = { directory: ".junco/memory" };
  const memory = new tools.JuncoMemory(options);
  const collection: tools.ToolCollectionOptions = { memory };
  const context: agent.JuncoAgentNodeContext = { nodeId };
  const unrelated: agent.JuncoAgentNodeContext = {};
  const genuine: boolean = tools.isMemoryTool(tool);
  const result = tools.invokeMemoryTool(tool, nodeId, "call", {
    text: "memory",
  });
  tools.invokeMemoryTool(tool, undefined, "unbound", {});
  // @ts-expect-error directory is required
  new tools.JuncoMemory({});
  // @ts-expect-error directory must be a string
  new tools.JuncoMemory({ directory: 1 });
  // @ts-expect-error host identities must be branded
  tools.invokeMemoryTool(tool, "Worker", "call", {});
  // @ts-expect-error context identities must be branded
  const invalid: agent.JuncoAgentNodeContext = { nodeId: "Worker" };
  return { memory, collection, context, unrelated, genuine, result, invalid };
}

export function memoryWorkflowTypes(memory: tools.JuncoMemory) {
  const ralph: string = workflows.memoryRalphLoop;
  const fanIn: string = workflows.memoryFanIn;
  const fanOut: string = workflows.memoryFanOut;
  const options: schedules.MemoryScheduleOptions = {
    memory,
    ralph: {
      rounds: 3,
      until: (result, context) => {
        const assignment: string = context.assignment;
        const round: number = context.round;
        return (
          result.stopReason === "stop" && assignment.length > 0 && round > 0
        );
      },
    },
  };
  const controller = schedules.memory(options);
  const available: NonNullable<syntax.BuildOptions["available"]> =
    controller.available;
  const code: {
    readonly Memory: syntax.DeterministicNode;
    readonly AnyFanInPublish: syntax.DeterministicNode;
  } = controller.code;
  const exactCodeKeys: keyof typeof controller.code = "Memory";
  const hooks: Pick<syntax.FromYamlOptions, "available" | "code"> = controller;
  schedules.memory({ memory });
  // @ts-expect-error a caller-owned memory wrapper is required
  schedules.memory({});
  // @ts-expect-error memory options are required
  schedules.memory();
  // @ts-expect-error a directory is not a JuncoMemory wrapper
  schedules.memory({ memory: { directory: ".junco/memory" } });
  // @ts-expect-error memory Ralph predicates must decide synchronously
  schedules.memory({ memory, ralph: { until: async () => true } });
  // @ts-expect-error the helper does not generate worker code nodes
  const worker: keyof typeof controller.code = "Worker";
  return {
    ralph,
    fanIn,
    fanOut,
    available,
    code,
    exactCodeKeys,
    hooks,
    worker,
  };
}
