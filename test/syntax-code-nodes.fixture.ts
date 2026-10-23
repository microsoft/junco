import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgenticInput, Deterministic } from "junco-agency";
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
    state: new Deterministic<AgenticInput, AssistantMessage>(
      async function* () {
        yield [];
        finished = true;
        return assistant(`${label}/${node}`);
      },
      policy,
    ),
    is_available: () => !finished,
    contract: () => ({ expect: "x" }),
  };
};
