---
name: junco-profile-optimizer
description: 'Profile and tune an existing Junco workflow pair (`workflow.yml` + `workflow.ts`) until a measured objective converges: scheduler, model-ladder and limit experiments that minimize or maximize recorded USD, tokens, memory, an existing numeric edge probe or a fixed external result while quality thresholds hold. Use when the user wants to profile, tune, cheapen, speed up or shrink a Junco/JuncoGraph workflow, compare schedulers or model ladders on it, or "optimize until it stops improving" — even without saying "profile optimizer". Not for authoring new workflows (junco-graph-create) or for unmeasured advice.'
---

# Junco profile optimizer

One request → one prepared target plus one invocation of the standard-library optimizer, run from the workflow project with the absolute session path:

```sh
bun run junco-profile-optimizer <sessionDir>/request.json
```

The library (`workflows.optimizer`, `schedules.runOptimizer` from `junco`) owns execution: it runs the target in fresh child processes, parses `JsonlRecorder` evidence, scores trials, decides convergence and drives a fixed GPT-6.1 Sol editor (`github-copilot/gpt-6.1-sol`, thinking `high`) that patches the tuning regions. This skill only inspects, asks for missing intent, prepares the target, writes the request and invokes the command once. Never copy, wrap or re-implement optimizer code, write an outer experiment loop, or hand the editor a fixed candidate catalog.

Target integration details, templates and API limits: [references/profiling.md](references/profiling.md). Read it before preparing a target.

## Hard constraints

- The YAML file stays byte-identical: no new nodes, edges, labels, probes or type changes in the file. Probes are enabled per run on a runtime copy of existing numeric edges only.
- Preserve the entrypoint, invocation, graph-building options, code-node bodies, tools, sandbox/permissions, ownership, inputs, terminal checks and every existing hard limit. Raising or removing a limit is never a candidate.
- Never invent a quality judge, metric producer, workload, model ID, fallback model or credential. External results must come from an existing fixed authoritative evaluator, not a graph change or learned judge. Missing intent → ask; missing prerequisite → report it exactly.
- No implicit or hidden iteration cap. Optional caller run/time budgets only; a budget or cancellation stop is not convergence.
- Report only what the optimizer measured. Faux/offline, parse-only or partial native measurements are never real-world savings.

## 1. Inspect before asking

Read the pair and how it is invoked today (scripts, README, CI, the user's command). Establish from the files:

- Graph structure: nodes, edge IDs (`edge.id ?? from + ("~>" for message | "->" for value) + to`), wrapper-node paths of nested graphs, existing `probe` flags and numeric edges (`schema.type` `number`/`integer`).
- The runner: `JuncoGraph.fromYaml` call, `params`/`sourceName`, scheduler factory and its label dispatch, ladder and strength selection, existing `schedules.limit` wrappers (the hard ceilings), recorder/tracer/collection/`createAgent`/`agents` ownership, the terminal assertion, and cleanup order.
- Agents and their models; deterministic targets (no agent nodes) have no ladder axis.
- Whether repeated runs are safe as-is or need an existing reset command.

## 2. Intake: ask only for what the files do not answer

Batch the questions. Required before execution:

1. **Objective**: exactly one metric and a direction (`minimize` | `maximize`):
   - `tokens` — committed tokens recorded for successful graph-node agent activations. Excludes `schedules.pi` oracle requests and `task` subagent usage.
   - `cost` — sum of recorded `resources.cost`, normalized to USD. For all-request dollars, prepare `JsonlRecorder` with `costMode: "usage"`, and meter scheduler requests separately; missing usage invalidates the run, including failed or aborted requests. Never call successful-activation cost total campaign spend.
   - `memory` — the maximum recorded per-activation shell-pipeline peak. Not JS heap, host RSS or simultaneous graph-total memory. Needs native monitoring coverage (see reference); otherwise only an existing caller-approved memory probe can substitute.
   - `probe` — an existing numeric edge: `{ node: <wrapper path, "" at the root>, edgeId: <exact local edge ID>, reduce: single|last|min|max|sum|mean }`. A graph's display label is not an identity.

   - `result` — `{ kind: "result", name: "resolved" }` reads a finite numeric value from the fixed target's nonce/hash-bound completion receipt. Define its authoritative producer and full-workload coverage before execution; missing or incomplete outcomes invalidate the run.
   Broader quantities need an existing numeric edge or fixed external-result producer; never relabel narrower recorded quantities or change the graph.
2. **Quality constraints**: each a metric + `<=`/`>=` + number. When the user says "keep high quality", ask what number on which existing edge or authoritative external result means that. Complete outcomes below the threshold are scored but infeasible, not an infrastructure failure.
3. **Workload**: the exact fixed input corpus and invocation (`argv`, `cwd`), a stable `workloadId`, a positive repeat count `R`, and either an existing `resetArgv` or confirmation that repeats are safe. Unsafe repetition is a prerequisite, not permission to rerun destructive effects.
4. **Stop condition** — at least one measurable predicate; all given must hold:
   - `target`: absolute objective value;
   - `improvement`: `{ kind: absolute | relative, value > 0 }` over the baseline median ("must decrease/increase" needs this; an unchanged baseline does not satisfy it);
   - `plateau`: `{ window: integer >= 2, absoluteTolerance >= 0, relativeTolerance >= 0 }` (relative is a fraction: 0.01 = 1%).
   Candidate exhaustion or one lucky run is never convergence.
5. **Domain**: axes to explore (`scheduler`, `ladder`, `limits`, in that order); permitted `provider/model` and thinking pairs for both target ladders and agentic schedulers, including the baseline's own (`allowedModels`); upper bounds for extra limits (`limitBounds.memoryBytes|tokens|tools`). Every requested axis must be explored or reported inapplicable with the reason. A `schedules.pi` alternative requires a fixed metered/domain-checked wrapper outside the tuning region; it may order ready work, never omit required work or choose model rungs.
6. **Optional budgets**: `runBudget` (child runs) and `timeBudgetMs`. A spend/cost cap requires an authoritative external meter covering every attempt, including failures and subagents; successful-activation JSONL totals cannot enforce it — say so and do not accept it otherwise.

## 3. Prepare the target once

Follow [references/profiling.md](references/profiling.md):

1. Create the session metadata directory: create `/tmp/junco-profile-optimizer-workspace/` if absent (mode `0700`; this literal path, not `$TMPDIR`), then `mkdtemp` with prefix `/tmp/junco-profile-optimizer-workspace/session-`. An existing parent must be a writable directory, not a symlink, owned by the current user, with no group/other access. On any conflict or creation failure, report the exact path and error before changing the target; never overwrite, chmod, empty or follow a conflicting parent, and never fall back to another location.
   The session holds metadata only: snapshots, request, optimizer state/usage, profiles, receipts, output logs and cleanup guards. Leave `BTRFS_ROOT`, native/Btrfs workspaces, mounts, the target's source paths, `argv`/`resetArgv` and its original working directory unchanged. The original entrypoint is instrumented in place; never move or copy the runnable project or its dependencies into the session.
2. Save `original.yml` and `original.ts` there **before** any change.
3. Move the existing tuning expressions, unchanged, into exactly one ordered marker pair per axis (all three pairs, even for unrequested axes) defining `optimizerScheduler(label)`, `optimizerLadder`/`optimizerStrength` and `optimizerLimits`. Fixed code outside the regions applies strength, extra limits and the original hard limits outermost. If the runner cannot be separated this way without changing its semantics, stop and report the exact integration prerequisite.
4. Add the fixed `JUNCO_PROFILE_RUN_DIR` instrumentation from the reference: run-request validation, document hash, runtime probe copy, ladder/scheduler/limit domain checks, `JsonlRecorder` on the existing ownership path, cleanup order, and the completion receipt (including requested external-result metrics only after complete evaluator coverage). With the variable absent the workflow behaves exactly as before. Import only public packages; never the installed skill directory.
5. Save the instrumented file as `prepared.ts` (byte-identical to `workflow.ts`). Check it once without paid execution (e.g. `bun build --no-bundle workflow.ts` or the project's typecheck).
6. Write `<sessionDir>/request.json` (schema below). `target.yaml`, `target.ts` and `target.cwd` are absolute paths to the inspected workflow's files and its original working directory; keep `sessionDir: "."` (relative paths resolve against the request file). Direct `schedules.runOptimizer` calls require an absolute `sessionDir` too.

```json
{
  "target": { "yaml": "/absolute/path/to/project/workflow.yml", "ts": "/absolute/path/to/project/workflow.ts", "cwd": "/absolute/path/to/project", "argv": ["bun", "run", "workflow.ts"] },
  "sessionDir": ".",
  "workloadId": "fixed-input-corpus-v1",
  "objective": { "metric": { "kind": "tokens" }, "direction": "minimize" },
  "constraints": [{ "metric": { "kind": "probe", "node": "", "edgeId": "quality", "reduce": "single" }, "op": ">=", "threshold": 0.9 }],
  "repeats": 3,
  "stop": { "improvement": { "kind": "relative", "value": 0.2 }, "plateau": { "window": 3, "absoluteTolerance": 0, "relativeTolerance": 0.01 } },
  "axes": ["scheduler", "ladder", "limits"],
  "allowedModels": [{ "model": "provider/baseline-model" }, { "model": "provider/cheaper-model", "thinking": "low" }],
  "limitBounds": { "tokens": 20000 }
}
```

The `target` paths above are illustrative; substitute the inspected workflow's absolute paths. Optional keys: `target.resetArgv`, `runBudget`, `timeBudgetMs`. Unknown keys are rejected.

## 4. Invoke once

From the original workflow project, with `junco` installed, passing the absolute request path:

```sh
bun run junco-profile-optimizer <sessionDir>/request.json
```

Exit 0 converged; 2 budget or blocked; 1 failed or invalid input; 130/143 interrupted. Stdout is one JSON summary (`stop`, `baselineScore`, `incumbentScore`, `runCount`, `statePath`, `profilePaths`). If the installed package lacks the `junco-profile-optimizer` binary, report that an optimizer-capable `junco` build/install is required; do not generate a wrapper. Programmatic use under Bun: `schedules.runOptimizer(request, { signal })`.

Before invoking, the user must have authorized paid execution of the workload, and the Sol editor and every allowed target model must pass the optimizer's preflight (catalog, saved login, account access, thinking support). There is no fallback model.

## 5. Report

From `state.json` and the summary: stop kind and reason; baseline and confirmed medians with units and scope (cost = recorded USD with the target's stated request coverage; tokens = successful agent activations; memory = per-activation pipeline peak; probe/result = the producer's unit); quality values per constraint; the winning region sources (converged runs leave them saved in `workflow.ts` with dormant instrumentation); run count; and profile paths. A non-converged stop restores `original.ts` when safe — say whether it was restored or preserved because the file changed outside the optimizer. Report editor USD separately and include it in campaign spend. Plateau convergence is measured local stability, not a global optimum.

Give the absolute session path and warn that evidence under `/tmp` can disappear on OS cleanup or reboot. Never delete the session yourself, whatever the stop kind: it is the recovery evidence.
