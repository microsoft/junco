# junco-tools

Pi's file and shell tools backed by native Rust engines: `bash` runs on real [marsh](https://github.com/junco-org/marsh) ShellMux jobs, and `read`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, and `diff` run on Oh My Pi's AST, diff, walker, and edit libraries. The bash tool injects Pi's public `BashOperations` backend instead of replacing its tool schema, streaming output, truncation, renderers, or error formatting.

**Compatibility:** `@earendil-works/pi-coding-agent@0.99.2` (Pi, not Oh My Pi). `ToolCollection` replaces Pi's `read`, `bash`, `edit`, `grep`, and `find`; Pi's `write`, `ls`, and interactive `user_bash` are unchanged. The `edit` replacement deliberately uses Oh My Pi's **hashline** contract — `{ input: string }` with `[path#TAG]` sections and numbered rows — not Pi's exact-text `oldText`/`newText` schema.

The native crate keeps `ast-grep-core` on 0.39.9: pinned `pi-ast` shares its `Pattern`/`Edit` types with that version. Upgrading only this crate would split those Rust types.

## Build the local package

Requirements:

- Linux x86-64 with glibc; Node.js **22.19.0 or newer** and Bun **1.4.2**.
- Rust **1.95.0**, selected by `rust-toolchain.toml`.
- This package lives in the junco-agency Bun workspace at `packages/junco-tools`. A `marsh` checkout beside the workspace (`../../../marsh` from this package), with `junco-policy` beside it for marsh's own path dependency: `marsh-core`, `marsh-btrfs` and the patched `brush-core` are consumed as local path dependencies, not from Git. SSH read access to `junco-org/marsh` and `junco-org/junco-policy`, with trusted GitHub SSH host keys, plus HTTPS access to the public `can1357/oh-my-pi` repository for the pinned `pi-ast`/`pi-diff`/`pi-walker`/`pi-edit` revision (or that revision already in the Cargo cache).
- Native build libraries. On Ubuntu 24.04:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends \
  build-essential pkg-config clang libclang-dev llvm-dev \
  libbtrfsutil-dev zlib1g-dev ca-certificates curl git
```

The build launcher defaults to isolated Rust homes. If Rust is not installed there, install it without changing system Rust or shell startup files:

```sh
export CARGO_HOME="$HOME/.local/share/junco-tools/cargo"
export RUSTUP_HOME="$HOME/.local/share/junco-tools/rustup"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
  sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.95.0
```

Then build the package:

```sh
git clone git@github.com:junco-org/marsh.git "$HOME/git/marsh"
git clone git@github.com:junco-org/junco-policy.git "$HOME/git/junco-policy"
git clone git@github.com:junco-org/junco-agency.git "$HOME/git/junco-agency"
cd "$HOME/git/junco-agency"
bun install --frozen-lockfile
cd packages/junco-tools
bun run build
```

The root `bun install` already runs `bun run build:native` through the workspace's `postinstall` when `marsh` is checked out beside the workspace; without it, the install skips the addon with a notice.

`bun run build` generates the production addon in `native/`, then compiles TypeScript into `dist/` with declarations. Node consumers and the Pi extension path below load `dist/`; Bun resolves the package's `bun` exports to the TypeScript sources in `ts/`, so Bun imports and source bundles need no `dist/`. The addon is loaded lazily through `junco-tools/native`: creating a `ToolCollection` without an injected `native` module, or running native-backed operations, needs `native/`, while importing the package or creating explicit-only tools such as `createYieldTool()` does not. The workspace links this directory into its consumers; the private package's `files` list ships only runtime artifacts and documentation in a packed tarball, not the test addon under `target/native-test/`; build and load that from this package for policy tests.

The launcher preserves explicit `CARGO_HOME`, `RUSTUP_HOME`, and SSH settings. Native build scripts use the committed Cargo lockfile and a process-local HTTPS-to-SSH rewrite for private junco dependencies; they do not change global Git configuration. For direct Cargo commands, use `node scripts/with-junco-build-env.mjs cargo …` too.

The launcher also installs `scripts/rustc-bootstrap-shim.sh` as `RUSTC_WRAPPER`. Oh My Pi builds on nightly, and `pi-edit`'s pinned transitive dependency `xutf 1.5.0` unconditionally enables `portable_simd`. The shim exports `RUSTC_BOOTSTRAP` **only** while compiling that one crate, so junco's own crate and every other dependency still compile as plain stable 1.95.0 rather than moving the toolchain off the stable channel.

## CI

The junco-agency workspace's `.github/workflows/ci.yml` `test` job covers this package. Configure the workspace repository secrets `JUNCO_MARSH_SSH_KEY` and `JUNCO_POLICY_SSH_KEY` with read-only deploy keys for `junco-org/marsh` and `junco-org/junco-policy`; CI checks them out beside the workspace and sets `CARGO_TARGET_DIR` to this package's `target/cargo`. It checks rustfmt on the routed bridge (`src/tool.rs`), whose formatting is already rustfmt-compatible; older native modules and marsh retain their existing layouts. Clippy denies warnings except `dead_code` (napi exports are reached from JavaScript) and `too_many_arguments` (two pre-existing grep helpers). It runs Rust unit tests with `test-fs`, then the root `bun install --frozen-lockfile`, `bun run build`, `bun run build:native:test`, and `bun run test`. The JavaScript suite uses the real CopyTree-enabled addon without a Btrfs mount or live model credentials.

## Run with `pi -e`

Production execution requires an **existing dedicated btrfs seed subvolume**, a writable parent directory, and the `user_subvol_rm_allowed` mount option. Start Pi in that seed or a directory beneath it. junco-tools discovers the enclosing seed; it does not create or migrate subvolumes.

```sh
cd /path/to/your/btrfs-seed
pi -e "$HOME/git/junco-agency/packages/junco-tools/dist/extension.js"
```

For the workspace at `/home/eioannidis/git/junco-agency`, the extension argument is `/home/eioannidis/git/junco-agency/packages/junco-tools/dist/extension.js`. If `pi` is not on your PATH, or is a different version, use the pinned CLI installed by the workspace's `bun install`:

```sh
"$HOME/git/junco-agency/node_modules/.bin/pi" \
  -e "$HOME/git/junco-agency/packages/junco-tools/dist/extension.js"
```

Run that command from the btrfs working directory, not necessarily from the package checkout. Configure Pi's model/provider credentials as usual; junco-tools does not configure an LLM.

The packaged extension:

- Registers the whole `ToolCollection` on `session_start`. **Do not disable the built-in tools**: Pi supports same-name overrides, and `read`, `bash`, `edit`, `grep`, and `find` are replaced by name.
- Uses `pi-${sessionId}` as the session's principal name (its command queue and display name), including reload/resume of that session.
- Reads the persisted shell command prefix through Pi's `SettingsManager`.
- Leases the process's one ShellMux (opened on first use over the session's seed), shared by `bash` and every file tool, and on `session_shutdown` closes only its own collection. The mux stays open for later sessions; the containing process owns the final `shutdownShellMux()`.

`bash` and the file tools are all marsh calls on that mux, routed by its sandbox policy. Read-only tools (`read`, `grep`, `find`, `ast_grep`, and a previewing `ast_edit`) always run directly against the seed. Shell commands, `edit`, and an applying `ast_edit` run in a private snapshot while another live shell in the process shares the seed — or always, when the singleton is opened with `sandbox: "always"` — and there publish only what marsh's policy authorizes; alone, they act on the seed directly. Pi's separate interactive `user_bash`/`!` command path is **not** intercepted. The agent bash tool still takes `{ command: string, timeout?: number }`; timeout is in **seconds**, with no default deadline.

These direct reads can complete while a different shell's `bash` command is still running in both
sandbox modes; writes and recovery retain their exclusion. They observe the live seed, not bash's
private snapshot: a held direct command in `shared` mode may have written visible bytes, while a
held managed command in `always` mode has not published its private changes. Reads can also see a
publication in progress and do not provide an atomic multi-file view.

`read` and `grep` record snapshots in one collection-local store and emit `[path#TAG]` headers with numbered rows; the hashline `edit` tool resolves its anchors against that store, and refuses lines a read never displayed. Files that cannot be snapshotted — images, binary, invalid UTF-8, notebooks under `grep`, anything past pi-edit's 4 MiB cap — are returned untagged through Pi's unmodified behavior. An oversized read notice has no tag or numbered source row and grants no line provenance; read a complete visible line before editing.

## Register through the TypeScript API

In another ESM TypeScript project, install the built checkout and the compatible Pi version:

```sh
npm install "$HOME/git/junco-agency/packages/junco-tools" @earendil-works/pi-coding-agent@0.99.2 @earendil-works/pi-agent-core@0.99.2
```

Use the package-root imports shown below. The package ships compiled ESM and declarations; it does not require Bun. A NodeNext TypeScript configuration matches this repository.

The junco-agency workspace root pins `typebox` 1.3.34 with an override so Pi's older metadata pin does not create a second schema type. A consumer sharing schemas should use the same override.

### Pi SDK: the whole collection

`ToolCollection.create` returns Pi `AgentTool` objects that also keep Pi's prompt metadata and renderers, so `tools` goes straight into SDK `customTools`, `pi.registerTool`, or a bare `Agent`'s tools. The cwd must lie inside the btrfs seed of the process's one ShellMux: the collection leases that singleton (opening it on first use), which `bash` and every file tool share, and `close()` stops only this collection's calls and releases its lease. `shutdownShellMux()` closes the mux once the application is done with it.

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { ToolCollection, shutdownShellMux } from "junco-tools";

const sessionManager = SessionManager.create(process.cwd());
const cwd = sessionManager.getCwd(); // Must be inside a btrfs seed.
const collection = await ToolCollection.create(cwd, {
  principal: `pi-${sessionManager.getSessionId()}`,
});
try {
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    customTools: collection.tools,
  });
  try {
    await session.prompt("Grep for TODO, then patch the first hit.");
  } finally {
    session.dispose();
  }
} finally {
  await collection.close();
  await shutdownShellMux(); // Application exit: no other consumer remains.
}
```

For deterministic offline SDK tests, pass `modelRuntime: await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false, allowModelNetwork: false })`; the SDK default uses its configured credential and model catalog stores.

Each collection owns one snapshot store, so `read`, `grep`, and `edit` share anchors, seen-line provenance, and named clipboard registers; two collections share none of it, although they share the one mux. The store is in-memory only. `close()` is terminal for that collection alone: it aborts and joins its own tool calls and default bash commands, then rejects every retained tool; other collections and the mux are untouched. Pass `sandbox: "always"` on the first acquisition to sandbox every shell command and writing file tool, or adopt a mux you opened with `{ mux, native }` (the addon that created it) as the process singleton, after which `shutdownShellMux()` closes it. New files are still created with Pi's built-in `write`.

### Bare Agent: individual tools

Every tool also has its own factory. The file tools take the native module and the mux explicitly, so a missing or mismatched addon fails at your `import`, not inside a tool call. Construct one `EditStore` and pass that same store to every `read`, `grep`, and `edit` you create: `edit` only accepts anchors that a tool sharing its store displayed.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createEditTool, createFindTool, createGrepTool, createReadTool } from "junco-tools";
import * as native from "junco-tools/native";

/** `mux` must lie over the btrfs seed containing `cwd`; it outlives the agent. */
export function createFileAgent(cwd: string, model: Model<Api>, mux: native.NativeMux): Agent {
  const store = new native.EditStore();
  return new Agent({
    initialState: {
      model,
      systemPrompt: "Read or grep before editing with hashline patches.",
      tools: [
        createReadTool(cwd, store, native, mux),
        createGrepTool(cwd, store, native, mux),
        createEditTool(cwd, store, native, mux),
        createFindTool(cwd, native, mux),
      ],
    },
  });
}
```

Obtain the mux from a lease, `const { mux, native } = await acquireShellMux(cwd)` (optionally `{ sandbox: "always" }` on the first acquisition), call `lease.release()` once every tool using it has finished, and `await shutdownShellMux()` at application exit. Releasing never closes the mux.

The same objects work as SDK `customTools` and with `pi.registerTool`. There, `read` also receives Pi's runtime context, which adds Pi's notice when the active model cannot accept an image; a bare `Agent` calls tools without that context, exactly as Pi's own `createReadTool` does.

### Pi SDK: bash only

`createBashTool` returns a four-argument `AgentTool` that keeps Pi's bash renderers and prompt metadata, so it goes into **`customTools`** as is. In Pi 0.99.2, **`tools` is an allowlist of names**, not an array of tool objects.

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createBashTool, createShellMuxOperations, shutdownShellMux } from "junco-tools";

const sessionManager = SessionManager.create(process.cwd());
const cwd = sessionManager.getCwd(); // Must be inside a btrfs seed.
const operations = createShellMuxOperations({
  principal: `pi-${sessionManager.getSessionId()}`,
});

try {
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    customTools: [createBashTool(cwd, { operations })],
    tools: ["bash"],
  });
  try {
    await session.prompt("Use bash to print the current working directory.");
  } finally {
    session.dispose();
  }
} finally {
  await shutdownShellMux();
}
```

The custom `bash` tool replaces Pi's built-in one. This example enables only `bash`; omit `tools` to keep Pi's default tools alongside the override. Pi's other built-in tools, including its exact-text `edit` and its `write`, stay in place and do not pass through ShellMux.

For resume, construct the session manager with `SessionManager.open(sessionFile)` or `SessionManager.continueRecent(cwd)` **before** deriving the principal. The principal only names and orders the session's commands: every command runs in a fresh shell with its own opaque marsh owner, so a name, resumed or reused, never carries grants between commands.

SDK callers can pass their own `BashToolOptions`, including `commandPrefix` and `spawnHook`, directly to the factory. Unlike the packaged CLI extension, the factory does not independently load persisted prefix settings. An explicitly supplied `operations` backend is retained; selecting it supersedes `shellPath`, as in Pi's factory.

### Custom Pi extension: `pi.registerTool`

For custom registration or options, save this as `my-junco-extension.ts` in a project where the package imports resolve:

```ts
import {
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { ToolCollection } from "junco-tools";

export default function extension(pi: ExtensionAPI): void {
  let collection: ToolCollection | undefined;
  pi.on("session_start", async (_event, ctx) => {
    await collection?.close();
    collection = await ToolCollection.create(ctx.cwd, {
      principal: `pi-${ctx.sessionManager.getSessionId()}`,
      bash: { commandPrefix: SettingsManager.create(ctx.cwd).getShellCommandPrefix() },
    });
    for (const tool of collection.tools) pi.registerTool(tool);
  });

  pi.on("session_shutdown", async () => {
    await collection?.close();
    collection = undefined;
  });
}
```

Register `createBashTool(ctx.cwd, …)` alone instead when only the shell backend should change.

Load your extension instead of the packaged one:

```sh
pi -e /absolute/path/to/my-junco-extension.ts
```

## API and ownership

| Export | Use |
| --- | --- |
| `ToolCollection.create(cwd, { bash?, principal?, sandbox?, mux?, native? }?)` | Every tool (`read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`) in `collection.tools`, sharing one `EditStore` and a lease on the process's one mux. `mux`/`native`/`sandbox` follow `acquireShellMux`. |
| `collection.close()` | Abort and join this collection's own calls and default bash commands, reject its retained tools, and release its lease; never closes caller-supplied operations or the mux. Idempotent. If `create` itself fails, it releases only its own lease and default operations before rejecting. |
| `isMarshPolicyDenied(error)`, `MARSH_POLICY_DENIED`, `MarshPolicyDeniedError` (also from the native-free `junco-tools/errors`) | Recognize a publication refused by marsh's policy. |
| `createBashTool(cwd, options?)` | `bash` through ShellMux. |
| `createReadTool(cwd, store, native, mux)`, `createGrepTool(cwd, store, native, mux)`, `createEditTool(cwd, store, native, mux)` | Hashline `read`, native `grep`, and hashline `edit` as routed calls on `mux`; pass them one shared `EditStore`. |
| `createFindTool(cwd, native, mux)`, `createAstGrepTool(cwd, native, mux)`, `createAstEditTool(cwd, native, mux)`, `createDiffTool(native)` | Native `find`, `ast_grep`, previewing `ast_edit` as routed calls on `mux`, and in-memory `diff`. |
| `createShellMuxOperations({ principal?, native?, mux?, sandbox? }?)` | Pi-compatible `BashOperations` backed by ShellMux, plus `close()`, which stops only this owner's commands and releases its lease. It acquires the singleton lazily on first execution from the generation current at creation; `mux` requires `native`. |
| `acquireShellMux(cwd, { native?, mux?, sandbox? }?)` | A lease `{ mux, native, closed, release() }` on the process's one ShellMux. The first acquisition opens it at `cwd` (default `"shared"`) or adopts a pre-opened `mux` (which requires its `native`); later ones inherit it, and an explicitly different addon, sandbox, or mux is refused. Every acquisition validates its own `cwd` against the seed. `release()` never closes the mux. |
| `shutdownShellMux()` | Application shutdown: fence every lease, operations owner, and collection of the current generation, await an in-flight open, and close the mux exactly once. Concurrent callers join one result. Only consumers created afterwards start a new generation. |
| `LspTool.create(cwd, { readOnly? }?)`, `LspTool.shutdown()` | Oh My Pi's `lsp` tool, from the pinned npm `@oh-my-pi/pi-coding-agent@18.2.11`, as a Pi `AgentTool` for any `tools` array (also re-exported by `junco-agency`). **Bun >=1.3.14 only**: `create` rejects under Node, though importing the package stays safe. Caller-installed language servers are discovered by upstream configuration; navigation uses a one-based `line` plus `symbol`; `timeout` is in seconds (default 20, 5–300); `readOnly` rejects upstream's write-tier actions. Semantic failures reject with upstream's text and the original result as `Error.cause`. It runs with host filesystem/process access, **not** through marsh's sandbox or hashline provenance, and is not part of `ToolCollection` or the Pi extension. `shutdown()` is process-wide teardown of upstream's client registry, called once all LSP users drain. |
| `createYieldTool()`, `isYieldTool(tool)`, `YieldTool`, `YieldToolDetails` | The native-free voluntary-suspension `yield` tool: executing it returns its non-empty `reason` as text and `details.reason`, and nothing else. `JuncoAgent` (`junco-agent`) treats a successful call as a pause after the tool batch; a bare Pi `Agent` continues. `isYieldTool` is true only for an object `createYieldTool()` returned, never for a same-named tool or a spread copy. It is not part of `ToolCollection`. |
| `createTaskTool(host?)`, `createAssignedTaskTool(input)`, `isTaskTool(tool)`, `isAssignedTaskTool(tool)`, `invokeTaskTool(tool, host, toolCallId, input, signal)`, `TaskInput`, `TaskDecision`, `TaskRequest`, `TaskCall`, `TaskTool`, `AssignedTaskTool`, `TaskToolHost`, `TaskToolDetails` | The native-free `task` tool. `createTaskTool` launches a free-form `TaskInput` `{ context, tasks: [{ task, name?, model?: { provider, modelId }, tools? }] }` (required shared `context` prepended to every task, at least one task, non-blank text, no extra properties). `createAssignedTaskTool(input)` validates and stores a detached copy of `input` off its schema; the model launches it with `task({})`. Both also accept a `TaskDecision` `{ action: "retry" \| "ignore", id, attempt }` (positive safe integer `attempt`, no extra properties) for a failed report marked `decisionRequired`. The model-facing schema is one object with optional fields (providers reject top-level unions); each call is checked against the exact launch, trigger or decision shape, and the host receives a detached `TaskRequest` (a `TaskInput` or a `TaskDecision`). A successful launch returns one opaque handle `{ id, name? }` per task (in `details.tasks` and as JSON text), a retry exactly the retried task's handle, an ignore none (`Ignored task <id>.`); any other receipt is an error, though the fulfilled host has already committed. A host rejection must mean nothing was admitted. Execution goes through the host passed to `createTaskTool`, or the one a `JuncoAgent` binds while an `agentNode` drives it (`invokeTaskTool`); without either it fails with `task requires an agentNode graph host`. `isTaskTool` is true only for an object either factory returned, `isAssignedTaskTool` only for `createAssignedTaskTool`'s; never for a same-named tool or a spread copy. Not part of `ToolCollection`; `JuncoAgent.create` adds a `createTaskTool()` to its defaults. |
| `createComplainTool(host?, context?)`, `isComplainTool(tool)`, `invokeComplainTool(tool, host, context, toolCallId, input, signal)`, `issueLog`, `Issue`, `Prompt`, `Complaint`, `ComplaintContext`, `ComplainToolHost`, `ComplainTool` | The native-free, frozen `complain` tool: `{ complaint }` (non-blank string, no extra properties), returning `Complaint recorded.` without pausing anything. Execution resolves a `ComplaintContext` (node ID, delivered messages, full model `Prompt`, optional tracer) and calls `host.complain(issue, tracer)` once; without a host and context it fails with `complain requires an agent context`. `JuncoAgent` always owns one and supplies its context. `issueLog` is the process-wide append-only history: `append(issue, tracer?)` stores a frozen snapshot (structured-cloned prompt, copied message list; node payloads stay references) and then notifies `tracer.complain(nodeId, complaint)`, isolating observer failures; `snapshot()` returns a frozen copy; nothing is ever removed. Not part of `ToolCollection`. |
| `NativeModule`, `NativeMux`, `EditStore` (types only) | The `native`, `mux` and `store` parameter contracts of the factories above. The root exports them as types only so importing tools never loads the addon; the runtime module and constructors come from `junco-tools/native`. |
| `NativeMux` from `junco-tools/native` | The raw native session: `NativeMux.open(cwd, { sandbox? }?)`, `mux.seed`, `mux.sandbox`, `mux.validateCwd(cwd)`, and `mux.close()`. One loaded addon permits only one mux opening, open, or closing at a time; a second `open` rejects. Prefer `acquireShellMux`. `sandbox` is `"shared"` (the default: sandbox a shell command or writing file tool while another live shell shares the seed) or `"always"`. |

Every factory returns a Pi `AgentTool` that also carries Pi's prompt metadata and renderers: pass it to a bare `Agent`, SDK `customTools`, or `pi.registerTool` without wrapping. `native` is the `junco-tools/native` module; `store` is `new native.EditStore()`; `mux` is the singleton from a lease. `BashOperations`, `BashToolInput`, `BashToolDetails`, and `BashToolOptions` are re-exported from Pi, not independently defined tool types. `HashlineEditDetails` is junco's own edit-result shape (`{ files: EditFileOutcome[] }` from the native engine) and is deliberately **not** Pi's `EditToolDetails`.

- Every agent, collection, and operations owner in the process (and every copy of this module loaded in it) shares one ShellMux, so later working directories must remain inside its seed. A shutdown permanently closes the consumers of that generation; create fresh ones afterwards.
- Without `principal`, one `pi-`-prefixed UUID is generated per operations instance, not per command. The principal is a queue and display name, not a policy identity: each command gets a fresh opaque shell owner. A later managed command under the same name cannot inherit an earlier shell's grants.
- Marsh shares a seed's source authority across live shells and muxes; an idle mux holds no exclusive lease. A direct shell command excludes other non-read admissions over that seed until it settles, though read-only file tools can overlap. Managed shell commands can overlap. Direct writes change the seed without recording durable grants or consulting earlier grants; managed publications perform those checks.
- The mux belongs to the application, not to any consumer: closing a collection or operations owner, or releasing a lease, never closes it, even when nothing else holds it. Call `shutdownShellMux()` once, after all users stop. It is process-wide teardown, not a per-agent close method.
- Commands sharing a principal are serialized. Each call gets a fresh shell/snapshot: shell variables and functions do not persist between invocations, and no grant carries over from an earlier call or a reopened seed.
- Commands are observed in-process: marsh's tracer threads seize each spawned command before it runs, and the interpreter reports its own file accesses. No companion executable is needed. Node children work: libuv's epoll-only `io_uring` ring is accepted, while rings that submit filesystem operations are refused.
- A publication marsh's policy refuses rejects a routed file tool (`edit`, an applying `ast_edit`), `bash`, or a native `NativeRun.wait()` with a real `Error` whose own `code` is `"MARSH_POLICY_DENIED"`; its message is marsh's diagnostic. Test it with `isMarshPolicyDenied`, never the message text. Every other failure, including cancellation, timeouts, and read-only tool errors, stays a plain error without that code. A refused hashline `edit` also discards the anchors it recorded, so its unpublished result cannot back a later edit.

## Execution limits and development checks

Commands use marsh's brush interpreter, not Pi's local OS-shell backend. A process exit code of zero can still be rejected by publication policy. Snapshots are **not OS confinement**: absolute-path writes and network effects remain possible. Cancellation waits for backend-owned cleanup and can be delayed by commands racing ShellMux's stop scan; do not treat timeout as a universal hard wall-clock kill guarantee.

Pi 0.99.2 reports a nonzero bash exit as a resolved result with `isError: true` and `structuredContent.exit_code`; the model sees the failure. Typed Marsh policy denials still reject the call, so handle them separately.

The file tools are marsh calls too, each in a transient shell of the mux. Read-only calls run directly against the seed. `edit` and an applying `ast_edit` are edits the mux's policy may sandbox: then they write inside a private snapshot through marsh's reported I/O and publish only what its policy authorizes, so a refused publication rejects the call and changes nothing on the seed. Result and error paths always name the seed, never a snapshot. `edit` stages every file in memory before writing, so a compute or parse failure writes nothing, but a writer error or cancellation between files can leave earlier files already written — that is the upstream engine's behavior, not a transactional commit. `ast_edit` previews by default; only `dryRun: false` writes.

An ordinary ext4 directory is not a production seed. The production addon never falls back to a fake filesystem. Development tests explicitly build a separate CopyTree-enabled addon and exercise the same binding, Pi factories, Agent loop, and SDK registration:

```sh
# Run from packages/junco-tools, after bun run build.
bun run build:native:test
bun run test
```

`NativeMux.openCopyTree(seed, { sandbox? }?)` exists only in `target/native-test/index.js`. Its ordinary `NativeMux.open` still requires btrfs. CopyTree tests do not exercise real-btrfs ioctls or storage atomicity.

The native tracer also needs readable kernel BTF/kallsyms and effective BPF/performance/system-log capabilities. On this WSL2 kernel, unprivileged runs lack `CAP_SYSLOG`, while privileged runs may still fail on kernel evidence loss or timing; do not weaken Marsh policy checks to hide those failures. Re-run native integration on a compatible kernel before treating that surface as verified.

The packaged extension and the production singleton's lifecycle are covered by a separate opt-in lane that uses the **production** addon:

```sh
bun run test:btrfs
```

It takes no arguments and no configuration. Each run allocates its own `target/btrfs-test-<random>` root, creates a fresh empty btrfs seed subvolume inside it, hands that root to the child suites as their working directory, and afterwards deletes exactly that root — nested subvolumes, leftover marsh snapshots and all. It requires `target/` on a writable btrfs mount carrying `user_subvol_rm_allowed`, and fails with that filesystem prerequisite rather than falling back to the checkout, the home subvolume, or a fake filesystem. Earlier fixture roots are never swept, and only a `SIGKILL` of the runner itself can leave one behind.
