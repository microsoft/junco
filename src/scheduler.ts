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
 * What the runtime knows about one available node when it asks for a plan. Every entry is a node
 * the runtime has already admitted: not `done`, trigger evaluated, availability hook passed.
 * These are candidate-local input-planning facts; nothing here reaches any other node.
 */
export type NodeAvailability<N, T> = {
  /** LIVE, non-destructive view of the node's inbound edges: queues are unconsumed. */
  readonly view: ParentView<N, T>;
  readonly trigger: TriggerRule<N, T>;
  /** Rule edges carrying something right now, in rule insertion order. */
  readonly satisfied: readonly EdgeId[];
  /** `"ready"` until its first occurrence primes the generator, then `"running"`. */
  readonly status: "ready" | "running";
};

/** Pluggable planner deciding which available nodes run, in which lane, at which turn, reading how much. */
export type DataflowScheduler<N, T> = {
  /** Configure the planner. Called exactly once, by the graph constructor. */
  create(window: number, threads: number): void;

  /**
   * Receive the constructing graph's candidate view and window driver. Called at most once, by the
   * graph constructor, right after {@link create}; a scheduler that does not need them omits it.
   *
   * `available` returns a fresh snapshot of the admitted candidates, exactly what {@link schedule}
   * would receive. `step` runs one window, like `graph.step({ signal })`, discarding its results.
   * Neither exposes the graph, other nodes, edges or results.
   */
  bind?(
    available: () => ReadonlyMap<NodeId, NodeAvailability<N, T>>,
    step: (signal?: AbortSignal) => Promise<void>,
  ): void;

  /**
   * Plan the next window from the currently-available nodes and what the runtime knows about each.
   *
   * CONTRACT: every returned id MUST be a key of `available`; a lane MUST NOT exceed `window`
   * entries; there MUST be at most `threads` lanes; no id may repeat within a column. Returning an
   * empty schedule while `available` is non-empty is a definition error. Liveness is the
   * scheduler's responsibility — the runtime never forces progress. Each entry's `inputs` keys MUST
   * be inbound edges of that node, and a numeric count MUST be a positive integer.
   */
  schedule(available: ReadonlyMap<NodeId, NodeAvailability<N, T>>): Schedule;

  /**
   * Recompute the reads of a planned occurrence of an already-running node from `live`, the
   * availability snapshot taken just before its column runs. Called once per such occurrence per
   * column, never for a prime. Absent, the planned `entry.inputs` are used unchanged.
   *
   * CONTRACT: SYNCHRONOUS and pure — it MUST NOT mutate the graph or `live`. The result is held to
   * the same inbound-edge and positive-count rules as {@link schedule}; a violation, or a throw,
   * rejects the invocation before any node of that column advances.
   */
  resolveInputs?(
    entry: NodeSchedule,
    live: NodeAvailability<N, T>,
  ): InputSchedule;
};

/**
 * The default read plan for a node: every edge an `"all"` rule fires on, or only the first
 * satisfied edge of an `"any"` rule, each read WHOLE. The usual input plan for scheduler policies.
 *
 * A trigger says only WHICH edges must be carrying something, so this is the plainest plan that
 * honours it. A scheduler wanting fixed-size batches, or a partial drain, builds its own
 * {@link InputSchedule} instead — that is the entire point of the count living here.
 *
 * A partially satisfied `"all"` rule reads NOTHING — atomicity. Reachable only when a custom
 * `is_available` hook reports a node available while its trigger is unsatisfied.
 */
export const triggerInputs = <N, T>({
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
