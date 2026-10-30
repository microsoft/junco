// The profile optimizer for `workflows.optimizer`: deterministic code nodes run an instrumented
// target workflow in fresh child processes, score its recorder evidence and decide convergence,
// while one persistent editor agent patches the target's scheduler, model-ladder and limit tuning
// regions. Every decision travels on the graph's state edges; the host holds only immutable
// services plus the active editor ticket and its write receipt.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DummyTracer,
  type Edge,
  EdgeId,
  Message,
  type NodeGenerator,
  NodeId,
  type ParentView,
} from "dataflow-engine";
import { JuncoAgent } from "junco-agent";
import { roundRobin } from "junco-scheduler";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { Deterministic } from "../../deterministic.js";
import { JsonlRecorder } from "../../jsonl-recorder.js";
import { JuncoGraph } from "../../junco-graph.js";
import { type LadderRung, uniformLadder } from "../../node-policy.js";
import {
  createJuncoAgent,
  type DeterministicNode,
  finalText,
} from "../../syntax/build.js";
import { parse } from "../../syntax/parse.js";
import source from "../workflows/optimizer.yml" with { type: "text" };
import {
  isStable,
  type Metric,
  type MetricSummary,
  readProfile,
  summarize,
} from "./optimizer-profile.js";

type Axis = "scheduler" | "ladder" | "limits";
const AXES: readonly Axis[] = ["scheduler", "ladder", "limits"];

export type OptimizationRequest = {
  /** The prepared pair and the existing invocation, run without a shell in `cwd`. */
  target: {
    yaml: string;
    ts: string;
    cwd: string;
    argv: string[];
    /** Run before every execution; must succeed. */
    resetArgv?: string[];
  };
  /** Holds original.yml, original.ts and prepared.ts; never a previous invocation's state. */
  sessionDir: string;
  workloadId: string;
  objective: { metric: Metric; direction: "minimize" | "maximize" };
  constraints: { metric: Metric; op: "<=" | ">="; threshold: number }[];
  repeats: number;
  /** Every present predicate must hold to converge; at least one is required. */
  stop: {
    target?: number;
    improvement?: { kind: "absolute" | "relative"; value: number };
    plateau?: {
      window: number;
      absoluteTolerance: number;
      relativeTolerance: number;
    };
  };
  axes: Axis[];
  /** Target model/thinking pairs candidate ladders and agentic schedulers may use; editor separate. */
  allowedModels: { model: string; thinking?: LadderRung["thinking"] }[];
  /** Upper bounds of the extra limits a candidate may add; original hard limits still apply. */
  limitBounds: { memoryBytes?: number; tokens?: number; tools?: number };
  runBudget?: number;
  timeBudgetMs?: number;
};

type Candidate = {
  /** Exact interiors of the three tuning regions. */
  sources: Record<Axis, string>;
  /** SHA-256 of the full target TS: the configuration identity, never a measurement. */
  tsHash: string;
};
type Observation = {
  run: number;
  directory: string;
  status: "running" | "ok" | "failed" | "cancelled";
  objective: MetricSummary | null;
  /** Same order as `request.constraints`. */
  constraints: (MetricSummary | null)[];
  error: string | null;
};
type Trial = {
  kind: "trial";
  phase: "baseline" | "candidate" | "remeasure" | "confirmation";
  axis: Axis | null;
  candidate: Candidate;
  runs: Observation[];
  score: number | null;
  feasible: boolean;
};
type Edit = {
  kind: "edit";
  ticket: string;
  axis: Axis;
  beforeHash: string;
  afterHash: string | null;
  source: string | null;
  reason: string;
  accepted: boolean;
  error: string | null;
};
type Stop = NonNullable<OptimizationState["stop"]>;

export type OptimizationState = {
  request: OptimizationRequest;
  current: Candidate;
  anchor: { candidate: Candidate; score: number | null };
  baselineScore: number | null;
  graphHash: string | null;
  cycle: number;
  axisIndex: number;
  cycleImproved: boolean;
  explored: Axis[];
  stableValues: number[];
  editTicket: string | null;
  history: (Trial | Edit)[];
  stop: null | {
    kind: "converged" | "cancelled" | "budget" | "blocked" | "failed";
    reason: string;
  };
};

const SOL: LadderRung = {
  model: "github-copilot/gpt-6.1-sol",
  thinking: "high",
};
const MARKER = "junco-profile-optimizer:";
const GRACE_MS = 5_000;
const EDITOR = NodeId.create("Editor");
const EDGES = {
  initial: "initial-state",
  feedback: "feedback-state",
  assignment: "editor-assignment",
  awaiting: "awaiting-edit",
  complete: "editor-complete",
  terminal: "terminal-state",
} as const;
/** Prefix of an edit error whose turn ended in a provider error: a non-converged stop, not a retry. */
const PROVIDER_FAILURE = "editor provider failure";

type Receipt = {
  ticket: string;
  axis: Axis;
  beforeHash: string;
  afterHash: string;
  source: string;
  reason: string;
};
/** The one editor turn in flight: its ticket, base hash and the tool's busy/receipt state. */
type Turn = {
  readonly ticket: string;
  readonly axis: Axis;
  readonly baseHash: string;
  busy: boolean;
  receipt: Receipt | undefined;
};
type Session = {
  readonly request: OptimizationRequest;
  readonly tsReal: string;
  readonly yamlReal: string;
  readonly tsMode: number;
  readonly yamlHash: string;
  readonly original: Buffer;
  readonly prepared: string;
  /** prepared.ts with every region interior removed: the bytes no edit may change. */
  readonly skeleton: string;
  readonly statePath: string;
  readonly runsDir: string;
  readonly transpile: (code: string) => void;
  /** Aborted by the caller or the time budget. */
  readonly signal: AbortSignal;
  readonly halted: (runs: number) => Stop | undefined;
  readonly checkpoint: (state: OptimizationState) => Promise<void>;
  readonly initial: OptimizationState;
  /** The latest checkpointed state, which an interrupted graph run is finalized from. */
  readonly latest: OptimizationState;
  /** Why restoration is unsafe: a live child group or an external-resource cleanup guard. */
  unsafe: string | undefined;
};
type OptimizerContext = { readonly session: Session; turn: Turn | undefined };

/** A drifted target or unprovable cleanup: stop blocked without overwriting anything. */
class Blocked extends Error {}

const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
/** `error`'s message followed by its cause chain. */
const message = (error: unknown): string =>
  !(error instanceof Error)
    ? String(error)
    : error.cause === undefined
      ? error.message
      : `${error.message}: ${message(error.cause)}`;

// --- tuning regions ----------------------------------------------------------------------------

/** Interior bounds per axis: from the line after its start marker to its end marker's line. */
function bounds(text: string): Record<Axis, [number, number]> {
  const found = text.split(MARKER).length - 1;
  if (found !== AXES.length * 2)
    throw new Blocked(
      `expected exactly one ordered marker pair per axis, found ${found} markers`,
    );
  const result: Partial<Record<Axis, [number, number]>> = {};
  let floor = 0;
  for (const axis of AXES) {
    const start = text.indexOf(`// ${MARKER}start ${axis}`);
    const end = text.indexOf(`// ${MARKER}end ${axis}`);
    if (start < floor || end < start)
      throw new Blocked(
        `markers of the ${axis} region are missing or out of order`,
      );
    const open = text.indexOf("\n", start);
    if (open < 0 || open > end)
      throw new Blocked(`the ${axis} start marker must end its line`);
    result[axis] = [open + 1, text.lastIndexOf("\n", end) + 1];
    floor = end;
  }
  return result as Record<Axis, [number, number]>;
}

type Regions = { sources: Record<Axis, string>; skeleton: string };
function regions(text: string): Regions {
  const at = bounds(text);
  let skeleton = "";
  let from = 0;
  for (const axis of AXES) {
    skeleton += text.slice(from, at[axis][0]);
    from = at[axis][1];
  }
  skeleton += text.slice(from);
  return {
    sources: {
      scheduler: text.slice(...at.scheduler),
      ladder: text.slice(...at.ladder),
      limits: text.slice(...at.limits),
    },
    skeleton,
  };
}

const splice = (text: string, axis: Axis, interior: string): string => {
  const [from, to] = bounds(text)[axis];
  return text.slice(0, from) + interior + text.slice(to);
};
const compose = (prepared: string, sources: Record<Axis, string>): string =>
  AXES.reduce((text, axis) => splice(text, axis, sources[axis]), prepared);

// --- request validation and session -----------------------------------------------------------

/** The closed schemas `workflows.optimizer` declares on its state edges. */
function schemas(): { state: TSchema; request: TSchema } {
  const document = parse(source, { sourceName: "optimizer.yml" });
  const edge = document.graph.edges?.find((e) => e.id === EDGES.initial);
  const state: unknown = edge?.schema;
  if (
    typeof state !== "object" ||
    state === null ||
    !("properties" in state) ||
    typeof state.properties !== "object" ||
    state.properties === null ||
    !("request" in state.properties)
  )
    throw new Error("optimizer.yml lacks its state schema");
  // Parsed and checked JSON Schema mappings: the engine checks them with Value.Check too.
  const schema = state as TSchema;
  const request = state.properties.request as TSchema;
  return { state: schema, request };
}

/** Throws unless `value` is a well-formed request; paths may still be relative. */
export function checkRequest(
  value: unknown,
  schema: TSchema = schemas().request,
): asserts value is OptimizationRequest {
  if (!Value.Check(schema, value)) {
    const [error] = Value.Errors(schema, value);
    throw new TypeError(
      `invalid optimization request at ${error?.instancePath || "/"}: ${error?.message ?? "invalid value"}`,
    );
  }
  const request = value as OptimizationRequest;
  const order = request.axes.map((axis) => AXES.indexOf(axis));
  if (order.some((index, i) => i > 0 && index <= (order[i - 1] as number)))
    throw new TypeError(
      "axes must be unique, in scheduler, ladder, limits order",
    );
  for (const metric of [
    request.objective.metric,
    ...request.constraints.map((constraint) => constraint.metric),
  ])
    if (
      metric.kind === "probe" &&
      metric.node !== "" &&
      metric.node.split("/").some((segment) => segment === "")
    )
      throw new TypeError(
        `probe node path "${metric.node}" has an empty segment`,
      );
  if (request.axes.includes("ladder") && request.allowedModels.length === 0)
    throw new TypeError("the ladder axis requires allowedModels");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function openSession(
  request: OptimizationRequest,
  base: {
    readonly transpile: (code: string) => void;
    readonly signal: AbortSignal;
    readonly halted: Session["halted"];
  },
): Promise<Session> {
  const { target, sessionDir } = request;
  for (const [name, path] of [
    ["target.yaml", target.yaml],
    ["target.ts", target.ts],
    ["target.cwd", target.cwd],
    ["sessionDir", sessionDir],
  ] as const)
    if (!isAbsolute(path))
      throw new TypeError(`${name} must be an absolute path`);
  const [yamlReal, tsReal] = await Promise.all([
    realpath(target.yaml),
    realpath(target.ts),
  ]);
  if (yamlReal === tsReal)
    throw new TypeError("target.yaml and target.ts must be different files");
  for (const stale of ["state.json", "optimizer.jsonl", "runs"])
    if (await exists(join(sessionDir, stale)))
      throw new TypeError(
        `${join(sessionDir, stale)} belongs to a previous invocation; prepare a fresh session`,
      );
  const [originalYaml, original, preparedBytes, yaml, ts, tsStat] =
    await Promise.all([
      readFile(join(sessionDir, "original.yml")),
      readFile(join(sessionDir, "original.ts")),
      readFile(join(sessionDir, "prepared.ts")),
      readFile(yamlReal),
      readFile(tsReal),
      stat(tsReal),
    ]);
  if (!yaml.equals(originalYaml))
    throw new TypeError("target.yaml differs from the session's original.yml");
  if (!ts.equals(preparedBytes))
    throw new TypeError("target.ts differs from the session's prepared.ts");
  const prepared = preparedBytes.toString("utf8");
  if (!prepared.includes("JUNCO_PROFILE_RUN_DIR"))
    throw new TypeError(
      "prepared.ts carries no JUNCO_PROFILE_RUN_DIR instrumentation",
    );
  let parsed: Regions;
  try {
    parsed = regions(prepared);
  } catch (error) {
    throw new TypeError(`prepared.ts tuning markers: ${message(error)}`);
  }
  const candidate: Candidate = {
    sources: parsed.sources,
    tsHash: sha256(preparedBytes),
  };
  const initial: OptimizationState = {
    request,
    current: candidate,
    anchor: { candidate, score: null },
    baselineScore: null,
    graphHash: null,
    cycle: 0,
    axisIndex: 0,
    cycleImproved: false,
    explored: [],
    stableValues: [],
    editTicket: null,
    history: [],
    stop: null,
  };
  const statePath = join(sessionDir, "state.json");
  let latest = initial;
  return {
    ...base,
    request,
    tsReal,
    yamlReal,
    tsMode: tsStat.mode & 0o7777,
    yamlHash: sha256(yaml),
    original,
    prepared,
    skeleton: parsed.skeleton,
    statePath,
    runsDir: join(sessionDir, "runs"),
    initial,
    get latest() {
      return latest;
    },
    unsafe: undefined,
    checkpoint: async (state) => {
      latest = state;
      const tmp = `${statePath}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
        flag: "wx",
      });
      await rename(tmp, statePath);
    },
  };
}

/** Catalog support, saved login, account access and thinking support of every rung. */
async function preflight(
  models: ModelRuntime,
  rungs: readonly LadderRung[],
  signal: AbortSignal,
): Promise<void> {
  // Loaded on invocation: importing the library root stays free of model runtime helpers.
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
  const credentials = await models.listCredentials({ signal });
  for (const rung of rungs) {
    const slash = rung.model.indexOf("/");
    const provider = rung.model.slice(0, slash);
    const modelId = rung.model.slice(slash + 1);
    const model = models.getModel(provider, modelId);
    if (model === undefined)
      throw new Error(`${rung.model} is not in the model catalog`);
    if (!credentials.some(({ providerId }) => providerId === provider))
      throw new Error(
        `a saved ${provider} login is required for ${rung.model}`,
      );
    const available = await models.getAvailable(provider, { signal });
    if (!available.some(({ id }) => id === modelId))
      throw new Error(`${rung.model} is not available to this account`);
    const thinking = rung.thinking ?? "off";
    if (!getSupportedThinkingLevels(model).includes(thinking))
      throw new Error(`${rung.model} does not support ${thinking} thinking`);
  }
}

// --- target files -------------------------------------------------------------------------------

async function readTarget(
  session: Session,
): Promise<{ bytes: Buffer; text: string; hash: string }> {
  if ((await realpath(session.request.target.ts)) !== session.tsReal)
    throw new Blocked("target.ts was redirected to another file");
  const bytes = await readFile(session.tsReal);
  return { bytes, text: bytes.toString("utf8"), hash: sha256(bytes) };
}

async function checkYaml(session: Session): Promise<void> {
  if ((await realpath(session.request.target.yaml)) !== session.yamlReal)
    throw new Blocked("target.yaml was redirected to another file");
  if (sha256(await readFile(session.yamlReal)) !== session.yamlHash)
    throw new Blocked("target.yaml changed; its original bytes are required");
}

/** Atomically replace target.ts with `bytes`, only while it still hashes to `expected`. */
async function replaceTarget(
  session: Session,
  bytes: string | Buffer,
  expected: string,
): Promise<void> {
  if ((await readTarget(session)).hash !== expected)
    throw new Blocked(
      "target.ts changed outside the optimizer; left untouched",
    );
  const tmp = join(
    dirname(session.tsReal),
    `.${basename(session.tsReal)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tmp, bytes, { flag: "wx", mode: session.tsMode });
    await chmod(tmp, session.tsMode);
    if ((await readTarget(session)).hash !== expected)
      throw new Blocked(
        "target.ts changed outside the optimizer; left untouched",
      );
    await rename(tmp, session.tsReal);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

// --- editor tools ------------------------------------------------------------------------------

const readParameters = Type.Object({}, { additionalProperties: false });
const editParameters = Type.Object(
  {
    ticket: Type.String(),
    axis: Type.Union(AXES.map((axis) => Type.Literal(axis))),
    expectedTsHash: Type.String(),
    source: Type.String(),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

async function applyEdit(
  session: Session,
  turn: Turn,
  input: { axis: Axis; expectedTsHash: string; source: string; reason: string },
): Promise<Receipt> {
  const before = await readTarget(session);
  if (before.hash !== input.expectedTsHash)
    throw new Error(
      `stale expectedTsHash; the current tsHash is ${before.hash}`,
    );
  if (before.hash !== turn.baseHash)
    throw new Error("target.ts changed outside the optimizer during this turn");
  await checkYaml(session);
  if (input.source.includes(MARKER) || input.source.includes("\0"))
    throw new Error("source must not contain region markers or NUL characters");
  const interior =
    input.source === "" || input.source.endsWith("\n")
      ? input.source
      : `${input.source}\n`;
  if (regions(before.text).sources[input.axis] === interior)
    throw new Error(
      "source is byte-identical to the current region; change it",
    );
  const prospective = splice(before.text, input.axis, interior);
  if (regions(prospective).skeleton !== session.skeleton)
    throw new Error("the edit would change bytes outside the tuning regions");
  try {
    session.transpile(prospective);
  } catch (error) {
    throw new Error(`the edited TypeScript does not parse: ${message(error)}`);
  }
  await replaceTarget(session, prospective, before.hash);
  const after = await readTarget(session);
  return {
    ticket: turn.ticket,
    axis: input.axis,
    beforeHash: before.hash,
    afterHash: after.hash,
    source: regions(after.text).sources[input.axis],
    reason: input.reason,
  };
}

function editorTools(ctx: OptimizerContext): Record<string, AgentTool> {
  const reply = <D>(details: D) => ({
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  });
  const read: AgentTool<typeof readParameters> = {
    name: "read_target",
    label: "read_target",
    description:
      "Returns the target workflow's YAML, its TypeScript entrypoint and the entrypoint's SHA-256 tsHash.",
    parameters: readParameters,
    executionMode: "sequential",
    execute: async () => {
      const [yaml, ts] = await Promise.all([
        readFile(ctx.session.yamlReal, "utf8"),
        readTarget(ctx.session),
      ]);
      return reply({ yaml, typescript: ts.text, tsHash: ts.hash });
    },
  };
  const edit: AgentTool<typeof editParameters> = {
    name: "edit_tuning",
    label: "edit_tuning",
    description:
      "Replaces the complete interior of this turn's tuning region in the target TypeScript with source. Requires the turn's ticket and axis and the current tsHash; one successful edit per turn. Returns the host's receipt.",
    parameters: editParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, input) => {
      const turn = ctx.turn;
      if (turn === undefined) throw new Error("no editor turn is active");
      if (turn.busy)
        throw new Error(
          "another edit_tuning call is in progress; wait for its result",
        );
      turn.busy = true;
      try {
        if (!Value.Check(editParameters, input))
          throw new Error(
            "edit_tuning requires ticket, axis, expectedTsHash, source and reason",
          );
        if (input.ticket !== turn.ticket)
          throw new Error(`ticket must be ${turn.ticket}`);
        if (input.axis !== turn.axis)
          throw new Error(`this turn edits the ${turn.axis} region only`);
        if (turn.receipt !== undefined)
          throw new Error("this turn already applied its one edit");
        turn.receipt = await applyEdit(ctx.session, turn, input);
        return reply(turn.receipt);
      } finally {
        turn.busy = false;
      }
    },
  };
  return { read_target: read, edit_tuning: edit };
}

// --- child execution ----------------------------------------------------------------------------

/** Signal owned group `group`: false only when it no longer exists. */
function signalGroup(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw new Error(`failed to send ${signal} to process group ${group}`, {
      cause: error,
    });
  }
}

async function groupGone(group: number): Promise<boolean> {
  const deadline = Date.now() + GRACE_MS;
  while (signalGroup(group, 0)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** Prove an owned group gone after its leader closed: TERM, wait, KILL, wait. */
async function drainGroup(group: number): Promise<void> {
  if (!signalGroup(group, 0)) return;
  signalGroup(group, "SIGTERM");
  if (await groupGone(group)) return;
  signalGroup(group, "SIGKILL");
  if (await groupGone(group)) return;
  throw new Error(`process group ${group} survived SIGKILL`);
}

type Outcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: unknown;
  cancelled: boolean;
};

/** One owned, detached child; waits for `close`, stops its group on abort, then proves it gone. */
async function spawnOwned(
  session: Session,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  directory: string,
  name: string,
): Promise<Outcome> {
  const [command, ...args] = argv as [string, ...string[]];
  const stdout = await open(join(directory, `${name}.stdout`), "wx");
  const stderr = await open(join(directory, `${name}.stderr`), "wx");
  let group: number | undefined;
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    if (group === undefined) return;
    const owned = group;
    try {
      signalGroup(owned, "SIGTERM");
    } catch {
      // Escalation below still runs; the drain proves disappearance either way.
    }
    escalation ??= setTimeout(() => {
      try {
        signalGroup(owned, "SIGKILL");
      } catch {}
    }, GRACE_MS);
  };
  try {
    const { promise, resolve } =
      Promise.withResolvers<Omit<Outcome, "cancelled">>();
    let child: ChildProcess | undefined;
    try {
      child = spawn(command, args, {
        cwd: session.request.target.cwd,
        env,
        stdio: ["ignore", stdout.fd, stderr.fd],
        shell: false,
        detached: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, error });
    }
    if (child !== undefined) {
      group = child.pid;
      let failure: unknown;
      child.once("error", (error) => {
        failure = error;
        // Without a pid no process exists, so no close fence will follow.
        if (group === undefined) resolve({ code: null, signal: null, error });
      });
      child.once("close", (code, signal) =>
        resolve({ code, signal, error: failure }),
      );
      if (session.signal.aborted) stop();
      else session.signal.addEventListener("abort", stop, { once: true });
    }
    const closed = await promise;
    const cancelled = session.signal.aborted;
    session.signal.removeEventListener("abort", stop);
    if (group !== undefined) {
      try {
        await drainGroup(group);
      } catch (error) {
        session.unsafe = message(error);
        throw new Blocked(`child cleanup unproven: ${message(error)}`);
      }
    }
    const pending = join(directory, "cleanup.pending");
    try {
      await lstat(pending);
      session.unsafe = `external cleanup unproven: ${pending}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        session.unsafe = `cannot inspect external cleanup guard ${pending}: ${message(error)}`;
    }
    if (session.unsafe !== undefined) throw new Blocked(session.unsafe);
    return { ...closed, cancelled };
  } finally {
    clearTimeout(escalation);
    await stdout.close();
    await stderr.close();
  }
}

const failure = (outcome: Outcome, what: string): string | undefined =>
  outcome.error !== undefined
    ? `${what} failed to run: ${message(outcome.error)}`
    : outcome.signal !== null
      ? `${what} ended by ${outcome.signal}`
      : outcome.code !== 0
        ? `${what} exited with status ${outcome.code}`
        : undefined;

const RECEIPT_KEYS = [
  "graphHash",
  "nonce",
  "resourceEvents",
  "terminal",
  "version",
];

type Completion = {
  graphHash: string;
  resourceEvents: number;
  /** Fixed target outcomes, validated only after the terminal nonce and graph identity. */
  metrics?: Record<string, number>;
};

async function readReceipt(
  directory: string,
  nonce: string,
  expectedGraphHash: string | null,
): Promise<Completion> {
  let receipt: unknown;
  try {
    receipt = JSON.parse(
      await readFile(join(directory, "completion.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(`no valid completion receipt: ${message(error)}`);
  }
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    Object.keys(receipt)
      .filter((key) => key !== "metrics")
      .sort()
      .join() !== RECEIPT_KEYS.join() ||
    !("version" in receipt) ||
    receipt.version !== 1 ||
    !("nonce" in receipt) ||
    receipt.nonce !== nonce ||
    !("terminal" in receipt) ||
    receipt.terminal !== true ||
    !("graphHash" in receipt) ||
    typeof receipt.graphHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.graphHash) ||
    !("resourceEvents" in receipt) ||
    typeof receipt.resourceEvents !== "number" ||
    !Number.isSafeInteger(receipt.resourceEvents) ||
    receipt.resourceEvents < 0
  )
    throw new Error(
      "the completion receipt is malformed or carries another nonce",
    );
  if (expectedGraphHash !== null && receipt.graphHash !== expectedGraphHash)
    throw new Error("the runtime graph document differs from the baseline's");
  let metrics: Record<string, number> | undefined;
  if ("metrics" in receipt) {
    if (
      typeof receipt.metrics !== "object" ||
      receipt.metrics === null ||
      Array.isArray(receipt.metrics) ||
      Object.values(receipt.metrics).some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    )
      throw new TypeError(
        "completion receipt metrics must be an object of finite numbers",
      );
    metrics = receipt.metrics as Record<string, number>;
  }
  return {
    graphHash: receipt.graphHash,
    resourceEvents: receipt.resourceEvents,
    ...(metrics === undefined ? {} : { metrics }),
  };
}

const metricsOf = (request: OptimizationRequest): Metric[] => [
  request.objective.metric,
  ...request.constraints.map((constraint) => constraint.metric),
];

type ChildResult = { observation: Observation; graphHash: string | null };

/**
 * One measured execution of the saved target, which must hash to `candidate.tsHash` before and
 * after. Only a clean close, the exact nonce's terminal receipt, matching document/YAML hashes and
 * a parsed fresh profile make it `ok`.
 */
async function runChild(
  session: Session,
  state: OptimizationState,
  run: number,
  directory: string,
  candidate: Candidate,
): Promise<ChildResult> {
  const { request } = session;
  const failed = (error: string, status: Observation["status"] = "failed") => ({
    observation: {
      run,
      directory,
      status,
      objective: null,
      constraints: [],
      error,
    } satisfies Observation,
    graphHash: null,
  });
  const checkTarget = async (when: string) => {
    await checkYaml(session);
    if ((await readTarget(session)).hash !== candidate.tsHash)
      throw new Blocked(
        `target.ts does not hold the measured configuration ${when} run ${run}`,
      );
  };
  await mkdir(session.runsDir, { recursive: true });
  await mkdir(directory);
  await checkTarget("before");
  if (request.target.resetArgv !== undefined) {
    const reset = await spawnOwned(
      session,
      request.target.resetArgv,
      process.env,
      directory,
      "reset",
    );
    if (reset.cancelled) return failed("cancelled during reset", "cancelled");
    const problem = failure(reset, "reset");
    if (problem !== undefined) return failed(problem);
  }
  const nonce = randomUUID();
  const metrics = metricsOf(request);
  const probes = [
    ...new Map(
      metrics.flatMap((metric) =>
        metric.kind === "probe"
          ? [
              [
                JSON.stringify([metric.node, metric.edgeId]),
                { node: metric.node, edgeId: metric.edgeId },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  await writeFile(
    join(directory, "request.json"),
    `${JSON.stringify({
      version: 1,
      nonce,
      monitored: metrics.some((metric) => metric.kind === "memory"),
      probes,
      expectedGraphHash: state.graphHash,
      allowedModels: request.allowedModels,
      limitBounds: request.limitBounds,
    })}\n`,
    { flag: "wx" },
  );
  const outcome = await spawnOwned(
    session,
    request.target.argv,
    { ...process.env, JUNCO_PROFILE_RUN_DIR: directory },
    directory,
    "target",
  );
  await checkTarget("after");
  if (outcome.cancelled) return failed("cancelled", "cancelled");
  const problem = failure(outcome, "target");
  if (problem !== undefined)
    return failed(`${problem}; see ${join(directory, "target.stderr")}`);
  let receipt: Completion;
  try {
    receipt = await readReceipt(directory, nonce, state.graphHash);
  } catch (error) {
    return failed(message(error));
  }
  // A validated receipt establishes the document hash even when a metric is missing.
  let summaries: MetricSummary[];
  try {
    const samples = await readProfile(join(directory, "samples.jsonl"));
    summaries = metrics.map((metric) => {
      if (metric.kind === "memory" && receipt.resourceEvents === 0)
        throw new Error(
          "memory is unobserved: the run reported no native resource events",
        );
      return summarize(samples, metric, receipt.metrics);
    });
  } catch (error) {
    return { ...failed(message(error)), graphHash: receipt.graphHash };
  }
  const [objective, ...constraints] = summaries as [
    MetricSummary,
    ...MetricSummary[],
  ];
  return {
    observation: {
      run,
      directory,
      status: "ok",
      objective,
      constraints,
      error: null,
    },
    graphHash: receipt.graphHash,
  };
}

// --- scoring -----------------------------------------------------------------------------------

const runCount = (state: OptimizationState): number =>
  state.history.reduce(
    (n, item) => n + (item.kind === "trial" ? item.runs.length : 0),
    0,
  );

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const value =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  if (!Number.isFinite(value)) throw new RangeError("median is not finite");
  return value;
}

const satisfies = (request: OptimizationRequest, run: Observation): boolean =>
  request.constraints.every(({ op, threshold }, index) => {
    const summary = run.constraints[index];
    if (summary === null || summary === undefined) return false;
    return op === "<="
      ? summary.value <= threshold
      : summary.value >= threshold;
  });

/** The directional gain of `to` over `from`. */
function gain(request: OptimizationRequest, from: number, to: number): number {
  const value =
    request.objective.direction === "minimize" ? from - to : to - from;
  if (!Number.isFinite(value)) throw new RangeError("gain is not finite");
  return value;
}

const tolerance = (request: OptimizationRequest, reference: number): number => {
  const plateau = request.stop.plateau;
  const value =
    plateau === undefined
      ? 0
      : plateau.absoluteTolerance +
        plateau.relativeTolerance * Math.abs(reference);
  if (!Number.isFinite(value)) throw new RangeError("tolerance is not finite");
  return value;
};

/** Target and improvement predicates at `score`. */
function meetsGoals(state: OptimizationState, score: number): boolean {
  const { request, baselineScore } = state;
  const { target, improvement } = request.stop;
  if (
    target !== undefined &&
    !(request.objective.direction === "minimize"
      ? score <= target
      : score >= target)
  )
    return false;
  if (improvement !== undefined) {
    if (baselineScore === null) return false;
    let amount = gain(request, baselineScore, score);
    if (improvement.kind === "relative") amount /= Math.abs(baselineScore);
    if (!Number.isFinite(amount))
      throw new RangeError("improvement is not finite");
    if (amount < improvement.value) return false;
  }
  return true;
}

const stable = (
  request: OptimizationRequest,
  values: readonly number[],
): boolean => {
  const plateau = request.stop.plateau;
  return (
    plateau === undefined ||
    isStable(
      values,
      plateau.window,
      plateau.absoluteTolerance,
      plateau.relativeTolerance,
    )
  );
};

const runValues = (trial: Trial): number[] =>
  trial.runs.flatMap((run) =>
    run.objective === null ? [] : [run.objective.value],
  );

// --- control -----------------------------------------------------------------------------------

type Route = {
  readonly state: OptimizationState;
  readonly route: "editor" | "final";
};

const withLast = (
  state: OptimizationState,
  trial: Trial,
  base: number,
): OptimizationState => ({
  ...state,
  history: [...state.history.slice(0, base), trial],
});

/**
 * `count` fresh executions of `state.current`, appended as one trial and checkpointed around every
 * child. The batch stops at its first ineligible run; its median scores only a complete batch.
 */
async function measure(
  ctx: OptimizerContext,
  input: OptimizationState,
  phase: Trial["phase"],
  axis: Axis | null,
  count: number,
): Promise<{ state: OptimizationState; trial: Trial; stop?: Stop }> {
  const { session } = ctx;
  const base = input.history.length;
  let trial: Trial = {
    kind: "trial",
    phase,
    axis,
    candidate: input.current,
    runs: [],
    score: null,
    feasible: false,
  };
  let state = withLast(input, trial, base);
  for (let i = 0; i < count; i++) {
    const halted = session.halted(runCount(state));
    if (halted !== undefined) {
      // A batch halted before its first run records no trial.
      if (trial.runs.length === 0) state = input;
      await session.checkpoint(state);
      return { state, trial, stop: halted };
    }
    const run = runCount(state) + 1;
    const directory = join(session.runsDir, String(run).padStart(4, "0"));
    const running: Observation = {
      run,
      directory,
      status: "running",
      objective: null,
      constraints: [],
      error: null,
    };
    trial = { ...trial, runs: [...trial.runs, running] };
    state = withLast(state, trial, base);
    await session.checkpoint(state);
    let outcome: ChildResult;
    try {
      outcome = await runChild(session, state, run, directory, trial.candidate);
    } catch (error) {
      trial = {
        ...trial,
        runs: [
          ...trial.runs.slice(0, -1),
          { ...running, status: "failed", error: message(error) },
        ],
      };
      await session.checkpoint(withLast(state, trial, base));
      throw error;
    }
    trial = {
      ...trial,
      runs: [...trial.runs.slice(0, -1), outcome.observation],
    };
    state = withLast(state, trial, base);
    if (state.graphHash === null && outcome.graphHash !== null)
      state = { ...state, graphHash: outcome.graphHash };
    await session.checkpoint(state);
    if (outcome.observation.status === "cancelled") {
      const stop = session.halted(runCount(state)) ?? {
        kind: "cancelled",
        reason: "cancelled",
      };
      return { state, trial, stop };
    }
    if (outcome.observation.status !== "ok") break;
  }
  const complete =
    trial.runs.length === count &&
    trial.runs.every((run) => run.status === "ok");
  const score = complete ? median(runValues(trial)) : null;
  trial = {
    ...trial,
    score,
    feasible:
      score !== null &&
      trial.runs.every((run) => satisfies(state.request, run)),
  };
  state = withLast(state, trial, base);
  await session.checkpoint(state);
  return { state, trial };
}

/** Put the anchor's bytes back, only over the optimizer's own last write. */
async function restoreAnchor(
  ctx: OptimizerContext,
  state: OptimizationState,
): Promise<OptimizationState> {
  const { anchor, current } = state;
  if (current.tsHash === anchor.candidate.tsHash) {
    if ((await readTarget(ctx.session)).hash !== current.tsHash)
      throw new Blocked(
        "target.ts changed outside the optimizer; left untouched",
      );
    return state;
  }
  const text = compose(ctx.session.prepared, anchor.candidate.sources);
  if (sha256(text) !== anchor.candidate.tsHash)
    throw new Error("the anchor's region sources do not reproduce its hash");
  await replaceTarget(ctx.session, text, current.tsHash);
  return { ...state, current: anchor.candidate };
}

/** Restore original.ts after a non-converged stop when safe; checkpoint the terminal state. */
async function settle(
  session: Session,
  state: OptimizationState,
  stop: Stop,
): Promise<OptimizationState> {
  let reason = stop.reason;
  if (stop.kind !== "converged") {
    try {
      if (session.unsafe !== undefined) throw new Error(session.unsafe);
      await replaceTarget(session, session.original, state.current.tsHash);
    } catch (error) {
      reason += `; original TS not restored: ${message(error)}`;
    }
  }
  const final: OptimizationState = {
    ...state,
    stop: { kind: stop.kind, reason },
  };
  await session.checkpoint(final);
  return final;
}

function prompt(state: OptimizationState, ticket: string, axis: Axis): string {
  return [
    `Optimization turn ${ticket}: tune the ${axis} region (cycle ${state.cycle}).`,
    "Read the complete optimization state on editor-assignment with recv, then call read_target,",
    `then edit_tuning with ticket "${ticket}" and axis "${axis}". Finish with one sentence.`,
  ].join(" ");
}

/** Arm the next editor turn on the anchor's bytes and route the same ticketed state to Editor and Feedback. */
async function stage(
  ctx: OptimizerContext,
  graph: JuncoGraph<TSchema, unknown>,
  input: OptimizationState,
): Promise<Route> {
  const { session } = ctx;
  const halted = session.halted(runCount(input));
  if (halted !== undefined) return terminal(ctx, input, halted);
  const state = await restoreAnchor(ctx, input);
  const axis = state.request.axes[state.axisIndex] as Axis;
  const node = graph.getNode(EDITOR);
  const agent = node?.state;
  if (
    !(agent instanceof JuncoAgent) ||
    node?.status !== "ready" ||
    agent.status !== "idle"
  )
    throw new Error("the editor is not idle and ready for a new assignment");
  const ticket = randomUUID();
  const next: OptimizationState = { ...state, editTicket: ticket };
  ctx.turn = {
    ticket,
    axis,
    baseHash: next.current.tsHash,
    busy: false,
    receipt: undefined,
  };
  agent.stagePrompt(prompt(next, ticket, axis));
  await session.checkpoint(next);
  return { state: next, route: "editor" };
}

async function terminal(
  ctx: OptimizerContext,
  state: OptimizationState,
  stop: Stop,
): Promise<Route> {
  return { state: await settle(ctx.session, state, stop), route: "final" };
}

/** All requested stop predicates at the anchor, the plateau after an all-axis cycle. */
function predicatesHold(state: OptimizationState): boolean {
  const score = state.anchor.score;
  if (score === null || !meetsGoals(state, score)) return false;
  return (
    state.request.stop.plateau === undefined ||
    (!state.cycleImproved && stable(state.request, state.stableValues))
  );
}

/** Fresh cycle-start values of a feasible anchor batch, at most W retained. */
function window(state: OptimizationState, trial: Trial): number[] {
  const plateau = state.request.stop.plateau;
  if (plateau === undefined || !trial.feasible) return [];
  return [...state.stableValues, ...runValues(trial)].slice(-plateau.window);
}

async function baseline(
  ctx: OptimizerContext,
  graph: JuncoGraph<TSchema, unknown>,
  input: OptimizationState,
): Promise<Route> {
  const { request } = input;
  const measured = await measure(ctx, input, "baseline", null, request.repeats);
  let state = measured.state;
  if (measured.stop !== undefined) return terminal(ctx, state, measured.stop);
  if (state.graphHash === null)
    return terminal(ctx, state, {
      kind: "blocked",
      reason: "no baseline run established the validated graph document hash",
    });
  const score = measured.trial.score;
  const improvement = request.stop.improvement;
  if (improvement !== undefined && score === null)
    return terminal(
      ctx,
      { ...state, baselineScore: score },
      {
        kind: "blocked",
        reason:
          "the baseline has no complete measurement for an improvement goal",
      },
    );
  if (improvement?.kind === "relative" && score === 0)
    return terminal(
      ctx,
      { ...state, baselineScore: score },
      {
        kind: "blocked",
        reason: "a relative improvement is undefined for a zero baseline",
      },
    );
  state = {
    ...state,
    baselineScore: score,
    anchor: { ...state.anchor, score: measured.trial.feasible ? score : null },
    stableValues: window(state, measured.trial),
  };
  return stage(ctx, graph, state);
}

/** A completed all-axis cycle: confirm when every predicate holds, else remeasure and continue. */
async function completeCycle(
  ctx: OptimizerContext,
  graph: JuncoGraph<TSchema, unknown>,
  input: OptimizationState,
): Promise<Route> {
  let state = input;
  const { request } = state;
  if (predicatesHold(state)) {
    const plateau = request.stop.plateau;
    const count =
      plateau === undefined
        ? request.repeats
        : Math.max(request.repeats, plateau.window);
    const confirmed = await measure(ctx, state, "confirmation", null, count);
    state = confirmed.state;
    if (confirmed.stop !== undefined)
      return terminal(ctx, state, confirmed.stop);
    if ((await readTarget(ctx.session)).hash !== state.anchor.candidate.tsHash)
      throw new Blocked("target.ts changed during confirmation");
    const { trial } = confirmed;
    if (
      trial.feasible &&
      trial.score !== null &&
      meetsGoals(state, trial.score) &&
      stable(request, runValues(trial))
    )
      return terminal(
        ctx,
        { ...state, anchor: { ...state.anchor, score: trial.score } },
        {
          kind: "converged",
          reason: `confirmed over ${trial.runs.length} fresh runs of the saved entrypoint`,
        },
      );
    state = {
      ...state,
      stableValues: [],
      anchor: {
        ...state.anchor,
        score: trial.feasible ? state.anchor.score : null,
      },
    };
  }
  state = {
    ...state,
    cycle: state.cycle + 1,
    axisIndex: 0,
    cycleImproved: false,
  };
  const remeasured = await measure(
    ctx,
    state,
    "remeasure",
    null,
    request.repeats,
  );
  state = remeasured.state;
  if (remeasured.stop !== undefined)
    return terminal(ctx, state, remeasured.stop);
  state = {
    ...state,
    anchor: {
      ...state.anchor,
      score: remeasured.trial.feasible ? remeasured.trial.score : null,
    },
    stableValues: remeasured.trial.feasible
      ? window(state, remeasured.trial)
      : [],
  };
  return stage(ctx, graph, state);
}

/** Evaluate's decision for one inbound state. */
async function advance(
  ctx: OptimizerContext,
  graph: JuncoGraph<TSchema, unknown>,
  input: OptimizationState,
): Promise<Route> {
  if (input.stop !== null) throw new Error("Evaluate received a stopped state");
  try {
    if (input.history.length === 0) return await baseline(ctx, graph, input);
    const last = input.history.at(-1);
    if (last?.kind !== "edit")
      throw new Error("Evaluate expects an edit outcome after the baseline");
    if (!last.accepted)
      return last.error?.startsWith(PROVIDER_FAILURE)
        ? await terminal(ctx, input, { kind: "failed", reason: last.error })
        : await stage(ctx, graph, input);
    const axis = input.request.axes[input.axisIndex] as Axis;
    const measured = await measure(
      ctx,
      input,
      "candidate",
      axis,
      input.request.repeats,
    );
    let state = measured.state;
    if (measured.stop !== undefined)
      return await terminal(ctx, state, measured.stop);
    const { trial } = measured;
    // An execution or measurement error retries the same axis from the anchor.
    if (trial.score === null) return await stage(ctx, graph, state);
    const anchorScore = state.anchor.score;
    if (
      trial.feasible &&
      (anchorScore === null ||
        gain(state.request, anchorScore, trial.score) >
          tolerance(state.request, anchorScore))
    )
      state = {
        ...state,
        anchor: { candidate: state.current, score: trial.score },
        stableValues: [],
        cycleImproved: true,
      };
    else state = await restoreAnchor(ctx, state);
    state = {
      ...state,
      axisIndex: state.axisIndex + 1,
      explored: state.explored.includes(axis)
        ? state.explored
        : [...state.explored, axis],
    };
    return state.axisIndex < state.request.axes.length
      ? await stage(ctx, graph, state)
      : await completeCycle(ctx, graph, state);
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    const latest = ctx.session.latest;
    return terminal(ctx, latest.stop === null ? latest : input, {
      kind: "blocked",
      reason: error.message,
    });
  }
}

// --- code nodes ----------------------------------------------------------------------------------

type View = ParentView<TSchema, unknown>;

function edgeOf(
  edges: ReadonlyMap<string, Edge<TSchema, unknown>>,
  id: string,
) {
  const edge = edges.get(id);
  if (edge === undefined) throw new Error(`optimizer.yml lacks edge ${id}`);
  return edge;
}

/** The single valid state message across `ids`, as every continuation requires. */
function onlyState(
  view: View,
  schema: TSchema,
  ids: readonly string[],
): OptimizationState {
  const batch = ids.flatMap((id) => view.messages.get(EdgeId.create(id)) ?? []);
  if (batch.length !== 1)
    throw new Error(
      `expected exactly one optimization state, got ${batch.length}`,
    );
  const [state] = batch;
  if (!Value.Check(schema, state)) {
    const [error] = Value.Errors(schema, state);
    throw new Error(
      `invalid optimization state at ${error?.instancePath || "/"}: ${error?.message ?? "invalid value"}`,
    );
  }
  return state as OptimizationState;
}

const init: DeterministicNode<OptimizerContext> = ({
  edges,
  policy,
  context,
}) => {
  const out = edgeOf(edges, EDGES.initial);
  let emitted = false;
  return {
    state: new Deterministic<TSchema, unknown>(
      async function* (): NodeGenerator<TSchema, unknown> {
        emitted = true;
        yield [Message.create(out, context.session.initial)];
        // Parked by is_available; never resumed.
        return context.session.initial;
      },
      policy,
    ),
    is_available: () => !emitted,
  };
};

const evaluate: DeterministicNode<OptimizerContext> = ({
  graph,
  edges,
  policy,
  context,
}) => {
  const schema = edgeOf(edges, EDGES.initial).schema;
  const [assignment, awaiting, final] = [
    EDGES.assignment,
    EDGES.awaiting,
    EDGES.terminal,
  ].map((id) => edgeOf(edges, id)) as [
    Edge<TSchema, unknown>,
    Edge<TSchema, unknown>,
    Edge<TSchema, unknown>,
  ];
  return {
    state: new Deterministic<TSchema, unknown>(
      async function* (): NodeGenerator<TSchema, unknown> {
        let inputs = yield [];
        while (true) {
          const state = onlyState(inputs, schema, [
            EDGES.initial,
            EDGES.feedback,
          ]);
          const next = await advance(context, graph, state);
          inputs = yield next.route === "final"
            ? [Message.create(final, next.state)]
            : [
                Message.create(assignment, next.state),
                Message.create(awaiting, next.state),
              ];
        }
      },
      policy,
    ),
  };
};

const feedback: DeterministicNode<OptimizerContext> = ({
  graph,
  edges,
  policy,
  context,
}) => {
  const schema = edgeOf(edges, EDGES.initial).schema;
  const out = edgeOf(edges, EDGES.feedback);
  const awaitingId = EdgeId.create(EDGES.awaiting);
  /** The queued ticket's turn settled: the editor re-armed and its agent idle. */
  const settled = (view: View): boolean => {
    const turn = context.turn;
    const [queued, ...rest] = view.messages.get(awaitingId) ?? [];
    if (turn === undefined || rest.length > 0 || !Value.Check(schema, queued))
      return false;
    if ((queued as OptimizationState).editTicket !== turn.ticket) return false;
    const node = graph.getNode(EDITOR);
    const agent = node?.state;
    return (
      node?.status === "ready" &&
      agent instanceof JuncoAgent &&
      agent.status === "idle"
    );
  };
  return {
    state: new Deterministic<TSchema, unknown>(
      async function* (): NodeGenerator<TSchema, unknown> {
        let inputs = yield [];
        while (true) {
          const state = onlyState(inputs, schema, [EDGES.awaiting]);
          const turn = context.turn;
          if (turn === undefined || state.editTicket !== turn.ticket)
            throw new Error("Feedback received a state for an inactive ticket");
          context.turn = undefined;
          const { receipt } = turn;
          let error: string | null = null;
          const result: unknown = inputs.values.get(
            EdgeId.create(EDGES.complete),
          );
          try {
            finalText(result, "Editor");
          } catch (failure) {
            const provider =
              typeof result === "object" &&
              result !== null &&
              "stopReason" in result &&
              (result.stopReason === "error" ||
                result.stopReason === "aborted");
            error = provider
              ? `${PROVIDER_FAILURE}: ${message(failure)}`
              : message(failure);
          }
          if (receipt === undefined)
            error ??=
              "the editor turn settled without a successful edit_tuning";
          const edit: Edit = {
            kind: "edit",
            ticket: turn.ticket,
            axis: turn.axis,
            beforeHash: turn.baseHash,
            afterHash: receipt?.afterHash ?? null,
            source: receipt?.source ?? null,
            reason: receipt?.reason ?? "",
            accepted: receipt !== undefined && error === null,
            error,
          };
          // The optimizer owns a written file even when the turn is rejected, so it can restore it.
          const next: OptimizationState = {
            ...state,
            current:
              receipt === undefined
                ? state.current
                : {
                    sources: {
                      ...state.current.sources,
                      [turn.axis]: receipt.source,
                    },
                    tsHash: receipt.afterHash,
                  },
            editTicket: null,
            history: [...state.history, edit],
          };
          await context.session.checkpoint(next);
          inputs = yield [Message.create(out, next)];
        }
      },
      policy,
    ),
    is_available: (view, triggered) => triggered && settled(view),
  };
};

const finalNode: DeterministicNode<OptimizerContext> = ({ edges, policy }) => {
  const schema = edgeOf(edges, EDGES.initial).schema;
  return {
    state: new Deterministic<TSchema, unknown>(
      async function* (): NodeGenerator<TSchema, unknown> {
        const inputs = yield [];
        const state = onlyState(inputs, schema, [EDGES.terminal]);
        if (state.stop === null)
          throw new Error("Final requires a stopped state");
        return state;
      },
      policy,
    ),
  };
};

/** The latest checkpoint completed by an interruption: active runs and any pending receipt. */
function interrupted(
  latest: OptimizationState,
  turn: Turn | undefined,
  reason: string,
): OptimizationState {
  let state: OptimizationState = {
    ...latest,
    history: latest.history.map((item) =>
      item.kind === "trial" && item.runs.some((run) => run.status === "running")
        ? {
            ...item,
            runs: item.runs.map((run) =>
              run.status === "running"
                ? { ...run, status: "cancelled", error: reason }
                : run,
            ),
          }
        : item,
    ),
  };
  if (turn !== undefined && state.editTicket === turn.ticket) {
    const { receipt } = turn;
    state = {
      ...state,
      current:
        receipt === undefined
          ? state.current
          : {
              sources: {
                ...state.current.sources,
                [turn.axis]: receipt.source,
              },
              tsHash: receipt.afterHash,
            },
      history: [
        ...state.history,
        {
          kind: "edit",
          ticket: turn.ticket,
          axis: turn.axis,
          beforeHash: turn.baseHash,
          afterHash: receipt?.afterHash ?? null,
          source: receipt?.source ?? null,
          reason: receipt?.reason ?? "",
          accepted: false,
          error: `turn interrupted: ${reason}`,
        },
      ],
    };
  }
  return state;
}

/**
 * Optimize the prepared target `request` names until every requested stop predicate holds on a
 * confirmed incumbent, a caller budget or cancellation stops it, or a prerequisite blocks it. A
 * converged run leaves the verified tuning saved; every other stop restores original.ts when safe.
 * Requires Bun. Invalid requests and failed model preflight reject before any execution.
 */
export async function runOptimizer(
  request: OptimizationRequest,
  options: {
    signal?: AbortSignal;
    models?: ModelRuntime;
    editorRung?: LadderRung;
  } = {},
): Promise<OptimizationState> {
  if (typeof Bun === "undefined") throw new Error("runOptimizer requires Bun");
  options.signal?.throwIfAborted();
  const { request: requestSchema, state: stateSchema } = schemas();
  checkRequest(request, requestSchema);
  const budget = new AbortController();
  const signal =
    options.signal === undefined
      ? budget.signal
      : AbortSignal.any([options.signal, budget.signal]);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const session = await openSession(request, {
    transpile: (code) => {
      transpiler.transformSync(code);
    },
    signal,
    halted: (runs) =>
      options.signal?.aborted
        ? { kind: "cancelled", reason: "cancelled" }
        : budget.signal.aborted
          ? {
              kind: "budget",
              reason: `time budget of ${request.timeBudgetMs} ms exhausted`,
            }
          : request.runBudget !== undefined && runs >= request.runBudget
            ? {
                kind: "budget",
                reason: `run budget of ${request.runBudget} child runs exhausted`,
              }
            : undefined,
  });
  const editorRung = options.editorRung ?? SOL;
  let models = options.models;
  if (models === undefined) {
    // Loaded on invocation: importing the library root acquires no model runtime.
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    models = await ModelRuntime.create({
      allowModelNetwork: true,
      refreshOnCreate: false,
      signal,
    });
    const refreshed = await models.refresh({ allowNetwork: true, signal });
    if (refreshed.aborted || refreshed.errors.size > 0)
      throw new AggregateError(
        [...refreshed.errors].map(
          ([provider, error]) => new Error(`${provider}: ${error.message}`),
        ),
        "model catalog refresh failed",
      );
  }
  await preflight(models, [editorRung, ...request.allowedModels], signal);

  const ctx: OptimizerContext = { session, turn: undefined };
  const ladder = uniformLadder(editorRung);
  const recorder = new JsonlRecorder({
    path: join(request.sessionDir, "optimizer.jsonl"),
    costMode: "usage",
  });
  await session.checkpoint(session.initial);
  const timer =
    request.timeBudgetMs === undefined
      ? undefined
      : setTimeout(
          () => budget.abort(new Error("time budget exhausted")),
          request.timeBudgetMs,
        );
  const failures: unknown[] = [];
  let result: unknown;
  let graph: JuncoGraph<TSchema, unknown> | undefined;
  try {
    const execution = await JuncoGraph.fromYaml<OptimizerContext>(source, {
      sourceName: "optimizer.yml",
      cwd: request.sessionDir,
      scheduler: () => roundRobin(undefined, 1),
      tracer: new DummyTracer(),
      recorder,
      ladder,
      models,
      tools: editorTools(ctx),
      createAgent: (spec) => createJuncoAgent(spec, ladder, models),
      code: {
        Init: init,
        Evaluate: evaluate,
        Feedback: feedback,
        Final: finalNode,
      },
      available: {
        // Resumes started work; otherwise needs its assignment and a staged prompt.
        Editor:
          ({ graph }) =>
          (_view, triggered) => {
            const node = graph.getNode(EDITOR);
            if (node?.status === "running") return true;
            const agent = node?.state;
            return (
              triggered &&
              agent instanceof JuncoAgent &&
              agent.status === "ready"
            );
          },
      },
      context: ctx,
      signal,
    });
    graph = execution.graph;
    // ponytail: full history rides every editor handoff; a long search can exhaust the provider's
    // context, which stops non-converged with its evidence rather than truncating or capping rounds.
    await execution.run({ signal });
    const sink = graph.result(graph.sink.id);
    if (sink._tag === "Some") result = sink.value;
  } catch (error) {
    failures.push(error);
  }
  try {
    await graph?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await recorder.close();
  } catch (error) {
    failures.push(error);
  }
  clearTimeout(timer);
  if (
    failures.length === 0 &&
    Value.Check(stateSchema, result) &&
    (result as OptimizationState).stop !== null
  )
    return result as OptimizationState;
  const latest = session.latest;
  if (latest.stop !== null && failures.length === 0) return latest;
  const stop: Stop = options.signal?.aborted
    ? { kind: "cancelled", reason: "cancelled" }
    : budget.signal.aborted
      ? {
          kind: "budget",
          reason: `time budget of ${request.timeBudgetMs} ms exhausted`,
        }
      : {
          kind: "failed",
          reason:
            failures.length === 0
              ? "the optimizer quiesced without a terminal state"
              : failures.map(message).join("; "),
        };
  if (latest.stop !== null) return latest;
  return settle(session, interrupted(latest, ctx.turn, stop.reason), stop);
}
