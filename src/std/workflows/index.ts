// `workflows`: the standard library's declarative graphs, as YAML text for `JuncoGraph.fromYaml`.
import allFanInSource from "./all-fan-in.yml" with { type: "text" };
import anyFanInSource from "./any-fan-in.yml" with { type: "text" };
import optimizerSource from "./optimizer.yml" with { type: "text" };
import source from "./ralph.yml" with { type: "text" };

/** Ralph: one agent revising its complete answer in a `Ralph -> Ralph` loop; drive with `schedules.ralph`. */
export const ralph: string = source;
/** The profile optimizer: measures a prepared target and edits its tuning regions; drive with `schedules.runOptimizer`. */
export const optimizer: string = optimizerSource;
/** One selection of the best candidate once every candidate has returned. */
export const allFanIn: string = allFanInSource;
/** One streamed selection per newly delivered candidate batch; drive with `schedules.anyFanIn`. */
export const anyFanIn: string = anyFanInSource;
export { memoryFanIn, memoryFanOut, memoryRalphLoop } from "./memory.js";
