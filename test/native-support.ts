/**
 * Registers a test-owned release (a connection's close, an agent's return, a graph's close);
 * the returned function retires that registration once it is done.
 */
export type DeferNativeRelease = <R>(release: () => R) => () => void;

/**
 * Runs `body`, then attempts every still-registered release in reverse registration order,
 * even after a body or release failure. A body failure is rethrown unchanged when every release
 * succeeded; otherwise the failures are aggregated, the body's first and as the `cause`.
 *
 * Register each acquisition before the next acquisition or assertion. An explicitly awaited
 * disposal retires its registration with `resource.close().finally(forget)`, so a disposal the
 * test deliberately observes failing is neither swallowed nor replayed here.
 */
export async function withNativeCleanup<T>(
  body: (defer: DeferNativeRelease) => Promise<T>,
): Promise<T> {
  const entries: { release: () => Promise<void>; active: boolean }[] = [];
  const defer: DeferNativeRelease = (release) => {
    const entry = {
      release: async () => {
        await release();
      },
      active: true,
    };
    entries.push(entry);
    return () => {
      entry.active = false;
    };
  };
  const failures: unknown[] = [];
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = await body(defer);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    for (const entry of entries.reverse()) {
      if (!entry.active) continue;
      entry.active = false;
      try {
        await entry.release();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 0) {
    if (failed) throw failure;
    return value as T;
  }
  if (!failed && failures.length === 1) throw failures[0];
  throw new AggregateError(
    failed ? [failure, ...failures] : failures,
    "Native test cleanup failed",
    failed ? { cause: failure } : undefined,
  );
}
