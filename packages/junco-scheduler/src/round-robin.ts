import { DataflowDefinitionError, type NodeIdType } from "dataflow-engine";
import type { TSchema } from "typebox";
import type { parallel } from "./parallel.js";
import { choose, type Snapshot } from "./scheduler.js";

/**
 * Up to `width` available nodes per decision, in rotation order (`order`, or sorted owned node ids)
 * starting after the last selected node. A history-derived cursor: the same policy can serve
 * independent contexts safely.
 */
export function roundRobin(
  order?: readonly NodeIdType[],
  width = 1,
): ReturnType<typeof parallel> {
  const explicit = order === undefined ? undefined : [...order];
  if (explicit !== undefined) {
    const seen = new Set<NodeIdType>();
    for (const id of explicit) {
      if (seen.has(id))
        throw new DataflowDefinitionError(
          `Round-robin order contains duplicate node "${id}"`,
        );
      seen.add(id);
    }
  }
  return function schedule<S, N extends TSchema, T, C>(
    snapshot: Snapshot<S, N, T, C>,
  ) {
    const ids =
      explicit ??
      [...snapshot.nodes.keys()]
        .filter((id) => snapshot.owned.has(id))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const indices = new Map(ids.map((id, index) => [id, index]));
    let cursor = 0;
    history: for (let i = snapshot.history.length - 1; i >= 0; i--) {
      const selected = snapshot.history[i].selected;
      for (let j = selected.length - 1; j >= 0; j--) {
        const index = indices.get(selected[j].nodeId);
        if (index !== undefined) {
          cursor = (index + 1) % ids.length;
          break history;
        }
      }
    }
    const distance = (id: NodeIdType) => {
      const index = indices.get(id);
      if (index === undefined)
        throw new DataflowDefinitionError(
          `roundRobin: node "${id}" not in rotation`,
        );
      return (index - cursor + ids.length) % ids.length;
    };
    return choose<S, N, T, C>({
      where: (_snapshot, id) => indices.has(id),
      rank: (_snapshot, left, right) => distance(left) - distance(right),
      width: () => width,
    })(snapshot);
  };
}
