# junco-agent

`JuncoAgent` wraps Pi `0.99.2`'s `AgentHarness.create` and one native `main` lane; it does not extend or patch Pi. It exposes a no-Context `Agentic` control surface and an `AsyncGenerator` whose `next()` returns a cooperative scheduling boundary: a successful `yield`, a typed Marsh policy denial, or a run's settlement. A consumed pause holds the run after the tool batch and before the next model request until another `next()` resumes it. [`junco-agency`](../..) builds recursive agent graphs on this contract.

## Layout

| Path | Package | Role |
| --- | --- | --- |
| `src/` → `dist/` | `junco-agent` | `JuncoAgent` and the typed `Agentic` contract. The `yield` tool (`createYieldTool`) is exported by `junco-tools`. |
| `test/` | — | Offline Bun suite over Pi's `fauxProvider`. |
| `../junco-tools` | `junco-tools` (`workspace:*`) | Workspace package with native-backed Pi tools and the typed `junco-tools/errors` denial check. |

## Setup

This package lives in the junco-agency Bun workspace at `packages/junco-agent`. Bun source consumers — such as the workspace root's `bun run build:examples` — resolve `junco-agent` and `junco-tools` through their `bun` exports to TypeScript source after one root `bun install --frozen-lockfile`; they need no `dist/` and, with explicit tools, no native addon (see the [workspace setup](../../README.md#setup)).

Building and typechecking this package consume `junco-tools`' emitted declarations, which `junco-tools`' `bun run build` produces together with its native addon. Requirements for this lane: Linux x86-64 with glibc, Node.js `>=22.19.0`, Bun `1.4.2`, and `junco-tools`' native prerequisites (Rust toolchain, the external `marsh` checkout beside the workspace, native libraries; see its [README](../junco-tools/README.md)).

Install once at the workspace root, build `junco-tools` (its `dist/` and `native/junco_tools.linux-x64-gnu.node`), then build and test this package:

```sh
bun install --frozen-lockfile                     # at the workspace root
(cd packages/junco-tools && bun run build)
cd packages/junco-agent
bun run build
bun run typecheck
bun run test
```

The workspace links `junco-tools` to `packages/junco-tools`, so its compiled output and native addon are read from there for this lane. The agent builds directly with TypeScript; Pi needs no local patch.

## CI

The workspace's `.github/workflows/ci.yml` `test` job checks out the private `marsh` and `junco-policy` beside the workspace, builds the real native addon, then builds, typechecks, and runs this package's offline Bun unit suite with coverage (`bun run test:coverage`, LCOV at `coverage/lcov.info`, uploaded as the `junco-agent-coverage` artifact; it reports this package's `src/` only) and launches `bun run cli <seed> --version`. CI needs no Btrfs mount or live model credentials.

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
  // Omitted tools: owned junco-tools collection plus yield.
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

For an already resolved `{ models, model }`, use `await JuncoAgent.fromResolved({ session, models, model, tools, resources, prompt })`. `await JuncoAgent.create({ provider, model: modelId, tools, ... })` takes provider/model ID strings and resolves them through Pi's `ModelRuntime` and saved login; an optional `models: ModelRuntime` shares an existing runtime. Omitted `tools` opens the default collection. Explicit `tools` replace that collection entirely and need no Btrfs seed or local execution environment; include `createYieldTool()` if voluntary pauses are needed:

```ts
import { JuncoAgent } from "junco-agent";
import { createYieldTool } from "junco-tools";
const agent = await JuncoAgent.fromResolved({ session, models, model, tools: [myTool, createYieldTool()] });
try {
  const response = await agent.prompt("Use the tools, then summarize.");
  console.log(response);
} finally {
  await agent.return();
}
```

Here `session`, `models`, `model`, and `myTool` are caller-provided. A supplied `Session` **transfers ownership** to JuncoAgent: closing the native harness closes that session (including on initialization failure); do not reuse or close it independently. Without a supplied session, `create` creates one through `MemorySessionRepo` and owns its repo. Caller-supplied tools remain caller-owned; an externally created collection remains yours to close after the agent.

## API

`Agentic<S extends Skill, P extends PromptTemplate, T extends AgentTool>` preserves typed skill/template/tool specialization. `getTools(): T[]` and `getActiveTools(): T[]` synchronously return the original tools (not native wrappers); `getResources(): AgentHarnessResources<S, P>` returns the typed resources. Changes go through `setTools(tools, activeToolNames?)`, `setActiveTools(names)` and `setResources(resources)`. Observe native events with `agent.events.on(...)` and register native hooks with `agent.hooks.on(...)`; there is **no public mutable lane**. `prompt`, `skill`, and `promptFromTemplate` resolve to the final `AssistantMessage`; `steer`, `followUp`, `nextTurn`, and `appendMessage` are asynchronous no-Context operations. Model, thinking, stream/queue mode, compaction, and tree-navigation controls also delegate to Pi. `navigateTree(targetId, { summarize?, label?, customInstructions? })` resolves to a native `Result` record: inspect `ok` before using its value.

- **Iterator.** `next()` has no command payload. It serves unread boundaries FIFO; otherwise it resumes the oldest consumed pause or starts an initial staged `prompt`, then waits. An idle `next()` waits for work. Runs publish a `settled` step with their final assistant message (including `aborted` or `error` stop reasons), or `failed` if native execution rejects before a final message. A rejected busy admission publishes no step.
- **Pauses.** Only a successful call to the actual `createYieldTool()` tool from `junco-tools` produces a `tool` reason; a four-argument tool throwing a typed `isMarshPolicyDenied` error produces a `policy` reason while its Pi tool result remains an error. A `task` call admitted through a host bound with `runWithTaskHost` produces a `tool` reason `Scheduled N subagents`, even if an `after_tool` hook rewrites its result. Reasons follow tool-result order. One pause occurs after the complete batch and `turn_end` subscribers, before the next provider request. Spoofed names and failed yields or admissions cannot pause. The adapter preserves four-argument `AgentTool` metadata and execution signature; native tool batches run sequentially, including after `setTools`.
- **Subagents.** `runWithTaskHost(host, work)` binds a `TaskToolHost` for `work` only (an overlapping binding rejects `busy`); binding neither prompts nor resumes. Without a binding, the `task` tool runs its own `execute`. `createSubagents(options: TaskAgentOptions[], signal?)` returns fresh, unstarted `JuncoAgent<S, P, AgentTool>`s, one per option, each with its own in-memory session (no transcript). Omitted `model`/`tools` inherit the caller's current model and active tools; thinking level, resources, system prompt and harness settings are inherited; hooks and event subscriptions are not. `tools` only narrows (`[]` leaves only the child's own always-on `complain` tool). Every registered `JuncoMcpTools` definition is snapshotted once per call and reconnected per child, which exposes only the selected original MCP tools. A default collection stays open until its last borrowing agent closes. All models (`Model not found`, `No usable credentials`, unsupported thinking level) and tool subsets are validated before any child is created; a later failure or `signal` abort closes every created child. `agentNode` in `junco-agency` binds the host and runs the children.
- **Complaints.** Every `JuncoAgent` owns one genuine `complain` tool (`createComplainTool` from `junco-tools`): it is appended to any tool list (a supplied genuine one is replaced in place, a same-named impostor fails as `Duplicate tool name: complain`), and `"complain"` is appended to every active selection, so `tools: []` or `setActiveTools([])` means complaint-only. A model call records an `Issue` in the process-wide, append-only `issueLog` (also `agent.issueLog`): the node ID, the messages its graph activation delivered, the complete provider-neutral request (`Prompt`: system prompt, converted messages, tool declarations) captured at `Models.streamSimple` after every context hook, and the complaint text. `runWithComplaintContext({ nodeId, messages, tracer? }, work)` binds the graph node for `work` (`agentNode` does this); outside a binding the agent's own `nodeId` (`agent-<uuid>`) and no messages are used. A complaint never pauses the run. `complain(issue, tracer?)` is the synchronous `Agentic` protocol method appending a complete caller-supplied issue; it throws `closed` once the agent is closing. Recorded prompts may contain sensitive data and stay in memory until process exit.
- **State and errors.** `status` is `ready`, `pending`, `running`, `suspended`, `idle`, or `closed`. A staged initial prompt starts on the first `next()`; other prompts reject `JuncoAgentError("busy")` until then. Locally rejected invalid arguments, invalid state and overlapping work use `JuncoAgentError` codes `invalid_argument`, `invalid_state`, and `busy`; every command rejected because the agent is closing or closed, and a run or maintenance request interrupted by close, uses `closed`. Native tagged errors and native event/hook subscription errors are not renamed.
- **Cancellation and closing.** `abort()` marks admitted runs stopping, releases pause gates, interrupts callers and joins native abort and dependent work without closing the agent; it reports cleared steer/follow-up messages, including queued messages when idle. `return()` and `throw()` terminally reject new work, abort and join runs/dependents, close the native harness/session, then release owned resources once. Unread yields are suppressed; subsequent `next()` is done. Cleanup failures propagate instead of being hidden.
- **Context size and maintenance.** `context_size()` estimates the tokens of the current main-lane context as Pi would send it: committed current-branch entries (latest compaction summary and retained tail, branch summaries, projected custom entries), excluding staged prompts and queued input. It uses the last valid provider usage plus trailing estimates, but ignores usage retained across a compaction. Compare it with `getModel()`'s `contextWindow`. `compact({ customInstructions? })` queues Pi's native compaction behind any admitted run, without aborting or resuming it, and resolves to `undefined` once compacted; nothing to compact also resolves. Requests run FIFO and independently; a failed, declined or ordinarily aborted (`abort()`) compaction rejects `invalid_state`. While one is pending, new runs and `navigateTree` reject `busy` and a staged prompt waits; held yields still resume through `next()`. Closing rejects queued and accepted compactions with `closed`, after aborting and joining an accepted one. `navigateTree(targetId, options?)` only moves the native branch (optionally summarizing and labelling): it never starts a prompt or consumes queued input, so its `NavigationResult` has no `run`, and queued next-turn input reaches the next explicit or staged prompt. Native admission errors (`LaneBusy`, `InvalidNavigation`, `UnknownTarget`, `Closed`) and `completed`, `declined`, `failed` or `aborted` records are returned as results; close interrupting navigation rejects `closed`.
- **Active tool invariants.** Initial and restored idle-lane active names must be unique and belong to the supplied original tools; a reopened session keeps its persisted subset, with `complain` appended and persisted when missing. `setTools` validates names before mutation, updates caches only on success and restores previous native tools/selection if its second mutation fails. A failed rollback closes the agent and rejects with the original and cleanup failures rather than leaving a live mixed configuration. `setActiveTools` validates before changing the protected lane.

## Tools

With `tools` omitted, `create` opens one `ToolCollection.create(cwd)` from `junco-tools` and passes `read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`, `task` and `yield`, in that order, followed by the always-on `complain`. There is no fallback backend, no Pi built-in tool, and no `write` or `ls` tool. Outside an `agentNode`, a `task` call fails as an ordinary tool error.

- `edit` is the hashline editor; it anchors on `[path#TAG]` snapshots from an earlier `read` or `grep` of the same collection.
- `ToolCollection.create(cwd)` opens its native mux immediately, so the default tools need `cwd` inside an existing dedicated Btrfs seed subvolume with a writable parent and `user_subvol_rm_allowed` on the mount. `create` rejects outside a seed.
- Explicit `tools` replace the defaults entirely (the agent still adds its `complain` tool); add `createYieldTool()` from `junco-tools` to let a run pause voluntarily. A collection you create and pass stays yours to close after the agent.
- `tools` may also hold `JuncoMcpTools` definitions from `junco-mcp`, alone or mixed with concrete tools, in both `create` and `fromResolved`. Each definition is connected from `cwd` for this agent (fresh clients and stdio server processes, run as audited jobs of the process's one ShellMux), its discovered `mcp__<server>__<tool>` tools take its place in order, and the agent closes those connections when it closes. A name clash with any other tool fails construction and closes every connection it opened. Definitions are factory-only: `setTools` takes concrete tools.
- Neither closing an agent nor closing a collection shuts the ShellMux down; the application calls `shutdownShellMux()` from `junco-tools` once, after every agent, graph and collection has stopped.
- File tools and `bash` share the collection's mux. Writes may run in a private snapshot and publish only what Marsh's policy authorizes; a refused publication rejects the call with a typed `MARSH_POLICY_DENIED` error, which pauses the run as a `policy` step.

## Authentication

Start `pi`, use `/login`, and select the provider before calling `JuncoAgent.create`. The default runtime reads Pi's `auth.json` and `models.json` from `~/.pi/agent/`, respecting `PI_CODING_AGENT_DIR`. Pi owns credential storage, OAuth refresh, and configured model endpoints; JuncoAgent never starts a browser/device login or reads Copilot CLI credentials. Environment-only credentials do not satisfy the saved-login requirement.

Missing credentials for the selected provider, unusable credentials, or a failed OAuth refresh reject with `JuncoAgentError("invalid_state")` and instructions to run `/login` in Pi. Authentication happens before allocating default sessions or tools; a supplied session is closed on failure. Unknown model IDs reject with `invalid_argument` rather than selecting a fallback model, and so does a `thinkingLevel` the model does not support (checked before credentials) rather than being silently clamped.

Pass `models: ModelRuntime` to reuse Pi's runtime across agents. For explicitly resolved custom or offline models, `fromResolved` remains the low-level path: its caller supplies the `Models` collection and model and owns authentication setup.

## Verification

`bun run test` uses Pi's `fauxProvider`, explicit in-memory tools, isolated in-memory credentials, and temporary Pi auth files; it needs no dedicated Btrfs seed, live model credentials or Opik service. The offline agent tests cover the native adapter's scheduling boundaries, sequential tool batches, active selection and reopened idle sessions, abort/close, context sizing and deferred compaction (`bun test ./test/junco-agent.test.ts -t 'context_size:|compact:'`), provider-resolving explicit-tool creation, saved OAuth reuse, missing provider credentials, failed token refresh, and session cleanup after authentication failure. Run the commands in [Setup](#setup) to verify this checkout; the default native ToolCollection, live credentials, and dedicated Btrfs operation require their own prerequisites and are not established by the offline suite.
