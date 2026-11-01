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
- `await tracer.GrafanaRecorder.create({ url?, intervalMs? })` (defaults `http://localhost:8000`, 1000 ms) creates or updates the tagged `junco-telemetry` dashboard (built with `@grafana/grafana-foundation-sdk`; an untagged dashboard at that UID is a conflict) and, from the first recorded event, pushes Influx line-protocol snapshots to Grafana Live stream `recorder.streamId`. Open `recorder.dashboardUrl`: memory, peak memory, tokens, token rates per node and in total, plus operation, resource/token and inclusive graph-context tables. Memory is shell-pipeline cgroup memory, not host heap; peaks are sampled. Live keeps no history: a browser shows only what it received while connected. Requests carry no credentials: the Grafana instance must grant anonymous users an organization role allowed to write dashboards and push to Live (e.g. `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_ROLE=Admin`); errors carry only an operation and status. Transport failures stop pushing without retries and reject `flush()`/`close()`.
  Snapshot measurements (`junco_total`, `junco_node`, `junco_context`, `junco_operation`) use
  one numeric `value` field and a `metric` label. This keeps Grafana Live's field schema stable
  when new nodes, optional usage fields, counters or gauges arrive; absent metrics are omitted.
  The managed dashboard selects metric names; custom panels using the former wide numeric
  fields must select the `metric` label instead. Probe points retain their existing format.
- Both sinks take `probe` events (`{ resource: "probe", kind: "probe", edgeId, value }`, emitted by YAML `probe: true` edges). JSONL appends one resource-free Sample per event — `node` is the `/`-joined context, `measurement.probe` is `[{ edgeId, value }]`, `firedAt` is the receipt time, no `runId` — regardless of activation outcome; fitting ignores it. Grafana sends each event exactly once as its own Live push of one `junco_probe,node=<context>,edge_id=<edgeId> value=<number>` point stamped at receipt, in record order before the interval's snapshot (Live keeps only one point per series and millisecond of a single push, so separate pushes preserve same-millisecond bursts), plotted in the **Edge probes** panel. A nonfinite value latches `invalid probe value` for `flush`/`close` and is never written.

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

Operational logs still use `junco-tools/log`'s one process-wide [tslog](https://github.com/fullstack-build/tslog) logger. `LOG_LEVEL` (`SILLY`, `TRACE`, `DEBUG`, `INFO` — the default — `WARN`, `ERROR`, `FATAL`) is read once at startup; missing/blank means INFO, names are trimmed and case-insensitive, and unknown or numeric values fail before native or model work. `issueLog`'s complaint-observer failures use WARN. The logger receives every junco-policy capability decision of the ShellMux `ShellMuxLease.create` opens: violations at INFO (`junco-policy authorize: policy violated`, with principal, action, resource segments, failed precondition and allowed fixes) and, under `LOG_LEVEL=DEBUG`, tentative grants. While the TUI owns the terminal, admitted operational logs are redirected exclusively into its trace pane. Each mux's `lease.release()` (and so a collection's final release) drains these records; its `flushLog()` barrier waits for drawing, not keyboard dismissal. Outside the TUI that barrier flushes stdout.

`dataflow-engine-opik` is a workspace package and a root development dependency providing `OpikTracer`, so the root install already provides it and `opik`; under Bun its `bun` export loads its source directly. Pass it explicitly like any other tracer, configured by the SDK's `OPIK_*` variables:

```ts
import { OpikTracer } from "dataflow-engine-opik";
import { Opik } from "opik";

const tracer = new OpikTracer(new Opik(), "JuncoGraph.run");
```

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

Every example run appends `tracer.JsonlRecorder` profile samples (one per node activation: runtime, tokens, cost, operations) to `<problem>/.junco/log.jsonl`, where the problem is the directory the example works on: the current directory (mixed, OSS committee, recursive agency), the repository root (MCP, Yak shaver), Verus's output directory, or the CooperBench pair's `problem_dir`. `examples/support.ts` `problemRecorder` creates it; the caller closes it after its last graph. A recorded graph rejects any agent without a view of the same recorder, so agents prepared outside the graph (committee, Verus and Yak members) are created with `recorder` and their `recorderNodeId`.

### OSS committee (live)

[`examples/oss-committee/oss-committee.ts`](examples/oss-committee/oss-committee.ts) runs three persistent `JuncoAgent` members through review rounds declared in its paired YAML. Each round builds fresh Source/Sink ports and a `schedules.parallel()` context over the same members; their sessions retain every earlier round. Librarian (`claude-opus-5.5`, medium) searches GitHub with generic technical terms, reporting stars, last push, URL and license. Architect (`gpt-6-sol`, high) designs from research with only builtin tools. Reducer (`claude-sonnet-5.5`, xhigh) combines both final reports, records a typed `review` verdict and produces the only titled Markdown plan. Revision starts another round; approval publishes the plan. There is no round limit; a round without a verdict fails. A failed lookup requires Librarian to hand partial research to Architect on a message edge and yield until Architect finishes. Reducer still waits for both normally stopped, nonempty final reports. Unsupported reasoning levels fail rather than silently downgrade.

Before running the live example, start `pi`, use `/login`, and select GitHub Copilot. The committee shares Pi's `ModelRuntime` and uses the saved login in `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`); Pi handles OAuth refresh. A missing or unusable login fails with instructions to run `/login`, without starting an interactive login or publishing a plan. Environment-only tokens and Copilot CLI credentials do not replace the saved Pi login.

```sh
bun run examples/oss-committee/oss-committee.ts ./request.txt ./plan.md
```

The first argument is a nonblank UTF-8 request file; the optional output defaults to `plan.md` in the current working directory. Existing outputs are rejected before credentials are read, and publication uses exclusive creation (`wx`): a failed/aborted run or concurrent writer cannot overwrite a plan. Each member's exact model ID **and** reasoning level must be in the installed Copilot catalog before its saved login is checked; per-account model access can still fail, with no plan published. Each GitHub lookup returns at most five repository URLs and GitHub-reported metadata, not a bound on the number of requests. The search fetch is unauthenticated; Pi's saved Copilot login authenticates the model runtime, not GitHub repository search. Yield is a scheduling handoff, not an HTTP retry or a quota increase. `incomplete_results=true` means partial research, a valid empty result is reported as no matching library, and a failed lookup remains disclosed as unavailable research. A missing/`NOASSERTION` SPDX identifier means unknown license. GitHub-reported SPDX identifiers, stars and push times do not verify full license terms or quality; versions and API compatibility are likewise unverified. Never place secrets, private identifiers, or private endpoints in a GitHub query or the request/reports exported to a tracer. `convene` flushes the rounds' shared automatic tracer once, and all members close, **before** the approved titled plan is written. In an interactive terminal, dismiss the final TUI with `q`/Esc before publication; redirected execution uses Dummy and emits no trace output. When you explicitly supply Opik, inspect each review round's three node results and activation spans in its project → Logs → Traces; successful `flush()` alone does not prove remote ingestion.

The tool restricts search to GitHub repositories but cannot detect secrets in a model-generated query. Submit only requests safe for public GitHub search and complete tracer export; prompt instructions alone do not enforce that boundary.

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

[`examples/cooperbench/wf.yml`](examples/cooperbench/wf.yml) and [`wf.ts`](examples/cooperbench/wf.ts) run one feature pair as two private feature teams. Each leader reads only its own assignment, works in its own network-less container through `container_bash`, coordinates with the other leader over native `send`/`recv`, and delegates leaf jobs through `divide` (all jobs must pass and compose) and `tournament` (first validated attempt wins) to worker graphs in disposable child containers. CooperBench's `scripts/run_junco.py` drives it; stdout is JSONL only. See [`examples/cooperbench/README.md`](examples/cooperbench/README.md).

### SWE-bench Verified workflow (live, driven by junco-swebench)

[`examples/swebench/wf.yml`](examples/swebench/wf.yml) and [`wf.ts`](examples/swebench/wf.ts) form one divide-and-conquer pair for every SWE-bench Verified problem: an Opus lead, three Sonnet evidence workers, an Opus planner, two Sonnet candidates validated in pristine acceptance containers, an Opus integrator and a Sonnet verifier. The separate junco-swebench harness runs it from a frozen snapshot of this repository and binds each shell-using node's `bash` to its own container; see [`examples/swebench/README.md`](examples/swebench/README.md).

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
// JuncoAgent.fromResolved(options): Promise<JuncoAgent<...>>; its constructor is protected.
// agent.events.on("tool_end", handler) and agent.hooks.on("before_request", handler)
// use the native event/hook surfaces. Local invariant failures throw JuncoAgentError.
```

**Skeletons.** Build text-only topology with `createGraph<string, void>({ multigraph: true })` from `ngraph.graph`, then call `JuncoGraph.map(skeleton, text => members.get(text)!, { source, sink, policy: tools.LockPolicy })` with pre-acquired agents and fresh meaningful ports. It returns a parallel context; wire the chosen terminal work's value edge into its sink before driving. Mapping is synchronous, in insertion order, and never runs a member or copies queued data. IDs, direction, parallel links, cycles and isolated nodes survive with independent empty transports. Bare roots start immediately; other bare states wait for any incoming message (cycles need an explicitly triggered seed). Full specs customize triggers; nested work uses `{ state: childContext, ...nodeOptions }`. The skeleton's ID overrides the spec's. A failed mapper leaves acquired members caller-owned; successful mapping hands registered resources to the graph.

Every kind reuses the engine's `NodeOptions`. An explicit `is_available` replaces the helper default. Descriptions stay on native nodes; a prompt lives on its agent. Native state is always the original instance, including ports and nested graphs. Contexts and policies are never native work states.

Nested graph nodes stay resumable while running, but after returning and being re-armed through a value self-edge they wait for their trigger again.

**Subagents.** `task` is an enabled default unless blocked. Children inherit the parent's immutable `tool_block`; a task's additional `tool_block` extends it, while `tools` selects inherited additions and cannot overlap the effective block. Omitted `tools` inherits surviving parent-active additions; `[]` selects none, but unblocked defaults remain. Retries pin resolved model, active names, prompt, and the copied additional block.

Graph-driven prompt agents receive every queued inbound message when they activate, independently of trigger edge order; triggers control readiness, not inbox selection. The engine's `messageInputs` schedules these opaque deliveries. Tools can inspect authenticated, already-delivered task outputs through `agent.getTaskResults()` (the current or latest run's; a new run or abort starts empty) instead of parsing native event envelopes; only the caller's own queued report entries count, never a look-alike message.

**Task failures.** Failed retries reacquire fresh children with the original prompt, resolved model, active names, and additional `tool_block`; parent exclusions cannot be undone. The existing ignore/retry decision protocol and stable task handles are unchanged.

**Complaints.** `complain` is a JuncoAgent default, not unconditional: `tool_block: [complain]` removes it. Enabled complaints retain graph attribution and the full request in the shared `tools.issueLog`; bare Pi agents and `MockAgent` behavior are unchanged.

### Standard library namespaces

The root entry also re-exports the standard library for building junco workflows as namespaces, beside the flat agency exports above:

| Namespace | Contents | Source |
|---|---|---|
| `graph` | `DataflowGraph`, `JuncoGraph` (with `fromYaml`, `create`, `map`, `spawn`, `compact`), `MockJuncoGraph`, native observations/execution, edges (`Edge.message`, `Edge.value`, `Message.create`, `from`), `NodeId`/`EdgeId`, `Width`/`UNBOUNDED`, `Queue`, `renderPretty`, errors and native node/edge types | `dataflow-engine`, this package |
| `graph.nodes` | `Source`, `Sink`, `ConstFanout`, `ConstFanin`, `StepNode`, `EmitOnce`, `Deterministic`, and the `Agentic`/`AgenticInput`/`AgenticNode`/`CompactionPolicy` types | `dataflow-engine`, this package |
| `trigger` (also `graph.trigger`) | `TriggerRule`, `TriggerEntry` and `TriggerKind` (`"all"` or `"any"`); rules `TriggerRule.allOf(...)`, `TriggerRule.anyOf(...)`, `TriggerRule.when(edge)`, `TriggerRule.always()`, `TriggerRule.never()`; entries `TriggerEntry.on(edge)`, typed by their edge's message and result payloads; `evaluateTrigger`, `satisfiedEdges` | `dataflow-engine` |
| `agent` | `JuncoAgent`, `JuncoAgentError`, `TaskPolicy`, `TaskFailurePolicy`, `SubagentObserver`, and the `Agentic` protocol types | `junco-agent` |
| `tools` | Everything `junco-tools` exports, including the ten `ToolCollection` natives, coordination tools, task launch contracts with per-task `tool_block`, and conditional `ComplainTool` support | `junco-tools` |
| `schedules` | Selection operators `choose`, `separate`, `agent`, `strength`; derived `parallel`, `roundRobin`; resource policies `limit`, `lowest`, `highest`; agency-aware `context`; stateless `pi`; Ralph controller `ralph`; profile optimizer `runOptimizer` with its `OptimizationRequest`/`OptimizationState` types; decision helpers `select`/`nodeIds`, strength constants/types, `Ladder`/`LadderRung`/`validateLadder`/`uniformLadder`, scheduler/observation types | `junco-scheduler`, this package |
| `syntax` | `parse`, `resolveAgents`, `createJuncoAgent`, `finalText` (a member's normally completed, nonblank result text), document schema/types, `BuildOptions`/`FromYamlOptions`, `DeterministicNode`/`CodeContext`/`CodeRegistration`; construction uses `JuncoGraph.fromYaml` | this package |
| `tracer` | `DataflowTracer`, `DataflowRunTrace`, `DataflowStepTrace`, the no-op `DummyTracer`, and `TuiTracer` (`shared()` selects the lazy interactive default or Dummy; `await create(name?)` explicitly acquires a TUI) | `dataflow-engine`, this package |
| `workflows` | Declarative YAML graph strings: `ralph`, driven by `schedules.ralph` with models supplied in the TypeScript ladder; `allFanIn`, one selection once every candidate returned; `anyFanIn`, one streamed selection per delivered batch, driven by `schedules.anyFanIn`; `optimizer`, driven by `schedules.runOptimizer` | this package |

```ts
import { graph, schedules, tracer, trigger } from "junco";
import { context } from "junco-scheduler";

const g = new graph.DataflowGraph<void, number, string, never>(graph.Width.create(1), graph.UNBOUNDED, new tracer.DummyTracer());
const execution = context({ graph: g, scheduler: schedules.parallel() });
const a = graph.Edge.message<number, string>("a");
const source = g.addNode(new graph.nodes.ConstFanout(7, [a], { state: undefined, ret: "sent" }));
const sink = g.addNode(new graph.nodes.StepNode<void, number, string>(() => [], { state: undefined, trigger: trigger.TriggerRule.allOf(trigger.TriggerEntry.on(a)) }));
g.addEdge(source, sink, a);
await execution.run();
```

A generic `DataflowGraph`'s tracer stays optional: pass a `tracer.DataflowTracer` (for example `OpikTracer` from `dataflow-engine-opik`, or `tracer.TuiTracer.shared()`) as its third argument, or omit it to run untraced. A `JuncoGraph` takes its tracer or `undefined` as the fifth argument, after its ports and bounds. The Opik adapter is not re-exported; this package does not depend on `dataflow-engine-opik` or `opik`.

### Prompt agents: `graph.addNode({ ...options, state: agent })`

- A node drives its member through one run per generator. A return delivered on its own value feedback edge re-arms the node with a fresh generator, retaining the same agent session and inbox; the next run needs a staged prompt. The body first yields nothing, so the engine's priming consumes no input. Each later activation appends delivered message batches (per edge, FIFO) and fresh parent results to the retained inbox. Value freshness is keyed by edge id and `!==` value identity: replacing a value delivers it again; mutating the same object does not. Payloads are data, never native commands: the model reads and drains the inbox with `recv`, sends on outgoing message edges with `send`, and discovers topology with `info`. A `ready` member starts its staged prompt (`JuncoAgent.create`/`fromResolved({ prompt })` or `agent.stagePrompt(prompt, { images? })`); a prompt callback `(inputs: ParentView<AgenticInput, AssistantMessage>) => string` runs once, synchronously, reading the retained inbox without draining it, and may throw to reject invalid inputs. Each activation calls `agent.next(inbox)` exactly once: a `yield` step leaves the member paused, a settled step returns its native final message (including `error`/`aborted` stop reasons), and a failed step fails the node with the original error. Only `yield` and a Marsh policy denial pause a run.
- Before initial admission or any re-arm, a member is available only when its trigger fires and it has a staged prompt (status `ready`) or fresh input; fresh input alone is retained and the idle member stays quiescent until a prompt starts it. A constructor prompt is one-shot: stage the next round's prompt with `stagePrompt` (it throws `busy` if one is already staged). A prompt callback that throws fails the node with the identical error. A member iterator that ends before its run settles (the member was closed) fails the node with `closed`. Once started, a member stays available until its node returns, even if its trigger was drained; a staged prompt alone cannot start a re-armed node.
- A validated handoff can use a prompt callback reading `inputs.messages`/`inputs.values`, rejecting invalid data and returning the assignment (the mixed Reviewer's joined review, MCP's Dependencies and Yak's judges). More involved preparation and validation runs in scheduled `kind: code` nodes, as in the OSS committee and Verus examples. Consumers need no `recv` when their assignments are staged from these inputs.
- `info({})` returns `{ parents, children }` with route objects containing only `id`, `edgeId` and `kind` (`message` or `value`). Put artifact requirements and acceptance conditions in role/handoff prompts; select handoffs by explicit edge ID and kind `message`, then send using that ID. Edge schemas and deterministic consumers still validate payloads. The YAML `contracts` field, receiver `contract` callbacks and exported `Contract` type have been removed; legacy YAML fields fail validation.
- One member can run in successive graphs, staged before each later registration with `stagePrompt`; its session keeps every earlier run.
- A finished node keeps its agent alive and usable until a graph containing it closes.

### Nested graphs: `{ ...options, state: childContext }`

- Register the child's `SchedulerContext`, not a bare graph. The registered native state is still the actual `childContext.graph`. Priming yields nothing and makes no child decision. Each later parent activation admits its edge-addressed message batches and fresh values (by edge id and `!==` identity) into the child's Source, then advances at most one child decision.
- Source routing is scheduled deterministic work; it validates/converts the original `ParentView` and returns messages for explicitly wired internal edges. An empty view is ignored. Each graph requires fresh Source/Sink instances with mandatory distinct branded IDs; inbound source edges, outbound sink edges and value edges out of the non-returning source are rejected.
- Only after successful child work, its Sink drains FIFO messages through the parent wrapper's real sender ID. A completing sink can stage its final messages and return its exact `T` in one activation. Failed delivery retains the undelivered suffix, and child failure/cancellation publishes nothing.
- Quiescence returns exactly `childContext.graph.result(childContext.graph.sink.id)`, including present `undefined`. Absence is an `invalid_state` failure. Intermediate member results never become nested output. A precompleted child with empty ingress can publish its retained sink result without another child decision.
- `persistent: true` (nested contexts only, message edges only) never returns: when the child quiesces the wrapper parks instead of failing, and wakes only for runnable child work or a queued message on one of its trigger edges. It runs until its owning graph closes or aborts. In YAML, a `kind: graph` node whose graph declares `sink: { stream: true }` is registered persistent.

### Workflows: `workflows` + `schedules`

Ralph is an ordinary YAML agent graph with a `Ralph -> Ralph` value feedback edge, not a node kind or a separate package entrypoint. Run it under Bun or Node:

```ts
import { contentText } from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import { AssistantMessageSchema, graph, JuncoGraph, schedules, workflows } from "junco";
import { Value } from "typebox/value";

const rung = { model: "github-copilot/claude-sonnet-5.5", thinking: "medium" } as const;
const ladder: schedules.Ladder = { smol: rung, low: rung, med: rung, high: rung, xhigh: rung };
const execution = await JuncoGraph.fromYaml(workflows.ralph, {
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  ladder,
  ...schedules.ralph({ rounds: 3 }),
});
try {
  execution.graph.source.enqueue({
    messages: new Map([[graph.EdgeId.create("assignment"), [{ kind: "prompt", text: "Write a complete project plan." }]]]),
    values: new Map(),
  });
  const result = execution.graph.result(execution.graph.sink.id);
  if (O.isSome(result) && Value.Check(AssistantMessageSchema, result.value))
    console.log(contentText(result.value.content));
} finally {
  await execution.graph.close();
}
```

- `schedules.ralph({ rounds })` supplies availability factories; rounds default to `2` and must be a positive safe integer (otherwise `RangeError`). The first round prompts the exact assignment; later rounds prompt the assignment plus only the immediately preceding complete draft, in the same session. Native yields resume within a round and never count as one.
- `schedules.ralph({ until, rounds? })` runs until success instead: the synchronous `until(result, { assignment, round, label })` (`schedules.RalphPredicate`; `round` is one-based, `label` the graph level's) is called exactly once per completed, validated draft. `true` publishes that draft; `false` stages the revision. Omitted `rounds` means no cap; an explicit `rounds` is a hard cap whose last `false` fails with `Ralph reached the round limit without success`, leaving the sink unpublished. A non-function `until` throws `TypeError` at construction; a non-boolean result (a Promise included), a thrown value, a blank or abnormal draft, or the cap failure is thrown from availability and rethrown on every later probe without calling the predicate or model again. `BuildOptions.available` factories receive the level's `label` for this.
- The `assignment` route requires exactly one text `prompt`, without images. Invalid assignments fail before a model request. Intermediate drafts must have stop reason `stop` and nonempty trimmed text before another round can start. The controller does **not** validate the final draft: a sink returns the native final message as-is, and a nested YAML sink also sends that same message, unchanged, on the parent's outbound message edges (whose schemas must admit it).
- YAML payloads are raw values checked only by their edge schemas: a nested graph's source forwards parent messages and parent values unchanged onto its routes (admitting the union of those routes' schemas), and its sink returns the selected result unchanged for parent value edges and sends it on parent message edges (admitting the union of their schemas). A `{{edge}}` prompt placeholder renders `AgenticInput` text (`appendMessage` contributes nothing) or a normally completed `AssistantMessage`'s trimmed text; any other payload, such as a number, fails naming the edge — read it with `recv` or a code node. YAML graphs are typed `JuncoGraph<TSchema, unknown>`: narrow results and inputs with `typeof` or `Value.Check(schema, value)`.
- The sink is held until the final round; `graph.result(Ralph)` and outbound value edges retain the latest draft. Factories decline graph levels without `Ralph->Ralph` by returning `undefined`, leaving their nodes and outer sink at default availability. `examples/mixed/mixed.ts` nests Ralph and sends only its final answer to Reviewer.
- YAML `sink: { stream: true }` forwards every message delivered to `$sink` and never returns; it accepts only message edges and rejects `sink.returns`. At the root each message keeps its inbound edge id; nested, it is sent on every parent outbound message edge. Like every node, the sink's default trigger is all-of its inbound edges: with several inbound edges, set `sink.trigger: { any: [...] }` to stream each as it arrives.
- `workflows.allFanIn` selects, without synthesis, the best of one batch of completed assistant answers on route `candidates`; its result is the selection. Embedded, give the wrapper an explicit `{ all: [<parent value edges>] }` trigger and route those edges to `$source~>AllFanIn`, so it selects once, only after every candidate returned.
- `workflows.anyFanIn` + `...schedules.anyFanIn()` stream one selection per delivered batch of `{ kind: "prompt", text }` candidates on route `candidates`, published under `AnyFanInPublish~>$sink`. The controller admits one source delivery at a time and stages a prompt containing only that batch (`CURRENT_BATCH`), so earlier candidates and selections never leak in; the next delivery waits until the previous selection is published, and identical selections are each published. Non-prompt or blank candidates, and blank or abnormal selections, fail the graph without publishing or admitting more. Embedded, route every parent message edge to `$source~>AnyFanIn`, give the wrapper `{ any: [<parent message edges>] }` and connect it by message edges only; parents need not return. One controller serves sibling levels independently and declines levels without `AnyFanIn->AnyFanIn`; merge `available` maps to combine it with `schedules.ralph`.

The profile optimizer's Editor declares `tools: [read_target, edit_tuning]` and blocks native, task, yield, and send defaults; its exact surface is `info`, `recv`, `read_target`, `edit_tuning`, `complain`. It remains native-free while the deterministic host measures and scores candidate scheduler, ladder, and limit regions.

- `fromYaml` requires a ladder when it creates agents. Supplying `createAgent` makes the ladder optional; omission leaves supplied agents' settings untouched. A ladder is validated even with `createAgent`. Default creation starts at `med`; the scheduler's selected strength is applied before execution.
- Successfully registered `createAgent` agents belong to the graph by default; `createAgentOwnership: "caller"` (requires `createAgent`) keeps them caller-owned, so graph close aborts and joins them without disposing them. Use it for a fresh graph per round over persistent agents, closing each round's graph. Construction failure never disposes factory agents.
- `scheduler(label, graphPath)` is called once per graph level with its display label (which may repeat across nested graphs) and its unique wrapper path (`""` at the root, `Child` or `Child/Grandchild` nested). Every `createAgent` spec carries `graph` (the enclosing display label), `node` (the local node ID) and `path` (the unique root-relative node path, e.g. `Child/Worker`); key per-agent bindings by `path` when nested graphs may reuse labels or local IDs.
- Optional `params` substitute `{{ params.name }}` verbatim in YAML text before parsing; parsed objects reject `params`. Runtime `{{edge}}` prompt substitutions remain separate. Code definitions are passed by node ID, never loaded from YAML paths.
- YAML text is one strict YAML 1.2 document (the `yaml` package, under Bun or Node): every YAML error or warning is fatal, including duplicate keys (`1` and `"1"` collide), complex/alias/non-string-tagged keys, unknown tags or directives and more than 100 alias expansions; plain scalar keys are strings, shared anchors keep object identity and `<<` merges (with overrides and repeats) are supported.
- Every graph level, nested graphs included, needs one entry and a path to `$sink`. Identifiers and list entries must be nonblank and unique. Agent `tools` and `tool_block` are disjoint; overlap points at the conflicting block entry. Selected registry definitions override defaults by exposed tool name; explicit duplicate definitions still fail. `toolSource` identifies their declaration module in INFO replacement notices, independently of YAML diagnostic `sourceName`.
- `parse` and `JuncoGraph.fromYaml` throw source-located `syntax.ValidationError`s before construction. Tool overlap diagnostics identify the node, both fields and repair; `resolveAgents` also enforces literal overlap for programmatic documents and rejects registry aliases whose concrete name is blocked, using the full nested node key.
- Every YAML edge (message, value or default-kind, including edges inside nested graphs) requires a `schema:` mapping: a JSON Schema Draft 2020-12 object, validated against TypeBox's 2020-12 meta-schema before any agent or resource is created; errors name `/graph/.../edges/<index>/schema/...`. An explicit `$schema` must select that dialect, and `{}` is the explicitly unconstrained schema (never an implicit default). Supported keywords are the 2020-12 assertions/applicators TypeBox implements plus meta-data annotations, `$comment` and `$defs`; unknown keywords and unregistered `format` names are rejected. Schemas must be acyclic JSON values; YAML anchors may share them. `$ref` must be a local JSON pointer (`#` or `#/...`) to a schema position in the same edge schema; external and anchor references, resource keywords (`$id`, `$anchor`, `$dynamic*`, `$recursive*`, `$vocabulary`) and reference cycles that never descend into the payload are rejected, while recursion through `properties`, `items` and similar child positions is allowed. There is no schema registry or file/network resolution.
- An edge may set `probe: true` to record every successful publication on it — source routes, code yields and results, agent sends, feedback and nested sink forwarding — as a `probe` event tagged with its edge ID in the owning graph's recorder context (`root::Child` inside nested graph `Child`); fan-out records once per target edge. It requires an explicit top-level `schema.type` of `number` or `integer`; `const`, `enum`, `$ref`, compositions or type arrays alone fail at `/graph/.../edges/<index>/probe`. Absent or `false` records nothing; rejected payloads and dry send validation record nothing; without a recorder the flag is inert.

### Coroutines: `Deterministic` and `{ ...options, state: coroutine }`

- `new Deterministic(body, policy, collection?)` invokes `body(signal, collection)` once; the generator speaks the engine's own protocol (dependent bodies start with `let view = yield []`, sources may emit immediately) and its closure holds any state. `step()` hands the coroutine to one consumer only; a second registration or a direct advance before it fails with `invalid_state`, and advancing a finished coroutine fails with `invalid_state`.
- `abort(reason)` aborts `signal` and joins the advance in flight; a rejection with exactly that reason is cancellation. `close()` (and async disposal) is cached: it signals pending work, joins it, then drains the generator through `return()`, discarding cleanup batches; later advances reject with `closed`, and an advance in flight when close began rejects with the signal's reason rather than publishing cleanup output. A sole cleanup error rejects as itself, several as `AggregateError("Deterministic close failed")`. Bodies that ignore their signal cannot be preempted.

### Scheduling: policies paired with work graphs

- The work-selection operators are `choose({ where?, rank, width? })` (ranks available owned nodes with raw string-ID ties), `separate(leftOwns, left, right)` (partitions exclusive selection authority and concatenates validated child decisions left-to-right), and `agent(invoke)` (normalizes one oracle response). `parallel()` and history-derived `roundRobin(order?, width?)` are derived policies. A `Scheduler<S,N,T,C>` returns `{ selected: readonly NodeModel[] }`, where each entry is `{ nodeId, modelStrength }`. Strength is an index into `MODEL_STRENGTHS`: `smol`, `low`, `med`, `high`, `xhigh`; work-only policies default to `med` (`2`). `select(ids, strength?)` creates entries and `nodeIds(entries)` extracts IDs. `strength((snapshot, id) => "high", inner)` assigns a rung per selected node; filtering policies preserve each entry's strength. Application priority, FIFO, random choice and fallback remain ordinary TypeScript.
- `schedules.context({ graph, scheduler })` supplies agency metadata (`agentStatus`, `lastYield`) and unseen-value reads. For a plain native graph use `context` from `junco-scheduler`, with optional typed `describeNode`, pure `readInputs`, and async `prepare(selected, signal)` hooks. Preparation runs after decision validation and freshness checks, before any selected work starts; rejection fails the drive. Pairing performs no observation, provider call, registration or binding. Policies are reusable; histories belong independently to each context, not the graph or policy closure. `execution.step()` takes at most one decision; `execution.run()` repeats to quiescence, without asking a policy when no work is available.
- `schedules.context({ graph, scheduler, ladder })` applies the selected rung to each prompt agent before execution: `{ model: "provider/model-id", thinking?: ThinkingLevel }`, with omitted thinking reset to `"off"`. A `Ladder` requires all five rungs; model IDs split at the first slash. Repeated selections at the same strength do not repeat model-setting calls. Without a ladder, the context never touches model or thinking settings.
- Snapshots retain exact native state/message/result and caller metadata types. Their all-node records, topology tuples, queue arrays, result membership, metadata map and history are detached readonly containers. Opaque state/message/result/metadata values are borrowed identities, not deep-cloned or frozen; callbacks must only read them, and applications needing historical object contents must use immutable data. Native mutation and non-empty Source admission invalidate an in-flight decision; metadata is captured freshly for every decision.
- `separate` separates only authority over existing work-node IDs and projects history to each branch. Native observations, external metadata and thread bounds stay shared. Authority safety does not promise thread feasibility, progress, fairness, JavaScript memory/effect isolation or external-service isolation. The frame rule applies only to owned-local readonly callbacks; ordinary TypeScript is not sandboxed. Policies, contexts and branches never become work nodes or transports.
- `schedules.limit({ memory }, scheduler)` preserves inner order and skips work that would exceed the sum of safe memory predictions for one concurrent column; it throws if no selected node fits. Wrap the outermost scheduler, not each `separate` branch. Retained memory across yields is not tracked: leave headroom. `schedules.lowest(kind)` / `highest(kind)` rank safe predictions in base units (e.g. cheapest tokens first or longest runtime first). Estimation supports constants and planned `count` features only; it never measures payload bytes/tokens. Priming is charged on the planned batch too. Missing selected/compared profiles throw, and small-work-first policies can starve large work.
- `schedules.limit({ tokens, tools, scope? }, scheduler)` enforces actual usage, unlike `memory`'s prediction: `tokens` (a `tokens(…)` quantity) caps committed model tokens (Pi's `totalTokens`: input, output and cache, including compaction/summary requests and tool-reported usage); `tools` caps admitted tool calls, every tool counted together (built-ins such as `read`, `edit`, `bash`, `send`, `task`, `yield` and custom/MCP tools alike). `0` denies all; an omitted cap is unlimited. `scope` sets the ledger lifetime: `"evaluation"` (default; one `run()` or `step()` call, so `drain()` resets per step), `"batch"` (one decision's column, shared by its nodes) or `"activation"` (one node prime/resume, not a whole agent run). Ledgers belong to the `limit(...)` instance: build it once with the policy; reusing one instance in two `separate` branches shares it, distinct instances never do, and two contexts never share counters. Nested limits all apply, outer first, and reach agents in nested graphs and the task subagents they admitted (charged to the ledgers of the activation that admitted them, even after it ends). Mixed `limit({ memory, tokens, tools })` keeps memory per column.
  ```ts
  schedules.limit({ tools: 100 }, schedules.parallel());
  schedules.limit({ tokens: tokens(20_000), scope: "batch" }, schedules.parallel());
  schedules.limit(
    { memory: gigabytes(4), tokens: tokens(100_000), tools: 500 },
    schedules.limit({ tools: 20, scope: "activation" }, schedules.parallel()),
  );
  ```
  A call counts once it reaches the tool's executor, even if it then fails or is cancelled; unknown tools, schema rejections and calls cancelled before execution do not count. A denied call never runs. A model request is refused once a token ledger is at its cap; a response that crosses the cap counts in full and fails its run, and no further request or tool effect starts. Responses already in flight in parallel peers still finish and count, so tokens can overshoot. The first hit fails the agent run and the graph call (no task retry or `on_error` recovery) with `graph.UsageLimitError` (`isUsageLimitError(error)`, `code: "JUNCO_USAGE_LIMIT_EXCEEDED"`): `details`/`toJSON()` give `resource`, `scope`, `limit`, `used` (before the hit), `requested` (`1` per call, the committed token delta, or `0` for a refused request), `attempted`, `exceededBy` and the `nodePath`.
- For deterministic resource scheduling, use `new MockAgent({ runs, usage: { memory: megabytes(3000), tokens: tokens(100) } })` and `new MockJuncoGraph(source, sink, ...)`. `usage` accepts finite non-negative memory/token quantities, independently of harness `resources`. `MockAgent.profiles` and exported `constantProfiles(usage)` return constant profiles; undeclared usage has no profile. `MockJuncoGraph` preserves explicit non-empty profiles, otherwise attaches a mock member's declared profiles or `NO_USAGE` (zero memory and tokens) for unprofiled nodes, including ports and coroutines. Declare every kind the policy uses on partially profiled members. A plain `JuncoGraph` remains unchanged: its unprofiled ports fail strict resource policies.
- Real YAML builds can declare per-node `profiles: { memory: "512 MB", runtime: "30 s", tokens: "4000 tok" }`, or load fitted `syntax.BuildOptions.profiles` keyed by node path; fitted records override that node's declarations. Profiled builds zero-cost ports and undeclared non-agent nodes, but still name agents missing the requested profile. `fromYaml` also forwards collection resource limits/monitoring. Kernel pipeline limits and planning estimates remain separate controls.
- `schedules.pi({ models, model, systemPrompt?, prompt?, streamOptions? })` is a stateless oracle using `models.completeSimple`: one request per current decision, no scheduler session, iterator, hidden conversation or default model. The last user message is `SchedulerSnapshot:\n` plus a `SchedulerRequest<C>` containing version, threads (`null` for unbounded), available-owned native node IDs/status/descriptions, their defined external metadata pairs and projected history. Native state, inputs and results are omitted; only the application's metadata must be JSON-serializable. Use `agent` for deliberate data-aware summaries.
- The only model tool is strict `schedule({ waves: string[][] })`. Later waves are speculative: stable-deduplicate and filter each to available owned IDs, execute the first non-empty wave, then recompute from a fresh snapshot. A ready node is only primed on first selection. Exactly one schedule call with `stopReason: "toolUse"` is required; malformed/extra keys, missing/multiple calls and provider failures reject before work. No retry, text-only settlement or fallback is invented.
- Every decision lowers to one native column. Malformed entries, strengths outside integer `0..4`, duplicate, unowned or unavailable selections, invalid reads, stale decisions and exceeded native capacity fail before activation/input consumption. Empty top-level selection with available work is an error; a branch may abstain beside a progressing sibling. History commits actual started node entries with their selected strengths after a column drains, even if work failed. Native execution drains admitted work before releasing its evaluation gate.

### Lifecycle: `JuncoGraph`

- Context drives enter the graph's generic `evaluate` scope before planning and observe `graph.signal`. Passing `{ signal }` also binds caller cancellation for that evaluation: recursively abort active resources, start no later work, and join the current provider/port/node work and cleanup. Already-aborted calls start nothing. Original cancellation wins; distinct concurrent cleanup failures are retained through existing aggregation.
- `abort(reason)` snapshots native membership recursively (graphs, agents and coroutines; shared/cyclic states once), starts resource cancellation, aborts each graph signal and joins resource operations plus active evaluations before replacing nonterminal controllers. A pending abort is joined; a closed graph rejects `closed`. Ports are deterministic work, not independent lifecycle resources.
- `close()` is terminal and cached, including failure. It aborts graph signals and joins active planning/execution and each agent/coroutine's async disposal before releasing collection holds. Results remain readable. Close and abort are stack-safe; internal cancellation cleanup never awaits its own evaluation gate. Contexts and policies own no resources and have no inverse graph binding.

### Context compaction: `JuncoGraph.compact`

- Every prompt agent reports `context_size()`, an estimate of its conversation's tokens, and `compact()`, which queues Pi's compaction after any admitted run. `JuncoGraph.compact(graph, policy)` (or `graph.compact(policy)`) applies it only to direct `JuncoAgent`/`MockAgent` states; nested graphs, coroutines and ports are skipped. It never executes work or consumes inputs/results. An unknown policy rejects with `invalid_argument` before inspection.
- `"all"` and `"more-than-forty"` consider every node, finished or unavailable included; `"all-available"` and `"more-than-forty-available"` take one `graph.available()` snapshot. Selection happens when `JuncoGraph.compact` is called; later readiness or topology changes do not alter it.
- Threshold policies read each candidate's `context_size()` and `getModel()` once and select members holding strictly more than 40% of their model's `contextWindow`. A member whose model or window is missing, non-finite or not positive rejects the compaction with `invalid_state` before any request is made.
- Each selected member gets one request, all dispatched without waiting for one another; every request finishes, and failures reject as one `AggregateError("Graph compaction failed")` in node order, keeping each member's original error — a member closed while its compaction is pending or accepted contributes its `closed` error. Successful members stay compacted.
- A member with an admitted run compacts only after that run ends; a held yield keeps its compaction pending. Keep driving the graph (or agency) while awaiting the compaction, or await it before driving an unstarted graph. While a member's compaction is pending, its new prompts and navigation are `busy` and its staged prompt waits, so a staged member can drop out of `available()` until then.

## Verification

`bun run test:unit` is the selected deterministic root suite, run by CI with agency-source coverage (`coverage/lcov.info`) through `bun run test:coverage`. Packages test their own implementation: engine graph/trigger/tracer/primitives; scheduler `test/scheduler.test.ts`, `test/scheduler-dsl.property.test.ts` (executable CSL authority laws with fast-check), and faux-only `test/agent.test.ts`; native agent/tool behavior in their packages. Root type fixtures cover typed observations, metadata, ports and context subtype preservation. Root mock-backed suites exercise both `roundRobin()` (window/thread 1) and `parallel()` (window 1/unbounded threads): native priming, all/any reads, batches, unseen-value fairness, nested sink-only completion, cancellation, resource ownership, shared/cyclic graphs and deep stack-safe traversal. Mock transcripts preserve agent admission, queue, yield, result, abort and close semantics without a provider. `bun run smoke` drives one real context per policy, then two `JuncoGraph.fromYaml` numeric scenarios (YAML text via `Bun.YAML.stringify` on Bun; the same parsed document on Node): two faux-backed agents passing `7` over a `{ type: number }` message route (a non-number `send` is a tool error against the advertised route schema; `recv` returns the raw number), and code nodes carrying `7` through a nested graph's source and sink. It closes every graph and prints:

```json
{"scheduler":"round-robin","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
{"scheduler":"parallel","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
{"scenario":"numeric-messaging","received":[7],"rejectedString":true,"closed":true}
{"scenario":"numeric-yaml-nesting","received":[7],"result":7,"closed":true}
```

The default suite also runs `test/compaction.test.ts`: each policy's selection over one real graph with available, trigger-blocked, availability-rejected and completed members; the strict 40% threshold; unknown policies and unknown context windows rejecting before any change; available-only policies never measuring unavailable members; invocation-time snapshots; a later member compacting while an earlier one is still yielded; and ordered failure aggregation. The native adapter's context sizing and deferred compaction are covered by `junco-agent`'s own suite.

`test/tui-payload.test.ts` (in the default suite) covers immediate safe payload snapshots with BigInts, cycles and long values without application getters or custom inspection. Ordinary runtime tests supply `DummyTracer` or a deliberate recording/custom observer, so a terminal never changes their backend.

The mock replays Agentic interactions; it does not simulate provider reasoning, native policy denial or tool execution. Those, and the Pi scheduler itself, are covered by separately runnable suites; CI runs `test:integration`, `test:native` and both workflow smokes, but not `smoke:pi`:

- `bun run test:integration` (offline, faux providers): stateless `pi` and candidate-only `SchedulerRequest<AgencyNodeMetadata>` with native descriptions, strict wave protocol, input fairness, nested contexts, 32-level recursive driving, pending-provider cancellation/drain, the OSS committee, mixed example and standard Ralph workflow. Ralph's native-agent checks cover three-round revision in one session, one round, native yields within a round, and a blank intermediate draft failing before the next round. Parser/build tests additionally cover assignment admission, default/invalid rounds and nested controller scope. Fan-in selector checks cover AllFanIn waiting for every candidate and failing on a blank one; AnyFanIn selecting before parents return, trigger-order admission, per-batch isolation (including a batch arriving mid-selection), duplicate publication, parking and native resumption, candidate/selection failures, and sibling levels beside AllFanIn and Ralph. Committee tests retain value-edge gating, failed-lookup partial handoff, normal/truncated/empty research, verdict guards, revision routing and scoped search metadata. These checks and tracer flush do not prove live GitHub access or provider entitlement.
- `bun run smoke:workflows` (after the agency build) runs `test/workflows.fixture.ts` under Node's TypeScript stripping against built public entrypoints; `bun run smoke:workflows:bun` uses source entrypoints. Both check a `new tools.YieldTool()` boundary: `turn_end` subscribers see its successful result before `JuncoAgent` suspends, only the next explicit `next()` resumes the run, and `return()` closes it terminally. Both then drive `JuncoGraph.fromYaml(workflows.ralph, config)` through three rounds, checks revision prompts and final-only sink publication, and print `{"mode":"until","rounds":3,"delivered":["draft-3"],"closed":true}`; then `workflows.allFanIn` selects one of two candidates and `workflows.anyFanIn` streams one selection per batch for two batches, printing `{"allFanIn":"best","anyFanIn":["x-complete","y-complete"],"closed":true}`.
- `bun run smoke:profile-optimizer` (after the agency build) runs `test/profile-optimizer.fixture.ts` against the built package: metric boundaries on canonical JSONL; batch mean/sample-SD statistics and the non-regressing one-SD promotion oracle; real child targets, recorders and code nodes with a faux-backed persistent editor converging a numeric scheduling target, a token/model-ladder target (including a usage-limit failure, a quality-infeasible cheaper model, rejected already-tried triplets and a failed then passing confirmation) and a cost/quality target (a hidden per-run constraint violation, quality-regressing and sub-SD candidates, one-SD cost and quality promotions); `scores.jsonl` rows checked against history, an append failure and stale score files; failed, receiptless, forged-nonce, metric-less and unmonitored-memory baselines; zero-baseline, maximize and run-budget stops; edit-tool rejections, external edits, graph-document drift, cancellation of a live child group and of an applied edit; the Node import boundary and the CLI's malformed-input exit. It prints `PROFILE_OPTIMIZER_CHECK_OK`. Its measurements come from faux providers and are not real-world savings.
- `bun run smoke:pi` runs the offline recursive Pi example, including its `Join` code node, with automatic tracing: interactive terminals show the TUI until dismissal; redirected runs stay silently untraced. After restoration it prints both branch results and the current root decision count.
- `bun run smoke:tui` is a credential-free real-terminal smoke using native agents with faux responses. With the production addon built, run it in an interactive terminal (`TERM=xterm-256color`, at least 100×30): observe Alpha then Beta in the active title, live full-height trace records, and the retained completed frame, then press `q`. It checks terminal restoration before printing `TUI_SMOKE_OK`; it needs neither a Btrfs mount nor model credentials.
- `bun run test:native` includes the real Linux PTY tests in `test/tui-tracer.test.ts` (automatic/explicit acquisition, one-pane activity and history navigation, live member and task traces, failure, dismissal, resizing, and terminal restoration) and `test/policy-yield.test.ts`, which uses junco-tools' real Marsh policy through the CopyTree native test addon (see Setup): denied `edit`, applying `ast_edit`, and `bash` calls pause in source order without publishing edits or starting a second model request until resumed. A failed native test is not evidence of a passing policy boundary, and the deterministic policy-reason scenario does not prove native enforcement.
- The build can be loaded under Node.js with `node --input-type=module -e 'await import("./dist/index.js")'`.
