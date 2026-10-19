import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { graph } from "junco-agency";
import type { DeterministicNode } from "junco-syntax";

/** A member's answer counts only when its run finished normally with text. */
function finalText(message: AssistantMessage | undefined, member: string): string {
  if (message?.stopReason !== "stop") {
    const detail = message?.errorMessage ? `: ${message.errorMessage}` : "";
    throw new Error(`${member} did not finish normally: ${message?.stopReason ?? "no final message"}${detail}`);
  }
  const text = contentText(message.content).trim();
  if (!text) throw new Error(`${member} produced an empty report`);
  return text;
}

/** Validate both reports before publishing the dependency report as the graph result. */
export const Reports: DeterministicNode = {
  create({ policy }) {
    return {
      state: new graph.nodes.Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* () {
        const inputs = yield [];
        finalText(inputs.values.get(graph.EdgeId.create("Research->Reports")), "Research");
        const result = inputs.values.get(graph.EdgeId.create("Dependencies->Reports"));
        finalText(result, "Dependencies");
        return result!;
      }, policy),
    };
  },
};
