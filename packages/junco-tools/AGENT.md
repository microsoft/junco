# Agent guidance for junco-tools

Read [README.md](README.md) for setup and user-facing usage. This file describes the contracts to preserve when changing this repository.

## Scope and compatibility

- This is a private, local TypeScript package with a Rust napi-rs addon. It replaces **Pi's agent `bash`, `read`, `edit`, `grep`, and `find` tools** and adds `ast_grep`, `ast_edit`, and `diff`. `bash` runs on marsh ShellMux; the file tools run on Oh My Pi's `pi-ast`/`pi-diff`/`pi-walker`/`pi-edit` engines, imported unmodified from a pinned public Git revision, each call routed through the same mux as a marsh tool call. Pi's `write`, `ls`, and `user_bash` stay untouched.
- Target `@earendil-works/pi-coding-agent@0.80.6`, not Oh My Pi. Preserve Pi's public tool interface rather than introducing another schema or error-result convention.
- Supported build target: Linux x86-64 GNU/glibc, Node.js >=22.19.0, Rust 1.95.0. Bun is not required by the package.
- Keep changes scoped to the request. Preserve unrelated local work. Do not push, publish packages, change global Git settings, replace system Rust, or create/migrate filesystem subvolumes unless explicitly authorized.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/lib.rs` | Exported napi classes/objects, the `sandbox` mux option, owner-bound handles (`forkOwner`), and production/test-only opening factories. |
| `src/mux.rs` | Session ownership, principal admission, execution, routed tool calls (each acting as its handle's policy owner), cancellation, verdicts, and shutdown. |
| `src/tool.rs` | Routed file tools: the `JuncoTool` classification, the mux's sandbox policy (`release` always managed), and the `NativeMux` file-tool and `release` methods that run inside marsh calls. |
| `src/frontend.rs` | Snapshot-UID output routing, JS callback receipts, errors, and closure fences. |
| `src/policy.rs`, `ts/policy.ts` | `NativePolicy` (lock, empty) and its `and`/`or`/`not` combinators as open `marsh_core::Policy` implementations; the open TS `Policy` interface, whose `toNative(native)` builds it per addon, with `LockPolicy`, `EmptyPolicy` and the same combinators. A new policy adds one native factory and one `Policy` object; nothing enumerates them. |
| `ts/shell-mux.ts` | `ShellMuxLease.create`: opens one fresh, owned ShellMux per call with its policy (default `LockPolicy`), validates cwd, logs policy decisions, and returns a lease whose `release()` closes the mux and flushes the policy log. |
| `ts/operations.ts` | Pi `BashOperations` adapter: borrows a supplied mux or lazily owns one (default `LockPolicy`), its own runs, timeout/abort handling, and local `close()`. |
| `src/ast.rs`, `src/diff.rs`, `src/edit.rs`, `src/glob.rs`, `src/glob_util.rs`, `src/grep.rs`, `src/iofs.rs`, `src/js.rs` | Oh My Pi `pi-natives` binding modules transplanted from the pinned revision (see `LICENSE.oh-my-pi`), verbatim except for the routing seams: filesystem exports split into a JS-thread `prepare` and an engine run `src/tool.rs` calls, `ast_edit` writing through a host writer, and `EditStore`'s tracked keys. `grep.rs` is the implementation, not a binding: upstream has no importable grep library. |
| `src/task.rs`, `src/testing.rs` | Blocking-task/cancellation support those modules need, adapted from the same revision. |
| `ts/tool-support.ts` | Shared adapter primitives: path resolution/display, editable-text normalization, bounded output, u32 validation, and `withNativeSignal`. |
| `ts/read.ts`, `ts/grep.ts` | Snapshot-anchored `[path#TAG]` + numbered-row output over Pi's read/grep contracts. |
| `ts/mime.ts` | Pi's image type sniffing, ported verbatim because Pi does not export it. |
| `ts/edit.ts` | The hashline edit tool: one routed `mux.edit` call per edit. |
| `ts/release.ts` | The `release` tool: one routed, always-managed `mux.release` call per file. |
| `ts/find.ts`, `ts/ast.ts`, `ts/diff.ts` | Native walker behind Pi's `find`, plus the structural-search/rewrite and diff tools. |
| `ts/collection.ts` | `ToolCollection`: one `EditStore`, its own mux owner and policy, the complete ordered tool list, per-owner `bind()` sets, creator/borrower holds (`close()`/`lease()`), and final teardown that drains its invocations and closes its mux. |
| `ts/yield.ts` | The native-free `yield` tool and the module-private registry behind `isYieldTool`: only its own tool objects are scheduling primitives for `junco-agent`. Keep factory and registry in this one module. |
| `ts/bash.ts`, `ts/index.ts` | Thin upstream factory wrappers and public exports. |
| `ts/extension.ts` | Pi session hooks and same-name collection registration. |
| `scripts/with-junco-build-env.mjs` | Isolated Rust homes and authenticated process-local Cargo/Git environment. |
| `scripts/rustc-bootstrap-shim.sh` | `RUSTC_WRAPPER` exporting `RUSTC_BOOTSTRAP` for `xutf` only; every other crate compiles as plain stable. |
| `scripts/test-btrfs.mjs` | Argument-free `test:btrfs` entrypoint: owns one disposable fixture around the production lane. |
| `tests/helpers.mjs`, `tests/scripted-model.mjs` | CopyTree seeds (`seedFixture`) and raw test muxes (`fixture`/`closeFixture`), the stable `copyTreeNative()` adapter for automatic acquisition, the ordered `cleanup`/`settleAgent` release helpers, the shared SDK resource bootstrap, the shared stdout-writer body, the held-child gate protocol, and the faux-provider scripting used by the suites. |
| `tests/shell-mux.test.mjs` | Resource-local mux lifecycle on the CopyTree addon: independent muxes and policies over one seed, refused configurations/cwds, failed opens, close/release idempotence, persistent `NativeProcess` basics, and forked owners/`release` in both sandbox modes. |
| `tests/bash.test.mjs` | Tool, output, cancellation, and native admission/shutdown cases on the CopyTree addon. |
| `tests/agent.test.mjs` | Real Agent loop with standalone bash and file tools, the native-free `yield` tool in a bare Agent, and SDK `customTools` registration, with scripted model responses. |
| `tests/tools.test.mjs` | Collection file tools over a CopyTree seed: hashline provenance, snapshot fidelity, staging, search boundaries, publication gating, and SDK registration. |
| `tests/btrfs-fixture.mjs` | Automatic `target/btrfs-test-*` fixture allocation, owned-cwd handoff, and subvolume reclaim. |
| `tests/btrfs-fixture.test.mjs` | Fixture-ownership lifecycle: success with nested subvolumes, child failure, interruption with descendants, concurrent isolation, synchronous/asynchronous spawn failure, cancellation, and a signal during descendant draining. |
| `tests/extension.btrfs.mjs` | Opt-in production lane: packaged extension, per-session collection mux lifecycle, ownership release without a live peer and removal-triggered release (both across reopening the seed), and nested-seed refusal on a real btrfs seed. Runs only as a fixture child (`test:btrfs`). |
| `tests/extension.test.mjs` | Lets plain `bun test` run that lane: owns one fixture around a Node run of `extension.btrfs.mjs`. |

`dist/`, `native/index.js`, `native/index.d.ts`, native binaries, `target/`, and `node_modules/` are generated/ignored. Do not hand-edit generated loaders or declarations. Keep `Cargo.lock` tracked; JavaScript dependencies are locked by the junco-agency workspace root's `bun.lock`.

## Build and verification commands

Install once with `bun install --frozen-lockfile` at the junco workspace root, then run from `packages/junco-tools` after installing the prerequisites in README; Cargo builds marsh and junco-policy from the monorepo's `crates/`:

```sh
bun run build
bun run build:native:test
bun run test
bun run test:btrfs
```

The native build must precede TypeScript declaration compilation. Production output goes to `native/`; the explicitly enabled test addon goes to `target/native-test/`, never over the production addon. `bun run test` needs the test addon; `bun run test:btrfs` needs the production addon and a `target/` on a writable btrfs mount carrying `user_subvol_rm_allowed`. It takes no arguments and no configuration: every run allocates its own `target/btrfs-test-*` root with a fresh empty seed subvolume, hands it to the child suites as their working directory, and deletes exactly that root afterwards. Without a suitable mount it fails with its filesystem prerequisite; never sudo, mount an image, or substitute the checkout or home subvolume.

For focused Rust checks and formatting, use the same launcher as the package's native build scripts:

```sh
node scripts/with-junco-build-env.mjs cargo check --locked
# The minimal Rust profile does not include rustfmt; install it when needed.
node scripts/with-junco-build-env.mjs rustup component add rustfmt --toolchain 1.95.0
node scripts/with-junco-build-env.mjs rustfmt --edition 2024 src/lib.rs src/mux.rs src/frontend.rs
```

Format junco-authored files only. The transplanted `pi-natives` modules keep upstream's formatting so re-extracting them from a newer pinned revision stays a readable diff; `cargo fmt --all` would rewrite all of them.

The launcher defaults to `$HOME/.local/share/junco-tools/cargo` and `$HOME/.local/share/junco-tools/rustup`, while preserving explicitly supplied homes. It supplies Cargo's CLI-fetch environment to child processes. Do not replace it with Cargo `[env]` or global configuration.

### Dependency changes

- Treat `Cargo.toml` and `Cargo.lock` as the source of truth for approved sources. `marsh-core` and `marsh-btrfs` are path dependencies on the monorepo's `crates/marsh`, which takes `junco-policy` from `crates/junco-policy`; everything else stays on its pinned Git revision or registry version. Do not switch anything else to a branch tip or a local path to make a build pass.
- Keep the consumer-root `[patch.crates-io]` for `brush-core` and `brush-interactive`, pointing at `crates/marsh/crates/`. Registry brush-core does not provide the required fork behavior; a dependency's own patch does not propagate to this consumer.
- Keep every direct and transitive marsh crate resolving to `crates/marsh` with a single crate identity each, never a Git-backed duplicate. Do not add the root `marsh` application or the rmux packages to this package.
- The lockfile deliberately keeps `napi-derive-backend` at 5.0.4 for napi 3.9.0 compatibility. Review codegen compatibility before changing that resolution.
- Use locked builds. After an intentional dependency update, inspect `cargo metadata --format-version 1 --locked` and `cargo tree` through the launcher: one path-patched brush-core, every marsh crate and junco-policy resolving to the local `crates/` sources, and one compatible Tokio. Verify `marsh-btrfs/fake` is absent from production and enabled only by `test-fs`; `marsh-btrfs` itself is an ordinary dependency because production seed discovery needs `PersistenceLayer`/`LibBtrfs`.
- The Oh My Pi engines are pinned Git dependencies (`pi-ast`, `pi-diff`, `pi-walker`, `pi-edit` at `7ae76f8e4daca0c8f409f61bcd514260cd522365`). Import them unmodified from that one URL/revision so each package keeps a single crate identity. Do not vendor them, add a `path` dependency, follow a branch, or point any build step at a local Oh My Pi checkout.
- `src/*.rs` binding modules are transplants, not junco-authored code. When updating the pinned revision, re-extract them from that same commit rather than patching them in place, re-apply only the routing seams listed in the source map, and keep the source/licence attribution.
- Oh My Pi builds on nightly, so the `xutf` crate in `pi-edit`'s tree needs unstable features. Keep that confined to `scripts/rustc-bootstrap-shim.sh`; do not move `rust-toolchain.toml` off stable 1.95.0 or export `RUSTC_BOOTSTRAP` globally.

## Native execution invariants

1. Use marsh's real `ShellMux`, `PersistenceLayer` and `Shell` APIs. A factory discovers its seed with `PersistenceLayer::discover` and leases nothing; the seed's lease, its log recovery and its one validator belong to the first shell a command opens. Do not create a bootstrap shell to take a lease early, and do not use a detached executor or another shell/process runner as a fallback.
2. Use napi's existing long-lived Tokio runtime. Construct muxes inside an async factory, on that runtime, and run blocking filesystem discovery off the JS thread. One `NativeMux` is one seed and one `Subvolumes` instance, used for both discovery and the session.
3. Allocate cancellation state, the result watch, and the callback synchronously before scheduling a run. An immediate abort must not be lost. Never drop an in-progress `open_shell` future and orphan the shell it admitted.
4. Serialize one principal's runs in admission order through full cleanup, including cancelled queued runs: upstream refuses a duplicate live principal and a concurrent command rather than queueing. Open a fresh pipe shell for every call and never `get_shell` to retain variables. Distinct agents must use distinct principals. A principal is an identity, not a claim on an earlier session's unsettled paths.
5. Canonicalize cwd, require a directory within the mux's seed, and reject a working directory whose own discovered seed differs — before a shell exists, so a single-seed session cannot silently lease a nested seed. Do not use a silent root fallback or interpolate cwd/environment values into shell text.
6. Use `JobIo::Pipes`, supply the complete exported environment, register the UID output route before command admission, and close stdin to provide real EOF. No hidden PTY.
7. Route output by `SnapshotUid`, not reusable names, and retain only a weak mux reference in the frontend. Copy borrowed bytes once into an owned Buffer, dispatch nonblocking, and acknowledge a stream's receipt only after its JS callback returns successfully. Callback, enqueue, and I/O failures must reject the run, not disappear or become fatal Node exceptions.
8. A command verdict is not an output fence. Wait for `run_command`, shell closure and every queued JS callback through the route's own drain. `run_command` resolving `Ok` already means `Outcome::Published`; never re-decide publication from the outcome, and still require an actual process status. Inspect a denial's outcome only for its diagnostics, and do not add `details.marsh`.
9. Record user cancellation and timeout separately from publication outcomes. `abort()` records/notifies cancellation without synchronously re-entering the mux from a JS callback. Stop through the shell and await owned cleanup; a lost acceptance receipt is never permission to replay an effectful line, and an arbitrary discarded verdict is not proof of timeout.
10. Close is idempotent: refuse new admissions synchronously on the JS call, cancel/join pending runs, join accepted tool calls, await mux shutdown, release callbacks and strong mux ownership, and let concurrent close callers join the same completion. Retaining a completed `NativeRun` must not retain the seed lease.
11. Every file-tool call is one `JuncoTool` call through `ShellMux::run_tool`, classified by its `Action`: a read-only call never takes the managed route. Its operation writes only through the call's `BuiltinContext` I/O (`open`, `create_dir_all`, `remove_file`), never raw `std::fs` on a physical path, or managed publication refuses the change as unobserved. Returned paths and messages name the seed, never a snapshot.

## Pi adapter invariants

- Import supported APIs from the **root** Pi packages, not their unexported `dist/...` subpaths. Keep the bash wrapper's type exactly `typeof` the upstream factory and re-export Pi's existing tool types.
- Preserve caller-supplied operations, `commandPrefix`, `spawnHook`, and option types. Selecting operations intentionally supersedes `shellPath`.
- Every public factory returns one Pi `AgentTool` (four-argument `execute`) that still carries Pi's prompt metadata and renderers. File tools are built as `satisfies ToolDefinition` and returned as `AgentTool`; bash merges upstream's `BashTool` onto upstream's definition, both given one resolved options object. The same object serves a bare `Agent`, SDK `customTools`, and `pi.registerTool`; do not add `defineTool` wrapping, casts, or a parallel definition-producing API. An optional runtime context stays optional: `read` forwards it to Pi's fallback when present and uses Pi's context-free reader otherwise. `createAgentSession`'s `tools` option contains names.
- Timeouts are seconds, optional with no default deadline. Match Pi's validation and abort/timeout sentinels before opening/starting work. Keep the abort listener for the whole operation, including pending opens and principal admission.
- Omit undefined environment values; never stringify them or mutate `process.env`. Forward Buffer chunks directly. Pi owns streaming UTF-8 decoding, truncation, and full-output persistence.
- An operations owner borrows a supplied `mux` (never closing it; an explicit policy/sandbox must match) or lazily opens one owned lease, assigned before awaiting. Clear a failed acquisition so a later invocation retries; once closed it never acquires, even when close races the first open.
- There is no process-wide ShellMux. Each collection, `ShellMuxLease.create` lease, and owning operations instance has its own mux and policy. Borrowers (agents, graphs, coroutines, MCP connections) take `collection.lease()` holds; only the final release fences execution, drains, and closes the mux. Tests close their own leases/collections in `finally`. Do not rely on asynchronous GC finalizers.
- Register the whole `ToolCollection` on `session_start`, using the Pi session ID as bash's stable principal and Pi's public settings API for the persisted prefix. Close the collection on `session_shutdown`. Do not intercept `user_bash`, replace `write`/`ls`, or instruct users to disable built-in tools.

## File-tool invariants

- One collection, or one standalone caller, owns exactly one native `EditStore` shared by its `read`, `grep`, and `edit`. Never create a store per tool, use a process-global store, disable seen-line enforcement, or synthesize hash tags in TypeScript.
- A `[path#TAG]` header may only be emitted for content the caller actually displayed, derived from the same buffer that produced the rows. Never re-read a file after display to mint its tag. Grep rows that native shortened, that disagree with the snapshot, or that fall past the output cap grant no provenance, and their section loses its tag.
- The snapshot is pi-edit's editable view: one leading BOM stripped, CRLF/CR folded to LF, notebooks decoded to cell-marker text. Writes hand native-supplied text back verbatim, so BOM/CRLF/notebook serialization stays owned by pi-edit.
- `edit` is Oh My Pi's hashline contract (`{ input: string }`), not Pi's replacement schema. Do not add `oldText`/`newText` aliases, a mode argument, automatic syntax repair, retries, or a second mutation engine. Apply every edit as one routed `mux.edit` call.
- Reject non-finite, fractional, or out-of-range numbers before they become NAPI `u32` fields; truncation there would silently change the requested search boundary.
- Route every native worker call through `withNativeSignal`. The pinned napi runtime writes the supplied signal's `onabort`, so forward a fresh per-call controller instead of the caller's signal, and always await the worker to settlement rather than racing it.
- Invalidate the walker scan cache around attempted mutations, covering both sides of a move, so a partially completed write cannot leave the cache looking fresh: `mux.edit` does so for every path it touched, `ast_edit` in a `finally` for its root.

## Tests and operational boundaries

- Verify execution changes with the **real Node addon, ShellMux, and Pi factory/registered tool**, not interface-shaped mocks or import-only checks. No provider request or LLM credentials are needed to invoke a registered tool directly.
- `bun run test` covers Pi tool semantics (publication, streams, exit status, non-PTY stdin EOF, cwd/prefix/hook/env, seed containment, fresh shell over a durable filesystem), Pi's line/byte truncation and complete spills, abort/timeout retention, timeout validation, native admission/queue/close boundaries, independent per-owner muxes/policies and their close lifecycle, persistent processes, the real Agent loop, and SDK `customTools` registration. Keep cases isolated, bounded, and explicit about native close in `finally`. New tests should protect observable behavior, not source text, wiring, or incidental wording.
- Use the shared `tests/helpers.mjs` fixture and held-child gate protocol for readiness: a held child prints a marker and polls a host-created gate file **outside** the snapshot. Never use a sleep, a preparatory builtin, or a gate inside the seed. Release test-owned resources through `cleanup(...)` so every step is attempted in order and every failure is reported; it is for releases, not for command execution or for unconditional deletion after a drain that was never proved.
- `NativeMux.openCopyTree` is available only in the `test-fs` addon and requires an explicit existing fixture directory. Ordinary `NativeMux.open` still selects real btrfs, even in that addon. There is no environment-variable fake-filesystem fallback.
- CopyTree verifies adapter/interpreter/policy/WAL behavior on ext4; it does not establish btrfs ioctl or storage-atomicity correctness. Report real-btrfs checks as untested when no suitable seed is available.
- ShellMux is not OS confinement. Absolute-path writes and network effects remain possible. Cancellation can wait for commands racing the backend's stop scan; use external-process readiness markers for forced-stop fixtures, and do not hide delays by skipping cleanup or applying an OS-child idle-drain shortcut.
- Type-check README TypeScript snippets against the pinned Pi APIs, preserving their renderers and schema types. The project uses strict NodeNext/ES2022 checking with `skipLibCheck` for Pi's vendored declarations. Verify registration without issuing an LLM request, and remove throwaway verification files after use.
