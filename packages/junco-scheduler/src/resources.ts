import {
  DataflowDefinitionError,
  type NodeIdType,
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

type Rank = <S, N extends TSchema, T, C>(
  snapshot: Snapshot<S, N, T, C>,
  left: NodeIdType,
  right: NodeIdType,
) => number;

function ranked(kind: ResourceKind, order: 1 | -1): Rank {
  return (snapshot, left, right) => {
    const a = snapshot.measurements.get(left)?.get(kind)?.at(-1);
    const b = snapshot.measurements.get(right)?.get(kind)?.at(-1);
    if (a === undefined) return b === undefined ? 0 : 1;
    if (b === undefined) return -1;
    return order * (a - b);
  };
}

/** Rank for `choose`: lowest latest measurement first; unmeasured nodes tie after measured nodes. */
export function lowest(kind: ResourceKind): Rank {
  return ranked(kind, 1);
}

/** Rank for `choose`: highest latest measurement first; unmeasured nodes tie after measured nodes. */
export function highest(kind: ResourceKind): Rank {
  return ranked(kind, -1);
}

/** Allowances for `limit`: a per-decision memory admission bound and token/tool budgets per `scope`. */
export type LimitOptions = {
  /** Memory admission allowance for one decision (not an enforced process memory cap). */
  readonly memory?: ResourceQuantity<"memory">;
  /** Optional calibrated byte floor per node, including cold starts. Undefined means no calibration. */
  readonly memoryFloor?: (node: NodeIdType) => number | undefined;
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
 * `memory` admits nodes in the inner decision's order using their peak retained memory sample
 * in bytes, raised to `memoryFloor(node)` when supplied. A node without either value runs
 * alone, since its memory need is unknown. A known need exceeding the allowance cannot run.
 * This estimates the concurrent batch, not memory retained across yields; leave headroom.
 * Wrap the outermost scheduler so `separate` branches share one allowance.
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
      key !== "memoryFloor" &&
      key !== "tokens" &&
      key !== "tools" &&
      key !== "scope"
    )
      throw new DataflowDefinitionError(`limit: unknown limit "${key}"`);
  const { memory, memoryFloor, tokens, tools, scope } = limits;
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
  if (
    memoryFloor !== undefined &&
    (memory === undefined || typeof memoryFloor !== "function")
  )
    throw new DataflowDefinitionError(
      "limit: memoryFloor requires a memory limit and a byte estimator",
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
    usage === undefined ? entry : copyUsageLimits(entry, { ...entry }, usage);
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
      let need = memoryFloor?.(entry.nodeId);
      if (need !== undefined && !(Number.isSafeInteger(need) && need >= 0))
        throw new DataflowDefinitionError(
          `limit: memoryFloor for node "${entry.nodeId}" must be a non-negative safe integer in bytes`,
        );
      const samples = snapshot.measurements.get(entry.nodeId)?.get("memory");
      if (samples !== undefined)
        for (const sample of samples)
          if (need === undefined || sample > need) need = sample;
      if (need === undefined) {
        if (selected.length > 0) continue;
        selected.push(admit(entry));
        break;
      }
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
