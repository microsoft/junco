# Agent guidance for junco-tools

Read [README.md](README.md) for setup and user-facing usage. This file describes the contracts to preserve when changing this repository.

## Scope and compatibility

- This is a private, local TypeScript package with a Rust napi-rs addon. It replaces **Pi's agent `bash` tool** with real marsh ShellMux execution, not Pi's other tools.
- Target `@earendil-works/pi-coding-agent@0.80.6`, not Oh My Pi. Preserve Pi's public tool interface rather than introducing another schema or error-result convention.
- Supported build target: Linux x86-64 GNU/glibc, Node.js >=22.19.0, Rust 1.95.0. Bun is not required by the package.
- Keep changes scoped to the request. Preserve unrelated local work. Do not push, publish packages, change global Git settings, replace system Rust, or create/migrate filesystem subvolumes unless explicitly authorized.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/lib.rs` | Exported napi classes/objects and production/test-only opening factories. |
| `src/mux.rs` | Session ownership, principal admission, execution, cancellation, verdicts, and shutdown. |
| `src/frontend.rs` | Snapshot-UID output routing, JS callback receipts, errors, and closure fences. |
| `ts/operations.ts` | Pi `BashOperations` adapter, lazy mux ownership, timeout/abort handling, and teardown. |
| `ts/bash.ts`, `ts/index.ts` | Thin upstream factory wrappers and public exports. |
| `ts/extension.ts` | Pi session hooks and same-name bash registration. |
| `scripts/with-junco-build-env.mjs` | Isolated Rust homes and authenticated process-local Cargo/Git environment. |
| `tests/bash.test.mjs` | Three retained real-native regression cases. |

`dist/`, `native/index.js`, `native/index.d.ts`, native binaries, `target/`, and `node_modules/` are generated/ignored. Do not hand-edit generated loaders or declarations. Keep both `Cargo.lock` and `package-lock.json` tracked.

## Build and verification commands

Run from the repository root after installing the prerequisites in README:

```sh
npm ci
npm run build
npm run build:native:test
timeout --signal=TERM --kill-after=5s 90s \
  node --test --test-concurrency=1 tests/bash.test.mjs
```

The native build must precede TypeScript declaration compilation. Production output goes to `native/`; the explicitly enabled test addon goes to `target/native-test/`, never over the production addon.

For focused Rust checks and formatting, use the same launcher as the npm native build scripts:

```sh
node scripts/with-junco-build-env.mjs cargo check --locked
# The minimal Rust profile does not include rustfmt; install it when needed.
node scripts/with-junco-build-env.mjs rustup component add rustfmt --toolchain 1.95.0
node scripts/with-junco-build-env.mjs cargo fmt --all
```

The launcher defaults to `$HOME/.local/share/junco-tools/cargo` and `$HOME/.local/share/junco-tools/rustup`, while preserving explicitly supplied homes and SSH settings. It supplies Cargo's CLI-fetch environment and the private junco HTTPS-to-SSH transport rewrite to child processes. Do not replace it with Cargo `[env]`, a consumer-only Git rewrite, or global credential configuration.

### Dependency changes

- Treat `Cargo.toml` and `Cargo.lock` as the source of truth for approved revisions. Do not silently switch to branch tips or local path dependencies to make a build pass.
- Keep the consumer-root `[patch.crates-io]` for `brush-core`. Registry brush-core does not provide the required fork behavior; a dependency's own patch does not propagate to this consumer.
- Keep all direct and transitive marsh sibling crates on the same Git URL/revision and crate identity. Do not add the root `marsh` application or unrelated rmux patches to this package.
- The lockfile deliberately keeps `napi-derive-backend` at 5.0.4 for napi 3.9.0 compatibility. Review codegen compatibility before changing that resolution.
- Use locked builds. After an intentional dependency update, inspect `cargo metadata --format-version 1 --locked` and `cargo tree` through the launcher: one Git-patched brush-core, shared marsh source identities, and one compatible Tokio. Verify `marsh-btrfs/fake` is absent from production and enabled only by `test-fs`.

## Native execution invariants

1. Use marsh's real `MarshExecutor`, `ShellMux`, `PolicyValidator`, and spawn APIs. Production opens the caller's cwd with `MarshExecutor::open`; seed discovery, leasing, and recovery belong to marsh. Do not use a detached/default executor or another shell/process runner as a fallback.
2. Use napi's existing long-lived Tokio runtime. Construct muxes inside an async factory; run blocking filesystem opening off the JS thread. Keep a fresh validator per seed/mux and the same builtin profile across muxes.
3. Allocate cancellation state, the result watch, and the callback synchronously before scheduling a run. An immediate abort must not be lost. Never drop an in-progress spawn future and orphan its admitted job.
4. Serialize one principal's runs in admission order through full cleanup, including cancelled queued runs. Use `ShellId::durable` for the caller-controlled agent identity, but create a fresh shell/snapshot for every call. Distinct agents must use distinct principals. Never reassign legacy snapshot-owned grants.
5. Canonicalize cwd, require a directory within the mux's seed, and derive the relative directory with `strip_prefix`. Do not use a silent root fallback or interpolate cwd/environment values into shell text.
6. Use `JobIo::Pipes`, supply the complete exported environment, register the UID output route before command admission, and close stdin to provide real EOF. No hidden PTY.
7. Route output by `SnapshotUid`, not reusable names, and retain only a weak mux reference in the frontend. Copy borrowed bytes once into an owned Buffer, dispatch nonblocking, and acknowledge a stream's receipt only after its JS callback returns successfully. Callback, enqueue, and I/O failures must reject the run, not disappear or become fatal Node exceptions.
8. A command verdict is not an output fence. Wait for the verdict, job closure, frontend `Closed`, and every queued JS callback. Normal success requires `Outcome::Published` and an actual process status. A zero-exit policy denial or stale snapshot is still an error; do not invent an exit code or add `details.marsh`.
9. Record user cancellation and timeout separately from publication outcomes. `abort()` records/notifies cancellation without synchronously re-entering the mux from a JS callback. Stop through ShellMux and await owned cleanup; an arbitrary discarded verdict is not proof of timeout.
10. Close is idempotent: refuse new admissions, cancel/join pending runs, await mux shutdown, release callbacks and strong executor/mux ownership, and let concurrent close callers join the same completion. Retaining a completed `NativeRun` must not retain the seed lease.

## Pi adapter invariants

- Import supported APIs from the **root** Pi package, not its unexported `dist/...` subpaths. Keep wrapper types exactly `typeof` the upstream factories and re-export Pi's existing tool types.
- Preserve caller-supplied operations, `commandPrefix`, `spawnHook`, and option types. Selecting operations intentionally supersedes `shellPath`.
- For SDK `customTools`, use Pi's public `defineTool(createBashToolDefinition(...))` helper. It accommodates typed renderers in tool arrays without casts or competing schemas. `createAgentSession`'s `tools` option contains names; `pi.registerTool` directly accepts the typed definition.
- Timeouts are seconds, optional with no default deadline. Match Pi's validation and abort/timeout sentinels before opening/starting work. Keep the abort listener for the whole operation, including pending opens and principal admission.
- Omit undefined environment values; never stringify them or mutate `process.env`. Forward Buffer chunks directly. Pi owns streaming UTF-8 decoding, truncation, and full-output persistence.
- Each default operations owner has one lazy opening promise, assigned before awaiting. Clear failed openings for later explicit invocations. The owner set is for teardown, not a seed cache/pool.
- An explicitly supplied mux is borrowed and must be closed by its caller. Default-owner shutdown must dispose owners, join pending opens, and close successfully opened muxes even if another owner fails. Do not rely on asynchronous GC finalizers.
- Register only the agent's `bash` tool on `session_start`, using the Pi session ID as its durable principal and Pi's public settings API for the persisted prefix. Await shutdown on `session_shutdown`. Do not intercept `user_bash` or instruct users to disable built-in bash.

## Tests and operational boundaries

- Verify execution changes with the **real Node addon, ShellMux, and Pi factory/registered tool**, not interface-shaped mocks or import-only checks. No provider request or LLM credentials are needed to invoke a registered tool directly.
- The retained Node suite covers complete multi-chunk/final-marker output before settlement, callback-error rejection followed by session reuse, and zero-exit atomic policy denial. Keep cases isolated, bounded, and explicit about native close in `finally`. New tests should protect observable behavior, not source text, wiring, or incidental wording.
- `NativeMux.openCopyTree` is available only in the `test-fs` addon and requires an explicit existing fixture directory. Ordinary `NativeMux.open` still selects real btrfs, even in that addon. There is no environment-variable fake-filesystem fallback.
- CopyTree verifies adapter/interpreter/policy/WAL behavior on ext4; it does not establish btrfs ioctl or storage-atomicity correctness. Report real-btrfs checks as untested when no suitable seed is available.
- ShellMux is not OS confinement. Absolute-path writes and network effects remain possible. Cancellation can wait for commands racing the backend's stop scan; use external-process readiness markers for forced-stop fixtures, and do not hide delays by skipping cleanup or applying an OS-child idle-drain shortcut.
- Type-check README TypeScript snippets against the pinned Pi APIs, preserving their renderers and schema types. The project uses strict NodeNext/ES2022 checking with `skipLibCheck` for Pi's vendored declarations. Verify registration without issuing an LLM request, and remove throwaway verification files after use.
