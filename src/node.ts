import type { Identifiable } from "share/identifiable";
import type { EdgeId, NodeId } from "./identity.js";
import type { TriggerRule } from "./trigger.js";

/** A single datum crossing one message edge. */
export type Message<N> = { readonly id: EdgeId; readonly payload: N };

/**
 * Keyed read access to one side of a node's inbound state.
 *
 * Deliberately narrower than `ReadonlyMap`: the runtime serves a readiness view by reading through to
 * the live `Edge`, so there is no materialized map behind it to iterate or size. A plain `Map` still
 * satisfies it structurally, which is what lets a delivered batch stay an ordinary map.
 */
export type Lookup<K, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  /** Exactly the keys for which `has` is true. INVARIANT — the two never disagree. */
  keys(): Iterable<K>;
};

/**
 * What the runtime hands a node each turn.
 *
 * `messages` — the batch read this turn, keyed by inbound message-edge id. How much came off each
 *   edge is the schedule's decision (see `MessageSchedule` in `scheduler.ts`), and a key is present
 *   ONLY for an edge that actually yielded items, so
 *   `view.messages.get(a) ?? view.messages.get(b)` distinguishes which branch of an `any` rule
 *   fired.
 * `values` — resolved return values of inbound value edges. The runtime owns ONE such map per
 *   node and shares it by reference into every view that node receives; entries are only ever
 *   added (a resolved `Option` never reverts).
 *
 * `S` is unused structurally and is carried only so {@link DataflowScheduler} stays tied to its
 * graph.
 */
export type ParentView<S, N, T> = {
  readonly messages: Lookup<EdgeId, readonly N[]>;
  readonly values: Lookup<EdgeId, T>;
};

/** Lifecycle of a node: never activated, mid-generator, or terminated. */
export type NodeStatus = "ready" | "running" | "done";

/** The generator a node body returns: yields message batches, is resumed with views, returns `T`. */
export type NodeGenerator<S, N, T> = AsyncGenerator<readonly Message<N>[], T, ParentView<S, N, T>>;

/**
 * A node body. Invoked as `node.step(view)`, so a non-arrow `async function*` receives the node as
 * `this` and can read/mutate `this.state`; arrow bodies simply ignore `this`.
 *
 * PROTOCOL — exactly one resume per turn:
 *  - First activation: `step(view)` is called with the turn's batch, then `generator.next()` once.
 *    JS discards the argument to a generator's first `next()`, so that first batch arrives ONLY
 *    via the `view` argument.
 *  - Every later activation: `generator.next(view_k)` with that turn's freshly materialized view.
 *    The idiom is `let inputs = view; while (…) { inputs = yield outputs; }`.
 *  - Each resume yields `readonly Message<N>[]` — every message the node emits that turn, routed
 *    in array order. Yield `[]` to emit nothing; a pure sink does exactly that and stays alive.
 *  - Returning `T` marks the node `done`. A node that must run for the whole graph's life simply
 *    never returns (see `stepNode` in `builders.ts`).
 */
export type StepFn<S, N, T> = (
  this: Node<S, N, T>,
  view: ParentView<S, N, T>,
) => NodeGenerator<S, N, T>;

/** Readiness hook. The runtime passes a NON-destructive probe view aliasing the live queues. */
export type AvailabilityFn<S, N, T> = (view: ParentView<S, N, T>) => boolean;

/** A registered graph node: its programmable state, lifecycle, trigger, body and live generator. */
export type Node<S, N, T> = Identifiable<NodeId> & {
  state: S;
  status: NodeStatus;
  readonly is_available: AvailabilityFn<S, N, T>;
  readonly trigger: TriggerRule<N, T>;
  readonly step: StepFn<S, N, T>;
  generator: NodeGenerator<S, N, T> | undefined;
};

/** What a caller passes to `DataflowGraph.addNode`. Omit `id` to get an auto-assigned one. */
export type NodeSpec<S, N, T> = {
  readonly id?: NodeId;
  readonly state: S;
  readonly trigger: TriggerRule<N, T>;
  readonly step: StepFn<S, N, T>;
  readonly is_available?: AvailabilityFn<S, N, T>;
};
