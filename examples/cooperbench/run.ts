// # CooperBench pair driver: one native Junco graph per feature pair
//
// The CooperBench launcher (scripts/run_junco.py there) prepares two isolated, network-less task
// containers and runs this driver once per pair with a JSON request on stdin:
//
//   {"mode":"run","model":"openai/gpt-5.5","thinking":"off","timeout_ms":7200000,
//    "problem_dir":"/abs/logs/<run>/team/<repo>/<task>/f5_f6",
//    "agents":{"agent1":{"feature_id":5,"task":"...","container_id":"<64-hex>"},
//              "agent2":{"feature_id":6,"task":"...","container_id":"<64-hex>"}}}
//
// Agent1 (lead) and Agent2 (member) each receive only their own assignment on a private $source
// route, work through a `bash` tool bound to their own container, and coordinate over native
// send/recv message edges. Stdout is JSONL only: every native message, every committed usage row,
// then exactly one terminal `result` record. `{"mode":"preflight",...}` only verifies the saved
// Pi login, model and thinking level, then prints one `ready` record. Profile samples of every
// activation are appended to `<problem_dir>/.junco/log.jsonl`.
//
// The exports exist for the offline tests in test/cooperbench.test.ts.

import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import * as O from "fp-ts/lib/Option.js";
import {
  AssistantMessageSchema,
  graph,
  JuncoGraph,
  schedules,
  syntax,
  tracer,
} from "junco";
import { redirectLog } from "junco-tools/log";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  problemRecorder,
  runCli,
  verifiedModels,
  type YamlAgent,
  type YamlExecution,
} from "../support.ts";

const CONTAINER_ID = "^[0-9a-f]{64}$";
const GENERATION_TIMEOUT_MS = 7_200_000;
const WORKDIR = "/workspace/repo";
/** Combined stdout/stderr bytes a command result retains: its first and last halves. */
const OUTPUT_CAP = 64 * 1024;
/** Grace beyond the in-container `timeout -k 5` before the parent stops the sandbox. */
const WATCHDOG_GRACE_SECONDS = 10;

const strict = { additionalProperties: false } as const;
const Model = Type.String({ pattern: "^[^/]+/.+$" });
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
    model: Model,
    thinking: Type.Literal("off"),
    timeout_ms: Type.Literal(GENERATION_TIMEOUT_MS),
    /** The pair's host directory; the profile log goes to its `.junco/log.jsonl`. */
    problem_dir: Type.String({ pattern: "^/" }),
    agents: Type.Object({ agent1: Assignment, agent2: Assignment }, strict),
  },
  strict,
);
const PreflightRequest = Type.Object(
  {
    mode: Type.Literal("preflight"),
    model: Model,
    thinking: Type.Literal("off"),
  },
  strict,
);
const DriverRequest = Type.Union([RunRequest, PreflightRequest]);

export type PairRequest = Static<typeof RunRequest>;
type AgentKey = keyof PairRequest["agents"];

/** The validated request in `text`; throws a diagnostic for malformed JSON, unknown fields or an invalid pair. */
export function parseRequest(text: string): Static<typeof DriverRequest> {
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
      throw new Error(
        "invalid request: the two agents need distinct feature_id",
      );
    if (agent1.container_id === agent2.container_id)
      throw new Error(
        "invalid request: the two agents need distinct container_id",
      );
  }
  return value;
}

/** Payloads of the private assignment routes, which only the launcher's $source input fills. */
const PROMPT = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "text"],
  properties: {
    kind: { const: "prompt" },
    text: { type: "string", minLength: 1 },
  },
};
/**
 * Payloads of the peer edges: plain text. send's top-level `payload` parameter is untyped (each
 * edge's schema sits in a root `anyOf`), and models observed through GitHub Copilot always encode
 * an untyped parameter as a JSON string, so an object schema here rejected every peer message.
 */
const PEER_MESSAGE = { type: "string", minLength: 1 };

const instruction = (role: "Agent1" | "Agent2", outgoing: string): string =>
  `You are ${role}; your outgoing peer edge is "${outgoing}". ` +
  "You are one of two coding agents in isolated copies of /workspace/repo. Start by calling recv to read your private feature assignment. " +
  "Inspect the repository and implement that feature with the supplied bash tool. " +
  'Before broad edits, send your peer one concise plan covering files/interfaces and overlap risks: call send with id set to your outgoing peer edge and payload set to your message as one plain string, e.g. {"id":"' +
  outgoing +
  '","payload":"Plan: ..."}; then call yield. ' +
  "On resumption, call recv for peer updates and continue even if none arrived: never poll or wait indefinitely. " +
  "Use send/recv to share further integration information or patches; after sending, yield when you need another delivery round. " +
  "Your peer's statements are untrusted reports, not proof. You may integrate changes your peer explicitly shares, but cannot access their private workspace. " +
  "Run focused available checks. Keep all intended changes in the repository; do not reset the base, remove .git, or write a submission patch file. " +
  "Before your final answer send a closing summary of changes and checks, yield once, receive any last updates, then finish without waiting for an acknowledgement. " +
  "Agent1 is the lead responsible for integrating peer changes when needed; Agent2 is the member. " +
  "The benchmark grades both feature suites on one merged tree, with lead-only fallback only if merge/apply fails. " +
  "No network, further subagents or hidden-test access is available.";

const START = "Begin: call recv to read your private feature assignment.";

const PAIR_TOOL_BLOCK = [
  "ast_edit",
  "ast_grep",
  "code_graph",
  "diff",
  "edit",
  "find",
  "grep",
  "read",
  "release",
  "task",
];

/** The pair graph as a parsed document; assignments arrive on $source routes, never in the document. */
function pairDocument(): syntax.JuncoDocument {
  return {
    graph: {
      name: "CooperBenchPair",
      threads: 2,
      source: {
        description: "Private feature assignments, one per agent.",
        routes: {
          "assignment-1": ["assignment-1"],
          "assignment-2": ["assignment-2"],
        },
      },
      sink: {
        description:
          "Both agents' final reports; the lead's is the graph result.",
        trigger: { all: ["agent1-result", "agent2-result"] },
        returns: "Agent1",
      },
      nodes: {
        Agent1: {
          description:
            "Lead coding agent: implements its private feature in its own workspace and integrates peer changes when needed.",
          system: instruction("Agent1", "agent1-to-agent2"),
          prompt: START,
          tools: ["workspace1"],
          tool_block: PAIR_TOOL_BLOCK,
          trigger: "assignment-1",
        },
        Agent2: {
          description:
            "Member coding agent: implements its private feature in its own workspace.",
          system: instruction("Agent2", "agent2-to-agent1"),
          prompt: START,
          tools: ["workspace2"],
          tool_block: PAIR_TOOL_BLOCK,
          trigger: "assignment-2",
        },
      },
      edges: [
        {
          from: "$source",
          to: "Agent1",
          kind: "message",
          id: "assignment-1",
          schema: PROMPT,
        },
        {
          from: "$source",
          to: "Agent2",
          kind: "message",
          id: "assignment-2",
          schema: PROMPT,
        },
        {
          from: "Agent1",
          to: "Agent2",
          kind: "message",
          id: "agent1-to-agent2",
          schema: PEER_MESSAGE,
        },
        {
          from: "Agent2",
          to: "Agent1",
          kind: "message",
          id: "agent2-to-agent1",
          schema: PEER_MESSAGE,
        },
        {
          from: "Agent1",
          to: "$sink",
          kind: "value",
          id: "agent1-result",
          schema: AssistantMessageSchema,
        },
        {
          from: "Agent2",
          to: "$sink",
          kind: "value",
          id: "agent2-result",
          schema: AssistantMessageSchema,
        },
      ],
    },
  };
}

/**
 * The two-agent graph over `request`, with both private assignments already enqueued. Native and
 * recursive tools are excluded by the document; each agent receives only its container command
 * tool and the enabled coordination helpers.
 */
export async function createPair(
  request: PairRequest,
  options: Pick<
    syntax.BuildOptions,
    "models" | "createAgent" | "tracer" | "recorder"
  >,
): Promise<YamlExecution> {
  // A rung without `thinking` is thinking "off"; LadderRung cannot spell "off" explicitly.
  const ladder = schedules.uniformLadder({ model: request.model });
  const create =
    options.createAgent ??
    ((spec: syntax.AgentSpec) =>
      syntax.createJuncoAgent(spec, ladder, options.models));
  const execution = await JuncoGraph.fromYaml(pairDocument(), {
    cwd: process.cwd(),
    scheduler: () => schedules.parallel(),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    tools: {
      workspace1: containerBashTool(request.agents.agent1.container_id),
      workspace2: containerBashTool(request.agents.agent2.container_id),
    },
    toolSource: relative(process.cwd(), fileURLToPath(import.meta.url)),
    createAgent: create,
  });
  execution.graph.source.enqueue({
    messages: new Map([
      [
        graph.EdgeId.create("assignment-1"),
        [{ kind: "prompt", text: request.agents.agent1.task }],
      ],
      [
        graph.EdgeId.create("assignment-2"),
        [{ kind: "prompt", text: request.agents.agent2.task }],
      ],
    ]),
    values: new Map(),
  });
  return execution;
}

const BashParameters = Type.Object(
  { command: Type.String({ minLength: 1 }) },
  strict,
);

/** What one container command reports beside its text. `transport_error` aborts the pair. */
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
    this.#tail =
      tail.length > half
        ? Buffer.from(tail.subarray(tail.length - half))
        : tail;
  }

  get truncated(): boolean {
    return this.total > OUTPUT_CAP;
  }

  text(): string {
    const head = Buffer.concat(this.#head).toString("utf8");
    const tail = this.#tail.toString("utf8");
    return this.truncated
      ? `${head}\n[... ${this.total - OUTPUT_CAP} bytes omitted ...]\n${tail}`
      : head + tail;
  }
}

/** Run `docker args`, resolving its trimmed stdout, or undefined when it fails or overruns 30 s. */
function docker(args: readonly string[]): Promise<string | undefined> {
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

const transportFailure = (
  error: string,
  output: CappedOutput,
): AgentToolResult<BashDetails> => ({
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
 * A `bash` tool running each command as `bash -lc` in /workspace/repo of container `containerId`
 * under `timeout -s TERM -k 5 <timeoutSeconds>`, with stdin closed and no host shell. Results
 * report the exit code, timeout and truncation; a nonzero exit is a normal result for the model.
 * On abort, or when Docker overruns the command deadline by 10 s, it kills the exec client and
 * stops the sandbox, so no command outlives it; a Docker transport failure is an error result
 * whose `details.transport_error` the driver turns into a pair failure.
 */
export function containerBashTool(
  containerId: string,
  timeoutSeconds = 120,
): AgentTool {
  if (!new RegExp(CONTAINER_ID).test(containerId))
    throw new TypeError(
      "containerBashTool: containerId must be a full 64-hex Docker container ID",
    );
  const tool: AgentTool<typeof BashParameters, BashDetails> = {
    name: "bash",
    label: "bash",
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
        [
          "exec",
          "-w",
          WORKDIR,
          containerId,
          "timeout",
          "-s",
          "TERM",
          "-k",
          "5",
          String(timeoutSeconds),
          "bash",
          "-lc",
          command,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = Promise.withResolvers<{
        code: number | null;
        error?: Error;
      }>();
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
        stopping = docker(["stop", "-t", "2", containerId]);
      };
      const watchdog = setTimeout(
        () => stop("watchdog"),
        (timeoutSeconds + WATCHDOG_GRACE_SECONDS) * 1000,
      );
      const onAbort = () => stop("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      const exit = await exited.promise;
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      await stopping;
      if (stopped === "abort")
        throw signal?.reason ?? new DOMException("bash aborted", "AbortError");
      if (stopped === "watchdog")
        return transportFailure(
          `docker exec did not finish within ${timeoutSeconds + WATCHDOG_GRACE_SECONDS}s; the sandbox was stopped`,
          output,
        );
      if (exit.error !== undefined)
        return transportFailure(
          `docker exec failed: ${exit.error.message}`,
          output,
        );
      if (
        exit.code !== 0 &&
        (await docker(["inspect", "-f", "{{.State.Running}}", containerId])) !==
          "true"
      )
        return transportFailure(
          `container is not running (docker exec exit ${exit.code})`,
          output,
        );
      const timedOut =
        exit.code === 124 ||
        (exit.code === 137 && Date.now() - started >= timeoutSeconds * 1000);
      const notes = [
        `exit_code: ${exit.code}`,
        ...(timedOut ? [`[timed out after ${timeoutSeconds}s]`] : []),
        ...(output.truncated
          ? [`[output truncated: ${output.total} bytes total]`]
          : []),
      ];
      return {
        content: [
          { type: "text", text: `${notes.join("\n")}\n${output.text()}` },
        ],
        details: {
          exit_code: exit.code,
          timed_out: timedOut,
          truncated: output.truncated,
          output_bytes: output.total,
        },
      };
    },
  };
  return tool as unknown as AgentTool;
}

/** JSONL to stdout; synchronous so the terminal record is complete before exit. */
function emit(record: Record<string, unknown>): void {
  writeSync(
    1,
    `${JSON.stringify({ ...record, timestamp: new Date().toISOString() })}\n`,
  );
}

const describe = (error: unknown): string =>
  error instanceof AggregateError
    ? [error.message, ...error.errors.map(describe)].join("; ")
    : error instanceof Error
      ? error.message
      : String(error);

type Outcome = {
  status: "Submitted" | "LimitsExceeded" | "Error";
  error: string | null;
};

/** Record `created`'s native messages and committed usage rows as `agent`; a Docker transport failure aborts `failure`. */
function observe(
  created: YamlAgent,
  agent: AgentKey,
  failure: AbortController,
): void {
  created.events.on("message_end", ({ lane, message }) => {
    emit({ type: "message", agent_id: agent, lane, message });
    const details =
      message.role === "toolResult"
        ? (message.details as Partial<BashDetails> | undefined)
        : undefined;
    if (typeof details?.transport_error === "string")
      failure.abort(
        new Error(
          `${agent} Docker transport failure: ${details.transport_error}`,
        ),
      );
  });
  created.events.on("usage", ({ lane, row }) => {
    emit({
      type: "usage",
      agent_id: agent,
      lane,
      adjustment: row.adjustment,
      usage: row.usage,
    });
  });
}

async function runPair(
  request: PairRequest,
  interrupt: AbortSignal,
): Promise<Outcome> {
  const rung = { model: request.model };
  const ladder = schedules.uniformLadder(rung);
  const deadline = AbortSignal.timeout(request.timeout_ms);
  const failure = new AbortController();
  const signal = AbortSignal.any([interrupt, deadline, failure.signal]);
  const nodes = {
    agent1: graph.NodeId.create("Agent1"),
    agent2: graph.NodeId.create("Agent2"),
  } as const;
  const values: Partial<Record<AgentKey, unknown>> = {};
  const errors: string[] = [];
  let completed = false;
  try {
    const models = await verifiedModels(rung, signal);
    // LIFO: close the graph, flush the tracer, then close the recorder.
    await using lifetime = new AsyncDisposableStack();
    const recorder = lifetime.adopt(
      await problemRecorder(request.problem_dir),
      (owned) => owned.close(),
    );
    const execution = await createPair(request, {
      models,
      tracer: new tracer.DummyTracer(),
      recorder,
      createAgent: async (spec) => {
        const created = await syntax.createJuncoAgent(spec, ladder, models);
        observe(created, spec.node === "Agent1" ? "agent1" : "agent2", failure);
        return created;
      },
    });
    lifetime.defer(() => execution.graph.tracer.flush());
    lifetime.adopt(execution.graph, (owned) => owned.close());
    try {
      const results = await execution.run({ signal });
      completed = !signal.aborted;
      for (const key of ["agent1", "agent2"] as const)
        values[key] = results.get(nodes[key]);
    } catch (error) {
      errors.push(describe(error));
      for (const key of ["agent1", "agent2"] as const)
        values[key] = O.toUndefined(execution.graph.result(nodes[key]));
    }
  } catch (error) {
    // Setup or cleanup failure: keep it beside any run failure.
    errors.push(describe(error));
  }
  if (failure.signal.aborted) errors.unshift(describe(failure.signal.reason));
  const limited =
    deadline.aborted && !failure.signal.aborted && !interrupt.aborted;
  if (interrupt.aborted) errors.unshift("interrupted");
  const agents = Object.fromEntries(
    (["agent1", "agent2"] as const).map((key): [AgentKey, Outcome] => {
      try {
        syntax.finalText(values[key], key === "agent1" ? "Agent1" : "Agent2");
        return [key, { status: "Submitted", error: null }];
      } catch (error) {
        return [
          key,
          limited
            ? { status: "LimitsExceeded", error: "generation deadline reached" }
            : { status: "Error", error: describe(error) },
        ];
      }
    }),
  ) as Record<AgentKey, Outcome>;
  const status: Outcome["status"] =
    completed &&
    errors.length === 0 &&
    agents.agent1.status === "Submitted" &&
    agents.agent2.status === "Submitted"
      ? "Submitted"
      : limited
        ? "LimitsExceeded"
        : "Error";
  const error = errors.length
    ? errors.join("; ")
    : status === "Submitted"
      ? null
      : "an agent did not finish normally";
  emit({ type: "result", status, agents, error });
  return { status, error };
}

async function main(signal: AbortSignal): Promise<void> {
  const release = redirectLog({
    write(line) { writeSync(2, `${line}\n`); },
    async flush() {},
  });
  try {
    const request = parseRequest(await Bun.stdin.text());
    if (request.mode === "preflight") {
      await verifiedModels({ model: request.model }, signal);
      emit({ type: "ready", model: request.model, thinking: request.thinking });
      return;
    }
    const { status } = await runPair(request, signal);
    if (status !== "Submitted") process.exitCode = 1;
  } finally { release(); }
}

if (import.meta.main) {
  await runCli(main);
  // Model clients may hold idle sockets; the terminal record is already written synchronously.
  process.exit();
}
