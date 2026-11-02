import {
  DataflowDefinitionError,
  type EdgeIdType,
  type InputSchedule,
  type Measure,
  measureFeatures,
  type NodeIdType,
  type ParentView,
  type ResourceKind,
  type ResourceQuantity,
  UsageBudget,
  type UsageLimitScope,
} from "dataflow-engine";
import type { TSchema } from "typebox";
import {
  type NodeModel,
  type Scheduler,
  type Snapshot,
  validateDecision,
} from "./scheduler.js";
import { copyUsageLimits, type UsageLimitDefinition } from "./usage-limits.js";

function countPort<N extends TSchema, T>(
  id: NodeIdType,
  resource: ResourceKind,
  port: EdgeIdType,
  measure: Measure,
  view: ParentView<N, T>,
  plan: InputSchedule,
): number {
  if (measure !== "count")
    throw new DataflowDefinitionError(
      `estimate: node "${id}" profile "${resource}" measures "${measure}" on port "${port}"; only "count" features can be estimated from a planned batch`,
    );
  const queue = view.messages.get(port);
  const n = plan.get(port);
  return queue === undefined || n === undefined || n === "none"
    ? 0
    : n === "all"
      ? queue.length
      : Math.min(n, queue.length);
}

function safeCost<S, N extends TSchema, T, C>(
  snapshot: Snapshot<S, N, T, C>,
  id: NodeIdType,
  kind: ResourceKind,
  who: "limit" | "lowest" | "highest",
): number {
  const profile = snapshot.nodes.get(id)?.profiles[kind];
  if (profile === undefined)
    throw new DataflowDefinitionError(
      `${who}: node "${id}" has no ${kind} profile`,
    );
  const plan = snapshot.plans.get(id);
  if (plan === undefined)
    throw new DataflowDefinitionError(`${who}: node "${id}" is not available`);
  const view = snapshot.inputs.get(id);
  if (view === undefined)
    throw new DataflowDefinitionError(`${who}: node "${id}" has no inputs`);
  const features = measureFeatures(profile.features, (port, measure) =>
    countPort(id, profile.resource, port, measure, view, plan),
  );
  if (features === undefined)
    throw new DataflowDefinitionError(
      `${who}: node "${id}" ${kind} features unmeasurable`,
    );
  return profile.predict(features).safe * profile.unit.scale;
}

type Rank = <S, N extends TSchema, T, C>(
  snapshot: Snapshot<S, N, T, C>,
  left: NodeIdType,
  right: NodeIdType,
) => number;

function ranked(
  kind: ResourceKind,
  order: 1 | -1,
  who: "lowest" | "highest",
): Rank {
  const cache = new WeakMap<object, Map<NodeIdType, number>>();
  return (snapshot, left, right) => {
    let costs = cache.get(snapshot);
    if (costs === undefined) {
      costs = new Map();
      cache.set(snapshot, costs);
    }
    const cost = (id: NodeIdType): number => {
      const cached = costs.get(id);
      if (cached !== undefined) return cached;
      const value = safeCost(snapshot, id, kind, who);
      costs.set(id, value);
      return value;
    };
    return order * (cost(left) - cost(right));
  };
}

/** Rank for `choose`: lower predicted `kind` cost first (the profile's `safe` estimate, base units). */
export function lowest(kind: ResourceKind): Rank {
  return ranked(kind, 1, "lowest");
}

/** Rank for `choose`: higher predicted `kind` cost first, e.g. `highest("runtime")` starts the longest work first. */
export function highest(kind: ResourceKind): Rank {
  return ranked(kind, -1, "highest");
}

/** Allowances for `limit`: a per-decision memory admission bound and token/tool budgets per `scope`. */
export type LimitOptions = {
  /** Predicted peak memory of one decision's batch. */
  readonly memory?: ResourceQuantity<"memory">;
  /** Committed model tokens (input, output and cache) per `scope`. */
  readonly tokens?: ResourceQuantity<"tokens">;
  /** Admitted tool calls, every tool counted together, per `scope`. */
  readonly tools?: number;
  /** The lifetime of the tokens/tools ledgers; default `"evaluation"`. */
  readonly scope?: UsageLimitScope;
};

/** `quantity` in whole base tokens, if it is a non-negative token quantity. */
function tokenAmount(quantity: ResourceQuantity<"tokens">): number {
  const unit: Partial<ResourceQuantity<"tokens">["unit"]> | undefined =
    typeof quantity === "object" && quantity !== null
      ? quantity.unit
      : undefined;
  const dimension: unknown = unit?.dimension;
  if (
    unit === undefined ||
    !(Number.isFinite(quantity.amount) && quantity.amount >= 0) ||
    typeof unit.scale !== "number" ||
    !(Number.isFinite(unit.scale) && unit.scale > 0) ||
    unit.offset !== 0 ||
    typeof dimension !== "object" ||
    dimension === null ||
    Object.entries(dimension).some(([name, power]) =>
      name === "tokens" ? power !== 1 : power !== 0,
    ) ||
    !("tokens" in dimension)
  )
    throw new DataflowDefinitionError(
      "limit: tokens must be a non-negative token quantity",
    );
  return quantity.amount * unit.scale;
}

/**
 * Bound `scheduler`'s work by `limits`.
 *
 * `memory` admits, in the inner decision's order, only nodes whose predicted peak memory (the
 * `memory` profile's `safe` estimate on the batch each would consume) fits beside the nodes
 * already admitted: Σ safe ≤ memory. One decision is one concurrently executed column, so the
 * sum is that column's predicted peak; memory a node retains across yields is not tracked —
 * leave headroom. Every selected node needs a memory profile. A skipped node stays available; a
 * policy that ranks small work first can delay a large node while small work keeps arriving.
 * Wrap the outermost scheduler: `separate` branches wrapped individually each receive the whole
 * allowance.
 *
 * `tokens` and `tools` are enforced budgets on the admitted nodes' actual usage, shared by every
 * node this combinator instance admits within `scope`: one `run()`/`step()` invocation
 * (`"evaluation"`), one decision (`"batch"`), or each node's single activation (`"activation"`).
 * Exhausting one fails the graph call with a `UsageLimitError`.
 */
export function limit<S, N extends TSchema, T, C>(
  limits: LimitOptions,
  scheduler: Scheduler<S, N, T, C>,
): Scheduler<S, N, T, C> {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits))
    throw new DataflowDefinitionError("limit: limits must be an object");
  for (const key of Object.keys(limits))
    if (
      key !== "memory" &&
      key !== "tokens" &&
      key !== "tools" &&
      key !== "scope"
    )
      throw new DataflowDefinitionError(`limit: unknown limit "${key}"`);
  const { memory, tokens, tools, scope } = limits;
  if (memory === undefined && tokens === undefined && tools === undefined)
    throw new DataflowDefinitionError(
      "limit: needs a memory, tokens or tools limit",
    );
  if (
    memory !== undefined &&
    !(Number.isFinite(memory.amount) && memory.amount > 0)
  )
    throw new DataflowDefinitionError(
      "limit: memory must be a positive quantity",
    );
  let usage: UsageLimitDefinition | undefined;
  if (tokens !== undefined || tools !== undefined) {
    // The ledger constructor validates scope and counts once, here.
    const { scope: validScope, limits: validLimits } = new UsageBudget(
      scope ?? "evaluation",
      {
        ...(tokens === undefined ? {} : { tokens: tokenAmount(tokens) }),
        ...(tools === undefined ? {} : { tools }),
      },
    );
    usage = Object.freeze({ scope: validScope, limits: validLimits });
  } else if (scope !== undefined) {
    throw new DataflowDefinitionError(
      "limit: scope applies only to tokens and tools",
    );
  }
  const admit = (entry: NodeModel): NodeModel =>
    usage === undefined
      ? entry
      : copyUsageLimits(
          entry,
          { nodeId: entry.nodeId, modelStrength: entry.modelStrength },
          usage,
        );
  const limitBase =
    memory === undefined ? undefined : memory.amount * memory.unit.scale;
  return async (snapshot, signal) => {
    signal?.throwIfAborted();
    const decision = await scheduler(snapshot, signal);
    validateDecision(snapshot, decision);
    signal?.throwIfAborted();
    if (memory === undefined || limitBase === undefined)
      return { selected: decision.selected.map(admit) };
    let load = 0;
    const selected: NodeModel[] = [];
    let smallest: { id: NodeIdType; need: number } | undefined;
    for (const entry of decision.selected) {
      const need = safeCost(snapshot, entry.nodeId, "memory", "limit");
      if (load + need <= limitBase) {
        selected.push(admit(entry));
        load += need;
      } else if (smallest === undefined || need < smallest.need) {
        smallest = { id: entry.nodeId, need };
      }
    }
    if (selected.length === 0 && smallest !== undefined)
      throw new DataflowDefinitionError(
        `limit: node "${smallest.id}" needs memory=${memory.unit(smallest.need / memory.unit.scale).toString()} alone, exceeding ${memory.toString()}`,
      );
    return { selected };
  };
}
