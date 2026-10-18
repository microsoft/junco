import {
  DataflowDefinitionError,
  type EdgeIdType, type InputSchedule, type Measure, type NodeIdType, type ParentView,
  type ResourceKind, type ResourceQuantity,
} from "dataflow-engine";
import { type Scheduler, type Snapshot, validateDecision } from "./scheduler.js";

function countPort<N, T>(id: NodeIdType, resource: ResourceKind, port: EdgeIdType, measure: Measure, view: ParentView<N, T>, plan: InputSchedule): number {
  if (measure !== "count")
    throw new DataflowDefinitionError(`estimate: node "${id}" profile "${resource}" measures "${measure}" on port "${port}"; only "count" features can be estimated from a planned batch`);
  const queue = view.messages.get(port);
  const n = plan.get(port);
  return queue === undefined || n === undefined || n === "none" ? 0 : n === "all" ? queue.length : Math.min(n, queue.length);
}

function safeCost<S, N, T, C>(
  snapshot: Snapshot<S, N, T, C>, id: NodeIdType, kind: ResourceKind,
  who: "limit" | "lowest" | "highest",
): number {
  const profile = snapshot.nodes.get(id)?.profiles[kind];
  if (profile === undefined) throw new DataflowDefinitionError(`${who}: node "${id}" has no ${kind} profile`);
  const plan = snapshot.plans.get(id);
  if (plan === undefined) throw new DataflowDefinitionError(`${who}: node "${id}" is not available`);
  const view = snapshot.inputs.get(id)!;
  const features = profile.features.map(feature => {
    if ("port" in feature) return countPort(id, profile.resource, feature.port, feature.measure, view, plan);
    let value = 0;
    for (const port of feature.ports) {
      const count = countPort(id, profile.resource, port, feature.measure, view, plan);
      value = feature.derived === "sum" ? value + count : Math.max(value, count);
    }
    return value;
  });
  return profile.predict(features).safe * profile.unit.scale;
}

type Rank = <S, N, T, C>(snapshot: Snapshot<S, N, T, C>, left: NodeIdType, right: NodeIdType) => number;

function ranked(kind: ResourceKind, order: 1 | -1, who: "lowest" | "highest"): Rank {
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

/**
 * Admit, in the inner decision's order, only nodes whose predicted peak memory (the `memory`
 * profile's `safe` estimate on the batch each would consume) fits beside the nodes already
 * admitted: Σ safe ≤ memory. One decision is one concurrently executed column, so the sum is
 * that column's predicted peak; memory a node retains across yields is not tracked — leave
 * headroom. Every selected node needs a memory profile. A skipped node stays available; a
 * policy that ranks small work first can delay a large node while small work keeps arriving.
 * Wrap the outermost scheduler: `separate` branches wrapped individually each receive the whole
 * allowance.
 */
export function limit<S, N, T, C>(
  limits: { readonly memory: ResourceQuantity<"memory"> },
  scheduler: Scheduler<S, N, T, C>,
): Scheduler<S, N, T, C> {
  const { memory } = limits;
  if (!(Number.isFinite(memory.amount) && memory.amount > 0))
    throw new DataflowDefinitionError("limit: memory must be a positive quantity");
  const limitBase = memory.amount * memory.unit.scale;
  return async (snapshot, signal) => {
    signal?.throwIfAborted();
    const decision = await scheduler(snapshot, signal);
    validateDecision(snapshot, decision);
    signal?.throwIfAborted();
    let load = 0;
    const selected: NodeIdType[] = [];
    let smallest: { id: NodeIdType; need: number } | undefined;
    for (const id of decision.selected) {
      const need = safeCost(snapshot, id, "memory", "limit");
      if (load + need <= limitBase) {
        selected.push(id);
        load += need;
      } else if (smallest === undefined || need < smallest.need) {
        smallest = { id, need };
      }
    }
    if (selected.length === 0 && smallest !== undefined)
      throw new DataflowDefinitionError(`limit: node "${smallest.id}" needs memory=${memory.unit(smallest.need / memory.unit.scale).toString()} alone, exceeding ${memory.toString()}`);
    return { selected };
  };
}
