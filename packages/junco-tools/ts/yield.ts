import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const yieldParameters = Type.Object(
  { reason: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** Details of a completed `yield` call: the reason the model gave. */
export type YieldToolDetails = { readonly reason: string };

/** Tools this module created. Only these are scheduling primitives; a same-named tool is not. */
const yieldTools = new WeakSet<object>();

/** The explicit voluntary-suspension tool. */
export type YieldTool = AgentTool<typeof yieldParameters, YieldToolDetails>;

/**
 * Constructs a fresh `yield` tool for an explicitly assembled toolset. Executing it only returns
 * the reason; a `JuncoAgent` treats a successful call as a cooperative scheduling boundary, pausing
 * after the turn's tool batch completes and before its next model request until its iterator is
 * resumed. A plain Pi agent simply continues.
 */
export const YieldTool: new () => YieldTool = class {
  name = "yield";
  label = "yield";
  description =
    "Pause after this turn's tool calls finish and hand control back to the scheduler. " +
    "Give the reason you are pausing; you continue from here when resumed.";
  parameters = yieldParameters;
  execute: YieldTool["execute"] = async (_toolCallId, { reason }) => ({
    content: [{ type: "text", text: reason }],
    details: { reason },
  });

  constructor() {
    yieldTools.add(this);
  }
};

/** Whether `tool` is a `yield` tool constructed by {@link YieldTool}. */
export function isYieldTool(tool: object): boolean {
  return yieldTools.has(tool);
}
