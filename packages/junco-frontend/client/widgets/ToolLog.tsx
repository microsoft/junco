import type { ToolCall } from "../state.ts";

const trunc = (text: string | undefined): string =>
  text === undefined || text.length <= 4000
    ? String(text)
    : `${text.slice(0, 4000)}…`;

export function ToolLog({ tools }: { tools: ToolCall[] }) {
  if (tools.length === 0) return <p className="muted">No tool calls yet</p>;
  return (
    <>
      {[...tools].reverse().map((call) => (
        <details key={`${call.key}|${call.startedAt}`}>
          <summary>
            <span className="muted">{call.startedAt.slice(11, 19)}</span> g
            {call.graph}/{call.node} <b>{call.toolName}</b>{" "}
            {call.endedAt === undefined ? (
              <span className="running">running…</span>
            ) : call.isError ? (
              <span className="error">error</span>
            ) : (
              <span className="ok">ok</span>
            )}
          </summary>
          <pre>{trunc(JSON.stringify(call.args, null, 2))}</pre>
          {call.result !== undefined && (
            <pre>{trunc(JSON.stringify(call.result, null, 2))}</pre>
          )}
        </details>
      ))}
    </>
  );
}
