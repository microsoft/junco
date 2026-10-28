# Target integration and library APIs

How to prepare an existing `workflow.yml`/`workflow.ts` pair for `schedules.runOptimizer`, and what the optimizer's editor may change. All imports are public: `junco`, `dataflow-engine`, `@earendil-works/pi-*`, Node built-ins.

## Contents

- [Execution model](#execution-model)
- [Run protocol](#run-protocol)
- [Tuning regions](#tuning-regions)
- [Instrumentation template](#instrumentation-template)
- [Configuration axes](#configuration-axes)
- [Metrics and measurement coverage](#metrics-and-measurement-coverage)
- [Outcomes and evidence](#outcomes-and-evidence)

## Execution model

- Every execution is a fresh child process running the user's existing `argv` in `target.cwd` (no shell), with the inherited environment plus `JUNCO_PROFILE_RUN_DIR=<sessionDir>/runs/<NNNN>`. `resetArgv`, when given, runs first in its own owned process and must succeed.
- Children are detached process groups. Cancellation or time-budget expiry sends SIGTERM to the group, SIGKILL after 5 s, and waits until the group is gone before restoring files or starting another run. If disappearance cannot be proved, nothing is restored.
- Baseline: the prepared, untuned file `R` times. Then cycles over the requested axes; each cycle (after the first) starts by re-measuring the incumbent `R` times. Each editor turn changes one axis; the candidate is measured `R` times. A batch scores (median; mean of the middle two for even `R`) only when every run passes process, receipt and metric validation. Feasible = scored and every run meets every constraint.
- A feasible candidate replaces the incumbent when its directional gain exceeds `absoluteTolerance + relativeTolerance * |incumbent|` (zero without a plateau request). Execution or measurement errors and rejected edits retry the same axis; fully measured alternatives (even infeasible ones) advance it.
- At a completed cycle where every requested predicate holds (plateau additionally: no promotion that cycle and the incumbent window stable), the saved entrypoint runs `max(R, W)` (plateau) or `R` fresh times. Passing confirmation converges and leaves the verified tuning saved; failing it starts another full cycle.
- `state.json` is checkpointed around every child; `optimizer.jsonl` holds the editor's own usage. Neither is a resume mechanism: a session directory is used once.

## Run protocol

The host writes `<run>/request.json` exactly:

```json
{ "version": 1, "nonce": "<fresh per run>", "monitored": false,
  "probes": [{ "node": "", "edgeId": "quality" }], "expectedGraphHash": null,
  "allowedModels": [{ "model": "provider/model" }], "limitBounds": { "tokens": 20000 } }
```

- `monitored` is true only when a metric uses recorded memory. `probes` lists every probe metric. `expectedGraphHash` is null until the baseline's first receipt establishes it; afterwards a mismatch must fail before any agent is acquired.
- The target writes only the fixed names `samples.jsonl` (the `JsonlRecorder`) and `completion.json`, and only after the existing terminal assertion passed and every graph, tracer and recorder close succeeded:

```json
{ "version": 1, "nonce": "<the request's>", "terminal": true, "graphHash": "<sha256>", "resourceEvents": 0 }
```

  Publish it through a temporary file and `rename` inside the run directory. A failed run or cleanup leaves no receipt.
- The host accepts a run only after child `close` with exit 0, no signal, the exact nonce, `terminal: true`, the baseline `graphHash`, unchanged YAML bytes, the measured TS hash before and after, and a canonically parsed fresh profile containing every metric. Anything else is ineligible, however cheap its partial rows look.

## Tuning regions

Insert exactly one ordered pair per axis, all three always, around real tuning source moved unchanged from the runner:

```ts
// junco-profile-optimizer:start scheduler
const optimizerScheduler = (label: string) => existingSchedulerFactory(label);
// junco-profile-optimizer:end scheduler
// junco-profile-optimizer:start ladder
const optimizerLadder: schedules.Ladder | undefined = existingLadder; // undefined for a deterministic target
const optimizerStrength = undefined; // or the existing (snapshot, nodeId) => rung selector
// junco-profile-optimizer:end ladder
// junco-profile-optimizer:start limits
const optimizerLimits: OptimizerLimits = {}; // extra limits only; hard limits stay outside
// junco-profile-optimizer:end limits
```

- Markers are whole-line `//` comments; a region's interior is the lines between them. The editor replaces one interior per turn through `edit_tuning`; every byte outside the interiors is fixed and checked on each write, and the YAML must stay unchanged.
- Keep imports, graph parsing/building, code-node bodies, tools, round counts, recorder/probe integration, quality logic and the original hard limits outside every region. Scheduler candidates must not change which rung a node uses; the ladder region owns that.
- Keep YAML/TypeScript prediction profiles fixed. Ranking (`lowest`/`highest`) and memory admission need complete compatible profiles; the resource scheduler supports only constant and planned `count` features. A missing profile invalidates that candidate — never substitute zero forecasts or refit during tuning.
- If the existing runner cannot expose these bindings without changing behavior (for example, scheduling decided inside a code node), report that integration prerequisite instead of claiming generic interception.

TypeScript patches are executable code in the user's environment, not a sandbox: these checks enforce file boundaries and observed graph invariants, not protection from deliberately hostile code. Use the user's existing trusted/isolated environment.

## Instrumentation template

Fixed code added once during preparation. Adapt only the marked integration points to the runner's existing options; `test/profile-optimizer.fixture.ts` in junco exercises this exact shape.

```ts
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytes, tokens } from "dataflow-engine";
import { JuncoGraph, schedules, syntax, tracer } from "junco";

type OptimizerLimits = {
  memoryBytes?: number;
  tokens?: number;
  tools?: number;
  scope?: "evaluation" | "batch" | "activation";
};
// ... the three tuning regions ...

/** The workflow's original hard ceilings, outermost around every candidate (or undefined). */
const HARD_LIMITS: schedules.LimitOptions | undefined = /* existing limit options */ undefined;
const PARAMS: Record<string, string> = /* the existing fromYaml params */ {};

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

/** `document` with probe: true on each requested existing numeric edge, revalidated. */
function withProbes(document: syntax.JuncoDocument, probes: ProfileRun["probes"]): syntax.JuncoDocument {
  const copy = structuredClone(document);
  for (const { node, edgeId } of probes) {
    let spec = copy.graph;
    for (const segment of node === "" ? [] : node.split("/")) {
      const wrapper = spec.nodes[segment];
      if (wrapper?.kind !== "graph") throw new Error(`probe path "${node}" names no graph node`);
      spec = wrapper.graph;
    }
    const edges = (spec.edges ?? []).filter(
      (edge) => (edge.id ?? `${edge.from}${edge.kind === "message" ? "~>" : "->"}${edge.to}`) === edgeId,
    );
    const type = edges.length === 1 ? (edges[0].schema as { type?: unknown }).type : undefined;
    if (type !== "number" && type !== "integer")
      throw new Error(`probe "${node}" / "${edgeId}" is not exactly one existing numeric edge`);
    edges[0].probe = true;
  }
  return syntax.parse(copy);
}

/** The candidate's concrete ladder and extra limits stay inside the run's authorized domain. */
function checkTuning(run: ProfileRun): void {
  for (const [name, rung] of Object.entries(optimizerLadder ?? {}))
    if (!run.allowedModels.some((allowed) => allowed.model === rung.model && allowed.thinking === rung.thinking))
      throw new Error(`ladder rung ${name} uses unauthorized ${rung.model}`);
  const bounds: Record<string, number | undefined> = { ...run.limitBounds };
  for (const [key, value] of Object.entries(optimizerLimits)) {
    if (key === "scope") {
      if (!["evaluation", "batch", "activation"].includes(String(value))) throw new Error(`invalid limit scope ${value}`);
      continue;
    }
    if (!["memoryBytes", "tokens", "tools"].includes(key)) throw new Error(`unknown limit ${key}`);
    const bound = bounds[key];
    if (
      typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (key === "tools" && !Number.isInteger(value)) || (bound !== undefined && value > bound)
    )
      throw new Error(`limit ${key}=${value} is outside its bound ${bound}`);
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

const run = await profileRun();
const yamlText = await readFile(new URL("./workflow.yml", import.meta.url), "utf8");
const document = syntax.parse(yamlText, { params: PARAMS, sourceName: "workflow.yml" });
const graphHash = createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex");
if (run?.expectedGraphHash != null && run.expectedGraphHash !== graphHash)
  throw new Error("the runtime graph document drifted from the baseline's");
if (run !== undefined) checkTuning(run);
const recorder =
  run === undefined
    ? undefined
    : new tracer.JsonlRecorder({ path: join(RUN_DIR as string, "samples.jsonl"), monitored: run.monitored });
const observer = /* the existing tracer */ new tracer.DummyTracer();
let resourceEvents = 0;
const failures: unknown[] = [];
let execution: Awaited<ReturnType<typeof JuncoGraph.fromYaml>> | undefined;
try {
  // A parsed document carries no params: they were applied above.
  execution = await JuncoGraph.fromYaml(run === undefined ? document : withProbes(document, run.probes), {
    /* the existing options, unchanged, except: */
    scheduler: tunedScheduler,
    ladder: optimizerLadder,
    tracer: observer,
    ...(recorder === undefined ? {} : { recorder }),
    // Only when this build creates its collection and monitors (resources.monitorIntervalMs):
    // onResourceEvent: (event) => { resourceEvents++; existingOnResourceEvent?.(event); },
  });
  await execution.run();
  /* the existing terminal assertion; throw when it fails */
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
if (run !== undefined) {
  const receipt = join(RUN_DIR as string, "completion.json");
  await writeFile(`${receipt}.tmp`, JSON.stringify({ version: 1, nonce: run.nonce, terminal: true, graphHash, resourceEvents }), { flag: "wx" });
  await rename(`${receipt}.tmp`, receipt);
}
```

Integration notes:

- **Recorder ownership.** Attach the recorder where the runner already builds: `fromYaml`'s `recorder` (agents created by `createAgent` receive it through their spec), or `JuncoGraph.create`'s collection options. An existing recorder must be integrated consistently or reported as an ownership conflict — never silently replaced. If the runner passes `recorderNodeId`, prefix probe `node` paths with it.
- **Caller-owned resources.** With caller-owned `collection`, `createAgent` or `agents`, monitoring is configured where that collection is constructed, never through conflicting `BuildOptions.resources`.
- **Cleanup order.** Graph and owned resources close first, the tracer flushes next, the recorder closes last; build failures still close. Run and cleanup failures are reported together.
- **Repeated runs.** Each child is fresh, so module-level state resets. Persistent external effects need the caller's `resetArgv`.

## Configuration axes

The editor writes concrete TypeScript within `allowedModels` and `limitBounds`; it is not limited to these examples.

| Axis | Supported configurations and restrictions |
|---|---|
| Scheduling | Existing factory, `schedules.parallel()`, `schedules.roundRobin(undefined, width)`, `schedules.choose({ rank, width: () => width })`. `parallel` does not enforce finite YAML `threads`; prefer width-bounded candidates compatible with the unchanged graph. `schedules.lowest("tokens"\|"memory"\|"runtime")` / `highest(...)` are **rank callbacks for `choose`**, not schedulers. Every existing work node stays schedulable. |
| Models | A complete `schedules.Ladder` (`smol`, `low`, `med`, `high`, `xhigh`, each `{ model: "provider/model-id", thinking? }`). `schedules.strength((snapshot, nodeId) => rung, inner)` selects a rung; built-in work policies otherwise use `med`. Changing an unused rung is not a measured model experiment. Keep graph-label dispatch and role assignments. |
| Limits | `schedules.limit({ memory?, tokens?, tools?, scope? }, inner)` outermost around the selected policy, inside the original hard limits. Memory quantities and `tokens(n)` come from `dataflow-engine`. Memory is predicted per-decision admission; tokens/tools are nonnegative caps on actual usage per `scope` (`evaluation` \| `batch` \| `activation`). |

- Policies are rebuilt through `scheduler(label)` for every child, so histories and limit ledgers cannot leak between trials. Nested graph levels get their own policies: parent token/tool budgets cover child work and child limits add to them, while parent memory prediction sees the nested wrapper, not its synchronized children. Use only the label granularity the existing factory exposes; never rename YAML labels to disambiguate.
- A limit violation (`JUNCO_USAGE_LIMIT_EXCEEDED`), capacity rejection, failed task, missing metric or failed quality threshold makes a trial ineligible. Token caps can overshoot by in-flight requests: never promise a monetary hard cap from them.

## Metrics and measurement coverage

- **tokens** — sum of `resources.tokens` over samples: committed tokens of successful graph-node agent activations. Not `schedules.pi` oracle requests or `task` subagents. A target without agent activations has no token contributors, which is an error, not zero.
- **memory** — maximum `resources.memory` in bytes: one activation's shell-pipeline peak. Requires a native collection bound to the same recorder, delegated cgroup v2 monitoring and actual coverage: the receipt's `resourceEvents` must be positive. `monitored: true` alone records zeros and is rejected for scoring. An explicitly selected, caller-approved existing memory probe is the only substitute.
- **probe** — values published on one existing numeric edge, matched by wrapper path (`""` root, `Parent/Child` nested) and exact local edge ID, in event order, reduced by `single` (exactly one value) | `last` | `min` | `max` | `sum` | `mean`. Zero and negative values are legitimate; units are the user's.
- **Stability** — over the last `W` values: `max - min <= absoluteTolerance + relativeTolerance * max(|value|)`. Window values are fresh feasible cycle-start incumbent measurements (or the confirmation's last `W`); promotions and failed re-measurements clear the window.

## Outcomes and evidence

| Stop | Meaning | Target file afterwards |
|---|---|---|
| `converged` | Every requested predicate held on a confirmed incumbent | Winning regions saved; instrumentation dormant |
| `budget` | Caller run/time budget exhausted | `original.ts` restored when safe |
| `cancelled` | Signal received | `original.ts` restored after the owned group is gone |
| `blocked` | Global prerequisite missing (no baseline hash, missing baseline metric for an improvement goal, zero baseline for a relative goal, target changed outside the optimizer, cleanup unproven) | Restored only when the file still matches the optimizer's last write |
| `failed` | Provider/editor failure, internal error, or quiescence without a terminal state | As above |

Every attempt keeps its run directory: `request.json`, `samples.jsonl`, `completion.json`, `target.stdout`, `target.stderr` (and `reset.*`). `state.json` records each trial's region sources and full-file hash, every run's summaries and errors, and every edit (rejected ones included). A configuration's hash identifies it, never a measurement: repeated configurations are re-measured.
