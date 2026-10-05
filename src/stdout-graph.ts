import type { TextEdge } from "mermaid-ascii";
import mermaidAscii from "mermaid-ascii";

const UNSUPPORTED = "Unsupported DataflowGraph Mermaid output";
const DECLARATION = /^(n\d+)\["([^"]*)"\];$/;
const SUBGRAPH = /^subgraph (n\d+)\["([^"]*)"\]$/;
const LINK = /^(n\d+) -->\|"([^"]*)"\| (n\d+);$/;

/** One Mermaid scope: its own declarations and links, plus nested subgraph scopes. */
interface Frame {
  /** Decoded node ids from the root down to this scope; empty for the root. */
  readonly path: readonly string[];
  /** Synthetic Mermaid id to escaped display label, in declaration order. */
  readonly nodes: Map<string, string>;
  readonly links: { from: string; to: string; label: string }[];
  readonly children: Frame[];
}

/** Decode the engine's `#<code point>;` entities exactly once. */
const decode = (label: string): string =>
  label.replace(/#(\d+);/g, (_, code: string) =>
    String.fromCodePoint(Number(code)),
  );

/** Render a decoded label on one terminal line with control characters, quotes, and backslashes escaped. */
const display = (decoded: string): string =>
  JSON.stringify(decoded).slice(1, -1);

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
    frame.nodes.set(id, display(decode(label)));
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
      scope.links.push({ from, to, label: display(decode(label)) });
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
function draw(frame: Frame): string {
  const data = new Map<string, TextEdge[]>();
  for (const label of frame.nodes.values()) {
    data.set(label, []);
  }
  // One arrow per ordered endpoint pair, carrying every parallel edge label in order.
  const grouped = new Map<string, Map<string, string[]>>();
  for (const { from, to, label } of frame.links) {
    const source = frame.nodes.get(from);
    const target = frame.nodes.get(to);
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
    labels.push(label);
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
  return mermaidAscii.DrawingCanvas.drawingToString(graph.draw().getCanvas());
}

function* preorder(frame: Frame): Generator<Frame> {
  for (const child of frame.children) {
    yield child;
    yield* preorder(child);
  }
}

/**
 * Render a `DataflowGraph` Mermaid document as Unicode box drawings: the root scope first, then
 * every subgraph scope in preorder under a heading naming its decoded containment path.
 */
export function renderStdoutGraph(mermaid: string): string {
  if (mermaid === "") {
    return "(empty graph)";
  }
  const root = parse(mermaid);
  const direction = mermaidAscii.graphDirection;
  const ascii = mermaidAscii.useAscii;
  mermaidAscii.setGraphDirection("TD");
  mermaidAscii.setUseAscii(false);
  try {
    const sections = [draw(root)];
    for (const frame of preorder(root)) {
      sections.push(`Subgraph ${JSON.stringify(frame.path)}:`, draw(frame));
    }
    return sections.join("\n");
  } finally {
    mermaidAscii.setGraphDirection(direction);
    mermaidAscii.setUseAscii(ascii);
  }
}
