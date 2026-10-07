import type { NodeOptions } from "dataflow-engine";
import type { ToolCollectionOptions } from "junco-tools";
import type { AgenticNode } from "./agentic.js";
import type { Deterministic } from "./deterministic.js";

/**
 * A graph node whose state and body are one {@link Deterministic} coroutine. Its bound `step`
 * hands the coroutine to the engine once, so registering it a second time fails on activation.
 * Availability is the engine's unless `options.is_available` supplies it; `options.contract`
 * describes what the coroutine expects on each incoming edge.
 */
export function deterministicNode<N, T>(
  state: Deterministic<N, T>,
  options: NodeOptions<N, T> &
    Pick<ToolCollectionOptions, "policy"> &
    Pick<AgenticNode<N, T>, "contract">,
): AgenticNode<N, T> {
  return { ...options, state, step: state.step };
}
