# Profile optimizer prepared for `report.yml` / `report.ts` (no paid run made)

## What I found
- Graph: `Writer` (agent) → `Quality` (code node) → `$sink` on the edge with ID `quality` (`type: number`). This is root-level, so the probe identity is `{ node: "", edgeId: "quality" }`.
- Runner: `JuncoGraph.fromYaml` with `scheduler: () => schedules.limit({ tools: 40 }, schedules.parallel())` and the uniform ladder `github-copilot/claude-sonnet-5.5` / `medium`. Without a strength selector, Writer uses the `med` rung. The run passes only if the sink produces a number (`no quality score` is thrown otherwise).
- `tools: 40` is the existing hard ceiling. It stays the outermost wrapper and is never a candidate.

## What I changed
- `report.yml`: **byte-identical** (checked with `cmp` against the snapshot).
- `report.ts`: the existing tuning moved, unchanged, into three marker regions:
  - **scheduler:** `schedules.parallel()`
  - **ladder:** the Sonnet 5.5 / medium uniform ladder, with `optimizerStrength = undefined`
  - **limits:** `{}`, so no extra limits at baseline
- Also added to `report.ts`: the fixed `JUNCO_PROFILE_RUN_DIR` instrumentation from the skill reference. It covers:
  - validating the run request
  - hashing the canonical graph document
  - a runtime-only probe on `quality`
  - checking each candidate's ladder and limits against the allowed domain
  - a `JsonlRecorder`
  - cleanup in the order graph → tracer → recorder
  - an atomic `completion.json` receipt
- When that environment variable is absent, `bun run report.ts` behaves as before: same graph, the effective `tools: 40` limit around `parallel`, same ladder, same terminal check and the same output.
- Session directory: `.junco/profile-optimizer/session-baTf1i/`. It contains `original.yml`, `original.ts` (both snapshotted before the edit), `prepared.ts` (identical to the current `report.ts`) and `request.json`:
  - Objective: minimize `tokens`.
  - Constraint: probe `quality` / `single` `>= 0.9`.
  - Repeats: `3`.
  - Stop condition: a relative improvement of `0.2` and a plateau of window 3, absolute tolerance 0, relative tolerance 0.01.
  - Axes: scheduler, ladder and limits.
  - Allowed models: Sonnet 5.5 / medium and Haiku 5 / low.
  - `limitBounds.tokens`: 20000.
  - No run or time budget, so there is no iteration cap.
  - `workloadId`: `notes.md-sha256-59e5fac20028d641`, from the current `notes.md` hash.

## Command (run from the workspace, only when you authorize paid runs)
```sh
bun run junco-profile-optimizer .junco/profile-optimizer/session-baTf1i/request.json
```
Exit codes:
- **0:** converged. The winning tuning is left saved in `report.ts`.
- **2:** budget exhausted or blocked.
- **1:** failed.
- **130/143:** interrupted.

On a non-converged stop, `original.ts` is restored if that is safe.

## Not verified / prerequisites
- **Checks run:** only a compile with `bun build --no-bundle report.ts`, which passed. No dependencies are installed in this workspace (`node_modules` is absent), so neither types nor runtime were checked against the real `junco`.
- **Package binary:** you need a `junco` install that provides the `junco-profile-optimizer` binary. If yours doesn't have it, an optimizer-capable build/install is required.
- **Logins and model access:** you need working GitHub Copilot logins for:
  - the fixed editor, `github-copilot/gpt-6.1-sol` (thinking: high)
  - Sonnet 5.5 / medium
  - Haiku 5 / low

  The optimizer preflight checks these, and there is no fallback model.
- **Repeated runs:** I assumed repeated runs are safe without a reset command, because the Writer only reads `notes.md`. If Writer can write files with its tools, please confirm or give me a `resetArgv`.
- **Token caps:** a token cap limits usage per scope, can overshoot, and is not a spend cap.
- **What gets counted:** tokens are only those recorded for successful graph-node agent activations.
- **Ladder axis:** with a uniform ladder, the ladder edits have to change the `med` rung, because that is the one Writer actually uses.
