import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DataflowGraph,
  type DataflowRunOptions,
  type DataflowScheduler,
  type DataflowTracer,
  type Message,
  type NodeIdType,
  type NodeSpec,
  type Width,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import { JuncoAgent, JuncoAgentError } from "junco-agent";
import { PiScheduler } from "junco-scheduler/agent";
import {
  issueLog,
  ToolCollection,
  type ToolCollectionOptions,
} from "junco-tools";
import { settleAll } from "./agent-operations.js";
import type { Agentic, AgenticInput, AgenticNode } from "./agentic.js";
import { Deterministic } from "./deterministic.js";
import type { MockAgent } from "./mock-agent.js";
import {
  checkPolicy,
  type NodeRegistration,
  nodePolicies,
  registeredNodeContexts,
} from "./node-policy.js";

/**
 * Internal entrypoint of an agency scheduler's abort and close callbacks: abort or close this
 * graph's members, except its already-aborting or -closing scheduler. Not exported from the package
 * root.
 */
export const cascadeMembers: unique symbol = Symbol(
  "JuncoGraph.cascadeMembers",
);

/** One recursive abort or close operation, recorded on every graph it visited. */
type Cascade = {
  readonly promise: Promise<void>;
  /** The scheduler whose own lifecycle callback started this cascade. */
  readonly excluded: PiScheduler<never, never> | undefined;
};

/** A prompt agent or coroutine a cascade operates on directly. */
type Resource<N, T> = JuncoAgent | MockAgent | Deterministic<N, T>;

type Kind = "abort" | "close";

const closedGraph = (): JuncoAgentError =>
  new JuncoAgentError("closed", "Graph is closed");

/** One hold on a collection, released once. */
type Hold = { close(): Promise<void> };

/**
 * A dataflow graph of {@link Agentic} node states that owns its members' lifecycle.
 *
 * Registration, scheduling, inspection and results are the native {@link DataflowGraph}'s. On top,
 * the graph keeps an abort signal that every `step`/`run` observes automatically, and recursive
 * {@link abort}/{@link close} cascades over its members: nested graphs, their `PiScheduler`s,
 * prompt agents and deterministic coroutines. Cancellation inside a running body stays cooperative.
 *
 * The graph has a `policy` and may borrow a `collection`, holding its own lease from construction
 * until close. A close first settles every member's close, then releases the visited graphs'
 * leases and owned creator holds.
 */
export class JuncoGraph<
  N = AgenticInput,
  T = AssistantMessage,
  EH = unknown,
  Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>,
> extends DataflowGraph<Agentic<N, T>, N, T, EH, Q> {
  /** Graphs inside the synchronous dispatch of an abort or close cascade: their scheduler callbacks no-op. */
  static readonly #dispatch: Record<Kind, ReadonlySet<object> | undefined> = {
    abort: undefined,
    close: undefined,
  };

  #controller = new AbortController();
  /** Default run options, replaced with the controller. */
  #options: DataflowRunOptions = { signal: this.#controller.signal };
  #abort: Cascade | undefined;
  /** Terminal once set, even if it failed. */
  #close: Cascade | undefined;
  /** A root `close()` joining a close its own scheduler started. */
  #rootClose: Promise<void> | undefined;
  #collection: ToolCollection | undefined;
  #lease: Hold | undefined;
  /** The creator hold this graph owns, when {@link create} built it. */
  #owned: Hold | undefined;

  /** The execution observer every `run()`/`step()` of this graph reports to. */
  declare readonly tracer: DataflowTracer;
  /** Authorization policy of this graph; equals `collection.policy` when one is bound. */
  readonly policy: ToolCollectionOptions["policy"];

  /**
   * @param tracer Required execution observer; `createTracer()` returns the shared default.
   * @param policy Required authorization policy of this graph.
   * @param collection Borrowed; the graph holds its own lease until close and never closes it.
   * @throws {TypeError} when `tracer` is missing, `policy` is missing or unknown, or `collection`
   *   has another policy.
   */
  constructor(
    scheduler: Q,
    window: Width,
    threads: Width,
    tracer: DataflowTracer,
    policy: ToolCollectionOptions["policy"],
    collection?: ToolCollection,
  ) {
    if (tracer == null) {
      throw new TypeError("JuncoGraph requires a tracer");
    }
    checkPolicy(policy, collection);
    super(scheduler, window, threads, tracer);
    this.policy = policy;
    this.#collection = collection;
    this.#lease = collection?.lease();
  }

  /**
   * Open one collection under `options`, then build a graph whose members all use it. `build`
   * receives the collection borrowed: pass it to every agent factory, scheduler, coroutine and
   * child-graph constructor, but never close it; members take their own leases. Every real agent
   * and scheduler of the returned graphs must use this collection, and the root its policy; the
   * root is bound to it if unbound and owns the creator hold, released by its close.
   *
   * A thrown `build` releases the creator hold. A rejected graph is closed, then the hold
   * released; cleanup failures aggregate with the original.
   *
   * @throws {TypeError} for an invalid policy or a member bound to another collection or policy.
   */
  static async create<N, T, EH, Q extends DataflowScheduler<N, T>>(
    cwd: string,
    options: ToolCollectionOptions,
    build: (
      collection: ToolCollection,
    ) => JuncoGraph<N, T, EH, Q> | Promise<JuncoGraph<N, T, EH, Q>>,
  ): Promise<JuncoGraph<N, T, EH, Q>> {
    const collection = await ToolCollection.create(cwd, options);
    const failures: unknown[] = [];
    let graph: JuncoGraph<N, T, EH, Q> | undefined;
    try {
      graph = await build(collection);
      graph.#adopt(collection);
      return graph;
    } catch (error) {
      failures.push(error);
    }
    try {
      await graph?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await collection.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Graph construction failed");
  }

  /** The borrowed collection this graph holds a lease on, if any. */
  get collection(): ToolCollection | undefined {
    return this.#collection;
  }

  /** Aborted by {@link abort} (then replaced once that settles) and, terminally, by {@link close}. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The process-wide complaint history every agent and graph shares. */
  get issueLog(): typeof issueLog {
    return issueLog;
  }

  /**
   * Register a node as natively, recording for that registration this graph's tracer, its
   * outgoing routes and topology (what `send` and `info` reach) and the spec's receiver contract.
   *
   * @throws {TypeError} when a real agent's, coroutine's or child graph's policy is not the spec's.
   */
  override addNode(spec: AgenticNode<N, T>): NodeIdType {
    checkPolicy(spec.policy, undefined);
    const state = spec.state;
    if (
      (state instanceof JuncoAgent ||
        state instanceof Deterministic ||
        state instanceof JuncoGraph) &&
      state.policy !== spec.policy
    )
      throw new TypeError("Node policy does not match its state");
    const id = super.addNode(spec);
    const current = (): AbortSignal => this.signal;
    const { contract } = spec;
    registeredNodeContexts.set(this.getNode(id)!, {
      tracer: this.tracer,
      get signal() {
        return current();
      },
      send: (message) => {
        this.signal.throwIfAborted();
        this.emit(id, message as Message<N>);
      },
      info: () => this.#nodeInfo(id),
      ...(contract === undefined ? {} : { contract }),
    });
    return id;
  }

  /**
   * Node `id`'s parent and child routes, one entry per actual edge, each with the contract its
   * receiving node in this graph declares for it. Fails rather than omit or invent a contract.
   */
  #nodeInfo(id: NodeIdType): ReturnType<NodeRegistration["info"]> {
    this.signal.throwIfAborted();
    const parents: ReturnType<NodeRegistration["info"]>["parents"][number][] =
      [];
    const children: typeof parents = [];
    // ponytail: info scans graph links; add an adjacency index only if large graphs make this hot.
    this.forEachLink((from, to, edge) => {
      if (from !== id && to !== id) return;
      const receiver = registeredNodeContexts.get(this.getNode(to)!)?.contract;
      if (receiver === undefined)
        throw new JuncoAgentError(
          "invalid_state",
          `No contract for edge "${edge.id}" at node "${to}"`,
        );
      const contract: unknown = receiver(edge.id);
      const expect =
        typeof contract === "object" &&
        contract !== null &&
        "expect" in contract
          ? contract.expect
          : undefined;
      if (
        typeof expect !== "string" ||
        expect.trim() === "" ||
        /[\r\n\u2028\u2029]/u.test(expect)
      )
        throw new JuncoAgentError(
          "invalid_state",
          `Invalid contract for edge "${edge.id}" at node "${to}"`,
        );
      const kind = E.isLeft(edge.transport) ? "message" : "value";
      if (to === id) parents.push({ id: from, edgeId: edge.id, kind, expect });
      if (from === id) children.push({ id: to, edgeId: edge.id, kind, expect });
    });
    this.signal.throwIfAborted();
    return { parents, children };
  }

  /**
   * Validate {@link create}'s returned graph against `collection`, then bind it and take the
   * creator hold.
   */
  #adopt(collection: ToolCollection): void {
    if (this.#close !== undefined) throw closedGraph();
    if (this.policy !== collection.policy)
      throw new TypeError(
        "Collection policy does not match the selected policy",
      );
    const seen = new Set<object>();
    const stack: unknown[] = [this];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member instanceof JuncoGraph) {
        if (seen.has(member)) continue;
        seen.add(member);
        stack.push(member.scheduler);
        member.forEachNode((_, node) => stack.push(node.state));
      }
      if (
        member instanceof JuncoAgent
          ? member.collection !== collection ||
            member.policy !== collection.policy
          : (member instanceof JuncoGraph || member instanceof Deterministic) &&
            member.collection !== undefined &&
            member.collection !== collection
      )
        throw new TypeError("Graph member does not use the graph's collection");
    }
    if (this.#collection === undefined) {
      this.#lease = collection.lease();
      this.#collection = collection;
    }
    this.#owned = collection;
  }

  /**
   * One window, observing {@link signal} and any caller `signal`. Caller cancellation affects only
   * this invocation.
   */
  override step(
    options?: DataflowRunOptions,
  ): Promise<ReadonlyMap<NodeIdType, T>> {
    return super.step(this.#runOptions(options));
  }

  /** Windows until quiescent, observing {@link signal} and any caller `signal`. */
  override run(
    options?: DataflowRunOptions,
  ): Promise<ReadonlyMap<NodeIdType, T>> {
    return super.run(this.#runOptions(options));
  }

  /**
   * Abort every member, recursively, with one `reason`: graph signals and coroutines receive it,
   * agents and schedulers their native `abort()`. Settles when every member's abort settles, then
   * gives this graph a fresh signal. Joins an abort already in progress.
   *
   * @throws {JuncoAgentError} `closed` once {@link close} has started.
   */
  abort(
    reason: unknown = new DOMException("Graph aborted", "AbortError"),
  ): Promise<void> {
    if (this.#close !== undefined) return Promise.reject(closedGraph());
    return this.#abortJoin() ?? this.#cascade("abort", reason, undefined);
  }

  /**
   * Close this graph and every member, recursively and terminally: agents, schedulers and coroutines
   * through their `Symbol.asyncDispose`, so a subclass's own cleanup is joined. Repeated calls join
   * the same close, including its failure. Results stay readable; new drives reject.
   */
  close(): Promise<void> {
    return this.#closeJoin() ?? this.#cascade("close", undefined, undefined);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** Abort or close members except this graph's scheduler, which is already aborting or closing. */
  [cascadeMembers](kind: Kind): Promise<void> | undefined {
    if (JuncoGraph.#dispatch[kind]?.has(this) === true) return undefined;
    if (kind === "close")
      return (
        this.#close?.promise ??
        this.#cascade("close", undefined, this.#piScheduler())
      );
    if (this.#close !== undefined) return Promise.reject(closedGraph());
    return (
      this.#abort?.promise ??
      this.#cascade(
        "abort",
        new DOMException("Graph aborted", "AbortError"),
        this.#piScheduler(),
      )
    );
  }

  #piScheduler(): PiScheduler<never, never> | undefined {
    const scheduler: unknown = this.scheduler;
    return scheduler instanceof PiScheduler ? scheduler : undefined;
  }

  #runOptions(options: DataflowRunOptions | undefined): DataflowRunOptions {
    const own = this.#controller.signal;
    const caller = options?.signal;
    if (caller === undefined || caller === own) return this.#options;
    return { signal: AbortSignal.any([own, caller]) };
  }

  #replaceController(reason?: unknown): void {
    const controller = new AbortController();
    if (reason !== undefined) controller.abort(reason);
    this.#controller = controller;
    this.#options = { signal: controller.signal };
  }

  /** How a caller joins this graph's abort in progress, if any. */
  #abortJoin(): Promise<void> | undefined {
    const current = this.#abort;
    if (current === undefined) return undefined;
    const excluded = current.excluded;
    if (excluded === undefined) return current.promise;
    // A callback-origin abort: join its members and request the scheduler too.
    return settleAll<() => unknown>(
      [() => current.promise, () => excluded.abort()],
      (request) => request(),
      "Graph abort failed",
    );
  }

  /** How a caller joins this graph's close, if one has started. */
  #closeJoin(): Promise<void> | undefined {
    const current = this.#close;
    if (current === undefined) return undefined;
    const excluded = current.excluded;
    if (excluded === undefined) return current.promise;
    // One microtask later: a callback-origin close starts before the scheduler caches its own close.
    this.#rootClose ??= Promise.resolve().then(() =>
      excluded[Symbol.asyncDispose](),
    );
    return this.#rootClose;
  }

  /**
   * Snapshot membership, record the cascade on every newly visited graph, start every resource
   * operation synchronously (each Pi ancestor before its descendants), then signal the visited
   * graphs. `excluded` is the scheduler whose callback started this cascade.
   */
  #cascade(
    kind: Kind,
    reason: unknown,
    excluded: PiScheduler<never, never> | undefined,
  ): Promise<void> {
    const graphs: JuncoGraph<N, T, unknown, DataflowScheduler<N, T>>[] = [];
    const requests: (() => unknown)[] = [];
    const seenGraphs = new Set<object>();
    const seenResources = new Set<object>(
      excluded === undefined ? [] : [excluded],
    );
    const joined = new Set<Promise<void>>();
    const resource = (member: Resource<N, T>): void => {
      if (seenResources.has(member)) return;
      seenResources.add(member);
      if (kind === "close") {
        requests.push(() => member[Symbol.asyncDispose]());
      } else if (member instanceof Deterministic) {
        requests.push(() => member.abort(reason));
      } else if (member.status !== "closed") {
        requests.push(() => member.abort());
      }
    };
    const stack: JuncoGraph<N, T, unknown, DataflowScheduler<N, T>>[] = [this];
    while (stack.length > 0) {
      const graph = stack.pop()!;
      if (seenGraphs.has(graph)) continue;
      seenGraphs.add(graph);
      if (graph !== this) {
        if (kind === "abort" && graph.#close !== undefined) continue;
        const join = kind === "abort" ? graph.#abortJoin() : graph.#closeJoin();
        if (join !== undefined) {
          if (!joined.has(join)) {
            joined.add(join);
            requests.push(() => join);
          }
          continue;
        }
      }
      graphs.push(graph);
      const scheduler = graph.#piScheduler();
      if (scheduler !== undefined) resource(scheduler);
      const children: JuncoGraph<N, T, unknown, DataflowScheduler<N, T>>[] = [];
      graph.forEachNode((_, node) => {
        const state = node.state;
        // A failed task's report already carries this state's settled teardown.
        if (
          kind === "close" &&
          nodePolicies.get(node.step)?.closedTaskState === state
        )
          return;
        if (state instanceof JuncoGraph) children.push(state);
        else resource(state);
      });
      for (let index = children.length - 1; index >= 0; index--)
        stack.push(children[index]!);
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const cascade: Cascade = { promise, excluded };
    for (const graph of graphs) {
      if (kind === "abort") graph.#abort = cascade;
      else graph.#close = cascade;
    }

    const previous = JuncoGraph.#dispatch[kind];
    JuncoGraph.#dispatch[kind] = new Set(graphs);
    let settled: Promise<void>;
    try {
      settled = settleAll(
        requests,
        (request) => request(),
        kind === "abort" ? "Graph abort failed" : "Graph close failed",
      );
      if (kind === "abort") {
        for (const graph of graphs) graph.#controller.abort(reason);
      } else {
        const closed = new DOMException("Graph closed", "AbortError");
        for (const graph of graphs) {
          if (graph.#controller.signal.aborted)
            graph.#replaceController(closed);
          else graph.#controller.abort(closed);
        }
      }
    } finally {
      JuncoGraph.#dispatch[kind] = previous;
    }
    if (kind === "close") {
      // Second phase, after every member settled: release the visited graphs' collection holds.
      const members = settled;
      settled = (async () => {
        const failures: unknown[] = [];
        await members.catch((error: AggregateError) =>
          failures.push(...error.errors),
        );
        const holds = new Set(
          graphs
            .flatMap((graph) => [graph.#lease, graph.#owned])
            .filter((hold) => hold !== undefined),
        );
        await settleAll([...holds], (hold) => hold.close(), "").catch(
          (error: AggregateError) => failures.push(...error.errors),
        );
        if (failures.length > 0)
          throw new AggregateError(failures, "Graph close failed");
      })();
    }

    const finish = (): void => {
      if (kind !== "abort") return;
      for (const graph of graphs) {
        if (graph.#abort !== cascade) continue;
        graph.#abort = undefined;
        if (graph.#close === undefined) graph.#replaceController();
      }
    };
    settled.then(
      () => {
        finish();
        resolve();
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
    return promise;
  }
}
