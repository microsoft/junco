import {
  type NodeIdType,
  UsageBudget,
  type UsageLimitScope,
  type UsageLimits,
} from "dataflow-engine";
import type { NodeModel } from "./scheduler.js";

/** One `limit` combinator's usage constraint; its identity is the identity of its ledgers. */
export type UsageLimitDefinition = Readonly<{
  scope: UsageLimitScope;
  limits: UsageLimits;
}>;

/** Package-private sidecar: the usage limits enclosing each selected entry, outermost first. */
const definitions = new WeakMap<NodeModel, readonly UsageLimitDefinition[]>();

/** `copy` carrying `source`'s usage limits, with `outer` ahead of them when given. */
export function copyUsageLimits(
  source: NodeModel,
  copy: NodeModel,
  outer?: UsageLimitDefinition,
): NodeModel {
  const inner = definitions.get(source) ?? [];
  const merged =
    outer === undefined || inner.includes(outer) ? inner : [outer, ...inner];
  if (merged.length > 0) definitions.set(copy, Object.freeze([...merged]));
  return copy;
}

/**
 * One ledger per definition each selected node carries: `evaluation` ledgers from `evaluation`
 * (shared across this invocation's decisions), one `batch` ledger per definition in this
 * decision, and a fresh `activation` ledger per node.
 */
export function usageBudgets(
  selected: readonly NodeModel[],
  evaluation: Map<UsageLimitDefinition, UsageBudget>,
): ReadonlyMap<NodeIdType, readonly UsageBudget[]> {
  const batch = new Map<UsageLimitDefinition, UsageBudget>();
  const budgets = new Map<NodeIdType, readonly UsageBudget[]>();
  for (const entry of selected) {
    const enclosing = definitions.get(entry);
    if (enclosing === undefined) continue;
    budgets.set(
      entry.nodeId,
      Object.freeze(
        enclosing.map((definition) => {
          if (definition.scope === "activation")
            return new UsageBudget(definition.scope, definition.limits);
          const ledgers = definition.scope === "batch" ? batch : evaluation;
          let budget = ledgers.get(definition);
          if (budget === undefined) {
            budget = new UsageBudget(definition.scope, definition.limits);
            ledgers.set(definition, budget);
          }
          return budget;
        }),
      ),
    );
  }
  return budgets;
}
