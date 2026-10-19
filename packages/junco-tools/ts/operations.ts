import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type {
  NativeMux,
  NativeResourceEvent,
  NativeResourceOptions,
  NativeRun,
} from "../native/index.js";
import type { NativeModule } from "./native.js";
import type { Policy } from "./policy.js";
import { ShellMuxLease } from "./shell-mux.js";

const closedError = () => new Error("ShellMux session is closed");

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const milliseconds = timeout * 1000;
  if (milliseconds > 2_147_483_647) {
    throw new Error("Invalid timeout: maximum is 2147483.647 seconds");
  }
  return milliseconds;
}

/**
 * Bash operations on one ShellMux; closing stops only this owner's commands.
 *
 * A principal names and orders one agent's commands; it is not a policy identity. Commands act
 * as the mux's policy owner: a supplied `mux` is borrowed, with whatever owner and policy it
 * carries, and never closed; it takes no `policy`, and an explicit `sandbox` must match it.
 * Without one, the first command opens an owned mux (`policy` default `LockPolicy`) bound to one
 * fresh owner every later command shares, which `close()` closes after aborting and draining
 * this owner's commands.
 * ShellMux snapshots are not OS confinement. Cancellation waits for owned cleanup and
 * can be delayed by external commands racing the backend's stop scan.
 */
export class ShellMuxOperations implements BashOperations {
  readonly #borrowed: NativeMux | undefined;
  readonly #principal: string;
  readonly #acquisition: {
    readonly native?: NativeModule;
    readonly sandbox?: "shared" | "always";
    readonly policy?: Policy;
    readonly resources?: NativeResourceOptions;
    readonly onResourceEvent?: (event: NativeResourceEvent) => void;
  };
  #mux: NativeMux | undefined;
  #owned: ShellMuxLease | undefined;
  #acquiring: Promise<NativeMux> | undefined;
  #closing: Promise<void> | undefined;
  readonly #runs = new Set<NativeRun>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options?: {
    readonly native?: NativeModule;
    readonly mux?: NativeMux;
    readonly sandbox?: "shared" | "always";
    readonly policy?: Policy;
    readonly resources?: NativeResourceOptions;
    readonly onResourceEvent?: (event: NativeResourceEvent) => void;
    principal?: string;
  }) {
    const borrowed = options?.mux;
    if (borrowed !== undefined) {
      if (options?.native === undefined) {
        throw new Error(
          "ShellMuxOperations: a mux requires the native module that created it",
        );
      }
      if (options.policy !== undefined) {
        throw new Error(
          "ShellMuxOperations: a borrowed mux keeps the policy it was opened with",
        );
      }
      if (
        options.resources !== undefined ||
        options.onResourceEvent !== undefined
      ) {
        throw new Error(
          "ShellMuxOperations: a borrowed mux keeps the resources it was opened with",
        );
      }
      if (
        options.sandbox !== undefined &&
        options.sandbox !== borrowed.sandbox
      ) {
        throw new Error(
          `ShellMuxOperations: sandbox "${options.sandbox}" conflicts with the mux's "${borrowed.sandbox}"`,
        );
      }
    }
    this.#borrowed = borrowed;
    this.#principal = options?.principal ?? `pi-${randomUUID()}`;
    this.#acquisition = {
      native: options?.native,
      sandbox: options?.sandbox,
      policy: options?.policy,
      resources: options?.resources,
      onResourceEvent: options?.onResourceEvent,
    };
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    const settled = () => this.#pending.delete(promise);
    promise.then(settled, settled);
    return promise;
  }

  // Tracked before it is awaited, so close() drains an in-flight open and releases what it
  // produced; a rejected attempt is cleared so later calls retry.
  #acquire(cwd: string): Promise<NativeMux> {
    if (this.#mux !== undefined) return Promise.resolve(this.#mux);
    if (this.#acquiring === undefined) {
      const borrowed = this.#borrowed;
      const attempt = this.#track(
        (async () => {
          if (borrowed !== undefined) {
            await borrowed.validateCwd(cwd);
            if (this.#closing !== undefined) throw closedError();
            this.#mux = borrowed;
            return borrowed;
          }
          const lease = await ShellMuxLease.create(cwd, this.#acquisition);
          if (this.#closing !== undefined) {
            await lease.release();
            throw closedError();
          }
          this.#owned = lease;
          this.#mux = lease.mux.forkOwner();
          return this.#mux;
        })(),
      );
      this.#acquiring = attempt;
      attempt.catch(() => {
        if (this.#acquiring === attempt) this.#acquiring = undefined;
      });
    }
    return this.#acquiring;
  }

  /** An own bound function, so detached upstream invocation works. */
  readonly exec: BashOperations["exec"] = async (
    command,
    cwd,
    { onData, signal, timeout, env },
  ) => {
    const timeoutMs = resolveTimeoutMs(timeout);
    if (signal?.aborted) throw new Error("aborted");
    if (this.#closing !== undefined) throw closedError();

    let run: NativeRun | undefined;
    let notifyAbort: (() => void) | undefined;
    const cancellation = signal
      ? new Promise<void>((resolve) => {
          notifyAbort = resolve;
        })
      : undefined;
    const onAbort = () => {
      notifyAbort?.();
      run?.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const beforeStart = <T>(promise: Promise<T>): Promise<T> =>
      cancellation
        ? Promise.race([
            promise,
            cancellation.then(() => {
              throw new Error("aborted");
            }),
          ])
        : promise;

    const execution = (async () => {
      try {
        let directory: Stats;
        try {
          directory = await beforeStart(stat(cwd));
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            throw new Error(
              `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
            );
          }
          throw error;
        }
        if (!directory.isDirectory())
          throw new Error(`Working directory is not a directory: ${cwd}`);
        if (signal?.aborted) throw new Error("aborted");
        if (this.#closing !== undefined) throw closedError();

        const mux = await beforeStart(this.#acquire(cwd));
        if (signal?.aborted) throw new Error("aborted");
        if (this.#closing !== undefined) throw closedError();
        const environment = Object.fromEntries(
          Object.entries(env ?? process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const started = mux.start(
          {
            command,
            cwd,
            principal: this.#principal,
            env: environment,
            timeoutMs,
          },
          (error, data) => {
            if (error) throw error;
            onData(data);
          },
        );
        run = started;
        this.#runs.add(started);
        try {
          // Do not race wait() against abort: the native result is the cleanup/output fence.
          const result = await started.wait();
          if (signal?.aborted || result.cancelled) throw new Error("aborted");
          if (result.timedOut) throw new Error(`timeout:${timeout}`);
          return { exitCode: result.exitCode ?? null };
        } finally {
          this.#runs.delete(started);
        }
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    })();
    return this.#track(execution);
  };

  close(): Promise<void> {
    this.#closing ??= (async () => {
      for (const run of this.#runs) run.abort();
      await Promise.allSettled([...this.#pending]);
      await this.#owned?.release();
    })();
    return this.#closing;
  }
}
