import { type NodeIdType as NodeId, triggerInputs } from "dataflow-engine";
import { Scheduler } from "./scheduler.js";

/**
 * Run exactly one candidate occurrence per window, rotating through node ids in increasing
 * JavaScript string order (`<`/`>`, so `"1" < "10" < "2"`), whatever the window and thread limits.
 *
 * `state` is the last scheduled `NodeId`, initially `undefined`. Each plan picks the smallest
 * available id strictly greater than it, wrapping to the smallest available id only when none is
 * greater; a vanished previous id still hands over to its smallest available successor, and a new
 * smaller candidate joins at the next wrap. `""` is a valid cursor. An empty candidate set plans
 * `[]` and leaves the cursor unchanged. Assigning `scheduler.state` moves the cursor.
 *
 * The chosen entry reads `triggerInputs(candidate)`.
 *
 * @example
 * ```ts
 * import { DataflowGraph, Width } from "dataflow-engine";
 * import { RoundRobinScheduler } from "junco-scheduler";
 *
 * const scheduler = new RoundRobinScheduler<number, string>();
 * const graph = new DataflowGraph<void, number, string, never>(scheduler, Width.create(1), Width.create(1));
 * // ...after some graph.step() calls, scheduler.state is the last id that ran.
 * ```
 */
export class RoundRobinScheduler<N = unknown, T = unknown> extends Scheduler<
  NodeId | undefined,
  N,
  T
> {
  constructor() {
    // The policy runs only after construction, so it may assign the cursor through `this`.
    super({
      state: undefined,
      schedule: (available, last) => {
        let first: NodeId | undefined;
        let next: NodeId | undefined;
        for (const id of available.keys()) {
          if (first === undefined || id < first) first = id;
          if (
            last !== undefined &&
            id > last &&
            (next === undefined || id < next)
          )
            next = id;
        }
        const chosen = next ?? first;
        if (chosen === undefined) return [];
        this.state = chosen;
        return [
          [{ id: chosen, inputs: triggerInputs(available.get(chosen)!) }],
        ];
      },
    });
  }
}
