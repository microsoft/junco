# junco-agent

`JuncoAgent` wraps Pi `0.99.2`'s `AgentHarness.create` and one native `main` lane, using the workspace's pinned `pi-agent-core` patch described below. It exposes a no-Context `Agentic` control surface and an `AsyncGenerator` whose `next()` returns a cooperative scheduling boundary: a successful `yield`, a typed Marsh policy denial, or a run's settlement. A consumed pause holds the run after the tool batch and before boundary input consumption and the next model request until another `next()` resumes it. [`junco`](../..) builds recursive agent graphs on this contract.

## Layout

| Path | Package | Role |
| --- | --- | --- |
| `src/` → `dist/` | `junco-agent` | `JuncoAgent` and the typed `Agentic` contract. The `yield` tool (`YieldTool`) is exported by `junco-tools`. |
| `test/` | — | Offline Bun suite over Pi's `fauxProvider`. |
| `../junco-tools` | `junco-tools` (`workspace:*`) | Workspace package with native-backed Pi tools and the typed `junco-tools/errors` denial check. |

## Setup

This package lives in the junco Bun workspace at `packages/junco-agent`. Bun source consumers — such as the workspace root's `bun run build:examples` — resolve `junco-agent` and `junco-tools` through their `bun` exports to TypeScript source after one root `bun install --frozen-lockfile`; they need no `dist/` and, with explicit tools, no native addon (see the [workspace setup](../../README.md#setup)).

Building and typechecking this package consume `junco-tools`' emitted declarations, which `junco-tools`' `bun run build` produces together with its native addon. Requirements for this lane: Linux x86-64 with glibc, Node.js `>=22.19.0`, Bun `1.4.2`, and `junco-tools`' native prerequisites (Rust toolchain and native libraries; Cargo fetches marsh from GitHub; see its [README](../junco-tools/README.md)).

Install once at the workspace root, build `junco-tools` (its `dist/` and `native/junco_tools.linux-x64-gnu.node`), then build and test this package:

```sh
bun install --frozen-lockfile                     # at the workspace root
(cd packages/junco-tools && bun run build)
cd packages/junco-agent
bun run build
bun run typecheck
bun run test
```

The workspace links `junco-tools` to `packages/junco-tools`, so its compiled output and native addon are read from there for this lane. The agent builds directly with TypeScript. Root `bun install --frozen-lockfile` applies the committed Bun patch at `patches/@earendil-works%2Fpi-agent-core@0.99.2.patch`. The patch orders the admitted instruction before already queued steering messages and adds the `after_tool_batch` gate after `turn_end` delivery, before the next boundary consumes queued input. Both are required: initial requests must see instruction then delivered content, and a paused run must consume newly delivered steering on its next request after resume. Keep this patch when installing or updating the pinned Pi dependency.

## CI

The workspace's `.github/workflows/ci.yml` `test` job builds the real native addon (Cargo fetches the public `marsh` and `junco-policy` from GitHub), then builds, typechecks, and runs this package's offline Bun unit suite with coverage (`bun run test:coverage`, LCOV at `coverage/lcov.info`, uploaded as the `junco-agent-coverage` artifact; it reports this package's `src/` only) and launches `bun run cli <seed> --version`. CI needs no Btrfs mount or live model credentials.

## Pi CLI

`bun run cli` runs the pinned Pi `cli.js` with the `junco-tools` extension, both resolved from this package through the workspace install; it does not run `JuncoAgent.create`. From `packages/junco-agent`, give it an existing dedicated Btrfs seed subvolume (or a directory beneath it) as the first argument. The launcher changes to that directory and forwards the remaining arguments to Pi. The seed needs a writable parent and `user_subvol_rm_allowed` on its mount; the launcher does not create subvolumes. Configure Pi's model credentials separately.

```sh
bun run cli /absolute/path/to/dedicated-btrfs-seed
bun run cli /absolute/path/to/dedicated-btrfs-seed --no-session -p 'Use the bash tool to run pwd.'
```

Pi's built-in default selection is `read,bash,edit,write`; extension tools are enabled on registration unless configured otherwise. To select exactly the extension tools plus Pi's `write` and `ls`, pass an explicit allowlist (it overrides the current default-tools setting):

```sh
bun run cli /absolute/path/to/dedicated-btrfs-seed \
  --tools read,bash,edit,grep,find,ast_grep,ast_edit,diff,write,ls
```

## Usage

Before this default-tools example, run `pi`, use `/login`, and select Anthropic. The example reuses that saved login and requires `cwd` inside an existing dedicated Btrfs seed (see [Tools](#tools)):

```ts
import { JuncoAgent } from "junco-agent";

const agent = await JuncoAgent.create({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  systemPrompt: "You are a concise coding assistant. Read files before editing.",
  prompt: "Read README.md and summarize this repository.",
  cwd: process.cwd(),
  // All enabled defaults: ten native tools plus task/yield/send/info/complain.
});
agent.events.on("message_end", ({ message }) => console.log(message));

try {
  for await (const step of agent) {
    if (step.kind === "yield") {
      console.log("paused:", step.reasons); // next iteration resumes this run
      continue;
    }
    console.log(step.kind === "settled" ? step.message : step.error);
    break;
  }
} finally {
  await agent.return(); // idempotent even if the loop's break already closed it
}
```

Leaving `for await` early calls terminal `return()`. To reuse an agent after a settlement, call `next()` directly rather than breaking out of the iterator, then start another run with `prompt()`.

For an already resolved `{ models, model }`, use `await JuncoAgent.fromResolved({ session, models, model, tools, resources, prompt })`. `await JuncoAgent.create({ provider, model: modelId, tools, ... })` resolves provider/model IDs through Pi's `ModelRuntime` and saved login; `models` may share an existing runtime. Omission and `tools: []` keep enabled defaults. Explicit tools replace defaults by exposed `AgentTool.name`; two explicit definitions with the same name remain an error. `tool_block` removes exact, case-sensitive names; it must contain unique nonblank strings and cannot overlap `tools` (including resolved MCP names). Blocking or explicitly replacing every native name avoids loading the addon or creating a collection when MCP does not need one:

```ts
import { JuncoAgent } from "junco-agent";

const agent = await JuncoAgent.fromResolved({
  session,
  models,
  model,
  tools: [myTool],
  tool_block: ["bash", "edit"],
});
try {
  const response = await agent.prompt("Use the tools, then summarize.");
  console.log(response);
} finally {
  await agent.return();
}
```

Here `session`, `models`, `model`, and `myTool` are caller-provided. A supplied `Session` **transfers ownership** to JuncoAgent: closing the native harness closes that session (including on initialization failure); do not reuse or close it independently. Without a supplied session, `create` creates one through `MemorySessionRepo` and owns its repo. Caller-supplied tools remain caller-owned; an externally created collection remains yours to close after the agent.

## API

`Agentic<S extends Skill, P extends PromptTemplate, T extends AgentTool>` preserves typed skill/template and constructor-input tool specialization. Real agents compose defaults, so `JuncoAgent.getTools(): AgentTool[]`, `getActiveTools(): AgentTool[]`, and `setTools(tools: AgentTool[], activeToolNames?)` use the honest runtime type; `getResources(): AgentHarnessResources<S, P>` remains specialized. `setTools` is a replacement operation for an initialized agent, still conditionally adding enabled `complain` and collection `release`; `setActiveTools` only changes activation. Observe native events with `agent.events.on(...)` and hooks with `agent.hooks.on(...)`; there is no public mutable lane.

`events` and `hooks` return the native harness objects unchanged. Accessing either before a subclass has initialized its harness throws `JuncoAgentError` with code `invalid_state`.

- **Iterator.** `next(inputs?: ParentView<N, V>)` takes no command; `inputs` is only read by a staged prompt callback. `JuncoAgent<S, P, T, N extends TSchema = typeof TaskSchema, V = AssistantMessage>` (and `Agentic`, `AgenticOptions`, both factory option types and overloads) carry the graph's message schema `N` (payloads are `Static<N>`) and parent-value type `V`; the agent's own result is always `AssistantMessage`. It serves unread boundaries FIFO; otherwise it resumes the oldest consumed pause or starts the staged prompt, then waits. An idle `next()` waits for work. Runs publish a `settled` step with their final assistant message (including `aborted` or `error` stop reasons), or `failed` if native execution rejects before a final message. A rejected busy admission publishes no step. A staged callback without `inputs` publishes `failed` with `JuncoAgentError("invalid_state")` without calling it; a callback that throws publishes `failed` with the identical thrown value; a non-string return (including a promise) publishes `failed` with `invalid_argument`. None of these starts a run, and the agent is idle afterwards.
- **Staged prompts.** The `prompt` option of `create`/`fromResolved` is `string | ((inputs: ParentView<N, V>) => string)`: a one-shot stage (status `ready`) consumed by the first `next()`; the constructor never calls the callback, and the callback runs synchronously on the borrowed view without draining it. `stagePrompt(prompt, { images? })` arms the same kind of stage later without starting anything; it throws `closed` while closing, and `busy` during pending compaction or unless the agent is `idle` with no abort in progress and no queued `next()`. `prompt(text)` still admits immediately. `Task` (the graph chat-wire message union: text, images and required `taskId`, `spec`, `deps` and `history` provenance; `Task.create({ kind, text, spec })` mints the id with empty `deps`/`history`) is exported from this package with its runtime TypeBox schema `TaskSchema` (appended messages are checked as objects with a string `role`); `AssistantMessageSchema` is the runtime schema of Pi's native result. Both allow structural extras. `PiScheduler` options keep `prompt` string-only.
- **Usage monitoring.** Both factories accept `tokenMonitor: TokenMonitorConfig`, with a positive finite `tokenThreshold`, `costThreshold` (dollars), or both, and `onThreshold(agent, totals, delta)`. Each committed Pi `usage` event reports once either threshold is reached by growth since the previous report; `totals` is cumulative session usage and `delta` is `{ tokens, cost }`. Restored sessions start from their existing usage, not zero. Subagents inherit the same config but track their own sessions; the callback's `agent` identifies the reporter. The baseline advances before calling the callback. Callbacks must not throw; Pi isolates throws as `handler_error` events.
- **Scheduler measurements.** A graph node can retain each committed main-lane request's token count and cost in integer micro-USD (rounded to the nearest microdollar). Neither a token budget nor a recorder is required. A resumed run reports new requests to the activation that resumed it; restored session totals and manual adjustments do not enter its history.
- **Profiling.** Both factories accept a `ProfileRecorder<"memory" | "tokens" | "cost" | "edits" | "operations" | "probe">` from `junco-tools`. Pass `{ recorder: session.add_context("solo") }` to record standalone usage at `solo`, or `{ recorder: session }` to record at the root (`""`). A directly created subagent records beneath its parent's standalone view at its own node ID. `runWithNodeContext({ recorder: view }, work)` uses `view` as the exact destination during `work`; `agent.recorder`, the collection binding and tool calls see that placement. Supplying a view from a different session, or supplying one to an agent created without a recorder, rejects with `ProfileRecorder instance mismatch` before work. The agent never closes the recorder.
  Each committed `usage` row emits paired `tokens` and `cost` events (`source` = the agent); restored history emits none. The agent also records `run`, `turn` (`turns_completed`), `model_request`/`maintenance_request` and `yield`/`handoff` (`yield_recognized`, `turns_yielded`, `yield_resumed`, reason counts, `yield_wait_ms`). Each model tool call counts as `requested = 1` (unregistered names as `custom`/`unregistered`/`invalid`). Tools that do not account their own calls emit one generic `custom`/`mcp` call per execution.
- **Pauses.** Only a successful call to the actual `new YieldTool()` tool from `junco-tools` produces a `tool` reason; a four-argument tool throwing a typed `isMarshPolicyDenied` error produces a `policy` reason while its Pi tool result remains an error. An agent created with `loopGuard: new LoopGuard(options)` folds every tool result of a run (edits per file, failing results, repeated failure signatures); when TokenEconomizer's stuck rule holds it appends a redirect to that result, at most `redirects` times per run, and when a later segment is stuck again it pauses the run with a `guard` reason, then stays quiet for the rest of the run. Both are counted as `loop_guard` metrics (`redirects`, `holds`) in the recorder. Every other tool — including `task`, `send`, `info`, `complain` and a scheduler's `schedule` — returns its result and the same run continues. Reasons follow tool-result order. One pause occurs after the complete batch and `turn_end` subscribers, before boundary input consumption and the next provider request. Spoofed names and failed yields cannot pause. The adapter preserves four-argument `AgentTool` metadata and execution signature; native tool batches run sequentially, including after `setTools`.
- **Node context.** `runWithNodeContext<N, R>({ nodeId?, messaging?, complaint?, recorder? }, work)` binds one graph activation for `work` only (an overlapping binding rejects `busy`); binding neither prompts nor resumes. `nodeId` authorizes memory access independently of profiling. `messaging` is a `SendToolHost<N> & NonNullable<ConstructorParameters<typeof InfoTool>[0]>` hosting genuine `new SendTool()`/`new InfoTool()` tools from `junco-tools`: outgoing routes, topology and the activation's `sendParameters`. `complaint` attributes complaints with that activation's messages. While bound, the genuine send adapter exposes the host's `send.parameters` on every model request; unbound it reads the original tool's. One shared tool thus serves agents with different edges without being mutated; `getTools`/`getActiveTools` return the originals. Unbound, each tool runs its own `execute`. `JuncoAgent.create` includes `send` and `info` by default, and a `junco` graph hosts both for a registered agent. Task subagents never inherit the binding.
- **Graph delivery.** The scheduler's mandatory `NodeModel.readEdges` selects queued inbound message edges; `select(snapshot, ids, strength?)` uses `plannedReads`, and `reads(assign, inner)` can override it (`[]` withholds messages). The graph steers each delivered message before advancing the agent: `Task` text/images become separate user messages in order, the text followed by a `Task:` JSON line (`taskId`, `spec`, `deps`, `history`; a task lacking any of them is a definition error), never commands dispatched by `kind`; other payloads become `JSON.stringify({ id, payload })`. `send({ id, payload, handoff, task, spec })` (all required) names a received task: the same `spec` hands it off with `handoff` appended to its history, another `spec` creates a subtask recorded in that task's `deps`; a node that received no task cannot send a task payload. Stage a constant instruction referring to the user message(s) following it, not a copy of the delivered content. Values are never steered; staged callbacks and YAML value-edge placeholders can read them. Message-edge placeholders fail at build time; `params` substitutions remain supported.
- **Task results.** `getTaskResults(): readonly TaskResult[]` exposes task attempts whose reports entered this agent's model context in its current or latest run, standalone or graph-driven; a new run or `abort()` starts it empty. Only reports the agent itself queued count, matched by native entry id, never a look-alike message. Tools read structured `id`, `name`, `attempt`, `status`, `output`, `stopReason` and optional error/decision fields without decoding native message envelopes.
- **Native tasks.** A genuine `task` tool without its own host (`tool.host === undefined`) admits through the running agent: it acquires every child through `createSubagents`, prepares the whole batch (a failure closes them and admits nothing), then starts all of them immediately in the background and returns their handles while the run continues. Each child resumes its own pauses and may run its own tasks. Its final report and each batch's completion marker are queued to this agent as follow-ups; the run settles only after all of them were answered, so `prompt()` and `next()` stay pending meanwhile. This agent owns the children: `abort()` and `return()` close them and drop their pending reports, also in a subclass whose `abortDependents`/`closeDependents` skip `super`. Children run under the admitting run's usage ledgers and recorder, at the attempt's path. A child's teardown failure or an exhausted usage budget fails this agent's run; ordinary child failures are task outcomes. A tool constructed with an explicit host (`new TaskTool(host)`) admits through that host instead, which owns its execution and reports.
- **Subagents.** `createSubagents(options, signal?)` returns fresh, unstarted agents. The parent's immutable `tool_block` is inherited and each `TaskAgentOptions.tool_block` may add exclusions, never remove them. Omitted `tools` inherits surviving parent-active ordinary additions; `tools: []` inherits no ordinary custom/MCP additions. Both retain every available unblocked default, including inactive replacements from the parent's committed tools. Explicit additions cannot overlap the effective block. MCP definitions reconnect per child, assigned tasks become ordinary task tools, and each child over a collection gets its own binding. Validation is all-or-nothing before child session acquisition; retries pin the first attempt's resolved model, active names, and additional block.
- **Task decisions and children.** A hosted `task({ action: "retry" | "ignore", id, attempt })` decides one failed task reported with `decisionRequired`: an admitted retry returns that task's original handle; an ignore returns `Ignored task <id>.`. Neither pauses. Children never receive this agent's assigned `task` tool: `createSubagents` gives them a fresh ordinary `new TaskTool()` in its place.
- **Task policy.** `setTaskPolicy(policy: TaskPolicy | undefined)` installs a check on every `task` launch this agent would admit (free-form or assigned, native or through an explicit host; decisions are not launches). The policy receives the validated, detached `TaskInput` and throws to reject it; the model then receives an ordinary tool error, no subagent is created and no pause is recorded, so it can correct and retry. `undefined` removes the policy; subagents never inherit it.
- **Assigned batch.** `setTaskBatch(input: TaskInput): Promise<void>` replaces this idle agent's genuine `task` tool, in place and keeping whether it is active, with `new AssignedTaskTool(input, previous.host)`, so an explicit host keeps executing it: the model launches a detached copy of `input` with `task({})`. Invalid input rejects `invalid_argument`, a missing or impostor task tool `invalid_state`, a running agent `busy`. The batch is admitted at most once per agent (`task` calls run sequentially, so launches never overlap): a host rejection leaves it unadmitted so the model may retry, and a fulfilled host marks it admitted before its receipt is checked; later launches fail as `Task batch already admitted; wait for its results.` and `setTaskBatch` rejects `invalid_state` (`Task batch already admitted`). Use a new agent for another batch.
- **Failure policy.** `setTaskFailurePolicy(policy)` defaults to `{ retries: 0 }`; `"ignore"` drops failures, while `{ retries }` reacquires a fresh child with the first attempt's prompt, resolved model, active names and copied additional `tool_block`. Parent exclusions are immutable, so automatic and explicit retries cannot re-enable a blocked tool.
- **Subagent observer.** `setSubagentObserver(observer: SubagentObserver | undefined)` sees every later `createSubagents` batch, including task launches and retries: `acquiring(options)` runs before anything is acquired (throwing rejects the batch with nothing created), `acquired(child, index)` sees each fresh, unstarted child in order before the caller receives it (throwing fails the batch and closes its children). `undefined` removes it; subagents never inherit it.
- **Complaints.** Enabled `complain` is required in active selections, whether custom or genuine. Genuine `ComplainTool` instances rebind to the agent's own instance; a custom same-name definition executes unchanged. `tool_block: ["complain"]` removes it completely. `setTools` replaces the full tool set, adding genuine complaint and collection release fallbacks only when their names are absent. Omitting a previous custom definition removes that choice; failed mutations retain the old tools. Genuine complaint calls record the complete provider-neutral request, node ID and delivered messages in the process-wide `issueLog` and never pause. `complain(issue)` also records a complete supplied issue directly. Every append calls `issueLog.backend`, defaulting to synchronous `{ at, nodeId, complaint }` lines in `process.cwd()/complaints.jsonl` (resolved at module load); prompts and messages are not written. Backend failures warn without discarding the issue or failing the tool. Graph tracers do not receive complaints; `ComplainBackend` remains the extension point for custom destinations.
- **State and errors.** `status` is `ready`, `pending`, `running`, `suspended`, `idle`, or `closed`. A staged initial prompt starts on the first `next()`; other prompts reject `JuncoAgentError("busy")` until then. Locally rejected invalid arguments, invalid state and overlapping work use `JuncoAgentError` codes `invalid_argument`, `invalid_state`, and `busy`; every command rejected because the agent is closing or closed, and a run or maintenance request interrupted by close, uses `closed`. Native tagged errors and native event/hook subscription errors are not renamed.
- **Cancellation and closing.** `abort()` marks admitted runs stopping, releases pause gates, interrupts callers and joins native abort and dependent work without closing the agent; it reports cleared steer/follow-up messages, including queued messages when idle. `return()` and `throw()` terminally reject new work, abort and join runs/dependents, close the native harness/session, then release owned resources once. Unread yields are suppressed; subsequent `next()` is done. Cleanup failures propagate instead of being hidden; failed construction, initialization and `createSubagents` rollback cleanup aggregate as an `AggregateError` with the primary failure first, then each cleanup failure.
- **Context size and maintenance.** `context_size()` estimates the tokens of the current main-lane context as Pi would send it: committed current-branch entries (latest compaction summary and retained tail, branch summaries, projected custom entries), excluding staged prompts and queued input. It uses the last valid provider usage plus trailing estimates, but ignores usage retained across a compaction. Compare it with `getModel()`'s `contextWindow`. `compact({ customInstructions? })` queues Pi's native compaction behind any admitted run, without aborting or resuming it, and resolves to `undefined` once compacted; nothing to compact also resolves. Requests run FIFO and independently; a failed, declined or ordinarily aborted (`abort()`) compaction rejects `invalid_state`. While one is pending, new runs and `navigateTree` reject `busy` and a staged prompt waits; held yields still resume through `next()`. Closing rejects queued and accepted compactions with `closed`, after aborting and joining an accepted one. `navigateTree(targetId, options?)` only moves the native branch (optionally summarizing and labelling): it never starts a prompt or consumes queued input, so its `NavigationResult` has no `run`, and queued next-turn input reaches the next explicit or staged prompt. Native admission errors (`LaneBusy`, `InvalidNavigation`, `UnknownTarget`, `Closed`) and `completed`, `declined`, `failed` or `aborted` records are returned as results; close interrupting navigation rejects `closed`.
- **Active tool invariants.** Initial and restored names must be unique and available. Reopened sessions discard persisted names now blocked, retain the remaining subset, add enabled required names, and persist the corrected selection without activating unrelated defaults. `setTools` rejects blocked names before native mutation and retains rollback behavior; `setActiveTools` naming an absent blocked tool remains an unknown-tool error.

## Tools

Agents take no authorization policy of their own: an optional `collection` selects it and is borrowed through one owner binding per agent. Initialization composes enabled `collection.tools` in collection order (`read`, `bash`, `edit`, `release`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`, `code_graph`), then `task`, `yield`, `send`, `info`, then remaining concrete/MCP additions, then enabled `complain`. An explicit same-name tool occupies the default's slot without copying definitions or mutating the collection. Native owner binding and coordination dispatch still depend on identity and brands: a plain custom `yield` does not suspend. No LSP tool is implicit. With `tool_pruning: true` on the collection, an agent that has settled ten runs deactivates, before each later run, every `collection.tools` entry it never called (`release` excepted), recorded as `tool_pruning` metrics (`pruned`); explicit replacements, the agent's own additions (including MCP definitions) and coordination tools are never pruned.

- `tool_block` is the opt-out for any default, including `release` and `complain`; blocked defaults are never reinserted. If every native name is blocked or explicitly replaced and MCP does not require execution infrastructure, `collection` remains `undefined` and no addon loads.
- `toolSource` is an optional display-ready declaration module path, preserved verbatim and inherited by children. Successful initialization logs each custom default replacement at INFO through the existing logger/output owner; without a nonempty source it reports an explicitly supplied tool. YAML registry entries affect only nodes that select them; registry keys resolve before collection tools and coordination defaults, and aliases replace by exposed name.
- `ToolCollection.create(cwd, options?)` opens the native mux, so any surviving native implementation needs `cwd` inside a valid seed. Nonempty MCP definitions still require a collection even when all native defaults are blocked.
- `edit` anchors on hashline tags from an earlier `read` or `grep` of the same collection. Blocking `release` while retaining write tools deliberately removes the model's way to relinquish committed ownership.
- `tools` may hold `JuncoMcpTools` definitions. Discovered names are checked against `tool_block` after discovery; failures close acquired connections. Definitions are factory-only, while `setTools` takes concrete tools.
- Caller-supplied collections remain caller-owned; default-created collections and MCP connections close with the agent. Collection bindings, creator holds, repos and transferred sessions retain their documented cleanup ordering.
- Each collection owns its own mux; the last of its holds (creator, agents, subagents, MCP connections) closes it.
- File tools and `bash` share the collection's mux. Writes may run in a private snapshot and publish only what Marsh's policy authorizes; a refused publication rejects the call with a typed `MARSH_POLICY_DENIED` error, which pauses the run as a `policy` step.
- Each agent (and each subagent) acts as its own policy owner through `collection.bind()`: its collection tools keep one owner across tool calls, prompts, retries and continuations, distinct from every other agent sharing the collection. A write takes ownership until that owner's `release` (or its deletion of the file); closing the agent or its collection releases nothing. `getTools()` still returns the original tool objects. Every model request's system prompt carries `After you write to a file use release to relinquish ownership`, appended once at the provider boundary and never persisted.

## Authentication

Start `pi`, use `/login`, and select the provider before calling `JuncoAgent.create`. The default runtime reads Pi's `auth.json` and `models.json` from `~/.pi/agent/`, respecting `PI_CODING_AGENT_DIR`. Pi owns credential storage, OAuth refresh, and configured model endpoints; JuncoAgent never starts a browser/device login or reads Copilot CLI credentials. Environment-only credentials do not satisfy the saved-login requirement.

Missing credentials for the selected provider, unusable credentials, or a failed OAuth refresh reject with `JuncoAgentError("invalid_state")` and instructions to run `/login` in Pi. Authentication happens before allocating default sessions or tools; a supplied session is closed on failure. Unknown model IDs reject with `invalid_argument` rather than selecting a fallback model, and so does a `thinkingLevel` the model does not support (checked before credentials) rather than being silently clamped.

After authentication, `create` checks Pi's provider-scoped account availability before allocating sessions or tools. A catalog model filtered out for the saved account rejects with `JuncoAgentError("invalid_argument")` and `Model not available: <provider>/<model>`; a transferred session is closed. Provider-filter exceptions propagate unchanged, not as login errors.

Pass `models: ModelRuntime` to reuse Pi's runtime across agents. For explicitly resolved custom or offline models, `fromResolved` remains the low-level path: its caller supplies the `Models` collection and model and owns authentication setup.

## Verification

`bun run test` uses Pi's `fauxProvider`, explicit in-memory tools, isolated in-memory credentials, and temporary Pi auth files; it needs no dedicated Btrfs seed, live model credentials or Opik service. The offline agent tests cover the native adapter's scheduling boundaries, sequential tool batches, active selection and reopened idle sessions, abort/close, context sizing and deferred compaction (`bun test ./test/junco-agent.test.ts -t 'context_size:|compact:'`), provider-resolving explicit-tool creation, saved OAuth reuse, missing provider credentials, failed token refresh, and session cleanup after authentication failure. Run the commands in [Setup](#setup) to verify this checkout; the default native ToolCollection, live credentials, and dedicated Btrfs operation require their own prerequisites and are not established by the offline suite.
