import * as E from "fp-ts/lib/Either.js";
import type { TSchema } from "typebox";
import type { DataflowGraph, MessageSchedule } from "../src/index.ts";

// No runtime engine imports: root fixtures load this module under Node, without compiled engine sources.

/** The messages currently queued on message edge `edge`, read without consuming them. */
export const queued = <N>(edge: {
  readonly transport: E.Either<Iterable<N>, unknown>;
}): N[] => (E.isLeft(edge.transport) ? [...edge.transport.left] : []);

/** Exercise native counted reads, not policy selections that consume whole queues. */
export const nativeReads = <S, N extends TSchema, T, EH>(
  graph: DataflowGraph<S, N, T, EH>,
  count: MessageSchedule,
) => {
  const drive = (repeat: boolean) =>
    graph.evaluate(async (execute) => {
      do {
        const available = graph.available();
        if (available.size === 0) break;
        await execute(
          [...available].map(([id, candidate]) => [
            {
              id,
              inputs: new Map(
                candidate.trigger.rule.map((edge) => [edge, count]),
              ),
            },
          ]),
        );
      } while (repeat);
      return graph.results();
    });
  return { step: () => drive(false), run: () => drive(true) };
};
