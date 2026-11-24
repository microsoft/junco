import * as E from "fp-ts/lib/Either.js";
import { type Static, type TArray, type TSchema, Type } from "typebox";
import { EmitOnce, from } from "./builders.js";
import { checkPayload, type Edge } from "./edges.js";
import { DataflowDefinitionError } from "./errors.js";
import type { NodeId } from "./identity.js";
import type { NodeGenerator, NodeOptions, NodeSpec, ParentView } from "./node.js";
import {
  Message,
  rejectLegacyAvailability,
  snapshotView,
} from "./node.js";
import { TriggerEntry, TriggerRule } from "./trigger.js";
import { assertUsageAllowed } from "./usage-limits.js";

/** Registration options for a constant node: identity, prose, its graph state and return value. */
type ConstNodeOptions<S, T> = Pick<
  NodeOptions<never, never>,
  "id" | "description"
> & {
  readonly state: S;
  readonly ret: T;
};

/**
 * A constant-node body ignores `this`, so it can register into any graph whose state and payload
 * types admit `S` and `N`. It has no failure hook.
 */
type ConstNodeSpec<S, N extends TSchema, T> = Omit<
  NodeSpec<S, N, T>,
  "step" | "on_error"
> & {
  readonly step: () => NodeGenerator<N, T>;
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
 * const a = Edge.message<typeof NumberSchema, string>("a", NumberSchema);
 * const b = Edge.message<typeof NumberSchema, string>("b", NumberSchema);
 * const source = graph.addNode(
 *   new ConstFanout(7, [a, b], { state: undefined, ret: "source done" }),
 * );
 * graph.addEdge(source, left, a).addEdge(source, right, b);
 * ```
 */
export class ConstFanout<S, N extends TSchema, T>
  extends EmitOnce<S, N, T>
  implements ConstNodeSpec<S, N, T>
{
  declare readonly on_error?: never;

  constructor(
    payload: Static<N>,
    outputs: readonly Edge<N, T>[],
    options: ConstNodeOptions<S, T>,
  ) {
    rejectLegacyAvailability(options);
    const { ret, ...registration } = options;
    const capturedOutputs = [...outputs];
    for (let i = 0; i < capturedOutputs.length; i++) {
      const edge = capturedOutputs[i];
      if (E.isRight(edge.transport)) {
        throw new DataflowDefinitionError(
          `ConstFanout output edge "${edge.id}" must be a message edge`,
        );
      }
      for (let j = 0; j < i; j++) {
        if (capturedOutputs[j].id === edge.id) {
          throw new DataflowDefinitionError(
            `ConstFanout received edge "${edge.id}" twice`,
          );
        }
      }
    }
    super(
      () => capturedOutputs.map((edge) => Message.create(edge, payload)),
      ret,
      { ...registration, trigger: TriggerRule.always<N, T>() },
    );
  }
}

/**
 * A complete collector spec that waits until every edge in `inputs` has delivered its constant,
 * sends them as ONE list message on `output`, then finishes with `options.ret`.
 *
 * Each input carries one constant `Static<C>`; the output carries the list `Static<C>[]`, admitted
 * by `TArray<C>`. The graph's message schema must therefore admit both, e.g.
 * `DataflowGraph<void, typeof NumberSchema | TArray<typeof NumberSchema>, string, never>`, and
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
 * const a = Edge.message<typeof NumberSchema, string>("a", NumberSchema);
 * const b = Edge.message<typeof NumberSchema, string>("b", NumberSchema);
 * const list = Edge.message("list", Type.Array(NumberSchema));
 * const join = graph.addNode(
 *   new ConstFanin([b, a], list, { state: undefined, ret: "fanin done" }),
 * );
 * graph.addEdge(sourceA, join, a).addEdge(sourceB, join, b).addEdge(join, sink, list);
 * // `sink` receives one message: [constant from b, constant from a].
 * ```
 */
export class ConstFanin<S, C extends TSchema, T>
  implements ConstNodeSpec<S, C | TArray<C>, T>
{
  declare readonly id?: NodeId;
  declare readonly description?: string;
  declare readonly state: S;
  readonly trigger: TriggerRule<C | TArray<C>, T>;
  readonly step: () => NodeGenerator<C | TArray<C>, T>;

  constructor(
    inputs: readonly Edge<C, T>[],
    output: Edge<TArray<C>, T>,
    options: ConstNodeOptions<S, T>,
  ) {
    rejectLegacyAvailability(options);
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
        ? TriggerRule.always<C | TArray<C>, T>()
        : TriggerRule.anyOf(...capturedInputs.map(TriggerEntry.on));

    async function* step(): NodeGenerator<C | TArray<C>, T> {
      let view = yield [];
      const chunks = capturedInputs.map((): Array<readonly Static<C>[]> => []);
      let remaining = capturedInputs.length;
      while (true) {
        for (let i = 0; i < capturedInputs.length; i++) {
          // The edge's declared `Edge<C, T>` contract narrows the graph-wide view.
          const batch = from(view, capturedInputs[i]);
          if (batch.length === 0) continue;
          const inputChunks = chunks[i];
          if (inputChunks.length === 0) remaining--;
          inputChunks.push(batch);
        }
        if (remaining === 0) break;
        view = yield [];
      }
      const collected: Static<C>[] = [];
      for (const inputChunks of chunks) {
        for (const batch of inputChunks) {
          for (const payload of batch) collected.push(payload);
        }
      }
      // `TArray<C>` admits exactly an array of `Static<C>`; TypeScript cannot unfold the generic.
      yield { resume: [Message.create(output, collected as Static<TArray<C>>)] };
      return ret;
    }

    Object.assign(this, registration);
    this.trigger = trigger;
    this.step = step;
  }
}

/** Reject a port constructed without a runtime schema. */
function requireSchema(port: "Source" | "Sink", id: NodeId, schema: unknown) {
  if (!Type.IsSchema(schema))
    throw new DataflowDefinitionError(
      `${port} "${id}" requires a TypeBox schema`,
    );
}

/**
 * Externally queued native ingress. A delivery must be pending and the port's trigger must fire.
 * Each scheduled delivery routes the FIFO head; an edge-triggered source primes without consuming
 * its credit or input. Enqueued messages must satisfy `schema` and each routed edge's own schema.
 */
export class Source<N extends TSchema, T>
  implements NodeSpec<Source<N, T>, N, T>
{
  readonly id: NodeId;
  readonly description?: string;
  readonly schema: N;
  readonly state = this;
  readonly trigger: TriggerRule<N, T>;
  readonly step: () => NodeGenerator<N, T>;
  readonly #pending: ParentView<N, T>[] = [];
  #revision = 0;

  constructor(
    route: (view: ParentView<N, T>) => Message<N>[],
    options: Partial<NodeOptions<N, T>> & {
      readonly id: NodeId;
      readonly schema: N;
    },
  ) {
    rejectLegacyAvailability(options);
    requireSchema("Source", options.id, options.schema);
    this.id = options.id;
    this.schema = options.schema;
    this.trigger = options.trigger ?? TriggerRule.always();
    if (options.description !== undefined)
      this.description = options.description;
    const source = this;
    this.step = async function* (): NodeGenerator<N, T> {
      if (source.trigger.rule.length > 0) yield [];
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

  /**
   * Queue one detached delivery. Atomic: a payload outside `schema` rejects the whole view before
   * anything is queued.
   *
   * @throws {DataflowDefinitionError} when any message fails `schema`.
   */
  enqueue(view: ParentView<N, T>): void {
    const detached = snapshotView(view);
    let nonempty = false;
    for (const id of detached.messages.keys())
      for (const payload of detached.messages.get(id) ?? []) {
        checkPayload(
          this.schema,
          payload,
          `Invalid payload for Source "${this.id}" on edge "${id}"`,
        );
        nonempty = true;
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

/**
 * Native egress: yielded and explicitly sent messages await acknowledged external delivery. Every
 * staged message must satisfy `schema`; the eventual destination edge checks its own schema again.
 */
export class Sink<N extends TSchema, T> implements NodeSpec<Sink<N, T>, N, T> {
  readonly id: NodeId;
  readonly description?: string;
  readonly schema: N;
  readonly state = this;
  readonly trigger: TriggerRule<N, T>;
  readonly step: () => NodeGenerator<N, T>;
  readonly #outbox: Message<N>[] = [];

  constructor(
    body: (sink: Sink<N, T>) => NodeGenerator<N, T>,
    options: Omit<NodeOptions<N, T>, "id"> & {
      readonly id: NodeId;
      readonly schema: N;
    },
  ) {
    rejectLegacyAvailability(options);
    requireSchema("Sink", options.id, options.schema);
    this.id = options.id;
    this.schema = options.schema;
    this.trigger = options.trigger;
    if (options.description !== undefined)
      this.description = options.description;
    this.step = () => body(this);
  }

  /** @throws {DataflowDefinitionError} when the payload fails `schema`; nothing is staged. */
  send(message: Message<N>): void {
    assertUsageAllowed();
    checkPayload(
      this.schema,
      message.payload,
      `Invalid payload for Sink "${this.id}" on edge "${message.id}"`,
    );
    this.#outbox.push(message);
  }

  drain(deliver: (message: Message<N>) => void): void {
    while (this.#outbox.length > 0) {
      deliver(this.#outbox[0]);
      this.#outbox.shift();
    }
  }
}
