import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { NativeMux, NativeRun } from "../native/index.js";
import type { NativeModule } from "./native.js";
import {
  acquireShellMuxFrom,
  currentShellMuxGeneration,
  type ShellMuxLease,
} from "./shell-mux.js";

/** Bash operations on the application's one ShellMux, closable without closing that mux. */
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
 * commands. Every operations owner runs on the application's one ShellMux, acquired on first
 * use from the generation current when this owner was created; `mux`/`native`/`sandbox` follow
 * {@link acquireShellMux}'s adoption rules. `close()` stops only this owner's commands and
 * releases its lease; {@link shutdownShellMux} alone closes the mux.
 * ShellMux snapshots are not OS confinement. Cancellation waits for owned cleanup and
 * can be delayed by external commands racing the backend's stop scan.
 */
export function createShellMuxOperations(options?: {
  readonly native?: NativeModule;
  readonly mux?: NativeMux;
  readonly sandbox?: "shared" | "always";
  principal?: string;
}): ShellMuxOperations {
  if (options?.mux !== undefined && options.native === undefined) {
    throw new Error(
      "createShellMuxOperations: a mux requires the native module that created it",
    );
  }
  const principal = options?.principal ?? `pi-${randomUUID()}`;
  const generation = currentShellMuxGeneration();
  const acquisition = {
    native: options?.native,
    mux: options?.mux,
    sandbox: options?.sandbox,
  };
  let lease: ShellMuxLease | undefined;
  let acquiring: Promise<ShellMuxLease> | undefined;
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

  // Assigned before it is awaited, so an aborted caller leaves the eventual lease owned by
  // close() instead of orphaning it; a rejected attempt is cleared so later calls retry on
  // the same, still-open generation.
  const acquire = (cwd: string): Promise<ShellMuxLease> => {
    if (lease !== undefined) {
      return lease.closed
        ? Promise.reject(closedError())
        : Promise.resolve(lease);
    }
    if (acquiring === undefined) {
      const attempt = track(
        acquireShellMuxFrom(generation, cwd, acquisition).then((acquired) => {
          if (closing !== undefined) {
            acquired.release();
            throw closedError();
          }
          lease = acquired;
          return acquired;
        }),
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
      if (closing !== undefined || lease?.closed) throw closedError();

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

          const { mux } = await beforeStart(acquire(cwd));
          if (signal?.aborted) throw new Error("aborted");
          if (closing !== undefined || lease?.closed) throw closedError();
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
        lease?.release();
      })();
      return closing;
    },
  };
}
