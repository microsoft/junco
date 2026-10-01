import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  EdgeIdType as EdgeId,
  Message,
  NodeGenerator,
  NodeOptions,
  ParentView,
  StepFn,
} from "dataflow-engine";
import { type AgenticStep, type JuncoAgent, JuncoAgentError } from "junco-agent";
import type { Agentic, AgenticInput, AgenticNode } from "./agentic.js";
import type { MockAgent } from "./mock-agent.js";
import { type NodePolicy, nodePolicies, unseenValues } from "./node-policy.js";

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
  readonly receive?: (view: ParentView<AgenticInput, AssistantMessage>) => readonly AgenticInput[];
  /** Messages to route when the agent pauses at a `yield` step; omitted, it routes nothing. */
  readonly emit?: (step: Extract<AgenticStep, { kind: "yield" }>) => Message<AgenticInput>[];
};

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
 */
export function agentNode(
  agent: JuncoAgent | MockAgent,
  options: NodeOptions<AgenticInput, AssistantMessage>,
  binding: AgentNodeBinding = {},
): AgenticNode {
  const { prompt, receive = () => [], emit = () => [] } = binding;
  const seenValues = new Set<EdgeId>();
  const policy: NodePolicy = { agent, seenValues };
  /** The node's one run has started: explicitly prompted or its staged prompt demanded. */
  let started = false;

  const dispatch = async (input: AgenticInput): Promise<void> => {
    const kind = input.kind;
    if (kind === "appendMessage") return agent.appendMessage(input.message);
    const native = input.images === undefined ? undefined : { images: input.images };
    switch (kind) {
      case "prompt":
        if (started || agent.status !== "idle") {
          throw new JuncoAgentError("invalid_state", "Agentic node runs one prompt, and its agent must be idle");
        }
        started = true;
        // Its settlement, success or failure, arrives through agent.next().
        agent.prompt(input.text, native).catch(() => undefined);
        return;
      case "steer":
      case "followUp":
      case "nextTurn":
        return agent[kind](input.text, native);
    }
  };

  const step: StepFn<Agentic, AgenticInput, AssistantMessage> = async function* (): NodeGenerator<
    AgenticInput,
    AssistantMessage
  > {
    let view = yield [];
    let pendingPrompt = prompt;
    while (true) {
      for (const input of receive({ messages: view.messages, values: unseenValues(view.values, seenValues) })) {
        await dispatch(input);
      }
      if (pendingPrompt !== undefined) {
        const text = pendingPrompt;
        pendingPrompt = undefined;
        await dispatch({ kind: "prompt", text });
      }
      if (!started) {
        // A control-only delivery to an idle agent has nothing to await.
        if (agent.status !== "ready") {
          view = yield [];
          continue;
        }
        started = true;
      }
      const result = await agent.next();
      if (result.done === true) {
        throw new JuncoAgentError("closed", "Agentic node closed before prompt settlement");
      }
      const boundary = result.value;
      if (boundary.kind === "failed") throw boundary.error;
      if (boundary.kind === "settled") return boundary.message;
      policy.lastYield = boundary.reasons;
      view = yield emit(boundary);
    }
  };
  nodePolicies.set(step, policy);

  const hasFreshInput = (view: ParentView<AgenticInput, AssistantMessage>): boolean => {
    for (const id of view.messages.keys()) if ((view.messages.get(id)?.length ?? 0) > 0) return true;
    for (const id of view.values.keys()) if (!seenValues.has(id)) return true;
    return false;
  };

  return {
    ...options,
    state: agent,
    step,
    is_available:
      options.is_available ??
      ((view, triggered) =>
        started ||
        (triggered && (agent.status === "ready" || (prompt !== undefined && agent.status === "idle") || hasFreshInput(view)))),
  };
}
