# junco-agency

Recursive agentic dataflow graphs. A `JuncoGraph` is a native [`dataflow-engine`](packages/dataflow-engine) graph whose node states are `Agentic`: agents, nested graphs, `Deterministic` coroutines, and deterministic `Source`/`Sink` ports. Every graph has fresh positional source and sink nodes; nested execution returns only its sink's retained result. Graphs own work and resource lifetime, never scheduling policy. An external `schedulers.context({ graph, scheduler })` pairs a graph with a typed function from [`junco-scheduler`](packages/junco-scheduler); `parallel()`, `roundRobin()` or the stateless `pi(...)` oracle decide which existing work nodes advance.

## Setup

Requirements: Linux x86-64 with glibc and Bun `1.4.2`. Package development additionally needs Node.js `>=22.19.0` (Node `dist` builds and smokes), and `junco-tools`' native addon needs Rust `1.95.0` plus native build libraries. This repository is a Bun workspace: the agency sits at the root and `packages/` holds `junco-tools`, `junco-agent`, `dataflow-engine` (with its `examples` workspace), `dataflow-engine-opik`, and `junco-scheduler`, each imported with its full Git history. Only `marsh` and `junco-policy` stay external: Cargo fetches them from the default branches of their public repositories ([`junco-org/marsh`](https://github.com/junco-org/marsh), [`junco-org/junco-policy`](https://github.com/junco-org/junco-policy)) when it builds junco-tools' native addon, so no sibling checkout is needed. The source example bundles below need no Rust. The tracer adapters are optional at runtime (see [Tracing](#tracing-local-only)).

To run the root `examples/`, install once from the root and let Bun bundle them from workspace sources; no package or declaration build comes first. When junco-tools' Rust toolchain is installed (see its [README](packages/junco-tools/README.md)), the root install's `postinstall` also builds the production native addon (`bun run build:native` in `packages/junco-tools`, which first moves `Cargo.lock` to marsh's and junco-policy's current GitHub HEAD; a failed build fails the install); without it, the install prints a notice and skips the addon, as does `--ignore-scripts`:

```sh
bun install --frozen-lockfile
bun run build:examples
bun --no-install examples/dist/recursive-agency.js
```

`build:examples` bundles `examples/recursive-agency.ts`, `mixed.ts`, `oss-committee.ts`, `mcp.ts`, `verus.ts`, and `yak-shaver.ts` (with shared chunks and external source maps) into `examples/dist/` for Bun. Reachable workspace packages resolve through their `bun` exports to TypeScript source, so producer declaration builds are not prerequisites. Five boundaries stay external and must be installed where the bundle runs: the generated lazy `junco-tools/native` loader, `@oh-my-pi/pi-coding-agent`, and the three `@earendil-works` Pi packages (which locate their own assets). Recursive/mixed/committee supply explicit tools and need no native addon; recursive is offline, while mixed/committee retain their credentials and inputs. MCP, Verus and yak-shaver workflows retain their native ShellMux/MCP prerequisites. Cancellation has no graph/scheduler to migrate.

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

A `JuncoGraph` takes fresh source and sink nodes, window and thread bounds, a tracer (or `undefined`), and its authorization policy, in that order. Its tracer defaults to `tracer.TuiTracer.shared()`: one shared lazy TUI named `JuncoGraph.run` when stdin and stdout are TTYs and `TERM !== "dumb"`, otherwise a silent, stateless `DummyTracer`. Explicit Dummy, custom and Opik tracers always win. Construction and `spawn` remain synchronous; imports, factory construction and shared selection do not load native bindings, enter terminal modes, install handlers or write output. The first observer callback starts the lazy display.

For explicit acquisition, use `const tui = await tracer.TuiTracer.create("My workflow")` (the name is optional), then pass it to your graphs. It rejects unsuitable terminals before loading native bindings; native initialization failures surface rather than falling back to another backend. Only one session may own the terminal. The ratatui display has two vertically stacked panes: `JuncoGraph` above and live `Agent traces` below. Topology stays fixed across steps unless it changes; only currently executing scheduled nodes are green. Stable identity colors and scoped `[g<serial>:<NodeId>]` badges distinguish repeated local IDs in nested graphs. Agent messages, tool progress and lifecycle outcomes appear independently of `LOG_LEVEL`. Promoted task parents retain their agent identity: return records show outcomes and stop reasons, not another copy of streamed messages. Payloads are snapshotted without application getters or custom inspection and may contain sensitive data; retained display history is bounded, not a durable transcript.

Share one tracer across child graphs: Ralph and promoted task graphs inherit their parent's observer; separately constructed children must receive the same explicit tracer from their caller. Close all graphs before calling `await observer.flush()` once for the shared observer. TUI `flush()` draws the final state and waits for `q`/Esc before restoring the terminal; `q`/Esc can also dismiss early without cancelling computation. `await tui.close()` or async disposal restores without waiting for dismissal. Flushing or closing an unused lazy instance performs no terminal I/O. While the screen is owned, do not write directly to stdout/stderr; capture MCP stderr (`stderr: "pipe"`) and print final results only after restoration. Tab switches pane focus; arrows, PageUp/PageDown and Home/End pan or scroll, and End resumes trace tail-follow.

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
import { graph as graphApi, schedulers } from "junco-agency";

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
const execution = schedulers.context({
  graph: new graphApi.JuncoGraph(source, sink, graphApi.Width.create(1), graphApi.UNBOUNDED, undefined, LockPolicy),
  scheduler: schedulers.pi({
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

[`examples/recursive-agency.ts`](examples/recursive-agency.ts) runs a root → child → grandchild agency around a leaf that pauses once, plus a root sibling, entirely offline on faux models. Each context records only its own decisions; leaf, sibling and sink results are inspected on the retained native graphs.

All six graph example CLIs handle Ctrl-C with a scoped `AbortSignal`: cancellation interrupts active agents, nested graphs and cooperative coroutines, joins cleanup, and exits with status 130. Imports install no signal handlers. Setup awaits without cancellation support finish before the next signal check; bodies that ignore cancellation must still drain.

### OSS committee (live)

[`examples/oss-committee.ts`](examples/oss-committee.ts) is a literate, top-to-bottom deterministic-policy workflow: three persistent `JuncoAgent` members run review rounds, each with fresh Source/Sink ports, a passive `JuncoGraph` and a `schedulers.parallel()` context over the same members. Their sessions keep every earlier round. The Librarian (`claude-opus-5.5`, medium reasoning) uses `search_oss` with generic technical terms rather than the verbatim request; each result reports GitHub stars and last push time alongside the repository URL and reported license. The Architect (`gpt-6-sol`, high) is toolless and designs from the available research; the Reducer (`claude-sonnet-5.5`, xhigh) combines both final reports, records a typed verdict with its `review` tool and produces the **only** titled Markdown plan. A revision request starts another round in which the Librarian continues investigating and the Architect revises its design from the Reducer's feedback; approval — minimal, clean custom code over well-trusted OSS libraries — publishes the plan. There is no round limit, and a round that ends without a verdict fails without publishing. Normally, a value edge gates Architect on a valid successful lookup and a nonempty, normally stopped Librarian report. After a failed lookup in any round, Librarian must call the real `yield` tool with its available public research, the failure and the remaining gaps in the reason. A message edge hands that partial snapshot to Architect while Librarian stays paused. Librarian resumes only after Architect returns, then writes its closing report without further searches. Reducer still waits for both final reports; missing, empty or truncated final reports cannot publish a plan. Returning after a failed lookup without the required yield is rejected rather than silently accepted. `JuncoAgent.create` rejects a reasoning level a model does not support, so no reasoning level is silently downgraded.

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

On a `mcp.JuncoMcpTools` definition, `definition.connect({ collection, toolLifetime: "call" })` closes schema discovery before returning and starts only the originating server for each invocation; each call joins its process cleanup before settling. The default `"connection"` lifetime keeps servers until `close()`. Lifetime is independent of `discardOnClose` (default `false`): set it to `true` for fresh, discard-only research. Call-scoped connections hold a collection lease; their cached `close()` fences new calls, cancels and joins active calls, then releases that lease. Select concrete tools with ordinary arrays and `mcp.getJuncoMcpToolIdentity(tool)`, not published collision names.

For a scripted end-to-end run without model credentials, run `bun run test/oss-committee.fixture.ts`. The fixture prints the approved plan of one scripted round. It and `bun test test/oss-committee.test.ts` choose an explicit `DummyTracer`, keeping offline output deterministic even in a terminal.

### Yak shaver: in-place refactoring (live)

[`examples/yak-shaver.ts`](examples/yak-shaver.ts) applies generalizing refactors in place to a Graft-indexed Git working tree and releases each changed file; it writes no report and never commits. It is one literate file, read top to bottom in numbered sections. `runYakShaver` first runs `graft build .` through the trusted tool collection's sandboxed `bash` tool so every run starts from a current index. It then ranks every indexed `class`, `interface`, `type`, `enum`, `struct`, and `trait` (merged with its owned methods) by its longest dependency distance, in strongly-connected-component hops, from the public API (exported AST-origin symbols) or a test path, deepest first and then by ascending positive distinct-caller count; nothing is cut off. `refactorCandidates` admits four initially ranked candidates at a time, resolved against the current snapshot (a candidate removed by an earlier refactor is reported `removed`). Each batch is one parallel graph of `Proposer:r ==proposal:r==> Judge:r` lanes driven one step at a time; every proposer's native `task` call spawns up to three read-only researchers over far-first file shards, and an independent judge, whose staged prompt callback validates the proposal and composes its assignment, records four criteria. As soon as a lane's review passes all four criteria, adds a caller definition, and removes net nonblank lines, its edits are applied and exactly its paths released (`release -- <path>`) inside one managed command, so the lane's owner releases its own files; applications drain one at a time. After a batch that applied anything, the trusted sandboxed `graft build .` publishes the refreshed cache before the next admission. Research uses concrete SDK tools from one lazy `toolLifetime: "call", discardOnClose: true` connection: each invocation sees fresh source and discards its private writes before returning.

`liveRunner` borrows the root's research `AsyncDisposableStack` for lazy acquisition. Root cleanup explicitly attempts research close, tracer flush, trusted build close, then protected collection close; body and cleanup failures remain in `SuppressedError` chains. Each batch explicitly closes its graph on success or failure; construction failures also dispose every supplied but unregistered agent. Failed lane acquisition disposes its acquired agents in reverse order. Scheduler-context steps retain the apply-before-next-window barrier; neither a tracer nor a graph-wide `run()` publishes refactors.

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
      readonly step?: never; readonly policy?: never;
    })
  | (StepLess<N, T> & { readonly state: JuncoAgent | MockAgent; readonly step?: never; readonly policy: ToolCollection["policy"] }) // chat wires only
) & { readonly contract?: (edgeId: EdgeIdType) => Contract };

// Graph construction is passive. Pair it externally with schedulers.context to drive it.
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
// state is a JuncoAgent or MockAgent (chat wires only). Each addNode builds its own driver; its receiver
// contract is options.contract ?? agent.contract(edgeId). Raw { state, step, policy } specs register unchanged;
// Complete Source/Sink specs register their own state directly under the graph's policy.
// A step-less { ...options, state: coroutine } runs its Deterministic body.
// A step-less { ...options, state: childContext, contract? } nests childContext.graph;
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

**Skeletons.** Build text-only topology with `createGraph<string, void>({ multigraph: true })` from `ngraph.graph`, then call `JuncoGraph.map(skeleton, text => members.get(text)!, { source, sink, policy: tools.LockPolicy })` with pre-acquired agents and fresh meaningful ports. It returns a parallel context; wire the chosen terminal work's value edge into its sink before driving. Mapping is synchronous, in insertion order, and never runs a member or copies queued data. IDs, direction, parallel links, cycles and isolated nodes survive with independent empty transports. Bare roots start immediately; other bare states wait for any incoming message (cycles need an explicitly triggered seed). Full specs customize triggers/contracts; nested work uses `{ state: childContext, ...nodeOptions }`. The skeleton's ID overrides the spec's. A failed mapper leaves acquired members caller-owned; successful mapping hands registered resources to the graph.

Every kind reuses the engine's `NodeOptions`. An explicit `is_available` replaces the helper default. Descriptions stay on native nodes; a prompt lives on its agent. Native state is the original instance, including ports and nested graphs, except when an agent promotes itself into its own task graph. Contexts and policies are never native work states.

**Subagents.** A `JuncoAgent` registered as a node can call the `task` tool (`new tools.TaskTool()`, included in `JuncoAgent.create`'s default tools). The call acquires one fresh subagent per task through `createSubagents` (inheriting the caller's model, active tools and registered MCP definitions unless the task narrows them) and returns their handles immediately; the caller's run continues. The children start when the caller next calls `yield` (or hits a policy pause) or finishes its current run, so a caller that needs their reports before continuing calls `yield`. A workflow that owns the assignments calls `agent.setTaskBatch(input)` instead: the model then launches that stored batch with `task({})`, at most once per agent (a rejected admission may be retried; a second launch fails with `Task batch already admitted; wait for its results.`). At that pause or settlement the node's `state` becomes a `JuncoGraph.spawn` graph whose `"root"` node is the same running caller and whose children (node id = handle id for the first attempt, `<id>:attempt:<n>` for retries; `description` = task name) run the subagents; the node keeps its id, trigger, edges, retained inbox, original `send`/`info` routes and seen values, and steps that graph once per activation. Each child starts from its bound task prompt and sends one final report, `{"type":"task_result","id","name"?,"attempt","status":"completed"|"failed","output","stopReason","error"?,"decisionRequired"?}`, back on `<node>->root`, always carrying the stable logical `id`; the caller receives each delivered report as a follow-up while it keeps working, and is prompted again (`Process the queued task reports.`) if it already answered. Once every task of a launch is completed or ignored, the caller receives one `{"type":"task_batch_complete","ids":[...]}` follow-up (original IDs, admission order), which also wakes it when every task was ignored. The node returns the caller's answer only after every delivered report and marker entered its context and was answered. Later task calls add siblings under the same root; a child's own task call nests a spawn graph in that child's node. Close and abort reach every member through the graph cascade.

Promoted task execution retains its context separately from that native graph state. Fresh `$source`/`$sink` ports carry only external input/output: Source routes original edge-addressed views into the original inbox before root work, while an internal wake never reaches model `recv`. Task reports/retries stay on native root/child edges. Promoted `send` validates the original sender's edge before staging in the sink, and the outer wrapper drains after the child evaluation; non-aborted failed work still delivers already-accepted sends (delivery failure aggregates after work failure). Abort wins and leaves undelivered output buffered. Only the sink's exact retained result can complete the outer node, after all task/report work.

**Task failures.** A child fails when it settles with a stop reason other than `stop` (its real output is kept) or its run throws (a failed native boundary, a hook error; recovered through the engine's `on_error` hook). Either way its subagent, or the spawn graph it expanded into, is disposed exactly once before anything else happens; a teardown failure is not reportable work but an `AggregateError` (the failure, then the teardown failure) that fails the graph, even under `"ignore"`. Cancellation of the owning graph propagates and is never retried or ignored. The caller's `setTaskFailurePolicy` (snapshotted per admitted task, default `{ retries: 0 }`) then decides: `"ignore"` drops the failure silently (no report reaches the caller); `{ retries: n }` reruns only that task in a fresh child with its original prompt, model and tool subset up to `n` times without telling the caller (an allocation failure also uses a retry), then delivers the failed report with `decisionRequired: true`. The caller answers with `task({ action: "retry" | "ignore", id, attempt })`: retry runs one more attempt under the same handle (started like any task, at the caller's next `yield` or settlement) and asks again if it fails; ignore returns `Ignored task <id>.`. Neither pauses. Unknown, stale or repeated decisions are ordinary tool errors. A caller that settles while a delivered question is unanswered fails with `Task failure decisions required: <ids>`. Ordinary registered agents have no such hook: a thrown failure still rejects the drive.

**Complaints.** Every `JuncoAgent` has an always-on `complain` tool. Graph-driven complaints retain the original registration's node ID, delivered edge-addressed inputs, full model request and issue in the shared `tools.issueLog` (`graph.issueLog` and `agent.issueLog` are the same object), and notify that graph's tracer. Task promotion preserves the outer caller's original registration and attribution; each child uses its task handle ID. `MockAgent.complain(issue,tracer?)` uses the same log.

### Standard library namespaces

The root entry also re-exports the standard library for building junco workflows as namespaces, beside the flat agency exports above:

| Namespace | Contents | Source |
|---|---|---|
| `graph` | `DataflowGraph`, `JuncoGraph` (with `create`, `map`, `spawn`, `compact`), native observations/execution, edges (`Edge.message`, `Edge.value`, `Message.create`, `from`), `NodeId`/`EdgeId`, `Width`/`UNBOUNDED`, `Queue`, `renderPretty`, errors and native node/edge types | `dataflow-engine`, this package |
| `graph.nodes` | `Source`, `Sink`, `ConstFanout`, `ConstFanin`, `StepNode`, `EmitOnce`, `Deterministic`, and the `Agentic`/`AgenticInput`/`AgenticNode`/`CompactionPolicy` types | `dataflow-engine`, this package |
| `trigger` (also `graph.trigger`) | `TriggerRule`, `TriggerEntry` and `TriggerKind` (`"all"` or `"any"`); rules `TriggerRule.allOf(...)`, `TriggerRule.anyOf(...)`, `TriggerRule.when(edge)`, `TriggerRule.always()`, `TriggerRule.never()`; entries `TriggerEntry.on(edge)`, typed by their edge's message and result payloads; `evaluateTrigger`, `satisfiedEdges` | `dataflow-engine` |
| `agent` | `JuncoAgent`, `JuncoAgentError`, `TaskPolicy`, `TaskFailurePolicy`, `SubagentObserver`, and the `Agentic` protocol types | `junco-agent` |
| `tools` | Everything `junco-tools` exports: `ToolCollection`, `LspTool`, the native tool classes' `create` factories (`ReadTool.create`, `BashTool.create`, …), `YieldTool`/`isYieldTool`, the graph messaging tools `new RecvTool()`/`new SendTool()`/`new InfoTool()` (each class with static `.is`/`.invoke`) and their edge `Contract`, `TaskTool`/`AssignedTaskTool`/`isTaskTool`/`isAssignedTaskTool`/`invokeTaskTool` with the `TaskInput`/`TaskDecision`/`TaskRequest`/`TaskCall` contracts, the always-on `ComplainTool`/`isComplainTool`/`invokeComplainTool` with the shared `issueLog` and its `Issue`/`Prompt` types, ShellMux operations (`ShellMuxOperations`, `ShellMuxLease`), the Marsh policy-denial check, and the type-only `NativeModule`, `NativeMux` and `EditStore` contracts | `junco-tools` |
| `schedulers` | The three operators `choose`, `separate`, `agent`; derived `parallel`, `roundRobin`; agency-aware `context`; stateless `pi`; `Decision`, `Snapshot`, `Scheduler`, `SchedulerContext`, `AgencyNodeMetadata`, `PiOptions`, `SchedulerRequest`, and the native observation type | `junco-scheduler`, this package |
| `tracer` | `DataflowTracer`, `DataflowRunTrace`, `DataflowStepTrace`, the no-op `DummyTracer`, and `TuiTracer` (`shared()` selects the lazy interactive default or Dummy; `await create(name?)` explicitly acquires a TUI) | `dataflow-engine`, this package |

```ts
import { graph, schedulers, tracer, trigger } from "junco-agency";
import { context } from "junco-scheduler";

const g = new graph.DataflowGraph<void, number, string, never>(graph.Width.create(1), graph.UNBOUNDED, new tracer.DummyTracer());
const execution = context({ graph: g, scheduler: schedulers.parallel() });
const a = graph.Edge.message<number, string>("a");
const source = g.addNode(new graph.nodes.ConstFanout(7, [a], { state: undefined, ret: "sent" }));
const sink = g.addNode(new graph.nodes.StepNode<void, number, string>(() => [], { state: undefined, trigger: trigger.TriggerRule.allOf(trigger.TriggerEntry.on(a)) }));
g.addEdge(source, sink, a);
await execution.run();
```

A generic `DataflowGraph`'s tracer stays optional: pass a `tracer.DataflowTracer` (for example `OpikTracer` from `dataflow-engine-opik`, or `tracer.TuiTracer.shared()`) as its third argument, or omit it to run untraced. A `JuncoGraph` takes its tracer or `undefined` as the fifth argument, after its ports and bounds. The Opik adapter is not re-exported; this package does not depend on `dataflow-engine-opik` or `opik`.

### Prompt agents: `graph.addNode({ ...options, state: agent })`

- A node drives its member through **one** run. The body first yields nothing, so the engine's priming consumes no input. Each later activation appends the delivered message batches (per edge, FIFO) and the parent results it has not seen before (each presented once) to the node's retained inbox. Payloads are data, never native commands: the model reads and drains the inbox with `recv`, sends on this node's outgoing message edges with `send` (by edge id), and discovers its parents, children, edge kinds and each receiver's `Contract.expect` with `info`. On its first activation a `ready` member starts its staged prompt (`JuncoAgent.create`/`fromResolved({ prompt })` or `agent.stagePrompt(prompt, { images? })`); a prompt callback `(inputs: ParentView<AgenticInput, AssistantMessage>) => string` runs once, synchronously, reading the node's retained inbox without draining it, and may throw to reject invalid inputs. Each activation calls `agent.next(inbox)` exactly once: a `yield` step leaves the member paused, a settled step returns the member's native final message (including `error`/`aborted` stop reasons) as the node's result, and a failed step fails the node with the original error. Only `yield` and a Marsh policy denial pause a run.
- Before its run starts, a member is available only when its trigger fires and it has a staged prompt (status `ready`) or fresh input; fresh input alone is retained and the idle member stays quiescent until a prompt starts it. A constructor prompt is one-shot: stage the next round's prompt with `stagePrompt` (it throws `busy` if one is already staged). A prompt callback that throws fails the node with the identical error. A member iterator that ends before its run settles (the member was closed) fails the node with `closed`. Once started, a member stays available until its run settles, even if its trigger was drained.
- A validated handoff that must build the consumer's assignment uses a prompt callback that reads `inputs.messages`/`inputs.values`, throws on invalid data and returns the assignment (`examples/mixed.ts`'s Reviewer, `examples/mcp.ts`'s Dependencies, the OSS committee's Architect and Reducer, the yak shaver's judges). The consumer needs no `recv`, and its registration's `contract` describes each incoming edge.
- One member can run in successive graphs, staged before each later registration with `stagePrompt`; its session keeps every earlier run.
- A finished node keeps its agent alive and usable until a graph containing it closes.

### Nested graphs: `{ ...options, state: childContext }`

- Register the child's `SchedulerContext`, not a bare graph. The registered native state is still the actual `childContext.graph`. Priming yields nothing and makes no child decision. Each later parent activation admits its edge-addressed message batches and once-only value keys into the child's Source, then advances at most one child decision.
- Source routing is scheduled deterministic work; it validates/converts the original `ParentView` and returns messages for explicitly wired internal edges. An empty view is ignored. Each graph requires fresh Source/Sink instances with mandatory distinct branded IDs; inbound source edges, outbound sink edges and value edges out of the non-returning source are rejected.
- Only after successful child work, its Sink drains FIFO messages through the parent wrapper's real sender ID. A completing sink can stage its final messages and return its exact `T` in one activation. Failed delivery retains the undelivered suffix, and child failure/cancellation publishes nothing.
- Quiescence returns exactly `childContext.graph.result(childContext.graph.sink.id)`, including present `undefined`. Absence is an `invalid_state` failure. Intermediate member results never become nested output. A precompleted child with empty ingress can publish its retained sink result without another child decision.

### Workflows: `junco-agency/workflows`

- `Ralph.register(parent, agent, { id?, description?, policy, input, output, rounds? })` registers one node in `parent` and returns its id. The node's state is a nested one-worker `JuncoGraph` whose worker's state is the supplied native `JuncoAgent`, so closing `parent` closes both. `input` and `output` are caller-owned message edges; wire them to the returned id before driving, and read the final `AssistantMessage` with `parent.result(id)`. Registration makes no model request; omitted ids are engine-generated, so several workflows coexist in one parent.
- `rounds` defaults to `2` and must be a positive safe integer; anything else throws `RangeError` before anything is registered. The first round prompts the exact assignment; every later round prompts the assignment plus the immediately preceding complete draft, in the same session. Native yields resume within a round and never count as one.
- The node expects exactly one text `prompt` on `input` (no images); a second assignment, any other input kind, or a nonempty `images` array fails the node. Each round must settle with stop reason `stop` and nonempty text; otherwise the node fails and nothing is published. A non-idle agent fails with `invalid_state`; cancellation through the nested graph's signal wins.
- Only the final round's trimmed text is emitted, once, as `{ kind: "prompt", text }` on `output`, in the same parent step that publishes the node's result. `examples/mixed.ts` uses it with `rounds: 2`.
- The agent is lent exclusively to the workflow while it runs: do not drive or reconfigure it concurrently.

### Coroutines: `Deterministic` and `{ ...options, state: coroutine }`

- `new Deterministic(body, policy, collection?)` invokes `body(signal, collection)` once; the generator speaks the engine's own protocol (dependent bodies start with `let view = yield []`, sources may emit immediately) and its closure holds any state. `step()` hands the coroutine to one consumer only; a second registration or a direct advance before it fails with `invalid_state`, and advancing a finished coroutine fails with `invalid_state`.
- `abort(reason)` aborts `signal` and joins the advance in flight; a rejection with exactly that reason is cancellation. `close()` (and async disposal) is cached: it signals pending work, joins it, then drains the generator through `return()`, discarding cleanup batches; later advances reject with `closed`, and an advance in flight when close began rejects with the signal's reason rather than publishing cleanup output. A sole cleanup error rejects as itself, several as `AggregateError("Deterministic close failed")`. Bodies that ignore their signal cannot be preempted.

### Scheduling: policies paired with work graphs

- The core language has exactly three operators: `choose({ where?, rank, width? })` ranks available owned nodes with raw string-ID ties, `separate(leftOwns, left, right)` partitions exclusive selection authority and concatenates validated child decisions left-to-right, and `agent(invoke)` normalizes one oracle response. `parallel()` and history-derived `roundRobin(order?, width?)` are derived policies. A `Scheduler<S,N,T,C>` is an ordinary sync/async function returning `{ selected: readonly NodeIdType[] }`; application priority, FIFO, random choice and fallback remain ordinary TypeScript.
- `schedulers.context({ graph, scheduler })` supplies agency metadata (`agentStatus`, `lastYield`) and unseen-value/task-inbox reads. For a plain native graph use `context` from `junco-scheduler`, with optional typed `describeNode` and pure `readInputs` hooks. Pairing performs no observation, provider call, registration or binding. Policies are reusable; histories belong independently to each context, not the graph or policy closure. `execution.step()` takes at most one decision; `execution.run()` repeats to quiescence, without asking a policy when no work is available.
- Snapshots retain exact native state/message/result and caller metadata types. Their all-node records, topology tuples, queue arrays, result membership, metadata map and history are detached readonly containers. Opaque state/message/result/metadata values are borrowed identities, not deep-cloned or frozen; callbacks must only read them, and applications needing historical object contents must use immutable data. Native mutation and non-empty Source admission invalidate an in-flight decision; metadata is captured freshly for every decision.
- `separate` separates only authority over existing work-node IDs and projects history to each branch. Native observations, external metadata and thread bounds stay shared. Authority safety does not promise thread feasibility, progress, fairness, JavaScript memory/effect isolation or external-service isolation. The frame rule applies only to owned-local readonly callbacks; ordinary TypeScript is not sandboxed. Policies, contexts and branches never become work nodes or transports.
- `schedulers.pi({ models, model, systemPrompt?, prompt?, streamOptions? })` is a stateless oracle using `models.completeSimple`: one request per current decision, no scheduler session, iterator, hidden conversation or default model. The last user message is `SchedulerSnapshot:\n` plus a `SchedulerRequest<C>` containing version, threads (`null` for unbounded), available-owned native node IDs/status/descriptions, their defined external metadata pairs and projected history. Native state, inputs and results are omitted; only the application's metadata must be JSON-serializable. Use `agent` for deliberate data-aware summaries.
- The only model tool is strict `schedule({ waves: string[][] })`. Later waves are speculative: stable-deduplicate and filter each to available owned IDs, execute the first non-empty wave, then recompute from a fresh snapshot. A ready node is only primed on first selection. Exactly one schedule call with `stopReason: "toolUse"` is required; malformed/extra keys, missing/multiple calls and provider failures reject before work. No retry, text-only settlement or fallback is invented.
- Every decision lowers to one native column. Duplicate, unowned or unavailable selections, invalid reads, stale decisions and exceeded native capacity fail before activation/input consumption. Empty top-level selection with available work is an error; a branch may abstain beside a progressing sibling. History commits actual started IDs after a column drains, even if work failed. Native execution drains admitted work before releasing its evaluation gate.

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

`bun run test` is the deterministic default suite, run by CI with agency-source coverage (`coverage/lcov.info`). Packages test their own implementation: engine graph/trigger/tracer/primitives; scheduler `test/scheduler.test.ts`, `test/scheduler-dsl.property.test.ts` (executable CSL authority laws with fast-check), and faux-only `test/agent.test.ts`; native agent/tool behavior in their packages. Root type fixtures cover typed observations, metadata, ports and context subtype preservation. Root mock-backed suites exercise both `roundRobin()` (window/thread 1) and `parallel()` (window 1/unbounded threads): native priming, all/any reads, batches, unseen-value fairness, nested sink-only completion, cancellation, resource ownership, shared/cyclic graphs and deep stack-safe traversal. Mock transcripts preserve agent admission, queue, yield, result, abort and close semantics without a provider. `bun run smoke` drives one real context per policy, closes its graph, and prints:

```json
{"scheduler":"round-robin","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
{"scheduler":"parallel","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
```

The default suite also runs `test/compaction.test.ts`: each policy's selection over one real graph with available, trigger-blocked, availability-rejected and completed members; the strict 40% threshold; unknown policies and unknown context windows rejecting before any change; available-only policies never measuring unavailable members; invocation-time snapshots; a later member compacting while an earlier one is still yielded; and ordered failure aggregation. The native adapter's context sizing and deferred compaction are covered by `junco-agent`'s own suite.

`test/tui-graph.test.ts` (in the default suite) covers graph geometry for escaped labels, parallel edges, self-loops, nested/shared/empty/recursive graphs and a long chain, plus immediate safe payload snapshots with BigInts, cycles and long values without application getters or custom inspection. Ordinary runtime tests supply `DummyTracer` or a deliberate recording/custom observer, so a terminal never changes their backend.

The mock replays Agentic interactions; it does not simulate provider reasoning, native policy denial or tool execution. Those, and the Pi scheduler itself, are covered by separately runnable suites; CI runs `test:integration`, `test:native` and both workflow smokes, but not `smoke:pi`:

- `bun run test:integration` (offline, faux providers): stateless `pi` and candidate-only `SchedulerRequest<AgencyNodeMetadata>` with native descriptions, strict wave protocol, input fairness, nested contexts, 32-level recursive driving, pending-provider cancellation/drain, the OSS committee, mixed example and Ralph workflow. Ralph coverage retains configured rounds, final-only publication, assignment validation, failures, native yields, idle admission, cancellation and independent state. Committee tests retain value-edge gating, failed-lookup partial handoff, normal/truncated/empty research, verdict guards, revision routing and scoped search metadata. These checks and tracer flush do not prove live GitHub access or provider entitlement.
- `bun run smoke:workflows` (after `bun run build`) runs `test/workflows.fixture.ts` under Node's TypeScript stripping against the built `junco-agency` and `junco-agency/workflows` entrypoints, and `bun run smoke:workflows:bun` runs it under Bun against the source entrypoints. Using the root `agent`, `tools`, `graph` and `trigger` namespaces, it first checks a tool created by `new tools.YieldTool()`: `turn_end` subscribers see its successful result before `JuncoAgent` suspends, only the next explicit `next()` resumes the run, and `return()` closes it terminally. It then runs a three-round Ralph over a native agent on a faux model, checking that the nested graph is the root bundle's `JuncoGraph` and that closing the parent closes it and the agent. Both print `{"rounds":3,"delivered":["draft-3"],"sharedGraphIdentity":true,"closed":true}`.
- `bun run smoke:pi` runs the offline recursive Pi example with automatic tracing: interactive terminals show the TUI until dismissal; redirected runs stay silently untraced. After restoration it prints `root complete; leaf-result + sibling-result; 11 root decisions`.
- `bun run smoke:tui` is a credential-free real-terminal smoke using native agents with faux responses. With the production addon built, run it in an interactive terminal (`TERM=xterm-256color`, at least 100×30): observe Alpha then Beta green, stable upper topology and live lower-pane text, then press `q` after completion. It checks terminal restoration before printing `TUI_SMOKE_OK`; it needs neither a Btrfs mount nor model credentials.
- `bun run test:native` includes the real Linux PTY tests in `test/tui-tracer.test.ts` (automatic/explicit acquisition, live member and task traces, failure, dismissal and terminal restoration) and `test/policy-yield.test.ts`, which uses junco-tools' real Marsh policy through the CopyTree native test addon (see Setup): denied `edit`, applying `ast_edit`, and `bash` calls pause in source order without publishing edits or starting a second model request until resumed. A failed native test is not evidence of a passing policy boundary, and the deterministic policy-reason scenario does not prove native enforcement.
- `bun run test:all` runs all three suites. The build can be loaded under Node.js with `node --input-type=module -e 'await import("./dist/index.js")'`.
