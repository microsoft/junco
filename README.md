# junco-tools

Pi's `bash` tool backed by real [marsh](https://github.com/junco-org/marsh) ShellMux jobs. The package injects Pi's public `BashOperations` backend instead of replacing its tool schema, streaming output, truncation, renderers, or error formatting.

**Compatibility:** `@earendil-works/pi-coding-agent@0.80.6` (Pi, not Oh My Pi). Currently only the agent's **bash** tool is replaced; Pi's other tools are unchanged.

## Build the local package

Requirements:

- Linux x86-64 with glibc; Node.js **22.19.0 or newer** and npm.
- Rust **1.95.0**, selected by `rust-toolchain.toml`.
- SSH read access to `junco-org/junco-tools`, `junco-org/marsh`, and `junco-org/junco-policy`, with trusted GitHub SSH host keys.
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
git clone git@github.com:junco-org/junco-tools.git "$HOME/git/junco-tools"
cd "$HOME/git/junco-tools"
npm ci
npm run build
```

`npm run build` generates the production addon in `native/`, then compiles TypeScript into `dist/`. Both are needed at runtime. The package is private and is not published to npm; build the checkout before using it.

The launcher preserves explicit `CARGO_HOME`, `RUSTUP_HOME`, and SSH settings. Native build scripts use the committed Cargo lockfile and a process-local HTTPS-to-SSH rewrite for private junco dependencies; they do not change global Git configuration. For direct Cargo commands, use `node scripts/with-junco-build-env.mjs cargo …` too.

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

- Registers `bash` on `session_start`. **Do not disable built-in bash**: Pi supports same-name tool overrides.
- Uses `pi-${sessionId}` as the durable agent principal, including reload/resume of that session.
- Reads the persisted shell command prefix through Pi's `SettingsManager`.
- Awaits native teardown on `session_shutdown`.

Ask the agent to use its `bash` tool. Pi's separate interactive `user_bash`/`!` command path is **not** intercepted. The agent tool still takes `{ command: string, timeout?: number }`; timeout is in **seconds**, with no default deadline.

## Register through the TypeScript API

In another ESM TypeScript project, install the built checkout and the compatible Pi version:

```sh
npm install "$HOME/git/junco-tools" @earendil-works/pi-coding-agent@0.80.6
```

Use the package-root imports shown below. The package ships compiled ESM and declarations; it does not require Bun. A NodeNext TypeScript configuration matches this repository.

### Pi SDK: `createAgentSession`

Wrap `createBashToolDefinition` with Pi's `defineTool` helper when placing it in **`customTools`**. The helper preserves typed parameters and renderers while making the definition usable in the SDK's tool array under strict TypeScript checking; it does not change the tool at runtime. In Pi 0.80.6, **`tools` is an allowlist of names**, not an array of tool objects.

```ts
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createShellMuxOperations,
  shutdownShellMux,
} from "junco-tools";

const sessionManager = SessionManager.create(process.cwd());
const cwd = sessionManager.getCwd(); // Must be inside a btrfs seed.
const operations = createShellMuxOperations({
  principal: `pi-${sessionManager.getSessionId()}`,
});

try {
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    customTools: [defineTool(createBashToolDefinition(cwd, { operations }))],
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

The custom `bash` definition replaces Pi's built-in one. This example enables only `bash`; omit `tools` to keep Pi's default tools alongside the override. Other tools, including `edit` and `write`, do not pass through ShellMux.

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
  createBashToolDefinition,
  createShellMuxOperations,
  shutdownShellMux,
} from "junco-tools";

export default function extension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const operations = createShellMuxOperations({
      principal: `pi-${ctx.sessionManager.getSessionId()}`,
    });
    pi.registerTool(createBashToolDefinition(ctx.cwd, {
      operations,
      commandPrefix: SettingsManager.create(ctx.cwd).getShellCommandPrefix(),
    }));
  });

  pi.on("session_shutdown", async () => {
    await shutdownShellMux();
  });
}
```

Load your extension instead of the packaged one:

```sh
pi -e /absolute/path/to/my-junco-extension.ts
```

## API and ownership

| Export | Use |
| --- | --- |
| `createBashToolDefinition(cwd, options?)` | Pi `ToolDefinition` for `pi.registerTool` or SDK `customTools`. |
| `createBashTool(cwd, options?)` | Pi `AgentTool` for hosts using the lower-level agent/tool interface. |
| `createShellMuxOperations({ principal?, mux? }?)` | Pi-compatible `BashOperations` backed by ShellMux. |
| `shutdownShellMux()` | Dispose and close all default-owned operations sessions, including pending opens. |
| `NativeMux` from `junco-tools/native` | Explicit native session ownership: `await NativeMux.open(cwd)`, `mux.seed`, and `await mux.close()`. |

`BashOperations`, `BashToolInput`, `BashToolDetails`, and `BashToolOptions` are re-exported from Pi, not independently defined tool types.

- Without `mux`, each operations instance lazily opens **one** native mux on first execution. Later working directories must remain inside that mux's seed. Shutdown disposes the owner; create fresh operations for a later session.
- Without `principal`, one `pi-`-prefixed UUID is generated per operations instance, not per command. Supply a stable, caller-controlled principal when the same agent must retain ownership after reopening.
- A seed has an exclusive lease. Independently opening it twice fails. To share it, open one `NativeMux` and pass that same instance as `mux` to each operations factory, using distinct principals for distinct agents.
- An explicit mux is **borrowed**: its caller must await `mux.close()` after all users finish. `shutdownShellMux()` does not close borrowed muxes. It is process-wide teardown for default owners, not a per-agent close method.
- Commands sharing a principal are serialized. Each call gets a fresh shell/snapshot: shell variables and functions do not persist between invocations. New durable grants survive reopening; legacy snapshot-owned grants are deliberately not reassigned.

## Execution limits and development checks

Commands use marsh's brush interpreter, not Pi's local OS-shell backend. A process exit code of zero can still be rejected by publication policy. Snapshots are **not OS confinement**: absolute-path writes and network effects remain possible. Cancellation waits for backend-owned cleanup and can be delayed by commands racing ShellMux's stop scan; do not treat timeout as a universal hard wall-clock kill guarantee.

An ordinary ext4 directory is not a production seed. The production addon never falls back to a fake filesystem. Development tests explicitly build a separate CopyTree-enabled addon and exercise the same binding and Pi factories:

```sh
# Run from the junco-tools checkout, after npm run build.
npm run build:native:test
node --test --test-concurrency=1 tests/bash.test.mjs
```

`NativeMux.openCopyTree(seed)` exists only in `target/native-test/index.js`. Its ordinary `NativeMux.open` still requires btrfs. These ext4 checks cover the adapter, interpreter, policy, and WAL; real-btrfs ioctls and storage atomicity remain unverified on the ext4 development host.
