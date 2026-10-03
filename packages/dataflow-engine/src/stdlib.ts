import * as E from "fp-ts/lib/Either.js";
import { emitOnce, from, msg } from "./builders.js";
import type { Edge } from "./edges.js";
import { DataflowDefinitionError } from "./errors.js";
import type {
  AvailabilityFn,
  NodeGenerator,
  NodeOptions,
  NodeSpec,
} from "./node.js";
import { always, anyOf, on } from "./trigger.js";

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
 * admit `S` and `N`, rather than pinning the graph to the inferred ones.
 */
type ConstNodeSpec<S, N, T> = Omit<
  NodeSpec<S, N, T>,
  "step" | "is_available"
> & {
  readonly step: () => NodeGenerator<N, T>;
  readonly is_available?: AvailabilityFn<unknown, unknown>;
};

/**
 * A complete source spec that sends one constant `payload` once on every edge in `outputs`, then
 * finishes with `options.ret`.
 *
 * Register the returned spec with `graph.addNode`, then wire each output edge with
 * `graph.addEdge(source, target, edge)` as usual.
 *
 * Runs in two activations: the first emits one message per output edge, in `outputs` order; the
 * next returns `options.ret`. With no outputs it emits nothing and still completes.
 *
 * @param payload - Sent by reference on every output: each receiver sees the same object, neither
 *   cloned nor frozen.
 * @param outputs - Message edges to send on. Copied when called, so later changes to the caller's
 *   array do not affect the node.
 * @param options - `state` and `ret` are required (pass `undefined` when unused); `id` and
 *   `description` are optional, as for any node.
 * @throws {DataflowDefinitionError} when an output is a value edge, or an output id repeats.
 *
 * @example
 * ```ts
 * const a = messageEdge<number, string>("a");
 * const b = messageEdge<number, string>("b");
 * const source = graph.addNode(
 *   ConstFanout(7, [a, b], { state: undefined, ret: "source done" }),
 * );
 * graph.addEdge(source, left, a).addEdge(source, right, b);
 * ```
 */
export const ConstFanout = <S, N, T>(
  payload: N,
  outputs: readonly Edge<N, T>[],
  options: ConstNodeOptions<S, T>,
): ConstNodeSpec<S, N, T> => {
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
  return {
    ...registration,
    trigger: always<N, T>(),
    step: emitOnce<S, N, T>(
      () => capturedOutputs.map((edge) => msg(edge, payload)),
      ret,
    ),
  };
};

/**
 * A complete collector spec that waits until every edge in `inputs` has delivered its constant,
 * sends them as ONE list message on `output`, then finishes with `options.ret`.
 *
 * Each input carries one constant `C`; the output carries the list `C[]`. The graph's message type
 * must therefore admit both, e.g. `DataflowGraph<void, number | number[], string, never>`, and
 * may include unrelated variants besides. Register the returned spec with `graph.addNode`, then
 * wire every input and the output with `graph.addEdge` as usual.
 *
 * The list follows `inputs` order, not arrival order; payloads are kept by reference, and an
 * array-valued constant stays one element. Should an input deliver more than one payload before
 * the list is sent, all of them are kept, in delivery order. Inputs may arrive across separate
 * activations or `run()` calls: until each has contributed, nothing is sent and the node stays
 * unfinished, resuming when the rest arrive. Once sent, the node returns `options.ret` on its next
 * activation; later input never produces another list. With no inputs it sends one `[]`.
 *
 * Each call holds its own collection progress: invoke the factory once per collector node.
 *
 * @param inputs - Message edges to collect from. Copied when called, so later changes to the
 *   caller's array do not affect the node.
 * @param output - The message edge the list is sent on.
 * @param options - `state` and `ret` are required (pass `undefined` when unused); `id` and
 *   `description` are optional, as for any node.
 * @throws {DataflowDefinitionError} when an input or the output is a value edge, or an input id
 *   repeats.
 *
 * @example
 * ```ts
 * const a = messageEdge<number, string>("a");
 * const b = messageEdge<number, string>("b");
 * const list = messageEdge<number[], string>("list");
 * const join = graph.addNode(
 *   ConstFanin([b, a], list, { state: undefined, ret: "fanin done" }),
 * );
 * graph.addEdge(sourceA, join, a).addEdge(sourceB, join, b).addEdge(join, sink, list);
 * // `sink` receives one message: [constant from b, constant from a].
 * ```
 */
export const ConstFanin = <S, C, T>(
  inputs: readonly Edge<C, T>[],
  output: Edge<C[], T>,
  options: ConstNodeOptions<S, T>,
): ConstNodeSpec<S, C | C[], T> => {
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
      ? always<C | C[], T>()
      : anyOf(...capturedInputs.map(on));
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
    yield [msg(output, collected)];
    return ret;
  }

  return {
    ...registration,
    trigger,
    is_available: (_view, triggered) => triggered || emitted,
    step,
  };
};
