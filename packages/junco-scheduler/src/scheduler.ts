import {
  DataflowDefinitionError,
  type DataflowScheduler,
  type InputSchedule,
  type NodeAvailability,
  type NodeIdType as NodeId,
  type NodeSchedule,
  type Schedule,
} from "dataflow-engine";

/**
 * A stateful scheduling policy for {@link Scheduler}.
 *
 * `State` is inferred from {@link SchedulerOptions.state}; spell it out (`new Scheduler<Cursor>(...)`)
 * when the initial value is narrower than what the policy later stores, such as `undefined` for a
 * cursor that becomes a `NodeId`. Stateless policies pass `state: undefined`.
 *
 * `N` and `T` are the graph's message and return payloads; they default to `unknown`, and are
 * inferred from annotated callbacks or from the graph the scheduler is passed to.
 */
export type SchedulerOptions<State, N = unknown, T = unknown> = {
  /**
   * The initial scheduler-owned state: the value itself, not a factory.
   *
   * It is kept by reference for the scheduler's whole life — never serialized, cloned or reset
   * between scheduling cycles — so class instances, `Map`s and closures survive as they are. A
   * shared object is shared: independently constructed schedulers need fresh state values.
   */
  readonly state: State;

  /**
   * Plan one window over the graph's current candidates. Called synchronously by the graph once per
   * `step`, and once per window of `run`, only while at least one node is available — a quiescent
   * graph never asks.
   *
   * `available` holds exactly the nodes the engine admitted (not done, trigger evaluated,
   * availability hook passed), in node insertion order, each with its candidate-local facts:
   * `status`, the live non-destructive `view`, its `trigger` and the `satisfied` rule edges. It is the
   * engine's own map; do not mutate it.
   *
   * `state` is the scheduler's CURRENT `state`, read on every call. `window` and `threads`
   * are the bounds the graph was constructed with (`Infinity` when unbounded).
   *
   * Return the engine's `Schedule`: `schedule[lane][turn]` entries. Turn `w` of every lane forms one
   * column; the columns run in order and each column's lanes run concurrently. At most `threads`
   * lanes, at most `window` entries per lane, no id twice within a column, and only ids from
   * `available`. Each entry names explicit reads: `triggerInputs(candidate)` reads what the trigger
   * fired on, while a hand-built map such as `new Map([[edgeId, 2]])` reads at most two messages.
   * A ready node's first occurrence only primes it and reads nothing. Return `[]` only for an empty
   * `available`; an empty plan while work remains is a definition error. The returned plan is used
   * as is — no normalization or copy.
   */
  readonly schedule: (
    available: ReadonlyMap<NodeId, NodeAvailability<N, T>>,
    state: State,
    window: number,
    threads: number,
  ) => Schedule;

  /**
   * Re-plan the reads of one occurrence of an already-running node, from `live`, the candidate's
   * availability snapshot taken just before its column runs. Called with the scheduler's CURRENT
   * `state`, never for a prime.
   *
   * MUST be synchronous and pure: no graph mutation, no mutation of `live`. Its result is validated
   * like a planned read map; an exception rejects the column before any node advances. Omit it to
   * keep every planned `inputs` map unchanged.
   */
  readonly resolveInputs?: (
    entry: NodeSchedule,
    live: NodeAvailability<N, T>,
    state: State,
  ) => InputSchedule;
};

/**
 * A dataflow-engine scheduler built from a policy function and its own mutable state.
 *
 * It implements the engine's `DataflowScheduler` and exposes {@link SchedulerOptions.state} as its
 * own mutable `state` property. Every callback receives the CURRENT `scheduler.state`, so:
 * - mutating a state object (from a callback or from outside) persists into later cycles;
 * - assigning `scheduler.state = next` replaces it for every later call, primitive state included.
 *
 * One scheduler configures exactly one graph: the graph constructor calls `create(window, threads)`
 * once, the bounds are kept and passed to `schedule`. Constructing a second graph with the same
 * scheduler throws `DataflowDefinitionError("Scheduler already configures a graph")`; planning
 * before any graph configured it throws `DataflowDefinitionError("Scheduler is not configured")`.
 * Policy exceptions propagate unchanged; nothing is retried, repaired or rolled back.
 *
 * @example Full parallel: every candidate in its own lane, one turn per window.
 * ```ts
 * import { DataflowGraph, triggerInputs, UNBOUNDED, Width } from "dataflow-engine";
 * import { Scheduler } from "junco-scheduler";
 *
 * const parallel = new Scheduler({
 *   state: undefined,
 *   schedule: (available) =>
 *     [...available].map(([id, candidate]) => [{ id, inputs: triggerInputs(candidate) }]),
 * });
 * const graph = new DataflowGraph<void, number, string, never>(parallel, Width.create(1), UNBOUNDED);
 * ```
 *
 * @example Round robin: one occurrence per window, rotating by id from a mutable cursor.
 * ```ts
 * import { type NodeIdType, triggerInputs } from "dataflow-engine";
 * import { Scheduler } from "junco-scheduler";
 *
 * const rotation = new Scheduler<{ last: NodeIdType | undefined }>({
 *   state: { last: undefined },
 *   schedule(available, state) {
 *     let first: NodeIdType | undefined;
 *     let next: NodeIdType | undefined;
 *     for (const id of available.keys()) {
 *       if (first === undefined || id < first) first = id;
 *       if (state.last !== undefined && id > state.last && (next === undefined || id < next)) next = id;
 *     }
 *     const chosen = next ?? first;
 *     if (chosen === undefined) return [];
 *     state.last = chosen; // persists: the same object is passed to the next cycle
 *     return [[{ id: chosen, inputs: triggerInputs(available.get(chosen)!) }]];
 *   },
 * });
 * rotation.state.last; // the cursor, readable and writable between steps
 * ```
 *
 * @example Fixed-size batches: plan two messages per occurrence, re-planned on the live queue.
 * ```ts
 * const pairs = new Scheduler({
 *   state: { size: 2 },
 *   schedule: (available, state) =>
 *     [...available].map(([id, candidate]) => [
 *       { id, inputs: new Map(candidate.trigger.rule.map((edge) => [edge, state.size])) },
 *     ]),
 *   resolveInputs: (_entry, live, state) => new Map(live.trigger.rule.map((edge) => [edge, state.size])),
 * });
 * ```
 *
 * @example An LLM scheduler: Pi's ready-made Opus 5.5 driver from `junco-scheduler/agent`.
 * Its synchronous `schedule` only consumes the decision its native `schedule` tool staged; the
 * model itself is driven through the Agentic iterator, never by `graph.run()`.
 * ```ts
 * import { DataflowGraph, UNBOUNDED, Width } from "dataflow-engine";
 * import { PiScheduler } from "junco-scheduler/agent";
 *
 * const scheduler = await PiScheduler.opus({ prompt: "Run available work." });
 * try {
 *   const graph = new DataflowGraph(scheduler, Width.create(1), UNBOUNDED); // configures and binds it
 *   // ...graph.addNode(...) / graph.addEdge(...)
 *   while (true) {
 *     const { done, value } = await scheduler.next();
 *     if (done || value.kind !== "yield") break; // settled or failed
 *   }
 * } finally {
 *   await scheduler.return();
 * }
 * ```
 */
export class Scheduler<State, N = unknown, T = unknown>
  implements DataflowScheduler<N, T>
{
  /** The scheduler-owned state every callback receives; mutate it, or assign a replacement. */
  state: State;
  declare bind?: DataflowScheduler<N, T>["bind"];
  declare resolveInputs?: DataflowScheduler<N, T>["resolveInputs"];
  readonly #policy: SchedulerOptions<State, N, T>["schedule"];
  #window: number | undefined;
  #threads: number | undefined;

  constructor(options: SchedulerOptions<State, N, T>) {
    this.state = options.state;
    this.#policy = options.schedule;
    const { resolveInputs } = options;
    if (resolveInputs !== undefined) {
      this.resolveInputs = (entry, live) =>
        resolveInputs(entry, live, this.state);
    }
  }

  create(window: number, threads: number): void {
    if (this.#window !== undefined || this.#threads !== undefined) {
      throw new DataflowDefinitionError("Scheduler already configures a graph");
    }
    this.#window = window;
    this.#threads = threads;
  }

  schedule(available: ReadonlyMap<NodeId, NodeAvailability<N, T>>): Schedule {
    if (this.#window === undefined || this.#threads === undefined) {
      throw new DataflowDefinitionError("Scheduler is not configured");
    }
    return this.#policy(available, this.state, this.#window, this.#threads);
  }
}
