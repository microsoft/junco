import { Deterministic, graph } from "junco-agency";
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
  let finished = false;
  return {
    state: new Deterministic<TSchema, unknown>(async function* () {
      yield [];
      finished = true;
      return assistant(`${label}/${node}`);
    }, policy),
    is_available: () => !finished,
    contract: () => ({ expect: "x" }),
  };
};

/** Returns `value`, unchanged, on its single activation. */
export const Constant =
  (value: unknown): DeterministicNode =>
  ({ policy }) => {
    let finished = false;
    return {
      state: new Deterministic<TSchema, unknown>(async function* () {
        yield [];
        finished = true;
        return value;
      }, policy),
      is_available: () => !finished,
    };
  };

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
  ({ policy }) => ({
    state: new Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      return ids.map((id) => payload(view, id));
    }, policy),
  });

/** Returns, raw, the payload on `id`. */
export const Forward =
  (id: string): DeterministicNode =>
  ({ policy }) => ({
    state: new Deterministic<TSchema, unknown>(async function* () {
      return payload(yield [], id);
    }, policy),
  });

/** Returns its single message on `id` plus one; anything but a number is rejected. */
export const Increment =
  (id: string): DeterministicNode =>
  ({ policy }) => ({
    state: new Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      const [count] = view.messages.get(graph.EdgeId.create(id)) ?? [];
      if (typeof count !== "number")
        throw new TypeError(`${id} must carry a number`);
      return count + 1;
    }, policy),
  });
