// `workflows`: the standard library's declarative graphs, as YAML text for `JuncoGraph.fromYaml`.
import optimizerSource from "./optimizer.yml" with { type: "text" };
import source from "./ralph.yml" with { type: "text" };

/** Ralph: one agent revising its complete answer in a `Ralph -> Ralph` loop; drive with `schedules.ralph`. */
export const ralph: string = source;
/** The profile optimizer: measures a prepared target and edits its tuning regions; drive with `schedules.runOptimizer`. */
export const optimizer: string = optimizerSource;
