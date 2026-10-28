# Junco profile optimizer: report.yml / report.ts preparation

I prepared everything and stopped before any paid run. I made no model or provider calls: no preflight, no baseline run, and no optimizer invocation.

## What I did

1. **Inspected the pair.**
   - `Writer` is the only agent node. It runs on the ladder's default `med` rung, currently `github-copilot/claude-sonnet-5.5` with `medium` thinking.
   - `Quality` is a code node that returns `0.95` when the report contains `## Highlights` and `0.5` otherwise. It sends that number on the root edge `quality` (`number`) to `$sink`.
   - The scheduler is `schedules.limit({ tools: 40 }, schedules.parallel())`.
2. **Created a fresh session** at `.junco/profile-optimizer/session-P7LDEI/`. It contains:
   - `original.yml` and `original.ts`: byte-for-byte snapshots taken before any change.
   - `prepared.ts`: the instrumented entrypoint, identical to the new `report.ts`.
   - `notes.md`: a snapshot of the fixed input, sha256 `59e5fac2…96ac`.
   - `request.json`: the optimization request.
   - No `state.json`, `optimizer.jsonl` or `runs/` yet, as a fresh session requires.
3. **Instrumented `report.ts`.** `report.yml` is unchanged (sha256 `9e6b0556…8a43f8a` matches `original.yml`).
   - **Three tuning regions with marker pairs**, holding today's settings as the baseline:
     - scheduler: `optimizerScheduler = (_label) => schedules.parallel()`
     - ladder: `optimizerLadder = uniformLadder({ claude-sonnet-5.5, medium })`, plus `optimizerStrength = undefined` (keeps the `med` rung)
     - limits: `optimizerLimits = {}`
   - **Fixed code outside the regions:**
     - The original hard ceiling `{ tools: 40 }` stays the outermost limit around every candidate.
     - The `Quality` code node is unchanged and still exported as `code`.
     - Graph parsing, the original terminal check (`no quality score`) and the `{"quality": …}` output are unchanged.
   - **Instrumentation runs only when `JUNCO_PROFILE_RUN_DIR` is set**, so plain `bun run report.ts` behaves as before. When it is set, the entrypoint:
     - Reads and validates the per-run `request.json`.
     - Hashes the parsed graph document and rejects drift from the baseline hash.
     - Rejects a candidate ladder that uses any model/thinking pair outside the allowed list.
     - Rejects any extra limit that has no bound. Only `tokens` up to 20000 is authorized; extra memory or tool limits are refused.
     - Marks the existing `quality` edge as a probe. No new edge is added and the YAML file is not touched.
     - Attaches a `JsonlRecorder` writing `samples.jsonl`.
     - Closes the graph, tracer and recorder before anything else.
     - Writes `completion.json` (nonce, `terminal: true`, graph hash) only after the terminal check and every cleanup step succeed.
4. **Request** (`.junco/profile-optimizer/session-P7LDEI/request.json`):
   - Objective: minimize `tokens`.
   - Constraint: probe `{ node: "", edgeId: "quality", reduce: "single" } >= 0.9`.
   - `repeats: 3`.
   - Stop conditions: relative improvement ≥ `0.2`, and a plateau with `window: 3`, `absoluteTolerance: 0`, `relativeTolerance: 0.01`. Both must hold.
   - `axes: ["scheduler", "ladder", "limits"]`.
   - `allowedModels`: `github-copilot/claude-sonnet-5.5`/`medium` and `github-copilot/claude-haiku-5`/`low`.
   - `limitBounds: { tokens: 20000 }`.
   - `argv: ["bun", "run", "report.ts"]`, run in the workspace.
   - `resetArgv` copies the `notes.md` snapshot back before every run, so a run cannot change the fixed input seen by later repeats.
   - No run or time budget, as you specified.

## Offline checks (none of them call a model)
- The request passes the library's `checkRequest`. The snapshots in the session directory match the workspace files byte for byte.
- `bun build --no-bundle report.ts` transpiles. `tsc --strict` reports only the same 2 errors as `original.ts`; both are in your unchanged `Quality` node (the generator's return type and the `"Writer->Quality"` EdgeId brand). The instrumentation adds none.
- I ran the prepared entrypoint with a dummy run directory that allows no models. It failed in the ladder authorization check before the graph was built, and wrote no receipt.
- Adding `probe: true` to the root `quality` edge passes `syntax.parse`.
- `dist/optimizer-cli.js` runs; with no arguments it prints its usage and exits 1.

## Command to run
From `/home/eioannidis/git/junco/skills/junco-profile-optimizer-workspace/iteration-1/eval-1-token-quality-preparation/without_skill/workspace`:

```sh
bun run /home/eioannidis/git/junco/dist/optimizer-cli.js .junco/profile-optimizer/session-P7LDEI/request.json
```

The packaged name `bun run junco-profile-optimizer <request.json>` is not linked here, because `node_modules/.bin/junco-profile-optimizer` does not exist yet. It will work after the optimizer-capable `junco` build is installed (`bun install`).

Exit codes are 0 for converged, 2 for budget/blocked, 1 for failed, and 130/143 for Ctrl-C/TERM. The command prints a JSON summary; evidence is in `state.json`, `optimizer.jsonl` and `runs/NNNN/` in the session directory. On convergence the verified tuning stays in `report.ts`; any other stop restores `original.ts` when that is safe.

## Prerequisites I could not verify (please confirm)
1. **`github-copilot/claude-haiku-5` is not in the bundled GitHub Copilot model catalog.**
   - The bundled catalog has `claude-haiku-4.5`, which supports `low` thinking.
   - Unless your account's live catalog lists `claude-haiku-5`, the optimizer's preflight will stop as blocked before anything runs. It does not fall back to another model.
   - Should I swap it for `claude-haiku-4.5`/`low`, or keep it as written?
2. **Logins.** A saved GitHub Copilot login with access to `claude-sonnet-5.5`, `claude-haiku-5` and the fixed editor model `github-copilot/gpt-6.1-sol` (thinking `high`) has not been checked. The preflight checks these first.
3. **What "tokens" counts.** The recorder counts committed tokens of successful graph-node agent activations, which here means `Writer`. If `Writer` delegates through the `task` tool, subagent tokens are not counted. Failed runs are not counted either.
4. **Repeat safety.** The reset restores only `notes.md`. If `Writer` creates or edits other files in the workspace, later repeats are no longer identical; tell me which files to reset.
5. **The quality check is a heuristic.** `quality ≥ 0.9` currently means only "the report has a `## Highlights` heading". That is the only quality protection; the optimizer does not judge content.
6. **No spending cap.** There is no budget, and the run continues until convergence. Each configuration costs 3 runs, and confirmation adds 3 more per attempt. Extra token caps can overshoot while requests are in flight; they are not a spending limit. If you want a hard stop, add `"runBudget": N` or `"timeBudgetMs": N` to `request.json`.

## Files changed
- `report.ts`: instrumented with three tuning regions; behaves as before unless run by the optimizer.
- New: `.junco/profile-optimizer/session-P7LDEI/{original.yml, original.ts, prepared.ts, notes.md, request.json}`.
- `report.yml` and `notes.md`: unchanged.
