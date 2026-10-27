import type { AgentTool, PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Agentic, agent, JuncoGraph, schedules } from "junco-agency";
import type { TSchema } from "typebox";

/** A native member as YAML graphs host it: runtime-loaded inbox schemas and unknown parent values. */
export type YamlAgent = agent.JuncoAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;

/** A workflow as `JuncoGraph.fromYaml` builds it: runtime-loaded edge schemas and unknown results. */
export type YamlExecution = schedules.SchedulerContext<
  Agentic<TSchema, unknown>,
  TSchema,
  unknown,
  schedules.AgencyNodeMetadata,
  JuncoGraph<TSchema, unknown>
>;

/** A CLI-scoped cancellation signal; importing examples installs no signal handler. */
export function ctrlC(): { readonly signal: AbortSignal; [Symbol.dispose](): void } {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException("Interrupted by Ctrl-C", "AbortError"));
  process.on("SIGINT", interrupt);
  return {
    signal: controller.signal,
    [Symbol.dispose]() {
      process.off("SIGINT", interrupt);
    },
  };
}

/** Run `main` under Ctrl-C cancellation: print the failure (just the message of a plain error), exit 130 when interrupted, 1 on any other failure. */
export async function runCli(main: (signal: AbortSignal) => Promise<void>): Promise<void> {
  using cancellation = ctrlC();
  try {
    await main(cancellation.signal);
  } catch (error) {
    console.error(error instanceof Error && error.constructor === Error && error.cause === undefined ? error.message : error);
    process.exitCode = cancellation.signal.aborted ? 130 : 1;
  }
  if (cancellation.signal.aborted) process.exitCode = 130;
}

/** A network-refreshed `ModelRuntime` whose catalog, saved login and thinking support cover `rung`. */
export async function verifiedModels(rung: schedules.LadderRung, signal?: AbortSignal): Promise<ModelRuntime> {
  const models = await ModelRuntime.create({ allowModelNetwork: true, refreshOnCreate: false, signal });
  const refreshed = await models.refresh({ allowNetwork: true, signal });
  if (refreshed.aborted || refreshed.errors.size > 0) {
    throw new AggregateError([
      ...(refreshed.aborted ? [new Error("Model catalog refresh aborted")] : []),
      ...[...refreshed.errors].map(([provider, error]) => new Error(`${provider}: ${error.message}`, { cause: error })),
    ], "Model catalog refresh failed");
  }
  signal?.throwIfAborted();
  const slash = rung.model.indexOf("/");
  const provider = rung.model.slice(0, slash);
  const modelId = rung.model.slice(slash + 1);
  if (!(await models.listCredentials({ signal })).some(({ providerId }) => providerId === provider)) {
    throw new Error(`A saved ${provider} Pi login is required`);
  }
  const model = (await models.getAvailable(provider, { signal })).find(({ id }) => id === modelId);
  if (!model) throw new Error(`${rung.model} is unavailable`);
  const thinking = rung.thinking ?? "off";
  if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error(`${rung.model} does not support ${thinking} thinking`);
  return models;
}
