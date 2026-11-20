import type { FrontendEvent } from "../../server/events.ts";
import type { State } from "../state.ts";

const MAX_ROWS = 200;

const labelOf = (event: FrontendEvent): string => {
  switch (event.kind) {
    case "activation":
      return `activation ${event.phase}`;
    case "step":
      return `step ${event.outcome}`;
    case "tool":
      return `tool ${event.toolName} ${event.phase}`;
    case "message":
      return `${event.role}: ${event.text}`;
    default:
      return event.kind;
  }
};

/** What one node did and is doing: status, usage totals and its newest activations, steps, messages and tool calls. */
export function NodePanel({
  state,
  graph,
  node,
}: {
  state: State;
  graph: number;
  node: string;
}) {
  const info = state.graphs[graph]?.nodes[node];
  let tokens = 0;
  let cost = 0;
  const rows: FrontendEvent[] = [];
  for (let i = state.log.length - 1; i >= 0; i--) {
    const event = state.log[i];
    if (event === undefined) continue;
    if (event.kind === "profile") {
      // shortcut: profile paths are node-id chains, matched by innermost id; nested graphs reusing a node id merge
      if (event.path.at(-1) !== node || event.event.kind !== "usage") continue;
      if (event.event.resource === "tokens")
        tokens += event.event.usage.totalTokens;
      if (event.event.resource === "cost") cost += event.event.usage.cost.total;
    } else if (
      (event.kind === "activation" ||
        event.kind === "step" ||
        event.kind === "tool" ||
        event.kind === "message") &&
      event.graph === graph &&
      event.node === node &&
      rows.length < MAX_ROWS
    )
      rows.push(event);
  }
  return (
    <>
      <h3>
        g{graph}/{node} — {info?.live ?? "unknown"}
      </h3>
      {info?.description && <p>{info.description}</p>}
      <p>
        tokens {tokens} · cost ${cost.toFixed(4)}
      </p>
      {rows.map((event) => (
        <details key={event.seq}>
          <summary>
            {event.at.slice(11, 19)} {labelOf(event)}
          </summary>
          <pre>{JSON.stringify(event, null, 2)}</pre>
        </details>
      ))}
    </>
  );
}
