# junco-agency

Recursive Pi agencies. `attachAgency(graph)` returns the graph's original `PiScheduler` as an `Agentic`: a cooperative scheduling iterator backed by Pi's native `AgentHarness.create` ([`junco-agent`](../junco-agent)). Its model runs a [`dataflow-engine`](../dataflow-engine) graph of `Agentic` members, `JuncoAgent` leaves or attached schedulers, through its only tool, `schedule`: one bounded graph window per call. Nesting needs neither flattening nor a forwarding object.

## Setup

Requirements: Linux x86-64 with glibc, Node.js `>=22.19.0`, Bun `1.4.2`, and Rust `1.95.0` plus native build libraries for `junco-tools`. Keep the `marsh`, `junco-policy`, `junco-tools`, `dataflow-engine`, `dataflow-engine-opik`, and `junco-agent` checkouts alongside this repository. Build in dependency order (tools → engine → Opik tracer → agent → agency):

```sh
(cd ../junco-tools && npm ci && npm run build && npm run build:native:test)
(cd ../dataflow-engine && bun install --frozen-lockfile && bun run build)
(cd ../dataflow-engine-opik && bun install --frozen-lockfile && bun run build)
(cd ../junco-agent && bun install --linker hoisted --frozen-lockfile && bun run build)
```

Then, from this repository:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run smoke
```

- Keep the checked-in locks and Bun `file:` sibling links. The root's isolated linker snapshots built sibling artifacts at install time; build each upstream sibling before installing its downstream consumer, and reinstall a consumer after rebuilding an upstream sibling. The agent uses Pi `0.99.2`'s native `AgentHarness` adapter; no Pi patch or fork is installed.
- Bun `1.4.2`'s `bun update` may fail to resolve nested linked development/workspace paths; this does not invalidate a successful frozen-lockfile install. Use the checked-in lockfiles for reproducible installs rather than editing consumers' dependencies to work around that update limitation.
- `test/policy-yield.test.ts` loads `../junco-tools/target/native-test/index.js`, built by `npm run build:native:test`.

## CI

GitHub Actions checks out the private `marsh`, `junco-policy`, `junco-tools`, `dataflow-engine`, `dataflow-engine-opik`, and `junco-agent` siblings using read-only deploy-key secrets `JUNCO_MARSH_SSH_KEY`, `JUNCO_POLICY_SSH_KEY`, `JUNCO_TOOLS_SSH_KEY`, `JUNCO_DATAFLOW_SSH_KEY`, `JUNCO_DATAFLOW_OPIK_SSH_KEY`, and `JUNCO_AGENT_SSH_KEY`. Provision the Opik-tracer key for that private checkout. CI builds tools → engine → Opik tracer → agent → agency, installing each Bun project with its frozen lockfile after its upstream `file:` dependencies are built. It runs offline unit suites, typechecks/builds, and the recursive smoke; no Btrfs mount, Opik service, or model credentials are required.

## Usage

```ts
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { always, DataflowGraph, UNBOUNDED } from "dataflow-engine";
import { createYieldTool, JuncoAgent } from "junco-agent";
import { type AgencyGraph, agentNode, attachAgency, PiScheduler } from "junco-agency";

// Resolve models beforehand; each supplied session transfers to its agent and closes on return().
const sessions = new MemorySessionRepo();
const researcher = await JuncoAgent.fromResolved({
  ...researcherOptions, session: await sessions.create({}, BACKGROUND_CONTEXT),
  tools: [createYieldTool()], prompt: "Find the facts.",
});
const writer = await JuncoAgent.fromResolved({
  ...writerOptions, session: await sessions.create({}, BACKGROUND_CONTEXT), prompt: "Draft the summary.",
});
const scheduler = await PiScheduler.make({
  ...schedulerOptions, session: await sessions.create({}, BACKGROUND_CONTEXT),
  systemPrompt: "Coordinate the team.", prompt: "Produce the report.",
});
scheduler.events.on("run_end", ({ status }) => { if (status === "failed") console.error("Scheduler run failed"); });
// scheduler.hooks.on("transform_context", handler) registers native request hooks.
// Invalid local arguments/state and overlapping work reject with JuncoAgentError.
const graph: AgencyGraph = new DataflowGraph(scheduler, UNBOUNDED, UNBOUNDED);
for (const [agent, description] of [[researcher, "researches"], [writer, "writes"]] as const) {
  graph.addNode(agentNode(agent, { description, trigger: always(), receive: () => [], emit: () => [] }));
}
const agency = attachAgency(graph); // wire every member and edge before attaching

for await (const step of agency) {
  if (step.kind === "yield") continue; // one graph window completed; the next iteration resumes
  console.log(step.kind === "settled" ? step.message : step.error);
  break;
}
await agency.return(); // closes the scheduler and its member sessions
await sessions.close(BACKGROUND_CONTEXT); // the caller owns the repo; agents owned its sessions
```

[`examples/recursive-agency.ts`](examples/recursive-agency.ts) runs a root → child → grandchild agency around a leaf that pauses once, plus a root sibling, entirely offline on faux models.

### OSS committee (live, traced)

[`examples/oss-committee.ts`](examples/oss-committee.ts) is **not** a `PiScheduler` agency: three one-shot `JuncoAgent` specialists run on a direct `ReadyScheduler` graph. The Librarian (`claude-opus-5.5`, medium reasoning) is instructed to use `search_oss` with generic technical terms rather than the verbatim request; the Architect (`gpt-6-sol`, high) chooses boundaries from the complete sourced report; the Reducer (`claude-sonnet-5.5`, xhigh) combines both reports and produces the **only** titled Markdown plan. The graph's value edges gate Architect on a valid successful lookup and a complete normally stopped Librarian report, and Reducer on both complete normally stopped reports. Missing, empty, or truncated reports fail rather than becoming input to downstream members. No model aliases or silent reasoning-level downgrades are used.

Before running the live example, start `pi`, use `/login`, and select GitHub Copilot. The committee shares Pi's `ModelRuntime` and uses the saved login in `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`); Pi handles OAuth refresh. A missing or unusable login fails with instructions to run `/login`, without starting an interactive login or publishing a plan. Environment-only tokens and Copilot CLI credentials do not replace the saved Pi login.

```sh
OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency \
  bun run examples/oss-committee.ts ./request.txt ./plan.md
```

The first argument is a nonblank UTF-8 request file; the optional output defaults to `plan.md` in the current working directory. Existing outputs are rejected before credentials are read, and publication uses exclusive creation (`wx`): a failed/aborted run or concurrent writer cannot overwrite a plan. The installed Copilot catalog must contain all three exact model IDs **and** their reasoning levels before the saved login is checked; per-account model access can still fail, with no plan published. The Librarian's bounded search returns at most five repository URLs and GitHub-reported metadata: `incomplete_results=true` means partial research, an empty result is reported as no matching library, and a missing/`NOASSERTION` SPDX identifier means unknown license. GitHub-reported SPDX identifiers do not verify full license terms; versions and API compatibility are likewise unverified. Never place secrets, private identifiers, or private endpoints in a GitHub query or the request/reports exported to Opik. All members close and the tracer flushes **before** the Reducer's completed titled plan is written. A successful `flush()` does not prove ingestion: inspect the three node results and activation spans in Opik's `junco-agency` project → Logs → Traces → `examples/oss-committee`.

The tool restricts search to GitHub repositories but cannot detect secrets in a model-generated query. Submit only requests safe for public GitHub search and complete Opik export; prompt instructions alone do not enforce that boundary.

For a scripted end-to-end run with real Opik export but no model credentials, start the local Opik service, then run `OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency bun run test/oss-committee.fixture.ts`. The fixture prints its new output path and complete plan. `bun test test/oss-committee.test.ts` exercises the same graph offline with `DummyTracer`; importing the fixture never constructs an Opik client.

## API

```ts
type AgenticInput =
  | { readonly kind: "prompt" | "steer" | "followUp" | "nextTurn"; readonly text: string; readonly images?: ImageContent[] }
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };
type AgencyGraph<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate> =
  DataflowGraph<Agentic, AgenticInput, AssistantMessage, unknown, PiScheduler<S, P>>;

function agentNode(agent: Agentic, options: {
  readonly id?: NodeId;
  readonly description: string; // shown to the scheduler
  readonly trigger: TriggerRule<AgenticInput, AssistantMessage>;
  readonly receive: (view: ParentView<AgenticInput, AssistantMessage>) => readonly AgenticInput[];
  readonly emit: (step: Extract<AgenticStep, { kind: "yield" }>) => Message<AgenticInput>[];
}): NodeSpec<Agentic, AgenticInput, AssistantMessage>;

class PiScheduler<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>
  extends JuncoAgent<S, P, ScheduleTool> implements DataflowScheduler<AgenticInput, AssistantMessage> {
  static make<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>(
    options: PiSchedulerOptions<S, P>,
  ): Promise<PiScheduler<S, P>>;
  protected constructor(options: PiSchedulerOptions<S, P>);
}
// JuncoAgent.fromResolved(options): Promise<JuncoAgent<...>>; its constructor is protected.
// agent.events.on("tool_end", handler) and agent.hooks.on("before_request", handler)
// use the native event/hook surfaces. Local invariant failures throw JuncoAgentError.
function attachAgency<S extends Skill, P extends PromptTemplate>(graph: AgencyGraph<S, P>): PiScheduler<S, P>;
```

### Members: `agentNode`

- A node drives its member through **one** run. The body first yields nothing, so the engine's priming consumes no input. Each later activation hands `receive` the delivered message batch and only the parent results it has not seen before (each result is presented once), and dispatches the returned inputs in order through the native method of the same name: a `prompt` starts without being awaited, and every queue or session input is awaited. Once the run has started, the activation calls `agent.next()` exactly once: a `yield` step routes `emit`'s messages and leaves the member paused, a settled step returns the member's native final message (including `error`/`aborted` stop reasons) as the node's result, and a failed step fails the node with the original error.
- Before its run starts, a member is available only when its trigger fires and it has a staged prompt or fresh input; a member with neither is quiescent. A delivery with only controls leaves it idle and yields nothing. A second prompt — including one conflicting with a staged prompt — fails the node with `invalid_state`, as does a member iterator that ends before its run settles. Once started, a member stays available until its run settles, even if its trigger was drained.
- A finished node keeps its member alive and usable until the owning agency closes.

### Scheduling: `PiScheduler`

- Its only tool is `schedule({ lanes })`, frozen with its schema; `setTools` and `setActiveTools` accept nothing else. Its instructions are appended to the caller's `systemPrompt` (a callback keeps native `this` and context). Every request ends with a transient `GraphInfo:` user message — a JSON snapshot of nodes (description, status, member status, availability, last pause reasons, result text) and edges — that is never persisted or emitted.
- Lanes run concurrently; position `k` of every lane forms column `k`, which starts after column `k - 1` finishes. A ready member's first occurrence only primes it. Only ids available when the window starts may be planned, within `threads` lanes and `window` columns; the engine validates the whole plan before anything runs, and later columns skip members that finished or went idle. Reads follow each member's trigger: `allOf` reads everything or nothing, and `anyOf` prefers an input over an already delivered parent result.
- Each successful call runs exactly one graph window, returns a fresh `GraphInfo`, and pauses the scheduler's run at that window boundary. More than one `schedule` call in a response rejects all of them before any graph work; invalid plans and nonempty plans with nothing available are ordinary tool errors; an empty plan with nothing available just returns `GraphInfo`. Nothing is retried or replayed automatically.
- A normally finishing run is accepted only when no graph work remains available and observed work was scheduled; otherwise it fails with `invalid_state`. A member failure fails the run with the original `DataflowNodeError` even if the model then answers normally. `error`/`aborted` final messages and stopping runs pass through unchanged.

### Attachment and ownership: `attachAgency`

- Attachment validates the graph's whole direct membership before claiming any of it: every node must come from `agentNode`; no member may repeat or belong to another agency; a `PiScheduler` member must be different from the graph's own scheduler and already attached; every member must be `ready` or `idle`. The scheduler serves exactly one graph and is attached only once, even for an empty graph. Failed validation claims nothing. A graph whose nodes, bodies or edges change afterwards is rejected before it is scheduled again.
- The returned actor **is** `graph.scheduler`, with its native API, iterator and `status`; no additional runtime object is created. The agency owns its members, including nested attached schedulers, by their original identity. A retained child `graph.scheduler` cannot be adopted again. Do not drive an owned member or its iterator directly.
- `abort()` aborts the scheduler's run and starts every direct member's `abort()` in node order, one ownership level per microtask, then joins them all; member failures reject the agency's abort as one ordered aggregate, and a failing member never keeps a sibling from being aborted.
- `return()`/`throw()` close the scheduler and start every direct member's `return()` once, without aborting members separately; no later graph column starts. Closing joins the active column, runs and member closes before it settles. Abort and close stay stack-safe at any finite depth.

## Verification

`bun run test` exercises the member adapter, native `schedule` tool gating, attachment, nested agencies, abort/close, and policy boundaries. `test/policy-yield.test.ts` uses junco-tools' real Marsh policy through the CopyTree native test addon (`npm run build:native:test`): denied `edit`, applying `ast_edit`, and `bash` calls pause in source order without publishing edits or starting a second model request until resumed. Native tracing requires usable kernel BTF/kallsyms and BPF, performance and system-log capabilities; this WSL2 workstation needed a privileged run for the policy suite. A failed native test is not evidence of a passing policy boundary. `bun run smoke` runs the offline recursive example and prints `leaf-result + sibling-result`; the build can be loaded under Node.js with `node --input-type=module -e 'await import("./dist/index.js")'`.

`bun test test/oss-committee.test.ts` runs six network-free committee tests with injected GitHub responses and a `DummyTracer`: researched value-edge order, sourced minimal plan and exclusive output, HTTP failure, truncated report, valid empty search, publication guards, and scoped/malformed search metadata. The scripted fixture can export to a running Opik service (`OPIK_URL_OVERRIDE=http://localhost:8888/api OPIK_PROJECT_NAME=junco-agency bun run test/oss-committee.fixture.ts`); separately inspect actual trace ingestion in the Opik UI. Neither those offline tests nor `flush()` prove live GitHub access, Copilot entitlement, or Opik ingestion.
