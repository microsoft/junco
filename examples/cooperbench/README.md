# CooperBench divide-and-conquer pair

The workflow that runs one CooperBench feature pair: two private feature teams, each led by one strong agent.

- `wf.yml`: topology, the private assignment routes, the peer message edges and the leader prompt.
- `wf.ts`: the request boundary, the model ladder and scheduler, the container-bound `container_bash`, `divide` and `tournament` tools, the one-worker leaf graph, Docker snapshot/patch operations and the JSONL CLI.

```
$source ─assignment-1→ Agent1 ⇄ Agent2 ←assignment-2─ $source
          Agent1 ─divide1/tournament1→ Worker graphs (child containers)
          Agent2 ─divide2/tournament2→ Worker graphs (child containers)
          {Agent1, Agent2} → $sink (returns Agent1)
```

Each leader reads only its own assignment and works in its own network-less task container through `container_bash` (`docker exec -w /workspace/repo … timeout -s TERM -k 5 120 bash -lc`, 64 KiB output cap). The leaders' `tool_block` removes Junco's native shell, file, search and `task` tools; workers inherit the same list. The leaders coordinate only over `agent1-to-agent2` and `agent2-to-agent1`, and Agent1 is the lead responsible for integrating peer changes.

`divide` runs independent leaf jobs in parallel: every job must report completion, pass its check again on the host, and all patches must compose and pass every check together, otherwise nothing is applied. `tournament` races two attempts of one job and applies the first whose check passes. Each job is a `CooperBenchWorker` graph (`Worker` → `Collect`) in a disposable child container restored from a snapshot of the leader's tree (committed, uncommitted and untracked files). Only validated patches reach the leader.

Leaders run on the `high` rung (`models.leader` at `thinking.leader`); workers run on `med` (`models.worker` at `thinking.worker`). Each level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, and must be one its model supports: `off` omits the rung's `thinking`. The CooperBench launcher defaults are `github-copilot/gpt-6.1-sol` at `medium` and `github-copilot/gpt-6-luna` at `low`, set with `--leader-model`/`--leader-thinking` and `--worker-model`/`--worker-thinking`. There is no fallback model.

Those defaults come from a junco-profile-optimizer campaign that minimized recorded USD over five pairs, requiring at least 4/5 resolved on every run. With these models, both runs resolved 5/5 at about $0.99 per run. The previous defaults, Opus 5.5 `low` leaders with Sonnet 5 workers, resolved 2.5/5 on average at about $1.02. Adding a 256-tool-call cap per evaluation measured about $0.91 at 5/5 over three runs, but that cap is not adopted. The campaign stopped on its run budget without reaching its 50% cost-reduction target.

## Running

The live copy is driven by CooperBench's `scripts/run_junco.py`, which runs `.junco/cb.ts` + `.junco/cb.wf` from the CooperBench checkout. This directory holds the same pair under the example's file names. The copies differ only in their import paths: `wf.ts` imports `./wf.yml` (and parses it under that name) instead of `./cb.wf`, and `test/cooperbench.test.ts` imports `../examples/cooperbench/wf.ts` instead of `./cb.ts`. After changing either copy, copy it to the other and keep those imports.

From the CooperBench checkout:

```sh
bun install --cwd .junco    # once: links the live Junco checkout registered with `bun link`
uv run python scripts/run_junco.py --name junco-smoke --repo llama_index_task --task 17244 --features 5,6 --concurrency 1 --preflight
uv run python scripts/run_junco.py --name junco-core --subset core
```

The launcher owns task selection, image verification, container setup, the driver deadline, artifact harvest, scoped teardown and grading. It records the git fingerprints of both checkouts and the workflow's sha256 in `logs/<name>/config.json`.

Requirements: Linux, Bun, Docker with the CooperBench task images, a built Junco (`bun run build`) and a saved Pi login (`~/.pi/agent`) whose catalog lists both models at the required thinking levels.

## Driver protocol

The driver reads one JSON request on stdin. It writes JSONL only to stdout and diagnostics to stderr.

```json
{"mode":"run","run_id":"<32-hex>","image_id":"sha256:<64-hex>",
 "models":{"worker":"github-copilot/gpt-6-luna","leader":"github-copilot/gpt-6.1-sol"},
 "thinking":{"worker":"low","leader":"medium"},"timeout_ms":7200000,
 "problem_dir":"/abs/logs/<run>/team/<repo>/<task>/f5_f6",
 "agents":{"agent1":{"feature_id":5,"task":"...","container_id":"<64-hex>"},
           "agent2":{"feature_id":6,"task":"...","container_id":"<64-hex>"}}}
```

- Unknown fields, equal `feature_id`s or equal `container_id`s are rejected before any Docker or model call. Both containers must run `image_id`.
- Stdout carries every native `message` and committed `usage` row of every agent, tagged with `agent_id` (team) and `node_id`, then exactly one `result` record: `status` (`Submitted` | `LimitsExceeded` | `Error`), per-agent outcomes, `error`, `worker_count` and `agent_count`. Exit 0 only for `Submitted`; 130 after Ctrl-C.
- `Submitted` needs a completed run, no error (including batch cleanup) and a normal final text from both leaders.
- The durable recorder writes `<problem_dir>/.junco/profile_events.jsonl`, usage-mode `log.jsonl`, and a `telemetry.json` completeness/error receipt linked to the Grafana stream and dashboard. Grafana defaults to `http://localhost:8000`; `GRAFANA_URL` overrides it and must be credential-free http(s). Metrics persist in Prometheus after the writer exits. Batch scratch space is `<problem_dir>/.junco/work/`.
- Every pair and worker graph run is exported to Opik as one trace named after `problem_dir` (`OpikTracer`); traces include graph inputs and outputs. The API defaults to `http://localhost:5173/api` and project to `cooperbench`; `OPIK_URL_OVERRIDE` and `OPIK_PROJECT_NAME` override them. Workspace/credentials retain the SDK's `OPIK_*` and `~/.opik.config` resolution. Junco/SDK diagnostics go to stderr, preserving JSONL stdout; export failures are reported.
- Every child container carries the label `cooperbench.junco.scope=<run_id>`, which the launcher sweeps after the driver stops.
- `{"mode":"preflight","models":{...},"thinking":{...}}` refreshes the catalog, checks the saved login, both models and their thinking levels, then prints one `ready` record with the resolved Junco entrypoint.

## Tests

```sh
bun test test/cooperbench.test.ts                         # offline: native agents over faux models, no credentials, network or Docker
JUNCO_DOCKER_TESTS=1 bun test test/cooperbench.test.ts    # adds batches in real task containers (cached llama_index image; nothing is pulled)
```
