import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { NativeMux, NativeRun } from "../native/index.js";

interface Owner {
  disposed: boolean;
  opening?: Promise<NativeMux>;
}

// Teardown ownership only: this is deliberately not a seed lookup or lease pool.
const owners = new Set<Owner>();

function openOwnedMux(owner: Owner, cwd: string): Promise<NativeMux> {
  if (!owner.opening) {
    const opening = import("../native/index.js").then(({ NativeMux }) => NativeMux.open(cwd));
    owner.opening = opening;
    void opening.catch(() => {
      if (owner.opening === opening) owner.opening = undefined;
    });
  }
  return owner.opening;
}

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
 * commands. Share one explicit mux when several operations instances intentionally share a
 * seed; borrowed muxes remain caller-owned.
 * ShellMux snapshots are not OS confinement. Cancellation waits for owned cleanup and
 * can be delayed by external commands racing the backend's stop scan.
 */
export function createShellMuxOperations(options?: {
  principal?: string;
  mux?: NativeMux;
}): BashOperations {
  const principal = options?.principal ?? `pi-${randomUUID()}`;
  const borrowedMux = options?.mux;
  const owner: Owner | undefined = borrowedMux ? undefined : { disposed: false };
  if (owner) owners.add(owner);

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      if (owner?.disposed) throw new Error("ShellMux session is closed");

      let run: NativeRun | undefined;
      let notifyAbort: (() => void) | undefined;
      const cancellation = signal
        ? new Promise<void>((resolve) => { notifyAbort = resolve; })
        : undefined;
      const onAbort = () => {
        notifyAbort?.();
        run?.abort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const beforeStart = <T>(promise: Promise<T>): Promise<T> => cancellation
        ? Promise.race([promise, cancellation.then(() => { throw new Error("aborted"); })])
        : promise;

      try {
        let directory;
        try {
          directory = await beforeStart(stat(cwd));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
          }
          throw error;
        }
        if (!directory.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
        if (signal?.aborted) throw new Error("aborted");
        if (owner?.disposed) throw new Error("ShellMux session is closed");

        // Assign the owner's opening promise before awaiting it, so an aborted caller leaves
        // the eventual native session owned by shutdown instead of orphaning it.
        const mux = borrowedMux ?? await beforeStart(openOwnedMux(owner!, cwd));
        if (signal?.aborted) throw new Error("aborted");
        if (owner?.disposed) throw new Error("ShellMux session is closed");
        const environment = Object.fromEntries(
          Object.entries(env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        run = mux.start({ command, cwd, principal, env: environment, timeoutMs }, (error, data) => {
          if (error) throw error;
          onData(data);
        });
        // Do not race wait() against abort: the native result is the cleanup/output fence.
        const result = await run.wait();
        if (signal?.aborted || result.cancelled) throw new Error("aborted");
        if (result.timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: result.exitCode ?? null };
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Dispose default owners, including pending opens. Borrowed muxes remain caller-owned. */
export async function shutdownShellMux(): Promise<void> {
  const closing = [...owners];
  for (const owner of closing) owner.disposed = true;
  const results = await Promise.allSettled(closing.map(async (owner) => {
    try {
      if (!owner.opening) return;
      let mux: NativeMux;
      try {
        mux = await owner.opening;
      } catch {
        // Failed opens hold no lease; their original exec caller receives that error.
        return;
      }
      await mux.close();
    } finally {
      owners.delete(owner);
    }
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "ShellMux shutdown failed");
}
