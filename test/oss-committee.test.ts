import { test } from "bun:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { DataflowNodeError, DummyTracer, NodeId } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { createOssSearchTool, publishPlan, runCommittee, type MemberId } from "../examples/oss-committee.ts";
import { scriptedCommitteeFixture } from "./oss-committee.fixture.ts";

const request = "Design a C# TUI for committee decision history.";
const members = ["Librarian", "Architect", "Reducer"] as const satisfies readonly MemberId[];
const repositoryUrl = "https://github.com/tui-cs/Terminal.Gui";

async function tempOutput() {
  const directory = await mkdtemp(join(tmpdir(), "oss-committee-test-"));
  return { directory, outputPath: join(directory, "plan.md") };
}

function textOf(message: AssistantMessage): string {
  return message.content.map((block) => block.type === "text" ? block.text : "").join("").trim();
}

async function assertNoOutput(outputPath: string): Promise<void> {
  await assert.rejects(lstat(outputPath), { code: "ENOENT" });
}

function assertClosed(committee: Awaited<ReturnType<typeof scriptedCommitteeFixture>>): void {
  for (const id of members) assert.equal(committee.members[id].status, "closed", `${id} must close`);
}

test("researched results gate the three members and produce one sourced minimal plan", async () => {
  const committee = await scriptedCommitteeFixture(new DummyTracer());
  const { directory, outputPath } = await tempOutput();
  try {
    const { graph } = committee;
    assert.deepEqual([...graph.available().keys()], ["Librarian"]);
    await graph.step(); // prime Librarian without activating its staged prompt
    assert.deepEqual([...graph.available().keys()], ["Librarian"]);
    assert.equal(committee.memberInputs.Architect.length, 0);
    await graph.step(); // Librarian searches and finishes; both outgoing value edges resolve
    const librarian = graph.result(NodeId("Librarian"));
    assert.ok(O.isSome(librarian));
    const librarianReport = textOf(librarian.value);
    assert.ok(librarianReport.includes(repositoryUrl), "the report must cite the searched repository");
    assert.deepEqual([...graph.available().keys()], ["Architect"]);
    assert.equal(committee.memberInputs.Architect.length, 0);
    assert.equal(committee.memberInputs.Reducer.length, 0);
    assert.equal(committee.searchQueries.length, 1);
    assert.ok(!committee.searchQueries[0]!.includes(request), "search must not send the original request");
    assert.match(committee.searchQueries[0]!, /terminal|tui|c#|csharp/i);

    await graph.step(); // prime Architect
    assert.equal(committee.memberInputs.Architect.length, 0);
    await graph.step(); // deliver the complete Librarian return
    assert.deepEqual(committee.memberInputs.Architect, [
      `Original request:\n${request}\n\nLibrarian report:\n${librarianReport}`,
    ]);
    const architect = graph.result(NodeId("Architect"));
    assert.ok(O.isSome(architect));
    const architectReport = textOf(architect.value);
    assert.ok(architectReport.includes(repositoryUrl), "the Architect must use the delivered research");
    assert.deepEqual([...graph.available().keys()], ["Reducer"]);
    assert.equal(committee.memberInputs.Reducer.length, 0);

    await runCommittee(committee, outputPath);
    assert.deepEqual(committee.memberInputs.Reducer, [
      `Original request:\n${request}\n\nLibrarian report:\n${librarianReport}\n\nArchitect report:\n${architectReport}`,
    ]);
    const plan = await readFile(outputPath, "utf8");
    assert.match(plan, /^# Committee plan\n/);
    assert.ok(plan.includes(request));
    assert.ok(plan.includes(repositoryUrl));
    assert.ok(plan.includes("RunStore/UI"));
    assert.match(plan, /reduce custom rendering glue/i);
    assert.ok(plan.includes("80x24"));
    assert.ok(plan.includes("## Committee conclusions"));
    for (const id of members) assert.ok(plan.includes(`- ${id}:`), `missing ${id} conclusion`);
    assertClosed(committee);
    const reducer = graph.result(committee.resultId);
    assert.ok(O.isSome(reducer));
    await assert.rejects(publishPlan(outputPath, reducer.value), { code: "EEXIST" });
    assert.equal(await readFile(outputPath, "utf8"), plan);
  } finally {
    await Promise.allSettled(Object.values(committee.members).map((member) => member.return()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed GitHub lookup cannot become remembered research", async () => {
  const committee = await scriptedCommitteeFixture(new DummyTracer(), new Response("rate limited", { status: 403 }));
  const { directory, outputPath } = await tempOutput();
  try {
    await assert.rejects(runCommittee(committee, outputPath), (error: unknown) =>
      error instanceof DataflowNodeError && error.nodeId === "Architect" &&
      error.error instanceof Error && /did not complete a valid GitHub OSS search/.test(error.error.message),
    );
    assert.equal(committee.searchQueries.length, 1);
    assert.deepEqual(committee.memberInputs.Architect, []);
    assert.deepEqual(committee.memberInputs.Reducer, []);
    assertClosed(committee);
    await assertNoOutput(outputPath);
  } finally {
    await Promise.allSettled(Object.values(committee.members).map((member) => member.return()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a length-stopped Librarian never supplies a partial report", async () => {
  const committee = await scriptedCommitteeFixture(new DummyTracer(), undefined, "length");
  const { directory, outputPath } = await tempOutput();
  try {
    await assert.rejects(runCommittee(committee, outputPath), (error: unknown) =>
      error instanceof DataflowNodeError && error.nodeId === "Architect" &&
      error.error instanceof Error && /Librarian stopped with /.test(error.error.message),
    );
    assert.equal(committee.searchQueries.length, 1);
    assert.deepEqual(committee.memberInputs.Architect, []);
    assert.deepEqual(committee.memberInputs.Reducer, []);
    assertClosed(committee);
    await assertNoOutput(outputPath);
  } finally {
    await Promise.allSettled(Object.values(committee.members).map((member) => member.return()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid empty search is researched, but never invents an OSS candidate or license", async () => {
  const response = Response.json({ incomplete_results: false, items: [] });
  const committee = await scriptedCommitteeFixture(new DummyTracer(), response);
  const { directory, outputPath } = await tempOutput();
  try {
    await runCommittee(committee, outputPath);
    const report = committee.memberInputs.Architect[0];
    assert.ok(report?.includes("No matching OSS libraries found"));
    assert.ok(committee.memberInputs.Reducer[0]?.includes("No matching OSS libraries found"));
    const plan = await readFile(outputPath, "utf8");
    assert.ok(plan.includes("No matching OSS libraries found"));
    assert.doesNotMatch(plan, /Terminal\.Gui|github\.com\/tui-cs/);
    assert.match(plan, /OSS[^\n]*unverified/i);
    assert.match(plan, /license[^\n]*unverified/i);
    assertClosed(committee);
  } finally {
    await Promise.allSettled(Object.values(committee.members).map((member) => member.return()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication rejects absent, incomplete and untitled final answers without creating a file", async () => {
  const { directory, outputPath } = await tempOutput();
  try {
    await assert.rejects(publishPlan(outputPath, undefined), /Reducer produced no final plan/);
    await assert.rejects(publishPlan(outputPath, fauxAssistantMessage("# Truncated", { stopReason: "length" })),
      /Reducer stopped with length/);
    await assert.rejects(publishPlan(outputPath, fauxAssistantMessage(" \n ")), /Markdown title/);
    await assert.rejects(publishPlan(outputPath, fauxAssistantMessage("No heading")), /Markdown title/);
    await assertNoOutput(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository search sends only the scoped GitHub request and rejects invalid metadata", async () => {
  const controller = new AbortController();
  const { tool, wasSearched } = createOssSearchTool(Object.assign(async (
    input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
  ) => {
    assert.equal(input, "https://api.github.com/search/repositories?q=terminal.gui%20library&per_page=5");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("Accept"), "application/vnd.github+json");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "junco-agency-oss-committee");
    assert.equal(init?.signal, controller.signal);
    return Response.json({ incomplete_results: false, items: [] });
  }, { preconnect: fetch.preconnect }));
  assert.equal(wasSearched(), false);
  const search = await tool.execute("lookup", { query: "  terminal.gui library  " }, controller.signal);
  assert.deepEqual(JSON.parse(search.content[0]!.type === "text" ? search.content[0].text : ""),
    { incomplete_results: false, repositories: [] });
  assert.equal(wasSearched(), true);

  const invalid = createOssSearchTool(Object.assign(async () => Response.json({
    incomplete_results: false,
    items: [{ full_name: "spoof/repo", html_url: "https://github.com.evil.test/spoof/repo",
      description: null, language: "C#", archived: false, license: null }],
  }), { preconnect: fetch.preconnect }));
  await assert.rejects(invalid.tool.execute("lookup", { query: "terminal tui" }, controller.signal),
    /Invalid GitHub OSS search response/);
  assert.equal(invalid.wasSearched(), false);
});
