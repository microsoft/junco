# Target integration and library APIs

How to prepare an existing `workflow.yml`/`workflow.ts` pair for `schedules.runOptimizer`, and what the optimizer's editor may change. All imports are public: `junco`, `dataflow-engine`, `@earendil-works/pi-*`, Node built-ins.

## Contents

- [Execution model](#execution-model)
- [Run protocol](#run-protocol)
- [Request schema and example](#request-schema-and-example)
- [Tuning regions](#tuning-regions)
- [Instrumentation template](#instrumentation-template)
- [Configuration axes](#configuration-axes)
- [Model domain](#model-domain)
- [Metrics and measurement coverage](#metrics-and-measurement-coverage)
- [Outcomes and evidence](#outcomes-and-evidence)

## Execution model

- `<sessionDir>` is a fresh `mkdtemp` child of `/tmp/junco-profile-optimizer-workspace/`. It holds optimizer metadata (snapshots, request, `state.json`, `optimizer.jsonl`, `scores.jsonl`, run directories) and is the root of the Editor's private native collection. Live optimization requires a writable native Btrfs seed containing it, even for a deterministic target. If absent, report that prerequisite. Do not relocate mounts, change `BTRFS_ROOT` or grant host tools as a substitute. Target `yaml`, `ts` and `cwd` remain absolute paths into the original project.
- Every execution is a fresh child process running the user's existing `argv` in `target.cwd` (no shell), with the inherited environment plus `JUNCO_PROFILE_RUN_DIR=<sessionDir>/runs/<NNNN>`. `resetArgv`, when given, runs first in its own owned process and must succeed.
- Children are detached process groups. Cancellation or time-budget expiry sends SIGTERM to the group, SIGKILL after 5 s, and waits until the group is gone before restoring files or starting another run. If disappearance cannot be proved, nothing is restored.
- A target owning external resources (for example task containers) creates `<run>/cleanup.pending` before acquiring them and removes it only after proving all owned resources and processes gone. A surviving guard, even after child exit 0 or forced process-group cancellation, blocks further trials and file restoration. Keep its ownership/recovery evidence; process disappearance alone does not prove remote cleanup. Targets without external resources need no guard.
- Baseline: the prepared, untuned file `R` times (`R >= 2`; one-run requests are rejected before preflight because unknown variance is never zero). Then coordinate-descent cycles over the requested axes in the fixed order `scheduler`, `ladder`, `limits`: each editor turn replaces exactly one region while the other two stay at the incumbent, and the candidate is measured `R` times. Each cycle after the first starts by re-measuring the incumbent `R` times; later proposals compare against that fresh batch, never stale variance.
- Statistics: a batch gets `stats` (`objective` and per-constraint `{ mean, standardDeviation, repeats }`, sample SD over the `R` runs) only when every requested run passes process, receipt and metric validation. Scalar `score`/`baselineScore`/`anchor.score` are objective **means**. Failed, cancelled or incomplete batches keep their observations with `stats: null`. Feasible = complete and every hard constraint holds in **every run**, not just on average.
- Promotion (non-regression, effect size): a feasible candidate replaces the incumbent only when the objective mean and the designated `qualityConstraint` mean are both no worse and at least one improves by at least the pooled sample SD `sqrt(((nRef-1)·sdRef² + (nCand-1)·sdCand²) / (nRef+nCand-2))`. Equal means never promote, even at zero variance. Other constraints are hard gates, not rewards. This is a heuristic, not a significance test. A complete infeasible baseline is only a reference; a missing complete baseline/incumbent measurement blocks the campaign.
- Invalid measurements retry the same axis with a different proposal; valid infeasible or non-improving candidates restore the incumbent bytes and advance the axis. A promotion forces another full cycle; confirmation is attempted only after a full all-axis cycle without promotion where every requested predicate holds (plateau: incumbent window stable). The saved entrypoint then runs `max(R, W)` (plateau) or `R` fresh times. Passing confirmation converges; failing it re-measures the incumbent and cycles again. Exhausting ideas or one lucky run is never convergence.
- Novelty: each candidate has `triplet: { ladder, scheduler, limits }`, the SHA-256 of each region's Bun-transpiled JavaScript, and `key = sha256(JSON.stringify([ladder, scheduler, limits]))`. `edit_tuning` rejects a key equal to the baseline or any previously attempted trial (failed and infeasible included) with `triplet <key> was already tried; propose a different <axis> configuration` before touching the target; the editor proposes again in the same turn. Normalization erases comments, whitespace, quote style and type annotations only — it does not prove semantic equivalence (reordered properties or renamed locals get new keys), so never disguise a repeat. Host-owned baseline repeats, re-measurements and confirmation deliberately reuse keys.
- `state.json` is checkpointed around every child; `optimizer.jsonl` holds the editor's own usage; `scores.jsonl` appends one row `{ version: 1, key, ...trial }` per finalized trial with at least one attempted run (failed/null-stats rows included, rejected edits excluded). A key identifies a configuration, never a measurement: repeated keys are expected, so group by `key` and never treat a row as a cached score. None of these is a resume mechanism: a session directory is used once.

## Run protocol

The host writes `<run>/request.json` exactly:

```json
{ "version": 1, "nonce": "<fresh per run>", "monitored": false,
  "probes": [{ "node": "", "edgeId": "quality" }], "expectedGraphHash": null,
  "allowedModels": [{ "model": "provider/model" }], "limitBounds": { "tokens": 20000 } }
```

- `monitored` is true only when a metric uses recorded memory. `probes` lists every probe metric. `expectedGraphHash` is null until the baseline's first receipt establishes it; afterwards a mismatch must fail before any agent is acquired.
- The target writes only the fixed names `samples.jsonl` (the `JsonlRecorder`) and `completion.json`, and only after its existing terminal invariant and every graph, tracer and recorder close succeeded. An external workload's terminal invariant is complete authoritative outcome coverage, not passing its quality threshold:

```json
{ "version": 1, "nonce": "<the request's>", "terminal": true, "graphHash": "<sha256>", "resourceEvents": 0,
  "metrics": { "resolved": 60 } }
```

  Publish it through a temporary file and `rename` inside the run directory. A failed run or cleanup leaves no receipt.
- `metrics` is optional for existing targets. Every supplied value must be a finite number; a requested `{ kind: "result", name }` must be present. The host reads it only after validating the receipt envelope. The fixed adapter owns freshness, exact workload coverage and the authoritative evaluator; never let a solving agent write these outcomes. A complete run below its quality threshold is scored but infeasible; a missing, stale or incomplete result is a measurement failure.
- The host accepts a run only after child `close` with exit 0, no signal, the exact nonce, `terminal: true`, the baseline `graphHash`, unchanged YAML bytes, the measured TS hash before and after, and a canonically parsed fresh profile containing every metric. Anything else is ineligible, however cheap its partial rows look.

## Request schema and example

```json
{
  "target": { "yaml": "/absolute/path/to/project/workflow.yml", "ts": "/absolute/path/to/project/workflow.ts", "cwd": "/absolute/path/to/project", "argv": ["bun", "run", "workflow.ts"] },
  "sessionDir": ".",
  "workloadId": "fixed-input-corpus-v1",
  "objective": { "metric": { "kind": "cost" }, "direction": "minimize" },
  "constraints": [{ "metric": { "kind": "probe", "node": "", "edgeId": "quality", "reduce": "single" }, "op": ">=", "threshold": 0.9 }],
  "qualityConstraint": 0,
  "repeats": 3,
  "stop": { "improvement": { "kind": "relative", "value": 0.2 }, "plateau": { "window": 3, "absoluteTolerance": 0, "relativeTolerance": 0.01 } },
  "axes": ["scheduler", "ladder", "limits"],
  "allowedModels": [{ "model": "provider/baseline-model" }, { "model": "provider/cheaper-model", "thinking": "low" }],
  "limitBounds": { "tools": 40 }
}
```

The `target` paths above are illustrative; substitute the inspected workflow's absolute paths and keep `sessionDir: "."` (relative paths resolve against the request file). `limitBounds.tools: 40` is example data, not a default cap. A `cost` objective needs `costMode: "usage"` request accounting ([cost](#metrics-and-measurement-coverage)). Optional keys: `qualityConstraint`, `target.resetArgv`, `runBudget`, `timeBudgetMs`. Unknown keys are rejected.

## Tuning regions

Insert exactly one ordered pair per axis, all three always, around real tuning source moved unchanged from the runner:

```ts
// junco-profile-optimizer:start scheduler
const optimizerScheduler = (label: string, graphPath: string) => existingSchedulerFactory(label, graphPath);
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
- Keep imports, graph parsing/building, code-node bodies, tools, round counts, recorder/probe integration, quality logic and the original hard limits outside every region. Scheduler candidates must not change which rung a node uses; the ladder region owns that. Agentic candidates call a fixed `optimizerPi(model, thinking?)` helper outside the regions: it checks the exact pair against `profile.request.allowedModels` before acquiring a model and supplies `schedules.pi` a metered `completeSimple` implementation (see Scheduler USD below).
- Preserve `measurementWindows` in the runner. Resource-based policies see only the last N actual measurements requested per node/resource. Never replace missing data with a zero forecast.
- If the existing runner cannot expose these bindings without changing behavior (for example, scheduling decided inside a code node), report that integration prerequisite instead of claiming generic interception.

TypeScript patches are executable code in the user's environment, not a sandbox: these checks enforce file boundaries and observed graph invariants, not protection from deliberately hostile code. Use the user's existing trusted/isolated environment.

## Instrumentation template

Fixed code added once during preparation. `OptimizerProfile` is a local, non-exported class owning the run request: an absent `JUNCO_PROFILE_RUN_DIR` makes it inactive (no request read, no probes, no recorder, no receipt), so the prepared file still runs as the ordinary workflow. Adapt only the marked integration points to the runner's existing options; `test/profile-optimizer.fixture.ts` in junco exercises the same protocol in its own adaptation (fault injection, concrete graphs and terminal checks, `"usage"` cost mode).

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
      const type = edges.length === 1 ? (edges[0].schema as { type?: unknown }).type : undefined;
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
const yamlText = await readFile(new URL("./workflow.yml", import.meta.url), "utf8");
const document = syntax.parse(yamlText, { params: PARAMS, sourceName: "workflow.yml" });
const graphHash = profile.validate(document);
const recorder = profile.createRecorder();
const observer = /* the existing tracer */ new tracer.DummyTracer();
let resourceEvents = 0;
const failures: unknown[] = [];
let execution: Awaited<ReturnType<typeof JuncoGraph.fromYaml>> | undefined;
try {
  // A parsed document carries no params: they were applied above.
  execution = await JuncoGraph.fromYaml(profile.withProbes(document), {
    /* the existing options, unchanged, except: */
    scheduler: (label, graphPath) => profile.scheduler(label, graphPath),
    ...(optimizerLadder === undefined ? {} : { ladder: new schedules.ModelLadder(models, optimizerLadder) }),
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
for (const close of [() => execution?.graph.close(), () => recorder?.close()])
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
if (failures.length > 0) throw new AggregateError(failures, "workflow run failed");
await profile.complete(graphHash, resourceEvents /* , fixed adapter metrics, when any */);
```

Integration notes:

- **Recorder ownership.** Pass the recorder to `fromYaml`; the graph supplies each agent's recorder context. With low-level `JuncoGraph.create`, pass it in the collection options. Integrate an existing recorder consistently or report an ownership conflict. If the runner passes `recorderNodeId`, prefix probe `node` paths with it.
- **Caller-owned resources.** Configure monitoring when opening each borrowed collection (`collection` or a `tools` map entry). `BuildOptions.resources` can configure only an internally created default; it never retrofits mapped collections. Close the graph, all caller-owned collections, then the recorder, including on failure.
- **Cleanup order.** Evaluation joins tracer delivery before settling. Graph and owned resources close first, a retained interactive TUI is finished next (if selected), and the recorder closes last; build failures still close. Run and cleanup failures are reported together.
- **Cost mode.** An all-request USD objective needs `profile.createRecorder("usage")`; semantics under [cost](#metrics-and-measurement-coverage).
- **Scheduler USD.** `optimizerPi` wraps only the scheduler's `completeSimple`. On every returned response, record `{ resource: "cost", kind: "usage", source: schedulerSource, usage: response.usage }` through a scheduler recorder context before `schedules.pi` checks cancellation, stop reason or scheduling output. Missing/nonfinite/negative cost invalidates the run. A thrown request with unknown usage is an accounting error, never a free request or a fallback. Agentic scheduling may order ready work, not omit required consultations or choose work-agent rungs.
- **External results.** A fixed workload adapter can publish finite `metrics` in the same completion receipt after validating its complete official outcomes, cost coverage, source hash and cleanup. Keep these out of the solving agents' environment; no YAML edge or invented judge is needed. A solver failure with complete accounting and official outcomes remains a scored, quality-infeasible run; infrastructure or accounting failures leave no receipt.
- **Repeated runs.** Each child is fresh, so module-level state resets. Persistent external effects need the caller's `resetArgv`.

## Configuration axes

The editor writes concrete TypeScript within `allowedModels` and `limitBounds`; it is not limited to these examples.

| Axis | Supported configurations and restrictions |
|---|---|
| Scheduling | Existing factory, `schedules.parallel()`, `schedules.roundRobin(undefined, width)`, `schedules.choose({ rank, width })`, `schedules.separate(leftOwns, left, right)`, or fixed metered/domain-checked `optimizerPi(model, thinking?)` using `schedules.pi`. `parallel` does not enforce finite YAML `threads`; prefer width-bounded candidates compatible with the unchanged graph. `schedules.lowest("tokens"\|"memory"\|"runtime")` / `highest(...)` are **rank callbacks for `choose`**, not schedulers. Every existing work node stays schedulable; no agentic omission or rung selection. |
| Models | A complete `schedules.Ladder` (`smol`, `low`, `med`, `high`, `xhigh`, each `{ model: "provider/model-id", thinking? }`). `schedules.strength((snapshot, nodeId) => rung, inner)` selects a rung; built-in work policies otherwise use `med`. Changing an unused rung is not a measured model experiment. Keep graph-label dispatch and role assignments. |
| Limits | `schedules.limit({ memory?, tokens?, tools?, scope? }, inner)` outermost around the selected policy, inside the original hard limits. Memory quantities and `tokens(n)` come from `dataflow-engine`. Memory is predicted per-decision admission; tokens/tools are nonnegative caps on actual usage per `scope` (`evaluation` \| `batch` \| `activation`). |

Candidate invariants:

- Baseline region values stay exactly as moved from the runner; the editor generates candidate policies and caps after baseline measurement, never preinstalled during setup.
- `profile.scheduler(label, graphPath)` builds a fresh policy for every child and graph level; contexts do not share measurement histories across trials or levels. Dispatch on the display `label` (which may repeat) or the unique wrapper `graphPath` (`""` at the root); never share policy instances or rename YAML labels. Parent token/tool budgets cover child work and child limits add to them; parent snapshots name the wrapper, not its child nodes.
- `choose({ rank, width })`: `rank` orders ready nodes with deterministic ties (e.g. by node ID) and may read `snapshot.history`; `width` may be a bounded dynamic callback. `separate(leftOwns, left, right)` splits ownership between two complementary policies over the inspected graph's existing roles/IDs; the graph needs capacity for their **combined** width, and partitioning guarantees neither fairness nor capacity.
- Every candidate keeps every required node schedulable (no bare `where` filter or incomplete node list), model strengths unchanged (the ladder axis owns rungs), deterministic ties, progress and bounded combined concurrency. Use `optimizerPi` only through its fixed metered/domain-checked wrapper, not as the default replacement for rich deterministic policies.
- Compose `lowest`/`highest` with `choose` when the runner retains the relevant resource; without samples, the comparator has no evidence to distinguish candidates. Never invent zero forecasts.
- Extra limits stay within `limitBounds`, outermost around the policy and inside the original hard limits, which are never raised or removed. Keep token/memory caps when requested or relevant.
- Tool-cap scopes: `evaluation` (default) = one `run()`/`step()` drive; `batch` = one selected scheduling decision; `activation` = one node prime/resume, not an agent's lifetime. Scope changes belong to the limits coordinate. All admitted graph-agent tool calls count together, including coordination tools and inherited `task`-child calls; optimizer-editor calls are outside the target cap.
- A denied tool call never executes its tool body and fails (invalidates) that run. Never suppress the failure, publish partial success, remove tools, modify prompts, raise original hard limits, invent a universal cap, claim unmeasured tool totals or promise a monetary cap. A missing `limitBounds.tools` means no numeric upper bound, not disabled tools; if intake has neither an authorized bound nor useful target evidence for a cap, obtain a bound from the user.
- A limit violation (`JUNCO_USAGE_LIMIT_EXCEEDED`), capacity rejection or failed target terminal invariant invalidates execution. Token caps can overshoot by in-flight requests: never promise a monetary hard cap from them.

## Model domain

The default `allowedModels`: every model pi offers through a saved login, each at every thinking level it supports, cheapest first. Local/self-hosted providers registered in `~/.pi/agent/models.json` (llama.cpp, Ollama, vLLM) are included; their catalog price is 0, so they sort first and record 0 USD. Run once from the workflow project and paste the output; add the baseline's own pairs if missing:

```ts
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const runtime = await ModelRuntime.create({ allowModelNetwork: true, refreshOnCreate: false });
await runtime.refresh({ allowNetwork: true });
// The optimizer's preflight requires a saved login; environment-only keys do not qualify.
const logins = new Set((await runtime.listCredentials()).map((c) => c.providerId));
const price = (m: { cost: { input: number; output: number } }) => m.cost.input + m.cost.output;
const allowedModels = (await runtime.getAvailable())
  .filter((m) => logins.has(m.provider))
  .sort((a, b) => price(a) - price(b))
  .flatMap((m) =>
    getSupportedThinkingLevels(m).map((thinking) =>
      // Rungs without thinking mean "off"; the domain check compares the omitted key.
      thinking === "off" ? { model: `${m.provider}/${m.id}` } : { model: `${m.provider}/${m.id}`, thinking },
    ),
  );
console.log(JSON.stringify(allowedModels));
process.exit(0);
```

A local provider without a saved login fails preflight: save one with `runtime.login(provider, "api_key", …)` using the key its server accepts, after the user approves changing `~/.pi/agent`. Its server must be reachable, and its slot count bounds concurrent requests: a workload whose existing deadlines cannot hold under that contention is a prerequisite to report, not a reason to raise them. Local models still need `supportsUsageInStreaming` (or equivalent) so every request reports usage; a request without usage invalidates the run, never counts as free.

## Metrics and measurement coverage

- **tokens** — sum of `resources.tokens` over samples: committed tokens of successful graph-node agent activations. Not `schedules.pi` oracle requests or `task` subagents. A target without agent activations has no token contributors, which is an error, not zero.
- **cost** — sum of `resources.cost`, normalized to USD; no contributors is an error. The default `costMode: "activation"` keeps successful-activation rollups only: never call that total campaign spend. For complete per-request USD use `costMode: "usage"`: each `resource: "cost", kind: "usage"` increment becomes one USD sample with the original Pi `Usage` in `measurement.usage`, regardless of activation success, and activation samples then omit cost. Agents already emit these events: never wrap and count their requests a second time. Attach standalone agents and the scheduler wrapper to the same recorder; unknown usage on failed/aborted attempts invalidates the run. Include spend on unresolved cases; report editor spend separately and in campaign totals. Local models record their catalog price, 0 USD, so their requests still need reported usage. This is catalog-priced recorded usage, not subscription invoice charges.
- **memory** — maximum `resources.memory` in bytes: one activation's shell-pipeline peak, not JS heap, host RSS or simultaneous graph-total memory. Requires a native collection bound to the same recorder, delegated cgroup v2 monitoring and actual coverage: the receipt's `resourceEvents` must be positive. `monitored: true` alone records zeros and is rejected for scoring. An explicitly selected, caller-approved existing memory probe is the only substitute.
- **probe** — values published on one existing numeric edge, matched by wrapper path (`""` root, `Parent/Child` nested) and exact local edge ID, in event order, reduced by `single` (exactly one value) | `last` | `min` | `max` | `sum` | `mean`. Zero and negative values are legitimate; units are the user's.
- **result** — a named finite number from the validated completion receipt's optional `metrics` object, summarized once with unit `null`. Only fixed authoritative external producers qualify; the adapter must reject partial or stale coverage. Result thresholds never authorize changing the evaluator, combining best results across repeats or hiding unsuccessful spend.
- **Stability** — over the last `W` values: `max - min <= absoluteTolerance + relativeTolerance * max(|value|)`. Window values are fresh feasible cycle-start incumbent measurements (or the confirmation's last `W`); promotions and failed re-measurements clear the window.

## Outcomes and evidence

| Stop | Meaning | Target file afterwards |
|---|---|---|
| `converged` | Every requested predicate held on a confirmed incumbent | Winning regions saved; instrumentation dormant |
| `budget` | Caller run/time budget exhausted | `original.ts` restored when safe |
| `cancelled` | Signal received | `original.ts` restored after the owned group is gone |
| `blocked` | Global prerequisite missing (no baseline hash, no complete baseline/incumbent measurement for standard-deviation comparison, missing baseline metric for an improvement goal, zero baseline for a relative goal, target changed outside the optimizer, cleanup unproven) | Restored only when the file still matches the optimizer's last write |
| `failed` | Provider/editor failure, internal error, or quiescence without a terminal state | As above |

Every attempt keeps its run directory: `request.json`, `samples.jsonl`, `completion.json`, `target.stdout`, `target.stderr` (and `reset.*`). `state.json` records each trial's region sources, component/full-file hashes, key, statistics, every run's summaries and errors, and every edit (rejected ones included); `scores.jsonl` is the triplet-indexed per-batch ledger described in [Execution model](#execution-model).
