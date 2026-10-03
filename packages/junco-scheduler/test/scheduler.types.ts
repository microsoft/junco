// Compile-only: builder state and payload inference for the deterministic core. Covered by
// tsconfig.typecheck.json and tsconfig.core.typecheck.json; never executed.

import {
  DataflowGraph,
  type DataflowScheduler,
  type EdgeIdType,
  type NodeAvailability,
  type NodeIdType,
  triggerInputs,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import {
  createParallelScheduler,
  createRoundRobinScheduler,
  createScheduler,
} from "../src/index.ts";

class Ledger {
  readonly seen = new Map<NodeIdType, number>();
  record(id: NodeIdType): number {
    const count = (this.seen.get(id) ?? 0) + 1;
    this.seen.set(id, count);
    return count;
  }
}

export function classStateKeepsItsMethods(edge: EdgeIdType) {
  const scheduler = createScheduler({
    state: new Ledger(),
    schedule(available, state, window, threads) {
      const capacity: number = window * threads;
      const counts: number[] = [...available.keys()].map((id) =>
        state.record(id),
      );
      return counts.length > capacity
        ? []
        : [...available].map(([id, live]) => [
            { id, inputs: triggerInputs(live) },
          ]);
    },
    resolveInputs: (_entry, live, state) => {
      const ledger: Ledger = state;
      return ledger.seen.size > 0 ? triggerInputs(live) : new Map([[edge, 1]]);
    },
  });
  const count: number = scheduler.state.record("a" as NodeIdType);
  scheduler.state = new Ledger();
  // @ts-expect-error the state keeps its inferred class type
  scheduler.state = { seen: new Map() };
  // @ts-expect-error nor may it become a primitive
  scheduler.state = 1;
  return count;
}

export function payloadsFlowIntoTheCandidateView(edge: EdgeIdType) {
  const scheduler = createScheduler({
    state: { reads: 0 },
    schedule(
      available: ReadonlyMap<NodeIdType, NodeAvailability<number, string>>,
      state,
    ) {
      for (const candidate of available.values()) {
        const queued: readonly number[] | undefined =
          candidate.view.messages.get(edge);
        const result: string | undefined = candidate.view.values.get(edge);
        // @ts-expect-error message payloads are numbers
        const wrong: readonly string[] | undefined =
          candidate.view.messages.get(edge);
        state.reads +=
          (queued?.length ?? 0) +
          (result === undefined ? 0 : 1) +
          (wrong === undefined ? 0 : 1);
      }
      return [...available].map(([id, candidate]) => [
        { id, inputs: triggerInputs(candidate) },
      ]);
    },
  });
  const typed: DataflowScheduler<number, string> & {
    state: { reads: number };
  } = scheduler;
  const graph = new DataflowGraph<
    void,
    number,
    string,
    never,
    typeof scheduler
  >(scheduler, Width(1), UNBOUNDED);
  const reads: number = graph.scheduler.state.reads;
  return [typed, reads];
}

export function shippedStrategiesKeepTheirShapes() {
  const parallel = createParallelScheduler<number, string>();
  // @ts-expect-error the stateless strategy exposes no state
  parallel.state;
  const rotation = createRoundRobinScheduler<number, string>();
  const cursor: NodeIdType | undefined = rotation.state;
  rotation.state = undefined;
  // @ts-expect-error the cursor is a branded NodeId, not a raw string
  rotation.state = "a";
  const graph = new DataflowGraph<void, number, string, never, typeof rotation>(
    rotation,
    Width(1),
    Width(1),
  );
  const last: NodeIdType | undefined = graph.scheduler.state;
  return [parallel, cursor, last];
}
