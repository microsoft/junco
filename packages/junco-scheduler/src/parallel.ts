import type { NodeIdType } from "dataflow-engine";
import type { Decision, Snapshot } from "./scheduler.js";

/** Select every available owned node in candidate order; native capacity stays authoritative. */
export function parallel(): <S, N, T, C>(
  snapshot: Snapshot<S, N, T, C>,
  signal?: AbortSignal,
) => Decision | Promise<Decision> {
  return (snapshot) => {
    const selected: NodeIdType[] = [];
    for (const id of snapshot.available)
      if (snapshot.owned.has(id)) selected.push(id);
    return { selected };
  };
}
