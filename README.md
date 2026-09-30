# junco-agency

Recursive Pi agencies. `attachAgency(graph)` returns the graph's original `PiScheduler` as an `Agentic`: a native Pi `AgentHarness` and cooperative scheduling iterator ([`junco-agent`](../junco-agent)). Its model runs a [`dataflow-engine`](../dataflow-engine) graph of `Agentic` members, `JuncoAgent` leaves or attached schedulers, through its only tool, `schedule`: one bounded graph window per call. Nesting needs neither flattening nor a forwarding object.

## Setup

Requirements: Linux x86-64 with glibc, Node.js `>=22.19.0`, and Bun `1.3.14`. Build the sibling checkouts first, as their READMEs describe:

```sh
(cd ../junco-tools && npm ci && npm run build && npm run build:native:test)
(cd ../dataflow-engine && bun install && bun run build)
(cd ../junco-agent && bun install --linker hoisted && bun run build)
```

Then, from this repository:

```sh
bun install
bun run typecheck
bun run test
bun run build
bun run smoke
```

- Install with Bun only. `package.json` registers `../junco-agent/patches/@earendil-works%2Fpi-agent-core@0.80.6.patch`, the one canonical patch `junco-agent` requires, and pins `pi-agent-core` to `0.80.6` through `overrides`.
- `bunfig.toml` selects the isolated linker. It snapshots each `file:` sibling into this root's store, so every package resolves the same patched `pi-agent-core` from here rather than from a sibling's own `node_modules`. After rebuilding a sibling, reinstall (`rm -rf node_modules && bun install`) to refresh its snapshot.
- Bun `1.3.14` limits: the snapshots are hardlinks, so this checkout must sit on the same filesystem — the same Btrfs subvolume — as the siblings, or they install empty; and a first install without `bun.lock` reports `failed to read patchfile` for a patch outside the root, which a second `bun install` resolves.
- Because the snapshots are hardlinks, changing a file under `node_modules/.bun` — even its permissions — changes the sibling checkout's file too.
- `test/policy-yield.test.ts` loads `../junco-tools/target/native-test/index.js`, built by `npm run build:native:test`.

## CI

GitHub Actions checks out the private `marsh`, `junco-policy`, `junco-tools`, `dataflow-engine`, and `junco-agent` siblings using read-only deploy-key repository secrets `JUNCO_MARSH_SSH_KEY`, `JUNCO_POLICY_SSH_KEY`, `JUNCO_TOOLS_SSH_KEY`, `JUNCO_DATAFLOW_SSH_KEY`, and `JUNCO_AGENT_SSH_KEY`. It builds each dependency in order, then runs every offline unit suite, this package's typecheck and build, and the recursive smoke. The native policy test uses the CopyTree addon; CI requires neither a Btrfs mount nor model credentials.

## Usage

```ts
import { always, DataflowGraph, UNBOUNDED } from "dataflow-engine";
import { createYieldTool, JuncoAgent } from "junco-agent";
import { type AgencyGraph, agentNode, attachAgency, PiScheduler } from "junco-agency";

// Native harness options (env, session, models, model) for each agent, resolved beforehand.
const researcher = new JuncoAgent({ ...researcherOptions, tools: [createYieldTool()], prompt: "Find the facts." });
const writer = new JuncoAgent({ ...writerOptions, prompt: "Draft the summary." });

const scheduler = new PiScheduler({ ...schedulerOptions, systemPrompt: "Coordinate the team.", prompt: "Produce the report." });
const graph: AgencyGraph = new DataflowGraph(scheduler, UNBOUNDED, UNBOUNDED);
for (const [agent, description] of [[researcher, "researches"], [writer, "writes"]] as const) {
  graph.addNode(agentNode(agent, { description, trigger: always(), receive: () => [], emit: () => [] }));
}
const agency = attachAgency(graph); // wire every member and edge before attaching

for await (const step of agency) {
  if (step.kind === "yield") continue; // one graph window completed; the next iteration resumes
  console.log(step.kind === "settled" ? step.message : step.error);
  break; // closes the agency and, with it, every member
}
```

[`examples/recursive-agency.ts`](examples/recursive-agency.ts) runs a root → child → grandchild agency around a leaf that pauses once, plus a root sibling, entirely offline on faux models.

## API

```ts
type AgenticInput =
  | { readonly kind: "prompt" | "steer" | "followUp" | "nextTurn"; readonly text: string; readonly images?: ImageContent[] }
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };
type AgencyGraph<S, P> = DataflowGraph<Agentic, AgenticInput, AssistantMessage, unknown, PiScheduler<S, P>>;

function agentNode(agent: Agentic, options: {
  readonly id?: NodeId;
  readonly description: string; // shown to the scheduler
  readonly trigger: TriggerRule<AgenticInput, AssistantMessage>;
  readonly receive: (view: ParentView<AgenticInput, AssistantMessage>) => readonly AgenticInput[];
  readonly emit: (step: Extract<AgenticStep, { kind: "yield" }>) => Message<AgenticInput>[];
}): NodeSpec<Agentic, AgenticInput, AssistantMessage>;

class PiScheduler<S, P> extends JuncoAgent<S, P, ScheduleTool> implements DataflowScheduler<AgenticInput, AssistantMessage> {
  constructor(options: Omit<AgenticOptions<S, P, ScheduleTool>, "tools" | "activeToolNames">);
}
function attachAgency<S, P>(graph: AgencyGraph<S, P>): PiScheduler<S, P>;
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

`bun run test` is offline except for `test/policy-yield.test.ts`, which uses junco-tools' CopyTree test addon with the sandbox always on: a real Marsh denial of `edit`, an applying `ast_edit` and `bash` pauses a `JuncoAgent` as `policy` steps in call order, publishes nothing, and makes no second model request until resumed. The suite covers the member adapter on the engine's own scheduler, the scheduler contract, attachment, 32 nested agencies, abort and close across 4096 idle nested agencies, abort reaching a live grandchild while its sibling runs, and closing a paused tree. `bun run smoke` runs the recursive example. The build loads under Node.js (`node --input-type=module -e 'await import("./dist/index.js")'`).
