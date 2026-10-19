import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgenticInput, Deterministic } from "junco-agency";
import type { DeterministicNode } from "../../src/build.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Records where it was registered and returns `<label>/<node>` on its single activation. */
export const Emitter: DeterministicNode<{ log: string[] }> = {
  create({ label, node, policy, context }) {
    context.log.push(`${label}/${node}`);
    let finished = false;
    return {
      state: new Deterministic<AgenticInput, AssistantMessage>(
        async function* () {
          yield [];
          finished = true;
          return {
            role: "assistant",
            content: [{ type: "text", text: `${label}/${node}` }],
            api: "mock",
            provider: "mock",
            model: "mock",
            usage,
            stopReason: "stop",
            timestamp: 0,
          };
        },
        policy,
      ),
      is_available: () => !finished,
      contract: () => ({ expect: "x" }),
    };
  },
};

export const NotANode = 42;
