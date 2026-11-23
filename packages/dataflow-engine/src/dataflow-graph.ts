/// <reference lib="es2024.promise" />
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { Graph } from "ngraph.graph";
import createGraph from "ngraph.graph";
import type { IDoc } from "prettier-printer";
import * as PP from "prettier-printer";
import { type Static, type TSchema, Type } from "typebox";
import type {
  DataflowRunTrace,
  DataflowStepTrace,
  DataflowTracer,
} from "./dataflow-tracer.js";
import { checkPayload, type Edge } from "./edges.js";
import { DataflowDefinitionError, DataflowNodeError } from "./errors.js";
import type { EdgeId } from "./identity.js";
import { NodeId } from "./identity.js";
import type { Lookup, Message, Node, NodeSpec, ParentView } from "./node.js";
import { snapshotView } from "./node.js";
import type { Pretty } from "./pretty.js";
import type { Queue } from "./queue.js";
import type {
  InputSchedule,
  NodeAvailability,
  NodeSchedule,
  Schedule,
} from "./scheduler.js";
import { satisfiedEdges } from "./trigger.js";
import type { ResourceKind } from "./units.js";
import {
  assertUsageAllowed,
  holdsUsageFailure,
  runWithUsageBudgets,
  type UsageBudget,
} from "./usage-limits.js";
import type { Width } from "./width.js";

/** Characters Mermaid would read as markup, entities, comments/directives, math or label ends. */
const MERMAID_SPECIAL = /[&#%$"<>\\`|\r\n]/g;

/** Encode `value` for a quoted Mermaid label using decimal entity codes (`#34;` for `"`, …). */
function escapeMermaidLabel(value: string): string {
  return value.replace(
    MERMAID_SPECIAL,
    (character) => `#${character.codePointAt(0)};`,
  );
}

/** The default availability hook: a node is available exactly when its trigger fires. */
const whenTriggered = (_view: unknown, triggered: boolean): boolean =>
  triggered;

/**
 * The per-node state the graph owns: allocated once by {@link DataflowGraph.addNode}, mutated in
 * place, never replaced.
 *
 * The `Edge` is the single source of truth for both transports — a message queue is mutated in place
 * and a value cell is replaced wholesale by {@link DataflowGraph.#recordReturn} — so this record
 * holds no copy of either. It holds only what an edge cannot answer: which edges point AT this node
 * (ngraph exposes no inbound-only accessor) and a reusable view over them.
 */
type NodeRuntime<N extends TSchema, T> = {
  /** Inbound edge id -> the edge itself. Pure topology; all transport state lives in the `Edge`. */
  readonly inbound: Map<EdgeId, Edge<N, T>>;
  /** Stable, non-destructive readiness view reading through to `inbound`'s edges. */
  readonly probe: ParentView<N, T>;
};

/**
 * A node's readiness view over its inbound edges. Every access reaches through to the live `Edge`,
 * so a queue mutated in place by `emit` and a value cell replaced by `#recordReturn` are both
 * visible immediately, with nothing to keep in sync.
 *
 * `messages` exposes an inbound message edge's live queue; `values` exposes only RESOLVED value
 * cells, which is what makes `values.has(id)` mean "this parent has returned".
 */
const probeOf = <N extends TSchema, T>(
  inbound: ReadonlyMap<EdgeId, Edge<N, T>>,
): ParentView<N, T> => ({
  messages: {
    get: (id) => {
      const edge = inbound.get(id);
      return edge !== undefined && E.isLeft(edge.transport)
        ? edge.transport.left
        : undefined;
    },
    has: (id) => {
      const edge = inbound.get(id);
      return edge !== undefined && E.isLeft(edge.transport);
    },
    *keys() {
      for (const [id, edge] of inbound) if (E.isLeft(edge.transport)) yield id;
    },
  },
  values: {
    get: (id) => {
      const edge = inbound.get(id);
      return edge !== undefined &&
        E.isRight(edge.transport) &&
        O.isSome(edge.transport.right)
        ? edge.transport.right.value
        : undefined;
    },
    has: (id) => {
      const edge = inbound.get(id);
      return (
        edge !== undefined &&
        E.isRight(edge.transport) &&
        O.isSome(edge.transport.right)
      );
    },
    *keys() {
      for (const [id, edge] of inbound) {
        if (E.isRight(edge.transport) && O.isSome(edge.transport.right))
          yield id;
      }
    },
  },
});

/** Shared empty key list for a view with no delivered batch. */
const NO_KEYS: readonly never[] = [];

/**
 * The view one node sees for one turn: the batch {@link DataflowGraph.#consume} just popped for it,
 * plus its resolved parent values.
 *
 * An absent batch answers every lookup empty and enumerates nothing, so a node whose plan read
 * `"none"` — or whose queues were empty — needs no batch object at all.
 */
const viewOf = <N extends TSchema, T>(
  batch: ReadonlyMap<EdgeId, readonly Static<N>[]> | undefined,
  values: Lookup<EdgeId, T>,
): ParentView<N, T> => ({
  messages: {
    get: (id) => batch?.get(id),
    has: (id) => batch?.has(id) ?? false,
    keys: () => batch?.keys() ?? NO_KEYS,
  },
  values,
});

/** Cancellation for one scoped evaluation, including planning and concrete execution. */
export type DataflowRunOptions = {
  /**
   * Stops the invocation between columns: checked before planning, before each column reads its
   * inputs and after each column drains. An aborted signal rejects with `signal.reason` without
   * starting a later column; node activations already running are always awaited, never abandoned.
   */
  readonly signal?: AbortSignal;
};

/** A policy's read-only view of node status/state, links, pending inputs, results and a change `version`. */
export type DataflowObservation<S, N extends TSchema, T> = {
  readonly nodes: ReadonlyMap<
    NodeId,
    Readonly<Pick<Node<S, N, T>, "id" | "status" | "description" | "state">>
  >;
  readonly links: readonly (readonly [
    from: NodeId,
    to: NodeId,
    id: EdgeId,
    kind: "message" | "value",
  ])[];
  readonly inputs: ReadonlyMap<NodeId, ParentView<N, T>>;
  readonly results: ReadonlyMap<NodeId, T>;
  readonly version: number;
};

/** Executes one planned `Schedule` inside `evaluate`. */
export type DataflowExecution<N extends TSchema, T> = (
  schedule: Schedule,
  options?: {
    readonly resolveInputs?: (
      entry: NodeSchedule,
      live: NodeAvailability<N, T>,
    ) => InputSchedule;
    readonly onColumn?: (selected: readonly NodeId[]) => void;
    /** Each selected node's own usage ledgers, added inside the ambient ones for its activation. */
    readonly usageBudgets?: ReadonlyMap<NodeId, readonly UsageBudget[]>;
    /** Raw observations from executed activations, in the resource's integer base unit. */
    readonly onMeasurement?: (
      id: NodeId,
      kind: ResourceKind,
      value: number,
    ) => void;
    /** Time each generator activation with a monotonic clock, reporting elapsed milliseconds. */
    readonly measureRuntime?: boolean;
  },
) => Promise<void>;

/** Native work topology and concrete lanes-by-turns executor; policy lives outside the graph. */
export class DataflowGraph<S, N extends TSchema, T, EH> implements Pretty {
  readonly #graph: Graph<Node<S, N, T>, Edge<N, T>>;
  /** Per-node runtime state, keyed by node id. */
  readonly #runtime = new Map<NodeId, NodeRuntime<N, T>>();
  /** Return value of every finished node, accumulated across runs. */
  readonly #results = new Map<NodeId, T>();
  #nextNodeIndex = 0;
  #evaluation: Promise<void> | undefined;
  #pending: Promise<void>[] = [];
  #version = 0;
  #observation: DataflowObservation<S, N, T> | undefined;

  /** Execution bounds and optional observer; no scheduler is bound to a graph. */
  constructor(
    readonly window: Width,
    readonly threads: Width,
    readonly tracer?: DataflowTracer,
  ) {
    this.#graph = createGraph<Node<S, N, T>, Edge<N, T>>({ multigraph: true });
  }

  /**
   * Register a node and return its id, so callers never have to invent one. Omitting `spec.id`
   * draws the next free auto id; supplying one that is already taken is a definition error
   * (ngraph's `addNode` silently overwrites node data).
   *
   * @throws {DataflowDefinitionError} on an explicit duplicate id.
   */
  addNode(spec: NodeSpec<S, N, T>): NodeId {
    let id: NodeId;
    if (spec.id === undefined) {
      id = NodeId.create(String(this.#nextNodeIndex++));
      while (this.#graph.getNode(id) !== undefined) {
        id = NodeId.create(String(this.#nextNodeIndex++));
      }
    } else {
      id = spec.id;
      if (this.#graph.getNode(id) !== undefined) {
        throw new DataflowDefinitionError(
          `Dataflow node id "${id}" is already registered`,
        );
      }
    }

    const inbound = new Map<EdgeId, Edge<N, T>>();
    this.#runtime.set(id, { inbound, probe: probeOf<N, T>(inbound) });

    const node: Node<S, N, T> = {
      id,
      state: spec.state,
      status: "ready",
      trigger: spec.trigger,
      step: spec.step,
      generator: undefined,
      is_available: spec.is_available ?? whenTriggered,
      ...(spec.description === undefined
        ? {}
        : { description: spec.description }),
      ...(spec.on_error === undefined ? {} : { on_error: spec.on_error }),
    };

    this.#graph.addNode(id, node);
    this.#version++;
    return id;
  }

  /**
   * Wire `edge` from `from` to `to`, returning `this` for chaining. An edge id must be unique
   * within `from`'s outbound set and within `to`'s inbound set — per node-side, not globally.
   *
   * @throws {DataflowDefinitionError} on a missing endpoint or a duplicate id.
   */
  addEdge(from: NodeId, to: NodeId, edge: Edge<N, T>): this {
    const missingId =
      this.#graph.getNode(from) === undefined
        ? from
        : this.#graph.getNode(to) === undefined
          ? to
          : undefined;
    if (missingId !== undefined) {
      throw new DataflowDefinitionError(
        `Dataflow edge references missing node: ${missingId}`,
      );
    }

    for (const link of this.#graph.getLinks(from) ?? []) {
      if (link.fromId === from && link.data.id === edge.id) {
        throw new DataflowDefinitionError(
          `Dataflow edge id "${edge.id}" is not unique in node ${from}'s outbound set`,
        );
      }
    }
    for (const link of this.#graph.getLinks(to) ?? []) {
      if (link.toId === to && link.data.id === edge.id) {
        throw new DataflowDefinitionError(
          `Dataflow edge id "${edge.id}" is not unique in node ${to}'s inbound set`,
        );
      }
    }

    this.#graph.addLink(from, to, edge);

    this.#runtimeOf(to).inbound.set(edge.id, edge);
    this.#version++;
    return this;
  }

  /** The node registered under `id`, or `undefined` if none. */
  getNode(id: NodeId): Node<S, N, T> | undefined {
    return this.#graph.getNode(id)?.data;
  }

  /** `id`'s runtime state; `addNode` registers one for every node. */
  #runtimeOf(id: NodeId): NodeRuntime<N, T> {
    const runtime = this.#runtime.get(id);
    if (runtime === undefined)
      throw new DataflowDefinitionError(
        `Dataflow node "${id}" has no runtime state`,
      );
    return runtime;
  }

  /** The value `id` returned, or `O.none` if it has not finished. */
  result(id: NodeId): O.Option<T> {
    return this.#results.has(id) ? O.some(this.#results.get(id) as T) : O.none;
  }

  results(): ReadonlyMap<NodeId, T> {
    return new Map(this.#results);
  }

  observe(): DataflowObservation<S, N, T> {
    if (this.#observation?.version === this.#version) return this.#observation;
    const nodes = new Map<
      NodeId,
      Readonly<Pick<Node<S, N, T>, "id" | "status" | "description" | "state">>
    >();
    const inputs = new Map<NodeId, ParentView<N, T>>();
    this.forEachNode((id, node) => {
      nodes.set(
        id,
        Object.freeze({
          id,
          status: node.status,
          state: node.state,
          ...(node.description === undefined
            ? {}
            : { description: node.description }),
        }),
      );
      inputs.set(id, snapshotView(this.#runtimeOf(id).probe));
    });
    const links: (readonly [NodeId, NodeId, EdgeId, "message" | "value"])[] =
      [];
    this.forEachLink((from, to, edge) => {
      links.push(
        Object.freeze([
          from,
          to,
          edge.id,
          E.isLeft(edge.transport) ? "message" : "value",
        ]),
      );
    });
    this.#observation = Object.freeze({
      nodes,
      inputs,
      links: Object.freeze(links),
      results: new Map(this.#results),
      version: this.#version,
    });
    return this.#observation;
  }

  /** Visit every registered node in graph iteration order. */
  forEachNode(callback: (id: NodeId, node: Node<S, N, T>) => void): void {
    this.#graph.forEachNode((graphNode) => {
      callback(graphNode.id as NodeId, graphNode.data);
    });
  }

  /** Visit every graph link with its endpoints. */
  forEachLink(
    callback: (from: NodeId, to: NodeId, edge: Edge<N, T>) => void,
  ): void {
    this.#graph.forEachLink((link) => {
      callback(link.fromId as NodeId, link.toId as NodeId, link.data);
    });
  }

  /**
   * Render the current graph topology as a Mermaid flowchart document. A node whose state is itself
   * a {@link DataflowGraph} renders as a `subgraph` holding that graph's current topology, and the
   * containing graph's edges attach to the subgraph boundary. An empty child graph, or one already
   * on the containment path, holds a single presentation-only marker so the group stays visible.
   */
  pretty(): IDoc {
    const document: IDoc[] = ["graph TD;"];
    const ancestry = new Set<object>([this]);
    let next = 0;
    const line = (depth: number, statement: string): void => {
      document.push(PP.lineBreak, `${"  ".repeat(depth)}${statement}`);
    };

    function appendGraph<GS, GN extends TSchema, GT, GEH>(
      graph: DataflowGraph<GS, GN, GT, GEH>,
      depth: number,
    ): boolean {
      const synthetic = new Map<NodeId, string>();
      graph.forEachNode((id, node) => {
        const key = `n${next++}`;
        synthetic.set(id, key);
        const label = escapeMermaidLabel(id);
        const child = node.state;
        if (!(child instanceof DataflowGraph)) {
          line(depth, `${key}["${label}"];`);
          return;
        }
        line(depth, `subgraph ${key}["${label}"]`);
        let marker: string | undefined = "(recursive reference)";
        if (!ancestry.has(child)) {
          ancestry.add(child);
          marker = appendGraph(child, depth + 1) ? undefined : "(empty graph)";
          ancestry.delete(child);
        }
        if (marker !== undefined) {
          line(depth + 1, `n${next++}["${escapeMermaidLabel(marker)}"];`);
        }
        line(depth, "end;");
      });
      graph.forEachLink((from, to, edge) => {
        const transport = E.isLeft(edge.transport) ? "message" : "value";
        const label = escapeMermaidLabel(`${edge.id} (${transport})`);
        line(
          depth,
          `${synthetic.get(from)} -->|"${label}"| ${synthetic.get(to)};`,
        );
      });
      return synthetic.size > 0;
    }

    return appendGraph(this, 0) ? document : "";
  }

  /**
   * Every node that could run now, with what the scheduler would see for it. Non-destructive: a
   * fresh snapshot of live state that reads no queue.
   */
  available(): ReadonlyMap<NodeId, NodeAvailability<N, T>> {
    return this.#available();
  }

  /**
   * Admit the next window's candidates. Non-destructive: the queues are untouched, so the scheduler
   * sees each node's inbound state live and decides for itself how much of it to read.
   *
   * The graph is the sole admission boundary: a `done` node is skipped, every other node's trigger
   * is evaluated once — validating every rule edge even when the hook will say no — and only then is
   * its availability hook told whether that trigger fired. Only admitted nodes reach a scheduler.
   *
   * Iteration order is ngraph node-insertion order, which keeps deterministic schedulers
   * deterministic.
   */
  #available(): Map<NodeId, NodeAvailability<N, T>> {
    const available = new Map<NodeId, NodeAvailability<N, T>>();
    this.#graph.forEachNode((graphNode) => {
      const node = graphNode.data;
      if (node.status === "done") return;
      const runtime = this.#runtimeOf(node.id);
      const { trigger } = node;
      const satisfied = satisfiedEdges(trigger, runtime.inbound, node.id);
      const triggered =
        trigger.kind === "all"
          ? satisfied.length === trigger.rule.length
          : satisfied.length > 0;
      if (!node.is_available(runtime.probe, triggered)) return;
      available.set(node.id, {
        view: runtime.probe,
        trigger,
        satisfied,
        status: node.status,
      });
    });
    return available;
  }

  /**
   * Pop what `inputs` asks for off `runtime`'s inbound queues, returning the delivered batch.
   *
   * A key is created only for an edge that actually yielded items — an absent key is what lets an
   * `any` node body detect which branch fired. A short queue yields what it has rather than
   * failing: the scheduler planned against a snapshot, and `splice` already clamps.
   */
  #consume(
    runtime: NodeRuntime<N, T>,
    inputs: InputSchedule,
  ): Map<EdgeId, Static<N>[]> | undefined {
    let batch: Map<EdgeId, Static<N>[]> | undefined;
    for (const [edgeId, count] of inputs) {
      if (count === "none") continue;
      const edge = runtime.inbound.get(edgeId);
      if (edge === undefined)
        throw new DataflowDefinitionError(
          `Dataflow schedule reads edge "${edgeId}", which is not an inbound edge`,
        );
      if (E.isRight(edge.transport)) continue; // value edges pop nothing
      const queue = edge.transport.left;
      const taken = queue.splice(0, count === "all" ? queue.length : count);
      if (taken.length === 0) continue;
      batch ??= new Map<EdgeId, Static<N>[]>();
      batch.set(edgeId, taken);
    }
    return batch;
  }

  protected get activeEvaluation(): Promise<void> | undefined {
    return this.#evaluation;
  }

  /** Single-flight lifetime scope encompassing external planning and all admitted work. */
  async evaluate<R>(
    operation: (
      execute: DataflowExecution<N, T>,
      signal?: AbortSignal,
    ) => R | Promise<R>,
    options?: DataflowRunOptions,
  ): Promise<R> {
    if (this.#evaluation !== undefined)
      throw new DataflowDefinitionError(
        "Dataflow execution is already in flight",
      );
    const gate = Promise.withResolvers<void>();
    this.#evaluation = gate.promise;
    let active = true;
    let executing = false;
    let running: Promise<void> | undefined;
    let observed: Promise<PromiseSettledResult<void>> | undefined;
    let trace: DataflowRunTrace<N, T> | undefined;
    const execute: DataflowExecution<N, T> = (schedule, executionOptions) => {
      if (!active)
        return Promise.reject(
          new DataflowDefinitionError(
            "Dataflow evaluation is no longer active",
          ),
        );
      if (executing)
        return Promise.reject(
          new DataflowDefinitionError(
            "Dataflow execution is already in flight",
          ),
        );
      executing = true;
      const work = this.#window(
        schedule,
        executionOptions,
        trace,
        options?.signal,
      );
      running = work;
      observed = work.then(
        () => {
          executing = false;
          running = undefined;
          return { status: "fulfilled", value: undefined };
        },
        (reason) => {
          executing = false;
          running = undefined;
          return { status: "rejected", reason };
        },
      );
      return work;
    };
    try {
      const { tracer } = this;
      if (tracer !== undefined)
        trace = this.#observe(() => tracer.startRun(this));
      options?.signal?.throwIfAborted();
      let outcome: { ok: true; value: R } | { ok: false; error: unknown };
      try {
        outcome = {
          ok: true,
          value: await operation(execute, options?.signal),
        };
      } catch (error) {
        outcome = { ok: false, error };
      }
      active = false;
      const pending = running === undefined ? undefined : observed;
      const drained = await pending;
      if (!outcome.ok) {
        if (drained?.status === "rejected" && drained.reason !== outcome.error)
          throw new AggregateError(
            [outcome.error, drained.reason],
            "Graph evaluation and execution failed",
          );
        throw outcome.error;
      }
      if (drained?.status === "rejected") throw drained.reason;
      const run = trace;
      if (run !== undefined) this.#settle(() => run.end(this.#results));
      return outcome.value;
    } catch (error) {
      const run = trace;
      if (run !== undefined) this.#settle(() => run.fail(error));
      throw error;
    } finally {
      active = false;
      await Promise.all(this.#pending.splice(0));
      this.#evaluation = undefined;
      gate.resolve();
    }
  }

  /** Validate a concrete matrix, then drain its columns in order. */
  async #window(
    schedule: Schedule,
    options: Parameters<DataflowExecution<N, T>>[1],
    execution: DataflowRunTrace<N, T> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    signal?.throwIfAborted();
    const turns = this.#assertSchedule(schedule, this.#available());
    const onMeasurement = options?.onMeasurement;
    for (let w = 0; w < turns; w++) {
      signal?.throwIfAborted();
      const live = this.#available();
      const column: NodeSchedule[] = [];
      for (const lane of schedule) {
        const entry = lane[w];
        if (entry === undefined) continue;
        const availability = live.get(entry.id);
        if (availability === undefined) continue;
        const inputs =
          availability.status === "running"
            ? (options?.resolveInputs?.(entry, availability) ?? entry.inputs)
            : entry.inputs;
        column.push({ id: entry.id, inputs });
      }
      for (const { id, inputs } of column) this.#assertInputs(id, inputs);
      if (column.length === 0) continue;
      // `allSettled`, not `all`: a second lane's rejection can never surface as an unhandled
      // rejection, and the error thrown is deterministically the lowest-lane one.
      const settled = await Promise.allSettled(
        column.map((entry) => {
          const report =
            onMeasurement === undefined
              ? undefined
              : (kind: ResourceKind, value: number) =>
                  this.#observe(() => onMeasurement(entry.id, kind, value));
          return runWithUsageBudgets(
            options?.usageBudgets?.get(entry.id) ?? [],
            entry.id,
            () =>
              this.#runNode(
                entry,
                execution,
                signal,
                options?.measureRuntime ? report : undefined,
              ),
            report,
          );
        }),
      );
      options?.onColumn?.(Object.freeze(column.map((entry) => entry.id)));
      const failed = settled.find((outcome) => outcome.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      signal?.throwIfAborted();
    }
  }

  /**
   * Invoke one observer, isolating the computation from it: a synchronous
   * observer exception is reported and swallowed, so it can neither become a node error nor mask
   * one.
   */
  #observe<U>(callback: () => U): U | undefined {
    try {
      return callback();
    } catch (error) {
      console.warn("[dataflow-engine] observer callback failed", error);
      return undefined;
    }
  }

  /**
   * Invoke one tracer completion like {@link #observe}, additionally retaining a returned promise so
   * {@link evaluate} settles only after it does; a rejection is reported exactly like a throw.
   */
  #settle(callback: () => void | Promise<void>): void {
    const delivery = this.#observe(callback);
    if (delivery instanceof Promise)
      this.#pending.push(
        delivery.then(undefined, (error) => {
          console.warn(
            "[dataflow-engine] DataflowTracer callback failed",
            error,
          );
        }),
      );
  }

  /**
   * Enforce the concrete schedule contract and return the validated window height.
   *
   * @throws {DataflowDefinitionError} on too many lanes, an over-long lane, an unavailable id, an
   *   invalid read map (see {@link #assertInputs}), a duplicated id within one column, or a plan
   *   with no slots while work remains (a spin).
   */
  #assertSchedule(
    schedule: Schedule,
    available: ReadonlyMap<NodeId, NodeAvailability<N, T>>,
  ): number {
    if (Number.isFinite(this.threads) && schedule.length > this.threads) {
      throw new DataflowDefinitionError(
        `Dataflow schedule returned ${schedule.length} lanes, exceeding threads=${this.threads}`,
      );
    }

    let slots = 0;
    let turns = 0;
    for (const lane of schedule) {
      if (Number.isFinite(this.window) && lane.length > this.window) {
        throw new DataflowDefinitionError(
          `Dataflow schedule lane holds ${lane.length} turns, exceeding window=${this.window}`,
        );
      }
      for (const { id, inputs } of lane) {
        if (!available.has(id)) {
          throw new DataflowDefinitionError(
            `Dataflow schedule returned node "${id}", which is not available`,
          );
        }
        this.#assertInputs(id, inputs);
      }
      slots += lane.length;
      turns = Math.max(turns, lane.length);
    }

    for (let w = 0; w < turns; w++) {
      const seen = new Set<NodeId>();
      for (const lane of schedule) {
        const entry = lane[w];
        if (entry === undefined) continue;
        if (seen.has(entry.id)) {
          throw new DataflowDefinitionError(
            `Dataflow schedule runs node "${entry.id}" twice in one turn`,
          );
        }
        seen.add(entry.id);
      }
    }

    if (slots === 0 && available.size > 0) {
      throw new DataflowDefinitionError(
        "Dataflow schedule returned no work while nodes are available",
      );
    }
    return turns;
  }

  /**
   * @throws {DataflowDefinitionError} when `inputs` reads an edge that is not one of `id`'s inbound
   *   edges, or a numeric count that is not a positive integer.
   */
  #assertInputs(id: NodeId, inputs: InputSchedule): void {
    const inbound = this.#runtimeOf(id).inbound;
    for (const [edgeId, count] of inputs) {
      if (!inbound.has(edgeId)) {
        throw new DataflowDefinitionError(
          `Dataflow schedule reads edge "${edgeId}" on node "${id}", which is not one of its inbound edges`,
        );
      }
      if (
        typeof count === "number" &&
        (!Number.isInteger(count) || count < 1)
      ) {
        throw new DataflowDefinitionError(
          `Dataflow schedule reads ${count} messages from edge "${edgeId}" on node "${id}"; a message count must be a positive integer, "all" or "none"`,
        );
      }
    }
  }

  /**
   * Prime a ready node without consuming its planned inputs, or deliver a running node's planned
   * batch, then advance the generator exactly once. `execution`, when present, observes the
   * activation: `"prime"` with no view, `"resume"` with exactly the delivered view.
   *
   * A throw from the body itself (`step()` or `next()`) ends the node; a configured `on_error` then
   * runs once in this activation and its batch is routed instead of a result. Wiring, scheduling,
   * routing and usage-limit failures never reach the hook. A usage budget that already failed
   * refuses the activation before it starts, and fails it after the body returns, before routing.
   */
  async #runNode(
    { id, inputs }: NodeSchedule,
    execution: DataflowRunTrace<N, T> | undefined,
    signal: AbortSignal | undefined,
    reportRuntime: ((kind: ResourceKind, value: number) => void) | undefined,
  ): Promise<void> {
    const node = this.#graph.getNode(id)?.data;
    if (node === undefined)
      throw new DataflowDefinitionError(
        `Dataflow node "${id}" is not registered`,
      );
    const runtime = this.#runtimeOf(id);
    assertUsageAllowed();
    let activation: DataflowStepTrace<N, T> | undefined;
    let started: number | undefined;
    /** The current throw, if any, came from the node body. */
    let inBody = false;
    this.#version++;

    try {
      let step: IteratorResult<Message<N>[], T>;
      if (node.status === "ready") {
        if (execution !== undefined)
          activation = this.#observe(() =>
            execution.startNode(id, "prime", undefined),
          );
        inBody = true;
        if (reportRuntime !== undefined) started = performance.now();
        node.generator = node.step(); // method call, so a non-arrow body sees the node as `this`
        node.status = "running";
        step = await node.generator.next();
        assertUsageAllowed();
        inBody = false;
      } else {
        if (node.generator === undefined) {
          throw new DataflowDefinitionError(
            `Dataflow node "${id}" is running without a generator`,
          );
        }
        // Synchronous before this branch's first `await`, so concurrent lanes consume in lane order.
        const view = viewOf<N, T>(
          this.#consume(runtime, inputs),
          runtime.probe.values,
        );
        if (execution !== undefined)
          activation = this.#observe(() =>
            execution.startNode(id, "resume", view),
          );
        inBody = true;
        if (reportRuntime !== undefined) started = performance.now();
        step = await node.generator.next(view);
        assertUsageAllowed();
        inBody = false;
      }

      if (step.done === true) {
        node.status = "done";
        this.#recordReturn(node, step.value);
      } else {
        for (const message of step.value) this.emit(id, message);
      }
      const finished = activation;
      if (finished !== undefined) this.#settle(() => finished.end(step));
    } catch (cause) {
      node.status = "done";
      const failed = activation;
      if (failed !== undefined) this.#settle(() => failed.fail(cause));
      // A wiring violation raised while routing a yield is a graph bug, not a node error; an
      // exhausted usage budget is no failure to recover from.
      if (cause instanceof DataflowDefinitionError || holdsUsageFailure(cause))
        throw cause;
      if (!inBody || node.on_error === undefined)
        throw new DataflowNodeError<EH>(id, cause as EH);
      // Cancellation of a configured node is not a failure to recover from.
      if (signal?.aborted === true && cause === signal.reason) throw cause;
      let messages: readonly Message<N>[];
      try {
        messages = await node.on_error(cause, signal); // method call: the node is `this`
      } catch (error) {
        if (
          error instanceof DataflowDefinitionError ||
          holdsUsageFailure(error)
        )
          throw error;
        if (signal?.aborted === true && error === signal.reason) throw error;
        throw new DataflowNodeError<EH>(id, error as EH);
      }
      for (const message of messages) this.emit(id, message);
    } finally {
      this.#version++;
      if (started !== undefined)
        reportRuntime?.("runtime", Math.round(performance.now() - started));
    }
  }

  /**
   * Push `message.payload` onto the outbound message edge of `fromId` carrying `message.id`, then
   * report it to the edge's `probe`, if any.
   *
   * Only enqueues: it does not drive the graph, consume inputs, complete `fromId`, or resolve a
   * value edge. The next availability/read decision observes the queued payload.
   *
   * @throws {DataflowDefinitionError} when no such edge is wired, when it is a value edge, or when
   *   the payload fails the edge's schema; nothing is queued then.
   */
  emit(fromId: NodeId, message: Message<N>): void {
    const edge = this.messageEdge(fromId, message);
    edge.transport.left.push(message.payload);
    this.#version++;
    const probe = edge.probe;
    if (probe !== undefined) this.#observe(() => probe(message.payload));
  }

  /**
   * Validate sender-local routing and the destination edge's schema without modifying its
   * transport, returning the message edge.
   *
   * @throws {DataflowDefinitionError} when no such edge is wired, when it is a value edge, or when
   *   `message.payload` fails the edge's schema.
   */
  protected messageEdge(
    fromId: NodeId,
    message: Message<N>,
  ): Edge<N, T> & { transport: E.Left<Queue<Static<N>>> } {
    const edgeId = message.id;
    for (const link of this.#graph.getLinks(fromId) ?? []) {
      if (link.fromId !== fromId || link.data.id !== edgeId) continue;
      const edge = link.data;
      if (E.isRight(edge.transport)) {
        throw new DataflowDefinitionError(
          `Node ${fromId} emitted a message on value edge "${edgeId}"`,
        );
      }
      const { schema } = edge;
      if (!Type.IsSchema(schema))
        throw new DataflowDefinitionError(
          `Message edge "${edgeId}" has no schema`,
        );
      checkPayload(
        schema,
        message.payload,
        `Invalid payload for message edge "${edgeId}"`,
      );
      // Narrowed by the `isRight` rejection above.
      return edge as Edge<N, T> & { transport: E.Left<Queue<Static<N>>> };
    }
    throw new DataflowDefinitionError(
      `Node ${fromId} emitted on unwired edge "${edgeId}"`,
    );
  }

  /**
   * Record `nodeId`'s return value and fan it into every outbound value edge; a self-edge re-arms
   * it. Every outbound value edge's schema is checked first, so a rejected value publishes nothing.
   * Each delivery is then reported to that edge's `probe`, if any.
   *
   * @throws {DataflowDefinitionError} when the value fails an outbound value edge's schema.
   */
  #recordReturn(node: Node<S, N, T>, value: T): void {
    const nodeId = node.id;
    const links = this.#graph.getLinks(nodeId) ?? [];
    for (const link of links) {
      if (link.fromId !== nodeId || E.isLeft(link.data.transport)) continue;
      checkPayload(
        link.data.schema,
        value,
        `Invalid payload for value edge "${link.data.id}"`,
      );
    }
    this.#results.set(nodeId, value);
    for (const link of links) {
      if (link.fromId !== nodeId) continue;
      const edge = link.data;
      if (E.isLeft(edge.transport)) continue; // message edge
      edge.transport = E.right(O.some(value));
      if (link.toId === nodeId) this.#rearm(node);
      const probe = edge.probe;
      if (probe !== undefined) this.#observe(() => probe(value));
    }
  }

  /** A delivery on a node's own feedback edge after it returned starts another run of the node. */
  #rearm(node: Node<S, N, T>): void {
    if (node.status !== "done") return;
    node.status = "ready";
    node.generator = undefined;
  }
}
