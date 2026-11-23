import mermaid from "mermaid";
import { useEffect, useMemo, useRef } from "react";
import { latestRoot, type State } from "../state.ts";

export type NodeRef = { graph: number; node: string };

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "loose",
  theme: "dark",
  // The panel background (app.css --panel), instead of Mermaid's grey label boxes.
  themeVariables: { edgeLabelBackground: "#1c1b1f" },
});
let renders = 0;

/** Mermaid's entity spelling of `"` inside a quoted label. */
const quote = (text: string): string => text.replaceAll('"', "#quot;");

/** The latest root and its nested subgraphs; `ids` maps clickable Mermaid ids to nodes. */
export function mermaidOf(graphs: State["graphs"]): {
  root: number | undefined;
  text: string;
  ids: Map<string, NodeRef>;
} {
  const lines = ["flowchart LR"];
  const ids = new Map<string, NodeRef>();
  let next = 0;
  const root = latestRoot(graphs);
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
  if (root !== undefined) emit(root, new Set([root]));
  lines.push(
    "classDef running fill:#4a3b0b,stroke:#fbbf24,color:#fde68a",
    "classDef waiting fill:#0b3147,stroke:#38bdf8,color:#e0f2fe",
    "classDef done fill:#12391f,stroke:#4ade80,color:#bbf7d0",
    "classDef error fill:#4a1717,stroke:#f87171,color:#fecaca",
  );
  return { root, text: lines.join("\n"), ids };
}

export function GraphView({
  state,
  onSelect,
}: {
  state: State;
  onSelect: (ref: NodeRef) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { root, text, ids } = useMemo(() => mermaidOf(state.graphs), [state.graphs]);
  useEffect(() => {
    const mount = ref.current;
    if (root === undefined || mount === null) return;
    let cancelled = false;
    mermaid
      .render(`junco-graph-${++renders}`, text)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || ref.current !== mount) return;
        mount.innerHTML = svg;
        Object.assign(window, {
          juncoNodeClick: (key: string) => {
            const hit = ids.get(key);
            if (hit !== undefined) onSelect(hit);
          },
        });
        bindFunctions?.(mount);
      })
      .catch((error: unknown) => {
        if (!cancelled && ref.current === mount) mount.textContent = String(error);
      });
    return () => {
      cancelled = true;
    };
  }, [root, text, ids, onSelect]);
  if (root === undefined) return <p className="muted">Waiting for a run…</p>;
  const run = state.graphs[root]?.run;
  return (
    <>
      <div className="muted">
        g{root} {run && `run #${run.run} ${run.phase}`}
      </div>
      <div key={root} ref={ref} />
    </>
  );
}
