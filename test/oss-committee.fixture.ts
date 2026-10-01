import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { DataflowTracer } from "dataflow-engine";
import { OpikDataflowTracer } from "dataflow-engine-opik";
import { type Agentic, JuncoAgent } from "junco-agent";
import { Opik } from "opik";
import { createCommitteeGraph, createOssSearchTool, runCommittee, type MemberId } from "../examples/oss-committee.ts";
import { scripted } from "./support.ts";

const request = "Design a C# TUI for committee decision history.";
const defaultSearchResponse = () => new Response(JSON.stringify({
  incomplete_results: false,
  items: [{
    full_name: "tui-cs/Terminal.Gui",
    html_url: "https://github.com/tui-cs/Terminal.Gui",
    description: "Cross Platform Terminal UI toolkit for .NET",
    language: "C#",
    archived: false,
    license: { spdx_id: "MIT" },
  }],
}), { headers: { "Content-Type": "application/json" } });

/** The most recent user-facing message of a model request, including array-form Pi content. */
function latestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.type === "text" ? block.text : "").join("");
  }
  throw new Error("Scripted actor request has no user message");
}

/** Split only the graph's structured prompt; reports remain the actual delivered value-edge payloads. */
function reportsFromPrompt(text: string, labels: readonly string[]): string[] {
  const parts: string[] = [];
  let remaining = text;
  for (const label of labels) {
    const prefix = `${label}:\n`;
    if (!remaining.startsWith(prefix)) throw new Error(`Missing ${label} in committee prompt`);
    remaining = remaining.slice(prefix.length);
    const nextLabel = labels[parts.length + 1];
    if (nextLabel === undefined) {
      parts.push(remaining);
    } else {
      const separator = `\n\n${nextLabel}:\n`;
      const boundary = remaining.indexOf(separator);
      if (boundary < 0) throw new Error(`Missing ${nextLabel} in committee prompt`);
      parts.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary + 2);
    }
  }
  return parts;
}

/** Real graph and real search tool, with scripted model responses and an injected HTTP response. */
export async function scriptedCommitteeFixture(
  tracer: DataflowTracer,
  searchResponse?: Response,
  librarianStopReason: "stop" | "length" = "stop",
): Promise<ReturnType<typeof createCommitteeGraph> & {
  memberInputs: Record<MemberId, string[]>;
  searchQueries: string[];
}> {
  const memberInputs: Record<MemberId, string[]> = { Librarian: [], Architect: [], Reducer: [] };
  const searchQueries: string[] = [];
  const response = searchResponse ?? defaultSearchResponse();
  const search = createOssSearchTool(Object.assign(async (url: Parameters<typeof fetch>[0]) => {
    searchQueries.push(new URL(url instanceof Request ? url.url : url).searchParams.get("q") ?? "");
    return response.clone();
  }, { preconnect: fetch.preconnect }));
  const members = {} as Record<MemberId, Agentic>;
  const created: Agentic[] = [];

  async function member(id: MemberId, responses: Parameters<typeof scripted>[0], options: { prompt?: string } = {}) {
    const { models, model } = scripted(responses);
    const agent = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models,
      model,
      systemPrompt: `You are the ${id} of a three-member design committee.`,
      tools: id === "Librarian" ? [search.tool] : [],
      ...options,
    });
    members[id] = agent;
    created.push(agent);
  }

  try {
    await member("Librarian", [
      (context: Context) => {
        memberInputs.Librarian.push(latestUserText(context));
        return fauxAssistantMessage([fauxToolCall("search_oss", { query: "C# terminal UI toolkit library" }, {
          id: "librarian-search",
        })], { stopReason: "toolUse" });
      },
      (context: Context) => {
        memberInputs.Librarian.push(latestUserText(context));
        const toolResult = context.messages.find((message) =>
          message.role === "toolResult" && message.toolName === "search_oss");
        if (toolResult?.role !== "toolResult") throw new Error("Librarian did not receive its search result");
        if (toolResult.isError) return fauxAssistantMessage("GitHub OSS lookup failed; no researched candidates are available.", {
          stopReason: librarianStopReason,
        });
        const body = JSON.parse(toolResult.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")) as {
          incomplete_results: boolean;
          repositories: { name: string; url: string; reportedLicense: string | null }[];
        };
        const candidate = body.repositories[0];
        const report = candidate === undefined
          ? "No matching OSS libraries found. OSS status, versions, licenses and compatibility remain unverified."
          : [
              `Repository: ${candidate.name}`,
              `Repository URL: ${candidate.url}`,
              `GitHub reported SPDX identifier: ${candidate.reportedLicense ?? "unknown"}.`,
              "Repository metadata does not verify full license terms, versions, APIs or compatibility.",
            ].join("\n");
        return fauxAssistantMessage(body.incomplete_results ? `${report}\nResults are partial.` : report, {
          stopReason: librarianStopReason,
        });
      },
    ], { prompt: `Research OSS libraries for this request:\n${request}\nUse generic technical search terms.` });

    await member("Architect", [(context: Context) => {
      const input = latestUserText(context);
      memberInputs.Architect.push(input);
      const [original, librarian] = reportsFromPrompt(input, ["Original request", "Librarian report"]);
      const url = librarian!.match(/^Repository URL: (https:\/\/github\.com\/\S+)/m)?.[1];
      const choice = url
        ? `Consider ${url} as a UI dependency, subject to license/API/compatibility checks.`
        : "No verified OSS candidate is available; keep the UI dependency undecided.";
      return fauxAssistantMessage([
        `Design for: ${original}`,
        `Librarian evidence: ${librarian}`,
        choice,
        "RunStore/UI boundary: persist typed decision-history events independently of rendering and keyboard navigation.",
        "Acceptance: at 80x24, arrows select a history row, Enter opens its detail, and Escape returns to the list.",
      ].join("\n"));
    }]);

    await member("Reducer", [(context: Context) => {
      const input = latestUserText(context);
      memberInputs.Reducer.push(input);
      const [original, librarian, architect] = reportsFromPrompt(input,
        ["Original request", "Librarian report", "Architect report"]);
      const url = librarian!.match(/^Repository URL: (https:\/\/github\.com\/\S+)/m)?.[1];
      const option = url
        ? `Investigate ${url}; GitHub's reported SPDX identifier is metadata only, not verified license terms.`
        : "No matching OSS libraries found; OSS status and licenses remain unverified.";
      return fauxAssistantMessage([
        "# Committee plan",
        "",
        "## Request and assumptions",
        original!,
        "Assume structured committee decision-history events; versions, library APIs and compatibility need verification.",
        "",
        "## Sourced OSS options and caveats",
        option,
        "Research evidence:",
        librarian!,
        "",
        "## Architecture",
        "RunStore/UI boundary: store typed events separately from the terminal presentation.",
        `Architect's delivered design: ${architect}`,
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
        `- Librarian: ${url ? `Investigate ${url}; license and compatibility unverified.` : "No matching OSS libraries found; status unverified."}`,
        "- Architect: Keep the RunStore/UI boundary and verify 80x24 navigation.",
        "- Reducer: Reduce custom rendering glue without dropping event storage or safe display.",
      ].join("\n"));
    }]);

    return { ...createCommitteeGraph(request, members, search.wasSearched, tracer), memberInputs, searchQueries };
  } catch (error) {
    await Promise.allSettled(created.map((actor) => actor.return()));
    throw error;
  }
}

if (import.meta.main) {
  const tracer = new OpikDataflowTracer(new Opik(), "examples/oss-committee");
  let committee: Awaited<ReturnType<typeof scriptedCommitteeFixture>> | undefined;
  let started = false;
  try {
    committee = await scriptedCommitteeFixture(tracer);
    const outputPath = join(await mkdtemp(join(tmpdir(), "oss-committee-")), "plan.md");
    started = true;
    await runCommittee(committee, outputPath);
    console.log(outputPath);
    console.log(await readFile(outputPath, "utf8"));
  } finally {
    if (!started) {
      await Promise.allSettled(committee === undefined ? [] : Object.values(committee.members).map((member) => member.return()));
      await tracer.flush();
    }
  }
}
