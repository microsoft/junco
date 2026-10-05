import type { ErrorFn, Message, NodeOptions, NodeSpec } from "../src/index.ts";
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

const notice = EdgeId("notice");

/** A synchronous handler returning an ordinary empty batch. */
export const syncEmptyHandler: ErrorFn<{ count: number }, number, string> =
  function (error, signal) {
    const count: number = this.state.count;
    void count;
    void error;
    signal?.throwIfAborted();
    return [];
  };

/** An asynchronous handler returning a readonly tuple of messages. */
export const asyncTupleHandler: ErrorFn<{ count: number }, number, string> =
  async function () {
    return [
      { id: notice, payload: this.state.count },
      { id: notice, payload: 2 },
    ] as const;
  };

/** Method-form `on_error` sees the spec's typed state. */
export const methodHandlerSpec: NodeSpec<{ count: number }, number, string> = {
  trigger: always(),
  state: { count: 0 },
  // biome-ignore lint/correctness/useYield: the body throws on its first activation.
  step: async function* () {
    throw new Error("boom");
  },
  on_error(error) {
    this.state.count += 1;
    const batch: readonly Message<number>[] = [
      { id: notice, payload: error instanceof Error ? 1 : 0 },
    ];
    return batch;
  },
};

// @ts-expect-error a handler returns messages, never a result `T`.
export const returnsResult: ErrorFn<null, number, string> = () => "fallback";

// @ts-expect-error a handler returns a bare batch, not a wrapper object.
export const returnsWrapper: ErrorFn<null, number, string> = () => ({
  messages: [{ id: notice, payload: 1 }],
});

export const wrongPayload: ErrorFn<null, number, string> = () => [
  // @ts-expect-error messages must carry payload `N`.
  { id: notice, payload: "one" },
];
