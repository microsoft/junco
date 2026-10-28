# Profile optimizer: intake for `audit.yml` + `audit.ts`

I inspected the pair but have **not** prepared or run anything: required intent and one measurement prerequisite are missing. The workspace is unchanged (no session directory, no markers, no instrumentation; `audit.yml` is byte-identical).

## What the files establish
- Root graph `Audit`: `Collect` (code) → `Review` (nested graph) → `Publish` (code) → `$sink`. Root edges: `Collect->Review` (string), `Review->Publish` (number), `Publish->$sink` (number).
- Nested `Review` (wrapper path `Review`): `$source~>Check` (message), `Check->Score` (object), and **`quality`** = `Score->$sink` (number). `Check` is the only agent (`bash` tool); `Score` returns 0.9, or 0.4 if the report contains `FAIL`.
- Runner: `JuncoGraph.fromYaml(..., { scheduler: () => schedules.parallel(), ladder: uniformLadder(github-copilot/claude-sonnet-5.5, medium), code, tracer: DummyTracer })`. No `schedules.limit` (no hard ceilings), no strength selector, no recorder, no native collection/`createAgent`/`agents`. Terminal check: sink must be a number.
- Workload: `Collect` returns the script's own directory, and `Check` runs repository checks with bash there. No script/README shows how it's invoked or whether repeated runs are safe.

## Blocking prerequisite: memory measurement
Your objective is `memory` (max per-activation shell-pipeline peak, not JS heap or host RSS). That needs a native collection bound to the run's recorder with delegated cgroup v2 monitoring and real resource-event coverage. `audit.ts` builds no collection, and the YAML has no memory edge. Without that, recorded memory would be zeros, and the optimizer rejects memory scoring with no coverage. I won't add a node/edge or treat another quantity as memory. Options:
1. Confirm that this host has delegated cgroup v2 and that you approve the instrumentation creating a monitored native collection for `Check`'s bash work. That is a new ownership path, so please confirm it explicitly. Or
2. Name an existing numeric edge you already accept as a memory measure. None exists today.

## Questions (answer together)
1. **Quality**: what number means "high quality"? The only quality signal is the nested probe `{ kind: "probe", node: "Review", edgeId: "quality", reduce: "single" }`, which takes 0.9 or 0.4. Is the constraint `>= 0.9`? (The display label isn't an identity; root `Review->Publish` carries the same value.)
2. **Stop condition**, at least one: an absolute memory target (bytes), a required improvement over baseline (e.g. relative 0.2), and/or a plateau (window W ≥ 2, absolute and relative tolerances). "Use less memory" implies a positive improvement requirement. How much?
3. **Workload**: the exact invocation (I assume `argv: ["bun", "run", "audit.ts"]`, `cwd` = this directory), the fixed repository state it audits, a `workloadId`, the repeat count R, and either a reset command or confirmation that repeated bash checks are safe.
4. **Domain**: which axes (scheduler / ladder / limits)? For the ladder, which model/thinking pairs besides baseline `github-copilot/claude-sonnet-5.5`/`medium` are allowed? There's no fallback model. For limits, what is the upper bound on extra limits (`limitBounds.memoryBytes`)? No existing ceilings are present to preserve.
5. **Optional budgets**: `runBudget` / `timeBudgetMs`. None by default; a budget stop is not convergence.

## Once answered
I'll create a session under `.junco/profile-optimizer/`, snapshot `original.yml`/`original.ts`, move the scheduler/ladder/limits expressions into marker regions, and add dormant `JUNCO_PROFILE_RUN_DIR` instrumentation (recorder with `monitored: true`, runtime-only `probe: true` on `Review`/`quality`). I'll then write `request.json` and run it once:

```sh
bun run junco-profile-optimizer .junco/profile-optimizer/<session>/request.json
```

Not verified yet: the installed `junco` provides that binary; the Sol editor (`github-copilot/gpt-6.1-sol`) and the target models pass login/access preflight; cgroup v2 delegation. There are no measurements and no savings claims.
