# junco-agent

A barebones async-generator wrapper around one Pi `AgentHarness` prompt, with the native-backed [`junco-tools`](../junco-tools) collection as its default tools.

Each generator runs one prompt in a fresh in-memory Pi session. There is no dataflow graph, durable-session storage, or capability-checking layer, and no CLI.

## Layout

| Path | Package | Role |
| --- | --- | --- |
| `src/` → `dist/` | `junco-agent` | The ESM library: `JuncoAgent` and its types. |
| `packages/model-auth/` | `model-auth` (workspace) | Authentication and model resolution. |
| `test/` | — | Offline Bun suite and its `drive`/`newAgent` harness over Pi's `fauxProvider`. |
| `../junco-tools` | `junco-tools` (`file:../junco-tools`) | Sibling checkout with native-backed Pi tools. |

## Setup

Requirements: Linux x86-64 with glibc, Node.js `>=22.19.0`, and Bun `1.3.14`.

`junco-tools` must be built before this repository is installed. If its `dist/` or `native/junco_tools.linux-x64-gnu.node` is missing, build it using its [README](../junco-tools/README.md) prerequisites (Rust toolchain, `../marsh`, native libraries):

```sh
cd ../junco-tools
npm ci
npm run build
```

The Rust backend is built by `junco-tools` from its own Cargo manifest. This repository has no Cargo manifest and no native code.

Then, from this repository:

```sh
bun install --linker hoisted
bun run build
bun run typecheck
bun run test
```

Bun installs `file:../junco-tools` as per-file symlinks into the sibling checkout, so rebuilding the tools in place is picked up without reinstalling. Rerun `bun install --linker hoisted` if the tools checkout gains or loses files.

Root `src/` and `test/` import `model-auth` through its package exports, which point at `packages/model-auth/dist/`. `bun run build` and `bun run typecheck` rebuild it first; `bun run test` does not, so after editing auth sources run `bun run build` before testing, or the tests use stale output (or fail with `Cannot find package 'model-auth'` on a fresh clone).

## Usage

This example uses the Anthropic API and requires `ANTHROPIC_API_KEY` in the environment:

```ts
import { JuncoAgent } from "junco-agent";
import { shutdownShellMux } from "junco-tools";
import { ModelId, ModelProvider } from "model-auth";

const agent = JuncoAgent({
  provider: ModelProvider.apiKey(),
  model: ModelId("claude-sonnet-4-6"),
  systemPrompt: "You are a concise coding assistant. Read files before editing.",
  prompt: "Read README.md and summarize this repository.",
  cwd: process.cwd(),
  // `tools` omitted: the default junco-tools collection.
});

try {
  let step = await agent.next();
  while (!step.done) {
    console.log(step.value);
    step = await agent.next();
  }
  console.log(step.value.text);
} finally {
  try {
    // Closes an unfinished generator; a no-op after completion.
    await agent.return({ text: "" });
  } finally {
    await shutdownShellMux();
  }
}
```

Iterate with `next()` rather than only `for await`: `for await` discards the generator's return value, which holds the answer.

## API

```ts
interface JuncoAgentOptions {
  readonly provider: ModelProvider;
  readonly model: ModelId;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly cwd?: string; // default: process.cwd(), resolved to an absolute path
  readonly thinkingLevel?: ThinkingLevel; // default: "off"
  readonly tools?: AgentTool[]; // default: the junco-tools collection
}

type JuncoAgent = AsyncGenerator<string, JuncoResult, readonly JuncoControl[] | undefined>;
function JuncoAgent(options: JuncoAgentOptions): JuncoAgent;

type JuncoControl = {
  readonly kind: "steer" | "followUp";
  readonly msg: string;
};

type JuncoAbort =
  | { readonly code: "protocol"; readonly message: string }
  | { readonly code: "invariant"; readonly message: string };

type JuncoResult = {
  readonly text: string;
  readonly details?: unknown;
};
```

Pass controls as the argument to `next()`. They are delivered in array order; `undefined` means no controls.

```ts
await agent.next([{ kind: "steer", msg: "Focus on the public API." }]);
await agent.next([{ kind: "followUp", msg: "Then list the exported types." }]);
```

- **Startup.** Nothing runs until the first `next()`. That call validates the options, resolves the model through the provider (authenticating if needed), creates the session and default tools, and starts the prompt. There is no initial empty yield. An empty `systemPrompt` throws an `Error`. A prompt that is blank after trimming throws a `JuncoAbort` with code `"protocol"`. Model-resolution and tool-loading failures throw code `"invariant"`.
- **Streaming.** Each yielded string is one *completed* thinking or text block, not a token delta. Thinking blocks are yielded but excluded from the result. `JuncoResult.text` is the trimmed concatenation of answer text blocks (falling back to the final assistant message's text).
- **Completion.** Success returns `{ text, details: { failed: false } }`. A rejected prompt, or a final model message stopped with `error` or `aborted`, returns `{ text: "prompt failed: <message>", details: { failed: true, message } }`. The failure text is never yielded.
- **Tool backpressure.** Before each tool call the generator yields `[tool:<toolName>]`, and the tool does not start until the consumer calls `next()` again. Controls passed with that call are queued before the tool is released, so a `steer` reaches the model's next turn. A `followUp` runs once the agent would otherwise stop. Controls that arrive after the prompt has settled are dropped.
- **Cancellation.** `return()` or `throw()` while the prompt is running aborts the Pi run and waits for it to settle. A tool paused at its marker never starts, so it has no side effects. Work in an already-running tool stops according to that tool's own abort-signal support; this wrapper does not roll anything back.

## Tools

With `tools` omitted, each generator creates one `ToolCollection.create(cwd)` from `junco-tools` and passes all eight of its tools to the harness, in this order:

`read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`

- `edit` is the hashline editor. It takes `{ input: string }` and anchors on `[path#TAG]` snapshots from an earlier `read` or `grep` in the same generator, because each collection has its own native `EditStore`.
- There is no `write`, `ls`, or file-creation tool by default. The harness adds no Pi built-ins.
- Any explicit `tools` array replaces the defaults entirely, and `tools: []` disables tools. An explicit array never loads `junco-tools`. To extend the defaults, build the collection yourself:

  ```ts
  const { tools } = await ToolCollection.create(cwd);
  const agent = JuncoAgent({ ...options, cwd, tools: [...tools, myWriteTool] });
  ```

- If the native addon fails to load, the first `next()` rejects with an `"invariant"` abort. There is no fallback backend and no substitution of Pi's built-in tools.
- Path problems (such as a missing `cwd` or file) are errors from the tool at execution time. The wrapper does no preflight checks.

### Shell prerequisites and ownership

- Only `bash` needs Btrfs: `cwd` must be inside an existing **dedicated** Btrfs seed subvolume, with a writable parent directory and the `user_subvol_rm_allowed` mount option. This is checked when `bash` first runs, not at startup. Never point shell work at the enclosing home subvolume.
- The file tools (`read`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`) operate directly on the ordinary filesystem at `cwd`. They are not a sandbox.
- `bash` opens a ShellMux lazily. `shutdownShellMux()` from `junco-tools` is process-wide: it closes every default-owned mux, not one agent's. Await it **once** at application shutdown, after all generators have finished or been closed. Never call it per agent.

## Authentication

`model-auth` supports API keys, GitHub Copilot (reusing Copilot CLI credentials or running the device flow), custom `pi-ai` providers, and HTTP proxies. See [`packages/model-auth/README.md`](packages/model-auth/README.md).

## Verification and runtimes

`bun run test` is offline: it drives the generator against Pi's `fauxProvider` with caller-supplied tools and needs no credentials, Btrfs seed, or native addon. Live authentication is not part of installation or verification.

The native-backed default tools were checked end to end without mocks. A faux model called the real `read` and then the hashline `edit` through `JuncoAgent` in an ordinary temporary directory. This passed and exited cleanly under both Node.js v26.10.0 and Bun 1.3.14. That check does not run `bash`, which requires a Btrfs seed.
