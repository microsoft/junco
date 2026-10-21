// `workflows`: the standard library's declarative graphs, as YAML text for `JuncoGraph.fromYaml`.
import source from "./ralph.yml" with { type: "text" };

/** Ralph: one agent revising its complete answer in a `Ralph -> Ralph` loop; drive with `schedules.ralph`. */
export const ralph: string = source;
