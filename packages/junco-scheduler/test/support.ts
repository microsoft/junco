import {
  type Context,
  createModels,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { pi, type PiOptions, type SchedulerRequest } from "../src/agent.ts";

let providers = 0;

/** An explicit, credential-free Models collection; no harness or session. */
export function nativeOptions(responses: readonly FauxResponseStep[] = []) {
  const name = `scheduler-faux-${++providers}`;
  const faux = fauxProvider({
    api: name,
    provider: name,
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, options: { models, model: faux.getModel() } };
}

export const userTexts = (context: Context): string[] =>
  context.messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [typeof message.content === "string"
          ? message.content
          : message.content.map((block) => block.type === "text" ? block.text : "").join("")],
  );

/** Parse only the request-local snapshot, retaining the caller's metadata contract. */
export function schedulerRequestOf<C>(context: Context): SchedulerRequest<C> {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role !== "user" || typeof message.content !== "string") continue;
    if (message.content.startsWith("SchedulerSnapshot:\n"))
      return JSON.parse(message.content.slice("SchedulerSnapshot:\n".length));
  }
  throw new Error("request carries no SchedulerSnapshot");
}

export type Plan = { readonly waves: readonly (readonly string[])[] };
export const runAvailable = <C>(request: SchedulerRequest<C>): Plan => ({
  waves: [request.nodes.map((node) => node.id)],
});

export const scheduleCall = (waves: readonly (readonly string[])[], id: string) =>
  fauxToolCall("schedule", { waves }, { id });

export const toolTurn = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

export type Decide<C> = (request: SchedulerRequest<C>, index: number) => Plan;
export type Script<C> = Decide<C> | readonly FauxResponseStep[];

export function newScheduler<C = never>(
  script: Script<C> = runAvailable,
  extra: Omit<PiOptions, "models" | "model"> = {},
) {
  let requests = 0;
  const respond: FauxResponseFactory = (context) => {
    if (typeof script !== "function") throw new Error("expected a decision callback");
    faux.appendResponses([respond]);
    const decision = script(schedulerRequestOf<C>(context), requests++);
    return toolTurn(scheduleCall(decision.waves, `schedule-${requests}`));
  };
  const { faux, options } = nativeOptions(typeof script === "function" ? [respond] : script);
  return { scheduler: pi({ ...options, ...extra }), faux };
}
