import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { Deterministic, graph } from "junco-agency";
import type { DeterministicNode } from "junco-syntax";
import type {
  CandidateLane,
  CandidateOutcome,
  CheckedProposal,
  NoProposal,
  RefactorApplier,
  RefactorVerdict,
} from "./yak-shaver.ts";

export const CRITERIA = ["minimalAugmentation", "preservesExistingCallers", "semanticCoherence", "dependencyImprovement"] as const;

/** Every failed gate of a reviewed proposal: failed criteria, no new caller, or no net removal. */
export function gateFailures(proposal: CheckedProposal, verdict: RefactorVerdict): string[] {
  const failures = CRITERIA.filter((name) => !verdict[name].pass).map((name) => `${name} failed: ${verdict[name].evidence}`);
  if (proposal.metrics.addedCallerDefinitions <= 0) failures.push("no new caller definitions");
  if (proposal.metrics.netLinesRemoved <= 0) failures.push(`projected net nonblank lines removed is ${proposal.metrics.netLinesRemoved}`);
  return failures;
}

/** A member's answer counts only when its run finished normally with text. */
export function finalText(message: AssistantMessage | undefined, member: string): string {
  if (message?.stopReason !== "stop") {
    const detail = message?.errorMessage ? `: ${message.errorMessage}` : "";
    throw new Error(`${member} did not finish normally: ${message?.stopReason ?? "no final message"}${detail}`);
  }
  const text = contentText(message.content).trim();
  if (!text) throw new Error(`${member} produced an empty final message`);
  return text;
}

export type CandidateGraphLane = Omit<CandidateLane, "proposer" | "judge"> & {
  readonly proposerId: graph.NodeIdType;
  readonly judgeId: graph.NodeIdType;
};

type CandidateAnalysis =
  | { readonly proposal: NoProposal }
  | { readonly proposal: CheckedProposal; readonly verdict: RefactorVerdict };

/** Consume a ready lane's recorders; missing final messages or structured results are protocol errors. */
function completedAnalysis(
  lane: CandidateGraphLane,
  results: ReadonlyMap<graph.NodeIdType, AssistantMessage>,
): CandidateAnalysis {
  const rank = lane.work.rank;
  finalText(results.get(lane.proposerId), `Proposer:${rank}`);
  const recorded = lane.proposal.peek();
  if (recorded === undefined) throw new Error(`Proposer:${rank} finished without recording ${lane.proposal.tool.name}`);
  if (recorded.kind === "none") {
    if (results.has(lane.judgeId) || lane.verdict.takeVerdict() !== undefined) throw new Error(`Judge:${rank} ran for a no-proposal result`);
    lane.proposal.takeProposal();
    return { proposal: recorded };
  }
  finalText(results.get(lane.judgeId), `Judge:${rank}`);
  const verdict = lane.verdict.takeVerdict();
  if (verdict === undefined) throw new Error(`Judge:${rank} finished without recording ${lane.verdict.tool.name}`);
  lane.proposal.takeProposal();
  return { proposal: recorded, verdict };
}

export type FinalizeBatchContext = {
  readonly lanes: readonly CandidateGraphLane[];
  readonly outcomes: Map<number, CandidateOutcome>;
  readonly apply: RefactorApplier;
  readonly signal?: AbortSignal;
};

/** Finalize ready lanes in order, publishing each successful application before examining the next. */
export const FinalizeBatch: DeterministicNode<FinalizeBatchContext> = {
  create({ graph: workflow, policy, collection, context }) {
    const { lanes, outcomes, apply } = context;
    const last = lanes.reduce((last, lane) => lane.work.rank > last.work.rank ? lane : last);
    const ready = (lane: CandidateGraphLane, results: ReadonlyMap<graph.NodeIdType, AssistantMessage>): boolean => {
      if (outcomes.has(lane.work.rank)) return false;
      if (results.get(lane.proposerId) === undefined) return workflow.getNode(lane.proposerId)?.status === "done";
      return lane.proposal.peek()?.kind !== "proposal" || results.has(lane.judgeId) || workflow.getNode(lane.judgeId)?.status === "done";
    };
    return {
      is_available: (_view, triggered) => {
        if (!triggered) return false;
        const results = workflow.results();
        return lanes.some((lane) => ready(lane, results));
      },
      state: new Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* (nodeSignal) {
        const signal = context.signal === undefined ? nodeSignal : AbortSignal.any([nodeSignal, context.signal]);
        yield [];
        while (true) {
          signal.throwIfAborted();
          const results = workflow.results();
          for (const lane of lanes) {
            if (!ready(lane, results)) continue;
            const analysis = completedAnalysis(lane, results);
            const { rank, candidate } = lane.work;
            const base = { rank, candidateId: candidate.definition.id, depth: candidate.depth, callerCount: candidate.callerIds.length };
            if (!("verdict" in analysis)) {
              const { proposal } = analysis;
              outcomes.set(rank, { ...base, status: "no-proposal", proposal, reason: proposal.reason });
              continue;
            }
            const { proposal, verdict } = analysis;
            const failures = gateFailures(proposal, verdict);
            if (failures.length > 0) {
              outcomes.set(rank, { ...base, status: "rejected", proposal, verdict, reason: failures.join("; ") });
              continue;
            }
            signal.throwIfAborted();
            const files = await apply({ rank, candidate, proposal, verdict }, signal);
            outcomes.set(rank, {
              ...base,
              status: "applied",
              proposal,
              verdict,
              files,
              reason: `All four criteria passed; applied and released ${files.join(", ")}; +${proposal.metrics.addedCallerDefinitions} caller definitions, ${proposal.metrics.netLinesRemoved} projected net nonblank lines removed`,
            });
          }
          if (outcomes.size === lanes.length) return results.get(last.proposerId)!;
          yield [];
        }
      }, policy, collection),
    };
  },
};
