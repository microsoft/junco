import { DefaultLogLevels } from "tslog";
import type {
  NativeMux,
  NativeResourceEvent,
  NativeResourceOptions,
} from "../native/index.js";
import { flushLog, log, logPolicyDecision } from "./log.js";
import type { NativeModule } from "./native.js";
import { LockPolicy, type Policy } from "./policy.js";

/** One owner's ShellMux. Releasing it closes that mux; no other owner shares it. */
export interface ShellMuxLease {
  readonly mux: NativeMux;
  readonly native: NativeModule;
  /** The authorization policy the mux was opened with. */
  readonly policy: Policy;
  /** True once release began. */
  readonly closed: boolean;
  /**
   * Closes the mux after every resource callback returns, then flushes the policy log so its
   * last record is observable. Every call returns the same terminal result.
   */
  release(): Promise<void>;
}

/** Opens owned {@link ShellMuxLease}s. */
export const ShellMuxLease = {
  /**
   * Opens one fresh ShellMux at `cwd` (default sandbox `"shared"`) with `policy` (default
   * {@link LockPolicy}), owned by the returned lease alone. A failed open closes only what it
   * acquired.
   */
  async create(
    cwd: string,
    options: {
      readonly native?: NativeModule;
      readonly sandbox?: "shared" | "always";
      readonly policy?: Policy;
      /**
       * Resource limits and monitoring of every command and persistent process on this mux
       * (Linux cgroup v2; a command fails closed without delegated controllers).
       */
      readonly resources?: NativeResourceOptions;
      /**
       * Receives each monitor event of this mux's pipelines; required by and requiring
       * `resources.monitorIntervalMs`. A throw is reported by `release()`. The stream ends with
       * the mux: `release()` resolves only after the last event returned.
       */
      readonly onResourceEvent?: (event: NativeResourceEvent) => void;
    } = {},
  ): Promise<ShellMuxLease> {
    const { policy = LockPolicy, sandbox = "shared" } = options;
    // Dynamic by design: importing junco-tools must not load the addon.
    const native = options.native ?? (await import("junco-tools/native"));
    // The native producer's filter is fixed here: grants at DEBUG or below, violations at INFO
    // or below, no observer at all above INFO.
    const level = log.settings.minLevel;
    const mux = await native.NativeMux.open(
      cwd,
      {
        sandbox,
        policy: policy.toNative(native),
        policyDebug: level <= DefaultLogLevels.DEBUG,
        resources: options.resources,
      },
      level <= DefaultLogLevels.INFO ? logPolicyDecision : undefined,
      options.onResourceEvent === undefined
        ? undefined
        : (error: Error | null, event: NativeResourceEvent) => {
            if (error !== null) throw error;
            options.onResourceEvent!(event);
          },
    );
    let released: Promise<void> | undefined;
    const lease: ShellMuxLease = {
      mux,
      native,
      policy,
      get closed() {
        return released !== undefined;
      },
      release() {
        released ??= (async () => {
          // Native close drains every policy record first; the flush then makes the last one —
          // often the violation that ended the run — observable before release resolves.
          const closed = await mux.close().then(
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
        return released;
      },
    };
    try {
      await mux.validateCwd(cwd);
    } catch (error) {
      try {
        await lease.release();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "ShellMuxLease.create: cwd validation failed and closing the mux failed",
          { cause: error },
        );
      }
      throw error;
    }
    return lease;
  },
};
