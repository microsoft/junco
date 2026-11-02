/**
 * Shared divide-and-conquer SWE-bench workflow: topology and role prompts in ./wf.yml, deterministic nodes,
 * ladder, role strengths and graph lifecycle here. One pair serves every prepared problem; the junco-swebench
 * runner (run-workflow.ts) supplies the problem, guarded models, container-bound bash tools and the Host
 * operations below. See ./README.md.
 *
 * Topology and termination: see the ./wf.yml header.
 *
 * Junco runs each scheduler decision as one column and awaits all of it, so contenders that settle in the
 * same column are validated together and the gate's `any` rule consumes A's verdict before B's; a loser
 * still running when the gate decides (for example after a `yield`) is aborted and its sandboxes stopped.
 */
import type { AssistantMessage, TSchema } from "@earendil-works/pi-ai";
import { agent, graph, JuncoGraph, MockAgent, schedules, syntax } from "junco";
import source from "./wf.yml" with { type: "text" };

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
 * nested). No agent reaches an acceptance sandbox; Lead and Planner have no shell.
 */
export const SANDBOX: Readonly<Record<string, Role>> = {
  Trace: "trace",
  Reproduce: "reproduce",
  Contracts: "contracts",
  CandidateA: "candidateA",
  CandidateB: "candidateB",
  Integrator: "canonical",
  Verifier: "canonical",
};

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

// User-requested: Opus 5.5 for Lead, Planner and Integrator; Sonnet 5 for every other agent. Verified
// 2026-10-30: both exact IDs are in ~/.pi/agent/models-store.json (anthropic-messages, 1,000,000-token
// context), Pi holds a saved github-copilot OAuth login, and GitHub's supported-models page
// (https://docs.github.com/en/copilot/reference/ai-models/supported-models) lists both. The runner checks
// live availability and thinking support before acquiring agents. getSupportedThinkingLevels: Sonnet 5
// off..max, so it keeps Pi's default (off); Opus 5.5 low..max only (no off), so its rungs think at high.
const SONNET = { model: "github-copilot/claude-sonnet-5" } as const;
const OPUS = { model: "github-copilot/claude-opus-5.5", thinking: "high" } as const;
export const ladder: schedules.Ladder = { smol: SONNET, low: SONNET, med: SONNET, high: OPUS, xhigh: OPUS };

const LEADS = new Set(["Lead", "Planner", "Integrator"]);
/**
 * Each agent's rung by root-relative path: the original role is the first segment, so `Planner/Draft` keeps the
 * Planner's model. Also the model the runner creates it with, so no agent switches models mid-run.
 */
export const strengthOf = (path: string): schedules.ModelStrengthName => (LEADS.has(path.split("/", 1)[0]) ? "xhigh" : "med");
export const scheduler: syntax.BuildOptions["scheduler"] = (_label, graphPath) =>
  schedules.strength((_snapshot, id) => strengthOf(graphPath === "" ? id : `${graphPath}/${id}`), schedules.parallel());

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
type Selection = { winner: Branch; verdicts: Verdict[]; cleanup: string[] };
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
};
type PlanDecision = { accepted: true; value: ValidatedPlan } | { accepted: false; feedback: string };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const prompt = (text: string) => ({ kind: "prompt", text }) as const;
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
async function runChecks(host: Host, role: Role, checks: readonly Check[], label: string): Promise<Observed[]> {
  const observed: Observed[] = [];
  for (const [index, check] of checks.entries()) {
    const { exit_code, output } = await host.sandbox.run(role, check.command, CHECK_TIMEOUT);
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

/** Publishes the problem once to the lead (no instance ID: it would invite recall of published fixes). */
export const Input: Code = ({ context, edges, policy }) => {
  const output = edge(edges, "Input~>Lead");
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* (signal) {
      while (true) {
        signal.throwIfAborted();
        published = true;
        yield [graph.Message.create(output, prompt(issueText(context.problem)))];
      }
    }, policy),
    is_available: () => !published,
  };
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
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const answer = syntax.finalText(value(view, "Lead->Assign"), "Lead");
      context.save("assignments.md", answer);
      const sections = parseAssignments(answer);
      const issue = issueText(context.problem);
      published = true;
      yield outputs.map(([worker, output]) =>
        graph.Message.create(output, prompt(`<issue>\n${issue}\n</issue>\n\n# Your assignment from the lead\n\n${sections[worker]}`)),
      );
    }, policy),
    is_available: (_view, triggered) => triggered && !published,
  };
};

/** A normal, non-empty final report from every evidence worker, forwarded once. */
export const JoinEvidence: Code = ({ context, edges, policy }) => {
  const planner = edge(edges, "JoinEvidence~>Planner");
  const dispatch = edge(edges, "JoinEvidence~>Dispatch");
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const evidence = WORKERS.map((worker) => `## ${worker} report\n\n${syntax.finalText(value(view, `${worker}->JoinEvidence`), worker)}`).join(
        "\n\n",
      );
      context.save("evidence.md", evidence);
      published = true;
      yield [
        graph.Message.create(planner, prompt(`<issue>\n${issueText(context.problem)}\n</issue>\n\n# Evidence from the investigation team\n\n${evidence}`)),
        graph.Message.create(dispatch, prompt(evidence)),
      ];
    }, policy),
    is_available: (_view, triggered) => triggered && !published,
  };
};

/** Planner corrections after its first draft; a fourth rejected draft fails the run. */
const MAX_PLAN_CORRECTIONS = 3;
const DRAFT = graph.NodeId.create("Draft");
const DRAFT_RESULT = graph.EdgeId.create("Draft->CheckPlan");

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
  return { accepted: false, feedback };
}

/** Draft's agent, the one CheckPlan stages corrections on. */
function draftAgent(level: JuncoGraph<TSchema, unknown>): agent.JuncoAgent | MockAgent {
  const state = level.getNode(DRAFT)?.state;
  if (!(state instanceof agent.JuncoAgent || state instanceof MockAgent)) throw new TypeError("Planner/Draft must be an agent node");
  return state;
}

/**
 * Validates each new Draft result once, in order. Accepted: records the plan for Dispatch and returns that exact
 * result, the only one Planner's sink publishes. Rejected: stages a complete-plan correction on the idle Draft
 * and waits for its next result; a rejected fourth draft fails the run.
 */
export const CheckPlan: Code = ({ context, graph: level, policy, signal }) => {
  /** The latest Draft result taken for validation, recorded before it is awaited. */
  let checked: unknown;
  const current = (view: graph.ParentView<TSchema, unknown>): unknown => view.values.get(DRAFT_RESULT);
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* (own) {
      const stop = signal === undefined ? own : AbortSignal.any([own, signal]);
      let view = yield [];
      for (let attempt = 1; ; attempt++) {
        const draft = current(view);
        checked = draft;
        const decision = await validatePlan(context, syntax.finalText(draft, "Planner/Draft"), attempt, stop);
        if (decision.accepted) {
          context.acceptedPlan = decision.value;
          return draft;
        }
        if (attempt > MAX_PLAN_CORRECTIONS)
          throw new Error(`plan rejected after ${MAX_PLAN_CORRECTIONS} correction turns: ${decision.feedback}`);
        stop.throwIfAborted();
        draftAgent(level).stagePrompt(
          [
            `Correction turn ${attempt} of ${MAX_PLAN_CORRECTIONS}. The automatic baseline run rejected your plan:`,
            decision.feedback,
            "Return the complete corrected plan as one JSON object in a single ```json block with every field. Keep the checks that held and full behaviour-matrix coverage. Repair each unsupported command from the evidence (a test path, id or runner the evidence shows works); never weaken a check or the expected behaviour to make it pass. A reproduction must exit non-zero printing `ISSUE REPRODUCED` on the baseline; a regression must exit 0 on the baseline.",
          ].join("\n\n"),
        );
        view = yield [];
      }
    }, policy),
    is_available: (view, triggered) => triggered && current(view) !== undefined && current(view) !== checked,
  };
};

/**
 * Draft's gate: its Draft->Draft self-edge rearms it after every draft, but it runs again only to resume a native
 * yield or for a correction CheckPlan staged, never while CheckPlan is still validating.
 */
export const plannerAvailability: NonNullable<syntax.BuildOptions["available"]> = {
  Draft: ({ graph: level, edges }) =>
    edges.has("Draft->Draft")
      ? (_view, triggered) => level.getNode(DRAFT)?.status === "running" || (triggered && draftAgent(level).status === "ready")
      : undefined,
};

/**
 * Dispatches the plan CheckPlan accepted: Planner's answer must be that plan and canonical still clean. Saves the
 * frozen checks and sends both candidates, validators and Apply their inputs once.
 */
export const Dispatch: Code = ({ context, edges, policy }) => {
  const candidates = { A: edge(edges, "Dispatch~>CandidateA"), B: edge(edges, "Dispatch~>CandidateB") };
  const validators = { A: edge(edges, "Dispatch~>ValidateA"), B: edge(edges, "Dispatch~>ValidateB") };
  const apply = edge(edges, "Dispatch~>Apply");
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const evidence = (single(view, "JoinEvidence~>Dispatch") as { text: string }).text;
      const answer = syntax.finalText(value(view, "Planner->Dispatch"), "Planner");
      const accepted = context.acceptedPlan;
      if (accepted === undefined || accepted.answer !== answer) throw new Error("Planner->Dispatch is not the plan CheckPlan accepted");
      if ((await context.sandbox.capture("canonical")) !== "") throw new Error("canonical /testbed changed before dispatch");
      const { plan, checks, baseline, kept, excluded } = accepted;
      context.save("plan.md", answer);
      context.save("acceptance.json", JSON.stringify({ checks, baseline, excluded }, null, 2));
      const brief = briefing(context.problem, evidence, plan, kept);
      const assignment = (branch: Branch) => {
        const { approach, steps } = plan.candidates[branch];
        const ordered = steps.map((s, i) => `${i + 1}. ${s.target}: ${s.change}\n   Check: ${s.check}`).join("\n");
        return `${brief}\n\n# Your assignment: candidate ${branch}\nApproach: ${approach}\n\nSteps:\n${ordered}`;
      };
      published = true;
      yield [
        graph.Message.create(candidates.A, prompt(assignment("A"))),
        graph.Message.create(candidates.B, prompt(assignment("B"))),
        graph.Message.create(validators.A, { checks }),
        graph.Message.create(validators.B, { checks }),
        graph.Message.create(apply, { brief, checks }),
      ];
    }, policy),
    is_available: (_view, triggered) => triggered && !published,
  };
};

/** A typed verdict on one contender: abnormal settlement, empty or inapplicable patch and failed checks are invalid. */
export async function judge(host: Context, branch: Branch, settled: unknown, checks: readonly Check[]): Promise<Verdict> {
  const invalid = (reason: string, patch = "", observed: Observed[] = []): Verdict => ({ branch, valid: false, reason, patch, checks: observed });
  try {
    syntax.finalText(settled, `Candidate${branch}`);
  } catch (error) {
    return invalid(describe(error));
  }
  try {
    const patch = await host.sandbox.capture(`candidate${branch}`);
    host.save(`candidate${branch}.patch`, patch);
    if (!patch.trim()) return invalid("empty patch: no change relative to the baseline");
    const applied = await host.sandbox.apply(`accept${branch}`, patch);
    if (applied.exit_code !== 0) return invalid(`patch does not apply to the verified baseline: ${tail(applied.output, 1000)}`, patch);
    const observed = await runChecks(host, `accept${branch}`, checks, `candidate${branch}`);
    const failed = observed.filter((c) => c.exit_code !== 0);
    if (failed.length) return invalid(`failed acceptance checks: ${failed.map((c) => `${c.name} (exit ${c.exit_code})`).join(", ")}`, patch, observed);
    return { branch, valid: true, reason: `all ${observed.length} acceptance checks passed`, patch, checks: observed };
  } catch (error) {
    // Once the other branch won, this branch's sandboxes are stopped; anything else is an infrastructure fault.
    const { winner } = host.race;
    if (winner !== undefined && winner !== branch) return invalid(`cancelled after candidate ${winner} won: ${describe(error)}`);
    throw error;
  }
}

const validator =
  (branch: Branch): Code =>
  ({ context, edges, policy }) => {
    const output = edge(edges, `Validate${branch}~>TournamentGate`);
    let published = false;
    return {
      state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
        const view = yield [];
        const { checks } = single(view, `Dispatch~>Validate${branch}`) as { checks: Check[] };
        const verdict = await judge(context, branch, value(view, `Candidate${branch}->Validate${branch}`), checks);
        const { patch: _patch, ...summary } = verdict;
        context.save(`verdict-${branch}.json`, JSON.stringify(summary, null, 2));
        published = true;
        yield [graph.Message.create(output, verdict)];
      }, policy),
      // A decided tournament never validates the loser: its sandboxes are already stopped.
      is_available: (_view, triggered) => triggered && !published && context.race.winner === undefined,
    };
  };
export const ValidateA = validator("A");
export const ValidateB = validator("B");

/**
 * `any` over both verdict routes: Junco hands it one route per activation, in rule order, so the first
 * valid verdict consumed wins exactly once. The winner is recorded before the loser is cancelled.
 */
export const TournamentGate: Code = ({ context, edges, policy }) => {
  const output = edge(edges, "TournamentGate~>Apply");
  let decided = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const verdicts = new Map<Branch, Verdict>();
      let view = yield [];
      while (true) {
        for (const branch of ["A", "B"] as const)
          for (const payload of view.messages.get(graph.EdgeId.create(`Validate${branch}~>TournamentGate`)) ?? []) {
            if (verdicts.has(branch)) throw new Error(`duplicate verdict from candidate ${branch}`);
            verdicts.set(branch, payload as Verdict);
          }
        const summary = () => [...verdicts.values()].map(({ patch: _patch, ...v }) => v);
        const winner = [...verdicts.values()].find((v) => v.valid)?.branch;
        if (winner !== undefined) {
          context.race.winner = winner;
          decided = true;
          const cleanup = [...(await context.cancel(other(winner)))];
          context.save("tournament.json", JSON.stringify({ winner, verdicts: summary(), cleanup }, null, 2));
          const selection: Selection = { winner, verdicts: [...verdicts.values()], cleanup };
          yield [graph.Message.create(output, selection)];
          return;
        }
        if (verdicts.size === 2) {
          decided = true;
          context.save("tournament.json", JSON.stringify({ winner: null, verdicts: summary(), cleanup: [] }, null, 2));
          throw new Error(`no valid candidate: ${[...verdicts.values()].map((v) => `${v.branch}: ${v.reason}`).join("; ")}`);
        }
        view = yield [];
      }
    }, policy),
    is_available: (_view, triggered) => triggered && !decided,
  };
};

/** Applies the selected patch to the untouched canonical /testbed and briefs the Integrator. */
export const Apply: Code = ({ context, edges, policy }) => {
  const integrator = edge(edges, "Apply~>Integrator");
  const freeze = edge(edges, "Apply~>Freeze");
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const selection = single(view, "TournamentGate~>Apply") as Selection;
      const { brief, checks } = single(view, "Dispatch~>Apply") as { brief: string; checks: Check[] };
      const chosen = selection.verdicts.find((v) => v.branch === selection.winner && v.valid);
      if (chosen === undefined) throw new Error(`selection carries no valid verdict for candidate ${selection.winner}`);
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
        "# Rejected candidate",
        `Candidate ${loser}: ${rejected}`,
      ].join("\n\n");
      published = true;
      yield [graph.Message.create(integrator, prompt(body)), graph.Message.create(freeze, { brief, checks, summary })];
    }, policy),
    is_available: (_view, triggered) => triggered && !published,
  };
};

/** Captures the integrated deliverable once, before verification, so Finish can prove it unchanged. */
export const Freeze: Code = ({ context, edges, policy }) => {
  const verifier = edge(edges, "Freeze~>Verifier");
  const finish = edge(edges, "Freeze~>Finish");
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const report = syntax.finalText(value(view, "Integrator->Freeze"), "Integrator");
      context.save("integrator.md", report);
      const { brief, checks, summary } = single(view, "Apply~>Freeze") as { brief: string; checks: Check[]; summary: string };
      const patch = await context.sandbox.capture("canonical");
      if (!patch.trim()) throw new Error("the Integrator left no change in canonical /testbed");
      context.save("integrated.patch", patch);
      published = true;
      yield [
        graph.Message.create(
          verifier,
          prompt(
            [
              brief,
              "# Integrator report",
              report,
              "# Final diff (canonical /testbed; `git diff HEAD` shows it, the changes are staged)",
              fence("diff", patch),
            ].join("\n\n"),
          ),
        ),
        graph.Message.create(finish, { patch, checks, summary }),
      ];
    }, policy),
    is_available: (_view, triggered) => triggered && !published,
  };
};

/**
 * Requires the Verifier's normal `VERDICT: PASS`, an unchanged deliverable and every frozen check passing on
 * the final patch in the pristine final sandbox; returns the terminal report, otherwise throws every failure.
 */
export const Finish: Code = ({ context, policy }) => ({
  state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const view = yield [];
    const verification = syntax.finalText(value(view, "Verifier->Finish"), "Verifier");
    context.save("verifier.md", verification);
    const frozen = single(view, "Freeze~>Finish") as { patch: string; checks: Check[]; summary: string };
    const failures: string[] = [];
    const verdict = verification.split("\n").at(-1)?.trim() ?? "";
    if (verdict !== "VERDICT: PASS")
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
  }, policy),
});

export const document = syntax.parse(source);
export const code = { Input, Assign, JoinEvidence, CheckPlan, Dispatch, ValidateA, ValidateB, TournamentGate, Apply, Freeze, Finish };

/** Nodes that never finished, for a run that quiesced without a terminal report. */
function unfinished(g: JuncoGraph<TSchema, unknown>): string {
  const pending: string[] = [];
  g.forEachNode((id, node) => {
    if (node.status !== "done") pending.push(`${id} (${node.status})`);
  });
  return pending.join(", ") || "none";
}

/** The runner's options; this module supplies the ladder, scheduler and code itself, and adds Draft's gate to `available`. */
export type RunOptions = Omit<syntax.FromYamlOptions<Host>, "ladder" | "scheduler" | "code" | "context"> & { readonly context: Host };

/** Builds and runs the workflow with this module's ladder, scheduler, code and Draft gate; returns Finish's report. */
export async function run(config: RunOptions): Promise<string> {
  const context: Context = { ...config.context, race: {} };
  const available = { ...config.available, ...plannerAvailability };
  const execution = await JuncoGraph.fromYaml<Context>(document, { ...config, ladder, scheduler, code, context, available });
  try {
    await execution.run({ signal: config.signal });
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag !== "Some") throw new Error(`workflow stopped without a terminal report; unfinished: ${unfinished(execution.graph)}`);
    return syntax.finalText(terminal.value, "Finish");
  } finally {
    try {
      await execution.graph.close();
    } finally {
      await execution.graph.tracer.flush();
    }
  }
}
