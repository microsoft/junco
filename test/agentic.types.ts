// Compile-only: specialized skills, prompt templates and tools keep their extra fields through
// JuncoAgent and attached PiScheduler agencies. Covered by tsconfig.typecheck.json; never executed.

import type { AgentTool, PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Agentic, AgenticStep, JuncoAgent } from "junco-agent";
import { attachAgency, type AgencyGraph, type PiScheduler, type ScheduleTool } from "../src/index.ts";

type TaggedSkill = Skill & { readonly tag: "skill" };
type TaggedTemplate = PromptTemplate & { readonly tag: "template" };
type TaggedTool = AgentTool & { readonly tag: "tool" };

export function juncoAgentKeepsSpecializations(agent: JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>) {
  const tool: "tool" | undefined = agent.getTools()[0]?.tag;
  const skill: "skill" | undefined = agent.getResources().skills?.[0]?.tag;
  const template: "template" | undefined = agent.getResources().promptTemplates?.[0]?.tag;
  const agentic: Agentic<TaggedSkill, TaggedTemplate, TaggedTool> = agent;
  return [tool, skill, template, agentic];
}

export function agencyKeepsSpecializations(
  scheduler: PiScheduler<TaggedSkill, TaggedTemplate>,
  graph: AgencyGraph<TaggedSkill, TaggedTemplate>,
) {
  const agency = attachAgency(graph);
  const skill: "skill" | undefined = agency.getResources().skills?.[0]?.tag;
  const template: "template" | undefined = scheduler.getResources().promptTemplates?.[0]?.tag;
  const tools: ScheduleTool[] = agency.getTools();
  const specialized: PiScheduler<TaggedSkill, TaggedTemplate> = graph.scheduler;
  const agentic: Agentic<TaggedSkill, TaggedTemplate, ScheduleTool> = agency;
  const iterator: AsyncGenerator<AgenticStep, void, void> = agency;
  const settlement: Promise<AssistantMessage> = agency.prompt("typed");
  return [skill, template, tools, specialized, agentic, iterator, settlement];
}
