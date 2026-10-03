import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AssistantMessage,
  contentText,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { DataflowNodeError, NodeId } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import {
  approvedPlan,
  convene,
  createOssSearchTool,
  reviewRound,
} from "../examples/oss-committee.ts";
import {
  request,
  type ScriptedReview,
  scriptedCommittee,
} from "./oss-committee.fixture.ts";

const repositoryUrl = "https://github.com/tui-cs/Terminal.Gui";
const textOf = (message: AssistantMessage) =>
  contentText(message.content).trim();
const rateLimited = () => new Response("rate limited", { status: 403 });
const emptySearch = () =>
  Response.json({ incomplete_results: false, items: [] });
const revise = (feedback: string): ScriptedReview => ({
  approved: false,
  feedback,
});
const approved: ScriptedReview = {
  approved: true,
  feedback: "Minimal, clean, and backed by well-trusted OSS.",
};
const normalRound = [
  "Librarian",
  "Librarian",
  "Architect",
  "Reducer",
  "Reducer",
] as const;

test("a round gates each member on the previous member's complete report", async () => {
  await using committee = await scriptedCommittee();
  const { graph } = reviewRound(request, committee.members, committee.search);
  assert.deepEqual([...graph.available().keys()], ["Librarian"]);
  await graph.step(); // prime the Librarian without starting its prompt
  assert.deepEqual([...graph.available().keys()], ["Librarian"]);
  await graph.step(); // the Librarian searches and finishes; both outgoing value edges resolve
  const librarian = graph.result(NodeId("Librarian"));
  assert.ok(O.isSome(librarian));
  const librarianReport = textOf(librarian.value);
  assert.ok(librarianReport.includes(repositoryUrl));
  assert.ok(librarianReport.includes("GitHub-reported stars: 10000"));
  assert.deepEqual([...graph.available().keys()], ["Architect"]);
  assert.equal(committee.searchQueries.length, 1);
  assert.ok(!committee.searchQueries[0]!.includes(request));
  assert.match(committee.searchQueries[0]!, /terminal|tui|c#|csharp/i);

  await graph.step(); // prime the Architect
  await graph.step(); // deliver the complete Librarian report
  assert.equal(committee.memberInputs.Architect.length, 1);
  assert.ok(committee.memberInputs.Architect[0]!.includes(librarianReport));
  assert.deepEqual([...graph.available().keys()], ["Reducer"]);

  await graph.run();
  const architect = graph.result(NodeId("Architect"));
  assert.ok(O.isSome(architect));
  assert.equal(committee.memberInputs.Reducer.length, 1);
  assert.ok(committee.memberInputs.Reducer[0]!.includes(librarianReport));
  assert.ok(
    committee.memberInputs.Reducer[0]!.includes(textOf(architect.value)),
  );
  assert.deepEqual(committee.review.takeVerdict(), approved);
}, 5_000);

test("a failed lookup yields to the Architect before the Librarian resumes", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[rateLimited()]],
  });
  const { graph } = reviewRound(request, committee.members, committee.search);
  await graph.step(); // prime the Librarian
  await graph.step(); // failed lookup, followed by the real yield tool
  assert.equal(committee.search.searches(), 0);
  assert.equal(committee.search.failures(), 1);
  assert.equal(committee.members.Librarian.status, "suspended");
  assert.ok(O.isNone(graph.result(NodeId("Librarian"))));
  assert.deepEqual([...graph.available().keys()], ["Architect"]);
  assert.deepEqual(committee.modelRequests, ["Librarian", "Librarian"]);

  await graph.step(); // prime the Architect without resuming the Librarian
  await graph.step(); // the Architect receives the yielded snapshot and returns
  assert.equal(committee.members.Librarian.status, "suspended");
  assert.ok(O.isSome(graph.result(NodeId("Architect"))));
  assert.deepEqual([...graph.available().keys()], ["Librarian"]);
  assert.ok(committee.memberInputs.Architect[0]?.includes("HTTP 403"));

  await graph.run();
  assert.deepEqual(committee.modelRequests, [
    "Librarian",
    "Librarian",
    "Architect",
    "Librarian",
    "Reducer",
    "Reducer",
  ]);
  assert.ok(committee.memberInputs.Reducer[0]?.includes("HTTP 403"));
}, 5_000);

test("a later failed lookup yields even after an earlier search succeeded", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[emptySearch(), rateLimited()]],
  });
  const plan = await convene(
    request,
    committee.members,
    committee.search,
    committee.review,
  );
  assert.equal(committee.search.searches(), 1);
  assert.equal(committee.search.failures(), 1);
  assert.deepEqual(committee.modelRequests, [
    "Librarian",
    "Librarian",
    "Librarian",
    "Architect",
    "Librarian",
    "Reducer",
    "Reducer",
  ]);
  assert.ok(committee.memberInputs.Architect[0]?.includes("HTTP 403"));
  assert.ok(plan.includes("HTTP 403"));
}, 5_000);

test("a truncated closing report after a handoff never reaches the Reducer", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[rateLimited()]],
    librarianStopReason: "length",
  });
  const { graph } = reviewRound(request, committee.members, committee.search);
  const error = await graph.run().catch((thrown: unknown) => thrown);
  assert.ok(error instanceof DataflowNodeError && error.nodeId === "Reducer");
  const librarian = graph.result(NodeId("Librarian"));
  assert.ok(O.isSome(librarian) && librarian.value.stopReason !== "stop");
  assert.ok(O.isSome(graph.result(NodeId("Architect"))));
  assert.deepEqual(committee.memberInputs.Reducer, []);
  // Pi treats a "length" stop as a context overflow and retries once before failing the run.
  assert.deepEqual(committee.modelRequests, [
    "Librarian",
    "Librarian",
    "Architect",
    "Librarian",
    "Librarian",
  ]);
}, 5_000);

test("a truncated research report never reaches the Architect", async () => {
  await using committee = await scriptedCommittee({
    librarianStopReason: "length",
  });
  const { graph } = reviewRound(request, committee.members, committee.search);
  const error = await graph.run().catch((thrown: unknown) => thrown);
  assert.ok(error instanceof DataflowNodeError && error.nodeId === "Architect");
  const librarian = graph.result(NodeId("Librarian"));
  assert.ok(O.isSome(librarian) && librarian.value.stopReason !== "stop");
  assert.deepEqual(committee.memberInputs.Architect, []);
  assert.deepEqual(committee.memberInputs.Reducer, []);
}, 5_000);

test("a valid empty search is reported without inventing a candidate", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[emptySearch()]],
  });
  const plan = await convene(
    request,
    committee.members,
    committee.search,
    committee.review,
  );
  assert.ok(
    committee.memberInputs.Architect[0]?.includes(
      "No matching OSS libraries found",
    ),
  );
  assert.ok(plan.includes("No matching OSS libraries found"));
  assert.doesNotMatch(plan, /Terminal\.Gui|github\.com\/tui-cs/);
  assert.match(plan, /OSS[^\n]*unverified/i);
  assert.match(plan, /license[^\n]*unverified/i);
}, 5_000);

test("only a complete titled plan can be approved", () => {
  for (const message of [
    undefined,
    fauxAssistantMessage("# Truncated", { stopReason: "length" }),
    fauxAssistantMessage(" \n "),
    fauxAssistantMessage("No heading"),
  ]) {
    assert.throws(() => approvedPlan(message));
  }
  assert.equal(
    approvedPlan(fauxAssistantMessage("# Plan\nBody")),
    "# Plan\nBody",
  );
});

test("repository search sends only the scoped GitHub request and rejects invalid metadata", async () => {
  const controller = new AbortController();
  const { tool, searches } = createOssSearchTool(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        assert.equal(
          input,
          "https://api.github.com/search/repositories?q=terminal.gui%20library&per_page=5",
        );
        assert.equal(init?.method, "GET");
        assert.equal(
          new Headers(init?.headers).get("Accept"),
          "application/vnd.github+json",
        );
        assert.equal(
          new Headers(init?.headers).get("User-Agent"),
          "junco-agency-oss-committee",
        );
        assert.equal(init?.signal, controller.signal);
        return Response.json({ incomplete_results: false, items: [] });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  assert.equal(searches(), 0);
  const search = await tool.execute(
    "lookup",
    { query: "  terminal.gui library  " },
    controller.signal,
  );
  assert.deepEqual(
    JSON.parse(
      search.content[0]!.type === "text" ? search.content[0].text : "",
    ),
    { incomplete_results: false, repositories: [] },
  );
  assert.equal(searches(), 1);

  const invalid = createOssSearchTool(
    Object.assign(
      async () =>
        Response.json({
          incomplete_results: false,
          items: [
            {
              full_name: "spoof/repo",
              html_url: "https://github.com.evil.test/spoof/repo",
              description: null,
              language: "C#",
              archived: false,
              license: null,
              stargazers_count: 10_000,
              pushed_at: "2026-09-15T00:00:00Z",
            },
          ],
        }),
      { preconnect: fetch.preconnect },
    ),
  );
  await assert.rejects(
    invalid.tool.execute(
      "lookup",
      { query: "terminal tui" },
      controller.signal,
    ),
  );
  assert.equal(invalid.searches(), 0);
  assert.equal(invalid.failures(), 1);
});

test("repository search reports GitHub trust signals and rejects results without them", async () => {
  const item = {
    full_name: "tui-cs/Terminal.Gui",
    html_url: repositoryUrl,
    description: "Cross Platform Terminal UI toolkit for .NET",
    language: "C#",
    archived: false,
    license: { spdx_id: "MIT" },
    stargazers_count: 10_000,
    pushed_at: "2026-09-15T00:00:00Z",
  };
  const trusted = createOssSearchTool(
    Object.assign(
      async () => Response.json({ incomplete_results: false, items: [item] }),
      { preconnect: fetch.preconnect },
    ),
  );
  const result = await trusted.tool.execute("lookup", { query: "terminal ui" });
  assert.deepEqual(
    JSON.parse(
      result.content[0]!.type === "text" ? result.content[0].text : "",
    ),
    {
      incomplete_results: false,
      repositories: [
        {
          name: "tui-cs/Terminal.Gui",
          url: repositoryUrl,
          description: "Cross Platform Terminal UI toolkit for .NET",
          language: "C#",
          archived: false,
          stars: 10_000,
          pushedAt: "2026-09-15T00:00:00Z",
          reportedLicense: "MIT",
        },
      ],
    },
  );

  const { pushed_at: _pushedAt, ...withoutPush } = item;
  const untrusted = createOssSearchTool(
    Object.assign(
      async () =>
        Response.json({ incomplete_results: false, items: [withoutPush] }),
      { preconnect: fetch.preconnect },
    ),
  );
  await assert.rejects(
    untrusted.tool.execute("lookup", { query: "terminal ui" }),
  );
  assert.equal(untrusted.searches(), 0);
  assert.equal(untrusted.failures(), 1);
});

test("the Reducer sends the Librarian and Architect back until it approves", async () => {
  const markdownFeedback =
    "Research a maintained Markdown renderer instead of custom rendering.";
  const cacheFeedback =
    "Drop the custom paging cache; use the library's own scrolling.";
  await using committee = await scriptedCommittee({
    reviews: [revise(markdownFeedback), revise(cacheFeedback), approved],
  });
  const plan = await convene(
    request,
    committee.members,
    committee.search,
    committee.review,
  );
  assert.ok(plan.includes("Review round: 3"));
  assert.ok(!plan.includes("Review round: 1"));
  assert.deepEqual(committee.modelRequests, [
    ...normalRound,
    ...normalRound,
    ...normalRound,
  ]);
  assert.equal(committee.searchQueries.length, 3);
  const { Librarian, Architect, Reducer } = committee.memberInputs;
  assert.ok(!Librarian[0]!.includes("Review feedback:"));
  assert.ok(Librarian[1]!.includes(markdownFeedback));
  assert.ok(Librarian[2]!.includes(cacheFeedback));
  assert.ok(Architect[1]!.includes(markdownFeedback));
  assert.ok(Architect[2]!.includes(cacheFeedback));
  assert.equal(Reducer.length, 3);
}, 5_000);

test("a round without a review verdict publishes nothing", async () => {
  await using committee = await scriptedCommittee({ reviews: ["skip"] });
  await assert.rejects(
    convene(request, committee.members, committee.search, committee.review),
  );
  assert.deepEqual(committee.modelRequests, [
    "Librarian",
    "Librarian",
    "Architect",
    "Reducer",
  ]);
}, 5_000);

test("a failed lookup in one round does not block a later normal round", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[rateLimited()]],
    reviews: [revise("Retry the terminal UI research."), approved],
  });
  const plan = await convene(
    request,
    committee.members,
    committee.search,
    committee.review,
  );
  assert.ok(plan.includes("Review round: 2"));
  assert.ok(plan.includes(repositoryUrl));
  assert.equal(committee.search.failures(), 1);
  assert.deepEqual(committee.modelRequests, [
    "Librarian",
    "Librarian",
    "Architect",
    "Librarian",
    "Reducer",
    "Reducer",
    ...normalRound,
  ]);
}, 5_000);
