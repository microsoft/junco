import mermaid from "mermaid";
import { useEffect, useMemo, useRef } from "react";
import type { State } from "../state.ts";

export type NodeRef = { graph: number; node: string };

mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
let renders = 0;

/** Mermaid's entity spelling of `"` inside a quoted label. */
const quote = (text: string): string => text.replaceAll('"', "#quot;");

/** A Mermaid flowchart of every root graph, nested graphs as subgraphs; `ids` maps clickable Mermaid ids to nodes. */
export function mermaidOf(graphs: State["graphs"]): {
  text: string;
  ids: Map<string, NodeRef>;
} {
  const lines = ["flowchart LR"];
  const ids = new Map<string, NodeRef>();
  let next = 0;
  const children = new Set<number>();
  for (const info of Object.values(graphs))
    for (const node of Object.values(info.nodes))
      if (node.child !== undefined) children.add(node.child);
  const emit = (g: number, path: ReadonlySet<number>): void => {
    const info = graphs[g];
    if (info === undefined) return;
    const keys = new Map<string, string>();
    for (const node of Object.values(info.nodes)) {
      const key = `n${next++}`;
      keys.set(node.id, key);
      const label = `["${quote(node.id)}"]`;
      const child = node.child;
      if (
        child !== undefined &&
        graphs[child] !== undefined &&
        !path.has(child)
      ) {
        lines.push(`subgraph ${key}${label}`);
        emit(child, new Set([...path, child]));
        lines.push("end");
        continue;
      }
      lines.push(
        `${key}${label}:::${node.live}`,
        `click ${key} juncoNodeClick`,
      );
      ids.set(key, { graph: g, node: node.id });
    }
    for (const link of info.links)
      lines.push(
        `${keys.get(link.from)} ${link.kind === "message" ? "-->" : "-.->"}|"${quote(link.id)}"| ${keys.get(link.to)}`,
      );
  };
  for (const g of Object.keys(graphs).map(Number))
    if (!children.has(g)) emit(g, new Set([g]));
  lines.push(
    "classDef running fill:#fde68a",
    "classDef waiting fill:#e0f2fe",
    "classDef done fill:#bbf7d0",
    "classDef error fill:#fecaca",
  );
  return { text: lines.join("\n"), ids };
}

export function GraphView({
  state,
  onSelect,
}: {
  state: State;
  onSelect: (ref: NodeRef) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { text, ids } = useMemo(() => mermaidOf(state.graphs), [state.graphs]);
  useEffect(() => {
    // Mermaid `click … juncoNodeClick` calls a global with the Mermaid node id.
    Object.assign(window, {
      juncoNodeClick: (key: string) => {
        const hit = ids.get(key);
        if (hit !== undefined) onSelect(hit);
      },
    });
    let cancelled = false;
    mermaid
      .render(`junco-graph-${++renders}`, text)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || ref.current === null) return;
        ref.current.innerHTML = svg;
        bindFunctions?.(ref.current);
      })
      .catch((error: unknown) => {
        if (!cancelled && ref.current !== null)
          ref.current.textContent = String(error);
      });
    return () => {
      cancelled = true;
    };
  }, [text, ids, onSelect]);
  const graphs = Object.entries(state.graphs);
  if (graphs.length === 0) return <p>Waiting for a run…</p>;
  return (
    <>
      {graphs.map(([g, info]) => (
        <div key={g}>
          g{g} {info.run && `run #${info.run.run} ${info.run.phase}`}
        </div>
      ))}
      <div ref={ref} />
    </>
  );
}
