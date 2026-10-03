import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

/** A fresh instance-scoped faux provider and stream function; no credentials or network. */
export function scriptedModel() {
  const faux = fauxProvider({
    api: "junco-test",
    provider: "junco-test",
    tokenSize: { min: 4, max: 4 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
  };
}

/**
 * Queue one assistant tool-use turn followed by a response factory that records the
 * next request context. Assertions belong to the caller: faux turns a thrown assertion
 * inside the factory into a model error event.
 */
export function scriptBashTurn(faux, calls) {
  const capture = {};
  faux.setResponses([
    fauxAssistantMessage(
      calls.map(({ id, command, timeout }) =>
        fauxToolCall(
          "bash",
          { command, ...(timeout === undefined ? {} : { timeout }) },
          { id },
        ),
      ),
      { stopReason: "toolUse" },
    ),
    (context) => {
      capture.context = context;
      return fauxAssistantMessage("verified");
    },
  ]);
  return capture;
}

export const toolResult = (messages, toolCallId) =>
  messages.findLast(
    (message) =>
      message.role === "toolResult" && message.toolCallId === toolCallId,
  );

export const assistantText = (message) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
