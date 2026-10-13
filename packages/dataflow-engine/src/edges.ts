import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { Identifiable } from "./identifiable.js";
import { EdgeId } from "./identity.js";
import { Queue } from "./queue.js";

/**
 * A graph edge. Its `transport` is `Either<Queue<N>, Option<T>>`: **Left = message queue**, drained
 * per the destination node's trigger rule, **Right = return-value cell**, written once when the
 * source node returns.
 *
 * `transport` is mutable because fp-ts `Right<A>.right` is readonly — resolving a value edge
 * replaces the whole `Either`; the queue side is mutated in place and never replaced, which is what
 * lets the runtime alias a live queue by reference into a node's readiness probe.
 */
export type Edge<N, T> = Identifiable<EdgeId> & {
  transport: E.Either<Queue<N>, O.Option<T>>;
};

/** Construction of {@link Edge}s. */
export const Edge = {
  /** Mint a message edge: a FIFO queue of `N`, drained per the destination node's trigger rule. */
  message: <N, T>(id: string): Edge<N, T> => ({
    id: EdgeId.create(id),
    transport: E.left(Queue.empty<N>()),
  }),
  /** Mint a value edge: a write-once cell holding the source node's return value `T`. */
  value: <N, T>(id: string): Edge<N, T> => ({
    id: EdgeId.create(id),
    transport: E.right(O.none),
  }),
};
