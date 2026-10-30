import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type Context,
  contentText,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DummyTracer } from "dataflow-engine";
import { JuncoAgent } from "junco-agent";
import { MARSH_POLICY_DENIED, SendTool, YieldTool } from "junco-tools";
import { Type } from "typebox";
import {
  convene,
  type MemberId,
  type Members,
  OssSearchTool,
  ReviewTool,
} from "../examples/oss-committee/oss-committee.ts";
import type { YamlAgent } from "../examples/support.ts";
import { userTexts } from "./deterministic-support.ts";
import { NATIVE_TOOL_BLOCK, scripted } from "./support.ts";

export const request = "Design a C# TUI for committee decision history.";

/** One round's scripted Reducer verdict; `"skip"` ends the round without calling `review`. */
export type ScriptedReview =
  | { readonly approved: boolean; readonly feedback: string }
  | "skip";

const approve: ScriptedReview = {
  approved: true,
  feedback: "Minimal, clean, and backed by well-trusted OSS.",
};

const defaultSearchResponse = () =>
  Response.json({
    incomplete_results: false,
    items: [
      {
        full_name: "tui-cs/Terminal.Gui",
        html_url: "https://github.com/tui-cs/Terminal.Gui",
        description: "Cross Platform Terminal UI toolkit for .NET",
        language: "C#",
        archived: false,
        license: { spdx_id: "MIT" },
        stargazers_count: 10_000,
        pushed_at: "2026-09-15T00:00:00Z",
      },
    ],
  });

/** The most recent user-facing message of a model request, including array-form Pi content. */
function latestUserText(context: Context): string {
  const text = userTexts(context.messages).at(-1);
  if (text === undefined)
    throw new Error("Scripted actor request has no user message");
  return text;
}

/** A Librarian tool whose only effect is a Marsh policy denial, which pauses the run. */
const guardedTool: AgentTool = {
  name: "guarded",
  label: "guarded",
  description: "A lookup the policy denies.",
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async () => {
    throw Object.assign(new Error("Policy denied the guarded lookup"), {
      code: MARSH_POLICY_DENIED,
    });
  },
};

/** Split only the graph's structured prompt; reports remain the actual delivered payloads. */
function reportsFromPrompt(text: string, labels: readonly string[]): string[] {
  const parts: string[] = [];
  let remaining = text;
  for (const label of labels) {
    const prefix = `${label}:\n`;
    if (!remaining.startsWith(prefix))
      throw new Error(`Missing ${label} in committee prompt`);
    remaining = remaining.slice(prefix.length);
    const nextLabel = labels[parts.length + 1];
    if (nextLabel === undefined) {
      parts.push(remaining);
    } else {
      const separator = `\n\n${nextLabel}:\n`;
      const boundary = remaining.indexOf(separator);
      if (boundary < 0)
        throw new Error(`Missing ${nextLabel} in committee prompt`);
      parts.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary + 2);
    }
  }
  return parts;
}

/**
 * Real search, review and graph tools with scripted members. Round r makes `lookups[r]` GitHub
 * lookups (default: one Terminal.Gui result) and ends with `reviews[r]`; `"skip"` omits the review
 * call. After a failed lookup the Librarian sends partial research on its declared edge
 * and yields; with `policyPauseBeforeSend` it is first paused by a policy denial.
 * Dispose it to close every member.
 */
export async function scriptedCommittee(
  script: {
    readonly lookups?: readonly (readonly Response[])[];
    readonly reviews?: readonly ScriptedReview[];
    readonly librarianStopReason?: "stop" | "length";
    readonly policyPauseBeforeSend?: boolean;
  } = {},
) {
  const reviews = script.reviews ?? [approve];
  const lookups = reviews.map(
    (_review, round) => script.lookups?.[round] ?? [defaultSearchResponse()],
  );
  const responses = lookups.flat();
  const librarianStopReason = script.librarianStopReason ?? "stop";
  const searchQueries: string[] = [];
  const search = new OssSearchTool(
    Object.assign(
      async (url: Parameters<typeof fetch>[0]) => {
        const response = responses[searchQueries.length];
        searchQueries.push(
          new URL(url instanceof Request ? url.url : url).searchParams.get(
            "q",
          ) ?? "",
        );
        if (response === undefined)
          throw new Error("No scripted GitHub response remains");
        return response.clone();
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const review = new ReviewTool();
  const memberInputs: Record<MemberId, string[]> = {
    Librarian: [],
    Architect: [],
    Reducer: [],
  };
  const modelRequests: MemberId[] = [];

  let librarianRound = -1;
  let librarianLookups = 0;
  let librarianReport = "";
  const sendPartialResearch = () =>
    fauxAssistantMessage(
      [
        fauxToolCall(
          "send",
          {
            id: "Librarian~>DesignAssignment",
            payload: { kind: "prompt", text: librarianReport },
          },
          { id: `librarian-send-${librarianRound + 1}` },
        ),
      ],
      { stopReason: "toolUse" },
    );
  const librarian: FauxResponseFactory = (context) => {
    modelRequests.push("Librarian");
    const last = context.messages.at(-1);
    if (last?.role === "toolResult" && last.toolName === "yield") {
      return fauxAssistantMessage(
        librarianStopReason === "length"
          ? librarianReport.slice(0, 4)
          : librarianReport,
        {
          stopReason: librarianStopReason,
        },
      );
    }
    if (last?.role === "toolResult" && last.toolName === "guarded") {
      return sendPartialResearch();
    }
    if (last?.role === "toolResult" && last.toolName === "send") {
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "yield",
            {
              reason: "Waiting for the Architect to use the partial research.",
            },
            { id: `librarian-yield-${librarianRound + 1}` },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }
    if (last?.role === "user") {
      librarianRound++;
      librarianLookups = 0;
      memberInputs.Librarian.push(latestUserText(context));
    }
    const round = lookups[librarianRound];
    if (round === undefined)
      throw new Error("No scripted Librarian round remains");
    if (librarianLookups < round.length) {
      const index = librarianLookups++;
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "search_oss",
            {
              query:
                index === 0
                  ? "C# terminal UI toolkit library"
                  : "C# markdown terminal library",
            },
            { id: `librarian-search-${librarianRound + 1}-${index + 1}` },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }
    let roundStart = 0;
    for (let index = context.messages.length - 1; index >= 0; index--) {
      if (context.messages[index]!.role === "user") {
        roundStart = index;
        break;
      }
    }
    const reports: string[] = [];
    let failed = false;
    for (const message of context.messages.slice(roundStart + 1)) {
      if (message.role !== "toolResult" || message.toolName !== "search_oss")
        continue;
      const text = contentText(message.content, "");
      if (message.isError) {
        failed = true;
        reports.push(
          `GitHub OSS lookup failed: ${text}. This lookup supplied no verified candidates.`,
        );
        continue;
      }
      const body = JSON.parse(text) as {
        incomplete_results: boolean;
        repositories: {
          name: string;
          url: string;
          reportedLicense: string | null;
          stars: number;
          pushedAt: string;
        }[];
      };
      const candidate = body.repositories[0];
      const report =
        candidate === undefined
          ? "No matching OSS libraries found. OSS status, versions, licenses and compatibility remain unverified."
          : [
              `Repository: ${candidate.name}`,
              `Repository URL: ${candidate.url}`,
              `GitHub reported SPDX identifier: ${candidate.reportedLicense ?? "unknown"}.`,
              `GitHub-reported stars: ${candidate.stars}; last push: ${candidate.pushedAt}.`,
              "Repository metadata does not verify full license terms, versions, APIs or compatibility.",
            ].join("\n");
      reports.push(
        body.incomplete_results ? `${report}\nResults are partial.` : report,
      );
    }
    if (reports.length === 0)
      throw new Error("Librarian did not receive its search result");
    librarianReport = reports.join("\n\n");
    if (!failed)
      return fauxAssistantMessage(
        librarianStopReason === "length"
          ? librarianReport.slice(0, 4)
          : librarianReport,
        {
          stopReason: librarianStopReason,
        },
      );
    if (!script.policyPauseBeforeSend) return sendPartialResearch();
    return fauxAssistantMessage(
      [
        fauxToolCall(
          "guarded",
          {},
          { id: `librarian-guarded-${librarianRound + 1}` },
        ),
      ],
      { stopReason: "toolUse" },
    );
  };

  const architect: FauxResponseFactory = (context) => {
    modelRequests.push("Architect");
    const input = latestUserText(context);
    memberInputs.Architect.push(input);
    const labels = input.includes("\n\nReview feedback:\n")
      ? ["Original request", "Review feedback", "Librarian report"]
      : ["Original request", "Librarian report"];
    const parts = reportsFromPrompt(input, labels);
    const original = parts[0];
    const research = parts.at(-1)!;
    const url = research.match(
      /^Repository URL: (https:\/\/github\.com\/\S+)/m,
    )?.[1];
    const choice = url
      ? `Consider ${url} as a UI dependency, subject to license/API/compatibility checks.`
      : "No verified OSS candidate is available; keep the UI dependency undecided.";
    return fauxAssistantMessage(
      [
        `Design for: ${original}`,
        `Librarian evidence: ${research}`,
        choice,
        "RunStore/UI boundary: persist typed decision-history events independently of rendering and keyboard navigation.",
        "Acceptance: at 80x24, arrows select a history row, Enter opens its detail, and Escape returns to the list.",
      ].join("\n"),
    );
  };

  const committeePlan = (input: string, round: number) => {
    const [original, research, design] = reportsFromPrompt(input, [
      "Original request",
      "Librarian report",
      "Architect report",
    ]);
    const url = research!.match(
      /^Repository URL: (https:\/\/github\.com\/\S+)/m,
    )?.[1];
    const noCandidate =
      search.searches() > 0
        ? "No matching OSS libraries found"
        : "GitHub lookups failed; no researched candidate is available";
    const option = url
      ? `Investigate ${url}; GitHub's reported SPDX identifier is metadata only, not verified license terms.`
      : `${noCandidate}; OSS status and licenses remain unverified.`;
    return [
      "# Committee plan",
      "",
      `Review round: ${round}`,
      "",
      "## Request and assumptions",
      original!,
      "Assume structured committee decision-history events; versions, library APIs and compatibility need verification.",
      "",
      "## Sourced OSS options and caveats",
      option,
      "Research evidence:",
      research!,
      "",
      "## Architecture",
      "RunStore/UI boundary: store typed events separately from the terminal presentation.",
      `Architect's delivered design: ${design}`,
      "Reduce custom rendering glue by reusing a suitable terminal UI library only after validating its license and API.",
      "",
      "## Ordered minimal implementation",
      "1. Define the decision-history event schema and RunStore read/write operations.",
      "2. Build one list/detail UI against RunStore, avoiding duplicate rendering abstractions.",
      "3. Add keyboard navigation and hostile-text escaping at the UI boundary.",
      "",
      "## Verification",
      "Given two stored decisions at 80x24, pressing Down then Enter shows the second decision's detail; Escape returns to the list.",
      "",
      "## Committee conclusions",
      `- Librarian: ${url ? `Investigate ${url}; license and compatibility unverified.` : `${noCandidate}; status unverified.`}`,
      "- Architect: Keep the RunStore/UI boundary and verify 80x24 navigation.",
      "- Reducer: Reduce custom rendering glue without dropping event storage or safe display.",
    ].join("\n");
  };

  let reducerRound = -1;
  let reducerInput = "";
  const reducer: FauxResponseFactory = (context) => {
    modelRequests.push("Reducer");
    const last = context.messages.at(-1);
    if (last?.role === "user") {
      reducerRound++;
      reducerInput = latestUserText(context);
      memberInputs.Reducer.push(reducerInput);
      const verdict = reviews[reducerRound];
      if (verdict === undefined) throw new Error("No scripted review remains");
      if (verdict !== "skip") {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              "review",
              { ...verdict },
              { id: `reducer-review-${reducerRound + 1}` },
            ),
          ],
          { stopReason: "toolUse" },
        );
      }
    }
    return fauxAssistantMessage(committeePlan(reducerInput, reducerRound + 1));
  };

  const created: YamlAgent[] = [];
  const member = async (
    id: MemberId,
    turn: FauxResponseFactory,
    tools: Parameters<typeof JuncoAgent.fromResolved>[0]["tools"],
  ) => {
    const { models, model } = scripted(Array.from({ length: 32 }, () => turn));
    // Match the truncated final's one-token usage; a shorter-than-budget `length` is native overflow recovery.
    if (id === "Librarian" && librarianStopReason === "length")
      model.maxTokens = 1;
    const agent: YamlAgent = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models,
      model,
      systemPrompt: `You are the ${id} of a three-member design committee.`,
      tools,
      tool_block: NATIVE_TOOL_BLOCK,
    });
    created.push(agent);
    return agent;
  };
  let members: Members;
  try {
    members = {
      Librarian: await member("Librarian", librarian, [
        search.tool,
        new YieldTool(),
        guardedTool,
        new SendTool(),
      ]),
      Architect: await member("Architect", architect, []),
      Reducer: await member("Reducer", reducer, [review.tool]),
    };
  } catch (error) {
    await Promise.allSettled(created.map((agent) => agent.return()));
    throw error;
  }

  return {
    members,
    search,
    review,
    memberInputs,
    searchQueries,
    modelRequests,
    async [Symbol.asyncDispose]() {
      await Promise.all(
        Object.values(members).map((member) => member.return()),
      );
    },
  };
}

if (import.meta.main) {
  await using committee = await scriptedCommittee();
  console.log(
    await convene(
      request,
      committee.members,
      committee.search,
      committee.review,
      undefined,
      new DummyTracer(),
    ),
  );
}
