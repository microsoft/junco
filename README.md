# junco-agent

Pi's native `AgentHarness` with a cooperative scheduling iterator, and the native-backed [`junco-tools`](../junco-tools) collection as its default tools.

`JuncoAgent` *is* a pinned Pi `0.80.6` `AgentHarness`: prompts, steering, follow-ups, sessions, hooks, events, compaction, navigation, configuration, results and errors are the native ones. It is also an `AsyncGenerator` whose `next()` returns the next scheduling boundary — a voluntary `yield`, a typed Marsh policy denial, or a run's native settlement. A consumed pause holds its run after the turn's tool batch and before the next model request until a later `next()` resumes it. [`junco-agency`](../junco-agency) builds recursive agent graphs on this contract.

## Layout

| Path | Package | Role |
| --- | --- | --- |
| `src/` → `dist/` | `junco-agent` | `JuncoAgent`, the `Agentic` contract types and `createYieldTool`. |
| `patches/` | — | The Bun patch adding per-run integration hooks to `@earendil-works/pi-agent-core@0.80.6`. |
| `packages/model-auth/` | `model-auth` (`workspace:*`) | Authentication and model resolution. |
| `test/` | — | Offline Bun suite over Pi's `fauxProvider`. |
| `../junco-tools` | `junco-tools` (`file:../junco-tools`) | Sibling checkout with native-backed Pi tools and the typed `junco-tools/errors` denial check. |

## Setup

Requirements: Linux x86-64 with glibc, Node.js `>=22.19.0`, and Bun `1.3.14`.

Build `junco-tools` first if its `dist/` or `native/junco_tools.linux-x64-gnu.node` is missing, using its [README](../junco-tools/README.md) prerequisites (Rust toolchain, `../marsh`, native libraries):

```sh
cd ../junco-tools
npm ci
npm run build
```

Then, from this repository:

```sh
bun install --linker hoisted
bun run build
bun run typecheck
bun run test
```

Install with Bun only. `package.json` registers `patches/@earendil-works%2Fpi-agent-core@0.80.6.patch` under `patchedDependencies`, and npm does not apply it. The patch adds the `@earendil-works/pi-agent-core/agentic-integration` export; `junco-agent` checks its revision when it loads and fails immediately without it. A package that installs `junco-agent` must register the same patch file from its own root — see [`junco-agency`](../junco-agency/README.md) for a consumer that does.

Bun installs `file:../junco-tools` as per-file symlinks into the sibling checkout, so rebuilding the tools in place is picked up without reinstalling. Rerun `bun install --linker hoisted` if the tools checkout gains or loses files.

Root `src/` and `test/` import `model-auth` through its package exports, which point at `packages/model-auth/dist/`. `bun run build` and `bun run typecheck` rebuild it first; `bun run test` does not, so after editing auth sources run `bun run build` before testing.

## CI

The GitHub Actions workflow checks out this repository alongside private `junco-tools`, `marsh`, and `junco-policy`, builds the real native addon, then builds, typechecks, and runs the offline Bun unit suite. Configure read-only deploy keys as repository secrets `JUNCO_TOOLS_SSH_KEY`, `JUNCO_MARSH_SSH_KEY`, and `JUNCO_POLICY_SSH_KEY`. CI needs no Btrfs mount or live model credentials.

## Usage

This example uses the Anthropic API and requires `ANTHROPIC_API_KEY`. Run it with the working directory inside an existing dedicated Btrfs seed subvolume (see [Tools](#tools)):

```ts
import { JuncoAgent } from "junco-agent";
import { ModelId, ModelProvider } from "model-auth";

const agent = await JuncoAgent.create({
  provider: ModelProvider.apiKey(),
  model: ModelId("claude-sonnet-4-6"),
  systemPrompt: "You are a concise coding assistant. Read files before editing.",
  prompt: "Read README.md and summarize this repository.",
  cwd: process.cwd(),
  // `tools` omitted: one owned junco-tools collection plus `yield`.
});
agent.subscribe((event) => {
  if (event.type === "message_end") console.log(event.message);
});

try {
  for await (const step of agent) {
    if (step.kind === "yield") {
      console.log("paused:", step.reasons); // the next iteration resumes the run
      continue;
    }
    console.log(step.kind === "settled" ? step.message : step.error);
    break;
  }
} finally {
  await agent.return(); // `break` already closed it; closing is idempotent
}
```

Leaving `for await` early calls `return()`, which terminally closes the agent. To keep using it after a settlement, call `next()` directly and start later runs with the native `prompt()`.

## API

```ts
type AgentHarnessApi<S, P, T> = Pick<AgentHarness<S, P, T>, keyof AgentHarness<S, P, T>>;
type AgenticStatus = "ready" | "pending" | "running" | "suspended" | "idle" | "closed";
type AgenticYieldReason = {
  readonly kind: "tool" | "policy";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: string;
};
type AgenticStep =
  | { readonly kind: "yield"; readonly reasons: readonly AgenticYieldReason[] }
  | { readonly kind: "settled"; readonly message: AssistantMessage }
  | { readonly kind: "failed"; readonly error: unknown };

interface Agentic<S, P, T> extends AgentHarnessApi<S, P, T>, AsyncGenerator<AgenticStep, void, void> {
  readonly status: AgenticStatus;
}
interface AgenticOptions<S, P, T> extends AgentHarnessOptions<S, P, T> {
  readonly prompt?: string; // staged until the first next()
  readonly images?: ImageContent[];
}

class JuncoAgent<S, P, T> extends AgentHarness<S, P, T> implements Agentic<S, P, T> {
  constructor(options: AgenticOptions<S, P, T>);
  static create(options: JuncoAgentCreateOptions<S, P, T>): Promise<JuncoAgent<S, P, T>>;
}
function createYieldTool(): YieldTool; // `yield({ reason })`
```

- **Native plane.** Every `AgentHarness` method, property and event is Pi's own, with its native `this`, arguments, results, errors and identity. The constructor takes native harness options with already-resolved `models`/`model`/`session`/`env`; omitted `tools` means no tools, as in Pi.
- **Iterator.** `next()` carries no command. It returns the oldest unread boundary; with none, it resumes the oldest consumed pause or starts the staged prompt, then waits. Consuming a settlement never resumes anything. Demands are served in order; an idle `next()` waits for a boundary. Every admitted `prompt`/`skill`/`promptFromTemplate` run publishes exactly one `settled` step (its native final message, including `error`/`aborted` stop reasons) or one `failed` step (its native rejection); a call rejected by Pi's busy guard publishes nothing.
- **Pauses.** A successful call of a `createYieldTool()` tool records `{ kind: "tool" }` with its reason. A tool whose execution throws an error satisfying `isMarshPolicyDenied` from `junco-tools/errors` records `{ kind: "policy" }` with the error's message; Pi still turns the error into its normal error tool result. The run pauses once its whole tool batch has finished and every `turn_end` subscriber, session write and save point has run, with reasons in the batch's tool-result order. Ordinary failures, hook-blocked calls and same-named tools from elsewhere never pause.
- **Staged prompt.** With `prompt`, the agent is `ready` and the first `next()` starts it. Until then, `prompt()`, `skill()` and `promptFromTemplate()` reject with `AgentHarnessError("busy", "JuncoAgent initial prompt is pending")`.
- **Status** is computed from all records: `closed` once terminal close began, else `pending` with an unread boundary, `suspended` with a consumed pause still holding its run, `running` with admitted native operations or tool work, `ready` with only a staged prompt, else `idle`.
- **Abort.** `abort()` marks the admitted runs stopping, calls Pi's native `abort()` once — which notifies an installed run signal — and then releases their pauses; stopping runs publish no further pauses. It returns the native promise, result and error, closes nothing, and does not stop later runs.
- **Terminal close.** `return()` and `throw()` share one close: from that instant native run-starting and mutating calls reject `AgentHarnessError("invalid_state")` (getters, subscriptions, `waitForIdle` and `abort` still work); close then starts native abort, releases and discards pauses, joins every admitted operation and tool worker or event emission, flushes session writes, and releases owned resources once. A demand already waiting receives its run's actual settlement; others finish `done`. `return(value)` resolves with its own value, `throw(error)` rejects with its own error, and close failures (abort, dependents, flush, resource release) reject as an ordered `AggregateError` behind `throw`'s error. Afterwards `next()` is `done`.

### `JuncoAgent.create`

```ts
type JuncoAgentCreateOptions<S, P, T> = Omit<AgenticOptions<S, P, T>, "env" | "session" | "models" | "model" | "tools"> & {
  readonly provider: ModelProvider;
  readonly model: ModelId;
  readonly session?: Session; // default: a fresh InMemorySessionRepo session
} & (
  | { readonly env: ExecutionEnv; readonly tools: T[] } // supplied environment: explicit tools
  | { readonly env?: undefined; readonly cwd?: string; readonly tools?: T[] } // owned NodeExecutionEnv at resolve(cwd ?? process.cwd())
);
```

`create` resolves the model through `provider.resolveModel` and owns exactly what it creates: the default `NodeExecutionEnv` and, when `tools` is omitted, one `ToolCollection.create(cwd)` (with the collection's current sandbox default) plus a `yield` tool. Terminal close releases those once. Supplied sessions, environments and tools stay caller-owned. Explicit tools keep their type and never load `junco-tools`. A supplied `env` without explicit tools rejects `invalid_argument` before anything is resolved or created. A construction failure releases what `create` acquired and rejects with the original error, or with an `AggregateError` whose `cause` is that error if releasing also failed.

### Native limits

These are Pi `0.80.6` behaviors, preserved rather than hidden:

- An `abort()` while a run is still starting (in an asynchronous `systemPrompt` or `before_agent_start` hook, before Pi installs its controller) waits for the run without cancelling it; the released startup may complete a normal turn. Its pauses are suppressed, so it finishes without another `next()`.
- A run started from an `agent_end` listener can escape a later native `abort()`, which may return while that run continues. Terminal close still joins it before releasing resources.
- When a tool event listener throws while another parallel tool still runs, Pi settles the run early with a synthetic error message. Terminal close waits for the remaining tool work before releasing resources.
- Awaiting a run's settlement or `next()` inside that run's own awaited listener deadlocks, as it would natively.

## Tools

With `tools` omitted, `create` opens one `ToolCollection.create(cwd)` from `junco-tools` and passes `read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff` and `yield`, in that order. There is no fallback backend, no Pi built-in tool, and no `write` or `ls` tool.

- `edit` is the hashline editor; it anchors on `[path#TAG]` snapshots from an earlier `read` or `grep` of the same collection.
- `ToolCollection.create(cwd)` opens its native mux immediately, so the default tools need `cwd` inside an existing dedicated Btrfs seed subvolume with a writable parent and `user_subvol_rm_allowed` on the mount. `create` rejects outside a seed.
- Explicit `tools` replace the defaults entirely; add `createYieldTool()` to let a run pause voluntarily. A collection you create and pass stays yours to close after the agent.
- File tools and `bash` share the collection's mux. Writes may run in a private snapshot and publish only what Marsh's policy authorizes; a refused publication rejects the call with a typed `MARSH_POLICY_DENIED` error, which pauses the run as a `policy` step.

## Authentication

`model-auth` supports API keys, GitHub Copilot (reusing Copilot CLI credentials or running the device flow), custom `pi-ai` providers, and HTTP proxies. See [`packages/model-auth/README.md`](packages/model-auth/README.md).

## Verification and runtimes

`bun run test` is offline: Pi's `fauxProvider` with caller-supplied tools, and isolated in-memory credentials for the auth tests. It needs no Btrfs seed, native addon or live credentials. It compares a raw harness and `JuncoAgent` over one scripted conversation (images, thinking, tool updates, hooks, steering and follow-up, a mid-run thinking change, a template, compaction and navigation) and covers pauses, iterator ordering, abort, terminal close and the native limits above.

A disposable consumer installed with Bun ran under Node.js v26.10.0 and Bun 1.3.14: the patched entrypoints and a single `pi-agent-core` instance, one owned `NodeExecutionEnv` cleaned up once, an explicit-tools `create` that loaded no `junco-tools` entry, a default-tools `create` over a fresh disposable Btrfs seed that opened and closed one collection, a supplied `env` without tools rejected before model resolution, and identical native events across a separately npm-installed pristine `0.80.6` harness, the patched harness and `JuncoAgent`. Real Marsh denials pausing a run as `policy` steps are covered by [`junco-agency`](../junco-agency)'s suite.
