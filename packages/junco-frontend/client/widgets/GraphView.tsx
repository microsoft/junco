import mermaid from "mermaid";
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fitDirection, type Size, validSize } from "../graph-fit.ts";
import { latestRoot, type State } from "../state.ts";

export type NodeRef = { graph: number; node: string };

mermaid.initialize({
  startOnLoad: false,
  suppressErrorRendering: true,
  securityLevel: "loose",
  theme: "dark",
  flowchart: { useMaxWidth: false },
  // The panel background (app.css --panel), instead of Mermaid's grey label boxes.
  themeVariables: { edgeLabelBackground: "#1c1b1f" },
});
let renders = 0;

/** Mermaid's entity spelling of `"` inside a quoted label. */
const quote = (text: string): string => text.replaceAll('"', "#quot;");

/** The latest root and its nested subgraphs; `ids` maps clickable Mermaid ids to nodes. */
export function mermaidOf(graphs: State["graphs"]): {
  root: number | undefined;
  body: string;
  ids: Map<string, NodeRef>;
} {
  const lines: string[] = [];
  const ids = new Map<string, NodeRef>();
  let next = 0;
  const root = latestRoot(graphs);
  const emit = (g: number, path: ReadonlySet<number>): void => {
    const info = graphs[g];
    if (info === undefined) return;
    lines.push(`%% graph ${g}`);
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
      lines.push(`${key}${label}`, `class ${key} junco-${key}`);
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
  return { root, body: lines.join("\n"), ids };
}

export function GraphView({
  state,
  onSelect,
}: {
  state: State;
  onSelect: (ref: NodeRef, token: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const { root, body, ids } = useMemo(
    () => mermaidOf(state.graphs),
    [state.graphs],
  );
  const [selection, setSelection] = useState<{
    root: number;
    body: string;
    result: SVGSVGElement | string;
  }>();
  useEffect(() => {
    const mount = ref.current;
    if (root === undefined || !mount) return;
    let cancelled = false;
    let panel: Size;
    let started = false;
    let selected: SVGSVGElement | undefined;
    type Drawings = Partial<Record<"LR" | "TB", SVGSVGElement>>;
    let drawings: Drawings | undefined;

    const choose = (cached: Drawings) => {
      const direction = fitDirection(
        panel,
        cached.LR?.viewBox.baseVal,
        cached.TB?.viewBox.baseVal,
      );
      const svg = direction && cached[direction];
      if (svg && svg !== selected) {
        selected = svg;
        setSelection({ root, body, result: svg });
      }
    };

    const render = async () => {
      const candidates: Drawings = {};
      let firstError: string | undefined;
      for (const direction of ["LR", "TB"] as const) {
        try {
          const { svg } = await mermaid.render(
            `junco-graph-${++renders}`,
            `flowchart ${direction}\n${body}`,
          );
          if (cancelled || ref.current !== mount) return;
          const container = document.createElement("div");
          container.innerHTML = svg;
          const drawing = container.querySelector("svg");
          if (drawing && validSize(drawing.viewBox.baseVal))
            candidates[direction] = drawing;
          else firstError ??= "Mermaid returned no usable SVG viewBox";
        } catch (error) {
          if (cancelled || ref.current !== mount) return;
          firstError ??= String(error);
        }
      }
      drawings = candidates;
      if (candidates.LR || candidates.TB) choose(candidates);
      else if (firstError !== undefined)
        setSelection({ root, body, result: firstError });
    };

    const observer = new ResizeObserver(([entry]) => {
      if (!entry || cancelled) return;
      panel = entry.contentRect;
      if (drawings) choose(drawings);
      else if (!started && validSize(panel)) {
        started = true;
        void render();
      }
    });
    observer.observe(mount);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [root, body]);

  const result =
    selection && selection.root === root && selection.body === body
      ? selection.result
      : undefined;
  useLayoutEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    if (!(result instanceof SVGSVGElement)) {
      mount.textContent = result ?? "";
      return;
    }
    for (const [key, hit] of ids) {
      const group = result.querySelector<SVGGElement>(`g.junco-${key}`);
      if (!group) continue;
      if (!group.dataset.nodeKey) {
        group.dataset.nodeKey = key;
        group.dataset.nodeAnchor = `${key}:${hit.graph}:${hit.node}`;
        group.setAttribute("role", "button");
        group.setAttribute("tabindex", "0");
        group.setAttribute("aria-label", `g${hit.graph}/${hit.node}`);
        group.setAttribute("aria-haspopup", "dialog");
      }
      const live = state.graphs[hit.graph]?.nodes[hit.node]?.live;
      if (live && !group.classList.contains(live)) {
        group.classList.remove("ready", "running", "waiting", "done", "error");
        group.classList.add(live);
      }
    }
    if (mount.firstElementChild === result) return;
    const focus = document.activeElement;
    const token =
      focus &&
      mount.contains(focus) &&
      focus.closest<SVGGElement>("g[data-node-anchor]")?.dataset.nodeAnchor;
    mount.replaceChildren(result);
    if (token)
      result
        .querySelector<SVGGElement>(
          `g[data-node-anchor="${CSS.escape(token)}"]`,
        )
        ?.focus({ preventScroll: true });
  }, [result, ids, state.graphs]);

  function activate(event: MouseEvent | KeyboardEvent) {
    if (!(event.target instanceof Element)) return;
    const group = event.target.closest<SVGGElement>("g[data-node-key]");
    const key = group?.dataset.nodeKey;
    const token = group?.dataset.nodeAnchor;
    const hit = key && ids.get(key);
    if (!hit || !token) return;
    if ("key" in event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.repeat) return;
    }
    onSelect(hit, token);
  }
  if (root === undefined) return <p className="muted">Waiting for a run…</p>;
  const run = state.graphs[root]?.run;
  return (
    <>
      <div className="muted">
        g{root} {run && `run #${run.run} ${run.phase}`}
      </div>
      <figure
        key={root}
        ref={ref}
        aria-label={`Graph ${root}`}
        className="graph-viewport"
        onClick={activate}
        onKeyDown={activate}
      />
    </>
  );
}
