// Regression tests for the shared workflow's consumer-visible boundaries: model routing, the container
// shell, the wf.yml coordination protocol (real topology and code nodes, scripted participants) and the
// sandbox operations on real containers.
import { afterAll, beforeAll, describe as group, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type AssistantMessage, type Context as PiContext, contentText, fauxAssistantMessage, fauxToolCall, getCurrentTools, type TSchema } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { captureUsageContext, runWithUsageContext } from "dataflow-engine";
import { graph, JuncoGraph, schedules, syntax, tools, tracer } from "junco";
import { countedCollection, fauxRuntime, offlineLadder } from "../../test/support.ts";
import { grafanaUrl } from "../benchmark-telemetry.ts";
import * as cb from "./wf.ts";
import * as solo from "./solo.ts";
import {
  BLOCKED_DEFAULTS,
  cancelBranch,
  checkDocument,
  collectAgents,
  checkLadder,
  containerBash,
  describe,
  guardedModels,
  readManifest,
  recordedSessions,
  sandboxBash,
  sandboxOps,
  sessionMessages,
  teeRecorder,
} from "./run-workflow.ts";

const IMAGE = "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const running = (id: string) => docker("inspect", "-f", "{{.State.Running}}", id).stdout.trim() === "true";
const owned: string[] = [];
const start = () => {
  const started = docker("run", "-d", "--network", "none", IMAGE, "tail", "-f", "/dev/null");
  if (started.error || started.status !== 0) throw started.error ?? new Error(`starting ${IMAGE}: ${started.stderr}`);
  const id = started.stdout.trim();
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
  expect(() => new schedules.ModelLadder(decoyModels, schedules.uniformLadder({ model: "decoy/m" }))).not.toThrow();
  expect(() => new schedules.ModelLadder(decoyModels, { ...schedules.uniformLadder({ model: "decoy/m" }), xhigh: { model: "decoy/m", thinking: "high" } })).toThrow(/xhigh.*high/);
});

test("a guarded agent sends no request to a model other than its role's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const models = guardedModels(decoyModels, log, new Map([["Worker", "decoy/other"]]));
  const model = decoyModels.getModel("decoy", "m")!;
  for (const nodePath of [undefined, ["Other"], ["Other", "Worker"]]) {
    const result = await runWithUsageContext(nodePath && { budgets: [], nodePath }, () => models.completeSimple(model, { messages: [] }));
    expect(result.errorMessage).toMatch(/refused model request from unknown role/);
  }
  const ladder = new schedules.ModelLadder(models, schedules.uniformLadder({ model: "decoy/m" }));
  const document = syntax.parse(`
graph:
  nodes:
    Assignment: {kind: emit, text: Say hi., spec: A greeting.}
    Worker:
      trigger: Assignment~>Worker
      prompt: Follow the greeting assignment.
      tool_block: ${JSON.stringify(BLOCKED_DEFAULTS)}
  edges:
    - {from: Assignment, to: Worker, kind: message, schema: {}}
    - {from: Worker, to: $sink, schema: {}}
`);
  const { collection, active } = countedCollection();
  const execution = await JuncoGraph.fromYaml(document, {
    cwd: dir, scheduler: () => schedules.parallel(), tracer: new tracer.DummyTracer(),
    ladder, collection,
  });
  let value: unknown;
  let failure: string | undefined;
  try {
    await execution.run();
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag === "Some") value = terminal.value;
  } catch (error) {
    failure = describe(error);
  } finally {
    await execution.graph.close();
    await collection.close();
    expect(active.bindings).toBe(0);
  }
  expect(hits).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("");
  expect(failure ?? (value as AssistantMessage | undefined)?.errorMessage).toContain("Worker: refused request to decoy/m");
  expect(() => syntax.finalText(value, "Worker")).toThrow();
});

test("a session setup failure releases earlier recordings and preserves close failures", async () => {
  await using lifetime = new AsyncDisposableStack();
  const cwd = mkdtempSync(join(tmpdir(), "swe-session-setup-"));
  lifetime.defer(() => rmSync(cwd, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd });
  lifetime.defer(() => env.cleanup(BACKGROUND_CONTEXT));
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: cwd });
  lifetime.defer(() => repo.close(BACKGROUND_CONTEXT));
  const create = repo.create.bind(repo);
  let opened = 0, closed = 0;
  repo.create = async (...args) => {
    if (opened++) throw new Error("second session unavailable");
    const session = await create(...args);
    const close = session.close.bind(session);
    session.close = async (ctx) => {
      closed++;
      await close(ctx);
      throw new Error("close failed");
    };
    return session;
  };
  const assignments = new Map(["A/Worker", "B/Worker"].map((path) => [graph.NodeId.create(path), "faux/m"]));
  const result = await recordedSessions(assignments, cwd, repo, join(cwd, "index.jsonl")).catch(describe);
  expect(result).toBe("opening SWE-bench sessions failed: second session unavailable; close failed");
  expect(closed).toBe(1);
});

test("container bash keeps argument boundaries, output and nonzero exit codes", async () => {
  const bash = tools.BashTool.create("/testbed", containerBash(start(), () => {}));
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
  const bash = tools.BashTool.create("/testbed", containerBash(mine, (reason) => { fatal = reason; }));
  await expect(bash.execute("t", { command: "sleep 60 & sleep 60", timeout: 1 })).rejects.toThrow(/timed out/);
  expect(fatal?.message).toMatch(/timeout/);
  expect(running(mine)).toBe(false);
  expect(running(sentinel)).toBe(true);
}, 60_000);

// ---- Coordination: the real workflow topology and code nodes, with root agents scripted as code nodes
// and Planner agents kept as real YAML-owned sessions so instruction staging and steering stay separate.
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
const CHECKS: cb.Check[] = [
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
          h.log.push(`apply:${role}`);
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
  return ({ policy, edges }) =>
    new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const texts = [...edges].flatMap(([id]) => (view.messages.get(graph.EdgeId.create(id)) ?? []).flatMap((payload: unknown) =>
        payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string" ? [payload.text] : [],
      ));
      h.saved.set(`scripted/${id}.prompt`, texts.join("\n\n"));
      h.log.push(`${id}:start`);
      for (let i = 0; i < (script.columns ?? 0); i++) yield { resume: [] };
      for (let i = 0; script.until !== undefined && !script.until(); i++) {
        if (i === 100) throw new Error(`${id} waited 100 scheduling turns without a release`);
        yield { resume: [] };
      }
      script.act?.(h);
      h.log.push(`${id}:done`);
      return message(script.text ?? `${id} report`, script.stop ?? "stop");
    }, policy);
}

/** Script only root agents; every nested Planner agent keeps its real prompt and trigger. */
function scriptedDocument(source: syntax.JuncoDocument = cb.document): syntax.JuncoDocument {
  const document = structuredClone(source);
  for (const [id, node] of Object.entries(document.graph.nodes))
    if (node.kind === undefined || node.kind === "agent")
      document.graph.nodes[id] = { kind: "code", description: node.description, trigger: node.trigger };
  return document;
}

type Draft = { id: string; requests: PiContext[]; result?: unknown };
/** One response per provider request, including actual native yield calls. */
const drafts = (...turns: (string | AssistantMessage)[]) =>
  turns.map((turn) => typeof turn === "string" ? fauxAssistantMessage(turn) : turn);
const userTexts = (request: PiContext): string[] => request.messages
  .filter((message) => message.role === "user")
  .map(({ content }) => typeof content === "string" ? content : content.map((part) => "text" in part ? part.text : "").join(""));
/** Corrections delivered to this producer, from the cumulative session in its final request. */
function corrections(agent: Draft): { attempt: number; feedback: string }[] {
  const last = agent.requests.at(-1);
  if (last === undefined) return [];
  return userTexts(last).filter((text) => text.startsWith('{"id":')).map((text) => {
    const { id, payload } = JSON.parse(text);
    expect(id).toBe(`CheckPlan~>${agent.id}`);
    return payload;
  });
}

async function scenario(
  overrides: Record<string, Script> = {},
  runs: AssistantMessage[] | Record<string, AssistantMessage[]> = drafts(plan(CHECKS)),
  code: (h: Fake) => Record<string, syntax.DeterministicNode<cb.Context>> = () => ({}),
  recorder?: tracer.ProfileRecorder<string>,
  workflow: typeof cb = cb,
  document: syntax.JuncoDocument = workflow.document,
) {
  const h = fake();
  const scripts: Record<string, Script> = {
    Lead: { text: LEAD },
    CandidateA: { act: (f) => { f.files.candidateA = diff("FIX A"); } },
    CandidateB: { act: (f) => { f.files.candidateB = diff("FIX B"); } },
    Verifier: { text: "ran every check\nVERDICT: PASS" },
    ...overrides,
  };
  const participants = Object.fromEntries(Object.entries(document.graph.nodes)
    .filter(([, node]) => node.kind === undefined || node.kind === "agent")
    .map(([id]) => [id, participant(id, scripts[id] ?? {}, h)]));
  const agents = new Map<string, Draft>();
  const source = scriptedDocument(document);
  const scriptsByPath = new Map<string, AssistantMessage[]>();
  for (const { path, node } of await syntax.resolveAgents(source, { cwd: tmpdir() })) {
    if (!path.startsWith("Planner/")) throw new Error(`unexpected agent ${path}`);
    const turns = Array.isArray(runs) ? runs : runs[path];
    if (turns === undefined) throw new Error(`no scripted requests for ${path}`);
    agents.set(path, { id: node, requests: [] });
    scriptsByPath.set(path, turns);
  }
  const respond = (context: PiContext) => {
    const path = captureUsageContext()?.nodePath.join("/") ?? "";
    const log = agents.get(path);
    if (!log) throw new Error(`request outside a scripted role: ${path}`);
    h.log.push(`${log.id}:next`);
    const response = scriptsByPath.get(path)?.[log.requests.length];
    log.requests.push(structuredClone(context));
    if (!response) throw new Error(`unexpected request ${log.requests.length} for ${path}`);
    return response;
  };
  const ladder = await offlineLadder([...scriptsByPath.values()].flatMap((turns) => turns.map(() => respond)));
  const { collection, active } = countedCollection();
  const execution = await JuncoGraph.fromYaml<cb.Context>(source, {
    cwd: tmpdir(),
    scheduler: workflow.scheduler,
    code: { ...workflow.code, ...participants, ...code(h) },
    ladder, collection,
    context: { ...h.host, race: {} },
    signal: h.abort.signal,
    tracer: new tracer.DummyTracer(),
    ...(recorder === undefined ? {} : { recorder }),
  });
  let report: string | undefined;
  let plannerResult: unknown;
  let error: string | undefined;
  try {
    await execution.run();
    execution.graph.forEachNode((id, { state }) => {
      if (id !== "Planner" || !(state instanceof JuncoGraph)) return;
      state.forEachNode((childId) => {
        const draft = agents.get(`Planner/${childId}`);
        const result = state.result(childId);
        if (draft && result._tag === "Some") draft.result = result.value;
      });
    });
    const planner = execution.graph.result(graph.NodeId.create("Planner"));
    if (planner._tag === "Some") plannerResult = planner.value;
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag === "Some") report = syntax.finalText(terminal.value, "Finish");
  } catch (failure) {
    error = describe(failure);
  } finally {
    await execution.graph.close();
    await collection.close();
    expect(active.bindings).toBe(0);
  }
  const at = (entry: string) => h.log.indexOf(entry);
  const count = (entry: string) => h.log.filter((e) => e === entry).length;
  const draft = agents.get("Planner/Draft")!;
  return { ...h, report, plannerResult, error, at, count, draft, agents, corrections: draft === undefined ? [] : corrections(draft) };
}

/** Import the real module against alternate YAML so module-load topology decisions are exercised. */
async function withWorkflow<T>(document: syntax.JuncoDocument, act: (workflow: typeof cb) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(import.meta.dir, ".topology-"));
  try {
    copyFileSync(join(import.meta.dir, "wf.ts"), join(dir, "wf.ts"));
    writeFileSync(join(dir, "wf.yml"), JSON.stringify(document));
    return await act(await import(join(dir, "wf.ts")) as typeof cb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

group("solo baseline", () => {
  const runSolo = async (h: Fake, stop: AssistantMessage["stopReason"] = "stop") => {
    const { collection, active } = countedCollection();
    const ladder = await offlineLadder([fauxAssistantMessage("solo report", { stopReason: stop, ...(stop === "error" ? { errorMessage: "solo error" } : {}) })]);
    try {
      return await solo.run({
        cwd: tmpdir(), context: h.host, ladder, collection, tracer: new tracer.DummyTracer(),
      }, (g) => {
        const members = new Map();
        collectAgents(g, members);
        expect([...members.keys()]).toEqual(["Solo"]);
      });
    } finally {
      await collection.close();
      expect(active.bindings).toBe(0);
    }
  };

  test("a solo patch reaches canonical after either a normal or abnormal agent stop", async () => {
    checkDocument(solo);
    for (const stop of ["stop", "error"] as const) {
      const h = fake();
      h.files.candidateA = diff("FIX solo");
      const report = await runSolo(h, stop);
      expect(h.files.canonical).toBe(diff("FIX solo"));
      expect(h.saved.get("solo.patch")).toBe(diff("FIX solo"));
      expect(h.saved.get("solo.md")).toContain("solo report");
      expect(report).toContain("Solo patch delivered");
    }
  });

  test("an empty solo sandbox never claims a delivered patch", async () => {
    const h = fake();
    await expect(runSolo(h).catch((failure) => { throw new Error(describe(failure)); })).rejects.toThrow(/Solo left no change in \/testbed/);
    expect(h.files.canonical).toBe("");
  });
});

group("coordination", () => {
  test("the planner starts only after every evidence report has settled", async () => {
    const run = await scenario({ Contracts: { columns: 6 } });
    expect(run.error).toBeUndefined();
    for (const worker of ["Trace", "Reproduce", "Contracts"]) expect(run.at("Draft:next")).toBeGreaterThan(run.at(`${worker}:done`));
    expect(run.at("Contracts:done")).toBeGreaterThan(run.at("Trace:done"));
    const texts = userTexts(run.draft.requests[0]);
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toContain("f(1) is wrong");
    expect(texts[1].split("f(1) is wrong")).toHaveLength(2);
    expect(texts[1].split(run.saved.get("evidence.md")!)).toHaveLength(2);
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
    expect(run.corrections).toHaveLength(1);
    expect(userTexts(run.draft.requests[1]).at(-2)).toBe(userTexts(run.draft.requests[0])[0]);
    expect(run.plannerResult).toBe(run.draft.result);
    expect(run.corrections[0].attempt).toBe(1);
    expect(run.corrections[0].feedback).toContain("No regression check survived the baseline run");
    expect(run.corrections[0].feedback).toContain("missing-class");
    expect(run.corrections[0].feedback).toContain("MigrationLoaderTests");
    expect(run.at("CandidateA:start")).toBeGreaterThan(run.at("save:planning/attempt-2/acceptance.json"));
    expect(run.saved.get("acceptance.json")).toBe(run.saved.get("planning/attempt-2/acceptance.json"));
    expect(run.saved.get("plan.md")).toBe(plan(CHECKS));
  });

  test("three correction turns are allowed and a valid fourth draft is accepted without a fifth request", async () => {
    const run = await scenario({}, drafts("no plan here", plan([CHECKS[0], MISSING_REGRESSION]), plan([CHECKS[0]]), plan(CHECKS)));
    expect(run.error).toBeUndefined();
    expect(run.report).toBeDefined();
    expect(run.draft.requests).toHaveLength(4);
    expect(run.corrections.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
    expect(run.corrections[0].feedback).toContain("the Planner returned no");
    expect(run.corrections[2].feedback).toContain("The plan has no regression check");
  });

  test("a parsed fourth rejected plan dispatches surviving checks and reaches Finish", async () => {
    // No reclassification: a reproduction that passes and a regression that fails stay excluded, never swapped.
    const swapped = plan([
      { kind: "reproduction", name: "swapped-r", command: "regress" },
      { kind: "regression", name: "swapped-g", command: "repro" },
    ]);
    const importError = plan([{ kind: "reproduction", name: "repro", command: "import-error" }, CHECKS[1]]);
    const run = await scenario({}, drafts("```json\n{not json\n```", importError, swapped, plan([CHECKS[0], MISSING_REGRESSION])));
    expect(run.error).toBeUndefined();
    expect(run.report).toContain("Final patch verified");
    expect(run.draft.requests).toHaveLength(4);
    expect(run.plannerResult).toBe(run.draft.result);
    expect(run.files.canonical).toBe(diff("FIX A"));
    for (const candidate of ["CandidateA", "CandidateB"]) {
      expect(run.at(`${candidate}:start`)).toBeGreaterThan(run.at("save:planning/degraded.txt"));
      expect(run.saved.get(`scripted/${candidate}.prompt`)).toContain("# Degraded plan");
      expect(run.saved.get(`scripted/${candidate}.prompt`)).toContain("No regression check survived");
    }
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
    expect(run.corrections[1].feedback).toContain("ImportError: No module named pkg");
  });

  test("a malformed fourth plan still fails before any patch work", async () => {
    const run = await scenario({}, drafts("not JSON", "not JSON", "not JSON", "not JSON"));
    expect(run.error).toMatch(/plan rejected after 3 correction turns: plan: the Planner returned no/);
    expect(run.at("CandidateA:start")).toBe(-1);
    expect(run.at("CandidateB:start")).toBe(-1);
    expect(run.files.canonical).toBe("");
  });

  test("a degraded plan with no surviving checks still submits an applying patch", async () => {
    const bad = plan([{ kind: "reproduction", name: "bad", command: "import-error" }]);
    const run = await scenario({}, drafts(bad, bad, bad, bad));
    expect(run.error).toBeUndefined();
    expect(run.report).toContain("Final patch verified");
    expect(JSON.parse(run.saved.get("acceptance.json")!).checks).toEqual([]);
    expect(run.files.canonical).toBe(diff("FIX A"));
  });

  test("a slow checker validates each distinct draft once and a native yield costs no correction turn", async () => {
    const bad = plan([{ kind: "reproduction", name: "repro", command: "import-error" }, { kind: "regression", name: "slow", command: "slow" }]);
    const yielding = fauxAssistantMessage([fauxToolCall("yield", { reason: "thinking" })], { stopReason: "toolUse" });
    const run = await scenario({}, drafts(yielding, bad, bad, plan([CHECKS[0], { kind: "regression", name: "slow", command: "slow" }])));
    expect(run.error).toBeUndefined();
    expect(run.draft.requests).toHaveLength(4); // yield + settle, then one request per correction
    expect(run.corrections.map(({ attempt }) => attempt)).toEqual([1, 2]);
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
    for (const branch of ["A", "B"]) {
      expect(run.count(`apply:accept${branch}`)).toBe(1);
      expect(run.count(`save:verdict-${branch}.json`)).toBe(1);
    }
    expect(JSON.parse(run.saved.get("tournament.json") ?? "{}").winner).toBe("A");
  });

  test("failed acceptance selects the applying patch with fewest failures, ties to A", async () => {
    for (const [a, b, winner] of [["FIX A BREAK", undefined, "A"], ["BAD A BREAK", "FIX B BREAK", "B"], ["FIX A BREAK", "FIX B BREAK", "A"]] as const) {
      const run = await scenario({
        CandidateA: { act: (f) => { f.files.candidateA = diff(a); } },
        CandidateB: b === undefined ? { stop: "aborted" } : { act: (f) => { f.files.candidateB = diff(b); } },
        Integrator: { act: (f) => { f.files.canonical = diff("FIX integrated"); } },
      });
      expect(run.error).toBeUndefined();
      expect(run.report).toContain("Final patch verified");
      expect(JSON.parse(run.saved.get("tournament.json")!).winner).toBe(winner);
      expect(JSON.parse(run.saved.get("tournament.json")!).degraded).toContain("regress");
      expect(run.saved.get("selected.patch")).toBe(diff(winner === "A" ? a : b!));
      expect(run.saved.get("scripted/Integrator.prompt")).toContain("# Selected patch failed acceptance checks");
      expect(run.saved.get("scripted/Integrator.prompt")).toContain("regress (exit 1)");
      expect(run.files.canonical).toBe(diff("FIX integrated"));
    }
  });

  test("two abnormal contenders still fail without an applied patch", async () => {
    const run = await scenario({ CandidateA: { stop: "error" }, CandidateB: { stop: "aborted" } });
    expect(run.error).toMatch(/no valid candidate/);
    expect(run.at("Integrator:start")).toBe(-1);
    expect(run.files.canonical).toBe("");
  });

  test("a contender still running when the gate decides is cancelled once and never validated", async () => {
    for (const stop of ["aborted", "stop"] as const) {
      let h: Fake | undefined;
      const run = await scenario({
        CandidateA: { act: (f) => { h = f; f.files.candidateA = diff("FIX A"); } },
        CandidateB: { until: () => h?.cancels.includes("B") ?? false, stop, act: (f) => { f.files.candidateB = diff("FIX B"); } },
      });
      expect(run.error).toBeUndefined();
      expect(run.at("cancel:B")).toBeLessThan(run.at("CandidateB:done"));
      expect(run.cancels).toEqual(["B"]);
      expect(run.captures).not.toContain("candidateB");
      expect(run.count("apply:acceptB")).toBe(0);
      expect(run.log.some((entry) => entry.startsWith("run:acceptB:"))).toBe(false);
      expect(run.saved.has("verdict-B.json")).toBe(false);
      expect(run.files.canonical).toBe(diff("FIX A"));
      expect(run.count("Integrator:start")).toBe(1);
    }
  });

  test("a capture interrupted by cancellation never starts acceptance; an infrastructure failure still rejects", async () => {
    for (const cancelled of [false, true]) {
      const h = fake();
      const context: cb.Context = { ...h.host, race: {} };
      const capture = Promise.withResolvers<string>();
      context.sandbox.capture = () => capture.promise;
      const judging = cb.judge(context, "B", message("patch ready"), CHECKS);
      if (cancelled) {
        context.race.winner = "A";
        capture.resolve(diff("FIX B"));
        expect(await judging).toMatchObject({ valid: false, reason: "cancelled after candidate A won" });
      } else {
        const failure = new Error("capture failed");
        capture.reject(failure);
        await expect(judging).rejects.toBe(failure);
      }
      expect(h.log).toEqual([]);
    }
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

group("dormant topology capabilities", () => {
  test("the incumbent routes every role to its non-Opus model and thinking level", async () => {
    const agents = await syntax.resolveAgents(cb.document, { cwd: tmpdir() });
    const sonnet = { model: "github-copilot/claude-sonnet-5.5", thinking: "high" } as const;
    const haiku = { model: "github-copilot/claude-haiku-5.5", thinking: "medium" } as const;
    const luna = { model: "github-copilot/gpt-6-luna", thinking: "medium" } as const;
    expect(Object.fromEntries(agents.map(({ path }) => [path, cb.ladder[cb.strengthOf(path)]]))).toEqual({
      Lead: sonnet, "Planner/Draft": sonnet, Integrator: sonnet,
      CandidateA: haiku, Reproduce: haiku, Verifier: haiku,
      CandidateB: luna, Contracts: luna, Trace: luna,
    });
    expect(["Lead", "Planner/Critic", "Integrator", "CandidateA", "Reproduce", "Verifier", "CandidateB", "Contracts", "Trace", "Other"]
      .map((path) => cb.strengthOf(path))).toEqual(["xhigh", "xhigh", "high", "med", "med", "med", "low", "low", "smol", "med"]);
  });

  test("an alternate producer receives corrections while Draft runs only once", async () => {
    const document = structuredClone(cb.document);
    const planner = document.graph.nodes.Planner;
    if (planner.kind !== "graph") throw new Error("expected Planner graph");
    const level = planner.graph;
    const promptSchema = level.edges!.find((edge) => edge.from === "$source")!.schema;
    const correction = level.edges!.find((edge) => edge.from === "CheckPlan" && edge.to === "Draft")!;
    level.source = { ...level.source, routes: { "JoinEvidence~>Planner": ["$source~>Draft", "$source~>Critic"] } };
    level.nodes.Draft.trigger = "$source~>Draft";
    level.nodes.Critic = {
      tool_block: [...BLOCKED_DEFAULTS],
      trigger: { any: ["Draft->Critic", "CheckPlan~>Critic"] },
      prompt: "Review the issue, evidence and draft. On a correction, return the complete plan addressing the baseline feedback.\n\n# Draft plan\n{{Draft->Critic}}",
    };
    level.nodes.CheckPlan.trigger = "Critic~>CheckPlan";
    level.edges = [
      { from: "$source", to: "Draft", kind: "message", schema: promptSchema },
      { from: "$source", to: "Critic", kind: "message", schema: promptSchema },
      { id: "Draft->Critic", from: "Draft", to: "Critic", kind: "message", on: "return", schema: {} },
      { ...correction, to: "Critic" },
      { from: "Critic", to: "CheckPlan", kind: "message", on: "return", schema: {} },
      { from: "CheckPlan", to: "$sink", schema: {} },
    ];
    await withWorkflow(document, async (workflow) => {
      checkDocument(workflow);
      const run = await scenario({}, {
        "Planner/Draft": drafts("initial draft based on evidence"),
        "Planner/Critic": drafts(plan([CHECKS[0]]), plan(CHECKS)),
      }, undefined, undefined, workflow);
      expect(run.error).toBeUndefined();
      expect(run.report).toContain("Final patch verified");
      expect(run.draft.requests).toHaveLength(1);
      const critic = run.agents.get("Planner/Critic")!;
      expect(critic.requests).toHaveLength(2);
      expect(corrections(critic)).toEqual([{ attempt: 1, feedback: expect.stringContaining("The plan has no regression check") }]);
      const first = userTexts(critic.requests[0]);
      expect(first).toHaveLength(2);
      expect(first[0]).toContain("initial draft based on evidence");
      expect(first[0]).not.toContain("f(1) is wrong");
      expect(first[1].split("f(1) is wrong")).toHaveLength(2);
      expect(first[1].split(run.saved.get("evidence.md")!)).toHaveLength(2);
    });
  });

  test("two return-message producers into CheckPlan are rejected when the pair is imported", async () => {
    const document = structuredClone(cb.document);
    const planner = document.graph.nodes.Planner;
    if (planner.kind !== "graph") throw new Error("expected Planner graph");
    planner.graph.nodes.Other = { trigger: "Draft~>Other", prompt: "another plan" };
    planner.graph.nodes.CheckPlan.trigger = { any: ["Draft~>CheckPlan", "Other~>CheckPlan"] };
    planner.graph.edges!.push(
      { from: "Draft", to: "Other", kind: "message", on: "return", schema: {} },
      { from: "Other", to: "CheckPlan", kind: "message", on: "return", schema: {} },
    );
    await expect(withWorkflow(document, async () => {})).rejects.toThrow("wf.yml: CheckPlan needs one producer's return-message edge and a correction message back to that producer");
  });

  test("Input publishes the same issue once on both outgoing message edges", async () => {
    const document = structuredClone(cb.document);
    document.graph.nodes.Observer = { trigger: "Input~>Observer", prompt: "Read the issue in the user message following this prompt." };
    document.graph.edges!.push({
      ...document.graph.edges!.find((edge) => edge.from === "Input")!, to: "Observer",
    });
    document.graph.edges!.push({ from: "Observer", to: "$sink", schema: {} });
    await withWorkflow(document, async (workflow) => {
      const run = await scenario({}, undefined, undefined, undefined, workflow);
      expect(run.error).toBeUndefined();
      expect(run.report).toContain("Final patch verified");
      const issue = "Repository: o/r (base commit " + "0".repeat(40) + ")\n\nf(1) is wrong";
      for (const id of ["Lead", "Observer"]) {
        expect(run.count(`${id}:start`)).toBe(1);
        expect(run.saved.get(`scripted/${id}.prompt`)).toBe(issue);
      }
    });
  });

  test("JoinDrafts forwards two ordered named reports once and rejects an abnormal draft", async () => {
    const document = structuredClone(cb.document);
    const planner = document.graph.nodes.Planner;
    if (planner.kind !== "graph") throw new Error("expected Planner graph");
    const level = planner.graph;
    const promptSchema = level.edges!.find((edge) => edge.from === "$source")!.schema;
    const correction = level.edges!.find((edge) => edge.from === "CheckPlan" && edge.to === "Draft")!;
    level.source = { ...level.source, routes: { "JoinEvidence~>Planner": ["$source~>DraftA", "$source~>DraftB", "$source~>Merge"] } };
    level.nodes = {
      DraftA: { trigger: "$source~>DraftA", prompt: "Draft a plan from the evidence in the user message following this prompt.", tool_block: [...BLOCKED_DEFAULTS] },
      DraftB: { trigger: "$source~>DraftB", prompt: "Draft a plan from the evidence in the user message following this prompt.", tool_block: [...BLOCKED_DEFAULTS] },
      JoinDrafts: { kind: "code", trigger: { all: ["DraftA->JoinDrafts", "DraftB->JoinDrafts"] } },
      Merge: { trigger: { any: ["JoinDrafts~>Merge", "CheckPlan~>Merge"] }, prompt: "Merge the evidence and named drafts into one plan. On a correction, return the complete plan addressing the baseline feedback.", tool_block: [...BLOCKED_DEFAULTS] },
      CheckPlan: { ...level.nodes.CheckPlan, trigger: "Merge~>CheckPlan" },
    };
    level.edges = [
      ...["DraftA", "DraftB", "Merge"].map((to): syntax.EdgeSpec => ({ from: "$source", to, kind: "message", schema: promptSchema })),
      { from: "DraftB", to: "JoinDrafts", schema: {} },
      { from: "DraftA", to: "JoinDrafts", schema: {} },
      { from: "JoinDrafts", to: "Merge", kind: "message", schema: promptSchema },
      { ...correction, to: "Merge" },
      { from: "Merge", to: "CheckPlan", kind: "message", on: "return", schema: {} },
      { from: "CheckPlan", to: "$sink", schema: {} },
    ];
    await withWorkflow(document, async (workflow) => {
      checkDocument(workflow);
      const run = await scenario({}, {
        "Planner/DraftA": drafts("first independent draft"),
        "Planner/DraftB": drafts("second independent draft"),
        "Planner/Merge": drafts(plan([CHECKS[0]]), plan(CHECKS)),
      }, undefined, undefined, workflow);
      expect(run.error).toBeUndefined();
      expect(run.report).toContain("Final patch verified");
      expect(run.saved.get("planning/drafts.md")).toBe("# Plan 1 (DraftA)\n\nfirst independent draft\n\n# Plan 2 (DraftB)\n\nsecond independent draft");
      expect(run.count("save:planning/drafts.md")).toBe(1);
      for (const path of ["Planner/DraftA", "Planner/DraftB"]) expect(run.agents.get(path)!.requests).toHaveLength(1);
      const merge = run.agents.get("Planner/Merge")!;
      expect(merge.requests).toHaveLength(2);
      const first = userTexts(merge.requests[0]);
      expect(first).toHaveLength(3);
      expect(first[0]).not.toContain("f(1) is wrong");
      expect(first[1].split("f(1) is wrong")).toHaveLength(2);
      expect(first[1].split(run.saved.get("evidence.md")!)).toHaveLength(2);
      // JoinDrafts emits a Task.create task, so Merge sees it rendered with its minted id and spec.
      expect(first[2]).toMatch(new RegExp(`^${RegExp.escape(run.saved.get("planning/drafts.md")!)}\\n\\nTask: \\{"taskId":"[0-9a-f-]{36}","spec":"One merged fix plan chosen from the drafts\\.","deps":\\[\\],"history":\\[\\]\\}$`));
      expect(corrections(merge)).toEqual([{ attempt: 1, feedback: expect.stringContaining("The plan has no regression check") }]);

      const abnormal = await scenario({}, {
        "Planner/DraftA": drafts(fauxAssistantMessage("broken draft", { stopReason: "error", errorMessage: "broken draft" })),
        "Planner/DraftB": drafts("second independent draft"),
        "Planner/Merge": drafts(plan(CHECKS)),
      }, undefined, undefined, workflow);
      expect(abnormal.error).toMatch(/DraftA did not finish normally/);
      expect(abnormal.agents.get("Planner/Merge")!.requests).toHaveLength(0);
      expect(abnormal.saved.has("planning/drafts.md")).toBe(false);
      expect(abnormal.at("CandidateA:start")).toBe(-1);
    });
  });

  test("removing Integrator, Verifier, or both still reaches Finish with final acceptance checks", async () => {
    for (const removed of [["Integrator"], ["Verifier"], ["Integrator", "Verifier"]]) {
      const document = structuredClone(cb.document);
      for (const id of removed) delete document.graph.nodes[id];
      document.graph.edges = document.graph.edges!.filter((edge) => !removed.includes(edge.from) && !removed.includes(edge.to));
      if (removed.includes("Integrator")) document.graph.nodes.Freeze.trigger = "Apply~>Freeze";
      if (removed.includes("Verifier")) document.graph.nodes.Finish.trigger = "Freeze~>Finish";
      await withWorkflow(document, async (workflow) => {
        checkDocument(workflow);
        const run = await scenario({}, undefined, undefined, undefined, workflow);
        expect(run.error).toBeUndefined();
        expect(run.report).toContain("Final patch verified");
        expect(run.files.canonical).toBe(diff("FIX A"));
        expect(run.files.acceptFinal).toBe(diff("FIX A"));
        for (const id of removed) {
          expect(run.at(`${id}:start`)).toBe(-1);
          expect(run.saved.has(`${id.toLowerCase()}.md`)).toBe(false);
        }
        if (removed.includes("Integrator") && !removed.includes("Verifier")) expect(run.saved.get("scripted/Verifier.prompt")).toContain("(no integrator)");
        if (removed.includes("Verifier")) expect(run.report).toContain("Verifier: none");
        expect(JSON.parse(run.saved.get("final-checks.json")!).observed.map((check: cb.Check) => check.name)).toEqual(["repro", "regress"]);
      });
    }
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
const shell = { trigger: "$source~>Worker", prompt: "Investigate the assignment in your sandbox.", tool_block: BLOCKED_DEFAULTS.filter((name) => name !== "bash") };
const helper = { trigger: "$source~>Helper", prompt: "Review the assignment.", tool_block: [...BLOCKED_DEFAULTS] };

test("manifest refuses aliases that could share an acceptance container", () => {
  const dir = mkdtempSync(join(tmpdir(), "swe-manifest-"));
  const path = join(dir, "manifest.json");
  const accept = "a".repeat(64);
  try {
    for (const candidate of ["b".repeat(64), accept, accept.slice(0, 12), "acceptA"]) {
      writeFileSync(path, JSON.stringify({ baseline: "0".repeat(40), containers: { candidateA: candidate, acceptA: accept } }));
      const read = () => readManifest(path, ["candidateA", "acceptA"]);
      if (candidate.startsWith("b")) expect(read().containers.candidateA).toBe(candidate);
      else expect(read).toThrow(/distinct full container IDs/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nested pairs are checked at every depth against the runtime's permissions and sandboxes", () => {
  expect(() => checkDocument(cb)).not.toThrow();
  const legal = { Helper: helper, Worker: shell };
  expect(() => checkDocument(nestedA(legal, { "CandidateA/Worker": "candidateA" }))).not.toThrow();
  const deep = { Inner: { kind: "graph", trigger: "$source~>Inner", graph: { name: "Candidate", nodes: legal, edges: [] } } };
  expect(() => checkDocument(nestedA(deep, { "CandidateA/Inner/Worker": "candidateA" }))).not.toThrow();
  const rejects = (workflow: Workflow, error: RegExp) => expect(() => checkDocument(workflow)).toThrow(error);
  rejects(nestedA({ ...legal, Mystery: { kind: "code", trigger: "$source~>Mystery" } }, { "CandidateA/Worker": "candidateA" }), /CandidateA\/Mystery has no exported definition Mystery/);
  rejects(nestedA(legal, {}), /CandidateA\/Worker: tool_block must include bash/);
  rejects(nestedA(legal, { CandidateA: "candidateA", "CandidateA/Worker": "candidateA" }), /SANDBOX\.CandidateA must bind a bash-using agent path/);
  for (const tool of BLOCKED_DEFAULTS) {
    rejects(nestedA({ ...legal, Helper: { ...helper, tool_block: BLOCKED_DEFAULTS.filter((name) => name !== tool) } }, { "CandidateA/Worker": "candidateA" }), new RegExp(`CandidateA/Helper: tool_block must include ${tool}`));
  }
  rejects(nestedA({ Worker: helper }, { "CandidateA/Worker": "candidateA" }), /mapped sandbox requires unblocked bash/);
  rejects(nestedA({ ...legal, Helper: { ...helper, skills: ["x"] } }, { "CandidateA/Worker": "candidateA" }), /CandidateA\/Helper: skills are not permitted/);
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
  const bash = tools.BashTool.create("/testbed", sandboxBash(cb, containers, new Map([["CandidateB", contender]]), (reason) => { fatal = reason; })("CandidateB"));
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

/** Exercise the same path guard and session handoff with and without a native Docker-bound collection. */
async function nestedWorkers(shells: boolean): Promise<void> {
  await using lifetime = new AsyncDisposableStack();
  const dir = mkdtempSync(join(tmpdir(), "swe-nested-"));
  lifetime.defer(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "requests.jsonl");
  const index = join(dir, "index.jsonl");
  const env = new NodeExecutionEnv({ cwd: dir });
  lifetime.defer(() => env.cleanup(BACKGROUND_CONTEXT));
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: dir });
  lifetime.defer(() => repo.close(BACKGROUND_CONTEXT));
  const branches = ["A", "B"] as const;
  const containers: Record<string, string> = {};
  const sandbox: Record<string, cb.Role> = {};
  const members = new Map<string, { abort(): Promise<unknown> }>();
  const collections = new Map<graph.NodeIdType, tools.ToolCollection>();
  let cwd = dir;
  if (shells) {
    // The package fixture creates and removes an isolated production seed under JUNCO_BTRFS_TEST_ROOT.
    const { createBtrfsFixture }: { createBtrfsFixture(): Promise<{ seed: string; close(): Promise<void> }> } =
      require("../../packages/junco-tools/tests/btrfs-fixture.mjs");
    const fixture = await createBtrfsFixture();
    lifetime.defer(() => fixture.close());
    cwd = fixture.seed;
    for (const branch of branches) {
      const role = `candidate${branch}` as const;
      sandbox[`Candidate${branch}/Worker`] = role;
      containers[role] = start();
      containers[`accept${branch}`] = start();
      expect(sh(containers[role], `printf '%s' '${branch}' > /tmp/worker-sentinel`).status).toBe(0);
    }
    const bind = sandboxBash({ SANDBOX: sandbox, BRANCHES: cb.BRANCHES }, containers, members, (error) => { throw error; });
    expect(() => bind("CandidateA")).toThrow(/no sandbox/);
    for (const path of Object.keys(sandbox)) {
      const collection = await tools.ToolCollection.create(cwd, { bash: bind(path) });
      lifetime.defer(() => collection.close());
      collections.set(graph.NodeId.create(path), collection);
    }
  }
  const respond = (context: PiContext) => {
    const role = userTexts(context)[0];
    expect(["Worker A", "Worker B"]).toContain(role);
    const names = getCurrentTools(context.messages).map((tool) => tool.name);
    for (const name of BLOCKED_DEFAULTS) expect(names.includes(name)).toBe(shells && name === "bash");
    if (!shells) return fauxAssistantMessage(role);
    const last = context.messages.at(-1);
    return last?.role === "toolResult"
      ? fauxAssistantMessage(`${role}: ${contentText(last.content).trim()}`)
      : fauxAssistantMessage([fauxToolCall("bash", { command: "cat /tmp/worker-sentinel" })], { stopReason: "toolUse" });
  };
  const { models } = await fauxRuntime(Array(shells ? 4 : 2).fill(respond), "swe", [{ id: "a" }, { id: "b" }]);
  const rungs = { ...schedules.uniformLadder({ model: "swe/a" }), high: { model: "swe/b" } };
  const document = syntax.parse(JSON.stringify({
    graph: {
      nodes: {
        Start: { kind: "emit", text: "Run the assignment.", spec: "Report the worker's evidence." },
        ...Object.fromEntries(branches.map((branch) => [`Candidate${branch}`, {
          kind: "graph", graph: {
            source: { routes: { [`Start~>Candidate${branch}`]: ["$source~>Worker"] } },
            nodes: { Worker: { prompt: `Worker ${branch}`, tool_block: shells ? shell.tool_block : BLOCKED_DEFAULTS } },
            edges: [{ from: "$source", to: "Worker", kind: "message", schema: {} }, { from: "Worker", to: "$sink", schema: {} }],
          },
        }])),
      },
      edges: branches.flatMap((branch) => [
        { from: "Start", to: `Candidate${branch}`, kind: "message", schema: {} },
        { from: `Candidate${branch}`, to: "$sink", schema: {} },
      ]),
      sink: { returns: "CandidateA" },
    },
  }));
  const strengthOf = (path: string) => path === "CandidateB/Worker" ? "high" : "med";
  const assignments = checkDocument({ ...cb, document, ladder: rungs, strengthOf, SANDBOX: sandbox, BRANCHES: shells ? cb.BRANCHES : {} });
  const ladder = new schedules.ModelLadder(guardedModels(models, log, assignments), rungs);
  const counted = shells ? undefined : countedCollection();
  if (counted) lifetime.defer(() => counted.collection.close());
  const execution = await JuncoGraph.fromYaml(document, {
    cwd, tools: collections, collection: counted?.collection, ladder, tracer: new tracer.DummyTracer(),
    scheduler: (_, prefix) => schedules.strength((_snapshot, id) => strengthOf(`${prefix}/${id}`), schedules.parallel()),
    agentOptions: await recordedSessions(assignments, cwd, repo, index),
  });
  try {
    collectAgents(execution.graph, members);
    expect([...members.keys()].sort()).toEqual(["CandidateA/Worker", "CandidateB/Worker"]);
    await execution.run();
    for (const branch of branches) {
      const result = execution.graph.result(graph.NodeId.create(`Candidate${branch}`));
      expect(result._tag === "Some" && syntax.finalText(result.value, branch)).toBe(`Worker ${branch}${shells ? `: ${branch}` : ""}`);
    }
    if (shells) {
      expect(await cancelBranch(cb.BRANCHES, containers, members)("A")).toEqual([]);
      expect([running(containers.candidateA), running(containers.acceptA)]).toEqual([false, false]);
      expect([running(containers.candidateB), running(containers.acceptB)]).toEqual([true, true]);
    }
  } finally {
    await execution.graph.close();
  }
  if (counted) expect(counted.active.bindings).toBe(0);
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const entries = readFileSync(index, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(entries).toHaveLength(2);
  expect(entries[0].session).not.toBe(entries[1].session);
  for (const branch of branches) {
    const role = `Candidate${branch}/Worker`;
    const model = branch.toLowerCase();
    expect(requests.filter((r) => r.role === role)).toEqual(Array(shells ? 2 : 1).fill({ role, provider: "swe", model }));
    const entry = entries.find((e) => e.node === role);
    expect(entry.model).toBe(`swe/${model}`);
    const messages = await sessionMessages(dir, entry.session);
    const last = messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toContainEqual(expect.objectContaining({ type: "text", text: `Worker ${branch}${shells ? `: ${branch}` : ""}` }));
    expect(messages.some((m) => m?.role === "toolResult" && m.toolName === "bash")).toBe(shells);
  }
}

test("nested guard accepts only each worker's selected rung and records its own durable session", () => nestedWorkers(false));
test("same-named nested workers call only their own container bash and cancelling A leaves B live", () => nestedWorkers(true), 120_000);

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
  const bash = tools.BashTool.create("/testbed", sandboxBash(workflow, containers, acquired, (reason) => { fatal = reason; })("CandidateA/Worker"));
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
