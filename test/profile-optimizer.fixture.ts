// The profile optimizer's single executable check: metric boundaries on canonical JSONL, then
// `schedules.runOptimizer` from the built package driving real child targets, recorders, code nodes
// and a faux-backed persistent editor through convergence, failure and ownership scenarios; plus
// the Node import boundary and the built CLI's malformed-input exit. Offline: the editor and the
// target agents are scripted faux providers, so no measurement here is a real-world saving.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Context,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { schedules } from "../dist/index.js";
import {
  isStable,
  type Metric,
  readProfile,
  summarize,
} from "../src/std/schedules/optimizer-profile.js";

type Request = schedules.OptimizationRequest;
type State = schedules.OptimizationState;
type Axis = Request["axes"][number];
type Trial = Extract<State["history"][number], { kind: "trial" }>;
type Edit = Extract<State["history"][number], { kind: "edit" }>;

const ROOT = resolve(import.meta.dir, "..");
const AXES: readonly Axis[] = ["scheduler", "ladder", "limits"];
const sha256 = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
};
const trials = (state: State) =>
  state.history.filter((item): item is Trial => item.kind === "trial");
const edits = (state: State) =>
  state.history.filter((item): item is Edit => item.kind === "edit");
const expectStop = (state: State, kind: NonNullable<State["stop"]>["kind"]) =>
  assert.equal(
    state.stop?.kind,
    kind,
    state.stop?.reason ?? "the optimizer did not stop",
  );

// --- metric boundaries ---------------------------------------------------------------------------

async function checkMetrics(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = async (name: string, lines: readonly string[]) => {
    const path = join(dir, name);
    await writeFile(path, `${lines.join("\n")}\n`);
    return path;
  };
  const tokens: Metric = { kind: "tokens" };
  const memory: Metric = { kind: "memory" };
  const row = (value: object) =>
    JSON.stringify({ features: {}, units: {}, resources: {}, ...value });
  const resources = await readProfile(
    await file("resources.jsonl", [
      row({
        node: "A",
        resources: { tokens: 100, memory: 1 },
        units: { tokens: "tok", memory: "KiB" },
      }),
      "",
      "   ",
      row({
        node: "B",
        resources: { tokens: 50, memory: 512 },
        units: { tokens: "tok", memory: "B" },
        measurement: { operations: [{ tool: "read", calls: 1 }] },
      }),
    ]),
  );
  assert.deepEqual(summarize(resources, tokens), {
    value: 150,
    unit: "tok",
    count: 2,
  });
  assert.deepEqual(summarize(resources, memory), {
    value: 1024,
    unit: "B",
    count: 2,
  });

  for (const [name, lines, pattern] of [
    ["json", [row({ node: "A" }), "{not json"], /line 2/],
    [
      "required",
      ["", JSON.stringify({ features: {}, resources: {}, units: {} })],
      /line 2/,
    ],
    [
      "negative",
      [row({ node: "A", resources: { tokens: -1 }, units: { tokens: "tok" } })],
      /line 1/,
    ],
    [
      "unit",
      [row({ node: "A" }), row({ node: "A", resources: { memory: 3 } })],
      /line 2.*no unit/,
    ],
  ] as const)
    await assert.rejects(
      readProfile(await file(`${name}.jsonl`, lines)),
      pattern,
    );
  await assert.rejects(readProfile(join(dir, "absent.jsonl")), /ENOENT/);

  const probe = (node: string, value: number, edgeId = "score") =>
    row({ node, measurement: { probe: [{ edgeId, value }] } });
  const probes = await readProfile(
    await file("probes.jsonl", [
      probe("Child", 0),
      probe("", 7),
      probe("Child", -2),
      probe("Child", 1, "other"),
      probe("Child", 4),
    ]),
  );
  const nested = (reduce: Extract<Metric, { kind: "probe" }>["reduce"]) =>
    summarize(probes, {
      kind: "probe",
      node: "Child",
      edgeId: "score",
      reduce,
    });
  assert.deepEqual(nested("last"), { value: 4, unit: null, count: 3 });
  assert.equal(nested("min").value, -2);
  assert.equal(nested("max").value, 4);
  assert.equal(nested("sum").value, 2);
  assert.equal(nested("mean").value, 2 / 3);
  assert.throws(() => nested("single"), /3 values; single requires one/);
  assert.deepEqual(
    summarize(probes, {
      kind: "probe",
      node: "",
      edgeId: "score",
      reduce: "single",
    }),
    { value: 7, unit: null, count: 1 },
  );
  const zero = await readProfile(await file("zero.jsonl", [probe("", 0)]));
  assert.equal(
    summarize(zero, {
      kind: "probe",
      node: "",
      edgeId: "score",
      reduce: "single",
    }).value,
    0,
  );
  const empty = await readProfile(await file("empty.jsonl", ["", " "]));
  assert.deepEqual(empty, []);
  assert.throws(() => summarize(empty, tokens), /no tokens/);
  assert.throws(() => summarize(probes, tokens), /no tokens/);
  assert.throws(() => summarize(probes, memory), /no memory/);
  assert.throws(
    () =>
      summarize(probes, {
        kind: "probe",
        node: "Other",
        edgeId: "score",
        reduce: "max",
      }),
    /no probe/,
  );
  for (const payload of [
    "x",
    [{ edgeId: 1, value: 1 }],
    [{ edgeId: "score" }],
  ]) {
    const bad = await readProfile(
      await file("malformed.jsonl", [
        row({ node: "", measurement: { probe: payload } }),
      ]),
    );
    assert.throws(
      () =>
        summarize(bad, {
          kind: "probe",
          node: "",
          edgeId: "score",
          reduce: "last",
        }),
      /probe/,
    );
  }
  const huge = await readProfile(
    await file("huge.jsonl", [probe("", 1e308), probe("", 1e308)]),
  );
  assert.throws(
    () =>
      summarize(huge, {
        kind: "probe",
        node: "",
        edgeId: "score",
        reduce: "sum",
      }),
    /not finite/,
  );

  assert.equal(isStable([80, 80.4, 80.2], 3, 0, 0.01), true);
  assert.equal(isStable([80, 84, 80], 3, 0, 0.01), false);
  assert.equal(isStable([80, 80], 3, 0, 0.01), false);
  assert.equal(isStable([0, -0.5, 0.5], 3, 1, 0), true);
  assert.equal(isStable([-3, -3, -3], 2, 0, 0), true);
  for (const [values, window, absolute, relative] of [
    [[1, 1], 1, 0, 0],
    [[1, 1], 2.5, 0, 0],
    [[1, 1], 2, -1, 0],
    [[1, 1], 2, 0, Number.NaN],
    [[1, Number.POSITIVE_INFINITY], 2, 0, 0],
    [[-Number.MAX_VALUE, Number.MAX_VALUE], 2, 0, 0],
  ] as const)
    assert.throws(
      () => isStable(values, window, absolute, relative),
      RangeError,
    );
}

// --- target template -----------------------------------------------------------------------------

const marker = (edge: "start" | "end", axis: Axis) =>
  `// junco-profile-optimizer:${edge} ${axis}`;

/** `text` with each listed region interior replaced: the fixture's independent splice. */
function withRegions(
  text: string,
  sources: Partial<Record<Axis, string>>,
): string {
  let out = text;
  for (const axis of AXES) {
    const source = sources[axis];
    if (source === undefined) continue;
    const open = out.indexOf("\n", out.indexOf(marker("start", axis))) + 1;
    const close = out.lastIndexOf("\n", out.indexOf(marker("end", axis))) + 1;
    out = out.slice(0, open) + source + out.slice(close);
  }
  return out;
}

type TargetParts = {
  readonly yaml: string;
  readonly header?: string;
  readonly scheduler: string;
  readonly ladder: string;
  readonly limits: string;
  readonly hardLimits?: string;
  readonly params?: string;
  readonly code: string;
  readonly options?: string;
  /** A boolean expression over the terminal `value`: the workflow's existing assertion. */
  readonly check: string;
  readonly beforeBuild?: string;
  readonly afterCleanup?: string;
  readonly nonce?: string;
};

/** The instrumented entrypoint the skill prepares, per references/profiling.md. */
const preparedSource = (
  p: TargetParts,
): string => `// Fixture target generated by test/profile-optimizer.fixture.ts.
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytes, tokens } from "dataflow-engine";
import { Deterministic, graph, JuncoGraph, schedules, syntax, tracer } from "junco-agency";
${p.header ?? ""}
type OptimizerLimits = {
  memoryBytes?: number;
  tokens?: number;
  tools?: number;
  scope?: "evaluation" | "batch" | "activation";
};

${marker("start", "scheduler")}
${p.scheduler}${marker("end", "scheduler")}
${marker("start", "ladder")}
${p.ladder}${marker("end", "ladder")}
${marker("start", "limits")}
${p.limits}${marker("end", "limits")}

/** The workflow's original hard ceilings, outermost around every candidate. */
const HARD_LIMITS: schedules.LimitOptions | undefined = ${p.hardLimits ?? "undefined"};
const PARAMS: Record<string, string> = ${p.params ?? "{}"};

// --- junco-profile-optimizer instrumentation: fixed, outside every tuning region ---
type ProfileRun = {
  version: 1;
  nonce: string;
  monitored: boolean;
  probes: { node: string; edgeId: string }[];
  expectedGraphHash: string | null;
  allowedModels: { model: string; thinking?: string }[];
  limitBounds: { memoryBytes?: number; tokens?: number; tools?: number };
};
const RUN_DIR = process.env.JUNCO_PROFILE_RUN_DIR;
const RUN_KEYS = "allowedModels,expectedGraphHash,limitBounds,monitored,nonce,probes,version";

async function profileRun(): Promise<ProfileRun | undefined> {
  if (RUN_DIR === undefined) return undefined;
  const run = JSON.parse(await readFile(join(RUN_DIR, "request.json"), "utf8"));
  if (
    Object.keys(run).sort().join() !== RUN_KEYS ||
    run.version !== 1 ||
    typeof run.nonce !== "string" ||
    typeof run.monitored !== "boolean" ||
    !Array.isArray(run.probes) ||
    !Array.isArray(run.allowedModels)
  )
    throw new Error("invalid profile run request");
  return run;
}

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

/** \`document\` with probe: true on each requested existing numeric edge, revalidated. */
function withProbes(document: syntax.JuncoDocument, probes: ProfileRun["probes"]): syntax.JuncoDocument {
  const copy = structuredClone(document);
  for (const { node, edgeId } of probes) {
    let spec = copy.graph;
    for (const segment of node === "" ? [] : node.split("/")) {
      const wrapper = spec.nodes[segment];
      if (wrapper?.kind !== "graph") throw new Error(\`probe path "\${node}" names no graph node\`);
      spec = wrapper.graph;
    }
    const edges = (spec.edges ?? []).filter(
      (edge) => (edge.id ?? \`\${edge.from}\${edge.kind === "message" ? "~>" : "->"}\${edge.to}\`) === edgeId,
    );
    const type = edges.length === 1 ? (edges[0].schema as { type?: unknown }).type : undefined;
    if (type !== "number" && type !== "integer")
      throw new Error(\`probe "\${node}" / "\${edgeId}" is not exactly one existing numeric edge\`);
    edges[0].probe = true;
  }
  return syntax.parse(copy);
}

/** The candidate's concrete ladder and extra limits stay inside the run's authorized domain. */
function checkTuning(run: ProfileRun): void {
  for (const [name, rung] of Object.entries(optimizerLadder ?? {}))
    if (!run.allowedModels.some((allowed) => allowed.model === rung.model && allowed.thinking === rung.thinking))
      throw new Error(\`ladder rung \${name} uses unauthorized \${rung.model}\`);
  const bounds: Record<string, number | undefined> = {
    memoryBytes: run.limitBounds.memoryBytes,
    tokens: run.limitBounds.tokens,
    tools: run.limitBounds.tools,
  };
  for (const [key, value] of Object.entries(optimizerLimits)) {
    if (key === "scope") {
      if (!["evaluation", "batch", "activation"].includes(String(value)))
        throw new Error(\`invalid limit scope \${value}\`);
      continue;
    }
    if (!Object.hasOwn(bounds, key)) throw new Error(\`unknown limit \${key}\`);
    const bound = bounds[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (key === "tools" && !Number.isInteger(value)) ||
      (bound !== undefined && value > bound)
    )
      throw new Error(\`limit \${key}=\${value} is outside its bound \${bound}\`);
  }
}

/** The candidate policy: tuned scheduler, optional strength, extra limits, hard limits outermost. */
function tunedScheduler(label: string) {
  let policy = optimizerScheduler(label);
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

${p.code}

const run = await profileRun();
const yamlText = await readFile(new URL("./workflow.yml", import.meta.url), "utf8");
const document = syntax.parse(yamlText, { params: PARAMS, sourceName: "workflow.yml" });
const graphHash = createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex");
if (run?.expectedGraphHash != null && run.expectedGraphHash !== graphHash)
  throw new Error("the runtime graph document drifted from the baseline's");
if (run !== undefined) checkTuning(run);
${p.beforeBuild ?? ""}
const recorder =
  run === undefined
    ? undefined
    : new tracer.JsonlRecorder({ path: join(RUN_DIR as string, "samples.jsonl"), monitored: run.monitored });
const observer = new tracer.DummyTracer();
let resourceEvents = 0;
const failures: unknown[] = [];
let execution: Awaited<ReturnType<typeof JuncoGraph.fromYaml>> | undefined;
try {
  execution = await JuncoGraph.fromYaml(run === undefined ? document : withProbes(document, run.probes), {
    cwd: import.meta.dir,
    scheduler: tunedScheduler,
    tracer: observer,
    code: CODE,
    ...(recorder === undefined ? {} : { recorder }),
    ${p.options ?? ""}
  });
  await execution.run();
  const result = execution.graph.result(execution.graph.sink.id);
  const value = result._tag === "Some" ? result.value : undefined;
  if (!(${p.check})) throw new Error(\`terminal check failed: \${String(value)}\`);
} catch (error) {
  failures.push(error);
}
for (const close of [() => execution?.graph.close(), () => observer.flush(), () => recorder?.close()])
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
if (failures.length > 0) throw new AggregateError(failures, "workflow run failed");
${p.afterCleanup ?? ""}
if (run !== undefined) {
  const receipt = join(RUN_DIR as string, "completion.json");
  await writeFile(
    \`\${receipt}.tmp\`,
    JSON.stringify({ version: 1, nonce: ${p.nonce ?? "run.nonce"}, terminal: true, graphHash, resourceEvents }),
    { flag: "wx" },
  );
  await rename(\`\${receipt}.tmp\`, receipt);
}
`;

const NUMERIC_YAML = (description = "Reports peak concurrency.") => `graph:
  name: NumericTarget
  nodes:
    Seed: { kind: code, trigger: always }
    A: { kind: code, profiles: { memory: 1 B } }
    B: { kind: code, profiles: { memory: 1 B } }
    Quality: { kind: code }
    Terminal: { kind: code, description: "${description}" }
  edges:
    - { from: Seed, to: A, kind: message, schema: { type: number } }
    - { from: Seed, to: B, kind: message, schema: { type: number } }
    - { from: A, to: Quality, schema: { type: number } }
    - { from: B, to: Quality, schema: { type: number } }
    - { id: quality, from: Quality, to: Terminal, schema: { type: number } }
    - { id: score, from: Terminal, to: $sink, schema: { type: number } }
`;

const NUMERIC_CODE = (terminal = "peak") => `let active = 0;
let peak = 0;
const worker: syntax.DeterministicNode = ({ policy }) => ({
  state: new Deterministic(async function* () {
    yield [];
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      active--;
    }
    return 1;
  }, policy),
});
const CODE: Record<string, syntax.DeterministicNode> = {
  Seed: ({ edges, policy }) => {
    let emitted = false;
    return {
      state: new Deterministic(async function* () {
        emitted = true;
        yield ["Seed~>A", "Seed~>B"].map((id) => graph.Message.create(edges.get(id)!, 1));
        return 1;
      }, policy),
      is_available: () => !emitted,
    };
  },
  A: worker,
  B: worker,
  Quality: ({ policy }) => ({
    state: new Deterministic(async function* () {
      const view = yield [];
      if (view.values.get("A->Quality") !== 1 || view.values.get("B->Quality") !== 1)
        throw new Error("Quality requires both inputs");
      return 0.95;
    }, policy),
  }),
  Terminal: ({ policy }) => ({
    state: new Deterministic(async function* () {
      const view = yield [];
      if (view.values.get("quality") !== 0.95) throw new Error("quality check failed");
      return ${terminal};
    }, policy),
  }),
};`;

const SCHED = {
  parallel:
    "const optimizerScheduler = (_label: string) => schedules.parallel();\n",
  roundRobin:
    "const optimizerScheduler = (_label: string) => schedules.roundRobin(undefined, 1);\n",
  choose:
    "const optimizerScheduler = (_label: string) =>\n  schedules.choose({ rank: () => 0, width: () => 1 });\n",
};
const NO_LADDER =
  "const optimizerLadder: schedules.Ladder | undefined = undefined;\nconst optimizerStrength = undefined;\n";
const limits = (value: string) =>
  `const optimizerLimits: OptimizerLimits = ${value};\n`;

const numericTarget = (extra: Partial<TargetParts> = {}): TargetParts => ({
  yaml: NUMERIC_YAML(),
  scheduler: SCHED.parallel,
  ladder: NO_LADDER,
  limits: limits("{}"),
  code: NUMERIC_CODE(),
  check: 'typeof value === "number" && value >= 1',
  ...extra,
});

type Prepared = {
  readonly dir: string;
  readonly yaml: string;
  readonly ts: string;
  readonly sessionDir: string;
  readonly prepared: string;
  readonly original: string;
};

/** What the skill does once: write the pair, snapshot the originals, then the instrumented TS. */
async function prepare(dir: string, parts: TargetParts): Promise<Prepared> {
  await mkdir(dir, { recursive: true });
  const yaml = join(dir, "workflow.yml");
  const ts = join(dir, "workflow.ts");
  const original = `// Original entrypoint before profile instrumentation.\n${parts.code}\n`;
  const prepared = preparedSource(parts);
  await writeFile(yaml, parts.yaml);
  await writeFile(ts, prepared);
  const sessions = join(dir, ".junco", "profile-optimizer");
  await mkdir(sessions, { recursive: true });
  const sessionDir = await mkdtemp(join(sessions, "session-"));
  await writeFile(join(sessionDir, "original.yml"), parts.yaml);
  await writeFile(join(sessionDir, "original.ts"), original);
  await writeFile(join(sessionDir, "prepared.ts"), prepared);
  return { dir, yaml, ts, sessionDir, prepared, original };
}

const SCORE: Metric = {
  kind: "probe",
  node: "",
  edgeId: "score",
  reduce: "single",
};
const QUALITY: Metric = {
  kind: "probe",
  node: "",
  edgeId: "quality",
  reduce: "single",
};

const requestFor = (
  target: Prepared,
  extra: Partial<Request> = {},
): Request => ({
  target: {
    yaml: target.yaml,
    ts: target.ts,
    cwd: target.dir,
    argv: [process.execPath, "run", target.ts],
  },
  sessionDir: target.sessionDir,
  workloadId: "fixed-numeric-workload",
  objective: { metric: SCORE, direction: "minimize" },
  constraints: [{ metric: QUALITY, op: ">=", threshold: 0.9 }],
  repeats: 1,
  stop: { improvement: { kind: "relative", value: 0.5 } },
  axes: ["scheduler"],
  allowedModels: [],
  limitBounds: { memoryBytes: 1024 },
  ...extra,
});

// --- faux editor ---------------------------------------------------------------------------------

let providers = 0;

/** Copied from test/support.ts's public faux setup: a credentialed offline ModelRuntime. */
async function editorRuntime(
  responses: FauxResponseStep[],
  targetModels: readonly string[] = [],
) {
  const name = `optimizer-editor-${++providers}`;
  const credentials = new InMemoryCredentialStore();
  const models = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  // A window large enough that the harness never auto-compacts the scripted transcript.
  const editor = fauxProvider({
    api: name,
    provider: name,
    models: [{ id: "editor", contextWindow: 100_000_000, maxTokens: 16_384 }],
    tokenSize: { min: 4, max: 4 },
  });
  editor.setResponses(responses);
  const fauxes = [{ provider: name, faux: editor }];
  if (targetModels.length > 0)
    fauxes.push({
      provider: "target",
      faux: fauxProvider({
        api: "target-catalog",
        provider: "target",
        models: targetModels.map((id) => ({ id })),
      }),
    });
  for (const { provider, faux } of fauxes) {
    await credentials.modify(provider, async () => ({
      type: "api_key",
      key: "fixture-login",
    }));
    models.registerNativeProvider(faux.provider);
  }
  const model = editor.getModel();
  return {
    models,
    editor,
    editorRung: { model: `${model.provider}/${model.id}` },
  };
}

type Result = {
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
};
type Info = {
  readonly ticket: string;
  readonly tsHash: string;
  readonly typescript: string;
};
type EditorTurn = {
  readonly axis: Axis;
  /** One valid edit; omit both this and rounds to settle without an edit. */
  readonly source?: string;
  /** Successive tool-call messages after read_target; each sees the previous message's results. */
  readonly rounds?: readonly ((
    info: Info,
    previous: readonly Result[],
  ) => ToolCall[] | Promise<ToolCall[]>)[];
  /** Runs once the last tool results returned, before the turn's final message settles. */
  readonly afterEdit?: (
    results: readonly Result[],
    info: Info,
  ) => Promise<void> | void;
};
type EditorLog = { readonly states: State[] };

const toolTurn = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

/** The tool results the newest assistant message produced. */
function latestResults(context: Context): Result[] {
  const results: Result[] = [];
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message?.role !== "toolResult") break;
    results.unshift({
      name: message.toolName,
      text: contentText(message.content),
      isError: message.isError,
    });
  }
  return results;
}

/** One scripted editor turn: recv, read_target, the edit rounds, then a one-sentence settlement. */
function editorTurn(turn: EditorTurn, log: EditorLog): FauxResponseStep[] {
  let state: State | undefined;
  let info: Info | undefined;
  const { source } = turn;
  const rounds =
    turn.rounds ??
    (source === undefined
      ? []
      : [
          ({ ticket, tsHash }: Info) => [
            fauxToolCall("edit_tuning", {
              ticket,
              axis: turn.axis,
              expectedTsHash: tsHash,
              source,
              reason: `measure a new ${turn.axis} configuration`,
            }),
          ],
        ]);
  const steps: FauxResponseStep[] = [
    toolTurn(fauxToolCall("recv", {})),
    (context) => {
      const [recv] = latestResults(context);
      const inbox = JSON.parse(recv?.text ?? "{}");
      state = inbox.messages?.find(
        (m: { id: string }) => m.id === "editor-assignment",
      )?.payload;
      if (state === undefined)
        throw new Error("the editor received no assignment");
      log.states.push(state);
      if (state.request.axes[state.axisIndex] !== turn.axis)
        throw new Error(
          `assigned ${state.request.axes[state.axisIndex]}, scripted ${turn.axis}`,
        );
      return rounds.length === 0
        ? fauxAssistantMessage("Nothing to change this turn.")
        : toolTurn(fauxToolCall("read_target", {}));
    },
  ];
  rounds.forEach((round, index) => {
    steps.push(async (context) => {
      const previous = latestResults(context);
      if (index === 0) {
        const target = JSON.parse(previous[0]?.text ?? "{}");
        info = {
          ticket: state?.editTicket ?? "",
          tsHash: target.tsHash,
          typescript: target.typescript,
        };
      }
      return toolTurn(...(await round(info as Info, previous)));
    });
  });
  if (rounds.length > 0)
    steps.push(async (context) => {
      await turn.afterEdit?.(latestResults(context), info as Info);
      return fauxAssistantMessage(`Changed the ${turn.axis} region.`);
    });
  return steps;
}

/** runOptimizer under the 120-second watchdog, which fails the check when it fires. */
async function optimize(
  request: Request,
  options: {
    models: ModelRuntime;
    editorRung: { model: string };
    signal?: AbortSignal;
  },
): Promise<State> {
  const watchdog = new AbortController();
  const timer = setTimeout(
    () => watchdog.abort(new Error("watchdog")),
    120_000,
  );
  try {
    const signal =
      options.signal === undefined
        ? watchdog.signal
        : AbortSignal.any([options.signal, watchdog.signal]);
    const state = await schedules.runOptimizer(request, { ...options, signal });
    assert.equal(
      watchdog.signal.aborted,
      false,
      "runOptimizer exceeded its 120-second watchdog",
    );
    return state;
  } finally {
    clearTimeout(timer);
  }
}

async function readState(sessionDir: string): Promise<State> {
  return JSON.parse(await readFile(join(sessionDir, "state.json"), "utf8"));
}
const runDirs = async (sessionDir: string) =>
  existsSync(join(sessionDir, "runs"))
    ? (await readdir(join(sessionDir, "runs"))).length
    : 0;

/** Every trial's identity reproduces its saved bytes and each ok run's summary its own profile. */
async function checkEvidence(target: Prepared, state: State): Promise<void> {
  for (const trial of trials(state)) {
    assert.equal(
      sha256(withRegions(target.prepared, trial.candidate.sources)),
      trial.candidate.tsHash,
    );
    for (const run of trial.runs) {
      if (run.status !== "ok") continue;
      const samples = await readProfile(join(run.directory, "samples.jsonl"));
      assert.deepEqual(
        summarize(samples, state.request.objective.metric),
        run.objective,
      );
      for (const [i, { metric }] of state.request.constraints.entries())
        assert.deepEqual(summarize(samples, metric), run.constraints[i]);
    }
  }
  assert.deepEqual(
    await readFile(target.yaml),
    await readFile(join(target.sessionDir, "original.yml")),
  );
  assert.deepEqual(await readState(target.sessionDir), state);
}

// --- numeric convergence -------------------------------------------------------------------------

async function numericScenario(dir: string): Promise<void> {
  const target = await prepare(dir, numericTarget());
  await chmod(target.ts, 0o640);
  const log: EditorLog = { states: [] };
  const delays: { runsUnchanged: boolean; feedbackWaited: boolean }[] = [];
  /** Hold settlement after the patch returned: no child may start and Feedback may not consume it. */
  const holdSettlement = async (_results: readonly Result[], info: Info) => {
    const before = await runDirs(target.sessionDir);
    await sleep(300);
    const checkpoint = await readState(target.sessionDir);
    const recorded = edits(checkpoint).some(
      (edit) => edit.ticket === info.ticket,
    );
    delays.push({
      runsUnchanged: (await runDirs(target.sessionDir)) === before,
      feedbackWaited: checkpoint.editTicket === info.ticket && !recorded,
    });
  };
  const { models, editor, editorRung } = await editorRuntime([
    ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
    ...editorTurn({ axis: "limits" }, log),
    ...editorTurn(
      {
        axis: "limits",
        source: limits("{ memoryBytes: 1 }"),
        afterEdit: holdSettlement,
      },
      log,
    ),
    ...editorTurn(
      { axis: "scheduler", source: SCHED.choose, afterEdit: holdSettlement },
      log,
    ),
    ...editorTurn(
      { axis: "limits", source: limits("{ memoryBytes: 2 }") },
      log,
    ),
  ]);
  const state = await optimize(
    requestFor(target, {
      repeats: 3,
      stop: {
        improvement: { kind: "relative", value: 0.5 },
        plateau: { window: 3, absoluteTolerance: 0, relativeTolerance: 0 },
      },
      axes: ["scheduler", "limits"],
    }),
    { models, editorRung },
  );
  expectStop(state, "converged");
  assert.equal(editor.getPendingResponseCount(), 0);
  assert.equal(state.baselineScore, 2);
  assert.equal(state.anchor.score, 1);
  assert.equal(state.anchor.candidate.sources.scheduler, SCHED.roundRobin);
  assert.equal(state.anchor.candidate.sources.limits, limits("{}"));
  assert.deepEqual(
    state.history.map((item) =>
      item.kind === "edit"
        ? `edit:${item.axis}:${item.accepted}`
        : `${item.phase}:${item.axis}:${item.runs.map((run) => run.objective?.value).join(",")}`,
    ),
    [
      "baseline:null:2,2,2",
      "edit:scheduler:true",
      "candidate:scheduler:1,1,1",
      "edit:limits:false",
      "edit:limits:true",
      "candidate:limits:1,1,1",
      "remeasure:null:1,1,1",
      "edit:scheduler:true",
      "candidate:scheduler:1,1,1",
      "edit:limits:true",
      "candidate:limits:1,1,1",
      "confirmation:null:1,1,1",
    ],
  );
  assert.match(
    edits(state)[1]?.error ?? "",
    /without a successful edit_tuning/,
  );
  for (const trial of trials(state)) {
    assert.ok(trial.feasible);
    for (const run of trial.runs) assert.equal(run.constraints[0]?.value, 0.95);
  }
  await checkEvidence(target, state);
  assert.equal(
    await readFile(target.ts, "utf8"),
    withRegions(target.prepared, state.anchor.candidate.sources),
  );
  assert.equal((await stat(target.ts)).mode & 0o777, 0o640);
  // Later assignments carry the earlier measured results.
  assert.equal(log.states.length, 5);
  assert.deepEqual(
    log.states.map((s) =>
      trials(s)
        .map((trial) => trial.phase)
        .join(","),
    ),
    [
      "baseline",
      "baseline,candidate",
      "baseline,candidate",
      "baseline,candidate,candidate,remeasure",
      "baseline,candidate,candidate,remeasure,candidate",
    ],
  );
  assert.deepEqual(delays, [
    { runsUnchanged: true, feedbackWaited: true },
    { runsUnchanged: true, feedbackWaited: true },
  ]);
  // Editor usage is recorded apart from the deterministic target, which records no tokens.
  const usage = summarize(
    await readProfile(join(target.sessionDir, "optimizer.jsonl")),
    { kind: "tokens" },
  );
  assert.ok(usage.value > 0 && usage.count >= 5);
  const firstRun = trials(state)[0]?.runs[0]?.directory as string;
  const targetSamples = await readProfile(join(firstRun, "samples.jsonl"));
  assert.ok(targetSamples.length > 0);
  assert.throws(
    () => summarize(targetSamples, { kind: "tokens" }),
    /no tokens/,
  );
}

// --- tokens and model ladder -----------------------------------------------------------------------

const TOKEN_YAML = `graph:
  name: ReportTarget
  nodes:
    Writer:
      prompt: Write the status report.
      trigger: always
    Quality: { kind: code }
    Terminal: { kind: code }
  edges:
    - { from: Writer, to: Quality, schema: { type: object } }
    - { id: quality, from: Quality, to: Terminal, schema: { type: number } }
    - { id: done, from: Terminal, to: $sink, schema: { type: number } }
`;

/** Real target agents on a faux provider whose reply length and stated quality depend on the model. */
const TOKEN_HEADER = `import { contentText, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const REPLIES: Record<string, string> = {
  large: \`quality=0.95 \${"l".repeat(12_000)}\`,
  small: \`quality=0.95 \${"s".repeat(2_400)}\`,
  tiny: \`quality=0.7 \${"t".repeat(200)}\`,
};
const targetModels = fauxProvider({
  api: "target",
  provider: "target",
  models: Object.keys(REPLIES).map((id) => ({ id })),
  tokenSize: { min: 4, max: 4 },
});
targetModels.setResponses(
  Array.from({ length: 4 }, () => (_context, _options, _state, model) => fauxAssistantMessage(REPLIES[model.id] ?? "")),
);
const credentials = new InMemoryCredentialStore();
await credentials.modify("target", async () => ({ type: "api_key", key: "fixture-login" }));
const models = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
models.registerNativeProvider(targetModels.provider);
`;

const TOKEN_CODE = `const CODE: Record<string, syntax.DeterministicNode> = {
  Quality: ({ policy }) => ({
    state: new Deterministic(async function* () {
      const view = yield [];
      const report = view.values.get("Writer->Quality") as { content: Parameters<typeof contentText>[0] };
      let quality = Number(/quality=([0-9.]+)/.exec(contentText(report.content))?.[1]);
      if (RUN_DIR !== undefined) {
        // Synthetic flake for the fixture: the first confirmation batch reads lower quality.
        const state = JSON.parse(await readFile(join(RUN_DIR, "..", "..", "state.json"), "utf8"));
        const phases = state.history.filter((item) => item.kind === "trial").map((item) => item.phase);
        if (phases.at(-1) === "confirmation" && phases.filter((phase) => phase === "confirmation").length === 1)
          quality = 0.85;
      }
      return quality;
    }, policy),
  }),
  Terminal: ({ policy }) => ({
    state: new Deterministic(async function* () {
      const view = yield [];
      if (typeof view.values.get("quality") !== "number") throw new Error("missing quality");
      return 1;
    }, policy),
  }),
};`;

const ladderOf = (med: string) =>
  `const optimizerLadder: schedules.Ladder | undefined = {\n  ...schedules.uniformLadder({ model: "target/large" }),\n  med: { model: "target/${med}" },\n};\nconst optimizerStrength = undefined;\n`;

async function tokenScenario(dir: string): Promise<void> {
  const target = await prepare(dir, {
    yaml: TOKEN_YAML,
    header: TOKEN_HEADER,
    scheduler: SCHED.parallel,
    ladder: ladderOf("large"),
    limits: limits("{}"),
    hardLimits: "{ tokens: tokens(100_000) }",
    code: TOKEN_CODE,
    options:
      "createAgent: (spec) => syntax.createJuncoAgent(spec, optimizerLadder!, models), ladder: optimizerLadder, models,",
    check: "value === 1",
  });
  const log: EditorLog = { states: [] };
  const tokenCap = (n: number) => limits(`{ tokens: ${n} }`);
  const { models, editorRung } = await editorRuntime(
    [
      // Cycle 0: an equal scheduler, a cheaper used rung (promoted), a failing then an equal limit.
      ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
      ...editorTurn({ axis: "ladder", source: ladderOf("small") }, log),
      ...editorTurn({ axis: "limits", source: tokenCap(1_000) }, log),
      ...editorTurn({ axis: "limits", source: tokenCap(10_000) }, log),
      // Cycle 1: no promotion; the cheapest rung fails quality; confirmation then flakes.
      ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
      ...editorTurn({ axis: "ladder", source: ladderOf("tiny") }, log),
      ...editorTurn({ axis: "limits", source: tokenCap(10_000) }, log),
      // Cycle 2: exploration resumes; confirmation passes on the saved 'small' configuration.
      ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
      ...editorTurn({ axis: "ladder", source: ladderOf("large") }, log),
      ...editorTurn({ axis: "limits", source: tokenCap(10_000) }, log),
    ],
    ["large", "small", "tiny"],
  );
  const state = await optimize(
    requestFor(target, {
      workloadId: "fixed-report-workload",
      objective: { metric: { kind: "tokens" }, direction: "minimize" },
      repeats: 3,
      stop: {
        improvement: { kind: "relative", value: 0.2 },
        plateau: { window: 3, absoluteTolerance: 0, relativeTolerance: 0.01 },
      },
      axes: ["scheduler", "ladder", "limits"],
      allowedModels: ["large", "small", "tiny"].map((id) => ({
        model: `target/${id}`,
      })),
      limitBounds: { tokens: 20_000 },
    }),
    { models, editorRung },
  );
  expectStop(state, "converged");
  const [baseline, ...rest] = trials(state);
  const large = baseline?.score as number;
  const small = state.anchor.score as number;
  assert.equal(state.baselineScore, large);
  assert.ok(
    (large - small) / large >= 0.2,
    `${small} tok is not 20% below ${large} tok`,
  );
  assert.equal(state.anchor.candidate.sources.ladder, ladderOf("small"));
  assert.equal(state.anchor.candidate.sources.scheduler, SCHED.parallel);
  assert.equal(state.anchor.candidate.sources.limits, limits("{}"));
  const summary = rest.map(
    (trial) =>
      `${trial.phase}:${trial.axis}:${trial.feasible}:${trial.score === null ? "null" : trial.score === small ? "small" : trial.score < small ? "cheaper" : "larger"}`,
  );
  assert.deepEqual(summary, [
    "candidate:scheduler:true:larger",
    "candidate:ladder:true:small",
    "candidate:limits:false:null",
    "candidate:limits:true:small",
    "remeasure:null:true:small",
    "candidate:scheduler:true:small",
    "candidate:ladder:false:cheaper",
    "candidate:limits:true:small",
    "confirmation:null:false:small",
    "remeasure:null:true:small",
    "candidate:scheduler:true:small",
    "candidate:ladder:true:larger",
    "candidate:limits:true:small",
    "confirmation:null:true:small",
  ]);
  const capped = rest[2] as Trial;
  assert.equal(capped.runs.length, 1);
  assert.equal(capped.runs[0]?.status, "failed");
  assert.match(
    await readFile(
      join(capped.runs[0]?.directory as string, "target.stderr"),
      "utf8",
    ),
    /JUNCO_USAGE_LIMIT_EXCEEDED|usage limit/i,
  );
  assert.deepEqual(
    rest[6]?.runs.map((run) => run.constraints[0]?.value),
    [0.7, 0.7, 0.7],
  );
  assert.deepEqual(
    rest[8]?.runs.map((run) => run.constraints[0]?.value),
    [0.85, 0.85, 0.85],
  );
  assert.deepEqual(
    rest[13]?.runs.map((run) => run.constraints[0]?.value),
    [0.95, 0.95, 0.95],
  );
  assert.equal(log.states.length, 10);
  await checkEvidence(target, state);
  assert.equal(
    await readFile(target.ts, "utf8"),
    withRegions(target.prepared, state.anchor.candidate.sources),
  );
}

// --- failures and ownership ------------------------------------------------------------------------

/** A request whose only stop predicate needs a measured baseline, stopped before any edit. */
async function blockedScenario(
  dir: string,
  parts: TargetParts,
  extra: Partial<Request>,
  error: RegExp,
  reason: RegExp,
): Promise<State> {
  const target = await prepare(dir, parts);
  const { models, editorRung } = await editorRuntime([]);
  const state = await optimize(requestFor(target, extra), {
    models,
    editorRung,
  });
  expectStop(state, "blocked");
  assert.match(state.stop?.reason ?? "", reason);
  const [baseline] = trials(state);
  assert.equal(baseline?.score, null);
  assert.match(baseline?.runs[0]?.error ?? "", error);
  assert.equal(state.baselineScore, null);
  assert.equal(await readFile(target.ts, "utf8"), target.original);
  await checkEvidence(target, state);
  return state;
}

async function failureScenarios(dir: string): Promise<void> {
  const noHash = /no baseline run established/;
  const partial = await blockedScenario(
    join(dir, "partial"),
    numericTarget({ afterCleanup: "process.exit(3);" }),
    {},
    /exited with status 3/,
    noHash,
  );
  const partialRun = trials(partial)[0]?.runs[0]?.directory as string;
  assert.ok((await readProfile(join(partialRun, "samples.jsonl"))).length > 0);
  await blockedScenario(
    join(dir, "terminal"),
    numericTarget({ check: 'typeof value === "number" && value > 100' }),
    {},
    /exited with status 1/,
    noHash,
  );
  await blockedScenario(
    join(dir, "nonce"),
    numericTarget({ nonce: '"forged"' }),
    {},
    /another nonce/,
    noHash,
  );
  await blockedScenario(
    join(dir, "receipt"),
    numericTarget({ afterCleanup: "process.exit(0);" }),
    {},
    /no valid completion receipt/,
    noHash,
  );
  const missing = /no complete measurement for an improvement goal/;
  await blockedScenario(
    join(dir, "metric"),
    numericTarget(),
    { objective: { metric: { kind: "tokens" }, direction: "minimize" } },
    /no tokens/,
    missing,
  );
  await blockedScenario(
    join(dir, "memory"),
    numericTarget(),
    { objective: { metric: { kind: "memory" }, direction: "minimize" } },
    /memory is unobserved/,
    missing,
  );

  // A zero baseline cannot anchor a relative goal, even beside another stop predicate.
  const zero = await prepare(
    join(dir, "zero"),
    numericTarget({
      code: NUMERIC_CODE("0"),
      check: 'typeof value === "number"',
    }),
  );
  const zeroRuntime = await editorRuntime([]);
  const zeroState = await optimize(
    requestFor(zero, {
      stop: {
        improvement: { kind: "relative", value: 0.1 },
        plateau: { window: 2, absoluteTolerance: 0, relativeTolerance: 0 },
      },
    }),
    zeroRuntime,
  );
  assert.equal(zeroState.stop?.kind, "blocked");
  assert.match(zeroState.stop?.reason ?? "", /zero baseline/);
  assert.equal(zeroState.baselineScore, 0);
  assert.equal(await readFile(zero.ts, "utf8"), zero.original);

  // Maximize: a lower candidate never replaces the anchor, which then converges on its target.
  const max = await prepare(join(dir, "maximize"), numericTarget());
  const maxLog: EditorLog = { states: [] };
  const maxRuntime = await editorRuntime(
    editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, maxLog),
  );
  const maxState = await optimize(
    requestFor(max, {
      objective: { metric: SCORE, direction: "maximize" },
      stop: { target: 2 },
    }),
    maxRuntime,
  );
  expectStop(maxState, "converged");
  assert.deepEqual(
    trials(maxState).map((trial) => trial.score),
    [2, 1, 2],
  );
  assert.equal(maxState.anchor.candidate.sources.scheduler, SCHED.parallel);
  assert.equal(await readFile(max.ts, "utf8"), max.prepared);

  // An explicit run budget stops non-converged and restores the original entrypoint.
  const budget = await prepare(join(dir, "budget"), numericTarget());
  const budgetRuntime = await editorRuntime(
    editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, { states: [] }),
  );
  const budgetState = await optimize(
    requestFor(budget, { stop: { target: 0 }, runBudget: 2 }),
    budgetRuntime,
  );
  assert.equal(budgetState.stop?.kind, "budget");
  assert.match(budgetState.stop?.reason ?? "", /run budget of 2/);
  assert.deepEqual(
    trials(budgetState).map((trial) => trial.score),
    [2, 1],
  );
  assert.equal(await readFile(budget.ts, "utf8"), budget.original);
  await checkEvidence(budget, budgetState);
}

async function ownershipScenario(dir: string): Promise<void> {
  const target = await prepare(dir, numericTarget());
  await chmod(target.ts, 0o600);
  const log: EditorLog = { states: [] };
  const rejected: { messages: string[]; unchanged: boolean }[] = [];
  const second: Result[][] = [];
  const edit = (info: Info, extra: Record<string, unknown>) =>
    fauxToolCall("edit_tuning", {
      ticket: info.ticket,
      axis: "limits",
      expectedTsHash: info.tsHash,
      source: limits("{ memoryBytes: 1 }"),
      reason: "probe the tool contract",
      ...extra,
    });
  const { models, editorRung } = await editorRuntime([
    ...editorTurn(
      {
        axis: "limits",
        rounds: [
          (info) => [
            edit(info, { ticket: "not-the-ticket" }),
            edit(info, { axis: "scheduler", source: SCHED.roundRobin }),
            edit(info, {
              source: `${limits("{}")}${marker("end", "limits")}\n`,
            }),
            edit(info, {
              source: "const optimizerLimits: OptimizerLimits = {;\n",
            }),
            edit(info, { source: limits("{}") }),
            edit(info, { expectedTsHash: "0".repeat(64) }),
          ],
          async (info, previous) => {
            rejected.push({
              messages: previous.map((result) =>
                result.isError ? result.text : `accepted: ${result.text}`,
              ),
              unchanged: sha256(await readFile(target.ts)) === info.tsHash,
            });
            // Two writes in one message: only the first can apply.
            return [
              edit(info, { source: limits("{ memoryBytes: 4096 }") }),
              edit(info, { source: limits("{ memoryBytes: 512 }") }),
            ];
          },
        ],
        afterEdit: (results) => {
          second.push([...results]);
        },
      },
      log,
    ),
    ...editorTurn(
      {
        axis: "limits",
        source: limits("{ memoryBytes: 512 }"),
        afterEdit: () => appendFile(target.ts, "// external edit\n"),
      },
      log,
    ),
  ]);
  const state = await optimize(requestFor(target, { axes: ["limits"] }), {
    models,
    editorRung,
  });
  expectStop(state, "blocked");
  assert.match(
    state.stop?.reason ?? "",
    /does not hold the measured configuration/,
  );
  assert.match(
    state.stop?.reason ?? "",
    /original TS not restored: .*changed outside the optimizer/,
  );
  const patterns = [
    /ticket must be/,
    /edits the limits region only/,
    /region markers/,
    /does not parse/,
    /byte-identical/,
    /stale expectedTsHash/,
  ];
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.unchanged, true);
  for (const [i, text] of (rejected[0]?.messages ?? []).entries())
    assert.match(text, patterns[i] as RegExp);
  assert.equal(rejected[0]?.messages.length, patterns.length);
  assert.equal(second[0]?.[0]?.isError, false);
  assert.equal(second[0]?.[1]?.isError, true);
  assert.match(second[0]?.[1]?.text ?? "", /already applied its one edit/);
  assert.deepEqual(
    edits(state).map((e) => [e.accepted, e.source]),
    [
      [true, limits("{ memoryBytes: 4096 }")],
      [true, limits("{ memoryBytes: 512 }")],
    ],
  );
  // The out-of-bound candidate failed inside the child before it could run.
  const [, unbounded] = trials(state);
  assert.equal(unbounded?.runs[0]?.status, "failed");
  assert.match(
    await readFile(
      join(unbounded?.runs[0]?.directory as string, "target.stderr"),
      "utf8",
    ),
    /limit memoryBytes=4096 is outside its bound 1024/,
  );
  const saved = await readFile(target.ts, "utf8");
  assert.equal(
    saved,
    `${withRegions(target.prepared, { limits: limits("{ memoryBytes: 512 }") })}// external edit\n`,
  );
  assert.equal((await stat(target.ts)).mode & 0o777, 0o600);
  assert.deepEqual(
    await readFile(target.yaml),
    await readFile(join(target.sessionDir, "original.yml")),
  );
}

async function driftScenario(dir: string): Promise<void> {
  const target = await prepare(
    dir,
    numericTarget({
      yaml: NUMERIC_YAML("{{ params.label }}"),
      params:
        'JSON.parse(await readFile(new URL("./params.json", import.meta.url), "utf8"))',
    }),
  );
  const params = join(dir, "params.json");
  await writeFile(params, JSON.stringify({ label: "first" }));
  const { models, editorRung } = await editorRuntime(
    editorTurn(
      {
        axis: "scheduler",
        source: SCHED.roundRobin,
        afterEdit: () => writeFile(params, JSON.stringify({ label: "second" })),
      },
      { states: [] },
    ),
  );
  const state = await optimize(
    requestFor(target, { stop: { target: 0 }, runBudget: 2 }),
    {
      models,
      editorRung,
    },
  );
  expectStop(state, "budget");
  const drifted = trials(state)[1]?.runs[0];
  assert.equal(drifted?.status, "failed");
  const directory = drifted?.directory as string;
  assert.match(
    await readFile(join(directory, "target.stderr"), "utf8"),
    /drifted from the baseline/,
  );
  assert.equal(existsSync(join(directory, "samples.jsonl")), false);
  assert.equal(await readFile(target.ts, "utf8"), target.original);
}

async function cancelScenario(dir: string): Promise<void> {
  const target = await prepare(
    dir,
    numericTarget({
      header: 'import { spawn } from "node:child_process";',
      beforeBuild: `if (RUN_DIR !== undefined) {
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  await writeFile(join(RUN_DIR, "sleeper.pid"), String(sleeper.pid));
  await new Promise(() => setInterval(() => {}, 1000));
}`,
    }),
  );
  const { models, editorRung } = await editorRuntime([]);
  const controller = new AbortController();
  const pidFile = join(target.sessionDir, "runs", "0001", "sleeper.pid");
  const watcher = (async () => {
    while (!existsSync(pidFile)) await sleep(20);
    await sleep(50);
    controller.abort(new Error("cancelled by the fixture"));
  })();
  const state = await optimize(requestFor(target), {
    models,
    editorRung,
    signal: controller.signal,
  });
  await watcher;
  expectStop(state, "cancelled");
  assert.equal(trials(state)[0]?.runs[0]?.status, "cancelled");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(await readFile(target.ts, "utf8"), target.original);
  assert.deepEqual(await readState(target.sessionDir), state);
}

// --- package boundaries ----------------------------------------------------------------------------

async function exec(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [command, ...args] = argv as [string, ...string[]];
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const { promise, resolve: done } = Promise.withResolvers<number | null>();
  child.once("close", done);
  const code = await promise;
  return { code, stdout, stderr };
}

async function boundaryChecks(dir: string): Promise<void> {
  const target = await prepare(dir, numericTarget());
  const request = requestFor(target);
  const portable = `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import "junco-agent";
import "junco-tools";
import "junco-scheduler";
import "junco-mcp";
const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));
const addons = Object.keys(require.cache).filter((path) => path.endsWith(".node"));
const { schedules } = await import(${JSON.stringify(join(ROOT, "dist", "index.js"))});
assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal)), listeners);
assert.deepEqual(Object.keys(require.cache).filter((path) => path.endsWith(".node")), addons);
await assert.rejects(schedules.runOptimizer(${JSON.stringify(request)}), { message: "runOptimizer requires Bun" });
assert.equal(existsSync(${JSON.stringify(join(target.sessionDir, "state.json"))}), false);
process.stderr.write("NODE_BOUNDARY_OK");
`;
  const node = await exec(["node", "--input-type=module", "--eval", portable], {
    ...process.env,
    NAPI_RS_NATIVE_LIBRARY_PATH: join(
      dir,
      "junco-tui-binding-does-not-exist.node",
    ),
  });
  assert.equal(node.code, 0, node.stderr);
  assert.equal(node.stdout, "");
  assert.equal(node.stderr, "NODE_BOUNDARY_OK");

  const malformed = join(dir, "malformed.json");
  await writeFile(malformed, "{ not json");
  const cli = await exec([
    process.execPath,
    "run",
    join(ROOT, "dist", "optimizer-cli.js"),
    malformed,
  ]);
  assert.equal(cli.code, 1);
  assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /invalid request/);
  assert.equal(existsSync(join(target.sessionDir, "state.json")), false);
}

const main = async () => {
  // .junco/ is gitignored scratch space: absent in a clean checkout.
  await mkdir(join(ROOT, ".junco"), { recursive: true });
  const root = await mkdtemp(join(ROOT, ".junco", "profile-optimizer-check-"));
  let ok = false;
  try {
    await checkMetrics(join(root, "metrics"));
    await boundaryChecks(join(root, "boundaries"));
    await numericScenario(join(root, "numeric"));
    await tokenScenario(join(root, "tokens"));
    await failureScenarios(join(root, "failures"));
    await ownershipScenario(join(root, "ownership"));
    await driftScenario(join(root, "drift"));
    await cancelScenario(join(root, "cancel"));
    ok = true;
  } finally {
    if (ok) await rm(root, { recursive: true, force: true });
    else
      console.error(
        `profile optimizer check failed; artifacts retained at ${root}`,
      );
  }
  console.log("PROFILE_OPTIMIZER_CHECK_OK");
};

if (import.meta.main) await main();
