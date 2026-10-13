// Internal operations over several members; not part of the package's public surface.

import { DataflowNodeError } from "dataflow-engine";

/**
 * `error`, or `signal.reason` when `error` is that cancellation, possibly wrapped by node errors.
 * Package-internal.
 */
export function cancellation(signal: AbortSignal, error: unknown): unknown {
  if (!signal.aborted) return error;
  let current = error;
  while (current instanceof DataflowNodeError) current = current.cause;
  return current === signal.reason ? signal.reason : error;
}

/**
 * Start `request` on every member in order, synchronously, then settle them all. A synchronous
 * throw counts as that member's failure; failures reject together, in member order, as one
 * `AggregateError` carrying the original errors.
 */
export async function settleAll<A>(
  members: readonly A[],
  request: (member: A) => unknown | PromiseLike<unknown>,
  message: string,
): Promise<void> {
  const requests = members.map((member) => {
    try {
      return request(member);
    } catch (error) {
      return Promise.reject(error);
    }
  });
  const failures = (await Promise.allSettled(requests)).flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, message);
}
