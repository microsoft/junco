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
import { createReleaseTool } from "./release.js";
import { acquireShellMux, type ShellMuxLease } from "./shell-mux.js";
import { resolveToolPath } from "./tool-support.js";

export interface ToolCollectionOptions {
  bash?: BashToolOptions;
  /** The addon to open this collection's mux with; loaded on demand when omitted. */
  native?: NativeModule;
  /** Routing mode of this collection's mux (default "shared"). */
  sandbox?: "shared" | "always";
  /** Authorization policy of this collection's mux. */
  policy: "LockPolicy" | "EmptyPolicy";
  /** Display/ordering label for the default bash operations; never a policy identity. */
  principal?: string;
}

/**
 * One owner's view of a collection: each of its tools mapped, by identity, to a counterpart over
 * the same `EditStore` and mux session whose every call acts as this binding's own policy owner.
 * `close()` (idempotent) aborts and drains only this binding's invocations and bash commands, then
 * drops its hold on the collection. Neither clears an ownership Marsh already committed.
 */
export interface ToolBinding {
  readonly tools: ReadonlyMap<AgentTool<any>, AgentTool<any>>;
  close(): Promise<void>;
}

/** A collection's tool set over `mux`, with `operations` backing its bash tool. */
type BuildTools = (
  mux: NativeMux,
  operations: NonNullable<BashToolOptions["operations"]>,
) => AgentTool<any>[];

/**
 * A complete set of junco AgentTools backed by its native engines and its own marsh mux.
 *
 * One collection owns exactly one native `EditStore`, so `read`, `grep`, and
 * the hashline `edit` tool share snapshots, seen-line provenance, and clipboard
 * registers. Every file tool is a routed marsh call through that mux, and `bash` runs on the
 * same mux unless its operations are supplied: a read-only call runs directly against the
 * seed, while a writing call may run in a private snapshot whose changes publish only when
 * the collection's `policy` authorizes them. Writes take ownership; `release` relinquishes it.
 *
 * `tools` and `mux` act as this collection's own policy owner, distinct from every other
 * collection's; {@link bind} gives each further owner (an agent) its own counterparts.
 *
 * The returned `tools` come from the same factories exported standalone and
 * are directly usable as a bare Agent's tools, SDK `customTools`, or with
 * `pi.registerTool`. `cwd` must lie inside a btrfs seed.
 *
 * Lifetime is reference-counted: the creator holds one hold, released by `close()`; each
 * borrower takes another with `lease()` or `bind()` and releases it with the returned handle's
 * `close()`, never the collection's. The final release aborts and joins this collection's
 * invocations and default bash commands, then closes its mux.
 */
export class ToolCollection {
  readonly tools: AgentTool<any>[];
  readonly policy: ToolCollectionOptions["policy"];
  readonly mux: NativeMux;
  readonly native: NativeModule;
  readonly #lease: ShellMuxLease;
  readonly #operations: ShellMuxOperations | undefined;
  readonly #build: BuildTools;
  /** Caller-supplied bash operations every owner shares, or `undefined` for owner-bound ones. */
  readonly #customOperations: NonNullable<BashToolOptions["operations"]> | undefined;
  readonly #abort = new AbortController();
  readonly #invocations = new Set<Promise<unknown>>();
  #holders = 1;
  #creatorRelease: Promise<void> | undefined;
  /** The final teardown, once started; fences execution and further leases. */
  #closing: Promise<void> | undefined;

  private constructor(
    mux: NativeMux,
    build: BuildTools,
    policy: ToolCollectionOptions["policy"],
    lease: ShellMuxLease,
    operations: ShellMuxOperations | undefined,
    customOperations: NonNullable<BashToolOptions["operations"]> | undefined,
  ) {
    this.policy = policy;
    this.mux = mux;
    this.native = lease.native;
    this.#lease = lease;
    this.#operations = operations;
    this.#build = build;
    this.#customOperations = customOperations;
    const tools = build(mux, customOperations ?? operations!);
    for (const tool of tools) {
      this.#fence(tool, this.#abort.signal, () => undefined, new Set());
    }
    this.tools = tools;
  }

  /**
   * Routes `tool`'s executions through this collection's fence: refused once teardown began or
   * `closed()` reports an error, aborted by `abort`, and tracked in `own` and the collection.
   */
  #fence(
    tool: AgentTool<any>,
    abort: AbortSignal,
    closed: () => Error | undefined,
    own: Set<Promise<unknown>>,
  ): void {
    const execute = tool.execute;
    // Every Pi and junco tool takes its AbortSignal third; definitions add a trailing context.
    tool.execute = (...args: Parameters<typeof execute>) => {
      if (this.#closing !== undefined) {
        return Promise.reject(new Error("ToolCollection is closed"));
      }
      const refusal = closed();
      if (refusal !== undefined) return Promise.reject(refusal);
      const signal = args[2];
      args[2] = signal ? AbortSignal.any([signal, abort]) : abort;
      const invocation = execute.apply(tool, args);
      for (const set of [this.#invocations, own]) {
        set.add(invocation);
        const settled = () => set.delete(invocation);
        invocation.then(settled, settled);
      }
      return invocation;
    };
  }

  static async create(
    cwd: string,
    options: ToolCollectionOptions,
  ): Promise<ToolCollection> {
    const policy = options?.policy;
    if (policy !== "LockPolicy" && policy !== "EmptyPolicy") {
      throw new TypeError('policy must be "LockPolicy" or "EmptyPolicy"');
    }
    const root = resolveToolPath(process.cwd(), cwd);
    // Rejects outside a seed: every file tool needs one.
    const lease = await acquireShellMux(root, {
      native: options.native,
      sandbox: options.sandbox,
      policy,
    });
    const { native } = lease;
    let operations: ShellMuxOperations | undefined;
    try {
      // This collection's own owner: no other collection over the same seed shares it.
      const mux = lease.mux.forkOwner();
      const store = new native.EditStore();
      operations = options.bash?.operations
        ? undefined
        : createShellMuxOperations({
            native,
            mux,
            principal: options.principal,
          });
      const build: BuildTools = (mux, operations) => [
        createReadTool(root, store, native, mux),
        createBashTool(root, { ...options.bash, operations }),
        createEditTool(root, store, native, mux),
        createReleaseTool(root, mux),
        createGrepTool(root, store, native, mux),
        createFindTool(root, native, mux),
        createAstGrepTool(root, native, mux),
        createAstEditTool(root, native, mux),
        createDiffTool(native),
      ];
      return new ToolCollection(
        mux,
        build,
        policy,
        lease,
        operations,
        options.bash?.operations,
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

  /**
   * One fresh policy owner's counterparts of {@link tools}, holding this collection until the
   * binding's `close()`. They share this collection's `EditStore`, mux session and invocation
   * fence; their bash commands run on owner-bound operations of their own, except that supplied
   * custom bash operations are shared as they are. Throws once final teardown has started.
   */
  bind(): ToolBinding {
    const mux = this.mux.forkOwner();
    const hold = this.lease();
    const stop = new AbortController();
    const signal = AbortSignal.any([this.#abort.signal, stop.signal]);
    const invocations = new Set<Promise<unknown>>();
    const operations = this.#customOperations
      ? undefined
      : createShellMuxOperations({ native: this.native, mux });
    let closing: Promise<void> | undefined;
    const bound = this.#build(mux, this.#customOperations ?? operations!);
    const tools = new Map<AgentTool<any>, AgentTool<any>>();
    bound.forEach((tool, index) => {
      this.#fence(
        tool,
        signal,
        () =>
          closing === undefined ? undefined : new Error("ToolBinding is closed"),
        invocations,
      );
      tools.set(this.tools[index]!, tool);
    });
    return {
      tools,
      close: () => {
        closing ??= (async () => {
          stop.abort(new Error("ToolBinding is closed"));
          await Promise.allSettled([...invocations]);
          try {
            await operations?.close();
          } finally {
            await hold.close();
          }
        })();
        return closing;
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
