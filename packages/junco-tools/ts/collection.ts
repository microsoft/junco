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
import {
  createShellMuxOperations,
  type ShellMuxOperations,
} from "./operations.js";
import { createReadTool } from "./read.js";
import { acquireShellMux, type ShellMuxLease } from "./shell-mux.js";
import { resolveToolPath } from "./tool-support.js";

export interface ToolCollectionOptions {
  bash?: BashToolOptions;
  /**
   * Adopted as the application's ShellMux when none is open yet, or that exact open mux;
   * any other mux is refused. Requires `native`, the addon that created it.
   */
  mux?: NativeMux;
  /** Must be the open ShellMux's addon, when one is open. */
  native?: NativeModule;
  /** The first acquisition's mode (default "shared"); later ones must match or omit it. */
  sandbox?: "shared" | "always";
  /** Principal for the default bash operations. */
  principal?: string;
}

/**
 * A complete set of junco AgentTools backed by its native engines and the application's one
 * marsh mux.
 *
 * One collection owns exactly one native `EditStore`, so `read`, `grep`, and
 * the hashline `edit` tool share snapshots, seen-line provenance, and clipboard
 * registers. Every file tool is a routed marsh call through that mux, and `bash` runs on the
 * same mux unless its operations are supplied: a read-only call runs directly against the
 * seed, while a writing call may run in a private snapshot whose changes publish only when
 * marsh authorizes them.
 *
 * The returned `tools` come from the same factories exported standalone and
 * are directly usable as a bare Agent's tools, SDK `customTools`, or with
 * `pi.registerTool`. `cwd` must lie inside the mux's btrfs seed. `close()` is terminal for
 * this collection only: it aborts and joins its own invocations and default bash commands,
 * then releases its lease. Only {@link shutdownShellMux} closes the mux.
 */
export class ToolCollection {
  readonly tools: AgentTool<any>[];
  readonly #lease: ShellMuxLease;
  readonly #operations: ShellMuxOperations | undefined;
  readonly #abort = new AbortController();
  readonly #invocations = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;

  private constructor(
    tools: AgentTool<any>[],
    lease: ShellMuxLease,
    operations: ShellMuxOperations | undefined,
  ) {
    this.#lease = lease;
    this.#operations = operations;
    for (const tool of tools) {
      const execute = tool.execute;
      // Every Pi and junco tool takes its AbortSignal third; definitions add a trailing context.
      tool.execute = (...args: Parameters<typeof execute>) => {
        if (this.#closing !== undefined || this.#lease.closed) {
          return Promise.reject(new Error("ToolCollection is closed"));
        }
        const signal = args[2];
        args[2] = signal
          ? AbortSignal.any([signal, this.#abort.signal])
          : this.#abort.signal;
        const invocation = execute.apply(tool, args);
        this.#invocations.add(invocation);
        const settled = () => this.#invocations.delete(invocation);
        invocation.then(settled, settled);
        return invocation;
      };
    }
    this.tools = tools;
  }

  static async create(
    cwd: string,
    options: ToolCollectionOptions = {},
  ): Promise<ToolCollection> {
    if (options.mux && !options.native) {
      throw new Error(
        "ToolCollection: a mux requires the native module that created it",
      );
    }
    const root = resolveToolPath(process.cwd(), cwd);
    // Rejects outside the mux's seed: every file tool needs one.
    const lease = await acquireShellMux(root, {
      native: options.native,
      mux: options.mux,
      sandbox: options.sandbox,
    });
    const { native, mux } = lease;
    let operations: ShellMuxOperations | undefined;
    try {
      const store = new native.EditStore();
      operations = options.bash?.operations
        ? undefined
        : createShellMuxOperations({
            native,
            mux,
            principal: options.principal,
          });
      return new ToolCollection(
        [
          createReadTool(root, store, native, mux),
          createBashTool(root, {
            ...options.bash,
            operations: options.bash?.operations ?? operations,
          }),
          createEditTool(root, store, native, mux),
          createGrepTool(root, store, native, mux),
          createFindTool(root, native, mux),
          createAstGrepTool(root, native, mux),
          createAstEditTool(root, native, mux),
          createDiffTool(native),
        ],
        lease,
        operations,
      );
    } catch (error) {
      // Only this collection's lease and default operations; the mux serves other consumers.
      try {
        await operations?.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "ToolCollection: construction failed and closing its operations failed",
          { cause: error },
        );
      } finally {
        lease.release();
      }
      throw error;
    }
  }

  /**
   * Fences new calls, aborts and joins this collection's invocations and default bash
   * commands, and releases its lease. Never closes caller-supplied operations or the mux.
   * Idempotent.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#abort.abort(new Error("ToolCollection is closed"));
      try {
        await Promise.allSettled([...this.#invocations]);
        await this.#operations?.close();
      } finally {
        this.#lease.release();
      }
    })();
    return this.#closing;
  }
}
