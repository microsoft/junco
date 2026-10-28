---
name: junco-profile-optimizer
description: 'Profile and tune an existing Junco workflow pair (`workflow.yml` + `workflow.ts`) until a measured objective converges: scheduler, model-ladder and limit experiments that minimize or maximize recorded tokens, recorded memory or an existing numeric edge probe while quality thresholds hold. Use when the user wants to profile, tune, cheapen, speed up or shrink a Junco/JuncoGraph workflow, compare schedulers or model ladders on it, or "optimize until it stops improving" — even without saying "profile optimizer". Not for authoring new workflows (junco-graph-create) or for unmeasured advice.'
---

# Junco profile optimizer

One request → one prepared target plus one invocation of the standard-library optimizer:

```sh
bun run junco-profile-optimizer <sessionDir>/request.json
```

The library (`workflows.optimizer`, `schedules.runOptimizer` from `junco`) owns execution: it runs the target in fresh child processes, parses `JsonlRecorder` evidence, scores trials, decides convergence and drives a fixed GPT-6.1 Sol editor (`github-copilot/gpt-6.1-sol`, thinking `high`) that patches the tuning regions. This skill only inspects, asks for missing intent, prepares the target, writes the request and invokes the command once. Never copy, wrap or re-implement optimizer code, write an outer experiment loop, or hand the editor a fixed candidate catalog.

Target integration details, templates and API limits: [references/profiling.md](references/profiling.md). Read it before preparing a target.

## Hard constraints

- The YAML file stays byte-identical: no new nodes, edges, labels, probes or type changes in the file. Probes are enabled per run on a runtime copy of existing numeric edges only.
- Preserve the entrypoint, invocation, graph-building options, code-node bodies, tools, sandbox/permissions, ownership, inputs, terminal checks and every existing hard limit. Raising or removing a limit is never a candidate.
- Never invent a quality judge, metric, workload, model ID, fallback model or credential. Missing intent → ask; missing prerequisite → report it exactly.
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
   - `memory` — the maximum recorded per-activation shell-pipeline peak. Not JS heap, host RSS or simultaneous graph-total memory. Needs native monitoring coverage (see reference); otherwise only an existing caller-approved memory probe can substitute.
   - `probe` — an existing numeric edge: `{ node: <wrapper path, "" at the root>, edgeId: <exact local edge ID>, reduce: single|last|min|max|sum|mean }`. A graph's display label is not an identity.

   Needing a broader quantity than tokens/memory define requires an existing numeric edge that measures it; never relabel the narrower recorded quantity or add a node/edge.
2. **Quality constraints**: each a metric + `<=`/`>=` + number. When the user says "keep high quality", ask what number on which existing edge means that.
3. **Workload**: the exact fixed input corpus and invocation (`argv`, `cwd`), a stable `workloadId`, a positive repeat count `R`, and either an existing `resetArgv` or confirmation that repeats are safe. Unsafe repetition is a prerequisite, not permission to rerun destructive effects.
4. **Stop condition** — at least one measurable predicate; all given must hold:
   - `target`: absolute objective value;
   - `improvement`: `{ kind: absolute | relative, value > 0 }` over the baseline median ("must decrease/increase" needs this; an unchanged baseline does not satisfy it);
   - `plateau`: `{ window: integer >= 2, absoluteTolerance >= 0, relativeTolerance >= 0 }` (relative is a fraction: 0.01 = 1%).
   Candidate exhaustion or one lucky run is never convergence.
5. **Domain**: axes to explore (`scheduler`, `ladder`, `limits`, in that order); permitted `provider/model` and thinking pairs for the target ladder including the baseline's own (`allowedModels`); upper bounds for extra limits (`limitBounds.memoryBytes|tokens|tools`). Every requested axis must be explored or reported inapplicable with the reason.
6. **Optional budgets**: `runBudget` (child runs) and `timeBudgetMs`. A spend/cost cap requires an authoritative external meter covering every attempt, including failures and subagents; successful-activation JSONL totals cannot enforce it — say so and do not accept it otherwise.

## 3. Prepare the target once

Follow [references/profiling.md](references/profiling.md):

1. `mkdtemp` a session directory under `<directory of workflow.ts>/.junco/profile-optimizer/`.
2. Save `original.yml` and `original.ts` there **before** any change.
3. Move the existing tuning expressions, unchanged, into exactly one ordered marker pair per axis (all three pairs, even for unrequested axes) defining `optimizerScheduler(label)`, `optimizerLadder`/`optimizerStrength` and `optimizerLimits`. Fixed code outside the regions applies strength, extra limits and the original hard limits outermost. If the runner cannot be separated this way without changing its semantics, stop and report the exact integration prerequisite.
4. Add the fixed `JUNCO_PROFILE_RUN_DIR` instrumentation from the reference: run-request validation, document hash, runtime probe copy, ladder/limit domain checks, `JsonlRecorder` on the existing ownership path, cleanup order, and the completion receipt. With the variable absent the workflow behaves exactly as before. Import only public packages; never the installed skill directory.
5. Save the instrumented file as `prepared.ts` (byte-identical to `workflow.ts`). Check it once without paid execution (e.g. `bun build --no-bundle workflow.ts` or the project's typecheck).
6. Write `<sessionDir>/request.json` (schema below). Relative paths resolve against the request file.

```json
{
  "target": { "yaml": "../../../workflow.yml", "ts": "../../../workflow.ts", "cwd": "../../..", "argv": ["bun", "run", "workflow.ts"] },
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

Optional keys: `target.resetArgv`, `runBudget`, `timeBudgetMs`. Unknown keys are rejected.

## 4. Invoke once

From the workflow project, with `junco` installed:

```sh
bun run junco-profile-optimizer <sessionDir>/request.json
```

Exit 0 converged; 2 budget or blocked; 1 failed or invalid input; 130/143 interrupted. Stdout is one JSON summary (`stop`, `baselineScore`, `incumbentScore`, `runCount`, `statePath`, `profilePaths`). If the installed package lacks the `junco-profile-optimizer` binary, report that an optimizer-capable `junco` build/install is required; do not generate a wrapper. Programmatic use under Bun: `schedules.runOptimizer(request, { signal })`.

Before invoking, the user must have authorized paid execution of the workload, and the Sol editor and every allowed target model must pass the optimizer's preflight (catalog, saved login, account access, thinking support). There is no fallback model.

## 5. Report

From `state.json` and the summary: stop kind and reason; baseline and confirmed medians with units and scope (tokens = successful agent activations; memory = per-activation pipeline peak; probe = the user's unit); quality values per constraint; the winning region sources (converged runs leave them saved in `workflow.ts` with dormant instrumentation); run count; and profile paths. A non-converged stop restores `original.ts` when safe — say whether it was restored or preserved because the file changed outside the optimizer. Plateau convergence is measured local stability, not a global optimum.
