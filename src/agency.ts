import type { PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NodeIdType } from "dataflow-engine";
import { JuncoAgentError } from "junco-agent";
import {
  PiScheduler,
  type PiSchedulerAdapter,
  type PiSchedulerOptions,
} from "junco-scheduler/agent";
import type { AgenticInput } from "./agentic.js";
import { cascadeMembers, type JuncoGraph } from "./junco-graph.js";
import { nodeInputs, nodePolicies } from "./node-policy.js";

/**
 * A `PiScheduler` driving the graph `getGraph()` returns. Construct the graph with this scheduler
 * right after creating it, keeping the getter live:
 *
 * ```ts
 * let graph: JuncoGraph<…, PiScheduler<…>> | undefined;
 * const scheduler = await createAgencyScheduler(() => graph, options);
 * const constructed = new JuncoGraph(
 *   scheduler, window, threads, tracer.createTracer(), options.policy, options.collection,
 * );
 * graph = constructed;
 * ```
 *
 * With a native `model`, it is built by `PiScheduler.make` over the resolved model and session;
 * otherwise by `PiScheduler.opus` (GitHub Copilot `claude-opus-5.5` through Pi's saved login).
 * The agency supplies the scheduler's adapter:
 * - before every SchedulerInfo snapshot, run admission and graph window, it requires the getter to
 *   return a graph driven by this scheduler, failing with `invalid_state` otherwise;
 * - each available node is described by its native `description`, plus a prompt agent's status and
 *   latest pause reasons, and nothing about any other node;
 * - an `allOf` node reads everything or nothing, an `anyOf` node reads its first satisfied edge
 *   whose value it has not already received;
 * - abort and close cascade to the graph's members, through the graph's own lifecycle.
 */
export async function createAgencyScheduler<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  N = AgenticInput,
  T = AssistantMessage,
>(
  getGraph: () => JuncoGraph<N, T> | undefined,
  options: Omit<PiSchedulerOptions<N, T, S, P>, "adapter">,
): Promise<PiScheduler<N, T, S, P>> {
  let scheduler: PiScheduler<N, T, S, P> | undefined;
  /** The graph this scheduler drives, if it is constructed and bound to this scheduler. */
  const bound = (): JuncoGraph<N, T> | undefined => {
    const graph = getGraph();
    if (graph === undefined) return undefined;
    if (graph.scheduler !== scheduler) {
      throw new JuncoAgentError(
        "invalid_state",
        "Agency scheduler is bound to a different graph",
      );
    }
    return graph;
  };
  const adapter: PiSchedulerAdapter<N, T> = {
    beforeSchedule: () => {
      if (bound() === undefined)
        throw new JuncoAgentError(
          "invalid_state",
          "Agency graph is not constructed",
        );
    },
    describeNode: (id: NodeIdType) => {
      const node = getGraph()?.getNode(id);
      if (node === undefined) return undefined;
      const policy = nodePolicies.get(node.step);
      const details = {
        ...(node.description === undefined
          ? {}
          : { description: node.description }),
        ...(policy?.agent === undefined
          ? {}
          : { agentStatus: policy.agent.status }),
        ...(policy?.lastYield === undefined
          ? {}
          : { lastYield: policy.lastYield }),
      };
      return Object.keys(details).length === 0 ? undefined : details;
    },
    readInputs: (id, candidate) =>
      nodeInputs(getGraph()?.getNode(id)?.step, candidate),
    abortDependents: () => bound()?.[cascadeMembers]("abort"),
    closeDependents: () => bound()?.[cascadeMembers]("close"),
  };
  // `adapter` last, so no caller-supplied adapter can replace the agency's callbacks.
  const full = { ...options, adapter };
  const made =
    options.model !== undefined
      ? await PiScheduler.make<N, T, S, P>(full)
      : await PiScheduler.opus<N, T, S, P>(full);
  scheduler = made;
  return made;
}
