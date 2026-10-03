import type { NodeOptions, NodeSpec } from "../src/index.ts";
import { always, EdgeId, NodeId } from "../src/index.ts";

// Exported so `noUnusedLocals` does not report the fixtures as dead. Nothing imports this file; it
// exists to be compiled.

/** Trigger is the only required option; numeric messages and string results stay generic. */
export const triggerOnly: NodeOptions<number, string> = { trigger: always() };

/** Every common option at once, including an explicitly empty description. */
export const fullySpecified: NodeOptions<number, string> = {
  id: NodeId("fully-specified"),
  description: "",
  trigger: always(),
  is_available: (view, triggered) =>
    triggered && view.messages.get(EdgeId("in"))?.[0] !== 0,
};

export const triggerOnlySpec: NodeSpec<null, number, string> = {
  ...triggerOnly,
  state: null,
  // biome-ignore lint/correctness/useYield: the source returns on its first activation.
  step: async function* () {
    return "done";
  },
};

export const fullySpecifiedSpec: NodeSpec<{ count: number }, number, string> = {
  ...fullySpecified,
  state: { count: 0 },
  step: async function* () {
    const view = yield [];
    return String(view.values.get(EdgeId("in")));
  },
};

// @ts-expect-error trigger is required.
export const missingTrigger: NodeOptions<number, string> = {
  description: "no trigger",
};
