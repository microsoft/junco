// # CooperBench divide-and-conquer pair driver
//
// CooperBench's scripts/run_junco.py prepares two isolated, network-less task containers and runs this driver
// once per pair with a JSON request on stdin:
//
//   {"mode":"run","run_id":"<32-hex>","image_id":"sha256:<64-hex>",
//    "models":{"worker":"github-copilot/claude-sonnet-5","leader":"github-copilot/claude-opus-5.5"},
//    "thinking":{"worker":"off","leader":"low"},"timeout_ms":7200000,"problem_dir":"/abs/logs/<run>/team/<repo>/<task>/f5_f6",
//    "agents":{"agent1":{"feature_id":5,"task":"...","container_id":"<64-hex>"},
//              "agent2":{"feature_id":6,"task":"...","container_id":"<64-hex>"}}}
//
// The YAML document declares two private feature teams: each leader (high rung) reads only its own assignment,
// works in its own container and coordinates with the other leader over native send/recv. Its
// `divide` and `tournament` tools run leaf jobs as one-worker graphs (med rung) in disposable child
// containers restored from a snapshot of the leader's repository; only validated patches reach it.
// Stdout is JSONL only: every native message and committed usage row of every agent, tagged with
// its team (`agent_id`) and node (`node_id`), then exactly one terminal `result` record.
// `{"mode":"preflight",...}` verifies the saved Pi login, both models and their thinking levels, then prints one `ready`
// record naming the resolved Junco entrypoint. Profile samples go to `<problem_dir>/.junco/log.jsonl`.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { type FileHandle, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentTool,
  AgentToolResult,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import { contentText, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Agentic,
  type agent,
  AssistantMessageSchema,
  Deterministic,
  graph,
  JuncoGraph,
  schedules,
  syntax,
  tracer,
} from "junco";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import source from "./wf.yml" with { type: "text" };

const CONTAINER_ID = "^[0-9a-f]{64}$";
const GENERATION_TIMEOUT_MS = 7_200_000;
const WORKDIR = "/workspace/repo";
/** Combined stdout/stderr bytes a command result retains: its first and last halves. */
const OUTPUT_CAP = 64 * 1024;
/** Grace beyond the in-container `timeout -k 5` before the parent stops the sandbox. */
const WATCHDOG_GRACE_SECONDS = 10;
/** Ceiling of one driver-owned Docker provisioning, archive or patch operation. */
const OPERATION_MS = 600_000;
/** Label every container of one attempt carries; the launcher sweeps it after the driver stops. */
export const SCOPE_LABEL = "cooperbench.junco.scope";

// ## Request boundary

const strict = { additionalProperties: false } as const;
const Model = Type.String({ pattern: "^[^/]+/.+$" });
const Models = Type.Object({ worker: Model, leader: Model }, strict);
/** One Pi thinking level per role; preflight checks each against its model (Opus 5.5, for one, has no "off"). */
const Level = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const Thinking = Type.Object({ worker: Level, leader: Level }, strict);
const Assignment = Type.Object(
  {
    feature_id: Type.Integer({ minimum: 1 }),
    task: Type.String({ pattern: "\\S" }),
    container_id: Type.String({ pattern: CONTAINER_ID }),
  },
  strict,
);
const RunRequest = Type.Object(
  {
    mode: Type.Literal("run"),
    /** The attempt's container scope, labelled on every child container. */
    run_id: Type.String({ pattern: "^[0-9a-f]{32}$" }),
    /** The pinned task image both primaries run; child containers start from it. */
    image_id: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    models: Models,
    thinking: Thinking,
    timeout_ms: Type.Literal(GENERATION_TIMEOUT_MS),
    /** The pair's host directory: profile log and batch scratch space under its `.junco/`. */
    problem_dir: Type.String({ pattern: "^/" }),
    agents: Type.Object({ agent1: Assignment, agent2: Assignment }, strict),
  },
  strict,
);
const PreflightRequest = Type.Object(
  { mode: Type.Literal("preflight"), models: Models, thinking: Thinking },
  strict,
);
const DriverRequest = Type.Union([RunRequest, PreflightRequest]);

export type PairRequest = Static<typeof RunRequest>;
export type DriverRequest = Static<typeof DriverRequest>;
type AgentKey = keyof PairRequest["agents"];

/** The validated request in `text`; throws a diagnostic for malformed JSON, unknown fields or an invalid pair. */
export function parseRequest(text: string): DriverRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`request is not JSON: ${(error as Error).message}`);
  }
  if (!Value.Check(DriverRequest, value)) {
    const problems = [...Value.Errors(DriverRequest, value)].map(
      (error) => `${error.instancePath || "/"} ${error.message}`,
    );
    throw new Error(`invalid request: ${problems.join("; ")}`);
  }
  if (value.mode === "run") {
    const { agent1, agent2 } = value.agents;
    if (agent1.feature_id === agent2.feature_id)
      throw new Error("invalid request: the two agents need distinct feature_id");
    if (agent1.container_id === agent2.container_id)
      throw new Error("invalid request: the two agents need distinct container_id");
  }
  return value;
}

// ## Models and documents

/**
 * Workers on smol/low/med, leaders on high/xhigh, each with its role's thinking level ("off" omits
 * the rung's `thinking`). The launcher defaults (github-copilot/claude-sonnet-5 workers off,
 * github-copilot/claude-opus-5.5 leaders low) were checked on 2026-10-30 against the saved Pi catalog
 * (Sonnet 5 supports off; Opus 5.5 supports low and up), the saved GitHub Copilot login and
 * https://docs.github.com/en/copilot/reference/ai-models/supported-models (both GA); preflight
 * re-verifies the requested models and levels before every run.
 */
export const ladderOf = (
  { worker, leader }: PairRequest["models"],
  thinking: PairRequest["thinking"],
): schedules.Ladder => {
  const rung = (model: string, level: Static<typeof Level>): schedules.LadderRung =>
    level === "off" ? { model } : { model, thinking: level };
  const workerRung = rung(worker, thinking.worker);
  const leaderRung = rung(leader, thinking.leader);
  return { smol: workerRung, low: workerRung, med: workerRung, high: leaderRung, xhigh: leaderRung };
};
/** Every graph level: native parallel selection, leaders on the leader rung, workers on the worker rung. */
const scheduler = () =>
  schedules.strength(
    (_snapshot, node) => (node === "Agent1" || node === "Agent2" ? "high" : "med"),
    schedules.parallel(),
  );

/** The two-team graph; assignments arrive on its private $source routes, never in the document. */
export const document = syntax.parse(source, {
  sourceName: "wf.yml",
  params: { assistant_schema: JSON.stringify(AssistantMessageSchema) },
});

// Workers share the leaders' blocked native tools and assignment schema, so neither can drift.
const leader = document.graph.nodes.Agent1 as { tool_block: string[] };
const PROMPT = document.graph.edges!.find(({ id }) => id === "assignment-1")!.schema;

const WORKER_SYSTEM =
  "You are a worker on one scoped job in a private, disposable copy of /workspace/repo; container_bash runs bash there, without network. " +
  "Do exactly the job you are given: stay within its scope, follow the repository's conventions and do not refactor unrelated code. " +
  "Run the acceptance check yourself and revise your change until it exits 0. Only then call send exactly once with id \"completion\" and the job ID as payload, " +
  "then finish with a concise report: files changed, the check command and its exit code, and anything your leader must know. " +
  "If you cannot complete the job, do not send completion; finish with a report of the blocker. " +
  "Keep your changes in the repository; do not reset the base, remove .git or write patch files. The host reruns the check and harvests your changes itself.";

/** One leaf job: Worker reports completion on a message edge and its final report on a value edge; Collect joins both. */
const WORKER_DOCUMENT: syntax.JuncoDocument = {
  graph: {
    name: "CooperBenchWorker",
    source: { description: "The job assignment.", routes: { assignment: ["assignment"] } },
    sink: { description: "The validated worker report.", returns: "Collect" },
    nodes: {
      Worker: {
        description: "Implements one scoped job in its own child container.",
        system: WORKER_SYSTEM,
        prompt: "{{assignment}}",
        tools: ["workspace"],
        tool_block: leader.tool_block,
        trigger: "assignment",
      },
      Collect: {
        kind: "code",
        description: "Accepts exactly one completion carrying the job ID plus a normally finished report.",
        trigger: { all: ["completion", "report"] },
      },
    },
    edges: [
      { from: "$source", to: "Worker", kind: "message", id: "assignment", schema: PROMPT },
      { from: "Worker", to: "Collect", kind: "message", id: "completion", schema: { type: "string", minLength: 1 } },
      { from: "Worker", to: "Collect", kind: "value", id: "report", schema: AssistantMessageSchema },
      { from: "Collect", to: "$sink", kind: "value", id: "result", schema: AssistantMessageSchema },
    ],
  },
};

const COMPLETION = graph.EdgeId.create("completion");
const REPORT = graph.EdgeId.create("report");
const COLLECT = graph.NodeId.create("Collect");

/** Returns the worker's report only after exactly one completion message naming this job. */
export const Collect: syntax.DeterministicNode<{ readonly jobId: string }> = ({ context, policy }) => ({
  state: new Deterministic<TSchema, unknown>(async function* () {
    const inputs = yield [];
    const sent = inputs.messages.get(COMPLETION) ?? [];
    if (sent.length !== 1 || sent[0] !== context.jobId)
      throw new Error(
        `worker must send exactly one completion carrying job ${context.jobId}; got ${JSON.stringify(sent)}`,
      );
    const report = inputs.values.get(REPORT);
    syntax.finalText(report, "Worker");
    return report;
  }, policy),
});

// ## Container command transport

const BashParameters = Type.Object({ command: Type.String({ minLength: 1 }) }, strict);

/** What one container command reports beside its text. A `transport_error` aborts its scope. */
export type BashDetails = {
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  readonly truncated: boolean;
  readonly output_bytes: number;
  readonly transport_error?: string;
};

/** First and last halves of a byte stream, bounded by {@link OUTPUT_CAP}. */
class CappedOutput {
  #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer = Buffer.alloc(0);
  total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    const half = OUTPUT_CAP / 2;
    const room = half - this.#headBytes;
    if (room > 0) {
      const part = chunk.subarray(0, room);
      this.#head.push(part);
      this.#headBytes += part.length;
      chunk = chunk.subarray(part.length);
    }
    if (chunk.length === 0) return;
    const tail = Buffer.concat([this.#tail, chunk]);
    this.#tail = tail.length > half ? Buffer.from(tail.subarray(tail.length - half)) : tail;
  }

  get truncated(): boolean {
    return this.total > OUTPUT_CAP;
  }

  text(): string {
    const head = Buffer.concat(this.#head).toString("utf8");
    const tail = this.#tail.toString("utf8");
    return this.truncated ? `${head}\n[... ${this.total - OUTPUT_CAP} bytes omitted ...]\n${tail}` : head + tail;
  }
}

/** Run `docker args`, resolving its trimmed stdout, or undefined when it fails or overruns 30 s. */
function quick(args: readonly string[]): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.once("error", () => resolve(undefined));
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code === 0 ? out.trim() : undefined);
  });
  return promise;
}

const transportFailure = (error: string, output: CappedOutput): AgentToolResult<BashDetails> => ({
  content: [{ type: "text", text: `Docker transport failure: ${error}` }],
  details: {
    exit_code: null,
    timed_out: false,
    truncated: output.truncated,
    output_bytes: output.total,
    transport_error: error,
  },
  isError: true,
});

/**
 * A `container_bash` tool running each command as `bash -lc` in /workspace/repo of container
 * `containerId` under `timeout -s TERM -k 5 <timeoutSeconds>`, with stdin closed and no host shell.
 * Results report the exit code, timeout and truncation; a nonzero exit is a normal result. On abort,
 * or when Docker overruns the command deadline by 10 s, it kills the exec client and stops that
 * container, so no command outlives it; a Docker transport failure is an error result whose
 * `details.transport_error` fails the container's owner (the pair for a leader, the job for a worker).
 */
export function containerBashTool(containerId: string, timeoutSeconds = 120): AgentTool {
  if (!new RegExp(CONTAINER_ID).test(containerId))
    throw new TypeError("containerBashTool: containerId must be a full 64-hex Docker container ID");
  const tool: AgentTool<typeof BashParameters, BashDetails> = {
    name: "container_bash",
    label: "container_bash",
    description:
      `Run a bash command (bash -lc) in /workspace/repo of your private task container; there is no network. ` +
      `Combined stdout/stderr is capped at ${OUTPUT_CAP / 1024} KiB (first and last halves kept); each command is stopped after ${timeoutSeconds} seconds.`,
    parameters: BashParameters,
    executionMode: "sequential",
    async execute(_toolCallId, { command }, signal) {
      signal?.throwIfAborted();
      const started = Date.now();
      const child = spawn(
        "docker",
        ["exec", "-w", WORKDIR, containerId, "timeout", "-s", "TERM", "-k", "5", String(timeoutSeconds), "bash", "-lc", command],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = Promise.withResolvers<{ code: number | null; error?: Error }>();
      child.once("error", (error) => exited.resolve({ code: null, error }));
      child.once("close", (code) => exited.resolve({ code }));
      const output = new CappedOutput();
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
      let stopped: "abort" | "watchdog" | undefined;
      let stopping: Promise<unknown> = Promise.resolve();
      const stop = (reason: "abort" | "watchdog") => {
        if (stopped !== undefined) return;
        stopped = reason;
        child.kill("SIGKILL");
        stopping = quick(["stop", "-t", "2", containerId]);
      };
      const watchdog = setTimeout(() => stop("watchdog"), (timeoutSeconds + WATCHDOG_GRACE_SECONDS) * 1000);
      const onAbort = () => stop("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      const exit = await exited.promise;
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      await stopping;
      if (stopped === "abort") throw signal?.reason ?? new DOMException("bash aborted", "AbortError");
      if (stopped === "watchdog")
        return transportFailure(
          `docker exec did not finish within ${timeoutSeconds + WATCHDOG_GRACE_SECONDS}s; the sandbox was stopped`,
          output,
        );
      if (exit.error !== undefined) return transportFailure(`docker exec failed: ${exit.error.message}`, output);
      if (exit.code !== 0 && (await quick(["inspect", "-f", "{{.State.Running}}", containerId])) !== "true")
        return transportFailure(`container is not running (docker exec exit ${exit.code})`, output);
      const timedOut = exit.code === 124 || (exit.code === 137 && Date.now() - started >= timeoutSeconds * 1000);
      const notes = [
        `exit_code: ${exit.code}`,
        ...(timedOut ? [`[timed out after ${timeoutSeconds}s]`] : []),
        ...(output.truncated ? [`[output truncated: ${output.total} bytes total]`] : []),
      ];
      return {
        content: [{ type: "text", text: `${notes.join("\n")}\n${output.text()}` }],
        details: { exit_code: exit.code, timed_out: timedOut, truncated: output.truncated, output_bytes: output.total },
      };
    },
  };
  return tool as unknown as AgentTool;
}

// ## Driver-owned Docker operations

type Run = { readonly code: number | null; readonly stdout: Buffer; readonly stderr: string };
type DockerIo = { readonly stdin?: Buffer | number; readonly stdout?: number };

/**
 * `docker args` to completion, cancelled by `signal` and a 600 s ceiling. stdin comes from a buffer
 * or file descriptor; stdout goes uncapped to a buffer, or to a file descriptor. Rejects on spawn
 * failure or cancellation; a nonzero exit resolves with its code and stderr tail.
 */
function docker(
  args: readonly string[],
  signal: AbortSignal,
  io: DockerIo = {},
): Promise<Run> {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(OPERATION_MS)]);
  if (limit.aborted) return Promise.reject(limit.reason);
  const { promise, resolve, reject } = Promise.withResolvers<Run>();
  const child = spawn("docker", args, {
    stdio: [io.stdin === undefined ? "ignore" : typeof io.stdin === "number" ? io.stdin : "pipe", io.stdout ?? "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    err = (err + chunk).slice(-4000);
  });
  const kill = () => child.kill("SIGKILL");
  limit.addEventListener("abort", kill, { once: true });
  child.once("error", (error) => {
    limit.removeEventListener("abort", kill);
    reject(error);
  });
  child.once("close", (code) => {
    limit.removeEventListener("abort", kill);
    if (limit.aborted) reject(limit.reason);
    else resolve({ code, stdout: Buffer.concat(out), stderr: err.trim() });
  });
  if (Buffer.isBuffer(io.stdin)) {
    child.stdin!.on("error", () => {}); // an early exit reports through `close`
    child.stdin!.end(io.stdin);
  }
  return promise;
}

/** Like {@link docker}, but a nonzero exit rejects with its stderr. */
async function must(
  args: readonly string[],
  signal: AbortSignal,
  io?: DockerIo,
): Promise<Buffer> {
  const { code, stdout, stderr } = await docker(args, signal, io);
  if (code !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed (exit ${code}): ${stderr}`);
  return stdout;
}

const inRepo = (container: string, script: string) => ["exec", "-w", WORKDIR, container, "bash", "-c", script];

type Identity = { readonly head: string; readonly tree: string };
/** HEAD and the tree of every nonignored file, staged exactly as the launcher's harvest stages them. */
async function identity(container: string, signal: AbortSignal): Promise<Identity> {
  const out = (await must(inRepo(container, "git add -A && git rev-parse HEAD && git write-tree"), signal)).toString();
  const [head, tree] = out.trim().split("\n");
  if (!/^[0-9a-f]{40}$/.test(head ?? "") || !/^[0-9a-f]{40}$/.test(tree ?? ""))
    throw new Error(`unexpected repository identity output: ${out.slice(0, 200)}`);
  return { head: head!, tree: tree! };
}

type Snapshot = Identity & { readonly tar: string };
/** The whole repository directory of `primary` (ignored assets and sanitized .git included) as a tar file. */
async function snapshot(primary: string, dir: string, signal: AbortSignal): Promise<Snapshot> {
  const frozen = await identity(primary, signal);
  const tar = join(dir, "snapshot.tar");
  const file = await open(tar, "w");
  try {
    await must(["cp", `${primary}:${WORKDIR}/.`, "-"], signal, { stdout: file.fd });
  } finally {
    await file.close();
  }
  return { ...frozen, tar };
}

/** A child container whose repository is the snapshot; `base` is its local snapshot commit. */
type Child = { readonly id: string; readonly base: string };

const SNAPSHOT_COMMIT =
  "git -c user.name=cooperbench -c user.email=cooperbench@localhost -c core.hooksPath=/dev/null -c commit.gpgsign=false " +
  "commit -q --no-verify --allow-empty -m 'cooperbench batch snapshot' && git rev-parse HEAD";

/** Start one labelled, network-less child of the pinned image and replace its repository with `snap`. */
async function provision(request: PairRequest, snap: Snapshot, names: string[], signal: AbortSignal): Promise<Child> {
  const name = `cb-${request.run_id}-${randomUUID()}`;
  names.push(name); // before creation: cleanup removes it even if `docker run` is cancelled midway
  const id = (
    await must(
      [
        "run", "-d", "--rm", "--pull=never", "--network", "none", "--platform", "linux/amd64",
        "--label", `${SCOPE_LABEL}=${request.run_id}`, "--name", name, "--workdir", WORKDIR,
        "--entrypoint", "/bin/bash", request.image_id, "-c", "sleep 7500s",
      ],
      signal,
    )
  )
    .toString()
    .trim();
  // Replace, never overlay: the image's own .git still holds the upstream future.
  await must(["exec", id, "bash", "-c", `rm -rf ${WORKDIR} && mkdir ${WORKDIR}`], signal);
  const file = await open(snap.tar, "r");
  try {
    await must(["cp", "-", `${id}:${WORKDIR}`], signal, { stdin: file.fd });
  } finally {
    await file.close();
  }
  const restored = await identity(id, signal);
  if (restored.head !== snap.head || restored.tree !== snap.tree)
    throw new Error(
      `restored snapshot differs: HEAD ${restored.head} tree ${restored.tree}, expected ${snap.head} ${snap.tree}`,
    );
  const base = (await must(inRepo(id, SNAPSHOT_COMMIT), signal)).toString().trim();
  return { id, base };
}

/** Every change of `child` against its snapshot commit, binary and untruncated; worker commits included. */
const harvest = (child: Child, signal: AbortSignal) =>
  must(inRepo(child.id, `git add -A && git diff --binary --full-index ${child.base} -- .`), signal);

/** Apply `patch` to `container` atomically (check first, no reject or fuzz); a failure message or undefined. */
async function apply(container: string, patch: Buffer, signal: AbortSignal): Promise<string | undefined> {
  for (const flags of [["--check"], []]) {
    const { code, stderr } = await docker(
      ["exec", "-i", "-w", WORKDIR, container, "git", "apply", ...flags, "-"],
      signal,
      { stdin: patch },
    );
    if (code !== 0) return `git apply ${flags.join(" ")} failed (exit ${code}): ${stderr}`;
  }
  return undefined;
}

/** Force-remove these containers and confirm each is gone within 60 s; diagnostics for any that remain. */
async function removeAll(names: readonly string[]): Promise<string[]> {
  const problems = await Promise.all(
    names.map(async (name) => {
      try {
        await docker(["rm", "-f", name], AbortSignal.timeout(120_000));
        const until = Date.now() + 60_000;
        while ((await docker(["inspect", name], AbortSignal.timeout(60_000))).code === 0) {
          if (Date.now() > until) return `container ${name} still exists after docker rm -f`;
          await Bun.sleep(500);
        }
        return undefined;
      } catch (error) {
        return `removing container ${name} failed: ${describe(error)}`;
      }
    }),
  );
  return problems.filter((problem) => problem !== undefined);
}

type CheckResult = Omit<BashDetails, "truncated" | "output_bytes"> & { readonly output: string };
/** Run a leaf's acceptance check (with pipefail) in `container` exactly as the agent's tool would. */
async function runCheck(container: string, command: string, signal: AbortSignal): Promise<CheckResult> {
  const result = await containerBashTool(container).execute("check", { command: `set -o pipefail\n${command}` }, signal);
  const { exit_code, timed_out, transport_error } = result.details as BashDetails;
  return { exit_code, timed_out, ...(transport_error === undefined ? {} : { transport_error }), output: contentText(result.content) };
}
const passed = (check: CheckResult) => check.exit_code === 0 && !check.timed_out && check.transport_error === undefined;

// ## Feature teams and their batches

/** Who an agent works for: its feature team, its unique node, and what a transport failure aborts. */
export type Owner = { readonly team: AgentKey; readonly node_id: string; readonly failure: AbortController };
export type YamlAgent = agent.JuncoAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;
/** A workflow as `JuncoGraph.fromYaml` builds it: runtime-loaded edge schemas and unknown results. */
export type YamlExecution = schedules.SchedulerContext<
  Agentic<TSchema, unknown>,
  TSchema,
  unknown,
  schedules.AgencyNodeMetadata,
  JuncoGraph<TSchema, unknown>
>;

export type PairOptions = Pick<syntax.BuildOptions, "models" | "tracer" | "recorder"> & {
  /** Every leader and worker agent; the caller observes it before it starts. */
  readonly createAgent: (spec: syntax.AgentSpec, owner: Owner) => Promise<YamlAgent>;
  /** Ends every batch: the pair's interrupt, deadline, failure or end. */
  readonly signal: AbortSignal;
  /** Aborted by a leader's own container transport failure. */
  readonly failure: AbortController;
};

/** Batch bookkeeping shared by both teams of one pair. */
export type Batches = { workers: number; readonly errors: string[]; readonly active: Set<Promise<unknown>> };

type Team = {
  readonly key: AgentKey;
  readonly primary: string;
  readonly request: PairRequest;
  readonly options: PairOptions;
  readonly batches: Batches;
};

const WorkItem = Type.Object(
  { name: Type.String({ pattern: "\\S" }), task: Type.String({ pattern: "\\S" }), check: Type.String({ pattern: "\\S" }) },
  strict,
);
const DivideParameters = Type.Object({ tasks: Type.Array(WorkItem, { minItems: 1 }) }, strict);
const TournamentParameters = Type.Object(
  { task: Type.String({ pattern: "\\S" }), check: Type.String({ pattern: "\\S" }) },
  strict,
);
export type WorkItem = Static<typeof WorkItem>;

type Success = { readonly item: WorkItem; readonly job: string; readonly report: string; readonly check: CheckResult; readonly patch: Buffer };
type JobRecord = {
  readonly name: string;
  readonly status: "passed" | "failed" | "cancelled";
  readonly job?: string;
  readonly report?: string;
  readonly check?: CheckResult;
  readonly error?: string;
};
export type BatchDetails = {
  readonly batch: string;
  readonly mode: "divide" | "tournament";
  applied: boolean;
  paths: string[];
  jobs: JobRecord[];
  transport_error?: string;
};

/** A failure the leader can act on; `diagnostics` are shown verbatim. */
class BatchError extends Error {
  constructor(message: string, readonly diagnostics: readonly string[] = []) {
    super(message);
  }
}
/** The leader's own container failed: like a failing container_bash, this aborts the pair. */
class PrimaryFailure extends Error {}

/** Run `operation` on the primary; if it fails and the primary is no longer running, fail the pair instead. */
async function onPrimary<T>(team: Team, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!team.options.signal.aborted && (await quick(["inspect", "-f", "{{.State.Running}}", team.primary])) !== "true")
      throw new PrimaryFailure(`${team.key} container is not running: ${describe(error)}`);
    throw error;
  }
}

const assignment = (job: string, item: WorkItem) =>
  `Job ID: ${job}\nJob: ${item.name}\n\nTask:\n${item.task}\n\n` +
  `Acceptance check (run in /workspace/repo; exit status 0 means the job is done):\n${item.check}\n\n` +
  `When the job is done and the check passes, call send with {"id":"completion","payload":"${job}"} exactly once, then finish with your report.`;

export type WorkerOptions = Pick<syntax.BuildOptions, "models" | "tracer" | "recorder"> & {
  readonly ladder: schedules.Ladder;
  readonly createAgent: (spec: syntax.AgentSpec) => Promise<YamlAgent>;
};

/** One leaf job's worker graph over `workspace`, its assignment enqueued; the sink returns the report Collect validated. */
export async function createWorker(
  job: string,
  item: WorkItem,
  workspace: AgentTool,
  { models, tracer: observer, recorder, ladder, createAgent }: WorkerOptions,
): Promise<YamlExecution> {
  const execution = await JuncoGraph.fromYaml(WORKER_DOCUMENT, {
    cwd: process.cwd(),
    scheduler,
    ladder,
    ...(models === undefined ? {} : { models }),
    ...(observer === undefined ? {} : { tracer: observer }),
    ...(recorder === undefined ? {} : { recorder }),
    tools: { workspace },
    code: { Collect },
    context: { jobId: job },
    createAgent,
  });
  try {
    execution.graph.source.enqueue({
      messages: new Map([[graph.EdgeId.create("assignment"), [{ kind: "prompt", text: assignment(job, item) }]]]),
      values: new Map(),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try { await execution.graph.close(); } catch (failure) { failures.push(failure); }
    try { await execution.graph.tracer.flush(); } catch (failure) { failures.push(failure); }
    throw new AggregateError(failures, "Worker assignment setup failed");
  }
  return execution;
}

/**
 * One worker graph in `child`: resolves only after a validated completion and report, a passing
 * host rerun of the check, and a complete harvest. Close failures go to `cleanup`, never into the
 * rejection, so a deliberately cancelled attempt cannot hide them.
 */
async function attempt(
  team: Team,
  batch: string,
  item: WorkItem,
  child: Child,
  signal: AbortSignal,
  cleanup: string[],
): Promise<Success> {
  const job = randomUUID();
  const failure = new AbortController();
  const scoped = AbortSignal.any([signal, failure.signal]);
  const owner: Owner = { team: team.key, node_id: `${team.key}/${batch}/${job}/Worker`, failure };
  const { models, tracer: observer, recorder } = team.options;
  try {
    team.batches.workers += 1;
    const execution = await createWorker(job, item, containerBashTool(child.id), {
      ladder: ladderOf(team.request.models, team.request.thinking),
      ...(models === undefined ? {} : { models }),
      ...(observer === undefined ? {} : { tracer: observer }),
      ...(recorder === undefined ? {} : { recorder: recorder.add_context(team.key).add_context(batch).add_context(job) }),
      createAgent: (spec) => team.options.createAgent(spec, owner),
    });
    let report: string;
    try {
      const results = await execution.run({ signal: scoped });
      if (failure.signal.aborted) throw failure.signal.reason;
      scoped.throwIfAborted();
      report = syntax.finalText(results.get(COLLECT), "Worker");
    } finally {
      try {
        await execution.graph.close();
      } catch (error) {
        cleanup.push(`closing ${owner.node_id}: ${describe(error)}`);
      } finally {
        await execution.graph.tracer.flush();
      }
    }
    const check = await runCheck(child.id, item.check, scoped);
    if (!passed(check))
      throw new BatchError(`host rerun of the check failed (exit ${check.exit_code}${check.timed_out ? ", timed out" : ""})`, [
        tail(check.output),
      ]);
    return { item, job, report, check, patch: await harvest(child, scoped) };
  } catch (error) {
    throw new BatchError(`${item.name} (job ${job}): ${describe(error)}`, error instanceof BatchError ? error.diagnostics : []);
  }
}

const tail = (text: string, size = 2000) => (text.length > size ? `[...]${text.slice(-size)}` : text);

/** Validated leaf jobs: nonblank fields and unique names, before any container exists. */
function validJobs(items: unknown): WorkItem[] {
  if (!Value.Check(Type.Array(WorkItem, { minItems: 1 }), items))
    throw new Error("jobs need nonblank name, task and check strings");
  const names = new Set(items.map(({ name }) => name.trim()));
  if (names.size !== items.length) throw new Error("job names must be unique");
  return items;
}

/**
 * One batch of `team`: snapshot its repository, provision every member, run the jobs, and promote
 * at most one complete patch. `divide` requires every job and composes them in a fresh integration
 * container; `tournament` races two attempts of one job and keeps the first validated success.
 * Everything the batch started is joined and removed before it returns.
 */
async function runBatch(
  team: Team,
  mode: BatchDetails["mode"],
  items: WorkItem[],
  toolSignal: AbortSignal | undefined,
): Promise<AgentToolResult<BatchDetails>> {
  const id = `batch-${randomUUID()}`;
  const dir = join(team.request.problem_dir, ".junco", "work", id);
  const done = new AbortController();
  const signal = AbortSignal.any([team.options.signal, done.signal, ...(toolSignal ? [toolSignal] : [])]);
  const names: string[] = [];
  const cleanup: string[] = [];
  const runs: Promise<Success>[] = [];
  const details: BatchDetails = { batch: id, mode, applied: false, paths: [], jobs: [] };
  let text: string;
  let failed = false;
  try {
    await mkdir(dir, { recursive: true });
    const snap = await onPrimary(team, () => snapshot(team.primary, dir, signal));
    const members = items.length + (mode === "divide" ? 1 : 0);
    const provisioned = await Promise.allSettled(
      Array.from({ length: members }, () => provision(team.request, snap, names, signal)),
    );
    const unprovisioned = provisioned.flatMap((p) => (p.status === "rejected" ? [describe(p.reason)] : []));
    if (unprovisioned.length) throw new BatchError("provisioning the batch failed; no job was started", unprovisioned);
    const children = provisioned.map((p) => (p as PromiseFulfilledResult<Child>).value);

    let selected: Success[];
    if (mode === "divide") {
      runs.push(...items.map((item, i) => attempt(team, id, item, children[i]!, signal, cleanup)));
      const settled = await Promise.allSettled(runs);
      details.jobs = settled.map((s, i) => record(items[i]!, s, false));
      const failures = details.jobs.filter((job) => job.status !== "passed");
      if (failures.length)
        throw new BatchError(
          `${failures.length} of ${items.length} jobs failed; nothing was applied`,
          failures.map((job) => job.error ?? job.name),
        );
      selected = settled.map((s) => (s as PromiseFulfilledResult<Success>).value);
      const integration = children.at(-1)!;
      for (const success of selected) {
        if (success.patch.length === 0) continue;
        const problem = await apply(integration.id, success.patch, signal);
        if (problem !== undefined)
          throw new BatchError(`the patch of ${success.item.name} conflicts with earlier jobs; nothing was applied`, [problem]);
      }
      for (const item of items) {
        const check = await runCheck(integration.id, item.check, signal);
        if (!passed(check))
          throw new BatchError(
            `the check of ${item.name} fails on the combined tree (exit ${check.exit_code}); nothing was applied`,
            [tail(check.output)],
          );
      }
      details.paths = await promote(team, snap, await harvest(integration, signal), signal);
    } else {
      const stops = children.map(() => new AbortController());
      runs.push(
        ...items.map((item, i) =>
          attempt(team, id, item, children[i]!, AbortSignal.any([signal, stops[i]!.signal]), cleanup),
        ),
      );
      const settledEarly = runs.map(() => false);
      runs.forEach((run, i) => {
        const mark = () => {
          settledEarly[i] = true;
        };
        run.then(mark, mark);
      });
      let winner: Success;
      try {
        winner = await Promise.any(runs);
      } catch {
        const settled = await Promise.allSettled(runs);
        details.jobs = settled.map((s, i) => record(items[i]!, s, false));
        throw new BatchError(
          "both attempts failed; nothing was applied",
          details.jobs.map((job) => job.error ?? job.name),
        );
      }
      // First validated success wins: cancel a still-running loser (its tool stops its own container) and join it.
      const cancelled = items.map((item, i) => item !== winner.item && !settledEarly[i]);
      stops.forEach((stop, i) => {
        if (cancelled[i]) stop.abort(new Error(`cancelled: ${winner.item.name} won`));
      });
      const settled = await Promise.allSettled(runs);
      details.jobs = settled.map((s, i) => record(items[i]!, s, cancelled[i]!));
      selected = [winner];
      details.paths = await promote(team, snap, winner.patch, signal);
    }
    details.applied = true;
    text = summary(details, selected);
  } catch (error) {
    failed = true;
    if (error instanceof PrimaryFailure) details.transport_error = error.message;
    text = [
      `${mode} ${id}: ${describe(error)}`,
      ...(error instanceof BatchError ? error.diagnostics.map((d) => `- ${d}`) : []),
      ...details.jobs.flatMap((job) => (job.report ? [`${job.name} report:\n${job.report}`] : [])),
      "Your repository is unchanged by this batch.",
    ].join("\n");
  }
  done.abort(new Error("batch finished"));
  await Promise.allSettled(runs);
  cleanup.push(...(await removeAll(names)));
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    cleanup.push(`removing ${dir}: ${describe(error)}`);
  }
  if (cleanup.length) {
    team.batches.errors.push(...cleanup.map((problem) => `${team.key} ${id} cleanup: ${problem}`));
    failed = true;
    text += `\nCleanup failed:\n${cleanup.map((problem) => `- ${problem}`).join("\n")}`;
  }
  return { content: [{ type: "text", text }], details, ...(failed ? { isError: true } : {}) };
}

function record(item: WorkItem, settled: PromiseSettledResult<Success>, cancelled: boolean): JobRecord {
  if (settled.status === "fulfilled") {
    const { job, report, check } = settled.value;
    return { name: item.name, status: "passed", job, report, check };
  }
  return { name: item.name, status: cancelled ? "cancelled" : "failed", error: describe(settled.reason) };
}

/** Apply one complete patch to the primary, only if it is still exactly the snapshot; the changed paths. */
function promote(team: Team, snap: Snapshot, patch: Buffer, signal: AbortSignal): Promise<string[]> {
  return onPrimary(team, async () => {
    const now = await identity(team.primary, signal);
    if (now.head !== snap.head || now.tree !== snap.tree)
      throw new BatchError("your repository changed since the batch snapshot; nothing was applied", [
        `snapshot HEAD ${snap.head} tree ${snap.tree}; now HEAD ${now.head} tree ${now.tree}`,
      ]);
    if (patch.length === 0) return [];
    const stat = await docker(["exec", "-i", "-w", WORKDIR, team.primary, "git", "apply", "--numstat", "-"], signal, {
      stdin: patch,
    });
    const problem = await apply(team.primary, patch, signal);
    if (problem !== undefined) throw new BatchError("the batch patch does not apply to your repository; nothing was applied", [problem]);
    return stat.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").slice(2).join("\t"));
  });
}

function summary(details: BatchDetails, selected: readonly Success[]): string {
  const applied = details.paths.length
    ? `applied ${details.paths.length} path(s) to your repository:\n${details.paths.map((p) => `  ${p}`).join("\n")}`
    : "the selected job(s) changed no files; your repository is unchanged";
  const jobs = details.jobs.map((job) =>
    job.status === "passed"
      ? `${selected.some((s) => s.job === job.job) ? "selected" : "passed"} ${job.name} (job ${job.job}): host check exit ${job.check!.exit_code}\n` +
        `Report:\n${job.report}\nCheck output:\n${tail(job.check!.output)}`
      : `${job.status} ${job.name}: ${job.error}`,
  );
  return [`${details.mode} ${details.batch}: ${applied}`, ...jobs].join("\n\n");
}

function teamTools(team: Team): Record<string, AgentTool> {
  const track = (batch: Promise<AgentToolResult<BatchDetails>>) => {
    team.batches.active.add(batch);
    void batch.finally(() => team.batches.active.delete(batch));
    return batch;
  };
  const divide: AgentTool<typeof DivideParameters, BatchDetails> = {
    name: "divide",
    label: "divide",
    description:
      "Run independent leaf jobs in parallel, each by a worker in its own private copy of your current repository. " +
      "Each job: a unique name, a self-contained task (files, interfaces, conventions, constraints) and an executable shell check (exit 0 = done). " +
      "Applies the combined patch to your repository only if every job completes, passes its check again on the host, and all patches compose and pass every check together.",
    parameters: DivideParameters,
    executionMode: "sequential",
    execute: async (_id, { tasks }, signal) => track(runBatch(team, "divide", validJobs(tasks), signal)),
  };
  const tournament: AgentTool<typeof TournamentParameters, BatchDetails> = {
    name: "tournament",
    label: "tournament",
    description:
      "Race two independent workers on one genuinely uncertain job, each in its own private copy of your current repository. " +
      "The first attempt that completes and passes the check again on the host is applied to your repository; the other is cancelled.",
    parameters: TournamentParameters,
    executionMode: "sequential",
    execute: async (_id, { task, check }, signal) =>
      track(
        runBatch(
          team,
          "tournament",
          validJobs([1, 2].map((n) => ({ name: `attempt-${n}`, task, check }))),
          signal,
        ),
      ),
  };
  return { divide: divide as unknown as AgentTool, tournament: tournament as unknown as AgentTool };
}

export type Pair = { readonly execution: YamlExecution; readonly batches: Batches };

/** The two-team graph over `request`, with both private assignments already enqueued. */
export async function createPair(request: PairRequest, options: PairOptions): Promise<Pair> {
  const batches: Batches = { workers: 0, errors: [], active: new Set() };
  const team = (key: AgentKey): Team => ({ key, primary: request.agents[key].container_id, request, options, batches });
  const tools = (key: AgentKey, n: 1 | 2) => {
    const { divide, tournament } = teamTools(team(key));
    return {
      [`workspace${n}`]: containerBashTool(request.agents[key].container_id),
      [`divide${n}`]: divide!,
      [`tournament${n}`]: tournament!,
    };
  };
  const { models, tracer: observer, recorder } = options;
  const execution = await JuncoGraph.fromYaml(document, {
    cwd: process.cwd(),
    scheduler,
    ladder: ladderOf(request.models, request.thinking),
    ...(models === undefined ? {} : { models }),
    ...(observer === undefined ? {} : { tracer: observer }),
    ...(recorder === undefined ? {} : { recorder }),
    tools: { ...tools("agent1", 1), ...tools("agent2", 2) },
    createAgent: (spec) =>
      options.createAgent(spec, {
        team: spec.node === "Agent1" ? "agent1" : "agent2",
        node_id: spec.node,
        failure: options.failure,
      }),
  });
  try {
    execution.graph.source.enqueue({
      messages: new Map([
        [graph.EdgeId.create("assignment-1"), [{ kind: "prompt", text: request.agents.agent1.task }]],
        [graph.EdgeId.create("assignment-2"), [{ kind: "prompt", text: request.agents.agent2.task }]],
      ]),
      values: new Map(),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try { await execution.graph.close(); } catch (failure) { failures.push(failure); }
    try { await execution.graph.tracer.flush(); } catch (failure) { failures.push(failure); }
    throw new AggregateError(failures, "Pair assignment setup failed");
  }
  return { execution, batches };
}

// ## Benchmark telemetry

/** The public recorder exposes its canonical base through its dashboard link, not a URL accessor. */
const grafanaBase = (live: tracer.GrafanaRecorder): string =>
  live.dashboardUrl.slice(0, live.dashboardUrl.lastIndexOf("/d/"));

function telemetryError(error: unknown): string {
  try {
    return describe(error).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[invalid URL]";
      }
    });
  } catch {
    return "unreadable recorder failure";
  }
}

/** One owning session: durable receipt-time events plus usage-mode samples and optional Live telemetry. */
export async function createBenchmarkRecorder(
  directory: string,
  runId: string,
  live?: tracer.GrafanaRecorder,
): Promise<tracer.ProfileRecorder<string>> {
  let profile: tracer.JsonlRecorder | undefined;
  let raw: FileHandle | undefined;
  const metadata = {
    version: 1,
    run_id: runId,
    grafana_url: live === undefined ? null : grafanaBase(live),
    stream_id: live?.streamId ?? null,
    dashboard_url: live?.dashboardUrl ?? null,
    raw_complete: false,
    profile_complete: false,
    grafana_complete: live === undefined ? null : false,
    errors: [] as string[],
  };
  const metadataPath = join(directory, "telemetry.json");
  try {
    await mkdir(directory, { recursive: true });
    profile = new tracer.JsonlRecorder({ path: join(directory, "log.jsonl"), costMode: "usage" });
    raw = await open(join(directory, "profile_events.jsonl"), "wx");
    await writeFile(join(directory, "log.jsonl"), "", { flag: "wx" });
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
  } catch (error) {
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => raw?.close()),
      Promise.resolve().then(() => profile?.close()),
      Promise.resolve().then(() => live?.close()),
    ]);
    throw new AggregateError(
      [error, ...closed.flatMap((result) => result.status === "rejected" ? [result.reason] : [])],
      "Benchmark recorder construction failed",
    );
  }
  const profileSink = profile!;
  const rawFile = raw!;
  type Sink = "raw" | "profile" | "grafana" | "metadata";
  const failures = new Map<Sink, string>();
  const fail = (sink: Sink, error: unknown): void => {
    if (!failures.has(sink)) failures.set(sink, `${sink}: ${telemetryError(error)}`);
  };
  const throwFailures = (): void => {
    if (failures.size) throw new AggregateError([...failures.values()].map((message) => new Error(message)), "Benchmark telemetry incomplete");
  };
  const identities = new WeakMap<object, string>();
  let identityCount = 0;
  const identity = (object: object): string => {
    let id = identities.get(object);
    if (id === undefined) {
      id = `object_${++identityCount}`;
      identities.set(object, id);
    }
    return id;
  };
  let sequence = 0;
  let pending: string[] = [];
  let writing = Promise.resolve();
  let closing: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    const batch = pending;
    pending = [];
    if (batch.length) writing = writing.then(() => rawFile.appendFile(batch.join(""))).catch((error) => fail("raw", error));
    return writing;
  };
  const settle = async (jobs: [Sink, () => Promise<unknown>][]): Promise<void> => {
    const results = await Promise.allSettled(jobs.map(([, job]) => Promise.resolve().then(job)));
    results.forEach((result, index) => {
      if (result.status === "rejected") fail(jobs[index]![0], result.reason);
    });
  };
  const flush = (): Promise<void> => closing ?? (async () => {
    await settle([
      ["raw", drain],
      ["profile", () => profileSink.flush()],
      ...(live === undefined ? [] : [["grafana", () => live.flush()]] as [Sink, () => Promise<unknown>][]),
    ]);
    throwFailures();
  })();
  const views = new Map<string, tracer.ProfileRecorder<string>>();
  const close = (): Promise<void> => closing ??= (async () => {
    clearInterval(timer);
    await settle([
      ["raw", async () => { try { await drain(); } finally { await rawFile.close(); } }],
      ["profile", () => profileSink.close()],
      ...(live === undefined ? [] : [["grafana", () => live.close()]] as [Sink, () => Promise<unknown>][]),
    ]);
    metadata.raw_complete = !failures.has("raw");
    metadata.profile_complete = !failures.has("profile");
    metadata.grafana_complete = live === undefined ? null : !failures.has("grafana");
    metadata.errors = [...failures.values()];
    const temporary = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
      await rename(temporary, metadataPath);
    } catch (error) {
      fail("metadata", error);
    } finally {
      views.clear();
      await rm(temporary, { force: true }).catch((error) => fail("metadata", error));
    }
    throwFailures();
  })();
  const record = (
    ids: readonly string[],
    sample: tracer.ProfileRecorder<string>,
    streaming: tracer.ProfileRecorder<string> | undefined,
    event: tracer.ProfileEvent<string>,
  ): void => {
    if (closing !== undefined) return;
    const seq = ++sequence;
    const timestamp = new Date().toISOString();
    try {
      const normalized = {
        ...event,
        ...("source" in event ? { source: identity(event.source) } : {}),
        ...("activation" in event && event.activation !== undefined ? {
          activation_id: identity(event.activation),
          activation: {
            ...event.activation,
            agent: event.activation.agent === undefined ? undefined : identity(event.activation.agent),
          },
        } : {}),
      };
      pending.push(`${JSON.stringify({ seq, timestamp, node: sample.path, node_ids: ids, event: normalized }, (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("nonfinite profile value");
        return value;
      })}\n`);
    } catch (error) {
      fail("raw", error);
    }
    try { sample.record(event); } catch (error) { fail("profile", error); }
    try { streaming?.record(event); } catch (error) { fail("grafana", error); }
  };
  let root: tracer.ProfileRecorder<string>;
  const context = (
    ids: readonly string[],
    sample: tracer.ProfileRecorder<string>,
    streaming: tracer.ProfileRecorder<string> | undefined,
  ): tracer.ProfileRecorder<string> => {
    const view: tracer.ProfileRecorder<string> = Object.freeze({
      get root() { return root; },
      path: sample.path,
      add_context: (id: string) => {
        if (closing !== undefined) throw new Error("Benchmark recorder: closed");
        if (id === "") return view;
        const child = sample.add_context(id);
        let found = views.get(child.path);
        if (found === undefined) {
          found = context([...ids, id], child, streaming?.add_context(id));
          views.set(child.path, found);
        }
        return found;
      },
      record: (event: tracer.ProfileEvent<string>) => record(ids, sample, streaming, event),
      flush,
      close,
    });
    return view;
  };
  root = context([], profileSink, live);
  views.set(root.path, root);
  const timer = setInterval(() => { void drain(); }, 1000);
  timer.unref();
  return root;
}

// ## CLI

/** JSONL to stdout; synchronous so the terminal record is complete before exit. */
function emit(record: Record<string, unknown>): void {
  writeSync(1, `${JSON.stringify({ ...record, timestamp: new Date().toISOString() })}\n`);
}

function describe(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(describe)].join("; ");
  if (error instanceof SuppressedError) return [error.message, describe(error.error), describe(error.suppressed)].join("; ");
  if (error instanceof Error) return error.cause === undefined ? error.message : `${error.message}: ${describe(error.cause)}`;
  return String(error);
}

/** Record every native message and committed usage row of `created`; its container transport failure aborts its owner. */
function observe(created: YamlAgent, { team, node_id, failure }: Owner): void {
  created.events.on("message_end", ({ lane, message }) => {
    emit({ type: "message", agent_id: team, node_id, lane, message });
    const details = message.role === "toolResult" ? (message.details as { transport_error?: unknown } | undefined) : undefined;
    if (typeof details?.transport_error === "string")
      failure.abort(new Error(`${node_id} Docker transport failure: ${details.transport_error}`));
  });
  created.events.on("usage", ({ lane, row }) => {
    emit({ type: "usage", agent_id: team, node_id, lane, adjustment: row.adjustment, usage: row.usage });
  });
}

/** One network-refreshed `ModelRuntime` whose catalog and saved logins cover both roles' models and thinking levels; no fallback. */
async function verifiedModels(
  models: PairRequest["models"],
  thinking: PairRequest["thinking"],
  signal?: AbortSignal,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: true, refreshOnCreate: false, signal });
  const refreshed = await runtime.refresh({ allowNetwork: true, signal });
  if (refreshed.aborted || refreshed.errors.size > 0)
    throw new AggregateError(
      [
        ...(refreshed.aborted ? [new Error("Model catalog refresh aborted")] : []),
        ...[...refreshed.errors].map(([provider, error]) => new Error(`${provider}: ${error.message}`, { cause: error })),
      ],
      "Model catalog refresh failed",
    );
  signal?.throwIfAborted();
  const credentials = await runtime.listCredentials({ signal });
  for (const role of ["worker", "leader"] as const) {
    const name = models[role];
    const slash = name.indexOf("/");
    const provider = name.slice(0, slash);
    if (!credentials.some(({ providerId }) => providerId === provider)) throw new Error(`A saved ${provider} Pi login is required`);
    const model = (await runtime.getAvailable(provider, { signal })).find(({ id }) => id === name.slice(slash + 1));
    if (!model) throw new Error(`${name} is unavailable`);
    if (!getSupportedThinkingLevels(model).includes(thinking[role]))
      throw new Error(`${name} does not support ${thinking[role]} thinking for the ${role} role`);
  }
  return runtime;
}

type Outcome = { status: "Submitted" | "LimitsExceeded" | "Error"; error: string | null };

async function runPair(request: PairRequest, interrupt: AbortSignal, grafanaUrl?: string): Promise<Outcome> {
  const deadline = AbortSignal.timeout(request.timeout_ms);
  const failure = new AbortController();
  const ended = new AbortController();
  const signal = AbortSignal.any([interrupt, deadline, failure.signal]);
  const nodes = { agent1: graph.NodeId.create("Agent1"), agent2: graph.NodeId.create("Agent2") } as const;
  const values: Partial<Record<AgentKey, unknown>> = {};
  const errors: string[] = [];
  let completed = false;
  let pair: Pair | undefined;
  try {
    // LIFO: join batches, close graphs/agents, flush the tracer, then close every recorder sink.
    await using lifetime = new AsyncDisposableStack();
    const live = grafanaUrl === undefined ? undefined : await tracer.GrafanaRecorder.create({ url: grafanaUrl });
    const recorder = lifetime.adopt(
      await createBenchmarkRecorder(join(request.problem_dir, ".junco"), request.run_id, live),
      (owned) => owned.close(),
    );
    const observer = new tracer.DummyTracer();
    lifetime.defer(() => observer.flush());
    const agents = lifetime.adopt(new AsyncDisposableStack(), (owned) => owned.disposeAsync());
    for (const key of ["agent1", "agent2"] as const) {
      const image = await must(["inspect", "-f", "{{.Image}}", request.agents[key].container_id], signal);
      if (image.toString().trim() !== request.image_id)
        throw new Error(`${key} container runs ${image.toString().trim()}, not ${request.image_id}`);
    }
    const models = await verifiedModels(request.models, request.thinking, signal);
    const ladder = ladderOf(request.models, request.thinking);
    signal.throwIfAborted();
    pair = await createPair(request, {
      models,
      tracer: observer,
      recorder,
      signal: AbortSignal.any([signal, ended.signal]),
      failure,
      createAgent: async (spec, owner) => {
        const created = agents.adopt(await syntax.createJuncoAgent(spec, ladder, models), async (owned) => { await owned.return(); });
        observe(created, owner);
        return created;
      },
    });
    const { execution, batches } = pair;
    lifetime.adopt(execution.graph, (owned) => owned.close());
    lifetime.defer(async () => {
      ended.abort(new Error("pair finished"));
      await Promise.allSettled([...batches.active]);
    });
    try {
      const results = await execution.run({ signal });
      completed = !signal.aborted;
      for (const key of ["agent1", "agent2"] as const) values[key] = results.get(nodes[key]);
    } catch (error) {
      errors.push(describe(error));
      for (const key of ["agent1", "agent2"] as const) {
        const result = execution.graph.result(nodes[key]);
        values[key] = result._tag === "Some" ? result.value : undefined;
      }
    }
  } catch (error) {
    // Setup or cleanup failure: keep it beside any run failure.
    errors.push(describe(error));
  }
  errors.push(...(pair?.batches.errors ?? []));
  if (failure.signal.aborted) errors.unshift(describe(failure.signal.reason));
  const limited = deadline.aborted && !failure.signal.aborted && !interrupt.aborted;
  if (interrupt.aborted) errors.unshift("interrupted");
  const { status, error, agents } = pairOutcome(values, { completed, errors, limited });
  const workers = pair?.batches.workers ?? 0;
  emit({ type: "result", status, agents, error, worker_count: workers, agent_count: 2 + workers });
  return { status, error };
}

/**
 * The pair's terminal outcome. Each leader's own final value must finish normally with text: the
 * sink retains only Agent1's, so it cannot vouch for Agent2. Submitted also needs a completed run
 * and no error, including batch cleanup failures.
 */
export function pairOutcome(
  values: Partial<Record<AgentKey, unknown>>,
  { completed, errors, limited }: { completed: boolean; errors: readonly string[]; limited: boolean },
): Outcome & { agents: Record<AgentKey, Outcome> } {
  const agents = Object.fromEntries(
    (["agent1", "agent2"] as const).map((key): [AgentKey, Outcome] => {
      try {
        syntax.finalText(values[key], key === "agent1" ? "Agent1" : "Agent2");
        return [key, { status: "Submitted", error: null }];
      } catch (error) {
        return [
          key,
          limited ? { status: "LimitsExceeded", error: "generation deadline reached" } : { status: "Error", error: describe(error) },
        ];
      }
    }),
  ) as Record<AgentKey, Outcome>;
  const status: Outcome["status"] =
    completed && errors.length === 0 && agents.agent1.status === "Submitted" && agents.agent2.status === "Submitted"
      ? "Submitted"
      : limited
        ? "LimitsExceeded"
        : "Error";
  const error = errors.length ? errors.join("; ") : status === "Submitted" ? null : "an agent did not finish normally";
  return { status, error, agents };
}

async function main(signal: AbortSignal): Promise<void> {
  const request = parseRequest(await Bun.stdin.text());
  const configuredUrl = process.env.GRAFANA_URL;
  let grafanaUrl: string | undefined;
  if (configuredUrl !== undefined) {
    let url: URL;
    try { url = new URL(configuredUrl); } catch { throw new Error("GRAFANA_URL must be a nonempty http(s) URL without credentials, query or fragment"); }
    if (!configuredUrl.trim() || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || configuredUrl.includes("?") || configuredUrl.includes("#"))
      throw new Error("GRAFANA_URL must be a nonempty http(s) URL without credentials, query or fragment");
    grafanaUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  if (request.mode === "preflight") {
    const live = grafanaUrl === undefined ? undefined : await tracer.GrafanaRecorder.create({ url: grafanaUrl });
    {
      await using lifetime = new AsyncDisposableStack();
      if (live !== undefined) lifetime.adopt(live, (owned) => owned.close());
      if (live !== undefined) {
        const view = live.add_context("preflight");
        const operation = { resource: "operations", category: "benchmark", tool: "", operation: "grafana_health" } as const;
        const started = performance.now();
        let outcome: "success" | "error" = "error";
        view.record({ kind: "start", ...operation });
        try {
          const health = await fetch(`${grafanaBase(live)}/api/health`, {
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          });
          await health.body?.cancel();
          if (!health.ok) throw new Error(`Grafana health failed with status ${health.status}`);
          outcome = "success";
        } finally {
          view.record({ kind: "finish", ...operation, outcome, durationMs: performance.now() - started });
        }
      }
      await verifiedModels(request.models, request.thinking, signal);
    }
    emit({
      type: "ready",
      models: request.models,
      thinking: request.thinking,
      runtime_entry: fileURLToPath(import.meta.resolve("junco")),
    });
    return;
  }
  const { status } = await runPair(request, signal, grafanaUrl);
  if (status !== "Submitted") process.exitCode = 1;
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException("Interrupted by Ctrl-C", "AbortError"));
  process.on("SIGINT", interrupt);
  try {
    await main(controller.signal);
  } catch (error) {
    console.error(error instanceof Error && error.constructor === Error && error.cause === undefined ? error.message : error);
    process.exitCode = 1;
  }
  if (controller.signal.aborted) process.exitCode = 130;
  // Model clients may hold idle sockets; the terminal record is already written synchronously.
  process.exit();
}
