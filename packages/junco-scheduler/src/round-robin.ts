import { DataflowDefinitionError, type NodeIdType } from "dataflow-engine";
import { type parallel } from "./parallel.js";
import { choose, type Snapshot } from "./scheduler.js";

/** A history-derived cursor: the same policy can serve independent contexts safely. */
export function roundRobin(
  order?: readonly NodeIdType[],
  width = 1,
): ReturnType<typeof parallel> {
  const explicit = order === undefined ? undefined : [...order];
  if (explicit !== undefined) {
    const seen = new Set<NodeIdType>();
    for (const id of explicit) {
      if (seen.has(id))
        throw new DataflowDefinitionError(`Round-robin order contains duplicate node "${id}"`);
      seen.add(id);
    }
  }
  return function schedule<S, N, T, C>(snapshot: Snapshot<S, N, T, C>) {
    const ids = explicit ?? [...snapshot.nodes.keys()]
      .filter((id) => snapshot.owned.has(id))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const indices = new Map(ids.map((id, index) => [id, index]));
    let cursor = 0;
    history: for (let i = snapshot.history.length - 1; i >= 0; i--) {
      const selected = snapshot.history[i]!.selected;
      for (let j = selected.length - 1; j >= 0; j--) {
        const index = indices.get(selected[j]!);
        if (index !== undefined) {
          cursor = (index + 1) % ids.length;
          break history;
        }
      }
    }
    return choose<S, N, T, C>({
      where: (_snapshot, id) => indices.has(id),
      rank: (_snapshot, left, right) =>
        (indices.get(left)! - cursor + ids.length) % ids.length -
        (indices.get(right)! - cursor + ids.length) % ids.length,
      width: () => width,
    })(snapshot);
  };
}
