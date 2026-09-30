import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { NativeMux } from "../native/index.js";
import { createAstEditTool, createAstGrepTool } from "./ast.js";
import { createBashTool } from "./bash.js";
import { createDiffTool } from "./diff.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import type { NativeModule } from "./native.js";
import { createShellMuxOperations } from "./operations.js";
import { createReadTool } from "./read.js";
import { resolveToolPath } from "./tool-support.js";

export interface ToolCollectionOptions {
  bash?: BashToolOptions;
  /** Borrowed mux; the caller closes it. Requires `native`, the addon that created it. */
  mux?: NativeMux;
  native?: NativeModule;
  /** Marsh operand for a mux the collection opens itself. Default "shared". */
  sandbox?: "shared" | "always";
  /** Principal for the default bash operations. */
  principal?: string;
}

/**
 * A complete set of junco AgentTools backed by its native engines and one marsh mux.
 *
 * One collection owns exactly one native `EditStore`, so `read`, `grep`, and
 * the hashline `edit` tool share snapshots, seen-line provenance, and clipboard
 * registers. Every file tool is a routed marsh call through the collection's
 * mux, and `bash` runs on the same mux unless its operations are supplied: a
 * read-only call runs directly against the seed, while a writing call may run
 * in a private snapshot whose changes publish only when marsh authorizes them.
 *
 * The returned `tools` come from the same factories exported standalone and
 * are directly usable as a bare Agent's tools, SDK `customTools`, or with
 * `pi.registerTool`. `cwd` must lie inside a btrfs seed: construction opens a
 * mux over it unless one is borrowed, and `close()` releases only a mux the
 * collection opened.
 */
export class ToolCollection {
  readonly tools: AgentTool<any>[];
  readonly #owned: NativeMux | undefined;
  #closing: Promise<void> | undefined;

  private constructor(tools: AgentTool<any>[], owned: NativeMux | undefined) {
    this.tools = tools;
    this.#owned = owned;
  }

  static async create(cwd: string, options: ToolCollectionOptions = {}): Promise<ToolCollection> {
    if (options.mux && !options.native) {
      throw new Error("ToolCollection: a borrowed mux requires the native module that created it");
    }
    if (options.mux && options.sandbox !== undefined) {
      throw new Error("ToolCollection: sandbox applies only to a mux the collection opens");
    }
    const root = resolveToolPath(process.cwd(), cwd);
    // Dynamic by design: a static import would load the addon at module
    // evaluation, so `import { ToolCollection }` would fail before a caller
    // could report a missing or mismatched binary. `ts/operations.ts` defers
    // the same way. A load failure rejects here; there is no second backend.
    const native = options.native ?? (await import("../native/index.js"));
    // Rejects outside a seed: every file tool needs one.
    const mux = options.mux ?? (await native.NativeMux.open(root, { sandbox: options.sandbox }));
    const store = new native.EditStore();
    return new ToolCollection(
      [
        createReadTool(root, store, native, mux),
        createBashTool(root, {
          ...options.bash,
          operations:
            options.bash?.operations ?? createShellMuxOperations({ principal: options.principal, mux }),
        }),
        createEditTool(root, store, native, mux),
        createGrepTool(root, store, native, mux),
        createFindTool(root, native, mux),
        createAstGrepTool(root, native, mux),
        createAstEditTool(root, native, mux),
        createDiffTool(native),
      ],
      options.mux ? undefined : mux,
    );
  }

  /** Closes the mux this collection opened; a borrowed mux stays its caller's. Idempotent. */
  async close(): Promise<void> {
    this.#closing ??= this.#owned?.close() ?? Promise.resolve();
    await this.#closing;
  }
}
