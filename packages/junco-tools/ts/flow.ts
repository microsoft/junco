import type { NativeFlowDecision, NativeFlowEvent } from "../native/index.js";
import type { NativeModule } from "./native.js";

/** Decides a candidate against capability facts using junco-policy's CaMeL flow rule. */
export async function flowDecision(
  history: readonly NativeFlowEvent[],
  candidate: NativeFlowEvent,
  native?: NativeModule,
): Promise<NativeFlowDecision> {
  const addon = native ?? (await import("junco-tools/native"));
  return addon.flowDecision([...history], candidate);
}
