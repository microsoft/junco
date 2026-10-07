import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { NativeMux, NativeRun } from "../native/index.js";
import type { ToolCollectionOptions } from "./collection.js";
import type { NativeModule } from "./native.js";
import { acquireShellMux, type ShellMuxLease } from "./shell-mux.js";

/** Bash operations on one ShellMux; closing stops only this owner's commands. */
export type ShellMuxOperations = BashOperations & { close(): Promise<void> };

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
 * A principal names and orders one agent's commands; it is not a policy identity. Every
 * command runs in a fresh marsh shell with an opaque owner, so no grant carries over between
 * commands. A supplied `mux` is borrowed and never closed; an explicit `policy`/`sandbox` must
 * match it. Without one, the first command opens an owned mux (`policy` defaults to
 * `"GitPolicy"`), which `close()` closes after aborting and draining this owner's commands.
 * ShellMux snapshots are not OS confinement. Cancellation waits for owned cleanup and
 * can be delayed by external commands racing the backend's stop scan.
 */
export function createShellMuxOperations(options?: {
  readonly native?: NativeModule;
  readonly mux?: NativeMux;
  readonly sandbox?: "shared" | "always";
  readonly policy?: ToolCollectionOptions["policy"];
  principal?: string;
}): ShellMuxOperations {
  const borrowed = options?.mux;
  if (borrowed !== undefined) {
    if (options?.native === undefined) {
      throw new Error(
        "createShellMuxOperations: a mux requires the native module that created it",
      );
    }
    if (options.policy !== undefined && options.policy !== borrowed.policy) {
      throw new Error(
        `createShellMuxOperations: policy "${options.policy}" conflicts with the mux's "${borrowed.policy}"`,
      );
    }
    if (options.sandbox !== undefined && options.sandbox !== borrowed.sandbox) {
      throw new Error(
        `createShellMuxOperations: sandbox "${options.sandbox}" conflicts with the mux's "${borrowed.sandbox}"`,
      );
    }
  }
  const principal = options?.principal ?? `pi-${randomUUID()}`;
  const acquisition = {
    native: options?.native,
    sandbox: options?.sandbox,
    policy: options?.policy ?? "GitPolicy",
  } as const;
  let mux: NativeMux | undefined;
  let owned: ShellMuxLease | undefined;
  let acquiring: Promise<NativeMux> | undefined;
  let closing: Promise<void> | undefined;
  const runs = new Set<NativeRun>();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    const settled = () => pending.delete(promise);
    promise.then(settled, settled);
    return promise;
  };
  const closedError = () => new Error("ShellMux session is closed");

  // Tracked before it is awaited, so close() drains an in-flight open and releases what it
  // produced; a rejected attempt is cleared so later calls retry.
  const acquire = (cwd: string): Promise<NativeMux> => {
    if (mux !== undefined) return Promise.resolve(mux);
    if (acquiring === undefined) {
      const attempt = track(
        (async () => {
          if (borrowed !== undefined) {
            await borrowed.validateCwd(cwd);
            if (closing !== undefined) throw closedError();
            mux = borrowed;
            return borrowed;
          }
          const lease = await acquireShellMux(cwd, acquisition);
          if (closing !== undefined) {
            await lease.release();
            throw closedError();
          }
          owned = lease;
          mux = lease.mux;
          return lease.mux;
        })(),
      );
      acquiring = attempt;
      attempt.catch(() => {
        if (acquiring === attempt) acquiring = undefined;
      });
    }
    return acquiring;
  };

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      if (closing !== undefined) throw closedError();

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
          if (closing !== undefined) throw closedError();

          const mux = await beforeStart(acquire(cwd));
          if (signal?.aborted) throw new Error("aborted");
          if (closing !== undefined) throw closedError();
          const environment = Object.fromEntries(
            Object.entries(env ?? process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          );
          const started = mux.start(
            { command, cwd, principal, env: environment, timeoutMs },
            (error, data) => {
              if (error) throw error;
              onData(data);
            },
          );
          run = started;
          runs.add(started);
          try {
            // Do not race wait() against abort: the native result is the cleanup/output fence.
            const result = await started.wait();
            if (signal?.aborted || result.cancelled) throw new Error("aborted");
            if (result.timedOut) throw new Error(`timeout:${timeout}`);
            return { exitCode: result.exitCode ?? null };
          } finally {
            runs.delete(started);
          }
        } catch (error) {
          if (signal?.aborted) throw new Error("aborted");
          throw error;
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      })();
      return track(execution);
    },

    close() {
      closing ??= (async () => {
        for (const run of runs) run.abort();
        await Promise.allSettled([...pending]);
        await owned?.release();
      })();
      return closing;
    },
  };
}
