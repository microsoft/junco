/**
 * Shared divide-and-conquer SWE-bench workflow: topology and role prompts in ./wf.yml, deterministic nodes,
 * ladder, role strengths and graph lifecycle here. One pair serves every prepared problem; the junco-swebench
 * runner (run-workflow.ts) supplies the problem, guarded models, container-bound bash tools and the Host
 * operations below. See ./README.md.
 *
 * Topology and termination: see the ./wf.yml header.
 * Models: Lead and Planner use Sonnet 5.5/high on xhigh; Integrator uses the same model on high. CandidateA,
 * Reproduce and Verifier use Haiku 5.5/medium on med; CandidateB and Contracts use GPT-6 Luna/medium on low,
 * and Trace uses it on smol. The runner checks live availability and thinking support before acquiring agents.
 *
 * Junco runs each scheduler decision as one column and awaits all of it, so contenders that settle in the
 * same column are validated together and the gate's `any` rule consumes A's verdict before B's; a loser
 * still running when the gate decides (for example after a `yield`) is aborted and its sandboxes stopped.
 */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytes, tokens } from "dataflow-engine";
import type { AssistantMessage, TSchema } from "@earendil-works/pi-ai";
import { graph, JuncoGraph, schedules, syntax, tracer } from "junco";
import source from "./wf.yml" with { type: "text" };

export const document = syntax.parse(source);

/** The agent feeding CheckPlan owns the correction loop at its graph level. */
export function planProducer(document: syntax.JuncoDocument): string {
  const find = (level: syntax.GraphSpec): syntax.GraphSpec | undefined => {
    if (Object.hasOwn(level.nodes, "CheckPlan")) return level;
    for (const node of Object.values(level.nodes)) {
      if (node.kind !== "graph") continue;
      const found = find(node.graph);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const level = find(document.graph);
  const wires = level?.edges ?? [];
  const inputs = wires.filter((wire) => wire.to === "CheckPlan" && (wire.kind !== "message" || wire.on === "return"));
  if (
    inputs.length !== 1 || inputs[0].kind !== "message" || inputs[0].on !== "return" ||
    !wires.some((wire) => wire.from === "CheckPlan" && wire.to === inputs[0].from && wire.kind === "message" && wire.on === undefined)
  )
    throw new Error("wf.yml: CheckPlan needs one producer's return-message edge and a correction message back to that producer");
  return inputs[0].from;
}

const PLAN_PRODUCER = planProducer(document);

export type Problem = { instance_id: string; repo: string; base_commit: string; problem_statement: string };
export type Branch = "A" | "B";

/** The runner's containers, one per role, all created from the official image at one verified baseline. */
export const ROLES = [
  "canonical",
  "trace",
  "reproduce",
  "contracts",
  "candidateA",
  "candidateB",
  "acceptA",
  "acceptB",
  "acceptFinal",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * The sandbox of each bash-using agent, keyed by its root-relative path (`CandidateA`, or `Child/Worker` when
 * nested). No agent reaches an acceptance sandbox; Lead and Planner have no shell. Absent root nodes have no binding.
 */
export const SANDBOX: Readonly<Record<string, Role>> = Object.fromEntries(
  Object.entries({
    Trace: "trace",
    Reproduce: "reproduce",
    Contracts: "contracts",
    CandidateA: "candidateA",
    CandidateB: "candidateB",
    Integrator: "canonical",
    Verifier: "canonical",
  } satisfies Record<string, Role>).filter(([path]) => Object.hasOwn(document.graph.nodes, path)),
);

/** Each contender's branch root (an agent or nested-graph path) and the sandboxes that cancelling it stops. */
export const BRANCHES: Readonly<Record<Branch, { readonly agent: string; readonly sandboxes: readonly Role[] }>> = {
  A: { agent: "CandidateA", sandboxes: ["candidateA", "acceptA"] },
  B: { agent: "CandidateB", sandboxes: ["candidateB", "acceptB"] },
};

export type Exec = { readonly exit_code: number; readonly output: string };

/** What the runner supplies per problem; code nodes never touch Docker directly. */
export type Host = {
  readonly problem: Problem;
  readonly sandbox: {
    /** `command` under `bash -lc` at /testbed in the testbed environment, killed after `timeout` seconds. */
    run(role: Role, command: string, timeout: number): Promise<Exec>;
    /** Every change relative to the baseline (binary, added and deleted files); restarts a stopped container. */
    capture(role: Role): Promise<string>;
    /** `git apply --check`, then `git apply` of `patch` at /testbed. */
    apply(role: Role, patch: string): Promise<Exec>;
    /** Restores the clean baseline (reset --hard, clean -fd). */
    reset(role: Role): Promise<void>;
  };
  /** Writes `data` under the instance's artifact directory and returns the path. */
  save(name: string, data: string): string;
  /** Aborts every agent under the branch root and stops its sandboxes; returns cleanup failures and never throws. */
  cancel(branch: Branch): Promise<readonly string[]>;
};

/** Host plus the run-local tournament decision shared by the gate and the validators, and CheckPlan's accepted plan. */
export type Context = Host & { readonly race: { winner?: Branch }; acceptedPlan?: ValidatedPlan };
type Code = syntax.DeterministicNode<Context>;

const SONNET = { model: "github-copilot/claude-sonnet-5.5", thinking: "high" } as const;
const HAIKU = { model: "github-copilot/claude-haiku-5.5", thinking: "medium" } as const;
const LUNA = { model: "github-copilot/gpt-6-luna", thinking: "medium" } as const;
type OptimizerLimits = {
  memoryBytes?: number;
  tokens?: number;
  tools?: number;
  scope?: "evaluation" | "batch" | "activation";
};

// junco-profile-optimizer:start scheduler
const optimizerScheduler = (_label: string, graphPath: string) =>
  schedules.strength((_snapshot, id) => optimizerStrengthOf(syntax.nodeKey(graphPath, id)), schedules.parallel());
// junco-profile-optimizer:end scheduler
// junco-profile-optimizer:start ladder
const optimizerLadder: schedules.Ladder = { smol: LUNA, low: LUNA, med: HAIKU, high: SONNET, xhigh: SONNET };

const STRENGTHS: Readonly<Record<string, schedules.ModelStrengthName>> = {
  Lead: "xhigh",
  Planner: "xhigh",
  Integrator: "high",
  CandidateA: "med",
  Reproduce: "med",
  Verifier: "med",
  CandidateB: "low",
  Contracts: "low",
  Trace: "smol",
};
/** Root-relative role classes retain separate rungs even where their incumbent models are equal. */
const optimizerStrengthOf = (path: string): schedules.ModelStrengthName => STRENGTHS[path.split("/", 1)[0]] ?? "med";
const optimizerStrength = undefined;
// junco-profile-optimizer:end ladder
// junco-profile-optimizer:start limits
const optimizerLimits: OptimizerLimits = {};
// junco-profile-optimizer:end limits

export const ladder = optimizerLadder;
export const strengthOf = optimizerStrengthOf;
export const scheduler: syntax.BuildOptions["scheduler"] = (label, graphPath) => profile.scheduler(label, graphPath);

/** The workflow's original hard ceilings, outermost around every candidate (or undefined). */
const HARD_LIMITS: schedules.LimitOptions | undefined = undefined;
const PARAMS: Record<string, string> = {};

interface ProfileRun {
  version: 1;
  nonce: string;
  monitored: boolean;
  probes: { node: string; edgeId: string }[];
  expectedGraphHash: string | null;
  allowedModels: { model: string; thinking?: string }[];
  limitBounds: { memoryBytes?: number; tokens?: number; tools?: number };
}
const RUN_KEYS = "allowedModels,expectedGraphHash,limitBounds,monitored,nonce,probes,version";

/** Deterministic JSON: object keys sorted recursively, array order kept. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;

/** sha256 of the parsed document with object keys sorted recursively: a topology's identity. */
function hashDocument(document: syntax.JuncoDocument): string {
  return createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex");
}

export type GraphRun = { dir: string; nonce: string; expectedGraphHash: string };

/** The measurement request of `JUNCO_GRAPH_RUN_DIR`; undefined outside measurement. */
export async function readGraphRun(): Promise<GraphRun | undefined> {
  const dir = process.env.JUNCO_GRAPH_RUN_DIR;
  if (dir === undefined) return undefined;
  const request = JSON.parse(await readFile(join(dir, "request.json"), "utf8"));
  if (
    Object.keys(request).sort().join() !== "expectedGraphHash,nonce,version" ||
    request.version !== 1 ||
    typeof request.nonce !== "string" ||
    typeof request.expectedGraphHash !== "string"
  )
    throw new Error("invalid graph run request");
  return { dir, nonce: request.nonce, expectedGraphHash: request.expectedGraphHash };
}

/** The optimizer's run request under JUNCO_PROFILE_RUN_DIR; inactive, both fields undefined, otherwise. */
class OptimizerProfile {
  private constructor(
    readonly directory: string | undefined,
    readonly request: ProfileRun | undefined,
  ) {}

  static async load(directory = process.env.JUNCO_PROFILE_RUN_DIR): Promise<OptimizerProfile> {
    if (directory === undefined) return new OptimizerProfile(undefined, undefined);
    const run = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
    if (
      Object.keys(run).sort().join() !== RUN_KEYS ||
      run.version !== 1 ||
      typeof run.nonce !== "string" ||
      typeof run.monitored !== "boolean" ||
      !Array.isArray(run.probes) ||
      !Array.isArray(run.allowedModels)
    )
      throw new Error("invalid profile run request");
    return new OptimizerProfile(directory, run);
  }

  /** The parsed document's canonical SHA-256; rejects drift and an out-of-domain candidate. */
  validate(document: syntax.JuncoDocument): string {
    const graphHash = createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex");
    if (this.request?.expectedGraphHash != null && this.request.expectedGraphHash !== graphHash)
      throw new Error("the runtime graph document drifted from the baseline's");
    if (this.request !== undefined) this.#checkTuning(this.request);
    return graphHash;
  }

  /** `document` with probe: true on each requested existing numeric edge, revalidated. */
  withProbes(document: syntax.JuncoDocument): syntax.JuncoDocument {
    if (this.request === undefined) return document;
    const copy = structuredClone(document);
    for (const { node, edgeId } of this.request.probes) {
      let spec = copy.graph;
      for (const segment of node === "" ? [] : node.split("/")) {
        const wrapper = spec.nodes[segment];
        if (wrapper?.kind !== "graph") throw new Error(`probe path "${node}" names no graph node`);
        spec = wrapper.graph;
      }
      const edges = (spec.edges ?? []).filter(
        (edge) => (edge.id ?? `${edge.from}${edge.kind === "message" ? "~>" : "->"}${edge.to}`) === edgeId,
      );
      const schema = edges.length === 1 ? edges[0].schema : undefined;
      const type = schema !== null && typeof schema === "object" && "type" in schema ? schema.type : undefined;
      if (type !== "number" && type !== "integer")
        throw new Error(`probe "${node}" / "${edgeId}" is not exactly one existing numeric edge`);
      edges[0].probe = true;
    }
    return syntax.parse(copy);
  }

  /** A fresh candidate policy: tuned scheduler, optional strength, extra limits, hard limits outermost. */
  scheduler(label: string, graphPath: string) {
    // Candidates may still ignore graphPath; the build passes both arguments.
    const factory: syntax.BuildOptions["scheduler"] = optimizerScheduler;
    let policy = factory(label, graphPath);
    if (optimizerStrength !== undefined) policy = schedules.strength(optimizerStrength, policy);
    const { memoryBytes, tokens: tokenCap, tools, scope } = optimizerLimits;
    if (memoryBytes !== undefined || tokenCap !== undefined || tools !== undefined)
      policy = schedules.limit(
        {
          ...(memoryBytes === undefined ? {} : { memory: bytes(memoryBytes) }),
          ...(tokenCap === undefined ? {} : { tokens: tokens(tokenCap) }),
          ...(tools === undefined ? {} : { tools }),
          ...(scope === undefined ? {} : { scope }),
        },
        policy,
      );
    return HARD_LIMITS === undefined ? policy : schedules.limit(HARD_LIMITS, policy);
  }

  /** This run's profile recorder; undefined when inactive. Pass "usage" for request-level USD. */
  createRecorder(costMode: "activation" | "usage" = "activation"): tracer.JsonlRecorder | undefined {
    if (this.directory === undefined || this.request === undefined) return undefined;
    return new tracer.JsonlRecorder({
      path: join(this.directory, "samples.jsonl"),
      monitored: this.request.monitored,
      costMode,
    });
  }

  /** Publish the completion receipt: only after the terminal check and every close succeeded. */
  async complete(graphHash: string, resourceEvents: number, metrics?: Readonly<Record<string, number>>): Promise<void> {
    if (this.directory === undefined || this.request === undefined) return;
    const receipt = join(this.directory, "completion.json");
    await writeFile(
      `${receipt}.tmp`,
      JSON.stringify({ version: 1, nonce: this.request.nonce, terminal: true, graphHash, resourceEvents, ...(metrics === undefined ? {} : { metrics }) }),
      { flag: "wx" },
    );
    await rename(`${receipt}.tmp`, receipt);
  }

  /** The candidate's concrete ladder and extra limits stay inside the run's authorized domain. */
  #checkTuning(run: ProfileRun): void {
    for (const [name, rung] of Object.entries(optimizerLadder ?? {}))
      if (!run.allowedModels.some((allowed) => allowed.model === rung.model && allowed.thinking === rung.thinking))
        throw new Error(`ladder rung ${name} uses unauthorized ${rung.model}`);
    const bounds: Record<string, number | undefined> = {
      memoryBytes: run.limitBounds.memoryBytes,
      tokens: run.limitBounds.tokens,
      tools: run.limitBounds.tools,
    };
    for (const [key, value] of Object.entries(optimizerLimits)) {
      if (key === "scope") {
        if (!["evaluation", "batch", "activation"].includes(String(value))) throw new Error(`invalid limit scope ${value}`);
        continue;
      }
      if (!Object.hasOwn(bounds, key)) throw new Error(`unknown limit ${key}`);
      const bound = bounds[key];
      if (
        typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
        (key === "tools" && !Number.isInteger(value)) || (bound !== undefined && value > bound)
      )
        throw new Error(`limit ${key}=${value} is outside its bound ${bound}`);
    }
  }
}

const profile = await OptimizerProfile.load();
const graphRun = await readGraphRun();
if (profile.request !== undefined && graphRun !== undefined)
  throw new Error("JUNCO_PROFILE_RUN_DIR and JUNCO_GRAPH_RUN_DIR are both set");
export const graphHash = profile.validate(document);
if (graphRun !== undefined && graphRun.expectedGraphHash !== graphHash)
  throw new Error("the candidate graph differs from its run request");
export const profileRun = profile.request !== undefined
  ? { nonce: profile.request.nonce }
  : graphRun !== undefined ? { nonce: graphRun.nonce } : undefined;

const runDocument = profile.withProbes(document);
/** Seconds each acceptance check may run before it is killed (and counts as failed). */
export const CHECK_TIMEOUT = 900;
/** What a reproduction check prints while the bug is present; an import error never contains it. */
export const REPRODUCED = "ISSUE REPRODUCED";

export type Check = { readonly kind: "reproduction" | "regression"; readonly name: string; readonly command: string };
type Observed = Check & {
  readonly exit_code: number;
  readonly reproduced: boolean;
  readonly log: string;
  readonly tail: string;
};
export type Verdict = { branch: Branch; valid: boolean; reason: string; patch: string; checks: Observed[] };
type Selection = { winner: Branch; verdicts: Verdict[]; cleanup: string[]; degraded?: string };
type Plan = {
  root_cause: string;
  interfaces: string[];
  behavior_matrix: string[];
  checks: Check[];
  candidates: Record<Branch, { approach: string; steps: { target: string; change: string; check: string }[] }>;
};
type ValidatedPlan = {
  answer: string;
  plan: Plan;
  checks: Check[];
  baseline: Observed[];
  kept: Observed[];
  excluded: { name: string; reason: string }[];
  degraded?: string;
};
type PlanDecision = { accepted: true; value: ValidatedPlan } | { accepted: false; feedback: string; partial?: ValidatedPlan };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const prompt = (text: string, spec: string) => graph.nodes.Task.create({ kind: "prompt", text, spec });
const tail = (text: string, size = 4000): string => (text.length <= size ? text : `…${text.slice(-size)}`);
const fence = (lang: string, body: string): string => `\`\`\`\`${lang}\n${body}${body.endsWith("\n") ? "" : "\n"}\`\`\`\``;
const other = (branch: Branch): Branch => (branch === "A" ? "B" : "A");

function edge(edges: ReadonlyMap<string, graph.Edge<TSchema, unknown>>, id: string): graph.Edge<TSchema, unknown> {
  const found = edges.get(id);
  if (found === undefined) throw new Error(`wf.yml declares no edge ${id}`);
  return found;
}

/** The one payload delivered on message edge `id`; zero or several is a protocol violation. */
function single(view: graph.ParentView<TSchema, unknown>, id: string): unknown {
  const batch = view.messages.get(graph.EdgeId.create(id)) ?? [];
  if (batch.length !== 1) throw new Error(`expected exactly one message on ${id}, got ${batch.length}`);
  return batch[0];
}

const value = (view: graph.ParentView<TSchema, unknown>, id: string): unknown => view.values.get(graph.EdgeId.create(id));

/** A code node's terminal report in the assistant-message form the sink and finalText accept. */
function reply(text: string): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "junco-code",
    provider: "junco",
    model: "Finish",
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Runs `checks` in `role` one by one, saving each full output; never throws for a failing check. */
async function runChecks(
  host: Host, role: Role, checks: readonly Check[], label: string,
  run = (command: string) => host.sandbox.run(role, command, CHECK_TIMEOUT),
): Promise<Observed[]> {
  const observed: Observed[] = [];
  for (const [index, check] of checks.entries()) {
    const { exit_code, output } = await run(check.command);
    const log = host.save(`checks/${label}/${index + 1}-${check.kind}.log`, `$ ${check.command}\n${output}\n[exit ${exit_code}]\n`);
    const { kind, name, command } = check;
    observed.push({ kind, name, command, exit_code, reproduced: output.includes(REPRODUCED), log, tail: tail(output) });
  }
  return observed;
}

const results = (observed: readonly Observed[]): string =>
  observed
    .map((c) => `- [${c.kind}] ${c.name}: exit ${c.exit_code}${c.reproduced ? ` (printed ${REPRODUCED})` : ""}`)
    .join("\n");

const text = (value: unknown, at: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`plan: ${at} must be a non-empty string`);
  return value;
};
const record = (value: unknown, at: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`plan: ${at} must be an object`);
  return value as Record<string, unknown>;
};
function list<T>(value: unknown, at: string, item: (entry: unknown, at: string) => T): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`plan: ${at} must be a non-empty array`);
  return value.map((entry, index) => item(entry, `${at}[${index}]`));
}

/** The Planner's single ```json plan, checked field by field; any deviation rejects the plan. */
function parsePlan(answer: string): Plan {
  const blocks = [...answer.matchAll(/```json[ \t]*\n([\s\S]*?)\n```/g)];
  const last = blocks.at(-1);
  if (last === undefined) throw new Error("plan: the Planner returned no ```json block");
  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1]);
  } catch (error) {
    throw new Error(`plan: invalid JSON: ${describe(error)}`);
  }
  const plan = record(parsed, "plan");
  const candidates = record(plan.candidates, "candidates");
  const candidate = (branch: Branch) => {
    const entry = record(candidates[branch], `candidates.${branch}`);
    return {
      approach: text(entry.approach, `candidates.${branch}.approach`),
      steps: list(entry.steps, `candidates.${branch}.steps`, (step, at) => {
        const s = record(step, at);
        return { target: text(s.target, `${at}.target`), change: text(s.change, `${at}.change`), check: text(s.check, `${at}.check`) };
      }),
    };
  };
  return {
    root_cause: text(plan.root_cause, "root_cause"),
    interfaces: list(plan.interfaces, "interfaces", text),
    behavior_matrix: list(plan.behavior_matrix, "behavior_matrix", text),
    checks: list(plan.checks, "checks", (entry, at): Check => {
      const c = record(entry, at);
      if (c.kind !== "reproduction" && c.kind !== "regression") throw new Error(`plan: ${at}.kind must be reproduction or regression`);
      return { kind: c.kind, name: text(c.name, `${at}.name`), command: text(c.command, `${at}.command`) };
    }),
    candidates: { A: candidate("A"), B: candidate("B") },
  };
}

function briefing(problem: Problem, evidence: string, plan: Plan, baseline: readonly Observed[]): string {
  return [
    `# Issue (${problem.repo}, base commit ${problem.base_commit})`,
    problem.problem_statement,
    "# Evidence from the investigation team",
    evidence,
    "# Plan",
    `Root cause: ${plan.root_cause}`,
    `Interfaces to preserve:\n${plan.interfaces.map((i) => `- ${i}`).join("\n")}`,
    `Behaviour matrix:\n${plan.behavior_matrix.map((m) => `- ${m}`).join("\n")}`,
    "# Acceptance checks (frozen; each runs as `bash -lc` from /testbed in a pristine copy of the baseline and must exit 0 after the fix)",
    baseline
      .map(
        (c, i) =>
          `${i + 1}. [${c.kind}] ${c.name}; baseline: exit ${c.exit_code}${c.reproduced ? ` with ${REPRODUCED}` : ""}\n${fence("bash", c.command)}`,
      )
      .join("\n\n"),
  ].join("\n\n");
}

const issueText = ({ repo, base_commit, problem_statement }: Problem): string =>
  `Repository: ${repo} (base commit ${base_commit})\n\n${problem_statement}`;

/** Publishes the problem once to every wired recipient (no instance ID: it would invite recall of published fixes). */
export const Input: Code = ({ context, edges, policy }) => {
  const outputs = [...edges].filter(([id, wire]) => id.startsWith("Input~>") && wire.transport._tag === "Left").map(([, wire]) => wire);
  if (!outputs.length) throw new Error("wf.yml: Input needs at least one message out-edge");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* (signal) {
    signal.throwIfAborted();
    const issue = prompt(issueText(context.problem), "The lead's investigation plan assigns every worker a section.");
    return new graph.FinalMessages(outputs.map((output) => graph.Message.create(output, issue)));
  }, policy);
};

const WORKERS = ["Trace", "Reproduce", "Contracts"] as const;
type Worker = (typeof WORKERS)[number];

/** The Lead's `## Trace` / `## Reproduce` / `## Contracts` sections: each exactly once and non-empty. */
function parseAssignments(answer: string): Record<Worker, string> {
  const heading = /^##[ \t]+(\S+)[ \t]*$/gm;
  const marks = [...answer.matchAll(heading)].filter((m) => (WORKERS as readonly string[]).includes(m[1]));
  const sections = {} as Record<Worker, string>;
  for (const [index, mark] of marks.entries()) {
    const worker = mark[1] as Worker;
    if (worker in sections) throw new Error(`Lead wrote the ${worker} assignment twice`);
    const end = marks[index + 1]?.index ?? answer.length;
    sections[worker] = answer.slice((mark.index ?? 0) + mark[0].length, end).trim();
  }
  for (const worker of WORKERS)
    if (!sections[worker]) throw new Error(`Lead wrote no ${worker} assignment (expected a "## ${worker}" section)`);
  return sections;
}

/** Sends each evidence worker the issue and only its own assignment, once. */
export const Assign: Code = ({ context, edges, policy }) => {
  const outputs = WORKERS.map((worker) => [worker, edge(edges, `Assign~>${worker}`)] as const);
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const answer = syntax.finalText(value(view, "Lead->Assign"), "Lead");
    context.save("assignments.md", answer);
    const sections = parseAssignments(answer);
    const issue = issueText(context.problem);
    return new graph.FinalMessages(outputs.map(([worker, output]) =>
      graph.Message.create(output, prompt(`<issue>\n${issue}\n</issue>\n\n# Your assignment from the lead\n\n${sections[worker]}`, "An investigator report answering this assignment with evidence.")),
    ));
  }, policy);
};

/** A normal, non-empty final report from every evidence worker, forwarded once. */
export const JoinEvidence: Code = ({ context, edges, policy }) => {
  const planner = edge(edges, "JoinEvidence~>Planner");
  const dispatch = edge(edges, "JoinEvidence~>Dispatch");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const evidence = WORKERS.map((worker) => `## ${worker} report\n\n${syntax.finalText(value(view, `${worker}->JoinEvidence`), worker)}`).join(
      "\n\n",
    );
    context.save("evidence.md", evidence);
    return new graph.FinalMessages([
      graph.Message.create(planner, prompt(`<issue>\n${issueText(context.problem)}\n</issue>\n\n# Evidence from the investigation team\n\n${evidence}`, "A fix plan grounded in the evidence.")),
      graph.Message.create(dispatch, prompt(evidence, "The evidence is dispatched to the candidates.")),
    ]);
  }, policy);
};

/** Joins independent normal drafts in edge-id order and forwards them once to the plan producer. */
export const JoinDrafts: Code = ({ context, edges, policy }) => {
  const inputs = [...edges].filter(([id, wire]) => /^(.+)->JoinDrafts$/.test(id) && wire.transport._tag === "Right").map(([id]) => id).sort();
  const outputs = [...edges].filter(([id, wire]) => /^JoinDrafts~>.+$/.test(id) && wire.transport._tag === "Left").map(([, wire]) => wire);
  if (inputs.length < 2) throw new Error("wf.yml: JoinDrafts needs at least two value in-edges");
  if (outputs.length !== 1) throw new Error("wf.yml: JoinDrafts needs exactly one message out-edge");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const drafts = inputs.map((id, index) => {
      const producer = id.slice(0, -"->JoinDrafts".length);
      return `# Plan ${index + 1} (${producer})\n\n${syntax.finalText(value(view, id), producer)}`;
    }).join("\n\n");
    context.save("planning/drafts.md", drafts);
    return new graph.FinalMessages([graph.Message.create(outputs[0], prompt(drafts, "One merged fix plan chosen from the drafts."))]);
  }, policy);
};

/** Planner corrections after its first draft; a fourth parsed draft keeps the surviving checks. */
const MAX_PLAN_CORRECTIONS = 3;

/**
 * Parses one complete Planner draft and runs each check alone on the clean canonical baseline, resetting after
 * every check so none sees another's writes. Only reproductions that fail while printing REPRODUCED and
 * regressions that pass are kept; at least one of each is required. A malformed plan or a missing kind is a
 * rejection with feedback for the next draft; a sandbox, cancellation or artifact failure throws.
 */
async function validatePlan(host: Host, answer: string, attempt: number, signal: AbortSignal): Promise<PlanDecision> {
  const dir = `planning/attempt-${attempt}`;
  host.save(`${dir}/plan.md`, answer);
  let plan: Plan;
  try {
    plan = parsePlan(answer);
  } catch (error) {
    const feedback = describe(error);
    host.save(`${dir}/rejection.txt`, feedback);
    return { accepted: false, feedback };
  }
  const { sandbox } = host;
  if ((await sandbox.capture("canonical")) !== "") throw new Error("canonical /testbed changed before plan validation");
  const baseline: Observed[] = [];
  for (const [index, check] of plan.checks.entries()) {
    signal.throwIfAborted();
    let observed: Observed[] = [];
    let failure: { error: unknown } | undefined;
    try {
      observed = await runChecks(host, "canonical", [check], `${dir}/check-${index + 1}`);
    } catch (error) {
      failure = { error };
    }
    try {
      await sandbox.reset("canonical"); // a check may write into /testbed
    } catch (error) {
      throw failure === undefined ? error : new AggregateError([failure.error, error], `plan check ${check.name} and the canonical reset both failed`);
    }
    if (failure !== undefined) throw failure.error;
    signal.throwIfAborted();
    if ((await sandbox.capture("canonical")) !== "") throw new Error(`canonical /testbed is not clean after plan check ${check.name}`);
    baseline.push(...observed);
  }
  const kept: Observed[] = [];
  const excluded: { name: string; reason: string }[] = [];
  const details: string[] = [];
  for (const c of baseline) {
    if (c.kind === "reproduction" ? c.exit_code !== 0 && c.reproduced : c.exit_code === 0) kept.push(c);
    else {
      const reason =
        c.kind === "reproduction"
          ? `did not reproduce on the baseline (exit ${c.exit_code}, ${c.reproduced ? "" : "no "}${REPRODUCED})`
          : `fails on the baseline (exit ${c.exit_code})`;
      excluded.push({ name: c.name, reason });
      details.push(`- [${c.kind}] ${c.name}: ${reason}\n${fence("bash", c.command)}\nOutput (tail):\n${fence("text", c.tail)}`);
    }
  }
  const checks: Check[] = kept.map(({ kind, name, command }) => ({ kind, name, command }));
  host.save(`${dir}/acceptance.json`, JSON.stringify({ checks, baseline, excluded }, null, 2));
  const missing = (["reproduction", "regression"] as const).filter((kind) => !checks.some((c) => c.kind === kind));
  if (!missing.length) return { accepted: true, value: { answer, plan, checks, baseline, kept, excluded } };
  const feedback = [
    `No ${missing.join(" and no ")} check survived the baseline run.`,
    details.length ? `Excluded on the baseline:\n${details.join("\n\n")}` : `The plan has no ${missing.join(" or ")} check.`,
  ].join("\n\n");
  host.save(`${dir}/rejection.txt`, feedback);
  return { accepted: false, feedback, partial: { answer, plan, checks, baseline, kept, excluded } };
}

/**
 * Validates each new producer result once, in order. Accepted: records the plan for Dispatch and returns that exact
 * result, the only one Planner's sink publishes. Rejected: sends the observed failure to the same producer;
 * after three corrections a parsed draft degrades to its surviving checks, while malformed data still fails.
 */
export const CheckPlan: Code = ({ context, edges, policy, signal }) => {
  const correction = edge(edges, `CheckPlan~>${PLAN_PRODUCER}`);
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* (own) {
    const stop = signal === undefined ? own : AbortSignal.any([own, signal]);
    let view = yield [];
    for (let attempt = 1; ; attempt++) {
      const draft = single(view, `${PLAN_PRODUCER}~>CheckPlan`);
      const decision = await validatePlan(context, syntax.finalText(draft, `Planner/${PLAN_PRODUCER}`), attempt, stop);
      if (decision.accepted) {
        context.acceptedPlan = decision.value;
        return draft;
      }
      if (attempt > MAX_PLAN_CORRECTIONS) {
        if (decision.partial === undefined)
          throw new Error(`plan rejected after ${MAX_PLAN_CORRECTIONS} correction turns: ${decision.feedback}`);
        context.acceptedPlan = { ...decision.partial, degraded: decision.feedback };
        context.save("planning/degraded.txt", decision.feedback);
        return draft;
      }
      stop.throwIfAborted();
      view = yield [graph.Message.create(correction, { attempt, feedback: decision.feedback })];
    }
  }, policy);
};

/**
 * Dispatches the plan CheckPlan accepted: Planner's answer must be that plan and canonical still clean. Saves the
 * frozen checks and sends both candidates, validators and Apply their inputs once.
 */
export const Dispatch: Code = ({ context, edges, policy }) => {
  const candidates = { A: edge(edges, "Dispatch~>CandidateA"), B: edge(edges, "Dispatch~>CandidateB") };
  const validators = { A: edge(edges, "Dispatch~>ValidateA"), B: edge(edges, "Dispatch~>ValidateB") };
  const apply = edge(edges, "Dispatch~>Apply");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const evidenceTask = single(view, "JoinEvidence~>Dispatch");
    if (!evidenceTask || typeof evidenceTask !== "object" || !("text" in evidenceTask) || typeof evidenceTask.text !== "string")
      throw new Error("JoinEvidence~>Dispatch did not deliver evidence text");
    const evidence = evidenceTask.text;
    const answer = syntax.finalText(value(view, "Planner->Dispatch"), "Planner");
    const accepted = context.acceptedPlan;
    if (accepted === undefined || accepted.answer !== answer) throw new Error("Planner->Dispatch is not the plan CheckPlan accepted");
    if ((await context.sandbox.capture("canonical")) !== "") throw new Error("canonical /testbed changed before dispatch");
    const { plan, checks, baseline, kept, excluded } = accepted;
    context.save("plan.md", answer);
    context.save("acceptance.json", JSON.stringify({ checks, baseline, excluded }, null, 2));
    const brief = briefing(context.problem, evidence, plan, kept) + (accepted.degraded === undefined ? "" :
      `\n\n# Degraded plan\nThe automatic baseline run rejected the last draft; the checks below are the ones that survived (possibly none of one kind). Rejection:\n${accepted.degraded}`);
    const assignment = (branch: Branch) => {
      const { approach, steps } = plan.candidates[branch];
      const ordered = steps.map((s, i) => `${i + 1}. ${s.target}: ${s.change}\n   Check: ${s.check}`).join("\n");
      return `${brief}\n\n# Your assignment: candidate ${branch}\nApproach: ${approach}\n\nSteps:\n${ordered}`;
    };
    return new graph.FinalMessages([
      graph.Message.create(candidates.A, prompt(assignment("A"), "Candidate A's patch is applied in its sandbox and passes its checks.")),
      graph.Message.create(candidates.B, prompt(assignment("B"), "Candidate B's patch is applied in its sandbox and passes its checks.")),
      graph.Message.create(validators.A, { checks }),
      graph.Message.create(validators.B, { checks }),
      graph.Message.create(apply, { brief, checks }),
    ]);
  }, policy);
};

/** A typed verdict on one contender: abnormal settlement, empty or inapplicable patch and failed checks are invalid. */
export async function judge(host: Context, branch: Branch, settled: unknown, checks: readonly Check[]): Promise<Verdict> {
  const invalid = (reason: string, patch = "", observed: Observed[] = []): Verdict => ({ branch, valid: false, reason, patch, checks: observed });
  try {
    syntax.finalText(settled, `Candidate${branch}`);
  } catch (error) {
    return invalid(describe(error));
  }
  // The gate may cancel this branch while an operation is in flight. Never start its next operation.
  const lost = () => host.race.winner === other(branch);
  const cancelled = Symbol();
  const inSandbox = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (!lost()) {
      try {
        const result = await operation();
        if (!lost()) return result;
      } catch (error) {
        if (!lost()) throw error;
      }
    }
    throw cancelled;
  };
  try {
    const patch = await inSandbox(() => host.sandbox.capture(`candidate${branch}`));
    host.save(`candidate${branch}.patch`, patch);
    if (!patch.trim()) return invalid("empty patch: no change relative to the baseline");
    const role = `accept${branch}` as const;
    const applied = await inSandbox(() => host.sandbox.apply(role, patch));
    if (applied.exit_code !== 0) return invalid(`patch does not apply to the verified baseline: ${tail(applied.output, 1000)}`, patch);
    const observed = await runChecks(host, role, checks, `candidate${branch}`,
      (command) => inSandbox(() => host.sandbox.run(role, command, CHECK_TIMEOUT)));
    const failed = observed.filter((c) => c.exit_code !== 0);
    if (failed.length) return invalid(`failed acceptance checks: ${failed.map((c) => `${c.name} (exit ${c.exit_code})`).join(", ")}`, patch, observed);
    return { branch, valid: true, reason: `all ${observed.length} acceptance checks passed`, patch, checks: observed };
  } catch (error) {
    if (error === cancelled) return invalid(`cancelled after candidate ${other(branch)} won`);
    throw error;
  }
}

const validator =
  (branch: Branch): Code =>
  ({ context, edges, policy }) => {
    const output = edge(edges, `Validate${branch}~>TournamentGate`);
    return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      // The gate stops the loser's sandboxes before this validator may get its turn.
      if (context.race.winner === other(branch)) return new graph.FinalMessages([]);
      const { checks } = single(view, `Dispatch~>Validate${branch}`) as { checks: Check[] };
      const verdict = await judge(context, branch, value(view, `Candidate${branch}->Validate${branch}`), checks);
      if (context.race.winner === other(branch)) return new graph.FinalMessages([]);
      const { patch: _patch, ...summary } = verdict;
      context.save(`verdict-${branch}.json`, JSON.stringify(summary, null, 2));
      return new graph.FinalMessages([graph.Message.create(output, verdict)]);
    }, policy);
  };
export const ValidateA = validator("A");
export const ValidateB = validator("B");

/**
 * `any` over both verdict routes: Junco hands it one route per activation, in rule order, so the first
 * valid verdict consumed wins exactly once. The winner is recorded before the loser is cancelled.
 */
export const TournamentGate: Code = ({ context, edges, policy }) => {
  const output = edge(edges, "TournamentGate~>Apply");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const verdicts = new Map<Branch, Verdict>();
    let view = yield [];
    while (true) {
      for (const branch of ["A", "B"] as const)
        for (const payload of view.messages.get(graph.EdgeId.create(`Validate${branch}~>TournamentGate`)) ?? []) {
          if (verdicts.has(branch)) throw new Error(`duplicate verdict from candidate ${branch}`);
          verdicts.set(branch, payload as Verdict);
        }
      const summary = () => [...verdicts.values()].map(({ patch: _patch, ...v }) => v);
      let chosen = [...verdicts.values()].find((v) => v.valid);
      if (chosen === undefined && verdicts.size === 2)
        chosen = [...verdicts.values()].filter((v) => v.checks.length > 0).sort((a, b) =>
          a.checks.filter((c) => c.exit_code !== 0).length - b.checks.filter((c) => c.exit_code !== 0).length || a.branch.localeCompare(b.branch))[0];
      if (chosen !== undefined) {
        const winner = chosen.branch;
        const degraded = chosen.valid ? undefined : chosen.reason;
        context.race.winner = winner;
        const cleanup = [...(await context.cancel(other(winner)))];
        context.save("tournament.json", JSON.stringify({ winner, verdicts: summary(), cleanup, degraded }, null, 2));
        const selection: Selection = { winner, verdicts: [...verdicts.values()], cleanup, degraded };
        return new graph.FinalMessages([graph.Message.create(output, selection)]);
      }
      if (verdicts.size === 2) {
        context.save("tournament.json", JSON.stringify({ winner: null, verdicts: summary(), cleanup: [] }, null, 2));
        throw new Error(`no valid candidate: ${[...verdicts.values()].map((v) => `${v.branch}: ${v.reason}`).join("; ")}`);
      }
      view = yield [];
    }
  }, policy);
};

/** Applies the selected patch to the untouched canonical /testbed and briefs the Integrator. */
export const Apply: Code = ({ context, edges, policy }) => {
  const integrator = edges.get("Apply~>Integrator");
  const freeze = edge(edges, "Apply~>Freeze");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const selection = single(view, "TournamentGate~>Apply") as Selection;
    const { brief, checks } = single(view, "Dispatch~>Apply") as { brief: string; checks: Check[] };
    const chosen = selection.verdicts.find((v) => v.branch === selection.winner);
    if (chosen === undefined) throw new Error(`selection carries no verdict for candidate ${selection.winner}`);
    if ((await context.sandbox.capture("canonical")) !== "") throw new Error("canonical /testbed is not at the baseline before apply");
    const applied = await context.sandbox.apply("canonical", chosen.patch);
    if (applied.exit_code !== 0) throw new Error(`selected patch does not apply to canonical /testbed: ${tail(applied.output, 2000)}`);
    context.save("selected.patch", chosen.patch);
    const loser = other(chosen.branch);
    const rejected =
      selection.verdicts.find((v) => v.branch === loser)?.reason ??
      "not considered: the gate selected the first valid verdict before consuming this candidate's";
    const summary = [
      `Selected: candidate ${chosen.branch} (${chosen.reason}); candidate ${loser}: ${rejected}`,
      `Cleanup: ${selection.cleanup.length ? selection.cleanup.join("; ") : "none"}`,
    ].join("\n");
    const body = [
      brief,
      `# Selected patch: candidate ${chosen.branch} (already applied to /testbed)`,
      fence("diff", chosen.patch),
      "# Acceptance results of the selected patch (pristine sandbox)",
      results(chosen.checks),
      ...(selection.degraded === undefined ? [] : ["# Selected patch failed acceptance checks", `${chosen.checks.filter((c) => c.exit_code !== 0).map((c) => `${c.name} (exit ${c.exit_code})`).join("; ")}; resolve them.`]),
      "# Rejected candidate",
      `Candidate ${loser}: ${rejected}`,
    ].join("\n\n");
    return new graph.FinalMessages([
      ...(integrator === undefined ? [] : [graph.Message.create(integrator, prompt(body, "The winning patch is integrated into canonical /testbed and its checks pass."))]),
      graph.Message.create(freeze, { brief, checks, summary }),
    ]);
  }, policy);
};

/** Captures the integrated deliverable once, before verification, so Finish can prove it unchanged. */
export const Freeze: Code = ({ context, edges, policy }) => {
  const verifier = edges.get("Freeze~>Verifier");
  const finish = edge(edges, "Freeze~>Finish");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const report = edges.has("Integrator->Freeze") ? syntax.finalText(value(view, "Integrator->Freeze"), "Integrator") : "(no integrator)";
    if (edges.has("Integrator->Freeze")) context.save("integrator.md", report);
    const { brief, checks, summary } = single(view, "Apply~>Freeze") as { brief: string; checks: Check[]; summary: string };
    const patch = await context.sandbox.capture("canonical");
    if (!patch.trim()) throw new Error("the Integrator left no change in canonical /testbed");
    context.save("integrated.patch", patch);
    return new graph.FinalMessages([
      ...(verifier === undefined ? [] : [graph.Message.create(
        verifier,
        prompt(
          [
            brief,
            "# Integrator report",
            report,
            "# Final diff (canonical /testbed; `git diff HEAD` shows it, the changes are staged)",
            fence("diff", patch),
          ].join("\n\n"),
          "A verdict on whether the final diff fixes the issue.",
        ),
      )]),
      graph.Message.create(finish, { patch, checks, summary }),
    ]);
  }, policy);
};

/**
 * Requires the wired Verifier's normal `VERDICT: PASS`, an unchanged deliverable and every frozen check passing
 * on the final patch in the pristine final sandbox; returns the terminal report, otherwise throws every failure.
 */
export const Finish: Code = ({ context, edges, policy }) =>
  new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const verification = edges.has("Verifier->Finish") ? syntax.finalText(value(view, "Verifier->Finish"), "Verifier") : undefined;
    if (verification !== undefined) context.save("verifier.md", verification);
    const frozen = single(view, "Freeze~>Finish") as { patch: string; checks: Check[]; summary: string };
    const failures: string[] = [];
    const verdict = verification?.split("\n").at(-1)?.trim() ?? "none";
    if (verification !== undefined && verdict !== "VERDICT: PASS")
      failures.push(verdict.startsWith("VERDICT: FAIL") ? `Verifier: ${verdict}` : "Verifier did not end with a VERDICT line");
    const final = await context.sandbox.capture("canonical");
    if (final !== frozen.patch) failures.push("the deliverable changed during verification");
    const path = context.save("final.patch", final);
    let observed: Observed[] = [];
    const applied = await context.sandbox.apply("acceptFinal", final);
    if (applied.exit_code !== 0) failures.push(`final patch does not apply to the baseline: ${tail(applied.output, 1000)}`);
    else {
      observed = await runChecks(context, "acceptFinal", frozen.checks, "final");
      const failed = observed.filter((c) => c.exit_code !== 0);
      if (failed.length) failures.push(`final acceptance checks failed: ${failed.map((c) => `${c.name} (exit ${c.exit_code})`).join(", ")}`);
    }
    context.save("final-checks.json", JSON.stringify({ observed, failures }, null, 2));
    if (failures.length) throw new Error(failures.join("; "));
    const files = [...final.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    return reply(
      [
        "Final patch verified.",
        frozen.summary,
        `Verifier: ${verdict}`,
        "Final acceptance (pristine baseline + final patch):",
        results(observed),
        `Final patch: ${path} (${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")})`,
        "Limitation: acceptance checks are issue-derived by the Planner; only the official evaluation decides resolution.",
      ].join("\n"),
    );
  }, policy);

export const code = { Input, Assign, JoinEvidence, CheckPlan, JoinDrafts, Dispatch, ValidateA, ValidateB, TournamentGate, Apply, Freeze, Finish };

/** Nodes that never finished, for a run that quiesced without a terminal report. */
function unfinished(g: JuncoGraph<TSchema, unknown>): string {
  const pending: string[] = [];
  g.forEachNode((id, node) => {
    if (node.status !== "done") pending.push(`${id} (${node.status})`);
  });
  return pending.join(", ") || "none";
}

/** The runner's options; this module supplies the scheduler and code. */
export type RunOptions = Omit<syntax.FromYamlOptions<Host>, "scheduler" | "code" | "context"> & { readonly context: Host };

/** Builds and runs the workflow with the runner's ladder and returns Finish's report. */
export async function run(config: RunOptions, observe?: (graph: JuncoGraph<TSchema, unknown>) => void): Promise<string> {
  const context: Context = { ...config.context, race: {} };
  const execution = await JuncoGraph.fromYaml<Context>(runDocument, { ...config, scheduler, code, context });
  try {
    observe?.(execution.graph);
    await execution.run({ signal: config.signal });
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag !== "Some") throw new Error(`workflow stopped without a terminal report; unfinished: ${unfinished(execution.graph)}`);
    return syntax.finalText(terminal.value, "Finish");
  } finally {
    await execution.graph.close();
  }
}
