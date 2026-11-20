import type { Card } from "../state.ts";

/** One task card: its spec, description, dependencies and provenance, oldest holder first. */
export function TaskPanel({ card }: { card: Card }) {
  const { task } = card;
  return (
    <>
      <h3>
        {card.taskId} @ {card.node} — {card.status}
      </h3>
      <h4>Spec</h4>
      <pre>{task.spec}</pre>
      <h4>Text</h4>
      <pre>{task.text}</pre>
      <h4>Deps</h4>
      <ul>
        {task.deps.map((dep) => (
          <li key={dep}>{dep}</li>
        ))}
      </ul>
      <h4>History</h4>
      <table>
        <thead>
          <tr>
            <th>Node</th>
            <th>Received</th>
            <th>Handoff</th>
          </tr>
        </thead>
        <tbody>
          {task.history.map((entry, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: history is append-only; position is its identity.
            <tr key={i}>
              <td>{entry.node}</td>
              <td>{entry.desc}</td>
              <td>{entry.handoff}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
