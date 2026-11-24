import type { TSchema } from "typebox";
import type { EdgeId, NodeId } from "./identity.js";
import type { ParentView } from "./node.js";
import type { TriggerRule } from "./trigger.js";

/** How many messages to pop from one inbound edge: a positive integer, the whole queue, or none. */
export type MessageSchedule = number | "all" | "none";

/** Per-edge read plan for one node occurrence. An edge absent from the map is read `"none"`. */
export type InputSchedule = ReadonlyMap<EdgeId, MessageSchedule>;

/** One node occupying one turn of one lane, plus how much it reads on entry. */
export type NodeSchedule = {
  readonly id: NodeId;
  readonly inputs: InputSchedule;
};

/**
 * A planned window, lanes x turns. `schedule[t][w]` is the entry lane `t` runs at turn offset `w`
 * within the window. The runtime executes turn `w` by taking index `w` from every lane and running
 * that column concurrently, for `w = 0 .. maxLaneLength-1`; so `[[A, A], [B]]` runs A and B
 * together, then A alone if it is still available. A ready node's first occurrence only primes its
 * generator (reading nothing). Lanes may be ragged and may be fewer than `threads`.
 */
export type Schedule = readonly (readonly NodeSchedule[])[];

/**
 * A node eligible to run because its trigger fired or its last yield requested a continuation.
 * These are candidate-local input-planning facts; nothing here reaches any other node.
 */
export type NodeAvailability<N extends TSchema, T> = {
  /** LIVE, non-destructive view of the node's inbound edges: queues are unconsumed. */
  readonly view: ParentView<N, T>;
  readonly trigger: TriggerRule<N, T>;
  /** The operation owes another turn but its trigger does not independently fire. */
  readonly continuationOnly: boolean;
  /** Rule edges carrying something right now, in rule insertion order. */
  readonly satisfied: readonly EdgeId[];
  /** `"ready"` until its first occurrence primes the generator, then `"running"`. */
  readonly status: "ready" | "running";
};

/**
 * The default read plan for a node: every edge an `"all"` rule fires on, or only the first
 * satisfied edge of an `"any"` rule, each read WHOLE. The usual input plan for scheduler policies.
 *
 * A trigger says only WHICH edges must be carrying something, so this is the plainest plan that
 * honours it. A scheduler wanting fixed-size batches, or a partial drain, builds its own
 * {@link InputSchedule} instead — that is the entire point of the count living here.
 *
 * A partially satisfied `"all"` rule reads nothing, including on continuation-only turns.
 */
export const triggerInputs = <N extends TSchema, T>({
  trigger,
  satisfied,
}: NodeAvailability<N, T>): InputSchedule => {
  const inputs = new Map<EdgeId, MessageSchedule>();
  if (trigger.kind === "all") {
    if (satisfied.length !== trigger.rule.length) return inputs;
    for (const edgeId of trigger.rule) inputs.set(edgeId, "all");
  } else {
    const first = satisfied[0];
    if (first !== undefined) inputs.set(first, "all");
  }
  return inputs;
};

/** Read every queued inbound message on activation, independently of which edge triggered it. */
export const messageInputs = <N extends TSchema, T>({
  view,
}: Pick<NodeAvailability<N, T>, "view">): InputSchedule => {
  const inputs = new Map<EdgeId, MessageSchedule>();
  for (const id of view.messages.keys())
    if ((view.messages.get(id)?.length ?? 0) > 0) inputs.set(id, "all");
  return inputs;
};
