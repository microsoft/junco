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
import { type AgenticStep, JuncoAgent, JuncoAgentError } from "junco-agent";
import type { TaskToolDetails, TaskToolHost } from "junco-tools";
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
  id: string;
  name?: string;
  status: "completed" | "failed";
  output: string;
  stopReason: AssistantMessage["stopReason"];
  error?: string;
};

/** A subagent a task call acquired, not yet registered in a graph. */
type StagedChild = {
  readonly id: string;
  readonly name?: string;
  readonly prompt: string;
  readonly agent: JuncoAgent;
  /** The admitting tool call's native abort signal. */
  readonly signal: AbortSignal;
};

/** The node-internal binding: the public one, plus what a task subagent's node adds. */
type DriverBinding = {
  readonly prompt?: string;
  readonly receive: NonNullable<AgentNodeBinding["receive"]>;
  readonly emit: NonNullable<AgentNodeBinding["emit"]>;
  /** Messages routed once the final result is ready, one activation before it is returned. */
  readonly complete?: (message: AssistantMessage) => Message<AgenticInput>[];
  readonly inputMode?: "all-messages";
};

const ROOT = NodeId("root");
const PROCESS_REPORTS = "Process the queued task reports.";

const closedNode = (): JuncoAgentError =>
  new JuncoAgentError("closed", "Agentic node closed before prompt settlement");

/** Close children no graph owns, then rethrow `primary` with any cleanup failures. */
async function disposeStaged(
  children: readonly StagedChild[],
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

/** A report on its child's return queue: failed reports are `error` inputs, the rest follow-ups. */
function taskReportMessage(report: TaskReport): Message<AgenticInput> {
  return {
    id: EdgeId(`${report.id}->${ROOT}`),
    payload: {
      kind: report.status === "failed" ? "error" : "followUp",
      text: JSON.stringify(report),
    },
  };
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
  /** Subagents accepted by task calls and not yet registered in a graph. */
  staged: StagedChild[] = [];
  /** Accepted subagents whose report has not crossed into this agent's node. */
  readonly outstanding = new Set<string>();
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

  /** Admits a task batch: acquires every subagent, then stages them with fresh handle IDs. */
  readonly host: TaskToolHost = async (_toolCallId, input, signal) => {
    const caller = this.agent;
    if (!(caller instanceof JuncoAgent))
      throw new JuncoAgentError(
        "invalid_state",
        "Only a JuncoAgent runs tasks",
      );
    const children = await caller.createSubagents(
      input.tasks.map(({ model, tools }) => ({ model, tools })),
      signal,
    );
    const staged = children.map((agent, index): StagedChild => {
      const { name, task } = input.tasks[index]!;
      return {
        id: `task-${crypto.randomUUID()}`,
        ...(name === undefined ? {} : { name }),
        prompt: `${input.context}\n\n${task}`,
        agent,
        signal,
      };
    });
    this.staged.push(...staged);
    for (const { id } of staged) this.outstanding.add(id);
    return staged.map(({ id, name }): TaskToolDetails["tasks"][number] =>
      name === undefined ? { id } : { id, name },
    );
  };

  /**
   * One activation: dispatch pending inputs, queue `reports` as follow-ups, then advance the run
   * at most once. A real agent does this with its task host bound, observing which reports enter
   * its context, and with its complaints attributed to the registered `node`'s id, its delivered
   * `messages` and the tracer of the graph `node` was registered in, if any.
   */
  async activate(
    node: Node<Agentic, AgenticInput, AssistantMessage>,
    messages: readonly Message<AgenticInput>[],
    reports: readonly string[],
    emit: DriverBinding["emit"],
  ): Promise<void> {
    const agent = this.agent;
    if (!(agent instanceof JuncoAgent)) return this.#advance(reports, emit);
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
        () =>
          agent.runWithTaskHost(this.host, () => this.#advance(reports, emit)),
      );
    } finally {
      unsubscribe();
    }
  }

  async #advance(
    reports: readonly string[],
    emit: DriverBinding["emit"],
  ): Promise<void> {
    const agent = this.agent;
    for (const input of this.inputs.splice(0)) await this.#dispatch(input);
    if (this.#prompt !== undefined) {
      const text = this.#prompt;
      this.#prompt = undefined;
      await this.#dispatch({ kind: "prompt", text });
    }
    for (const text of reports) {
      const report: unknown = JSON.parse(text);
      if (
        typeof report !== "object" ||
        report === null ||
        !("id" in report) ||
        typeof report.id !== "string"
      )
        throw new JuncoAgentError("invalid_state", "Malformed task report");
      this.outstanding.delete(report.id);
      this.unread.add(text);
      await agent.followUp(text);
    }
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
    // An earlier answer is interim until every accepted report was answered.
    if (this.outstanding.size === 0 && this.unread.size === 0 && this.answered)
      this.result = boundary.message;
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
  options: NodeOptions<AgenticInput, AssistantMessage>,
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
   * A task subagent's node: started by its queued prompt, reporting its final message. A thrown
   * failure closes the subagent and reports it as an `error` input instead of a result.
   */
  const childNode = (child: StagedChild): AgenticNode => ({
    ...driverNode(
      child.agent,
      {
        id: NodeId(child.id),
        trigger: always(),
        ...(child.name === undefined ? {} : { description: child.name }),
      },
      {
        receive: (view) =>
          [...view.messages.keys()].flatMap(
            (id) => view.messages.get(id) ?? [],
          ),
        emit: () => [],
        complete: (message) => [
          taskReportMessage({
            type: "task_result",
            id: child.id,
            ...(child.name === undefined ? {} : { name: child.name }),
            status: message.stopReason === "stop" ? "completed" : "failed",
            output: contentText(message.content),
            stopReason: message.stopReason,
            ...(message.errorMessage === undefined
              ? {}
              : { error: message.errorMessage }),
          }),
        ],
        inputMode: "all-messages",
      },
    ),
    async on_error(error, signal) {
      signal?.throwIfAborted();
      // The failed subagent, or the Spawn graph it expanded into; never the containing graph.
      const state = this.state;
      let failure = error;
      try {
        await state[Symbol.asyncDispose]();
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          "Task subagent execution and cleanup failed",
          { cause: error },
        );
      }
      const notification = [
        taskReportMessage({
          type: "task_result",
          id: child.id,
          ...(child.name === undefined ? {} : { name: child.name }),
          status: "failed",
          output: "",
          stopReason: "error",
          error: taskErrorText(failure),
        }),
      ];
      signal?.throwIfAborted();
      // The report owns this teardown's outcome; the owning graph's close must not rethrow it.
      nodePolicies.get(this.step)!.closedTaskState = state;
      return notification;
    },
  });

  /** Register staged children under the root and send each its prompt through its queue. */
  const commit = async (graph: JuncoGraph): Promise<void> => {
    const staged = driver.staged;
    if (staged.length === 0) return;
    driver.staged = [];
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
        let reports: string[] = [];
        let messages: Message<AgenticInput>[] = [];
        while (true) {
          await driver.activate(this, messages, reports, emit);
          if (driver.result !== undefined) return driver.result;
          const view = yield [];
          messages = deliveredMessages(view);
          reports = [];
          for (const { payload } of messages)
            if (payload.kind === "followUp" || payload.kind === "error")
              reports.push(payload.text);
        }
      };
    nodePolicies.set(rootStep, rootPolicy);
    let graph: JuncoGraph;
    try {
      graph = Spawn(
        {
          id: ROOT,
          trigger: always(),
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
      let reported = false;
      try {
        while (true) {
          const messages = deliveredMessages(view);
          for (const input of receive({
            messages: view.messages,
            values: unseenValues(view.values, seenValues),
          }))
            driver.inputs.push(input);
          if (driver.outbox.length === 0 && finished() === undefined) {
            if (spawned === undefined) {
              await driver.activate(this, messages, [], emit);
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
            if (complete === undefined || reported) return result;
            reported = true;
            view = yield complete(result);
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
            spawned.available().size > 0 ||
            driver.outbox.length > 0 ||
            driver.result !== undefined ||
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
  options: NodeOptions<AgenticInput, AssistantMessage>,
  binding: AgentNodeBinding = {},
): AgenticNode {
  const { prompt, receive = () => [], emit = () => [] } = binding;
  return driverNode(agent, options, {
    ...(prompt === undefined ? {} : { prompt }),
    receive,
    emit,
  });
}
