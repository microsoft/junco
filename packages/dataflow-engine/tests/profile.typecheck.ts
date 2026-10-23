import { seconds } from "@buge/ts-units/time/index.js";
import {
  constantProfile,
  DataflowGraph,
  megabytes,
  NodeId,
  type NodeSpec,
  type ProfileData,
  StepNode,
  TriggerRule,
  tokens,
  UNBOUNDED,
} from "../src/index.ts";
import { stubProfile } from "./profile-support.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const spec: NodeSpec<void, number, string> = {
  state: undefined,
  trigger: TriggerRule.always(),
  async *step() {
    return "done";
  },
};
const plain = new DataflowGraph<void, number, string, never>(
  UNBOUNDED,
  UNBOUNDED,
);
plain.addNode(spec);
plain.addNode(
  new StepNode<void, number, string>(() => [], {
    state: undefined,
    trigger: TriggerRule.always(),
  }),
);
const profiled = new DataflowGraph<
  void,
  number,
  string,
  never,
  "memory" | "runtime"
>(UNBOUNDED, UNBOUNDED);
const profiles = {
  memory: stubProfile("memory", megabytes),
  runtime: stubProfile("runtime", seconds),
};
profiled.addNode({ ...spec, profiles });
profiled.addNode(
  new StepNode<void, number, string, "memory" | "runtime">(() => [], {
    state: undefined,
    trigger: TriggerRule.always(),
    profiles,
  }),
);
// @ts-expect-error runtime is required.
profiled.addNode({ ...spec, profiles: { memory: profiles.memory } });
// @ts-expect-error profiles is required.
profiled.addNode(spec);
profiled.addNode({
  ...spec,
  // @ts-expect-error profile resource must match its key.
  profiles: { memory: profiles.runtime, runtime: profiles.runtime },
});
// @ts-expect-error information cannot be measured in seconds.
stub<"memory">("memory", seconds);
const node = profiled.getNode(NodeId.create("node"))!;
export type _memoryProfile = Expect<
  Equal<typeof node.profiles.memory, ProfileData<"memory">>
>;
const memory = new DataflowGraph<void, number, string, never, "memory">(
  UNBOUNDED,
  UNBOUNDED,
);
function acceptsDefault(
  _graph: DataflowGraph<void, number, string, never>,
): void {}
acceptsDefault(memory);
const fixedMemory = constantProfile("memory", megabytes(1));
export type _constantMemory = Expect<
  Equal<typeof fixedMemory, ProfileData<"memory">>
>;
// @ts-expect-error memory requires an information quantity, not tokens.
constantProfile("memory", tokens(1));
