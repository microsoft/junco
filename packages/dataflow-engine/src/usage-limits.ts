import { AsyncLocalStorage } from "node:async_hooks";
import { DataflowDefinitionError } from "./errors.js";

/** How long one usage ledger lives: a whole `run()`/`step()`, one scheduler decision, or one node activation. */
export type UsageLimitScope = "evaluation" | "batch" | "activation";
/** Caps on committed model tokens and admitted tool calls; an omitted cap is unlimited, `0` denies all. */
export type UsageLimits = Readonly<{ tokens?: number; tools?: number }>;
/** What a `UsageLimitError` carries: which budget, its scope and limit, the usage that hit it, and the node path. */
export type UsageLimitDetails = Readonly<{
  resource: "tokens" | "tools";
  scope: UsageLimitScope;
  limit: number;
  /** The ledger's count before the denied tool call or the triggering token increment. */
  used: number;
  /** `1` for a tool call, the committed token delta, or `0` for a model request at an exhausted cap. */
  requested: number;
  /** `used + requested`. */
  attempted: number;
  /** `max(0, attempted - limit)`. */
  exceededBy: number;
  nodePath: readonly string[];
}>;

const USAGE_LIMIT_EXCEEDED = "JUNCO_USAGE_LIMIT_EXCEEDED";

/** A token or tool budget was hit; `details` and `toJSON()` carry the limit and the amount that hit it. */
export class UsageLimitError extends Error {
  readonly code = USAGE_LIMIT_EXCEEDED;
  readonly details: UsageLimitDetails;

  constructor(details: UsageLimitDetails) {
    const frozen: UsageLimitDetails = Object.freeze({
      resource: details.resource,
      scope: details.scope,
      limit: details.limit,
      used: details.used,
      requested: details.requested,
      attempted: details.attempted,
      exceededBy: details.exceededBy,
      nodePath: Object.freeze([...details.nodePath]),
    });
    super(
      `Usage limit hit: resource=${frozen.resource} scope=${frozen.scope} node=${JSON.stringify(frozen.nodePath)} limit=${frozen.limit} used=${frozen.used} requested=${frozen.requested} attempted=${frozen.attempted} exceededBy=${frozen.exceededBy}`,
    );
    this.name = "UsageLimitError";
    this.details = frozen;
  }

  toJSON(): UsageLimitDetails & { code: string; message: string } {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/** Whether `error` is a usage-limit failure, by its exact code, never its message text. */
export function isUsageLimitError(error: unknown): error is UsageLimitError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === USAGE_LIMIT_EXCEEDED
  );
}

function count(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new DataflowDefinitionError(
      `usage: ${what} must be a non-negative safe integer`,
    );
  return value;
}

/** One mutable ledger: counters start at zero; the first failure latches. */
export class UsageBudget {
  readonly scope: UsageLimitScope;
  readonly limits: UsageLimits;
  usedTokens = 0;
  usedTools = 0;
  failure: UsageLimitError | DataflowDefinitionError | undefined;

  constructor(scope: UsageLimitScope, limits: UsageLimits) {
    if (scope !== "evaluation" && scope !== "batch" && scope !== "activation")
      throw new DataflowDefinitionError(
        `usage: unknown scope ${JSON.stringify(scope)}`,
      );
    if (typeof limits !== "object" || limits === null)
      throw new DataflowDefinitionError("usage: limits must be an object");
    const tokens = count(limits.tokens, "tokens");
    const tools = count(limits.tools, "tools");
    if (tokens === undefined && tools === undefined)
      throw new DataflowDefinitionError(
        "usage: a budget needs a tokens or tools limit",
      );
    this.scope = scope;
    this.limits = Object.freeze({
      ...(tokens === undefined ? {} : { tokens }),
      ...(tools === undefined ? {} : { tools }),
    });
  }
}

/** The budgets applying to current work, outermost first, and the node path that names it. */
export type UsageContext = Readonly<{
  budgets: readonly UsageBudget[];
  nodePath: readonly string[];
}>;

// Boxed, so an explicitly empty context masks an enclosing one.
const active = new AsyncLocalStorage<{
  readonly context: UsageContext | undefined;
}>();

export function captureUsageContext(): UsageContext | undefined {
  return active.getStore()?.context;
}

/** Run `work` with exactly `context` (even `undefined`) as the current usage context. */
export function runWithUsageContext<T>(
  context: UsageContext | undefined,
  work: () => T,
): T {
  return active.run({ context }, work);
}

/** Run `work` inside node `nodeId` with the ambient budgets plus `budgets`, outer before inner. */
export function runWithUsageBudgets<T>(
  budgets: readonly UsageBudget[],
  nodeId: string,
  work: () => T,
): T {
  const ambient = captureUsageContext();
  const merged = [...(ambient?.budgets ?? [])];
  for (const budget of budgets)
    if (!merged.includes(budget)) merged.push(budget);
  return runWithUsageContext(
    Object.freeze({
      budgets: Object.freeze(merged),
      nodePath: Object.freeze([...(ambient?.nodePath ?? []), nodeId]),
    }),
    work,
  );
}

function hit(
  budget: UsageBudget,
  resource: "tokens" | "tools",
  limit: number,
  used: number,
  requested: number,
  nodePath: readonly string[],
): UsageLimitError {
  const attempted = used + requested;
  const error = new UsageLimitError({
    resource,
    scope: budget.scope,
    limit,
    used,
    requested,
    attempted,
    exceededBy: Math.max(0, attempted - limit),
    nodePath,
  });
  budget.failure ??= error;
  return error;
}

/** Throw the first latched failure, outermost first. */
export function assertUsageAllowed(
  context: UsageContext | undefined = captureUsageContext(),
): void {
  for (const budget of context?.budgets ?? [])
    if (budget.failure !== undefined) throw budget.failure;
}

/** Deny a new model request once any token count already reached its cap. */
export function assertTokenRequestAllowed(
  context: UsageContext | undefined = captureUsageContext(),
): void {
  if (context === undefined) return;
  assertUsageAllowed(context);
  for (const budget of context.budgets) {
    const limit = budget.limits.tokens;
    if (limit !== undefined && budget.usedTokens >= limit)
      throw hit(
        budget,
        "tokens",
        limit,
        budget.usedTokens,
        0,
        context.nodePath,
      );
  }
}

/**
 * Admit one tool call against every current budget, synchronously: all permit and all count it,
 * or none counts it and the first denial throws. Admitted calls are never refunded.
 */
export function admitToolCall(): void {
  const context = captureUsageContext();
  if (context === undefined) return;
  assertUsageAllowed(context);
  let denied: UsageLimitError | undefined;
  for (const budget of context.budgets) {
    const limit = budget.limits.tools;
    if (limit !== undefined && budget.usedTools + 1 > limit)
      denied ??= hit(
        budget,
        "tools",
        limit,
        budget.usedTools,
        1,
        context.nodePath,
      );
  }
  if (denied !== undefined) throw denied;
  for (const budget of context.budgets)
    if (budget.limits.tools !== undefined) budget.usedTools += 1;
}

/**
 * Charge one committed token increment to every current token budget, then throw the first
 * failure, outermost first. Usage keeps counting after a budget failed.
 */
export function chargeTokenUsage(
  delta: number,
  context: UsageContext | undefined = captureUsageContext(),
): void {
  if (context === undefined) return;
  const charged = context.budgets.filter(
    (budget) => budget.limits.tokens !== undefined,
  );
  if (charged.length === 0) return;
  if (!Number.isSafeInteger(delta) || delta < 0) {
    const error = new DataflowDefinitionError(
      "usage: tokens must be a non-negative safe integer",
    );
    for (const budget of charged) budget.failure ??= error;
    throw error;
  }
  for (const budget of charged) {
    const limit = budget.limits.tokens;
    const used = budget.usedTokens;
    budget.usedTokens = used + delta;
    if (
      limit !== undefined &&
      budget.failure === undefined &&
      budget.usedTokens > limit
    )
      hit(budget, "tokens", limit, used, delta, context.nodePath);
  }
  assertUsageAllowed(context);
}

/**
 * Whether `error`'s `AggregateError.errors`/`Error.cause` graph holds a usage-limit failure or a
 * failure latched on one of `context`'s budgets. Such errors bypass recovery.
 */
export function holdsUsageFailure(
  error: unknown,
  context: UsageContext | undefined = captureUsageContext(),
): boolean {
  const latched = new Set<unknown>();
  for (const budget of context?.budgets ?? [])
    if (budget.failure !== undefined) latched.add(budget.failure);
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const value = pending.pop();
    if (seen.has(value)) continue;
    seen.add(value);
    if (isUsageLimitError(value) || latched.has(value)) return true;
    if (value instanceof AggregateError) pending.push(...value.errors);
    if (value instanceof Error && "cause" in value) pending.push(value.cause);
  }
  return false;
}
