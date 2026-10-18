import { test } from "bun:test";
import assert from "node:assert/strict";
import { graph } from "junco-agency";
import { edgeId, parse, resolveTrigger } from "../src/parse.ts";

const base = () => ({
  graph: {
    nodes: { A: { model: "p/m" }, B: { model: "p/m" } },
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "$sink" },
    ],
  },
});
const rejects = (mutate: (doc: any) => void, message: string) => {
  const doc = base();
  mutate(doc);
  assert.throws(
    () => parse(doc),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message.includes(message),
  );
};
for (const id of ["$source", "$sink"])
  test(`reserved node ${id}`, () =>
    rejects((d) => {
      d.graph.nodes[id] = { model: "p/m" };
    }, `node id "${id}" is reserved`));
for (const [from, to, message] of [
  ["Missing", "B", 'references unknown node "Missing"'],
  ["A", "Missing", 'references unknown node "Missing"'],
  ["A", "$source", "Graph source cannot have inbound edges"],
  ["$sink", "B", "Graph sink cannot have outbound edges"],
  ["$source", "B", "Graph source cannot produce value edges"],
] as const)
  test(message, () =>
    rejects((d) => {
      d.graph.edges[0] = { from, to };
    }, message),
  );
test("duplicate edge ids", () =>
  rejects((d) => {
    d.graph.edges.push({ from: "A", to: "B" });
  }, 'edge "A->B" declared twice'));
test("trigger must be inbound", () =>
  rejects((d) => {
    d.graph.nodes.B.trigger = "B->$sink";
  }, 'Node "B" trigger references edge "B->$sink" which is not one of its inbound edges'));
for (const kind of ["all", "any"])
  test(`duplicate ${kind} trigger`, () =>
    rejects((d) => {
      d.graph.nodes.B.trigger = { [kind]: ["A->B", "A->B"] };
    }, 'Node "B" trigger lists edge "A->B" twice'));
test("sink needs input", () =>
  rejects((d) => {
    d.graph.edges.pop();
  }, "$sink needs at least one inbound edge"));
test("sink return needs edge", () =>
  rejects((d) => {
    d.graph.sink = { returns: "A" };
  }, 'sink.returns "A" has no edge to $sink'));
test("ambiguous sink return", () =>
  rejects((d) => {
    d.graph.edges.push({ from: "A", to: "$sink" });
  }, "sink.returns is required: $sink has inbound edges from B, A"));
for (const field of ["contracts", "prompt"])
  test(`${field} references inbound`, () =>
    rejects((d) => {
      d.graph.nodes.B[field] =
        field === "contracts" ? { wrong: "expect" } : "{{ wrong }}";
    }, `Node "B" ${field} references edge "wrong" which is not one of its inbound edges`));
for (const [field, name] of [
  ["mcp", "mcp"],
  ["skills", "skill"],
])
  test(`unknown ${name}`, () =>
    rejects((d) => {
      d.graph.nodes.A[field!] = ["missing"];
    }, `Node "A" references unknown ${name} "missing"`));
test("builtins always on", () =>
  rejects((d) => {
    d.graph.nodes.A.tools = ["yield"];
  }, 'tool "yield" is builtin and always on'));
test("duplicate tools", () =>
  rejects((d) => {
    d.graph.nodes.A.tools = ["read", "read"];
  }, 'Node "A" lists tool "read" twice'));
for (const mode of ["input", "value", "empty"])
  test(`invalid emit ${mode}`, () =>
    rejects((d) => {
      d.graph.nodes.A = { kind: "emit", text: "go" };
      if (mode === "input")
        d.graph.edges.push({ from: "B", to: "A", kind: "message" });
      if (mode === "empty") d.graph.edges.shift();
    }, 'Node "A" (emit) must have no inbound edges and only message outbound edges (at least one)'));
for (const mode of ["missing", "value", "trigger", "extra"])
  test(`invalid ralph ${mode}`, () =>
    rejects((d) => {
      d.graph.nodes.B.kind = "ralph";
      d.graph.edges[0].kind = mode === "value" ? "value" : "message";
      d.graph.edges[1].kind = "message";
      if (mode === "missing") d.graph.edges.shift();
      if (mode === "trigger") d.graph.nodes.B.trigger = "A~>B";
      if (mode === "extra")
        d.graph.edges.push({
          from: "A",
          to: "B",
          kind: "message",
          id: "second",
        });
    }, 'Node "B" (ralph) needs exactly one inbound message edge and one outbound message edge, and no trigger'));
const nested = () => ({
  graph: {
    nodes: {
      A: {
        kind: "graph",
        graph: {
          source: { routes: { incoming: ["$source~>W"] } },
          nodes: { W: { model: "p/m" } },
          edges: [
            { from: "$source", to: "W", kind: "message" },
            { from: "W", to: "$sink" },
          ],
        },
      },
    },
    edges: [{ from: "A", to: "$sink" }],
  },
});
test("nested routes require parent edge", () =>
  assert.throws(
    () => parse(nested()),
    /Graph "A" routes unknown parent edge "incoming"/,
  ));
test("root routes allow external ids but validate targets", () => {
  const doc = nested().graph.nodes.A.graph;
  assert.equal(
    parse({ graph: doc }).graph.source?.routes?.incoming?.[0],
    "$source~>W",
  );
  doc.source.routes.incoming = ["wrong"];
  assert.throws(
    () => parse({ graph: doc }),
    /route target "wrong" is not an edge from \$source/,
  );
});
test("trigger forms and defaults mirror engine", () => {
  const doc = parse(base());
  for (const [input, kind, rule] of [
    ["always", "all", []],
    ["never", "any", []],
    ["A->B", "all", ["A->B"]],
    [{ all: ["A->B"] }, "all", ["A->B"]],
    [{ any: ["A->B"] }, "any", ["A->B"]],
    [undefined, "all", ["A->B"]],
  ] as const) {
    assert.deepEqual(resolveTrigger(doc.graph, "B", input as any), {
      kind,
      rule,
    });
  }
  assert.deepEqual(resolveTrigger(doc.graph, "A"), { kind: "all", rule: [] });
});
test("YAML and object parsing, default ids", () => {
  assert.equal(edgeId({ from: "A", to: "B" }), "A->B");
  assert.equal(edgeId({ from: "A", to: "B", kind: "message" }), "A~>B");
  const doc = base();
  assert.equal(parse(doc), doc);
  const node = parse(
    "graph:\n  nodes:\n    A: {model: p/m}\n  edges: [{from: A, to: $sink}]",
  ).graph.nodes.A;
  assert.ok(node && "model" in node);
  assert.equal(node.model, "p/m");
});
test("invalid YAML and strict shape", () => {
  assert.throws(() => parse("graph: ["), /junco-syntax: invalid YAML:/);
  assert.throws(() => parse({ ...base(), extra: true }), /junco-syntax:/);
  assert.throws(
    () => parse({ graph: { nodes: {}, edges: [] } }),
    /junco-syntax:/,
  );
  assert.throws(
    () => parse({ graph: { nodes: { A: { model: "bad" } } } }),
    /junco-syntax:/,
  );
});
