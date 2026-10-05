import type { Identifiable } from "./identifiable.js";
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
 * What the runtime hands a running node on each input-delivery turn.
 *
 * `messages` — the batch read this turn, keyed by inbound message-edge id. How much came off each
 *   edge is the schedule's decision (see `MessageSchedule` in `scheduler.ts`), and a key is present
 *   ONLY for an edge that actually yielded items, so
 *   `view.messages.get(a) ?? view.messages.get(b)` distinguishes which branch of an `any` rule
 *   fired.
 * `values` — resolved return values of inbound value edges. The runtime owns ONE such map per
 *   node and shares it by reference into every view that node receives; entries are only ever
 *   added (a resolved `Option` never reverts).
 */
export type ParentView<N, T> = {
  readonly messages: Lookup<EdgeId, readonly N[]>;
  readonly values: Lookup<EdgeId, T>;
};

/** Lifecycle of a node: never activated, mid-generator, or terminated. */
export type NodeStatus = "ready" | "running" | "done";

/** The generator a node body returns: yields message batches, is resumed with views, returns `T`. */
export type NodeGenerator<N, T> = AsyncGenerator<
  Message<N>[],
  T,
  ParentView<N, T>
>;

/**
 * A node body. Invoked as `node.step()`, so a non-arrow `async function*` receives the node as
 * `this` and can read/mutate `this.state`; arrow bodies simply ignore `this`.
 *
 * PROTOCOL — exactly one generator advance per activation:
 *  - Ready-node activation primes the body with `step()` followed by `generator.next()`. The
 *    scheduled input batch is NOT consumed and no view is materialized on this activation. A
 *    dependent body normally begins with `let view = yield []`; a source may yield real output
 *    immediately.
 *  - Every running-node activation consumes its scheduled batch and calls
 *    `generator.next(view_k)` with that turn's freshly materialized view.
 *  - Each advance yields mutable `Message<N>[]` — every message the node emits that turn, routed
 *    in array order. Yield `[]` to emit nothing; a pure sink does exactly that and stays alive.
 *  - Returning `T` marks the node `done`. A node that must run for the whole graph's life simply
 *    never returns (see `stepNode` in `builders.ts`).
 */
export type StepFn<S, N, T> = (this: Node<S, N, T>) => NodeGenerator<N, T>;

/**
 * Failure hook of a node whose body threw. Invoked once as `node.on_error(error, signal)` after the
 * node became `done`, with the raw body error and the invocation's signal. The returned batch is
 * routed like a yield in the same terminal activation; `[]` handles the failure silently. The node
 * records no result and its outbound value edges stay unresolved. A throw rejects the invocation.
 */
export type ErrorFn<S, N, T> = (
  this: Node<S, N, T>,
  error: unknown,
  signal: AbortSignal | undefined,
) => readonly Message<N>[] | Promise<readonly Message<N>[]>;

/**
 * Availability hook, consulted only for a node that is not `done`, after the runtime has evaluated
 * its trigger. `view` is a NON-destructive probe aliasing the live queues; `triggered` says whether
 * the node's {@link TriggerRule} fires right now. The default hook returns `triggered`.
 *
 * A custom hook may override the trigger in either direction: demand a deeper backlog than one
 * message, or keep an already-started actor resumable after it consumed its triggering input.
 */
export type AvailabilityFn<N, T> = (
  view: ParentView<N, T>,
  triggered: boolean,
) => boolean;

/**
 * Registration options common to every node kind: identity, optional prose, firing rule and
 * availability. Omit `id` to get an auto-assigned one; omit `description` when the node needs no
 * prose. `is_available` defaults to the trigger result.
 */
export type NodeOptions<N, T> = {
  readonly id?: NodeId;
  readonly description?: string;
  readonly trigger: TriggerRule<N, T>;
  readonly is_available?: AvailabilityFn<N, T>;
};

/** A registered graph node: its programmable state, lifecycle, trigger, body and live generator. */
export type Node<S, N, T> = Identifiable<NodeId> &
  NodeOptions<N, T> & {
    state: S;
    status: NodeStatus;
    readonly is_available: AvailabilityFn<N, T>;
    readonly step: StepFn<S, N, T>;
    readonly on_error?: ErrorFn<S, N, T>;
    generator: NodeGenerator<N, T> | undefined;
  };

/** What a caller passes to `DataflowGraph.addNode`: common options plus state, body and failure hook. */
export type NodeSpec<S, N, T> = NodeOptions<N, T> & {
  readonly state: S;
  readonly step: StepFn<S, N, T>;
  readonly on_error?: ErrorFn<S, N, T>;
};
