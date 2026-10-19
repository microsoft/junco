// # Mixed workflow: one agent against a nested graph
//
// mixed.yml declares Goals, Direct, the two-round Ralph workflow (a nested `Ralph -> Ralph` loop driven by `schedules.ralph`), and their joined Reviewer.
// Goals sends the same assignment to both competitors; only Ralph's final draft reaches Reviewer.
// Install workspace dependencies, then run after `pi` → `/login` → GitHub Copilot:
//
//   bun run examples/mixed/mixed.ts
//
// The exports exist for the offline tests in test/mixed.test.ts.

import { fileURLToPath } from "node:url";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, schedules } from "junco-agency";
import { build, parse, type BuildOptions } from "junco-syntax";
import { ctrlC } from "../cancellation/cancellation.ts";
import source from "./mixed.yml" with { type: "text" };

const document = parse(source);
document.code = { Goals: fileURLToPath(new URL("./code.js", import.meta.url)) };

/** A member's answer counts only when its run finished normally with text. */
export function finalText(message: AssistantMessage | undefined, member: string): string {
  if (message?.stopReason !== "stop") {
    throw new Error(`${member} did not finish normally: ${message?.stopReason ?? "no final message"}`);
  }
  const text = contentText(message.content).trim();
  if (!text) throw new Error(`${member} produced an empty report`);
  return text;
}

/** Build the mixed graph and identify its final Reviewer. */
export interface MixedGraph {
  execution: Awaited<ReturnType<typeof build>>;
  reviewerId: graph.NodeIdType;
}

export const MixedGraph = {
  async create(options: Pick<BuildOptions, "createAgent" | "tracer" | "models">): Promise<MixedGraph> {
    const execution = await build(document, {
      cwd: process.cwd(),
      scheduler: () => schedules.parallel(),
      ...schedules.ralph({ rounds: 2 }),
      ...options,
    });
    return { execution, reviewerId: graph.NodeId.create("Reviewer") };
  },
};

async function main(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const models = await ModelRuntime.create();
  signal?.throwIfAborted();
  const { execution, reviewerId } = await MixedGraph.create({ models });
  let review: string;
  try {
    signal?.throwIfAborted();
    const results = await execution.run({ signal });
    signal?.throwIfAborted();
    review = finalText(results.get(reviewerId), "Reviewer");
  } finally {
    // Both graphs share the automatically selected tracer: flush it even when close fails.
    try {
      await execution.graph.close();
    } finally {
      await execution.graph.tracer.flush();
    }
  }
  console.log(`Final review:\n${review}`);
}

if (import.meta.main) {
  using cancellation = ctrlC();
  try {
    await main(cancellation.signal);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = cancellation.signal.aborted ? 130 : 1;
  }
  if (cancellation.signal.aborted) process.exitCode = 130;
}
