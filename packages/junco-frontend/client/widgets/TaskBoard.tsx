import { Fragment } from "react";
import { type Card, cardId } from "../state.ts";

/** Rows are task ids, columns node ids; the board only mirrors the run, so cards are plain buttons. */
export function TaskBoard({
  cards,
  onSelect,
}: {
  cards: Record<string, Card>;
  onSelect: (id: string) => void;
}) {
  const list = Object.values(cards);
  if (list.length === 0) return <p className="muted">No tasks yet</p>;
  const columns = [...new Set(list.map((card) => card.node))].sort();
  const rows = [...new Set(list.map((card) => card.taskId))].sort();
  return (
    <div
      className="board"
      style={{
        gridTemplateColumns: `minmax(8em, max-content) repeat(${columns.length}, minmax(14em, 1fr))`,
      }}
    >
      <div />
      {columns.map((node) => (
        <div key={node} className="board-head">
          {node}
        </div>
      ))}
      {rows.map((taskId) => (
        <Fragment key={taskId}>
          <div className="board-row">{taskId}</div>
          {columns.map((node) => {
            const card = cards[cardId(taskId, node)];
            return (
              <div key={node} className="board-cell">
                {card && (
                  <button
                    type="button"
                    className={`card ${card.status}`}
                    onClick={() => onSelect(card.id)}
                  >
                    <b>{card.status}</b>
                    {card.summary}
                  </button>
                )}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
