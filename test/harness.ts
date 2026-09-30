import { tmpdir } from "node:os";
import {
  type AgentHarnessOptions,
  type AgentTool,
  InMemorySessionRepo,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
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
  const faux = fauxProvider({ api: "faux", provider: "faux", tokenSize: { min: 4, max: 4 } });
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

/** Native harness options over `responses` with a fresh in-memory session and no tools. */
export async function nativeOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
>(
  responses: readonly FauxResponseStep[],
  overrides: Partial<AgentHarnessOptions<S, P, T>> = {},
): Promise<AgentHarnessOptions<S, P, T> & { readonly faux: FauxProviderHandle }> {
  const { faux, models, model } = scripted(responses);
  return {
    env: new NodeExecutionEnv({ cwd: tmpdir() }),
    session: await new InMemorySessionRepo().create(),
    models,
    model,
    systemPrompt: "sys",
    ...overrides,
    faux,
  };
}

/** A JuncoAgent over `responses`; `options` apply last. */
export async function newAgent<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
>(responses: readonly FauxResponseStep[], options: Partial<AgenticOptions<S, P, T>> = {}) {
  const { faux, ...native } = await nativeOptions<S, P, T>(responses);
  return { faux, agent: new JuncoAgent<S, P, T>({ ...native, ...options }) };
}

/** A tool whose every execution waits for the returned `release`, counting executions. */
export function gatedTool(name: string) {
  const gates: PromiseWithResolvers<void>[] = [];
  const started: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const state = { executions: 0, started: started.promise };
  const tool: AgentTool = {
    name,
    label: name,
    description: `${name} waits for the test`,
    parameters: Type.Object({}),
    execute: async () => {
      state.executions += 1;
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      started.resolve();
      await gate.promise;
      return { content: [{ type: "text", text: `${name} done` }], details: undefined };
    },
  };
  return { tool, state, release: () => gates.shift()?.resolve() };
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
