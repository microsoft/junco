import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { EdgeId } from "dataflow-engine";
import { type AgenticInput, Deterministic, graph as graphApi } from "junco-agency";
import type { DeterministicNode } from "junco-syntax";
import type { MemberId, Members, OssSearchTool } from "./oss-committee.ts";

export type SearchCounts = Pick<OssSearchTool, "searches" | "failures">;
export type RoundContext = {
  readonly request: string;
  readonly feedback?: string;
  readonly members: Members;
  readonly search: SearchCounts;
  readonly failuresBefore: number;
  architectStarted: boolean;
};

/** A member's report counts only when its run finished normally with text. */
export function finalText(message: AssistantMessage | undefined, member: MemberId): string {
  if (message?.stopReason !== "stop") {
    throw new Error(`${member} did not finish normally: ${message?.stopReason ?? "no final message"}`);
  }
  const text = contentText(message.content).trim();
  if (!text) throw new Error(`${member} produced an empty report`);
  return text;
}

const partialResearchId = EdgeId.create("Librarian~>DesignAssignment");
const researchId = EdgeId.create("Librarian->DesignAssignment");
const reducerResearchId = EdgeId.create("Librarian->ReviewAssignment");
const designId = EdgeId.create("Architect->ReviewAssignment");

/** Prepare the first assignment at execution time, without starting or replacing any member. */
export const ResearchAssignment: DeterministicNode<RoundContext> = {
  create({ context, edges, policy }) {
    let published = false;
    return {
      state: new Deterministic<AgenticInput, AssistantMessage>(async function* () {
        const { request, feedback } = context;
        const text = `Original request:\n${request}\n\n${feedback === undefined ? "" : `Review feedback:\n${feedback}\n\n`}` +
          (feedback === undefined
            ? "Search public GitHub repositories using only generic technical terms, then report the available evidence and any research gaps."
            : "Continue investigating with new search_oss lookups using only generic technical terms, then report the updated evidence and any remaining research gaps.");
        published = true;
        // Like a YAML emit node, publish once and park; assignments are messages, not fake reports.
        while (true) yield [graphApi.Message.create(edges.get("ResearchAssignment~>Librarian")!, { kind: "prompt", text })];
      }, policy),
      is_available: (_view, triggered) => triggered && !published,
    };
  },
};

/** Admit either exactly one partial prompt or a valid, normally completed research report. */
export const DesignAssignment: DeterministicNode<RoundContext> = {
  create({ context, edges, policy }) {
    let published = false;
    return {
      state: new Deterministic<AgenticInput, AssistantMessage>(async function* () {
        const inputs = yield [];
        const partial = inputs.messages.get(partialResearchId);
        let report: string;
        if (partial !== undefined) {
          const [snapshot, ...extra] = partial;
          if (snapshot?.kind !== "prompt" || extra.length > 0)
            throw new Error("Librarian must send exactly one partial research prompt");
          report = `Partial research: a GitHub lookup failed and the Librarian is paused.\n${snapshot.text}`;
        } else {
          if (context.search.failures() > context.failuresBefore)
            throw new Error("Librarian must send its partial research after a failed GitHub lookup");
          if (context.search.searches() === 0)
            throw new Error("Librarian did not complete a valid GitHub OSS search");
          report = finalText(inputs.values.get(researchId), "Librarian");
        }
        context.architectStarted = true;
        const text = `Original request:\n${context.request}\n\n${context.feedback === undefined ? "" : `Review feedback:\n${context.feedback}\n\n`}Librarian report:\n${report}`;
        published = true;
        while (true) yield [graphApi.Message.create(edges.get("DesignAssignment~>Architect")!, { kind: "prompt", text })];
      }, policy),
      is_available: (_view, triggered) => triggered && !published,
      contract: (edgeId) => ({
        expect: edgeId === partialResearchId
          ? "Exactly one prompt carrying partial research: available evidence, the failed lookup/error, and remaining gaps, used to prepare the Architect's assignment."
          : "Normally completed, non-empty Librarian research after a valid OSS search and no unhanded failed lookup, used to prepare the Architect's assignment.",
      }),
    };
  },
};

/** Only the joined, validated final reports can prepare the Reducer's assignment. */
export const ReviewAssignment: DeterministicNode<RoundContext> = {
  create({ context, edges, policy }) {
    let published = false;
    return {
      state: new Deterministic<AgenticInput, AssistantMessage>(async function* () {
        const inputs = yield [];
        const text = `Original request:\n${context.request}\n\nLibrarian report:\n${finalText(inputs.values.get(reducerResearchId), "Librarian")}\n\nArchitect report:\n${finalText(inputs.values.get(designId), "Architect")}`;
        published = true;
        while (true) yield [graphApi.Message.create(edges.get("ReviewAssignment~>Reducer")!, { kind: "prompt", text })];
      }, policy),
      is_available: (_view, triggered) => triggered && !published,
      contract: (edgeId) => ({
        expect: edgeId === reducerResearchId
          ? "The Librarian's normally completed, non-empty closing report for the joined review."
          : "The Architect's normally completed, non-empty design report for the joined review.",
      }),
    };
  },
};
