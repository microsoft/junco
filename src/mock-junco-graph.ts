import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NodeIdType } from "dataflow-engine";
import type { AgenticInputSchema } from "junco-agent";
import type { TSchema } from "typebox";
import type { AgenticNode } from "./agentic.js";
import { JuncoGraph } from "./junco-graph.js";
import { MockAgent, NO_USAGE } from "./mock-agent.js";

/**
 * A JuncoGraph whose every node is profiled: a MockAgent member gets the constant profiles of
 * its transcript's `usage`, any other node without `profiles` (ports, coroutines, nested
 * graphs, real agents) gets zero memory and zero tokens. Strict resource schedules
 * (`schedules.limit`, `schedules.lowest`) therefore accept the whole graph.
 */
export class MockJuncoGraph<
  N extends TSchema = typeof AgenticInputSchema,
  T = AssistantMessage,
  EH = never,
> extends JuncoGraph<N, T, EH> {
  override addNode(spec: AgenticNode<N, T>): NodeIdType {
    if (spec.profiles !== undefined && Object.keys(spec.profiles).length > 0)
      return super.addNode(spec);
    const profiles =
      spec.state instanceof MockAgent &&
      Object.keys(spec.state.profiles).length > 0
        ? spec.state.profiles
        : NO_USAGE;
    return super.addNode({ ...spec, profiles } as AgenticNode<N, T>);
  }
}
