// Compile-only: the public Ralph workflow keeps branded ids and wire types, returns a registration id
// whose result is an AssistantMessage, and accepts concrete schedulers and specialized agents
// without widening the caller's variables. Covered by tsconfig.typecheck.json; never executed.

import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Edge, NodeId, type NodeIdType } from "dataflow-engine";
import type * as O from "fp-ts/lib/Option.js";
import type { JuncoAgent } from "junco-agent";
import type { PiScheduler } from "junco-scheduler/agent";
import { EmptyPolicy, isComplainTool, LockPolicy } from "junco-tools";
import type { AgenticInput, JuncoGraph } from "../src/index.ts";
import { Ralph, type RalphOptions } from "../src/workflows/index.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };
type Scheduler = PiScheduler<AgenticInput, AssistantMessage>;

export function ralphKeepsTypes(
  parent: JuncoGraph<AgenticInput, AssistantMessage, unknown, Scheduler>,
  agent: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>,
) {
  const input = Edge.message<AgenticInput, AssistantMessage>("in");
  const output = Edge.message<AgenticInput, AssistantMessage>("out");
  const options: RalphOptions = {
    id: NodeId.create("Ralph"),
    description: "two rounds",
    input,
    output,
    rounds: 2,
    policy: LockPolicy,
  };
  const id: NodeIdType = Ralph.register(parent, agent, options);
  const anonymous: NodeIdType = Ralph.register(parent, agent, {
    input,
    output,
    policy: EmptyPolicy,
  });
  const result: O.Option<AssistantMessage> = parent.result(id);
  // The caller's own variables keep their concrete types.
  const scheduler: Scheduler = parent.scheduler;
  const [first] = agent.getTools();
  const tool: "tool" | undefined =
    first === undefined || isComplainTool(first) ? undefined : first.tag;
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
  Ralph.register(parent, agent, {
    input,
    output,
    // @ts-expect-error rounds is a number
    rounds: "2",
    policy: LockPolicy,
  });
  Ralph.register(parent, agent, {
    // @ts-expect-error ids are branded NodeIds
    id: "Ralph",
    input,
    output,
    policy: LockPolicy,
  });
  // @ts-expect-error Ralph's edges carry AgenticInput messages and AssistantMessage results
  Ralph.register(parent, agent, { input: numeric, output, policy: LockPolicy });
  // @ts-expect-error Ralph's edges carry AgenticInput messages and AssistantMessage results
  Ralph.register(parent, agent, { input, output: numeric, policy: LockPolicy });
  // @ts-expect-error Ralph registers only in AgenticInput/AssistantMessage graphs
  Ralph.register(numericParent, agent, { input, output, policy: LockPolicy });
  // @ts-expect-error Ralph requires a policy
  Ralph.register(parent, agent, { input, output });
  // @ts-expect-error policies are the two case-sensitive literals
  Ralph.register(parent, agent, { input, output, policy: "Git" });
}
