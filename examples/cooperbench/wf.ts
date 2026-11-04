// CooperBench shared-worktree driver. Seven small-model roles share one caller-owned Marsh collection.
// Stdout contains native message/usage JSONL and a terminal result.
import { createHash, randomUUID } from "node:crypto";
import { constants, writeSync } from "node:fs";
import { type FileHandle, copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OpikTracer } from "dataflow-engine-opik";
import {
  type Agentic,
  type agent,
  AssistantMessageSchema,
  graph,
  JuncoGraph,
  schedules,
  syntax,
  tracer,
} from "junco";
import * as tools from "junco-tools";
import { redirectLog } from "junco-tools/log";
import { logger as opikLogger, Opik } from "opik";
import { type Static, type TArray, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import source from "./wf.yml" with { type: "text" };

type Edges = syntax.CodeContext["edges"];
type Available = NonNullable<syntax.BuildOptions["available"]>;
const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Locally declared edges whose IDs start with `prefix`, in YAML declaration order. */
const declared = (edges: Edges, prefix: string) =>
  [...edges].filter(([id]) => id.startsWith(prefix)).map(([, edge]) => edge);

/** The payloads one activation received on `edge`: its value, or its delivered messages. */
function delivered(
  view: graph.ParentView<TSchema, unknown>,
  edge: graph.Edge<TSchema, unknown>,
): unknown[] {
  return view.values.has(edge.id)
    ? [view.values.get(edge.id)]
    : [...(view.messages.get(edge.id) ?? [])];
}

/** A plain text prompt input, or a normally finished, non-empty assistant report; anything else throws. */
function textOf(payload: unknown, edgeId: string): string {
  if (typeof payload === "object" && payload !== null && "kind" in payload) {
    const { kind, text, images } = payload as Record<string, unknown>;
    if (
      kind !== "prompt" ||
      typeof text !== "string" ||
      !text.trim() ||
      (Array.isArray(images) && images.length > 0)
    )
      throw new TypeError(`${edgeId} carries an input that is not a non-empty text prompt`);
    return text;
  }
  return syntax.finalText(payload, edgeId);
}

/** Sends `{ kind: "prompt", text }` once on `outputs` through the standard primitive, then returns. */
function broadcast(text: string, outputs: graph.Edge<TSchema, unknown>[]) {
  return new graph.nodes.ConstFanout<undefined, TSchema, unknown>(
    { kind: "prompt", text },
    outputs,
    { state: undefined, ret: undefined },
  ).step();
}

/** `__junco_fanout`: one payload on `__junco_fanout:input`, broadcast to every `__junco_fanout:worker:*` edge. */
export const fanout: syntax.DeterministicNode = ({ node, edges, policy }) => {
  const input = edges.get("__junco_fanout:input");
  const outputs = declared(edges, "__junco_fanout:worker:");
  if (input === undefined || outputs.length === 0)
    throw new Error(`${node} needs edge "__junco_fanout:input" and "__junco_fanout:worker:*" edges`);
  let emitting = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const payloads = delivered(yield [], input);
      if (payloads.length !== 1)
        throw new Error(`${node} needs exactly one payload on "${input.id}"`);
      const text = textOf(payloads[0], input.id);
      emitting = true;
      return yield* broadcast(text, outputs);
    }, policy),
    // Priming reads nothing; stay available through the emission's terminal-return activation.
    is_available: (_view, triggered) => emitting || triggered,
  };
};

/** `__junco_fanin`: `ConstFanin` over `__junco_fanin:input:*` (declaration order) onto `__junco_fanin:output`. */
export const fanin: syntax.DeterministicNode = ({ node, edges, policy }) => {
  const inputs = declared(edges, "__junco_fanin:input:");
  const output = edges.get("__junco_fanin:output");
  if (inputs.length < 2 || output === undefined)
    throw new Error(`${node} needs two or more "__junco_fanin:input:*" edges and "__junco_fanin:output"`);
  const collector = new graph.nodes.ConstFanin<undefined, TSchema, unknown>(
    inputs,
    output as graph.Edge<TArray<TSchema>, unknown>,
    { state: undefined, ret: undefined },
  );
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      return yield* collector.step();
    }, policy),
    is_available: (view, triggered) => {
      // Every candidate is a normally finished, non-empty report before the primitive keeps it.
      for (const edge of inputs)
        for (const payload of view.messages.get(edge.id) ?? []) syntax.finalText(payload, edge.id);
      return collector.is_available(view, triggered);
    },
  };
};

/**
 * `__junco_assignment`: re-renders the replaced agent's original prompt template (frozen per
 * replacement graph label) from `__junco_assignment:input:<originalEdgeId>`, then sends it once as
 * `{ kind: "prompt", text }` on every `__junco_assignment:output*` edge.
 */
export const assignment =
  (templates: Readonly<Record<string, string>>): syntax.DeterministicNode =>
  ({ node, label, edges, policy }) => {
    if (!Object.hasOwn(templates, label))
      throw new Error(`${node}: no frozen assignment template for graph label "${label}"`);
    const template = templates[label];
    const inputs = declared(edges, "__junco_assignment:input:");
    const names = inputs.map((edge) => edge.id.slice("__junco_assignment:input:".length));
    const outputs = declared(edges, "__junco_assignment:output");
    const used = [...template.matchAll(PLACEHOLDER)].map(([, id]) => id);
    // Every original input is rendered and every placeholder has one: nothing dropped or invented.
    if (
      outputs.length === 0 ||
      used.some((id) => !names.includes(id)) ||
      names.some((id) => !used.includes(id))
    )
      throw new Error(
        `${node}: template placeholders ${JSON.stringify(used)} must match inputs ${JSON.stringify(names)}, with an output`,
      );
    let emitting = false;
    return {
      state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
        const view = yield [];
        const texts = new Map<string, string>();
        for (const [index, edge] of inputs.entries()) {
          const payloads = delivered(view, edge);
          if (payloads.length === 0)
            throw new Error(`${node}: required input "${names[index]}" is missing`);
          texts.set(names[index], payloads.map((p) => textOf(p, names[index])).join("\n\n"));
        }
        const text = template.replace(PLACEHOLDER, (_, id: string) => texts.get(id) ?? "");
        if (!text.trim()) throw new Error(`${node}: the rendered assignment is empty`);
        emitting = true;
        return yield* broadcast(text, outputs);
      }, policy),
      is_available: (_view, triggered) => emitting || triggered,
    };
  };

/** `config.code` plus the three reserved helpers; a same-named existing entry is a collision. */
export function withOptimizerCode<C>(
  existing: Readonly<Record<string, syntax.DeterministicNode<C>>> | undefined,
  templates: Readonly<Record<string, string>>,
): Record<string, syntax.DeterministicNode<C>> {
  const added = {
    __junco_fanout: fanout,
    __junco_fanin: fanin,
    __junco_assignment: assignment(templates),
  };
  for (const id of Object.keys(added))
    if (existing !== undefined && Object.hasOwn(existing, id))
      throw new Error(`config.code already defines reserved "${id}"`);
  return { ...existing, ...added };
}

/** `schedules.ralph` judged by the fixed authoritative check of each prepared `__junco_ralph_*` label. */
export function ralphUntil(
  checks: Readonly<Record<string, schedules.RalphPredicate>>,
  rounds?: number,
) {
  return schedules.ralph({
    rounds,
    until: (result, context) => {
      if (!Object.hasOwn(checks, context.label))
        throw new Error(`no authoritative Ralph check for graph label "${context.label}"`);
      return checks[context.label](result, context);
    },
  });
}

/** Existing hooks on every level; on a prepared label also `added`, conjoined with an existing gate. */
export function mergeAvailable(
  existing: Available | undefined,
  added: Available,
  prepared: ReadonlySet<string>,
): Available {
  const merged: Record<string, Available[string]> = {};
  for (const id of new Set([...Object.keys(existing ?? {}), ...Object.keys(added)]))
    merged[id] = (context) => {
      const old = existing?.[id]?.(context);
      const extra = prepared.has(context.label) ? added[id]?.(context) : undefined;
      return old && extra ? (view, triggered) => old(view, triggered) && extra(view, triggered) : (extra ?? old);
    };
  return merged;
}

/** sha256 of the parsed document with object keys sorted recursively: a topology's identity. */
export function graphHash(document: syntax.JuncoDocument): string {
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

/** Publishes the run's receipt atomically; call only after complete outcomes and successful cleanup. */
export async function writeCompletion(
  run: GraphRun,
  hash: string,
  metrics: Readonly<Record<string, number>>,
): Promise<void> {
  for (const [name, value] of Object.entries(metrics))
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new TypeError(`metric ${name} is not a finite number`);
  const receipt = join(run.dir, "completion.json");
  await writeFile(
    `${receipt}.tmp`,
    JSON.stringify({ version: 1, nonce: run.nonce, terminal: true, graphHash: hash, metrics }),
    { flag: "wx" },
  );
  await rename(`${receipt}.tmp`, receipt);
}
export const marshOptions = { sandbox: "always", policy: tools.LockPolicy } as const;

// ## Request boundary

const strict = { additionalProperties: false } as const;
const Model = Type.String({ pattern: "^[^/]+/.+$" });
const Models = Type.Object({ worker: Model, leader: Model }, strict);
/** One common Pi thinking level, validated against both models in preflight. */
const Level = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const Assignment = Type.Object(
  {
    feature_id: Type.Integer({ minimum: 1 }),
    task: Type.String({ pattern: "\\S" }),
  },
  strict,
);
const RunRequest = Type.Object(
  {
    mode: Type.Literal("run"),
    run_id: Type.String({ pattern: "^[0-9a-f]{32}$" }),
    models: Models,
    thinking: Level,
    timeout_ms: Type.Integer({ minimum: 1 }),
    /** The pair's artifact directory, including its profile log. */
    problem_dir: Type.String({ pattern: "^/" }),
    agents: Type.Object({ agent1: Assignment, agent2: Assignment }, strict),
  },
  strict,
);
const PreflightRequest = Type.Object(
  { mode: Type.Literal("preflight"), models: Models, thinking: Level },
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
  }
  return value;
}

// ## Models and documents

/** Workers on smol/low/med and leaders on high/xhigh, sharing one thinking level. */
export const ladderOf = (
  { worker, leader }: PairRequest["models"],
  thinking: PairRequest["thinking"],
): schedules.Ladder => {
  const rung = (model: string, level: Static<typeof Level>): schedules.LadderRung =>
    level === "off" ? { model } : { model, thinking: level };
  const workerRung = rung(worker, thinking);
  const leaderRung = rung(leader, thinking);
  return { smol: workerRung, low: workerRung, med: workerRung, high: leaderRung, xhigh: leaderRung };
};
/** Every graph level uses parallel selection at the uniform med rung. */
const scheduler = () => schedules.parallel();

/** The Architect receives both assignments; each feature team receives only its own. */
export const document = syntax.parse(source, {
  sourceName: "wf.yml",
  params: { assistant_schema: JSON.stringify(AssistantMessageSchema) },
});

const TEST_DIR = /\/(tests?|__tests__|spec|testdata)\//;
const TEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test\.[A-Za-z0-9]+|[^/]+\.(test|spec)\.[A-Za-z0-9]+|[^/]*Tests?\.(java|kt|cs|scala)|tests?\.py)$/;
/** Mirrors CooperBench `sandbox._is_test_path`: files the grader strips from the patch. */
export const isTestPath = (path: string): boolean => TEST_DIR.test(`/${path}`) || TEST_FILE.test(path);
/** Synchronous structural checks of a role's final report (graph-optimizer Ralph stop rules). */
// shortcut: self-reported verdict lines, upgrade to a gate script if Ralph candidates pass while failing the evaluator.
export const verdicts = {
  Architect: (text: string) =>
    ["## Interfaces", "## Ownership", "## Shared-file protocol", "## Conflicts", "## Test setup", "## Risks"].every((h) => text.includes(h)),
  Tester: (text: string) =>
    /^RED: yes$/m.test(text) && /^TEST_COMMAND: \S/m.test(text) && /^SUITE_COMMAND: \S/m.test(text) &&
    [...text.matchAll(/^- (\S+)/gm)].some(([, path]) => isTestPath(path!)),
  Implementer: (text: string) => /^TEST_COMMAND: .+ exit=0$/m.test(text) && /^SUITE_COMMAND: .+ exit=0$/m.test(text),
} satisfies Record<string, (text: string) => boolean>;

/** Original prompts frozen for eligible replacement graph labels; Agent1/Agent2 remain pinned. */
const ASSIGNMENTS: Record<string, string> = {
  __junco_opt_Architect: `You are the Architect. Two features will be implemented concurrently in this repository by two teams sharing one working tree: Team 1 implements the feature headed "Team 1", Team 2 the one headed "Team 2". You implement nothing and never edit files.

Specifications:
{{arch-specs}}

If only one specification is present above, call recv once to collect the other before planning.
Read the repository (conventions, affected modules, existing tests, how tests run — also /usr/local/bin/runner.sh if it exists) and return one plan in exactly these sections:
## Interfaces — per team: every public name the spec requires (module/package path, class, function, method, parameter, CLI flag, error type, config key) with its exact spelling and signature as the spec states or implies, and the file where it belongs. Where the spec leaves a name or shape open, choose one and state it.
## Ownership — three lists of repository paths: Team 1 only, Team 2 only, Shared (both must touch). Make a shared file unshared by moving one team's change to a new file whenever the design allows.
## Shared-file protocol — per shared path: who edits first, exactly which regions/symbols each team changes, the final combined signature of any symbol both touch, and the release handoff order.
## Conflicts — behaviours where the features interact (same function, config, default, or test module) and the combined behaviour that satisfies both specs.
## Test setup — the project's test command(s) for the affected packages and the directory/naming pattern for new test files, as observed in the repository.
## Risks — existing tests likely affected, compatibility obligations, and spec statements that are easy to miss: exact representations (counts, shapes, ordering, case), nested/recursive application, lifecycle/reset semantics, immutability of inputs, error types and messages.
Be concrete: paths, symbols, signatures. No prose outside these sections.`,
  __junco_opt_Tester1: `You are Tester1 of Team 1. Team 1 implements this feature:
{{team1-spec}}

Architect plan (both teams; follow its Interfaces, Ownership and Test setup for your team):
{{Architect->Tester1}}

Turn the specification into executable acceptance tests BEFORE the implementation exists, so the Implementer has an objective target.
1. Read the affected code and existing tests for conventions (framework, fixtures, layout, how the suite runs).
2. Write the acceptance checklist: number every testable claim in the spec AC-1, AC-2, …; quote the spec sentence, state the observable behaviour, name the exact public symbol(s). For each claim also cover: exact representation (types, shapes, counts, ordering, case, multi-value vs joined values); application to nested or repeated inputs; lifecycle and state transitions (create/use/close/reset, repeated calls, idempotence); no mutation of inputs or unrelated state (repeat the operation on the same object and assert the original is unchanged); defaults and backward compatibility of existing callers; error paths with the specified error type and message.
3. Write the tests as NEW files only, one test per AC where practical, using the names and signatures from the Interfaces section. Each new file path must satisfy the grader's test-path rule: a directory segment named tests, test, __tests__, spec or testdata, or a basename matching test_*.py, *_test.<ext>, *.test.<ext> or *.spec.<ext>. Never modify existing test files, fixtures or conftest files. Do not implement the feature.
4. Run your new tests and confirm they FAIL or error only because the feature is missing; fix collection errors caused by your own code. Run the existing suite for the affected package once to record the baseline.
5. Release every file you created with release({file}).
Return exactly:
## Checklist — the AC list.
## Interface contract — the public names/signatures your tests assume.
## Tests — one line per new test file: "- <path> — <AC ids>".
## Commands
TEST_COMMAND: <command that runs only your new tests>
SUITE_COMMAND: <command that runs the affected package's existing tests>
RED: yes|no   (yes = your tests currently fail only for the missing feature)`,
  __junco_opt_Tester2: `You are Tester2 of Team 2. Team 2 implements this feature:
{{team2-spec}}

Architect plan (both teams; follow its Interfaces, Ownership and Test setup for your team):
{{Architect->Tester2}}

Turn the specification into executable acceptance tests BEFORE the implementation exists, so the Implementer has an objective target.
1. Read the affected code and existing tests for conventions (framework, fixtures, layout, how the suite runs).
2. Write the acceptance checklist: number every testable claim in the spec AC-1, AC-2, …; quote the spec sentence, state the observable behaviour, name the exact public symbol(s). For each claim also cover: exact representation (types, shapes, counts, ordering, case, multi-value vs joined values); application to nested or repeated inputs; lifecycle and state transitions (create/use/close/reset, repeated calls, idempotence); no mutation of inputs or unrelated state (repeat the operation on the same object and assert the original is unchanged); defaults and backward compatibility of existing callers; error paths with the specified error type and message.
3. Write the tests as NEW files only, one test per AC where practical, using the names and signatures from the Interfaces section. Each new file path must satisfy the grader's test-path rule: a directory segment named tests, test, __tests__, spec or testdata, or a basename matching test_*.py, *_test.<ext>, *.test.<ext> or *.spec.<ext>. Never modify existing test files, fixtures or conftest files. Do not implement the feature.
4. Run your new tests and confirm they FAIL or error only because the feature is missing; fix collection errors caused by your own code. Run the existing suite for the affected package once to record the baseline.
5. Release every file you created with release({file}).
Return exactly:
## Checklist — the AC list.
## Interface contract — the public names/signatures your tests assume.
## Tests — one line per new test file: "- <path> — <AC ids>".
## Commands
TEST_COMMAND: <command that runs only your new tests>
SUITE_COMMAND: <command that runs the affected package's existing tests>
RED: yes|no   (yes = your tests currently fail only for the missing feature)`,
  __junco_opt_Implementer1: `You are Implementer1 of Team 1. Implement this feature in the shared working tree:
{{team1-spec-impl}}

Architect plan (follow Ownership and the Shared-file protocol; the other team edits concurrently):
{{Architect->Implementer1}}

Tester1's acceptance tests and contract (your objective target):
{{Tester1->Implementer1}}

1. The spec is the ground truth; the checklist is its test. Implement with the exact public names and signatures from the Interface contract; where contract and spec disagree, follow the spec and report it.
2. Make TEST_COMMAND pass, then SUITE_COMMAND; fix every regression you caused. Never weaken, skip or delete tests. If a Tester test contradicts the spec, correct that test minimally and explain.
3. Edit only paths in your team's Ownership lists and shared paths per the Shared-file protocol. A Marsh ownership denial means the other team holds the file: do your other work first, retry, and if still denied report the path as BLOCKED instead of working around it.
4. Before finishing, run TEST_COMMAND and SUITE_COMMAND once more and paste the exact commands with exit codes; release every file you edited with release({file}).
Return exactly:
## Changes — files changed and what each change does.
## Deviations — contract/spec disagreements, corrected tests, BLOCKED paths.
## Verdict
TEST_COMMAND: <cmd> exit=<n>
SUITE_COMMAND: <cmd> exit=<n>`,
  __junco_opt_Implementer2: `You are Implementer2 of Team 2. Implement this feature in the shared working tree:
{{team2-spec-impl}}

Architect plan (follow Ownership and the Shared-file protocol; the other team edits concurrently):
{{Architect->Implementer2}}

Tester2's acceptance tests and contract (your objective target):
{{Tester2->Implementer2}}

1. The spec is the ground truth; the checklist is its test. Implement with the exact public names and signatures from the Interface contract; where contract and spec disagree, follow the spec and report it.
2. Make TEST_COMMAND pass, then SUITE_COMMAND; fix every regression you caused. Never weaken, skip or delete tests. If a Tester test contradicts the spec, correct that test minimally and explain.
3. Edit only paths in your team's Ownership lists and shared paths per the Shared-file protocol. A Marsh ownership denial means the other team holds the file: do your other work first, retry, and if still denied report the path as BLOCKED instead of working around it.
4. Before finishing, run TEST_COMMAND and SUITE_COMMAND once more and paste the exact commands with exit codes; release every file you edited with release({file}).
Return exactly:
## Changes — files changed and what each change does.
## Deviations — contract/spec disagreements, corrected tests, BLOCKED paths.
## Verdict
TEST_COMMAND: <cmd> exit=<n>
SUITE_COMMAND: <cmd> exit=<n>`,
};

const RALPH_CHECKS: Record<string, schedules.RalphPredicate> = {
  __junco_ralph_Architect: (result) => verdicts.Architect(syntax.finalText(result, "Ralph")),
  __junco_ralph_Tester1: (result) => verdicts.Tester(syntax.finalText(result, "Ralph")),
  __junco_ralph_Tester2: (result) => verdicts.Tester(syntax.finalText(result, "Ralph")),
  __junco_ralph_Implementer1: (result) => verdicts.Implementer(syntax.finalText(result, "Ralph")),
  __junco_ralph_Implementer2: (result) => verdicts.Implementer(syntax.finalText(result, "Ralph")),
};

// ## Shared-worktree pair

export type Owner = { readonly team: AgentKey; readonly node_id: string };
export type YamlAgent = agent.JuncoAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;
/** A workflow as `JuncoGraph.fromYaml` builds it: runtime-loaded edge schemas and unknown results. */
export type YamlExecution = schedules.SchedulerContext<
  Agentic<TSchema, unknown>,
  TSchema,
  unknown,
  schedules.AgencyNodeMetadata,
  JuncoGraph<TSchema, unknown>
>;

export type PairOptions = Pick<syntax.BuildOptions, "tracer" | "recorder"> & {
  readonly ladder: schedules.ModelLadder;
  readonly cwd?: string;
  readonly collection: tools.ToolCollection;
  readonly createAgent: (spec: syntax.AgentSpec, owner: Owner) => Promise<YamlAgent>;
  readonly signal: AbortSignal;
};

export type Pair = { readonly execution: YamlExecution; readonly stats: { agents: number; workers: number } };

/** Build the pair over the caller's collection, leaving collection ownership with the caller. */
export async function createPair(request: PairRequest, options: PairOptions): Promise<Pair> {
  const stats = { agents: 0, workers: 0 };
  const ownerOf = (spec: syntax.AgentSpec): Owner => ({ team: /2$/.test(spec.path.split("/")[0]!) ? "agent2" : "agent1", node_id: spec.path });
  const install = (created: Parameters<NonNullable<agent.SubagentObserver["acquired"]>>[0], owner: Owner): void => {
    observe(created, owner);
    created.setSubagentObserver({ acquired(child) {
      stats.workers++;
      install(child, { team: owner.team, node_id: child.nodeId });
    } });
  };
  const { ladder, tracer: observer, recorder } = options;
  const execution = await JuncoGraph.fromYaml(document, {
    cwd: options.cwd ?? process.cwd(),
    scheduler,
    ladder,
    code: withOptimizerCode(undefined, ASSIGNMENTS),
    available: mergeAvailable(undefined, ralphUntil(RALPH_CHECKS, 3).available, new Set(Object.keys(RALPH_CHECKS))),
    ...(observer === undefined ? {} : { tracer: observer }),
    ...(recorder === undefined ? {} : { recorder }),
    collection: options.collection,
    signal: options.signal,
    createAgent: async (spec) => {
      stats.agents++;
      const owner = ownerOf(spec);
      const created = await options.createAgent(spec, owner);
      install(created, owner);
      return created;
    },
  });
  try {
    execution.graph.source.enqueue({
      messages: new Map([
        [graph.EdgeId.create("assignment-1"), [{ kind: "prompt", text: "## Feature assigned to Team 1\n\n" + request.agents.agent1.task }]],
        [graph.EdgeId.create("assignment-2"), [{ kind: "prompt", text: "## Feature assigned to Team 2\n\n" + request.agents.agent2.task }]],
      ]),
      values: new Map(),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try { await execution.graph.close(); } catch (failure) { failures.push(failure); }
    throw new AggregateError(failures, "Pair assignment setup failed");
  }
  return { execution, stats };
}

// ## Benchmark telemetry

function telemetryUrl(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a nonempty http(s) URL without credentials, query or fragment`); }
  if (!value.trim() || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#"))
    throw new Error(`${name} must be a nonempty http(s) URL without credentials, query or fragment`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

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

export const containerMemorySupport = { scope: "container", source: "cgroup_v2", metric: "memory.peak" } as const;

/** Read only the private Docker cgroup root, never resolve host or sibling cgroup paths. */
export async function readContainerMemoryPeak(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<number> {
  try {
    await read("/.dockerenv");
    for (const path of ["/proc/self/cgroup", "/proc/1/cgroup"]) {
      if ((await read(path)).trim() !== "0::/") throw new Error("a private Docker cgroup v2 namespace is required");
    }
    const mounts = (await read("/proc/self/mountinfo")).trim().split("\n");
    if (!mounts.some((line) => {
      const [mount, filesystem] = line.split(" - ");
      const fields = mount!.split(" ");
      return fields[3] === "/" && fields[4] === "/sys/fs/cgroup" && filesystem?.startsWith("cgroup2 ");
    })) throw new Error("the private cgroup v2 root must be mounted at /sys/fs/cgroup");
    const value = (await read("/sys/fs/cgroup/memory.peak")).trim();
    const bytes = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("memory.peak must contain finite nonnegative safe-integer bytes");
    return bytes;
  } catch (error) {
    throw new Error(`Container memory prerequisite failed: ${telemetryError(error)}`);
  }
}

/** Own this after the recorder, before Opik/collection/agents, so its final read covers shutdown. */
export async function createContainerMemorySampler(
  directory: string,
  runId: string,
  recorder: tracer.ProfileRecorder<string>,
  read: () => Promise<number> = readContainerMemoryPeak,
): Promise<{ close(): Promise<void> }> {
  const metadata = {
    version: 1, run_id: runId, scope: "container", source: "cgroup_v2",
    peak_memory_bytes: null as number | null, complete: false, errors: [] as string[],
  };
  const path = join(directory, "memory.json");
  const fail = (error: unknown): void => {
    const message = telemetryError(error);
    if (!metadata.errors.includes(message)) metadata.errors.push(message);
  };
  const sample = async (): Promise<void> => {
    try {
      const bytes = await read();
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid container memory peak bytes");
      if (metadata.peak_memory_bytes !== null && bytes < metadata.peak_memory_bytes)
        throw new Error("container memory.peak decreased; cgroup changed or peak was reset");
      metadata.peak_memory_bytes = bytes;
      recorder.record({ resource: "memory", kind: "metrics", category: "benchmark", tool: "",
        operation: "container_memory", gauges: { peak_memory_bytes: bytes } });
    } catch (error) { fail(error); }
  };
  const save = async (): Promise<void> => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  };
  await sample();
  await writeFile(path, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
  if (metadata.errors.length) throw new AggregateError(metadata.errors.map((message) => new Error(message)), "Container memory incomplete");
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending === undefined) pending = sample().then(save).catch(fail).finally(() => { pending = undefined; });
  }, 1000);
  timer.unref();
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= (async () => {
    clearInterval(timer);
    await pending;
    await sample();
    metadata.complete = metadata.errors.length === 0;
    try { await save(); } catch (error) { fail(error); }
    if (metadata.errors.length) throw new AggregateError(metadata.errors.map((message) => new Error(message)), "Container memory incomplete");
  })() };
}

/** One owning session: durable receipt-time events plus usage-mode samples and optional retained metrics. */
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

/** Node's writable queue serializes complete JSONL records under pipe backpressure. */
export function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...record, timestamp: new Date().toISOString() })}\n`);
}

/** Join every queued record before the explicit exit that releases idle model sockets. */
export const flushEvents = (): Promise<void> => new Promise((resolve, reject) => {
  process.stdout.write("", (error) => error ? reject(error) : resolve());
});

function describe(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(describe)].join("; ");
  if (error instanceof SuppressedError) return [error.message, describe(error.error), describe(error.suppressed)].join("; ");
  if (error instanceof Error) return error.cause === undefined ? error.message : `${error.message}: ${describe(error.cause)}`;
  return String(error);
}

/** Record every native message and committed usage row of an observed agent. */
function observe(created: Parameters<NonNullable<agent.SubagentObserver["acquired"]>>[0], { team, node_id }: Owner): void {
  created.events.on("message_end", ({ lane, message }) => {
    emit({ type: "message", agent_id: team, node_id, lane, message });
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
    if (!getSupportedThinkingLevels(model).includes(thinking))
      throw new Error(`${name} does not support ${thinking} thinking for the ${role} role`);
  }
  return runtime;
}

type Outcome = { status: "Submitted" | "LimitsExceeded" | "Error"; error: string | null };

async function runPair(request: PairRequest, interrupt: AbortSignal, grafanaUrl: string, opikUrl: string): Promise<Outcome> {
  const deadline = AbortSignal.timeout(request.timeout_ms);
  const signal = AbortSignal.any([interrupt, deadline]);
  const nodes = { agent1: graph.NodeId.create("Agent1"), agent2: graph.NodeId.create("Agent2") } as const;
  const values: Partial<Record<AgentKey, unknown>> = {};
  const errors: string[] = [];
  let completed = false;
  let pair: Pair | undefined;
  let graphRun: GraphRun | undefined;
  let hash: string | undefined;
  let setupOrCleanupFailed = false;
  try {
    graphRun = await readGraphRun();
    if (graphRun !== undefined) {
      hash = graphHash(document);
      if (graphRun.expectedGraphHash !== hash)
        throw new Error("the candidate graph differs from its run request");
    }
    // LIFO: graph/agents, collection, final container peak, then recorder sinks.
    await using lifetime = new AsyncDisposableStack();
    const live = await tracer.GrafanaRecorder.create({ url: grafanaUrl, dashboard: "junco-cooperbench" });
    const recorder = lifetime.adopt(
      await createBenchmarkRecorder(join(request.problem_dir, ".junco"), request.run_id, live),
      async (owned) => {
        await owned.close();
        // Reuse the closed usage-mode log, including failed attempts, without double accounting.
        if (graphRun !== undefined)
          await copyFile(join(request.problem_dir, ".junco", "log.jsonl"), join(graphRun.dir, "samples.jsonl"), constants.COPYFILE_EXCL);
      },
    );
    lifetime.adopt(await createContainerMemorySampler(join(request.problem_dir, ".junco"), request.run_id, recorder), (owned) => owned.close());
    const observer = new OpikTracer(new Opik({ apiUrl: opikUrl, projectName: process.env.OPIK_PROJECT_NAME ?? "cooperbench" }), request.problem_dir);
    const collection = lifetime.adopt(
      await tools.ToolCollection.create(process.cwd(), marshOptions),
      (owned) => owned.close(),
    );
    const agents = lifetime.adopt(new AsyncDisposableStack(), (owned) => owned.disposeAsync());
    const ladder = new schedules.ModelLadder(await verifiedModels(request.models, request.thinking, signal), ladderOf(request.models, request.thinking));
    signal.throwIfAborted();
    pair = await createPair(request, {
      ladder,
      tracer: observer,
      recorder,
      collection,
      signal,
      createAgent: async (spec) =>
        agents.adopt(await syntax.createJuncoAgent(spec, ladder), async (owned) => { await owned.return(); }),
    });
    const { execution } = pair;
    let closing: Promise<void> | undefined;
    const closeGraph = () => closing ??= execution.graph.close();
    lifetime.adopt(execution.graph, closeGraph);
    const abortGraph = () => { void closeGraph().catch(() => undefined); };
    signal.addEventListener("abort", abortGraph, { once: true });
    lifetime.defer(() => signal.removeEventListener("abort", abortGraph));
    if (signal.aborted) abortGraph();
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
    setupOrCleanupFailed = true;
    // Setup or cleanup failure: keep it beside any run failure.
    errors.push(describe(error));
  }
  const limited = deadline.aborted && !interrupt.aborted;
  if (interrupt.aborted) errors.unshift("interrupted");
  let outcome = pairOutcome(values, { completed, errors, limited });
  // Measurement completion requires a closed attempt, not a successful solver verdict.
  if (graphRun !== undefined && pair !== undefined && !setupOrCleanupFailed && !interrupt.aborted) {
    try {
      await writeCompletion(graphRun, hash!, {});
    } catch (failure) {
      errors.push(describe(failure));
      outcome = pairOutcome(values, { completed, errors, limited });
    }
  }
  const { status, error, agents } = outcome;
  const workers = pair?.stats.workers ?? 0;
  emit({ type: "result", status, agents, error, worker_count: workers, agent_count: (pair?.stats.agents ?? 0) + workers });
  return { status, error };
}

/**
 * The pair's terminal outcome. Each leader's own final value must finish normally with text: the
 * sink retains only Agent1's, so it cannot vouch for Agent2. Submitted also needs a completed run
 * and no error, including cleanup failures.
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

const RuntimeManifest = Type.Object({
  version: Type.Literal(1),
  libc: Type.Union([Type.Literal("gnu"), Type.Literal("musl")]),
  bun_version: Type.String({ minLength: 1 }),
  rust_version: Type.String({ minLength: 1 }),
  node_version: Type.String({ minLength: 1 }),
  native_version: Type.String({ minLength: 1 }),
  native_target: Type.Union([Type.Literal("x86_64-unknown-linux-gnu"), Type.Literal("x86_64-unknown-linux-musl")]),
  builder_image_digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  runtime_build_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  source_hashes: Type.Object({
    wf_ts: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    wf_yml: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    bun_lock: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }, strict),
}, strict);

async function runtimeMetadata() {
  const runtime = "/opt/junco-runtime";
  const manifest: unknown = await Bun.file(join(runtime, "manifest.json")).json();
  if (!Value.Check(RuntimeManifest, manifest)) {
    const [error] = Value.Errors(RuntimeManifest, manifest);
    throw new Error(`invalid runtime manifest: ${error?.instancePath || "/"} ${error?.message || "schema mismatch"}`);
  }
  if (process.arch !== "x64" || process.platform !== "linux" || Bun.version !== manifest.bun_version ||
      manifest.native_target !== `x86_64-unknown-linux-${manifest.libc}`)
    throw new Error("runtime platform, Bun version or native target does not match its manifest");
  const entry = fileURLToPath(import.meta.url);
  if (entry !== join(runtime, "app/examples/cooperbench/wf.ts"))
    throw new Error("native preflight must use the packaged canonical workflow entry");
  for (const [key, file] of Object.entries({ wf_ts: entry, wf_yml: join(runtime, "app/examples/cooperbench/wf.yml"), bun_lock: join(runtime, "app/bun.lock") })) {
    const hash = createHash("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex");
    if (hash !== manifest.source_hashes[key as keyof typeof manifest.source_hashes])
      throw new Error(`packaged source hash does not match manifest: ${key}`);
  }
  return { ...manifest, runtime_entry: entry };
}

/** Proves real Btrfs publication, including repeated ignored cache writes, before model discovery. */
export async function probeRuntime(worktree: string): Promise<void> {
  await import("junco-tools/native");
  const seed = worktree;
  const initialized = Bun.spawnSync(["git", "init", "--quiet", seed]);
  if (initialized.exitCode !== 0) throw new Error(`native probe git initialization failed: ${initialized.stderr.toString()}`);
  await writeFile(join(seed, ".gitignore"), ".cache/\n");
  {
    await using lifetime = new AsyncDisposableStack();
    const collection = lifetime.adopt(await tools.ToolCollection.create(seed, marshOptions), (owned) => owned.close());
    const first = lifetime.adopt(collection.bind(), (owned) => owned.close());
    const second = lifetime.adopt(collection.bind(), (owned) => owned.close());
    const bash = collection.tools.find((tool) => tool.name === "bash")!;
    const release = collection.tools.find((tool) => tool.name === "release")!;
    const a = first.tools.get(bash)!;
    const b = second.tools.get(bash)!;
    await a.execute("probe-write", { command: "printf original > shared.txt" });
    let denied = false;
    try { await b.execute("probe-denied", { command: "printf stolen > shared.txt" }); }
    catch (error) { if (!tools.isMarshPolicyDenied(error)) throw error; denied = true; }
    if (!denied || await Bun.file(join(seed, "shared.txt")).text() !== "original")
      throw new Error("native probe did not deny a competing write and preserve committed bytes");
    await b.execute("probe-disjoint", { command: "printf independent > other.txt" });
    if (await Bun.file(join(seed, "other.txt")).text() !== "independent")
      throw new Error("native probe disjoint write did not publish");
    await first.tools.get(release)!.execute("probe-release", { file: "shared.txt" });
    await b.execute("probe-handoff", { command: "cat shared.txt; printf handed-off > shared.txt" });
    if (await Bun.file(join(seed, "shared.txt")).text() !== "handed-off")
      throw new Error("native probe owner-released handoff did not publish");
    const cache = "mkdir -p .cache && (test ! -f .cache/native-probe || cat .cache/native-probe) && printf cached > .cache/native-probe";
    await a.execute("probe-cache", { command: cache });
    let cacheDenied = false;
    try { await b.execute("probe-cache-denied", { command: cache }); }
    catch (error) { if (!tools.isMarshPolicyDenied(error)) throw error; cacheDenied = true; }
    if (!cacheDenied || await Bun.file(join(seed, ".cache/native-probe")).text() !== "cached")
      throw new Error("native probe did not deny a competing ignored cache write");
    await first.tools.get(release)!.execute("probe-cache-release", { file: ".cache/native-probe" });
    await b.execute("probe-cache-handoff", { command: cache });
    if (await Bun.file(join(seed, ".cache/native-probe")).text() !== "cached")
      throw new Error("native probe released cache command did not publish");
  }
}

/** A first real shell acquires the seed lease and replays its WAL before patch harvesting. */
export async function recoverWorkspace(worktree: string): Promise<void> {
  await using lifetime = new AsyncDisposableStack();
  const collection = lifetime.adopt(await tools.ToolCollection.create(worktree, marshOptions), (owned) => owned.close());
  const binding = lifetime.adopt(collection.bind(), (owned) => owned.close());
  const bash = collection.tools.find((tool) => tool.name === "bash")!;
  await binding.tools.get(bash)!.execute("recover-workspace", { command: "/bin/true" });
}

async function main(signal: AbortSignal): Promise<void> {
  const release = redirectLog({
    write(line) { writeSync(2, `${line}\n`); },
    async flush() {},
  });
  const { type, attachedTransports } = opikLogger.settings;
  opikLogger.settings.type = "hidden";
  opikLogger.settings.attachedTransports = [
    ...attachedTransports,
    (record) => { writeSync(2, `${JSON.stringify(record)}\n`); },
  ];
  try {
    const request = parseRequest(await Bun.stdin.text());
    const grafanaUrl = telemetryUrl(process.env.GRAFANA_URL ?? "http://localhost:8000", "GRAFANA_URL");
    const opikUrl = telemetryUrl(process.env.OPIK_URL_OVERRIDE ?? "http://localhost:5173/api", "OPIK_URL_OVERRIDE");
    const native = request.mode === "preflight" ? await runtimeMetadata() : undefined;
    await readContainerMemoryPeak();
    if (request.mode === "preflight") {
      await probeRuntime(process.cwd());
      {
        await using lifetime = new AsyncDisposableStack();
        const live = lifetime.adopt(await tracer.GrafanaRecorder.create({ url: grafanaUrl, dashboard: "junco-cooperbench" }), (owned) => owned.close());
        lifetime.defer(async () => {
          live.record({ resource: "memory", kind: "metrics", category: "benchmark", tool: "", operation: "container_memory",
            gauges: { peak_memory_bytes: await readContainerMemoryPeak() } });
        });
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
        const opik = new Opik({ apiUrl: opikUrl, projectName: process.env.OPIK_PROJECT_NAME ?? "cooperbench" });
        const projects = await opik.api.projects.findProjects({ size: 1 }, { timeoutInSeconds: 5, maxRetries: 0, abortSignal: signal });
        if (projects === null || typeof projects !== "object" || !Array.isArray(projects.content))
          throw new Error("Opik project API did not return a valid project page");
        await opik.flush();
        await verifiedModels(request.models, request.thinking, signal);
      }
      emit({
        type: "ready",
        models: request.models,
        thinking: request.thinking,
        ...native,
        native_probe: { denied_overwrite: true, disjoint_write: true, released_handoff: true, cache_write_denied: true, cache_released_handoff: true },
        memory: containerMemorySupport,
        telemetry: { grafana: true, opik: true },
      });
      return;
    }
    const { status } = await runPair(request, signal, grafanaUrl, opikUrl);
    if (status !== "Submitted") process.exitCode = 1;
  } finally {
    opikLogger.settings.type = type;
    opikLogger.settings.attachedTransports = attachedTransports;
    release();
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException("Interrupted", "AbortError"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (process.argv.length === 2) await main(controller.signal);
    else if (process.argv.length === 3 && process.argv[2] === "--recover-workspace") await recoverWorkspace(process.cwd());
    else throw new Error("unsupported workflow arguments");
  } catch (error) {
    console.error(error instanceof Error && error.constructor === Error && error.cause === undefined ? error.message : error);
    process.exitCode = 1;
  }
  if (controller.signal.aborted) process.exitCode = 130;
  await flushEvents();
  process.exit();
}
