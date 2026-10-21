import {
  DataflowDefinitionError,
  type DataflowGraph,
  type DataflowRunOptions,
  type InputSchedule,
  type NodeAvailability,
  type NodeIdType,
  triggerInputs,
} from "dataflow-engine";
import {
  type Decision,
  type NodeModel,
  type Scheduler,
  type Snapshot,
  validateDecision,
} from "./scheduler.js";

export type SchedulerContext<
  S,
  N,
  T,
  C,
  G extends DataflowGraph<S, N, T, never>,
> = {
  readonly scheduler: Scheduler<S, N, T, C>;
  readonly graph: G;
  step(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeIdType, T>>;
  run(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeIdType, T>>;
};

/** Pair work and policy externally. Construction never observes or registers graph work. */
export function context<
  S,
  N,
  T,
  C = never,
  G extends DataflowGraph<S, N, T, never> = DataflowGraph<S, N, T, never>,
>(options: {
  readonly scheduler: Scheduler<NoInfer<S>, NoInfer<N>, NoInfer<T>, NoInfer<C>>;
  readonly graph: G & DataflowGraph<S, N, T, never>;
  readonly describeNode?: (
    id: NodeIdType,
    candidate: NodeAvailability<N, T>,
  ) => C | undefined;
  readonly readInputs?: (
    id: NodeIdType,
    candidate: NodeAvailability<N, T>,
  ) => InputSchedule;
  readonly prepare?: (
    selected: readonly NodeModel[],
    signal?: AbortSignal,
  ) => void | Promise<void>;
}): SchedulerContext<S, N, T, C, G> {
  const { graph, scheduler, describeNode, readInputs } = options;
  const inputs =
    readInputs ??
    ((_id: NodeIdType, candidate: NodeAvailability<N, T>) =>
      triggerInputs(candidate));
  const history: Decision[] = [];
  const drive = (repeat: boolean, runOptions?: DataflowRunOptions) =>
    graph.evaluate(async (execute, signal) => {
      do {
        signal?.throwIfAborted();
        const candidates = graph.available();
        if (candidates.size === 0) break;
        const observation = graph.observe();
        const plans = new Map(
          [...candidates].map(([id, candidate]) => [id, inputs(id, candidate)]),
        );
        const metadata = new Map<NodeIdType, C>();
        if (describeNode !== undefined) {
          for (const [id, candidate] of candidates) {
            const description = describeNode(id, candidate);
            if (description !== undefined) metadata.set(id, description);
          }
        }
        const snapshot: Snapshot<S, N, T, C> = Object.freeze({
          ...observation,
          available: new Set(candidates.keys()),
          owned: new Set(observation.nodes.keys()),
          context: metadata,
          plans,
          history: Object.freeze([...history]),
          threads: graph.threads,
        });
        signal?.throwIfAborted();
        let decision: Decision;
        try {
          decision = await scheduler(snapshot, signal);
        } catch (error) {
          signal?.throwIfAborted();
          throw error;
        }
        signal?.throwIfAborted();
        validateDecision(snapshot, decision);
        const schedule = decision.selected.map(({ nodeId }) => [
          {
            id: nodeId,
            inputs: plans.get(nodeId)!,
          },
        ]);
        const live = graph.available();
        if (
          graph.observe().version !== snapshot.version ||
          decision.selected.some((entry) => !live.has(entry.nodeId))
        ) {
          throw new DataflowDefinitionError(
            "Scheduler snapshot changed while computing a decision",
          );
        }
        const strengths = new Map(
          decision.selected.map((entry) => [entry.nodeId, entry.modelStrength]),
        );
        await options.prepare?.(decision.selected, signal);
        await execute(schedule, {
          resolveInputs: (entry, candidate) => inputs(entry.id, candidate),
          onColumn: (selected) => {
            if (selected.length > 0)
              history.push(
                Object.freeze({
                  selected: Object.freeze(
                    selected.map((nodeId) => ({
                      nodeId,
                      modelStrength: strengths.get(nodeId)!,
                    })),
                  ),
                }),
              );
          },
        });
      } while (repeat);
      return graph.results();
    }, runOptions);
  return Object.freeze({
    scheduler,
    graph,
    step: (runOptions?: DataflowRunOptions) => drive(false, runOptions),
    run: (runOptions?: DataflowRunOptions) => drive(true, runOptions),
  });
}

/** Run to quiescence as separate steps, retaining trace and cancellation boundaries between them. */
export async function drain(
  execution: {
    readonly graph: { available(): { readonly size: number } };
    step(options?: DataflowRunOptions): Promise<unknown>;
  },
  options?: DataflowRunOptions,
): Promise<void> {
  options?.signal?.throwIfAborted();
  while (execution.graph.available().size > 0) {
    await execution.step(options);
    options?.signal?.throwIfAborted();
  }
}
