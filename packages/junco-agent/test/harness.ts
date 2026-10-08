import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type AgenticOptions, JuncoAgent } from "../src/index.ts";

// Offline scaffolding: Pi's faux provider in an explicit Models collection, an in-memory session and
// caller-supplied tools. Nothing here loads junco-tools' native addon or needs credentials.

/** A faux model whose provider serves `responses` (messages or context-inspecting factories) in order. */
export function scripted(responses: readonly FauxResponseStep[]) {
  const faux = fauxProvider({
    api: "faux",
    provider: "faux",
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

/** Resolved options over `responses` with a fresh in-memory session and no native addon. */
export async function nativeOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
>(
  responses: readonly FauxResponseStep[],
  overrides: Partial<AgenticOptions<S, P, T>> = {},
): Promise<AgenticOptions<S, P, T> & { readonly faux: FauxProviderHandle }> {
  const { faux, models, model } = scripted(responses);
  return {
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model,
    systemPrompt: "sys",
    policy: "LockPolicy",
    ...overrides,
    faux,
  };
}

/** A JuncoAgent over `responses`; `options` apply last. */
export async function newAgent<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
>(
  responses: readonly FauxResponseStep[],
  options: Partial<AgenticOptions<S, P, T>> = {},
) {
  const { faux, ...native } = await nativeOptions<S, P, T>(responses);
  return {
    faux,
    agent: await JuncoAgent.fromResolved<S, P, T>({ ...native, ...options }),
  };
}

/** A caller-owned tool counting its executions. */
export function countingTool(name = "mock_tool") {
  const state = { executions: 0 };
  const tool: AgentTool = {
    name,
    label: name,
    description: "counts executions",
    parameters: Type.Object({}),
    execute: async () => {
      state.executions += 1;
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
  return { tool, state };
}
