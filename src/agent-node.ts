import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import {
  always,
  EdgeId,
  type EdgeIdType,
  type Message,
  type Node,
  type NodeGenerator,
  NodeId,
  type NodeOptions,
  type ParentView,
  type StepFn,
} from "dataflow-engine";
import {
  type AgenticStep,
  JuncoAgent,
  JuncoAgentError,
  type TaskAgentOptions,
  type TaskFailurePolicy,
} from "junco-agent";
import type {
  TaskDecision,
  TaskInput,
  TaskToolDetails,
  TaskToolHost,
  ToolCollectionOptions,
} from "junco-tools";
import type { Agentic, AgenticInput, AgenticNode } from "./agentic.js";
import { cancellation } from "./graph-node.js";
import type { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";
import {
  type NodePolicy,
  nodePolicies,
  registeredNodeTracers,
  unseenValues,
} from "./node-policy.js";
import { appendSpawnChildren, Spawn } from "./spawn.js";

/** How a prompt-agent node executes; carries no registration options. */
export type AgentNodeBinding = {
  /**
   * Starts an idle agent without a staged prompt: dispatched once, after `receive`'s inputs, on the
   * node's first delivery. One agent can run in successive graphs, each node with its own prompt.
   */
  readonly prompt?: string;
  /**
   * Map one delivery to native inputs, dispatched in order. `messages` is the consumed batch;
   * `values` holds only parent results not delivered before, each presented once. Omitted,
   * deliveries dispatch nothing.
   */
  readonly receive?: (
    view: ParentView<AgenticInput, AssistantMessage>,
  ) => readonly AgenticInput[];
  /** Messages to route when the agent pauses at a `yield` step; omitted, it routes nothing. */
  readonly emit?: (
    step: Extract<AgenticStep, { kind: "yield" }>,
  ) => Message<AgenticInput>[];
};

/** The final report a subagent sends back to the agent that started it, as JSON follow-up text. */
type TaskReport = {
  type: "task_result";
  /** The stable handle ID, whichever attempt reports. */
  id: string;
  name?: string;
  attempt: number;
  status: "completed" | "failed";
  output: string;
  stopReason: AssistantMessage["stopReason"];
  error?: string;
  /** The failed task waits for the caller to retry or ignore it. */
  decisionRequired?: true;
};

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
  /** The queued decision request, while one is pending. */
  question?: string;
};

/** The node-internal binding: the public one, plus what a task subagent's node adds. */
type DriverBinding = {
  readonly prompt?: string;
  readonly receive: NonNullable<AgentNodeBinding["receive"]>;
  readonly emit: NonNullable<AgentNodeBinding["emit"]>;
  /** Messages routed once the final result is ready, one activation before it is returned. */
  readonly complete?: (
    this: Node<Agentic, AgenticInput, AssistantMessage>,
    message: AssistantMessage,
  ) => Message<AgenticInput>[] | Promise<Message<AgenticInput>[]>;
  readonly inputMode?: "all-messages";
};

const ROOT = NodeId("root");
const PROCESS_REPORTS = "Process the queued task reports.";

const closedNode = (): JuncoAgentError =>
  new JuncoAgentError("closed", "Agentic node closed before prompt settlement");

/** Close agents no graph owns, then rethrow `primary` with any cleanup failures. */
async function disposeStaged(
  children: readonly { readonly agent: JuncoAgent }[],
  primary: unknown,
): Promise<never> {
  const failures: unknown[] = [];
  for (const { agent } of children) {
    try {
      await agent.return();
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      [primary, ...failures],
      "Staged subagent cleanup failed",
      { cause: primary },
    );
  throw primary;
}

/** `error` and every value reachable from it through `Error.cause` and `AggregateError.errors`. */
function reachable(error: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const value = pending.pop();
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof AggregateError) pending.push(...value.errors);
    if (value instanceof Error && "cause" in value) pending.push(value.cause);
  }
  return seen;
}

/**
 * Whether `cleanup` reports a failure beyond `failure`: closing a faulted agent rethrows the fault
 * that failed it, which is no separate cleanup failure.
 */
function addsFailure(cleanup: unknown, failure: unknown): boolean {
  const known = reachable(failure);
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
    id: EdgeId(`${child.id}->${ROOT}`),
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
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    try {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return;
        seen.add(value);
      }
      if (!(value instanceof Error)) {
        lines.push(String(value));
        return;
      }
      lines.push(
        value.message === "" ? value.name : `${value.name}: ${value.message}`,
      );
      if (value instanceof AggregateError)
        for (const inner of value.errors) visit(inner);
      if ("cause" in value) visit(value.cause);
    } catch {
      lines.push("Unprintable subagent error");
    }
  };
  visit(error);
  return lines.join("\n");
}

/**
 * The one run of a prompt agent, shared by whichever body currently drives it: the node's own body
 * until a task call expands it, then the internal Spawn root. Only the current driver advances it.
 */
class AgentDriver {
  /** The node's one run has started: explicitly prompted or its staged prompt demanded. */
  started = false;
  /** A native run was admitted and its settlement has not been read. */
  active = false;
  /** Mapped native inputs, dispatched by the next activation. */
  readonly inputs: AgenticInput[] = [];
  /** Messages the agent's yields routed, emitted by the original node's body. */
  readonly outbox: Message<AgenticInput>[] = [];
  /** Subagents accepted by task calls or retries and not yet registered in a graph. */
  staged: StagedChild[] = [];
  /** Every admitted task by its stable handle ID. */
  readonly tasks = new Map<string, TaskRecord>();
  /** Admitted tasks neither completed nor ignored. */
  readonly outstanding = new Set<string>();
  /** Report and completion texts to queue natively, in order, at the next opportunity. */
  readonly notices: string[] = [];
  /** Report texts queued natively that have not entered the agent's context. */
  readonly unread = new Set<string>();
  /** A native assistant message followed the latest report that entered the context. */
  answered = true;
  /** The final message, once the run settled with every accepted report processed. */
  result: AssistantMessage | undefined;
  /** The policy of the body currently driving the agent, which records its pauses. */
  policy: NodePolicy;
  #prompt: string | undefined;

  constructor(
    readonly agent: JuncoAgent | MockAgent,
    prompt: string | undefined,
    policy: NodePolicy,
  ) {
    this.#prompt = prompt;
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
      this.#resolve(record);
      return [];
    }
    // Reserved while acquiring, so a concurrent decision cannot start a second attempt.
    record.state = "retrying";
    try {
      this.staged.push(await this.#acquire(caller, record, signal));
    } catch (error) {
      record.state = "awaiting-decision";
      throw error;
    }
    record.question = undefined;
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

  /** Ends `record` as completed or ignored; its batch's last resolution queues its completion. */
  #resolve(record: TaskRecord): void {
    record.state = "terminal";
    record.question = undefined;
    this.outstanding.delete(record.id);
    record.batch.open -= 1;
    if (record.batch.open === 0)
      this.notices.push(
        JSON.stringify({ type: "task_batch_complete", ids: record.batch.ids }),
      );
  }

  /**
   * Consume one report from a task node: only the current attempt's first report on its own
   * return edge counts; duplicate or stale deliveries change nothing.
   */
  async #receive(
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
      edge !== EdgeId(`${record.node}->${ROOT}`) ||
      report.attempt !== record.attempt ||
      record.state !== "running"
    )
      return;
    if (report.status === "completed") {
      this.notices.push(payload.text);
      this.#resolve(record);
      return;
    }
    if (record.policy === "ignore") {
      this.#resolve(record);
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
        return;
      } catch (failure) {
        if (signal.aborted) throw failure;
        error = taskErrorText(failure);
      }
    }
    record.state = "awaiting-decision";
    record.question = JSON.stringify({
      ...report,
      ...(error === undefined ? {} : { error }),
      decisionRequired: true,
    } satisfies TaskReport);
    this.notices.push(record.question);
  }

  /** Queue every pending notice natively, in order. */
  async #flush(): Promise<void> {
    for (const text of this.notices.splice(0)) {
      this.unread.add(text);
      await this.agent.followUp(text);
    }
  }

  /**
   * One activation: dispatch pending inputs, consume task reports, then advance the run at most
   * once. A real agent does this with its task host bound, observing which reports enter its
   * context, and with its complaints attributed to the registered `node`'s id, its delivered
   * `messages` and the tracer of the graph `node` was registered in, if any. `reports` are an
   * expanded root's deliveries, with the signal of the graph that owns their tasks.
   */
  async activate(
    node: Node<Agentic, AgenticInput, AssistantMessage>,
    messages: readonly Message<AgenticInput>[],
    emit: DriverBinding["emit"],
    reports?: { readonly signal: AbortSignal },
  ): Promise<void> {
    const agent = this.agent;
    const advance = async () => {
      if (reports !== undefined)
        for (const message of messages)
          await this.#receive(message, reports.signal);
      return this.#advance(emit);
    };
    if (!(agent instanceof JuncoAgent)) return advance();
    const unsubscribe = agent.events.on("message_end", ({ lane, message }) => {
      if (lane !== "main") return;
      if (message.role === "user") {
        if (this.unread.delete(contentText(message.content)))
          this.answered = false;
      } else if (message.role === "assistant") {
        this.answered = true;
      }
    });
    try {
      const tracer = registeredNodeTracers.get(node);
      await agent.runWithComplaintContext(
        {
          nodeId: node.id,
          messages,
          ...(tracer === undefined ? {} : { tracer }),
        },
        () => agent.runWithTaskHost(this.host, advance),
      );
    } finally {
      unsubscribe();
    }
  }

  async #advance(emit: DriverBinding["emit"]): Promise<void> {
    const agent = this.agent;
    for (const input of this.inputs.splice(0)) await this.#dispatch(input);
    if (this.#prompt !== undefined) {
      const text = this.#prompt;
      this.#prompt = undefined;
      await this.#dispatch({ kind: "prompt", text });
    }
    await this.#flush();
    if (!this.started) {
      // A control-only delivery to an idle agent has nothing to await.
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
    const result = await agent.next();
    if (result.done === true) throw closedNode();
    const boundary = result.value;
    if (boundary.kind === "yield") {
      this.policy.lastYield = boundary.reasons;
      this.outbox.push(...emit(boundary));
      return;
    }
    this.active = false;
    if (boundary.kind === "failed") throw boundary.error;
    // Notices a task call queued during this run keep its answer interim.
    await this.#flush();
    if (this.unread.size > 0 || !this.answered) return;
    const undecided = [...this.tasks.values()].filter(
      ({ question }) => question !== undefined,
    );
    if (undecided.length > 0)
      throw new JuncoAgentError(
        "invalid_state",
        `Task failure decisions required: ${undecided.map(({ id }) => id).join(", ")}`,
      );
    // An earlier answer is interim until every accepted report was answered.
    if (this.outstanding.size === 0) this.result = boundary.message;
  }

  async #dispatch(input: AgenticInput): Promise<void> {
    const agent = this.agent;
    const kind = input.kind;
    if (kind === "appendMessage") return agent.appendMessage(input.message);
    const native =
      input.images === undefined ? undefined : { images: input.images };
    switch (kind) {
      case "prompt":
        if (this.started || agent.status !== "idle") {
          throw new JuncoAgentError(
            "invalid_state",
            "Agentic node runs one prompt, and its agent must be idle",
          );
        }
        this.started = true;
        this.active = true;
        // Its settlement, success or failure, arrives through agent.next().
        agent.prompt(input.text, native).catch(() => undefined);
        return;
      case "steer":
      case "followUp":
      case "nextTurn":
        return agent[kind](input.text, native);
      case "error":
        return agent.followUp(input.text, native);
    }
  }
}

function hasMessages(
  view: ParentView<AgenticInput, AssistantMessage>,
): boolean {
  for (const id of view.messages.keys())
    if ((view.messages.get(id)?.length ?? 0) > 0) return true;
  return false;
}

/** The batch one activation received: each payload with its edge, in edge then delivery order. */
function deliveredMessages<N, T>(view: ParentView<N, T>): Message<N>[] {
  const delivered: Message<N>[] = [];
  for (const id of view.messages.keys())
    for (const payload of view.messages.get(id) ?? [])
      delivered.push({ id, payload });
  return delivered;
}

/** The node body and availability of one prompt agent, expanding into a Spawn graph on `task`. */
function driverNode(
  agent: JuncoAgent | MockAgent,
  options: NodeOptions<AgenticInput, AssistantMessage> &
    Pick<ToolCollectionOptions, "policy">,
  binding: DriverBinding,
): AgenticNode {
  const { prompt, receive, emit, complete, inputMode } = binding;
  const seenValues = new Set<EdgeIdType>();
  const policy: NodePolicy = {
    agent,
    seenValues,
    ...(inputMode === undefined ? {} : { inputMode }),
  };
  const driver = new AgentDriver(agent, prompt, policy);
  /** The Spawn graph this node's state became, once a task call expanded it. */
  let spawned: JuncoGraph | undefined;

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
    // The failed subagent, or the Spawn graph it expanded into; never the containing graph.
    const state = node.state;
    // This teardown owns the state's outcome; the owning graph's close must not repeat it.
    nodePolicies.get(node.step)!.closedTaskState = state;
    try {
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
   * A task subagent's node: started by its queued prompt, reporting its final message. An
   * unsuccessful settlement or a thrown failure closes the subagent and reports the failure as an
   * `error` input; cancellation of the owning graph propagates instead.
   */
  const childNode = (child: StagedChild): AgenticNode => ({
    ...driverNode(
      child.agent,
      {
        id: NodeId(child.id),
        trigger: always(),
        policy: options.policy,
        ...(child.name === undefined ? {} : { description: child.name }),
      },
      {
        receive: (view) =>
          [...view.messages.keys()].flatMap(
            (id) => view.messages.get(id) ?? [],
          ),
        emit: () => [],
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
          spawned?.signal.throwIfAborted();
          if (agent.status === "closed") throw closedNode();
          return retire(
            this,
            child,
            new Error(
              message.errorMessage ?? `Subagent stopped: ${message.stopReason}`,
            ),
            { output, stopReason: message.stopReason, ...error },
          );
        },
        inputMode: "all-messages",
      },
    ),
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
  });

  /** Register staged children under the root and send each its prompt through its queue. */
  const commit = async (graph: JuncoGraph): Promise<void> => {
    const staged = driver.staged;
    if (staged.length === 0) return;
    driver.staged = [];
    // As at expansion: a call aborted after acquiring its children never publishes them.
    const aborted = staged.find(({ signal }) => signal.aborted)?.signal;
    if (aborted !== undefined) await disposeStaged(staged, aborted.reason);
    try {
      appendSpawnChildren(graph, ROOT, staged, childNode);
    } catch (error) {
      await disposeStaged(
        staged.filter(
          ({ id, agent }) => graph.getNode(NodeId(id))?.state !== agent,
        ),
        error,
      );
    }
    for (const { id, prompt } of staged) {
      graph.emit(ROOT, {
        id: EdgeId(`${ROOT}->${id}`),
        payload: { kind: "prompt", text: prompt },
      });
    }
  };

  /**
   * Replace this node's state with a Spawn graph of the same running agent as its root plus the
   * staged children. Nothing else about the node changes; the agent's lifetime moves to the root.
   */
  const expand = async (
    node: Node<Agentic, AgenticInput, AssistantMessage>,
  ): Promise<JuncoGraph> => {
    const staged = driver.staged;
    driver.staged = [];
    const rootPolicy: NodePolicy = { agent, inputMode: "all-messages" };
    const rootStep: StepFn<Agentic, AgenticInput, AssistantMessage> =
      async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
        let messages: Message<AgenticInput>[] = [];
        while (true) {
          await driver.activate(this, messages, emit, { signal: graph.signal });
          if (driver.result !== undefined) return driver.result;
          messages = deliveredMessages(yield []);
        }
      };
    nodePolicies.set(rootStep, rootPolicy);
    let graph: JuncoGraph;
    try {
      graph = Spawn(
        {
          id: ROOT,
          trigger: always(),
          policy: options.policy,
          state: agent,
          step: rootStep,
          is_available: (view) =>
            driver.result === undefined &&
            (driver.inputs.length > 0 ||
              hasMessages(view) ||
              driver.active ||
              driver.unread.size > 0 ||
              !driver.answered),
          // A failing task's root unblocks its descendants so the failure reaches the task node.
          ...(node.on_error === undefined
            ? {}
            : {
                async on_error(error, signal) {
                  signal?.throwIfAborted();
                  try {
                    await graph.abort(error);
                  } catch (abortError) {
                    throw new AggregateError(
                      [error, abortError],
                      "Task subgraph abort failed",
                      { cause: error },
                    );
                  }
                  throw error;
                },
              }),
        },
        staged,
        childNode,
      );
    } catch (error) {
      return disposeStaged(staged, error);
    }
    // No await between these checks and publication.
    const aborted = staged.find(({ signal }) => signal.aborted)?.signal;
    if (aborted !== undefined) return disposeStaged(staged, aborted.reason);
    if (agent.status === "closed") return disposeStaged(staged, closedNode());
    node.state = graph;
    for (const { id, prompt } of staged) {
      graph.emit(ROOT, {
        id: EdgeId(`${ROOT}->${id}`),
        payload: { kind: "prompt", text: prompt },
      });
    }
    // The root drives the agent from now on; this body keeps only its external reads.
    nodePolicies.set(step, {
      seenValues,
      ...(inputMode === undefined ? {} : { inputMode }),
    });
    driver.policy = rootPolicy;
    return graph;
  };

  /** One bounded advance of the expanded graph, then registration of newly accepted tasks. */
  const advanceGraph = async (graph: JuncoGraph): Promise<void> => {
    const signal = graph.signal;
    signal.throwIfAborted();
    if (graph.available().size > 0) {
      try {
        await graph.step({ signal });
      } catch (error) {
        throw cancellation(signal, error);
      }
      signal.throwIfAborted();
    }
    await commit(graph);
  };

  /** The final message once the run and every subagent's node finished. */
  const finished = (): AssistantMessage | undefined =>
    spawned === undefined || spawned.available().size === 0
      ? driver.result
      : undefined;

  const step: StepFn<Agentic, AgenticInput, AssistantMessage> =
    async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
      let view = yield [];
      /** The result already reported; a failed attempt's state is closed by then. */
      let reported: AssistantMessage | undefined;
      try {
        while (true) {
          if (reported !== undefined) return reported;
          const messages = deliveredMessages(view);
          for (const input of receive({
            messages: view.messages,
            values: unseenValues(view.values, seenValues),
          }))
            driver.inputs.push(input);
          if (driver.outbox.length === 0 && finished() === undefined) {
            if (spawned === undefined) {
              await driver.activate(this, messages, emit);
              if (driver.staged.length > 0) spawned = await expand(this);
            } else {
              await advanceGraph(spawned);
            }
          }
          // Output first; a result ready at the same time returns on the next activation.
          if (driver.outbox.length > 0) {
            view = yield driver.outbox.splice(0);
            continue;
          }
          const result = finished();
          if (result !== undefined) {
            if (complete === undefined) return result;
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
    for (const id of view.values.keys()) if (!seenValues.has(id)) return true;
    return false;
  };

  return {
    ...options,
    state: agent,
    step,
    is_available:
      options.is_available ??
      ((view, triggered) => {
        if (spawned !== undefined)
          return (
            driver.result !== undefined ||
            spawned.available().size > 0 ||
            driver.outbox.length > 0 ||
            (triggered && hasFreshInput(view))
          );
        return (
          driver.started ||
          (triggered &&
            (agent.status === "ready" ||
              (prompt !== undefined && agent.status === "idle") ||
              hasFreshInput(view)))
        );
      }),
  };
}

/**
 * A graph node driving one prompt agent through a single run.
 *
 * The body first yields `[]` so the engine's priming consumes nothing. Each later activation hands
 * `receive` the delivered batch and any parent result it has not seen, dispatches the returned
 * inputs through their native methods — starting a `prompt` without awaiting it and awaiting every
 * queue or session mutation — then, once the run has started, calls `agent.next()` exactly once:
 * a `yield` step routes `emit`'s messages and leaves the agent suspended, a settled step returns
 * the native final message, and a failed step throws the native error. A node runs at most one
 * prompt. Unless `options.is_available` replaces it, the node is available before it starts only
 * when its trigger fires with a staged prompt, its own `prompt` for an idle agent, or fresh inbound
 * data, and once started it stays resumable until its run settles.
 *
 * A `JuncoAgent`'s `task` calls are admitted while the node drives it. At the resulting pause the
 * node's state becomes a `Spawn` graph whose root is the same running agent and whose children run
 * one fresh subagent per task, linked by paired message queues; the node keeps its id, trigger and
 * edges, and later drives that graph one step per activation. Each subagent starts from its queued
 * prompt and sends its final report back through its queue; the agent receives reports as
 * follow-ups, and the node returns its answer only after every report entered its context and was
 * answered. Later task calls add siblings under the same root.
 */
export function agentNode(
  agent: JuncoAgent | MockAgent,
  options: NodeOptions<AgenticInput, AssistantMessage> &
    Pick<ToolCollectionOptions, "policy">,
  binding: AgentNodeBinding = {},
): AgenticNode {
  const { prompt, receive = () => [], emit = () => [] } = binding;
  return driverNode(agent, options, {
    ...(prompt === undefined ? {} : { prompt }),
    receive,
    emit,
  });
}
