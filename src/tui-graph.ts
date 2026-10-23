import { DataflowGraph, type ResourceKind } from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import type { TextEdge } from "mermaid-ascii";
import mermaidAscii from "mermaid-ascii";

export type TuiNodeBox = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
export type TuiGraphSection = {
  readonly path: readonly string[];
  readonly lines: readonly string[];
  readonly boxes: readonly TuiNodeBox[];
};

const UNSUPPORTED = "Unsupported DataflowGraph layout";

type AnyGraph = DataflowGraph<unknown, unknown, unknown, unknown>;

/** One graph scope: its node labels and links, plus nested subgraph scopes. */
interface Frame {
  /** Node ids from the root down to this scope; empty for the root. */
  readonly path: readonly string[];
  readonly nodes: string[];
  readonly links: { from: string; to: string; label: string }[];
  readonly children: Frame[];
}

/** ASCII cell spelling shared by graph labels and trace badges. */
export const escapeTuiLabel = (decoded: string): string =>
  JSON.stringify(decoded)
    .slice(1, -1)
    .replace(
      /[^\x20-\x7e]/g,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );

/** Mirrors `DataflowGraph.pretty`: nested graphs become child frames with markers. */
function frameOf(
  graph: AnyGraph,
  path: readonly string[],
  ancestry: Set<object>,
): Frame {
  const frame: Frame = { path, nodes: [], links: [], children: [] };
  graph.forEachNode((id, node) => {
    frame.nodes.push(String(id));
    const child = node.state;
    if (!(child instanceof DataflowGraph)) return;
    const childPath = [...path, String(id)];
    if (ancestry.has(child)) {
      frame.children.push({
        path: childPath,
        nodes: ["(recursive reference)"],
        links: [],
        children: [],
      });
      return;
    }
    ancestry.add(child);
    const nested = frameOf(child as AnyGraph, childPath, ancestry);
    ancestry.delete(child);
    if (nested.nodes.length === 0) nested.nodes.push("(empty graph)");
    frame.children.push(nested);
  });
  graph.forEachLink((from, to, edge) => {
    const transport = E.isLeft(edge.transport) ? "message" : "value";
    frame.links.push({
      from: String(from),
      to: String(to),
      label: `${edge.id} (${transport})`,
    });
  });
  return frame;
}

/** Draw one scope's declarations and links as a Unicode canvas. */
function draw(frame: Frame): TuiGraphSection {
  const data = new Map<string, TextEdge[]>();
  for (const label of frame.nodes) {
    data.set(escapeTuiLabel(label), []);
  }
  // One arrow per ordered endpoint pair, carrying every parallel edge label in order.
  const grouped = new Map<string, Map<string, string[]>>();
  for (const { from, to, label } of frame.links) {
    const source = escapeTuiLabel(from);
    const target = escapeTuiLabel(to);
    let targets = grouped.get(source);
    if (targets === undefined) {
      targets = new Map();
      grouped.set(source, targets);
    }
    let labels = targets.get(target);
    if (labels === undefined) {
      labels = [];
      targets.set(target, labels);
    }
    labels.push(escapeTuiLabel(label));
  }
  for (const [source, targets] of grouped) {
    data.set(
      source,
      Array.from(targets, ([target, labels]) => ({
        parent: { name: source, styleClass: "" },
        child: { name: target, styleClass: "" },
        label: labels.join(" / "),
      })),
    );
  }
  const graph = mermaidAscii.Graph.makeGraph(data);
  graph.createMapping();
  const lines = mermaidAscii.DrawingCanvas.drawingToString(
    graph.draw().getCanvas(),
  ).split("\n");
  const boxes = frame.nodes.map((id): TuiNodeBox => {
    const node = graph.getNode(escapeTuiLabel(id));
    if (node?.drawingCoord === undefined || node.drawing === undefined) {
      throw new Error(UNSUPPORTED);
    }
    const [width, height] = node.drawing.getDrawingSize();
    return {
      id,
      x: node.drawingCoord.x,
      y: node.drawingCoord.y,
      width: width + 1,
      height: height + 1,
    };
  });
  return { path: frame.path, lines, boxes };
}

function* preorder(frame: Frame): Generator<Frame> {
  for (const child of frame.children) {
    yield child;
    yield* preorder(child);
  }
}

/** Root and nested canvases in preorder, with section-relative geometry. */
export function renderTuiGraph<S, N, T, EH, K extends ResourceKind>(
  graph: DataflowGraph<S, N, T, EH, K>,
): readonly TuiGraphSection[] {
  const root = frameOf(graph as unknown as AnyGraph, [], new Set([graph]));
  if (root.nodes.length === 0) {
    return [{ path: [], lines: ["(empty graph)"], boxes: [] }];
  }
  const direction = mermaidAscii.graphDirection;
  const ascii = mermaidAscii.useAscii;
  mermaidAscii.setGraphDirection("TD");
  mermaidAscii.setUseAscii(false);
  try {
    return [root, ...preorder(root)].map(draw);
  } finally {
    mermaidAscii.setGraphDirection(direction);
    mermaidAscii.setUseAscii(ascii);
  }
}
