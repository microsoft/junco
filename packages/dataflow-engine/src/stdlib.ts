import * as E from "fp-ts/lib/Either.js";
import { from } from "./builders.js";
import type { Edge } from "./edges.js";
import { DataflowDefinitionError } from "./errors.js";
import type { NodeId } from "./identity.js";
import type {
  AvailabilityFn,
  NodeGenerator,
  NodeOptions,
  NodeSpec,
  ParentView,
} from "./node.js";
import { Message, snapshotView } from "./node.js";
import type { Profiles } from "./profile.js";
import { TriggerEntry, TriggerRule } from "./trigger.js";

/** Registration options for a constant node: identity, prose, its graph state and return value. */
type ConstNodeOptions<S, T> = Pick<
  NodeOptions<never, never>,
  "id" | "description"
> & {
  readonly state: S;
  readonly ret: T;
};

/**
 * A complete constant-node spec. Its body ignores `this` and its availability hook ignores the
 * view, so both are typed loosely enough to register into any graph whose state and payload types
 * admit `S` and `N`, rather than pinning the graph to the inferred ones. It has no failure hook.
 */
type ConstNodeSpec<S, N, T> = Omit<
  NodeSpec<S, N, T>,
  "step" | "is_available" | "on_error"
> & {
  readonly step: () => NodeGenerator<N, T>;
  readonly is_available?: AvailabilityFn<unknown, unknown>;
};

/**
 * A complete source spec that sends one constant `payload` once on every edge in `outputs`, then
 * finishes with `options.ret`.
 *
 * Register the constructed spec with `graph.addNode`, then wire each output edge with
 * `graph.addEdge(source, target, edge)` as usual.
 *
 * Runs in two activations: the first emits one message per output edge, in `outputs` order; the
 * next returns `options.ret`. With no outputs it emits nothing and still completes.
 *
 * @param payload - Sent by reference on every output: each receiver sees the same object, neither
 *   cloned nor frozen.
 * @param outputs - Message edges to send on. Copied on construction, so later changes to the caller's
 *   array do not affect the node.
 * @param options - `state` and `ret` are required (pass `undefined` when unused); `id` and
 *   `description` are optional, as for any node.
 * @throws {DataflowDefinitionError} when an output is a value edge, or an output id repeats.
 *
 * @example
 * ```ts
 * const a = Edge.message<number, string>("a");
 * const b = Edge.message<number, string>("b");
 * const source = graph.addNode(
 *   new ConstFanout(7, [a, b], { state: undefined, ret: "source done" }),
 * );
 * graph.addEdge(source, left, a).addEdge(source, right, b);
 * ```
 */
export class ConstFanout<S, N, T> implements ConstNodeSpec<S, N, T> {
  declare readonly id?: NodeId;
  declare readonly description?: string;
  declare readonly state: S;
  readonly trigger: TriggerRule<N, T>;
  readonly step: () => NodeGenerator<N, T>;

  constructor(
    payload: N,
    outputs: readonly Edge<N, T>[],
    options: ConstNodeOptions<S, T>,
  ) {
    const { ret, ...registration } = options;
    const capturedOutputs = [...outputs];
    for (let i = 0; i < capturedOutputs.length; i++) {
      const edge = capturedOutputs[i]!;
      if (E.isRight(edge.transport)) {
        throw new DataflowDefinitionError(
          `ConstFanout output edge "${edge.id}" must be a message edge`,
        );
      }
      for (let j = 0; j < i; j++) {
        if (capturedOutputs[j]!.id === edge.id) {
          throw new DataflowDefinitionError(
            `ConstFanout received edge "${edge.id}" twice`,
          );
        }
      }
    }
    Object.assign(this, registration);
    this.trigger = TriggerRule.always<N, T>();
    this.step = async function* (): NodeGenerator<N, T> {
      yield capturedOutputs.map((edge) => Message.create(edge, payload));
      return ret;
    };
  }
}

/**
 * A complete collector spec that waits until every edge in `inputs` has delivered its constant,
 * sends them as ONE list message on `output`, then finishes with `options.ret`.
 *
 * Each input carries one constant `C`; the output carries the list `C[]`. The graph's message type
 * must therefore admit both, e.g. `DataflowGraph<void, number | number[], string, never>`, and
 * may include unrelated variants besides. Register the constructed spec with `graph.addNode`, then
 * wire every input and the output with `graph.addEdge` as usual.
 *
 * The list follows `inputs` order, not arrival order; payloads are kept by reference, and an
 * array-valued constant stays one element. Should an input deliver more than one payload before
 * the list is sent, all of them are kept, in delivery order. Inputs may arrive across separate
 * activations or `run()` calls: until each has contributed, nothing is sent and the node stays
 * unfinished, resuming when the rest arrive. Once sent, the node returns `options.ret` on its next
 * activation; later input never produces another list. With no inputs it sends one `[]`.
 *
 * Each instance holds its own collection progress: construct one per collector node.
 *
 * @param inputs - Message edges to collect from. Copied on construction, so later changes to the
 *   caller's array do not affect the node.
 * @param output - The message edge the list is sent on.
 * @param options - `state` and `ret` are required (pass `undefined` when unused); `id` and
 *   `description` are optional, as for any node.
 * @throws {DataflowDefinitionError} when an input or the output is a value edge, or an input id
 *   repeats.
 *
 * @example
 * ```ts
 * const a = Edge.message<number, string>("a");
 * const b = Edge.message<number, string>("b");
 * const list = Edge.message<number[], string>("list");
 * const join = graph.addNode(
 *   new ConstFanin([b, a], list, { state: undefined, ret: "fanin done" }),
 * );
 * graph.addEdge(sourceA, join, a).addEdge(sourceB, join, b).addEdge(join, sink, list);
 * // `sink` receives one message: [constant from b, constant from a].
 * ```
 */
export class ConstFanin<S, C, T> implements ConstNodeSpec<S, C | C[], T> {
  declare readonly id?: NodeId;
  declare readonly description?: string;
  declare readonly state: S;
  readonly trigger: TriggerRule<C | C[], T>;
  readonly is_available: AvailabilityFn<unknown, unknown>;
  readonly step: () => NodeGenerator<C | C[], T>;

  constructor(
    inputs: readonly Edge<C, T>[],
    output: Edge<C[], T>,
    options: ConstNodeOptions<S, T>,
  ) {
    const { ret, ...registration } = options;
    const capturedInputs = [...inputs];
    for (const edge of capturedInputs) {
      if (E.isRight(edge.transport)) {
        throw new DataflowDefinitionError(
          `ConstFanin input edge "${edge.id}" must be a message edge`,
        );
      }
    }
    if (E.isRight(output.transport)) {
      throw new DataflowDefinitionError(
        `ConstFanin output edge "${output.id}" must be a message edge`,
      );
    }
    const trigger =
      capturedInputs.length === 0
        ? TriggerRule.always<C | C[], T>()
        : TriggerRule.anyOf(...capturedInputs.map(TriggerEntry.on));
    // Once the list is out, stay available so the final return runs after the inputs have drained.
    let emitted = false;

    async function* step(): NodeGenerator<C | C[], T> {
      let view = yield [];
      const chunks: (Array<readonly C[]> | undefined)[] = [];
      let remaining = capturedInputs.length;
      while (true) {
        for (let i = 0; i < capturedInputs.length; i++) {
          // The edge's declared `Edge<C, T>` contract narrows the graph-wide view.
          const batch = from(view, capturedInputs[i]!) as readonly C[];
          if (batch.length === 0) continue;
          const inputChunks = chunks[i];
          if (inputChunks === undefined) {
            chunks[i] = [batch];
            remaining--;
          } else {
            inputChunks.push(batch);
          }
        }
        if (remaining === 0) break;
        view = yield [];
      }
      const collected: C[] = [];
      for (const inputChunks of chunks) {
        for (const batch of inputChunks!) {
          for (const payload of batch) collected.push(payload);
        }
      }
      emitted = true;
      yield [Message.create(output, collected)];
      return ret;
    }

    Object.assign(this, registration);
    this.trigger = trigger;
    this.is_available = (_view, triggered) => triggered || emitted;
    this.step = step;
  }
}

/** Externally queued native ingress; one detached delivery per selected activation. */
export class Source<N, T> implements NodeSpec<Source<N, T>, N, T> {
  readonly id: NodeId;
  readonly description?: string;
  readonly profiles?: Profiles<never>;
  readonly state = this;
  readonly trigger = TriggerRule.always<N, T>();
  readonly is_available = () => this.#pending.length > 0;
  readonly step: () => NodeGenerator<N, T>;
  readonly #pending: ParentView<N, T>[] = [];
  #revision = 0;

  constructor(
    route: (view: ParentView<N, T>) => Message<N>[],
    options: Pick<NodeOptions<N, T>, "description" | "profiles"> & {
      readonly id: NodeId;
    },
  ) {
    this.id = options.id;
    if (options.profiles !== undefined) this.profiles = options.profiles;
    if (options.description !== undefined)
      this.description = options.description;
    const source = this;
    this.step = async function* (): NodeGenerator<N, T> {
      while (true) {
        const view = source.#pending.shift();
        if (view === undefined)
          throw new DataflowDefinitionError("Source has no queued input");
        source.#revision++;
        yield route(view);
      }
    };
  }

  get revision(): number {
    return this.#revision;
  }

  enqueue(view: ParentView<N, T>): void {
    const detached = snapshotView(view);
    let nonempty = false;
    for (const id of detached.messages.keys())
      if ((detached.messages.get(id)?.length ?? 0) > 0) {
        nonempty = true;
        break;
      }
    if (!nonempty)
      for (const _id of detached.values.keys()) {
        nonempty = true;
        break;
      }
    if (!nonempty) return;
    this.#pending.push(detached);
    this.#revision++;
  }

  peek(): ParentView<N, T> | undefined {
    return this.#pending[0];
  }
}

/** Native egress: yielded and explicitly sent messages await acknowledged external delivery. */
export class Sink<N, T> implements NodeSpec<Sink<N, T>, N, T> {
  readonly id: NodeId;
  readonly description?: string;
  readonly profiles?: Profiles<never>;
  readonly state = this;
  readonly trigger: TriggerRule<N, T>;
  readonly is_available?: AvailabilityFn<N, T>;
  readonly step: () => NodeGenerator<N, T>;
  readonly #outbox: Message<N>[] = [];

  constructor(
    body: (sink: Sink<N, T>) => NodeGenerator<N, T>,
    options: Omit<NodeOptions<N, T>, "id"> & { readonly id: NodeId },
  ) {
    this.id = options.id;
    if (options.profiles !== undefined) this.profiles = options.profiles;
    this.trigger = options.trigger;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.is_available !== undefined)
      this.is_available = options.is_available;
    const sink = this;
    this.step = async function* (): NodeGenerator<N, T> {
      const generator = body(sink);
      let next = await generator.next();
      while (!next.done) {
        for (const message of next.value) sink.send(message);
        const view = yield [];
        next = await generator.next(view);
      }
      return next.value;
    };
  }

  send(message: Message<N>): void {
    this.#outbox.push(message);
  }

  drain(deliver: (message: Message<N>) => void): void {
    while (this.#outbox.length > 0) {
      deliver(this.#outbox[0]!);
      this.#outbox.shift();
    }
  }
}
