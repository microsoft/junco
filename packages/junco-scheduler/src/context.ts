import {
  DataflowDefinitionError,
  type DataflowGraph,
  type DataflowRunOptions,
  type InputSchedule,
  type NodeAvailability,
  type NodeIdType,
  triggerInputs,
  type UsageBudget,
} from "dataflow-engine";
import type { TSchema } from "typebox";
import {
  type Decision,
  type NodeModel,
  type Scheduler,
  type Snapshot,
  validateDecision,
} from "./scheduler.js";
import { type UsageLimitDefinition, usageBudgets } from "./usage-limits.js";

const SCHEDULE_ATTEMPTS = 3;

/** A graph paired with its policy: `step()` runs one decision, `run()` repeats decisions to quiescence; both resolve to the results map. */
export type SchedulerContext<
  S,
  N extends TSchema,
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
  N extends TSchema,
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
      // Evaluation-scoped ledgers live for this one run()/step() invocation.
      const evaluation = new Map<UsageLimitDefinition, UsageBudget>();
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
        let attempt = snapshot;
        let decision: Decision;
        for (let tries = 1; ; tries++) {
          try {
            decision = await scheduler(attempt, signal);
          } catch (error) {
            signal?.throwIfAborted();
            throw error;
          }
          signal?.throwIfAborted();
          try {
            validateDecision(attempt, decision);
            break;
          } catch (error) {
            if (
              !(error instanceof DataflowDefinitionError) ||
              tries >= SCHEDULE_ATTEMPTS
            )
              throw error;
            attempt = Object.freeze({ ...snapshot, lastError: error });
          }
        }
        const schedule = decision.selected.map((entry) => [
          {
            id: entry.nodeId,
            inputs: new Map(
              entry.readEdges.map((edge) => [edge, "all" as const]),
            ),
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
        const byId = new Map(
          decision.selected.map((entry) => [entry.nodeId, entry]),
        );
        await options.prepare?.(decision.selected, signal);
        await execute(schedule, {
          usageBudgets: usageBudgets(decision.selected, evaluation),
          onColumn: (selected) => {
            if (selected.length > 0)
              history.push(
                Object.freeze({
                  selected: Object.freeze(
                    selected.map((nodeId) => {
                      const entry = byId.get(nodeId);
                      if (entry === undefined)
                        throw new DataflowDefinitionError(
                          `Scheduler: node "${nodeId}" ran but was not selected`,
                        );
                      return entry;
                    }),
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
