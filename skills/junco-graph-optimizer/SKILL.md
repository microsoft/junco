---
name: junco-graph-optimizer
description: 'Optimize the graph topology of an existing Junco workflow pair (`workflow.yml` + `workflow.ts`) by measured experiments: keep a fixed quality metric at least as good while cutting recorded USD (or another named metric), by replacing a costly or difficult agent node with a delegating leader + workers, a single-node Ralph self-loop judged by an authoritative check, or a two-candidate tournament with a reviewer, and by ablating benchmark-proven redundant nodes with parent/child rewiring. Use when the user wants to restructure, decompose, prune or "make the graph cheaper/better" for a Junco/JuncoGraph workflow with a frozen runner. Not for authoring new workflows (junco-graph-create) or tuning schedulers, model ladders or limits (junco-profile-optimizer).'
---

# Junco graph optimizer

Graph experiments on one existing pair: the YAML topology is the only thing that changes between trials. `workflow.ts` is prepared once (measurement instrumentation plus dormant reserved helpers), hashed and frozen — scheduler policy and label dispatch, model ladders, hard limits, existing code bodies, tools, permissions, evaluator and terminal checks are never tuning axes. You (the agent) run the search: author one candidate, measure it with the session's `measure.ts`, decide with the comparator below. No optimizer engine: never call `schedules.runOptimizer` or the `junco-profile-optimizer` binary, copy their controller, or write another one.

Templates, helper code, recipes and measurement: [references/optimization.md](references/optimization.md). Read it before preparing.

## Hard constraints

- Quality comes from a fixed authoritative producer outside the editable region: an existing external evaluator, or a protected evaluator node/edge with all its dependencies. Never invent a judge, quality floor, workload, model or credential; a tournament reviewer is never the benchmark judge.
- Every candidate keeps the original inputs, outputs, terminal contract, permissions, YAML `window`/`threads`, profiles and resource ceilings. New nodes get the replaced node's tools or fewer. Concurrent mutable workers need already-safe independent artifacts/workspaces, else the candidate is inapplicable.
- One transformation per candidate, measured against the same saved incumbent; never stack unmeasured changes.
- Recorded cost is catalog-priced usage, not invoices; offline/faux runs are wiring evidence, never savings. Paid runs need the user's explicit authorization at invocation.
- No hidden iteration cap. Exhausted ideas, inapplicable patterns, budgets and cancellation are stops, not convergence. Never claim a global optimum.
- Never overwrite outside edits: every restore checks the file still holds the skill's last write.

## 1. Inspect before asking

Read the pair, its actual invocation (scripts, README, CI) and its TS build options. Record:

- Graph: nodes, edge IDs (`edge.id ?? from + ("~>" message | "->" value) + to`), nested wrapper paths and labels (`name ?? node id`), triggers, `source.routes`, `sink.returns`, which agents `send` on message edges.
- Everything TS pins: node/edge IDs used by code nodes, `agents` maps (by node path), profiles, terminal checks, label dispatch in `scheduler(label)`/ladder/limits, existing `available` hooks (including any `schedules.ralph`), recorder/tracer/collection ownership, `config.code` keys.
- The existing authoritative whole-workload evaluator and, per candidate Ralph target, an existing synchronous checker that can judge one completed result. Do not create either.
- Tools/MCP/skills per agent, and whether repeated runs are safe or need an existing reset command.
- Any text `__junco_` in either file: a reserved-namespace collision — stop and report it.

## 2. Intake: ask only what the files do not answer

Batch the questions; all are required before measuring:

1. **Workload**: fixed corpus and invocation (`argv`, `cwd`), `workloadId`, positive repeat count `R`, `resetArgv` or confirmation that repeats are safe.
2. **Quality**: the numeric metric, its direction, and its authoritative producer (a finite receipt metric).
3. **Secondary metric** to reduce: recorded USD (`cost`, default) or another named receipt metric.
4. **Tolerances**: absolute/relative for quality equivalence and for secondary improvement; zero unless the caller sets them.
5. **Stop rule**: a target and/or plateau window `W >= 2` with tolerances; optional run/time/spend budgets (a spend cap needs complete attempt accounting).
6. **Authorization** for paid runs, and an explicit Ralph round cap only if the caller wants one (fixed at preparation).

Missing intent → ask. Missing prerequisite (no evaluator, async-only checker, unrecordable request usage, unsafe repetition) → report it exactly; do not fabricate a substitute.

## 3. Prepare once

1. Session: `/tmp/junco-graph-optimizer-workspace/` (mode `0700`, owned, not a symlink) and `mkdtemp` prefix `/tmp/junco-graph-optimizer-workspace/session-`, with the reference's refusal rules. Save `original.yml` and `original.ts` there before any change. The project, cwd, native/Btrfs workspaces and reset command stay in place.
2. Paste the reference's `helpers.ts` block unchanged into `workflow.ts`, and adapt its runner-integration block: `JUNCO_GRAPH_RUN_DIR` request check before any agent is built, `tracer.JsonlRecorder({ path, costMode: "usage" })` on the existing ownership path (never silently replacing an existing recorder), merged `config.code` and `available`, graph close → optional retained TUI `finish()` → recorder close with every error retained, and the receipt written only after complete outcomes and cleanup. Evaluation joins tracer delivery before settling. Without the variable the workflow behaves exactly as before.
3. Freeze per-target entries for every eligible original node you may replace: `ASSIGNMENTS["__junco_opt_<encodeURIComponent(path)>"]` = its original prompt text; `RALPH_CHECKS["__junco_ralph_<encodeURIComponent(path)>"]` = a call into the existing synchronous checker that judges the current result/assignment/round. A missing checker or label is a prerequisite, never an always-true fallback.
4. Check the file without paid execution, save `prepared.ts`, record its sha256 in `campaign.json`, copy `measure.ts` into the session, validate the unchanged baseline once (`measure.ts check`, then a measured baseline). On preparation failure restore only skill-written bytes that still match the last write.

## 4. Experiment cycle

Each cycle starts from the saved incumbent (`candidates/incumbent-<n>.yml`) and its fresh profile.

**A — replace one costly, difficult node.** Rank nodes by recorded USD per recorder path (descendants included, wrapper roll-ups counted once) and corroborate difficulty with evaluator failures, recorded errors, repeated activations, turns and retries. Cost alone is not difficulty. Check eligibility against the reference's replacement boundary, then author, from the same incumbent, one candidate of each applicable pattern:

- **A1 delegating leader** — leader plans for two named worker roles; `__junco_fanout` broadcasts the plan; each worker is a real graph node in its own wrapper; `__junco_fanin` collects; a synthesizer rebuilds the complete required output.
- **A2 Ralph** — `__junco_assignment` feeds a copy of `workflows.ralph` (only `name`/routes rekeyed, original role on its single agent); `ralphUntil` stops on the frozen authoritative check, uncapped unless the caller fixed a cap. Failed/capped runs are failures whose spend counts.
- **A3 tournament** — two independent candidates solve the whole assignment; `__junco_fanin` waits for both; the reviewer reads the ordered array via `recv`, checks it against the original assignment and returns the best complete answer. All spend counts; no early-winner claim.

A pattern that cannot run under the frozen runner is reported with its exact reason, not silently skipped. Measure every applicable alternative, then confirm and promote at most the best eligible one.

**B — remove one suspected redundant node** from the (possibly new) incumbent, chosen from its duties and artifacts, never from cost or degree alone. Delete it and its edges, reconnect required producers directly with their existing transport and schema, and update every placeholder, trigger, route and `sink.returns`. Accept only with nondegrading quality, every hard constraint holding, and strictly lower median recorded USD (plus the caller's secondary metric beyond tolerance when it is not USD).

For every candidate: write it to `candidates/`, then to the target YAML (only if the file still matches the last write), run `measure.ts check`, then `measure.ts run <name> <R>`. Restore the incumbent bytes after a rejected candidate. Re-profile after every promotion before choosing the next hypothesis.

## 5. Decide, confirm, stop

Use the reference's comparator: quality first, medians over `R` valid runs (middle-two mean for even `R`), tolerances `absolute + relative * |incumbent median|`. Invalid batches (failed run, stale/missing receipt, missing or nonfinite metric, TS or YAML changed during the run) never win. Confirm a prospective winner with `R` fresh runs before promotion; a failed confirmation keeps the previous confirmed incumbent.

Stop on a met caller target or a confirmed plateau (stable window, a completed no-promotion cycle, fresh confirmation), or report budget exhaustion, cancellation, or no remaining eligible hypothesis as such. On any stop, keep the last confirmed graph (or the original) in the target YAML — restoring only after the active child and its owned resources are gone and only if the file still matches the skill's last write. `prepared.ts` stays; its recorder is dormant outside measurement.

## 6. Report

Baseline and confirmed median quality, secondary metric and recorded USD with units and coverage (catalog-priced request usage; failed/aborted/subagent requests included; anything unrecorded named). Every tested replacement and removal with its accept/reject reason and inapplicable patterns with theirs. Actual child-run count, stop reason, `prepared.ts` sha256, retained YAML path, and the absolute session directory (ledger, run directories, receipts, stdout/stderr). Campaign spend counts failed trials, and your own authoring/model usage separately when known; unknown overhead is disclosed, never zero. Warn that `/tmp` evidence may disappear on cleanup or reboot; never delete the session yourself.
