import { Type } from "typebox";
import type { ErrorFn, Message, NodeOptions, NodeSpec } from "../src/index.ts";
import { EdgeId, NodeId, TriggerRule } from "../src/index.ts";

const NumberSchema = Type.Number();
type Num = typeof NumberSchema;

// Exported so `noUnusedLocals` does not report the fixtures as dead. Nothing imports this file; it
// exists to be compiled.

/** Trigger is the only required option; numeric messages and string results stay generic. */
export const triggerOnly: NodeOptions<Num, string> = {
  trigger: TriggerRule.always(),
};

/** Every common option at once, including an explicitly empty description. */
export const fullySpecified: NodeOptions<Num, string> = {
  id: NodeId.create("fully-specified"),
  description: "",
  trigger: TriggerRule.always(),
  is_available: (view, triggered) =>
    triggered && view.messages.get(EdgeId.create("in"))?.[0] !== 0,
};

export const triggerOnlySpec: NodeSpec<null, Num, string> = {
  ...triggerOnly,
  state: null,
  // biome-ignore lint/correctness/useYield: the source returns on its first activation.
  step: async function* () {
    return "done";
  },
};

export const fullySpecifiedSpec: NodeSpec<{ count: number }, Num, string> = {
  ...fullySpecified,
  state: { count: 0 },
  step: async function* () {
    const view = yield [];
    return String(view.values.get(EdgeId.create("in")));
  },
};

// @ts-expect-error trigger is required.
export const missingTrigger: NodeOptions<Num, string> = {
  description: "no trigger",
};

const notice = EdgeId.create("notice");

/** A synchronous handler returning an ordinary empty batch. */
export const syncEmptyHandler: ErrorFn<{ count: number }, Num, string> =
  function (error, signal) {
    const count: number = this.state.count;
    void count;
    void error;
    signal?.throwIfAborted();
    return [];
  };

/** An asynchronous handler returning a readonly tuple of messages. */
export const asyncTupleHandler: ErrorFn<{ count: number }, Num, string> =
  async function () {
    return [
      { id: notice, payload: this.state.count },
      { id: notice, payload: 2 },
    ] as const;
  };

/** Method-form `on_error` sees the spec's typed state. */
export const methodHandlerSpec: NodeSpec<{ count: number }, Num, string> = {
  trigger: TriggerRule.always(),
  state: { count: 0 },
  // biome-ignore lint/correctness/useYield: the body throws on its first activation.
  step: async function* () {
    throw new Error("boom");
  },
  on_error(error) {
    this.state.count += 1;
    const batch: readonly Message<Num>[] = [
      { id: notice, payload: error instanceof Error ? 1 : 0 },
    ];
    return batch;
  },
};

// @ts-expect-error a handler returns messages, never a result `T`.
export const returnsResult: ErrorFn<null, Num, string> = () => "fallback";

// @ts-expect-error a handler returns a bare batch, not a wrapper object.
export const returnsWrapper: ErrorFn<null, Num, string> = () => ({
  messages: [{ id: notice, payload: 1 }],
});

export const wrongPayload: ErrorFn<null, Num, string> = () => [
  // @ts-expect-error messages must carry payload `N`.
  { id: notice, payload: "one" },
];
