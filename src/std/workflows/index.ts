// `workflows`: the standard library's declarative graphs, as YAML text for `JuncoGraph.fromYaml`.
import allFanInSource from "./all-fan-in.yml" with { type: "text" };
import anyFanInSource from "./any-fan-in.yml" with { type: "text" };
import optimizerSource from "./optimizer.yml" with { type: "text" };
import source from "./ralph.yml" with { type: "text" };

/** Ralph revises one assignment in the same agent session until `schedules.ralph` accepts a round. */
export const ralph: string = source;
/** The profile optimizer: measures a prepared target and edits its tuning regions; drive with `schedules.runOptimizer`. */
export const optimizer: string = optimizerSource;
/** One selection of the best candidate once every candidate has returned. */
export const allFanIn: string = allFanInSource;
/** One streamed selection per newly delivered candidate batch; drive with `schedules.anyFanIn`. */
export const anyFanIn: string = anyFanInSource;
export { memoryFanIn, memoryFanOut, memoryRalphLoop } from "./memory.js";
