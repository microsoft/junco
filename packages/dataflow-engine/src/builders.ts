import type { Edge } from "./edges.js";
import type {
  Message,
  Node,
  NodeGenerator,
  ParentView,
  StepFn,
} from "./node.js";

/** Shared empty result for `from`. Safe to alias: the return type is `readonly N[]`. */
const NO_MESSAGES: readonly never[] = [];

/** A message bound for `edge`. */
export const msg = <N, T>(edge: Edge<N, T>, payload: N): Message<N> => ({
  id: edge.id,
  payload,
});

/** This turn's batch from `edge`, empty when it did not fire. */
export const from = <N, T>(
  view: ParentView<N, T>,
  edge: Edge<N, T>,
): readonly N[] => view.messages.get(edge.id) ?? NO_MESSAGES;

/**
 * A node body that never terminates: after its priming yield, `fn` maps state plus each delivered
 * view to the messages emitted that turn, and is re-invoked on every running-node activation.
 *
 * Such a node never reaches `done`, so it never appears in `run()`'s result map — which is exactly
 * what a pure sink wants.
 */
export const stepNode = <S, N, T>(
  fn: (state: S, view: ParentView<N, T>) => Message<N>[],
): StepFn<S, N, T> => {
  // Annotated explicitly so the `never` return inferred from `while (true)` cannot fight `T`.
  async function* body(this: Node<S, N, T>): NodeGenerator<N, T> {
    let view = yield [];
    while (true) view = yield fn(this.state, view);
  }
  return body;
};

/**
 * A source body: emit one batch, then finish with `ret`.
 *
 * The graph primes this source with `step()` and `next()`, so the first `next()` lands directly on
 * the real batch. A source therefore runs in two turns: turn one yields its batch, turn two returns
 * `ret`.
 */
export const emitOnce = <S, N, T>(
  batch: () => Message<N>[],
  ret: T,
): StepFn<S, N, T> => {
  async function* body(): NodeGenerator<N, T> {
    yield batch();
    return ret;
  }
  return body;
};
