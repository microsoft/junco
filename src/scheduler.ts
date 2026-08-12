import type { EdgeId, NodeId } from "./identity.js";
import type { ParentView } from "./node.js";
import type { TriggerRule } from "./trigger.js";

/** How many messages to pop from one inbound edge: a positive integer, the whole queue, or none. */
export type MessageSchedule = number | "all" | "none";

/** Per-edge read plan for one node occurrence. An edge absent from the map is read `"none"`. */
export type InputSchedule = ReadonlyMap<EdgeId, MessageSchedule>;

/** One node occupying one turn of one lane, plus how much it reads on entry. */
export type NodeSchedule = { readonly id: NodeId; readonly inputs: InputSchedule };

/**
 * A planned window. `schedule[t][w]` is the entry lane `t` runs at turn offset `w` within the
 * window. The runtime executes turn `w` by taking index `w` from every lane and running that
 * column concurrently, for `w = 0 .. maxLaneLength-1`; when the window is exhausted it re-plans.
 * Lanes may be ragged and may be fewer than `threads`.
 */
export type Schedule = readonly (readonly NodeSchedule[])[];

/** What the runtime knows about one available node when it asks for a plan. */
export type NodeAvailability<S, N, T> = {
  /** LIVE, non-destructive view of the node's inbound edges: queues are unconsumed. */
  readonly view: ParentView<S, N, T>;
  readonly trigger: TriggerRule<N, T>;
  /** Rule edges carrying something right now, in rule insertion order. */
  readonly satisfied: readonly EdgeId[];
};

/** Pluggable planner deciding which available nodes run, in which lane, at which turn, reading how much. */
export type DataflowScheduler<S, N, T> = {
  /** Configure the planner. Called exactly once, by the graph constructor. */
  create(window: number, threads: number): void;

  /**
   * Plan the next window from the currently-available nodes and what the runtime knows about each.
   *
   * CONTRACT: every returned id MUST be a key of `available`; a lane MUST NOT exceed `window`
   * entries; there MUST be at most `threads` lanes; no id may repeat within a column. Returning an
   * empty schedule while `available` is non-empty is a definition error. Liveness is the
   * scheduler's responsibility — the runtime never forces progress. Each entry's `inputs` keys MUST
   * be inbound edges of that node, and a numeric count MUST be a positive integer.
   */
  schedule(available: ReadonlyMap<NodeId, NodeAvailability<S, N, T>>): Schedule;
};

/**
 * The default read plan for a node: every edge an `"all"` rule fires on, or only the first
 * satisfied edge of an `"any"` rule, each read WHOLE. Both shipped schedulers use it.
 *
 * A trigger says only WHICH edges must be carrying something, so this is the plainest plan that
 * honours it. A scheduler wanting fixed-size batches, or a partial drain, builds its own
 * {@link InputSchedule} instead — that is the entire point of the count living here.
 *
 * A partially satisfied `"all"` rule reads NOTHING — atomicity. Reachable only when a custom
 * `is_available` hook reports a node available while its trigger is unsatisfied.
 */
export const triggerInputs = <S, N, T>({ trigger, satisfied }: NodeAvailability<S, N, T>): InputSchedule => {
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

/**
 * Runs every available node in one concurrent column, one lane each, one turn per window.
 *
 * Its lane count equals the number of available nodes, which can exceed any finite `threads`, so a
 * graph using it MUST be constructed with `threads: Number.POSITIVE_INFINITY`.
 */
export class ReadyScheduler<S, N, T> implements DataflowScheduler<S, N, T> {
  /** Ignores both knobs: this scheduler always plans exactly one turn over every available node. */
  create(_window: number, _threads: number): void {}

  schedule(available: ReadonlyMap<NodeId, NodeAvailability<S, N, T>>): Schedule {
    return [...available].map(([id, availability]) => [{ id, inputs: triggerInputs(availability) }]);
  }
}

/**
 * Fills `threads` lanes x `window` turns per plan, resuming from where the previous plan stopped.
 *
 * `capacity <= ids.length` guarantees the placed ids are distinct, so no column ever holds a
 * duplicate; the rotating cursor guarantees a starved node is eventually reached when
 * `threads * window < available.size`.
 */
export class RoundRobinScheduler<S, N, T> implements DataflowScheduler<S, N, T> {
  #window = 1;
  #threads = 1;
  #cursor = 0;

  create(window: number, threads: number): void {
    this.#window = window;
    this.#threads = threads;
  }

  schedule(available: ReadonlyMap<NodeId, NodeAvailability<S, N, T>>): Schedule {
    const ids = [...available.keys()];
    if (ids.length === 0) return [];

    const capacity = Math.min(ids.length, this.#threads * this.#window);
    // `min(threads, capacity)` is the exact lane count: any further lane would stay empty. It also
    // keeps the allocation finite when `threads` is `Number.POSITIVE_INFINITY`.
    const lanes: NodeSchedule[][] = Array.from({ length: Math.min(this.#threads, capacity) }, () => []);
    for (let k = 0; k < capacity; k++) {
      const id = ids[(this.#cursor + k) % ids.length]!;
      lanes[k % this.#threads]!.push({ id, inputs: triggerInputs(available.get(id)!) });
    }
    this.#cursor = (this.#cursor + capacity) % ids.length;
    return lanes.filter((lane) => lane.length > 0);
  }
}
