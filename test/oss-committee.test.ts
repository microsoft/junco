import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AssistantMessage,
  contentText,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  DataflowNodeError,
  DummyTracer,
  EdgeId,
  NodeId,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticInput, Deterministic } from "junco-agency";
import {
  approvedPlan,
  convene,
  OssSearchTool,
  ReviewRound,
} from "../examples/oss-committee/oss-committee.ts";
import {
  request,
  type ScriptedReview,
  scriptedCommittee,
} from "./oss-committee.fixture.ts";

const quiet = new DummyTracer();

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
test("a round gates each member on the previous member's complete report", async () => {
  await using committee = await scriptedCommittee();
  const { execution } = await ReviewRound.create(
    request,
    committee.members,
    committee.search,
    undefined,
    quiet,
  );
  const graph = execution.graph;
  assert.deepEqual([...graph.available().keys()], ["ResearchAssignment"]);
  assert.equal(committee.modelRequests.length, 0);
  await execution.step(); // the code node publishes the research assignment
  assert.deepEqual([...graph.available().keys()], ["Librarian"]);
  await execution.step(); // prime the Librarian without starting its prompt
  assert.deepEqual([...graph.available().keys()], ["Librarian"]);
  await execution.step(); // the Librarian searches and finishes; its outgoing value edges resolve
  const librarian = graph.result(NodeId.create("Librarian"));
  assert.ok(O.isSome(librarian));
  const librarianReport = textOf(librarian.value);
  assert.ok(librarianReport.includes(repositoryUrl));
  assert.ok(librarianReport.includes("GitHub-reported stars: 10000"));
  assert.deepEqual([...graph.available().keys()], ["DesignAssignment"]);
  await execution.step(); // prime the validator without consuming the report
  assert.deepEqual([...graph.available().keys()], ["DesignAssignment"]);
  await execution.step(); // validate the report and publish the design assignment
  assert.deepEqual([...graph.available().keys()], ["Architect"]);
  assert.equal(committee.searchQueries.length, 1);
  assert.ok(!committee.searchQueries[0]!.includes(request));
  assert.match(committee.searchQueries[0]!, /terminal|tui|c#|csharp/i);
  assert.ok(!committee.modelRequests.includes("Architect"));

  await execution.run();
  const architect = graph.result(NodeId.create("Architect"));
  assert.ok(O.isSome(architect));
  assert.equal(committee.memberInputs.Architect.length, 1);
  assert.equal(
    committee.memberInputs.Librarian[0],
    `Original request:\n${request}\n\nSearch public GitHub repositories using only generic technical terms, then report the available evidence and any research gaps.`,
  );
  assert.equal(
    committee.memberInputs.Architect[0],
    `Original request:\n${request}\n\nLibrarian report:\n${librarianReport}`,
  );
  assert.equal(committee.memberInputs.Reducer.length, 1);
  assert.equal(
    committee.memberInputs.Reducer[0],
    `Original request:\n${request}\n\nLibrarian report:\n${librarianReport}\n\nArchitect report:\n${textOf(architect.value)}`,
  );
  assert.ok(
    committee.modelRequests.indexOf("Reducer") >
      committee.modelRequests.indexOf("Architect"),
  );
  assert.deepEqual(committee.review.takeVerdict(), approved);
}, 5_000);

test("a failed lookup sends partial research to the Architect before the Librarian resumes", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[rateLimited()]],
  });
  const { execution } = await ReviewRound.create(
    request,
    committee.members,
    committee.search,
    undefined,
    quiet,
  );
  const graph = execution.graph;
  await execution.step(); // prepare the research assignment
  await execution.step(); // prime the Librarian
  await execution.step(); // failed lookup, then info, send and the real yield tool
  assert.equal(committee.search.searches(), 0);
  assert.equal(committee.search.failures(), 1);
  assert.equal(committee.members.Librarian.status, "suspended");
  assert.ok(O.isNone(graph.result(NodeId.create("Librarian"))));
  assert.deepEqual([...graph.available().keys()], ["DesignAssignment"]);
  assert.ok(!committee.modelRequests.includes("Architect"));

  // The Librarian stays paused until the Architect returns from the partial research.
  for (
    let steps = 0;
    O.isNone(graph.result(NodeId.create("Architect")));
    steps++
  ) {
    assert.ok(steps < 10, "the Architect never finished");
    assert.equal(committee.members.Librarian.status, "suspended");
    assert.ok(!graph.available().has(NodeId.create("Librarian")));
    await execution.step();
  }
  assert.equal(committee.members.Librarian.status, "suspended");
  assert.ok(graph.available().has(NodeId.create("Librarian")));
  assert.ok(committee.memberInputs.Architect[0]?.includes("Partial research"));
  assert.ok(committee.memberInputs.Architect[0]?.includes("HTTP 403"));

  await execution.run();
  assert.ok(
    committee.modelRequests.lastIndexOf("Librarian") >
      committee.modelRequests.indexOf("Architect"),
  );
  assert.ok(committee.memberInputs.Reducer[0]?.includes("HTTP 403"));
}, 5_000);

test("a policy pause before any partial send leaves the Librarian resumable", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[rateLimited()]],
    policyPauseBeforeSend: true,
  });
  const { execution } = await ReviewRound.create(
    request,
    committee.members,
    committee.search,
    undefined,
    quiet,
  );
  const graph = execution.graph;
  await execution.step(); // prepare the research assignment
  await execution.step(); // prime the Librarian
  await execution.step(); // failed lookup, then a policy denial pauses the run
  assert.equal(committee.search.failures(), 1);
  assert.equal(committee.members.Librarian.status, "suspended");
  assert.deepEqual([...graph.available().keys()], ["Librarian"]);

  await execution.run();
  assert.ok(committee.memberInputs.Architect[0]?.includes("Partial research"));
  assert.ok(committee.memberInputs.Reducer[0]?.includes("HTTP 403"));
  assert.deepEqual(committee.review.takeVerdict(), approved);
}, 5_000);

test("a later failed lookup sends partial research even after an earlier search succeeded", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[emptySearch(), rateLimited()]],
  });
  const plan = await convene(
    request,
    committee.members,
    committee.search,
    committee.review,
    undefined,
    quiet,
  );
  assert.equal(committee.search.searches(), 1);
  assert.equal(committee.search.failures(), 1);
  assert.ok(committee.memberInputs.Architect[0]?.includes("HTTP 403"));
  assert.ok(plan.includes("HTTP 403"));
}, 5_000);

test("a truncated closing report after a handoff never reaches the Reducer", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[rateLimited()]],
    librarianStopReason: "length",
  });
  const { execution } = await ReviewRound.create(
    request,
    committee.members,
    committee.search,
    undefined,
    quiet,
  );
  const graph = execution.graph;
  const error = await execution.run().catch((thrown: unknown) => thrown);
  assert.ok(
    error instanceof DataflowNodeError && error.nodeId === "ReviewAssignment",
  );
  assert.match(
    String(error.cause),
    /Librarian did not finish normally: length/,
  );
  const librarian = graph.result(NodeId.create("Librarian"));
  assert.ok(O.isSome(librarian));
  assert.equal(librarian.value.stopReason, "length");
  assert.ok(O.isSome(graph.result(NodeId.create("Architect"))));
  assert.deepEqual(committee.memberInputs.Reducer, []);
  assert.ok(!committee.modelRequests.includes("Reducer"));
}, 5_000);

test("a truncated research report never reaches the Architect", async () => {
  await using committee = await scriptedCommittee({
    librarianStopReason: "length",
  });
  const { execution } = await ReviewRound.create(
    request,
    committee.members,
    committee.search,
    undefined,
    quiet,
  );
  const graph = execution.graph;
  const error = await execution.run().catch((thrown: unknown) => thrown);
  assert.ok(
    error instanceof DataflowNodeError && error.nodeId === "DesignAssignment",
  );
  assert.match(
    String(error.cause),
    /Librarian did not finish normally: length/,
  );
  const librarian = graph.result(NodeId.create("Librarian"));
  assert.ok(O.isSome(librarian));
  assert.equal(librarian.value.stopReason, "length");
  assert.ok(!committee.modelRequests.includes("Architect"));
  assert.ok(!committee.modelRequests.includes("Reducer"));
}, 5_000);

test("the design code node rejects missing searches and malformed partial handoffs before any model starts", async () => {
  const cases: { batch?: AgenticInput[]; failed?: boolean; error: RegExp }[] = [
    { error: /Librarian did not complete a valid GitHub OSS search/ },
    {
      batch: [],
      error: /Librarian must send exactly one partial research prompt/,
    },
    {
      batch: [{ kind: "followUp", text: "partial" }],
      error: /Librarian must send exactly one partial research prompt/,
    },
    {
      batch: [
        { kind: "prompt", text: "first" },
        { kind: "prompt", text: "second" },
      ],
      error: /Librarian must send exactly one partial research prompt/,
    },
    {
      failed: true,
      error:
        /Librarian must send its partial research after a failed GitHub lookup/,
    },
  ];
  for (const entry of cases) {
    await using committee = await scriptedCommittee({
      lookups: [[rateLimited()]],
    });
    const { execution } = await ReviewRound.create(
      request,
      committee.members,
      committee.search,
      undefined,
      quiet,
    );
    if (entry.failed)
      await assert.rejects(
        committee.search.tool.execute("failed-search", {
          query: "terminal UI",
        }),
      );
    const state = execution.graph.getNode(
      NodeId.create("DesignAssignment"),
    )!.state;
    assert.ok(state instanceof Deterministic);
    const body = state.step();
    await body.next(); // prime the actual registered code node, not a replacement test implementation
    await assert.rejects(
      body.next({
        messages:
          entry.batch === undefined
            ? new Map()
            : new Map([
                [EdgeId.create("Librarian~>DesignAssignment"), entry.batch],
              ]),
        values: new Map([
          [
            EdgeId.create("Librarian->DesignAssignment"),
            fauxAssistantMessage("Unsearched research"),
          ],
        ]),
      }),
      entry.error,
    );
    assert.equal(committee.modelRequests.length, 0);
  }
});

test("a valid empty search is reported without inventing a candidate", async () => {
  await using committee = await scriptedCommittee({
    lookups: [[emptySearch()]],
  });
  const plan = await convene(
    request,
    committee.members,
    committee.search,
    committee.review,
    undefined,
    quiet,
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
  const searcher = new OssSearchTool(
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
  assert.equal(searcher.searches(), 0);
  const search = await searcher.tool.execute(
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
  assert.equal(searcher.searches(), 1);

  const invalid = new OssSearchTool(
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
  const trusted = new OssSearchTool(
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
  const untrusted = new OssSearchTool(
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
    undefined,
    quiet,
  );
  assert.ok(plan.includes("Review round: 3"));
  assert.ok(!plan.includes("Review round: 1"));
  assert.equal(committee.searchQueries.length, 3);
  const { Librarian, Architect, Reducer } = committee.memberInputs;
  assert.ok(!Librarian[0]!.includes("Review feedback:"));
  for (const [index, feedback] of [markdownFeedback, cacheFeedback].entries()) {
    assert.equal(
      Librarian[index + 1],
      `Original request:\n${request}\n\nReview feedback:\n${feedback}\n\nContinue investigating with new search_oss lookups using only generic technical terms, then report the updated evidence and any remaining research gaps.`,
    );
    assert.ok(
      Architect[index + 1]!.startsWith(
        `Original request:\n${request}\n\nReview feedback:\n${feedback}\n\nLibrarian report:\n`,
      ),
    );
  }
  assert.equal(Reducer.length, 3);
}, 5_000);

test("a round without a review verdict publishes nothing", async () => {
  await using committee = await scriptedCommittee({ reviews: ["skip"] });
  await assert.rejects(
    convene(
      request,
      committee.members,
      committee.search,
      committee.review,
      undefined,
      quiet,
    ),
  );
  assert.equal(committee.memberInputs.Reducer.length, 1);
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
    undefined,
    quiet,
  );
  assert.ok(plan.includes("Review round: 2"));
  assert.ok(plan.includes(repositoryUrl));
  assert.equal(committee.search.failures(), 1);
}, 5_000);
