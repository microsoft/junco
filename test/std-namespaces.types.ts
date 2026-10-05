// Compile-only: every type exported through the root `graph`, `trigger`, `tracer`, `schedulers`,
// `agent`, `tools` and `mcp` namespaces, plus the flat LSP types, used as a consumer would: typed
// construction, callbacks and narrowing, with deliberate rejections. Detailed generic rules stay in
// the engine and scheduler fixtures. Covered by tsconfig.typecheck.json; never executed.

import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type * as O from "fp-ts/lib/Option.js";
import {
  agent,
  graph,
  LspTool,
  type LspToolDetails,
  type LspToolInput,
  type LspToolOptions,
  mcp,
  schedulers,
  tools,
  tracer,
  trigger,
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

// --- graph: typed node construction and reading ---------------------------------------------------

export async function graphTypesBuildAndReadTypedNodes(
  g: graph.DataflowGraph<Counter, number, string, never>,
  source: graph.NodeIdType,
) {
  const numbers: graph.Edge<number, string> = graph.messageEdge<number, string>(
    "numbers",
  );
  const done: graph.Edge<number, string> = graph.valueEdge<number, string>(
    "done",
  );
  const numbersId: graph.EdgeIdType = numbers.id;
  const doneId: graph.EdgeId = graph.EdgeId("done");
  const sinkId: graph.NodeId = graph.NodeId("sink");
  const window: graph.Width = graph.Width(2);
  const threads: graph.WidthType = graph.UNBOUNDED;
  const queued: graph.Queue<number> = graph.Queue([1, 2]);
  const empty: graph.Queue<number> = graph.emptyQueue<number>();
  queued.push(3);
  const sent: graph.Message<number> = graph.msg(
    numbers,
    queued.shift() ?? empty.length,
  );

  const bounded = <W extends number>(width: graph.ValidWidth<W>): graph.Width =>
    graph.Width<W>(width);
  const widths: graph.WidthType[] = [window, threads, bounded(4)];

  const messages: graph.Lookup<graph.EdgeIdType, readonly number[]> = new Map([
    [numbersId, [1, 2]],
  ]);
  const values: graph.Lookup<graph.EdgeIdType, string> = new Map([
    [doneId, "finished"],
  ]);
  const view: graph.ParentView<number, string> = { messages, values };
  const fromView: readonly number[] = graph.from(view, numbers);

  const availability: graph.AvailabilityFn<number, string> = (
    current,
    triggered,
  ) => triggered && graph.from(current, numbers).length > 0;
  const step: graph.StepFn<Counter, number, string> = async function* (
    this: graph.Node<Counter, number, string>,
  ): graph.NodeGenerator<number, string> {
    let current: graph.ParentView<number, string> = yield [];
    while (current.values.get(doneId) === undefined) {
      this.state.count += graph.from(current, numbers).length;
      const status: graph.NodeStatus = this.status;
      current = yield status === "running"
        ? [graph.msg(numbers, this.state.count)]
        : [];
    }
    return `${this.state.count}`;
  };
  const options: graph.NodeOptions<number, string> = {
    id: sinkId,
    description: "counts numbers until done",
    trigger: graph.trigger.anyOf<number, string>(
      trigger.on(numbers),
      trigger.on(done),
    ),
    is_available: availability,
  };
  const recover: graph.ErrorFn<Counter, number, string> = async function (
    this: graph.Node<Counter, number, string>,
    error: unknown,
    signal: AbortSignal | undefined,
  ): Promise<readonly graph.Message<number>[]> {
    signal?.throwIfAborted();
    return error instanceof Error ? [graph.msg(numbers, this.state.count)] : [];
  };
  const spec: graph.NodeSpec<Counter, number, string> = {
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

  const node: graph.Node<Counter, number, string> | undefined = g.getNode(id);
  const identified: graph.Identifiable<graph.NodeIdType> | undefined = node;
  const counted: number | undefined = node?.state.count;
  const generator: graph.NodeGenerator<number, string> | undefined =
    node?.generator;
  const runOptions: graph.DataflowRunOptions = {
    signal: new AbortController().signal,
  };
  const results: ReadonlyMap<graph.NodeIdType, string> =
    await g.run(runOptions);
  const result: O.Option<string> = g.result(id);
  const finalStatus: graph.NodeStatus | undefined = node?.status;

  const leaf: graph.Pretty = { pretty: () => "leaf" };
  const rendered: string[] = [graph.renderPretty(leaf), graph.renderPretty(g)];

  try {
    await g.step();
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
  const wrongPayload: graph.Message<number> = { id: numbersId, payload: "one" };
  // @ts-expect-error msg rejects a payload of the wrong type
  graph.msg(numbers, "one");
  // @ts-expect-error a node spec requires its step
  const incomplete: graph.NodeSpec<Counter, number, string> = {
    trigger: graph.trigger.always(),
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
  root: graph.nodes.AgenticNode<number, string>,
  child: (label: string) => graph.nodes.AgenticNode<number, string>,
  stringChild: graph.nodes.AgenticNode<string, string>,
  bare: graph.nodes.Agentic<number, string>,
  state: graph.nodes.Deterministic<number, string>,
  lead: agent.JuncoAgent,
  worker: agent.JuncoAgent,
) {
  const tasks: readonly Task[] = [{ label: "a" }, { label: "b" }];
  const typed: graph.JuncoGraph<number, string> = graph.Spawn(
    root,
    tasks,
    (task) => {
      const inferred: Task = task;
      // @ts-expect-error the factory input is the list's element type
      task.missing;
      return child(inferred.label);
    },
  );
  const defaults: graph.JuncoGraph = graph.Spawn(
    graph.nodes.agentNode(lead, { trigger: trigger.never() }),
    tasks,
    () => graph.nodes.agentNode(worker, { trigger: trigger.never() }),
  );
  // @ts-expect-error the root must be an adapted node, not a bare state
  graph.Spawn(bare, tasks, (task) => child(task.label));
  // @ts-expect-error the factory must return an adapted node, not a bare state
  graph.Spawn(root, tasks, () => state);
  // @ts-expect-error the factory must return a node, not an arbitrary value
  graph.Spawn(root, tasks, (task) => task.label);
  // @ts-expect-error a string-message child cannot join a number-wired star
  graph.Spawn<Task, number, string>(root, tasks, () => stringChild);
  return [typed, defaults];
}

// --- trigger and tracer ----------------------------------------------------------------------------

export function triggerRulesDriveTypedNodes(
  left: graph.Edge<number, string>,
  right: graph.Edge<number, string>,
) {
  const kind: trigger.TriggerKind = "any";
  const leftEntry: trigger.TriggerEntry<number, string> = trigger.on(left);
  const literal: trigger.TriggerRule<number, string> = {
    kind,
    rule: [leftEntry, trigger.on(right)],
  };
  const nested: graph.trigger.TriggerRule<number, string> =
    graph.trigger.allOf(leftEntry);
  const rules: trigger.TriggerRule<number, string>[] = [
    literal,
    nested,
    trigger.when(right),
    trigger.always(),
    trigger.never(),
  ];
  const inbound = new Map<graph.EdgeIdType, graph.Edge<number, string>>([
    [left.id, left],
    [right.id, right],
  ]);
  const sink = graph.NodeId("sink");
  const ready: boolean[] = rules.map((rule) =>
    trigger.evaluateTrigger(rule, inbound, sink),
  );
  const satisfied: (readonly graph.EdgeIdType[])[] = rules.map((rule) =>
    trigger.satisfiedEdges(rule, inbound, sink),
  );
  const spec: graph.NodeSpec<undefined, number, string> = {
    trigger: literal,
    state: undefined,
    step: graph.nodes.emitOnce(() => [graph.msg(left, 1)], "once"),
  };
  const invalidKind: trigger.TriggerRule<number, string> = {
    // @ts-expect-error a trigger kind is "all" or "any"
    kind: "some",
    rule: [],
  };
  const rawRule: graph.trigger.TriggerRule<number, string> = {
    kind: "all",
    // @ts-expect-error a rule lists edge IDs, not raw strings
    rule: ["left"],
  };
  // @ts-expect-error a number-message entry does not build a string-message rule
  const wrongMessage: trigger.TriggerRule<string, string> =
    trigger.allOf(leftEntry);
  // @ts-expect-error a string-result entry does not build a Date-result rule
  const wrongResult: graph.trigger.TriggerRule<number, Date> =
    graph.trigger.anyOf(leftEntry);
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

  startRun<S, N, T, EH>(
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

  complain(nodeId: graph.NodeIdType, complaint: string): void {
    this.events.push(`complain ${nodeId} ${complaint}`);
  }

  async flush(): Promise<void> {
    this.events.length = 0;
  }
}

export async function tracerHandlesRetainPayloadTypes(
  g: graph.DataflowGraph<Counter, number, string, never>,
  id: graph.NodeIdType,
  view: graph.ParentView<number, string>,
  edge: graph.Edge<number, string>,
) {
  const counting = new CountingTracer();
  const tracers: tracer.DataflowTracer[] = [
    counting,
    new tracer.DummyTracer(),
    new tracer.StdoutTracer(),
    tracer.createTracer(),
  ];
  const run: tracer.DataflowRunTrace<number, string> = counting.startRun(g);
  const primed: tracer.DataflowStepTrace<number, string> = run.startNode(
    id,
    "prime",
    undefined,
  );
  primed.end({ done: false, value: [] });
  const resumed: tracer.DataflowStepTrace<number, string> = run.startNode(
    id,
    "resume",
    view,
  );
  resumed.end({ done: false, value: [graph.msg(edge, 2)] });
  resumed.end({ done: true, value: "two" });
  run.end(new Map([[id, "two"]]));
  // @ts-expect-error a step result is the node's string result type
  resumed.end({ done: true, value: 2 });
  // @ts-expect-error a run result map holds the node's result type
  run.end(new Map([[id, 2]]));
  // @ts-expect-error a step phase is "prime" or "resume"
  run.startNode(id, "restart", undefined);
  const traced = new graph.DataflowGraph<Counter, number, string, never>(
    schedulers.createParallelScheduler<number, string>(),
    graph.Width(1),
    graph.UNBOUNDED,
    counting,
  );
  await Promise.all(tracers.map((each) => each.flush()));
  // A factory-built agency graph always holds a tracer, flushable without optional access.
  await graph.createParallelAgentGraph().tracer.flush();
  return traced;
}

// --- schedulers ------------------------------------------------------------------------------------

type Cursor = { last: graph.NodeIdType | undefined; batch: number };

export async function typedSchedulerPolicyReadsPerEdge(
  edge: graph.Edge<number, string>,
) {
  const options: schedulers.SchedulerOptions<Cursor, number, string> = {
    state: { last: undefined, batch: 2 },
    schedule(available, state, window, threads) {
      const lanes: schedulers.NodeSchedule[][] = [];
      for (const [id, candidate] of available) {
        const node: schedulers.NodeAvailability<number, string> = candidate;
        const pending: readonly number[] = graph.from(node.view, edge);
        const read: schedulers.MessageSchedule =
          node.status === "ready"
            ? "none"
            : pending.length > 0
              ? state.batch
              : "all";
        const inputs: schedulers.InputSchedule = new Map<
          graph.EdgeIdType,
          schedulers.MessageSchedule
        >(node.satisfied.map((satisfied) => [satisfied, read]));
        if (lanes.length < threads)
          lanes.push(
            Array.from({ length: Math.min(window, 1) }, () => ({ id, inputs })),
          );
        state.last = id;
      }
      const plan: schedulers.Schedule = lanes;
      return plan;
    },
    resolveInputs(entry, live, state) {
      if (live.status === "ready") return entry.inputs;
      return new Map<graph.EdgeIdType, schedulers.MessageSchedule>([
        [edge.id, state.batch],
      ]);
    },
  };
  const policy = schedulers.createScheduler(options);
  policy.state.batch = 3;
  const contract: schedulers.DataflowScheduler<number, string> = policy;
  const g = new graph.DataflowGraph<
    Counter,
    number,
    string,
    never,
    typeof policy
  >(policy, graph.Width(2), graph.Width(2));
  const observed: graph.NodeIdType | undefined = g.scheduler.state.last;
  const fallback: schedulers.InputSchedule[] = [...g.available().values()].map(
    schedulers.triggerInputs,
  );
  const roundRobin: schedulers.DataflowScheduler<number, string> =
    schedulers.createRoundRobinScheduler<number, string>();

  // @ts-expect-error a planned entry names a node ID, not a raw string
  const rawId: schedulers.NodeSchedule = { id: "a", inputs: new Map() };
  // @ts-expect-error a read is a count, "all" or "none"
  const unknownRead: schedulers.MessageSchedule = "some";
  const wrongPayload: schedulers.SchedulerOptions<undefined, number, string> = {
    state: undefined,
    // @ts-expect-error the policy's callbacks see the graph's numeric payloads
    schedule: (
      available: ReadonlyMap<
        graph.NodeIdType,
        schedulers.NodeAvailability<string, string>
      >,
    ) => [...available.keys()].map((id) => [{ id, inputs: new Map() }]),
  };
  return [
    contract,
    observed,
    fallback,
    roundRobin,
    rawId,
    unknownRead,
    wrongPayload,
  ];
}

export async function piSchedulerTypesFixTheScheduleTool(
  native: Omit<
    schedulers.PiSchedulerOptions<number, string, TaggedSkill, TaggedTemplate>,
    "adapter"
  >,
  skill: TaggedSkill,
  plainTool: AgentTool,
  edge: graph.Edge<number, string>,
) {
  const adapter: schedulers.PiSchedulerAdapter<number, string> = {
    describeNode: (id, node) => ({
      id,
      status: node.status,
      pending: graph.from(node.view, edge).length,
    }),
    readInputs: (_id, node) =>
      node.status === "ready"
        ? new Map<graph.EdgeIdType, schedulers.MessageSchedule>()
        : schedulers.triggerInputs(node),
    beforeSchedule: () => undefined,
    abortDependents: async () => undefined,
    closeDependents: () => undefined,
  };
  const options: schedulers.PiSchedulerOptions<
    number,
    string,
    TaggedSkill,
    TaggedTemplate
  > = {
    ...native,
    prompt: "Run available work.",
    resources: { skills: [skill] },
    adapter,
  };
  const scheduler: schedulers.PiScheduler<
    number,
    string,
    TaggedSkill,
    TaggedTemplate
  > = await schedulers.PiScheduler.make(options);
  const opus: schedulers.PiScheduler<
    number,
    string,
    TaggedSkill,
    TaggedTemplate
  > = await schedulers.PiScheduler.opus(options);
  let agency: graph.JuncoGraph | undefined;
  const agencyScheduler: schedulers.PiScheduler<
    graph.nodes.AgenticInput,
    AssistantMessage,
    TaggedSkill,
    TaggedTemplate
  > = await schedulers.createAgencyScheduler<TaggedSkill, TaggedTemplate>(
    () => agency,
    { prompt: "Run the agency." },
  );
  agency = new graph.JuncoGraph(
    agencyScheduler,
    graph.Width(1),
    graph.UNBOUNDED,
    tracer.createTracer(),
  );
  const skillTags: ("skill" | undefined)[] = [
    scheduler,
    opus,
    agencyScheduler,
  ].map((each) => each.getResources().skills?.[0]?.tag);

  const [schedule] = scheduler.getTools();
  if (schedule === undefined || tools.isComplainTool(schedule))
    throw new Error("the schedule tool is fixed");
  const result = await schedule.execute("call-1", {
    lanes: [["a", "b"], ["c"]],
  });
  const info: schedulers.SchedulerInfo = result.details;
  const window: number | null = info.window;
  const candidates: string[] = info.nodes.map(
    (node) => `${node.id}:${node.status === "ready" ? "prime" : "resume"}`,
  );
  const details: unknown[] = info.nodes.map((node) => node.details);

  // @ts-expect-error schedule lanes hold string node IDs
  await schedule.execute("call-2", { lanes: [[1]] });
  // @ts-expect-error the scheduler's tool set is fixed to `schedule` and `complain`
  await scheduler.setTools([plainTool]);
  const replaced: schedulers.PiSchedulerOptions<number, string> = {
    // @ts-expect-error construction cannot replace the fixed tool set
    tools: [plainTool],
  };
  const finished: schedulers.SchedulerInfo = {
    window: 1,
    threads: null,
    quiescent: false,
    // @ts-expect-error a snapshot lists only ready or running candidates
    nodes: [{ id: "a", status: "done" }],
  };
  const badReads: schedulers.PiSchedulerAdapter<number, string> = {
    // @ts-expect-error an adapter's read plan is keyed by edge ID, not a payload
    readInputs: () => 2,
  };
  return [skillTags, window, candidates, details, replaced, finished, badReads];
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
  const issue: tools.Issue<number> = {
    nodeId: graph.NodeId("n"),
    messages: [],
    prompt: { messages: [] },
    complaint: "blocked",
  };
  const complained: void = protocol.complain(issue);
  // @ts-expect-error a complaint string alone is not an issue
  protocol.complain("blocked");
  // @ts-expect-error an issue carries its messages and prompt
  protocol.complain({ nodeId: graph.NodeId("n"), complaint: "blocked" });
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
    };
  const resolved: agent.JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool> =
    await agent.JuncoAgent.fromResolved(options);
  const yieldTool: tools.YieldTool = tools.createYieldTool();
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
  const noProvider: agent.JuncoAgentCreateOptions = { model: "plain" };
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
    malformedResources,
    malformedTools,
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
  const operations: tools.ShellMuxOperations = tools.createShellMuxOperations({
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
  const bashOptions: tools.BashToolOptions = {
    operations,
    commandPrefix: "set -e",
  };
  const bashInput: tools.BashToolInput = { command: "printf ok", timeout: 5 };
  const bash = tools.createBashTool(cwd, bashOptions);
  const bashResult = await bash.execute("bash-1", bashInput, signal);
  const bashDetails: tools.BashToolDetails | undefined = bashResult.details;
  const truncated: string | undefined = bashDetails?.fullOutputPath;

  const edit = tools.createEditTool(cwd, store, native, mux);
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
      mux,
      principal: "typed",
    },
  );
  const collectionOptions: tools.ToolCollectionOptions = {
    sandbox: "always",
    principal: "owned",
  };
  const agentTools: AgentTool[] = [
    tools.createReadTool(cwd, store, native, mux),
    edit,
    tools.createGrepTool(cwd, store, native, mux),
    tools.createFindTool(cwd, native, mux),
    tools.createAstGrepTool(cwd, native, mux),
    tools.createAstEditTool(cwd, native, mux),
    tools.createDiffTool(native),
    bash,
    ...collection.tools,
  ];
  const nativeAgent = await agent.JuncoAgent.fromResolved({
    ...base,
    tools: agentTools,
  });

  try {
    await collection.close();
  } catch (error) {
    if (tools.isMarshPolicyDenied(error)) {
      const denied: tools.MarshPolicyDeniedError = error;
      const code: "MARSH_POLICY_DENIED" = denied.code;
      void code;
    }
  }
  const deniedCode: typeof tools.MARSH_POLICY_DENIED = "MARSH_POLICY_DENIED";
  await tools.shutdownShellMux();

  // @ts-expect-error bash requires a command
  const noCommand: tools.BashToolInput = { timeout: 5 };
  // @ts-expect-error a bash timeout is a number of seconds
  const stringTimeout: tools.BashToolInput = { command: "true", timeout: "5" };
  // @ts-expect-error a command prefix is a string
  const numericPrefix: tools.BashToolOptions = { commandPrefix: 1 };
  // @ts-expect-error a collection sandbox is "shared" or "always"
  const invalidSandbox: tools.ToolCollectionOptions = { sandbox: "never" };
  // @ts-expect-error streamed output is a Buffer
  await operations.exec("true", cwd, { onData: (data: string) => void data });
  return [
    chunks,
    failed,
    truncated,
    outcomes,
    collectionOptions,
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
) {
  const options: LspToolOptions = { readOnly: true };
  const routedOptions: tools.LspToolOptions = { readOnly: false };
  const flat: LspTool = await LspTool.create(cwd, options);
  const routed: tools.LspTool = await tools.LspTool.create(cwd, routedOptions);
  const execute: LspTool["execute"] = flat.execute;
  const routedExecute: tools.LspTool["execute"] = routed.execute;
  const status: LspToolInput = { action: "status" };
  const diagnostics: tools.LspToolInput = {
    action: "diagnostics",
    file: "src/index.ts",
    timeout: 20,
  };
  const results = [
    await execute("status-1", status),
    await routedExecute("diagnostics-1", diagnostics),
  ];
  const details: (LspToolDetails | undefined)[] = results.map(
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
  await LspTool.shutdown();
  await tools.LspTool.shutdown();

  // @ts-expect-error an LSP action outside the upstream set is rejected
  const unknownAction: LspToolInput = { action: "format" };
  const textLine: tools.LspToolInput = {
    action: "hover",
    file: "a.ts",
    // @ts-expect-error an LSP line is one-based numeric
    line: "1",
    symbol: "x",
  };
  // @ts-expect-error readOnly is a boolean
  const textReadOnly: LspToolOptions = { readOnly: "yes" };
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

export async function sharedShellMuxLeasesAndAdoption(
  cwd: string,
  native: tools.NativeModule,
  mux: tools.NativeMux,
) {
  const lease: tools.ShellMuxLease = await tools.acquireShellMux(cwd);
  const adopted: tools.ShellMuxLease = await tools.acquireShellMux(cwd, {
    native,
    mux,
    sandbox: "always",
  });
  const same: boolean = lease.mux === adopted.mux && !lease.closed;
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
  lease.release();
  adopted.release();
  await tools.shutdownShellMux();

  // @ts-expect-error a lease's sandbox is "shared" or "always"
  await tools.acquireShellMux(cwd, { sandbox: "never" });
  // @ts-expect-error a lease is released, not closed
  await lease.close();
  return [same, mode, finished, processOptions];
}

export async function mcpDefinitionsComposeWithAgentFactories(
  cwd: string,
  base: agent.AgenticOptions,
  tool: TaggedTool,
  lsp: LspTool,
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
  const connectOptions: mcp.JuncoMcpConnectOptions = { cwd };
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
  // @ts-expect-error mixed sources cannot promise a specialized tool type
  const narrowed: agent.JuncoAgent<Skill, PromptTemplate, TaggedTool> = mixed;
  return [
    chained,
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
    return input.tasks.map(({ name }, index) => ({
      id: `task-${index}`,
      ...(name === undefined ? {} : { name }),
    }));
  };
  const task = tools.createTaskTool(host);
  const unhosted: AgentTool = tools.createTaskTool();
  const branded: boolean = tools.isTaskTool(unhosted);
  const admitted = await tools.invokeTaskTool(
    task,
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
  const hosted: number = await specialized.runWithTaskHost(host, async () => 1);
  const snapshot: mcp.JuncoMcpTools = definition.snapshot();
  const identity: mcp.JuncoMcpToolIdentity | undefined =
    mcp.getJuncoMcpToolIdentity(unhosted);
  const cancellable: mcp.JuncoMcpConnectOptions = { signal };

  // @ts-expect-error a task needs its instructions
  await task.execute("call-2", { context: "c", tasks: [{ name: "x" }] });
  await task.execute("call-3", {
    context: "c",
    // @ts-expect-error a model override names its provider and model ID
    tasks: [{ task: "x", model: { provider: "p" } }],
  });
  // @ts-expect-error a tool subset lists tool names
  await task.execute("call-4", { context: "c", tasks: [{ task: "x", tools: [1] }] });
  // @ts-expect-error a task batch shares a context
  await task.execute("call-5", { tasks: [{ task: "x" }] });
  // @ts-expect-error hosts receive the input directly, not a request wrapper
  await tools.invokeTaskTool(
    task,
    host,
    { toolCallId: "c", input: {} },
    signal,
  );
  // @ts-expect-error a handle ID is a string
  const badHandles: tools.TaskToolDetails = { tasks: [{ id: 1 }] };
  // @ts-expect-error children never promise the caller's specialized tool type
  const narrowedChildren: agent.JuncoAgent<
    TaggedSkill,
    TaggedTemplate,
    TaggedTool
  >[] = children;
  return [
    branded,
    firstId,
    hosted,
    snapshot,
    identity,
    cancellable,
    badHandles,
    narrowedChildren,
  ];
}
