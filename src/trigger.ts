import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { DataflowDefinitionError } from "./errors.js";
import type { Edge } from "./edges.js";
import type { EdgeId, NodeId } from "./identity.js";

/** Conjunction (`"all"`) or ordered disjunction (`"any"`) over a rule's entries. */
export type TriggerKind = "all" | "any";

/**
 * A node's readiness predicate: WHICH inbound edges must be carrying something. Never how much of
 * it to take — that is the scheduler's decision, carried in `MessageSchedule` (`scheduler.ts`).
 *
 * An entry is satisfied by a single queued message, or by a resolved value cell. A node that must
 * wait for a deeper backlog than that says so in its own `is_available` hook, which is handed the
 * live queues.
 *
 * `rule` is in call order — an `"any"` rule fires on the FIRST satisfied entry — and holds no
 * duplicate, so `rule.length` is the number of distinct edges `"all"` must see satisfied.
 *
 * `N`/`T` are phantom: they tie a rule to its graph's payload types without constraining the
 * structure, so `allOf(on(a), on(b))` needs no explicit type arguments at a call site.
 */
export type TriggerRule<N, T> = { readonly kind: TriggerKind; readonly rule: readonly EdgeId[] };

/** One rule entry: the inbound edge to watch. */
export const on = <N, T>(edge: Edge<N, T>): EdgeId => edge.id;

/**
 * Validate the variadic entries and adopt them as the rule, rejecting a duplicate edge id (which
 * would inflate an `"all"` rule's length and make it unsatisfiable).
 *
 * The rest-parameter array is freshly allocated per call and reachable from nowhere else, so it is
 * kept rather than copied. `indexOf` over a handful of entries beats allocating a `Set` to dedupe.
 */
const buildRule = (who: string, entries: readonly EdgeId[]): readonly EdgeId[] => {
  for (let i = 0; i < entries.length; i++) {
    const edgeId = entries[i]!;
    if (entries.indexOf(edgeId) !== i) {
      throw new DataflowDefinitionError(`${who} received edge "${edgeId}" twice`);
    }
  }
  return entries;
};

/** Conjunction: fires iff EVERY entry has something to offer. */
export const allOf = <N, T>(...entries: readonly EdgeId[]): TriggerRule<N, T> => ({
  kind: "all",
  rule: buildRule("allOf", entries),
});

/** Ordered disjunction: fires on the FIRST satisfied entry. */
export const anyOf = <N, T>(...entries: readonly EdgeId[]): TriggerRule<N, T> => ({
  kind: "any",
  rule: buildRule("anyOf", entries),
});

/**
 * The single-edge conjunction: `when(e)` is `allOf(on(e))`. Named because a one-entry `allOf` is by
 * far the most common trigger shape.
 */
export const when = <N, T>(edge: Edge<N, T>): TriggerRule<N, T> => allOf<N, T>(on(edge));

/** Fires every turn and names no edge — the source trigger. Identical to `allOf()`. */
export const always = <N, T>(): TriggerRule<N, T> => allOf<N, T>();

/** Never fires. Identical to `anyOf()`. */
export const never = <N, T>(): TriggerRule<N, T> => anyOf<N, T>();

/**
 * Whether one rule entry has something to offer right now: at least one queued message, or a
 * resolved value cell.
 *
 * @throws {DataflowDefinitionError} when `edgeId` is not one of `nodeId`'s inbound edges.
 */
const isSatisfied = <N, T>(edgeId: EdgeId, inbound: ReadonlyMap<EdgeId, Edge<N, T>>, nodeId: NodeId): boolean => {
  const edge = inbound.get(edgeId);
  if (edge === undefined) {
    throw new DataflowDefinitionError(
      `Node "${nodeId}" trigger references edge "${edgeId}" which is not one of its inbound edges`,
    );
  }
  return E.isLeft(edge.transport) ? edge.transport.left.length > 0 : O.isSome(edge.transport.right);
};

/**
 * Edge ids with something to offer right now, in rule insertion order.
 *
 * `inbound` is the node's own inbound index, so a rule naming an edge that is not wired into this
 * node is a definition error rather than a silently unsatisfied entry.
 *
 * @throws {DataflowDefinitionError} when a rule entry is not one of `nodeId`'s inbound edges.
 */
export const satisfiedEdges = <N, T>(
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

/**
 * Whether `trigger` fires right now against `nodeId`'s inbound edges. An empty rule is `true` for
 * `"all"` (how a source with no inbound edges stays permanently available) and `false` for `"any"`.
 *
 * Deliberately does NOT short-circuit: `isSatisfied` doubles as the wiring check, so bailing early
 * on a decided outcome would stop a later entry's unknown-edge reference from throwing.
 *
 * @throws {DataflowDefinitionError} when a rule entry is not one of `nodeId`'s inbound edges.
 */
export const evaluateTrigger = <N, T>(
  trigger: TriggerRule<N, T>,
  inbound: ReadonlyMap<EdgeId, Edge<N, T>>,
  nodeId: NodeId,
): boolean => {
  let met = 0;
  for (const edgeId of trigger.rule) {
    if (isSatisfied(edgeId, inbound, nodeId)) met++;
  }
  return trigger.kind === "all" ? met === trigger.rule.length : met > 0;
};
