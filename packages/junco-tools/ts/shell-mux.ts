import { LogLevel } from "tslog";
import type {
  NativeMux,
  NativeResourceEvent,
  NativeResourceOptions,
} from "../native/index.js";
import { flushLog, log, logPolicyDecision } from "./log.js";
import type { NativeModule } from "./native.js";
import { LockPolicy, type Policy } from "./policy.js";
import type { ProfileRecorder } from "./profile-recorder.js";

/** One owner's ShellMux. Releasing it closes that mux; no other owner shares it. */
export interface ShellMuxLease {
  readonly mux: NativeMux;
  readonly native: NativeModule;
  /** The authorization policy the mux was opened with. */
  readonly policy: Policy;
  /** True once release began. */
  readonly closed: boolean;
  /** Receives this mux's resource events at pipelines without a registered owner. */
  readonly recorder?: ProfileRecorder<"memory">;
  /**
   * Attributes `owner`'s pipelines to `recorder()`, resolved at each pipeline's first event and
   * kept until it finishes. A later registration affects only later pipelines.
   */
  registerRecorderOwner(
    owner: string,
    recorder: () => ProfileRecorder<"memory"> | undefined,
  ): void;
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
       * Receives each monitor event of this mux's pipelines. Requires `resources.monitorIntervalMs`
       * unless `recorder` or `measureMemory` supplies the default. A throw is reported by
       * `release()`, which resolves only after the last event returned.
       */
      readonly onResourceEvent?: (event: NativeResourceEvent) => void;
      /** Enable per-command memory peak reporting (Linux cgroup v2 with delegated controllers). */
      readonly measureMemory?: boolean;
      /**
       * Receives every resource event as well, beside `onResourceEvent`; enables monitoring at
       * `resources.monitorIntervalMs` (default 1000).
       */
      readonly recorder?: ProfileRecorder<"memory">;
    } = {},
  ): Promise<ShellMuxLease> {
    const { policy = LockPolicy, sandbox = "shared", recorder } = options;
    const owners = new Map<
      string,
      () => ProfileRecorder<"memory"> | undefined
    >();
    let onResourceEvent = options.onResourceEvent;
    let resources = options.resources;
    if (options.measureMemory || recorder !== undefined)
      resources = {
        ...resources,
        monitorIntervalMs: resources?.monitorIntervalMs ?? 1000,
      };
    if (recorder !== undefined) {
      // Opaque: pipeline IDs are unique only within this lease.
      const source = {};
      // `owner\0pipelineId` → the view its first event resolved, until it finishes.
      const pins = new Map<string, ProfileRecorder<"memory">>();
      const caller = onResourceEvent;
      onResourceEvent = (event) => {
        let failure: { error: unknown } | undefined;
        try {
          const key = `${event.owner ?? ""}\0${event.pipelineId}`;
          let view = pins.get(key);
          if (view === undefined) {
            view =
              (event.owner === undefined
                ? undefined
                : owners.get(event.owner)?.()) ?? recorder;
            pins.set(key, view);
          }
          if (event.kind === "finished") pins.delete(key);
          view.record({ resource: "memory", kind: "resource", source, event });
        } catch (error) {
          failure = { error };
        }
        if (caller !== undefined) {
          try {
            caller(event);
          } catch (error) {
            if (failure === undefined) throw error;
            throw new AggregateError(
              [failure.error, error],
              "ShellMuxLease: recorder and onResourceEvent failed",
              { cause: failure.error },
            );
          }
        }
        if (failure !== undefined) throw failure.error;
      };
    }
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
        policyDebug: level <= LogLevel.DEBUG,
        resources,
        ...(options.measureMemory ? { measureMemory: true } : {}),
      },
      level <= LogLevel.INFO ? logPolicyDecision : undefined,
      onResourceEvent === undefined
        ? undefined
        : (error: Error | null, event: NativeResourceEvent) => {
            if (error !== null) throw error;
            onResourceEvent(event);
          },
    );
    let released: Promise<void> | undefined;
    const lease: ShellMuxLease = {
      mux,
      native,
      policy,
      recorder,
      registerRecorderOwner(owner, recorder) {
        owners.set(owner, recorder);
      },
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
