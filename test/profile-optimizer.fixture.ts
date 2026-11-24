// The profile optimizer's single executable check: metric and statistics boundaries, the promotion
// oracle, then `schedules.runOptimizer` from the built package driving real child targets,
// recorders, code nodes and a faux-backed persistent editor through convergence, coordinate
// descent, novelty, score-table, failure and ownership scenarios; plus the Node import boundary and
// the built CLI's malformed-input exit. Offline: the editor and the target agents are scripted faux
// providers, so no measurement here is a real-world saving.
// Run with JUNCO_BTRFS_TEST_ROOT pointing to a writable Btrfs directory mounted with user_subvol_rm_allowed.
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
  rename,
  rm,
  stat,
  symlink,
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
  getCurrentTools,
  InMemoryCredentialStore,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { schedules } from "../dist/index.js";
import { improves } from "../src/std/schedules/optimizer.js";
import {
  distribution,
  isStable,
  type Metric,
  readProfile,
  summarize,
  type TrialStatistics,
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
const transpiler = new Bun.Transpiler({ loader: "ts" });
/** The fixture's own triplet identity: per-region transpiled-JS hashes and their combined key. */
function identityOf(sources: Record<Axis, string>) {
  const triplet = {
    ladder: sha256(transpiler.transformSync(sources.ladder)),
    scheduler: sha256(transpiler.transformSync(sources.scheduler)),
    limits: sha256(transpiler.transformSync(sources.limits)),
  };
  return {
    triplet,
    key: sha256(
      JSON.stringify([triplet.ladder, triplet.scheduler, triplet.limits]),
    ),
  };
}
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
  const cost: Metric = { kind: "cost" };
  const resolved: Metric = { kind: "result", name: "resolved" };
  const row = (value: object) =>
    JSON.stringify({ features: {}, units: {}, resources: {}, ...value });
  const resources = await readProfile(
    await file("resources.jsonl", [
      row({
        node: "A",
        resources: { tokens: 100, memory: 1, cost: 0.25 },
        units: { tokens: "tok", memory: "KiB", cost: "USD" },
      }),
      "",
      "   ",
      row({
        node: "B",
        resources: { tokens: 50, memory: 512, cost: 0.5 },
        units: { tokens: "tok", memory: "B", cost: "USD" },
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
  assert.deepEqual(summarize(resources, cost), {
    value: 0.75,
    unit: "USD",
    count: 2,
  });
  assert.deepEqual(summarize([], resolved, { resolved: 0 }), {
    value: 0,
    unit: null,
    count: 1,
  });
  for (const results of [
    undefined,
    {},
    { other: 60 },
    Object.create({ resolved: 60 }),
  ])
    assert.throws(() => summarize([], resolved, results), /no result/);
  for (const value of ["60", null, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(
      () =>
        summarize([], resolved, { resolved: value } as Record<string, number>),
      /finite number/,
    );

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
    [
      "negative-cost",
      [row({ node: "A", resources: { cost: -1 }, units: { cost: "USD" } })],
      /line 1/,
    ],
    [
      "cost-unit",
      [row({ node: "A", resources: { cost: 1 }, units: { cost: "EUR" } })],
      /line 1/,
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
  assert.throws(() => summarize(probes, cost), /no cost/);
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

// --- batch statistics and the promotion oracle ---------------------------------------------------

function checkStatistics(): void {
  assert.deepEqual(distribution([1, 2, 3]), {
    mean: 2,
    standardDeviation: 1,
    repeats: 3,
  });
  assert.deepEqual(distribution([2, 4]), {
    mean: 3,
    standardDeviation: Math.SQRT2,
    repeats: 2,
  });
  assert.deepEqual(distribution([7, 7, 7]), {
    mean: 7,
    standardDeviation: 0,
    repeats: 3,
  });
  for (const values of [
    [],
    [1],
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ])
    assert.throws(() => distribution(values), RangeError);

  const stats = (objective: number[], quality: number[]): TrialStatistics => ({
    objective: distribution(objective),
    constraints: [distribution(quality)],
  });
  const request = (op: "<=" | ">=", qualityConstraint?: number) =>
    ({
      objective: { metric: SCORE, direction: "minimize" },
      constraints: [{ metric: QUALITY, op, threshold: 0 }],
      qualityConstraint,
    }) as Request;
  // Minimized cost with a higher-is-better quality; equal deviations keep pooled SDs 10 and 1.
  const both = request(">=", 0);
  const reference = stats([90, 100, 110], [9, 10, 11]);
  for (const [objective, quality, expected] of [
    [[80, 90, 100], [9, 10, 11], true],
    [[90, 100, 110], [10, 11, 12], true],
    [[80.001, 90.001, 100.001], [9, 10, 11], false],
    [[90, 100, 110], [9.999, 10.999, 11.999], false],
    [[80, 90, 100], [8.999, 9.999, 10.999], false],
    [[90.001, 100.001, 110.001], [10, 11, 12], false],
    [[90, 100, 110], [9, 10, 11], false],
    [[80, 90, 100], [10, 11, 12], true],
    // A wider candidate spread raises the pooled SD to sqrt(250), above the gain of 10.
    [[70, 90, 110], [9, 10, 11], false],
  ] as [number[], number[], boolean][])
    assert.equal(
      improves(both, reference, stats(objective, quality)),
      expected,
      `cost ${objective}, quality ${quality}`,
    );
  // Zero spread: equal means never promote; any strictly positive gain does.
  const objectiveOnly = request(">=");
  const flat = stats([5, 5], [1, 1]);
  assert.equal(improves(objectiveOnly, flat, stats([5, 5], [1, 1])), false);
  assert.equal(
    improves(objectiveOnly, flat, stats([4.999, 4.999], [1, 1])),
    true,
  );
  // Without a designated quality, only the objective is compared.
  assert.equal(
    improves(objectiveOnly, reference, stats([80, 90, 100], [0, 1, 2])),
    true,
  );
  // A `<=` quality is better lower.
  const lower = request("<=", 0);
  assert.equal(
    improves(lower, reference, stats([90, 100, 110], [8, 9, 10])),
    true,
  );
  assert.equal(
    improves(lower, reference, stats([80, 90, 100], [10, 11, 12])),
    false,
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
  readonly parameters?: string;
  /** A boolean expression over the terminal `value`: the workflow's existing assertion. */
  readonly check: string;
  readonly beforeBuild?: string;
  readonly afterCleanup?: string;
  readonly nonce?: string;
  readonly metrics?: string;
  readonly receiptFields?: string;
  readonly afterRun?: string;
};

/** The instrumented entrypoint the skill prepares, per references/profiling.md. */
const preparedSource = (
  p: TargetParts,
): string => `// Fixture target generated by test/profile-optimizer.fixture.ts.
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytes, tokens } from "dataflow-engine";
import { Deterministic, graph, JuncoGraph, schedules, syntax, tracer } from "junco";
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

  /** \`document\` with probe: true on each requested existing numeric edge, revalidated. */
  withProbes(document: syntax.JuncoDocument): syntax.JuncoDocument {
    if (this.request === undefined) return document;
    const copy = structuredClone(document);
    for (const { node, edgeId } of this.request.probes) {
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

  /** A fresh candidate policy: tuned scheduler, optional strength, extra limits, hard limits outermost. */
  scheduler(label: string, graphPath: string) {
    // Candidates may still ignore graphPath; the build passes both arguments.
    const factory: syntax.JuncoParameters["scheduler"] = optimizerScheduler;
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

  /** This run's profile recorder; undefined when inactive. */
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
      \`\${receipt}.tmp\`,
      JSON.stringify({ version: 1, nonce: ${p.nonce ?? "this.request.nonce"}, terminal: true, graphHash, resourceEvents, ...(metrics === undefined ? {} : { metrics }), ...(${p.receiptFields ?? "{}"}) }),
      { flag: "wx" },
    );
    await rename(\`\${receipt}.tmp\`, receipt);
  }

  /** The candidate's concrete ladder and extra limits stay inside the run's authorized domain. */
  #checkTuning(run: ProfileRun): void {
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
}

${p.code}

const profile = await OptimizerProfile.load();
const yamlText = await readFile(new URL("./workflow.yml", import.meta.url), "utf8");
const document = syntax.parse(yamlText, { params: PARAMS, sourceName: "workflow.yml" });
const graphHash = profile.validate(document);
${p.beforeBuild ?? ""}
const recorder = profile.createRecorder("usage");
const observer = new tracer.DummyTracer();
let resourceEvents = 0;
const failures: unknown[] = [];
let execution: Awaited<ReturnType<typeof JuncoGraph.fromYaml>> | undefined;
try {
  execution = await JuncoGraph.fromYaml(profile.withProbes(document), {
    args: { cwd: import.meta.dir, tracer: observer, code: CODE, ...(recorder === undefined ? {} : { recorder }) },
    parameters: {
      scheduler: (label, graphPath) => profile.scheduler(label, graphPath),
      ${p.parameters ?? ""}
    },
  });
  await execution.run();
  const result = execution.graph.result(execution.graph.sink.id);
  const value = result._tag === "Some" ? result.value : undefined;
  if (!(${p.check})) throw new Error(\`terminal check failed: \${String(value)}\`);
  ${p.afterRun ?? ""}
} catch (error) {
  failures.push(error);
}
for (const close of [() => execution?.graph.close(), () => recorder?.close()])
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
if (failures.length > 0) throw new AggregateError(failures, "workflow run failed");
${p.afterCleanup ?? ""}
await profile.complete(graphHash, resourceEvents${p.metrics === undefined ? "" : `, ${p.metrics}`});
`;

const NUMERIC_YAML = (description = "Reports peak concurrency.") => `graph:
  name: NumericTarget
  nodes:
    Seed: { kind: code, trigger: always }
    A: { kind: code }
    B: { kind: code }
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

const NUMERIC_CODE = (terminal = "peak", quality = "0.95") => `let active = 0;
let peak = 0;
const worker: syntax.DeterministicNode = ({ policy }) => new Deterministic(async function* () {
  yield [];
  active++;
  peak = Math.max(peak, active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    active--;
  }
  return 1;
}, policy);
const CODE: Record<string, syntax.DeterministicNode> = {
  Seed: ({ edges, policy }) => new Deterministic(async function* () {
    return new graph.FinalMessages(["Seed~>A", "Seed~>B"].map((id) => graph.Message.create(edges.get(id)!, 1)));
  }, policy),
  A: worker,
  B: worker,
  Quality: ({ policy }) => new Deterministic(async function* () {
    const view = yield [];
    if (view.values.get("A->Quality") !== 1 || view.values.get("B->Quality") !== 1)
      throw new Error("Quality requires both inputs");
    return ${quality};
  }, policy),
  Terminal: ({ policy }) => new Deterministic(async function* () {
    const view = yield [];
    if (view.values.get("quality") !== ${quality}) throw new Error("quality check failed");
    return ${terminal};
  }, policy),
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
  repeats: 2,
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

/** One scripted editor turn: read the steered state, read_target, edit rounds, then settle. */
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
    (context) => {
      const granted = new Set(
        getCurrentTools(context.messages).map((tool) => tool.name),
      );
      assert.ok(granted.has("read_target") && granted.has("edit_tuning"));
      for (const blocked of ["bash", "edit", "read", "release", "task"])
        assert.ok(!granted.has(blocked));
      const message = context.messages.at(-1);
      assert.ok(message?.role === "user", "the editor received no assignment");
      const assignment = JSON.parse(
        typeof message.content === "string"
          ? message.content
          : contentText(message.content),
      );
      assert.equal(assignment.id, "editor-assignment");
      state = assignment.payload;
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

/** One score-table row per attempted trial, in order: exactly its finalized history entry. */
async function checkScores(sessionDir: string, state: State): Promise<void> {
  const text = await readFile(join(sessionDir, "scores.jsonl"), "utf8");
  const rows =
    text === ""
      ? []
      : text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows,
    trials(state)
      .filter((trial) => trial.runs.length > 0)
      .map((trial) => ({ version: 1, key: trial.candidate.key, ...trial })),
  );
}

/**
 * Every trial's identity reproduces its saved bytes and normalized triplet, each ok run's summary
 * its own profile, each complete batch its statistics and per-run feasibility, every batch fresh
 * runs, and the score table the history.
 */
async function checkEvidence(target: Prepared, state: State): Promise<void> {
  const { request } = state;
  const numbers = trials(state).flatMap((trial) =>
    trial.runs.map((run) => run.run),
  );
  assert.deepEqual(
    numbers,
    numbers.map((_, i) => i + 1),
  );
  for (const trial of trials(state)) {
    assert.equal(
      sha256(withRegions(target.prepared, trial.candidate.sources)),
      trial.candidate.tsHash,
    );
    const { triplet, key } = trial.candidate;
    assert.deepEqual({ triplet, key }, identityOf(trial.candidate.sources));
    for (const run of trial.runs) {
      if (run.status !== "ok") continue;
      const samples = await readProfile(join(run.directory, "samples.jsonl"));
      const { metrics } = JSON.parse(
        await readFile(join(run.directory, "completion.json"), "utf8"),
      );
      assert.deepEqual(
        summarize(samples, request.objective.metric, metrics),
        run.objective,
      );
      for (const [i, { metric }] of request.constraints.entries())
        assert.deepEqual(
          summarize(samples, metric, metrics),
          run.constraints[i],
        );
    }
    if (trial.stats === null) {
      assert.equal(trial.score, null);
      assert.equal(trial.feasible, false);
      continue;
    }
    const values = (pick: (run: Trial["runs"][number]) => number | undefined) =>
      distribution(trial.runs.map((run) => pick(run) ?? Number.NaN));
    assert.deepEqual(trial.stats, {
      objective: values((run) => run.objective?.value),
      constraints: request.constraints.map((_, i) =>
        values((run) => run.constraints[i]?.value),
      ),
    });
    assert.equal(trial.score, trial.stats.objective.mean);
    assert.equal(
      trial.feasible,
      trial.runs.every((run) =>
        request.constraints.every(({ op, threshold }, i) => {
          const value = run.constraints[i]?.value as number;
          return op === ">=" ? value >= threshold : value <= threshold;
        }),
      ),
    );
  }
  assert.deepEqual(
    await readFile(target.yaml),
    await readFile(join(target.sessionDir, "original.yml")),
  );
  assert.deepEqual(await readState(target.sessionDir), state);
  await checkScores(target.sessionDir, state);
}

/** Each accepted proposal changes only its assigned region of the incumbent it was handed. */
function checkCoordinates(state: State, log: EditorLog): void {
  for (const handed of log.states) {
    const edit = state.history[handed.history.length];
    if (edit?.kind !== "edit" || !edit.accepted) continue;
    const trial = state.history[handed.history.length + 1];
    assert.equal(trial?.kind === "trial" && trial.phase, "candidate");
    const { sources } = (trial as Trial).candidate;
    const incumbent = handed.anchor.candidate.sources;
    for (const axis of AXES)
      if (axis === edit.axis) assert.notEqual(sources[axis], incumbent[axis]);
      else assert.equal(sources[axis], incumbent[axis]);
  }
}

// --- numeric convergence -------------------------------------------------------------------------

/** Check the on-disk ticket and trial directories while the successful tool result awaits settlement. */
async function holdSettlement(target: { sessionDir: string }, info: Info) {
  const before = await runDirs(target.sessionDir);
  await sleep(300);
  const checkpoint = await readState(target.sessionDir);
  assert.equal(await runDirs(target.sessionDir), before);
  assert.equal(checkpoint.editTicket, info.ticket);
  assert.ok(!edits(checkpoint).some((edit) => edit.ticket === info.ticket));
}

async function numericScenario(dir: string): Promise<void> {
  const target = await prepare(dir, numericTarget());
  await chmod(target.ts, 0o640);
  const log: EditorLog = { states: [] };
  const { models, editor, editorRung } = await editorRuntime([
    ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
    ...editorTurn({ axis: "limits" }, log),
    ...editorTurn(
      {
        axis: "limits",
        source: limits("{ memoryBytes: 1 }"),
        afterEdit: (_, info) => holdSettlement(target, info),
      },
      log,
    ),
    ...editorTurn(
      {
        axis: "scheduler",
        source: SCHED.choose,
        afterEdit: (_, info) => holdSettlement(target, info),
      },
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
    // Repeats count batch executions; a run's summary count its in-run contributors.
    assert.equal(trial.stats?.objective.repeats, 3);
    for (const run of trial.runs) {
      assert.equal(run.constraints[0]?.value, 0.95);
      assert.equal(run.objective?.count, 1);
    }
  }
  // Host-owned remeasurement and confirmation repeat the incumbent's key.
  const [, promoted, , remeasure, , , confirmation] = trials(state);
  assert.equal(remeasure?.candidate.key, promoted?.candidate.key);
  assert.equal(confirmation?.candidate.key, promoted?.candidate.key);
  checkCoordinates(state, log);
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
// --- per-request cost and fixed external outcomes -------------------------------------------------

const COST_HEADER = (
  stopReason = "toolUse",
) => `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
const schedulerProvider = fauxProvider({ api: "cost-scheduler", provider: "target", models: [{ id: "cheap" }] });
const schedulerSource = {};
function optimizerPi(model: string, thinking?: schedules.LadderRung["thinking"]) {
  if (profile.request !== undefined && !profile.request.allowedModels.some((allowed) => allowed.model === model && allowed.thinking === thinking))
    throw new Error(\`scheduler uses unauthorized \${model}/\${thinking ?? "default"}\`);
  const selected = schedulerProvider.getModel();
  if (model !== \`\${selected.provider}/\${selected.id}\`) throw new Error("unknown scheduler model");
  return schedules.pi({
    model: selected,
    ...(thinking === undefined ? {} : { streamOptions: { reasoning: thinking } }),
    models: {
      completeSimple: async (_model, context) => {
        const message = context.messages.at(-1);
        if (message?.role !== "user" || typeof message.content !== "string") throw new Error("missing scheduler snapshot");
        const snapshot = JSON.parse(message.content.slice("SchedulerSnapshot:\\n".length));
        const response = fauxAssistantMessage(
          fauxToolCall("schedule", { waves: snapshot.nodes.map((node: { id: string }) => [node.id]) }),
          { stopReason: ${JSON.stringify(stopReason)} },
        );
        const usage = { ...response.usage, cost: { ...response.usage.cost, total: 0.25 } };
        // Meter returned usage before schedules.pi checks cancellation, stop reason or output.
        recorder?.add_context("Scheduler").record({ resource: "cost", kind: "usage", source: schedulerSource, usage });
        return { ...response, usage };
      },
    },
  });
}
`;
const PI_SCHED =
  'const optimizerScheduler = (_label: string) => optimizerPi("target/cheap");\n';
const COST_USAGE = `const usage = fauxAssistantMessage("").usage;
  recorder?.add_context("Solver").record({
    resource: "cost", kind: "usage", source: {},
    usage: { ...usage, cost: { ...usage.cost, total: peak * 100 } },
  });`;
const RESOLVED: Metric = { kind: "result", name: "resolved" };
const costTarget = (extra: Partial<TargetParts> = {}): TargetParts =>
  numericTarget({
    header: COST_HEADER(),
    afterRun: COST_USAGE,
    metrics: "{ resolved: peak === 1 ? 60 : 59, attempted: 60 }",
    ...extra,
  });

async function costResultScenario(dir: string): Promise<void> {
  const target = await prepare(dir, costTarget());
  const log: EditorLog = { states: [] };
  // The promotion forces a second cycle; its two-wide round robin is infeasible like the baseline.
  const runtime = await editorRuntime(
    [
      ...editorTurn({ axis: "scheduler", source: PI_SCHED }, log),
      ...editorTurn(
        {
          axis: "scheduler",
          afterEdit: (_, info) => holdSettlement(target, info),
          source:
            "const optimizerScheduler = (_label: string) => schedules.roundRobin(undefined, 2);\n",
        },
        log,
      ),
    ],
    ["cheap"],
  );
  const state = await optimize(
    requestFor(target, {
      objective: { metric: { kind: "cost" }, direction: "minimize" },
      constraints: [{ metric: RESOLVED, op: ">=", threshold: 60 }],
      repeats: 2,
      stop: { target: 110 },
      allowedModels: [{ model: "target/cheap" }],
      runBudget: 10,
    }),
    runtime,
  );
  expectStop(state, "converged");
  assert.equal(runtime.editor.getPendingResponseCount(), 0);
  assert.equal(state.baselineScore, 200);
  assert.equal(log.states[0]?.anchor.score, null);
  assert.deepEqual(
    trials(state).map((trial) => [trial.phase, trial.feasible]),
    [
      ["baseline", false],
      ["candidate", true],
      ["remeasure", true],
      ["candidate", false],
      ["confirmation", true],
    ],
  );
  assert.equal(await runDirs(target.sessionDir), 10);
  for (const trial of trials(state))
    for (const run of trial.runs) {
      assert.equal(run.status, "ok");
      assert.equal(run.objective?.unit, "USD");
      assert.equal(run.constraints[0]?.value, trial.feasible ? 60 : 59);
      const request = JSON.parse(
        await readFile(join(run.directory, "request.json"), "utf8"),
      );
      assert.deepEqual(request.allowedModels, [{ model: "target/cheap" }]);
      const samples = await readProfile(join(run.directory, "samples.jsonl"));
      const scheduler = samples.filter((sample) => sample.node === "Scheduler");
      if (trial.candidate.sources.scheduler !== PI_SCHED)
        assert.equal(scheduler.length, 0);
      else {
        assert.ok(scheduler.length > 0);
        assert.equal(
          summarize(scheduler, { kind: "cost" }).value,
          scheduler.length * 0.25,
        );
        assert.equal(run.objective?.value, 100 + scheduler.length * 0.25);
      }
    }
  checkCoordinates(state, log);
  await checkEvidence(target, state);
  assert.equal(
    await readFile(target.ts, "utf8"),
    withRegions(target.prepared, state.anchor.candidate.sources),
  );
  assert.ok(
    summarize(await readProfile(join(target.sessionDir, "optimizer.jsonl")), {
      kind: "cost",
    }).count > 0,
  );
}

// --- tokens and model ladder -----------------------------------------------------------------------

const TOKEN_YAML = `graph:
  name: ReportTarget
  nodes:
    Assignment: { kind: emit, text: Write the status report., spec: A completed status report. }
    Writer:
      prompt: Write the status report.
      tool_block: [read, bash, edit, release, grep, find, ast_grep, ast_edit, diff, code_graph]
      trigger: "Assignment~>Writer"
    Quality: { kind: code }
    Terminal: { kind: code }
  edges:
    - { from: Assignment, to: Writer, kind: message, schema: { type: object } }
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
  Quality: ({ policy }) => new Deterministic(async function* () {
    const view = yield [];
    const report = view.values.get("Writer->Quality") as { content: Parameters<typeof contentText>[0] };
    let quality = Number(/quality=([0-9.]+)/.exec(contentText(report.content))?.[1]);
    if (profile.directory !== undefined) {
      // Synthetic flake for the fixture: the first confirmation batch reads lower quality.
      const state = JSON.parse(await readFile(join(profile.directory, "..", "..", "state.json"), "utf8"));
      const phases = state.history.filter((item) => item.kind === "trial").map((item) => item.phase);
      if (phases.at(-1) === "confirmation" && phases.filter((phase) => phase === "confirmation").length === 1)
        quality = 0.85;
    }
    return quality;
  }, policy),
  Terminal: ({ policy }) => new Deterministic(async function* () {
    const view = yield [];
    if (typeof view.values.get("quality") !== "number") throw new Error("missing quality");
    return 1;
  }, policy),
};`;

const ladderOf = (med: string) =>
  `const optimizerLadder: schedules.Ladder | undefined = {\n  ...schedules.uniformLadder({ model: "target/large" }),\n  med: { model: "target/${med}" },\n};\nconst optimizerStrength = undefined;\n`;
const UNIFORM_SMALL =
  'const optimizerLadder: schedules.Ladder | undefined = schedules.uniformLadder({ model: "target/small" });\nconst optimizerStrength = undefined;\n';

async function tokenScenario(dir: string): Promise<void> {
  const target = await prepare(dir, {
    yaml: TOKEN_YAML,
    header: TOKEN_HEADER,
    scheduler: SCHED.parallel,
    ladder: ladderOf("large"),
    limits: limits("{}"),
    hardLimits: "{ tokens: tokens(100_000) }",
    code: TOKEN_CODE,
    beforeBuild:
      "const ladder = new schedules.ModelLadder(models, optimizerLadder!);",
    parameters: "ladder,",
    check: "value === 1",
  });
  const log: EditorLog = { states: [] };
  const tokenCap = (n: number) => limits(`{ tokens: ${n} }`);
  const capEdit = (info: Info, n: number) =>
    fauxToolCall("edit_tuning", {
      ticket: info.ticket,
      axis: "limits",
      expectedTsHash: info.tsHash,
      source: tokenCap(n),
      reason: `cap tokens at ${n}`,
    });
  const repeated: { messages: string[]; unchanged: boolean }[] = [];
  const runsBefore: number[] = [];
  const { models, editorRung } = await editorRuntime(
    [
      // Cycle 0: an equal scheduler, a cheaper used rung (promoted), a failing then an equal limit.
      ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
      ...editorTurn({ axis: "ladder", source: ladderOf("small") }, log),
      ...editorTurn({ axis: "limits", source: tokenCap(1_000) }, log),
      ...editorTurn({ axis: "limits", source: tokenCap(10_000) }, log),
      // Cycle 1: no promotion; the cheapest rung fails quality; confirmation then flakes. The same
      // scheduler source beside the promoted ladder is a new triplet; the failed and the measured
      // caps beside it are not, so the limits turn needs a third proposal.
      ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
      ...editorTurn({ axis: "ladder", source: ladderOf("tiny") }, log),
      ...editorTurn(
        {
          axis: "limits",
          rounds: [
            async (info) => {
              runsBefore.push(await runDirs(target.sessionDir));
              return [capEdit(info, 1_000), capEdit(info, 10_000)];
            },
            async (info, previous) => {
              repeated.push({
                messages: previous.map((result) =>
                  result.isError ? result.text : `accepted: ${result.text}`,
                ),
                unchanged:
                  sha256(await readFile(target.ts)) === info.tsHash &&
                  (await runDirs(target.sessionDir)) === runsBefore[0],
              });
              return [capEdit(info, 12_000)];
            },
          ],
        },
        log,
      ),
      // Cycle 2: exploration resumes; confirmation passes on the saved 'small' configuration.
      ...editorTurn({ axis: "scheduler", source: SCHED.choose }, log),
      ...editorTurn({ axis: "ladder", source: UNIFORM_SMALL }, log),
      ...editorTurn({ axis: "limits", source: tokenCap(14_000) }, log),
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
    "candidate:ladder:true:small",
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
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]?.unchanged, true);
  assert.equal(repeated[0]?.messages.length, 2);
  for (const text of repeated[0]?.messages ?? [])
    assert.match(
      text,
      /triplet [0-9a-f]{64} was already tried; propose a different limits configuration/,
    );
  // One scheduler source, two ladders: equal component hashes, distinct triplets.
  assert.equal(
    rest[0]?.candidate.triplet.scheduler,
    rest[5]?.candidate.triplet.scheduler,
  );
  assert.notEqual(rest[0]?.candidate.key, rest[5]?.candidate.key);
  checkCoordinates(state, log);
  await checkEvidence(target, state);
  assert.equal(
    await readFile(target.ts, "utf8"),
    withRegions(target.prepared, state.anchor.candidate.sources),
  );
}

// --- statistical promotion and the score table ------------------------------------------------------

/** Synthetic per-run score and quality, indexed by child-run number, independent of the tuning. */
const runTable = (
  scores: readonly number[],
  qualities: readonly number[],
): TargetParts =>
  numericTarget({
    beforeBuild:
      'const RUN = Number(profile.directory?.split("/").at(-1)) - 1;',
    code: NUMERIC_CODE(
      `${JSON.stringify(scores)}[RUN]`,
      `${JSON.stringify(qualities)}[RUN]`,
    ),
    check: 'typeof value === "number"',
  });

async function statisticsScenario(dir: string): Promise<void> {
  const batches: [scores: number[], qualities: number[]][] = [
    [
      [90, 100, 110],
      [9, 10, 11],
    ], // baseline
    [
      [60, 70, 80],
      [12, 12, 6],
    ], // C1: one run below the floor, though the mean passes
    [
      [80, 90, 100],
      [8.999, 9.999, 10.999],
    ], // C2: one-SD saving, slightly worse quality
    [
      [90, 100, 110],
      [9, 10, 11],
    ], // remeasure
    [
      [80, 90, 100],
      [9, 10, 11],
    ], // C3: exact one-SD saving
    [
      [80, 90, 100],
      [10, 11, 12],
    ], // C4: exact one-SD quality gain
    [
      [80, 90, 100],
      [10, 11, 12],
    ], // remeasure
    [
      [80, 90, 100],
      [10, 11, 12],
    ], // C5: unchanged
    [
      [70.001, 80.001, 90.001],
      [10, 11, 12],
    ], // C6: sub-SD saving
    [
      [80, 90, 100],
      [10, 11, 12],
    ], // confirmation
  ];
  const target = await prepare(
    dir,
    runTable(
      batches.flatMap(([scores]) => scores),
      batches.flatMap(([, qualities]) => qualities),
    ),
  );
  const log: EditorLog = { states: [] };
  const repeated: { messages: string[]; unchanged: boolean }[] = [];
  const scheduler = (info: Info, source: string) =>
    fauxToolCall("edit_tuning", {
      ticket: info.ticket,
      axis: "scheduler",
      expectedTsHash: info.tsHash,
      source,
      reason: "try a scheduler",
    });
  let runsBefore = 0;
  const { models, editor, editorRung } = await editorRuntime([
    ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
    ...editorTurn(
      { axis: "limits", source: limits("{ memoryBytes: 1 }") },
      log,
    ),
    ...editorTurn(
      {
        axis: "scheduler",
        rounds: [
          // The infeasible triplet, then it and the baseline only reformatted or re-annotated.
          async (info) => {
            runsBefore = await runDirs(target.sessionDir);
            return [
              scheduler(info, SCHED.roundRobin),
              scheduler(
                info,
                "// the earlier proposal, reformatted\nconst optimizerScheduler = (_label: string) =>\n  schedules.roundRobin( undefined, 1 ) ;\n",
              ),
              scheduler(
                info,
                "const optimizerScheduler = (_label: string): unknown => schedules.parallel();\n",
              ),
            ];
          },
          async (info, previous) => {
            repeated.push({
              messages: previous.map((result) =>
                result.isError ? result.text : `accepted: ${result.text}`,
              ),
              unchanged:
                sha256(await readFile(target.ts)) === info.tsHash &&
                (await runDirs(target.sessionDir)) === runsBefore,
            });
            return [scheduler(info, SCHED.choose)];
          },
        ],
      },
      log,
    ),
    ...editorTurn(
      { axis: "limits", source: limits("{ memoryBytes: 2 }") },
      log,
    ),
    ...editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, log),
    ...editorTurn(
      { axis: "limits", source: limits("{ memoryBytes: 3 }") },
      log,
    ),
  ]);
  const state = await optimize(
    requestFor(target, {
      constraints: [{ metric: QUALITY, op: ">=", threshold: 8.5 }],
      qualityConstraint: 0,
      repeats: 3,
      stop: { improvement: { kind: "relative", value: 0.05 } },
      axes: ["scheduler", "limits"],
    }),
    { models, editorRung },
  );
  expectStop(state, "converged");
  assert.equal(editor.getPendingResponseCount(), 0);
  const all = trials(state);
  assert.deepEqual(
    all.map((trial) => `${trial.phase}:${trial.axis}:${trial.feasible}`),
    [
      "baseline:null:true",
      "candidate:scheduler:false",
      "candidate:limits:true",
      "remeasure:null:true",
      "candidate:scheduler:true",
      "candidate:limits:true",
      "remeasure:null:true",
      "candidate:scheduler:true",
      "candidate:limits:true",
      "confirmation:null:true",
    ],
  );
  assert.equal(all[1]?.stats?.constraints[0]?.mean, 10);
  // The incumbent each assignment was handed: only C3 and C4 promoted, each from fresh evidence.
  const [base, c1, , first, c3, c4, second, c5] = all as Trial[];
  assert.deepEqual(
    log.states.map((s) => s.anchor.candidate.key),
    [base, base, base, c3, c4, c4].map((trial) => trial?.candidate.key),
  );
  assert.deepEqual(
    log.states.map((s) => s.anchor.stats),
    [base, base, first, c3, second, second].map((trial) => trial?.stats),
  );
  // The rejected infeasible candidate's bytes are gone before the next proposal.
  assert.equal(log.states[1]?.current.key, base?.candidate.key);
  assert.deepEqual(state.anchor.candidate.sources, {
    scheduler: SCHED.choose,
    ladder: NO_LADDER,
    limits: limits("{ memoryBytes: 2 }"),
  });
  assert.deepEqual(state.anchor.stats?.objective, {
    mean: 90,
    standardDeviation: 10,
    repeats: 3,
  });
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]?.unchanged, true);
  assert.equal(repeated[0]?.messages.length, 3);
  for (const text of repeated[0]?.messages ?? [])
    assert.match(
      text,
      /triplet [0-9a-f]{64} was already tried; propose a different scheduler configuration/,
    );
  assert.equal(
    c5?.candidate.triplet.scheduler,
    c1?.candidate.triplet.scheduler,
  );
  assert.notEqual(c5?.candidate.key, c1?.candidate.key);
  checkCoordinates(state, log);
  await checkEvidence(target, state);
  // The promoted triplet's candidate, remeasurement and confirmation rows share its key.
  const rows = (await readFile(join(target.sessionDir, "scores.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.filter((row) => row.key === c4?.candidate.key).map((row) => row.phase),
    ["candidate", "remeasure", "confirmation"],
  );
  assert.equal(
    await readFile(target.ts, "utf8"),
    withRegions(target.prepared, state.anchor.candidate.sources),
  );
}

/** A score-table append failure stops failed, never continues or converges, and restores. */
async function scoreFailureScenario(dir: string): Promise<void> {
  const target = await prepare(dir, numericTarget());
  const scores = join(target.sessionDir, "scores.jsonl");
  const { models, editorRung } = await editorRuntime(
    editorTurn(
      {
        axis: "scheduler",
        source: SCHED.roundRobin,
        afterEdit: async () => {
          await rename(scores, `${scores}.before-failure`);
          await mkdir(scores);
        },
      },
      { states: [] },
    ),
  );
  const state = await optimize(requestFor(target, { stop: { target: 0 } }), {
    models,
    editorRung,
  });
  expectStop(state, "failed");
  assert.match(state.stop?.reason ?? "", /cannot append to .*scores\.jsonl/);
  assert.match(state.stop?.reason ?? "", /EISDIR/);
  assert.deepEqual(
    trials(state).map((trial) => [trial.phase, trial.runs.length]),
    [
      ["baseline", 2],
      ["candidate", 2],
    ],
  );
  assert.equal(edits(state).length, 1);
  assert.equal(await readFile(target.ts, "utf8"), target.original);
  const [baseline] = trials(state);
  assert.deepEqual(
    JSON.parse(await readFile(`${scores}.before-failure`, "utf8")),
    { version: 1, key: baseline?.candidate.key, ...baseline },
  );
  assert.deepEqual(await readState(target.sessionDir), state);
}

// --- failures and ownership ------------------------------------------------------------------------

/** A request whose only stop predicate needs a measured baseline, stopped before any edit. */
async function blockedScenario(
  dir: string,
  parts: TargetParts,
  extra: Partial<Request>,
  error: RegExp,
  reason: RegExp,
  targetModels: readonly string[] = [],
): Promise<State> {
  const target = await prepare(dir, parts);
  const { models, editorRung } = await editorRuntime([], targetModels);
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

async function resultFailureScenarios(dir: string): Promise<void> {
  const noHash = /no baseline run established/;
  const missing = /the baseline has no complete measurement/;
  const request: Partial<Request> = {
    objective: { metric: { kind: "cost" }, direction: "minimize" },
    constraints: [{ metric: RESOLVED, op: ">=", threshold: 60 }],
  };
  const cases: readonly [string, Partial<TargetParts>, RegExp, RegExp][] = [
    ["missing", { metrics: undefined }, /no result "resolved"/, missing],
    ["unknown", { metrics: "{ other: 60 }" }, /no result "resolved"/, missing],
    [
      "null",
      { metrics: "null" },
      /metrics must be an object of finite numbers/,
      noHash,
    ],
    [
      "array",
      { metrics: "[]" },
      /metrics must be an object of finite numbers/,
      noHash,
    ],
    ["string", { metrics: '{ resolved: "60" }' }, /finite numbers/, noHash],
    [
      "nonfinite",
      {
        afterCleanup: `await writeFile(join(profile.directory as string, "completion.json"),
      JSON.stringify({ version: 1, nonce: profile.request?.nonce, terminal: true, graphHash, resourceEvents, metrics: { resolved: "overflow" } }).replace('"overflow"', "1e309")); process.exit(0);`,
      },
      /finite numbers/,
      noHash,
    ],
    [
      "unused-malformed",
      { metrics: '{ resolved: 60, ignored: "bad" }' },
      /finite numbers/,
      noHash,
    ],
    [
      "unknown-receipt-key",
      { receiptFields: "{ unknown: true }" },
      /malformed/,
      noHash,
    ],
    ["stale", { nonce: '"stale"', metrics: "null" }, /another nonce/, noHash],
    [
      "not-terminal",
      { receiptFields: "{ terminal: false }", metrics: "null" },
      /malformed/,
      noHash,
    ],
    [
      "bad-hash",
      { receiptFields: '{ graphHash: "bad" }', metrics: "null" },
      /malformed/,
      noHash,
    ],
    [
      "incomplete",
      { afterCleanup: "process.exit(0);" },
      /no valid completion receipt/,
      noHash,
    ],
    ["unaccounted", { afterRun: "" }, /no cost/, missing],
  ];
  for (const [name, parts, error, reason] of cases)
    await blockedScenario(
      join(dir, name),
      costTarget(parts),
      request,
      error,
      reason,
    );

  // Metrics remain strict even when only a recorder metric was requested.
  await blockedScenario(
    join(dir, "unused-metrics"),
    costTarget({ metrics: "null" }),
    {
      objective: { metric: { kind: "cost" }, direction: "minimize" },
    },
    /finite numbers/,
    noHash,
  );

  // Target-owned authorization applies to schedulers and ladders, before model acquisition.
  for (const [name, scheduler] of [
    [
      "scheduler-model",
      'const optimizerScheduler = (_label: string) => optimizerPi("target/other");\n',
    ],
    [
      "scheduler-thinking",
      'const optimizerScheduler = (_label: string) => optimizerPi("target/cheap", "high");\n',
    ],
  ] as const) {
    const state = await blockedScenario(
      join(dir, name),
      costTarget({ scheduler }),
      {
        ...request,
        allowedModels: [{ model: "target/cheap" }],
      },
      /exited with status 1/,
      noHash,
      ["cheap"],
    );
    const run = trials(state)[0]?.runs[0];
    assert.match(
      await readFile(join(run?.directory as string, "target.stderr"), "utf8"),
      /scheduler uses unauthorized/,
    );
  }
  const ladder = await blockedScenario(
    join(dir, "ladder-model"),
    costTarget({ ladder: ladderOf("other") }),
    {
      ...request,
      allowedModels: [{ model: "target/cheap" }],
    },
    /exited with status 1/,
    noHash,
    ["cheap"],
  );
  assert.match(
    await readFile(
      join(trials(ladder)[0]?.runs[0]?.directory as string, "target.stderr"),
      "utf8",
    ),
    /ladder rung .* unauthorized/,
  );
  await blockedScenario(
    join(dir, "ladder-thinking"),
    costTarget({
      ladder:
        'const optimizerLadder = schedules.uniformLadder({ model: "target/cheap", thinking: "high" });\nconst optimizerStrength = undefined;\n',
    }),
    { ...request, allowedModels: [{ model: "target/cheap" }] },
    /exited with status 1/,
    noHash,
    ["cheap"],
  );

  // Failed scheduler responses still contribute usage before schedules.pi rejects them.
  const failed = await blockedScenario(
    join(dir, "scheduler-failed"),
    costTarget({
      scheduler: PI_SCHED,
      header: COST_HEADER("error"),
    }),
    { ...request, allowedModels: [{ model: "target/cheap" }] },
    /exited with status 1/,
    noHash,
    ["cheap"],
  );
  const samples = await readProfile(
    join(trials(failed)[0]?.runs[0]?.directory as string, "samples.jsonl"),
  );
  assert.deepEqual(summarize(samples, { kind: "cost" }), {
    value: 0.25,
    unit: "USD",
    count: 1,
  });

  // A candidate's stale document hash is rejected before even malformed result metrics are read.
  const drift = await prepare(
    join(dir, "receipt-hash-drift"),
    costTarget({
      receiptFields:
        'peak === 1 ? { graphHash: "f".repeat(64), metrics: null } : {}',
    }),
  );
  const runtime = await editorRuntime(
    editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, { states: [] }),
  );
  const state = await optimize(
    requestFor(drift, { ...request, stop: { target: 0 }, runBudget: 3 }),
    runtime,
  );
  expectStop(state, "budget");
  assert.equal(trials(state)[0]?.score, 200);
  assert.equal(trials(state)[1]?.score, null);
  assert.match(
    trials(state)[1]?.runs[0]?.error ?? "",
    /runtime graph document differs/,
  );
  assert.equal(await readFile(drift.ts, "utf8"), drift.original);
  await checkEvidence(drift, state);
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
  const missing = /the baseline has no complete measurement/;
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

  // An explicit run budget stops non-converged mid-batch and restores the original entrypoint:
  // the complete baseline and the partial candidate are each one score row.
  const budget = await prepare(join(dir, "budget"), numericTarget());
  const budgetRuntime = await editorRuntime(
    editorTurn({ axis: "scheduler", source: SCHED.roundRobin }, { states: [] }),
  );
  const budgetState = await optimize(
    requestFor(budget, { repeats: 3, stop: { target: 0 }, runBudget: 4 }),
    budgetRuntime,
  );
  assert.equal(budgetState.stop?.kind, "budget");
  assert.match(budgetState.stop?.reason ?? "", /run budget of 4/);
  assert.deepEqual(
    trials(budgetState).map((trial) => [trial.score, trial.runs.length]),
    [
      [2, 3],
      [null, 1],
    ],
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
    requestFor(target, { stop: { target: 0 }, runBudget: 3 }),
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
      beforeBuild: `if (profile.directory !== undefined) {
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  await writeFile(join(profile.directory, "sleeper.pid"), String(sleeper.pid));
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
  await checkScores(target.sessionDir, state);

  // Cancelled after its edit applied: the receipt keeps the edited identity and ownership, no
  // unexecuted candidate becomes a measured trial or score row, and the original is restored.
  const edited = await prepare(join(dir, "interrupted"), numericTarget());
  const turn = new AbortController();
  const runtime = await editorRuntime(
    editorTurn(
      {
        axis: "scheduler",
        source: SCHED.roundRobin,
        afterEdit: () => turn.abort(new Error("cancelled by the fixture")),
      },
      { states: [] },
    ),
  );
  const cut = await optimize(requestFor(edited), {
    models: runtime.models,
    editorRung: runtime.editorRung,
    signal: turn.signal,
  });
  expectStop(cut, "cancelled");
  const sources = {
    ...cut.anchor.candidate.sources,
    scheduler: SCHED.roundRobin,
  };
  assert.deepEqual(cut.current, {
    sources,
    ...identityOf(sources),
    tsHash: sha256(withRegions(edited.prepared, sources)),
  });
  const last = cut.history.at(-1) as Edit;
  assert.equal(last.kind, "edit");
  assert.equal(last.accepted, false);
  assert.equal(last.afterHash, cut.current.tsHash);
  assert.match(last.error ?? "", /turn interrupted/);
  assert.equal(trials(cut).length, 1);
  assert.equal(await readFile(edited.ts, "utf8"), edited.original);
  assert.deepEqual(await readState(edited.sessionDir), cut);
  await checkScores(edited.sessionDir, cut);
}

/**
 * Two overlapping campaigns on distinct targets whose edits share one triplet key: each keeps its
 * own receipt, run numbering, evidence and restoration, and cancelling A never disturbs B.
 */
async function concurrentCampaignScenario(dir: string): Promise<void> {
  const a = await prepare(join(dir, "a"), numericTarget());
  const b = await prepare(
    join(dir, "b"),
    numericTarget({ code: `${NUMERIC_CODE()}\n// overlapping campaign B` }),
  );
  const cancelA = new AbortController();
  const aEdited = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const results: { a?: readonly Result[]; b?: readonly Result[] } = {};
  const runtimeA = await editorRuntime(
    editorTurn(
      {
        axis: "scheduler",
        source: SCHED.roundRobin,
        afterEdit: async (edit) => {
          results.a = edit;
          aEdited.resolve();
          await releaseA.promise;
        },
      },
      { states: [] },
    ),
  );
  const runtimeB = await editorRuntime(
    editorTurn(
      {
        axis: "scheduler",
        source: SCHED.roundRobin,
        afterEdit: (edit) => {
          results.b = edit;
          cancelA.abort(new Error("cancel overlapping campaign A"));
          releaseA.resolve();
        },
      },
      { states: [] },
    ),
  );
  const runA = optimize(requestFor(a), {
    models: runtimeA.models,
    editorRung: runtimeA.editorRung,
    signal: cancelA.signal,
  });
  let runB: Promise<State> | undefined;
  try {
    await Promise.race([
      aEdited.promise,
      runA.then((state) => {
        throw new Error(
          `campaign A stopped before its edit: ${state.stop?.reason}`,
        );
      }),
    ]);
    runB = optimize(requestFor(b, { repeats: 2, runBudget: 4 }), {
      models: runtimeB.models,
      editorRung: runtimeB.editorRung,
    });
    await runB;
  } finally {
    if (!cancelA.signal.aborted)
      cancelA.abort(new Error("the overlapping campaign check failed"));
    releaseA.resolve();
    await Promise.allSettled([runA, runB]);
  }
  const stateA = await runA;
  const stateB = await runB;

  for (const edit of [results.a, results.b]) {
    assert.equal(edit?.length, 1);
    assert.equal(edit?.[0]?.name, "edit_tuning");
    assert.equal(edit?.[0]?.isError, false, edit?.[0]?.text);
  }
  const sources = {
    ...stateA.anchor.candidate.sources,
    scheduler: SCHED.roundRobin,
  };
  const candidateOf = (target: Prepared) => ({
    sources,
    ...identityOf(sources),
    tsHash: sha256(withRegions(target.prepared, sources)),
  });

  // A: cancelled after its applied edit; the unexecuted candidate is owned, restored, never scored.
  expectStop(stateA, "cancelled");
  assert.equal(await runDirs(a.sessionDir), 2);
  assert.deepEqual(
    trials(stateA).map((trial) => [trial.phase, trial.runs.length]),
    [["baseline", 2]],
  );
  assert.deepEqual(stateA.current, candidateOf(a));
  const lastA = stateA.history.at(-1) as Edit;
  assert.equal(lastA.kind, "edit");
  assert.equal(lastA.accepted, false);
  assert.equal(lastA.afterHash, stateA.current.tsHash);
  assert.match(lastA.error ?? "", /turn interrupted/);
  assert.equal(await readFile(a.ts, "utf8"), a.original);

  // B: the same triplet key is novel to its own session, measured and promoted.
  expectStop(stateB, "budget");
  assert.equal(await runDirs(b.sessionDir), 4);
  const [baselineB, candidateB] = trials(stateB);
  assert.deepEqual(
    trials(stateB).map((trial) => [trial.phase, trial.runs.length]),
    [
      ["baseline", 2],
      ["candidate", 2],
    ],
  );
  assert.equal(baselineB?.stats?.objective.mean, 2);
  assert.equal(candidateB?.stats?.objective.mean, 1);
  assert.deepEqual(candidateB?.candidate, candidateOf(b));
  assert.deepEqual(stateB.anchor.candidate, candidateOf(b));
  assert.equal(candidateB?.candidate.key, stateA.current.key);
  assert.notEqual(candidateB?.candidate.tsHash, stateA.current.tsHash);
  assert.equal(await readFile(b.ts, "utf8"), b.original);

  for (const [target, state] of [
    [a, stateA],
    [b, stateB],
  ] as const) {
    for (const trial of trials(state))
      for (const run of trial.runs)
        assert.ok(
          run.directory.startsWith(join(target.sessionDir, "runs", "")),
          run.directory,
        );
    await checkEvidence(target, state);
  }
}

async function externalCleanupScenario(dir: string): Promise<void> {
  const target = await prepare(
    dir,
    numericTarget({
      afterCleanup:
        'await writeFile(join(profile.directory as string, "cleanup.pending"), "external resources may still be live");',
    }),
  );
  const { models, editorRung } = await editorRuntime([]);
  const state = await optimize(requestFor(target), { models, editorRung });
  expectStop(state, "blocked");
  assert.match(
    state.stop?.reason ?? "",
    /external cleanup unproven: .*cleanup\.pending.*original TS not restored/,
  );
  assert.equal(trials(state)[0]?.runs.length, 1);
  assert.match(
    trials(state)[0]?.runs[0]?.error ?? "",
    /external cleanup unproven/,
  );
  assert.equal(await readFile(target.ts, "utf8"), target.prepared);
  assert.ok(
    existsSync(join(target.sessionDir, "runs", "0001", "cleanup.pending")),
  );
  assert.deepEqual(await readState(target.sessionDir), state);
  await checkScores(target.sessionDir, state);
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

/** Without JUNCO_PROFILE_RUN_DIR the prepared target runs as the ordinary workflow and writes no evidence. */
async function inactiveInstrumentationScenario(dir: string): Promise<void> {
  const target = await prepare(
    dir,
    numericTarget({
      afterRun:
        "console.log(JSON.stringify({ value, active: profile.request !== undefined }));",
    }),
  );
  const result = await exec([process.execPath, "run", target.ts], {
    ...process.env,
    JUNCO_PROFILE_RUN_DIR: undefined,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { value: 2, active: false });
  assert.equal(await readFile(target.ts, "utf8"), target.prepared);
  assert.deepEqual((await readdir(target.sessionDir)).sort(), [
    "original.ts",
    "original.yml",
    "prepared.ts",
  ]);
}

async function boundaryChecks(dir: string): Promise<void> {
  const target = await prepare(dir, numericTarget());
  const request = requestFor(target);
  for (const metric of [
    { kind: "cost", name: "unexpected" },
    { kind: "result" },
    { kind: "result", name: "" },
    { kind: "result", name: 60 },
    { kind: "result", name: "resolved", reduce: "sum" },
  ])
    await assert.rejects(
      schedules.runOptimizer({
        ...request,
        objective: { metric, direction: "minimize" },
      } as Request),
      /invalid optimization request/,
    );
  for (const [extra, pattern] of [
    [{ repeats: 1 }, /invalid optimization request/],
    [{ qualityConstraint: -1 }, /invalid optimization request/],
    [{ qualityConstraint: 0.5 }, /invalid optimization request/],
    [{ qualityConstraint: 1 }, /qualityConstraint 1 names no constraint/],
    [
      {
        constraints: [{ metric: { kind: "tokens" }, op: "<=", threshold: 1 }],
        qualityConstraint: 0,
      },
      /must name a probe or result constraint/,
    ],
  ] as const)
    await assert.rejects(
      schedules.runOptimizer({ ...request, ...extra } as Request),
      pattern,
    );
  // A score table from an earlier invocation is never reused or overwritten.
  const staleScores = join(target.sessionDir, "scores.jsonl");
  await writeFile(staleScores, "kept\n");
  await assert.rejects(
    schedules.runOptimizer(request),
    /scores\.jsonl belongs to a previous invocation/,
  );
  assert.equal(await readFile(staleScores, "utf8"), "kept\n");
  await rm(staleScores);
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
  // The editor needs a seed subvolume, not an ordinary directory on the CI mount.
  const {
    createBtrfsFixture,
  }: {
    createBtrfsFixture(): Promise<{ seed: string; close(): Promise<void> }>;
  } = require("../packages/junco-tools/tests/btrfs-fixture.mjs");
  const { seed: root, close } = await createBtrfsFixture();
  let ok = false;
  try {
    const modules = join(root, "node_modules");
    await mkdir(modules);
    await symlink(ROOT, join(modules, "junco"), "dir");
    for (const dependency of ["dataflow-engine", "@earendil-works"])
      await symlink(
        join(ROOT, "node_modules", dependency),
        join(modules, dependency),
        "dir",
      );
    await checkMetrics(join(root, "metrics"));
    checkStatistics();
    await boundaryChecks(join(root, "boundaries"));
    await inactiveInstrumentationScenario(join(root, "inactive"));
    await numericScenario(join(root, "numeric"));
    await tokenScenario(join(root, "tokens"));
    await statisticsScenario(join(root, "statistics"));
    await scoreFailureScenario(join(root, "score-failure"));
    await costResultScenario(join(root, "cost-results"));
    await resultFailureScenarios(join(root, "result-failures"));
    await failureScenarios(join(root, "failures"));
    await ownershipScenario(join(root, "ownership"));
    await driftScenario(join(root, "drift"));
    await cancelScenario(join(root, "cancel"));
    await concurrentCampaignScenario(join(root, "concurrent"));
    await externalCleanupScenario(join(root, "external-cleanup"));
    ok = true;
  } finally {
    if (ok) await close();
    else
      console.error(
        `profile optimizer check failed; artifacts retained at ${root}`,
      );
  }
  console.log("PROFILE_OPTIMIZER_CHECK_OK");
};

if (import.meta.main) await main();
