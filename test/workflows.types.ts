// Compile-only: the public Ralph workflow keeps branded ids and wire types, returns a registration id
// whose result is an AssistantMessage, and accepts concrete schedulers and specialized agents
// without widening the caller's variables. Covered by tsconfig.typecheck.json; never executed.

import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type Edge,
  messageEdge,
  NodeId,
  type NodeIdType,
} from "dataflow-engine";
import type * as O from "fp-ts/lib/Option.js";
import type { JuncoAgent } from "junco-agent";
import type { PiScheduler } from "junco-scheduler/agent";
import type { AgenticInput, JuncoGraph } from "../src/index.ts";
import { type RalphOptions, ralph } from "../src/workflows/index.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };
type Scheduler = PiScheduler<AgenticInput, AssistantMessage>;

export function ralphKeepsTypes(
  parent: JuncoGraph<AgenticInput, AssistantMessage, unknown, Scheduler>,
  agent: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
) {
  const input = messageEdge<AgenticInput, AssistantMessage>("in");
  const output = messageEdge<AgenticInput, AssistantMessage>("out");
  const options: RalphOptions = {
    id: NodeId("Ralph"),
    description: "two rounds",
    input,
    output,
    rounds: 2,
  };
  const id: NodeIdType = ralph(parent, agent, options);
  const anonymous: NodeIdType = ralph(parent, agent, { input, output });
  const result: O.Option<AssistantMessage> = parent.result(id);
  // The caller's own variables keep their concrete types.
  const scheduler: Scheduler = parent.scheduler;
  const tool: "tool" | undefined = agent.getTools()[0]?.tag;
  return [anonymous, result, scheduler, tool];
}

export function ralphRejectsMistypedOptions(
  parent: JuncoGraph,
  agent: JuncoAgent,
  input: Edge<AgenticInput, AssistantMessage>,
  output: Edge<AgenticInput, AssistantMessage>,
  numeric: Edge<number, string>,
  numericParent: JuncoGraph<number, string>,
) {
  // @ts-expect-error rounds is a number
  ralph(parent, agent, { input, output, rounds: "2" });
  // @ts-expect-error ids are branded NodeIds
  ralph(parent, agent, { id: "Ralph", input, output });
  // @ts-expect-error Ralph's edges carry AgenticInput messages and AssistantMessage results
  ralph(parent, agent, { input: numeric, output });
  // @ts-expect-error Ralph's edges carry AgenticInput messages and AssistantMessage results
  ralph(parent, agent, { input, output: numeric });
  // @ts-expect-error Ralph registers only in AgenticInput/AssistantMessage graphs
  ralph(numericParent, agent, { input, output });
}
