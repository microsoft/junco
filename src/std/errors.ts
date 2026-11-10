// Failure policies of agent nodes: leaves decide, wrappers take `inner`, as the `schedules` combinators do.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgenticInputSchema, ErrorHandler } from "junco-agent";
import type { ModelStrength } from "junco-scheduler";
import type { TSchema } from "typebox";
import {
  applyModel,
  type Ladder,
  resolveRung,
  validateLadder,
} from "../node-policy.js";

export type { ErrorHandler } from "junco-agent";

/** Hard error: reject the run with `DataflowNodeError` carrying the failure. */
export const crash =
  <
    N extends TSchema = typeof AgenticInputSchema,
    V = AssistantMessage,
  >(): ErrorHandler<N, V> =>
  ({ error }) => {
    throw error;
  };

/**
 * Re-prompt the same agent after `afterMs` while `failure.attempt <= times`; then `inner` decides.
 * @throws {RangeError} "retry afterMs must be a non-negative finite number" / "retry times must be a non-negative safe integer".
 */
export function retry<
  N extends TSchema = typeof AgenticInputSchema,
  V = AssistantMessage,
>(
  options: { readonly afterMs: number; readonly times: number },
  inner: ErrorHandler<N, V>,
): ErrorHandler<N, V> {
  if (!Number.isFinite(options.afterMs) || options.afterMs < 0)
    throw new RangeError("retry afterMs must be a non-negative finite number");
  if (!Number.isSafeInteger(options.times) || options.times < 0)
    throw new RangeError("retry times must be a non-negative safe integer");
  return (failure) =>
    failure.attempt <= options.times
      ? { retryAfterMs: options.afterMs }
      : inner(failure);
}

/**
 * Switch the agent to the rung above the highest one matching its current `provider/model@thinking` and re-prompt it
 * at once; at the top rung, or when its model is on no rung, `inner` decides.
 * Compose as `retry(…, escalate(…, …))` so same-rung retries run first.
 * @throws {DataflowDefinitionError} via `validateLadder` at construction.
 */
export function escalate<
  N extends TSchema = typeof AgenticInputSchema,
  V = AssistantMessage,
>(
  options: { readonly ladder: Ladder },
  inner: ErrorHandler<N, V>,
): ErrorHandler<N, V> {
  validateLadder(options.ladder);
  return async (failure) => {
    const [model, thinking] = await Promise.all([
      failure.agent.getModel(),
      failure.agent.getThinkingLevel(),
    ]);
    const key = (i: ModelStrength) => {
      const rung = resolveRung(options.ladder, i);
      return `${rung.provider}/${rung.modelId}@${rung.thinking}`;
    };
    const current =
      model === undefined
        ? undefined
        : `${model.provider}/${model.id}@${thinking}`;
    const at = ([4, 3, 2, 1, 0] as const).find((i) => key(i) === current);
    if (at === undefined || at === 4) return inner(failure);
    const {
      provider,
      modelId,
      thinking: next,
    } = resolveRung(options.ladder, (at + 1) as ModelStrength);
    await applyModel(failure.agent, { provider, modelId }, next);
    return { retryAfterMs: 0 };
  };
}

/**
 * Count the failure and `inner`'s decision in the node's recorder, then return that decision.
 * Records one `metrics` event with resource `operations`, category `agent`, tool `""`, operation
 * `failure`, and counters `{ failures: 1, <decision>: 1 }`, where `<decision>` is `retries`,
 * `soft_errors` or `hard_errors`. No error text is recorded; the failed run's `finish` with
 * `outcome: "error"` is already recorded by `JuncoAgent`.
 */
export const record =
  <N extends TSchema = typeof AgenticInputSchema, V = AssistantMessage>(
    inner: ErrorHandler<N, V>,
  ): ErrorHandler<N, V> =>
  async (failure) => {
    const event = (decision: string) =>
      failure.recorder?.record({
        kind: "metrics",
        resource: "operations",
        category: "agent",
        tool: "",
        operation: "failure",
        counters: { failures: 1, [decision]: 1 },
      });
    let recovery: Awaited<ReturnType<ErrorHandler<N, V>>>;
    try {
      recovery = await inner(failure);
    } catch (error) {
      event("hard_errors");
      throw error;
    }
    event("retryAfterMs" in recovery ? "retries" : "soft_errors");
    return recovery;
  };
