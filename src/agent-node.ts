import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type EdgeIdType,
  fires,
  type Message,
  messagesOf,
  type Node,
  type NodeGenerator,
  type NodeOptions,
  type NodeSpec,
  type ParentView,
  type StepFn,
  type TriggerRule,
} from "dataflow-engine";
import {
  JuncoAgent,
  JuncoAgentError,
  type JuncoAgentNodeContext,
} from "junco-agent";
import { RecvTool, SendTool, type ToolCollection } from "junco-tools";
import type { Static, TSchema } from "typebox";
import type { Agentic } from "./agentic.js";
import type { MockAgent } from "./mock-agent.js";
import {
  type NodePolicy,
  type NodeRegistration,
  nodePolicies,
  registrationOf,
  unseenValues,
} from "./node-policy.js";
import { TuiTracer } from "./tui-tracer.js";

/** The prompt agent a driver advances, reading inputs of `N` and parent values `V`. */
type DrivenAgent<N extends TSchema, V> =
  | JuncoAgent<Skill, PromptTemplate, AgentTool, N, V>
  | MockAgent<Skill, PromptTemplate, AgentTool, N, V>;

/**
 * The one run of a prompt agent driven by its graph node. Internal: graphs construct its node for
 * a registered agent without a step.
 */
export class AgentDriver<N extends TSchema, V> {
  readonly #agent: DrivenAgent<N, V>;
  /** The node's one run has started: its staged prompt demanded. */
  #started = false;
  /** Delivered message batches per edge, retained in FIFO order until the model's `recv`. */
  readonly #messages = new Map<EdgeIdType, Static<N>[]>();
  /** Delivered parent results, each staged once, retained until the model's `recv`. */
  readonly #values = new Map<EdgeIdType, V>();
  /** Parent results already staged, with the value staged; a re-resolved edge is fresh again. */
  readonly #seenValues = new Map<EdgeIdType, unknown>();
  /** The node body's policy, sharing {@link #seenValues}. */
  readonly #policy: NodePolicy;
  /** The node's own graph registration, captured when its body was primed. */
  #registration: NodeRegistration<N, V> | undefined;
  #messageHost:
    | NonNullable<JuncoAgentNodeContext<N, V>["messaging"]>
    | undefined;

  private constructor(agent: DrivenAgent<N, V>) {
    this.#agent = agent;
    this.#policy = {
      agent,
      seenValues: this.#seenValues,
      inputMode: "all-messages",
    };
  }

  /**
   * The node's messaging host, created once: its retained inbox for `recv`, and its registration's
   * routes, route schemas and topology for `send`, `recv` and `info`. Every access reads the
   * current registration and checks its current signal.
   */
  #messaging(): NonNullable<JuncoAgentNodeContext<N, V>["messaging"]> {
    if (this.#messageHost !== undefined) return this.#messageHost;
    const driver = this;
    const view = { messages: this.#messages, values: this.#values };
    this.#messageHost = {
      get view() {
        driver.#registration?.signal.throwIfAborted();
        return view;
      },
      get recvOutputSchema() {
        return (
          driver.#registration?.recvOutputSchema ??
          RecvTool.outputSchemaFor([], [])
        );
      },
      get sendParameters() {
        return (
          driver.#registration?.sendParameters ?? SendTool.parametersFor([])
        );
      },
      consume: () => {
        this.#registration?.signal.throwIfAborted();
        this.#messages.clear();
        this.#values.clear();
      },
      send: (message) => {
        const registration = this.#registration;
        if (registration === undefined)
          throw new Error("send requires a JuncoGraph host");
        registration.send(message);
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
   * Retain original parent edge identities and FIFO batches for the agent's recv tool. Values are
   * seen once staged, so a postponed recv never lets a permanent result starve a newer message.
   */
  #retain(view: ParentView<N, V>): Message<N>[] {
    const messages = messagesOf(view);
    for (const { id, payload } of messages) {
      const retained = this.#messages.get(id);
      if (retained === undefined) this.#messages.set(id, [payload]);
      else retained.push(payload);
    }
    const values = unseenValues(view.values, this.#seenValues);
    for (const id of values.keys()) {
      const value = values.get(id);
      if (value !== undefined) this.#values.set(id, value);
    }
    return messages;
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

  /** What `recv` returns right now, for the model's next request — only while that inbox would fire `trigger`. */
  #briefing<M extends TSchema>(trigger: TriggerRule<M, V>): string | undefined {
    if (this.#messages.size === 0 && this.#values.size === 0) return undefined;
    if (!fires(trigger, (id) => this.#messages.has(id) || this.#values.has(id)))
      return undefined;
    const entries = [
      ...[...this.#messages].map(([id, batch]) => `${id}: ${batch.length}`),
      ...[...this.#values.keys()].map((id) => `${id}: 1`),
    ];
    return `Inbox { ${entries.join(", ")} } read with recv tool`;
  }

  /**
   * One activation: advance the run at most once, returning its final message once it settled. A
   * real agent does this with one node context bound: its messaging host, and complaints
   * attributed to `node`'s id, its delivered `messages` and its graph's tracer, if any.
   */
  async #activate(
    node: Node<Agentic<N, V>, N, V>,
    messages: readonly Message<N>[],
  ): Promise<AssistantMessage | undefined> {
    const agent = this.#agent;
    const tracer = this.#registration?.tracer;
    const recorder = this.#registration?.recorder;
    const detach =
      tracer instanceof TuiTracer
        ? tracer.observeAgent(node, agent.events)
        : undefined;
    try {
      if (!(agent instanceof JuncoAgent)) return await this.#advance();
      return await agent.runWithNodeContext<N, V, AssistantMessage | undefined>(
        {
          messaging: this.#messaging(),
          briefing: () => this.#briefing(node.trigger),
          complaint: {
            nodeId: node.id,
            messages,
            ...(tracer === undefined ? {} : { tracer }),
          },
          ...(recorder === undefined
            ? {}
            : { recorder, recorderNodeId: String(node.id) }),
        },
        () => this.#advance(),
      );
    } finally {
      detach?.();
    }
  }

  async #advance(): Promise<AssistantMessage | undefined> {
    const agent = this.#agent;
    if (!this.#started) {
      // Delivered data waits in the inbox; an agent without a staged prompt has nothing to await.
      if (agent.status !== "ready") return undefined;
      this.#started = true;
    }
    // The retained inbox is also the view a staged prompt function reads.
    const result = await agent.next(this.#messaging().view);
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
   * retains the delivered batch and any parent result it has not seen in the node's inbox, which
   * the model drains through `recv`; payloads are data, never native commands. The node demands
   * the agent's staged prompt once, passing that inbox as the view a prompt function reads, then
   * calls `agent.next()` at most once per activation: a `yield` step leaves the agent suspended, a
   * settled step returns the native final message, and a failed step throws the native error.
   * While it drives a `JuncoAgent`, the agent's `send` admits messages on this node's outgoing
   * message edges and `info` describes this node's routes. Unless
   * `options.is_available` replaces it, the node is available before it starts only when its
   * trigger fires with a staged prompt or fresh inbound data, and once started it stays resumable
   * until it returns; a node re-armed through a value self-edge waits for its trigger again.
   * A `JuncoAgent`'s `task` calls run subagents natively; its settlement already follows their reports.
   */
  static node<N extends TSchema, V>(
    agent: DrivenAgent<N, V>,
    options: NodeOptions<N, V> &
      Pick<NodeSpec<Agentic<N, V>, N, V>, "on_error"> &
      Pick<ToolCollection, "policy">,
  ): NodeSpec<Agentic<N, V>, N, V> & Pick<ToolCollection, "policy"> {
    const driver = new AgentDriver<N, V>(agent);
    const step: StepFn<Agentic<N, V>, N, V> = async function* (): NodeGenerator<
      N,
      V
    > {
      driver.#registration = registrationOf(this);
      let view = yield [];
      while (true) {
        const result = await driver.#activate(this, driver.#retain(view));
        if (result !== undefined) {
          driver.#started = false;
          // The native result; the step-less registration admits AssistantMessage into V.
          return result as V;
        }
        view = yield [];
      }
    };
    nodePolicies.set(step, driver.#policy);

    return {
      ...options,
      state: agent,
      step,
      is_available:
        options.is_available ??
        ((view, triggered) => driver.#isAvailable(view, triggered)),
    };
  }
}
