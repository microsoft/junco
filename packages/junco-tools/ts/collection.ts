import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  BashOperations,
  BashToolOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  NativeMux,
  NativeResourceEvent,
  NativeResourceOptions,
} from "../native/index.js";
import { AstEditTool, AstGrepTool } from "./ast.js";
import { BashTool } from "./bash.js";
import { DiffTool } from "./diff.js";
import { EditTool } from "./edit.js";
import { FindTool } from "./find.js";
import { CodeGraphTool } from "./graph.js";
import { GrepTool } from "./grep.js";
import type { JuncoMemory } from "./memory.js";
import type { NativeModule } from "./native.js";
import { ShellMuxOperations } from "./operations.js";
import type { Policy } from "./policy.js";
import {
  captureRecorder,
  hasProfileOwner,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import { ReadTool } from "./read.js";
import { ReleaseTool } from "./release.js";
import { ShellMuxLease } from "./shell-mux.js";
import { resolveToolPath, trackPromise } from "./tool-support.js";

export interface ToolCollectionOptions {
  bash?: BashToolOptions;
  /** Caller-owned optional memory; collection teardown never closes it. */
  memory?: JuncoMemory;
  /** The addon to open this collection's mux with; loaded on demand when omitted. */
  native?: NativeModule;
  /** Routing mode of this collection's mux (default "shared"). */
  sandbox?: "shared" | "always";
  /** Authorization policy of this collection's mux (default `LockPolicy`). */
  policy?: Policy;
  /**
   * Resource limits and monitoring of every bash command and persistent process on this
   * collection's mux; file tools spawn no pipelines. See `ShellMuxLease.create`.
   */
  resources?: NativeResourceOptions;
  /** Receives each resource monitor event; see `ShellMuxLease.create`. */
  onResourceEvent?: (event: NativeResourceEvent) => void;
  /** Display/ordering label for the default bash operations; never a policy identity. */
  principal?: string;
  /**
   * This collection's view: every tool records its calls there (or in the invocation's, see
   * `runWithRecorder`), and the mux its resource events, enabling monitoring (see
   * `ShellMuxLease.create`).
   */
  recorder?: ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  /**
   * Tools connected over the created collection once its native tools exist (e.g. MCP servers on
   * its mux). Every owner shares them as they are: no owner-bound counterparts, no collection
   * fence. A rejection closes the collection. Its `close()` runs first when the creator closes
   * the collection, so it may hold a `lease()`.
   */
  extend?: (collection: ToolCollection) => Promise<{
    readonly tools: readonly AgentTool[];
    close(): Promise<void>;
  }>;
  /** Agents over this collection deactivate its tools they never called once they have settled ten runs (TE tool pruning); see `JuncoAgent`. */
  tool_pruning?: boolean;
}

/**
 * One owner's view of a collection: each of its tools mapped, by identity, to a counterpart over
 * the same `EditStore` and mux session whose every call acts as this binding's own policy owner.
 * `close()` (idempotent) aborts and drains only this binding's invocations and bash commands, then
 * drops its hold on the collection. Neither clears an ownership Marsh already committed.
 */
export interface ToolBinding {
  /** Policy owner id of this binding's calls and commands (`NativeResourceEvent.owner`). */
  readonly owner: string;
  readonly tools: ReadonlyMap<AgentTool, AgentTool>;
  /** One shell command as this owner on the collection's mux (Pi `BashOperations.exec`): merged stdout/stderr through `onData`, `timeout` in seconds, `env` replaces the environment; its pipelines record in this binding's recorder. Rejects once closed. */
  readonly exec: BashOperations["exec"];
  close(): Promise<void>;
}

/** A collection's tool set over `mux`, with `operations` backing its bash tool. */
type BuildTools = (
  mux: NativeMux,
  operations: NonNullable<BashToolOptions["operations"]>,
  recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | (() =>
        | ProfileRecorder<
            "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
          >
        | undefined)
    | undefined,
) => AgentTool[];

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
 * `tools` act as this collection's own policy owner, distinct from every other collection's;
 * {@link bind} gives each further owner (an agent) its own counterparts. `mux` is the session
 * itself, as borrowers (MCP servers, custom operations) use it: each of its calls acts as its
 * own fresh shell unless the borrower forks an owner.
 *
 * The returned `tools` come from the same `create` methods exported standalone and
 * are directly usable as a bare Agent's tools, SDK `customTools`, or with
 * `pi.registerTool`. `cwd` must lie inside a btrfs seed.
 *
 * Lifetime is reference-counted: the creator holds one hold, released by `close()`; each
 * borrower takes another with `lease()` or `bind()` and releases it with the returned handle's
 * `close()`, never the collection's. The final release aborts and joins this collection's
 * invocations and default bash commands, then closes its mux. Tools added by
 * `ToolCollectionOptions.extend` are shared by every owner and closed by the creator's
 * `close()` before its hold is released.
 */
export class ToolCollection {
  readonly tools: AgentTool[];
  readonly policy: Policy;
  readonly mux: NativeMux;
  readonly native: NativeModule;
  /** Whether agents over this collection prune its tools they never call; see {@link ToolCollectionOptions.tool_pruning}. */
  readonly tool_pruning: boolean;
  readonly #lease: ShellMuxLease;
  readonly #operations: ShellMuxOperations | undefined;
  readonly #build: BuildTools;
  /** Caller-supplied bash operations every owner shares, or `undefined` for owner-bound ones. */
  readonly #customOperations:
    | NonNullable<BashToolOptions["operations"]>
    | undefined;
  readonly #abort = new AbortController();
  readonly #invocations = new Set<Promise<unknown>>();
  #holders = 1;
  #creatorRelease: Promise<void> | undefined;
  /** The final teardown, once started; fences execution and further leases. */
  #closing: Promise<void> | undefined;
  /** What `ToolCollectionOptions.extend` connected; closed before the creator's release. */
  #extension: { close(): Promise<void> } | undefined;
  readonly #recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;

  private constructor(
    mux: NativeMux,
    build: BuildTools,
    lease: ShellMuxLease,
    operations: ShellMuxOperations | undefined,
    customOperations: NonNullable<BashToolOptions["operations"]> | undefined,
    recorder:
      | ProfileRecorder<
          "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
        >
      | undefined,
    tool_pruning: boolean,
  ) {
    this.policy = lease.policy;
    this.mux = lease.mux;
    this.native = lease.native;
    this.#lease = lease;
    this.#operations = operations;
    this.#build = build;
    this.#customOperations = customOperations;
    this.tool_pruning = tool_pruning;
    this.#recorder = recorder;
    const bashOperations = customOperations ?? operations;
    if (bashOperations === undefined)
      throw new Error("ToolCollection: bash operations missing");
    const tools = build(mux, bashOperations, recorder);
    for (const tool of tools) {
      this.#fence(
        tool,
        this.#abort.signal,
        () => undefined,
        new Set(),
        recorder,
      );
    }
    this.tools = tools;
  }

  /** This collection's view, which its own tools and the default {@link bind} record in. */
  get recorder():
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined {
    return this.#recorder;
  }

  /**
   * Routes `tool`'s executions through this collection's fence: refused once teardown began or
   * `closed()` reports an error, aborted by `abort`, and tracked in `own` and the collection.
   * Admitted calls of a tool not accounting its own are recorded as `custom` in `recorder`.
   */
  #fence(
    tool: AgentTool,
    abort: AbortSignal,
    closed: () => Error | undefined,
    own: Set<Promise<unknown>>,
    recorder:
      | ProfileRecorder<
          "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
        >
      | (() =>
          | ProfileRecorder<
              "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
            >
          | undefined)
      | undefined,
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
      const profile = hasProfileOwner(tool)
        ? undefined
        : captureRecorder(recorder);
      const invocation =
        profile === undefined
          ? execute.apply(tool, args)
          : profileToolCall(
              profile,
              {
                resource: "operations",
                category: "custom",
                tool: tool.name,
                operation: "execute",
              },
              args[2],
              () => execute.apply(tool, args),
            );
      trackPromise(own, invocation);
      return trackPromise(this.#invocations, invocation);
    };
  }

  static async create(
    cwd: string,
    options: ToolCollectionOptions = {},
  ): Promise<ToolCollection> {
    const root = resolveToolPath(process.cwd(), cwd);
    const { recorder } = options;
    // Rejects outside a seed: every file tool needs one.
    const lease = await ShellMuxLease.create(root, {
      native: options.native,
      sandbox: options.sandbox,
      policy: options.policy,
      resources: options.resources,
      onResourceEvent: options.onResourceEvent,
      recorder,
    });
    const { native } = lease;
    let operations: ShellMuxOperations | undefined;
    let collection: ToolCollection;
    try {
      // This collection's own owner: no other collection over the same seed shares it.
      const mux = lease.mux.forkOwner();
      if (recorder !== undefined && mux.owner !== undefined)
        lease.registerRecorderOwner(mux.owner, () => recorder);
      const store = new native.EditStore();
      operations = options.bash?.operations
        ? undefined
        : new ShellMuxOperations({
            native,
            mux,
            principal: options.principal,
            recorder,
          });
      const build: BuildTools = (mux, operations, recorder) => [
        ReadTool.create(root, store, native, mux, recorder),
        BashTool.create(root, { ...options.bash, operations }, recorder),
        EditTool.create(root, store, native, mux, recorder),
        ReleaseTool.create(root, mux, recorder),
        GrepTool.create(root, store, native, mux, recorder),
        FindTool.create(root, native, mux, recorder),
        AstGrepTool.create(root, native, mux, recorder),
        AstEditTool.create(root, native, mux, recorder),
        DiffTool.create(native, recorder),
        CodeGraphTool.create(root, native, mux, recorder),
        ...(options.memory?.tools(recorder) ?? []),
      ];
      collection = new ToolCollection(
        mux,
        build,
        lease,
        operations,
        options.bash?.operations,
        recorder,
        options.tool_pruning === true,
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
    if (options.extend === undefined) return collection;
    try {
      const extension = await options.extend(collection);
      collection.tools.push(...extension.tools);
      collection.#extension = extension;
      return collection;
    } catch (error) {
      try {
        await collection.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "ToolCollection: extension failed and closing failed",
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
   *
   * Their calls, and this owner's resource events, record in `recorder` (a getter is resolved
   * per call, and per pipeline at its first event), by default this collection's view.
   */
  bind(
    recorder:
      | ProfileRecorder<
          "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
        >
      | (() =>
          | ProfileRecorder<
              "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
            >
          | undefined)
      | undefined = this.#recorder,
  ): ToolBinding {
    const mux = this.mux.forkOwner();
    const owner = mux.owner;
    if (owner === undefined)
      throw new Error("ToolCollection.bind: the forked mux has no owner");
    const hold = this.lease();
    if (recorder !== undefined) {
      this.#lease.registerRecorderOwner(
        owner,
        typeof recorder === "function" ? recorder : () => recorder,
      );
    }
    const stop = new AbortController();
    const signal = AbortSignal.any([this.#abort.signal, stop.signal]);
    const invocations = new Set<Promise<unknown>>();
    const operations = this.#customOperations
      ? undefined
      : new ShellMuxOperations({ native: this.native, mux, recorder });
    let closing: Promise<void> | undefined;
    const bashOperations = this.#customOperations ?? operations;
    if (bashOperations === undefined)
      throw new Error("ToolCollection.bind: bash operations missing");
    const bound = this.#build(mux, bashOperations, recorder);
    const tools = new Map<AgentTool, AgentTool>();
    bound.forEach((tool, index) => {
      this.#fence(
        tool,
        signal,
        () =>
          closing === undefined
            ? undefined
            : new Error("ToolBinding is closed"),
        invocations,
        recorder,
      );
      tools.set(this.tools[index], tool);
    });
    return {
      owner,
      tools,
      exec: (command, cwd, options) =>
        bashOperations.exec(command, cwd, options),
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
    this.#creatorRelease ??=
      this.#extension === undefined
        ? this.#release()
        : this.#extension.close().finally(() => this.#release());
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
