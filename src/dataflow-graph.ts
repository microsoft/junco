import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { Graph } from "ngraph.graph";
import createGraph from "ngraph.graph";
import type { Edge } from "./edges.js";
import { DataflowDefinitionError, DataflowNodeError } from "./errors.js";
import type { EdgeId } from "./identity.js";
import { NodeId } from "./identity.js";
import type { Lookup, Message, Node, NodeSpec, ParentView } from "./node.js";
import type {
  DataflowScheduler,
  InputSchedule,
  NodeAvailability,
  NodeSchedule,
  Schedule,
} from "./scheduler.js";
import { evaluateTrigger, satisfiedEdges } from "./trigger.js";
import type { Width } from "./width.js";

/**
 * The per-node state the graph owns: allocated once by {@link DataflowGraph.addNode}, mutated in
 * place, never replaced.
 *
 * The `Edge` is the single source of truth for both transports — a message queue is mutated in place
 * and a value cell is replaced wholesale by {@link DataflowGraph.#recordReturn} — so this record
 * holds no copy of either. It holds only what an edge cannot answer: which edges point AT this node
 * (ngraph exposes no inbound-only accessor) and a reusable view over them.
 */
type NodeRuntime<N, T> = {
  /** Inbound edge id -> the edge itself. Pure topology; all transport state lives in the `Edge`. */
  readonly inbound: Map<EdgeId, Edge<N, T>>;
  /** Stable, non-destructive readiness view reading through to `inbound`'s edges. */
  readonly probe: ParentView<N, T>;
};

/**
 * A node's readiness view over its inbound edges. Every access reaches through to the live `Edge`,
 * so a queue mutated in place by `#route` and a value cell replaced by `#recordReturn` are both
 * visible immediately, with nothing to keep in sync.
 *
 * `messages` exposes an inbound message edge's live queue; `values` exposes only RESOLVED value
 * cells, which is what makes `values.has(id)` mean "this parent has returned".
 */
const probeOf = <N, T>(
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
const viewOf = <N, T>(
  batch: ReadonlyMap<EdgeId, readonly N[]> | undefined,
  values: Lookup<EdgeId, T>,
): ParentView<N, T> => ({
  messages: {
    get: (id) => batch?.get(id),
    has: (id) => batch?.has(id) ?? false,
    keys: () => batch?.keys() ?? NO_KEYS,
  },
  values,
});

/**
 * An async, generator-driven dataflow graph.
 *
 * Nodes are async generators the runtime resumes; edges carry either a FIFO message queue or a
 * write-once return cell; readiness is decided by a declarative `TriggerRule`; and which nodes run
 * each turn is delegated to `scheduler`, which plans `threads` lanes x `window` turns at a time.
 *
 * {@link run} is resumable: it returns when nothing is available, leaving node status, generators
 * and queues intact, so calling it again after adding nodes or edges continues the same graph.
 */
export class DataflowGraph<S, N, T, EH> {
  readonly #graph: Graph<Node<S, N, T>, Edge<N, T>>;
  /** Per-node runtime state, keyed by node id. */
  readonly #runtime = new Map<NodeId, NodeRuntime<N, T>>();
  /** Return value of every finished node, accumulated across runs. */
  readonly #results = new Map<NodeId, T>();
  #nextNodeIndex = 0;
  #inFlight = false;

  /**
   * @param scheduler Plans each window; `create` is invoked here, exactly once.
   * @param window Max turns one lane may hold per plan.
   * @param threads Max concurrent lanes per plan.
   */
  constructor(
    readonly scheduler: DataflowScheduler<N, T>,
    readonly window: Width,
    readonly threads: Width,
  ) {
    this.#graph = createGraph<Node<S, N, T>, Edge<N, T>>({ multigraph: true });
    this.scheduler.create(window, threads);
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
      id = NodeId(String(this.#nextNodeIndex++));
      while (this.#graph.getNode(id) !== undefined) {
        id = NodeId(String(this.#nextNodeIndex++));
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

    // The default hook closes over `node`; it only ever runs after this initializer completes, so
    // there is no TDZ hazard, and `inbound` is read lazily so edges wired after `addNode` count.
    const node: Node<S, N, T> = {
      id,
      state: spec.state,
      status: "ready",
      trigger: spec.trigger,
      step: spec.step,
      generator: undefined,
      is_available:
        spec.is_available ?? (() => evaluateTrigger(node.trigger, inbound, id)),
    };

    this.#graph.addNode(id, node);
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

    this.#runtime.get(to)!.inbound.set(edge.id, edge);
    return this;
  }

  /** The node registered under `id`, or `undefined` if none. */
  getNode(id: NodeId): Node<S, N, T> | undefined {
    return this.#graph.getNode(id)?.data;
  }

  /** The value `id` returned, or `O.none` if it has not finished. */
  result(id: NodeId): O.Option<T> {
    return this.#results.has(id) ? O.some(this.#results.get(id) as T) : O.none;
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
   * Plan the next window's candidates. Non-destructive: the queues are untouched, so the scheduler
   * sees each node's inbound state live and decides for itself how much of it to read.
   *
   * Iteration order is ngraph node-insertion order, which makes both shipped schedulers
   * deterministic.
   */
  #available(): Map<NodeId, NodeAvailability<N, T>> {
    const available = new Map<NodeId, NodeAvailability<N, T>>();
    this.#graph.forEachNode((graphNode) => {
      const node = graphNode.data;
      if (node.status === "done") return;
      const runtime = this.#runtime.get(node.id)!;
      if (!node.is_available(runtime.probe)) return;
      available.set(node.id, {
        view: runtime.probe,
        trigger: node.trigger,
        satisfied: satisfiedEdges(node.trigger, runtime.inbound, node.id),
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
  ): Map<EdgeId, N[]> | undefined {
    let batch: Map<EdgeId, N[]> | undefined;
    for (const [edgeId, count] of inputs) {
      if (count === "none") continue;
      const edge = runtime.inbound.get(edgeId)!;
      if (E.isRight(edge.transport)) continue; // value edges pop nothing
      const queue = edge.transport.left;
      const taken = queue.splice(0, count === "all" ? queue.length : count);
      if (taken.length === 0) continue;
      batch ??= new Map<EdgeId, N[]>();
      batch.set(edgeId, taken);
    }
    return batch;
  }

  /**
   * Drive the graph until no node is available, then resolve to every finished node's return value.
   *
   * Each iteration plans one window and executes it column by column: turn `w` runs index `w` of
   * every lane concurrently. A column reads its batches synchronously in lane order before any body
   * runs, which keeps a concurrent column deterministic; a later turn in the same window does see
   * messages an earlier turn emitted.
   *
   * @throws {DataflowDefinitionError} when re-entered while already in flight, or on any wiring
   *   violation detected mid-run.
   * @throws {DataflowNodeError} wrapping whatever a node body threw.
   */
  async run(): Promise<ReadonlyMap<NodeId, T>> {
    if (this.#inFlight)
      throw new DataflowDefinitionError("Dataflow run() is already in flight");
    this.#inFlight = true;
    try {
      while (true) {
        const available = this.#available();
        if (available.size === 0) return this.#results;

        const schedule = this.scheduler.schedule(available);
        this.#assertSchedule(schedule, available);
        const turns = schedule.reduce(
          (max, lane) => Math.max(max, lane.length),
          0,
        );
        for (let w = 0; w < turns; w++) {
          const column: NodeSchedule[] = [];
          for (const lane of schedule) {
            const entry = lane[w];
            if (entry !== undefined) column.push(entry);
          }
          if (column.length === 0) continue;
          // `allSettled`, not `all`: a second lane's rejection can never surface as an unhandled
          // rejection, and the error thrown is deterministically the lowest-lane one.
          const settled = await Promise.allSettled(
            column.map((entry) => this.#runNode(entry)),
          );
          const failed = settled.find(
            (outcome) => outcome.status === "rejected",
          );
          if (failed !== undefined) throw failed.reason;
        }
      }
    } finally {
      this.#inFlight = false;
    }
  }

  /**
   * Enforce the {@link DataflowScheduler.schedule} contract.
   *
   * @throws {DataflowDefinitionError} on too many lanes, an over-long lane, an unavailable id, an
   *   input that is not an inbound edge or not a positive count, a duplicated id within one column,
   *   or a plan with no slots while work remains (a spin).
   */
  #assertSchedule(
    schedule: Schedule,
    available: ReadonlyMap<NodeId, NodeAvailability<N, T>>,
  ): void {
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
        const inbound = this.#runtime.get(id)!.inbound;
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
  }

  /**
   * Prime a ready node without consuming its planned inputs, or deliver a running node's planned
   * batch, then advance the generator exactly once.
   */
  async #runNode({ id, inputs }: NodeSchedule): Promise<void> {
    const node = this.#graph.getNode(id)!.data;
    const runtime = this.#runtime.get(id)!;

    try {
      let step: IteratorResult<Message<N>[], T>;
      if (node.status === "ready") {
        node.generator = node.step(); // method call, so a non-arrow body sees the node as `this`
        node.status = "running";
        step = await node.generator.next();
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
        step = await node.generator.next(view);
      }

      if (step.done === true) {
        node.status = "done";
        this.#recordReturn(id, step.value);
        return;
      }
      for (const message of step.value) this.#route(id, message);
    } catch (cause) {
      node.status = "done";
      // A wiring violation raised while routing a yield is a graph bug, not a node error.
      if (cause instanceof DataflowDefinitionError) throw cause;
      throw new DataflowNodeError<EH>(id, cause as EH);
    }
  }

  /**
   * Push `message.payload` onto the outbound message edge of `fromId` carrying `message.id`.
   *
   * @throws {DataflowDefinitionError} when no such edge is wired, or when it is a value edge.
   */
  #route(fromId: NodeId, message: Message<N>): void {
    for (const link of this.#graph.getLinks(fromId) ?? []) {
      if (link.fromId !== fromId || link.data.id !== message.id) continue;
      const transport = link.data.transport;
      if (E.isRight(transport)) {
        throw new DataflowDefinitionError(
          `Node ${fromId} emitted a message on value edge "${message.id}"`,
        );
      }
      transport.left.push(message.payload);
      return;
    }
    throw new DataflowDefinitionError(
      `Node ${fromId} emitted on unwired edge "${message.id}"`,
    );
  }

  /** Record `nodeId`'s return value and fan it into every unresolved outbound value edge. */
  #recordReturn(nodeId: NodeId, value: T): void {
    this.#results.set(nodeId, value);
    for (const link of this.#graph.getLinks(nodeId) ?? []) {
      if (link.fromId !== nodeId) continue;
      const edge = link.data;
      if (E.isLeft(edge.transport)) continue; // message edge
      if (O.isSome(edge.transport.right)) continue; // write-once: never overwrite
      edge.transport = E.right(O.some(value));
    }
  }
}
