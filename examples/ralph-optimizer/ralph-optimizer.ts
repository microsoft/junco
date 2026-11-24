// # Ralph sort optimizer
//
// Install workspace dependencies and cc; use a Btrfs checkout for the collection tools.
// Log in with `pi` → `/login` → GitHub Copilot, then run:
//   bun run examples/ralph-optimizer/ralph-optimizer.ts
// Every round is measured by the runner; only passing, strictly faster edits stay.
// No round cap: Ctrl-C exits 130 and restores the last accepted sort.c.
// shortcut: synchronous compile/run blocks cancellation for seconds; use async measurement if responsiveness matters.
// The example edits sort.c in place; restore the committed file to restart from bubble sort.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, JuncoGraph, schedules, tracer } from "junco";
import { log } from "junco-tools/log";
import { runCli } from "../support.ts";
import source from "./ralph-optimizer.yml" with { type: "text" };

// Verified 2026-11-08: refreshed Pi catalog, saved Copilot OAuth and https://docs.github.com/en/copilot/reference/ai-models/supported-models.
const LADDER = schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" });
const DIR = import.meta.dir;
const SOURCE = join(DIR, "sort.c");
const BINARY = join(DIR, "sort");
const BUILD = "cc -O2 -Wall -o sort sort.c";

/** Compile sort.c and measure only sort(), rejecting failed builds or tests. */
export function measure(): { ms: number } | { failure: string } {
  const build = spawnSync("cc", ["-O2", "-Wall", "-o", BINARY, SOURCE], { encoding: "utf8" });
  if (build.error || build.status !== 0) return { failure: build.stderr.trim() || build.error?.message || `cc exited ${build.status}` };
  const run = spawnSync(BINARY, [], { encoding: "utf8", timeout: 120_000 });
  const match = /^PASS (\d+(?:\.\d+)?)$/m.exec(run.stdout);
  if (run.status === 0 && match) return { ms: Number(match[1]) };
  return { failure: (run.stdout + run.stderr).trim() || `sort exited ${run.status}` };
}

async function main(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let best = { source: readFileSync(SOURCE, "utf8"), ms: 0 };
  const baseline = measure();
  if ("failure" in baseline) throw new Error(`committed sort.c must pass its tests: ${baseline.failure}`);
  best.ms = baseline.ms;
  const until: schedules.RalphPredicate = (_result, { round }) => {
    const outcome = measure();
    if ("ms" in outcome && outcome.ms < best.ms) {
      best = { source: readFileSync(SOURCE, "utf8"), ms: outcome.ms };
      log.info(`round ${round}: kept, ${outcome.ms} ms`);
    } else {
      writeFileSync(SOURCE, best.source);
      log.info(`round ${round}: reverted (${"ms" in outcome ? `${outcome.ms} ms, best ${best.ms} ms` : outcome.failure})`);
    }
    return false;
  };
  const models = await ModelRuntime.create();
  try {
    await using lifetime = new AsyncDisposableStack();
    const observer = tracer.TuiTracer.shared();
    lifetime.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
    const execution = await JuncoGraph.fromYaml(source, {
      args: { cwd: DIR, tracer: observer, signal, ...schedules.ralph({ until }) },
      parameters: { scheduler: () => schedules.parallel(), ladder: new schedules.ModelLadder(models, LADDER) },
    });
    lifetime.adopt(execution.graph, (g) => g.close());
    const ASSIGNMENT = `Make \`sort\` in ${SOURCE} faster. Build and test with exactly: \`${BUILD} && ./sort\` (run from ${DIR}). It currently prints PASS ${baseline.ms} ms; every test must keep passing.`;
    execution.graph.source.enqueue({
      messages: new Map([[graph.EdgeId.create("assignment"), [graph.nodes.Task.create({ kind: "prompt", text: ASSIGNMENT, spec: `\`${BUILD} && ./sort\` prints PASS in under ${baseline.ms} ms.` })]]]),
      values: new Map(),
    });
    await execution.run({ signal });
  } finally {
    if (readFileSync(SOURCE, "utf8") !== best.source) writeFileSync(SOURCE, best.source);
    console.log(`best: ${best.ms} ms (baseline ${baseline.ms} ms)`);
  }
}

if (import.meta.main) await runCli(main);
