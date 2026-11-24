import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";

const yieldParameters = Type.Object(
  {
    reason: Type.String({ minLength: 1 }),
    waitForInput: Type.Optional(
      Type.Literal(true, {
        description: "Wait for the graph node's input trigger before resuming.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** A completed explicit yield, optionally parked until the next graph input. */
export type YieldToolDetails = {
  readonly reason: string;
  readonly waitForInput?: true;
};

/** Tools this module created. Only these are scheduling primitives; a same-named tool is not. */
const yieldTools = new WeakSet<object>();

const yieldOperation = {
  resource: "operations",
  category: "yield",
  tool: "yield",
  operation: "execute",
} as const;

/** The explicit voluntary-suspension tool. */
export type YieldTool = AgentTool<typeof yieldParameters, YieldToolDetails>;

/**
 * Constructs a fresh `yield` tool for an explicitly assembled toolset. Executing it only returns
 * the reason; a `JuncoAgent` treats a successful call as a cooperative scheduling boundary, pausing
 * after the turn's tool batch completes and before its next model request until its iterator is
 * resumed. A plain Pi agent simply continues.
 */
export const YieldTool: new (
  recorder?:
    | ProfileRecorder<"operations">
    | (() => ProfileRecorder<"operations"> | undefined),
) => YieldTool = class {
  name = "yield";
  label = "yield";
  description =
    "Pause after this turn's tool calls finish and hand control back to the scheduler. " +
    "Give the reason you are pausing; you continue from here when resumed.";
  parameters = yieldParameters;
  execute: YieldTool["execute"];

  constructor(
    recorder?:
      | ProfileRecorder<"operations">
      | (() => ProfileRecorder<"operations"> | undefined),
  ) {
    this.execute = (_toolCallId, params, signal) =>
      profileToolCall(
        captureRecorder(recorder),
        yieldOperation,
        signal,
        async () => {
          const { reason } = params;
          return {
            content: [{ type: "text", text: reason }],
            details: params.waitForInput
              ? { reason, waitForInput: params.waitForInput }
              : { reason },
          };
        },
      );
    yieldTools.add(this);
    markProfileOwned(this, () => yieldOperation);
  }
};

/** Whether `tool` is a `yield` tool constructed by {@link YieldTool}. */
export function isYieldTool(tool: object): boolean {
  return yieldTools.has(tool);
}
