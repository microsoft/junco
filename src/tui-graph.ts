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

const UNSUPPORTED = "Unsupported DataflowGraph Mermaid output";
const DECLARATION = /^(n\d+)\["([^"]*)"\];$/;
const SUBGRAPH = /^subgraph (n\d+)\["([^"]*)"\]$/;
const LINK = /^(n\d+) -->\|"([^"]*)"\| (n\d+);$/;

/** One Mermaid scope: its own declarations and links, plus nested subgraph scopes. */
interface Frame {
  /** Decoded node ids from the root down to this scope; empty for the root. */
  readonly path: readonly string[];
  /** Synthetic Mermaid id to decoded node identity, in declaration order. */
  readonly nodes: Map<string, string>;
  readonly links: { from: string; to: string; label: string }[];
  readonly children: Frame[];
}

/** Decode the engine's `#<code point>;` entities exactly once. */
const decode = (label: string): string =>
  label.replace(/#(\d+);/g, (_, code: string) =>
    String.fromCodePoint(Number(code)),
  );

/** ASCII cell spelling shared by graph labels and trace badges. */
export const escapeTuiLabel = (decoded: string): string =>
  JSON.stringify(decoded)
    .slice(1, -1)
    .replace(
      /[^\x20-\x7e]/g,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );

function parse(mermaid: string): Frame {
  const [header, ...lines] = mermaid.split("\n").map((line) => line.trim());
  if (header !== "graph TD;") {
    throw new Error(UNSUPPORTED);
  }
  const root: Frame = { path: [], nodes: new Map(), links: [], children: [] };
  const scopes: Frame[] = [root];
  const declared = new Set<string>();
  const declare = (frame: Frame, id: string, label: string): void => {
    if (declared.has(id)) {
      throw new Error(UNSUPPORTED);
    }
    declared.add(id);
    frame.nodes.set(id, decode(label));
  };
  for (const line of lines) {
    const scope = scopes.at(-1) ?? root;
    const subgraph = SUBGRAPH.exec(line);
    const declaration = DECLARATION.exec(line);
    const link = LINK.exec(line);
    if (subgraph) {
      const [, id = "", label = ""] = subgraph;
      declare(scope, id, label);
      const child: Frame = {
        path: [...scope.path, decode(label)],
        nodes: new Map(),
        links: [],
        children: [],
      };
      scope.children.push(child);
      scopes.push(child);
    } else if (line === "end;" && scopes.length > 1) {
      scopes.pop();
    } else if (declaration) {
      const [, id = "", label = ""] = declaration;
      declare(scope, id, label);
    } else if (link) {
      const [, from = "", label = "", to = ""] = link;
      scope.links.push({ from, to, label: decode(label) });
    } else {
      throw new Error(UNSUPPORTED);
    }
  }
  if (scopes.length !== 1) {
    throw new Error(UNSUPPORTED);
  }
  return root;
}

/** Draw one scope's declarations and links as a Unicode canvas. */
function draw(frame: Frame): TuiGraphSection {
  const data = new Map<string, TextEdge[]>();
  for (const label of frame.nodes.values()) {
    data.set(escapeTuiLabel(label), []);
  }
  // One arrow per ordered endpoint pair, carrying every parallel edge label in order.
  const grouped = new Map<string, Map<string, string[]>>();
  for (const { from, to, label } of frame.links) {
    const rawSource = frame.nodes.get(from);
    const rawTarget = frame.nodes.get(to);
    const source =
      rawSource === undefined ? undefined : escapeTuiLabel(rawSource);
    const target =
      rawTarget === undefined ? undefined : escapeTuiLabel(rawTarget);
    if (source === undefined || target === undefined) {
      throw new Error(UNSUPPORTED);
    }
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
  const boxes = Array.from(frame.nodes.values(), (id): TuiNodeBox => {
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
export function renderTuiGraph(mermaid: string): readonly TuiGraphSection[] {
  if (mermaid === "") {
    return [{ path: [], lines: ["(empty graph)"], boxes: [] }];
  }
  const root = parse(mermaid);
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
