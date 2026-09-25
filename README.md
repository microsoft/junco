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
- Uses `pi-${sessionId}` as the durable agent principal, including reload/resume of that session.
- Reads the persisted shell command prefix through Pi's `SettingsManager`.
- Awaits native teardown on `session_shutdown`.

Only `bash` runs inside marsh snapshots. The file tools read, search, and write the ordinary filesystem at the session cwd, exactly as Pi's own non-bash tools do, so they carry no publication policy. Pi's separate interactive `user_bash`/`!` command path is **not** intercepted. The agent bash tool still takes `{ command: string, timeout?: number }`; timeout is in **seconds**, with no default deadline.

`read` and `grep` record snapshots in one collection-local store and emit `[path#TAG]` headers with numbered rows; the hashline `edit` tool resolves its anchors against that store, and refuses lines a read never displayed. Files that cannot be snapshotted — images, binary, invalid UTF-8, notebooks under `grep`, anything past pi-edit's 4 MiB cap — are returned untagged through Pi's unmodified behavior.

## Register through the TypeScript API

In another ESM TypeScript project, install the built checkout and the compatible Pi version:

```sh
npm install "$HOME/git/junco-tools" @earendil-works/pi-coding-agent@0.80.6 @earendil-works/pi-agent-core@0.80.6
```

Use the package-root imports shown below. The package ships compiled ESM and declarations; it does not require Bun. A NodeNext TypeScript configuration matches this repository.

### Pi SDK: the whole collection

`ToolCollection.create` returns Pi `AgentTool` objects that also keep Pi's prompt metadata and renderers, so `tools` goes straight into SDK `customTools`, `pi.registerTool`, or a bare `Agent`'s tools. Construction opens no shell mux and does not require a btrfs cwd; only executing `bash` does.

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createShellMuxOperations, shutdownShellMux, ToolCollection } from "junco-tools";

const sessionManager = SessionManager.create(process.cwd());
const cwd = sessionManager.getCwd(); // Must be inside a btrfs seed to run bash.
const operations = createShellMuxOperations({
  principal: `pi-${sessionManager.getSessionId()}`,
});

try {
  const collection = await ToolCollection.create(cwd, { bash: { operations } });
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
  await shutdownShellMux();
}
```

Each collection owns one snapshot store, so `read`, `grep`, and `edit` share anchors, seen-line provenance, and named clipboard registers; two collections share none of it. `EditSession` instances close per call, and the store is in-memory only, so a collection needs no explicit disposal. New files are still created with Pi's built-in `write`.

### Bare Agent: individual tools

Every tool also has its own factory. The file tools take the native module explicitly, so a missing or mismatched addon fails at your `import`, not inside a tool call. Construct one `EditStore` and pass that same store to every `read`, `grep`, and `edit` you create: `edit` only accepts anchors that a tool sharing its store displayed.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createEditTool, createFindTool, createGrepTool, createReadTool } from "junco-tools";

export async function createFileAgent(cwd: string, model: Model<Api>): Promise<Agent> {
  const native = await import("junco-tools/native");
  const store = new native.EditStore();
  return new Agent({
    initialState: {
      model,
      systemPrompt: "Read or grep before editing with hashline patches.",
      tools: [
        createReadTool(cwd, store, native),
        createGrepTool(cwd, store, native),
        createEditTool(cwd, store, native),
        createFindTool(cwd, native),
      ],
    },
  });
}
```

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

For resume, construct the session manager with `SessionManager.open(sessionFile)` or `SessionManager.continueRecent(cwd)` **before** deriving the principal. Reuse an identity only for the same agent. `SessionManager.create` starts a new session and therefore a new owner.

SDK callers can pass their own `BashToolOptions`, including `commandPrefix` and `spawnHook`, directly to the factory. Unlike the packaged CLI extension, the factory does not independently load persisted prefix settings. An explicitly supplied `operations` backend is retained; selecting it supersedes `shellPath`, as in Pi's factory.

### Custom Pi extension: `pi.registerTool`

For custom registration or options, save this as `my-junco-extension.ts` in a project where the package imports resolve:

```ts
import {
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createShellMuxOperations,
  shutdownShellMux,
  ToolCollection,
} from "junco-tools";

export default function extension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const operations = createShellMuxOperations({
      principal: `pi-${ctx.sessionManager.getSessionId()}`,
    });
    const collection = await ToolCollection.create(ctx.cwd, {
      bash: {
        operations,
        commandPrefix: SettingsManager.create(ctx.cwd).getShellCommandPrefix(),
      },
    });
    for (const tool of collection.tools) pi.registerTool(tool);
  });

  pi.on("session_shutdown", async () => {
    await shutdownShellMux();
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
| `ToolCollection.create(cwd, { bash? }?)` | Every tool (`read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`) in `collection.tools`, sharing one `EditStore`. |
| `createBashTool(cwd, options?)` | `bash` through ShellMux. |
| `createReadTool(cwd, store, native)`, `createGrepTool(cwd, store, native)`, `createEditTool(cwd, store, native)` | Hashline `read`, native `grep`, and hashline `edit`; pass them one shared `EditStore`. |
| `createFindTool(cwd, native)`, `createAstGrepTool(cwd, native)`, `createAstEditTool(cwd, native)`, `createDiffTool(native)` | Native `find`, `ast_grep`, previewing `ast_edit`, and in-memory `diff`. |
| `createShellMuxOperations({ principal?, mux? }?)` | Pi-compatible `BashOperations` backed by ShellMux. |
| `shutdownShellMux()` | Dispose and close all default-owned operations sessions, including pending opens. |
| `NativeMux` from `junco-tools/native` | Explicit native session ownership: `await NativeMux.open(cwd)`, `mux.seed`, and `await mux.close()`. |

Every factory returns a Pi `AgentTool` that also carries Pi's prompt metadata and renderers: pass it to a bare `Agent`, SDK `customTools`, or `pi.registerTool` without wrapping. `native` is `await import("junco-tools/native")`; `store` is `new native.EditStore()`. `BashOperations`, `BashToolInput`, `BashToolDetails`, and `BashToolOptions` are re-exported from Pi, not independently defined tool types. `HashlineEditDetails` is junco's own edit-result shape (`{ files: EditFileOutcome[] }` from the native engine) and is deliberately **not** Pi's `EditToolDetails`.

- Without `mux`, each operations instance lazily opens **one** native mux on first execution. Later working directories must remain inside that mux's seed. Shutdown disposes the owner; create fresh operations for a later session.
- Without `principal`, one `pi-`-prefixed UUID is generated per operations instance, not per command. Supply a stable, caller-controlled principal so one agent's commands are one principal's in the seed's history; it is an identity, not a claim on what an earlier session left unsettled.
- A seed has an exclusive lease, taken by the first command a session runs rather than by `NativeMux.open`. Two idle handles over one seed are legal; the second session's first command fails while the first holds the lease, and succeeds once it is released. To share a seed deliberately, open one `NativeMux` and pass that same instance as `mux` to each operations factory, using distinct principals for distinct agents.
- An explicit mux is **borrowed**: its caller must await `mux.close()` after all users finish. `shutdownShellMux()` does not close borrowed muxes. It is process-wide teardown for default owners, not a per-agent close method.
- Commands sharing a principal are serialized. Each call gets a fresh shell/snapshot: shell variables and functions do not persist between invocations. Marsh records a published path's unsettled stake against the snapshot that published it, so a reopened seed refuses every live principal that path until it is staged — a returning principal name inherits nothing.

## Execution limits and development checks

Commands use marsh's brush interpreter, not Pi's local OS-shell backend. A process exit code of zero can still be rejected by publication policy. Snapshots are **not OS confinement**: absolute-path writes and network effects remain possible. Cancellation waits for backend-owned cleanup and can be delayed by commands racing ShellMux's stop scan; do not treat timeout as a universal hard wall-clock kill guarantee.

The file tools carry none of that: they operate directly on the collection's cwd, so a collection can read, search, and edit an ordinary directory even where `bash` needs a real btrfs seed. `edit` stages every file in memory before writing, so a compute or parse failure writes nothing, but a writer error or cancellation between files can leave earlier files already written — that is the upstream engine's behavior, not a transactional commit. `ast_edit` previews by default; only `dryRun: false` writes.

An ordinary ext4 directory is not a production seed. The production addon never falls back to a fake filesystem. Development tests explicitly build a separate CopyTree-enabled addon and exercise the same binding, Pi factories, Agent loop, and SDK registration:

```sh
# Run from the junco-tools checkout, after npm run build.
npm run build:native:test
npm test
```

`NativeMux.openCopyTree(seed)` exists only in `target/native-test/index.js`. Its ordinary `NativeMux.open` still requires btrfs. These ext4 checks cover the adapter, interpreter, policy, and WAL; real-btrfs ioctls and storage atomicity remain unverified on the ext4 development host.

The packaged extension and default-owned muxes are covered by a separate opt-in lane that uses the **production** addon:

```sh
npm run test:btrfs
```

It takes no arguments and no configuration. Each run allocates its own `target/btrfs-test-<random>` root, creates a fresh empty btrfs seed subvolume inside it, hands that root to the child suites as their working directory, and afterwards deletes exactly that root — nested subvolumes, leftover marsh snapshots and all. It requires `target/` on a writable btrfs mount carrying `user_subvol_rm_allowed`, and fails with that filesystem prerequisite rather than falling back to the checkout, the home subvolume, or a fake filesystem. Earlier fixture roots are never swept, and only a `SIGKILL` of the runner itself can leave one behind.
