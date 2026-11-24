import type { Static, TSchema } from "typebox";
import type { Edge } from "./edges.js";
import { DataflowDefinitionError } from "./errors.js";
import type { Identifiable } from "./identifiable.js";
import type { EdgeId, NodeId } from "./identity.js";
import type { TriggerRule } from "./trigger.js";

/** A single datum crossing one message edge: a raw payload admitted by the edge's schema `N`. */
export type Message<N extends TSchema> = {
  readonly id: EdgeId;
  readonly payload: Static<N>;
};

/** Construction of {@link Message}s. */
export const Message = {
  /**
   * A message bound for `edge`, carrying `payload` by reference. A cheap constructor: the edge's
   * schema is enforced when the message is routed, not here.
   */
  create: <N extends TSchema, T>(
    edge: Edge<N, T>,
    payload: NoInfer<Static<N>>,
  ): Message<N> => ({
    id: edge.id,
    payload,
  }),
};

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
 * `values` — the resolved inbound value cells on an admitted input turn. A continuation-only turn
 * receives neither messages nor values.
 */
export type ParentView<N extends TSchema, T> = {
  readonly messages: Lookup<EdgeId, readonly Static<N>[]>;
  readonly values: Lookup<EdgeId, T>;
};

/** The batch `view` delivered: each payload with its edge, in edge then delivery order. */
export function messagesOf<N extends TSchema>(
  view: Pick<ParentView<N, unknown>, "messages">,
): Message<N>[] {
  const messages: Message<N>[] = [];
  for (const id of view.messages.keys())
    for (const payload of view.messages.get(id) ?? [])
      messages.push({ id, payload });
  return messages;
}

/** Detach native input containers, preserving present-undefined values and opaque identity. */
export function snapshotView<N extends TSchema, T>(
  view: ParentView<N, T>,
): ParentView<N, T> {
  // ponytail: opaque S/N/T values are borrowed; use immutable application data when historical value snapshots are required
  const messages = new Map<EdgeId, readonly Static<N>[]>();
  for (const id of view.messages.keys())
    messages.set(id, Object.freeze([...(view.messages.get(id) ?? [])]));
  const values = new Map<EdgeId, T | undefined>();
  for (const id of view.values.keys()) values.set(id, view.values.get(id));
  return Object.freeze({ messages, values });
}

/** Lifecycle of a node: never activated, mid-generator, or returned (a value self-edge delivery re-arms it to `ready`). */
export type NodeStatus = "ready" | "running" | "done";

/** An ordinary batch waits for admission; a resume batch requests another turn. */
export type NodeYield<N extends TSchema> =
  | Message<N>[]
  | { readonly resume: Message<N>[] };

/** Publish one last batch and finish without supplying a result. */
export class FinalMessages<N extends TSchema> {
  constructor(readonly messages: Message<N>[]) {}
}

/** The native yield, return and input protocol for a node body. */
export type NodeGenerator<N extends TSchema, T> = AsyncGenerator<
  NodeYield<N>,
  T | FinalMessages<N>,
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
 *  - An array publishes in order and waits for the next admission. `{ resume: batch }` publishes
 *    and requests another turn, even without new input.
 *  - Return `T` to record a result, or `new FinalMessages(batch)` to publish and end without one.
 */
export type StepFn<S, N extends TSchema, T> = (
  this: Node<S, N, T>,
) => NodeGenerator<N, T>;

/**
 * Failure hook of a node whose body threw. Invoked once as `node.on_error(error, signal)` after the
 * node became `done`, with the raw body error and the invocation's signal. The returned batch is
 * routed like a yield in the same terminal activation; `[]` handles the failure silently. The node
 * records no result and its outbound value edges stay unresolved. A throw rejects the invocation.
 */
export type ErrorFn<S, N extends TSchema, T> = (
  this: Node<S, N, T>,
  error: unknown,
  signal: AbortSignal | undefined,
) => readonly Message<N>[] | Promise<readonly Message<N>[]>;

/** Registration options common to every node kind: optional identity and prose, and its firing rule. */
export type NodeOptions<N extends TSchema, T> = {
  readonly id?: NodeId;
  readonly description?: string;
  readonly trigger: TriggerRule<N, T>;
};

/** Reject obsolete node options before copying them or acquiring resources. */
export function rejectLegacyAvailability(options: object): void {
  if ("is_available" in options)
    throw new DataflowDefinitionError("is_available was removed; use trigger");
}

/** A registered graph node: its programmable state, lifecycle, trigger, body and live generator. */
export type Node<S, N extends TSchema, T> = Identifiable<NodeId> &
  NodeOptions<N, T> & {
    state: S;
    status: NodeStatus;
    readonly step: StepFn<S, N, T>;
    readonly on_error?: ErrorFn<S, N, T>;
    generator: NodeGenerator<N, T> | undefined;
  };

/** What a caller passes to `DataflowGraph.addNode`: common options plus state, body and failure hook. */
export type NodeSpec<S, N extends TSchema, T> = NodeOptions<N, T> & {
  /** Maximum work admissions over the node's lifetime. Omitted means uncapped. */
  readonly repeat?: number;
  readonly state: S;
  readonly step: StepFn<S, N, T>;
  readonly on_error?: ErrorFn<S, N, T>;
};
