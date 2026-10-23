/** The `code` of every error a Marsh policy denial of publication rejects with. */
export const MARSH_POLICY_DENIED = "MARSH_POLICY_DENIED";

/** A native rejection caused by a Marsh policy denial; its message is the diagnostic. */
export interface MarshPolicyDeniedError extends Error {
  readonly code: typeof MARSH_POLICY_DENIED;
}

/** Whether `error` is a Marsh policy denial, by its exact code, never its message text. */
export function isMarshPolicyDenied(
  error: unknown,
): error is MarshPolicyDeniedError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === MARSH_POLICY_DENIED
  );
}

/** `root` and every value reachable through `AggregateError.errors` then `Error.cause`, DFS preorder, each once. */
export function* errorGraph(
  root: unknown,
): Generator<unknown, void, undefined> {
  const seen = new Set<unknown>();
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (seen.has(value)) continue;
    seen.add(value);
    yield value;
    const next: unknown[] = [];
    if (value instanceof AggregateError) next.push(...value.errors);
    if (value instanceof Error && "cause" in value) next.push(value.cause);
    pending.push(...next.reverse());
  }
}

/** `return()` each child in order, collecting failures, then rethrow `primary`; failures aggregate as
 *  `new AggregateError([primary, ...failures], message, { cause: primary })`. */
export async function disposeThenRethrow(
  children: Iterable<{ return(): Promise<unknown> }>,
  primary: unknown,
  message: string,
): Promise<never> {
  const failures: unknown[] = [];
  for (const child of children) {
    try {
      await child.return();
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length > 0)
    throw new AggregateError([primary, ...failures], message, {
      cause: primary,
    });
  throw primary;
}
