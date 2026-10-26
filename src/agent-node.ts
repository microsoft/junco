import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import {
  Edge,
  EdgeId,
  type EdgeIdType,
  fires,
  type Message,
  messagesOf,
  type Node,
  type NodeGenerator,
  NodeId,
  type NodeOptions,
  type NodeSpec,
  type ParentView,
  Sink,
  Source,
  type StepFn,
  TriggerEntry,
  TriggerRule,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import {
  JuncoAgent,
  JuncoAgentError,
  type JuncoAgentNodeContext,
  type TaskAgentOptions,
  type TaskFailurePolicy,
  type TaskResult,
} from "junco-agent";
import type { SchedulerContext } from "junco-scheduler";
import type {
  Contract,
  ProfileRecorder,
  TaskDecision,
  TaskInput,
  TaskToolDetails,
  TaskToolHost,
  ToolCollection,
} from "junco-tools";
import { disposeThenRethrow, errorGraph } from "junco-tools/errors";
import { cancellation } from "./agent-operations.js";
import type { Agentic, AgenticInput, AgenticNode } from "./agentic.js";
import { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";
import {
  type AgencyNodeMetadata,
  type NodePolicy,
  type NodeRegistration,
  nodePolicies,
  registeredNodeContexts,
  unseenValues,
} from "./node-policy.js";
import { TuiTracer } from "./tui-tracer.js";

/** The final report a subagent sends back to the agent that started it, as JSON follow-up text. */
type TaskReport = TaskResult & { readonly type: "task_result" };

/** A subagent a task call or retry acquired, not yet registered in a graph. */
type StagedChild = {
  /** Its node's ID: the task ID for the first attempt, then `<taskId>:attempt:<n>`. */
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly name?: string;
  readonly prompt: string;
  readonly agent: JuncoAgent;
  /** The acquiring call's abort signal. */
  readonly signal: AbortSignal;
};

/** The tasks one launch admitted, in admission order, and how many are not yet resolved. */
type TaskBatch = { readonly ids: readonly string[]; open: number };

/** One logical task across its attempts. */
type TaskRecord = {
  readonly id: string;
  readonly name?: string;
  readonly prompt: string;
  /** The first attempt's resolved model and active tools; every retry uses exactly these. */
  readonly selection: TaskAgentOptions;
  readonly policy: TaskFailurePolicy;
  /** Automatic retries left. */
  retries: number;
  attempt: number;
  /** The current attempt's node ID. */
  node: string;
  state: "running" | "retrying" | "awaiting-decision" | "terminal";
  readonly batch: TaskBatch;
};

/** How a prompt-agent node executes, beyond its registration options: what a task subagent adds. */
type DriverBinding = {
  /** Messages routed once the final result is ready, one activation before it is returned. */
  readonly complete?: (
    this: Node<Agentic, AgenticInput, AssistantMessage>,
    message: AssistantMessage,
  ) => Message<AgenticInput>[] | Promise<Message<AgenticInput>[]>;
};

const ROOT = NodeId.create("root");
const SOURCE_WAKE: AgenticInput = { kind: "nextTurn", text: "" };
const SOURCE_EDGE = EdgeId.create("$source->root");
const TASK_LIFECYCLE = {
  resource: "operations",
  category: "task",
  tool: "task",
  operation: "lifecycle",
} as const;
type TaskContext = SchedulerContext<
  Agentic,
  AgenticInput,
  AssistantMessage,
  AgencyNodeMetadata,
  JuncoGraph
>;
const PROCESS_REPORTS = "Process the queued task reports.";
/** The unused paired route from the root to a task child. */
const TASK_EDGE_CONTRACT: Contract = {
  expect:
    "No messages are expected on this reserved task edge; the child starts from its bound task prompt.",
};
/** Every report route into an expanded root, current or retained. */
const TASK_REPORT_CONTRACT: Contract = {
  expect:
    "Harness-owned followUp/error containing a JSON task_result for a known task and attempt; current reports resolve or retry tasks, stale reports are ignored; do not send manually.",
};

const closedNode = (): JuncoAgentError =>
  new JuncoAgentError("closed", "Agentic node closed before prompt settlement");

/** Close agents no graph owns, then rethrow `primary` with any cleanup failures. */
const disposeStaged = (
  children: readonly { readonly agent: JuncoAgent }[],
  primary: unknown,
): Promise<never> =>
  disposeThenRethrow(
    children.map(({ agent }) => agent),
    primary,
    "Staged subagent cleanup failed",
  );

/**
 * Whether `cleanup` reports a failure beyond `failure`: closing a faulted agent rethrows the fault
 * that failed it, which is no separate cleanup failure.
 */
function addsFailure(cleanup: unknown, failure: unknown): boolean {
  const known = new Set(errorGraph(failure));
  const seen = new Set<unknown>();
  const pending = [cleanup];
  while (pending.length > 0) {
    const value = pending.pop();
    if (known.has(value) || seen.has(value)) continue;
    seen.add(value);
    if (!(value instanceof AggregateError)) return true;
    pending.push(...value.errors);
  }
  return false;
}

/** A report on its attempt's return queue: failed reports are `error` inputs, the rest follow-ups. */
function taskReportMessage(
  child: StagedChild,
  report: Pick<TaskReport, "status" | "output" | "stopReason" | "error">,
): Message<AgenticInput> {
  const full: TaskReport = {
    type: "task_result",
    id: child.taskId,
    ...(child.name === undefined ? {} : { name: child.name }),
    attempt: child.attempt,
    ...report,
  };
  return {
    id: EdgeId.create(`${child.id}->${ROOT}`),
    payload: {
      kind: report.status === "failed" ? "error" : "followUp",
      text: JSON.stringify(full),
    },
  };
}

/** A delivered report, or a protocol error: only task nodes write to the root. */
function parseReport(text: string): TaskReport {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch (cause) {
    throw new JuncoAgentError("invalid_state", "Malformed task report", {
      cause,
    });
  }
  if (
    typeof report !== "object" ||
    report === null ||
    !("type" in report) ||
    report.type !== "task_result" ||
    !("id" in report) ||
    typeof report.id !== "string" ||
    !("attempt" in report) ||
    typeof report.attempt !== "number" ||
    !Number.isSafeInteger(report.attempt) ||
    report.attempt < 1 ||
    !("status" in report) ||
    (report.status !== "completed" && report.status !== "failed")
  )
    throw new JuncoAgentError("invalid_state", "Malformed task report");
  return report as TaskReport;
}

/**
 * Every distinct error reachable from `error` through `Error.cause` and `AggregateError.errors`,
 * one `name: message` (or `String(value)` for a non-Error) per line. Never throws.
 */
function taskErrorText(error: unknown): string {
  const lines: string[] = [];
  for (const value of errorGraph(error)) {
    try {
      lines.push(
        !(value instanceof Error)
          ? String(value)
          : value.message === ""
            ? value.name
            : `${value.name}: ${value.message}`,
      );
    } catch {
      lines.push("Unprintable subagent error");
    }
  }
  return lines.join("\n");
}

function hasMessages(
  view: ParentView<AgenticInput, AssistantMessage>,
): boolean {
  for (const id of view.messages.keys())
    if ((view.messages.get(id)?.length ?? 0) > 0) return true;
  return false;
}

/**
 * The one run of a prompt agent, shared by whichever body currently drives it: the node's own body
 * until a task call expands it, then the internal spawn root. Only the current driver advances it.
 * Internal: graphs construct its node for a registered agent without a step.
 */
export class AgentDriver {
  /** The node's one run has started: its staged prompt demanded. */
  started = false;
  /** A native run was admitted and its settlement has not been read. */
  active = false;
  /** Delivered message batches per edge, retained in FIFO order until the model's `recv`. */
  readonly messages = new Map<EdgeIdType, AgenticInput[]>();
  /** Delivered parent results, each staged once, retained until the model's `recv`. */
  readonly values = new Map<EdgeIdType, AssistantMessage>();
  /**
   * The outer node's own graph registration, captured when its body was primed: `send` and `info`
   * keep using it after promotion makes the agent an inner spawn root.
   */
  registration: NodeRegistration | undefined;
  /** The outer node's ID in that registration's graph: its recorder context. */
  nodeId: string | undefined;
  #outputSink: Sink<AgenticInput, AssistantMessage> | undefined;
  #messageHost:
    | NonNullable<
        JuncoAgentNodeContext<AgenticInput, AssistantMessage>["messaging"]
      >
    | undefined;
  /** Subagents accepted by task calls or retries and not yet registered in a graph. */
  staged: StagedChild[] = [];
  /** Every admitted task by its stable handle ID. */
  readonly tasks = new Map<string, TaskRecord>();
  /** Admitted tasks neither completed nor ignored. */
  readonly outstanding = new Set<string>();
  /** Report and completion notices to queue natively, in order. */
  readonly notices: (string | TaskReport)[] = [];
  /** Queued notices that have not entered the agent's context. */
  readonly unread = new Map<string, TaskResult | undefined>();
  /** Authenticated task attempts whose reports actually entered the caller's context. */
  readonly taskResults: TaskResult[] = [];
  /** A native assistant message followed the latest report that entered the context. */
  answered = true;
  /** The final message, once the run settled with every accepted report processed. */
  result: AssistantMessage | undefined;
  /** The policy of the body currently driving the agent, which records its pauses. */
  policy: NodePolicy;

  constructor(
    readonly agent: JuncoAgent | MockAgent,
    policy: NodePolicy,
  ) {
    this.policy = policy;
  }

  /** Admits a launch or applies a decision. */
  readonly host: TaskToolHost = async (_toolCallId, input, signal) => {
    const caller = this.agent;
    if (!(caller instanceof JuncoAgent))
      throw new JuncoAgentError(
        "invalid_state",
        "Only a JuncoAgent runs tasks",
      );
    return "action" in input
      ? this.#decide(caller, input, signal)
      : this.#launch(caller, input, signal);
  };

  /** Acquires and prepares every subagent, then stages them all with fresh handle IDs. */
  async #launch(
    caller: JuncoAgent,
    input: TaskInput,
    signal: AbortSignal,
  ): Promise<TaskToolDetails["tasks"]> {
    const policy = caller.getTaskFailurePolicy();
    const children = await caller.createSubagents(
      input.tasks.map(({ model, tools }) => ({ model, tools })),
      signal,
    );
    const ids = children.map(() => `task-${crypto.randomUUID()}`);
    const batch: TaskBatch = { ids, open: ids.length };
    const prepared: { child: StagedChild; record: TaskRecord }[] = [];
    try {
      for (const [index, agent] of children.entries()) {
        const { name, task } = input.tasks[index]!;
        const id = ids[index]!;
        const prompt = `${input.context}\n\n${task}`;
        const model = await agent.getModel();
        if (model === undefined)
          throw new JuncoAgentError("invalid_state", "Subagent has no model");
        const named = name === undefined ? {} : { name };
        prepared.push({
          child: {
            id,
            taskId: id,
            attempt: 1,
            ...named,
            prompt,
            agent,
            signal,
          },
          record: {
            id,
            ...named,
            prompt,
            selection: {
              model: { provider: model.provider, modelId: model.id },
              tools: agent.getActiveTools().map((tool) => tool.name),
            },
            policy,
            retries: policy === "ignore" ? 0 : policy.retries,
            attempt: 1,
            node: id,
            state: "running",
            batch,
          },
        });
      }
      signal.throwIfAborted();
    } catch (error) {
      return disposeStaged(
        children.map((agent) => ({ agent })),
        error,
      );
    }
    for (const { child, record } of prepared) {
      this.staged.push(child);
      this.tasks.set(record.id, record);
      this.outstanding.add(record.id);
    }
    this.#lifecycle({
      batches_admitted: 1,
      tasks_admitted: prepared.length,
      attempts_admitted: prepared.length,
    });
    return prepared.map(({ record: { id, name } }) =>
      name === undefined ? { id } : { id, name },
    );
  }

  /** Retries or ignores a failed task awaiting the caller's decision about its current attempt. */
  async #decide(
    caller: JuncoAgent,
    { action, id, attempt }: TaskDecision,
    signal: AbortSignal,
  ): Promise<TaskToolDetails["tasks"]> {
    const record = this.tasks.get(id);
    if (record === undefined) throw new Error(`Unknown task ${id}`);
    if (record.state !== "awaiting-decision")
      throw new Error(`Task ${id} is not awaiting a decision`);
    if (attempt !== record.attempt)
      throw new Error(
        `Task ${id} awaits a decision about attempt ${record.attempt}, not ${attempt}`,
      );
    if (action === "ignore") {
      this.#resolve(record, { tasks_ignored: 1 });
      return [];
    }
    // Reserved while acquiring, so a concurrent decision cannot start a second attempt.
    record.state = "retrying";
    try {
      this.staged.push(await this.#acquire(caller, record, signal));
      this.#lifecycle({ attempts_admitted: 1, retry_attempts: 1 });
    } catch (error) {
      record.state = "awaiting-decision";
      throw error;
    }
    return [record.name === undefined ? { id } : { id, name: record.name }];
  }

  /** A fresh attempt of `record` with its pinned model, tools and prompt. */
  async #acquire(
    caller: JuncoAgent,
    record: TaskRecord,
    signal: AbortSignal,
  ): Promise<StagedChild> {
    const [agent] = await caller.createSubagents([record.selection], signal);
    if (agent === undefined)
      throw new JuncoAgentError("invalid_state", "No subagent acquired");
    record.attempt += 1;
    record.node = `${record.id}:attempt:${record.attempt}`;
    record.state = "running";
    return {
      id: record.node,
      taskId: record.id,
      attempt: record.attempt,
      ...(record.name === undefined ? {} : { name: record.name }),
      prompt: record.prompt,
      agent,
      signal,
    };
  }

  /**
   * Ends `record` as completed or ignored, recording `counters` with its resolution; its batch's
   * last resolution queues its completion.
   */
  #resolve(
    record: TaskRecord,
    counters: Readonly<Record<string, number>>,
  ): void {
    record.state = "terminal";
    this.outstanding.delete(record.id);
    record.batch.open -= 1;
    this.#lifecycle({
      ...counters,
      tasks_resolved: 1,
      ...(record.batch.open === 0 ? { batches_completed: 1 } : {}),
    });
    if (record.batch.open === 0)
      this.notices.push(
        JSON.stringify({ type: "task_batch_complete", ids: record.batch.ids }),
      );
  }

  /**
   * Consume one report from a task node: only the current attempt's first report on its own
   * return edge counts; duplicate or stale deliveries change nothing.
   */
  async #receiveTaskReport(
    { id: edge, payload }: Message<AgenticInput>,
    signal: AbortSignal,
  ): Promise<void> {
    if (payload.kind !== "followUp" && payload.kind !== "error")
      throw new JuncoAgentError("invalid_state", "Malformed task report");
    const report = parseReport(payload.text);
    const record = this.tasks.get(report.id);
    if (record === undefined)
      throw new JuncoAgentError("invalid_state", "Malformed task report");
    if (
      edge !== EdgeId.create(`${record.node}->${ROOT}`) ||
      report.attempt !== record.attempt ||
      record.state !== "running"
    )
      return;
    if (report.status === "completed") {
      this.notices.push(report);
      this.#resolve(record, { tasks_completed: 1 });
      return;
    }
    this.#lifecycle({ tasks_failed: 1 });
    if (record.policy === "ignore") {
      this.#resolve(record, { tasks_ignored: 1 });
      return;
    }
    let error = report.error;
    while (record.retries > 0) {
      record.retries -= 1;
      record.state = "retrying";
      try {
        this.staged.push(
          await this.#acquire(this.agent as JuncoAgent, record, signal),
        );
        this.#lifecycle({ attempts_admitted: 1, retry_attempts: 1 });
        return;
      } catch (failure) {
        if (signal.aborted) throw failure;
        error = taskErrorText(failure);
      }
    }
    record.state = "awaiting-decision";
    this.notices.push({
      ...report,
      ...(error === undefined ? {} : { error }),
      decisionRequired: true,
    });
  }

  /** Task commits, at the logical task owner's node context with the current outstanding count. */
  #lifecycle(counters: Readonly<Record<string, number>>): void {
    const id = this.nodeId;
    const view: ProfileRecorder<"operations"> | undefined =
      id === undefined
        ? undefined
        : this.registration?.recorder?.add_context(id);
    view?.record({
      kind: "metrics",
      ...TASK_LIFECYCLE,
      counters,
      gauges: { tasks_outstanding: this.outstanding.size },
    });
  }

  /** Queue every pending notice natively, in order. */
  async #flush(): Promise<void> {
    for (const notice of this.notices.splice(0)) {
      const text = typeof notice === "string" ? notice : JSON.stringify(notice);
      this.unread.set(text, typeof notice === "string" ? undefined : notice);
      await this.agent.followUp(text);
    }
  }

  /**
   * The node's messaging host, created once: its retained inbox for `recv`, and its original
   * registration's routes and topology for `send` and `info`. Every access reads the current
   * registration and checks its current signal.
   */
  #messaging(): NonNullable<
    JuncoAgentNodeContext<AgenticInput, AssistantMessage>["messaging"]
  > {
    if (this.#messageHost !== undefined) return this.#messageHost;
    const driver = this;
    const view = { messages: this.messages, values: this.values };
    this.#messageHost = {
      get view() {
        driver.registration?.signal.throwIfAborted();
        return view;
      },
      consume: () => {
        this.registration?.signal.throwIfAborted();
        this.messages.clear();
        this.values.clear();
      },
      send: (message) => {
        const registration = this.registration;
        if (registration === undefined)
          throw new Error("send requires a JuncoGraph host");
        if (this.#outputSink === undefined) registration.send(message);
        else {
          registration.assertSend(message.id);
          this.#outputSink.send(message);
        }
      },
      info: () => {
        const registration = this.registration;
        if (registration === undefined)
          throw new Error("info requires a JuncoGraph host");
        return registration.info();
      },
    };
    return this.#messageHost;
  }

  /** Retain original parent edge identities and FIFO batches for the agent's recv tool. */
  #retain(
    view: ParentView<AgenticInput, AssistantMessage>,
  ): Message<AgenticInput>[] {
    const messages = messagesOf(view);
    for (const { id, payload } of messages) {
      const retained = this.messages.get(id);
      if (retained === undefined) this.messages.set(id, [payload]);
      else retained.push(payload);
    }
    for (const id of view.values.keys()) {
      const value = view.values.get(id);
      if (value !== undefined) this.values.set(id, value);
    }
    return messages;
  }

  /** What `recv` returns right now, for the model's next request — only while that inbox would fire `trigger`. */
  briefing(
    trigger: TriggerRule<AgenticInput, AssistantMessage>,
  ): string | undefined {
    if (this.messages.size === 0 && this.values.size === 0) return undefined;
    if (!fires(trigger, (id) => this.messages.has(id) || this.values.has(id)))
      return undefined;
    const entries = [
      ...[...this.messages].map(([id, batch]) => `${id}: ${batch.length}`),
      ...[...this.values.keys()].map((id) => `${id}: 1`),
    ];
    return `Inbox { ${entries.join(", ")} } read with recv tool`;
  }

  /**
   * One activation: consume task reports, then advance the run at most once. A real agent does
   * this with one node context bound: its messaging host, its task host (observing which reports
   * enter its context), and complaints attributed to the executing `node`'s id, its delivered
   * `messages` and the tracer of the graph `node` was registered in, if any. A `reportSignal`
   * marks an expanded root's deliveries as task reports, owned by the graph with that signal.
   */
  async activate(
    node: Node<Agentic, AgenticInput, AssistantMessage>,
    messages: readonly Message<AgenticInput>[],
    reportSignal?: AbortSignal,
  ): Promise<void> {
    const agent = this.agent;
    const advance = async () => {
      if (reportSignal !== undefined)
        for (const message of messages)
          await this.#receiveTaskReport(message, reportSignal);
      return this.#advance();
    };
    const registration = registeredNodeContexts.get(node);
    const tracer = registration?.tracer;
    const recorder = registration?.recorder;
    const detach =
      tracer instanceof TuiTracer
        ? tracer.observeAgent(node, agent.events)
        : undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      if (!(agent instanceof JuncoAgent)) return await advance();
      unsubscribe = agent.events.on("message_end", ({ lane, message }) => {
        if (lane !== "main") return;
        if (message.role === "user") {
          const text = contentText(message.content);
          const result = this.unread.get(text);
          if (this.unread.delete(text)) {
            this.answered = false;
            if (result !== undefined) this.taskResults.push(result);
          }
        } else if (message.role === "assistant") {
          this.answered = true;
        }
      });
      await agent.runWithNodeContext(
        {
          messaging: this.#messaging(),
          briefing: () => this.briefing(node.trigger),
          task: this.host,
          taskResults: this.taskResults,
          complaint: {
            nodeId: node.id,
            messages,
            ...(tracer === undefined ? {} : { tracer }),
          },
          ...(recorder === undefined
            ? {}
            : { recorder, recorderNodeId: String(node.id) }),
        },
        advance,
      );
    } finally {
      try {
        unsubscribe?.();
      } finally {
        detach?.();
      }
    }
  }

  async #advance(): Promise<void> {
    const agent = this.agent;
    await this.#flush();
    if (!this.started) {
      // Delivered data waits in the inbox; an agent without a staged prompt has nothing to await.
      if (agent.status !== "ready") return;
      this.started = true;
      this.active = true;
    }
    if (!this.active) {
      // Settled: only reports that never entered the context need another run.
      if (this.unread.size === 0 && this.answered) return;
      this.active = true;
      agent.prompt(PROCESS_REPORTS).catch(() => undefined);
    }
    // The retained inbox is also the view a staged prompt function reads.
    const result = await agent.next(this.#messaging().view);
    if (result.done === true) throw closedNode();
    const boundary = result.value;
    if (boundary.kind === "yield") {
      this.policy.lastYield = boundary.reasons;
      return;
    }
    this.active = false;
    if (boundary.kind === "failed") throw boundary.error;
    // Notices a task call queued during this run keep its answer interim.
    await this.#flush();
    if (this.unread.size > 0 || !this.answered) return;
    const undecided = [...this.tasks.values()].filter(
      ({ state }) => state === "awaiting-decision",
    );
    if (undecided.length > 0)
      throw new JuncoAgentError(
        "invalid_state",
        `Task failure decisions required: ${undecided.map(({ id }) => id).join(", ")}`,
      );
    // An earlier answer is interim until every accepted report was answered.
    if (this.outstanding.size === 0) this.result = boundary.message;
  }

  /**
   * A graph node driving one prompt agent through a single run.
   *
   * The body first yields `[]` so the engine's priming consumes nothing. Each later activation
   * retains the delivered batch and any parent result it has not seen in the node's inbox, which
   * the model drains through `recv`; payloads are data, never native commands. The node demands
   * the agent's staged prompt once, passing that inbox as the view a prompt function reads, then
   * calls `agent.next()` at most once per activation: a `yield` step leaves the agent suspended, a
   * settled step returns the native final message, and a failed step throws the native error.
   * While it drives a `JuncoAgent`, the agent's `send` admits messages on this node's outgoing
   * message edges and `info` describes this node's routes with each receiver's contract. Unless
   * `options.is_available` replaces it, the node is available before it starts only when its
   * trigger fires with a staged prompt or fresh inbound data, and once started it stays resumable
   * until it returns; a node re-armed through a value self-edge waits for its trigger again.
   * Its receiver contract is `options.contract`, else the agent's.
   *
   * A `JuncoAgent`'s `task` calls are admitted while the node drives it; the run continues. At its
   * next pause or settlement the node's state becomes a `JuncoGraph.spawn` graph whose root is the same
   * running agent and whose children run one fresh subagent per task, linked by paired message
   * queues; the node keeps its id, trigger, edges and inbox, and later drives that graph one step
   * per activation. Each subagent starts from its task prompt and sends its final report back
   * through its queue; the agent receives reports as follow-ups, and the node returns its answer
   * only after every report entered its context and was answered. Later task calls add siblings
   * under the same root.
   */
  static node(
    agent: JuncoAgent | MockAgent,
    options: NodeOptions<AgenticInput, AssistantMessage> &
      Pick<ToolCollection, "policy"> &
      Pick<AgenticNode, "contract" | "on_error">,
    binding: DriverBinding = {},
  ): NodeSpec<Agentic, AgenticInput, AssistantMessage> &
    Pick<ToolCollection, "policy"> &
    Pick<AgenticNode, "contract"> {
    const { complete } = binding;
    const seenValues = new Map<EdgeIdType, unknown>();
    const policy: NodePolicy = {
      agent,
      seenValues,
      inputMode: "all-messages",
    };
    const driver = new AgentDriver(agent, policy);
    /** The spawn graph this node's state became, once a task call expanded it. */
    let spawned: TaskContext | undefined;
    let failureAbort:
      | Promise<{ workError: unknown; abortError: unknown } | undefined>
      | undefined;

    /**
     * Close a failed attempt's node state exactly once, record its failure for the root, and report
     * it. Teardown failure is no task failure: it propagates with both causes.
     */
    const retire = async (
      node: Node<Agentic, AgenticInput, AssistantMessage>,
      child: StagedChild,
      failure: unknown,
      report: Pick<TaskReport, "output" | "stopReason" | "error">,
    ): Promise<Message<AgenticInput>[]> => {
      // The failed subagent, or the spawn graph it expanded into; never the containing graph.
      const state = node.state;
      // This teardown owns the state's outcome; the owning graph's close must not repeat it.
      nodePolicies.get(node.step)!.closedTaskState = state;
      try {
        if (!(state instanceof Source) && !(state instanceof Sink))
          await state[Symbol.asyncDispose]();
      } catch (cleanupError) {
        if (addsFailure(cleanupError, failure))
          throw new AggregateError(
            [failure, cleanupError],
            "Task subagent execution and cleanup failed",
            { cause: failure },
          );
      }
      return [taskReportMessage(child, { status: "failed", ...report })];
    };

    /**
     * A task subagent's node: started by its task prompt, staged once here, reporting its final
     * message. An unsuccessful settlement or a thrown failure closes the subagent and reports the
     * failure as an `error` input; cancellation of the owning graph propagates instead.
     */
    const childNode = (child: StagedChild) => {
      child.agent.stagePrompt(child.prompt);
      return AgentDriver.node(
        child.agent,
        {
          id: NodeId.create(child.id),
          trigger: TriggerRule.always(),
          policy: options.policy,
          ...(child.name === undefined ? {} : { description: child.name }),
          async on_error(error, signal) {
            signal?.throwIfAborted();
            // A failed teardown already retired this attempt; it never retires twice.
            if (nodePolicies.get(this.step)!.closedTaskState === this.state)
              throw error;
            const notification = await retire(this, child, error, {
              output: "",
              stopReason: "error",
              error: taskErrorText(error),
            });
            signal?.throwIfAborted();
            return notification;
          },
          contract: (edgeId) =>
            edgeId === EdgeId.create(`${ROOT}->${child.id}`)
              ? TASK_EDGE_CONTRACT
              : child.agent.contract(edgeId),
        },
        {
          async complete(message) {
            const output = contentText(message.content);
            const error =
              message.errorMessage === undefined
                ? {}
                : { error: message.errorMessage };
            if (message.stopReason === "stop")
              return [
                taskReportMessage(child, {
                  status: "completed",
                  output,
                  stopReason: message.stopReason,
                  ...error,
                }),
              ];
            spawned?.graph.signal.throwIfAborted();
            if (agent.status === "closed") throw closedNode();
            return retire(
              this,
              child,
              new Error(
                message.errorMessage ??
                  `Subagent stopped: ${message.stopReason}`,
              ),
              { output, stopReason: message.stopReason, ...error },
            );
          },
        },
      );
    };

    /** Register staged children under the root; each starts from its bound prompt. */
    const commit = async (graph: JuncoGraph): Promise<void> => {
      const staged = driver.staged;
      if (staged.length === 0) return;
      driver.staged = [];
      // As at expansion: a call aborted after acquiring its children never publishes them.
      const aborted = staged.find(({ signal }) => signal.aborted)?.signal;
      if (aborted !== undefined) await disposeStaged(staged, aborted.reason);
      try {
        graph.appendChildren(ROOT, staged, childNode);
      } catch (error) {
        await disposeStaged(
          staged.filter(
            ({ id, agent }) =>
              graph.getNode(NodeId.create(id))?.state !== agent,
          ),
          error,
        );
      }
    };

    /**
     * Replace this node's state with a spawn graph of the same running agent as its root plus the
     * staged children. Nothing else about the node changes; the agent's lifetime moves to the root.
     */
    const expand = async (
      node: Node<Agentic, AgenticInput, AssistantMessage>,
    ): Promise<TaskContext> => {
      const staged = driver.staged;
      driver.staged = [];
      // The agent's owner follows it to the root; spawned workers stay graph-owned.
      const rootPolicy: NodePolicy = {
        agent,
        inputMode: "all-messages",
        agentOwnership: policy.agentOwnership,
      };
      const rootStep: StepFn<Agentic, AgenticInput, AssistantMessage> =
        async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
          let messages: Message<AgenticInput>[] = [];
          while (true) {
            await driver.activate(this, messages, graph.signal);
            if (driver.result !== undefined) return driver.result;
            messages = messagesOf(yield []).filter(
              ({ id }) => id !== SOURCE_EDGE,
            );
          }
        };
      nodePolicies.set(rootStep, rootPolicy);
      const source = new Source<AgenticInput, AssistantMessage>(
        (view) => {
          driver.#retain(view);
          return [{ id: SOURCE_EDGE, payload: SOURCE_WAKE }];
        },
        { id: NodeId.create("$source") },
      );
      const output = Edge.value<AgenticInput, AssistantMessage>("root->$sink");
      const sink = new Sink<AgenticInput, AssistantMessage>(
        async function* () {
          yield [];
          const result = graph.result(ROOT);
          if (O.isNone(result))
            throw new JuncoAgentError(
              "invalid_state",
              "Task graph stopped before producing its sink result",
            );
          return result.value;
        },
        {
          id: NodeId.create("$sink"),
          trigger: TriggerRule.allOf(TriggerEntry.on(output)),
        },
      );
      let graph: JuncoGraph;
      let execution: TaskContext;
      try {
        execution = JuncoGraph.spawn<
          StagedChild,
          AgenticInput,
          AssistantMessage
        >(
          source,
          sink,
          {
            id: ROOT,
            trigger: TriggerRule.always(),
            policy: options.policy,
            state: agent,
            step: rootStep,
            is_available: (view) =>
              driver.result === undefined &&
              (hasMessages(view) ||
                source.peek() !== undefined ||
                driver.active ||
                driver.unread.size > 0 ||
                !driver.answered),
            // Every report route, current or retained, carries the same harness protocol.
            contract: () => TASK_REPORT_CONTRACT,
            // A failing task's root unblocks its descendants so the failure reaches the task node.
            ...(node.on_error === undefined
              ? {}
              : {
                  on_error(error, signal) {
                    signal?.throwIfAborted();
                    // Public abort joins this evaluation; observe it here, join only after step exits.
                    failureAbort = graph.abort(error).then(
                      () => undefined,
                      (abortError: unknown) => ({
                        workError: error,
                        abortError,
                      }),
                    );
                    throw error;
                  },
                }),
          },
          staged,
          childNode,
          registeredNodeContexts.get(node)?.tracer,
          registeredNodeContexts.get(node)?.recorder,
          String(node.id),
        );
        graph = execution.graph;
        graph
          .addEdge(
            source.id,
            ROOT,
            Edge.message<AgenticInput, AssistantMessage>(SOURCE_EDGE),
          )
          .addEdge(ROOT, sink.id, output);
      } catch (error) {
        return disposeStaged(staged, error);
      }
      // No await between these checks and publication.
      const aborted = staged.find(({ signal }) => signal.aborted)?.signal;
      if (aborted !== undefined) return disposeStaged(staged, aborted.reason);
      if (agent.status === "closed") return disposeStaged(staged, closedNode());
      node.state = graph;
      driver.#outputSink = sink;
      // The root drives the agent from now on; this body keeps only its external reads.
      nodePolicies.set(step, {
        seenValues,
        inputMode: "all-messages",
      });
      driver.policy = rootPolicy;
      return execution;
    };

    /** One bounded advance of the expanded graph, then registration of newly accepted tasks. */
    const advanceGraph = async (
      execution: TaskContext,
      nodeId: string,
    ): Promise<void> => {
      const graph = execution.graph;
      const signal = graph.signal;
      signal.throwIfAborted();
      const drain = () =>
        graph.sink.drain((message) => {
          if (driver.registration === undefined)
            throw new Error("send requires a JuncoGraph host");
          driver.registration.send(message);
        });
      if (graph.available().size > 0) {
        try {
          // The promoted node's actual position, never the former agent's own context.
          const placement = driver.registration?.recorder?.add_context(nodeId);
          const drive = () => execution.step({ signal });
          await (placement === undefined
            ? drive()
            : graph.runWithRecorder(placement, drive));
        } catch (error) {
          const abort = failureAbort;
          failureAbort = undefined;
          const aborted = await abort;
          if (aborted !== undefined) {
            if (signal.aborted && signal.reason !== aborted.workError)
              signal.throwIfAborted();
            throw new AggregateError(
              [aborted.workError, aborted.abortError],
              "Task subgraph abort failed",
              { cause: aborted.workError },
            );
          }
          signal.throwIfAborted();
          try {
            drain();
          } catch (deliveryError) {
            signal.throwIfAborted();
            throw new AggregateError(
              [error, deliveryError],
              "Task graph execution and sink delivery failed",
            );
          }
          throw cancellation(signal, error);
        }
        signal.throwIfAborted();
      }
      drain();
      signal.throwIfAborted();
      await commit(graph);
    };

    /** Only the designated sink publishes a promoted task's exact final result. */
    const finished = (): AssistantMessage | undefined => {
      if (spawned === undefined) return driver.result;
      const graph = spawned.graph;
      if (graph.available().size > 0) return undefined;
      const result = graph.result(graph.sink.id);
      if (O.isNone(result))
        throw new JuncoAgentError(
          "invalid_state",
          "Task graph stopped before producing its sink result",
        );
      return result.value;
    };

    const step: StepFn<Agentic, AgenticInput, AssistantMessage> =
      async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
        // Captured once, at priming: a promoted agent keeps this node's routes and topology.
        driver.registration = registeredNodeContexts.get(this);
        driver.nodeId = String(this.id);
        // A later run of a re-armed node: same agent and retained inbox, a fresh settlement.
        if (driver.result !== undefined) {
          if (spawned !== undefined)
            throw new JuncoAgentError(
              "invalid_state",
              "A promoted task node cannot run again",
            );
          driver.result = undefined;
          driver.active = false;
        }
        let view = yield [];
        /** The result already reported; a failed attempt's state is closed by then. */
        let reported: AssistantMessage | undefined;
        try {
          while (true) {
            if (reported !== undefined) {
              driver.started = false;
              return reported;
            }
            // Retain the delivery for recv; values are seen once staged, so a postponed recv
            // never lets a permanent result starve a newer message.
            const fresh = {
              messages: view.messages,
              values: unseenValues(view.values, seenValues),
            };
            if (spawned === undefined) {
              const messages = driver.#retain(fresh);
              if (driver.result === undefined) {
                await driver.activate(this, messages);
                if (driver.staged.length > 0) spawned = await expand(this);
              }
            } else {
              spawned.graph.source.enqueue(fresh);
              await advanceGraph(spawned, String(this.id));
            }
            const result = finished();
            if (result !== undefined) {
              if (complete === undefined) {
                driver.started = false;
                return result;
              }
              reported = result;
              view = yield await complete.call(this, result);
              continue;
            }
            view = yield [];
          }
        } catch (error) {
          if (driver.staged.length > 0)
            await disposeStaged(driver.staged.splice(0), error);
          throw error;
        }
      };
    nodePolicies.set(step, policy);

    const hasFreshInput = (
      view: ParentView<AgenticInput, AssistantMessage>,
    ): boolean => {
      if (hasMessages(view)) return true;
      for (const id of view.values.keys())
        if (!seenValues.has(id) || seenValues.get(id) !== view.values.get(id))
          return true;
      return false;
    };

    return {
      ...options,
      state: agent,
      step,
      contract: options.contract ?? ((edgeId) => agent.contract(edgeId)),
      is_available:
        options.is_available ??
        ((view, triggered) => {
          if (spawned !== undefined)
            return (
              O.isSome(spawned.graph.result(spawned.graph.sink.id)) ||
              spawned.graph.available().size > 0 ||
              (triggered && hasFreshInput(view))
            );
          return (
            driver.started ||
            (triggered && (agent.status === "ready" || hasFreshInput(view)))
          );
        }),
    };
  }
}
