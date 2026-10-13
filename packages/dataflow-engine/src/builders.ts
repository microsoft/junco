import type { Edge } from "./edges.js";
import type { NodeId } from "./identity.js";
import type {
  AvailabilityFn,
  ErrorFn,
  Message,
  Node,
  NodeGenerator,
  NodeSpec,
  ParentView,
  StepFn,
} from "./node.js";
import type { TriggerRule } from "./trigger.js";

/** Shared empty result for `from`. Safe to alias: the return type is `readonly N[]`. */
const NO_MESSAGES: readonly never[] = [];

/** This turn's batch from `edge`, empty when it did not fire. */
export const from = <N, T>(
  view: ParentView<N, T>,
  edge: Edge<N, T>,
): readonly N[] => view.messages.get(edge.id) ?? NO_MESSAGES;

/**
 * A complete node spec whose body never terminates: after its priming yield, `fn` maps the
 * registered node's current state plus each delivered view to the messages emitted that turn, and
 * is re-invoked on every running-node activation.
 *
 * Such a node never reaches `done`, so it never appears in `run()`'s result map — which is exactly
 * what a pure sink wants. `options` supplies everything but the body; its own properties are copied
 * onto the spec.
 */
export class StepNode<S, N, T> implements NodeSpec<S, N, T> {
  declare readonly id?: NodeId;
  declare readonly description?: string;
  declare readonly trigger: TriggerRule<N, T>;
  declare readonly is_available?: AvailabilityFn<N, T>;
  declare readonly on_error?: ErrorFn<S, N, T>;
  declare readonly state: S;
  readonly step: StepFn<S, N, T>;

  constructor(
    fn: (state: S, view: ParentView<N, T>) => Message<N>[],
    options: Omit<NodeSpec<S, N, T>, "step">,
  ) {
    Object.assign(this, options);
    // Annotated explicitly so the `never` return inferred from `while (true)` cannot fight `T`.
    this.step = async function* (this: Node<S, N, T>): NodeGenerator<N, T> {
      let view = yield [];
      while (true) view = yield fn(this.state, view);
    };
  }
}

/**
 * A complete source spec: emit one batch, then finish with `ret`.
 *
 * The graph primes this source with `step()` and `next()`, so the first `next()` lands directly on
 * the real batch. A source therefore runs in two turns: turn one yields its batch, turn two returns
 * `ret`. `options` supplies everything but the body; its own properties are copied onto the spec.
 */
export class EmitOnce<S, N, T> implements NodeSpec<S, N, T> {
  declare readonly id?: NodeId;
  declare readonly description?: string;
  declare readonly trigger: TriggerRule<N, T>;
  declare readonly is_available?: AvailabilityFn<N, T>;
  declare readonly on_error?: ErrorFn<S, N, T>;
  declare readonly state: S;
  readonly step: () => NodeGenerator<N, T>;

  constructor(
    batch: () => Message<N>[],
    ret: T,
    options: Omit<NodeSpec<S, N, T>, "step">,
  ) {
    Object.assign(this, options);
    this.step = async function* (): NodeGenerator<N, T> {
      yield batch();
      return ret;
    };
  }
}
