#!/usr/bin/env bun
/**
 * Junco runtime for the shared SWE-bench workflow pairs in junco/examples/swebench: ./<pair>.{yml,ts} link into
 * the frozen .junco-snapshot (benchmark.py is the corpus CLI). SWEBENCH_PAIR selects the pair (default wf).
 *
 *   bun run run-workflow.ts --preflight                      live smoke: both models, a real tool call, a code-relayed handoff
 *   bun run run-workflow.ts --check <problem-directory>      offline validation of the shared pair against one problem
 *   bun run run-workflow.ts <problem-directory> <manifest.json> <artifact-directory>   internal worker
 *
 * Models come from Pi's saved logins (~/.pi/agent; MODELS) and the pair's ladder: each agent is
 * created with its role's model and every provider request is checked against exactly that model at the
 * Models boundary. Each agent's bash runs in its role's container from the manifest written by
 * benchmark.py. Artifacts: requests.jsonl (accepted requests by node and model), recordings/ (durable Pi
 * sessions: committed messages, tool calls, tool results, usage) with recordings/index.jsonl mapping node →
 * model → session file, profile.jsonl (Junco profile samples; per-request USD under the profile optimizer), the
 * workflow's own plans, check logs, patches and verdicts, outcome.json (the worker's verdict) and, under the
 * profile optimizer, profile-receipt.json (the run's nonce and graph hash, once every recording closed cleanly).
 * Telemetry (see `telemetry`): every graph run is traced to Opik project `swebench`; Grafana retains profile metrics.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type Api, getSupportedThinkingLevels, lazyStream, type Model, type TSchema, Type } from "@earendil-works/pi-ai";
import { type BashOperations, createBashTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { agent, graph, JuncoGraph, schedules, syntax, tracer } from "junco";
import { benchmarkTelemetry, grafanaUrl } from "../benchmark-telemetry.ts";
import type * as Pair from "./wf.ts";

const ROOT = import.meta.dir;
const PAIR = process.env.SWEBENCH_PAIR ?? "wf";
if (!/^[A-Za-z0-9_-]+$/.test(PAIR)) throw new Error("SWEBENCH_PAIR must be a bare file stem");
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

/**
 * The only models the benchmark may call: every model Pi offered through a saved login on 2026-10-31
 * (user-approved for cost optimization; previously Sonnet 5 workers, Opus 5.5 leads). The pair's ladder picks.
 */
export const MODELS: readonly string[] = [
  "flint/flint",
  "github-copilot/gpt-6-luna",
  "github-copilot/claude-haiku-5.5",
  "github-copilot/gpt-5.6-luna",
  "github-copilot/mai-code-1.1-flash",
  "github-copilot/gemini-3.8-flash",
  "github-copilot/claude-haiku-4.5",
  "github-copilot/grok-4.6",
  "github-copilot/grok-4.7",
  "github-copilot/claude-sonnet-5",
  "github-copilot/claude-sonnet-5.5",
  "github-copilot/gpt-6-sol",
  "github-copilot/gpt-6.1-sol",
  "github-copilot/gemini-4-argon",
  "github-copilot/gpt-5.6-terra",
  "github-copilot/gpt-5.3-codex",
  "github-copilot/claude-opus-5.5",
  "github-copilot/gpt-5.6-sol",
  "github-copilot/claude-opus-5",
  "github-copilot/gpt-6-astra",
];
const WORKDIR = "/testbed";
const ACTIVATE = "source /opt/miniconda3/bin/activate\nconda activate testbed";
const GIT = ["git", "-c", "safe.directory=/testbed", "-C", WORKDIR];
/** Junco's communication tools. Bound tools are the only others. */
const COMMUNICATION_TOOLS: Record<string, true> = { yield: true, info: true, send: true, recv: true };
/**
 * Junco defaults every agent loses: the host file and shell natives (a node's bound container bash replaces
 * the native bash) and `task`, so nodes cannot spawn undeclared work.
 */
export const BLOCKED_DEFAULTS: readonly string[] = [
  "ast_edit", "ast_grep", "bash", "code_graph", "diff", "edit", "find", "grep", "read", "release", "task",
];
/** What the workflow module may import. */
const IMPORTS: Record<string, true> = {
  junco: true,
  "@earendil-works/pi-ai": true,
  "@earendil-works/pi-agent-core": true,
  "@earendil-works/pi-coding-agent": true,
  "dataflow-engine": true,
  [`./${PAIR}.yml`]: true,
};

/** The pair; a profile-optimizer candidate module also exports its run's nonce and graph hash. */
type Workflow = Pick<typeof Pair, "document" | "ladder" | "strengthOf" | "run" | "ROLES" | "SANDBOX"> & {
  readonly code: Readonly<Record<string, unknown>>;
  readonly BRANCHES: Readonly<Partial<typeof Pair.BRANCHES>>;
  readonly profileRun?: { readonly nonce: string };
  readonly graphHash?: string;
};
// Junco exports no name for the YAML agent instantiation createJuncoAgent returns.
type Agent = Awaited<ReturnType<typeof syntax.createJuncoAgent>>;
type Manifest = { baseline: string; containers: Record<Pair.Role, string> };
type Outcome = {
  workflow_status: "completed" | "error" | "cancelled";
  terminal_text: string | null;
  error: string | null;
};

/** An error with its aggregate members and cause chain (a failed node reports only its id; the reason is the cause). */
export const describe = (error: unknown): string =>
  error instanceof AggregateError
    ? `${error.message}: ${error.errors.map(describe).join("; ")}`
    : error instanceof Error
      ? error.cause === undefined
        ? error.message
        : `${error.message}: ${describe(error.cause)}`
      : String(error);
const tail = (text: string, size = 2000): string => (text.length <= size ? text : `…${text.slice(-size)}`);

/** Every rung is one of MODELS (thinking support needs the model catalog: see checkThinking). */
export function checkLadder(ladder: unknown): asserts ladder is schedules.Ladder {
  schedules.validateLadder(ladder as schedules.Ladder);
  for (const [name, rung] of Object.entries(ladder as schedules.Ladder))
    if (!MODELS.includes(rung.model)) throw new Error(`ladder rung ${name} must be one of ${MODELS.join(", ")}, got ${rung.model}`);
}

/** Every rung's thinking level (omitted = off) is one its model supports, so Pi never silently clamps it. */
export function checkThinking(models: ModelRuntime, ladder: schedules.Ladder): void {
  for (const [name, { model, thinking = "off" }] of Object.entries(ladder)) {
    const slash = model.indexOf("/");
    const resolved = models.getModel(model.slice(0, slash), model.slice(slash + 1));
    if (resolved === undefined) throw new Error(`ladder rung ${name}: ${model} is not in the model catalog`);
    const supported = getSupportedThinkingLevels(resolved);
    if (!supported.includes(thinking))
      throw new Error(`ladder rung ${name}: ${model} does not support thinking ${thinking} (supported: ${supported.join(", ")})`);
  }
}

/** Pi's saved-login runtime; fails unless every ladder model is credentialed, available and supports its thinking level. */
async function copilotModels(ladder: schedules.Ladder): Promise<ModelRuntime> {
  const models = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  // Pi's cached catalog (~/.pi/agent/models-store.json) holds MODELS newer than the built-in one; no network.
  await models.refresh({ allowNetwork: false });
  const error = models.getError();
  if (error) throw new Error(`Pi model runtime: ${error}`);
  const wanted = [...new Set(Object.values(ladder).map((rung) => rung.model))];
  const credentials = await models.listCredentials();
  for (const providerId of new Set(wanted.map((model) => model.split("/")[0]))) {
    if (!credentials.some((c) => c.providerId === providerId)) throw new Error(`No saved Pi credential for ${providerId}`);
    const available = await models.getAvailable(providerId);
    for (const model of wanted.filter((m) => m.startsWith(`${providerId}/`)))
      if (!available.some((m) => `${m.provider}/${m.id}` === model)) throw new Error(`${model} is not available through the saved login`);
  }
  checkThinking(models, ladder);
  return models;
}

/** Rejects a request to any model but `allowed` before it is sent; records accepted requests. */
function route(log: string, role: string, allowed: string, model: Pick<Model<Api>, "provider" | "id">): void {
  const target = `${model.provider}/${model.id}`;
  if (target !== allowed) throw new Error(`${role}: refused request to ${target}; this role may only use ${allowed}`);
  appendFileSync(log, `${JSON.stringify({ role, provider: model.provider, model: model.id })}\n`);
}

/**
 * ModelRuntime methods that send a provider request, each taking the target model first, by the
 * shape a refusal must take: an error stream, an error message, or a rejection.
 */
const REQUEST_METHODS: Record<string, "stream" | "message" | "reject"> = {
  stream: "stream",
  streamSimple: "stream",
  streamDeferred: "stream",
  complete: "message",
  completeSimple: "message",
  fetchDeferred: "message",
  cancelDeferred: "reject",
  generateImages: "reject",
  classify: "reject",
};

/**
 * `models` for one agent `role` that may only call `allowed`: every provider request goes through `route` first.
 * Pi swallows errors thrown by `before_request` hooks, so the refusal happens at the Models boundary,
 * as the provider failure Pi expects (a thrown request is a harness invariant fault).
 */
export function guardedModels(models: ModelRuntime, log: string, role: string, allowed: string): ModelRuntime {
  return new Proxy(models, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const shape = typeof key === "string" && Object.hasOwn(REQUEST_METHODS, key) ? REQUEST_METHODS[key] : undefined;
      if (shape === undefined) return value.bind(target);
      return (model: Model<Api>, ...rest: unknown[]) => {
        try {
          route(log, role, allowed, model);
        } catch (error) {
          if (shape === "reject") return Promise.reject(error);
          const refused = lazyStream(model, () => Promise.reject(error));
          return shape === "stream" ? refused : refused.result();
        }
        return value.call(target, model, ...rest);
      };
    },
  });
}

type AgentFactory = {
  readonly models: ModelRuntime;
  readonly ladder: schedules.Ladder;
  /** The rung of a root-relative agent path (`Lead`, `Planner/Draft`). */
  readonly strengthOf: (path: string) => schedules.ModelStrengthName;
  readonly log: string;
  readonly repo: JsonlSessionRepo;
  /** recordings/index.jsonl: one `{node, model, session}` line per agent; `node` is its root-relative path. */
  readonly index: string;
  /** Per-agent-path instances of each supplied tool name; any other supplied tool is refused. */
  readonly bind: Readonly<Record<string, (path: string) => AgentTool>>;
  /** Acquired agents by root-relative path, in acquisition order. */
  readonly acquired: Map<string, Agent>;
};

/**
 * The guarded factory: the agent's role model from the ladder (the same rung the strength scheduler
 * selects), a durable JSONL session, its node's bound tools plus Junco's defaults except BLOCKED_DEFAULTS it
 * does not replace and the spec's own tool_block, and the spec's collection, recorder and skills.
 */
async function createAgent(factory: AgentFactory, spec: syntax.AgentSpec): Promise<Agent> {
  const { path } = spec;
  if (factory.acquired.has(path)) throw new Error(`${path}: agent already created`);
  const tools = spec.tools.flatMap((tool): AgentTool[] => {
    if (!("name" in tool)) throw new Error(`${path}: mcp tools are not permitted`);
    if (tool.name === "task") return [];
    if (Object.hasOwn(COMMUNICATION_TOOLS, tool.name)) return [tool];
    const bound = factory.bind[tool.name];
    if (bound === undefined) throw new Error(`${path}: tool ${tool.name} is not permitted`);
    return [bound(path)];
  });
  const { model, thinking = "off" } = factory.ladder[factory.strengthOf(path)];
  const slash = model.indexOf("/");
  // Junco owns the session from here on, including when creation fails.
  const session = await factory.repo.create({ cwd: spec.cwd }, BACKGROUND_CONTEXT);
  appendFileSync(factory.index, `${JSON.stringify({ node: path, model, session: session.metadata.path })}\n`);
  const instance = await agent.JuncoAgent.create<Skill, PromptTemplate, TSchema, unknown>({
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    models: guardedModels(factory.models, factory.log, path, model),
    thinkingLevel: thinking,
    session,
    systemPrompt: spec.systemPrompt,
    cwd: spec.cwd,
    tools,
    tool_block: [...new Set([
      ...BLOCKED_DEFAULTS.filter((name) => !tools.some((tool) => tool.name === name)),
      ...(spec.tool_block ?? []),
    ])],
    collection: spec.collection,
    recorder: spec.recorder,
    recorderNodeId: spec.recorderNodeId,
    ...(spec.skills.length ? { resources: { skills: spec.skills } } : {}),
  });
  factory.acquired.set(path, instance);
  return instance;
}

/** Closes every factory agent (idempotent after graph close); returns the failures. */
async function closeAgents(acquired: ReadonlyMap<string, Agent>): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const instance of [...acquired.values()].reverse()) {
    try {
      await instance.return();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** Releases the run's recording resources in order, each even when an earlier one failed. */
async function closeRecording(
  acquired: ReadonlyMap<string, Agent>,
  repo: JsonlSessionRepo,
  env: NodeExecutionEnv,
  recorder: tracer.ProfileRecorder<string>,
): Promise<unknown[]> {
  const failures = await closeAgents(acquired);
  for (const release of [() => repo.close(BACKGROUND_CONTEXT), () => env.cleanup(BACKGROUND_CONTEXT), () => recorder.close()]) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** One profiling session recorded into every sink; flush and close settle all of them and report each failure. */
export function teeRecorder(sinks: readonly tracer.ProfileRecorder<string>[]): tracer.ProfileRecorder<string> {
  const views = new Map<string, tracer.ProfileRecorder<string>>();
  const settle = async (step: (sink: tracer.ProfileRecorder<string>) => Promise<void>): Promise<void> => {
    const failed = (await Promise.allSettled(sinks.map(step))).flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (failed.length) throw new AggregateError(failed, "profile recording failed");
  };
  const view = (parts: readonly tracer.ProfileRecorder<string>[]): tracer.ProfileRecorder<string> => {
    const self: tracer.ProfileRecorder<string> = {
      get root() {
        return root;
      },
      path: parts[0].path,
      add_context: (id) => {
        if (id === "") return self;
        const children = parts.map((part) => part.add_context(id));
        let child = views.get(children[0].path);
        if (child === undefined) views.set(children[0].path, (child = view(children)));
        return child;
      },
      record: (event) => {
        for (const part of parts) part.record(event);
      },
      flush: () => settle((sink) => sink.flush()),
      close: () => settle((sink) => sink.close()),
    };
    return self;
  };
  const root = view(sinks);
  return root;
}

/**
 * Telemetry beside profile.jsonl. Every graph run is exported to Opik as trace `name`, configured by the SDK's
 * OPIK_* variables and ~/.opik.config. GRAFANA_URL defaults to http://localhost:8000 and persists the profile
 * as Prometheus metrics through Grafana (the dashboard link goes to stderr).
 */
async function telemetry(
  profile: tracer.JsonlRecorder,
  name: string,
): Promise<{ recorder: tracer.ProfileRecorder<string>; tracer: tracer.DataflowTracer }> {
  const live = await benchmarkTelemetry("swebench", name, "junco-swebench");
  return { recorder: teeRecorder([profile, live.recorder]), tracer: live.tracer };
}

function dockerEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];
  return Object.fromEntries(keep.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
}

/** Stops an owned container so no command started through docker exec survives. */
const stopContainer = (container: string): Promise<void> => docker(["kill", container]).then(
  () => {},
  () => {},
);

/**
 * Pi's bash tool executing in `container` at /testbed under the testbed conda environment.
 * The host environment the tool supplies is ignored. On timeout or abort, `onFatal` runs after the
 * container is stopped (descendants of a killed docker-exec client would otherwise survive).
 */
export function containerBash(container: string, onFatal: (reason: Error) => void): AgentTool {
  const operations: BashOperations = {
    exec: async (command, _cwd, { onData, signal, timeout }) => {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
        throw new Error("Invalid timeout: must be a finite number of seconds");
      if (signal?.aborted) throw new Error("aborted");
      const { promise, resolve: settle, reject } = Promise.withResolvers<{ exitCode: number | null }>();
      const child = spawn("docker", ["exec", "--workdir", WORKDIR, container, "/bin/bash", "-lc", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: dockerEnv(),
      });
      let stopped: "aborted" | "timeout" | undefined;
      let stopping: Promise<void> | undefined;
      const stop = (why: "aborted" | "timeout") => {
        if (stopped) return;
        stopped = why;
        child.kill("SIGKILL");
        stopping = stopContainer(container).then(() =>
          onFatal(new Error(why === "timeout" ? `bash command exceeded its ${timeout}s timeout` : "bash command aborted")),
        );
      };
      const onAbort = () => stop("aborted");
      const timer = timeout === undefined ? undefined : setTimeout(() => stop("timeout"), timeout * 1000);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", reject);
      child.on("close", (code, signalName) =>
        settle({ exitCode: code ?? (signalName ? 128 + (osConstants.signals[signalName] ?? 0) : null) }),
      );
      try {
        const result = await promise;
        if (stopped) {
          await stopping;
          throw new Error(stopped === "timeout" ? `timeout:${timeout}` : "aborted");
        }
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
  return createBashTool(WORKDIR, { operations, commandPrefix: ACTIVATE, exposeSessionEnvironment: false });
}

/** One docker CLI call: exit code and the complete stdout bytes and stderr text. */
function docker(args: readonly string[], input?: string): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const { promise, resolve: done, reject } = Promise.withResolvers<{ code: number; stdout: Buffer; stderr: string }>();
  const child = spawn("docker", args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: dockerEnv() });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", reject);
  child.on("close", (code, signalName) =>
    done({
      code: code ?? 128 + (signalName ? (osConstants.signals[signalName] ?? 0) : 0),
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString(),
    }),
  );
  if (input !== undefined) child.stdin?.end(input);
  return promise;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The workflow's deterministic container operations over the manifest's containers, with the same git
 * semantics as benchmark.py's extract_patch: `git add -A`, then the binary diff against the baseline.
 */
export function sandboxOps(containers: Readonly<Record<string, string>>, baseline: string): Pair.Host["sandbox"] {
  const id = (role: string): string => {
    const container = containers[role];
    if (container === undefined) throw new Error(`no container for sandbox role ${role}`);
    return container;
  };
  const exec = (role: string, argv: readonly string[], input?: string) =>
    docker(["exec", ...(input === undefined ? [] : ["-i"]), "--workdir", WORKDIR, id(role), ...argv], input);
  const checked = async (role: string, argv: readonly string[], what: string): Promise<Buffer> => {
    const result = await exec(role, argv);
    if (result.code !== 0) throw new Error(`${role}: ${what} failed (${result.code}): ${tail(result.stderr || result.stdout.toString())}`);
    return result.stdout;
  };
  const state = async (role: string): Promise<string> => {
    const result = await docker(["inspect", "-f", "{{.State.Running}}", id(role)]);
    if (result.code !== 0) throw new Error(`${role}: docker inspect failed: ${tail(result.stderr)}`);
    return result.stdout.toString().trim();
  };
  const running = async (role: string): Promise<void> => {
    if ((await state(role)) !== "true") throw new Error(`${role}: container ${id(role)} is not running`);
  };
  return {
    async run(role, command, timeout) {
      await running(role);
      const result = await exec(role, ["timeout", "--signal=KILL", `${timeout}s`, "/bin/bash", "-lc", `exec 2>&1\n${ACTIVATE}\n${command}`]);
      return { exit_code: result.code, output: result.stdout.toString() + result.stderr };
    },
    async capture(role) {
      // A container stopped on a tool timeout or abort keeps its files.
      if ((await state(role)) !== "true") {
        const started = await docker(["start", id(role)]);
        if (started.code !== 0) throw new Error(`${role}: docker start failed: ${tail(started.stderr)}`);
      }
      await checked(role, [...GIT, "add", "-A"], "git add");
      return utf8.decode(await checked(role, [...GIT, "diff", "--cached", "--binary", baseline, "--"], "git diff"));
    },
    async apply(role, patch) {
      await running(role);
      const write = await exec(role, ["/bin/bash", "-c", "cat > /tmp/cb.patch"], patch);
      if (write.code !== 0) throw new Error(`${role}: could not stage the patch: ${tail(write.stderr)}`);
      const git = GIT.join(" ");
      const result = await exec(role, ["/bin/bash", "-c", `${git} apply --check /tmp/cb.patch && ${git} apply /tmp/cb.patch`]);
      return { exit_code: result.code, output: result.stdout.toString() + result.stderr };
    },
    async reset(role) {
      await checked(role, [...GIT, "reset", "-q", "--hard", baseline], "git reset");
      await checked(role, [...GIT, "clean", "-qfd"], "git clean");
    },
  };
}

function readProblem(problemDir: string): Pair.Problem {
  const value = JSON.parse(readFileSync(join(problemDir, "problem.json"), "utf8"));
  const keys = ["instance_id", "repo", "base_commit", "problem_statement"];
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join() !== [...keys].sort().join() ||
    keys.some((key) => typeof value[key] !== "string")
  )
    throw new Error("problem.json must hold exactly instance_id, repo, base_commit and problem_statement strings");
  return value;
}

/** The manifest benchmark.py writes: one distinct container per workflow role at one 40-hex baseline. */
function readManifest(path: string, roles: readonly string[]): Manifest {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const containers = value?.containers;
  if (typeof value?.baseline !== "string" || !/^[0-9a-f]{40}$/.test(value.baseline))
    throw new Error("manifest baseline must be a 40-hex commit");
  if (
    typeof containers !== "object" ||
    containers === null ||
    Object.keys(containers).sort().join() !== [...roles].sort().join() ||
    roles.some((role) => typeof containers[role] !== "string" || !containers[role]) ||
    new Set(Object.values(containers)).size !== roles.length
  )
    throw new Error(`manifest containers must map exactly ${roles.join(", ")} to distinct container IDs`);
  return value;
}

/** The shared pair, imported only after its imports passed the allowlist. */
async function loadWorkflow(): Promise<Workflow> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const { path } of transpiler.scanImports(readFileSync(join(ROOT, `${PAIR}.ts`), "utf8")))
    if (!Object.hasOwn(IMPORTS, path) && !path.startsWith("node:") && !builtinModules.includes(path))
      throw new Error(`${PAIR}.ts imports ${path}; only junco, Pi packages, dataflow-engine, Node built-ins and ./${PAIR}.yml are permitted`);
  const module = await import(join(ROOT, `${PAIR}.ts`));
  for (const name of ["run", "strengthOf"])
    if (typeof module[name] !== "function") throw new Error(`${PAIR}.ts must export ${name}`);
  if (typeof module.document?.graph !== "object") throw new Error(`${PAIR}.ts must export document = syntax.parse(source)`);
  for (const name of ["code", "SANDBOX", "BRANCHES"])
    if (typeof module[name] !== "object" || module[name] === null) throw new Error(`${PAIR}.ts must export ${name}`);
  if (!Array.isArray(module.ROLES)) throw new Error(`${PAIR}.ts must export ROLES`);
  checkLadder(module.ladder);
  return module as Workflow;
}

/** Acceptance sandboxes: only code nodes run checks there, never an agent. */
const ACCEPTANCE: readonly string[] = ["acceptA", "acceptB", "acceptFinal"];
/**
 * The one mutable sandbox shared by agents: the Integrator finishes before Freeze starts the Verifier, so each
 * of those roots may hold one bash leaf in canonical. Every other sandbox has at most one bash leaf.
 */
const SHARED: Readonly<Record<string, readonly string[]>> = { canonical: ["Integrator", "Verifier"] };

/** `path` is the node path `root` or one of its descendants (never a merely prefixed sibling). */
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * Offline checks of the pair against this runtime, at every graph depth: defined code (by local ID, as Junco
 * resolves it), no MCP/skills, bash the only bound tool and only on an agent path with its own sandbox, and
 * branch roots whose bash leaves are confined to that branch's sandboxes.
 */
export function checkDocument(workflow: Workflow): void {
  const { document, code, SANDBOX, BRANCHES, ROLES } = workflow;
  if (document.mcp !== undefined || document.skills !== undefined) throw new Error("mcp and skills registries are not permitted");
  const roles: readonly string[] = ROLES;
  /** Agent and nested-graph paths: the nodes a branch may be rooted at. */
  const roots = new Set<string>();
  const bashUsers: string[] = [];
  const walk = (graph: syntax.GraphSpec, prefix: string): void => {
    for (const [id, node] of Object.entries(graph.nodes)) {
      const path = prefix + id;
      if (id.includes("/")) throw new Error(`${path}: node IDs must not contain /`);
      if (node.kind === "graph") {
        roots.add(path);
        walk(node.graph, `${path}/`);
      } else if (node.kind === "code") {
        if (typeof (code as Record<string, unknown>)[id] !== "function") throw new Error(`code node ${path} has no exported definition ${id} in code`);
      } else if (node.kind !== "emit") {
        roots.add(path);
        if (node.mcp?.length || node.skills?.length) throw new Error(`${path}: mcp and skills are not permitted`);
        for (const tool of node.tools ?? []) if (tool !== "bash") throw new Error(`${path}: tool ${tool} is not permitted`);
        if (node.tools?.includes("bash")) bashUsers.push(path);
      }
    }
  };
  walk(document.graph, "");
  for (const path of bashUsers) if (!Object.hasOwn(SANDBOX, path)) throw new Error(`${path} uses bash but has no sandbox`);
  const users = new Map<string, string[]>();
  for (const [path, role] of Object.entries(SANDBOX)) {
    if (!bashUsers.includes(path) || !roles.includes(role)) throw new Error(`SANDBOX.${path} must bind a bash-using agent path to one of ${roles.join(", ")}`);
    if (ACCEPTANCE.includes(role)) throw new Error(`SANDBOX.${path}: acceptance sandbox ${role} is reserved for code nodes`);
    users.set(role, [...(users.get(role) ?? []), path]);
  }
  for (const [role, paths] of users) {
    const shared = SHARED[role];
    if (
      shared === undefined
        ? paths.length > 1
        : paths.some((path) => !shared.some((root) => within(path, root))) ||
          shared.some((root) => paths.filter((path) => within(path, root)).length > 1)
    )
      throw new Error(`sandbox ${role} would be shared by ${paths.join(", ")}`);
  }
  // Overlapping roots and outside use of a branch sandbox are impossible past this point: every member binds
  // its branch's candidate sandbox, which holds one bash leaf, and no agent binds an acceptance sandbox.
  for (const [branch, { agent: root, sandboxes }] of Object.entries(BRANCHES)) {
    const own = [`candidate${branch}`, `accept${branch}`];
    const cancels: readonly string[] = sandboxes;
    if (!roots.has(root)) throw new Error(`branch ${branch} root ${root} must be an agent or nested graph path`);
    const members = bashUsers.filter((path) => within(path, root));
    if (!members.length) throw new Error(`branch ${branch} root ${root} has no bash agent`);
    for (const path of members) if (SANDBOX[path] !== own[0]) throw new Error(`${path} in branch ${branch} must use sandbox ${own[0]}`);
    if (cancels.length !== own.length || own.some((role) => !cancels.includes(role) || !roles.includes(role)))
      throw new Error(`branch ${branch} must cancel exactly the known sandboxes ${own.join(" and ")}`);
  }
}

/** Offline validation; resolves agents with the unbound bash stand-in only to type-check tool names, never executing it. */
async function check(problemDir: string): Promise<{ problem: string; models: Record<string, string> }> {
  const dir = resolve(problemDir);
  grafanaUrl(); // benchmark.py's validate step: a bad GRAFANA_URL fails before any instance starts
  const problem = readProblem(dir);
  const workflow = await loadWorkflow();
  if (!Bun.deepEquals(syntax.parse(readFileSync(join(ROOT, `${PAIR}.yml`), "utf8")), workflow.document))
    throw new Error(`document is not syntax.parse(${PAIR}.yml)`);
  checkDocument(workflow);
  const specs = await syntax.resolveAgents(workflow.document, { cwd: dir, tools: { bash: UNBOUND_BASH } });
  const models = Object.fromEntries(specs.map((spec) => [spec.path, workflow.ladder[workflow.strengthOf(spec.path)].model]));
  return { problem: problem.instance_id, models };
}

function writeOutcome(artifacts: string, outcome: Outcome): void {
  const path = join(artifacts, "outcome.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(outcome)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** A stand-in that lets resolveAgents type the YAML `bash` name; the factory always replaces it per node. */
const UNBOUND_BASH: AgentTool = {
  name: "bash",
  label: "bash",
  description: "unbound",
  parameters: Type.Object({}),
  execute: async () => {
    throw new Error("bash was not bound to a sandbox");
  },
};

type Abortable = { abort(): Promise<unknown> };

/**
 * Each bash-using agent path's container-bound bash. A contender's tool timeout or abort stays in its branch:
 * its container is stopped and every acquired agent under the branch root aborted, so it is judged invalid.
 * Any other is instance-fatal.
 */
export function sandboxBash(
  workflow: Pick<Workflow, "SANDBOX" | "BRANCHES">,
  containers: Readonly<Record<string, string>>,
  acquired: ReadonlyMap<string, Abortable>,
  fatal: (reason: Error) => void,
): (path: string) => AgentTool {
  return (path) => {
    const role = workflow.SANDBOX[path];
    if (role === undefined) throw new Error(`${path} has no sandbox`);
    const branch = Object.entries(workflow.BRANCHES).find(([, config]) => within(path, config.agent));
    return containerBash(containers[role], (reason) => {
      if (branch === undefined) return fatal(reason);
      const [name, { agent: root }] = branch;
      console.error(`candidate ${name}: ${reason.message}; aborting ${root}`);
      // Not awaited: an abort may wait on this very tool call.
      for (const [member, instance] of acquired) if (within(member, root)) instance.abort().catch(() => {});
    });
  };
}

/** Host.cancel: aborts every acquired agent under the branch root, then stops its sandboxes; reports failures and never throws. */
export function cancelBranch(
  branches: Workflow["BRANCHES"],
  containers: Readonly<Record<string, string>>,
  acquired: ReadonlyMap<string, Abortable>,
): Pair.Host["cancel"] {
  return async (branch) => {
    const config = branches[branch];
    if (config === undefined) return [`unknown candidate branch ${branch}`];
    const { agent: root, sandboxes } = config;
    const members = [...acquired].filter(([path]) => within(path, root));
    // Every abort starts before any is awaited; async turns a synchronous throw into a recorded rejection.
    const settled = await Promise.allSettled(members.map(async ([, instance]) => instance.abort()));
    const failures = settled.flatMap((result, i) =>
      result.status === "rejected" ? [`abort ${members[i][0]}: ${describe(result.reason)}`] : [],
    );
    for (const role of sandboxes) await stopContainer(containers[role]);
    console.error(`cancelled candidate ${branch}: ${failures.join("; ") || "ok"}`);
    return failures;
  };
}

/** Executes the shared pair for one problem against the manifest's containers; always writes outcome.json. */
async function worker(problemDir: string, manifestPath: string, artifacts: string): Promise<number> {
  const dir = resolve(problemDir);
  const log = join(artifacts, "requests.jsonl");
  writeFileSync(log, "", { flag: "wx" });
  const recordings = join(artifacts, "recordings");
  mkdirSync(recordings);
  const index = join(recordings, "index.jsonl");
  writeFileSync(index, "", { flag: "wx" });
  const controller = new AbortController();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    controller.abort(new Error("cancelled by operator"));
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const acquired = new Map<string, Agent>();
  const env = new NodeExecutionEnv({ cwd: artifacts });
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: recordings });
  // Both optimizers record per-provider-request cost, failed and cancelled requests included.
  const profiling = process.env.JUNCO_PROFILE_RUN_DIR !== undefined || process.env.JUNCO_GRAPH_RUN_DIR !== undefined;
  const profile = new tracer.JsonlRecorder({ path: join(artifacts, "profile.jsonl"), ...(profiling ? { costMode: "usage" } : {}) });
  let recorder: tracer.ProfileRecorder<string> = profile;
  let receipt: { nonce: string; graphHash: string } | undefined;
  let outcome: Outcome;
  try {
    const problem = readProblem(dir);
    const workflow = await loadWorkflow();
    checkDocument(workflow);
    if (workflow.profileRun !== undefined && workflow.graphHash !== undefined)
      receipt = { nonce: workflow.profileRun.nonce, graphHash: workflow.graphHash };
    const { baseline, containers } = readManifest(manifestPath, workflow.ROLES);
    const host: Pair.Host = {
      problem,
      sandbox: sandboxOps(containers, baseline),
      save: (name, data) => {
        const path = join(artifacts, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
        return path;
      },
      cancel: cancelBranch(workflow.BRANCHES, containers, acquired),
    };
    const bash = sandboxBash(workflow, containers, acquired, (reason) => controller.abort(reason));
    const models = await copilotModels(workflow.ladder);
    const observers = await telemetry(profile, problem.instance_id);
    recorder = observers.recorder;
    const factory: AgentFactory = { models, ladder: workflow.ladder, strengthOf: workflow.strengthOf, log, repo, index, bind: { bash }, acquired };
    const text = await workflow.run({
      cwd: dir,
      models,
      createAgent: (spec) => createAgent(factory, spec),
      tools: { bash: UNBOUND_BASH },
      tracer: observers.tracer,
      recorder,
      signal: controller.signal,
      context: host,
    });
    if (typeof text !== "string" || !text.trim()) throw new Error("workflow returned blank terminal text");
    outcome = { workflow_status: "completed", terminal_text: text, error: null };
  } catch (error) {
    outcome = { workflow_status: cancelled ? "cancelled" : "error", terminal_text: null, error: describe(error) };
  }
  const failures = await closeRecording(acquired, repo, env, recorder);
  if (failures.length)
    outcome = {
      workflow_status: outcome.workflow_status === "cancelled" ? "cancelled" : "error",
      terminal_text: null,
      error: [outcome.error, `cleanup failed: ${failures.map(describe).join("; ")}`].filter(Boolean).join("; "),
    };
  writeOutcome(artifacts, outcome);
  // Proof for benchmark.py's profile receipt: this instance's spend was fully recorded under the run's nonce and graph.
  if (receipt !== undefined && !failures.length && outcome.workflow_status !== "cancelled")
    writeFileSync(join(artifacts, "profile-receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx" });
  return outcome.workflow_status === "completed" ? 0 : outcome.workflow_status === "cancelled" ? 130 : 1;
}

const PREFLIGHT = `
graph:
  name: Preflight
  nodes:
    Probe:
      description: Calls the probe tool and returns its value.
      system: You are a test agent. Use tools exactly as instructed.
      tools: [probe]
      prompt: Call the probe tool once. Then reply with exactly the value it returned and nothing else.
    Relay:
      kind: code
      description: Hands Probe's normal final answer to Echo as a message, like the workflow's code nodes.
      trigger: Probe->Relay
    Echo:
      description: Repeats the handed-off value.
      system: You are a test agent.
      trigger: Relay~>Echo
      prompt: "Reply with exactly this value and nothing else: {{Relay~>Echo}}"
  edges:
    - {from: Probe, to: Relay, schema: {}}
    - {from: Relay, to: Echo, kind: message, schema: {type: object, required: [kind, text], properties: {kind: {const: prompt}, text: {type: string}}}}
    - {from: Echo, to: $sink, schema: {}}
`;
/** Preflight roles: the worker rung for the tool user, the lead rung for the receiver. */
const PREFLIGHT_STRENGTH = (node: string): schedules.ModelStrengthName => (node === "Echo" ? "xhigh" : "med");

/** Publishes Probe's final text once on Relay~>Echo. */
const Relay: syntax.DeterministicNode = ({ edges, policy }) => {
  const output = edges.get("Relay~>Echo");
  if (output === undefined) throw new Error("preflight declares no Relay~>Echo edge");
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const text = syntax.finalText(view.values.get(graph.EdgeId.create("Probe->Relay")), "Probe");
      published = true;
      yield [graph.Message.create(output, { kind: "prompt", text })];
    }, policy),
    is_available: (_view, triggered) => triggered && !published,
  };
};

type SessionEntry = { type?: string; message?: { role?: string; content?: unknown; toolName?: string } };

/** Committed message entries of a durable session, read back through a fresh repository. */
async function sessionMessages(root: string, path: string): Promise<SessionEntry["message"][]> {
  const env = new NodeExecutionEnv({ cwd: root });
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: root });
  try {
    const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find((m) => m.path === path);
    if (metadata === undefined) throw new Error(`no durable session at ${path}`);
    const session = await repo.open(metadata, BACKGROUND_CONTEXT);
    try {
      const entries = (await session.findEntries({ type: "message" }, BACKGROUND_CONTEXT)) as SessionEntry[];
      return entries.map((entry) => entry.message);
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await repo.close(BACKGROUND_CONTEXT);
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

/**
 * Live smoke through the worker's own factory and recording: a Sonnet tool call whose answer a code node
 * hands to an Opus receiver as a message (the workflow's handoff path); then the request log, the reopened
 * durable sessions and the profile are inspected.
 */
async function preflight(): Promise<void> {
  const artifacts = mkdtempSync(join(tmpdir(), "junco-cb-preflight-"));
  const log = join(artifacts, "requests.jsonl");
  const recordings = join(artifacts, "recordings");
  mkdirSync(recordings);
  const index = join(recordings, "index.jsonl");
  writeFileSync(index, "");
  const sentinel = crypto.randomUUID();
  let probes = 0;
  const probe: AgentTool = {
    name: "probe",
    label: "probe",
    description: "Returns the runtime probe value.",
    parameters: Type.Object({}),
    execute: async () => {
      probes++;
      return { content: [{ type: "text", text: sentinel }], details: undefined };
    },
  };
  const { ladder } = await loadWorkflow();
  const models = await copilotModels(ladder);
  const acquired = new Map<string, Agent>();
  const env = new NodeExecutionEnv({ cwd: artifacts });
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: recordings });
  const profilePath = join(artifacts, "profile.jsonl");
  const profile = new tracer.JsonlRecorder({ path: profilePath });
  const factory: AgentFactory = { models, ladder, strengthOf: PREFLIGHT_STRENGTH, log, repo, index, bind: { probe: () => probe }, acquired };
  let recorder: tracer.ProfileRecorder<string> = profile;
  let text: string;
  try {
    const observers = await telemetry(profile, "preflight");
    recorder = observers.recorder;
    const execution = await JuncoGraph.fromYaml(syntax.parse(PREFLIGHT), {
      cwd: ROOT,
      models,
      ladder,
      scheduler: () => schedules.strength((_snapshot, id) => PREFLIGHT_STRENGTH(id), schedules.parallel()),
      createAgent: (spec) => createAgent(factory, spec),
      code: { Relay },
      tools: { probe },
      tracer: observers.tracer,
      recorder,
    });
    try {
      await execution.run();
      const terminal = execution.graph.result(execution.graph.sink.id);
      if (terminal._tag !== "Some") throw new Error("preflight sink produced no result");
      text = syntax.finalText(terminal.value, "preflight sink");
    } finally {
      await execution.graph.close();
    }
  } finally {
    const failures = await closeRecording(acquired, repo, env, recorder);
    if (failures.length) throw new AggregateError(failures, "preflight cleanup failed");
  }
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { role: string; model: string });
  const sessions = readFileSync(index, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { node: string; model: string; session: string });
  const recorded: Record<string, { model: string; roles: string[]; tool_calls: string[]; tool_results: string[] }> = {};
  for (const { node, model, session } of sessions) {
    const messages = await sessionMessages(recordings, session);
    const calls = messages.flatMap((m) =>
      m?.role === "assistant" && Array.isArray(m.content)
        ? (m.content as { type?: string; name?: string }[]).filter((c) => c.type === "toolCall").map((c) => String(c.name))
        : [],
    );
    recorded[node] = {
      model,
      roles: messages.map((m) => String(m?.role)),
      tool_calls: calls,
      tool_results: messages.filter((m) => m?.role === "toolResult").map((m) => String(m?.toolName)),
    };
  }
  const profileSamples = readFileSync(profilePath, "utf8").trim().split("\n").filter(Boolean).length;
  const result = {
    probe_calls: probes,
    sentinel_reported: text.includes(sentinel),
    requests: requests.length,
    request_models: Object.fromEntries(requests.map((r) => [r.role, r.model])),
    recordings: recorded,
    profile_samples: profileSamples,
    artifacts,
  };
  console.log(JSON.stringify(result, null, 2));
  if (probes < 1 || !text.includes(sentinel)) throw new Error("preflight: the probe value did not reach the final answer");
  for (const role of ["Probe", "Echo"])
    if (!requests.some((r) => r.role === role)) throw new Error(`preflight: no recorded ${ladder[PREFLIGHT_STRENGTH(role)].model} request for ${role}`);
  const probeRecord = recorded.Probe;
  if (!probeRecord?.tool_calls.includes("probe") || !probeRecord.tool_results.includes("probe"))
    throw new Error("preflight: the durable Probe session lacks the committed probe call and its result");
  if (!recorded.Echo?.roles.includes("assistant")) throw new Error("preflight: the durable Echo session has no assistant message");
  if (profileSamples < 1) throw new Error("preflight: no profile samples were written");
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);
  try {
    if (first === "--preflight" && rest.length === 0) {
      await preflight();
      console.log("preflight: ok");
    } else if (first === "--check" && rest.length === 1) {
      console.log(JSON.stringify({ check: "ok", ...(await check(rest[0])) }));
    } else if (first !== undefined && !first.startsWith("--") && rest.length === 2) {
      process.exitCode = await worker(first, rest[0], rest[1]);
    } else {
      console.error("usage: run-workflow.ts --preflight | --check <problem-directory> | <problem-directory> <manifest.json> <artifact-directory>");
      process.exitCode = 64;
    }
  } catch (error) {
    console.error(`${first}: ${describe(error)}`);
    process.exitCode = 1;
  }
  // Pi/Junco may keep handles (keep-alive sockets) open after cleanup; exit with the decided status.
  process.exit(process.exitCode ?? 0);
}
