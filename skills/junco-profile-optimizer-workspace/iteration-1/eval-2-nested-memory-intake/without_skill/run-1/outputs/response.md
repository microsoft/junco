# Profile-optimizing `audit.yml` + `audit.ts` for memory: stopped before running

I didn't start the optimizer. Two of its required inputs can't be read from the files: a numeric bar for "high quality", and a way to measure memory that this machine can provide. Starting without them would mean making up a constraint or a metric, and the run would use paid model calls. **`audit.yml` and `audit.ts` are unchanged.**

I worked out the request from the library itself (`src/std/schedules/optimizer.ts`, `optimizer-profile.ts`, the recorder and the run protocol in `test/profile-optimizer.fixture.ts`). Below are what I found, a draft of the prepared entrypoint, and the questions I need answered.

## What I did
- **Draft instrumented entrypoint:** `outputs/audit.prepared.ts` is a ready version of `audit.ts` that I have not applied.
  - It has the three tuning regions the optimizer edits: `scheduler`, `ladder` and `limits`. Their baseline values are the current ones: `schedules.parallel()`, a uniform `github-copilot/claude-sonnet-5.5`/`medium` ladder and no extra limits.
  - It adds the `JUNCO_PROFILE_RUN_DIR` run protocol: it reads the run's `request.json`, adds probes to a runtime copy of the YAML only, checks the graph hash, writes a `JsonlRecorder` profile and a `completion.json` file once a run finishes cleanly, and turns native resource monitoring on only when memory is scored.
  - The code nodes, the existing terminal check and how you run the file are unchanged. With the variable unset, it behaves exactly like today's `audit.ts`.
- **Checks I ran (offline):**
  - `bun build --no-bundle` transpiles the draft.
  - `tsc --strict` reports no errors in the added code. It does report four errors in the code nodes, but `audit.ts` already has those same errors and Bun runs it without type-checking.
  - I parsed `audit.yml` and confirmed the quality probe can attach: inside the `Review` wrapper there is exactly one edge with local ID `quality` (`Score → $sink`), its schema is `{type: number}`, and setting `probe: true` on it still validates.

## What I need from you
1. **What score counts as "high quality"?** The only numeric quality signal is the existing edge `quality` inside the nested `Review` graph. In request terms that is `{ "kind": "probe", "node": "Review", "edgeId": "quality", "reduce": "single" }`. `node` is the wrapper path; this is not the root edge `Review->Publish`.
   - Its values are `0.9` (the report doesn't contain "FAIL") or `0.4`. Is the constraint `>= 0.9`?
   - Be aware that `Score` only checks whether the text contains "FAIL". A cheaper or lower-memory configuration whose model runs fewer checks, or never prints "FAIL", would still score 0.9. If that isn't what you mean by high quality, I need an existing numeric edge that measures it. I won't add a judge or change the graph.
2. **Which memory do you want reduced?** The memory the recorder can measure is the highest memory peak of any single bash command `Check` runs (the native tools measure it through Linux cgroup v2). It is not process RSS, JS heap or model context size.
   - This needs a cgroup v2 setup that gives your user the cpu, memory and pids controllers. In this environment the shell sits in root-owned `/sys/fs/cgroup/init.scope` with an empty `cgroup.subtree_control`, so I couldn't confirm that. If monitoring is turned on without it, bash commands fail with `cgroup resource control unavailable`, and runs that report no resource events are rejected rather than scored as 0.
   - `audit.yml` has no existing numeric edge that measures memory, so nothing can stand in for this. Can you run it on a host that provides this cgroup setup? If you meant a different kind of memory, which existing numeric edge measures it?
3. **Workload and repeatability.**
   - `Collect` returns the workspace directory, so `Check` runs "the repository checks" in a folder that contains only `audit.yml` and `audit.ts`. Which repository and checks make up the fixed workload?
   - Is running it repeatedly safe and free of side effects? If not, which reset command should run before each attempt (`resetArgv`)?
   - I'd run it as `["bun", "audit.ts"]` in that directory. Is that right?
4. **Repeat count and stopping rule.**
   - How many runs per configuration (`repeats`, for example 3)?
   - When should it stop? At least one of: a target peak in bytes, a required improvement over the baseline (for example 20% relative), and/or a plateau (window ≥ 2 plus absolute and relative tolerances).
   - Optionally, a run budget or time budget. These stop the run without counting as convergence. There is no cap unless you set one.
5. **What the optimizer may change.**
   - Which other model/thinking pairs may the ladder use (`allowedModels`)?
   - What upper limits apply to extra limits (`limitBounds`)?
   - Practical note: `audit.yml` has no `profiles`, so memory-based admission limits and `choose`/`lowest("memory")` ranking have no forecasts to use. `Check` is the only agent node, so changing the scheduler is unlikely to affect per-command peaks. The model ladder is the realistic lever, so I suggest `axes: ["ladder"]` (optionally adding `"scheduler"`) unless you want the others tried anyway.
6. **Editor login.** The optimizer's editor is fixed to `github-copilot/gpt-6.1-sol` with `high` thinking and no fallback. Your saved login and account access are checked only when the run starts; I couldn't verify them here.

## Request once you've answered
```json
{
  "target": { "yaml": "audit.yml", "ts": "audit.ts", "cwd": ".", "argv": ["bun", "audit.ts"] },
  "sessionDir": ".junco/profile-optimizer/<session>",
  "workloadId": "<your fixed checks>",
  "objective": { "metric": { "kind": "memory" }, "direction": "minimize" },
  "constraints": [{ "metric": { "kind": "probe", "node": "Review", "edgeId": "quality", "reduce": "single" }, "op": ">=", "threshold": 0.9 }],
  "repeats": 3,
  "stop": { "improvement": { "kind": "relative", "value": 0.2 } },
  "axes": ["ladder"],
  "allowedModels": [{ "model": "github-copilot/claude-sonnet-5.5", "thinking": "medium" }],
  "limitBounds": {}
}
```
The `0.9` threshold, `repeats`, `stop`, `axes` and `allowedModels` values above are only examples until you confirm them in items 1–5; `<…>` marks values only you can supply.

Once those answers are in, the steps are:
1. Create a fresh session directory under `.junco/profile-optimizer/` containing `original.yml`, `original.ts`, `prepared.ts` (the draft) and `request.json`.
2. Copy `prepared.ts` over `audit.ts`.
3. Run from the workspace:
```sh
bun run /home/eioannidis/git/junco/dist/optimizer-cli.js .junco/profile-optimizer/<session>/request.json
```
If the package is installed in the project, `bun run junco-profile-optimizer <request.json>` does the same. Exit code 0 means it converged and the winning settings are saved in `audit.ts`. Exit code 2 means a budget ran out or a prerequisite was missing, and `audit.ts` is restored to the original.

## Files
- `outputs/audit.prepared.ts` — draft instrumented entrypoint (not applied)
- `outputs/response.md` — this report
- `workspace/audit.yml`, `workspace/audit.ts` — unchanged
