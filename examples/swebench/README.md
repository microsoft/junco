# SWE-bench Verified workflow

One shared workflow pair for every SWE-bench Verified problem, plus the harness that runs it:

- `wf.yml`: topology, edges and role prompts.
- `wf.ts`: code nodes, the model ladder and role strengths, the scheduler, the container roles (`ROLES`, `SANDBOX`, `BRANCHES`), the `Host` contract and `run`.
- `run-workflow.ts`: the per-instance runtime (guarded models, container-bound `bash`, recordings, telemetry) and `test_runtime.test.ts`.
- `benchmark.py`: the corpus CLI (prepare, validate, run, official grading), `test_benchmark.py` and `requirements.txt`.
- `solo.{yml,ts}`: the single-agent Opus 5.5 (high thinking) baseline; select it with `SWEBENCH_PAIR=solo`.

```
Input → Lead → Assign → {Trace, Reproduce, Contracts} → JoinEvidence → Planner (Draft ⇄ CheckPlan) → Dispatch
  → {CandidateA, CandidateB} → {ValidateA, ValidateB} → TournamentGate → Apply → Integrator
  → Freeze → Verifier → Finish → sink
```

The prepared small-model workflow uses Sonnet 5.5 with high thinking for Lead, Planner and Integrator; Haiku 5.5 with medium thinking for CandidateA, Reproduce and Verifier; and GPT-6 Luna with medium thinking for CandidateB, Contracts and Trace. Nested agents inherit their first path segment's role. The solo baseline uses Opus 5.5 with high thinking throughout.

Each instance gets nine containers from its official SWE-bench image: six agent sandboxes and three acceptance sandboxes reachable only by code nodes. Each shell role has its own native collection whose only bash backend runs in its container, at `/testbed`, with the `testbed` environment active and no network. Every role blocks host file tools and `task`; Lead and Planner also block bash. The ladder checks the full active node path before each provider request, logs accepted requests and refuses missing, unknown or wrongly routed roles. Each agent writes its own durable session.

`CheckPlan` receives each completed draft, runs its checks separately on the clean canonical baseline, and resets after each check. It sends the plan producer at most three correction assignments with the attempt number and observed failures. A parsed fourth draft proceeds with surviving checks (possibly none), records `planning/degraded.txt`, and warns both candidates. A malformed fourth draft still fails. The tournament prefers the first valid patch; if both fail acceptance, it selects an applying patch with the fewest failed checks (tie: A), records the degraded selection and asks Integrator to repair it. Two non-applying candidates still fail. Finish checks the unchanged final patch in a pristine sandbox; only the official SWE-bench evaluator decides resolution.

Dormant code supports YAML-only alternatives: multiple issue recipients, a Critic/Merge plan producer with return and correction message edges to and from `CheckPlan`, `JoinDrafts`, and edge-keyed Integrator/Verifier ablations. The incumbent retains all roles.

## Running

The harness runs in its own directory next to this repository (`../junco-swebench`). It never imports this checkout directly: it runs a frozen snapshot, `.junco-snapshot`. Workflow pairs and TypeScript entrypoints link into that snapshot so shared relative imports keep resolving there.

Live runs require Linux x86-64, Bun, Docker (images `swebench/sweb.eval.x86_64.*` are pulled on demand), Python 3 and a saved Pi login for every model selected by the ladder. Place the harness and prepared problems inside a dedicated writable Btrfs seed with a writable parent and `user_subvol_rm_allowed`; live preflight opens its native collections in the current directory. See the [native tool requirements](../../packages/junco-tools/README.md). A missing seed is an error, never a host-shell fallback. `prepare` needs network access to Hugging Face and GitHub. `--check` does not open models, sessions, collections or containers.

### 1. Snapshot junco

Run this from the harness directory after every change to junco or to this directory, from an installed junco checkout (`bun install` at its root):

```sh
rsync -a --delete --exclude=/.git --exclude=/.junco --exclude=/.claude/settings.local.json \
  --exclude=/crates/marsh/target --exclude=/crates/junco-policy/target --exclude=/crates/junco-policy/fuzz/target \
  --exclude=/packages/junco-tools/target --exclude=/packages/junco-tools/xtask/target \
  --exclude=/REVISION --exclude=/STATUS ../junco/ .junco-snapshot/
git -C ../junco rev-parse HEAD > .junco-snapshot/REVISION
git -C ../junco status --porcelain > .junco-snapshot/STATUS
cp .junco-snapshot/examples/swebench/{benchmark.py,test_benchmark.py,requirements.txt} .
for file in run-workflow.ts test_runtime.test.ts wf.yml wf.ts solo.yml solo.ts; do
  ln -sfn .junco-snapshot/examples/swebench/$file $file
done
```

Every run records `REVISION` and `STATUS` together with the sha256 of the selected pair's YAML and TypeScript files (`wf.yml`/`wf.ts` by default, or `solo.yml`/`solo.ts`). A run counts as dirty when `STATUS` lists any change except untracked files.

### 2. Set up the harness once

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # pinned SWE-bench harness
mkdir -p node_modules/@earendil-works
ln -sfn ../.junco-snapshot node_modules/junco
for p in dataflow-engine dataflow-engine-opik dataflow-profile opik; do
  ln -sfn ../.junco-snapshot/node_modules/$p node_modules/$p
done
for p in pi-agent-core pi-ai pi-coding-agent; do
  ln -sfn ../../.junco-snapshot/node_modules/@earendil-works/$p node_modules/@earendil-works/$p
done
```

`node_modules` holds only symlinks into the snapshot. `bun install` cannot resolve the snapshot's workspace dependencies, so the links are made by hand.

### 3. Prepare, check and run

```sh
.venv/bin/python benchmark.py prepare                         # pinned dataset → <instance_id>/problem.json + repo/
.venv/bin/python benchmark.py validate                        # every problem record, plus run-workflow.ts --check once
bun run run-workflow.ts --check astropy__astropy-12907        # offline check of the pair against one problem
bun run run-workflow.ts --preflight                           # live: worker tool call and lead handoff
.venv/bin/python benchmark.py run --instance-id astropy__astropy-12907
SWEBENCH_PAIR=solo .venv/bin/python benchmark.py run --instance-id astropy__astropy-12907
.venv/bin/python benchmark.py run --parallel 6                # all 500 instances, up to six concurrently
```

`run` validates first, then executes up to `--parallel N` independent instances concurrently (default 1). It grades each canonical patch with the official harness and durably appends one JSONL row per completed instance, in completion order, to `swebench-cb.jsonl` or `--output <new-file>`; existing outputs are never overwritten. SIGINT/SIGTERM cancels queued instances, terminates registered workers and drains active cleanup/evaluation before reporting. Each instance writes artifacts to `.swebench/runs/<run>/<instance_id>/`: `requests.jsonl`, `recordings/`, `profile.jsonl`, `worker.log`, `outcome.json`, `patch.diff`, planning drafts/checks/rejections (`planning/attempt-<n>/`), verdicts and candidate patches. Predictions are labelled `junco-cb` for `wf`, or `junco-<stem>` for another selected pair.

### Telemetry

`benchmark.py` passes `GRAFANA_URL` and every `OPIK_*` variable to the worker; `--preflight` uses the same telemetry. With Grafana on `localhost:8000` and Opik on `localhost:5173`:

```sh
export GRAFANA_URL=http://localhost:8000 OPIK_URL_OVERRIDE=http://localhost:5173/api
.venv/bin/python benchmark.py run --instance-id astropy__astropy-12907
```

- Opik is always on: each graph run is exported to project `swebench` as one trace named after the instance (`OpikTracer`), including graph inputs and outputs. Its API defaults to `http://localhost:5173/api`; `OPIK_URL_OVERRIDE` and `OPIK_PROJECT_NAME` override endpoint/project while workspace/credentials retain SDK resolution. Export failures are logged.
- Grafana defaults to `http://localhost:8000`; `GRAFANA_URL` overrides it and an empty, invalid or credential-bearing URL fails (`validate` rejects it before any instance starts). The worker selects dashboard UID/title `junco-swebench` and writes its session dashboard link to `worker.log`; OTLP JSON metrics persist in Prometheus after completion. A failed dashboard setup fails before a model call; a failed metrics push surfaces at cleanup.

Open `/d/junco-swebench` on your Grafana base for **All** recorded sessions over the saved 15-day range (30-second refresh). New sessions do not reset All; the logged link or `?var-stream=<streamId>` selects one. Narrow the range and select a session before expanding the collapsed detail row. Token/cost totals sum each session's last observed cumulative sample in the range, not increments earned only within it. Session count includes real zero-usage preflight and health-check sessions with token samples. The memory overview is the largest individual-session peak, not simultaneous campaign memory; absent memory/probes/output observations read **Not recorded**, not zero. Retention follows original timestamps. See the root [telemetry documentation](../../README.md#telemetry-deployment) for the distinction between unavailable Grafana Live samples and source-supported JSONL reconstruction; the CooperBench converter does not reconstruct SWE-bench history.

For measured runs, set exactly one of `JUNCO_GRAPH_RUN_DIR` or `JUNCO_PROFILE_RUN_DIR` to a fresh optimizer run directory containing `request.json`. Workers record catalog-priced per-request usage, including failed/cancelled requests. After complete official outcomes, recording closure and container cleanup, `benchmark.py` concatenates profiles into `samples.jsonl` and atomically publishes the nonce-bound `completion.json` with `metrics.resolved` and `metrics.passed`. Missing accounting or cleanup leaves no completion receipt. Instrumentation is dormant outside those environments.

### Harness tests

The routing, session and workflow coordination tests use local model responses and no credentials or telemetry. The full suite also needs a reachable Docker daemon, the official image below, the production native addon and a delegated Linux cgroup v2. Set `JUNCO_BTRFS_TEST_ROOT` to an existing writable Btrfs allocation directory on a `user_subvol_rm_allowed` mount; the nested worker test creates and removes its own private seed there.

```sh
docker pull swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest
JUNCO_BTRFS_TEST_ROOT=/btrfs systemd-run --user --scope -p Delegate=yes -- bun test ./test_runtime.test.ts
bun test ./test_runtime.test.ts -t 'guarded agent|nested guard|session setup|coordination|solo baseline|checked at every depth'  # without Docker or a native seed
.venv/bin/python -m unittest test_benchmark       # benchmark.py boundaries (git, containers)
```

## Changing the workflow

Edit `wf.yml`, `wf.ts` and the harness files here, then snapshot again (step 1). `run-workflow.ts --check`, which `validate` and `run` call before any instance starts, rejects a pair that breaks this contract:

- A pair may import only `junco`, the Pi packages, `dataflow-engine`, Node built-ins and its own `./<stem>.yml`.
- It must export `document`, `code`, `run`, `strengthOf`, `ladder`, `ROLES`, `SANDBOX` and `BRANCHES`. `strengthOf` and the `SANDBOX` keys take root-relative node paths (`CandidateA`, `CandidateA/Worker` when nested).
- `run(config, observe?)` hands `config.args.agentOptions` to `fromYaml` immediately. Inside the graph-close `try`, it calls `observe?.(execution.graph)` before the first turn so branch cancellation targets the actual built agents.
- `document` must equal `syntax.parse(<stem>.yml)`. Nested graphs are allowed; at every depth there are no skills, no node ID contains `/`, and every code node has a `code` export named by its local ID.
- On **every** agent, `tool_block` must exclude all host-native tools and `task`. Bash must also be blocked unless `SANDBOX` maps that agent's qualified path to a legal worker sandbox; a mapped role must leave bash unblocked. Do not declare a YAML `tools:` list. Each sandbox has at most one bash agent, except `canonical`, which `Integrator` and `Verifier` (or one leaf under each) share in turn. The runner alone selects the container backend; no agent has acceptance-container access.
- Each `BRANCHES` root is an agent or nested-graph path whose bash agents all use its `candidate<Branch>` sandbox; cancelling it aborts every agent under that root and stops exactly `candidate<Branch>` and `accept<Branch>`.
- Every ladder rung must be one of the runner's `MODELS`. Before creating agents, the worker also requires each rung's thinking level to be one its model supports.
