import { useCallback, useState } from "react";
import { useJuncoState } from "./api.ts";
import { GraphView, type NodeRef } from "./widgets/GraphView.tsx";
import { NodePanel } from "./widgets/NodePanel.tsx";
import { TaskBoard } from "./widgets/TaskBoard.tsx";
import { TaskPanel } from "./widgets/TaskPanel.tsx";
import { ToolLog } from "./widgets/ToolLog.tsx";

type Selection =
  | ({ kind: "node" } & NodeRef)
  | { kind: "task"; id: string }
  | undefined;

export function App() {
  const state = useJuncoState();
  const [selected, setSelected] = useState<Selection>();
  // Stable: GraphView re-renders its diagram whenever this identity changes.
  const selectNode = useCallback(
    (ref: NodeRef) => setSelected({ kind: "node", ...ref }),
    [],
  );
  const card = selected?.kind === "task" ? state.cards[selected.id] : undefined;
  return (
    <div className="grid">
      <section className="panel">
        <GraphView state={state} onSelect={selectNode} />
      </section>
      <section className="panel">
        <ToolLog tools={state.tools} />
      </section>
      <section className="panel">
        <TaskBoard
          cards={state.cards}
          onSelect={(id) => setSelected({ kind: "task", id })}
        />
      </section>
      <section className="panel">
        {selected?.kind === "node" ? (
          <NodePanel
            state={state}
            graph={selected.graph}
            node={selected.node}
          />
        ) : card !== undefined ? (
          <TaskPanel card={card} />
        ) : (
          <p>Click a node or card</p>
        )}
      </section>
    </div>
  );
}
