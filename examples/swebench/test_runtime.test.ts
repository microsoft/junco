// Regression tests for the shared workflow's consumer-visible boundaries: model routing, the container
// shell, the wf.yml coordination protocol (real topology and code nodes, scripted participants) and the
// sandbox operations on real containers.
import { afterAll, beforeAll, describe as group, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AgentTool, PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TSchema } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, JuncoGraph, MockAgent, type MockRun, schedules, syntax, tracer } from "junco";
import { grafanaUrl } from "../benchmark-telemetry.ts";
import * as cb from "./wf.ts";
import {
  BLOCKED_DEFAULTS,
  cancelBranch,
  checkDocument,
  checkLadder,
  checkThinking,
  containerBash,
  describe,
  guardedModels,
  sandboxBash,
  sandboxOps,
  teeRecorder,
} from "./run-workflow.ts";

const IMAGE = "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const running = (id: string) => docker("inspect", "-f", "{{.State.Running}}", id).stdout.trim() === "true";
const owned: string[] = [];
const start = () => {
  const id = docker("run", "-d", "--network", "none", IMAGE, "tail", "-f", "/dev/null").stdout.trim();
  owned.push(id);
  return id;
};
const sh = (id: string, command: string) => docker("exec", "--workdir", "/testbed", id, "/bin/bash", "-c", command);
afterAll(() => {
  for (const id of owned) docker("rm", "-f", id);
});

function message(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason,
    ...(stopReason === "stop" ? {} : { errorMessage: `${stopReason} in test` }),
    timestamp: Date.now(),
  };
}

let decoy: ReturnType<typeof Bun.serve>;
let hits = 0;
let decoyModels: ModelRuntime;
beforeAll(async () => {
  decoy = Bun.serve({ port: 0, fetch: () => { hits++; return new Response("{}", { status: 500 }); } });
  const dir = mkdtempSync(join(tmpdir(), "decoy-agent-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ decoy: { type: "api_key", key: "local" } }));
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 4096 });
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { decoy: {
    baseUrl: `http://127.0.0.1:${decoy.port}/v1`, api: "openai-completions", models: [model("m"), model("other")],
  } } }));
  decoyModels = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "store.json") });
});
afterAll(() => decoy.stop(true));

test("a ladder may only use the benchmark models, at thinking levels their catalog entry supports", () => {
  const sonnet = schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5" });
  expect(() => checkLadder({ ...sonnet, xhigh: { model: "github-copilot/claude-opus-5.5" } })).not.toThrow();
  expect(() => checkLadder({ ...sonnet, xhigh: { model: "decoy/m" } })).toThrow(/xhigh/);
  // The decoy model has no reasoning, so only "off" (an omitted level) is supported.
  expect(() => checkThinking(decoyModels, schedules.uniformLadder({ model: "decoy/m" }))).not.toThrow();
  expect(() => checkThinking(decoyModels, { ...schedules.uniformLadder({ model: "decoy/m" }), xhigh: { model: "decoy/m", thinking: "high" } })).toThrow(/xhigh.*high/);
});

test("a guarded agent sends no request to a model other than its role's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const ladder = schedules.uniformLadder({ model: "decoy/m" });
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const document = syntax.parse(`graph:\n  nodes:\n    Worker:\n      prompt: Say hi.\n      tool_block: ${JSON.stringify(BLOCKED_DEFAULTS)}\n  edges:\n    - from: Worker\n      to: $sink\n      schema: {}\n`);
  const execution = await JuncoGraph.fromYaml(document, {
    cwd: dir, models: decoyModels, scheduler: () => schedules.parallel(), tracer: new tracer.DummyTracer(),
    createAgent: (spec) => syntax.createJuncoAgent(spec, ladder, guardedModels(decoyModels, log, "Worker", "decoy/other")),
  });
  let value: unknown;
  try {
    await execution.run();
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag === "Some") value = terminal.value;
  } catch {
    // A refused request may surface as a failed run; the assertions below decide.
  } finally {
    await execution.graph.close();
  }
  expect(hits).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("");
  expect(() => syntax.finalText(value, "Worker")).toThrow();
});

test("container bash keeps argument boundaries, output and nonzero exit codes", async () => {
  const bash = containerBash(start(), () => {});
  const result = await bash.execute("t", { command: `printf '%s|' 'a b' "c  d" 'it'"'"'s'; echo err >&2; exit 7` });
  const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
  expect(text).toContain("a b|c  d|it's|");
  expect(text).toContain("err");
  expect("isError" in result && result.isError).toBe(true);
  const structured = result.structuredContent;
  expect(structured && typeof structured === "object" && "exit_code" in structured ? structured.exit_code : undefined).toBe(7);
});

test("a timed-out command stops its own container and leaves other containers running", async () => {
  const mine = start();
  const sentinel = start();
  let fatal: Error | undefined;
  const bash = containerBash(mine, (reason) => { fatal = reason; });
  await expect(bash.execute("t", { command: "sleep 60 & sleep 60", timeout: 1 })).rejects.toThrow(/timed out/);
  expect(fatal?.message).toMatch(/timeout/);
  expect(running(mine)).toBe(false);
  expect(running(sentinel)).toBe(true);
}, 60_000);

// ---- Coordination: the real wf.yml topology and code nodes, with every agent but Planner/Draft (a MockAgent)
// replaced by a scripted code node.

/** The root agents the coordination scenarios script as code nodes; Planner/Draft stays a real (mock) agent. */
const AGENTS = ["Lead", "Trace", "Reproduce", "Contracts", "CandidateA", "CandidateB", "Integrator", "Verifier"] as const;
type Fake = {
  files: Record<string, string>;
  log: string[];
  cancels: string[];
  captures: string[];
  saved: Map<string, string>;
  /** Set by `explode-reset`: every later reset fails. */
  resetFails: boolean;
  /** The run's signal; `abort-run` aborts it. */
  abort: AbortController;
  host: cb.Host;
};
/** A participant's run: wait `columns` scheduler columns (and until `until()`), then `act` and return `text`. */
type Script = { text?: string; stop?: AssistantMessage["stopReason"]; columns?: number; until?: () => boolean; act?: (h: Fake) => void };

const diff = (tag: string) => `diff --git a/pkg/m.py b/pkg/m.py\n--- a/pkg/m.py\n+++ b/pkg/m.py\n@@ -1 +1 @@\n-x\n+${tag}\n`;
const LEAD = "## Trace\nfind the cause\n## Reproduce\nreproduce it\n## Contracts\nbuild the matrix";
const plan = (checks: { kind: string; name: string; command: string }[]) =>
  `Plan:\n\`\`\`json\n${JSON.stringify({
    root_cause: "pkg/m.py:f drops a case",
    interfaces: ["f(x) keeps its signature"],
    behavior_matrix: ["f(1) == 2"],
    checks,
    candidates: {
      A: { approach: "guard", steps: [{ target: "pkg/m.py:f", change: "handle the case", check: "repro" }] },
      B: { approach: "rewrite", steps: [{ target: "pkg/m.py:f", change: "rewrite the branch", check: "repro" }] },
    },
  })}\n\`\`\``;
const CHECKS = [
  { kind: "reproduction", name: "repro", command: "repro" },
  { kind: "regression", name: "regress", command: "regress" },
];

/** In-memory sandboxes: a role's state is its patch (or untracked files); checks pass or fail from its FIX/BREAK tags. */
function fake(): Fake {
  const files: Record<string, string> = Object.fromEntries(cb.ROLES.map((role) => [role, ""]));
  const h: Fake = {
    files,
    log: [],
    cancels: [],
    captures: [],
    saved: new Map(),
    resetFails: false,
    abort: new AbortController(),
    host: {
      problem: { instance_id: "o__r-1", repo: "o/r", base_commit: "0".repeat(40), problem_statement: "f(1) is wrong" },
      sandbox: {
        run: async (role, command) => {
          h.log.push(`run:${role}:${command}`);
          const patch = files[role];
          if (command === "repro") return patch.includes("FIX") ? { exit_code: 0, output: "fixed" } : { exit_code: 1, output: `${cb.REPRODUCED}: f(1) == 3` };
          if (command === "regress") return patch.includes("BREAK") ? { exit_code: 1, output: "1 failed" } : { exit_code: 0, output: "1 passed" };
          if (command === "import-error") return { exit_code: 1, output: "ImportError: No module named pkg" };
          if (command === "missing-class")
            return { exit_code: 1, output: "AttributeError: type object 'MigrationLoaderTests' has no attribute 'test_missing'" };
          if (command === "slow") {
            // Pending across many event-loop turns, so a busy Draft or CheckPlan re-activation would show.
            for (let turn = 0; turn < 50; turn++) await setImmediate();
            return { exit_code: 0, output: "1 passed" };
          }
          if (command === "write-marker") {
            files[role] += "?? marker\n"; // an untracked file in /testbed
            return { exit_code: 0, output: "" };
          }
          if (command === "no-marker") return files[role].includes("marker") ? { exit_code: 1, output: "marker present" } : { exit_code: 0, output: "" };
          if (command === "explode") throw new Error("docker exec failed");
          if (command === "explode-reset") {
            h.resetFails = true;
            throw new Error("docker exec failed");
          }
          if (command === "abort-run") {
            h.abort.abort(new Error("run cancelled"));
            return { exit_code: 0, output: "" };
          }
          return { exit_code: 127, output: "command not found" };
        },
        capture: async (role) => {
          h.captures.push(role);
          return files[role];
        },
        apply: async (role, patch) => {
          files[role] = patch;
          return { exit_code: 0, output: "" };
        },
        reset: async (role) => {
          if (h.resetFails) throw new Error("reset failed");
          files[role] = "";
        },
      },
      save: (name, data) => {
        h.log.push(`save:${name}`);
        h.saved.set(name, data);
        return `mem/${name}`;
      },
      cancel: async (branch) => {
        h.cancels.push(branch);
        h.log.push(`cancel:${branch}`);
        return [];
      },
    },
  };
  return h;
}

function participant(id: string, script: Script, h: Fake): syntax.DeterministicNode<cb.Context> {
  return ({ policy }) => {
    let started = false;
    let done = false;
    return {
      state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
        yield [];
        started = true;
        h.log.push(`${id}:start`);
        for (let i = 0; i < (script.columns ?? 0); i++) yield [];
        while (script.until !== undefined && !script.until()) yield [];
        script.act?.(h);
        done = true;
        h.log.push(`${id}:done`);
        return message(script.text ?? `${id} report`, script.stop ?? "stop");
      }, policy),
      // Like an agent node: available once triggered, then resumable until it returns.
      is_available: (_view, triggered) => !done && (started || triggered),
    };
  };
}

/** cb.document with every agent node but Planner/Draft, at any depth, turned into a code node of the same id and trigger. */
function scriptedDocument(): syntax.JuncoDocument {
  const document = structuredClone(cb.document);
  const script = (level: syntax.GraphSpec, prefix: string) => {
    for (const [id, node] of Object.entries(level.nodes)) {
      if (node.kind === "graph") script(node.graph, `${prefix}${id}/`);
      else if (node.kind !== "code" && node.kind !== "emit" && `${prefix}${id}` !== "Planner/Draft")
        level.nodes[id] = { kind: "code", description: node.description, trigger: node.trigger };
    }
  };
  script(document.graph, "");
  return document;
}

type YamlMock = MockAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;
/** Planner/Draft: a mock agent that logs every request it is asked for. */
class Draft extends MockAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown> {
  constructor(runs: readonly MockRun[], readonly h: Fake) {
    super({ runs });
  }
  override next(...args: Parameters<YamlMock["next"]>) {
    this.h.log.push("Draft:next");
    return super.next(...args);
  }
}
const settled = (text: string): MockRun["frames"][number] => ({ step: { kind: "settled", message: message(text) } });
/** One Draft run per entry: a plan text settles at once; frames are used verbatim. */
const drafts = (...runs: (string | MockRun["frames"])[]): MockRun[] =>
  runs.map((run) => ({
    frames: typeof run === "string" ? [settled(run)] : run,
    interrupted: { step: { kind: "settled", message: message("aborted", "aborted") } },
  }));
/** The user text of each Draft request after the first: the correction prompts CheckPlan staged. */
const corrections = (agent: Draft): string[] =>
  agent.requests.slice(1).map(({ messages }) => {
    const last = messages.at(-1);
    return last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map((c) => ("text" in c ? c.text : "")).join("")) : "";
  });

async function scenario(
  overrides: Partial<Record<(typeof AGENTS)[number], Script>> = {},
  runs: MockRun[] = drafts(plan(CHECKS)),
  code: (h: Fake) => Record<string, syntax.DeterministicNode<cb.Context>> = () => ({}),
  recorder?: tracer.ProfileRecorder<string>,
) {
  const h = fake();
  const scripts: Record<string, Script> = {
    Lead: { text: LEAD },
    CandidateA: { act: (f) => { f.files.candidateA = diff("FIX A"); } },
    CandidateB: { act: (f) => { f.files.candidateB = diff("FIX B"); } },
    Verifier: { text: "ran every check\nVERDICT: PASS" },
    ...overrides,
  };
  const participants = Object.fromEntries(AGENTS.map((id) => [id, participant(id, scripts[id] ?? {}, h)]));
  const draft = new Draft(runs, h);
  const execution = await JuncoGraph.fromYaml<cb.Context>(scriptedDocument(), {
    cwd: tmpdir(),
    scheduler: cb.scheduler,
    code: { ...cb.code, ...participants, ...code(h) },
    available: cb.plannerAvailability,
    createAgent: async (spec) => {
      if (spec.path !== "Planner/Draft") throw new Error(`unexpected agent ${spec.path}`);
      return draft;
    },
    context: { ...h.host, race: {} },
    signal: h.abort.signal,
    tracer: new tracer.DummyTracer(),
    ...(recorder === undefined ? {} : { recorder }),
  });
  let report: string | undefined;
  let error: string | undefined;
  try {
    await execution.run();
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag === "Some") report = syntax.finalText(terminal.value, "Finish");
  } catch (failure) {
    error = describe(failure);
  } finally {
    await execution.graph.close();
  }
  const at = (entry: string) => h.log.indexOf(entry);
  const count = (entry: string) => h.log.filter((e) => e === entry).length;
  return { ...h, report, error, at, count, draft, corrections: corrections(draft) };
}

group("coordination", () => {
  test("the planner starts only after every evidence report has settled", async () => {
    const run = await scenario({ Contracts: { columns: 6 } });
    expect(run.error).toBeUndefined();
    for (const worker of ["Trace", "Reproduce", "Contracts"]) expect(run.at("Draft:next")).toBeGreaterThan(run.at(`${worker}:done`));
    expect(run.at("Contracts:done")).toBeGreaterThan(run.at("Trace:done"));
  });

  test("an abnormal evidence report or a duplicated assignment fails the run before planning", async () => {
    const abnormal = await scenario({ Trace: { stop: "error" } });
    expect(abnormal.error).toMatch(/Trace did not finish normally/);
    expect(abnormal.at("Draft:next")).toBe(-1);
    const duplicated = await scenario({ Lead: { text: `${LEAD}\n## Trace\nagain` } });
    expect(duplicated.error).toMatch(/Trace assignment twice/);
    expect(duplicated.at("Trace:start")).toBe(-1);
  });

  const MISSING_REGRESSION = { kind: "regression", name: "loader", command: "missing-class" };

  test("a plan with a nonexistent regression test is corrected from its observed failure before any patch work", async () => {
    const run = await scenario({}, drafts(plan([CHECKS[0], MISSING_REGRESSION]), plan(CHECKS)));
    expect(run.error).toBeUndefined();
    expect(run.report).toBeDefined();
    expect(run.draft.requests).toHaveLength(2);
    expect(run.corrections[0]).toContain("Correction turn 1 of 3");
    expect(run.corrections[0]).toContain("No regression check survived the baseline run");
    expect(run.corrections[0]).toContain("missing-class");
    expect(run.corrections[0]).toContain("MigrationLoaderTests");
    expect(run.at("CandidateA:start")).toBeGreaterThan(run.at("save:planning/attempt-2/acceptance.json"));
    expect(run.saved.get("acceptance.json")).toBe(run.saved.get("planning/attempt-2/acceptance.json"));
    expect(run.saved.get("plan.md")).toBe(plan(CHECKS));
  });

  test("three correction turns are allowed and a valid fourth draft is accepted without a fifth request", async () => {
    const run = await scenario({}, drafts("no plan here", plan([CHECKS[0], MISSING_REGRESSION]), plan([CHECKS[0]]), plan(CHECKS)));
    expect(run.error).toBeUndefined();
    expect(run.report).toBeDefined();
    expect(run.draft.requests).toHaveLength(4);
    expect(run.corrections.map((text) => text.split(".")[0])).toEqual([1, 2, 3].map((n) => `Correction turn ${n} of 3`));
    expect(run.corrections[0]).toContain("the Planner returned no");
    expect(run.corrections[2]).toContain("The plan has no regression check");
  });

  test("a plan still rejected after three correction turns fails the run before any patch work", async () => {
    // No reclassification: a reproduction that passes and a regression that fails stay excluded, never swapped.
    const swapped = plan([
      { kind: "reproduction", name: "swapped-r", command: "regress" },
      { kind: "regression", name: "swapped-g", command: "repro" },
    ]);
    const importError = plan([{ kind: "reproduction", name: "repro", command: "import-error" }, CHECKS[1]]);
    const run = await scenario({}, drafts("```json\n{not json\n```", importError, swapped, plan([CHECKS[0], MISSING_REGRESSION])));
    expect(run.error).toMatch(/plan rejected after 3 correction turns: No regression check survived/);
    expect(run.draft.requests).toHaveLength(4);
    expect(run.at("CandidateA:start")).toBe(-1);
    expect(run.at("CandidateB:start")).toBe(-1);
    expect(run.at("save:plan.md")).toBe(-1);
    expect(run.files.canonical).toBe("");
    for (const attempt of [1, 2, 3, 4]) {
      expect(run.saved.has(`planning/attempt-${attempt}/plan.md`)).toBe(true);
      expect(run.saved.has(`planning/attempt-${attempt}/rejection.txt`)).toBe(true);
      expect(run.saved.has(`planning/attempt-${attempt}/acceptance.json`)).toBe(attempt > 1); // a malformed plan ran nothing
    }
    const excluded = (attempt: number) => JSON.parse(run.saved.get(`planning/attempt-${attempt}/acceptance.json`)!).excluded;
    expect(excluded(2)).toEqual([{ name: "repro", reason: `did not reproduce on the baseline (exit 1, no ${cb.REPRODUCED})` }]);
    expect(excluded(3)).toEqual([
      { name: "swapped-r", reason: `did not reproduce on the baseline (exit 0, no ${cb.REPRODUCED})` },
      { name: "swapped-g", reason: "fails on the baseline (exit 1)" },
    ]);
    expect(run.corrections[1]).toContain("ImportError: No module named pkg");
  });

  test("a slow checker validates each distinct draft once and a native yield costs no correction turn", async () => {
    const bad = plan([{ kind: "reproduction", name: "repro", command: "import-error" }, { kind: "regression", name: "slow", command: "slow" }]);
    const yielding: MockRun["frames"] = [
      { step: { kind: "yield", reasons: [{ kind: "tool", toolCallId: "y1", toolName: "yield", reason: "thinking" }] } },
      settled(bad),
    ];
    const run = await scenario({}, drafts(yielding, bad, plan([CHECKS[0], { kind: "regression", name: "slow", command: "slow" }])));
    expect(run.error).toBeUndefined();
    expect(run.draft.requests).toHaveLength(4); // yield + settle, then one request per correction
    expect(run.corrections.filter((text) => text.startsWith("Correction turn"))).toEqual([
      expect.stringContaining("Correction turn 1 of 3"),
      expect.stringContaining("Correction turn 2 of 3"),
    ]);
    // The identical second draft is a new draft: attempt 2, not a repeat of attempt 1.
    expect(run.saved.get("planning/attempt-2/plan.md")).toBe(bad);
    expect(run.saved.has("planning/attempt-4/plan.md")).toBe(false);
    expect(run.count("run:canonical:slow")).toBe(3);
  });

  test("baseline checks each start from a clean tree", async () => {
    const marker = [
      CHECKS[0],
      { kind: "regression", name: "writes", command: "write-marker" },
      { kind: "regression", name: "clean", command: "no-marker" },
    ];
    const run = await scenario({}, drafts(plan(marker)));
    expect(run.draft.requests).toHaveLength(1);
    expect(JSON.parse(run.saved.get("acceptance.json")!).checks.map((c: { name: string }) => c.name)).toEqual(["repro", "writes", "clean"]);
  });

  test("a sandbox, reset or cancellation failure fails the run at once instead of costing a correction", async () => {
    const failing = (command: string) => plan([CHECKS[0], { kind: "regression", name: "boom", command }]);
    const dirty = await scenario({ Contracts: { act: (f) => { f.files.canonical = "?? stray\n"; } } });
    expect(dirty.error).toMatch(/canonical \/testbed changed before plan validation/);
    const exploded = await scenario({}, drafts(failing("explode"), plan(CHECKS)));
    expect(exploded.error).toMatch(/docker exec failed/);
    const both = await scenario({}, drafts(failing("explode-reset"), plan(CHECKS)));
    expect(both.error).toMatch(/plan check boom and the canonical reset both failed: docker exec failed; reset failed/);
    const cancelled = await scenario({}, drafts(failing("abort-run"), plan(CHECKS)));
    expect(cancelled.error).toMatch(/run cancelled/);
    for (const run of [dirty, exploded, both, cancelled]) {
      expect(run.draft.requests).toHaveLength(1);
      expect(run.at("CandidateA:start")).toBe(-1);
    }
  });

  test("Dispatch refuses a plan that CheckPlan did not accept", async () => {
    const run = await scenario({}, drafts(plan(CHECKS)), (h) => ({ CheckPlan: participant("CheckPlan", { text: plan(CHECKS) }, h) }));
    expect(run.error).toMatch(/Planner->Dispatch is not the plan CheckPlan accepted/);
    expect(run.at("CandidateA:start")).toBe(-1);
    expect(run.at("save:plan.md")).toBe(-1);
  });

  test("an invalid early contender loses to a valid later one", async () => {
    const run = await scenario({
      CandidateA: { act: (f) => { f.files.candidateA = diff("FIX A BREAK"); } },
      CandidateB: { columns: 4, act: (f) => { f.files.candidateB = diff("FIX B"); } },
    });
    expect(run.error).toBeUndefined();
    expect(run.at("CandidateA:done")).toBeLessThan(run.at("CandidateB:done"));
    expect(run.files.canonical).toBe(diff("FIX B"));
    expect(run.count("Integrator:start")).toBe(1);
    expect(JSON.parse(run.saved.get("tournament.json") ?? "{}").verdicts.map((v: cb.Verdict) => [v.branch, v.valid])).toEqual([["A", false], ["B", true]]);
    expect(run.report).toContain("Selected: candidate B");
  });

  test("simultaneous valid verdicts hand off exactly once, in declaration order", async () => {
    const run = await scenario();
    expect(run.error).toBeUndefined();
    expect(run.files.canonical).toBe(diff("FIX A"));
    expect(run.cancels).toEqual(["B"]);
    expect(run.count("Integrator:start")).toBe(1);
    expect(JSON.parse(run.saved.get("tournament.json") ?? "{}").winner).toBe("A");
  });

  test("two invalid contenders end the run without a winner or an applied patch", async () => {
    const run = await scenario({
      CandidateA: { act: (f) => { f.files.candidateA = diff("FIX A BREAK"); } },
      CandidateB: { stop: "aborted" },
    });
    expect(run.error).toMatch(/no valid candidate: A: failed acceptance checks: regress.*B: CandidateB did not finish normally/);
    expect(run.at("Integrator:start")).toBe(-1);
    expect(run.files.canonical).toBe("");
  });

  test("a contender still running when the gate decides is cancelled once and never validated", async () => {
    let h: Fake | undefined;
    const run = await scenario({
      CandidateA: { act: (f) => { h = f; f.files.candidateA = diff("FIX A"); } },
      CandidateB: { until: () => h?.cancels.includes("B") ?? false, stop: "aborted" },
    });
    expect(run.error).toBeUndefined();
    expect(run.at("cancel:B")).toBeLessThan(run.at("CandidateB:done"));
    expect(run.cancels).toEqual(["B"]);
    expect(run.captures).not.toContain("candidateB");
    expect(run.files.canonical).toBe(diff("FIX A"));
    expect(run.count("Integrator:start")).toBe(1);
  });

  test("verification may not change the deliverable", async () => {
    const run = await scenario({ Verifier: { text: "VERDICT: PASS", act: (f) => { f.files.canonical += "+scratch\n"; } } });
    expect(run.error).toMatch(/deliverable changed during verification/);
    expect(run.report).toBeUndefined();
  });

  test("a change by the integrator that breaks a frozen check fails the final acceptance", async () => {
    const run = await scenario({ Integrator: { act: (f) => { f.files.canonical = diff("FIX A BREAK"); } } });
    expect(run.error).toMatch(/final acceptance checks failed: regress/);
    expect(run.report).toBeUndefined();
  });
});

test("the telemetry tee records the nested workflow into every sink and reports a failing sink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tee-"));
  const kept = join(dir, "profile.jsonl");
  // A sink whose writes fail (missing directory) must not stop the other sink or go unreported.
  const recorder = teeRecorder([new tracer.JsonlRecorder({ path: kept }), new tracer.JsonlRecorder({ path: join(dir, "missing", "live.jsonl") })]);
  const run = await scenario({}, undefined, undefined, recorder);
  expect(run.error).toBeUndefined();
  await expect(recorder.close()).rejects.toThrow(/profile recording failed/);
  const nodes = readFileSync(kept, "utf8").trim().split("\n").map((line) => JSON.parse(line).node);
  expect(nodes).toContain("Planner/Draft");
  expect(nodes).toContain("Finish");
});

test("GRAFANA_URL is normalized and rejects anything but a credential-free http(s) URL", () => {
  expect(grafanaUrl("http://localhost:8000/")).toBe("http://localhost:8000");
  expect(grafanaUrl("https://host/grafana//")).toBe("https://host/grafana");
  for (const value of ["", " ", "not-a-url", "file:///tmp/grafana", "http://name:secret@localhost:8000", "http://localhost:8000?token=secret", "http://localhost:8000#secret"])
    expect(() => grafanaUrl(value)).toThrow("GRAFANA_URL must be");
});

// ---- Offline permission checks of nested pairs.

type Workflow = Parameters<typeof checkDocument>[0];
type Spec = Record<string, unknown>;
/** cb with CandidateA replaced by a nested graph of `nodes` and SANDBOX's CandidateA entry replaced by `sandbox`. */
function nestedA(nodes: Record<string, Spec>, sandbox: Record<string, string>, extra: Partial<Workflow> = {}): Workflow {
  const document = structuredClone(cb.document);
  const { CandidateA, ...rest } = cb.SANDBOX;
  document.graph.nodes.CandidateA = {
    kind: "graph",
    trigger: document.graph.nodes.CandidateA.trigger,
    graph: { name: "Candidate", nodes, edges: [] },
  } as unknown as syntax.NodeSpec;
  return { ...cb, document, SANDBOX: { ...rest, ...sandbox } as Workflow["SANDBOX"], ...extra };
}
const shell = { trigger: "$source~>Worker", tools: ["bash"] };
const helper = { trigger: "$source~>Helper" };

test("nested pairs are checked at every depth against the runtime's permissions and sandboxes", () => {
  expect(() => checkDocument(cb)).not.toThrow();
  const legal = { Helper: helper, Worker: shell };
  expect(() => checkDocument(nestedA(legal, { "CandidateA/Worker": "candidateA" }))).not.toThrow();
  const deep = { Inner: { kind: "graph", trigger: "$source~>Inner", graph: { name: "Candidate", nodes: legal, edges: [] } } };
  expect(() => checkDocument(nestedA(deep, { "CandidateA/Inner/Worker": "candidateA" }))).not.toThrow();
  const rejects = (workflow: Workflow, error: RegExp) => expect(() => checkDocument(workflow)).toThrow(error);
  rejects(nestedA({ ...legal, Mystery: { kind: "code", trigger: "$source~>Mystery" } }, { "CandidateA/Worker": "candidateA" }), /CandidateA\/Mystery has no exported definition Mystery/);
  rejects(nestedA(legal, {}), /CandidateA\/Worker uses bash but has no sandbox/);
  rejects(nestedA(legal, { CandidateA: "candidateA", "CandidateA/Worker": "candidateA" }), /SANDBOX\.CandidateA must bind a bash-using agent path/);
  rejects(nestedA({ ...legal, Helper: { ...helper, tools: ["read"] } }, { "CandidateA/Worker": "candidateA" }), /CandidateA\/Helper: tool read is not permitted/);
  rejects(nestedA({ ...legal, Helper: { ...helper, mcp: ["github"] } }, { "CandidateA/Worker": "candidateA" }), /CandidateA\/Helper: mcp and skills/);
  rejects(nestedA({ ...legal, Helper: { ...helper, skills: ["x"] } }, { "CandidateA/Worker": "candidateA" }), /CandidateA\/Helper: mcp and skills/);
  rejects(nestedA({ "Two/Parts": shell }, { "CandidateA/Two/Parts": "candidateA" }), /must not contain \//);
  rejects(nestedA(legal, { "CandidateA/Worker": "acceptA" }), /acceptance sandbox acceptA is reserved/);
  rejects(nestedA({ Worker: shell, Second: shell }, { "CandidateA/Worker": "candidateA", "CandidateA/Second": "candidateA" }), /sandbox candidateA would be shared/);
  rejects(nestedA({ Worker: shell, Second: shell }, { "CandidateA/Worker": "candidateA", "CandidateA/Second": "trace" }), /sandbox trace would be shared/);
  rejects(nestedA(legal, { "CandidateA/Worker": "candidateB" }), /sandbox candidateB would be shared/);
  rejects(nestedA({ Helper: helper }, {}), /branch A root CandidateA has no bash agent/);
  rejects(nestedA(legal, { "CandidateA/Worker": "candidateA" }, { BRANCHES: { ...cb.BRANCHES, A: { agent: "CandidateA", sandboxes: ["candidateA", "acceptB"] } } }), /branch A must cancel exactly/);
  rejects(nestedA(legal, { "CandidateA/Worker": "candidateA" }, { BRANCHES: { ...cb.BRANCHES, A: { agent: "CandidateA/Helper", sandboxes: ["candidateA", "acceptA"] } } }), /branch A root CandidateA\/Helper has no bash agent/);
  const integrator = structuredClone(cb.document);
  integrator.graph.nodes.Integrator = { kind: "graph", trigger: integrator.graph.nodes.Integrator.trigger, graph: { name: "Integrator", nodes: { Worker: shell, Second: shell }, edges: [] } } as unknown as syntax.NodeSpec;
  const { Integrator, ...others } = cb.SANDBOX;
  rejects({ ...cb, document: integrator, SANDBOX: { ...others, "Integrator/Worker": "canonical", "Integrator/Second": "canonical" } }, /sandbox canonical would be shared/);
});

// ---- Real containers: the workflow's sandbox operations and branch-local cancellation.

const BASELINE = "d350420dae50c80ca33b845734c31428d62af0a8"; // HEAD of IMAGE's /testbed

test("cancelling one contender stops only its command and sandboxes", async () => {
  const containers = { candidateA: start(), candidateB: start(), acceptA: start(), acceptB: start(), canonical: start() };
  const sentinel = start();
  const controller = new AbortController();
  const contender = { abort: async () => controller.abort() };
  let fatal: Error | undefined;
  const bash = sandboxBash(cb, containers, new Map([["CandidateB", contender]]), (reason) => { fatal = reason; })("CandidateB");
  const started = Promise.withResolvers<void>();
  const command = bash.execute("t", { command: "echo started; sleep 60" }, controller.signal, () => started.resolve());
  const settled = command.then(() => undefined, (error: unknown) => error);
  await started.promise; // the command is running in the contender's container
  expect(await cancelBranch(cb.BRANCHES, containers, new Map([["CandidateB", contender]]))("B")).toEqual([]);
  expect(describe(await settled)).toMatch(/aborted/);
  expect(fatal).toBeUndefined();
  expect([running(containers.candidateB), running(containers.acceptB)]).toEqual([false, false]);
  expect([containers.candidateA, containers.acceptA, containers.canonical, sentinel].map(running)).toEqual([true, true, true, true]);
}, 60_000);

test("same-named nested shells in different branches bind their own containers", async () => {
  const containers = { candidateA: start(), candidateB: start() };
  const workflow = { SANDBOX: { "CandidateA/Worker": "candidateA", "CandidateB/Worker": "candidateB" } as Workflow["SANDBOX"], BRANCHES: cb.BRANCHES };
  const bind = sandboxBash(workflow, containers, new Map(), (reason) => { throw reason; });
  const sh = async (path: string, command: string) =>
    (await bind(path).execute("t", { command })).content.map((c) => ("text" in c ? c.text : "")).join("");
  await sh("CandidateA/Worker", "echo A > sentinel_a");
  await sh("CandidateB/Worker", "echo B > sentinel_b");
  expect(await sh("CandidateA/Worker", "cat sentinel_a; test -e sentinel_b && echo LEAK || echo clean")).toBe("A\nclean\n");
  expect(await sh("CandidateB/Worker", "cat sentinel_b; test -e sentinel_a && echo LEAK || echo clean")).toBe("B\nclean\n");
  expect(() => bind("CandidateA")).toThrow(/CandidateA has no sandbox/);
}, 60_000);

test("cancelling a nested branch aborts every member under its root, concurrently, and nothing else", async () => {
  const containers = { candidateA: start(), candidateB: start(), acceptA: start(), acceptB: start() };
  const aborted: string[] = [];
  const helperCalled = Promise.withResolvers<void>();
  const acquired = new Map([
    // The worker's abort settles only once the helper's has started: awaiting aborts one by one would hang.
    ["CandidateA/Worker", { abort: async () => { aborted.push("CandidateA/Worker"); await helperCalled.promise; } }],
    ["CandidateA/Helper", { abort: async () => { aborted.push("CandidateA/Helper"); helperCalled.resolve(); throw new Error("stuck"); } }],
    ["CandidateAB", { abort: async () => { aborted.push("CandidateAB"); } }],
    ["CandidateB/Worker", { abort: async () => { aborted.push("CandidateB/Worker"); } }],
  ]);
  const branches = { A: { agent: "CandidateA", sandboxes: ["candidateA", "acceptA"] }, B: { agent: "CandidateB", sandboxes: ["candidateB", "acceptB"] } } as const;
  expect(await cancelBranch(branches, containers, acquired)("A")).toEqual(["abort CandidateA/Helper: stuck"]);
  expect(aborted).toEqual(["CandidateA/Worker", "CandidateA/Helper"]);
  expect([containers.candidateA, containers.acceptA].map(running)).toEqual([false, false]);
  expect([containers.candidateB, containers.acceptB].map(running)).toEqual([true, true]);
}, 60_000);

test("a nested contender's timeout aborts its own branch members and is not instance-fatal", async () => {
  const containers = { candidateA: start(), candidateB: start() };
  const aborted: string[] = [];
  const member = (path: string) => [path, { abort: async () => { aborted.push(path); } }] as const;
  const acquired = new Map([member("CandidateA/Worker"), member("CandidateA/Helper"), member("CandidateAB"), member("CandidateB/Worker")]);
  const workflow = { SANDBOX: { "CandidateA/Worker": "candidateA", "CandidateB/Worker": "candidateB" } as Workflow["SANDBOX"], BRANCHES: cb.BRANCHES };
  let fatal: Error | undefined;
  const bash = sandboxBash(workflow, containers, acquired, (reason) => { fatal = reason; })("CandidateA/Worker");
  await expect(bash.execute("t", { command: "sleep 60", timeout: 1 })).rejects.toThrow(/timed out/);
  expect(fatal).toBeUndefined();
  expect(aborted).toEqual(["CandidateA/Worker", "CandidateA/Helper"]);
  expect([running(containers.candidateA), running(containers.candidateB)]).toEqual([false, true]);
}, 60_000);

test("of two conflicting contenders, only the applied patch reaches canonical", async () => {
  const containers = { candidateA: start(), candidateB: start(), canonical: start() };
  const ops = sandboxOps(containers, BASELINE);
  sh(containers.candidateA, "sed -i '1s/.*/# edited by A/' astropy/modeling/separable.py && printf 'a = 1\\n' > astropy/added_by_a.py");
  sh(containers.candidateB, "sed -i '1s/.*/# edited by B/' astropy/modeling/separable.py");
  const [a, b] = [await ops.capture("candidateA"), await ops.capture("candidateB")];
  expect(a).toContain("new file mode");
  expect((await ops.apply("canonical", a)).exit_code).toBe(0);
  expect((await ops.apply("canonical", b)).exit_code).not.toBe(0);
  expect(await ops.capture("canonical")).toBe(a);
  await ops.reset("canonical");
  expect(await ops.capture("canonical")).toBe("");
}, 120_000);

test("a contender that passes only through ignored sandbox state is judged invalid", async () => {
  const containers = { candidateA: start(), acceptA: start() };
  const ops = sandboxOps(containers, BASELINE);
  sh(containers.candidateA, "mkdir -p build && touch build/cb_marker && sed -i '1s/.*/# edited/' astropy/modeling/separable.py");
  const check: cb.Check = { kind: "regression", name: "marker", command: "test -f build/cb_marker" };
  expect((await ops.run("candidateA", check.command, 60)).exit_code).toBe(0);
  const artifacts = mkdtempSync(join(tmpdir(), "judge-"));
  const host: cb.Context = {
    problem: { instance_id: "x", repo: "astropy/astropy", base_commit: BASELINE, problem_statement: "x" },
    sandbox: ops,
    save: (name, data) => {
      const path = join(artifacts, name.replaceAll("/", "_"));
      writeFileSync(path, data);
      return path;
    },
    cancel: async () => [],
    race: {},
  };
  const verdict = await cb.judge(host, "A", message("done"), [check]);
  expect(verdict.patch).not.toContain("cb_marker");
  expect(verdict.valid).toBe(false);
  expect(verdict.reason).toMatch(/failed acceptance checks: marker/);
}, 120_000);
