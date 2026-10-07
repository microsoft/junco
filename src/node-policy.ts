import type {
  DataflowTracer,
  EdgeIdType as EdgeId,
  InputSchedule,
  Lookup,
  NodeAvailability,
} from "dataflow-engine";
import { triggerInputs } from "dataflow-engine";
import type {
  AgenticYieldReason,
  JuncoAgent,
  JuncoAgentNodeContext,
} from "junco-agent";
import type { ToolCollection, ToolCollectionOptions } from "junco-tools";
import type { AgenticNode } from "./agentic.js";
import type { MockAgent } from "./mock-agent.js";

// Internal execution bookkeeping of adapter-built node bodies; not part of the public surface.

/** What an adapter records about one node body, keyed by that body. */
export type NodePolicy = {
  /** The prompt agent a prompt-agent body drives. */
  readonly agent?: JuncoAgent | MockAgent;
  /** Value edges whose result has already been delivered to the body. */
  readonly seenValues?: Set<EdgeId>;
  /**
   * `all-messages`: every activation reads every nonempty inbound message queue, whatever the
   * trigger, and no value edge. Used by task-spawn members, whose return queues are added later.
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
  /** The registered spec's receiver contract, captured because engine nodes drop it. */
  readonly contract?: AgenticNode["contract"];
};

/**
 * Each node record's registration, keyed by that registration's own Node record: a reused spec or
 * body registered in several graphs keeps each graph's tracer, routes and contract.
 */
export const registeredNodeContexts = new WeakMap<object, NodeRegistration>();

/** Rejects a missing or unknown policy, or a collection opened under another policy. */
export function checkPolicy(
  policy: ToolCollectionOptions["policy"],
  collection: ToolCollection | undefined,
): void {
  if (policy !== "LockPolicy" && policy !== "EmptyPolicy")
    throw new TypeError('policy must be "LockPolicy" or "EmptyPolicy"');
  if (collection !== undefined && collection.policy !== policy)
    throw new TypeError("Collection policy does not match the selected policy");
}

/** Only the resolved parent results `seen` has not recorded, recording them now. */
export function unseenValues<T>(
  values: Lookup<EdgeId, T>,
  seen: Set<EdgeId>,
): Lookup<EdgeId, T> {
  const fresh = new Set<EdgeId>();
  for (const id of values.keys()) if (!seen.has(id)) fresh.add(id);
  for (const id of fresh) seen.add(id);
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
  if (policy?.inputMode === "all-messages") {
    const reads = new Map<EdgeId, "all">();
    const messages = candidate.view.messages;
    for (const id of messages.keys())
      if ((messages.get(id)?.length ?? 0) > 0) reads.set(id, "all");
    return reads;
  }
  if (candidate.trigger.kind === "all") return triggerInputs(candidate);
  const seen = policy?.seenValues;
  const first = candidate.satisfied.find((edgeId) => !seen?.has(edgeId));
  return first === undefined ? new Map() : new Map([[first, "all"]]);
}
