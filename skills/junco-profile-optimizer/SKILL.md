---
name: junco-profile-optimizer
description: 'Profile and tune an existing Junco workflow pair (`workflow.yml` + `workflow.ts`) until a measured objective converges: scheduler, model-ladder and limit experiments that minimize or maximize recorded USD, tokens, memory, an existing numeric edge probe or a fixed external result while quality thresholds hold. Use when the user wants to profile, tune, cheapen, speed up or shrink a Junco/JuncoGraph workflow, compare schedulers or model ladders on it, or "optimize until it stops improving" — even without saying "profile optimizer". Not for authoring new workflows (junco-graph-create) or for unmeasured advice.'
---

# Junco profile optimizer

This skill inspects an existing pair, asks for missing intent, prepares the target once, writes one request, invokes the optimizer once and reports. The library (`workflows.optimizer`, `schedules.runOptimizer` from `junco`) owns the optimizer/editor loop: fresh child executions, `JsonlRecorder` evidence, per-batch means and sample standard deviations, rejection of previously tried configurations, promotion and convergence, and a fixed GPT-6.1 Sol editor (`github-copilot/gpt-6.1-sol`, thinking `high`) proposing one-coordinate patches to the tuning regions. The agent proposes; the host scores, accepts and stops. Never copy, wrap or re-implement optimizer code, write an outer experiment loop, write scores, impose hidden quotas, or hand the editor a fixed candidate catalog.

[references/profiling.md](references/profiling.md) holds the execution model, run protocol, request schema, instrumentation template, axes, metrics and evidence contracts. Read it before preparing a target.

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
- Agents and their models; deterministic targets (no agent nodes) have no ladder axis. Admitted agent tools (a tool-call cap needs at least one).
- The models pi offers: every `provider/model` with a saved login, local/self-hosted providers from `~/.pi/agent/models.json` included, with its thinking levels and catalog price ([Model domain](references/profiling.md#model-domain)).
- Whether repeated runs are safe as-is or need an existing reset command.

## 2. Intake: ask only for what the files do not answer

Batch the questions. All six are settled before execution; never invent an answer.

1. **Objective** — exactly one metric and a direction (`minimize` | `maximize`):
   - `tokens`, `cost` or `memory`, each with a narrow recorded scope: `tokens` excludes `schedules.pi` oracle and `task` subagent usage; all-request `cost` needs `costMode: "usage"` and a metered scheduler; `memory` is the per-activation shell-pipeline peak and needs native monitoring coverage. Details: [Metrics and measurement coverage](references/profiling.md#metrics-and-measurement-coverage).
   - `probe` — an existing numeric edge: `{ node: <wrapper path, "" at the root>, edgeId: <exact local edge ID>, reduce: single|last|min|max|sum|mean }`. A graph's display label is not an identity.
   - `result` — `{ kind: "result", name }` from a fixed authoritative producer; define the producer and its full-workload coverage before execution.
   - Broader quantities need an existing numeric edge or fixed external-result producer; never relabel a narrower recorded quantity or change the graph.
2. **Quality constraints and quality index** — each constraint is a metric + `<=`/`>=` + number, a hard gate in every run; complete outcomes below the threshold are scored but infeasible. "Keep high quality" → ask which number on which existing edge or authoritative result. Set `qualityConstraint` (zero-based index into `constraints`) to the authoritative quality metric so a one-SD quality gain can promote too; never guess among several — ask. Omitting it means objective-only promotion.
3. **Fixed workload and repeats** — the exact input corpus and invocation (`argv`, `cwd`), a stable `workloadId`, `R >= 2` repeats (3 recommended; never silently raise an approved count), and an existing `resetArgv` or confirmation that repeats are safe. Unsafe repetition is a prerequisite, not permission to rerun destructive effects.
4. **Stop predicates** — at least one; all given must hold:
   - `target`: absolute objective value, compared to the mean;
   - `improvement`: `{ kind: absolute | relative, value > 0 }` over the baseline mean ("must decrease/increase" needs this; an unchanged baseline does not satisfy it);
   - `plateau`: `{ window: integer >= 2, absoluteTolerance >= 0, relativeTolerance >= 0 }` (relative is a fraction: 0.01 = 1%).

   Convergence also needs a no-promotion cycle over every requested axis and a passing fresh confirmation ([Execution model](references/profiling.md#execution-model)). Candidate exhaustion or one lucky run is never convergence.
5. **Axes and authorized domains** — axes in the fixed order `scheduler`, `ladder`, `limits`: all applicable ones by default, narrower only when the user restricts them. The ladder is inapplicable without agent nodes; a tool-call cap is inapplicable without admitted tools, though token/memory controls can keep `limits` applicable. Report each inapplicability with its reason; never substitute model search or silently drop an axis.
   - `allowedModels` (target ladders and agentic schedulers): by default every model pi offers at each supported thinking level, local ones included, plus the baseline's own, ordered by ascending catalog price (the editor sees only IDs); a narrower set only when the user names one.
   - `limitBounds.memoryBytes|tokens|tools` bound extra limits. A missing `limitBounds.tools` means no numeric bound, not disabled tools; with neither a bound nor useful target evidence for a cap, ask for one.
   - A `schedules.pi` alternative needs the fixed metered/domain-checked `optimizerPi` wrapper outside the regions; it may order ready work, never omit required work or choose model rungs.
6. **Optional budgets** — `runBudget` (child runs) and `timeBudgetMs`. A spend/cost cap requires an authoritative external meter covering every attempt, including failures and subagents; recorded JSONL totals cannot enforce it — say so and do not accept it otherwise.

## 3. Prepare the target once

Follow [references/profiling.md](references/profiling.md), in this order:

1. **Session directory.** Create `/tmp/junco-profile-optimizer-workspace/` if absent (mode `0700`; this literal path, not `$TMPDIR`), then `mkdtemp` with prefix `/tmp/junco-profile-optimizer-workspace/session-`. An existing parent must be a writable directory, not a symlink, owned by the current user, with no group/other access. On any conflict or creation failure, report the exact path and error before changing the target; never overwrite, chmod, empty or follow a conflicting parent, and never fall back to another location.
   The session holds metadata only: snapshots, request, optimizer state/usage, profiles, receipts, output logs and cleanup guards. Leave `BTRFS_ROOT`, native/Btrfs workspaces, mounts, the target's source paths, `argv`/`resetArgv` and its original working directory unchanged. The original entrypoint is instrumented in place; never move or copy the runnable project or its dependencies into the session.
2. **Snapshots.** Save `original.yml` and `original.ts` there **before** any change.
3. **Regions.** Move the existing tuning expressions, unchanged, into exactly one ordered marker pair per axis (all three pairs, even for unrequested axes) defining `optimizerScheduler(label)`, `optimizerLadder`/`optimizerStrength` and `optimizerLimits` ([Tuning regions](references/profiling.md#tuning-regions)). Keep these baseline values unchanged: candidate policies and caps are generated by the editor after baseline measurement, never preinstalled. If the runner cannot be separated this way without changing its semantics, stop and report the exact integration prerequisite.
4. **Instrumentation.** Add the fixed `JUNCO_PROFILE_RUN_DIR` code in place from the [instrumentation template](references/profiling.md#instrumentation-template). Its local `OptimizerProfile` validates the run request, hashes the document, enables probes on a runtime copy, checks candidate ladder rungs and extra limits against `allowedModels`/`limitBounds`, builds each policy with the original hard limits outermost, creates the `JsonlRecorder` on the existing ownership path and, after the existing cleanup order, writes the completion receipt (with requested external-result metrics only after complete evaluator coverage). Agentic scheduler models are checked by the fixed `optimizerPi` integration when applicable. With the variable absent the workflow behaves exactly as before. Import only public packages, never the installed skill directory.
5. **Prepared snapshot.** Save the instrumented file as `prepared.ts` (byte-identical to `workflow.ts`). Check it once without paid execution (e.g. `bun build --no-bundle workflow.ts` or the project's typecheck).
6. **Request.** Write `<sessionDir>/request.json` per [Request schema and example](references/profiling.md#request-schema-and-example). `target.yaml`, `target.ts` and `target.cwd` are absolute paths to the inspected workflow's files and its original working directory; keep `sessionDir: "."` (relative paths resolve against the request file). Direct `schedules.runOptimizer` calls require an absolute `sessionDir` too.

## 4. Invoke once

From the original workflow project, with `junco` installed, passing the absolute request path:

```sh
bun run junco-profile-optimizer <sessionDir>/request.json
```

Exit 0 converged; 2 budget or blocked; 1 failed or invalid input; 130/143 interrupted. Stdout is one JSON summary (`stop`, `baselineScore`, `incumbentScore` — objective means — `runCount`, `statePath`, `scoresPath`, `profilePaths`). Programmatic use under Bun: `schedules.runOptimizer(request, { signal })`. If the installed package lacks the `junco-profile-optimizer` binary, report that an optimizer-capable `junco` build/install is required; do not generate a wrapper.

Before invoking, the user must have authorized paid execution of the workload, and the Sol editor and every allowed target model must pass the optimizer's preflight: catalog, saved login, account access and thinking support. There is no fallback model. Local providers have further login, server, usage and slot prerequisites: [Model domain](references/profiling.md#model-domain).

## 5. Report

From `state.json`, `scores.jsonl` and the summary:

- [ ] Stop kind and reason; after a non-converged stop, whether `original.ts` was restored or preserved because the file changed outside the optimizer or cleanup was unproven.
- [ ] The triplets compared (keys and changed axis) with objective and designated-quality mean, sample SD and repeat count.
- [ ] Which were promoted and which rejected (infeasible, not a one-SD non-regressing gain, or failed measurement), and the confirmation result.
- [ ] Baseline and confirmed means with units and coverage (cost = recorded USD with the target's stated request coverage, local requests at 0 USD; tokens = successful agent activations; memory = per-activation pipeline peak; probe/result = the producer's unit) and per-constraint values.
- [ ] Any configured tool cap and its scope.
- [ ] Axes tried, and axes reported inapplicable with their reasons.
- [ ] The winning region sources (a converged run leaves them saved in `workflow.ts` with dormant instrumentation) and the models the trials actually used.
- [ ] Run count, `statePath`, `scoresPath` and profile paths.
- [ ] Editor USD, separately and included in campaign spend.
- [ ] The absolute session path, with a warning that evidence under `/tmp` can disappear on OS cleanup or reboot. Never delete the session yourself, whatever the stop kind: it is the recovery evidence.

Promotion is a one-SD effect-size heuristic, not a significance test; plateau convergence is measured local stability, not a global optimum. Faux/offline or partial evidence is never claimed as savings.
