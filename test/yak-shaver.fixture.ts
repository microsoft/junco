// Offline scaffolding for test/yak-shaver.test.ts: in-memory Graft graphs and real JuncoAgent lanes
// on faux providers, driven by the example's real batch graph and native task tool.

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  type CandidateLane,
  type CandidateWork,
  type GraftSnapshot,
  ProposalRecorder,
  parseSnapshot,
  type RefactorVerdict,
  type SearchReport,
  VerdictRecorder,
} from "../examples/yak-shaver/yak-shaver.ts";
import { agent as agentApi, tools as toolsApi } from "../src/index.ts";
import { nativeOptions } from "./support.ts";

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

export const userTexts = (context: Context): string[] =>
  context.messages.filter((message) => message.role === "user").map(textOf);

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
  userTexts(context)
    .filter((text) => text.startsWith('{"type":"task_result"'))
    .map((text) => JSON.parse(text));

/** IDs of every `task_batch_complete` marker in `context`. */
const completedBatchesIn = (context: Context): string[][] =>
  userTexts(context)
    .filter((text) => text.startsWith('{"type":"task_batch_complete"'))
    .map((text) => JSON.parse(text).ids);

let calls = 0;
export const call = (name: string, args: Record<string, unknown>) =>
  fauxToolCall(name, args as never, { id: `call-${++calls}` });
export const toolUse = (...items: ToolCall[]) =>
  fauxAssistantMessage(items, { stopReason: "toolUse" });

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

const readParameters = Type.Object({ path: Type.String() });

/** A tool that returns in-memory source; researchers have it, nothing calls it unscripted. */
export function sourceTool(
  sources: ReadonlyMap<string, string>,
): AgentTool<typeof readParameters, undefined> {
  return {
    name: "read",
    label: "read",
    description: "Read an in-memory source file.",
    parameters: readParameters,
    execute: async (_id, { path }) => ({
      content: [{ type: "text", text: sources.get(path) ?? "missing" }],
      details: undefined,
    }),
  };
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
  /** Names of the original launch's handles. */
  handles: string[];
  submitErrors: string[];
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
};

/** A lane ready for the batch graph, and what it observed. */
export type ScriptedLane = {
  readonly lane: CandidateLane;
  readonly log: LaneLog;
};

/**
 * A real proposer/judge lane on faux providers. The proposer's provider also serves its native task
 * children (they inherit its model), so one dispatcher answers both roles from the request context.
 */
export async function scriptedLane(
  work: CandidateWork,
  snapshot: GraftSnapshot,
  sources: ReadonlyMap<string, string>,
  script: LaneScript = {},
  extraTools: readonly AgentTool[] = [],
): Promise<ScriptedLane> {
  const log: LaneLog = {
    handles: [],
    submitErrors: [],
    forbidden: [],
    researchers: 0,
    starts: {},
    decisions: [],
    yields: 0,
    reads: 0,
    judgeCalls: 0,
    judgeInputs: [],
  };
  const proposal = new ProposalRecorder({
    snapshot,
    work,
    readSource: async (path) => sources.get(path),
  });
  const verdict = new VerdictRecorder();
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
        return toolUse(
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
        return toolUse(call(script.hang.tool, {}));
      if (script.hold?.shard === shard) {
        script.hold.entered();
        await script.hold.gate;
      }
      if (script.readAssigned)
        return toolUse(...files.map((path) => call("read", { path })));
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
    const texts = userTexts(context);
    const prompt = texts[0] ?? "";
    if (prompt.startsWith("You are a read-only researcher"))
      return researcher(context, prompt);
    if (!started) {
      if (
        latestResults(context).some(
          (result) => result.toolName === "yield" && !result.isError,
        )
      )
        log.yields++;
      if (yieldsLeft > 0) {
        yieldsLeft--;
        return toolUse(call("yield", { reason: "letting other lanes run" }));
      }
      started = true;
      if (script.proposerFails)
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "proposer exploded",
        });
      await script.barrier?.();
      return toolUse(call("task", {}));
    }
    const results = latestResults(context);
    const task = results.find((result) => result.toolName === "task");
    if (task !== undefined && launched === undefined) {
      const parsed = JSON.parse(task.text.slice(task.text.indexOf("\n") + 1));
      launched = parsed.tasks.map((handle: { id: string }) => handle.id);
      log.handles = parsed.tasks.map((handle: { name: string }) => handle.name);
      if (script.earlySubmit && !earlyTried) {
        earlyTried = true;
        return toolUse(
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
    if (submitted !== undefined)
      return fauxAssistantMessage(script.proposerFinal ?? "result recorded");
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
      return toolUse(
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
    return toolUse(call("submit_refactor", args));
  };

  const proposerOptions = await nativeOptions(
    Array.from({ length: 200 }, () => dispatch),
  );
  const judgeOptions = await nativeOptions([
    (context: Context) => {
      log.judgeCalls++;
      script.onJudge?.();
      // The judge's input is the staged prompt its callback composed.
      log.judgeInputs.push(userTexts(context));
      if (script.skipVerdict) return fauxAssistantMessage("verdict omitted");
      return toolUse(call("judge_refactor", script.verdict ?? allPass));
    },
    fauxAssistantMessage("verdict recorded"),
  ]);
  const read = sourceTool(sources);
  const proposer = await agentApi.JuncoAgent.fromResolved({
    ...proposerOptions.options,
    systemPrompt: "analyst",
    tools: [
      read,
      ...extraTools,
      ...(script.beforeResearchYields === undefined
        ? []
        : [new toolsApi.YieldTool()]),
      new toolsApi.TaskTool(),
      proposal.tool,
    ],
  });
  const judge = await agentApi.JuncoAgent.fromResolved({
    ...judgeOptions.options,
    systemPrompt: "judge",
    tools: [read, verdict.tool],
  });
  return { lane: { work, proposer, judge, proposal, verdict }, log };
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
