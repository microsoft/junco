import { fauxProvider } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { ModelId, ModelProvider } from "model-auth";
import { JuncoAgent } from "../src/index.ts";
import type { JuncoAgentOptions, JuncoControl, JuncoResult } from "../src/index.ts";

// Shared offline scaffolding for driving a real JuncoAgent through its generator protocol.
// No network/auth: resolveModel + harness.prompt resolve entirely offline.

export const PROMPT_TEXT = "list primes";

/** A prompt-independent offline provider that consumes fixed responses or factories in FIFO order. */
export function scriptedModelProvider(responses: readonly FauxResponseStep[]): ModelProvider {
  const faux = fauxProvider({
    api: "faux",
    provider: "faux",
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...responses]);
  return ModelProvider.custom({ provider: faux.provider });
}

/** Build a JuncoAgent over the faux model with no tools; overrides apply last. */
export function newAgent(
  provider: ModelProvider,
  overrides: Partial<JuncoAgentOptions> = {},
): JuncoAgent {
  return JuncoAgent({
    provider,
    model: ModelId("faux-1"),
    systemPrompt: "sys",
    prompt: PROMPT_TEXT,
    tools: [],
    ...overrides,
  });
}

export type Resume = (yielded: string, turn: number) => readonly JuncoControl[] | undefined;

/** Drive a JuncoAgent until it returns its completion value. */
export async function drive(
  agent: JuncoAgent,
  resume: Resume = () => undefined,
): Promise<{
  readonly result: JuncoResult;
  readonly emitted: readonly string[];
}> {
  const emitted: string[] = [];
  let step = await agent.next();
  let turn = 0;
  while (!step.done) {
    emitted.push(step.value);
    step = await agent.next(resume(step.value, turn));
    turn += 1;
  }
  return { result: step.value, emitted };
}
