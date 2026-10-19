import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { graph } from "junco-agency";
import type { DeterministicNode } from "junco-syntax";

/** Join both root branches, retaining the child's exact result after validating both reports. */
export const Join: DeterministicNode = {
  create({ policy }) {
    return {
      state: new graph.nodes.Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* () {
        const inputs = yield [];
        for (const id of ["0->Join", "1->Join"]) {
          const result = inputs.values.get(graph.EdgeId.create(id));
          if (result?.stopReason !== "stop" || !contentText(result.content).trim())
            throw new Error(`${id} did not produce a complete report`);
        }
        return inputs.values.get(graph.EdgeId.create("0->Join"))!;
      }, policy),
    };
  },
};
