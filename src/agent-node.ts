import { AgentHarnessError, type AgentMessage, type PromptTemplate, type Skill } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type {
  DataflowGraph,
  EdgeIdType as EdgeId,
  Lookup,
  Message,
  NodeGenerator,
  NodeIdType as NodeId,
  NodeSpec,
  ParentView,
  StepFn,
  TriggerRule,
} from "dataflow-engine";
import type { Agentic, AgenticStep, AgenticYieldReason } from "junco-agent";
import type { PiScheduler } from "./pi-scheduler.js";

/** One input for a graph member, dispatched through the native method of the same name. */
export type AgenticInput =
  | {
      readonly kind: "prompt" | "steer" | "followUp" | "nextTurn";
      readonly text: string;
      readonly images?: ImageContent[];
    }
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };

/** An agency's graph: Agentic members exchanging {@link AgenticInput}s and returning final messages. */
export type AgencyGraph<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate> = DataflowGraph<
  Agentic,
  AgenticInput,
  AssistantMessage,
  unknown,
  PiScheduler<S, P>
>;

/** How one Agentic member meets the graph. */
export type AgentNodeOptions = {
  readonly id?: NodeId;
  /** What this member does, shown to the scheduler. */
  readonly description: string;
  readonly trigger: TriggerRule<AgenticInput, AssistantMessage>;
  /**
   * Map one delivery to native inputs, dispatched in order. `messages` is the consumed batch;
   * `values` holds only parent results not delivered before, each presented once.
   */
  readonly receive: (view: ParentView<AgenticInput, AssistantMessage>) => readonly AgenticInput[];
  /** Messages to route when the member pauses at a `yield` step. */
  readonly emit: (step: Extract<AgenticStep, { kind: "yield" }>) => Message<AgenticInput>[];
};

/** Adapter bookkeeping of one member node, shared with its scheduler and GraphInfo. */
export type AgentNodeRecord = {
  readonly agent: Agentic;
  readonly description: string;
  /** Value edges whose result `receive` has already seen. */
  readonly seenValues: Set<EdgeId>;
  /** The node's one run has started: explicitly prompted or its staged prompt demanded. */
  started: boolean;
  lastYield: readonly AgenticYieldReason[] | undefined;
};

type AgentStep = StepFn<Agentic, AgenticInput, AssistantMessage>;

/** Keyed by the generated body, so node state itself stays the Agentic instance. */
const records = new WeakMap<AgentStep, AgentNodeRecord>();

/** The adapter record of a body created by {@link agentNode}, if it is one. */
export function agentNodeRecord(step: AgentStep): AgentNodeRecord | undefined {
  return records.get(step);
}

/** Only the resolved parent results `seen` has not recorded, recording them now. */
function unseenValues(
  values: Lookup<EdgeId, AssistantMessage>,
  seen: Set<EdgeId>,
): Lookup<EdgeId, AssistantMessage> {
  const fresh = [...values.keys()].filter((id) => !seen.has(id));
  for (const id of fresh) seen.add(id);
  return {
    get: (id) => (fresh.includes(id) ? values.get(id) : undefined),
    has: (id) => fresh.includes(id),
    keys: () => fresh,
  };
}

/**
 * A graph node driving one Agentic member through a single run.
 *
 * The body first yields `[]` so the engine's priming consumes nothing. Each later activation hands
 * `receive` the delivered batch and any parent result it has not seen, dispatches the returned
 * inputs through their native methods — starting a `prompt` without awaiting it and awaiting every
 * queue or session mutation — then, once the run has started, calls `agent.next()` exactly once:
 * a `yield` step routes `emit`'s messages and leaves the member suspended, a settled step returns
 * the native final message, and a failed step throws the native error. A node runs at most one
 * prompt; before it starts, the node is available only when its trigger fires with a staged prompt
 * or fresh inbound data, and once started it stays resumable until its run settles.
 */
export function agentNode(
  agent: Agentic,
  options: AgentNodeOptions,
): NodeSpec<Agentic, AgenticInput, AssistantMessage> {
  const { receive, emit, trigger } = options;
  const record: AgentNodeRecord = {
    agent,
    description: options.description,
    seenValues: new Set(),
    started: false,
    lastYield: undefined,
  };

  const dispatch = async (input: AgenticInput): Promise<void> => {
    const kind = input.kind;
    if (kind === "appendMessage") return agent.appendMessage(input.message);
    const native = input.images === undefined ? undefined : { images: input.images };
    switch (kind) {
      case "prompt":
        if (record.started || agent.status !== "idle") {
          throw new AgentHarnessError("invalid_state", "Agentic node runs one prompt, and its agent must be idle");
        }
        record.started = true;
        // Its settlement, success or failure, arrives through agent.next().
        agent.prompt(input.text, native).catch(() => undefined);
        return;
      case "steer":
      case "followUp":
      case "nextTurn":
        return agent[kind](input.text, native);
    }
  };

  const step: AgentStep = async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
    let view = yield [];
    while (true) {
      for (const input of receive({ messages: view.messages, values: unseenValues(view.values, record.seenValues) })) {
        await dispatch(input);
      }
      if (!record.started) {
        // A control-only delivery to an idle member has nothing to await.
        if (agent.status !== "ready") {
          view = yield [];
          continue;
        }
        record.started = true;
      }
      const result = await agent.next();
      if (result.done) {
        throw new AgentHarnessError("invalid_state", "Agentic node closed before prompt settlement");
      }
      const boundary = result.value;
      if (boundary.kind === "failed") throw boundary.error;
      if (boundary.kind === "settled") return boundary.message;
      record.lastYield = boundary.reasons;
      view = yield emit(boundary);
    }
  };
  records.set(step, record);

  const fires = (view: ParentView<AgenticInput, AssistantMessage>): boolean => {
    let met = 0;
    for (const id of trigger.rule) {
      if ((view.messages.get(id)?.length ?? 0) > 0 || view.values.has(id)) met++;
    }
    return trigger.kind === "all" ? met === trigger.rule.length : met > 0;
  };
  const hasFreshInput = (view: ParentView<AgenticInput, AssistantMessage>): boolean => {
    for (const id of view.messages.keys()) if ((view.messages.get(id)?.length ?? 0) > 0) return true;
    for (const id of view.values.keys()) if (!record.seenValues.has(id)) return true;
    return false;
  };

  return {
    ...(options.id === undefined ? {} : { id: options.id }),
    state: agent,
    trigger,
    step,
    is_available: (view) =>
      record.started || (fires(view) && (agent.status === "ready" || hasFreshInput(view))),
  };
}
