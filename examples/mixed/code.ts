import type { AssistantMessage } from "@earendil-works/pi-ai";
import { graph } from "junco-agency";
import type { DeterministicNode } from "junco-syntax";

export const goalsPrompt = "1. Explain what a dataflow graph is in two sentences.\n2. Give one concrete example that combines a single agent with a nested graph.\n3. Add one practical limitation of this design.";

/** Publish the assignment once on both competing branches. */
export const Goals: DeterministicNode = {
  create({ edges, policy }) {
    const outputs = ["Goals~>Direct", "Goals~>Ralph"].map((id) => edges.get(id)!);
    let published = false;
    return {
      state: new graph.nodes.Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* (signal) {
        while (true) {
          signal.throwIfAborted();
          published = true;
          yield outputs.map((edge) => graph.Message.create(edge, { kind: "prompt", text: goalsPrompt }));
        }
      }, policy),
      is_available: () => !published,
    };
  },
};
