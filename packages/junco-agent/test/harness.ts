import assert from "node:assert/strict";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import {
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { isComplainTool } from "junco-tools";
import { Type } from "typebox";
import { scripted } from "../../../test/support.ts";
import {
  type AgenticOptions,
  type AgenticStep,
  JuncoAgent,
  JuncoAgentError,
} from "../src/index.ts";

export function step(result: IteratorResult<AgenticStep, void>): AgenticStep {
  assert.ok(!result.done);
  return result.value;
}

export function settledText(result: IteratorResult<AgenticStep, void>): string {
  const value = step(result);
  assert.equal(value.kind, "settled");
  return value.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

export const isCode =
  (code: JuncoAgentError["code"]) =>
  (error: unknown): boolean =>
    error instanceof JuncoAgentError && error.code === code;

/** Asserts the optional tools in order, followed by exactly one genuine complain tool. */
export function assertTools(
  actual: readonly object[],
  expected: readonly object[],
) {
  assert.deepEqual(actual.slice(0, -1), expected);
  assert.equal(isComplainTool(actual.at(-1)!), true);
  assert.equal(actual.filter((tool) => isComplainTool(tool)).length, 1);
}

// Offline scaffolding: Pi's faux provider in an explicit Models collection, an in-memory session and
// caller-supplied tools. Nothing here loads junco-tools' native addon or needs credentials.

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
