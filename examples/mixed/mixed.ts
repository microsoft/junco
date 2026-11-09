// # Mixed workflow: one agent against a nested graph
//
// mixed.yml declares the competitors and their joined Reviewer; this module supplies LADDER, Ralph's rounds and raw-draft validation.
// Goals sends the same assignment to both competitors; only Ralph's final draft reaches Reviewer.
// Install workspace dependencies, then run after `pi` → `/login` → GitHub Copilot:
//
//   bun run examples/mixed/mixed.ts
//
// The exports exist for the offline tests in test/mixed.test.ts.

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, JuncoGraph, schedules, syntax, tracer } from "junco";
import { problemRecorder, runCli, type YamlExecution } from "../support.ts";
import source from "./mixed.yml" with { type: "text" };

const LADDER = schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" });

const document = syntax.parse(source);
export const goalsPrompt = (document.graph.nodes.Goals as Extract<syntax.NodeSpec, { kind: "emit" }>).text;

/** Build the mixed graph and identify its final Reviewer. */
export interface MixedGraph {
  execution: YamlExecution;
  reviewerId: graph.NodeIdType;
}

export const MixedGraph = {
  async create(options: Pick<syntax.BuildOptions, "createAgent" | "tracer" | "ladder" | "recorder">): Promise<MixedGraph> {
    const reviewerId = graph.NodeId.create("Reviewer");
    const ralph = schedules.ralph({ rounds: 2 });
    const execution = await JuncoGraph.fromYaml(source, {
      cwd: process.cwd(),
      scheduler: () => schedules.parallel(),
      ...ralph,
      available: {
        ...ralph.available,
        Reviewer: ({ graph: workflow }) => (view, triggered) => {
          // Validate the raw draft without copying it into the staged prompt.
          if (triggered)
            for (const draft of view.messages.get(graph.EdgeId.create("Ralph~>Reviewer")) ?? [])
              syntax.finalText(draft, "Ralph~>Reviewer");
          return triggered || workflow.getNode(reviewerId)?.status === "running";
        },
      },
      ...options,
    });
    return { execution, reviewerId };
  },
};

async function main(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const models = await ModelRuntime.create();
  signal?.throwIfAborted();
  let review: string;
  {
    // LIFO: close the graph, finish the TUI it shares with the nested Ralph graph, then close the recorder.
    await using lifetime = new AsyncDisposableStack();
    const recorder = lifetime.adopt(await problemRecorder(process.cwd()), (owned) => owned.close());
    const observer = tracer.TuiTracer.shared();
    const { execution, reviewerId } = await MixedGraph.create({ ladder: new schedules.ModelLadder(models, LADDER), recorder, tracer: observer });
    lifetime.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
    lifetime.adopt(execution.graph, (graph) => graph.close());
    signal?.throwIfAborted();
    const results = await execution.run({ signal });
    signal?.throwIfAborted();
    review = syntax.finalText(results.get(reviewerId), "Reviewer");
  }
  console.log(`Final review:\n${review}`);
}

if (import.meta.main) await runCli(main);
