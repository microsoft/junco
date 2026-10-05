# Agent guidance for junco-agent

Read [README.md](README.md) for setup and user-facing usage. This file describes the contracts to preserve when changing this repository.

## Scope and compatibility

- This is a private ESM TypeScript library. `JuncoAgent` extends Pi's `AgentHarness` unchanged as the conversation/control plane and adds a cooperative lifetime iterator over scheduling boundaries. It has no dataflow graph, persistence layer, capability checking, standalone agent CLI, native code, or Cargo manifest; `bun run cli <seed>` only launches Pi's CLI with the `junco-tools` extension. Graphs of agents live in the workspace root package [`junco-agency`](../..). Never import from or depend on `../junco-runtime`.
- Pins: Bun `1.3.14` for package management and tests, TypeScript `6.0.3`, and every `@earendil-works/*` package at exactly `0.80.6` (`pi-agent-core` also forced through the workspace root's `overrides`). That is the Pi version `junco-tools` declares as its peer and the version the patch targets. Supported runtime: Linux x86-64 with glibc and Node.js `>=22.19.0`.
- Runtime dependencies are exactly `junco-tools` (`workspace:*`, the workspace package at `../junco-tools`), `pi-agent-core`, `pi-ai`, `pi-coding-agent` (Pi's login-backed `ModelRuntime`, also a `junco-tools` peer) and `typebox` (the `yield` schema). Never substitute a registry package or the old monorepo's tools package.
- Keep changes scoped to the request and preserve unrelated local work. Unless explicitly authorized, do not push, publish, edit `../junco-tools` from here, or create or mount Btrfs volumes.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/agentic.ts` | The `Agentic` contract: `AgentHarnessApi`, `AgenticStatus`, `AgenticYieldReason`, `AgenticStep`, `AgenticOptions`, `AgenticConstructor`. Types only. |
| `src/junco-agent.ts` | `JuncoAgent`: run admission through the patch's per-run integration, pause recording and gating, the demand queue, status, abort, terminal close, the protected subclass hooks, and the `create` factory with its owned resources. |
| `src/index.ts` | Public exports: the contract types, `JuncoAgent`, `AgenticRun`, `JuncoAgentCreateOptions`, `TaskAgentOptions`. Nothing else; `createYieldTool`, `createTaskTool` and their helpers and types are owned and exported by `junco-tools`. |
| `patches/@earendil-works%2Fpi-agent-core@0.80.6.patch` | The one canonical Pi patch, registered here and by consumers (`../junco-agency`) from their own roots. |
| `scripts/run-cli.sh` | Bun script launcher: enter the caller's dedicated Btrfs seed, exec pinned Pi `cli.js` with the installed `junco-tools` extension, and forward Pi arguments. |
| `test/harness.ts` | Offline scaffolding: `scripted`/`nativeOptions` (faux model, in-memory session, no tools), `newAgent`, `gatedTool`, `countingTool`. |
| `test/junco-agent.test.ts` | Native fidelity against a raw harness, iterator ordering, pauses, abort, terminal close, the native limits, `create` ownership, and saved Pi login/error behavior. |

`dist/`, `node_modules/`, `*.tsbuildinfo`, and `graphify-out/` are generated and ignored. Dependencies are locked by the workspace root's `bun.lock`.

## Build and verification commands

Install once at the junco-agency workspace root, then run from `packages/junco-agent`:

```sh
bun install --frozen-lockfile    # at the workspace root
bun run build
bun run typecheck
bun run test
```

- Build `junco-tools` first. If its `dist/` or `native/junco_tools.linux-x64-gnu.node` is missing, run `bun run build` in `../junco-tools`, following its README. Do not change its Cargo configuration or backend from here.
- The workspace links `junco-tools` to `../junco-tools`, so its compiled output and native addon are read from there.
- `build` and `typecheck` invoke TypeScript directly. `tsconfig.json` includes only `src/**/*.ts`, so the tests are not type-checked. `verbatimModuleSyntax` is on.

## The Pi patch

- Change Pi only through `bun patch @earendil-works/pi-agent-core@0.80.6` and `bun patch --commit`, then make the committed file a standard `git diff` with `a/`/`b/` package-relative headers: Bun `1.3.14` writes machine-specific paths into deleted- and added-file headers, and its output is not portable until normalized. Deleted source maps keep header-only deletions, which Bun applies.
- New files the patch adds live at the package root (`agentic-integration.js`/`.d.ts`, exported as `./agentic-integration`). Bun `1.3.14` creates a new file's parent directory relative to the installing project instead of the package, with the file's mode, so a new `dist/…` file leaves an unusable empty `dist/` in every consumer that installs the patch fresh.
- The patch adds only per-run integration and never changes behavior without it. Its surface: the `./agentic-integration` export (`AGENTIC_INTEGRATION_REVISION` and the `AgentRunIntegration` observer type); protected `createRunIntegration(kind)`, called once by `prompt`/`skill`/`promptFromTemplate` after the busy guard and before their first await; protected `abortDependents()`, started by `abort()` right after notifying the run's controller and joined after `waitForIdle` and before the `abort` event; protected `flushPendingSessionWrites`; and an optional last `integration` argument of `runAgentLoop`. Uninstrumented calls keep their exact control flow and promises. Source maps are removed only for the edited modules.
- Observer callbacks: `controller` after the run's `AbortController` is installed; `beforeTools` with the complete assistant message before its batch executes; `toolOutcome` right after each actual `execute` promise settles (argument validation, hooks and update listeners are not observed; a failure is rethrown unchanged); `track` for every started parallel worker and update emission, never awaited; `afterTurn` only on the normal path after `turn_end` delivery, before the next turn is prepared (a returned promise gates the next request); `abandoned` when the low-level run rejects, before native failure reporting. Only `afterTurn` may be asynchronous; none may throw.
- Bump `AGENTIC_INTEGRATION_REVISION` together with `REQUIRED_INTEGRATION_REVISION` in `src/junco-agent.ts` whenever the observer contract changes.

## Lifetime invariants

1. `JuncoAgent` overrides only the three run-starting methods (to scope admission and reject while a prompt is staged or after close), the mutating operations (to reject after close and track them), `abort()`, and the protected hooks. It never proxies, re-emits, wraps tools or providers, or replaces native arguments, results, errors or event order. Native getters and `systemPrompt` keep native identity and `this`.
2. Admission uses a stack of synchronous invocation scopes filled by `createRunIntegration`; a call Pi rejects as busy fills none and publishes nothing, while every admitted run publishes exactly one `settled` or `failed` boundary — including a `before_agent_start` hook that throws a busy-coded error, and missing skills or templates.
3. Pause reasons belong to their run and assistant message, keyed by tool call id, and are ordered by the batch's tool results at `afterTurn`. Only tools created by `junco-tools`' `createYieldTool()` (checked with its `isYieldTool`, never by name), `createTaskTool()` tools admitted through the host bound by `runWithTaskHost` (checked with `isTaskTool`; the admission, not the mutable result, records the reason), and errors satisfying `isMarshPolicyDenied` (a code check, never message text) record reasons. An abandoned run discards its reasons; late sibling outcomes stay tracked for close but cannot publish a pause.
4. Demands are served strictly in order. A demand takes the oldest unread boundary; only with none does it resume the oldest consumed pause or start the staged prompt. Without a demand every gate stays shut.
5. `abort()` marks the currently admitted runs stopping, calls `super.abort()` exactly once, then releases their gates and drops their unread pauses. It returns the native promise unchanged and never closes resources.
6. Terminal close is one shared operation: it rejects native run-starting and mutating calls from its first instant, starts native abort and `closeDependents()` without awaiting them, releases every gate, joins all admitted operations and tracked work, then the abort and dependents, flushes session writes, and releases factory-owned resources exactly once. Failures aggregate in that order; task failures stay on their own promises and steps.
7. `create` loads the native addon only through `ToolCollection.create` when `tools` is omitted, or through a nonempty MCP definition's connection: the `junco-tools` and `junco-mcp` root imports load no addon, so concrete explicit tools never do. Both factories expand `JuncoMcpTools` sources in order before construction and record each connection as factory-owned; release closes them in reverse, then the collection, then the session repository, and never shuts down the shared ShellMux. It takes ownership only of what it creates. Provider/model ID strings resolve through Pi's `ModelRuntime`, optionally shared via `models`; require the selected provider's saved Pi credential and resolve/refresh it before allocating default sessions/tools. Never start an interactive login or fall back to Copilot CLI credentials: missing/unusable credentials must tell the user to run `/login` in Pi. `fromResolved` remains caller-authenticated.
8. `createSubagents` validates every option before creating a child, gives each child its own `MemorySessionRepo`, and never shares a live MCP client: it reconnects the per-call snapshot of every recorded `McpSourceRegistration` and rebinds the selected tools by `getJuncoMcpToolIdentity`, never by published name. Borrowed local tools hold a `SharedCollection` lease; only the last release closes the collection. Children never receive the caller's hooks, subscriptions, transcript or bound task host.

## Tests and operational boundaries

- The suite is offline. Pi's `fauxProvider` supplies model turns; use response factories to inspect a request's context and keep assertions outside them, because faux turns a thrown assertion into a model error.
- Synchronize with `Promise.withResolvers` gates, never sleeps. `setImmediate` flushes appear only to show that nothing progressed. Lifecycle tests use a `5_000` ms timeout to detect a stuck gate or close.
- Assert observable behavior — steps, statuses, request contexts, execution and request counts, signals, file contents and session state — never wording, spies or wiring.
- A pristine-versus-patched comparison needs a separately installed pristine `0.80.6` (npm does not apply the patch; a Bun alias of the same package would be patched too). Run it from a disposable consumer, never against a second copy of the patched package.
- Verify the native default path only against a disposable dedicated Btrfs seed. Never use an ordinary directory or the home subvolume, never use sudo or mount an image, and without a suitable seed report the default path as unverified.
- Tests and verification never use live LLM credentials.
