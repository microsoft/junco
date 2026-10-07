import { DefaultLogLevels } from "tslog";
import type { NativeMux } from "../native/index.js";
import type { ToolCollectionOptions } from "./collection.js";
import { flushLog, log, logPolicyDecision } from "./log.js";
import type { NativeModule } from "./native.js";

/** One owner's ShellMux. Releasing it closes that mux; no other owner shares it. */
export interface ShellMuxLease {
  readonly mux: NativeMux;
  readonly native: NativeModule;
  /** True once release began. */
  readonly closed: boolean;
  /**
   * Closes the mux, then flushes the policy log so its last record is observable. Every call
   * returns the same terminal result.
   */
  release(): Promise<void>;
}

class Lease implements ShellMuxLease {
  #released: Promise<void> | undefined;

  constructor(
    readonly mux: NativeMux,
    readonly native: NativeModule,
  ) {}

  get closed(): boolean {
    return this.#released !== undefined;
  }

  release(): Promise<void> {
    this.#released ??= (async () => {
      // Native close drains every policy record first; the flush then makes the last one —
      // often the violation that ended the run — observable before release resolves.
      const closed = await this.mux.close().then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      try {
        await flushLog();
      } catch (flushError) {
        if (closed === undefined) throw flushError;
        throw new AggregateError(
          [closed.error, flushError],
          "ShellMux close and log flush failed",
          { cause: closed.error },
        );
      }
      if (closed !== undefined) throw closed.error;
    })();
    return this.#released;
  }
}

/**
 * Opens one fresh ShellMux at `cwd` (default sandbox `"shared"`) with `policy`, owned by the
 * returned lease alone. A failed open closes only what it acquired.
 */
export async function acquireShellMux(
  cwd: string,
  options: {
    readonly native?: NativeModule;
    readonly sandbox?: "shared" | "always";
    readonly policy: ToolCollectionOptions["policy"];
  },
): Promise<ShellMuxLease> {
  const { policy, sandbox = "shared" } = options;
  if (policy !== "GitPolicy" && policy !== "EmptyPolicy") {
    throw new TypeError('policy must be "GitPolicy" or "EmptyPolicy"');
  }
  // Dynamic by design: importing junco-tools must not load the addon.
  const native = options.native ?? (await import("junco-tools/native"));
  // The native producer's filter is fixed here: grants at DEBUG or below, violations at INFO
  // or below, no observer at all above INFO.
  const level = log.settings.minLevel;
  const mux = await native.NativeMux.open(
    cwd,
    { sandbox, policy, policyDebug: level <= DefaultLogLevels.DEBUG },
    level <= DefaultLogLevels.INFO ? logPolicyDecision : undefined,
  );
  const lease = new Lease(mux, native);
  try {
    await mux.validateCwd(cwd);
  } catch (error) {
    try {
      await lease.release();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "acquireShellMux: cwd validation failed and closing the mux failed",
        { cause: error },
      );
    }
    throw error;
  }
  return lease;
}
