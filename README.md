# junco-agency

Recursive agentic dataflow graphs. A `JuncoGraph` is a native [`dataflow-engine`](packages/dataflow-engine) graph whose node states are `Agentic`: a `JuncoAgent` ([`junco-agent`](packages/junco-agent)), a `MockAgent`, a nested `JuncoGraph`, or a `Deterministic` coroutine. Every kind registers through the engine's own `addNode` with the engine's one `NodeOptions` (`id`, `description`, `trigger`, `is_available`); the graph adds recursive abort/close over its members. `createAgencyScheduler()` makes a `PiScheduler` ([`junco-scheduler/agent`](packages/junco-scheduler)) whose model drives such a graph through its only tool, `schedule`: one bounded graph window per call. Nesting needs neither flattening nor a forwarding object.

## Setup

Requirements: Linux x86-64 with glibc and Bun `1.4.2`. Package development additionally needs Node.js `>=22.19.0` (Node `dist` builds and smokes), and `junco-tools`' native addon needs Rust `1.95.0` plus native build libraries. This repository is a Bun workspace: the agency sits at the root and `packages/` holds `junco-tools`, `junco-agent`, `dataflow-engine` (with its `examples` workspace), `dataflow-engine-opik`, and `junco-scheduler`, each imported with its full Git history. Only `marsh` and `junco-policy` stay external: native development needs their checkouts alongside this repository (`../marsh`, `../junco-policy`), where `packages/junco-tools/Cargo.toml` finds the marsh crates. The source example bundles below need neither these checkouts nor Rust. The tracer adapters are optional at runtime (see [Tracing](#tracing-local-only)).

To run the root `examples/`, install once from the root and let Bun bundle them from workspace sources; no package, declaration, or native build comes first:

```sh
bun install --frozen-lockfile
bun run build:examples
bun --no-install examples/dist/recursive-agency.js
```

`build:examples` bundles `examples/recursive-agency.ts`, `mixed.ts`, `oss-committee.ts`, `mcp.ts`, and `yak-shaver.ts` (with shared chunks and external source maps) into `examples/dist/` for Bun. Every reachable workspace package resolves through its `bun` export to TypeScript source, so the tools → engine → agent → scheduler → Opik adapter chain below is not a prerequisite. Six boundaries stay external and must be installed where the bundle runs: the generated `junco-tools/native` loader (loaded lazily, only when default native tools are created), `@oh-my-pi/pi-coding-agent`, the three `@earendil-works` Pi packages (which locate their assets from their own install), and the `opik` SDK (needed only by a bundle built with `--feature=opik`). The first three examples supply explicit tools, so they need no native addon (`mcp.ts` and `yak-shaver.ts` run MCP servers and native file tools on the native ShellMux); the recursive example is offline, while `mixed` and `oss-committee` still need their existing credentials and inputs. Tracing is chosen at build time: `bun run build:examples --feature=opik` rebuilds the same outputs with the workspace Opik adapter bundled (run them with the usual `OPIK_*` configuration); a runtime `--feature=opik` cannot enable Opik in a bundle built without it, and rebuilding without the flag returns to `StdoutTracer` output.

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

A direct `JuncoGraph` requires a tracer as its constructor's fourth argument (`TypeError` when missing), and its `tracer` property is never `undefined`. `tracer.createTracer()` returns the automatically selected tracer from Bun's native feature flags: `--feature=opik` uses `dataflow-engine-opik` (configured by the SDK's `OPIK_*` variables); without it, `tracer.StdoutTracer`. `createParallelAgentGraph()` (and so `graph.Spawn`) defaults to it; an explicit tracer, such as `new tracer.DummyTracer()` for no output, always wins. The automatic tracer is built once per process, named `JuncoGraph.run`, and shared by every graph given it, nested ones included; Ralph's child graph uses its parent's tracer. Callers own `await graph.tracer.flush()`, as every example does. A missing Opik adapter or configuration fails `createTracer()` rather than falling back to stdout. The Node `dist` build carries no features, so it selects `StdoutTracer`; `examples/dist` carries the features it was built with (`bun run build:examples --feature=opik`).

`StdoutTracer` prints each `run()`/`step()` as it happens: a `[run <n>] <name>` header, the graph's topology drawn as Unicode boxes and arrows with [`mermaid-ascii`](https://www.npmjs.com/package/mermaid-ascii) (patched under `patches/`; every subgraph drawn separately under a `Subgraph [<path>]:` heading), then `Trace:` and one line per activation start (`prime`/`resume` with its delivered inputs) and outcome (`yield`, `return` or the raw `error`), ending with the run's cumulative results or escaping error. Payloads are printed in full with `util.inspect`, snapshotted when each event happens, without invoking application getters or custom inspection; they may include sensitive data. Parallel edges between the same two nodes share one arrow with their labels joined by ` / `; opposite-direction edges between the same pair can overlap each other's labels.

`dataflow-engine-opik` is a workspace package and a root development dependency, so the root install already provides it and `opik`; under Bun its `bun` export loads its source directly. Confirm with the `require.resolve` check:

```sh
bun --no-install -e 'for (const name of ["dataflow-engine-opik", "opik"]) console.log(require.resolve(name))'
OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency bun run --feature=opik examples/recursive-agency.ts
```

## CI

`.github/workflows/ci.yml` runs on every push, pull request, and manual dispatch, with two independent jobs that each run one root `bun install --frozen-lockfile`:

- `core` needs no secrets. It runs the root Biome check (`bun run check:ci`); then, before any package or native build, bundles the root examples from workspace sources (`bun run build:examples`), builds the engine's traced examples (`examples:build`, not executed) and runs its deterministic `--no-tracing` examples with their exact output, asserts after each that no package `dist`/`native`/`target` output appeared, and runs the copied root bundles in a temporary consumer that installs only the Pi vendor externals, without `opik` (the recursive example's successful exit with empty stderr, and the committee's usage rejection). It runs `junco-mcp`'s in-memory protocol suite from source, without the native addon. It then builds the engine, the scheduler's deterministic root (`build:core`, `typecheck:core` over that root with its scheduler suite and type fixture, then the scheduler suite), and the Opik adapter (build and typecheck); runs the engine's typecheck (Dummy) and `examples:typecheck` (Opik) against those declarations, and its tests with coverage (uploaded as the `coverage` artifact); packs the engine and scheduler into an isolated consumer without agent or Pi peers and runs the round-robin smoke under Bun and Node; and runs an offline Opik graph smoke through an in-memory Opik client.
- `test` checks out the private `marsh` and `junco-policy` beside the repository using read-only deploy-key secrets `JUNCO_MARSH_SSH_KEY` and `JUNCO_POLICY_SSH_KEY`. It runs junco-tools' rustfmt, Clippy and Rust unit tests, builds its production and CopyTree test addons and runs its Node tests, then builds and tests tools → MCP (core and native suites) → engine → agent (including its native MCP suite) → scheduler (full `typecheck` and both suites) → Opik adapter → agency; the agent and scheduler suites run with coverage of their own `src/` (uploaded as the `junco-agent-coverage` and `junco-scheduler-coverage` artifacts). For the agency it runs build, typecheck (the built-package fixture needs the emitted declarations), the deterministic suites with coverage (uploaded as the `agency-coverage` artifact), the deterministic smoke, the offline integration suites, the native policy-yield suite (`bun run test:native`), and the `junco-agency/workflows` smoke under Bun (source entrypoints) and Node (built entrypoints), then checks that the workspace `junco-scheduler` and the agency share one `dataflow-engine` instance under Bun and Node, and runs the relocated `junco-agent` CLI launcher (`--version`).

No Btrfs mount, tracing service, language server, or model credentials are required: native suites run on CopyTree workspaces. Forks and other runs without the deploy-key secrets cannot run the `test` job, so they have no native coverage.

## Usage

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { always, UNBOUNDED } from "dataflow-engine";
import { JuncoAgent } from "junco-agent";
import type { PiScheduler } from "junco-scheduler/agent";
import { createYieldTool } from "junco-tools";
import { type AgenticInput, agentNode, createAgencyScheduler, JuncoGraph, tracer } from "junco-agency";

// Resolve models beforehand; each supplied session transfers to its agent and closes on return().
const sessions = new MemorySessionRepo();
const researcher = await JuncoAgent.fromResolved({
  ...researcherOptions, session: await sessions.create({}, BACKGROUND_CONTEXT),
  tools: [createYieldTool()], prompt: "Find the facts.",
});
const writer = await JuncoAgent.fromResolved({
  ...writerOptions, session: await sessions.create({}, BACKGROUND_CONTEXT), prompt: "Draft the summary.",
});
// With a native `model` the scheduler uses it; without one it is GitHub Copilot `claude-opus-5.5`
// through Pi's saved login (run Pi's /login first).
type Agency = JuncoGraph<AgenticInput, AssistantMessage, unknown, PiScheduler<AgenticInput, AssistantMessage>>;
let current: Agency | undefined; // the scheduler reads its graph through this live getter
const scheduler = await createAgencyScheduler(() => current, {
  ...schedulerOptions, session: await sessions.create({}, BACKGROUND_CONTEXT),
  systemPrompt: "Coordinate the team.", prompt: "Produce the report.",
});
scheduler.events.on("run_end", ({ status }) => { if (status === "failed") console.error("Scheduler run failed"); });
// scheduler.hooks.on("transform_context", handler) registers native request hooks.
// Invalid local arguments/state and overlapping work reject with JuncoAgentError.
await using graph = new JuncoGraph(scheduler, UNBOUNDED, UNBOUNDED, tracer.createTracer()); // disposal closes every member
current = graph;
for (const [agent, description] of [[researcher, "researches"], [writer, "writes"]] as const) {
  graph.addNode(agentNode(agent, { description, trigger: always() }));
}

for await (const step of scheduler) {
  if (step.kind === "yield") continue; // one graph window completed; the next iteration resumes
  console.log(step.kind === "settled" ? step.message : step.error);
  break;
}
// Leaving scope closes the graph: its scheduler and agents, with their sessions.
// The caller owns the repo and closes it afterwards with sessions.close(BACKGROUND_CONTEXT).
```

[`examples/recursive-agency.ts`](examples/recursive-agency.ts) runs a root → child → grandchild agency around a leaf that pauses once, plus a root sibling, entirely offline on faux models. Each scheduler reports only its own completion; the leaf and sibling results are read from the retained graphs.

### OSS committee (live, optionally traced)

[`examples/oss-committee.ts`](examples/oss-committee.ts) is a literate, top-to-bottom junco example and **not** a `PiScheduler` agency: three persistent `JuncoAgent` members run review rounds, each a fresh `createParallelAgentGraph()` graph over the same members, whose sessions keep every earlier round. The Librarian (`claude-opus-5.5`, medium reasoning) uses `search_oss` with generic technical terms rather than the verbatim request; each result reports GitHub stars and last push time alongside the repository URL and reported license. The Architect (`gpt-6-sol`, high) is toolless and designs from the available research; the Reducer (`claude-sonnet-5.5`, xhigh) combines both final reports, records a typed verdict with its `review` tool and produces the **only** titled Markdown plan. A revision request starts another round in which the Librarian continues investigating and the Architect revises its design from the Reducer's feedback; approval — minimal, clean custom code over well-trusted OSS libraries — publishes the plan. There is no round limit, and a round that ends without a verdict fails without publishing. Normally, a value edge gates Architect on a valid successful lookup and a nonempty, normally stopped Librarian report. After a failed lookup in any round, Librarian must call the real `yield` tool with its available public research, the failure and the remaining gaps in the reason. A message edge hands that partial snapshot to Architect while Librarian stays paused. Librarian resumes only after Architect returns, then writes its closing report without further searches. Reducer still waits for both final reports; missing, empty or truncated final reports cannot publish a plan. Returning after a failed lookup without the required yield is rejected rather than silently accepted. `JuncoAgent.create` rejects a reasoning level a model does not support, so no reasoning level is silently downgraded.

Before running the live example, start `pi`, use `/login`, and select GitHub Copilot. The committee shares Pi's `ModelRuntime` and uses the saved login in `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`); Pi handles OAuth refresh. A missing or unusable login fails with instructions to run `/login`, without starting an interactive login or publishing a plan. Environment-only tokens and Copilot CLI credentials do not replace the saved Pi login.

```sh
OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency \
  bun run --feature=opik examples/oss-committee.ts ./request.txt ./plan.md
```

The first argument is a nonblank UTF-8 request file; the optional output defaults to `plan.md` in the current working directory. Existing outputs are rejected before credentials are read, and publication uses exclusive creation (`wx`): a failed/aborted run or concurrent writer cannot overwrite a plan. Each member's exact model ID **and** reasoning level must be in the installed Copilot catalog before its saved login is checked; per-account model access can still fail, with no plan published. Each GitHub lookup returns at most five repository URLs and GitHub-reported metadata, not a bound on the number of requests. The search fetch is unauthenticated; Pi's saved Copilot login authenticates the model runtime, not GitHub repository search. Yield is a scheduling handoff, not an HTTP retry or a quota increase. `incomplete_results=true` means partial research, a valid empty result is reported as no matching library, and a failed lookup remains disclosed as unavailable research. A missing/`NOASSERTION` SPDX identifier means unknown license. GitHub-reported SPDX identifiers, stars and push times do not verify full license terms or quality; versions and API compatibility are likewise unverified. Never place secrets, private identifiers, or private endpoints in a GitHub query or the request/reports exported to a tracer. `convene` flushes the rounds' shared automatic tracer once, and all members close, **before** the approved titled plan is written. A successful `flush()` does not prove ingestion: each review round is one `JuncoGraph.run` trace; inspect its three node results and activation spans in Opik's project → Logs → Traces.

The tool restricts search to GitHub repositories but cannot detect secrets in a model-generated query. Submit only requests safe for public GitHub search and complete tracer export; prompt instructions alone do not enforce that boundary.

### MCP graph (live, optionally traced)

[`examples/mcp.ts`](examples/mcp.ts) runs exactly two `github-copilot/claude-sonnet-5.5` agents on this repository, each with only the tools of its own graft MCP server (`mcp.JuncoMcpTools`, `npx -y @nanonets/graft mcp`). Research maps the repository and selects five central classes; Dependencies receives that report on a value edge and traces all five itself with outbound all-depth `graft_trace_calls`. Both servers run as audited jobs of the process's one Junco ShellMux, so the repository must be inside a Btrfs seed with the production native addon built, and graft's index must be current (`graft build`): graft refreshes the index before a query only when the working tree drifted from the last build, so over a current index its queries write nothing, while two servers refreshing a stale shared index would overlap and Marsh refuses the later publication. The runner closes the graph, flushes the tracer, then calls `tools.shutdownShellMux()`.

```sh
OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency bun run --feature=opik examples/mcp.ts
```

For a scripted end-to-end run with real trace export but no model credentials, start the local service, then run `OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency bun run --feature=opik test/oss-committee.fixture.ts`. The fixture prints the approved plan of one scripted round. `bun test test/oss-committee.test.ts` exercises the same rounds offline with the default `StdoutTracer`; importing the fixture never loads a tracer adapter.

### Yak shaver: in-place refactoring (live)

[`examples/yak-shaver.ts`](examples/yak-shaver.ts) applies generalizing refactors in place to a Graft-indexed Git working tree and stages each one; it writes no report and never commits. It ranks every indexed `class`, `interface`, `type`, `enum`, `struct`, and `trait` (merged with its owned methods) by its longest dependency distance, in strongly-connected-component hops, from the public API (exported AST-origin symbols) or a test path, deepest first and then by ascending positive distinct-caller count; nothing is cut off. A deterministic two-node controller (`RankCandidates → RefactorBatches`) admits four initially ranked candidates at a time, resolved against the current snapshot (a candidate removed by an earlier refactor is reported `removed`). Each batch is one parallel graph of `Proposer:r ==proposal:r==> Judge:r` lanes driven one step at a time; every proposer's native `task` call spawns up to three read-only researchers over far-first file shards, and an independent judge records four criteria. As soon as a lane's review passes all four criteria, adds a caller definition, and removes net nonblank lines, its edits are applied and exactly its paths staged (`git add -- <paths>`) inside one managed command, so the lane's owner releases its own files; applications drain one at a time. After a batch that applied anything, a private, discarded `graft build` refreshes the in-memory snapshot. Every Graft MCP connection is discard-only and lives for one call.

Prerequisites: `graft` 0.21.1-compatible on `PATH` and a current index (`graft build <root>`), the production native addon, the Git working-tree root inside a Btrfs seed, and the Copilot login. The Graft cache is never published: rebuild it before the next run. A later failure keeps earlier applied and staged refactors and says so. `bun test test/yak-shaver.test.ts` exercises ranking, evidence checks, gates, admission, and real four-lane batch graphs with incremental application offline on faux models.

```sh
graft build /path/to/repo
bun run examples/yak-shaver.ts /path/to/repo
```

## API

```ts
type AgenticInput =
  | { readonly kind: "prompt" | "steer" | "followUp" | "nextTurn" | "error"; readonly text: string; readonly images?: ImageContent[] } // error: a failure notification, delivered as a follow-up
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };
// The four node-state kinds; N/T default to the chat wire types and stay overridable.
type Agentic<N = AgenticInput, T = AssistantMessage> = JuncoAgent | JuncoGraph<N, T> | MockAgent | Deterministic<N, T>;
type AgenticNode<N = AgenticInput, T = AssistantMessage> = NodeSpec<Agentic<N, T>, N, T>;

// addNode/addEdge, inspection and results are DataflowGraph's. `tracer` is required; pass
// `tracer.createTracer()` for the feature-selected one (see Tracing).
class JuncoGraph<N = AgenticInput, T = AssistantMessage, EH = unknown, Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>>
  extends DataflowGraph<Agentic<N, T>, N, T, EH, Q> {
  constructor(scheduler: Q, window: Width, threads: Width, tracer: DataflowTracer); // TypeError without a tracer
  readonly tracer: DataflowTracer;
  get signal(): AbortSignal;                 // step()/run() observe it automatically
  abort(reason?: unknown): Promise<void>;    // recursive; a fresh signal once settled
  close(): Promise<void>;                    // recursive and terminal; cached
  [Symbol.asyncDispose](): Promise<void>;    // close()
}

// NodeOptions<N, T> = { id?, description?, trigger, is_available? } comes from "dataflow-engine".
type AgentNodeBinding = {
  readonly prompt?: string; // starts an idle agent on the node's first delivery, after receive's inputs
  readonly receive?: (view: ParentView<AgenticInput, AssistantMessage>) => readonly AgenticInput[]; // omitted: dispatch nothing
  readonly emit?: (step: Extract<AgenticStep, { kind: "yield" }>) => Message<AgenticInput>[]; // omitted: route nothing
};
function agentNode(
  agent: JuncoAgent | MockAgent, options: NodeOptions<AgenticInput, AssistantMessage>, binding?: AgentNodeBinding,
): AgenticNode;
function deterministicNode<N, T>(state: Deterministic<N, T>, options: NodeOptions<N, T>): AgenticNode<N, T>;
type GraphNodeBinding<N = AgenticInput, T = AssistantMessage> = {
  readonly result: NodeId; // the registered child node whose result this node returns
  readonly receive?: (view: ParentView<N, T>) => void | Promise<void>;
  readonly afterStep?: () => void | Promise<void>;
};
function graphNode<N, T, EH, Q extends DataflowScheduler<N, T>>(
  graph: JuncoGraph<N, T, EH, Q>, options: NodeOptions<N, T>, binding: GraphNodeBinding<N, T>,
): AgenticNode<N, T>;

class Deterministic<N = AgenticInput, T = AssistantMessage> implements NodeGenerator<N, T> {
  constructor(body: (signal: AbortSignal) => NodeGenerator<N, T>);
  readonly signal: AbortSignal;
  readonly step: () => NodeGenerator<N, T>; // hands out this coroutine once
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
}
class MockAgent<S, P, T> implements Agentic<S, P, T> /* junco-agent's protocol */ {
  constructor(transcript: MockTranscript<S, P, T>);
}

// Every available node runs in each window: junco-scheduler's parallel policy, Width(1), UNBOUNDED.
function createParallelAgentGraph<N = AgenticInput, T = AssistantMessage>(tracer: DataflowTracer = createTracer()): JuncoGraph<N, T>;

// graph.Spawn (namespace-only): a createParallelAgentGraph holding `root` plus one child per input,
// built by `spawn` in order. Each child gets two fresh message edges, `${rootId}->${childId}` and
// `${childId}->${rootId}`; children are never linked. Construction only wires queues: members send
// and consume messages through their own triggers and yields. Ids are the ones `addNode` returns.
// Factory/registration errors propagate synchronously; already-created members stay caller-owned.
function Spawn<T, N = AgenticInput, R = AssistantMessage>(
  root: AgenticNode<N, R>,
  inputs: readonly T[],
  spawn: (input: T) => AgenticNode<N, R>,
): JuncoGraph<N, R>;

// PiScheduler, PiSchedulerOptions, SchedulerInfo and ScheduleTool come from "junco-scheduler/agent";
// the agency supplies the scheduler's adapter itself. A defined `model` selects PiScheduler.make
// (requiring model, models and session); otherwise PiScheduler.opus selects Copilot Opus 5.5.
function createAgencyScheduler<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate, N = AgenticInput, T = AssistantMessage>(
  getGraph: () => JuncoGraph<N, T> | undefined,
  options?: Omit<PiSchedulerOptions<N, T, S, P>, "adapter">,
): Promise<PiScheduler<N, T, S, P>>;

type CompactionPolicy =
  | "all"                        // every node
  | "more-than-forty"            // every node, context > 40% of window
  | "all-available"              // nodes in one graph.available() snapshot
  | "more-than-forty-available"; // available nodes, context > 40% of window
// await compactGraph(graph, "more-than-forty-available");
function compactGraph<A extends Agentic<N, T>, N, T, EH, Q extends DataflowScheduler<N, T>>(
  graph: DataflowGraph<A, N, T, EH, Q>, policy: CompactionPolicy,
): Promise<void>;
// JuncoAgent.fromResolved(options): Promise<JuncoAgent<...>>; its constructor is protected.
// agent.events.on("tool_end", handler) and agent.hooks.on("before_request", handler)
// use the native event/hook surfaces. Local invariant failures throw JuncoAgentError.
```

Every kind registers with the engine's own `NodeOptions`; execution-only settings live in the separate binding argument and never become node state. An explicit `options.is_available` replaces a helper's default availability exactly like a native `NodeSpec` hook. `description` is optional for every kind and stays on the native node (`graph.getNode(id).description`). Node state is the original instance, except for an `agentNode` whose agent called `task` (below): narrow `graph.getNode(id)!.state` with `instanceof` before using kind-specific methods.

**Subagents.** A `JuncoAgent` driven by `agentNode` can call the `task` tool (`tools.createTaskTool()`, included in `JuncoAgent.create`'s default tools). The call acquires one fresh subagent per task through `createSubagents` (inheriting the caller's model, active tools and registered MCP definitions unless the task narrows them), returns their handles immediately and pauses the caller at the end of its tool batch. At that pause the node's `state` becomes a `graph.Spawn` graph whose `"root"` node is the same running caller and whose children (node id = handle id, `description` = task name) run the subagents; the node keeps its id, trigger, edges, `receive`/`emit` binding and seen values, and steps that graph once per activation. Each child starts from its prompt on `root-><id>` and sends one final report, `{"type":"task_result","id","name"?,"status":"completed"|"failed","output","stopReason","error"?}`, back on `<id>->root`; the caller receives each report as a follow-up while it keeps working, and is prompted again (`Process the queued task reports.`) if it already answered. The node returns the caller's answer only after every report entered its context and was answered. Later task calls add siblings under the same root; a child's own task call nests a Spawn graph in that child's node. Close and abort reach every member through the graph cascade.

**Task failures.** A failed report travels as `{ kind: "error" }` on `<id>->root`; a completed one as `{ kind: "followUp" }`; the caller receives both as follow-ups. A genuine assistant error stop keeps its real output and stays the child's node result. A child whose run throws instead (a failed native boundary, a hook error) is recovered through the engine's `on_error` hook: its subagent, or the Spawn graph it expanded into after cancelling that graph's blocked descendants, is closed, and exactly one report `{ status: "failed", output: "", stopReason: "error", error }` is queued, where `error` lists every distinct error in the cause chain, cleanup failures included. The child node ends `done` with no result, the caller still has to answer the report before its node returns, and closing the owning graph does not rethrow a teardown failure already reported. Ordinary `agentNode`s have no such hook: a thrown failure still rejects the drive.

**Complaints.** Every `JuncoAgent` has an always-on `complain` tool (see `junco-agent`). While `agentNode` drives an agent, a complaint is recorded in the shared `tools.issueLog` (also `graph.issueLog` and `agent.issueLog`, all the same object) with that node's ID, the messages delivered to the current activation (`{ id: edge, payload }`, in edge order), the full model request and the complaint, and is reported to `tracer.complain(nodeId, complaint)` of the graph the node was registered in. After a task expansion the caller's complaints use its Spawn graph's `"root"` node and tracer; each child uses its task handle ID. `MockAgent.complain(issue, tracer?)` appends a supplied issue to the same log.

### Standard library namespaces

The root entry also re-exports the standard library for building junco workflows as namespaces, beside the flat agency exports above:

| Namespace | Contents | Source |
|---|---|---|
| `graph` | `DataflowGraph`, `JuncoGraph`, `createParallelAgentGraph`, `Spawn`, edges (`messageEdge`, `valueEdge`, `msg`, `from`), `NodeId`/`EdgeId`, `Width`/`UNBOUNDED`, `Queue`, `renderPretty`, the definition/node errors, and the node/edge types | `dataflow-engine`, this package |
| `graph.nodes` | Node constructors: `ConstFanout`, `ConstFanin`, `stepNode`, `emitOnce`, `agentNode`, `graphNode`, `deterministicNode`, `Deterministic`, and the `Agentic`/`AgenticInput`/`AgenticNode` types | `dataflow-engine`, this package |
| `trigger` (also `graph.trigger`) | `TriggerRule`, `TriggerEntry` and `TriggerKind` (`"all"` or `"any"`); rules `allOf(...)`, `anyOf(...)`, `when(edge)`, `always()`, `never()`; entries `on(edge)`, typed by their edge's message and result payloads; `evaluateTrigger`, `satisfiedEdges` | `dataflow-engine` |
| `agent` | `JuncoAgent`, `JuncoAgentError`, and the `Agentic` protocol types | `junco-agent` |
| `tools` | Everything `junco-tools` exports: `ToolCollection`, `LspTool`, the `create*Tool` factories, `createYieldTool`/`isYieldTool`, `createTaskTool`/`isTaskTool`/`invokeTaskTool`, the always-on `createComplainTool`/`isComplainTool`/`invokeComplainTool` with the shared `issueLog` and its `Issue`/`Prompt` types, ShellMux operations, the Marsh policy-denial check, and the type-only `NativeModule`, `NativeMux` and `EditStore` contracts | `junco-tools` |
| `schedulers` | `createScheduler`, `createParallelScheduler`, `createRoundRobinScheduler`, `PiScheduler`, `createAgencyScheduler`, the `DataflowScheduler` contract and its schedule types, `triggerInputs` | `junco-scheduler`, `dataflow-engine`, this package |
| `compaction` | `CompactionPolicy`, `compactGraph` | this package |
| `tracer` | `DataflowTracer`, `DataflowRunTrace`, `DataflowStepTrace`, the no-op `DummyTracer`, `StdoutTracer`, and `createTracer` (the feature-selected shared tracer) | `dataflow-engine`, this package |

```ts
import { graph, schedulers, tracer, trigger } from "junco-agency";

const g = new graph.DataflowGraph(schedulers.createParallelScheduler(), graph.Width(1), graph.UNBOUNDED, new tracer.DummyTracer());
const a = graph.messageEdge<number, string>("a");
const source = g.addNode(graph.nodes.ConstFanout(7, [a], { state: undefined, ret: "sent" }));
const sink = g.addNode({ state: undefined, trigger: trigger.allOf(trigger.on(a)), step: graph.nodes.stepNode(() => []) });
g.addEdge(source, sink, a);
```

A generic `DataflowGraph`'s tracer stays optional: pass a `tracer.DataflowTracer` (for example `OpikDataflowTracer` from the `dataflow-engine-opik` workspace package, or `tracer.StdoutTracer`) as its fourth argument, or omit it to run untraced. A `JuncoGraph` always takes one (see [Tracing](#tracing-local-only)). The Opik adapter is not re-exported, because `dataflow-engine-opik` and `opik` are optional peers.

### Prompt agents: `agentNode`

- A node drives its member through **one** run. The body first yields nothing, so the engine's priming consumes no input. Each later activation hands `receive` the delivered message batch and only the parent results it has not seen before (each result is presented once), and dispatches the returned inputs in order through the native method of the same name: a `prompt` starts without being awaited, and every queue or session input is awaited. On the node's first delivery, its own `prompt`, if given, is dispatched once after `receive`'s inputs. Once the run has started, the activation calls `agent.next()` exactly once: a `yield` step routes `emit`'s messages and leaves the member paused, a settled step returns the member's native final message (including `error`/`aborted` stop reasons) as the node's result, and a failed step fails the node with the original error.
- Before its run starts, a member is available only when its trigger fires and it has a staged prompt, its node's own `prompt` while idle, or fresh input; a member with none is quiescent. A delivery with only controls leaves it idle and yields nothing. A second prompt — including a received or node prompt conflicting with a staged prompt — fails the node with `invalid_state`. A member iterator that ends before its run settles (the member was closed) fails the node with `closed`. Once started, a member stays available until its run settles, even if its trigger was drained.
- One member can run in successive graphs, each node with its own `prompt`; its session keeps every earlier run.
- A finished node keeps its agent alive and usable until a graph containing it closes.

### Nested graphs: `graphNode`

- The node's state is the child graph itself. Its body first yields nothing; every later activation calls `receive` with the delivered batch and only unseen parent results, then advances the child once: a policy-scheduled child takes one `child.step()`, a `PiScheduler` child one `scheduler.next()`. After each successful advance `afterStep` runs, then the node completes with `child.result(binding.result)` once a policy child is quiescent, or once a Pi child settled with stop reason `stop` and nothing available; otherwise it yields nothing and stays resumable. A selected `undefined` is a real result.
- `binding.result` must name a registered child node (`DataflowDefinitionError` otherwise). A quiescent child without that result fails with `invalid_state`; so do an idle Pi scheduler without a staged prompt (unless it already settled with the result retained), a non-`stop` settlement, and a normal settlement with graph work still available. A closed scheduler fails with `closed`. Cancellation through the child's signal wins over any result. By default the node is available once started or whenever its trigger fires.
- A nested node has no return-only message output. To send messages on its parent's outgoing edges, call the parent's inherited `graph.emit(nestedNodeId, msg(edge, payload))` from `afterStep`; on the completing activation the messages are queued before the node's result is published, in the same parent step. The `ralph` workflow sends only its final round this way.

### Workflows: `junco-agency/workflows`

- `ralph(parent, agent, { id?, description?, input, output, rounds? })` registers one node in `parent` and returns its id. The node's state is a nested one-worker `JuncoGraph` whose worker's state is the supplied native `JuncoAgent`, so closing `parent` closes both. `input` and `output` are caller-owned message edges; wire them to the returned id before driving, and read the final `AssistantMessage` with `parent.result(id)`. Registration makes no model request; omitted ids are engine-generated, so several workflows coexist in one parent.
- `rounds` defaults to `2` and must be a positive safe integer; anything else throws `RangeError` before anything is registered. The first round prompts the exact assignment; every later round prompts the assignment plus the immediately preceding complete draft, in the same session. Native yields resume within a round and never count as one.
- The node expects exactly one text `prompt` on `input` (no images); a second assignment, any other input kind, or a nonempty `images` array fails the node. Each round must settle with stop reason `stop` and nonempty text; otherwise the node fails and nothing is published. A non-idle agent fails with `invalid_state`; cancellation through the nested graph's signal wins.
- Only the final round's trimmed text is emitted, once, as `{ kind: "prompt", text }` on `output`, in the same parent step that publishes the node's result. `examples/mixed.ts` uses it with `rounds: 2`.
- The agent is lent exclusively to the workflow while it runs: do not drive or reconfigure it concurrently.

### Coroutines: `Deterministic` and `deterministicNode`

- `new Deterministic(body)` invokes `body(signal)` once; the generator speaks the engine's own protocol (dependent bodies start with `let view = yield []`, sources may emit immediately) and its closure holds any state. `step()` hands the coroutine to one consumer only; a second registration or a direct advance before it fails with `invalid_state`, and advancing a finished coroutine fails with `invalid_state`.
- `abort(reason)` aborts `signal` and joins the advance in flight; a rejection with exactly that reason is cancellation. `close()` (and async disposal) is cached: it signals pending work, joins it, then drains the generator through `return()`, discarding cleanup batches; later advances reject with `closed`, and an advance in flight when close began rejects with the signal's reason rather than publishing cleanup output. A sole cleanup error rejects as itself, several as `AggregateError("Deterministic close failed")`. Bodies that ignore their signal cannot be preempted.

### Scheduling: `createAgencyScheduler`

- The scheduler is `junco-scheduler`'s `PiScheduler`: `PiScheduler.make` when a native `model` is given, otherwise `PiScheduler.opus` (GitHub Copilot `claude-opus-5.5` through Pi's saved login; a missing model or login fails with `JuncoAgentError`, without fallback). Both factories take the same `PiSchedulerOptions`: `make` rejects with `invalid_argument` unless `model`, `models` and `session` are all given, while `opus` ignores a supplied `model` and checks saved logins only on a model collection that can list them (a bare native collection fails its login check). Its only tool is `schedule({ lanes })`, frozen with its schema; `setTools` and `setActiveTools` accept nothing else. Its instructions are appended to the caller's `systemPrompt` (a callback keeps native `this` and context).
- Every request ends with a transient `SchedulerInfo:` user message, never persisted or emitted: the window/thread bounds and only the currently available nodes, each with its node status and `details` — its native `description` when present, plus a prompt agent's status and latest pause reasons. Unavailable or finished nodes, results and edges are never shown; a node's absence, or a quiescent snapshot, proves neither completion nor any output. The graph's owner reads node results with `graph.result(id)`.
- The scheduler reads its graph through the live `getGraph` getter. Before every snapshot, run admission and window it requires a constructed graph driven by this scheduler (`invalid_state` otherwise, before any provider call). Nodes and edges may be added at any time; there is no topology snapshot.
- Lanes run concurrently; position `k` of every lane forms column `k`, which starts after column `k - 1` finishes. A ready member's first occurrence only primes it. Only ids available when the window starts may be planned, within `threads` lanes and `window` columns; the engine validates the whole plan before anything runs, and later columns skip members that finished or went idle. Reads follow each member's trigger: `allOf` reads everything or nothing, and `anyOf` prefers an input over an already delivered parent result.
- Each successful call runs exactly one graph window, returns a fresh `SchedulerInfo`, and pauses the scheduler's run at that window boundary. More than one `schedule` call in a response rejects all of them before any graph work; invalid plans and nonempty plans with nothing available are ordinary tool errors; an empty plan with nothing available just returns `SchedulerInfo`. Nothing is retried or replayed automatically.
- A normally finishing run is accepted only when no graph work remains available and observed work was scheduled; otherwise it fails with `invalid_state`. A member failure fails the run with the original `DataflowNodeError` even if the model then answers normally. `error`/`aborted` final messages and stopping runs pass through unchanged.

### Lifecycle: `JuncoGraph`

- `step()`/`run()` observe `graph.signal` without any argument; a distinct caller `signal` still cancels only that invocation. Cancellation is cooperative between columns and inside bodies that watch their signal; a cancelled drive rejects with the reason or a `DataflowNodeError` caused by it.
- `abort(reason)` snapshots membership recursively (nested graphs, each graph's `PiScheduler` before its members, agents and coroutines; shared or cyclic states once), starts every non-closed agent's or scheduler's native `abort()` and every coroutine's `abort(reason)` synchronously, then aborts each visited graph's signal with the same reason. It settles when they all do, failures rejecting as one ordered `AggregateError("Graph abort failed")`, and then gives each nonterminal graph a fresh signal. A pending abort is joined; a closed graph rejects `closed`.
- `close()` is terminal and cached, including its failure: agents, schedulers and coroutines are closed through their `Symbol.asyncDispose` — so a subclass's own async disposal and the cleanup it awaits are joined — never a separate abort; every visited graph's signal aborts with one `Graph closed` reason. Later drives reject, results stay readable, and `await using` closes on scope exit. Abort and close are stack-safe at any finite depth.
- An agency scheduler's own `abort()`/`return()` cascades through its graph's members the same way, excluding itself; a later `graph.close()` joins that native close. Lifecycle promises join resource lifecycles, not arbitrary node-body awaits; callers observe their run promises separately.

### Context compaction: `compactGraph`

- Every prompt agent reports `context_size()`, an estimate of its current conversation's tokens, and `compact()`, which queues Pi's compaction after any admitted run and resolves to `undefined`. `compactGraph(graph, policy)` applies `compact()` to the direct `JuncoAgent`/`MockAgent` node states of any graph; nested graphs and coroutines are skipped, never compacted recursively. It never runs the graph or consumes messages or results, and a scheduler is compacted only when it is itself a node. A policy outside `CompactionPolicy` rejects with `invalid_argument` before the graph is inspected.
- `"all"` and `"more-than-forty"` consider every node, finished or unavailable included; `"all-available"` and `"more-than-forty-available"` take one `graph.available()` snapshot. Selection happens when `compactGraph` is called; later readiness or topology changes do not alter it.
- Threshold policies read each candidate's `context_size()` and `getModel()` once and select members holding strictly more than 40% of their model's `contextWindow`. A member whose model or window is missing, non-finite or not positive rejects the compaction with `invalid_state` before any request is made.
- Each selected member gets one request, all dispatched without waiting for one another; every request finishes, and failures reject as one `AggregateError("Graph compaction failed")` in node order, keeping each member's original error — a member closed while its compaction is pending or accepted contributes its `closed` error. Successful members stay compacted.
- A member with an admitted run compacts only after that run ends; a held yield keeps its compaction pending. Keep driving the graph (or agency) while awaiting the compaction, or await it before driving an unstarted graph. While a member's compaction is pending, its new prompts and navigation are `busy` and its staged prompt waits, so a staged member can drop out of `available()` until then.

## Verification

`bun run test` is the deterministic default suite, run by CI with coverage (`bun run test:coverage`, LCOV at `coverage/lcov.info`, uploaded by the `test` job as the `agency-coverage` artifact; it reports agency `src/` only). Each package's implementation is tested by its own suite: `dataflow-engine` (`tests/`, graph/trigger/scheduler/tracer/primitives), `junco-scheduler` (`test/scheduler.test.ts` core, `test/pi-scheduler.test.ts` Pi adapter), `junco-agent` (`test/junco-agent.test.ts`) and `junco-tools` (`tests/*.test.mjs` under Node). The agency's own suites do not repeat them; `test/std-namespaces.test.ts` composes the root `graph`, `schedulers`, `tracer` and `trigger` namespaces into one fan-out/fan-in graph, and `test/agentic.types.ts` plus `test/std-namespaces.types.ts` (root `bun run typecheck`) compile every exported type as a consumer contract. Its prompt agents are `MockAgent`s (exported from `src/mock-agent.ts`): an `Agentic` that replays one constant transcript — scripted yields, terminals, hook results, events and maintenance records — with `JuncoAgent`'s status, admission, queue, iterator, abort and close semantics, and no provider, harness, tool or session. `test/mock-agent.test.ts` checks that complete surface. `test/agent-node.test.ts` and `test/deterministic-agency.test.ts` run real `JuncoGraph`s of mock agents, `Deterministic` coroutines and nested graphs on `junco-scheduler`'s `createRoundRobinScheduler` (`Width(1)` × `Width(1)`) and `createParallelScheduler` (`Width(1)` × `UNBOUNDED`): the prompt-agent adapter, value-once priming, all five dispatched methods, single-prompt and close failures, suspended continuation, `anyOf`/`allOf` reads, shared `NodeOptions` availability across kinds, nested-graph completion, result selection and captured-signal cancellation, both policies' window contracts, recursive abort/close over cyclic and shared graphs, graph-signal cancellation, close-once and failed-close reuse, and 4096-deep nesting. `test/deterministic.test.ts` covers the coroutine's cooperative abort, close draining, direct `return`/`throw`, async iteration, single-consumer and finished guards. `bun run smoke` runs `test/deterministic-agency.fixture.ts` (one producer/worker graph per policy, closed through `graph.close()`) and prints:

```json
{"scheduler":"round-robin","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
{"scheduler":"parallel","producer":"seed","worker":"done","inputs":["upstream: seed","context first","then work"],"closed":true}
```

The default suite also runs `test/compaction.test.ts`: each policy's selection over one real graph with available, trigger-blocked, availability-rejected and completed members; the strict 40% threshold; unknown policies and unknown context windows rejecting before any change; available-only policies never measuring unavailable members; invocation-time snapshots; a later member compacting while an earlier one is still yielded; and ordered failure aggregation. The native adapter's context sizing and deferred compaction are covered by `junco-agent`'s own suite.

`test/stdout-tracer.test.ts` (also in the default suite) runs real graphs in Bun subprocesses: Unicode drawings of escaped labels, parallel edges, self-loops, nested, shared, empty and recursive subgraphs and a 40-node chain; full, snapshotted payloads (BigInts, cycles, long arrays and strings) without application getters; activation errors, handled recoveries, run failures and rendering diagnostics; per-invocation blocks and shared-tracer settlement order; required `JuncoGraph` tracers, Ralph's inherited tracer, and `createTracer()` selecting `StdoutTracer` or, under `--feature=opik`, one shared `OpikDataflowTracer`.

The mock replays Agentic interactions; it does not simulate provider reasoning, native policy denial or tool execution. Those, and the Pi scheduler itself, are covered by separately runnable suites; CI runs `test:integration`, `test:native` and both workflow smokes, but not `smoke:pi`:

- `bun run test:integration` (offline, faux providers): the real `PiScheduler` factories and Opus acquisition from a fixture login, the live graph getter, candidate-only `SchedulerInfo` with native descriptions, schedule-tool plans, input fairness, nested Pi graphs, 32-level recursive driving, abort/close cascades, the OSS committee, the mixed example, and the `ralph` workflow (`test/ralph-workflow.test.ts`: default and configured round counts, final-only publication timing, assignment protocol, failed rounds, native yields, idle admission, cancellation, and isolation of several workflows in one parent). `bun test test/oss-committee.test.ts` runs twelve network-free committee tests with injected GitHub responses: value-edge gating within a round, failed-lookup yield handoff before Librarian resumes, success followed by failure, truncated final reports before and after handoff, valid empty search, approval guards, scoped/malformed search metadata and GitHub trust signals, revision rounds that route the Reducer's feedback to Librarian and Architect until approval, a round without a verdict, and a failed lookup followed by a normal round. The scripted fixture can export to a running Opik service (`OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency bun run test/oss-committee.fixture.ts`); separately inspect actual trace ingestion in the Opik UI. Neither those offline tests nor `flush()` prove live GitHub access, Copilot entitlement, or Opik ingestion.
- `bun run smoke:workflows` (after `bun run build`) runs `test/workflows.fixture.ts` under Node's TypeScript stripping against the built `junco-agency` and `junco-agency/workflows` entrypoints, and `bun run smoke:workflows:bun` runs it under Bun against the source entrypoints. Using the root `agent`, `tools`, `graph` and `trigger` namespaces, it first checks a tool created by `tools.createYieldTool()`: `turn_end` subscribers see its successful result before `JuncoAgent` suspends, only the next explicit `next()` resumes the run, and `return()` closes it terminally. It then runs a three-round Ralph over a native agent on a faux model, checking that the nested graph is the root bundle's `JuncoGraph` and that closing the parent closes it and the agent. Both print `{"rounds":3,"delivered":["draft-3"],"sharedGraphIdentity":true,"closed":true}`.
- `bun run smoke:pi` runs the offline recursive Pi example: it prints its `StdoutTracer` trace, then `root complete; leaf-result + sibling-result; 8 root windows`.
- `bun run test:native` runs `test/policy-yield.test.ts`, which uses junco-tools' real Marsh policy through the CopyTree native test addon (see Setup): denied `edit`, applying `ast_edit`, and `bash` calls pause in source order without publishing edits or starting a second model request until resumed. A failed native test is not evidence of a passing policy boundary, and the deterministic policy-reason scenario does not prove native enforcement.
- `bun run test:all` runs all three suites. The build can be loaded under Node.js with `node --input-type=module -e 'await import("./dist/index.js")'`.
