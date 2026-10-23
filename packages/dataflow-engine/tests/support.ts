import * as E from "fp-ts/lib/Either.js";

// No `../src` imports: root fixtures load this module under Node, which cannot run the package's `.ts` sources.

/** The messages currently queued on message edge `edge`, read without consuming them. */
export const queued = <N>(edge: {
  readonly transport: E.Either<Iterable<N>, unknown>;
}): N[] => (E.isLeft(edge.transport) ? [...edge.transport.left] : []);
