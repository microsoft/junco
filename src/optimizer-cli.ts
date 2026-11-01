#!/usr/bin/env bun
// `junco-profile-optimizer <request.json>`: run `schedules.runOptimizer` on one prepared request,
// print a JSON summary and exit 0 converged, 2 budget/blocked, 1 failed or invalid input, 130/143
// on SIGINT/SIGTERM. Relative request paths resolve against the request file's directory.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  checkRequest,
  type OptimizationRequest,
  type OptimizationState,
  runOptimizer,
} from "./std/schedules/optimizer.js";

const EXIT: Record<NonNullable<OptimizationState["stop"]>["kind"], number> = {
  converged: 0,
  budget: 2,
  blocked: 2,
  failed: 1,
  cancelled: 130,
};
const SIGNALS = { SIGINT: 130, SIGTERM: 143 } as const;
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function main(args: readonly string[]): Promise<number> {
  const [path, ...extra] = args;
  if (path === undefined || extra.length > 0) {
    console.error("Usage: junco-profile-optimizer <request.json>");
    return 1;
  }
  const file = resolve(path);
  let request: OptimizationRequest;
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    checkRequest(value);
    const base = dirname(file);
    request = {
      ...value,
      target: {
        ...value.target,
        yaml: resolve(base, value.target.yaml),
        ts: resolve(base, value.target.ts),
        cwd: resolve(base, value.target.cwd),
      },
      sessionDir: resolve(base, value.sessionDir),
    };
  } catch (error) {
    console.error(`invalid request ${file}: ${describe(error)}`);
    return 1;
  }
  const controller = new AbortController();
  let received: keyof typeof SIGNALS | undefined;
  const handlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      received ??= signal;
      controller.abort(
        new DOMException(`Interrupted by ${signal}`, "AbortError"),
      );
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  let state: OptimizationState;
  try {
    state = await runOptimizer(request, { signal: controller.signal });
  } catch (error) {
    console.error(describe(error));
    return received === undefined ? 1 : SIGNALS[received];
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  const runs = state.history.flatMap((item) =>
    item.kind === "trial" ? item.runs : [],
  );
  console.log(
    JSON.stringify({
      stop: state.stop,
      sessionDir: request.sessionDir,
      baselineScore: state.baselineScore,
      incumbentScore: state.anchor.score,
      runCount: runs.length,
      statePath: join(request.sessionDir, "state.json"),
      scoresPath: join(request.sessionDir, "scores.jsonl"),
      profilePaths: runs.map((run) => join(run.directory, "samples.jsonl")),
    }),
  );
  if (received !== undefined) return SIGNALS[received];
  return state.stop === null ? 1 : EXIT[state.stop.kind];
}

process.exitCode = await main(process.argv.slice(2));
