import {
  type Context,
  contentText,
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolCall,
  type UserMessage,
} from "@earendil-works/pi-ai";
// Types only: root fixtures load this module under Node, which cannot run the package's `.ts` sources.
import type { SchedulerRequest } from "../src/agent.ts";

let providers = 0;

/** A faux model serving `responses` in order; `provider` defaults to a unique name. */
export function scripted(
  responses: readonly FauxResponseStep[] = [],
  provider = `faux-${++providers}`,
) {
  const faux = fauxProvider({
    api: provider,
    provider,
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

/** A faux assistant turn calling `calls`. */
export const toolTurn = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

/** The user texts of `messages`, in order. */
export const userTexts = (
  messages: readonly { readonly role: string }[],
): string[] =>
  messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [contentText((message as UserMessage).content, "")],
  );

/** An explicit, credential-free Models collection; no harness or session. */
export function nativeOptions(responses: readonly FauxResponseStep[] = []) {
  const { faux, models, model } = scripted(responses);
  return { faux, options: { models, model } };
}

/** Parse only the request-local snapshot, retaining the caller's metadata contract. */
export function schedulerRequestOf<C>(context: Context): SchedulerRequest<C> {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role !== "user" || typeof message.content !== "string")
      continue;
    if (message.content.startsWith("SchedulerSnapshot:\n"))
      return JSON.parse(message.content.slice("SchedulerSnapshot:\n".length));
  }
  throw new Error("request carries no SchedulerSnapshot");
}

export type Plan = { readonly waves: readonly (readonly string[])[] };
export const runAvailable = <C>(request: SchedulerRequest<C>): Plan => ({
  waves: [request.nodes.map((node) => node.id)],
});

export const scheduleCall = (
  waves: readonly (readonly string[])[],
  id: string,
) => fauxToolCall("schedule", { waves }, { id });
