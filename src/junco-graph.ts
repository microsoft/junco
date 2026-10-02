import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DataflowGraph, type DataflowRunOptions, type DataflowScheduler, type NodeIdType } from "dataflow-engine";
import { JuncoAgentError, type JuncoAgent } from "junco-agent";
import { PiScheduler } from "junco-scheduler/agent";
import type { Agentic, AgenticInput } from "./agentic.js";
import { settleAll } from "./agent-operations.js";
import { Deterministic } from "./deterministic.js";
import type { MockAgent } from "./mock-agent.js";

/**
 * Internal entrypoint of an agency scheduler's abort and close callbacks: abort or close this
 * graph's members, except its already-aborting or -closing scheduler. Not exported from the package
 * root.
 */
export const cascadeMembers: unique symbol = Symbol("JuncoGraph.cascadeMembers");

/** One recursive abort or close operation, recorded on every graph it visited. */
type Cascade = {
  readonly promise: Promise<void>;
  /** The scheduler whose own lifecycle callback started this cascade. */
  readonly excluded: PiScheduler<never, never> | undefined;
};

/** A prompt agent or coroutine a cascade operates on directly. */
type Resource<N, T> = JuncoAgent | MockAgent | Deterministic<N, T>;

type Kind = "abort" | "close";

const closedGraph = (): JuncoAgentError => new JuncoAgentError("closed", "Graph is closed");

/**
 * A dataflow graph of {@link Agentic} node states that owns its members' lifecycle.
 *
 * Registration, scheduling, inspection and results are the native {@link DataflowGraph}'s. On top,
 * the graph keeps an abort signal that every `step`/`run` observes automatically, and recursive
 * {@link abort}/{@link close} cascades over its members: nested graphs, their `PiScheduler`s,
 * prompt agents and deterministic coroutines. Cancellation inside a running body stays cooperative.
 */
export class JuncoGraph<
  N = AgenticInput,
  T = AssistantMessage,
  EH = unknown,
  Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>,
> extends DataflowGraph<Agentic<N, T>, N, T, EH, Q> {
  /** Graphs inside the synchronous dispatch of an abort or close cascade: their scheduler callbacks no-op. */
  static readonly #dispatch: Record<Kind, ReadonlySet<object> | undefined> = { abort: undefined, close: undefined };

  #controller = new AbortController();
  /** Default run options, replaced with the controller. */
  #options: DataflowRunOptions = { signal: this.#controller.signal };
  #abort: Cascade | undefined;
  /** Terminal once set, even if it failed. */
  #close: Cascade | undefined;
  /** A root `close()` joining a close its own scheduler started. */
  #rootClose: Promise<void> | undefined;

  /** Aborted by {@link abort} (then replaced once that settles) and, terminally, by {@link close}. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * One window, observing {@link signal} and any caller `signal`. Caller cancellation affects only
   * this invocation.
   */
  override step(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeIdType, T>> {
    return super.step(this.#runOptions(options));
  }

  /** Windows until quiescent, observing {@link signal} and any caller `signal`. */
  override run(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeIdType, T>> {
    return super.run(this.#runOptions(options));
  }

  /**
   * Abort every member, recursively, with one `reason`: graph signals and coroutines receive it,
   * agents and schedulers their native `abort()`. Settles when every member's abort settles, then
   * gives this graph a fresh signal. Joins an abort already in progress.
   *
   * @throws {JuncoAgentError} `closed` once {@link close} has started.
   */
  abort(reason: unknown = new DOMException("Graph aborted", "AbortError")): Promise<void> {
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
    if (kind === "close") return this.#close?.promise ?? this.#cascade("close", undefined, this.#piScheduler());
    if (this.#close !== undefined) return Promise.reject(closedGraph());
    return (
      this.#abort?.promise ??
      this.#cascade("abort", new DOMException("Graph aborted", "AbortError"), this.#piScheduler())
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
    return settleAll<() => unknown>([() => current.promise, () => excluded.abort()], (request) => request(), "Graph abort failed");
  }

  /** How a caller joins this graph's close, if one has started. */
  #closeJoin(): Promise<void> | undefined {
    const current = this.#close;
    if (current === undefined) return undefined;
    const excluded = current.excluded;
    if (excluded === undefined) return current.promise;
    // One microtask later: a callback-origin close starts before the scheduler caches its own close.
    this.#rootClose ??= Promise.resolve().then(() => excluded[Symbol.asyncDispose]());
    return this.#rootClose;
  }

  /**
   * Snapshot membership, record the cascade on every newly visited graph, start every resource
   * operation synchronously (each Pi ancestor before its descendants), then signal the visited
   * graphs. `excluded` is the scheduler whose callback started this cascade.
   */
  #cascade(kind: Kind, reason: unknown, excluded: PiScheduler<never, never> | undefined): Promise<void> {
    const graphs: JuncoGraph<N, T, unknown, DataflowScheduler<N, T>>[] = [];
    const requests: (() => unknown)[] = [];
    const seenGraphs = new Set<object>();
    const seenResources = new Set<object>(excluded === undefined ? [] : [excluded]);
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
        if (state instanceof JuncoGraph) children.push(state);
        else resource(state);
      });
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
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
      settled = settleAll(requests, (request) => request(), kind === "abort" ? "Graph abort failed" : "Graph close failed");
      if (kind === "abort") {
        for (const graph of graphs) graph.#controller.abort(reason);
      } else {
        const closed = new DOMException("Graph closed", "AbortError");
        for (const graph of graphs) {
          if (graph.#controller.signal.aborted) graph.#replaceController(closed);
          else graph.#controller.abort(closed);
        }
      }
    } finally {
      JuncoGraph.#dispatch[kind] = previous;
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
