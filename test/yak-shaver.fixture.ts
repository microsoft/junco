// Offline scaffolding for test/yak-shaver.test.ts: in-memory Graft graphs and real JuncoAgent lanes
// on faux providers, driven by the example's real batch graph and native task tool.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type { YamlAgent } from "../examples/support.ts";
import {
  type CandidateLane,
  type CandidateWork,
  type GraftSnapshot,
  parseSnapshot,
  type RefactorVerdict,
  type SearchReport,
  runCandidateBatch,
} from "../examples/yak-shaver/yak-shaver.ts";
import { agent, graph, tools, tracer } from "../src/index.ts";
import { userTexts } from "./deterministic-support.ts";
import { copyTreeNative, offlineLadder, toolTurn } from "./support.ts";

/** One graph node; omitted fields follow Graft's shape for an unexported AST class on line 1. */
export type NodeInput = {
  readonly id: string;
  readonly kind?: string;
  readonly span?: string;
  readonly exported?: boolean;
  readonly origin?: "ast" | "generic";
  readonly owner?: string;
};

/** `[source, target, relation = "calls", confidence = "extracted"]`. */
export type EdgeInput = readonly [string, string, string?, string?];

/** Graft v1 wiring JSON over `nodes`, adding a file node for every path. */
export function wiring(
  nodes: readonly NodeInput[],
  edges: readonly EdgeInput[] = [],
): string {
  const records = nodes.map((node) => {
    const path = node.id.split("#")[0]!;
    return {
      id: node.id,
      name: node.id
        .slice(node.id.indexOf("#") + 1)
        .split(".")
        .at(-1),
      kind: node.kind ?? "class",
      ...(node.owner === undefined ? {} : { owner: node.owner }),
      path,
      span: node.span ?? "L1-L1",
      signature: null,
      exported: node.exported ?? false,
      origin: node.origin ?? "ast",
      body_hash: "0",
      summary_state: "pending",
      summary: null,
      crux: null,
    };
  });
  const files = [...new Set(records.map((record) => record.path))].map(
    (path) => ({
      id: path,
      name: path.split("/").at(-1),
      kind: "file",
      path,
      span: "L1-L1",
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: "0",
      summary_state: "pending",
      summary: null,
      crux: null,
    }),
  );
  const all = [...files, ...records];
  return JSON.stringify({
    meta: {
      version: 1,
      nodeCount: all.length,
      edgeCount: edges.length,
      languages: ["typescript"],
    },
    nodes: all,
    edges: edges.map(
      ([source, target, relation = "calls", confidence = "extracted"]) => ({
        source,
        target,
        relation,
        confidence,
      }),
    ),
  });
}

export const snapshotOf = (
  nodes: readonly NodeInput[],
  edges: readonly EdgeInput[] = [],
): GraftSnapshot => parseSnapshot(wiring(nodes, edges));

export const allPass: RefactorVerdict = {
  minimalAugmentation: {
    pass: true,
    evidence: "Adds only unique() at fx/C1.ts:L1.",
  },
  preservesExistingCallers: { pass: true, evidence: "No caller changes." },
  semanticCoherence: { pass: true, evidence: "Both deduplicate keys." },
  dependencyImprovement: {
    pass: true,
    evidence: "dupe gains the dependency; its loop is removed.",
  },
};

const textOf = (message: AgentMessage): string =>
  "content" in message ? contentText(message.content) : "";

export type TaskReport = {
  readonly id: string;
  readonly name?: string;
  readonly attempt: number;
  readonly status: "completed" | "failed";
  readonly output: string;
  readonly error?: string;
  readonly decisionRequired?: true;
};

const reportsIn = (context: Context): TaskReport[] =>
  userTexts(context.messages)
    .filter((text) => text.startsWith('{"type":"task_result"'))
    .map((text) => JSON.parse(text));

/** IDs of every `task_batch_complete` marker in `context`. */
const completedBatchesIn = (context: Context): string[][] =>
  userTexts(context.messages)
    .filter((text) => text.startsWith('{"type":"task_batch_complete"'))
    .map((text) => JSON.parse(text).ids);

let calls = 0;
export const call = (name: string, args: Record<string, unknown>) =>
  fauxToolCall(name, args as never, { id: `call-${++calls}` });

/** Tool results answering the latest assistant message. */
function latestResults(context: Context) {
  const results: { toolName: string; isError: boolean; text: string }[] = [];
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "toolResult") break;
    results.unshift({
      toolName: message.toolName,
      isError: message.isError,
      text: textOf(message),
    });
  }
  return results;
}


/** How one scripted lane behaves. */
export type LaneScript = {
  /** Submit a proposal built from the delivered research, or `none`. */
  readonly proposal?: (research: SearchReport[]) => Record<string, unknown>;
  /** Try to submit before any report arrived. */
  readonly earlySubmit?: boolean;
  /** This shard's researcher first tries `task` and `submit_refactor`. */
  readonly forbiddenProbe?: string;
  /** This shard's researcher waits for `gate` after signalling `entered`. */
  readonly hold?: {
    readonly shard: string;
    readonly entered: () => void;
    readonly gate: Promise<void>;
  };
  /** How many initial fresh attempts of each named shard fail, at their final answer. */
  readonly failures?: Readonly<Record<string, number>>;
  /** The proposer's answer to each failed report that asks for a decision; default `ignore`. */
  readonly failureDecision?: "retry" | "ignore";
  /** This shard's researcher calls this (waiting) tool first. */
  readonly hang?: { readonly shard: string; readonly tool: string };
  /** The proposer fails instead of researching. */
  readonly proposerFails?: boolean;
  /** Finish normally after research without using the required result tool. */
  readonly skipProposal?: boolean;
  /** Finish normally without recording the required verdict. */
  readonly skipVerdict?: boolean;
  /** The proposer's final answer after recording its structured result. */
  readonly proposerFinal?: string;
  /**
   * Native `yield` calls the proposer makes, one per turn, before it researches (or fails): each
   * pauses its node, so the lane spans at least this many more scheduler windows.
   */
  readonly beforeResearchYields?: number;
  /** Awaited by the proposer before its task call. */
  readonly barrier?: () => Promise<void>;
  /** Called when the judge's first request arrives. */
  readonly onJudge?: () => void;
  /** Called as each researcher gives its final answer. */
  readonly onResearched?: () => void;
  /** Researchers first read every assigned file. */
  readonly readAssigned?: boolean;
  readonly verdict?: RefactorVerdict;
};

/** What one scripted lane observed. */
export type LaneLog = {
  /** First request: the registered role prompt and this lane's delivered assignment. */
  proposerInput: string[];
  /** Names of the original launch's handles. */
  handles: string[];
  submitErrors: string[];
  submitted: boolean;
  forbidden: { toolName: string; isError: boolean; text: string }[];
  /** Fresh researcher starts, every attempt counted. */
  researchers: number;
  /** Fresh researcher starts per shard. */
  starts: Record<string, number>;
  /** Task decisions the proposer made, as `action id attempt`. */
  decisions: string[];
  /** Completed `yield` calls the proposer made before researching. */
  yields: number;
  /** Successful `read` results researchers received. */
  reads: number;
  judgeCalls: number;
  judgeInputs: string[][];
  /** Steered summary messages the judge read, as JSON text. */
  received: string[];
};

/** A lane ready for the batch graph, and what it observed. */
export type ScriptedLane = {
  readonly lane: CandidateLane;
  readonly log: LaneLog;
  readonly members: YamlAgent[];
  readonly respond: (context: Context) => Promise<AssistantMessage>;
};

/**
 * Script for a lane's shared provider. Dispatch by role and candidate rank in the transcript.
 */
export function scriptedLane(
  work: CandidateWork,
  sources: ReadonlyMap<string, string>,
  script: LaneScript = {},
  extraTools: readonly AgentTool[] = [],
): ScriptedLane {
  const log: LaneLog = {
    proposerInput: [],
    handles: [],
    submitErrors: [],
    submitted: false,
    forbidden: [],
    researchers: 0,
    starts: {},
    decisions: [],
    yields: 0,
    reads: 0,
    judgeCalls: 0,
    judgeInputs: [],
    received: [],
  };
  let earlyTried = false;
  let started = false;
  let yieldsLeft = script.beforeResearchYields ?? 0;
  /** The original launch's handle IDs. */
  let launched: string[] | undefined;

  const researcher = async (
    context: Context,
    prompt: string,
  ): Promise<AssistantMessage> => {
    const shard = /You are researcher (Search\d)\./.exec(prompt)?.[1] ?? "";
    const files = [
      ...(
        /Assigned files \(\d+[^)]*\):\n((?:- .*\n?)*)/.exec(prompt)?.[1] ?? ""
      ).matchAll(/^- (.*)$/gm),
    ].map((match) => match[1]!);
    const answered = context.messages.some(
      (message) => message.role === "assistant",
    );
    if (!answered) {
      log.researchers++;
      log.starts[shard] = (log.starts[shard] ?? 0) + 1;
      if (script.forbiddenProbe === shard) {
        return toolTurn(
          call("task", {
            context: "Recursive research",
            tasks: [{ task: "recurse" }],
          }),
          call("submit_refactor", {
            candidateId: work.candidate.definition.id,
            kind: "none",
            research: [],
            reason: "child",
          }),
        );
      }
      if (script.hang?.shard === shard)
        return toolTurn(call(script.hang.tool, {}));
      if (script.hold?.shard === shard) {
        script.hold.entered();
        await script.hold.gate;
      }
      if (script.readAssigned)
        return toolTurn(...files.map((path) => call("read", { path })));
    } else if (script.forbiddenProbe === shard) {
      log.forbidden.push(...latestResults(context));
    } else if (script.readAssigned) {
      log.reads += latestResults(context).filter(
        (result) => result.toolName === "read" && !result.isError,
      ).length;
    }
    // Attempts of one shard run one after another, so its latest start is this attempt.
    if ((log.starts[shard] ?? 0) <= (script.failures?.[shard] ?? 0)) {
      script.onResearched?.();
      return fauxAssistantMessage("partial", {
        stopReason: "error",
        errorMessage: "researcher crashed",
      });
    }
    const report: SearchReport = {
      shard,
      searchedFiles: files,
      status: "complete",
      report: `${shard} examined ${files.join(", ")} for rank ${work.rank}`,
    };
    script.onResearched?.();
    return fauxAssistantMessage(JSON.stringify(report));
  };

  const dispatch = async (context: Context) => {
    const texts = userTexts(context.messages);
    const prompt = texts[0] ?? "";
    const granted = new Set(getCurrentTools(context.messages).map((tool) => tool.name));
    for (const denied of ["bash", "edit", "ast_edit", "release"]) assert.ok(!granted.has(denied), denied);
    if (prompt.startsWith("You are a read-only researcher")) {
      for (const denied of ["submit_refactor", "judge_refactor", "task"]) assert.ok(!granted.has(denied), denied);
      assert.ok(granted.has("read"));
      return researcher(context, prompt);
    }
    if (prompt.startsWith("Judge the checked proposal")) {
      assert.ok(granted.has("judge_refactor") && !granted.has("submit_refactor") && !granted.has("task"));
      if (latestResults(context).some((result) => result.toolName === "judge_refactor" && !result.isError))
        return fauxAssistantMessage("verdict recorded");
      log.judgeCalls++;
      script.onJudge?.();
      log.judgeInputs.push(texts);
      log.received.push(...texts.filter((text) => text.startsWith('{"id":"summary:')));
      if (script.skipVerdict) return fauxAssistantMessage("verdict omitted");
      return toolTurn(call("judge_refactor", script.verdict ?? allPass));
    }
    assert.ok(granted.has("submit_refactor") && !granted.has("judge_refactor"));
    if (!log.proposerInput.length) log.proposerInput.push(...texts);
    if (!started) {
      if (
        latestResults(context).some(
          (result) => result.toolName === "yield" && !result.isError,
        )
      )
        log.yields++;
      if (yieldsLeft > 0) {
        yieldsLeft--;
        return toolTurn(call("yield", { reason: "letting other lanes run" }));
      }
      started = true;
      if (script.proposerFails)
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "proposer exploded",
        });
      await script.barrier?.();
      const { taskId, spec } = JSON.parse(log.proposerInput[1]!.split("\n\nTask: ").at(-1)!);
      return toolTurn(
        call("send", {
          id: `summary:${work.rank}`,
          payload: `Proposer ${work.rank}: callers reconciled; research launched`,
          handoff: "summary",
          task: taskId,
          spec,
        }),
        call("task", {}),
      );
    }
    const results = latestResults(context);
    const task = results.find((result) => result.toolName === "task");
    if (task !== undefined && launched === undefined) {
      const parsed = JSON.parse(task.text.slice(task.text.indexOf("\n") + 1));
      launched = parsed.tasks.map((handle: { id: string }) => handle.id);
      log.handles = parsed.tasks.map((handle: { name: string }) => handle.name);
      if (script.earlySubmit && !earlyTried) {
        earlyTried = true;
        return toolTurn(
          call("submit_refactor", {
            candidateId: work.candidate.definition.id,
            kind: "none",
            reason: "early",
            research: work.shards.map((shard) => ({
              shard: shard.name,
              searchedFiles: shard.files,
              status: "complete",
              report: "claimed before any report",
            })),
          }),
        );
      }
      return fauxAssistantMessage("waiting for researchers");
    }
    const submitted = results.find(
      (result) => result.toolName === "submit_refactor",
    );
    if (submitted?.isError) {
      log.submitErrors.push(submitted.text);
      return fauxAssistantMessage("waiting for researchers");
    }
    if (submitted !== undefined) {
      log.submitted = true;
      return fauxAssistantMessage(script.proposerFinal ?? "result recorded");
    }
    const reports = reportsIn(context);
    const decided = new Set(log.decisions);
    const question = reports.find(
      ({ decisionRequired, id, attempt }) =>
        decisionRequired === true &&
        !decided.has(`retry ${id} ${attempt}`) &&
        !decided.has(`ignore ${id} ${attempt}`),
    );
    if (question !== undefined) {
      const action = script.failureDecision ?? "ignore";
      log.decisions.push(`${action} ${question.id} ${question.attempt}`);
      return toolTurn(
        call("task", { action, id: question.id, attempt: question.attempt }),
      );
    }
    const ids = launched ?? [];
    if (
      !completedBatchesIn(context).some((batch) =>
        ids.every((id) => batch.includes(id)),
      )
    )
      return fauxAssistantMessage("waiting for researchers");
    // Only valid completed reports are evidence; every other shard is missing.
    const research: SearchReport[] = reports.flatMap((report) => {
      if (report.status !== "completed") return [];
      try {
        return [JSON.parse(report.output) as SearchReport];
      } catch {
        return [];
      }
    });
    if (script.skipProposal) return fauxAssistantMessage("proposal omitted");
    const missing = work.shards
      .map((shard) => shard.name)
      .filter(
        (name) =>
          !research.some(
            (record) => record.shard === name && record.status === "complete",
          ),
      );
    const args =
      script.proposal === undefined || missing.length > 0
        ? {
            candidateId: work.candidate.definition.id,
            kind: "none",
            research,
            reason:
              missing.length > 0
                ? `Incomplete: ${missing.join(", ")}`
                : "No duplicated responsibility found.",
          }
        : script.proposal(research);
    return toolTurn(call("submit_refactor", args));
  };

  return { lane: { work, readSource: async (path) => sources.get(path), research: extraTools }, log, members: [], respond: dispatch };
}

/** Run the actual lane builder on a temporary CopyTree seed and one transcript-dispatched ladder. */
export async function runScriptedBatch(
  options: Omit<Parameters<typeof runCandidateBatch>[0], "root" | "collection" | "ladder" | "lanes"> & { lanes: readonly ScriptedLane[] },
  signal?: AbortSignal,
) {
  const { lanes, observer = new tracer.DummyTracer() } = options;
  const byRank = new Map(lanes.map((script) => [script.lane.work.rank, script]));
  const ladder = await offlineLadder((ctx) => {
    const rank = userTexts(ctx.messages).map((text) => /Candidate \(rank (\d+)\):/.exec(text)?.[1]).find(Boolean);
    const script = byRank.get(Number(rank));
    assert.ok(script, `missing candidate rank ${rank} in transcript`);
    return script.respond(ctx);
  });
  await using owned = new AsyncDisposableStack();
  const root = await mkdtemp(join(tmpdir(), "yak-batch-"));
  owned.defer(() => rm(root, { recursive: true, force: true }));
  for (const path of options.snapshot.files) {
    const source = await lanes[0]!.lane.readSource(path);
    if (source === undefined) continue;
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  const collection = owned.adopt(await tools.ToolCollection.create(root, {
    native: await copyTreeNative(), policy: tools.LockPolicy, sandbox: "always",
  }), (collection) => collection.close());
  return await runCandidateBatch({
    ...options, root, collection, ladder, lanes: lanes.map(({ lane }) => lane),
    observer: {
      startRun(workflow) {
        if (workflow.getNode(graph.NodeId.create("FinalizeBatch"))) {
          for (const { members, lane } of lanes) if (!members.length) {
            for (const role of ["Proposer", "Judge"]) {
              const member = workflow.getNode(graph.NodeId.create(`${role}:${lane.work.rank}`))?.state;
              assert.ok(member instanceof agent.JuncoAgent);
              members.push(member);
            }
          }
        }
        return observer.startRun(workflow);
      },
    },
  }, signal);
}

/** A barrier every `size` callers enter before any of them continues. */
export function barrier(size: number) {
  let entered = 0;
  let peak = 0;
  const all = Promise.withResolvers<void>();
  return {
    enter: async () => {
      entered++;
      peak = Math.max(peak, entered);
      if (entered === size) all.resolve();
      await all.promise;
    },
    peak: () => peak,
  };
}
