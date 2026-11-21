import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  type EdgeIdType,
  type ErrorFn,
  holdsUsageFailure,
  type Message,
  messagesOf,
  type Node,
  type NodeGenerator,
  type NodeOptions,
  type NodeSpec,
  type ParentView,
  type StepFn,
} from "dataflow-engine";
import {
  JuncoAgent,
  JuncoAgentError,
  type JuncoAgentNodeContext,
  type Task,
  TaskSchema,
} from "junco-agent";
import { SendTool, type ToolCollection } from "junco-tools";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Agentic } from "./agentic.js";
import type { MockAgent } from "./mock-agent.js";
import {
  type NodePolicy,
  type NodeRegistration,
  nodePolicies,
  registrationOf,
  unseenValues,
} from "./node-policy.js";

/** A tracer that also observes the agent behind an agentic node (`TuiTracer`, `OpikTracer`); `observeAgent` returns its detach function. */
export type AgentObserver = {
  observeAgent<S, N extends TSchema, T>(
    node: Node<S, N, T>,
    events: JuncoAgent["events"],
  ): () => void;
};
const observesAgents = (tracer: unknown): tracer is AgentObserver =>
  typeof (tracer as { observeAgent?: unknown } | undefined)?.observeAgent ===
  "function";

const RETRY_PROMPT =
  "Your previous attempt ended with an error, not because the work was finished. Continue the same task, building on what you already did, and return the complete answer.";

/** The prompt agent a driver advances, reading inputs of `N` and parent values `V`. */
type DrivenAgent<N extends TSchema, V> =
  | JuncoAgent<Skill, PromptTemplate, AgentTool, N, V>
  | MockAgent<Skill, PromptTemplate, AgentTool, N, V>;

type TextTask = Extract<Task, { readonly text: string }>;

/** A received task; `deps` grows as its holder sends subtasks of it. */
type HeldTask = Omit<TextTask, "deps"> & { readonly deps: string[] };

/** The user message a delivered task becomes: its text, then its metadata as a `Task:` JSON line. */
export const renderTask = (task: TextTask): string =>
  `${task.text}\n\nTask: ${JSON.stringify({ taskId: task.taskId, spec: task.spec, deps: task.deps, history: task.history })}`;

const PROVENANCE = ["taskId", "spec", "deps", "history"];

/**
 * `schema` with the provenance properties of every task-shaped object (one with a `taskId`)
 * dropped, through `anyOf`/`oneOf`/`allOf`: a sending node attaches them itself from `send`'s
 * `task`/`spec`/`handoff`, so its model never writes them into a payload.
 */
export function withoutProvenance<S extends TSchema>(schema: S): S {
  const out = { ...schema } as Record<string, unknown>;
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(out[key])) out[key] = out[key].map(withoutProvenance);
  const { properties, required } = out;
  if (
    typeof properties === "object" &&
    properties !== null &&
    "taskId" in properties
  ) {
    out.properties = Object.fromEntries(
      Object.entries(properties).filter(([name]) => !PROVENANCE.includes(name)),
    );
    if (Array.isArray(required))
      out.required = required.filter((name) => !PROVENANCE.includes(name));
  }
  return out as S;
}

/** A task as a model sends it: everything but the provenance its node attaches. */
const TaskDraftSchema = withoutProvenance(TaskSchema);

/**
 * The one run of a prompt agent driven by its graph node. Internal: graphs construct its node for
 * a registered agent without a step.
 */
export class AgentDriver<N extends TSchema, V> {
  readonly #agent: DrivenAgent<N, V>;
  /** The node's one run has started: its staged prompt demanded. */
  #started = false;
  #attempt = 0;
  #soft: readonly Message<N>[] | undefined;
  /** Parent results already staged, with the value staged; a re-resolved edge is fresh again. */
  readonly #seenValues = new Map<EdgeIdType, unknown>();
  /** The node body's policy, sharing {@link #seenValues}. */
  readonly #policy: NodePolicy;
  /** The node's own graph registration, captured when its body was primed. */
  #registration: NodeRegistration<N> | undefined;
  #messageHost: NonNullable<JuncoAgentNodeContext<N>["messaging"]> | undefined;
  /** The node's id, captured when its body was primed; recorded in the history it appends. */
  #node = "";
  /**
   * Every task this node received, by id; a redelivered task replaces its earlier copy. Kept for
   * the node's lifetime: its session keeps showing their ids across runs.
   */
  readonly #received = new Map<string, HeldTask>();

  private constructor(agent: DrivenAgent<N, V>) {
    this.#agent = agent;
    this.#policy = {
      agent,
      seenValues: this.#seenValues,
      inputMode: "all-messages",
    };
  }

  /** Live outbound route schemas and topology for `send` and `info`. */
  #messaging(): NonNullable<JuncoAgentNodeContext<N>["messaging"]> {
    if (this.#messageHost !== undefined) return this.#messageHost;
    const driver = this;
    this.#messageHost = {
      get sendParameters() {
        return (
          driver.#registration?.sendParameters ?? SendTool.parametersFor([])
        );
      },
      send: (message, task) => {
        const registration = this.#registration;
        if (registration === undefined)
          throw new Error("send requires a JuncoGraph host");
        registration.send(this.#outbound(message, task));
      },
      info: () => {
        const registration = this.#registration;
        if (registration === undefined)
          throw new Error("info requires a JuncoGraph host");
        return registration.info();
      },
    };
    return this.#messageHost;
  }

  /**
   * `message` with the task provenance its `send` call implies: a handoff of received task `task`
   * with this node's history entry appended when `spec` is that task's own spec, otherwise a new
   * subtask of it, recorded in its deps. Fields a model put inside the payload never win; non-task
   * payloads pass unchanged.
   */
  #outbound(
    message: Message<N>,
    {
      handoff,
      task,
      spec,
    }: {
      readonly handoff: string;
      readonly task: string;
      readonly spec: string;
    },
  ): Message<N> {
    const payload: unknown = message.payload;
    if (!(Value.Check(TaskDraftSchema, payload) && "text" in payload))
      return message;
    const held = this.#received.get(task);
    if (held === undefined)
      throw new Error(
        `send: task "${task}" was not received; received: ${[...this.#received.keys()].join(", ") || "none"}`,
      );
    const entry = { node: this.#node, desc: held.text, handoff };
    let fields: Pick<TextTask, "taskId" | "spec" | "deps" | "history">;
    if (spec === held.spec)
      fields = {
        taskId: held.taskId,
        spec,
        deps: [...held.deps],
        history: [...held.history, entry],
      };
    else {
      const taskId = crypto.randomUUID();
      held.deps.push(taskId);
      fields = { taskId, spec, deps: [], history: [entry] };
    }
    return { ...message, payload: { ...payload, ...fields } as Static<N> };
  }

  #deliver(view: ParentView<N, V>): Message<N>[] {
    unseenValues(view.values, this.#seenValues);
    return messagesOf(view);
  }

  /**
   * Once started, the run stays resumable until it returns. Before that, the node needs its
   * trigger and either a staged prompt or fresh inbound data: a nonempty message batch, or a
   * parent result not yet staged. Never marks anything seen.
   */
  #isAvailable(view: ParentView<N, V>, triggered: boolean): boolean {
    if (this.#started) return true;
    if (!triggered) return false;
    if (this.#agent.status === "ready") return true;
    for (const id of view.messages.keys())
      if ((view.messages.get(id)?.length ?? 0) > 0) return true;
    for (const id of view.values.keys())
      if (
        !this.#seenValues.has(id) ||
        this.#seenValues.get(id) !== view.values.get(id)
      )
        return true;
    return false;
  }

  /**
   * One activation: advance the run at most once, returning its final message once it settled. A
   * real agent does this with one node context bound: its messaging host, and complaints
   * attributed to `node`'s id and its delivered `messages`.
   */
  async #activate(
    node: Node<Agentic<N, V>, N, V>,
    view: ParentView<N, V>,
    messages: readonly Message<N>[],
  ): Promise<AssistantMessage | undefined> {
    const agent = this.#agent;
    const tracer = this.#registration?.tracer;
    const recorder = this.#registration?.recorder;
    const detach = observesAgents(tracer)
      ? tracer.observeAgent(node, agent.events)
      : undefined;
    try {
      if (!(agent instanceof JuncoAgent))
        return await this.#advance(view, messages);
      return await agent.runWithNodeContext<N, AssistantMessage | undefined>(
        {
          nodeId: node.id,
          messaging: this.#messaging(),
          complaint: { nodeId: node.id, messages },
          ...(recorder === undefined
            ? {}
            : { recorder, recorderNodeId: String(node.id) }),
        },
        () => this.#advance(view, messages),
      );
    } finally {
      detach?.();
    }
  }

  /** Retry inside this activation; park a soft batch for the engine's `on_error` hook. */
  async #recovering(
    node: Node<Agentic<N, V>, N, V>,
    view: ParentView<N, V>,
    messages: readonly Message<N>[],
  ): Promise<AssistantMessage | undefined> {
    const handler = this.#agent.errorHandler;
    const signal = this.#registration?.signal;
    let batch = messages;
    while (true) {
      let error: unknown;
      try {
        const result = await this.#activate(node, view, batch);
        if (
          handler === undefined ||
          result === undefined ||
          result.stopReason !== "error"
        )
          return result;
        error = new Error(
          result.errorMessage ?? 'Agent run ended with stopReason "error"',
          { cause: result },
        );
      } catch (thrown) {
        if (
          handler === undefined ||
          signal?.aborted === true ||
          thrown instanceof DataflowDefinitionError ||
          holdsUsageFailure(thrown) ||
          (thrown instanceof JuncoAgentError && thrown.code === "closed")
        )
          throw thrown;
        error = thrown;
      }
      const recovery = await handler({
        error,
        attempt: ++this.#attempt,
        agent: this.#agent,
        recorder: this.#registration?.recorder?.add_context(String(node.id)),
        signal,
      });
      if (!("retryAfterMs" in recovery)) {
        this.#soft = recovery;
        throw error;
      }
      if (recovery.retryAfterMs > 0)
        await sleep(recovery.retryAfterMs, undefined, { signal }).catch(() =>
          signal?.throwIfAborted(),
        );
      this.#agent.stagePrompt(RETRY_PROMPT);
      batch = []; // The delivered batch was steered by the failed attempt.
    }
  }

  async #advance(
    view: ParentView<N, V>,
    messages: readonly Message<N>[],
  ): Promise<AssistantMessage | undefined> {
    const agent = this.#agent;
    for (const { id, payload: input } of messages) {
      const payload: unknown = input;
      if (Value.Check(TaskDraftSchema, payload) && "text" in payload) {
        if (!Value.Check(TaskSchema, payload))
          throw new DataflowDefinitionError(
            `Task on edge ${id} lacks its taskId, spec, deps or history; construct it with Task.create`,
          );
        this.#received.set(payload.taskId, {
          ...payload,
          deps: [...payload.deps],
        });
        await agent.steer(
          renderTask(payload),
          payload.images?.length ? { images: payload.images } : undefined,
        );
      } else await agent.steer(JSON.stringify({ id, payload }));
    }
    if (!this.#started) {
      // Steers wait in Pi until a staged run is admitted.
      if (agent.status !== "ready") return undefined;
      this.#started = true;
    }
    const result = await agent.next(view);
    if (result.done === true)
      throw new JuncoAgentError(
        "closed",
        "Agentic node closed before prompt settlement",
      );
    const boundary = result.value;
    if (boundary.kind === "yield") {
      this.#policy.lastYield = boundary.reasons;
      return undefined;
    }
    if (boundary.kind === "failed") throw boundary.error;
    // Native settlement already follows every report of the run's tasks.
    return boundary.message;
  }

  /**
   * A graph node driving one prompt agent through a single run.
   *
   * The body first yields `[]` so the engine's priming consumes nothing. Each later activation
   * steers the delivered batch into the agent before advancing it; payload kinds are data, never
   * native commands. A staged prompt function receives the delivered view, including value edges.
   * Without a failure handler the node calls `agent.next()` at most once per activation; a handler
   * can retry failed runs before yielding. A settlement returns the native final message.
   * While it drives a `JuncoAgent`, the agent's `send` admits messages on this node's outgoing
   * message edges, attaching task provenance (see `#outbound`), and `info` describes this node's
   * routes. Delivered tasks are steered as {@link renderTask} text. Unless
   * `options.is_available` replaces it, the node is available before it starts only when its
   * trigger fires with a staged prompt or fresh inbound data, and once started it stays resumable
   * until it returns; a node re-armed through a value self-edge waits for its trigger again.
   * A `JuncoAgent`'s `task` calls run subagents natively; its settlement already follows their reports.
   */
  static node<N extends TSchema, V>(
    agent: DrivenAgent<N, V>,
    options: NodeOptions<N, V> & Pick<ToolCollection, "policy">,
  ): NodeSpec<Agentic<N, V>, N, V> & Pick<ToolCollection, "policy"> {
    const driver = new AgentDriver<N, V>(agent);
    const step: StepFn<Agentic<N, V>, N, V> = async function* (): NodeGenerator<
      N,
      V
    > {
      driver.#registration = registrationOf(this);
      driver.#node = String(this.id);
      let view = yield [];
      while (true) {
        const result = await driver.#recovering(
          this,
          view,
          driver.#deliver(view),
        );
        if (result !== undefined) {
          driver.#started = false;
          driver.#attempt = 0;
          // The native result; the step-less registration admits AssistantMessage into V.
          return result as V;
        }
        view = yield [];
      }
    };
    nodePolicies.set(step, driver.#policy);
    const on_error: ErrorFn<Agentic<N, V>, N, V> = (error) => {
      const soft = driver.#soft;
      driver.#soft = undefined;
      if (soft !== undefined) return soft;
      throw error;
    };

    return {
      ...options,
      state: agent,
      step,
      ...(agent.errorHandler === undefined ? {} : { on_error }),
      is_available:
        options.is_available ??
        ((view, triggered) => driver.#isAvailable(view, triggered)),
    };
  }
}
