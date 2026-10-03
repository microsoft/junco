import type {
  DataflowGraph,
  DataflowScheduler,
  NodeIdType,
} from "dataflow-engine";
import { JuncoAgent, JuncoAgentError } from "junco-agent";
import { settleAll } from "./agent-operations.js";
import type { Agentic } from "./agentic.js";
import { MockAgent } from "./mock-agent.js";

/**
 * Which direct prompt-agent node states {@link compactGraph} compacts:
 * - `"all"`: every node's member, including finished and unavailable nodes;
 * - `"more-than-forty"`: every node's member whose context exceeds 40% of its model's context window;
 * - `"all-available"`: the members of the nodes in one `graph.available()` snapshot;
 * - `"more-than-forty-available"`: the available nodes' members whose context exceeds 40% of their
 *   context window.
 */
export type CompactionPolicy =
  | "all"
  | "more-than-forty"
  | "all-available"
  | "more-than-forty-available";

/** A member is full when its context holds strictly more than this fraction of its window. */
const FULLNESS_THRESHOLD = 0.4;

/**
 * Request compaction of the direct prompt-agent node states of `graph` that `policy` selects.
 * Selection is a snapshot taken when called; each selected agent gets one queued `compact()`
 * request, all dispatched without waiting for one another. An agent with an admitted run compacts
 * only after that run ends, so keep driving the graph while awaiting the compaction. It never runs
 * the graph, consumes messages or results, or descends into child graphs; nested graphs and
 * deterministic coroutines are skipped, and a scheduler is compacted only when it is itself a node.
 *
 * @throws {JuncoAgentError} `invalid_argument` for an unknown policy; `invalid_state` when a
 *   fullness policy cannot measure a candidate's context window.
 */
export async function compactGraph<
  A extends Agentic<N, T>,
  N,
  T,
  EH,
  Q extends DataflowScheduler<N, T>,
>(
  graph: DataflowGraph<A, N, T, EH, Q>,
  policy: CompactionPolicy,
): Promise<void> {
  let availableOnly: boolean;
  let fullOnly: boolean;
  switch (policy) {
    case "all":
      [availableOnly, fullOnly] = [false, false];
      break;
    case "more-than-forty":
      [availableOnly, fullOnly] = [false, true];
      break;
    case "all-available":
      [availableOnly, fullOnly] = [true, false];
      break;
    case "more-than-forty-available":
      [availableOnly, fullOnly] = [true, true];
      break;
    default:
      policy satisfies never;
      throw new JuncoAgentError(
        "invalid_argument",
        "Unknown compaction policy",
      );
  }
  // Snapshot before the first await: later readiness or topology changes do not alter selection.
  const available = availableOnly ? graph.available() : undefined;
  const candidates: {
    readonly id: NodeIdType;
    readonly agent: JuncoAgent | MockAgent;
  }[] = [];
  graph.forEachNode((id, node) => {
    const state: unknown = node.state;
    if (!(state instanceof JuncoAgent || state instanceof MockAgent)) return;
    if (available === undefined || available.has(id))
      candidates.push({ id, agent: state });
  });
  let selected = candidates;
  if (fullOnly) {
    // Every decision precedes the first request, so an unmeasurable member changes nothing.
    const full = await Promise.all(
      candidates.map(async ({ id, agent }) => {
        const [tokens, model] = await Promise.all([
          agent.context_size(),
          agent.getModel(),
        ]);
        const capacity = model?.contextWindow;
        if (
          capacity === undefined ||
          !Number.isFinite(capacity) ||
          capacity <= 0
        ) {
          throw new JuncoAgentError(
            "invalid_state",
            `Cannot determine context fullness for node "${id}"`,
          );
        }
        return tokens > FULLNESS_THRESHOLD * capacity;
      }),
    );
    selected = candidates.filter((_, index) => full[index]);
  }
  // Requests start one microtask after selection.
  await undefined;
  await settleAll(
    selected,
    ({ agent }) => agent.compact(),
    "Graph compaction failed",
  );
}
