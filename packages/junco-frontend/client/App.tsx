import { useCallback, useState } from "react";
import { useJuncoState } from "./api.ts";
import { DetailCallout } from "./widgets/DetailCallout.tsx";
import { GraphView, type NodeRef } from "./widgets/GraphView.tsx";
import { NodePanel } from "./widgets/NodePanel.tsx";
import { TaskBoard } from "./widgets/TaskBoard.tsx";
import { TaskPanel } from "./widgets/TaskPanel.tsx";
import { ToolLog } from "./widgets/ToolLog.tsx";

type Selection =
  | ({ kind: "node"; token: string } & NodeRef)
  | { kind: "task"; id: string }
  | undefined;

export function App() {
  const state = useJuncoState();
  const [selected, setSelected] = useState<Selection>();
  const selectNode = (ref: NodeRef, token: string) =>
    setSelected((current) =>
      current?.kind === "node" && current.token === token
        ? undefined
        : { kind: "node", token, ...ref },
    );
  const dismiss = useCallback(() => setSelected(undefined), []);
  const card = selected?.kind === "task" ? state.cards[selected.id] : undefined;
  const details =
    selected?.kind === "node"
      ? state.graphs[selected.graph]?.nodes[selected.node] && (
          <NodePanel
            state={state}
            graph={selected.graph}
            node={selected.node}
          />
        )
      : card && <TaskPanel card={card} />;
  if (selected && !details) setSelected(undefined);
  const selector =
    selected?.kind === "node"
      ? `g[data-node-anchor="${CSS.escape(selected.token)}"]`
      : selected && `button[data-card-id="${CSS.escape(selected.id)}"]`;
  return (
    <div className="app">
      <header>
        <h1>Junco Monitor</h1>
        <span className="muted">{state.log.length} events</span>
      </header>
      <main className="grid">
        <section className="panel graph-panel">
          <h2>Graph</h2>
          <GraphView state={state} onSelect={selectNode} />
        </section>
        <section className="panel">
          <h2>Tool calls</h2>
          <ToolLog tools={state.tools} />
        </section>
        <section className="panel tasks-panel">
          <h2>Tasks</h2>
          <TaskBoard
            cards={state.cards}
            onSelect={(id) =>
              setSelected((current) =>
                current?.kind === "task" && current.id === id
                  ? undefined
                  : { kind: "task", id },
              )
            }
          />
        </section>
      </main>
      {selector && details && (
        <DetailCallout
          key={selector}
          selector={selector}
          label={selected?.kind === "node" ? "Node details" : "Task details"}
          onDismiss={dismiss}
        >
          {details}
        </DetailCallout>
      )}
    </div>
  );
}
