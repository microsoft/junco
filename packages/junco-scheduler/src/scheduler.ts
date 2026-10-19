import {
  DataflowDefinitionError,
  type DataflowObservation,
  type InputSchedule,
  type NodeIdType,
} from "dataflow-engine";

export type Decision = { readonly selected: readonly NodeIdType[] };

/** Native containers are detached; opaque state, messages, results and metadata are borrowed. */
export type Snapshot<S, N, T, C> = DataflowObservation<S, N, T> & {
  readonly available: ReadonlySet<NodeIdType>;
  readonly owned: ReadonlySet<NodeIdType>;
  readonly context: ReadonlyMap<NodeIdType, C>;
  /** Input consumption planned for each available node in this decision. */
  readonly plans: ReadonlyMap<NodeIdType, InputSchedule>;
  readonly history: readonly Decision[];
  readonly threads: number;
};

export type Scheduler<S, N, T, C> = (
  snapshot: Snapshot<S, N, T, C>,
  signal?: AbortSignal,
) => Decision | Promise<Decision>;

/** Internal authority check shared by composition and the context driver. */
export function validateDecision<S, N, T, C>(
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
      "Scheduler must return a decision with a selected array of node IDs",
    );
  }
  const seen = new Set<NodeIdType>();
  for (const id of decision.selected) {
    if (typeof id !== "string")
      throw new DataflowDefinitionError(
        "Scheduler must return a decision with a selected array of node IDs",
      );
  }
  for (const id of decision.selected) {
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
export function choose<S, N, T, C>(options: {
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
    return { selected: candidates.slice(0, width) };
  };
}

function restrict<S, N, T, C>(
  snapshot: Snapshot<S, N, T, C>,
  owned: ReadonlySet<NodeIdType>,
): Snapshot<S, N, T, C> {
  const history: Decision[] = [];
  for (const decision of snapshot.history) {
    const selected = decision.selected.filter((id) => owned.has(id));
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
export function separate<S, N, T, C>(
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

/** Normalize this invocation's first applicable speculative wave; retain no future plan. */
export function agent<S, N, T, C>(
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
      if (selected.size > 0) return { selected: [...selected] };
    }
    return { selected: [] };
  };
}
