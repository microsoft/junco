import { test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
  DataflowGraph,
  Edge,
  EmitOnce,
  NodeId,
  renderPretty,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "../src/index.ts";

const NumberSchema = Type.Number();

type Graph = DataflowGraph<unknown, typeof NumberSchema, string, never>;

const newGraph = (): Graph =>
  new DataflowGraph<unknown, typeof NumberSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
  );

const add = (graph: Graph, id: string, state: unknown = undefined): NodeId =>
  graph.addNode(
    new EmitOnce(() => [], "done", {
      id: NodeId.create(id),
      state,
      trigger: TriggerRule.always(),
    }),
  );

type Topology = {
  /** `group:` or `leaf:` followed by the declaration's label path from the root. */
  readonly nodes: string[];
  /** `<enclosing path>: <from path> -> <to path> <label>`; the root's path is empty. */
  readonly edges: string[];
};

/**
 * Parse a rendered flowchart into label paths, independent of whitespace and synthetic ids,
 * asserting that every id is declared once and every edge endpoint is declared.
 */
function topology(document: string): Topology {
  const [header, ...lines] = document.split("\n").map((line) => line.trim());
  assert.equal(header, "graph TD;");
  const paths = new Map<string, string>();
  const scopes: string[] = [""];
  const nodes: string[] = [];
  const pending: { scope: string; from: string; to: string; label: string }[] =
    [];
  const declare = (kind: string, id: string, label: string) => {
    assert.ok(!paths.has(id), `duplicate id ${id}`);
    const scope = scopes.at(-1)!;
    const path = scope === "" ? label : `${scope}/${label}`;
    assert.ok(![...paths.values()].includes(path), `duplicate path ${path}`);
    paths.set(id, path);
    nodes.push(`${kind}:${path}`);
    return path;
  };
  for (const line of lines) {
    const group = line.match(/^subgraph (n\d+)\["([^"]*)"\]$/);
    const leaf = line.match(/^(n\d+)\["([^"]*)"\];$/);
    const link = line.match(/^(n\d+) -->\|"([^"]*)"\| (n\d+);$/);
    if (group) {
      scopes.push(declare("group", group[1]!, group[2]!));
    } else if (line === "end;") {
      assert.ok(scopes.length > 1, "unbalanced end");
      scopes.pop();
    } else if (leaf) {
      declare("leaf", leaf[1]!, leaf[2]!);
    } else if (link) {
      const [, from = "", label = "", to = ""] = link;
      pending.push({ scope: scopes.at(-1)!, from, to, label });
    } else {
      assert.fail(`unexpected line: ${line}`);
    }
  }
  assert.equal(scopes.length, 1, "unclosed subgraph");
  const edges = pending.map(({ scope, from, to, label }) => {
    assert.ok(paths.has(from), `undeclared endpoint ${from}`);
    assert.ok(paths.has(to), `undeclared endpoint ${to}`);
    return `${scope}: ${paths.get(from)} -> ${paths.get(to)} ${label}`;
  });
  return { nodes, edges };
}

test("renderPretty renders flat topology with escaped labels and transports", () => {
  const graph = newGraph();
  assert.equal(renderPretty(graph), "");

  const first = add(graph, 'A"#\n');
  const second = add(graph, "B&|");
  graph.addEdge(
    first,
    second,
    Edge.message<typeof NumberSchema, string>("m%", NumberSchema),
  );
  graph.addEdge(first, second, Edge.value("v|", Type.String()));

  const edges = [
    ": A#34;#35;#10; -> B#38;#124; m#37; (message)",
    ": A#34;#35;#10; -> B#38;#124; v#124; (value)",
  ];
  assert.deepEqual(topology(renderPretty(graph)), {
    nodes: ["leaf:A#34;#35;#10;", "leaf:B#38;#124;"],
    edges,
  });

  add(graph, "C");
  assert.deepEqual(topology(renderPretty(graph)), {
    nodes: ["leaf:A#34;#35;#10;", "leaf:B#38;#124;", "leaf:C"],
    edges,
  });
});

test("renderPretty expands graph-valued nodes as nested subgraphs", () => {
  const inner = newGraph();
  inner.addEdge(
    add(inner, "A"),
    add(inner, "B"),
    Edge.message<typeof NumberSchema, string>("ab", NumberSchema),
  );
  const group = newGraph();
  group.addEdge(
    add(group, "A"),
    add(group, "Inner", inner),
    Edge.value("inner", Type.String()),
  );
  const root = newGraph();
  const source = add(root, "Source");
  const middle = add(root, 'Group"#\n', group);
  const sink = add(root, "Sink");
  root.addEdge(
    source,
    middle,
    Edge.message<typeof NumberSchema, string>("in", NumberSchema),
  );
  root.addEdge(middle, sink, Edge.value("out", Type.String()));

  const outer = "Group#34;#35;#10;";
  assert.deepEqual(topology(renderPretty(root)), {
    nodes: [
      "leaf:Source",
      `group:${outer}`,
      `leaf:${outer}/A`,
      `group:${outer}/Inner`,
      `leaf:${outer}/Inner/A`,
      `leaf:${outer}/Inner/B`,
      "leaf:Sink",
    ],
    edges: [
      `${outer}/Inner: ${outer}/Inner/A -> ${outer}/Inner/B ab (message)`,
      `${outer}: ${outer}/A -> ${outer}/Inner inner (value)`,
      `: Source -> ${outer} in (message)`,
      `: ${outer} -> Sink out (value)`,
    ],
  });
});

test("renderPretty expands every occurrence of a shared child graph", () => {
  const child = newGraph();
  child.addEdge(
    add(child, "A"),
    add(child, "B"),
    Edge.value("ab", Type.String()),
  );
  const root = newGraph();
  root.addEdge(
    add(root, "Left", child),
    add(root, "Right", child),
    Edge.message<typeof NumberSchema, string>("between", NumberSchema),
  );

  assert.deepEqual(topology(renderPretty(root)), {
    nodes: [
      "group:Left",
      "leaf:Left/A",
      "leaf:Left/B",
      "group:Right",
      "leaf:Right/A",
      "leaf:Right/B",
    ],
    edges: [
      "Left: Left/A -> Left/B ab (value)",
      "Right: Right/A -> Right/B ab (value)",
      ": Left -> Right between (message)",
    ],
  });
});

test("renderPretty stops at a graph already on the containment path", () => {
  const root = newGraph();
  const child = newGraph();
  add(child, "Back", root);
  const node = add(root, "Child", child);
  root.addEdge(
    node,
    node,
    Edge.message<typeof NumberSchema, string>("again", NumberSchema),
  );

  assert.deepEqual(topology(renderPretty(root)), {
    nodes: [
      "group:Child",
      "group:Child/Back",
      "leaf:Child/Back/(recursive reference)",
    ],
    edges: [": Child -> Child again (message)"],
  });
});

test("renderPretty keeps an empty child graph grouped and reads it live", () => {
  const child = newGraph();
  const root = newGraph();
  const source = add(root, "Source");
  const empty = add(root, "Empty", child);
  const sink = add(root, "Sink");
  root.addEdge(
    source,
    empty,
    Edge.message<typeof NumberSchema, string>("in", NumberSchema),
  );
  root.addEdge(empty, sink, Edge.value("out", Type.String()));
  const edges = [
    ": Source -> Empty in (message)",
    ": Empty -> Sink out (value)",
  ];

  assert.deepEqual(topology(renderPretty(root)), {
    nodes: [
      "leaf:Source",
      "group:Empty",
      "leaf:Empty/(empty graph)",
      "leaf:Sink",
    ],
    edges,
  });

  child.addEdge(
    add(child, "A"),
    add(child, "B"),
    Edge.value("ab", Type.String()),
  );
  assert.deepEqual(topology(renderPretty(root)), {
    nodes: [
      "leaf:Source",
      "group:Empty",
      "leaf:Empty/A",
      "leaf:Empty/B",
      "leaf:Sink",
    ],
    edges: ["Empty: Empty/A -> Empty/B ab (value)", ...edges],
  });
});
