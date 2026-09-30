# junco-tools

Pi's file and shell tools backed by native Rust engines: `bash` runs on real [marsh](https://github.com/junco-org/marsh) ShellMux jobs, and `read`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, and `diff` run on Oh My Pi's AST, diff, walker, and edit libraries. The bash tool injects Pi's public `BashOperations` backend instead of replacing its tool schema, streaming output, truncation, renderers, or error formatting.

**Compatibility:** `@earendil-works/pi-coding-agent@0.80.6` (Pi, not Oh My Pi). `ToolCollection` replaces Pi's `read`, `bash`, `edit`, `grep`, and `find`; Pi's `write`, `ls`, and interactive `user_bash` are unchanged. The `edit` replacement deliberately uses Oh My Pi's **hashline** contract — `{ input: string }` with `[path#TAG]` sections and numbered rows — not Pi's exact-text `oldText`/`newText` schema.

## Build the local package

Requirements:

- Linux x86-64 with glibc; Node.js **22.19.0 or newer** and npm.
- Rust **1.95.0**, selected by `rust-toolchain.toml`.
- A sibling `marsh` checkout at `../marsh` relative to this one: `marsh-core`, `marsh-btrfs` and the patched `brush-core` are consumed as local path dependencies, not from Git. SSH read access to `junco-org/junco-tools` and `junco-org/junco-policy`, with trusted GitHub SSH host keys, plus HTTPS access to the public `can1357/oh-my-pi` repository for the pinned `pi-ast`/`pi-diff`/`pi-walker`/`pi-edit` revision (or that revision already in the Cargo cache).
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

Then build the checkout:

```sh
git clone git@github.com:junco-org/marsh.git "$HOME/git/marsh"
git clone git@github.com:junco-org/junco-tools.git "$HOME/git/junco-tools"
cd "$HOME/git/junco-tools"
npm ci
npm run build
```

`npm run build` generates the production addon in `native/`, then compiles TypeScript into `dist/`. Both are needed at runtime. The package is private and is not published to npm; build the checkout before using it.

The launcher preserves explicit `CARGO_HOME`, `RUSTUP_HOME`, and SSH settings. Native build scripts use the committed Cargo lockfile and a process-local HTTPS-to-SSH rewrite for private junco dependencies; they do not change global Git configuration. For direct Cargo commands, use `node scripts/with-junco-build-env.mjs cargo …` too.

The launcher also installs `scripts/rustc-bootstrap-shim.sh` as `RUSTC_WRAPPER`. Oh My Pi builds on nightly, and `pi-edit`'s pinned transitive dependency `xutf 1.5.0` unconditionally enables `portable_simd`. The shim exports `RUSTC_BOOTSTRAP` **only** while compiling that one crate, so junco's own crate and every other dependency still compile as plain stable 1.95.0 rather than moving the toolchain off the stable channel.

## Run with `pi -e`

Production execution requires an **existing dedicated btrfs seed subvolume**, a writable parent directory, and the `user_subvol_rm_allowed` mount option. Start Pi in that seed or a directory beneath it. junco-tools discovers the enclosing seed; it does not create or migrate subvolumes.

```sh
cd /path/to/your/btrfs-seed
pi -e "$HOME/git/junco-tools/dist/extension.js"
```

For the checkout at `/home/eioannidis/git/junco-tools`, the extension argument is `/home/eioannidis/git/junco-tools/dist/extension.js`. If `pi` is not on your PATH, or is a different version, use the pinned CLI installed by `npm ci`:

```sh
"$HOME/git/junco-tools/node_modules/.bin/pi" \
  -e "$HOME/git/junco-tools/dist/extension.js"
```

Run that command from the btrfs working directory, not necessarily from the package checkout. Configure Pi's model/provider credentials as usual; junco-tools does not configure an LLM.

The packaged extension:

- Registers the whole `ToolCollection` on `session_start`. **Do not disable the built-in tools**: Pi supports same-name overrides, and `read`, `bash`, `edit`, `grep`, and `find` are replaced by name.
- Uses `pi-${sessionId}` as the session's principal name (its command queue and display name), including reload/resume of that session.
- Reads the persisted shell command prefix through Pi's `SettingsManager`.
- Opens one mux over the session's seed, shared by `bash` and every file tool, and awaits its close on `session_shutdown`.

`bash` and the file tools are all marsh calls on that mux, routed by its sandbox policy. Read-only tools (`read`, `grep`, `find`, `ast_grep`, and a previewing `ast_edit`) always run directly against the seed. Shell commands, `edit`, and an applying `ast_edit` run in a private snapshot while another live shell in the process shares the seed — or always, when the mux is opened with `sandbox: "always"` — and there publish only what marsh's policy authorizes; alone, they act on the seed directly. Pi's separate interactive `user_bash`/`!` command path is **not** intercepted. The agent bash tool still takes `{ command: string, timeout?: number }`; timeout is in **seconds**, with no default deadline.

These direct reads can complete while a different shell's `bash` command is still running in both
sandbox modes; writes and recovery retain their exclusion. They observe the live seed, not bash's
private snapshot: a held direct command in `shared` mode may have written visible bytes, while a
held managed command in `always` mode has not published its private changes. Reads can also see a
publication in progress and do not provide an atomic multi-file view.

`read` and `grep` record snapshots in one collection-local store and emit `[path#TAG]` headers with numbered rows; the hashline `edit` tool resolves its anchors against that store, and refuses lines a read never displayed. Files that cannot be snapshotted — images, binary, invalid UTF-8, notebooks under `grep`, anything past pi-edit's 4 MiB cap — are returned untagged through Pi's unmodified behavior.

## Register through the TypeScript API

In another ESM TypeScript project, install the built checkout and the compatible Pi version:

```sh
npm install "$HOME/git/junco-tools" @earendil-works/pi-coding-agent@0.80.6 @earendil-works/pi-agent-core@0.80.6
```

Use the package-root imports shown below. The package ships compiled ESM and declarations; it does not require Bun. A NodeNext TypeScript configuration matches this repository.

### Pi SDK: the whole collection

`ToolCollection.create` returns Pi `AgentTool` objects that also keep Pi's prompt metadata and renderers, so `tools` goes straight into SDK `customTools`, `pi.registerTool`, or a bare `Agent`'s tools. The cwd must lie inside a btrfs seed: the collection opens one mux over it, which `bash` and every file tool share, and `close()` releases it.

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { ToolCollection } from "junco-tools";

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
}
```

Each collection owns one snapshot store, so `read`, `grep`, and `edit` share anchors, seen-line provenance, and named clipboard registers; two collections share none of it. The store is in-memory only; the mux is the collection's one resource to close. Pass `sandbox: "always"` to sandbox every shell command and writing file tool, or borrow an existing mux with `{ mux, native }` (the addon that created it), which its caller keeps and closes. New files are still created with Pi's built-in `write`.

### Bare Agent: individual tools

Every tool also has its own factory. The file tools take the native module and a mux it opened explicitly, so a missing or mismatched addon fails at your `import`, not inside a tool call. Construct one `EditStore` and pass that same store to every `read`, `grep`, and `edit` you create: `edit` only accepts anchors that a tool sharing its store displayed.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createEditTool, createFindTool, createGrepTool, createReadTool } from "junco-tools";
import * as native from "junco-tools/native";

/** `mux` must lie over the btrfs seed containing `cwd`; its caller closes it after the agent. */
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

Open the mux with `await native.NativeMux.open(cwd)` (optionally `{ sandbox: "always" }`) and `await mux.close()` once every tool using it has finished.

The same objects work as SDK `customTools` and with `pi.registerTool`. There, `read` also receives Pi's runtime context, which adds Pi's notice when the active model cannot accept an image; a bare `Agent` calls tools without that context, exactly as Pi's own `createReadTool` does.

### Pi SDK: bash only

`createBashTool` returns an `AgentTool` that keeps Pi's bash renderers and prompt metadata, so it goes into **`customTools`** as is. In Pi 0.80.6, **`tools` is an allowlist of names**, not an array of tool objects.

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
| `ToolCollection.create(cwd, { bash?, principal?, sandbox?, mux?, native? }?)` | Every tool (`read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`) in `collection.tools`, sharing one `EditStore` and one mux over the seed containing `cwd`. |
| `collection.close()` | Close the mux the collection opened; a borrowed `mux` stays its caller's. Idempotent. |
| `createBashTool(cwd, options?)` | `bash` through ShellMux. |
| `createReadTool(cwd, store, native, mux)`, `createGrepTool(cwd, store, native, mux)`, `createEditTool(cwd, store, native, mux)` | Hashline `read`, native `grep`, and hashline `edit` as routed calls on `mux`; pass them one shared `EditStore`. |
| `createFindTool(cwd, native, mux)`, `createAstGrepTool(cwd, native, mux)`, `createAstEditTool(cwd, native, mux)`, `createDiffTool(native)` | Native `find`, `ast_grep`, previewing `ast_edit` as routed calls on `mux`, and in-memory `diff`. |
| `createShellMuxOperations({ principal?, mux? }?)` | Pi-compatible `BashOperations` backed by ShellMux. |
| `shutdownShellMux()` | Dispose and close all default-owned operations sessions, including pending opens. |
| `NativeMux` from `junco-tools/native` | Explicit native session ownership: `await NativeMux.open(cwd, { sandbox? }?)`, `mux.seed`, and `await mux.close()`. `sandbox` is `"shared"` (the default: sandbox a shell command or writing file tool while another live shell shares the seed) or `"always"`. |

Every factory returns a Pi `AgentTool` that also carries Pi's prompt metadata and renderers: pass it to a bare `Agent`, SDK `customTools`, or `pi.registerTool` without wrapping. `native` is the `junco-tools/native` module; `store` is `new native.EditStore()`; `mux` is a `NativeMux` that same module opened, which its caller closes. `BashOperations`, `BashToolInput`, `BashToolDetails`, and `BashToolOptions` are re-exported from Pi, not independently defined tool types. `HashlineEditDetails` is junco's own edit-result shape (`{ files: EditFileOutcome[] }` from the native engine) and is deliberately **not** Pi's `EditToolDetails`.

- Without `mux`, each operations instance lazily opens **one** native mux on first execution. Later working directories must remain inside that mux's seed. Shutdown disposes the owner; create fresh operations for a later session.
- Without `principal`, one `pi-`-prefixed UUID is generated per operations instance, not per command. The principal is a queue and display name, not a policy identity: each command gets a fresh shell whose marsh owner is opaque, so a later command, even under the same name, cannot overwrite what an earlier one published.
- Source authority for a seed is marsh's and shared across live shells and muxes in the process; no mux holds an exclusive lease. Two default owners, or a default owner and a borrowed mux, run over one seed concurrently, and every command is still published through marsh's policy checks.
- An explicit mux is **borrowed**: its caller must await `mux.close()` after all users finish. `shutdownShellMux()` does not close borrowed muxes. It is process-wide teardown for default owners, not a per-agent close method.
- Commands sharing a principal are serialized. Each call gets a fresh shell/snapshot: shell variables and functions do not persist between invocations, and no grant carries over from an earlier call or a reopened seed.
- Commands are observed in-process: marsh's tracer threads seize each spawned command before it runs, and the interpreter reports its own file accesses. No companion executable is needed. Node children work: libuv's epoll-only `io_uring` ring is accepted, while rings that submit filesystem operations are refused.

## Execution limits and development checks

Commands use marsh's brush interpreter, not Pi's local OS-shell backend. A process exit code of zero can still be rejected by publication policy. Snapshots are **not OS confinement**: absolute-path writes and network effects remain possible. Cancellation waits for backend-owned cleanup and can be delayed by commands racing ShellMux's stop scan; do not treat timeout as a universal hard wall-clock kill guarantee.

The file tools are marsh calls too, each in a transient shell of the mux. Read-only calls run directly against the seed. `edit` and an applying `ast_edit` are edits the mux's policy may sandbox: then they write inside a private snapshot through marsh's reported I/O and publish only what its policy authorizes, so a refused publication rejects the call and changes nothing on the seed. Result and error paths always name the seed, never a snapshot. `edit` stages every file in memory before writing, so a compute or parse failure writes nothing, but a writer error or cancellation between files can leave earlier files already written — that is the upstream engine's behavior, not a transactional commit. `ast_edit` previews by default; only `dryRun: false` writes.

An ordinary ext4 directory is not a production seed. The production addon never falls back to a fake filesystem. Development tests explicitly build a separate CopyTree-enabled addon and exercise the same binding, Pi factories, Agent loop, and SDK registration:

```sh
# Run from the junco-tools checkout, after npm run build.
npm run build:native:test
npm test
```

`NativeMux.openCopyTree(seed, { sandbox? }?)` exists only in `target/native-test/index.js`. Its ordinary `NativeMux.open` still requires btrfs. These ext4 checks cover the adapter, interpreter, policy, and WAL; real-btrfs ioctls and storage atomicity remain unverified on the ext4 development host.

The packaged extension and default-owned muxes are covered by a separate opt-in lane that uses the **production** addon:

```sh
npm run test:btrfs
```

It takes no arguments and no configuration. Each run allocates its own `target/btrfs-test-<random>` root, creates a fresh empty btrfs seed subvolume inside it, hands that root to the child suites as their working directory, and afterwards deletes exactly that root — nested subvolumes, leftover marsh snapshots and all. It requires `target/` on a writable btrfs mount carrying `user_subvol_rm_allowed`, and fails with that filesystem prerequisite rather than falling back to the checkout, the home subvolume, or a fake filesystem. Earlier fixture roots are never swept, and only a `SIGKILL` of the runner itself can leave one behind.
