import type { FrontendEvent, GraphNode, Link } from "../server/events.ts";

export type NodeStatus = "ready" | "running" | "waiting" | "done" | "error";
/** A node with its live status: `waiting` between a yield and its next activation. */
export type NodeInfo = GraphNode & { live: NodeStatus };
export type GraphInfo = {
  nodes: Record<string, NodeInfo>;
  links: Link[];
  run?: { run: number; phase: "start" | "end" | "fail" };
};
export type ToolCall = {
  key: string;
  graph: number;
  node: string;
  toolName: string;
  startedAt: string;
  args: unknown;
  endedAt?: string;
  result?: unknown;
  isError?: boolean;
};
/** A task-shaped message payload: junco-agent's `Task`, whose provenance fields are all required. */
export type TaskPayload = {
  kind: string;
  text: string;
  taskId: string;
  spec: string;
  deps: string[];
  history: { node: string; desc: string; handoff: string }[];
};
/** How busy a task's holder is; tasks themselves have no done flag, a returned holder leaves them `waiting`. */
export type CardStatus = "queued" | "running" | "waiting" | "error";
/** One task at one node: a kanban card. */
export type Card = {
  id: string;
  graph: number;
  taskId: string;
  node: string;
  status: CardStatus;
  task: TaskPayload;
  summary: string;
};
export type State = {
  graphs: Record<number, GraphInfo>;
  tools: ToolCall[];
  cards: Record<string, Card>;
  log: FrontendEvent[];
};

export const EMPTY: State = { graphs: {}, tools: [], cards: {}, log: [] };

export const isTask = (p: unknown): p is TaskPayload =>
  typeof p === "object" &&
  p !== null &&
  "text" in p &&
  typeof p.text === "string" &&
  "kind" in p &&
  typeof p.kind === "string" &&
  "taskId" in p &&
  typeof p.taskId === "string" &&
  "spec" in p &&
  typeof p.spec === "string" &&
  "deps" in p &&
  Array.isArray(p.deps) &&
  "history" in p &&
  Array.isArray(p.history);

/** The key of the card of task `taskId` at node `node`. */
export const cardId = (taskId: string, node: string): string =>
  `${taskId}@${node}`;

function withLive(
  graphs: State["graphs"],
  graph: number,
  node: string,
  live: NodeStatus,
): State["graphs"] {
  const info = graphs[graph];
  const current = info?.nodes[node];
  if (info === undefined || current === undefined) return graphs;
  return {
    ...graphs,
    [graph]: {
      ...info,
      nodes: { ...info.nodes, [node]: { ...current, live } },
    },
  };
}

/** `cards` with every card of `(graph, node)` in one of `from` moved to `to`. */
function moveCards(
  cards: State["cards"],
  graph: number,
  node: string,
  from: readonly CardStatus[],
  to: CardStatus,
): State["cards"] {
  let next = cards;
  for (const card of Object.values(cards))
    if (
      card.graph === graph &&
      card.node === node &&
      from.includes(card.status)
    )
      next = { ...next, [card.id]: { ...card, status: to } };
  return next;
}

function upsertCard(
  cards: State["cards"],
  graph: number,
  node: string,
  task: TaskPayload,
  status: CardStatus,
): State["cards"] {
  const { taskId } = task;
  const id = cardId(taskId, node);
  const summary = `${task.kind}: ${task.text.slice(0, 120)}`;
  return { ...cards, [id]: { id, graph, taskId, node, status, task, summary } };
}

/** Fold one server event into the client state; never mutates `state`. */
export function reduce(state: State, event: FrontendEvent): State {
  // shortcut: copying the log is quadratic over a session, move to an append-only store when runs reach ~100k events
  const base = { ...state, log: [...state.log, event] };
  switch (event.kind) {
    case "graph": {
      const nodes: Record<string, NodeInfo> = {};
      for (const node of event.nodes)
        nodes[node.id] = { ...node, live: node.status };
      const run = state.graphs[event.graph]?.run;
      return {
        ...base,
        graphs: {
          ...state.graphs,
          [event.graph]: { nodes, links: event.links, ...(run && { run }) },
        },
      };
    }
    case "run": {
      const info = state.graphs[event.graph];
      if (info === undefined) return base;
      const run = { run: event.run, phase: event.phase };
      return {
        ...base,
        graphs: { ...state.graphs, [event.graph]: { ...info, run } },
      };
    }
    case "activation": {
      const { graph, node } = event;
      let cards = moveCards(
        state.cards,
        graph,
        node,
        ["waiting", "queued"],
        "running",
      );
      for (const { payloads } of event.messages)
        for (const payload of payloads)
          if (isTask(payload))
            cards = upsertCard(cards, graph, node, payload, "running");
      return {
        ...base,
        graphs: withLive(state.graphs, graph, node, "running"),
        cards,
      };
    }
    case "step": {
      const { graph, node } = event;
      if (event.outcome === "return")
        return {
          ...base,
          graphs: withLive(state.graphs, graph, node, "done"),
          cards: moveCards(state.cards, graph, node, ["running"], "waiting"),
        };
      if (event.outcome === "error")
        return {
          ...base,
          graphs: withLive(state.graphs, graph, node, "error"),
          cards: moveCards(state.cards, graph, node, ["running"], "error"),
        };
      let cards = moveCards(state.cards, graph, node, ["running"], "waiting");
      const links = state.graphs[graph]?.links ?? [];
      for (const { edge, payload } of event.messages) {
        if (!isTask(payload)) continue;
        for (const link of links)
          if (
            link.id === edge &&
            link.from === node &&
            cards[cardId(payload.taskId, link.to)]?.status !== "running"
          )
            cards = upsertCard(cards, graph, link.to, payload, "queued");
      }
      return {
        ...base,
        graphs: withLive(state.graphs, graph, node, "waiting"),
        cards,
      };
    }
    case "tool": {
      const key = `${event.graph}|${event.node}|${event.toolCallId}`;
      if (event.phase === "start") {
        const { graph, node, toolName, args } = event;
        return {
          ...base,
          tools: [
            ...state.tools,
            { key, graph, node, toolName, startedAt: event.at, args },
          ],
        };
      }
      const ended = {
        endedAt: event.at,
        result: event.result,
        isError: event.isError,
      };
      const index = state.tools.findIndex(
        (call) => call.key === key && call.endedAt === undefined,
      );
      if (index === -1) {
        const { graph, node, toolName } = event;
        return {
          ...base,
          tools: [
            ...state.tools,
            {
              key,
              graph,
              node,
              toolName,
              startedAt: event.at,
              args: undefined,
              ...ended,
            },
          ],
        };
      }
      return {
        ...base,
        tools: state.tools.map((call, i) =>
          i === index ? { ...call, ...ended } : call,
        ),
      };
    }
    default:
      return base;
  }
}
