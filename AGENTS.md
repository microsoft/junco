# Agent guidance for junco-agent

Read [README.md](README.md) for setup and user-facing usage. This file describes the contracts to preserve when changing this repository.

## Scope and compatibility

- This is a private ESM TypeScript library. It exposes one `JuncoAgent(options)` async generator that runs a single prompt through a Pi `AgentHarness` in a fresh `InMemorySessionRepo` session. It has no dataflow graph, durable session, persistence layer, capability checking, CLI, native code, or Cargo manifest. Do not reintroduce them, and never import from or depend on `../junco-runtime`.
- Pins: Bun `1.3.14` for package management and tests, TypeScript `6.0.3`, and every `@earendil-works/*` package at `0.80.6`. That is the same Pi version `junco-tools` declares as its peer dependency. Supported runtime: Linux x86-64 with glibc and Node.js `>=22.19.0`.
- Runtime dependencies are exactly `model-auth` (`workspace:*`), `junco-tools` (`file:../junco-tools`), `pi-agent-core`, `pi-ai`, and `pi-coding-agent`. `pi-coding-agent` is there only because `junco-tools` requires it as a peer. If the tools checkout moves, change only that `file:` path and the README prerequisite. Never substitute a registry package or the old monorepo's tools package.
- Keep changes scoped to the request and preserve unrelated local work. Unless explicitly authorized, do not push, publish, edit the sibling `../junco-tools` working tree, or create or mount Btrfs volumes.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/junco-agent.ts` | `JuncoAgent` and `JuncoAgentOptions`: startup on the first `next()`, the default `ToolCollection`, the `Turn` queue, the tool gate, delivery of controls, the completion value, and cancellation. |
| `src/events.ts` | `JuncoControl`, `JuncoAbort`, and `JuncoResult`, the only protocol types. |
| `src/index.ts` | Public exports: those three types, `JuncoAgent`, and `JuncoAgentOptions`. Nothing else. |
| `packages/model-auth/src/model-provider.ts` | `ModelProvider` factories (`apiKey`, `custom`, `githubCopilot`, `httpProxy`), `resolveModel`, the memoized `authenticate` → `runAuth` login, HTTP-proxy and credential-store helpers, and device-flow callbacks. |
| `packages/model-auth/src/copilot-cli.ts` | `discoverCopilotCliToken()` reads the Copilot CLI's `github-copilot/apps.json`. It returns `undefined` on any failure, so the device flow runs instead. |
| `packages/model-auth/src/newtypes.ts` | Compile-time brands `ApiKey`, `HttpProxyUrl`, `ModelId`, and `RepoPath`. `Newtype` is local and unexported. |
| `packages/model-auth/src/index.ts` | Public exports of the auth package. |
| `test/harness.ts` | `scriptedModelProvider` (faux responses or factories, consumed in FIFO order), `newAgent` (faux model, `"sys"`, `PROMPT_TEXT`, `tools: []`, with overrides applied last), and `drive`. |
| `test/junco-agent.test.ts` | Offline regressions: streaming order, failure and abort categories, the tool gate, `return()`/`throw()` at a marker, ordering of controls, and a shared provider. |

`dist/`, `packages/model-auth/dist/`, `node_modules/`, `*.tsbuildinfo`, and `graphify-out/` are generated and ignored. Keep `bun.lock` tracked. Do not copy the old monorepo's lockfile or `.npmrc`.

## Build and verification commands

Run from the repository root:

```sh
bun install --linker hoisted
bun run build
bun run typecheck
bun run test
```

- Install `junco-tools` first. If its `dist/` or `native/junco_tools.linux-x64-gnu.node` is missing, run `npm ci` and then `npm run build` in `../junco-tools`, following its README. Do not change its Cargo configuration or backend from here.
- The hoisted linker is required. It installs `file:../junco-tools` as per-file symlinks, so the compiled output and native addon are read from their paths in the sibling checkout.
- Root `src/` and `test/` import `model-auth` through its package exports, which point at `packages/model-auth/dist/`. `build` and `typecheck` rebuild that package first; `test` does not. After editing auth sources, run `bun run build` before testing. Without that output, the suite fails with `Cannot find package 'model-auth'`.
- `tsconfig.json` includes only `src/**/*.ts`, so `typecheck` does not type-check the tests. Bun strips test types at runtime. `verbatimModuleSyntax` is on, so type-only imports must use `import type`.

## Generator invariants

1. Nothing runs until the first `next()`. There is no initial empty yield and no separate initialization factory. On that call, the checks run in this order:
   - An empty `systemPrompt` throws a plain `Error`.
   - A prompt that is empty after trimming throws `{ code: "protocol" }`.
   - Any failure in resolving the model, creating the session, loading the default tools, or constructing the harness throws `{ code: "invariant", message: "JuncoAgent: initialization failed: …" }`.

   Tests assert these error categories, not their wording.
2. Normalize `cwd` with `resolve(options.cwd ?? process.cwd())` and nothing else. `thinkingLevel` defaults to `"off"`. `AgentHarness` uses its default generics and plain string prompts.
3. Yield raw strings only: the content of each completed `thinking_end` or `text_end` block, and `[tool:<toolName>]` before each tool runs. Never yield token deltas or wrap values in an envelope.
4. The completion value accumulates answer text only. If no answer block arrives, it falls back to the text of the final assistant message.
   - On success, return `{ text: answer.trim(), details: { failed: false } }`.
   - If the prompt rejects, or the final stop reason is `error` or `aborted`, return `{ text: "prompt failed: " + message, details: { failed: true, message } }`. Never yield that text.
5. The `tool_call` hook returns a pending promise, and at most one gate is pending per generator, because Pi prepares tool calls one at a time. At a marker, deliver that resume's controls in array order before releasing the gate with `{}`: `steer` goes to `harness.steer`, `followUp` to `harness.followUp`. This ensures the next model turn cannot outrun the controls. Drop a control that fails because the prompt has already settled.
6. On `return()` or `throw()` while the prompt is running, the order is:
   1. `const aborting = harness.abort()`, not awaited.
   2. Release the pending gate.
   3. `await aborting`.

   In Pi `0.80.6`, `abort()` flips its signal synchronously and then waits for the run. The run is blocked on the gate, so awaiting first deadlocks. After the hook returns, `prepareToolCall` checks the signal again, so a released gated tool never executes. Propagate abort failures, and unsubscribe both listeners in a nested `finally` even when abort throws.
7. A generator never calls `shutdownShellMux()`. That call is process-wide and would close other agents' shells. The embedding application awaits it once at shutdown.

## Tools and auth boundaries

- Only when `tools === undefined`, dynamically `import("junco-tools")` and call `ToolCollection.create(cwd)` once for that generator. The tools arrive in this order: `read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`. Keep the import dynamic, so explicit tools (including `[]`) never load the native addon.
- Any explicit array replaces the defaults entirely. Do not append Pi's `write` or `ls`, add harness built-ins, or fall back to another backend when the native addon fails to load.
- Each generator gets its own collection. Its single native `EditStore` is what makes the `[path#TAG]` headers from `read` and `grep` valid anchors for the hashline `edit`. Never share a collection across generators or create a store per tool.
- Path existence, the Btrfs seed requirement, and tool execution errors belong to `junco-tools` at execution time. Do not add preflight validation, create `cwd`, or add a shell fallback.
- Preserve the `ModelProvider` factories and the auth package's public exports. `authenticate` is memoized per provider instance (`authOnce`, keyed by the first caller's model), so generators that share a provider share one login. Keep the brands local; do not reintroduce a `share` package.

## Tests and operational boundaries

- The suite is offline. Pi's `fauxProvider` supplies model turns through `scriptedModelProvider`. To inspect the next request context, use response factories. Keep assertions outside the factories, because faux turns a thrown assertion into a model error.
- Use caller-supplied stateful tools only in gate and abort tests. Assert observable behavior: yields, completion values, captured model context, execution counts, and the run's abort signal. Do not assert spies, wiring, or wording. Lifecycle tests use a `5_000` ms test timeout to detect a stuck gate or abort. Never synchronize with sleeps.
- Verify changes to the default native path with a throwaway ESM script against the built `dist/index.js`, run under both Node and Bun. No `tools` override is set. In an ordinary temporary directory, a faux model calls the real `read` and then the hashline `edit`.
  - Assert the eight offered tool names, the yields, the file contents, and the completion value.
  - In `finally`, close the generator, await `shutdownShellMux()` once, and remove only that temporary directory.
  - Delete the script afterwards. Never commit it.
- `bash` alone needs an existing **dedicated** Btrfs seed subvolume, a writable parent directory, and the `user_subvol_rm_allowed` mount option. Never point shell work at the home subvolume, use sudo, or mount an image. When no seed is available, report `bash` as untested.
- Tests and verification never use live LLM credentials.
