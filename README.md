# junco-agency

Recursive agentic dataflow graphs. A `JuncoGraph` is a native [`dataflow-engine`](packages/dataflow-engine) graph whose node states are `Agentic`: a `JuncoAgent` ([`junco-agent`](packages/junco-agent)), a `MockAgent`, a nested `JuncoGraph`, or a `Deterministic` coroutine. Every kind registers through the engine's own `addNode` with the engine's one `NodeOptions` (`id`, `description`, `trigger`, `is_available`); the graph adds recursive abort/close over its members. `JuncoGraph.pi()` builds such a graph driven by a `PiScheduler` ([`junco-scheduler/agent`](packages/junco-scheduler)), whose model drives it through its only tool, `schedule`: one bounded graph window per call. Nesting needs neither flattening nor a forwarding object.

## Setup

Requirements: Linux x86-64 with glibc and Bun `1.4.2`. Package development additionally needs Node.js `>=22.19.0` (Node `dist` builds and smokes), and `junco-tools`' native addon needs Rust `1.95.0` plus native build libraries. This repository is a Bun workspace: the agency sits at the root and `packages/` holds `junco-tools`, `junco-agent`, `dataflow-engine` (with its `examples` workspace), `dataflow-engine-opik`, and `junco-scheduler`, each imported with its full Git history. Only `marsh` and `junco-policy` stay external: Cargo fetches them from the default branches of their public repositories ([`junco-org/marsh`](https://github.com/junco-org/marsh), [`junco-org/junco-policy`](https://github.com/junco-org/junco-policy)) when it builds junco-tools' native addon, so no sibling checkout is needed. The source example bundles below need no Rust. The tracer adapters are optional at runtime (see [Tracing](#tracing-local-only)).

To run the root `examples/`, install once from the root and let Bun bundle them from workspace sources; no package or declaration build comes first. When junco-tools' Rust toolchain is installed (see its [README](packages/junco-tools/README.md)), the root install's `postinstall` also builds the production native addon (`bun run build:native` in `packages/junco-tools`, which first moves `Cargo.lock` to marsh's and junco-policy's current GitHub HEAD; a failed build fails the install); without it, the install prints a notice and skips the addon, as does `--ignore-scripts`:

```sh
bun install --frozen-lockfile
bun run build:examples
bun --no-install examples/dist/recursive-agency.js
```

`build:examples` bundles `examples/recursive-agency.ts`, `mixed.ts`, `oss-committee.ts`, `mcp.ts`, and `yak-shaver.ts` (with shared chunks and external source maps) into `examples/dist/` for Bun. Every reachable workspace package resolves through its `bun` export to TypeScript source, so the tools → engine → agent → scheduler chain below is not a prerequisite. Five boundaries stay external and must be installed where the bundle runs: the generated `junco-tools/native` loader (loaded lazily, only when default native tools are created), `@oh-my-pi/pi-coding-agent`, and the three `@earendil-works` Pi packages (which locate their assets from their own install). The first three examples supply explicit tools, so they need no native addon (`mcp.ts` and `yak-shaver.ts` run MCP servers and native file tools on the native ShellMux); the recursive example is offline, while `mixed` and `oss-committee` still need their existing credentials and inputs.

`dataflow-engine`'s own examples follow the same contract: after the root install, `bun run examples` (or `examples:build`) in `packages/dataflow-engine` bundles them from workspace sources without any producer build; see its [README](packages/dataflow-engine/README.md#examples-and-development).

For package development (Node `dist` builds, declarations, and the native addon), build in dependency order (tools → engine → agent → scheduler → Opik adapter → agency):

```sh
bun install --frozen-lockfile
(cd packages/junco-tools && bun run build)
(cd packages/junco-mcp && bun run build)
(cd packages/dataflow-engine && bun run build)
(cd packages/junco-agent && bun run build)
(cd packages/junco-scheduler && bun run build)
(cd packages/dataflow-engine-opik && bun run build)
bun run typecheck
bun run build
bun run check
bun run test
bun run smoke
```

- One root `bun.lock` with the hoisted linker. Internal dependencies use `workspace:*`, so every package links to its `packages/` directory, a rebuild is visible to its consumers without reinstalling, and the engine and Pi peers each have one installed identity. The root `overrides` are the only version policy. The agent uses Pi `0.99.2`'s native `AgentHarness` adapter; no Pi patch or fork is installed.
- Bun `1.4.2`'s `bun update` may fail to resolve nested linked development/workspace paths; this does not invalidate a successful frozen-lockfile install. Use the checked-in lockfile for reproducible installs rather than editing consumers' dependencies to work around that update limitation.
- `bun run test:native` (root, `junco-mcp` and `junco-agent`) and junco-tools' Node suite additionally need junco-tools' CopyTree native test addon (`bun run build:native:test` in `packages/junco-tools`, loaded from `packages/junco-tools/target/native-test/index.js`). They run on CopyTree workspaces, not a Btrfs mount; only junco-tools' opt-in `bun run test:btrfs` needs Btrfs.
- `bun run check` runs Biome `2.5.15` (pinned at the root; `bun run check:ci` is the non-writing CI form) over one policy from the root `biome.json`: the agency's `src/` and `test/`, the whole `packages/dataflow-engine` (whose nested `biome.json` extends the root, so its own `check`/`check:ci` keep the same scope), the `src/` and `test/` of `junco-agent`, `junco-mcp` and `junco-scheduler`, junco-tools' `ts/` and `tests/`, and those packages' `package.json`/`tsconfig*.json`. Git-ignored and generated trees (`node_modules`, `dist`, `target`, `native`, `coverage`) and the `graft` graph are excluded; Rust stays with rustfmt and Clippy.

## Tracing (local only)

A direct `JuncoGraph` requires a tracer as its constructor's fourth argument (`TypeError` when missing), and its `tracer` property is never `undefined`. `JuncoGraph.parallel(policy)`, `JuncoGraph.spawn` and `JuncoGraph.pi` default to `tracer.TuiTracer.shared()`: one shared lazy TUI named `JuncoGraph.run` when stdin and stdout are TTYs and `TERM !== "dumb"`, otherwise a silent, stateless `DummyTracer`. Explicit Dummy, custom and Opik tracers always win. `parallel` and `spawn` remain synchronous; imports, factory construction and shared selection do not load native bindings, enter terminal modes, install handlers or write output. The first observer callback starts the lazy display.

For explicit acquisition, use `const tui = await tracer.TuiTracer.create("My workflow")` (the name is optional), then pass it to your graphs. It rejects unsuitable terminals before loading native bindings; native initialization failures surface rather than falling back to another backend. Only one session may own the terminal. The ratatui display has two vertically stacked panes: `JuncoGraph` above and live `Agent traces` below. Topology stays fixed across steps unless it changes; only currently executing scheduled nodes are green. Stable identity colors and scoped `[g<serial>:<NodeId>]` badges distinguish repeated local IDs in nested graphs. Agent messages, tool progress and lifecycle outcomes appear independently of `LOG_LEVEL`. Promoted task parents retain their agent identity: return records show outcomes and stop reasons, not another copy of streamed messages. Payloads are snapshotted without application getters or custom inspection and may contain sensitive data; retained display history is bounded, not a durable transcript.

Share one tracer across child graphs: Ralph and promoted task graphs inherit their parent's observer; separately constructed children must receive the same explicit tracer from their caller. Close all graphs before calling `await observer.flush()` once for the shared observer. TUI `flush()` draws the final state and waits for `q`/Esc before restoring the terminal; `q`/Esc can also dismiss early without cancelling computation. `await tui.close()` or async disposal restores without waiting for dismissal. Flushing or closing an unused lazy instance performs no terminal I/O. While the screen is owned, do not write directly to stdout/stderr; capture MCP stderr (`stderr: "pipe"`) and print final results only after restoration. Tab switches pane focus; arrows, PageUp/PageDown and Home/End pan or scroll, and End resumes trace tail-follow.

Operational logs still use `junco-tools/log`'s one process-wide [tslog](https://github.com/fullstack-build/tslog) logger. `LOG_LEVEL` (`SILLY`, `TRACE`, `DEBUG`, `INFO` — the default — `WARN`, `ERROR`, `FATAL`) is read once at startup; missing/blank means INFO, names are trimmed and case-insensitive, and unknown or numeric values fail before native or model work. `issueLog`'s complaint-observer failures use WARN. The logger receives every junco-policy capability decision of the ShellMux `ShellMuxLease.create` opens: violations at INFO (`junco-policy authorize: policy violated`, with principal, action, resource segments, failed precondition and allowed fixes) and, under `LOG_LEVEL=DEBUG`, tentative grants. While the TUI owns the terminal, admitted operational logs are redirected exclusively into its trace pane. Each mux's `lease.release()` (and so a collection's final release) drains these records; its `flushLog()` barrier waits for drawing, not keyboard dismissal. Outside the TUI that barrier flushes stdout.

`dataflow-engine-opik` is a workspace package and a root development dependency providing `OpikDataflowTracer`, so the root install already provides it and `opik`; under Bun its `bun` export loads its source directly. Pass it explicitly like any other tracer, configured by the SDK's `OPIK_*` variables:

```ts
import { OpikDataflowTracer } from "dataflow-engine-opik";
import { Opik } from "opik";

const tracer = new OpikDataflowTracer(new Opik(), "JuncoGraph.run");
```

## CI

`.github/workflows/ci.yml` runs on every push, pull request, and manual dispatch, with two independent jobs that each run one root `bun install --frozen-lockfile`:

- `core` needs no secrets. It installs with `--ignore-scripts`, so no native addon is built, and runs the root Biome check (`bun run check:ci`); then, before any package or native build, bundles the root examples from workspace sources (`bun run build:examples`), builds the engine's traced examples (`examples:build`, not executed) and runs its deterministic `--no-tracing` examples with their exact output, asserts after each that no package `dist`/`native`/`target` output appeared, and runs the copied root bundles in a temporary consumer that installs only the Pi vendor externals, without `opik` (the recursive example's successful exit with empty stderr, and the committee's usage rejection). It runs `junco-mcp`'s in-memory protocol suite from source, without the native addon. It then builds the engine, the scheduler's deterministic root (`build:core`, `typecheck:core` over that root with its scheduler suite and type fixture, then the scheduler suite), and the Opik adapter (build and typecheck); runs the engine's typecheck (Dummy) and `examples:typecheck` (Opik) against those declarations, and its tests with coverage (uploaded as the `coverage` artifact); packs the engine and scheduler into an isolated consumer without agent or Pi peers and runs the round-robin smoke under Bun and Node; and runs an offline Opik graph smoke through an in-memory Opik client.
- `test` needs no secrets either: Cargo fetches the public `marsh` and `junco-policy` from GitHub, and the root install's `postinstall` builds the production addon. It runs junco-tools' rustfmt, Clippy and Rust unit tests, builds its production and CopyTree test addons and runs its Node tests, then builds and tests tools → MCP (core and native suites) → engine → agent (including its native MCP suite) → scheduler (full `typecheck` and both suites) → Opik adapter → agency; the agent and scheduler suites run with coverage of their own `src/` (uploaded as the `junco-agent-coverage` and `junco-scheduler-coverage` artifacts). For the agency it runs build, typecheck (the built-package fixture needs the emitted declarations), the deterministic suites with coverage (uploaded as the `agency-coverage` artifact), the deterministic smoke, the offline integration suites, the native policy-yield suite (`bun run test:native`), and the `junco-agency/workflows` smoke under Bun (source entrypoints) and Node (built entrypoints), then checks that the workspace `junco-scheduler` and the agency share one `dataflow-engine` instance under Bun and Node, and runs the relocated `junco-agent` CLI launcher (`--version`).

No Btrfs mount, tracing service, language server, or model credentials are required: native suites run on CopyTree workspaces.

## Usage

```ts
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { TriggerRule } from "dataflow-engine";
import { JuncoAgent } from "junco-agent";
import { LockPolicy, YieldTool } from "junco-tools";
import { JuncoGraph } from "junco-agency";

// Resolve models beforehand; each supplied session transfers to its agent and closes on return().
const sessions = new MemorySessionRepo();
const researcher = await JuncoAgent.fromResolved({
  ...researcherOptions, session: await sessions.create({}, BACKGROUND_CONTEXT),
  tools: [new YieldTool()], prompt: "Find the facts.",
});
const writer = await JuncoAgent.fromResolved({
  ...writerOptions, session: await sessions.create({}, BACKGROUND_CONTEXT), prompt: "Draft the summary.",
});
// With a native `model` the scheduler uses it; without one it is GitHub Copilot `claude-opus-5.5`
// through Pi's saved login (run Pi's /login first). Tracer defaults to TuiTracer.shared(),
// window and threads to UNBOUNDED.
await using graph = await JuncoGraph.pi({
  ...schedulerOptions, session: await sessions.create({}, BACKGROUND_CONTEXT),
  systemPrompt: "Coordinate the team.", prompt: "Produce the report.", policy: LockPolicy,
}); // disposal closes every member
const scheduler = graph.scheduler;
// Event subscribers must not print directly while the TUI owns the terminal.
// scheduler.hooks.on("transform_context", handler) registers native request hooks.
// Invalid local arguments/state and overlapping work reject with JuncoAgentError.
for (const [agent, description] of [[researcher, "researches"], [writer, "writes"]] as const) {
  graph.addNode({ state: agent, description, policy: LockPolicy, trigger: TriggerRule.always() }); // runs its constructor prompt
}

let outcome: unknown;
try {
  for await (const step of scheduler) {
    if (step.kind === "yield") continue; // one graph window completed; the next iteration resumes
    outcome = step.kind === "settled" ? step.message : step.error;
    break;
  }
} finally {
  try { await graph.close(); } finally { await graph.tracer.flush(); }
}
console.log(outcome); // the terminal has been restored
// Leaving scope closes the graph: its scheduler and agents, with their sessions.
// The caller owns the repo and closes it afterwards with sessions.close(BACKGROUND_CONTEXT).
```

[`examples/recursive-agency.ts`](examples/recursive-agency.ts) runs a root → child → grandchild agency around a leaf that pauses once, plus a root sibling, entirely offline on faux models. Each scheduler reports only its own completion; the leaf and sibling results are read from the retained graphs.

All five example CLIs handle Ctrl-C with a scoped `AbortSignal`: cancellation interrupts active agents, nested graphs and cooperative coroutines, joins cleanup, and exits with status 130. Importing an example installs no signal handler. Setup awaits without cancellation support finish before the next signal check; bodies that ignore cancellation must still drain.

### OSS committee (live)

[`examples/oss-committee.ts`](examples/oss-committee.ts) is a literate, top-to-bottom junco example and **not** a `PiScheduler` agency: three persistent `JuncoAgent` members run review rounds, each a fresh `JuncoGraph.parallel(LockPolicy)` graph over the same members, whose sessions keep every earlier round. The Librarian (`claude-opus-5.5`, medium reasoning) uses `search_oss` with generic technical terms rather than the verbatim request; each result reports GitHub stars and last push time alongside the repository URL and reported license. The Architect (`gpt-6-sol`, high) is toolless and designs from the available research; the Reducer (`claude-sonnet-5.5`, xhigh) combines both final reports, records a typed verdict with its `review` tool and produces the **only** titled Markdown plan. A revision request starts another round in which the Librarian continues investigating and the Architect revises its design from the Reducer's feedback; approval — minimal, clean custom code over well-trusted OSS libraries — publishes the plan. There is no round limit, and a round that ends without a verdict fails without publishing. Normally, a value edge gates Architect on a valid successful lookup and a nonempty, normally stopped Librarian report. After a failed lookup in any round, Librarian must call the real `yield` tool with its available public research, the failure and the remaining gaps in the reason. A message edge hands that partial snapshot to Architect while Librarian stays paused. Librarian resumes only after Architect returns, then writes its closing report without further searches. Reducer still waits for both final reports; missing, empty or truncated final reports cannot publish a plan. Returning after a failed lookup without the required yield is rejected rather than silently accepted. `JuncoAgent.create` rejects a reasoning level a model does not support, so no reasoning level is silently downgraded.

Before running the live example, start `pi`, use `/login`, and select GitHub Copilot. The committee shares Pi's `ModelRuntime` and uses the saved login in `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`); Pi handles OAuth refresh. A missing or unusable login fails with instructions to run `/login`, without starting an interactive login or publishing a plan. Environment-only tokens and Copilot CLI credentials do not replace the saved Pi login.

```sh
bun run examples/oss-committee.ts ./request.txt ./plan.md
```

The first argument is a nonblank UTF-8 request file; the optional output defaults to `plan.md` in the current working directory. Existing outputs are rejected before credentials are read, and publication uses exclusive creation (`wx`): a failed/aborted run or concurrent writer cannot overwrite a plan. Each member's exact model ID **and** reasoning level must be in the installed Copilot catalog before its saved login is checked; per-account model access can still fail, with no plan published. Each GitHub lookup returns at most five repository URLs and GitHub-reported metadata, not a bound on the number of requests. The search fetch is unauthenticated; Pi's saved Copilot login authenticates the model runtime, not GitHub repository search. Yield is a scheduling handoff, not an HTTP retry or a quota increase. `incomplete_results=true` means partial research, a valid empty result is reported as no matching library, and a failed lookup remains disclosed as unavailable research. A missing/`NOASSERTION` SPDX identifier means unknown license. GitHub-reported SPDX identifiers, stars and push times do not verify full license terms or quality; versions and API compatibility are likewise unverified. Never place secrets, private identifiers, or private endpoints in a GitHub query or the request/reports exported to a tracer. `convene` flushes the rounds' shared automatic tracer once, and all members close, **before** the approved titled plan is written. In an interactive terminal, dismiss the final TUI with `q`/Esc before publication; redirected execution uses Dummy and emits no trace output. When you explicitly supply Opik, inspect each review round's three node results and activation spans in its project → Logs → Traces; successful `flush()` alone does not prove remote ingestion.

The tool restricts search to GitHub repositories but cannot detect secrets in a model-generated query. Submit only requests safe for public GitHub search and complete tracer export; prompt instructions alone do not enforce that boundary.

### MCP graph (live)

[`examples/mcp.ts`](examples/mcp.ts) runs exactly two `github-copilot/claude-sonnet-5.5` agents on this repository, each with only the tools of its own graft MCP server (`mcp.JuncoMcpTools`, `npx -y @nanonets/graft mcp`). Research maps the repository and selects five central classes; Dependencies receives that report on a value edge and traces all five itself with outbound all-depth `graft_trace_calls`. Both servers run as audited jobs of one `LockPolicy` collection's ShellMux, created by `JuncoGraph.create` and passed to both agents, so the repository must be inside a Btrfs seed with the production native addon built, and graft's index must be current (`graft build`): graft refreshes the index before a query only when the working tree drifted from the last build, so over a current index its queries write nothing, while two servers refreshing a stale shared index would overlap and Marsh refuses the later publication. The runner closes the graph, whose final collection release closes the mux, then flushes the tracer.

```sh
bun run examples/mcp.ts
```

For a scripted end-to-end run without model credentials, run `bun run test/oss-committee.fixture.ts`. The fixture prints the approved plan of one scripted round. It and `bun test test/oss-committee.test.ts` choose an explicit `DummyTracer`, keeping offline output deterministic even in a terminal.

### Yak shaver: in-place refactoring (live)

[`examples/yak-shaver.ts`](examples/yak-shaver.ts) applies generalizing refactors in place to a Graft-indexed Git working tree and releases each changed file; it writes no report and never commits. It is one literate file, read top to bottom in numbered sections. `runYakShaver` first runs `graft build .` through the trusted tool collection's sandboxed `bash` tool so every run starts from a current index. It then ranks every indexed `class`, `interface`, `type`, `enum`, `struct`, and `trait` (merged with its owned methods) by its longest dependency distance, in strongly-connected-component hops, from the public API (exported AST-origin symbols) or a test path, deepest first and then by ascending positive distinct-caller count; nothing is cut off. `refactorCandidates` admits four initially ranked candidates at a time, resolved against the current snapshot (a candidate removed by an earlier refactor is reported `removed`). Each batch is one parallel graph of `Proposer:r ==proposal:r==> Judge:r` lanes driven one step at a time; every proposer's native `task` call spawns up to three read-only researchers over far-first file shards, and an independent judge, whose staged prompt callback validates the proposal and composes its assignment, records four criteria. As soon as a lane's review passes all four criteria, adds a caller definition, and removes net nonblank lines, its edits are applied and exactly its paths released (`release -- <path>`) inside one managed command, so the lane's owner releases its own files; applications drain one at a time. After a batch that applied anything, a private, discarded `graft build` refreshes the in-memory snapshot. Every Graft MCP connection is discard-only and lives for one call.

Prerequisites: `graft` 0.21.1-compatible on `PATH`, the production native addon, the Git working-tree root inside a Btrfs seed, and the Copilot login. A later failure keeps earlier applied and released refactors and says so. `bun test test/yak-shaver.test.ts` exercises ranking, evidence checks, gates, admission, and real four-lane batch graphs with incremental application offline on faux models.

```sh
bun run examples/yak-shaver.ts /path/to/repo
```

### Verus loop (live)

[`examples/verus.ts`](examples/verus.ts) runs persistent Verifier → Reviewer → Cleanup rounds until cancellation. All three agents receive every tool from the `verus` stdio entry in `~/.omp/agent/mcp.json`: code queries, diagnostics, and supported LSP mutations. There are no local Rust parsers, direct Verus/Cargo commands, or separate file/grep tools. The Reviewer must obtain its own MCP diagnostics each round; successful diagnostics do not terminate the loop or establish whole-project proof coverage.

```sh
bun run examples/verus.ts /path/to/source /path/to/new-output 'Natural-language specification'
```

Requires the native junco-tools addon, output inside a Btrfs seed, the configured lsp-mcp bridge/Verus analyzer, and a saved Pi Copilot login for `github-copilot/gpt-6.1-sol` with high thinking. Source is mirrored into a new/empty output directory. The bridge's `.lsp-mcp.json` is copied from its configured cwd into a private temporary directory inside output, avoiding ShellMux's external-cwd restriction; that directory and all agents are disposed on exit, while output is retained.

Output-only mutation and Reviewer read-only behavior are role instructions, not filesystem enforcement: every role has the full MCP tool set. The bridge can apply offered code actions, rename, and formatting, but exposes no arbitrary file-write API; unsupported translation/proof edits must be reported rather than claimed as applied. Empty LSP diagnostics are not evidence that the verifier ran. `bun test test/verus.test.ts` covers round ordering, independent review, feedback, cancellation, MCP failures, and source-copy isolation.

## API

```ts
type AgenticInput =
  | { readonly kind: "prompt" | "steer" | "followUp" | "nextTurn" | "error"; readonly text: string; readonly images?: ImageContent[] } // error: a failure notification, delivered as a follow-up
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };
// The four node-state kinds; N/T default to the chat wire types and stay overridable.
type Agentic<N = AgenticInput, T = AssistantMessage> = JuncoAgent | JuncoGraph<N, T> | MockAgent | Deterministic<N, T>;
// A raw spec with `step` (plus required `policy`); or a step-less spec whose state is a Deterministic
// or a nested JuncoGraph (with `result`, `receive?`, `afterStep?`), authorized by its state's own
// `policy` and so taking none (a supplied own `policy` field, even a matching or `undefined` one,
// throws `TypeError`), or (chat wires only) a JuncoAgent | MockAgent with required `policy`; each
// with an optional receiver `contract?: (edgeId) => Contract`. `StepLess` is implementation-local:
// `Omit<NodeSpec<Agentic<N, T>, N, T>, "state" | "step">`. Only the nested branch may carry
// `result`/`receive`/`afterStep`.
type AgenticNode<N = AgenticInput, T = AssistantMessage> = (
  | (NodeSpec<Agentic<N, T>, N, T> & { readonly policy: ToolCollection["policy"] })
  | (StepLess<N, T> & { readonly state: Deterministic<N, T>; readonly step?: never; readonly policy?: never })
  | (StepLess<N, T> & { readonly state: JuncoGraph<N, T>; readonly step?: never; readonly policy?: never; readonly result: NodeIdType;
      readonly receive?: (view: ParentView<N, T>) => void | Promise<void>; readonly afterStep?: () => void | Promise<void> })
  | (StepLess<N, T> & { readonly state: JuncoAgent | MockAgent; readonly step?: never; readonly policy: ToolCollection["policy"] }) // chat wires only
) & { readonly contract?: (edgeId: EdgeIdType) => Contract };

// addNode/addEdge, inspection and results are DataflowGraph's. `tracer` is required; pass
// `tracer.TuiTracer.shared()` for the automatic interactive/Dummy selection (see Tracing).
class JuncoGraph<N = AgenticInput, T = AssistantMessage, EH = unknown, Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>>
  extends DataflowGraph<Agentic<N, T>, N, T, EH, Q> {
  // policy: a junco-tools `Policy` (compared by identity); a supplied collection must have it and is borrowed until close.
  constructor(scheduler: Q, window: Width, threads: Width, tracer: DataflowTracer, policy: ToolCollection["policy"], collection?: ToolCollection); // TypeError without a tracer
  // Creates one collection, passes it to `build` (which must hand it to every member), checks every
  // member's collection, and gives the returned root graph the creator hold.
  static create<N, T, EH, Q extends DataflowScheduler<N, T>>(cwd: string, options: ToolCollectionOptions,
    build: (collection: ToolCollection) => JuncoGraph<N, T, EH, Q> | Promise<JuncoGraph<N, T, EH, Q>>): Promise<JuncoGraph<N, T, EH, Q>>;
  // Every available node runs in each window: junco-scheduler's ParallelScheduler, Width.create(1), UNBOUNDED.
  static parallel<N = AgenticInput, T = AssistantMessage>(
    policy: ToolCollection["policy"], tracer: DataflowTracer = TuiTracer.shared(), collection?: ToolCollection,
  ): JuncoGraph<N, T>;
  // A JuncoGraph.parallel graph under the root's registration policy (a managed root's state policy,
  // else the spec's) holding `root` plus one child per input, built by `child` in
  // order and wired by appendChildren. Construction only wires queues: members send and consume
  // messages through their own triggers and yields. Ids are the ones `addNode` returns.
  // Factory/registration errors propagate synchronously; already-created members stay caller-owned.
  static spawn<Input, N = AgenticInput, T = AssistantMessage>(
    root: AgenticNode<N, T>, inputs: readonly Input[], child: (input: Input) => AgenticNode<N, T>,
    tracer: DataflowTracer = TuiTracer.shared(),
  ): JuncoGraph<N, T>;
  // A model-driven graph; drive it through `graph.scheduler`. PiScheduler, PiSchedulerOptions,
  // SchedulerInfo and ScheduleTool come from "junco-scheduler/agent"; the agency supplies the
  // scheduler's adapter itself. A defined `model` selects PiScheduler.make (requiring model, models
  // and session); otherwise PiScheduler.opus selects Copilot Opus 5.5. `tracer` defaults to
  // TuiTracer.shared(), `window`/`threads` to UNBOUNDED; the graph is assigned before this resolves.
  static pi<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate, N = AgenticInput, T = AssistantMessage>(
    options: Omit<PiSchedulerOptions<N, T, S, P>, "adapter"> & {
      readonly policy: ToolCollection["policy"];
      readonly tracer?: DataflowTracer;
      readonly window?: Width;
      readonly threads?: Width;
    },
  ): Promise<JuncoGraph<N, T, unknown, PiScheduler<N, T, S, P>>>;
  // await JuncoGraph.compact(graph, "more-than-forty-available"), or graph.compact(policy).
  static compact<A extends Agentic<N, T>, N, T, EH, Q extends DataflowScheduler<N, T>>(
    graph: DataflowGraph<A, N, T, EH, Q>, policy: CompactionPolicy,
  ): Promise<void>;
  compact(policy: CompactionPolicy): Promise<void>;
  // One child per input under the registered `rootId`, each with two fresh message edges,
  // `${rootId}->${childId}` and `${childId}->${rootId}`; children are never linked.
  appendChildren<Input>(rootId: NodeId, inputs: readonly Input[], child: (input: Input) => AgenticNode<N, T>): void;
  readonly policy: ToolCollection["policy"];
  readonly collection: ToolCollection | undefined;
  readonly tracer: DataflowTracer;
  get signal(): AbortSignal;                 // step()/run() observe it automatically
  abort(reason?: unknown): Promise<void>;    // recursive; a fresh signal once settled
  close(): Promise<void>;                    // recursive and terminal; cached
  [Symbol.asyncDispose](): Promise<void>;    // close()
}

// NodeOptions<N, T> = { id?, description?, trigger, is_available? } comes from "dataflow-engine".
// Prompt agents register directly: graph.addNode({ ...options, policy, state: agent }) — a step-less spec whose
// state is a JuncoAgent or MockAgent (chat wires only). Each addNode builds its own driver; its receiver
// contract is options.contract ?? agent.contract(edgeId). Raw { state, step, policy } specs register unchanged;
// a step-less spec with any other state throws TypeError. A step-less { ...options, state: coroutine }
// runs a Deterministic as its own body; { ...options, state: childGraph, result, receive?, afterStep?, contract? }
// nests a graph (missing `result` throws TypeError; an unknown `result` id DataflowDefinitionError). Both
// run under their state's own policy and take none (a supplied own `policy` field throws TypeError).
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

Every kind registers with the engine's own `NodeOptions`; a nested graph's execution-only fields (`result`, `receive`, `afterStep`) drive its node and never become node state; a prompt lives on its agent. An explicit `options.is_available` replaces a helper's default availability exactly like a native `NodeSpec` hook. `description` is optional for every kind and stays on the native node (`graph.getNode(id).description`). Node state is the original instance, except for a registered agent that called `task` (below): narrow `graph.getNode(id)!.state` with `instanceof` before using kind-specific methods.

**Subagents.** A `JuncoAgent` registered as a node can call the `task` tool (`new tools.TaskTool()`, included in `JuncoAgent.create`'s default tools). The call acquires one fresh subagent per task through `createSubagents` (inheriting the caller's model, active tools and registered MCP definitions unless the task narrows them) and returns their handles immediately; the caller's run continues. The children start when the caller next calls `yield` (or hits a policy pause) or finishes its current run, so a caller that needs their reports before continuing calls `yield`. A workflow that owns the assignments calls `agent.setTaskBatch(input)` instead: the model then launches that stored batch with `task({})`, at most once per agent (a rejected admission may be retried; a second launch fails with `Task batch already admitted; wait for its results.`). At that pause or settlement the node's `state` becomes a `JuncoGraph.spawn` graph whose `"root"` node is the same running caller and whose children (node id = handle id for the first attempt, `<id>:attempt:<n>` for retries; `description` = task name) run the subagents; the node keeps its id, trigger, edges, retained inbox, original `send`/`info` routes and seen values, and steps that graph once per activation. Each child starts from its bound task prompt and sends one final report, `{"type":"task_result","id","name"?,"attempt","status":"completed"|"failed","output","stopReason","error"?,"decisionRequired"?}`, back on `<node>->root`, always carrying the stable logical `id`; the caller receives each delivered report as a follow-up while it keeps working, and is prompted again (`Process the queued task reports.`) if it already answered. Once every task of a launch is completed or ignored, the caller receives one `{"type":"task_batch_complete","ids":[...]}` follow-up (original IDs, admission order), which also wakes it when every task was ignored. The node returns the caller's answer only after every delivered report and marker entered its context and was answered. Later task calls add siblings under the same root; a child's own task call nests a spawn graph in that child's node. Close and abort reach every member through the graph cascade.

**Task failures.** A child fails when it settles with a stop reason other than `stop` (its real output is kept) or its run throws (a failed native boundary, a hook error; recovered through the engine's `on_error` hook). Either way its subagent, or the spawn graph it expanded into, is disposed exactly once before anything else happens; a teardown failure is not reportable work but an `AggregateError` (the failure, then the teardown failure) that fails the graph, even under `"ignore"`. Cancellation of the owning graph propagates and is never retried or ignored. The caller's `setTaskFailurePolicy` (snapshotted per admitted task, default `{ retries: 0 }`) then decides: `"ignore"` drops the failure silently (no report reaches the caller); `{ retries: n }` reruns only that task in a fresh child with its original prompt, model and tool subset up to `n` times without telling the caller (an allocation failure also uses a retry), then delivers the failed report with `decisionRequired: true`. The caller answers with `task({ action: "retry" | "ignore", id, attempt })`: retry runs one more attempt under the same handle (started like any task, at the caller's next `yield` or settlement) and asks again if it fails; ignore returns `Ignored task <id>.`. Neither pauses. Unknown, stale or repeated decisions are ordinary tool errors. A caller that settles while a delivered question is unanswered fails with `Task failure decisions required: <ids>`. Ordinary registered agents have no such hook: a thrown failure still rejects the drive.

**Complaints.** Every `JuncoAgent` has an always-on `complain` tool (see `junco-agent`). While a graph drives a registered agent, a complaint is recorded in the shared `tools.issueLog` (also `graph.issueLog` and `agent.issueLog`, all the same object) with that node's ID, the messages delivered to the current activation (`{ id: edge, payload }`, in edge order), the full model request and the complaint, and is reported to `tracer.complain(nodeId, complaint)` of the graph the node was registered in. After a task expansion the caller's complaints use its spawn graph's `"root"` node and tracer; each child uses its task handle ID. `MockAgent.complain(issue, tracer?)` appends a supplied issue to the same log.

### Standard library namespaces

The root entry also re-exports the standard library for building junco workflows as namespaces, beside the flat agency exports above:

| Namespace | Contents | Source |
|---|---|---|
| `graph` | `DataflowGraph`, `JuncoGraph` (with `JuncoGraph.parallel`, `JuncoGraph.spawn`, `JuncoGraph.pi`, `JuncoGraph.compact`), edges (`Edge.message`, `Edge.value`, `Message.create`, `from`), `NodeId`/`EdgeId`, `Width`/`UNBOUNDED`, `Queue` (`Queue.from`, `Queue.empty`), `renderPretty`, the definition/node errors, and the node/edge types | `dataflow-engine`, this package |
| `graph.nodes` | Node constructors: `ConstFanout`, `ConstFanin`, `StepNode`, `EmitOnce`, `Deterministic`, and the `Agentic`/`AgenticInput`/`AgenticNode`/`CompactionPolicy` types | `dataflow-engine`, this package |
| `trigger` (also `graph.trigger`) | `TriggerRule`, `TriggerEntry` and `TriggerKind` (`"all"` or `"any"`); rules `TriggerRule.allOf(...)`, `TriggerRule.anyOf(...)`, `TriggerRule.when(edge)`, `TriggerRule.always()`, `TriggerRule.never()`; entries `TriggerEntry.on(edge)`, typed by their edge's message and result payloads; `evaluateTrigger`, `satisfiedEdges` | `dataflow-engine` |
| `agent` | `JuncoAgent`, `JuncoAgentError`, `TaskPolicy`, `TaskFailurePolicy`, `SubagentObserver`, and the `Agentic` protocol types | `junco-agent` |
| `tools` | Everything `junco-tools` exports: `ToolCollection`, `LspTool`, the native tool classes' `create` factories (`ReadTool.create`, `BashTool.create`, …), `YieldTool`/`isYieldTool`, the graph messaging tools `new RecvTool()`/`new SendTool()`/`new InfoTool()` (each class with static `.is`/`.invoke`) and their edge `Contract`, `TaskTool`/`AssignedTaskTool`/`isTaskTool`/`isAssignedTaskTool`/`invokeTaskTool` with the `TaskInput`/`TaskDecision`/`TaskRequest`/`TaskCall` contracts, the always-on `ComplainTool`/`isComplainTool`/`invokeComplainTool` with the shared `issueLog` and its `Issue`/`Prompt` types, ShellMux operations (`ShellMuxOperations`, `ShellMuxLease`), the Marsh policy-denial check, and the type-only `NativeModule`, `NativeMux` and `EditStore` contracts | `junco-tools` |
| `schedulers` | `Scheduler`, `ParallelScheduler`, `RoundRobinScheduler` (both extend `Scheduler`), `PiScheduler`, the `DataflowScheduler` contract and its schedule types, `triggerInputs` (a model-driven agency graph is `graph.JuncoGraph.pi`) | `junco-scheduler`, `dataflow-engine` |
| `tracer` | `DataflowTracer`, `DataflowRunTrace`, `DataflowStepTrace`, the no-op `DummyTracer`, and `TuiTracer` (`shared()` selects the lazy interactive default or Dummy; `await create(name?)` explicitly acquires a TUI) | `dataflow-engine`, this package |

```ts
import { graph, schedulers, tracer, trigger } from "junco-agency";

const g = new graph.DataflowGraph(new schedulers.ParallelScheduler(), graph.Width.create(1), graph.UNBOUNDED, new tracer.DummyTracer());
const a = graph.Edge.message<number, string>("a");
const source = g.addNode(new graph.nodes.ConstFanout(7, [a], { state: undefined, ret: "sent" }));
const sink = g.addNode(new graph.nodes.StepNode(() => [], { state: undefined, trigger: trigger.TriggerRule.allOf(trigger.TriggerEntry.on(a)) }));
g.addEdge(source, sink, a);
```

A generic `DataflowGraph`'s tracer stays optional: pass a `tracer.DataflowTracer` (for example `OpikDataflowTracer` from the `dataflow-engine-opik` workspace package, or `tracer.TuiTracer.shared()`) as its fourth argument, or omit it to run untraced. A `JuncoGraph` always takes one (see [Tracing](#tracing-local-only)). The Opik adapter is not re-exported; this package does not depend on `dataflow-engine-opik` or `opik`.

### Prompt agents: `graph.addNode({ ...options, state: agent })`

- A node drives its member through **one** run. The body first yields nothing, so the engine's priming consumes no input. Each later activation appends the delivered message batches (per edge, FIFO) and the parent results it has not seen before (each presented once) to the node's retained inbox. Payloads are data, never native commands: the model reads and drains the inbox with `recv`, sends on this node's outgoing message edges with `send` (by edge id), and discovers its parents, children, edge kinds and each receiver's `Contract.expect` with `info`. On its first activation a `ready` member starts its staged prompt (`JuncoAgent.create`/`fromResolved({ prompt })` or `agent.stagePrompt(prompt, { images? })`); a prompt callback `(inputs: ParentView<AgenticInput, AssistantMessage>) => string` runs once, synchronously, reading the node's retained inbox without draining it, and may throw to reject invalid inputs. Each activation calls `agent.next(inbox)` exactly once: a `yield` step leaves the member paused, a settled step returns the member's native final message (including `error`/`aborted` stop reasons) as the node's result, and a failed step fails the node with the original error. Only `yield` and a Marsh policy denial pause a run.
- Before its run starts, a member is available only when its trigger fires and it has a staged prompt (status `ready`) or fresh input; fresh input alone is retained and the idle member stays quiescent until a prompt starts it. A constructor prompt is one-shot: stage the next round's prompt with `stagePrompt` (it throws `busy` if one is already staged). A prompt callback that throws fails the node with the identical error. A member iterator that ends before its run settles (the member was closed) fails the node with `closed`. Once started, a member stays available until its run settles, even if its trigger was drained.
- A validated handoff that must build the consumer's assignment uses a prompt callback that reads `inputs.messages`/`inputs.values`, throws on invalid data and returns the assignment (`examples/mixed.ts`'s Reviewer, `examples/mcp.ts`'s Dependencies, the OSS committee's Architect and Reducer, the yak shaver's judges). The consumer needs no `recv`, and its registration's `contract` describes each incoming edge.
- One member can run in successive graphs, staged before each later registration with `stagePrompt`; its session keeps every earlier run.
- A finished node keeps its agent alive and usable until a graph containing it closes.

### Nested graphs: `{ ...options, state: child, result }`

- The node's state is the child graph itself. Its body first yields nothing; every later activation calls `receive` with the delivered batch and only unseen parent results, then advances the child once: a policy-scheduled child takes one `child.step()`, a `PiScheduler` child one `scheduler.next()`. After each successful advance `afterStep` runs, then the node completes with `child.result(result)` once a policy child is quiescent, or once a Pi child settled with stop reason `stop` and nothing available; otherwise it yields nothing and stays resumable. A selected `undefined` is a real result.
- `result` is required (`TypeError` otherwise) and must name a registered child node (`DataflowDefinitionError` otherwise). A quiescent child without that result fails with `invalid_state`; so do an idle Pi scheduler without a staged prompt (unless it already settled with the result retained), a non-`stop` settlement, and a normal settlement with graph work still available. A closed scheduler fails with `closed`. Cancellation through the child's signal wins over any result. By default the node is available once started or whenever its trigger fires.
- A nested node has no return-only message output. To send messages on its parent's outgoing edges, call the parent's inherited `graph.emit(nestedNodeId, Message.create(edge, payload))` from `afterStep`; on the completing activation the messages are queued before the node's result is published, in the same parent step. The Ralph workflow sends only its final round this way.

### Workflows: `junco-agency/workflows`

- `Ralph.register(parent, agent, { id?, description?, policy, input, output, rounds? })` registers one node in `parent` and returns its id. The node's state is a nested one-worker `JuncoGraph` whose worker's state is the supplied native `JuncoAgent`, so closing `parent` closes both. `input` and `output` are caller-owned message edges; wire them to the returned id before driving, and read the final `AssistantMessage` with `parent.result(id)`. Registration makes no model request; omitted ids are engine-generated, so several workflows coexist in one parent.
- `rounds` defaults to `2` and must be a positive safe integer; anything else throws `RangeError` before anything is registered. The first round prompts the exact assignment; every later round prompts the assignment plus the immediately preceding complete draft, in the same session. Native yields resume within a round and never count as one.
- The node expects exactly one text `prompt` on `input` (no images); a second assignment, any other input kind, or a nonempty `images` array fails the node. Each round must settle with stop reason `stop` and nonempty text; otherwise the node fails and nothing is published. A non-idle agent fails with `invalid_state`; cancellation through the nested graph's signal wins.
- Only the final round's trimmed text is emitted, once, as `{ kind: "prompt", text }` on `output`, in the same parent step that publishes the node's result. `examples/mixed.ts` uses it with `rounds: 2`.
- The agent is lent exclusively to the workflow while it runs: do not drive or reconfigure it concurrently.

### Coroutines: `Deterministic` and `{ ...options, state: coroutine }`

- `new Deterministic(body, policy, collection?)` invokes `body(signal, collection)` once; the generator speaks the engine's own protocol (dependent bodies start with `let view = yield []`, sources may emit immediately) and its closure holds any state. `step()` hands the coroutine to one consumer only; a second registration or a direct advance before it fails with `invalid_state`, and advancing a finished coroutine fails with `invalid_state`.
- `abort(reason)` aborts `signal` and joins the advance in flight; a rejection with exactly that reason is cancellation. `close()` (and async disposal) is cached: it signals pending work, joins it, then drains the generator through `return()`, discarding cleanup batches; later advances reject with `closed`, and an advance in flight when close began rejects with the signal's reason rather than publishing cleanup output. A sole cleanup error rejects as itself, several as `AggregateError("Deterministic close failed")`. Bodies that ignore their signal cannot be preempted.

### Scheduling: `JuncoGraph.pi`

- The scheduler is `junco-scheduler`'s `PiScheduler`: `PiScheduler.make` when a native `model` is given, otherwise `PiScheduler.opus` (GitHub Copilot `claude-opus-5.5` through Pi's saved login; a missing model or login fails with `JuncoAgentError`, without fallback). Both factories take the same `PiSchedulerOptions` (whose `prompt` is string-only): `make` rejects with `invalid_argument` unless `model`, `models` and `session` are all given, while `opus` ignores a supplied `model` and checks saved logins only on a model collection that can list them (a bare native collection fails its login check). Its only tool is `schedule({ lanes })`, frozen with its schema; `setTools` and `setActiveTools` accept nothing else. Its instructions are appended to the caller's `systemPrompt` (a callback keeps native `this` and context).
- Every request ends with a transient `SchedulerInfo:` user message, never persisted or emitted: the window/thread bounds and only the currently available nodes, each with its node status and `details` — its native `description` when present, plus a prompt agent's status and latest pause reasons. Unavailable or finished nodes, results and edges are never shown; a node's absence, or a quiescent snapshot, proves neither completion nor any output. The graph's owner reads node results with `graph.result(id)`.
- `JuncoGraph.pi` assigns the graph before it resolves, so the scheduler always reads its own graph; its adapter still rejects a snapshot, run admission or window with `invalid_state`, before any provider call, if the graph is missing. Nodes and edges may be added at any time; there is no topology snapshot.
- Lanes run concurrently; position `k` of every lane forms column `k`, which starts after column `k - 1` finishes. A ready member's first occurrence only primes it. Only ids available when the window starts may be planned, within `threads` lanes and `window` columns; the engine validates the whole plan before anything runs, and later columns skip members that finished or went idle. Reads follow each member's trigger: `allOf` reads everything or nothing, and `anyOf` prefers an input over an already delivered parent result.
- Each successful call runs exactly one graph window and returns a fresh `SchedulerInfo`; the scheduler's run continues, so consecutive `schedule` turns drive successive windows within one `next()`. More than one `schedule` call in a response rejects all of them before any graph work; invalid plans and nonempty plans with nothing available are ordinary tool errors; an empty plan with nothing available just returns `SchedulerInfo`. Nothing is retried or replayed automatically.
- A normally finishing run is accepted only when no graph work remains available and observed work was scheduled; otherwise it fails with `invalid_state`. A member failure fails the run with the original `DataflowNodeError` even if the model then answers normally. `error`/`aborted` final messages and stopping runs pass through unchanged.

### Lifecycle: `JuncoGraph`

- `step()`/`run()` observe `graph.signal` without any argument. Passing `{ signal }` also binds caller cancellation for that evaluation: it recursively aborts members already executing, starts no later column, and waits for the active column and requested abort cleanup. The listener is removed on completion; an already-aborted caller starts no work. Cancellation does not close the graph, but interrupted members do not resume their cancelled runs. A cancelled drive rejects with the reason or a `DataflowNodeError` caused by it; concurrent drive and abort failures are retained together in an `AggregateError`. Pi scheduler windows exclude their driving scheduler from the abort join to avoid waiting on their own tool execution.
- `abort(reason)` snapshots membership recursively (nested graphs, each graph's `PiScheduler` before its members, agents and coroutines; shared or cyclic states once), starts every non-closed agent's or scheduler's native `abort()` and every coroutine's `abort(reason)` synchronously, then aborts each visited graph's signal with the same reason. It settles when they all do, failures rejecting as one ordered `AggregateError("Graph abort failed")`, and then gives each nonterminal graph a fresh signal. A pending abort is joined; a closed graph rejects `closed`.
- `close()` is terminal and cached, including its failure: agents, schedulers and coroutines are closed through their `Symbol.asyncDispose` — so a subclass's own async disposal and the cleanup it awaits are joined — never a separate abort; every visited graph's signal aborts with one `Graph closed` reason. Later drives reject, results stay readable, and `await using` closes on scope exit. Abort and close are stack-safe at any finite depth.
- An agency scheduler's own `abort()`/`return()` cascades through its graph's members the same way, excluding itself; a later `graph.close()` joins that native close. Lifecycle promises join resource lifecycles, not arbitrary node-body awaits; callers observe their run promises separately.

### Context compaction: `JuncoGraph.compact`

- Every prompt agent reports `context_size()`, an estimate of its current conversation's tokens, and `compact()`, which queues Pi's compaction after any admitted run and resolves to `undefined`. `JuncoGraph.compact(graph, policy)` (or `graph.compact(policy)`) applies `compact()` to the direct `JuncoAgent`/`MockAgent` node states of any graph; nested graphs and coroutines are skipped, never compacted recursively. It never runs the graph or consumes messages or results, and a scheduler is compacted only when it is itself a node. A policy outside `CompactionPolicy` rejects with `invalid_argument` before the graph is inspected.
- `"all"` and `"more-than-forty"` consider every node, finished or unavailable included; `"all-available"` and `"more-than-forty-available"` take one `graph.available()` snapshot. Selection happens when `JuncoGraph.compact` is called; later readiness or topology changes do not alter it.
- Threshold policies read each candidate's `context_size()` and `getModel()` once and select members holding strictly more than 40% of their model's `contextWindow`. A member whose model or window is missing, non-finite or not positive rejects the compaction with `invalid_state` before any request is made.
- Each selected member gets one request, all dispatched without waiting for one another; every request finishes, and failures reject as one `AggregateError("Graph compaction failed")` in node order, keeping each member's original error — a member closed while its compaction is pending or accepted contributes its `closed` error. Successful members stay compacted.
- A member with an admitted run compacts only after that run ends; a held yield keeps its compaction pending. Keep driving the graph (or agency) while awaiting the compaction, or await it before driving an unstarted graph. While a member's compaction is pending, its new prompts and navigation are `busy` and its staged prompt waits, so a staged member can drop out of `available()` until then.

## Verification

`bun run test` is the deterministic default suite, run by CI with coverage (`bun run test:coverage`, LCOV at `coverage/lcov.info`, uploaded by the `test` job as the `agency-coverage` artifact; it reports agency `src/` only). Each package's implementation is tested by its own suite: `dataflow-engine` (`tests/`, graph/trigger/scheduler/tracer/primitives), `junco-scheduler` (`test/scheduler.test.ts` core, `test/pi-scheduler.test.ts` Pi adapter), `junco-agent` (`test/junco-agent.test.ts`) and `junco-tools` (`tests/*.test.mjs` under Node). The agency's own suites do not repeat them; `test/std-namespaces.test.ts` composes the root `graph`, `schedulers`, `tracer` and `trigger` namespaces into one fan-out/fan-in graph, and `test/agentic.types.ts` plus `test/std-namespaces.types.ts` (root `bun run typecheck`) compile every exported type as a consumer contract. Its prompt agents are `MockAgent`s (exported from `src/mock-agent.ts`): an `Agentic` that replays one constant transcript — scripted yields, terminals, hook results, events and maintenance records — with `JuncoAgent`'s status, admission, queue, iterator, abort and close semantics, and no provider, harness, tool or session. `test/mock-agent.test.ts` checks that complete surface. `test/agent-node.test.ts` and `test/deterministic-agency.test.ts` run real `JuncoGraph`s of mock agents, `Deterministic` coroutines and nested graphs on `junco-scheduler`'s `RoundRobinScheduler` (`Width.create(1)` × `Width.create(1)`) and `ParallelScheduler` (`Width.create(1)` × `UNBOUNDED`): the prompt-agent adapter, value-once priming, all five dispatched methods, single-prompt and close failures, suspended continuation, `anyOf`/`allOf` reads, shared `NodeOptions` availability across kinds, nested-graph completion, result selection and captured-signal cancellation, both policies' window contracts, recursive abort/close over cyclic and shared graphs, graph-signal cancellation, close-once and failed-close reuse, and 4096-deep nesting. `test/deterministic.test.ts` covers the coroutine's cooperative abort, close draining, direct `return`/`throw`, async iteration, single-consumer and finished guards. `bun run smoke` runs `test/deterministic-agency.fixture.ts` (one producer/worker graph per policy, closed through `graph.close()`) and prints:

```json
{"scheduler":"round-robin","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
{"scheduler":"parallel","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
```

The default suite also runs `test/compaction.test.ts`: each policy's selection over one real graph with available, trigger-blocked, availability-rejected and completed members; the strict 40% threshold; unknown policies and unknown context windows rejecting before any change; available-only policies never measuring unavailable members; invocation-time snapshots; a later member compacting while an earlier one is still yielded; and ordered failure aggregation. The native adapter's context sizing and deferred compaction are covered by `junco-agent`'s own suite.

`test/tui-graph.test.ts` (in the default suite) covers graph geometry for escaped labels, parallel edges, self-loops, nested/shared/empty/recursive graphs and a long chain, plus immediate safe payload snapshots with BigInts, cycles and long values without application getters or custom inspection. Ordinary runtime tests supply `DummyTracer` or a deliberate recording/custom observer, so a terminal never changes their backend.

The mock replays Agentic interactions; it does not simulate provider reasoning, native policy denial or tool execution. Those, and the Pi scheduler itself, are covered by separately runnable suites; CI runs `test:integration`, `test:native` and both workflow smokes, but not `smoke:pi`:

- `bun run test:integration` (offline, faux providers): the real `PiScheduler` factories and Opus acquisition from a fixture login, `JuncoGraph.pi` graph assignment, candidate-only `SchedulerInfo` with native descriptions, schedule-tool plans, input fairness, nested Pi graphs, 32-level recursive driving, abort/close cascades, the OSS committee, the mixed example, and the Ralph workflow (`test/ralph-workflow.test.ts`: default and configured round counts, final-only publication timing, assignment protocol, failed rounds, native yields, idle admission, cancellation, and isolation of several workflows in one parent). `bun test test/oss-committee.test.ts` runs twelve network-free committee tests with injected GitHub responses: value-edge gating within a round, failed-lookup yield handoff before Librarian resumes, success followed by failure, truncated final reports before and after handoff, valid empty search, approval guards, scoped/malformed search metadata and GitHub trust signals, revision rounds that route the Reducer's feedback to Librarian and Architect until approval, a round without a verdict, and a failed lookup followed by a normal round. Neither those offline tests nor `flush()` prove live GitHub access or Copilot entitlement.
- `bun run smoke:workflows` (after `bun run build`) runs `test/workflows.fixture.ts` under Node's TypeScript stripping against the built `junco-agency` and `junco-agency/workflows` entrypoints, and `bun run smoke:workflows:bun` runs it under Bun against the source entrypoints. Using the root `agent`, `tools`, `graph` and `trigger` namespaces, it first checks a tool created by `new tools.YieldTool()`: `turn_end` subscribers see its successful result before `JuncoAgent` suspends, only the next explicit `next()` resumes the run, and `return()` closes it terminally. It then runs a three-round Ralph over a native agent on a faux model, checking that the nested graph is the root bundle's `JuncoGraph` and that closing the parent closes it and the agent. Both print `{"rounds":3,"delivered":["draft-3"],"sharedGraphIdentity":true,"closed":true}`.
- `bun run smoke:pi` runs the offline recursive Pi example with automatic tracing: interactive terminals show the TUI until dismissal; redirected runs stay silently untraced. After restoration it prints `root complete; leaf-result + sibling-result; 3 root windows`.
- `bun run smoke:tui` is a credential-free real-terminal smoke using native agents with faux responses. With the production addon built, run it in an interactive terminal (`TERM=xterm-256color`, at least 100×30): observe Alpha then Beta green, stable upper topology and live lower-pane text, then press `q` after completion. It checks terminal restoration before printing `TUI_SMOKE_OK`; it needs neither a Btrfs mount nor model credentials.
- `bun run test:native` includes the real Linux PTY tests in `test/tui-tracer.test.ts` (automatic/explicit acquisition, live member and task traces, failure, dismissal and terminal restoration) and `test/policy-yield.test.ts`, which uses junco-tools' real Marsh policy through the CopyTree native test addon (see Setup): denied `edit`, applying `ast_edit`, and `bash` calls pause in source order without publishing edits or starting a second model request until resumed. A failed native test is not evidence of a passing policy boundary, and the deterministic policy-reason scenario does not prove native enforcement.
- `bun run test:all` runs all three suites. The build can be loaded under Node.js with `node --input-type=module -e 'await import("./dist/index.js")'`.
