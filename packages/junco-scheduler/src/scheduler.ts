import {
  DataflowDefinitionError,
  type DataflowObservation,
  type InputSchedule,
  type NodeIdType,
} from "dataflow-engine";
import type { TSchema } from "typebox";
import { copyUsageLimits } from "./usage-limits.js";

/** The five model strengths, weakest first; a `Ladder` names one model per strength. */
export const MODEL_STRENGTHS = ["smol", "low", "med", "high", "xhigh"] as const;
/** A strength by name, `"smol"` … `"xhigh"`. */
export type ModelStrengthName = (typeof MODEL_STRENGTHS)[number];
/** Index into MODEL_STRENGTHS: 0 = smol … 4 = xhigh. */
export type ModelStrength = 0 | 1 | 2 | 3 | 4;
/** `2` (`"med"`): the strength work-only policies select at. */
export const DEFAULT_MODEL_STRENGTH: ModelStrength = 2;
/** One selected node and the strength it runs at. */
export type NodeModel = {
  readonly nodeId: NodeIdType;
  readonly modelStrength: ModelStrength;
};
/** One scheduler answer: the nodes that run together in the next column, each at a strength. */
export type Decision = { readonly selected: readonly NodeModel[] };
/** Work-only policies select at the default strength. */
export const select = (
  ids: Iterable<NodeIdType>,
  modelStrength: ModelStrength = DEFAULT_MODEL_STRENGTH,
): NodeModel[] => [...ids].map((nodeId) => ({ nodeId, modelStrength }));
/** The node ids of `selected`, in order. */
export const nodeIds = (selected: readonly NodeModel[]): NodeIdType[] =>
  selected.map((entry) => entry.nodeId);

/** Native containers are detached; opaque state, messages, results and metadata are borrowed. */
export type Snapshot<S, N extends TSchema, T, C> = DataflowObservation<
  S,
  N,
  T
> & {
  readonly available: ReadonlySet<NodeIdType>;
  readonly owned: ReadonlySet<NodeIdType>;
  readonly context: ReadonlyMap<NodeIdType, C>;
  /** Input consumption planned for each available node in this decision. */
  readonly plans: ReadonlyMap<NodeIdType, InputSchedule>;
  readonly history: readonly Decision[];
  readonly threads: number;
};

/** A policy: from a `Snapshot` of the graph (and an optional cancellation signal) to one `Decision`. */
export type Scheduler<S, N extends TSchema, T, C> = (
  snapshot: Snapshot<S, N, T, C>,
  signal?: AbortSignal,
) => Decision | Promise<Decision>;

/** Internal authority check shared by composition and the context driver. */
export function validateDecision<S, N extends TSchema, T, C>(
  snapshot: Snapshot<S, N, T, C>,
  decision: Decision,
): void {
  if (
    decision === null ||
    typeof decision !== "object" ||
    Array.isArray(decision) ||
    !Array.isArray(decision.selected)
  ) {
    throw new DataflowDefinitionError(
      "Scheduler must return a decision with a selected array of { nodeId, modelStrength } entries",
    );
  }
  const seen = new Set<NodeIdType>();
  for (const entry of decision.selected) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.nodeId !== "string"
    )
      throw new DataflowDefinitionError(
        "Scheduler must return a decision with a selected array of { nodeId, modelStrength } entries",
      );
    const { nodeId, modelStrength } = entry;
    if (
      !Number.isInteger(modelStrength) ||
      modelStrength < 0 ||
      modelStrength > 4
    )
      throw new DataflowDefinitionError(
        `Scheduler decision gives node "${nodeId}" an invalid model strength ${String(modelStrength)}`,
      );
  }
  for (const { nodeId: id } of decision.selected) {
    if (seen.has(id))
      throw new DataflowDefinitionError(
        `Scheduler decision selects node "${id}" more than once`,
      );
    if (!snapshot.owned.has(id))
      throw new DataflowDefinitionError(
        `Scheduler decision selects unowned node "${id}"`,
      );
    if (!snapshot.available.has(id))
      throw new DataflowDefinitionError(
        `Scheduler decision selects unavailable node "${id}"`,
      );
    seen.add(id);
  }
}

/** Rank only available, owned work; equal ranks use raw JavaScript string order. */
export function choose<S, N extends TSchema, T, C>(options: {
  readonly where?: (
    snapshot: Snapshot<S, N, T, C>,
    node: NodeIdType,
  ) => boolean;
  readonly rank: (
    snapshot: Snapshot<S, N, T, C>,
    left: NodeIdType,
    right: NodeIdType,
  ) => number;
  readonly width?: (snapshot: Snapshot<S, N, T, C>) => number;
}): Scheduler<S, N, T, C> {
  return (snapshot) => {
    const width = options.width === undefined ? 1 : options.width(snapshot);
    if (width !== Infinity && (!Number.isInteger(width) || width < 0))
      throw new DataflowDefinitionError(
        "Scheduler width must be a non-negative integer or Infinity",
      );
    const candidates: NodeIdType[] = [];
    for (const id of snapshot.available) {
      if (snapshot.owned.has(id) && (options.where?.(snapshot, id) ?? true))
        candidates.push(id);
    }
    candidates.sort((left, right) => {
      const rank = options.rank(snapshot, left, right);
      if (typeof rank !== "number" || Number.isNaN(rank))
        throw new DataflowDefinitionError(
          "Scheduler rank must return a number other than NaN",
        );
      return rank === 0 ? (left < right ? -1 : left > right ? 1 : 0) : rank;
    });
    return { selected: select(candidates.slice(0, width)) };
  };
}

function restrict<S, N extends TSchema, T, C>(
  snapshot: Snapshot<S, N, T, C>,
  owned: ReadonlySet<NodeIdType>,
): Snapshot<S, N, T, C> {
  const history: Decision[] = [];
  for (const decision of snapshot.history) {
    const selected = decision.selected.filter((entry) =>
      owned.has(entry.nodeId),
    );
    if (selected.length > 0)
      history.push(Object.freeze({ selected: Object.freeze(selected) }));
  }
  return Object.freeze({ ...snapshot, owned, history: Object.freeze(history) });
}

/**
 * Split exclusive selection authority, not work, effects or JavaScript memory.
 * Shared native observations and metadata stay globally visible. Successful children
 * conserve authority; safety does not imply thread feasibility, fairness or progress.
 * Frame/associativity laws require total, deterministic, owned-local callbacks.
 */
export function separate<S, N extends TSchema, T, C>(
  leftOwns: (snapshot: Snapshot<S, N, T, C>, node: NodeIdType) => boolean,
  left: Scheduler<S, N, T, C>,
  right: Scheduler<S, N, T, C>,
): Scheduler<S, N, T, C> {
  return async (snapshot, signal) => {
    signal?.throwIfAborted();
    const leftDomain = new Set<NodeIdType>();
    const rightDomain = new Set<NodeIdType>();
    for (const id of snapshot.owned)
      (leftOwns(snapshot, id) ? leftDomain : rightDomain).add(id);
    const leftSnapshot = restrict(snapshot, leftDomain);
    const rightSnapshot = restrict(snapshot, rightDomain);
    const invoke = async (
      scheduler: Scheduler<S, N, T, C>,
      scoped: Snapshot<S, N, T, C>,
    ): Promise<Decision> => {
      const decision = await scheduler(scoped, signal);
      validateDecision(scoped, decision);
      return decision;
    };
    // Queue both jobs before invoking either: a synchronous throw cannot suppress its sibling.
    signal?.throwIfAborted();
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => invoke(left, leftSnapshot)),
      Promise.resolve().then(() => invoke(right, rightSnapshot)),
    ]);
    signal?.throwIfAborted();
    const [leftResult, rightResult] = outcomes;
    if (leftResult.status === "rejected") throw leftResult.reason;
    if (rightResult.status === "rejected") throw rightResult.reason;
    return {
      selected: [...leftResult.value.selected, ...rightResult.value.selected],
    };
  };
}

/** Override the strength of every node `inner` selects; `assign` names the rung per node. */
export function strength<S, N extends TSchema, T, C>(
  assign: (
    snapshot: Snapshot<S, N, T, C>,
    nodeId: NodeIdType,
  ) => ModelStrengthName,
  inner: Scheduler<S, N, T, C>,
): Scheduler<S, N, T, C> {
  return async (snapshot, signal) => {
    const decision = await inner(snapshot, signal);
    return {
      selected: decision.selected.map((entry) => {
        const { nodeId } = entry;
        const name = assign(snapshot, nodeId);
        const index = MODEL_STRENGTHS.indexOf(name);
        if (index < 0)
          throw new DataflowDefinitionError(
            `strength: unknown model strength "${name}" for node "${nodeId}"`,
          );
        return copyUsageLimits(entry, {
          nodeId,
          modelStrength: index as ModelStrength,
        });
      }),
    };
  };
}

/** Normalize this invocation's first applicable speculative wave; retain no future plan. */
export function agent<S, N extends TSchema, T, C>(
  invoke: (
    snapshot: Snapshot<S, N, T, C>,
    signal?: AbortSignal,
  ) => Promise<readonly (readonly NodeIdType[])[]>,
): Scheduler<S, N, T, C> {
  return async (snapshot, signal) => {
    let hasCandidate = false;
    for (const id of snapshot.available) {
      if (snapshot.owned.has(id)) {
        hasCandidate = true;
        break;
      }
    }
    if (!hasCandidate) return { selected: [] };
    const waves = await invoke(snapshot, signal);
    for (const wave of waves) {
      const selected = new Set<NodeIdType>();
      for (const id of wave)
        if (snapshot.available.has(id) && snapshot.owned.has(id))
          selected.add(id);
      if (selected.size > 0) return { selected: select(selected) };
    }
    return { selected: [] };
  };
}
