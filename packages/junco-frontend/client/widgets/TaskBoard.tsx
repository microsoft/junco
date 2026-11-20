import {
  ColumnDirective,
  ColumnsDirective,
  KanbanComponent,
} from "@syncfusion/ej2-react-kanban";
import type { Card } from "../state.ts";

/** Rows are task ids, columns node ids; drag and drop is off, the board only mirrors the run. */
export function TaskBoard({
  cards,
  onSelect,
}: {
  cards: Record<string, Card>;
  onSelect: (id: string) => void;
}) {
  // Copies: Syncfusion's data layer may annotate its records, and these are reducer state.
  const list = Object.values(cards).map((card) => ({ ...card }));
  if (list.length === 0) return <p>No tasks yet</p>;
  const columns = [...new Set(list.map((card) => card.node))].sort();
  return (
    <KanbanComponent
      // Remount when the column set changes: directives are read once at creation.
      key={columns.join("\u0000")}
      keyField="node"
      dataSource={list}
      cardSettings={{ headerField: "Id", contentField: "summary" }}
      swimlaneSettings={{ keyField: "taskId" }}
      allowDragAndDrop={false}
      cardClick={(args) => onSelect(String(args.data.Id))}
    >
      <ColumnsDirective>
        {columns.map((node) => (
          <ColumnDirective key={node} headerText={node} keyField={node} />
        ))}
      </ColumnsDirective>
    </KanbanComponent>
  );
}
