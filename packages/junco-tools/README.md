# junco-tools

Pi's file and shell tools backed by native Rust engines: `bash` runs on real [marsh](https://github.com/junco-org/marsh) ShellMux jobs, and `read`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, and `diff` run on Oh My Pi's AST, diff, walker, and edit libraries, and `code_graph` on the tree-sitter code graph in `crates/rust-graph`. The bash tool injects Pi's public `BashOperations` backend instead of replacing its tool schema, streaming output, truncation, renderers, or error formatting.

**Compatibility:** `@earendil-works/pi-coding-agent@0.99.2` (Pi, not Oh My Pi). `ToolCollection` replaces Pi's `read`, `bash`, `edit`, `grep`, and `find`; Pi's `write`, `ls`, and interactive `user_bash` are unchanged. The `edit` replacement deliberately uses Oh My Pi's **hashline** contract — `{ input: string }` with `[path#TAG]` sections and numbered rows — not Pi's exact-text `oldText`/`newText` schema.

The native crate keeps `ast-grep-core` on 0.39.9: pinned `pi-ast` shares its `Pattern`/`Edit` types with that version. Upgrading only this crate would split those Rust types.

## Build the local package

Requirements:

- Linux x86-64 with glibc; Node.js **22.19.0 or newer** and Bun **1.4.2**.
- Rust **1.95.0**, selected by `rust-toolchain.toml`.
- This package lives in the junco Bun workspace at `packages/junco-tools`. Cargo builds `marsh-core`, `marsh-btrfs` and the patched `brush-core`/`brush-interactive` from the monorepo's `crates/marsh` (which takes `junco-policy` from `crates/junco-policy`), and fetches the pinned `pi-ast`/`pi-diff`/`pi-walker`/`pi-edit` revision from the public `can1357/oh-my-pi` repository: HTTPS access to GitHub, or that revision already in the Cargo cache. No sibling checkout or SSH key is needed.
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
git clone git@github.com:microsoft/junco.git "$HOME/git/junco"
cd "$HOME/git/junco"
bun install --frozen-lockfile
cd packages/junco-tools
bun run build
```

The root `bun install` already runs `bun run build:native` through the workspace's `postinstall` when the launcher's Rust toolchain is installed (`$CARGO_HOME/bin/cargo`, by default the isolated home above); otherwise it skips the addon with a notice. `build:native` builds locked and leaves `Cargo.lock` unchanged.

`bun run build` generates the production addon in `native/`, then compiles TypeScript into `dist/` with declarations. Node consumers and the Pi extension path below load `dist/`; Bun resolves the package's `bun` exports to the TypeScript sources in `ts/`, so Bun imports and source bundles need no `dist/`. The addon is loaded lazily through `junco-tools/native`: creating a `ToolCollection` without an injected `native` module, or running native-backed operations, needs `native/`, while importing the package or creating explicit-only tools such as `new YieldTool()` does not. The workspace links this directory into its consumers; the private package's `files` list ships only runtime artifacts and documentation in a packed tarball, not the test addon under `target/native-test/`; build and load that from this package for policy tests.

The launcher preserves explicit `CARGO_HOME` and `RUSTUP_HOME`. Native build scripts use the committed Cargo lockfile (refreshed for marsh and junco-policy as above) and fetch Git dependencies with the git CLI over anonymous HTTPS; they do not change global Git configuration. For direct Cargo commands, use `node scripts/with-junco-build-env.mjs cargo …` too.

The launcher also installs `scripts/rustc-bootstrap-shim.sh` as `RUSTC_WRAPPER`. Oh My Pi builds on nightly, and `pi-edit`'s pinned transitive dependency `xutf 1.5.0` unconditionally enables `portable_simd`. The shim exports `RUSTC_BOOTSTRAP` **only** while compiling that one crate, so junco's own crate and every other dependency still compile as plain stable 1.95.0 rather than moving the toolchain off the stable channel.

The `code_graph` engine lives in this package's [`crates/rust-graph`](crates/rust-graph) directory as a standalone Cargo workspace, with its own lockfile and toolchain pin. From this package, run `(cd crates/rust-graph && cargo test --locked)` to test it.

## CI

The junco workspace's `.github/workflows/ci.yml` privileged native lane covers this package without model credentials. Marsh and policy are local `crates/` dependencies; Cargo fetches their other public dependencies. The full suite uses a frozen `--ignore-scripts` dependency install and one producer-order root build for the production addon and TypeScript, then builds the separate CopyTree test addon. It checks rustfmt on the routed bridge (`src/tool.rs`), runs Clippy with warnings denied except `dead_code` (napi exports are reached from JavaScript) and `too_many_arguments` (two legacy grep helpers), and executes Rust `test-fs`, JavaScript CopyTree and production Btrfs lanes. Generated native transaction journals, staging trees and ownership locks are excluded from source copies; copying them would invalidate their recorded inode identities.

Pinned Marsh classifies kernel-proven process creation before descendant effects and resumes attributed threads' irreversible exit stops. Native startup preserves the first ptrace stop even when another signal or lifecycle event acknowledges an interrupt; classification owns that stop before execution resumes. If cancellation leaves an unknown thread held beside an exiting leader, observation fails closed and teardown resumes and reaps the tree instead of waiting for the leader's withheld final exit. Multithreaded stdio servers can close independently; unresolved completed filesystem evidence still fails closed.

Quiescence waits for each accepted command's observer to retire, not just for its last process to exit. Cancellation and attribution remain available while late stops and failures are drained.

## Run with `pi -e`

Production execution requires an **existing dedicated btrfs seed subvolume**, a writable parent directory, and the `user_subvol_rm_allowed` mount option. Start Pi in that seed or a directory beneath it. junco-tools discovers the enclosing seed; it does not create or migrate subvolumes.

```sh
cd /path/to/your/btrfs-seed
pi -e "$HOME/git/junco/packages/junco-tools/dist/extension.js"
```

For the workspace at `/home/eioannidis/git/junco`, the extension argument is `/home/eioannidis/git/junco/packages/junco-tools/dist/extension.js`. If `pi` is not on your PATH, or is a different version, use the pinned CLI installed by the workspace's `bun install`:

```sh
"$HOME/git/junco/node_modules/.bin/pi" \
  -e "$HOME/git/junco/packages/junco-tools/dist/extension.js"
```

Run that command from the btrfs working directory, not necessarily from the package checkout. Configure Pi's model/provider credentials as usual; junco-tools does not configure an LLM.

The packaged extension:

- Registers the whole `ToolCollection` on `session_start`. **Do not disable the built-in tools**: Pi supports same-name overrides, and `read`, `bash`, `edit`, `grep`, and `find` are replaced by name.
- Uses `pi-${sessionId}` as the session's principal name (its command queue and display name), including reload/resume of that session.
- Reads the persisted shell command prefix through Pi's `SettingsManager`.
- Opens one `ToolCollection` per session under the default `LockPolicy`; that collection owns its own ShellMux over the session's seed, shared by `bash` and every file tool, and `session_shutdown` closes the collection and therefore its mux.

`bash` and the file tools are all marsh calls on that mux, routed by its sandbox mode and authorized by its policy: `LockPolicy` (a write takes ownership of its file until its owner releases or deletes it) or `EmptyPolicy` (grants every event, while marsh still keeps snapshots, freshness checks and atomic publication). Read-only tools (`read`, `grep`, `find`, `ast_grep`, the graph tools, and a previewing `ast_edit`) always run directly against the seed. Shell commands, `edit`, and an applying `ast_edit` run in a private snapshot while another live shell shares the seed — or always, when the mux is opened with `sandbox: "always"` — and there publish only what the mux's policy authorizes; alone, they act on the seed directly. Pi's separate interactive `user_bash`/`!` command path is **not** intercepted. The agent bash tool still takes `{ command: string, timeout?: number }`; timeout is in **seconds**, with no default deadline.

These direct reads can complete while a different shell's `bash` command is still running in both
sandbox modes; writes and recovery retain their exclusion. They observe the live seed, not bash's
private snapshot: a held direct command in `shared` mode may have written visible bytes, while a
held managed command in `always` mode has not published its private changes. Reads can also see a
publication in progress and do not provide an atomic multi-file view.

`read` and `grep` record snapshots in one collection-local store and emit `[path#TAG]` headers with numbered rows; the hashline `edit` tool resolves its anchors against that store, and refuses lines a read never displayed. Files that cannot be snapshotted — images, binary, invalid UTF-8, notebooks under `grep`, anything past pi-edit's 4 MiB cap — are returned untagged through Pi's unmodified behavior. An oversized read notice has no tag or numbered source row and grants no line provenance; read a complete visible line before editing.

## Register through the TypeScript API

In another ESM TypeScript project, install the built checkout and the compatible Pi version:

```sh
npm install "$HOME/git/junco/packages/junco-tools" @earendil-works/pi-coding-agent@0.99.2 @earendil-works/pi-agent-core@0.99.2
```

Use the package-root imports shown below. The package ships compiled ESM and declarations; it does not require Bun. A NodeNext TypeScript configuration matches this repository.

The junco workspace root pins `typebox` 1.4.3 with an override so Pi's older metadata pin does not create a second schema type. A consumer sharing schemas should use the same override.

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

### Reviewed source edits and repository baselines

`SourceEdit` is a domain-neutral `replace`/`create` union: `path` is a POSIX repo-relative path,
`startLine` is 1-based, and `beforeLines`/`afterLines` contain exact source lines without terminators.
An empty `beforeLines` inserts; a create uses line 1, empty `beforeLines`, and nonempty `afterLines`.
This explicit application API is separate from the agent-facing hashline `edit` tool.

```ts
import {
  applySourceEdits, captureBaseline, repositorySourceReader,
  requireWorkTreeRoot, type SourceEdit, type ToolCollection,
} from "junco-tools";

export async function applyReviewedEdits(
  root: string, collection: ToolCollection, edits: readonly SourceEdit[], signal?: AbortSignal,
) {
  await requireWorkTreeRoot(collection, signal);
  const baseline = await captureBaseline(root, new Set(edits.map((edit) => edit.path)));
  const readSource = repositorySourceReader(root, baseline);
  // readSource(path) decodes BOM-aware UTF-8/UTF-16LE and rejects a changed captured file.
  return applySourceEdits(root, collection.mux, edits, baseline, {
    label: "reviewed edits", signal,
  });
}
```

Capture the baseline **before** analysis/review and retain it until application. Baseline entries
are SHA-256 hashes of complete bytes, or `null` for absent paths. Both capture and source reading
reject invalid paths, dangling symlinks, and paths resolving outside the repository;
`isRepoRelativePath` exposes the lexical predicate. A reader returns `undefined` for missing files,
and may read uncaptured files; a captured absence rejects a subsequently created file.
`requireWorkTreeRoot` checks the collection's cwd through its native bash tool, rejecting a subdirectory
or non-working-tree repository and retaining Git output in the error's cause.

`applySourceEdits` borrows a mux opened with `sandbox: "always"`; the caller retains its lifetime.
It runs the native `mux.astApply(cwd, { files, edits, label, signal? })` routed call, which preflights
every baseline hash, exact before-line, range, overlap, encoding, and target before writing; refuses
symlink targets, escaping/dangling ancestors, and multiply linked replacement files; preserves
existing BOMs, UTF-8/UTF-16LE, line terminators, final-newline state, and file modes; and creates
UTF-8 files with LF and a final newline. The same routed call then releases exactly the sorted unique
edited paths, without staging or committing; the mux's policy still authorizes every write and
release. A refusal rejects with `Applying <label> failed: <reason>; nothing was written` and publishes
nothing; policy denials keep their identity.

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
| `ToolCollection.create(cwd, { policy?, bash?, principal?, sandbox?, native?, resources?, onResourceEvent?, recorder? }?)` | Every tool (`read`, `bash`, `edit`, `release`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`, `code_graph`) in `collection.tools`, sharing one `EditStore` and the collection's own mux. `policy` is a `Policy` (default `LockPolicy`); `native`/`sandbox`/`resources`/`onResourceEvent`/`recorder` follow `ShellMuxLease.create`. Readonly `policy` (the very object it was opened with), `mux`, `native`, `recorder`; `tools` act as the collection's own policy owner, while `mux` is the unforked session borrowers share. |
| `collection.lease()`, `collection.close()` | `lease()` takes a borrower hold, returning `{ close() }`; `close()` releases the creator hold once. The final release aborts and joins this collection's calls and default bash commands, rejects its retained tools, closes owned operations, and closes its mux; it never closes caller-supplied operations. Idempotent. If `create` itself fails, it releases only what it acquired before rejecting. |
| `collection.bind(recorder?)`, `ToolBinding` | One fresh policy owner's view: `tools` maps each original collection tool (by identity) to a counterpart over the same `EditStore`, mux session and invocation fence, acting as that owner (bash runs on owner-bound operations; supplied custom operations are shared as is). Its calls and its owner's pipelines record in `recorder` (a `ProfileRecorder<"memory" \| "tokens" \| "edits" \| "operations">` or getter; default the collection's). Holds the collection until its idempotent `close()`, which aborts and drains only this binding's calls and commands. `JuncoAgent` takes one per agent. Neither close clears committed ownership. |
| `isMarshPolicyDenied(error)`, `MARSH_POLICY_DENIED`, `MarshPolicyDeniedError` (also from the native-free `junco-tools/errors`) | Recognize a publication refused by marsh's policy. |
| `Policy`, `LockPolicy`, `EmptyPolicy`, `Policy.and(left, right)`, `Policy.or(left, right)`, `Policy.not(policy)` | Mux authorization policies. `Policy` is an open interface, `{ toNative(native): NativePolicy }`, building the native policy it denotes with one addon (each addon build has its own `NativePolicy`); any implementation composes with the others. `LockPolicy`: a write takes ownership of its file until released or deleted. `EmptyPolicy`: grants every capability. `and` grants what both grant (denying with the first denial), `or` what either grants (denying with both preconditions and fixes), `not` what its operand denies. Policies compare by identity, so share one object wherever one policy is meant. |
| `BashTool.create(cwd, { operations, ... }, recorder?)` | `bash` through ShellMux. `operations` (from `ShellMuxOperations`) is required, so there is no host-bash fallback; the caller closes it. |
| `ReadTool.create(cwd, store, native, mux, recorder?)`, `GrepTool.create(cwd, store, native, mux, recorder?)`, `EditTool.create(cwd, store, native, mux, recorder?)` | Hashline `read`, native `grep`, and hashline `edit` as routed calls on `mux`; pass them one shared `EditStore`. |
| `ReleaseTool.create(cwd, mux, recorder?)` | `release({ file })`: relinquishes `mux`'s owner's ownership of one file as an always-managed routed call, resolving once marsh published it. Nothing is read or written; releasing another owner's file is a policy denial, releasing an unowned file succeeds. Deleting a file releases it automatically. |
| `FindTool.create(cwd, native, mux, recorder?)`, `AstGrepTool.create(cwd, native, mux, recorder?)`, `AstEditTool.create(cwd, native, mux, recorder?)`, `DiffTool.create(native, recorder?)` | Native `find`, `ast_grep`, previewing `ast_edit` as routed calls on `mux`, and in-memory `diff`. |
| `CodeGraphTool.create(cwd, native, mux, recorder?)` | `code_graph`: deterministic tree-sitter code graph (private library `crates/rust-graph`, no standalone CLI or LLM) as a routed read on `mux`. Actions: `map` (directory buckets, hubs, hotspots), `search` (`query`, optional `kinds`/`pathPrefix`/`lang`/`limit`, default 10), `deps` (`symbol`, optional `symbolPath`/`direction`/`depth` 1–5/`relations`) and `cluster` (below). `path` always selects the repository root; any action accepts `fstar` include-path settings (see F* below). Every call refreshes `<root>/.junco/graph/graph.json`, parsing changed files; ignore `.junco/`. Results use snake_case JSON (`GraphMapResult`, `GraphSearchResult`, `GraphDependencyResult`, `GraphClusterResult`, together `CodeGraphResult`). |
| `new ShellMuxOperations({ principal?, native?, mux?, policy?, sandbox?, resources?, onResourceEvent?, recorder? }?)` | Pi-compatible `BashOperations` backed by ShellMux, plus `close()`, which stops only this owner's commands. A supplied `mux` is borrowed and never closed; it keeps its policy and resources, so it takes no `policy`, `resources`, or `onResourceEvent`, and an explicit `sandbox` must match it. Otherwise the first command lazily opens an owned mux (`policy` default `LockPolicy`, `recorder` passed to it) that `close()` releases. With `recorder` (a `ProfileRecorder<"memory">` or getter) each command records as `shell/exec`. |
| `ShellMuxLease.create(cwd, { policy?, native?, sandbox?, resources?, onResourceEvent?, recorder? }?)` | Opens one fresh ShellMux at `cwd` (default `"shared"`) with `policy` (default `LockPolicy`), returning `{ mux, native, policy, recorder, closed, registerRecorderOwner(owner, getter), release() }`. `await release()` closes that mux, drains resource callbacks, then flushes its policy log; repeated calls return the same promise. |
| `LspTool.create(cwd, { readOnly? }?, recorder?)`, `LspTool.shutdown()` | Oh My Pi's `lsp` tool, from the pinned npm `@oh-my-pi/pi-coding-agent@18.13.3`, as a Pi `AgentTool` for any `tools` array (also re-exported by `junco`). **Bun >=1.3.14 only**: `create` rejects under Node, though importing the package stays safe. Caller-installed language servers are discovered by upstream configuration; navigation uses a one-based `line` plus `symbol`; `timeout` is in seconds (default 20, 5–300); `readOnly` rejects upstream's write-tier actions. Semantic failures reject with upstream's text and the original result as `Error.cause`. It runs with host filesystem/process access, **not** through marsh's sandbox or hashline provenance, and is not part of `ToolCollection` or the Pi extension. `shutdown()` is process-wide teardown of upstream's client registry, called once all LSP users drain. |
| `new YieldTool(recorder?)`, `isYieldTool(tool)`, `YieldTool`, `YieldToolDetails` | The native-free voluntary-suspension `yield` tool: executing it returns its non-empty `reason` as text and `details.reason`, and nothing else. `JuncoAgent` (`junco-agent`) treats a successful call as a pause after the tool batch; a bare Pi `Agent` continues. `isYieldTool` is true only for an object `new YieldTool()` constructed, never for a same-named tool or a spread copy. It is not part of `ToolCollection`. |
| `new RecvTool(host?, recorder?)`, `new SendTool(host?, recorder?)`, `new InfoTool(host?, recorder?)` (each with `.is(tool)` and `.invoke(tool, host, toolCallId, input, signal)`) | Native-free graph messaging tools, newtyped so only constructor-built carriers are graph primitives. `recv({})` drains the node's retained `{ messages, values }`; `send({ id, payload })` admits one message on an existing outgoing message edge; `info({})` returns `{ parents, children }` entries containing only `{ id, edgeId, kind }`. Handoff instructions belong in prompts and routes are selected by edge ID and kind. Invalid input, an absent host or cancellation has no effect. None of them pauses a run. A `junco` graph supplies the host for a registered agent. Not part of `ToolCollection`; `JuncoAgent.create` adds all three to its defaults. |
| `new TaskTool(host?, recorder?)`, `new AssignedTaskTool(input, host?, recorder?)`, `TaskTool.is(tool)`, `AssignedTaskTool.is(tool)`, `tool.host`, `tool.invoke(host, toolCallId, input, signal)`, `TaskInput`, `TaskDecision`, `TaskCall`, `TaskTool`, `AssignedTaskTool`, `TaskToolHost`, `TaskToolDetails` | The native-free `task` tool. `TaskTool` launches a free-form `TaskInput` `{ context, tasks: [{ task, name?, model?: { provider, modelId }, tools? }] }` (required shared `context` prepended to every task, at least one task, non-blank text, no extra properties). `new AssignedTaskTool(input, host?)` validates and stores a detached copy of `input` off its schema; the model launches it with `task({})`. Both also accept a `TaskDecision` `{ action: "retry" \| "ignore", id, attempt }` (positive safe integer `attempt`, no extra properties) for a failed report marked `decisionRequired`. The model-facing schema is one object with optional fields (providers reject top-level unions); each call is checked against the exact launch, trigger or decision shape, and the host receives a detached `TaskRequest` (a `TaskInput` or a `TaskDecision`). A successful launch returns one opaque handle `{ id, name? }` per task (in `details.tasks` and as JSON text), a retry exactly the retried task's handle, an ignore none (`Ignored task <id>.`); any other receipt is an error, though the fulfilled host has already committed. A host rejection must mean nothing was admitted. The tool tells the model that subagents start immediately in the background while it keeps working. Execution goes through the host passed to the constructor, else through the native host of the `JuncoAgent` running the tool (`invoke`); a bare unhosted tool executed directly fails with `task requires a host`. `tool.host` is the constructor-supplied host of a genuine task tool, never of a copy. `TaskTool.is` is true only for an object either constructor returned, `AssignedTaskTool.is` only for `AssignedTaskTool`'s; never for a same-named tool, a spread copy or an `Object.create` forgery, and `invoke` on such a receiver throws `TypeError` before any host call. Not part of `ToolCollection`; `JuncoAgent.create` adds a `new TaskTool()` to its defaults. |
| `new ComplainTool(host?, context?, recorder?)`, `isComplainTool(tool)`, `invokeComplainTool(tool, host, context, toolCallId, input, signal)`, `issueLog`, `Issue`, `Prompt`, `ComplaintContext`, `ComplainToolHost`, `ComplainTool` | The native-free, frozen `complain` tool: `{ complaint }` (non-blank string, no extra properties), returning `Complaint recorded.` without pausing anything. Execution resolves a `ComplaintContext` (node ID, delivered messages, full model `Prompt`, optional tracer) and calls `host.complain(issue, tracer)` once; without a host and context it fails with `complain requires an agent context`. `JuncoAgent` always owns one and supplies its context. `issueLog` is the process-wide append-only history: `append(issue, tracer?)` stores a frozen snapshot (structured-cloned prompt, copied message list; node payloads stay references) and then notifies `tracer.complain(nodeId, complaint)`, isolating observer failures; `snapshot()` returns a frozen copy; nothing is ever removed. Not part of `ToolCollection`. |
| `recorder?` (final argument of the tool constructors/factories above) | A `ProfileRecorder<"edits">` (`ast_edit`) or `ProfileRecorder<"operations">` (the others), or a getter returning one, resolved once per call after any invocation recorder an agent scopes. Each call records one start/finish (validation failures and returned errors are `error`, aborts `cancelled`), output sizes and typed result counters (AST byte deltas, `code_graph` counts and page gauges, messages sent/received, routes, task handles, complaints); `.invoke` paths count exactly once. Tools are profile-owned whether or not a recorder is given. |
| `NativeModule`, `NativeMux`, `EditStore` (types only) | The `native`, `mux` and `store` parameter contracts of the factories above. The root exports them as types only so importing tools never loads the addon; the runtime module and constructors come from `junco-tools/native`. |
| `NativeMux`, `NativePolicy` from `junco-tools/native` | The raw native session: `NativeMux.open(cwd, { sandbox?, policy?, resources? }?, onPolicyDecision?, onResourceEvent?)`, `mux.seed`, `mux.sandbox`, `mux.validateCwd(cwd)`, `mux.forkOwner()`, `mux.release(cwd, file)`, and `mux.close()`. Native callbacks receive `(error, data)`. `policy` is a `NativePolicy` (`NativePolicy.lock()`, `.empty()`, `.and(l, r)`, `.or(l, r)`, `.not(p)`), the ownership-lock policy when omitted. Each call of an opened handle acts as its own fresh shell; `forkOwner()` returns a handle over the same session (sharing its admission and close) whose every call, command and process acts as one fresh owner. Muxes are independent; several may be open over one seed and share its source authority. Prefer `ShellMuxLease.create`. `sandbox` is `"shared"` (the default: sandbox a shell command or writing file tool while another live shell shares the seed) or `"always"`; `release` always takes the managed route. |

Every factory returns a Pi `AgentTool` that also carries Pi's prompt metadata and renderers: pass it to a bare `Agent`, SDK `customTools`, or `pi.registerTool` without wrapping. `native` is the `junco-tools/native` module; `store` is `new native.EditStore()`; `mux` comes from a lease or a collection. `BashOperations`, `BashToolInput`, `BashToolDetails`, and `BashToolOptions` are re-exported from Pi, not independently defined tool types. `HashlineEditDetails` is junco's own edit-result shape (`{ files: EditFileOutcome[] }` from the native engine) and is deliberately **not** Pi's `EditToolDetails`.

- Each collection, lease, and owning operations instance has its own ShellMux with its own policy; working directories must remain inside that mux's seed. Consumers that should share a mux and policy borrow one collection.
- Without `principal`, one `pi-`-prefixed UUID is generated per operations instance, not per command. The principal is a queue and display name, not a policy identity: the commands act as the operations' mux owner (an owned mux is forked to one fresh owner). Reusing a name grants nothing.
- Marsh shares a seed's source authority across live shells and muxes; an idle mux holds no exclusive lease. A direct shell command excludes other non-read admissions over that seed until it settles, though read-only file tools can overlap. Managed shell commands can overlap. Direct writes change the seed without recording durable grants or consulting earlier grants; managed publications perform those checks.
- A mux belongs to its owner: the final collection release, `lease.release()`, or an owning operations `close()` closes it. Borrowers never close what they borrowed.
- Commands sharing a principal are serialized. Each call gets a fresh shell/snapshot: shell variables and functions do not persist between invocations. Ownership is the mux owner's: a write takes ownership until that owner releases the file (or deletes it), and closing a mux or opening another one releases nothing.
- Commands are observed in-process: marsh's tracer threads seize each spawned command before it runs, and the interpreter reports its own file accesses. No companion executable is needed. Node children work: libuv's epoll-only `io_uring` ring is accepted, while rings that submit filesystem operations are refused.
- A publication marsh's policy refuses rejects a routed file tool (`edit`, an applying `ast_edit`), `bash`, or a native `NativeRun.wait()` with a real `Error` whose own `code` is `"MARSH_POLICY_DENIED"`; its message is marsh's diagnostic. Test it with `isMarshPolicyDenied`, never the message text. Every other failure, including cancellation, timeouts, and read-only tool errors, stays a plain error without that code. A refused hashline `edit` also discards the anchors it recorded, so its unpublished result cannot back a later edit.

### Pipeline resources

`ToolCollection.create`, `ShellMuxLease.create`, and owned `ShellMuxOperations` accept
`resources: { memoryBytes?, cpus?, pids?, monitorIntervalMs? }`. Limits apply separately to
each outermost pipeline of every bash command and persistent process on that mux, including
its descendants. Memory is a positive integer byte ceiling with swap disabled; `cpus` is a
positive CPU quota (for example `0.5`); `pids` is a positive integer up to 4294967295. Omitted
limits leave that resource unlimited. File tools spawn no pipelines and are unaffected.

Resource control requires Linux cgroup v2 with delegated cpu/memory/pids controllers. Without
delegation, external commands fail closed with `cgroup resource control unavailable` on
standard error instead of running unlimited. Builtin-only pipelines create no cgroup or events.

Monitoring requires both a positive `resources.monitorIntervalMs` (milliseconds) and
`onResourceEvent(event)`. `NativeResourceOptions` and `NativeResourceEvent` are package-root type
exports (`NativeResourceSample` comes from `junco-tools/native`). Events share a `pipelineId`: `started`
carries the pipeline's source text in `command`; periodic, lossy `sample` events and the
always-delivered `finished` event carry cumulative accounting in `sample`. Sample durations
are milliseconds, memory fields are bytes, and counters are JavaScript numbers.
Every event also carries `owner` for a forked handle (`NativeMux.owner`, exposed as
`ToolBinding.owner` and `JuncoAgent.owner`); an unforked handle has no owner. Each shell
uses a private monitor, preserving its owner on started/sample/finished events even when
several bindings share one collection.

The final collection release, lease `release()`, or owned operations `close()` waits for the
event stream to end and all callbacks to return; a callback throw rejects that final release
without changing command execution. Borrowed muxes retain their original resource settings.
`JuncoAgent.create` keeps its default collection settings; pass a configured collection to
give an agent resource limits.

### Profiling

A `ProfileRecorder<R>` (see `profile-recorder.ts`) is narrowed by plain assignment to the
resource singletons each producer records: `memory` for `bash`, `shell/exec` and native resource
events, `edits` for `edit`, `diff` and `ast_edit`, `operations` for the other tools (including
`lsp`, labelled by its upstream action or `invalid`). With a `recorder`, a lease enables
monitoring at `resources.monitorIntervalMs` (default 1000, explicit values and limits kept) and
records every event as `{ resource: "memory", kind: "resource", source, event }` beside any
`onResourceEvent`; both run even if the other throws, and a throw still rejects `release()`.
Each pipeline records in the view its owner's `registerRecorderOwner` getter returned at its first
event until it finishes; unregistered or unforked owners use the lease's own view. Collections
register their own and every binding's owner. `shell/exec` counts `output_bytes`,
`nonzero_exits`, `timeouts`, `cancellations` and gauges `exit_code_last`; a nonzero exit is an
`error` outcome. A collection records admitted calls of any tool not accounting its own as
`custom`; refused calls after close record nothing.


## Proof-language graph support

`code_graph` includes Rocq, Lean, Verus and F* grammars pinned to upstream commits under [`crates/rust-graph/vendor`](crates/rust-graph/vendor/README.md). They are not committed here. `bun run grammars` (`cargo xtask grammars`) shallow-fetches each upstream repository at its pinned commit, including its committed generated parser, so nothing is generated locally. It is the first step of `build:native`/`build:native:test`, so the workspace `bun install` runs it through the root `postinstall` whenever a Rust toolchain is present. Checkouts already at their pin are skipped. Builds need `git` and GitHub access; nothing is downloaded at runtime.

| Language | Files and search aliases | Static extraction |
| --- | --- | --- |
| Rocq/Coq | `.v`; `lang: "rocq"` or `"coq"` | Definitions, lemmas/theorems and their proof spans, inductives/constructors, records/classes/fields, modules and local Require imports |
| Lean 4 | `.lean`; `lang: "lean"` or `"lean4"` | Definitions, theorems, axioms/constants, inductives, structures/classes/fields, named instances, namespaces and local module imports |
| Verus | Real Verus syntax in `.rs`; `lang: "verus"` | `verus!` bodies, standalone spec/proof declarations and contracts, program/proof calls, types and impl ownership |
| F* and injected Pulse | `.fst`/`.fsti`; `lang: "fstar"`, `"f*"`, `"fst"` or `"fsti"` | Let/val declarations, proofs, types/classes/constructors/fields, modules and aliases, dependencies, and real Pulse fences/`#lang-pulse` bodies with original source spans |

Ordinary Rust keeps its existing grammar and `rust` language label. Verus routing inspects syntax, not text inside comments or strings. New languages reuse the existing node kinds: theorem/proof declarations are functions and namespaces are modules. `map`, `search`, `deps`, and cluster views all use the same extracted graph. The extractor-version bump automatically rebuilds older caches, including Rust caches that previously treated `verus!` bodies as opaque.

Rocq imports resolve local dotted module files and literal `-Q`/`-R` mappings in the nearest `_CoqProject`; Lean imports resolve local dotted module paths. This does not run package managers, interpret arbitrary build configuration, elaborate notation/macros, or check proofs. The small upstream Rocq grammar needs parser-token recovery; Lean dynamic syntax/patterns and some Verus modifiers remain incomplete. Missing edges are still not evidence that implementation or proof source is absent. See the vendoring notes for exact revisions, licensing and grammar limitations.

F* modules resolve the way `fstar.exe` would for each source file as its command-line input: ordered include roots (cache directory, default library, explicit `--include` roots, an uncovered input parent, then cwd), `fstar.include` manifests, namespace directories (`A/B/C.fst` is `A.B.C` only under a recursive root), case-insensitive names, and the last root winning separately for `.fsti` and `.fst`. Settings come from the nearest `*.fst.config.json` within the graph root (fstar-vscode-assistant's `cwd`, `fstar_exe`, `options`, `include_dirs`; no parent merging, no Makefile fallback); the `fstar` parameter (`cwd`, `fstarExe`, `options`, `includeDirs`) replaces discovered fields one by one, `[]` included, and its relative `cwd` is relative to the graph root. Only `--include`, `--cache_dir`, `--no_default_includes`, `--with_fstarc` and `@respfile` select files; other options are parsed for arity, never run. The default library is `FSTAR_LIB`, else `<fstar.exe>/../lib/fstar` found statically on `PATH`; without either, explicit and local roots still work. Selected files outside the root are indexed under `../`-prefixed graph keys, and only from the roots that selected them: imports and name fallback never reach a shadowed or unrelated project's sources. Configuration, manifests and roots are reread on every refresh. Navigation prefers a selected implementation over its interface. A `val` and body sharing a name remain separate source nodes, but references resolve to the implementation rather than becoming ambiguous; declaration roles survive cache reuse. Pulse and ordinary F* share the `fstar` language label. Foreign opaque extension bodies are not indexed as F*/Pulse, and no F* verification is implied.

Run the library checks with `(cd crates/rust-graph && cargo test --locked)` and the real-native language fixtures with `node --test --test-name-pattern='code_graph extracts' tests/tools.test.mjs` after building the production and test addons and TypeScript package.

## Cluster evidence

`code_graph({ action: "cluster", path: repo, directory: "src" })` lists symbol groupings touching that root-relative POSIX directory; leading `..` components select indexed files outside the root, such as F* include roots (`../lib`). `clusterView: "members"` with a returned `clusterId` returns source nodes/spans; `clusterView: "neighbors"` returns one-hop code dependencies. Members rejects `directory`/`direction`; neighbors rejects `directory`; list rejects `clusterId`/`direction`. Map's directory buckets are not cluster IDs.

Clustering always covers the full refreshed graph: directory selection changes list rows, never memberships. Clusters may cross directories; `matching_files` counts selected files and `contained` indicates all files match. `sample_files` shows the first five sorted distinct paths; `file_count` counts every file. An absent directory returns no rows, not an extraction guarantee. Unsupported source still needs inspection.

All views return `total`, echoed `offset` (default 0), and `next_offset` (null at the end). `limit` defaults to 20 and accepts 1–100. Follow relevant pages; if the byte-bound truncates output, lower the page limit rather than infer missing rows are absent. Keep root, `maxSize` (default 20) and `omnipresent` (default automatic) fixed while browsing. IDs are snapshot/options-local handles; restart from list after edits.

Neighbor `direction` defaults to `both`: `out` means selected calls/references another cluster; `in` means another cluster uses selected. Each neighbor appears once, with both actual `incoming` and `outgoing` edges when present, even if only one direction selected it. Edges count distinct symbol pairs and distinct target symbols; cycles are valid evidence, not workflow loops or scheduling order. Connectivity is symbol-only: use ordinary `deps` for file imports, or file deps with `direction: "out", relations: ["contains"]` for definitions. No depth traversal is added to clusters.

## Native terminal display

`NativeTui` and its input types are runtime/declaration exports of **`junco-tools/native` only**, not package-root runtime exports. They are present in both the production addon and the `test-fs` addon (`target/native-test/index.js`). Opening the display needs no `ToolCollection`, `NativeMux`, btrfs seed/mount, or Marsh tracing capabilities; the package's native build prerequisites above remain unchanged.

```ts
import { NativeTui } from "junco-tools/native";

type NativeTuiNode = { key: string; nodeId: string; scope: string };
type NativeTuiTrace = {
  nodeKey?: string;
  text: string;
  recordId?: string;
  mode?: "append" | "replace";
  tone?: "normal" | "thinking" | "error";
};

// NativeTui's public API:
// static open(name: string): Promise<NativeTui>
// setNode(node: NativeTuiNode): void
// setActive(nodeKey: string, active: boolean): void
// trace(record: NativeTuiTrace): void
// flush(): Promise<void>
// finish(): Promise<void>
// waitForExit(): Promise<"dismissed" | "interrupted" | "closed">
// close(): Promise<void>
```

`open(name)` requires interactive **stdin and stdout**, otherwise rejecting with `TuiTracer requires an interactive terminal on stdin and stdout`. One session owns the terminal process-wide; another acquisition rejects with `A TUI session already owns this terminal`. It resolves after initialization on a dedicated native thread, which owns input polling, raw mode, the alternate screen, and the hidden cursor. Startup failures roll back ownership and partially entered terminal modes. Normal close, input/render failures, and worker unwinding attempt cursor, alternate-screen, and raw-mode restoration before publishing completion; there is no process-wide panic hook. Direct `process.exit()`, process abort, and `SIGKILL` bypass asynchronous cleanup.

`setNode` additively registers one scoped identity or updates its badge while preserving its color and activity. `key` is the raw scoped identity; `nodeId` is the escaped display spelling and `scope` identifies its graph. Unknown node keys and invalid trace modes/tones reject rather than inventing nodes. `setActive` controls the active badges in the title. `trace` appends a record without `recordId`, or coalesces one by `(nodeKey, recordId)`; `append`/`normal` are the defaults, and `replace` replaces progress text. Omitted `nodeKey` uses a neutral `[system]` badge.

The screen is one full-terminal bordered **Agent traces** pane with the session name, completion state, active scoped badges, omitted count, and following/paused state in its title. Registered scoped badges keep distinct identity colors. Thinking bodies are dim and error bodies red without changing badge colors. Controls in display text are escaped (newlines retained, tabs expanded to four spaces).

Arrows scroll traces, with Left/Right as one-line aliases; PageUp/PageDown move by the viewport; Home goes to the oldest record; End restores tail-follow. Tab has no display action. `q`/Esc dismiss at any time without cancelling graph computation, and later updates are discarded. Ctrl-C restores and reports `interrupted`; the higher-level `TuiTracer` handles application signal propagation. History is in-memory display text only, bounded to **4 MiB**, **4,096 records**, and **32 KiB per formatted entry**. Truncation is UTF-8-safe and marked `[display truncated]`; oldest records are evicted with an omitted count in the title. These limits do not truncate graph results or agent state.

- `flush()` is a **draw barrier** for preceding updates, never a keyboard wait. After intentional closure it settles after restoration.
- `finish()` marks completion synchronously when called, requests the final frame, and waits for dismissal/restoration. A dismissal queued before that final draw does not skip the frame.
- `waitForExit()` observes the same restored/joined worker completion and reports `dismissed`, `interrupted`, or `closed`.
- `close()` immediately fences updates and restores/joins without requiring keyboard dismissal; it is idempotent. Display failures are latched and reject barriers/completion after restoration, with no stdout fallback.

For graphs, use `junco`'s `tracer.TuiTracer` rather than managing the native screen directly. Its caller owns interactive completion: stop/close all shared graphs, then call the shared tracer's `flush()` to retain the final screen until `q`/Esc; `close()`/async disposal restores without waiting. This interactive finish is deliberately different from `NativeTui.flush()` and `flushLog()`. While the TUI owns the terminal, do not directly write to process stdout/stderr (including inherited subprocess stderr); capture such output instead.

## Operational logging and output ownership

The `junco-tools/log` APIs are `log`, `redirectLog(output: { write(line: string): void; flush(): Promise<void> }): () => void`, and `flushLog(): Promise<void>`. Operational/policy logging remains controlled by `LOG_LEVEL`, read once at startup: missing/blank means INFO, names are trimmed and case-insensitive, and only SILLY, TRACE, DEBUG, INFO, WARN, ERROR, or FATAL are accepted (numeric/unknown names reject). Policy grants are tentative DEBUG records; policy violations are INFO. TUI lifecycle/member trace records are independent of this operational log threshold.

`redirectLog` exclusively replaces `log.settings.pretty.levelMethod` with the sink's `write`, rather than adding a transport that also prints to stdout. Ownership is shared across module copies through `Symbol.for("junco-tools.log.output")`; a second redirect rejects with `Junco log output is already redirected`. The returned idempotent release restores the exact previous method table.

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

It takes no arguments. Each run allocates its own `btrfs-test-<random>` child beneath the package's `target/` by default, creates a fresh empty btrfs seed subvolume inside it, hands that private root to the child suites as their working directory, and afterwards deletes exactly that root — nested subvolumes, leftover marsh snapshots and all. Set `JUNCO_BTRFS_TEST_ROOT` to an existing absolute directory to allocate elsewhere without moving the checkout or its build outputs; empty or relative overrides fail. The canonical allocation base must be writable and searchable on btrfs with `user_subvol_rm_allowed`. Only the parent is configurable, never the seed; there is no fallback to the checkout, HOME, or a fake filesystem. Earlier fixtures and the supplied parent are never swept. Cleanup failures retain and report the owned fixture.
