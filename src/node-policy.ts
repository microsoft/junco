import type { ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  DataflowTracer,
  EdgeIdType as EdgeId,
  InputSchedule,
  Lookup,
  NodeAvailability,
} from "dataflow-engine";
import {
  DataflowDefinitionError,
  messageInputs,
  triggerInputs,
} from "dataflow-engine";
import type {
  AgenticYieldReason,
  JuncoAgent,
  JuncoAgentNodeContext,
} from "junco-agent";
import {
  MODEL_STRENGTHS,
  type ModelStrength,
  type ModelStrengthName,
  type Scheduler,
  type SchedulerContext,
  context as schedulerContext,
} from "junco-scheduler";
import type { ToolCollection } from "junco-tools";
import type { Agentic, AgenticNode } from "./agentic.js";
import type { JuncoGraph } from "./junco-graph.js";
import type { MockAgent } from "./mock-agent.js";

/** One rung: a "provider/model-id" and its reasoning effort (`"off"` when omitted). */
export type LadderRung = {
  readonly model: string;
  readonly thinking?: ThinkingLevel;
};
/** Every strength's model; all five rungs are required. */
export type Ladder = Readonly<Record<ModelStrengthName, LadderRung>>;

export function validateLadder(ladder: Ladder): void {
  for (const name of MODEL_STRENGTHS) {
    const rung = ladder?.[name];
    if (
      rung === null ||
      typeof rung !== "object" ||
      Array.isArray(rung) ||
      typeof rung.model !== "string" ||
      !/^[^/]+\/.+$/.test(rung.model)
    )
      throw new DataflowDefinitionError(
        `ladder.${name}.model must be "provider/model-id"`,
      );
  }
}

/** The same rung at every strength. */
export const uniformLadder = (rung: LadderRung): Ladder =>
  Object.fromEntries(MODEL_STRENGTHS.map((name) => [name, rung])) as Ladder;

/** The provider, model and thinking level `strength` selects in `ladder` (`thinking` defaults to `"off"`). */
export function resolveRung(
  ladder: Ladder,
  strength: ModelStrength,
): { provider: string; modelId: string; thinking: ModelThinkingLevel } {
  const { model, thinking = "off" } = ladder[MODEL_STRENGTHS[strength]];
  const slash = model.indexOf("/");
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
    thinking,
  };
}

/** The `provider/model@thinking` each agent last switched to. */
const appliedModels = new WeakMap<object, string>();

// Internal execution bookkeeping of adapter-built node bodies; not part of the public surface.

/** What an adapter records about one node body, keyed by that body. */
export type NodePolicy = {
  /** The prompt agent a prompt-agent body drives. */
  readonly agent?: JuncoAgent | MockAgent;
  /** Resolved value edges already delivered to the body, with the value delivered; a re-resolved edge is fresh again. */
  readonly seenValues?: Map<EdgeId, unknown>;
  /**
   * `all-messages`: every activation reads every nonempty inbound message queue, whatever the
   * trigger, and no value edge. Prompt agents use it so messaging is independent of activation.
   */
  readonly inputMode?: "all-messages";
  /** Reasons of the agent's latest pause. */
  lastYield?: readonly AgenticYieldReason[];
  /**
   * The exact state a failed task's recovery closed and reported; its owning graph's close skips
   * it rather than rethrowing a teardown failure the caller already received.
   */
  closedTaskState?: object;
};

/** Source-derived policy metadata; native descriptions remain on native observations. */
export type AgencyNodeMetadata = Readonly<
  Pick<NodePolicy, "lastYield"> & {
    agentStatus?: NonNullable<NodePolicy["agent"]>["status"];
  }
>;

/** Keyed by the generated body, so node state itself stays the original instance. */
export const nodePolicies = new WeakMap<object, NodePolicy>();

/** What one node registration in a {@link JuncoGraph} binds: its graph's tracer, signal and routes. */
export type NodeRegistration = Pick<
  NonNullable<JuncoAgentNodeContext["messaging"]>,
  "send" | "info"
> & {
  readonly tracer: DataflowTracer;
  /** The owning graph's current signal. */
  readonly signal: AbortSignal;
  /** Validate the original sender's message route without publishing or consuming anything. */
  readonly assertSend: (edgeId: EdgeId) => void;
  /** The registered spec's receiver contract, captured because engine nodes drop it. */
  readonly contract?: AgenticNode["contract"];
};

/**
 * Each node record's registration, keyed by that registration's own Node record: a reused spec or
 * body registered in several graphs keeps each graph's tracer, routes and contract.
 */
export const registeredNodeContexts = new WeakMap<object, NodeRegistration>();

/**
 * Rejects a missing policy (anything without a `toNative` method), or a collection opened under
 * another policy (policies compare by identity).
 */
export function checkPolicy(
  policy: ToolCollection["policy"] | undefined,
  collection: ToolCollection | undefined,
): asserts policy is ToolCollection["policy"] {
  if (
    typeof (policy as Partial<typeof policy> | undefined)?.toNative !==
    "function"
  )
    throw new TypeError("A policy is required");
  if (collection !== undefined && collection.policy !== policy)
    throw new TypeError("Collection policy does not match the selected policy");
}

/** Only the resolved parent results `seen` has not recorded, recording them now. */
export function unseenValues<T>(
  values: Lookup<EdgeId, T>,
  seen: Map<EdgeId, unknown>,
): Lookup<EdgeId, T> {
  const fresh = new Set<EdgeId>();
  for (const id of values.keys())
    if (!seen.has(id) || seen.get(id) !== values.get(id)) fresh.add(id);
  for (const id of fresh) seen.set(id, values.get(id));
  return {
    get: (id) => (fresh.has(id) ? values.get(id) : undefined),
    has: (id) => fresh.has(id),
    keys: () => fresh.keys(),
  };
}

/**
 * The reads of one occurrence of the node whose body is `step`. An `all-messages` body reads every
 * nonempty message queue. Otherwise an `all` trigger reads every rule edge, or nothing until the
 * conjunction holds — an already delivered result still counts. An `any` trigger reads its first
 * satisfied edge that is not an already delivered result, so a permanent result never starves a
 * newer message.
 */
export function nodeInputs<N, T>(
  step: object | undefined,
  candidate: NodeAvailability<N, T>,
): InputSchedule {
  const policy = step === undefined ? undefined : nodePolicies.get(step);
  if (policy?.inputMode === "all-messages") return messageInputs(candidate);
  if (candidate.trigger.kind === "all") return triggerInputs(candidate);
  const seen = policy?.seenValues;
  const first = candidate.satisfied.find(
    (edgeId) =>
      !seen?.has(edgeId) ||
      seen.get(edgeId) !== candidate.view.values.get(edgeId),
  );
  return first === undefined ? new Map() : new Map([[first, "all"]]);
}

/** Pair a passive agency graph with policy, sidecar metadata and agency input semantics. */
export function context<N, T, G extends JuncoGraph<N, T, never>>(options: {
  readonly scheduler: Scheduler<
    NoInfer<Agentic<N, T>>,
    NoInfer<N>,
    NoInfer<T>,
    AgencyNodeMetadata
  >;
  readonly graph: G & JuncoGraph<N, T, never>;
  readonly ladder?: Ladder;
}): SchedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, G> {
  const { graph, ladder } = options;
  if (ladder !== undefined) validateLadder(ladder);
  return schedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, G>({
    ...options,
    ...(ladder === undefined
      ? {}
      : {
          prepare: async (selected) => {
            for (const { nodeId, modelStrength } of selected) {
              const node = graph.getNode(nodeId);
              const member =
                node === undefined
                  ? undefined
                  : nodePolicies.get(node.step)?.agent;
              if (member === undefined) continue;
              const { provider, modelId, thinking } = resolveRung(
                ladder,
                modelStrength,
              );
              const key = `${provider}/${modelId}@${thinking}`;
              if (appliedModels.get(member) === key) continue;
              await member.setModel({ provider, modelId });
              await member.setThinkingLevel(thinking);
              appliedModels.set(member, key);
            }
          },
        }),
    readInputs: (id, candidate) =>
      nodeInputs(graph.getNode(id)?.step, candidate),
    describeNode: (id): AgencyNodeMetadata | undefined => {
      const node = graph.getNode(id);
      const policy =
        node === undefined ? undefined : nodePolicies.get(node.step);
      if (policy?.agent === undefined && policy?.lastYield === undefined)
        return undefined;
      return {
        ...(policy.agent === undefined
          ? {}
          : { agentStatus: policy.agent.status }),
        ...(policy.lastYield === undefined
          ? {}
          : { lastYield: policy.lastYield }),
      };
    },
  });
}
