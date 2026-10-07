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
  /** The addon to open this collection's mux with; loaded on demand when omitted. */
  native?: NativeModule;
  /** Routing mode of this collection's mux (default "shared"). */
  sandbox?: "shared" | "always";
  /** Authorization policy of this collection's mux. */
  policy: "GitPolicy" | "EmptyPolicy";
  /** Principal for the default bash operations. */
  principal?: string;
}

/**
 * A complete set of junco AgentTools backed by its native engines and its own marsh mux.
 *
 * One collection owns exactly one native `EditStore`, so `read`, `grep`, and
 * the hashline `edit` tool share snapshots, seen-line provenance, and clipboard
 * registers. Every file tool is a routed marsh call through that mux, and `bash` runs on the
 * same mux unless its operations are supplied: a read-only call runs directly against the
 * seed, while a writing call may run in a private snapshot whose changes publish only when
 * the collection's `policy` authorizes them.
 *
 * The returned `tools` come from the same factories exported standalone and
 * are directly usable as a bare Agent's tools, SDK `customTools`, or with
 * `pi.registerTool`. `cwd` must lie inside a btrfs seed.
 *
 * Lifetime is reference-counted: the creator holds one hold, released by `close()`; each
 * borrower takes another with `lease()` and releases it with the returned handle's `close()`,
 * never the collection's. The final release aborts and joins this collection's invocations
 * and default bash commands, then closes its mux.
 */
export class ToolCollection {
  readonly tools: AgentTool<any>[];
  readonly policy: ToolCollectionOptions["policy"];
  readonly mux: NativeMux;
  readonly native: NativeModule;
  readonly #lease: ShellMuxLease;
  readonly #operations: ShellMuxOperations | undefined;
  readonly #abort = new AbortController();
  readonly #invocations = new Set<Promise<unknown>>();
  #holders = 1;
  #creatorRelease: Promise<void> | undefined;
  /** The final teardown, once started; fences execution and further leases. */
  #closing: Promise<void> | undefined;

  private constructor(
    tools: AgentTool<any>[],
    policy: ToolCollectionOptions["policy"],
    lease: ShellMuxLease,
    operations: ShellMuxOperations | undefined,
  ) {
    this.policy = policy;
    this.mux = lease.mux;
    this.native = lease.native;
    this.#lease = lease;
    this.#operations = operations;
    for (const tool of tools) {
      const execute = tool.execute;
      // Every Pi and junco tool takes its AbortSignal third; definitions add a trailing context.
      tool.execute = (...args: Parameters<typeof execute>) => {
        if (this.#closing !== undefined) {
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
    options: ToolCollectionOptions,
  ): Promise<ToolCollection> {
    const policy = options?.policy;
    if (policy !== "GitPolicy" && policy !== "EmptyPolicy") {
      throw new TypeError('policy must be "GitPolicy" or "EmptyPolicy"');
    }
    const root = resolveToolPath(process.cwd(), cwd);
    // Rejects outside a seed: every file tool needs one.
    const lease = await acquireShellMux(root, {
      native: options.native,
      sandbox: options.sandbox,
      policy,
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
            operations: options.bash?.operations ?? operations!,
          }),
          createEditTool(root, store, native, mux),
          createGrepTool(root, store, native, mux),
          createFindTool(root, native, mux),
          createAstGrepTool(root, native, mux),
          createAstEditTool(root, native, mux),
          createDiffTool(native),
        ],
        policy,
        lease,
        operations,
      );
    } catch (error) {
      const failures: unknown[] = [];
      try {
        await operations?.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      try {
        await lease.release();
      } catch (releaseError) {
        failures.push(releaseError);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          "ToolCollection: construction failed and releasing its mux failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Takes another hold on this collection; the returned handle's idempotent `close()` releases
   * it. Throws once final teardown has started.
   */
  lease(): { close(): Promise<void> } {
    if (this.#closing !== undefined) {
      throw new Error("ToolCollection is closed");
    }
    this.#holders++;
    let released: Promise<void> | undefined;
    return {
      close: () => {
        released ??= this.#release();
        return released;
      },
    };
  }

  /** Releases the creator's hold, once; the final release tears the collection down. */
  close(): Promise<void> {
    this.#creatorRelease ??= this.#release();
    return this.#creatorRelease;
  }

  #release(): Promise<void> {
    if (--this.#holders > 0) return Promise.resolve();
    this.#closing ??= (async () => {
      this.#abort.abort(new Error("ToolCollection is closed"));
      await Promise.allSettled([...this.#invocations]);
      const failures: unknown[] = [];
      try {
        await this.#operations?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#lease.release();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "ToolCollection: teardown failed");
      }
    })();
    return this.#closing;
  }
}
