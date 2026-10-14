# junco-tools

Pi's file and shell tools backed by native Rust engines: `bash` runs on real [marsh](https://github.com/junco-org/marsh) ShellMux jobs, and `read`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, and `diff` run on Oh My Pi's AST, diff, walker, and edit libraries. The bash tool injects Pi's public `BashOperations` backend instead of replacing its tool schema, streaming output, truncation, renderers, or error formatting.

**Compatibility:** `@earendil-works/pi-coding-agent@0.99.2` (Pi, not Oh My Pi). `ToolCollection` replaces Pi's `read`, `bash`, `edit`, `grep`, and `find`; Pi's `write`, `ls`, and interactive `user_bash` are unchanged. The `edit` replacement deliberately uses Oh My Pi's **hashline** contract — `{ input: string }` with `[path#TAG]` sections and numbered rows — not Pi's exact-text `oldText`/`newText` schema.

The native crate keeps `ast-grep-core` on 0.39.9: pinned `pi-ast` shares its `Pattern`/`Edit` types with that version. Upgrading only this crate would split those Rust types.

## Build the local package

Requirements:

- Linux x86-64 with glibc; Node.js **22.19.0 or newer** and Bun **1.4.2**.
- Rust **1.95.0**, selected by `rust-toolchain.toml`.
- This package lives in the junco-agency Bun workspace at `packages/junco-tools`. Cargo fetches `marsh-core`, `marsh-btrfs` and the patched `brush-core`/`brush-interactive` from the default branch of the public [`junco-org/marsh`](https://github.com/junco-org/marsh) repository (which takes `junco-policy` from [`junco-org/junco-policy`](https://github.com/junco-org/junco-policy) the same way), and the pinned `pi-ast`/`pi-diff`/`pi-walker`/`pi-edit` revision from the public `can1357/oh-my-pi` repository: HTTPS access to GitHub, or those revisions already in the Cargo cache. No sibling checkout or SSH key is needed.
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
git clone git@github.com:junco-org/junco-agency.git "$HOME/git/junco-agency"
cd "$HOME/git/junco-agency"
bun install --frozen-lockfile
cd packages/junco-tools
bun run build
```

The root `bun install` already runs `bun run build:native` through the workspace's `postinstall` when the launcher's Rust toolchain is installed (`$CARGO_HOME/bin/cargo`, by default the isolated home above); otherwise it skips the addon with a notice. `build:native` first moves the marsh and junco-policy entries of `Cargo.lock` to those repositories' current default-branch HEAD (`cargo update -p marsh-core -p junco-policy`, which leaves every other locked crate alone), then builds locked, so every install picks up their latest pushes and may leave `Cargo.lock` modified.

`bun run build` generates the production addon in `native/`, then compiles TypeScript into `dist/` with declarations. Node consumers and the Pi extension path below load `dist/`; Bun resolves the package's `bun` exports to the TypeScript sources in `ts/`, so Bun imports and source bundles need no `dist/`. The addon is loaded lazily through `junco-tools/native`: creating a `ToolCollection` without an injected `native` module, or running native-backed operations, needs `native/`, while importing the package or creating explicit-only tools such as `new YieldTool()` does not. The workspace links this directory into its consumers; the private package's `files` list ships only runtime artifacts and documentation in a packed tarball, not the test addon under `target/native-test/`; build and load that from this package for policy tests.

The launcher preserves explicit `CARGO_HOME` and `RUSTUP_HOME`. Native build scripts use the committed Cargo lockfile (refreshed for marsh and junco-policy as above) and fetch Git dependencies with the git CLI over anonymous HTTPS; they do not change global Git configuration. For direct Cargo commands, use `node scripts/with-junco-build-env.mjs cargo …` too.

The launcher also installs `scripts/rustc-bootstrap-shim.sh` as `RUSTC_WRAPPER`. Oh My Pi builds on nightly, and `pi-edit`'s pinned transitive dependency `xutf 1.5.0` unconditionally enables `portable_simd`. The shim exports `RUSTC_BOOTSTRAP` **only** while compiling that one crate, so junco's own crate and every other dependency still compile as plain stable 1.95.0 rather than moving the toolchain off the stable channel.

## CI

The junco-agency workspace's `.github/workflows/ci.yml` `test` job covers this package. It needs no secrets: Cargo fetches the public marsh and junco-policy repositories. It sets `CARGO_TARGET_DIR` to this package's `target/cargo`, and its root `bun install --frozen-lockfile` builds the production addon through the `postinstall`. It checks rustfmt on the routed bridge (`src/tool.rs`), whose formatting is already rustfmt-compatible; older native modules and marsh retain their existing layouts. Clippy denies warnings except `dead_code` (napi exports are reached from JavaScript) and `too_many_arguments` (two pre-existing grep helpers). It runs Rust unit tests with `test-fs`, then `bun run build`, `bun run build:native:test`, and `bun run test`. The JavaScript suite uses the real CopyTree-enabled addon without a Btrfs mount or live model credentials.

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
- Opens one `ToolCollection` per session under the default `LockPolicy`; that collection owns its own ShellMux over the session's seed, shared by `bash` and every file tool, and `session_shutdown` closes the collection and therefore its mux.

`bash` and the file tools are all marsh calls on that mux, routed by its sandbox mode and authorized by its policy: `LockPolicy` (a write takes ownership of its file until its owner releases or deletes it) or `EmptyPolicy` (grants every event, while marsh still keeps snapshots, freshness checks and atomic publication). Read-only tools (`read`, `grep`, `find`, `ast_grep`, and a previewing `ast_edit`) always run directly against the seed. Shell commands, `edit`, and an applying `ast_edit` run in a private snapshot while another live shell shares the seed — or always, when the mux is opened with `sandbox: "always"` — and there publish only what the mux's policy authorizes; alone, they act on the seed directly. Pi's separate interactive `user_bash`/`!` command path is **not** intercepted. The agent bash tool still takes `{ command: string, timeout?: number }`; timeout is in **seconds**, with no default deadline.

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

`ToolCollection.create` returns Pi `AgentTool` objects that also keep Pi's prompt metadata and renderers, so `tools` goes straight into SDK `customTools`, `pi.registerTool`, or a bare `Agent`'s tools. The cwd must lie inside a btrfs seed. Each collection opens its own ShellMux with the required `policy`, shared by `bash` and every file tool; the final release of the collection closes that mux.

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
  await collection.close(); // Final release: closes this collection's mux.
}
```

For deterministic offline SDK tests, pass `modelRuntime: await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false, allowModelNetwork: false })`; the SDK default uses its configured credential and model catalog stores.

Each collection owns one snapshot store, so `read`, `grep`, and `edit` share anchors, seen-line provenance, and named clipboard registers; two collections share none of it, and each has its own mux. The store is in-memory only. Its readonly `policy`, `mux`, and `native` let explicit borrowers reuse it. Lifetime is reference-counted: `close()` releases the creator's hold once; `lease()` takes another hold and returns a handle whose idempotent `close()` releases it. Borrowers close their handle, never the collection. Only the final release aborts and joins the collection's tool calls and default bash commands, rejects every retained tool, and closes its mux; other collections are untouched. Pass `sandbox: "always"` to sandbox every shell command and writing file tool. New files are still created with Pi's built-in `write`.

### Bare Agent: individual tools

Every tool also has its own factory. The file tools take the native module and the mux explicitly, so a missing or mismatched addon fails at your `import`, not inside a tool call. Construct one `EditStore` and pass that same store to every `read`, `grep`, and `edit` you create: `edit` only accepts anchors that a tool sharing its store displayed.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { EditTool, FindTool, GrepTool, ReadTool } from "junco-tools";
import * as native from "junco-tools/native";

/** `mux` must lie over the btrfs seed containing `cwd`; it outlives the agent. */
export function createFileAgent(cwd: string, model: Model<Api>, mux: native.NativeMux): Agent {
  const store = new native.EditStore();
  return new Agent({
    initialState: {
      model,
      systemPrompt: "Read or grep before editing with hashline patches.",
      tools: [
        ReadTool.create(cwd, store, native, mux),
        GrepTool.create(cwd, store, native, mux),
        EditTool.create(cwd, store, native, mux),
        FindTool.create(cwd, native, mux),
      ],
    },
  });
}
```

Obtain the mux from a lease, `const lease = await ShellMuxLease.create(cwd)` (optionally `policy` and `sandbox: "always"`), or borrow `collection.mux`/`collection.native`. Each `ShellMuxLease.create` opens a fresh mux; `await lease.release()` once every tool using it has finished closes it and flushes its policy log.

The same objects work as SDK `customTools` and with `pi.registerTool`. There, `read` also receives Pi's runtime context, which adds Pi's notice when the active model cannot accept an image; a bare `Agent` calls tools without that context, exactly as Pi's own `createReadTool` does.

### Pi SDK: bash only

`BashTool` returns a four-argument `AgentTool` that keeps Pi's bash renderers and prompt metadata, so it goes into **`customTools`** as is. In Pi 0.99.2, **`tools` is an allowlist of names**, not an array of tool objects.

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { BashTool, ShellMuxOperations } from "junco-tools";

const sessionManager = SessionManager.create(process.cwd());
const cwd = sessionManager.getCwd(); // Must be inside a btrfs seed.
const operations = new ShellMuxOperations({
  principal: `pi-${sessionManager.getSessionId()}`,
});

try {
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    customTools: [BashTool.create(cwd, { operations })],
    tools: ["bash"],
  });
  try {
    await session.prompt("Use bash to print the current working directory.");
  } finally {
    session.dispose();
  }
} finally {
  await operations.close(); // Releases its lazily opened mux.
}
```

The custom `bash` tool replaces Pi's built-in one. This example enables only `bash`; omit `tools` to keep Pi's default tools alongside the override. Pi's other built-in tools, including its exact-text `edit` and its `write`, stay in place and do not pass through ShellMux.

For resume, construct the session manager with `SessionManager.open(sessionFile)` or `SessionManager.continueRecent(cwd)` **before** deriving the principal. The principal only names and orders the session's commands: every command of one operations instance acts as that instance's own opaque marsh owner, so a name, resumed or reused, never carries grants to anyone else.

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

Register `BashTool.create(ctx.cwd, { operations })` alone instead when only the shell backend should change; the caller owns and closes `operations`.

Load your extension instead of the packaged one:

```sh
pi -e /absolute/path/to/my-junco-extension.ts
```

## API and ownership

| Export | Use |
| --- | --- |
| `ToolCollection.create(cwd, { policy?, bash?, principal?, sandbox?, native? }?)` | Every tool (`read`, `bash`, `edit`, `release`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`) in `collection.tools`, sharing one `EditStore` and the collection's own mux. `policy` is a `Policy` (default `LockPolicy`); `native`/`sandbox` follow `ShellMuxLease.create`. Readonly `policy` (the very object it was opened with), `mux`, `native`; `tools` act as the collection's own policy owner, while `mux` is the unforked session borrowers share. |
| `collection.lease()`, `collection.close()` | `lease()` takes a borrower hold, returning `{ close() }`; `close()` releases the creator hold once. The final release aborts and joins this collection's calls and default bash commands, rejects its retained tools, closes owned operations, and closes its mux; it never closes caller-supplied operations. Idempotent. If `create` itself fails, it releases only what it acquired before rejecting. |
| `collection.bind()`, `ToolBinding` | One fresh policy owner's view: `tools` maps each original collection tool (by identity) to a counterpart over the same `EditStore`, mux session and invocation fence, acting as that owner (bash runs on owner-bound operations; supplied custom operations are shared as is). Holds the collection until its idempotent `close()`, which aborts and drains only this binding's calls and commands. `JuncoAgent` takes one per agent. Neither close clears committed ownership. |
| `isMarshPolicyDenied(error)`, `MARSH_POLICY_DENIED`, `MarshPolicyDeniedError` (also from the native-free `junco-tools/errors`) | Recognize a publication refused by marsh's policy. |
| `Policy`, `LockPolicy`, `EmptyPolicy`, `Policy.and(left, right)`, `Policy.or(left, right)`, `Policy.not(policy)` | Mux authorization policies. `Policy` is an open interface, `{ toNative(native): NativePolicy }`, building the native policy it denotes with one addon (each addon build has its own `NativePolicy`); any implementation composes with the others. `LockPolicy`: a write takes ownership of its file until released or deleted. `EmptyPolicy`: grants every capability. `and` grants what both grant (denying with the first denial), `or` what either grants (denying with both preconditions and fixes), `not` what its operand denies. Policies compare by identity, so share one object wherever one policy is meant. |
| `BashTool.create(cwd, { operations, ... })` | `bash` through ShellMux. `operations` (from `ShellMuxOperations`) is required, so there is no host-bash fallback; the caller closes it. |
| `ReadTool.create(cwd, store, native, mux)`, `GrepTool.create(cwd, store, native, mux)`, `EditTool.create(cwd, store, native, mux)` | Hashline `read`, native `grep`, and hashline `edit` as routed calls on `mux`; pass them one shared `EditStore`. |
| `ReleaseTool.create(cwd, mux)` | `release({ file })`: relinquishes `mux`'s owner's ownership of one file as an always-managed routed call, resolving once marsh published it. Nothing is read or written; releasing another owner's file is a policy denial, releasing an unowned file succeeds. Deleting a file releases it automatically. |
| `FindTool.create(cwd, native, mux)`, `AstGrepTool.create(cwd, native, mux)`, `AstEditTool.create(cwd, native, mux)`, `DiffTool.create(native)` | Native `find`, `ast_grep`, previewing `ast_edit` as routed calls on `mux`, and in-memory `diff`. |
| `new ShellMuxOperations({ principal?, native?, mux?, policy?, sandbox? }?)` | Pi-compatible `BashOperations` backed by ShellMux, plus `close()`, which stops only this owner's commands. A supplied `mux` is borrowed and never closed; it keeps the policy it was opened with, so it takes no `policy`, and an explicit `sandbox` must match it. Otherwise the first command lazily opens an owned mux (`policy` default `LockPolicy`) that `close()` releases. |
| `ShellMuxLease.create(cwd, { policy?, native?, sandbox? }?)` | Opens one fresh ShellMux at `cwd` (default `"shared"`) with `policy` (default `LockPolicy`), returning `{ mux, native, policy, closed, release() }`. `await release()` closes that mux, then flushes its policy log; repeated calls return the same promise. |
| `LspTool.create(cwd, { readOnly? }?)`, `LspTool.shutdown()` | Oh My Pi's `lsp` tool, from the pinned npm `@oh-my-pi/pi-coding-agent@18.2.11`, as a Pi `AgentTool` for any `tools` array (also re-exported by `junco-agency`). **Bun >=1.3.14 only**: `create` rejects under Node, though importing the package stays safe. Caller-installed language servers are discovered by upstream configuration; navigation uses a one-based `line` plus `symbol`; `timeout` is in seconds (default 20, 5–300); `readOnly` rejects upstream's write-tier actions. Semantic failures reject with upstream's text and the original result as `Error.cause`. It runs with host filesystem/process access, **not** through marsh's sandbox or hashline provenance, and is not part of `ToolCollection` or the Pi extension. `shutdown()` is process-wide teardown of upstream's client registry, called once all LSP users drain. |
| `new YieldTool()`, `isYieldTool(tool)`, `YieldTool`, `YieldToolDetails` | The native-free voluntary-suspension `yield` tool: executing it returns its non-empty `reason` as text and `details.reason`, and nothing else. `JuncoAgent` (`junco-agent`) treats a successful call as a pause after the tool batch; a bare Pi `Agent` continues. `isYieldTool` is true only for an object `new YieldTool()` constructed, never for a same-named tool or a spread copy. It is not part of `ToolCollection`. |
| `new RecvTool(host?)`, `new SendTool(host?)`, `new InfoTool(host?)` (each with `.is(tool)` and `.invoke(tool, host, toolCallId, input, signal)`), `Contract` | Native-free graph messaging tools, newtyped so only constructor-built carriers are graph primitives. `recv({})` drains the node's retained `{ messages, values }`; `send({ id, payload })` admits one message on an existing outgoing message edge; `info({})` returns `{ parents, children }` entries `{ id, edgeId, kind, expect }`, where `expect` is the receiving node's `Contract`. Invalid input, an absent host or cancellation has no effect. None of them pauses a run. A `junco-agency` graph supplies the host for a registered agent. Not part of `ToolCollection`; `JuncoAgent.create` adds all three to its defaults. |
| `new TaskTool(host?)`, `new AssignedTaskTool(input)`, `isTaskTool(tool)`, `isAssignedTaskTool(tool)`, `invokeTaskTool(tool, host, toolCallId, input, signal)`, `TaskInput`, `TaskDecision`, `TaskRequest`, `TaskCall`, `TaskTool`, `AssignedTaskTool`, `TaskToolHost`, `TaskToolDetails` | The native-free `task` tool. `TaskTool` launches a free-form `TaskInput` `{ context, tasks: [{ task, name?, model?: { provider, modelId }, tools? }] }` (required shared `context` prepended to every task, at least one task, non-blank text, no extra properties). `new AssignedTaskTool(input)` validates and stores a detached copy of `input` off its schema; the model launches it with `task({})`. Both also accept a `TaskDecision` `{ action: "retry" \| "ignore", id, attempt }` (positive safe integer `attempt`, no extra properties) for a failed report marked `decisionRequired`. The model-facing schema is one object with optional fields (providers reject top-level unions); each call is checked against the exact launch, trigger or decision shape, and the host receives a detached `TaskRequest` (a `TaskInput` or a `TaskDecision`). A successful launch returns one opaque handle `{ id, name? }` per task (in `details.tasks` and as JSON text), a retry exactly the retried task's handle, an ignore none (`Ignored task <id>.`); any other receipt is an error, though the fulfilled host has already committed. A host rejection must mean nothing was admitted. Execution goes through the host passed to `TaskTool`, or the one a `JuncoAgent` binds while a `junco-agency` graph drives it (`invokeTaskTool`); without either it fails with `task requires a JuncoGraph host`. `isTaskTool` is true only for an object either factory returned, `isAssignedTaskTool` only for `AssignedTaskTool`'s; never for a same-named tool or a spread copy. Not part of `ToolCollection`; `JuncoAgent.create` adds a `new TaskTool()` to its defaults. |
| `new ComplainTool(host?, context?)`, `isComplainTool(tool)`, `invokeComplainTool(tool, host, context, toolCallId, input, signal)`, `issueLog`, `Issue`, `Prompt`, `Complaint`, `ComplaintContext`, `ComplainToolHost`, `ComplainTool` | The native-free, frozen `complain` tool: `{ complaint }` (non-blank string, no extra properties), returning `Complaint recorded.` without pausing anything. Execution resolves a `ComplaintContext` (node ID, delivered messages, full model `Prompt`, optional tracer) and calls `host.complain(issue, tracer)` once; without a host and context it fails with `complain requires an agent context`. `JuncoAgent` always owns one and supplies its context. `issueLog` is the process-wide append-only history: `append(issue, tracer?)` stores a frozen snapshot (structured-cloned prompt, copied message list; node payloads stay references) and then notifies `tracer.complain(nodeId, complaint)`, isolating observer failures; `snapshot()` returns a frozen copy; nothing is ever removed. Not part of `ToolCollection`. |
| `NativeModule`, `NativeMux`, `EditStore` (types only) | The `native`, `mux` and `store` parameter contracts of the factories above. The root exports them as types only so importing tools never loads the addon; the runtime module and constructors come from `junco-tools/native`. |
| `NativeMux`, `NativePolicy` from `junco-tools/native` | The raw native session: `NativeMux.open(cwd, { sandbox?, policy? }?)`, `mux.seed`, `mux.sandbox`, `mux.validateCwd(cwd)`, `mux.forkOwner()`, `mux.release(cwd, file)`, and `mux.close()`. `policy` is a `NativePolicy` (`NativePolicy.lock()`, `.empty()`, `.and(l, r)`, `.or(l, r)`, `.not(p)`), the ownership-lock policy when omitted. Each call of an opened handle acts as its own fresh shell; `forkOwner()` returns a handle over the same session (sharing its admission and close) whose every call, command and process acts as one fresh owner. Muxes are independent; several may be open over one seed and share its source authority. Prefer `ShellMuxLease.create`. `sandbox` is `"shared"` (the default: sandbox a shell command or writing file tool while another live shell shares the seed) or `"always"`; `release` always takes the managed route. |

Every factory returns a Pi `AgentTool` that also carries Pi's prompt metadata and renderers: pass it to a bare `Agent`, SDK `customTools`, or `pi.registerTool` without wrapping. `native` is the `junco-tools/native` module; `store` is `new native.EditStore()`; `mux` comes from a lease or a collection. `BashOperations`, `BashToolInput`, `BashToolDetails`, and `BashToolOptions` are re-exported from Pi, not independently defined tool types. `HashlineEditDetails` is junco's own edit-result shape (`{ files: EditFileOutcome[] }` from the native engine) and is deliberately **not** Pi's `EditToolDetails`.

- Each collection, lease, and owning operations instance has its own ShellMux with its own policy; working directories must remain inside that mux's seed. Consumers that should share a mux and policy borrow one collection.
- Without `principal`, one `pi-`-prefixed UUID is generated per operations instance, not per command. The principal is a queue and display name, not a policy identity: the commands act as the operations' mux owner (an owned mux is forked to one fresh owner). Reusing a name grants nothing.
- Marsh shares a seed's source authority across live shells and muxes; an idle mux holds no exclusive lease. A direct shell command excludes other non-read admissions over that seed until it settles, though read-only file tools can overlap. Managed shell commands can overlap. Direct writes change the seed without recording durable grants or consulting earlier grants; managed publications perform those checks.
- A mux belongs to its owner: the final collection release, `lease.release()`, or an owning operations `close()` closes it. Borrowers never close what they borrowed.
- Commands sharing a principal are serialized. Each call gets a fresh shell/snapshot: shell variables and functions do not persist between invocations. Ownership is the mux owner's: a write takes ownership until that owner releases the file (or deletes it), and closing a mux or opening another one releases nothing.
- Commands are observed in-process: marsh's tracer threads seize each spawned command before it runs, and the interpreter reports its own file accesses. No companion executable is needed. Node children work: libuv's epoll-only `io_uring` ring is accepted, while rings that submit filesystem operations are refused.
- A publication marsh's policy refuses rejects a routed file tool (`edit`, an applying `ast_edit`), `bash`, or a native `NativeRun.wait()` with a real `Error` whose own `code` is `"MARSH_POLICY_DENIED"`; its message is marsh's diagnostic. Test it with `isMarshPolicyDenied`, never the message text. Every other failure, including cancellation, timeouts, and read-only tool errors, stays a plain error without that code. A refused hashline `edit` also discards the anchors it recorded, so its unpublished result cannot back a later edit.

## Native terminal display

`NativeTui` and its input types are runtime/declaration exports of **`junco-tools/native` only**, not package-root runtime exports. They are present in both the production addon and the `test-fs` addon (`target/native-test/index.js`). Opening the display needs no `ToolCollection`, `NativeMux`, btrfs seed/mount, or Marsh tracing capabilities; the package's native build prerequisites above remain unchanged.

```ts
import { NativeTui } from "junco-tools/native";

type NativeTuiNode = { key: string; nodeId: string; scope: string };
type NativeTuiBox = {
  nodeKey: string;
  x: number; y: number; width: number; height: number;
};
type NativeTuiTrace = {
  nodeKey?: string;
  text: string;
  recordId?: string;
  mode?: "append" | "replace";
  tone?: "normal" | "thinking" | "error";
};

// NativeTui's public API:
// static open(name: string): Promise<NativeTui>
// setGraph(nodes: NativeTuiNode[], lines: string[], boxes: NativeTuiBox[]): void
// setActive(nodeKey: string, active: boolean): void
// trace(record: NativeTuiTrace): void
// flush(): Promise<void>
// finish(): Promise<void>
// waitForExit(): Promise<"dismissed" | "interrupted" | "closed">
// close(): Promise<void>
```

`open(name)` requires interactive **stdin and stdout**, otherwise rejecting with `TuiTracer requires an interactive terminal on stdin and stdout`. One session owns the terminal process-wide; another acquisition rejects with `A TUI session already owns this terminal`. It resolves after initialization on a dedicated native thread, which owns input polling, raw mode, the alternate screen, and the hidden cursor. Startup failures roll back ownership and partially entered terminal modes. Normal close, input/render failures, and worker unwinding attempt cursor, alternate-screen, and raw-mode restoration before publishing completion; there is no process-wide panic hook. Direct `process.exit()`, process abort, and `SIGKILL` bypass asynchronous cleanup.

`setGraph` replaces the drawing but retains registered identities/colors until close. `key` is raw scoped identity; `nodeId` is the escaped display spelling and `scope` identifies its graph. Box positions must be nonnegative integers and dimensions positive integers, all finite and within the native range. Invalid geometry, unknown node keys, and invalid trace modes/tones reject rather than inventing nodes. `setActive` controls execution highlights, independently of topology. `trace` appends a record without `recordId`, or coalesces one by `(nodeKey, recordId)`; `append`/`normal` are the defaults, and `replace` replaces progress text. Omitted `nodeKey` uses a neutral `[system]` badge.

The screen has exactly two bordered, vertically stacked panes: **JuncoGraph** (40%) and **Agent traces** (60%), with the session name in their titles. Registered scoped badges keep distinct identity colors; only active node rectangles are green/bold, with active IDs also in the graph title. Thinking bodies are dim and error bodies red without changing badge colors. Activity/trace updates preserve graph coordinates; resizing changes the viewport. Controls in display text are escaped (newlines retained, tabs expanded to four spaces).

`Tab` switches focus; arrows pan the graph or scroll traces; PageUp/PageDown scroll the focused pane; Home/End go to its start/end. Trace End restores tail-follow after manual scrolling. `q`/Esc dismiss at any time without cancelling graph computation, and later updates are discarded. Ctrl-C restores and reports `interrupted`; the higher-level `TuiTracer` handles application signal propagation. History is in-memory display text only, bounded to **4 MiB**, **4,096 records**, and **32 KiB per formatted entry**. Truncation is UTF-8-safe and marked `[display truncated]`; oldest records are evicted with an omitted count in the trace title. These limits do not truncate graph results or agent state.

- `flush()` is a **draw barrier** for preceding updates, never a keyboard wait. After intentional closure it settles after restoration.
- `finish()` marks completion synchronously when called, requests the final frame, and waits for dismissal/restoration. A dismissal queued before that final draw does not skip the frame.
- `waitForExit()` observes the same restored/joined worker completion and reports `dismissed`, `interrupted`, or `closed`.
- `close()` immediately fences updates and restores/joins without requiring keyboard dismissal; it is idempotent. Display failures are latched and reject barriers/completion after restoration, with no stdout fallback.

For graphs, use `junco-agency`'s `tracer.TuiTracer` rather than managing the native screen directly. Its caller owns interactive completion: stop/close all shared graphs, then call the shared tracer's `flush()` to retain the final screen until `q`/Esc; `close()`/async disposal restores without waiting. This interactive finish is deliberately different from `NativeTui.flush()` and `flushLog()`. While the TUI owns the terminal, do not directly write to process stdout/stderr (including inherited subprocess stderr); capture such output instead.

## Operational logging and output ownership

The `junco-tools/log` APIs are `log`, `redirectLog(output: { write(line: string): void; flush(): Promise<void> }): () => void`, and `flushLog(): Promise<void>`. Operational/policy logging remains controlled by `LOG_LEVEL`, read once at startup: missing/blank means INFO, names are trimmed and case-insensitive, and only SILLY, TRACE, DEBUG, INFO, WARN, ERROR, or FATAL are accepted (numeric/unknown names reject). Policy grants are tentative DEBUG records; policy violations are INFO. TUI lifecycle/member trace records are independent of this operational log threshold.

`redirectLog` exclusively replaces `log.settings.prettyLogLevelMethod` with the sink's `write`, rather than adding a transport that also prints to stdout. Ownership is shared across module copies through `Symbol.for("junco-tools.log.output")`; a second redirect rejects with `Junco log output is already redirected`. The returned idempotent release restores the exact previous method table.

Without a redirect, `flushLog()` fences stdout with a stream write callback. While redirected, it awaits **only the owned sink's `flush()`**. `TuiTracer` first captures the existing stdout barrier, acquires the redirect before its first initialization await, and buffers new operational lines until the screen opens. Its sink uses the native draw barrier, not interactive tracer completion, and releases ownership on startup failure/restoration. Thus `ShellMuxLease.release()` still drains its policy log without waiting for `q`/Esc. Sink failures are latched by `TuiTracer` for its own teardown rather than escaping into tool cleanup.

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

Marsh's native command tracer (not `NativeTui`) also needs readable kernel BTF/kallsyms and effective BPF/performance/system-log capabilities. On this WSL2 kernel, unprivileged runs lack `CAP_SYSLOG`, while privileged runs may still fail on kernel evidence loss or timing; do not weaken Marsh policy checks to hide those failures. Re-run native integration on a compatible kernel before treating that surface as verified.

The packaged extension and the production addon's mux lifecycle are covered by a separate opt-in lane that uses the **production** addon:

```sh
bun run test:btrfs
```

It takes no arguments and no configuration. Each run allocates its own `target/btrfs-test-<random>` root, creates a fresh empty btrfs seed subvolume inside it, hands that root to the child suites as their working directory, and afterwards deletes exactly that root — nested subvolumes, leftover marsh snapshots and all. It requires `target/` on a writable btrfs mount carrying `user_subvol_rm_allowed`, and fails with that filesystem prerequisite rather than falling back to the checkout, the home subvolume, or a fake filesystem. Earlier fixture roots are never swept, and only a `SIGKILL` of the runner itself can leave one behind.
