# junco

Recursive agentic dataflow graphs. A `JuncoGraph` is a native [`dataflow-engine`](packages/dataflow-engine) graph whose node states are `Agentic`: agents, nested graphs, `Deterministic` coroutines, and deterministic `Source`/`Sink` ports. Every graph has fresh positional source and sink nodes; nested execution returns only its sink's retained result. Graphs own work and resource lifetime, never scheduling policy. An external `schedules.context({ graph, scheduler })` pairs a graph with a typed function from [`junco-scheduler`](packages/junco-scheduler); `parallel()`, `roundRobin()` or the stateless `pi(...)` oracle decide which existing work nodes advance.

## Setup

Requirements: Linux x86-64 with glibc and Bun `1.4.2`. Package development additionally needs Node.js `>=22.19.0` (Node `dist` builds and smokes); `junco-tools`' native addon needs Rust `1.98.1` plus native build libraries. This repository is a Bun workspace: the agency sits at the root and `packages/` holds `junco-tools`, `junco-agent`, `dataflow-engine` (with its `examples` workspace), `dataflow-engine-opik`, and `junco-scheduler`, each imported with its full Git history. `crates/marsh` and `crates/junco-policy` hold the marsh and junco-policy repositories, also with full history, as independent Cargo workspaces; junco-tools' native addon builds them as local path dependencies. The source example bundles below need no Rust. The tracer adapters are optional at runtime (see [Tracing](#tracing-local-only)).

To run the root `examples/`, install once from the root and let Bun bundle them from workspace sources; no package or declaration build comes first. When junco-tools' Rust toolchain is installed (see its [README](packages/junco-tools/README.md)), the root install's `postinstall` also builds the production native addon (`bun run build:native` in `packages/junco-tools`, a locked build against the local `crates/`; a failed build fails the install); without it, the install prints a notice and skips the addon, as does `--ignore-scripts`:

```sh
bun install --frozen-lockfile
bun run build:examples
bun --no-install examples/dist/recursive-agency/recursive-agency.js
```

`build:examples` bundles the paired `examples/<name>/<name>.ts` and `.yml` workflows for recursive-agency, mixed, oss-committee, mcp, verus, and yak-shaver (with shared chunks and external source maps) into `examples/dist/<name>/<name>.js` for Bun. YAML text imports are inlined, so the bundles need no source YAML files. Reachable workspace packages resolve through their `bun` exports to TypeScript source, so producer declaration builds are not prerequisites. Four boundaries stay external and must be installed where the bundle runs: the generated lazy `junco-tools/native` loader and the three `@earendil-works` Pi packages (which locate their own assets). Recursive and committee supply explicit agents/tools and need no native addon; recursive is offline, while committee retains its credentials and inputs. Mixed's default builder and the MCP, Verus and yak-shaver workflows retain their native collection/ShellMux prerequisites. The shared CLI runner (`runCli`), Ctrl-C cancellation and live model preflight (`verifiedModels`) live in `examples/support.ts`, which has no YAML graph.

`dataflow-engine`'s own examples follow the same contract: after the root install, `bun run examples` (or `examples:build`) in `packages/dataflow-engine` bundles them from workspace sources without any producer build; see its [README](packages/dataflow-engine/README.md#examples-and-development).

`JuncoGraph.fromYaml(source, config)` builds runnable scheduler contexts from YAML text or parsed objects. Agent nodes may list additive registry names in `tools` and exact default exclusions in `tool_block`; the lists must be disjoint. Resolution filters blocked automatic helpers before construction and rejects aliases whose resolved `AgentTool.name` is blocked. Every real YAML-built agent then composes the enabled native and coordination defaults through `JuncoAgent`.

```yaml
Worker:
  tools: [project_search]
  tool_block: [bash, edit, task]
```

An overlap is reported at the conflicting `tool_block` scalar with a source-located repair to remove it from either field. A registry alias such as `shell` resolving to `name: bash` is rejected during resolution before any agent factory runs.

Every `JuncoAgent` model request appends `agent.SYSTEM_INSTRUCTION`: collaboration guidance for `send`, `recv`, and `yield`, followed by the file-release rule. It applies to subagents and agents without messaging tools too, exactly once at the provider boundary, without changing persisted prompts.

During graph activations, each request also ends with `Inbox { <edgeId>: <count>, … } read with recv tool` when the retained inbox is nonempty and would fire the node's own trigger. Message batches use their counts; retained parent values count as `1`. This suffix is recomputed at the provider boundary, disappears after `recv` drains the inbox, and is never persisted or added to unbound direct requests.

Prepared `agents` in `JuncoGraph.fromYaml` transfer ownership at entry: failed parsing or construction closes every supplied agent, including unregistered agents; successful construction leaves them owned by the graph. The node-path mapping must cover each agent exactly once and is exclusive with `createAgent`. Prepared agents keep their existing model/tool/skill/system configuration; YAML prompts and profiles still apply, without creating a default collection.

For package development (Node `dist` builds, declarations, and the native addon), the root build runs in producer order: engine → tools → MCP → agent → scheduler → Opik adapter → profile → Junco. The root and standalone tools packages pin Rust `1.98.1`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run typecheck
bun run check
bun run test:unit
bun run smoke
```

| Root command | Behavior |
| --- | --- |
| `bun run build:lib` | Build only the root standard library, after its producers. |
| `bun run build:marsh` | Locked release build of standalone `rmux`, without installation. |
| `bun run build:junco-policy` | Locked release build of the policy library. |
| `bun test:junco-policy` | Policy tests and the deterministic release-mode fuzz oracle. |
| `bun fuzz:junco-policy [libFuzzer flags...]` | Fixed `lock_policy` target, with a 60-second default; requires nightly and `cargo-fuzz` (`0.13.2` in CI). |
| `bun run install:marsh` | Install only `rmux` into `$HOME/.local/bin`; print PATH instructions if needed, without changing startup files. |
| `bun run install` | Build and globally link Junco's library/CLI tools and install bundled skills for selected harnesses; no `rmux`. |
| `bun test:marsh [--btrfs=<path>]` | Whole Marsh workspace and executable smoke, requiring real Btrfs and resource enforcement. |
| `bun run test [--btrfs=<path>]` | Complete policy, Marsh, native/addon, JavaScript package and integration suites. |

`bun run test:marsh`, `bun run test:junco-policy` and `bun run fuzz:junco-policy` are equivalent explicit spellings. Native `bun install` installs workspace dependencies; native `bun test` remains Bun's runner. Use explicit `bun run install` and `bun run test` for Junco's installation and complete-suite entrypoints.

`bun run install` requires interactive stdin and stdout. It bootstraps the frozen dependencies with lifecycle scripts disabled, then shows an unchecked harness checklist: arrows navigate, Space selects, Enter confirms, `a` selects all and `i` inverts. At least one choice is required. Ctrl-C exits 130 before global links or skills change; non-terminal invocation exits 2 before dependency installation or builds.

| Harness | Default personal skill root | Override |
| --- | --- | --- |
| GitHub Copilot CLI | `$HOME/.copilot/skills` | `$COPILOT_HOME/skills` |
| Claude Code | `$HOME/.claude/skills` | `$CLAUDE_CONFIG_DIR/skills` |
| Pi | `$HOME/.pi/agent/skills` | `$PI_CODING_AGENT_DIR/skills` |
| OpenAI Codex | `$HOME/.agents/skills` | `$CODEX_HOME/skills` |
| OpenCode | `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills` | `$OPENCODE_CONFIG_DIR/skills` |

Empty overrides mean unset; nonempty overrides must be absolute. Identical destinations are deduplicated and unselected harnesses stay untouched. Codex's default `.agents/skills` is shared and may also be discovered by compatible harnesses. The installer does not install harness executables, register MCP servers or edit client settings.

The bundled skills, `junco-graph-create`, `junco-graph-optimizer` and `junco-profile-optimizer`, are copied whole, including `references/` and `evals/`. Existing skill directories are replaceable only when a regular `.junco-installed` file contains exactly `junco\n`; foreign directories, files and symlinks are conflicts. Each skill is staged beside its destination and renamed into place, removing stale managed files. Failed replacement restores the previous tree or reports its retained backup; earlier successful destinations are reported on failure.

Global binaries use `bun pm bin -g`, including Bun's configured `BUN_INSTALL_BIN`: `junco-profile-optimizer` links to `dist/optimizer-cli.js`, and `profile-fit` to `packages/dataflow-profile/src/cli.ts`. Conflicting executables are refused before linking. PATH instructions are printed when needed; shell startup files are never changed. In a separate consuming project, run `bun link --save --ignore-scripts junco`. Global registration alone does not resolve arbitrary-project imports: the checkout, its `node_modules` and its built outputs must remain in place.

Both aggregate test commands default to the privileged Docker Btrfs environment. Add `--btrfs=/existing/base` to use the local toolchain and checkout caches instead: the existing directory must be writable and searchable on Btrfs with `user_subvol_rm_allowed`; ordinary directories within a subvolume are valid. A private `.junco-tests-*` child contains separate HOME and fixture directories. Success removes only that identity-checked allocation; failure or interruption retains it and prints its path. The supplied parent is never created, mounted, formatted or deleted. Local execution requires `systemd-run --user --scope -p Delegate=yes --` for an isolated delegated cgroup; unavailable delegation fails rather than falling back to partial tests or changing host configuration.

The Docker full-suite runner uses the local daemon at `/var/run/docker.sock`, pulls the SWE-bench fixture image when it is not cached, and mounts the socket into the already-privileged CI container. Its unprivileged `ci` user receives the socket's group so container-backed tests can launch and reap their own fixtures. Run only trusted tests: access to this socket grants control of the host Docker daemon. The Marsh-only runner does not mount it.

- One root `bun.lock` with the hoisted linker. Internal dependencies use `workspace:*`, so every package links to its `packages/` directory, a rebuild is visible to its consumers without reinstalling, and the engine and Pi peers each have one installed identity. The root `overrides` are the only version policy. The agent uses Pi `0.99.2`'s native `AgentHarness` adapter; no Pi patch or fork is installed.
- The Earendil family stays at `0.99.2`: newer stable releases through `1.4.0` remove the injectable durable-session and admission/recovery APIs required by Junco's native harness adapter. Keep Bun's declaration package aligned with the pinned `1.4.2` runtime; newer declarations expose unsupported runtime APIs. Revisit these compatibility ceilings only when upstream supplies equivalent capabilities or a runtime-floor change is explicitly authorized.
- Bun `1.4.2`'s `bun update` may fail to resolve nested linked development/workspace paths; this does not invalidate a successful frozen-lockfile install. Use the checked-in lockfile for reproducible installs rather than editing consumers' dependencies to work around that update limitation.
- The individually runnable `test:native` suites (root, `junco-mcp` and `junco-agent`) and junco-tools' Node suite need the CopyTree native test addon (`bun run build:native:test` in `packages/junco-tools`, loaded from `packages/junco-tools/target/native-test/index.js`). The aggregate builds it separately from the production addon. The tools Btrfs lane and final bare Bun discovery use owned fixtures; `JUNCO_BTRFS_TEST_ROOT` can select an existing allocation parent for low-level entrypoints. Resource-limit and memory-profiling tests also require delegated cgroup v2 `cpu`, `memory` and `pids` controllers.
- The aggregate also prepares Graft's native Tree-sitter bindings, whose dependency install scripts were skipped by `--ignore-scripts`. It reuses installed Node headers when available; `ci/Dockerfile` exposes npm's bundled `node-gyp`.
- CI retains `ci/Dockerfile`'s full-suite default: a fresh loop-backed Btrfs (`user_subvol_rm_allowed`), an unprivileged `ci` user with separate Btrfs HOME/fixtures, and delegated `cpu`, `memory` and `pids` controllers. Only tracked and unignored source files are copied in; image Cargo/Rustup homes remain in use. The outer commands forward `CARGO_BUILD_JOBS` and `BTRFS_SIZE` only when supplied. Full-suite discovery ends with bare `bun test` and fails on skips. Direct Docker users can mount a directory at `/artifacts` for coverage reports.
- `bun run check` runs Biome `2.6.4` (pinned at the root; `bun run check:ci` is the non-writing CI form) over one policy from `biome.json`: root `src/`, `test/`, `install.ts` and `ci/run-tests.ts`; the whole `packages/dataflow-engine` (whose nested `biome.json` extends the root); `src/` and `test/` of `junco-agent`, `junco-mcp` and `junco-scheduler`; junco-tools' `ts/` and `tests/`; and package manifests/typecheck configurations. Git-ignored and generated trees (`node_modules`, `dist`, `target`, `native`, `coverage`) and the `graft` graph are excluded; Rust stays with rustfmt and Clippy.

Return-only and throw-only `AsyncGenerator` protocol fixtures are exempt from Biome's `useYield` rule in explicitly listed test files: first-activation completion or failure is intentional, and inserting a yield would change the schedule.

## Tracing (local only)

A `JuncoGraph` takes fresh source and sink nodes, window and thread bounds, a tracer (or `undefined`), and its authorization policy, in that order. Its tracer defaults to `tracer.TuiTracer.shared()`: one shared lazy TUI named `JuncoGraph.run` when stdin and stdout are TTYs and `TERM !== "dumb"`, otherwise a silent, stateless `DummyTracer`. Explicit Dummy, custom and Opik tracers always win. Construction and `spawn` remain synchronous; imports, factory construction and shared selection do not load native bindings, enter terminal modes, install handlers or write output. The first observer callback starts the lazy display.

For explicit acquisition, use `const tui = await tracer.TuiTracer.create("My workflow")` (the name is optional), then pass it to your graphs. It rejects unsuitable terminals before loading native bindings; native initialization failures surface rather than falling back to another backend. Only one session may own the terminal. The ratatui display is one full-terminal bordered `Agent traces` pane. Its title carries the session name, completion state, active scoped-node badges, omitted-record count, and following/paused state. Stable identity colors and scoped `[g<serial>:<NodeId>]` badges distinguish repeated local IDs in trace history. Agent messages, tool progress and lifecycle outcomes appear independently of `LOG_LEVEL`. A task-calling caller stays one node: its `task` calls and report follow-ups appear in its own traces, and return records show outcomes and stop reasons, not another copy of streamed messages. Payloads are snapshotted without application getters or custom inspection and may contain sensitive data; retained display history is bounded, not a durable transcript.

Share one tracer across child graphs: Ralph graphs inherit their parent's observer; separately constructed children must receive the same explicit tracer from their caller. Close all graphs before calling `await observer.flush()` once for the shared observer. TUI `flush()` draws the final state and waits for `q`/Esc before restoring the terminal; `q`/Esc can also dismiss early without cancelling computation. `await tui.close()` or async disposal restores without waiting for dismissal. Flushing or closing an unused lazy instance performs no terminal I/O. While the screen is owned, do not write directly to stdout/stderr; capture MCP stderr (`stderr: "pipe"`) and print final results only after restoration. Arrows (Left/Right included), PageUp/PageDown, and Home/End navigate trace history immediately; End resumes tail-follow. Tab has no display action.

Profiling uses a separate `recorder` dependency, never a tracer: one application-owned `tools.ProfileRecorder<R>` session whose resource union `R` is a set of singleton strings. Graphs, agents and collections take `recorder?: tools.ProfileRecorder<"memory" | "tokens" | "cost" | "edits" | "operations" | "probe">` (graphs and agents also `recorderNodeId`); narrowing to a producer's singleton, such as `ProfileRecorder<"memory">` for `ShellMuxLease.create(cwd, { recorder })`, is plain assignment, and `add_context(nodeId)` derives the `::`-joined node context of the same session (`.root`). Every graph, agent and collection in one hierarchy must share that root, else construction rejects with `ProfileRecorder instance mismatch`. Two sinks implement it:

- `new tracer.JsonlRecorder({ path, monitored?, costMode? })` appends one `dataflow-profile` Sample JSON line per successful graph activation, automatically at each graph evaluation end and on `flush()`, keyed by its node IDs joined with `/` (`Inner/Worker`). Runtime is milliseconds; a real `JuncoAgent`'s tokens and default `costMode: "activation"` USD are its committed usage since the activation started (zero when none); mocks/non-agents have neither. With `costMode: "usage"`, each cost usage increment instead contributes one cost-only USD sample, including standalone agents, failed/aborted activations and separately metered scheduler calls; activation samples omit cost to avoid double counting. Missing, negative or nonfinite usage cost rejects `flush()`/`close()`. With `monitored: true`, memory is the maximum attributed pipeline memory/peak bytes (zero without pipelines), not a sum of concurrent pipelines. Late events update the owner's last ended activation only until serialization; later events are dropped. `measurement.edits` and `measurement.operations` list the activation's `edits`/`operations` events (its own graph events, then its agent's runs, turns and tool calls, a child graph's `evaluate`), one row per `{ category, tool, operation }` with `calls`, `success`/`error`/`cancelled` finishes, summed `durationMs`, summed `counters` and latest `gauges`; an event without an `activation` counts only while exactly one activation is live at its node, so concurrent same-path activations and events outside any activation are not counted. Failed activations are not sampled; a negative or non-finite final resource rejects `flush()` with `JsonlRecorder: invalid <resource> sample` instead of writing the row.
- `await tracer.GrafanaRecorder.create({ url?, intervalMs?, dashboard? })` (defaults `http://localhost:8000`, 1000 ms, `junco-telemetry`) creates or updates the selected tagged dashboard (an untagged dashboard at that UID is a conflict). Dashboard UIDs must match `^[A-Za-z0-9_-]{1,40}$`; invalid values fail before network I/O. It pushes OTLP JSON gauges through Grafana's public `/api/telemetry/metrics` route to persistent Prometheus storage. The generic `junco-telemetry` dashboard still defaults to the newest session; select another with `recorder.streamId` or open the session-specific `recorder.dashboardUrl`, including after the writer exits. Its detail panels show shell-pipeline cgroup memory and sampled peaks, tokens, token rates, probes, and operation/resource/context tables. Requests carry no credentials; Grafana grants anonymous Admin access with basic authentication and the login form disabled. Transport failures stop pushing without retries and reject `flush()`/`close()`. Deleting an exported custom gauge emits one stale point; cumulative counters and built-ins remain authoritative.
  Snapshots are sharded at metric-point boundaries into requests no larger than 500 KiB, preserving names, labels, timestamps and values. A single point too large for one request still fails; an error after earlier shards were delivered remains an error, not a successful flush.
- Both sinks take `probe` events (`{ resource: "probe", kind: "probe", edgeId, value }`, emitted by YAML `probe: true` edges). JSONL appends one resource-free Sample per event — `node` is the `/`-joined context, `measurement.probe` is `[{ edgeId, value }]`, `firedAt` is the receipt time, no `runId` — regardless of activation outcome; fitting ignores it. Grafana sends each event exactly once, in record order before the snapshot, as a `junco_probe_value` gauge labelled by stream, node and edge. Each series uses increasing millisecond timestamps: same-millisecond collisions advance by 1ms per point. The **Edge probes** panel queries original samples rather than resampling bursts. A nonfinite value latches `invalid probe value` for `flush`/`close` and is never written.

The benchmark examples select separate dashboards whose UIDs and titles are `junco-cooperbench`, `junco-swebench`, and `junco-msbench`: open `/d/junco-cooperbench`, `/d/junco-swebench`, or `/d/junco-msbench` on your Grafana base URL. Each defaults to **All** recorded sessions over **15 days**, with a 30-second refresh. New sessions do not reset All. `recorder.dashboardUrl` or `?var-stream=<streamId>` selects one session. Choose one session and narrow the time range before expanding the collapsed detail row.

Benchmark token and cost totals sum each session's last observed cumulative sample within the selected range: these are recorded lifetime totals as of those samples, not usage earned only within the range. Session count includes every session with a recorded total-token sample, including real zero-usage preflight and health-check sessions. The memory overview is the largest individual-session peak, not simultaneous campaign memory. Missing memory, probes, or output-token observations display **Not recorded**, not zero.

Session memory peaks prefer a recorded root `junco_operation_peak_memory_bytes{resource="memory",category="benchmark",operation="container_memory",node="::"}` gauge for each dashboard/session. CooperBench records the kernel cgroup v2 `memory.peak`: the whole container, including Bun, native task/tool descendants and cache, not an agent-attributable measurement. Only sessions without that gauge fall back to `junco_total_peak_memory_bytes`, the maximum sampled active-pipeline sum or single-pipeline high-water mark. Container and pipeline peaks are never added together. Current/per-node memory remains pipeline-only and unavailable when unmeasured; recording a container peak does not invent CPU, process-count or per-node memory samples.

Close graphs, agents and caller-owned collections first (native close drains the final resource events), then `await recorder.close()` once; closing a source never closes the recorder.

```ts
import { JuncoGraph, tracer } from "junco";

const recorder = await tracer.GrafanaRecorder.create();
console.log(recorder.dashboardUrl);
try {
  const execution = await JuncoGraph.fromYaml(document, { ...options, recorder });
  try {
    await execution.run();
  } finally {
    await execution.graph.close();
  }
} finally {
  await recorder.close();
}
```

Operational logs still use `junco-tools/log`'s one process-wide [tslog](https://github.com/fullstack-build/tslog) logger. `LOG_LEVEL` (`SILLY`, `TRACE`, `DEBUG`, `INFO` — the default — `WARN`, `ERROR`, `FATAL`) is read once at startup; missing/blank means INFO, names are trimmed and case-insensitive, and unknown or numeric values fail before native or model work. `issueLog`'s complaint-backend failures use WARN. The logger receives every junco-policy capability decision of the ShellMux `ShellMuxLease.create` opens: violations at INFO (`junco-policy authorize: policy violated`, with principal, action, resource segments, failed precondition and allowed fixes) and, under `LOG_LEVEL=DEBUG`, tentative grants. While the TUI owns the terminal, admitted operational logs are redirected exclusively into its trace pane. Each mux's `lease.release()` (and so a collection's final release) drains these records; its `flushLog()` barrier waits for drawing, not keyboard dismissal. Outside the TUI that barrier flushes stdout.

Complaints go to the process-wide `issueLog.backend`, independently of graph tracing. Its default `JsonlComplainBackend` synchronously appends `{ at, nodeId, complaint }` to `process.cwd()/complaints.jsonl`, with the path resolved at module load. Messages and full model requests remain only in the in-memory issue log. Write failures warn and retain the issue; the agent still receives "Complaint recorded.". The TUI no longer displays a complaint line.

`dataflow-engine-opik` is a workspace package and a root development dependency providing `OpikTracer`, so the root install already provides it and `opik`; under Bun its `bun` export loads its source directly. Pass it explicitly like any other tracer, configured by the SDK's `OPIK_*` variables:

```ts
import { OpikTracer } from "dataflow-engine-opik";
import { Opik } from "opik";

const tracer = new OpikTracer(new Opik(), "JuncoGraph.run");
```


### Telemetry deployment

The root `docker-compose.yml` owns `junco-telemetry`: anonymous Grafana at `http://localhost:8000/`, Prometheus at `http://localhost:8001/`, and Opik UI/API at `http://localhost:5173/` (`/api` for SDKs). Ports bind to loopback by default. Nginx transparently routes recorder writes to Prometheus and other requests/WebSockets to Grafana; recorder callers need no Prometheus URL or authentication setting. Prometheus retains samples for **15 days** on `junco-telemetry_prometheus_data`; `grafana_data` and the seven `opik-opik_*` volumes remain external. Old Grafana Live samples themselves are unavailable, but durable raw `profile_events.jsonl` can reconstruct source-supported state. Rebuild old recorder consumers rather than dual-writing. Retention uses original sample timestamps, not the import date; November 1–2 samples age out roughly November 16–17 at block-retention boundaries.

For a recorded CooperBench campaign, run the offline converter from the Junco checkout with a fresh output directory:

```sh
bun run scripts/backfill-cooperbench.ts \
  --campaign /absolute/path/to/CooperBench/logs/<campaign> \
  --out /absolute/path/to/fresh-staging
```

This prepares OpenMetrics and a receipt only: no network requests, campaign changes, or production TSDB writes. A matching completed receipt can be verified/reused; unrelated or nonempty output is refused. Importing staged blocks is a separate, controlled Prometheus maintenance operation, not part of this command. Raw `profile_events.jsonl` is the event source; aggregate `log.jsonl` and `result.json` are reconciliation inputs, never additional usage. Reconstruction emits state after all events in each occupied UTC second, at that second's last recorded event timestamp. Rates use elapsed time between these snapshots, not lost live timer ticks. Partial histories retain their valid prefix and `completion="partial"`; there are no invented terminal events or zero tails. Unrecorded resources, memory, probes, and output-token observations remain missing. Complete raw telemetry means a durable ledger, not a solved task.

Host settings belong in the checkout's private `.env`: `JUNCO_BIND_ADDRESS`, `JUNCO_GRAFANA_ROOT_URL`, `JUNCO_GRAFANA_IMAGE`, `JUNCO_OPIK_VERSION`, and `JUNCO_OPIK_{BACKEND,FRONTEND,PYTHON_BACKEND}_IMAGE`. Defaults retain Grafana 13.3.0 and Opik 2.2.99. Pin existing application digests when adopting another host's stores. Publishing on `0.0.0.0` exposes anonymous Admin access; use it only on a trusted network.

Keep this checkout and the sibling `../opik` checkout available at their installed paths. Installation requires the existing stores, upstream Opik deployment assets, Docker/Compose and a root systemd session; it installs no packages or daemon and does not repair sudo/su. Run:

```sh
bash /absolute/path/to/junco/install-telemetry.sh # as root
# This Docker Desktop/WSL host's root route:
wsl.exe -d archlinux -u root -- bash /home/eioannidis/git/junco/install-telemetry.sh
```

The installer checks Docker access as root and the checkout owner, service/store ownership, disk space and datasource conflicts before downtime. It pulls missing images, saves exact-image renders and cold-archives the eight legacy stores in root-only `/var/backups/junco-telemetry/` directories, then replaces `grafana-compose.service` or `grafana.service` plus `opik.service` with enabled `junco-telemetry.service`. A verified legacy Grafana bind is copied into a new `grafana_data` volume with contents and ownership checked; its source remains untouched. Bind adoption requires `JUNCO_OPIK_BASELINE_RECEIPT` pointing to the private pre-cutover project/trace/eight-span receipt. Reinstalls use the recorded baseline and volume, without recopying or reseeding; an unrecognized partial destination is retained and rejected. Failed cutovers restore saved configuration, enablement and previous workloads without pulling images or overwriting newer volume data. Only an exact localhost:8888 `/api` URL in the checkout owner's `.opik.config` is migrated to 5173; custom/cloud URLs and workspace settings remain untouched.

`systemctl restart junco-telemetry.service` restarts the stack without builds or pulls; explicit stop stops containers without deleting volumes. The unit orders after Docker and wants `docker.service` when installed. On Docker Desktop/WSL it retries unavailable Docker every 15 seconds, but cannot start Windows Docker Desktop or boot a stopped WSL distribution. A full host reboot is not part of installation.
## CI

`.github/workflows/ci.yml` runs on every push, pull request, and manual dispatch, with two independent jobs that each run one root `bun install --frozen-lockfile`:

- `core` needs no secrets. It installs with `--ignore-scripts` (no native addon), runs root Biome, bundles all root and engine examples from workspace sources before package builds, and executes deterministic engine examples with exact outputs and no accidental producer artifacts. Copied root bundles run in an isolated Pi-vendor-only consumer without Opik; MCP protocol tests use in-memory transports. It then builds the native engine, peer-free scheduler core and Opik adapter; runs core type fixtures, scheduler context/CSL property tests and the renamed faux-only `test/agent.test.ts`; typechecks and tests all engine consumers. Packed core packages are exercised without optional peers under Bun and Node (round-robin `1,10,2,1`), and offline Opik traces/results are checked through an in-memory client.
- `test` also needs no secrets: Cargo fetches public native dependencies and root installation builds the production addon. It runs tools' Rust/Node/native tests, builds dependency producers in order, checks the full scheduler and all its suites, then builds/typechecks the agency and runs deterministic, integration, native and Bun/Node workflow smokes. Coverage artifacts retain each package's own source scope. Workspace engine error identity is exercised through a rejected policy before work and a subsequent successful context drive under Bun and Node; the relocated agent CLI launcher is checked separately.

No Btrfs mount, tracing service, language server, or model credentials are required: native suites run on CopyTree workspaces.

## Usage

```ts
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent } from "junco-agent";
import { LockPolicy, YieldTool } from "junco-tools";
import { graph as graphApi, schedules } from "junco";

// Resolve member options and schedulerOptions.models/model beforehand.
// Only member agents own sessions; scheduling makes one completeSimple call per decision.
const sessions = new MemorySessionRepo();
const researcher = await JuncoAgent.fromResolved({
  ...researcherOptions, session: await sessions.create({}, BACKGROUND_CONTEXT),
  tools: [new YieldTool()], prompt: "Find the facts.",
});
const writer = await JuncoAgent.fromResolved({
  ...writerOptions, session: await sessions.create({}, BACKGROUND_CONTEXT), prompt: "Draft the summary.",
});
const writerId = graphApi.NodeId.create("writer");
const final = graphApi.Edge.value<graphApi.nodes.AgenticInput, AssistantMessage>("writer->$sink");
const source = new graphApi.nodes.Source<graphApi.nodes.AgenticInput, AssistantMessage>(() => {
  throw new graphApi.DataflowDefinitionError("Report workflow does not accept external input");
}, { id: graphApi.NodeId.create("$source") });
const sink = new graphApi.nodes.Sink<graphApi.nodes.AgenticInput, AssistantMessage>(async function* (): graphApi.NodeGenerator<graphApi.nodes.AgenticInput, AssistantMessage> {
  yield [];
  const result = execution.graph.result(writerId);
  if (!O.isSome(result)) throw new Error("Writer did not produce a result");
  return result.value;
}, { id: graphApi.NodeId.create("$sink"), trigger: graphApi.trigger.TriggerRule.when(final) });
const execution = schedules.context({
  graph: new graphApi.JuncoGraph(source, sink, graphApi.Width.create(1), graphApi.UNBOUNDED, undefined, LockPolicy),
  scheduler: schedules.pi({
    models: schedulerOptions.models, model: schedulerOptions.model,
    systemPrompt: "Coordinate the team.", prompt: "Produce the report.",
  }),
});
execution.graph.addNode({ id: graphApi.NodeId.create("researcher"), state: researcher,
  description: "researches", policy: LockPolicy, trigger: graphApi.trigger.TriggerRule.always() });
execution.graph.addNode({ id: writerId, state: writer,
  description: "writes", policy: LockPolicy, trigger: graphApi.trigger.TriggerRule.always() });
execution.graph.addEdge(writerId, sink.id, final);

let outcome: AssistantMessage | undefined;
try {
  await execution.run();
  const result = execution.graph.result(sink.id);
  if (!O.isSome(result)) throw new Error("Report workflow did not produce its sink result");
  outcome = result.value;
} finally {
  try {
    try { await execution.graph.close(); } finally { await execution.graph.tracer.flush(); }
  } finally { await sessions.close(BACKGROUND_CONTEXT); }
}
console.log(outcome); // the terminal has been restored
```

[`examples/recursive-agency/recursive-agency.ts`](examples/recursive-agency/recursive-agency.ts) runs a root → child → grandchild agency around a leaf that pauses once, plus a root sibling, entirely offline on faux models. Each context records only its own decisions; leaf, sibling and sink results are inspected on the retained native graphs.

Five graph examples declare deterministic work as YAML `kind: code` nodes backed by `syntax.DeterministicNode` definitions in the same-named TypeScript workflow: MCP report validation, recursive result joining, committee assignment preparation, Verus diagnostic gates, and Yak's progressive finalization/application; mixed publishes its assignment from a YAML `kind: emit` node. Pass definitions directly as `JuncoGraph.fromYaml(source, { code: { Reports }, context, ... })`; every referenced node ID must have a definition, including nested graphs. Typed `context` supplies run-local dependencies. `bun run build:examples` bundles only the six same-named entrypoints; there are no dynamically imported code modules or registry paths.

All six graph example CLIs handle Ctrl-C with a scoped `AbortSignal`: cancellation interrupts active agents, nested graphs and cooperative coroutines, joins cleanup, and exits with status 130. Imports install no signal handlers. Setup awaits without cancellation support finish before the next signal check; bodies that ignore cancellation must still drain.

Standalone examples using `examples/support.ts` append `tracer.JsonlRecorder` activation samples (runtime, tokens, cost, operations) to `<problem>/.junco/log.jsonl`; callers close the recorder after their last graph. A recorded graph rejects an agent without a view of that recorder, so externally prepared committee, Verus, and Yak agents receive `recorder` and `recorderNodeId`. CooperBench uses its own usage-mode recorder plus raw profile and sink-completeness files under the pair's `problem_dir`, as described in its example README.

### OSS committee (live)

[`examples/oss-committee/oss-committee.ts`](examples/oss-committee/oss-committee.ts) runs three persistent `JuncoAgent` members through review rounds declared in its paired YAML. Each round builds fresh Source/Sink ports and a `schedules.parallel()` context over the same members; their sessions retain every earlier round. Librarian (`claude-opus-5.5`, medium) searches GitHub with generic technical terms, reporting stars, last push, URL and license. Architect (`gpt-6-sol`, high) designs from research with only builtin tools. Reducer (`claude-sonnet-5.5`, xhigh) combines both final reports, records a typed `review` verdict and produces the only titled Markdown plan. Revision starts another round; approval publishes the plan. There is no round limit; a round without a verdict fails. A failed lookup requires Librarian to hand partial research to Architect on a message edge and yield until Architect finishes. Reducer still waits for both normally stopped, nonempty final reports. Unsupported reasoning levels fail rather than silently downgrade.

Before running the live example, start `pi`, use `/login`, and select GitHub Copilot. The committee shares Pi's `ModelRuntime` and uses the saved login in `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`); Pi handles OAuth refresh. A missing or unusable login fails with instructions to run `/login`, without starting an interactive login or publishing a plan. Environment-only tokens and Copilot CLI credentials do not replace the saved Pi login.

```sh
bun run examples/oss-committee/oss-committee.ts ./request.txt ./plan.md
```

The first argument is a nonblank UTF-8 request file; the optional output defaults to `plan.md` in the current working directory. Existing outputs are rejected before credentials are read, and publication uses exclusive creation (`wx`): a failed/aborted run or concurrent writer cannot overwrite a plan. Each member's exact model ID **and** reasoning level must be in the installed Copilot catalog before its saved login is checked; per-account model access can still fail, with no plan published. Each GitHub lookup returns at most five repository URLs and GitHub-reported metadata, not a bound on the number of requests. The search fetch is unauthenticated; Pi's saved Copilot login authenticates the model runtime, not GitHub repository search. Yield is a scheduling handoff, not an HTTP retry or a quota increase. `incomplete_results=true` means partial research, a valid empty result is reported as no matching library, and a failed lookup remains disclosed as unavailable research. A missing/`NOASSERTION` SPDX identifier means unknown license. GitHub-reported SPDX identifiers, stars and push times do not verify full license terms or quality; versions and API compatibility are likewise unverified. Never place secrets, private identifiers, or private endpoints in a GitHub query or the request/reports exported to a tracer. `convene` flushes the rounds' shared automatic tracer once, and all members close, **before** the approved titled plan is written. In an interactive terminal, dismiss the final TUI with `q`/Esc before publication; redirected execution uses Dummy and emits no trace output. When you explicitly supply Opik, inspect each review round's three node results and activation spans in its project → Logs → Traces; successful `flush()` alone does not prove remote ingestion.

The tool restricts search to GitHub repositories but cannot detect secrets in a model-generated query. Submit only requests safe for public GitHub search and complete tracer export; prompt instructions alone do not enforce that boundary.

### CaMeL: quarantined email parsing (live)

[`examples/camel/camel.yml`](examples/camel/camel.yml) and [`camel.ts`](examples/camel/camel.ts) implement the [CaMeL paper's Fig. 5 workflow](https://arxiv.org/abs/2503.18813). PLLM sees only the user query and writes a three-tool JSON plan. Interpreter reads the fixture inbox; tool-free QLLM extracts structured fields; Executor propagates source/reader capabilities and calls `tools.flowDecision` before writing to the in-memory fixture outbox. Both LLMs explicitly block Junco's default tools; no real email is sent.

See the [example README](examples/camel/README.md) for setup, trust boundaries, policy semantics, and offline verification.

```sh
bun run examples/camel/camel.ts
bun run examples/camel/camel.ts "Forward my last email to Bob; his address is in it"
bun test ./test/camel.test.ts
```

Requires the built native addon and a saved Pi Copilot login for `github-copilot/claude-sonnet-5.5` with medium thinking. The optional query must be one line. The workspace `send_email` rule grants trusted recipients; otherwise every recipient must be allowed to read the body, then the subject (public values are readable by everyone). Thus a literal reminder is permitted, but forwarding private email to an address extracted from it is denied. A denial stops subsequent steps. This is a one-query JSON DSL, not a Python interpreter; there is no repair loop or attachment support. Live outcomes depend on the generated plan; the offline tests prove the reminder, forwarding denial, and insufficient-information failure deterministically. Profiles append at the repository root.

In an interactive terminal, press `q` or `Esc` to dismiss the final trace screen; the outcome JSON prints after the tracer releases the terminal.

### MCP graph (live)

[`examples/mcp/mcp.ts`](examples/mcp/mcp.ts) runs two agents with all enabled JuncoAgent defaults plus each agent's graft MCP tools. Both servers and native defaults use one graph-owned `LockPolicy` collection, so the repository must be inside a valid seed with the production addon and a current graft index.

```sh
bun run examples/mcp/mcp.ts
```

The server must expose `graft_repo_map`, `graft_file_api`, `graft_find_code` and `graft_trace_calls` under the `mcp__graft__` tool namespace. The runner rejects a missing tool before agent execution; rebuilding the index does not repair a server protocol/version mismatch.

On a `mcp.JuncoMcpTools` definition, `definition.connect({ collection, toolLifetime: "call" })` closes schema discovery before returning and starts only the originating server for each invocation; each call joins its process cleanup before settling. The default `"connection"` lifetime keeps servers until `close()`. Lifetime is independent of `discardOnClose` (default `false`): set it to `true` for fresh, discard-only research. Call-scoped connections hold a collection lease; their cached `close()` fences new calls, cancels and joins active calls, then releases that lease. Select concrete tools with ordinary arrays and `mcp.getJuncoMcpToolIdentity(tool)`, not published collision names.

For a scripted end-to-end run without model credentials, run `bun run test/oss-committee.fixture.ts`. The fixture prints the approved plan of one scripted round. It and `bun test test/oss-committee.test.ts` choose an explicit `DummyTracer`, keeping offline output deterministic even in a terminal.

### Yak shaver: in-place refactoring (live)

[`examples/yak-shaver/yak-shaver.ts`](examples/yak-shaver/yak-shaver.ts) applies generalizing refactors in place to a Graft-indexed Git working tree and releases each changed file; it writes no report and never commits. Its paired YAML declares one lane and a `FinalizeBatch` code node, expanded for each batch. `runYakShaver` runs `graft build .` through the trusted collection's sandboxed `bash` tool before ranking indexed definitions by longest SCC dependency distance from public APIs/tests, deepest first, then positive distinct-caller count. Four candidates run in parallel `Proposer:r ==proposal:r==> Judge:r` lanes. Proposers can spawn up to three read-only researchers; judges validate checked proposals and record four criteria. `FinalizeBatch` validates completed lanes and applies passing proposals without waiting for slower lanes. Passing lanes must add a caller definition and remove net nonblank lines before their edits apply and their exact paths release in one managed command. Applications drain serially. Changed batches refresh the index before the next admission. Research uses a lazy `toolLifetime: "call", discardOnClose: true` MCP connection so each invocation sees fresh source and discards private writes.

Each proposer sends progress and final summaries on its lane's `summary:r` message edge; its judge calls `recv` first to drain these as evidence, never instructions. The `proposal:r` value edge still gates review on completed proposals, so missing summaries never stall a lane and summaries alone never start its judge.

`junco-tools` owns baseline capture, confined source reads, Git-root validation, and managed `applySourceEdits`/release; the example supplies refactor policy and edits. `AsyncDisposableStack` handles resource lifetime in research-close, tracer-flush, trusted-build-close, protected-close order, preserving `SuppressedError` chains. Prepared-agent ownership and `await using` close each batch and every supplied agent on failure. `schedules.drain(execution, { signal })` drives separate scheduler steps to preserve trace and cancellation boundaries before application; finalization remains in the scheduled code node, and the sink publishes only after all outcomes exist.

Prerequisites: `graft` 0.28.0-compatible on `PATH` (`bun run` supplies the pinned development CLI), the production native addon, the Git working-tree root inside a Btrfs seed, and the Copilot login. A later failure keeps earlier applied and released refactors and says so. `bun test test/yak-shaver.test.ts` exercises ranking, evidence checks, gates, admission, and real four-lane batch graphs with incremental application offline on faux models.

```sh
bun run examples/yak-shaver/yak-shaver.ts /path/to/repo
```

### Verus loop (live)

[`examples/verus/verus.ts`](examples/verus/verus.ts) runs persistent Verifier → Reviewer → Cleanup rounds. Each agent receives enabled JuncoAgent defaults plus every tool from the configured `verus` MCP entry; role-specific read/write limits remain prompt policy, not capability enforcement.

```sh
bun run examples/verus/verus.ts /path/to/source /path/to/new-output 'Natural-language specification'
```

Requires the native junco-tools addon, output inside a Btrfs seed, the configured lsp-mcp bridge/Verus analyzer, and a saved Pi Copilot login for `github-copilot/gpt-6.1-sol` with high thinking. Source is mirrored into a new/empty output directory. The bridge's `.lsp-mcp.json` is copied from its configured cwd into a private temporary directory inside output, avoiding ShellMux's external-cwd restriction; that directory and all agents are disposed on exit, while output is retained.

Output-only mutation and Reviewer read-only behavior are role instructions, not filesystem enforcement: every role has the full MCP tool set. The bridge can apply offered code actions, rename, and formatting, but exposes no arbitrary file-write API; unsupported translation/proof edits must be reported rather than claimed as applied. Empty LSP diagnostics are not evidence that the verifier ran. `bun test test/verus.test.ts` covers round ordering, independent review, feedback, cancellation, MCP failures, and source-copy isolation.

### CooperBench pair (live, driven by CooperBench)

[`examples/cooperbench/wf.yml`](examples/cooperbench/wf.yml) and [`wf.ts`](examples/cooperbench/wf.ts) are the canonical shared-worktree pair. CooperBench builds them into GNU/musl task-image overlays and runs both leaders, native recursive tasks, model clients, and tools in one container with one always-managed Marsh collection. Both normal final reports are required; identical shared patches go to the unchanged official grader. Credentials are ephemeral copies, telemetry uses the existing bridge, and cleanup is authorized by exact resource receipts rather than label sweeps. See [`examples/cooperbench/README.md`](examples/cooperbench/README.md) for ownership, packaging, preflight, and test contracts.

### SWE-bench Verified workflow (live, driven by junco-swebench)

[`examples/swebench/wf.yml`](examples/swebench/wf.yml) and [`wf.ts`](examples/swebench/wf.ts) form the non-Opus divide-and-conquer pair for SWE-bench Verified, with independently tunable Sonnet 5.5, Haiku 5.5 and GPT-6 Luna role rungs. [`solo.yml`](examples/swebench/solo.yml) and [`solo.ts`](examples/swebench/solo.ts) provide a single-agent Opus 5.5 baseline (`SWEBENCH_PAIR=solo`). The harness (`run-workflow.ts`, `benchmark.py` and their tests) runs either pair from a frozen repository snapshot, binds `bash` to each role's official-image container, supports concurrent independent instances and publishes official evaluator outcomes for measurement; see [`examples/swebench/README.md`](examples/swebench/README.md).

## API

```ts
type AgenticInput =
  | { readonly kind: "prompt" | "steer" | "followUp" | "nextTurn" | "error"; readonly text: string; readonly images?: ImageContent[] } // error: a failure notification, delivered as a follow-up
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };
// Native work states; N/T default to chat wire types and remain overridable.
type Agentic<N = AgenticInput, T = AssistantMessage> =
  JuncoAgent | JuncoGraph<N, T> | MockAgent | Deterministic<N, T> | Source<N, T> | Sink<N, T>;
// StepLess is implementation-local: NodeSpec minus state/step.
type AgenticNode<N = AgenticInput, T = AssistantMessage> = (
  | (NodeSpec<Agentic<N, T>, N, T> & { readonly policy: ToolCollection["policy"] })
  | ((Source<N, T> | Sink<N, T>) & { readonly policy?: never })
  | (StepLess<N, T> & { readonly state: Deterministic<N, T>; readonly step?: never; readonly policy?: never })
  | (StepLess<N, T> & {
      readonly state: SchedulerContext<Agentic<N, T>, N, T, never, JuncoGraph<N, T>>;
      readonly step?: never; readonly policy?: never; readonly persistent?: true;
    })
  | (StepLess<N, T> & { readonly state: JuncoAgent | MockAgent; readonly step?: never; readonly policy: ToolCollection["policy"] }) // chat wires only
);

// Graph construction is passive. Pair it externally with schedules.context to drive it.
class JuncoGraph<N = AgenticInput, T = AssistantMessage, EH = never>
  extends DataflowGraph<Agentic<N, T>, N, T, EH> {
  constructor(source: Source<N, T>, sink: Sink<NoInfer<N>, NoInfer<T>>,
    window: Width, threads: Width, tracer: DataflowTracer | undefined,
    policy: ToolCollection["policy"], collection?: ToolCollection);
  readonly source: Source<N, T>;
  readonly sink: Sink<N, T>;
  // The returned context's graph adopts the collection's creator hold.
  static create<N, T, EH, C = AgencyNodeMetadata>(cwd: string, options: ToolCollectionOptions,
    build: (collection: ToolCollection) =>
      SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>> |
      Promise<SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>>
  ): Promise<SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>>;
  // Preserve skeleton IDs/topology with fresh transports and caller-supplied meaningful ports.
  static map<S, L, N = AgenticInput, T = AssistantMessage>(
    skeleton: Pick<import("ngraph.graph").Graph<S, L>, "forEachNode" | "forEachLink" | "getLinks">,
    f: (state: S) => Agentic<N, T> | AgenticNode<N, T>,
    options: { readonly source: Source<N, T>; readonly sink: Sink<N, T>;
      readonly policy: ToolCollection["policy"]; readonly tracer?: DataflowTracer },
  ): SchedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, JuncoGraph<N, T>>;
  // Ports precede root and children. Construction failures leave members caller-owned.
  static spawn<Input, N = AgenticInput, T = AssistantMessage>(
    source: Source<N, T>, sink: Sink<N, T>, root: AgenticNode<N, T>,
    inputs: readonly Input[], child: (input: Input) => AgenticNode<N, T>,
    tracer: DataflowTracer = TuiTracer.shared(),
  ): SchedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, JuncoGraph<N, T>>;
  static compact<A extends Agentic<N, T>, N, T, EH>(
    graph: DataflowGraph<A, N, T, EH>, policy: CompactionPolicy,
  ): Promise<void>;
  compact(policy: CompactionPolicy): Promise<void>;
  // One child per input under the registered `rootId`, each with two fresh message edges,
  // `${rootId}->${childId}` and `${childId}->${rootId}`; children are never linked.
  appendChildren<Input>(rootId: NodeId, inputs: readonly Input[], child: (input: Input) => AgenticNode<N, T>): void;
  readonly policy: ToolCollection["policy"];
  readonly collection: ToolCollection | undefined;
  readonly tracer: DataflowTracer;
  get signal(): AbortSignal;                 // context drives observe it automatically
  abort(reason?: unknown): Promise<void>;    // recursive; a fresh signal once settled
  close(): Promise<void>;                    // recursive and terminal; cached
  [Symbol.asyncDispose](): Promise<void>;    // close()
}

// NodeOptions<N, T> = { id?, description?, trigger, is_available? } comes from "dataflow-engine".
// Prompt agents register directly: graph.addNode({ ...options, policy, state: agent }) — a step-less spec whose
// state is a JuncoAgent or MockAgent (chat wires only). Each addNode builds its own driver.
// Raw { state, step, policy } specs register unchanged;
// Complete Source/Sink specs register their own state directly under the graph's policy.
// A step-less { ...options, state: coroutine } runs its Deterministic body.
// A step-less { ...options, state: childContext } nests childContext.graph;
// its native state is that actual graph, and its result comes only from the child sink.
// Coroutine and nested-context specs take no own policy field.
// The prompt belongs to the agent:
//   JuncoAgent.create/fromResolved({ prompt: string | ((inputs: ParentView<AgenticInput, AssistantMessage>) => string) })
//   agent.stagePrompt(prompt, { images? }) // arms a later round

class Deterministic<N = AgenticInput, T = AssistantMessage> implements NodeGenerator<N, T> {
  // A supplied collection must match `policy`; the coroutine borrows a lease until close().
  constructor(body: (signal: AbortSignal, collection?: ToolCollection) => NodeGenerator<N, T>, policy: ToolCollection["policy"], collection?: ToolCollection);
  readonly policy: ToolCollection["policy"];
  readonly collection: ToolCollection | undefined;
  readonly signal: AbortSignal;
  readonly step: () => NodeGenerator<N, T>; // hands out this coroutine once
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
}
class MockAgent<S, P, T> implements Agentic<S, P, T> /* junco-agent's protocol */ {
  constructor(transcript: MockTranscript<S, P, T>);
}

type CompactionPolicy =
  | "all"                        // every node
  | "more-than-forty"            // every node, context > 40% of window
  | "all-available"              // nodes in one graph.available() snapshot
  | "more-than-forty-available"; // available nodes, context > 40% of window
```