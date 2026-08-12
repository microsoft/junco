import type { Edge } from "./edges.js";
import type { Message, Node, NodeGenerator, ParentView, StepFn } from "./node.js";

/** Shared empty result for `from`. Safe to alias: the return type is `readonly N[]`. */
const NO_MESSAGES: readonly never[] = [];

/** A message bound for `edge`. */
export const msg = <N, T>(edge: Edge<N, T>, payload: N): Message<N> => ({ id: edge.id, payload });

/** This turn's batch from `edge`, empty when it did not fire. */
export const from = <S, N, T>(view: ParentView<S, N, T>, edge: Edge<N, T>): readonly N[] =>
  view.messages.get(edge.id) ?? NO_MESSAGES;

/**
 * A node body that never terminates: `fn` maps state plus this turn's view to the messages emitted
 * that turn, and is re-invoked on every firing.
 *
 * Such a node never reaches `done`, so it never appears in `run()`'s result map — which is exactly
 * what a pure sink wants.
 */
export const stepNode = <S, N, T>(fn: (state: S, view: ParentView<S, N, T>) => readonly Message<N>[]): StepFn<S, N, T> => {
  // Annotated explicitly so the `never` return inferred from `while (true)` cannot fight `T`.
  async function* body(
    this: Node<S, N, T>,
    view: ParentView<S, N, T>,
  ): NodeGenerator<S, N, T> {
    let inputs = view;
    while (true) inputs = yield fn(this.state, inputs);
  }
  return body;
};

/**
 * A source body: emit one batch, then finish with `ret`.
 *
 * No priming `yield []` is needed — the graph delivers the first batch through `step(view)`, so the
 * first `next()` already lands on the first real yield. A source therefore runs in two turns: turn
 * one yields its batch, turn two returns `ret`.
 */
export const emitOnce = <S, N, T>(batch: () => readonly Message<N>[], ret: T): StepFn<S, N, T> => {
  async function* body(): NodeGenerator<S, N, T> {
    yield batch();
    return ret;
  }
  return body;
};
