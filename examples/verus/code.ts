import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { graph } from "junco-agency";
import type { DeterministicNode } from "junco-syntax";
import type { VerusMembers, VerusRole } from "./verus.ts";

export type VerusRoundContext = {
  readonly assignment: string;
  readonly members: VerusMembers;
  readonly verification: { runs(): number };
  reviewerBaseline?: number;
};

/** Partial, abnormal, or blank predecessor output must never activate the next role. */
export function finalText(message: AssistantMessage | undefined, role: VerusRole): string {
  if (message?.stopReason !== "stop") throw new Error(`${role} did not finish normally: ${message?.stopReason ?? "no final message"}`);
  const text = contentText(message.content).trim();
  if (!text) throw new Error(`${role} produced an empty report`);
  return text;
}

/** Validate the translation and sample diagnostics before the persistent Reviewer starts. */
export const PrepareReviewer: DeterministicNode<VerusRoundContext> = {
  create({ policy, context }) {
    return {
      state: new graph.nodes.Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* (signal) {
        const inputs = yield [];
        signal.throwIfAborted();
        const message = inputs.values.get(graph.EdgeId.create("Verifier->PrepareReviewer"));
        const report = finalText(message, "Verifier");
        context.reviewerBaseline = context.verification.runs();
        context.members.Reviewer.stagePrompt(context.assignment + `Current Verifier report (evidence):\n${report}\n\nInspect the current output and call mcp__verus__lsp_diagnostics yourself this round. Report stronger specifications and smaller proofs, even if verification succeeds.`);
        return message!;
      }, policy),
    };
  },
};

/** Cleanup is admitted only after a complete review and fresh Reviewer diagnostics. */
export const PrepareCleanup: DeterministicNode<VerusRoundContext> = {
  create({ policy, context }) {
    return {
      state: new graph.nodes.Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* (signal) {
        const inputs = yield [];
        signal.throwIfAborted();
        const message = inputs.values.get(graph.EdgeId.create("Reviewer->PrepareCleanup"));
        const report = finalText(message, "Reviewer");
        if (context.reviewerBaseline === undefined || context.verification.runs() <= context.reviewerBaseline) {
          throw new Error("Reviewer did not obtain Verus MCP diagnostics in this round");
        }
        context.members.Cleanup.stagePrompt(context.assignment + `Current Reviewer report (evidence):\n${report}\n\nSimplify real source/proofs without weakening contracts. Check edits with Verus MCP diagnostics; retain unresolved stronger-spec recommendations for the next Verifier.`);
        return message!;
      }, policy),
    };
  },
};
