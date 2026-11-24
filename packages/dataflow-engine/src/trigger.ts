import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { TSchema } from "typebox";
import type { Edge } from "./edges.js";
import { DataflowDefinitionError } from "./errors.js";
import type { EdgeId, NodeId } from "./identity.js";

/** Conjunction (`"all"`) or ordered disjunction (`"any"`) over a rule's entries. */
export type TriggerKind = "all" | "any";

/**
 * A node's readiness predicate: WHICH inbound edges must be carrying something. Never how much of
 * it to take — that is the scheduler's decision, carried in `MessageSchedule` (`scheduler.ts`).
 *
 * An entry is satisfied by a single queued message, or by a resolved value cell.
 *
 * `rule` is in call order — an `"any"` rule fires on the FIRST satisfied entry — and holds no
 * duplicate, so `rule.length` is the number of distinct edges `"all"` must see satisfied.
 *
 * `N`/`T` are carried by each entry's type-only brand (see `TriggerEntry`): a rule built from
 * `TriggerEntry.on(edge)` entries admits only edges whose message and result payloads fit the rule. The brand is
 * covariant, so a rule over narrow payloads serves a graph over a wider payload union.
 */
export type TriggerRule<N extends TSchema, T> = {
  readonly kind: TriggerKind;
  readonly rule: readonly TriggerEntry<N, T>[];
};

declare const triggerEntry: unique symbol;

/**
 * One rule entry: an inbound edge id branded, at the type level only, with that edge's message and
 * result payload types. At runtime it is exactly the edge id string.
 */
export type TriggerEntry<N extends TSchema, T> = EdgeId & {
  readonly [triggerEntry]: readonly [message: N, result: T];
};

/** Construction of {@link TriggerEntry}s. */
export const TriggerEntry = {
  /** One rule entry: the inbound edge to watch. */
  on: <N extends TSchema, T>(edge: Edge<N, T>): TriggerEntry<N, T> =>
    edge.id as TriggerEntry<N, T>,
};

/**
 * Validate the variadic entries and adopt them as the rule, rejecting a duplicate edge id (which
 * would inflate an `"all"` rule's length and make it unsatisfiable).
 *
 * The rest-parameter array is freshly allocated per call and reachable from nowhere else, so it is
 * kept rather than copied. `indexOf` over a handful of entries beats allocating a `Set` to dedupe.
 */
const buildRule = <Entry extends EdgeId>(
  who: string,
  entries: readonly Entry[],
): readonly Entry[] => {
  for (let i = 0; i < entries.length; i++) {
    const edgeId = entries[i];
    if (entries.indexOf(edgeId) !== i) {
      throw new DataflowDefinitionError(
        `${who} received edge "${edgeId}" twice`,
      );
    }
  }
  return entries;
};

/** Conjunction: fires iff EVERY entry has something to offer. */
function allOf<const Entries extends readonly TriggerEntry<TSchema, unknown>[]>(
  ...entries: Entries
): TriggerRule<
  Entries[number][typeof triggerEntry][0],
  Entries[number][typeof triggerEntry][1]
>;
function allOf<N extends TSchema = never, T = never>(
  ...entries: readonly TriggerEntry<N, T>[]
): TriggerRule<N, T>;
function allOf(
  ...entries: readonly TriggerEntry<TSchema, unknown>[]
): TriggerRule<TSchema, unknown> {
  return { kind: "all", rule: buildRule("allOf", entries) };
}

/** Ordered disjunction: fires on the FIRST satisfied entry. */
function anyOf<const Entries extends readonly TriggerEntry<TSchema, unknown>[]>(
  ...entries: Entries
): TriggerRule<
  Entries[number][typeof triggerEntry][0],
  Entries[number][typeof triggerEntry][1]
>;
function anyOf<N extends TSchema = never, T = never>(
  ...entries: readonly TriggerEntry<N, T>[]
): TriggerRule<N, T>;
function anyOf(
  ...entries: readonly TriggerEntry<TSchema, unknown>[]
): TriggerRule<TSchema, unknown> {
  return { kind: "any", rule: buildRule("anyOf", entries) };
}

/** Construction of {@link TriggerRule}s. */
export const TriggerRule = {
  allOf,
  anyOf,
  /**
   * The single-edge conjunction: `when(e)` is `allOf(on(e))`. Named because a one-entry `allOf` is
   * by far the most common trigger shape.
   */
  when: <N extends TSchema, T>(edge: Edge<N, T>): TriggerRule<N, T> =>
    allOf<N, T>(TriggerEntry.on(edge)),
  /** Fires every turn and names no edge — the source trigger. Identical to `allOf()`. */
  always: <N extends TSchema = never, T = never>(): TriggerRule<N, T> =>
    allOf<N, T>(),
  /** Never fires. Identical to `anyOf()`. */
  never: <N extends TSchema = never, T = never>(): TriggerRule<N, T> =>
    anyOf<N, T>(),
};

/**
 * Whether one rule entry has something to offer right now: at least one queued message, or a
 * resolved value cell.
 *
 * @throws {DataflowDefinitionError} when `edgeId` is not one of `nodeId`'s inbound edges.
 */
const isSatisfied = <N extends TSchema, T>(
  edgeId: EdgeId,
  inbound: ReadonlyMap<EdgeId, Edge<N, T>>,
  nodeId: NodeId,
): boolean => {
  const edge = inbound.get(edgeId);
  if (edge === undefined) {
    throw new DataflowDefinitionError(
      `Node "${nodeId}" trigger references edge "${edgeId}" which is not one of its inbound edges`,
    );
  }
  return E.isLeft(edge.transport)
    ? edge.transport.left.length > 0
    : O.isSome(edge.transport.right);
};

/**
 * Edge ids with something to offer right now, in rule insertion order.
 *
 * `inbound` is the node's own inbound index, so a rule naming an edge that is not wired into this
 * node is a definition error rather than a silently unsatisfied entry.
 *
 * @throws {DataflowDefinitionError} when a rule entry is not one of `nodeId`'s inbound edges.
 */
export const satisfiedEdges = <N extends TSchema, T>(
  trigger: TriggerRule<N, T>,
  inbound: ReadonlyMap<EdgeId, Edge<N, T>>,
  nodeId: NodeId,
): readonly EdgeId[] => {
  const satisfied: EdgeId[] = [];
  for (const edgeId of trigger.rule) {
    if (isSatisfied(edgeId, inbound, nodeId)) satisfied.push(edgeId);
  }
  return satisfied;
};

/** Whether `trigger` fires when `has(edgeId)` says which entries have something to offer. Never short-circuits. */
export const fires = <N extends TSchema, T>(
  trigger: TriggerRule<N, T>,
  has: (edgeId: EdgeId) => boolean,
): boolean => {
  let met = 0;
  for (const edgeId of trigger.rule) if (has(edgeId)) met++;
  return trigger.kind === "all" ? met === trigger.rule.length : met > 0;
};

/**
 * Whether `trigger` fires right now against `nodeId`'s inbound edges. An empty rule is `true` for
 * `"all"` and `false` for `"any"`.
 *
 * Deliberately does NOT short-circuit: `isSatisfied` doubles as the wiring check, so bailing early
 * on a decided outcome would stop a later entry's unknown-edge reference from throwing.
 *
 * @throws {DataflowDefinitionError} when a rule entry is not one of `nodeId`'s inbound edges.
 */
export const evaluateTrigger = <N extends TSchema, T>(
  trigger: TriggerRule<N, T>,
  inbound: ReadonlyMap<EdgeId, Edge<N, T>>,
  nodeId: NodeId,
): boolean => {
  return fires(trigger, (edgeId) => isSatisfied(edgeId, inbound, nodeId));
};
