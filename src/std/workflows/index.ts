// `workflows`: the standard library's declarative graphs, as YAML text for `junco-syntax`'s `parse`.
import source from "./ralph.yml" with { type: "text" };

/** Ralph: one agent revising its complete answer in a `Ralph -> Ralph` loop. `params.model`; drive with `schedules.ralph`. */
export const ralph: string = source;
