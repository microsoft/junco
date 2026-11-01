# SWE-bench Verified workflow

One shared workflow pair for every SWE-bench Verified problem:

- `wf.yml`: topology, edges and role prompts.
- `wf.ts`: code nodes, the model ladder and role strengths, the scheduler, the container roles (`ROLES`, `SANDBOX`, `BRANCHES`), the `Host` contract and `run`.

```
Input → Lead → Assign → {Trace, Reproduce, Contracts} → JoinEvidence → Planner (Draft ⇄ CheckPlan) → Dispatch
  → {CandidateA, CandidateB} → {ValidateA, ValidateB} → TournamentGate → Apply → Integrator
  → Freeze → Verifier → Finish → sink
```

Lead, Planner (its nested `Planner/Draft` agent) and Integrator run on `github-copilot/claude-opus-5.5` (high thinking); every other agent runs on `github-copilot/claude-sonnet-5`. A nested agent takes the model of its first path segment. Each instance gets nine containers from its official SWE-bench image: six agent sandboxes and three acceptance sandboxes that only code nodes reach. The seven agents that list `tools: [bash]` get a `bash` bound to their role's container at `/testbed`, with the `testbed` conda environment active and no network; it replaces Junco's native `bash`. The runner blocks the other native defaults and `task`, so Lead and Planner have no shell. `CheckPlan` runs each draft's checks one at a time on the clean canonical baseline (reset after each) and returns a rejected draft's observed results to Draft for at most three correction turns; only the accepted plan reaches Dispatch. Protocol violations, a plan still rejected after three corrections, two invalid candidates, a changed deliverable or a failed final check fail the run.

## Running

The workflow is driven by the separate junco-swebench harness, checked out next to this repository. `run-workflow.ts` is the per-instance runtime and `benchmark.py` is the corpus CLI. The harness never imports this checkout directly: it loads `.junco-snapshot/examples/swebench/wf.{yml,ts}` from a frozen copy of it.

Requirements: Linux x86-64, Bun, Docker (images `swebench/sweb.eval.x86_64.*` are pulled on demand), Python 3 and a saved Pi login (`~/.pi/agent`) for `github-copilot` whose catalog lists both models. `prepare` needs network access to Hugging Face and GitHub.

### 1. Set up the harness once

From the harness directory:

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # pinned SWE-bench harness
mkdir -p node_modules/@earendil-works
ln -sfn ../.junco-snapshot node_modules/junco
ln -sfn ../.junco-snapshot/node_modules/dataflow-engine node_modules/dataflow-engine
for p in pi-agent-core pi-ai pi-coding-agent; do
  ln -sfn ../../.junco-snapshot/node_modules/@earendil-works/$p node_modules/@earendil-works/$p
done
```

`node_modules` holds only symlinks into the snapshot. `bun install` cannot resolve the snapshot's workspace dependencies, so the links are made by hand.

### 2. Snapshot junco

Run this after every change to junco or to this workflow, from an installed junco checkout (`bun install` at its root):

```sh
rsync -a --delete --exclude=/.git --exclude=/.junco --exclude=/.claude/settings.local.json \
  --exclude=/crates/marsh/target --exclude=/crates/junco-policy/target --exclude=/crates/junco-policy/fuzz/target \
  --exclude=/packages/junco-tools/target --exclude=/packages/junco-tools/xtask/target \
  --exclude=/REVISION --exclude=/STATUS ../junco/ .junco-snapshot/
git -C ../junco rev-parse HEAD > .junco-snapshot/REVISION
git -C ../junco status --porcelain > .junco-snapshot/STATUS
```

Every run records `REVISION` and `STATUS` together with the sha256 of `wf.yml` and `wf.ts`. A run counts as dirty when `STATUS` lists any change except untracked files.

### 3. Prepare, check and run

```sh
.venv/bin/python benchmark.py prepare                         # pinned dataset → <instance_id>/problem.json + repo/
.venv/bin/python benchmark.py validate                        # every problem record, plus run-workflow.ts --check once
bun run run-workflow.ts --check astropy__astropy-12907        # offline check of the pair against one problem
bun run run-workflow.ts --preflight                           # live: one Sonnet tool call, one Opus handoff
.venv/bin/python benchmark.py run --instance-id astropy__astropy-12907
.venv/bin/python benchmark.py run                             # all 500 instances, one at a time
```

`run` validates first, then works through instances one at a time. It grades each canonical patch with the official harness and writes one row per instance to `swebench-cb.jsonl`, or to `--output <new-file>`. It refuses to start if the output file already exists. Each instance writes its artifacts to `.swebench/runs/<run>/<instance_id>/`: `requests.jsonl`, `recordings/`, `profile.jsonl`, `worker.log`, `outcome.json`, `patch.diff`, the workflow's checks, verdicts and candidate patches. Predictions are labelled `junco-cb`.

### Harness tests

```sh
bun test ./test_runtime.test.ts                   # model routing, container bash, wf.yml protocol, sandbox ops (Docker)
.venv/bin/python -m unittest test_benchmark       # benchmark.py boundaries (git, containers)
```

## Changing the workflow

Edit `wf.yml` and `wf.ts` here, then snapshot again (step 2). `run-workflow.ts --check`, which `validate` and `run` call before any instance starts, rejects a pair that breaks this contract:

- `wf.ts` may import only `junco`, the Pi packages, `dataflow-engine`, Node built-ins and `./wf.yml`.
- It must export `document`, `code`, `run`, `scheduler`, `strengthOf`, `ladder`, `ROLES`, `SANDBOX` and `BRANCHES`. `strengthOf` and the `SANDBOX` keys take root-relative node paths (`CandidateA`, `CandidateA/Worker` when nested).
- `document` must equal `syntax.parse(wf.yml)`. Nested graphs are allowed; at every depth there are no MCP or skills, no node ID contains `/`, and every code node has a `code` export named by its local ID.
- The only agent tool allowed is `bash`, and only on agent paths that `SANDBOX` binds to a known role other than an acceptance sandbox. Each sandbox has at most one bash agent, except `canonical`, which `Integrator` and `Verifier` (or one leaf under each) share in turn.
- Each `BRANCHES` root is an agent or nested-graph path whose bash agents all use its `candidate<Branch>` sandbox; cancelling it aborts every agent under that root and stops exactly `candidate<Branch>` and `accept<Branch>`.
- Every ladder rung must be one of the runner's `MODELS`. Before creating agents, the worker also requires each rung's thinking level to be one its model supports.
