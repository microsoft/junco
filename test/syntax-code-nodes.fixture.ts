import { Deterministic, graph } from "junco";
import type { TSchema } from "typebox";
import type { DeterministicNode } from "../src/syntax/build.ts";
import { assistant } from "./deterministic-support.ts";

/** Records where it was registered and returns `<label>/<node>` on its single activation. */
export const Emitter: DeterministicNode<{ log: string[] }> = ({
  label,
  node,
  policy,
  context,
}) => {
  context.log.push(`${label}/${node}`);
  return new Deterministic<TSchema, unknown>(async function* () {
    yield [];
    return assistant(`${label}/${node}`);
  }, policy);
};

/** Returns `value`, unchanged, on its single activation. */
export const Constant =
  (value: unknown): DeterministicNode =>
  ({ policy }) =>
    new Deterministic<TSchema, unknown>(async function* () {
      yield [];
      return value;
    }, policy);

/** The parent value on `id`, or else its first message, raw. */
function payload(view: graph.ParentView<TSchema, unknown>, id: string) {
  const key = graph.EdgeId.create(id);
  return view.values.has(key)
    ? view.values.get(key)
    : view.messages.get(key)?.[0];
}

/** Returns, raw, the payloads on `ids` in order. */
export const Collect =
  (...ids: string[]): DeterministicNode =>
  ({ policy }) =>
    new Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      return ids.map((id) => payload(view, id));
    }, policy);

/** Returns, raw, the payload on `id`. */
export const Forward =
  (id: string): DeterministicNode =>
  ({ policy }) =>
    new Deterministic<TSchema, unknown>(async function* () {
      return payload(yield [], id);
    }, policy);

/** Forwards every message on `from`, raw, onto message edge `to`; never returns. */
export const Relay =
  (from: string, to: string): DeterministicNode =>
  ({ policy, edges }) => {
    const input = graph.EdgeId.create(from);
    const output = edges.get(to);
    if (output === undefined) throw new TypeError(`unknown edge "${to}"`);
    return new Deterministic<TSchema, unknown>(async function* () {
      let view = yield [];
      while (true)
        view = yield (view.messages.get(input) ?? []).map((payload) =>
          graph.Message.create(output, payload),
        );
    }, policy);
  };

/** Returns its single message on `id` plus one; anything but a number is rejected. */
export const Increment =
  (id: string): DeterministicNode =>
  ({ policy }) =>
    new Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const [count] = view.messages.get(graph.EdgeId.create(id)) ?? [];
      if (typeof count !== "number")
        throw new TypeError(`${id} must carry a number`);
      return count + 1;
    }, policy);
