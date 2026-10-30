import { test } from "bun:test";
import assert from "node:assert/strict";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { graph } from "junco";
import { Type } from "typebox";
import { YAMLError } from "yaml";
import { ValidationError } from "../src/syntax/errors.ts";
import {
  edgeId,
  type ParseOptions,
  parse,
  resolveTrigger,
} from "../src/syntax/parse.ts";
import type { EdgeSpec, GraphSpec, TriggerSpec } from "../src/syntax/schema.ts";

/** Topology fixtures share one valid payload schema; schema cases replace it. */
const schema = { type: "number" };
const NumberSchema = Type.Number();
const StringSchema = Type.String();
/** The runtime edges `build.ts` wires for one graph level. */
const wired = (spec: GraphSpec) =>
  new Map<string, graph.Edge<typeof NumberSchema, number>>(
    (spec.edges ?? []).map((e) => [
      edgeId(e),
      e.kind === "message"
        ? graph.Edge.message(edgeId(e), NumberSchema)
        : graph.Edge.value(edgeId(e), NumberSchema),
    ]),
  );
const base = () => ({
  graph: {
    nodes: { A: {}, B: {} },
    edges: [
      { from: "A", to: "B", schema },
      { from: "B", to: "$sink", schema },
    ],
  },
});
const nested = () => ({
  graph: {
    nodes: {
      A: {
        kind: "graph",
        graph: {
          source: { routes: { incoming: ["$source~>W"] } },
          nodes: { W: {} },
          edges: [
            { from: "$source", to: "W", kind: "message", schema },
            { from: "W", to: "$sink", schema },
          ],
        },
      },
    },
    edges: [{ from: "A", to: "$sink", schema }],
  },
});
/** JSON shapes let cases spell documents the schema rejects. */
type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json | undefined;
}
interface LooseGraph extends JsonObject {
  nodes: Record<string, JsonObject>;
  edges: JsonObject[];
}
interface LooseDoc extends JsonObject {
  graph: LooseGraph;
}
type Mutate = (doc: LooseDoc) => void;
/** A mutated copy of `base()`. */
const variant = (mutate: Mutate) => {
  const doc: LooseDoc = base();
  mutate(doc);
  return doc;
};
/** The `ValidationError` (a `DataflowDefinitionError`) that `parse` throws. */
function failure(value: unknown, options?: ParseOptions): ValidationError {
  try {
    parse(value, options);
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.ok(error instanceof graph.DataflowDefinitionError);
    return error;
  }
  assert.fail("parse accepted an invalid document");
}
const rejects = (mutate: Mutate, message: string) =>
  assert.ok(failure(variant(mutate)).message.includes(message));
const rejectsAt = (value: unknown, path: string) => {
  // TypeBox may identify the union boundary or a selected variant's field.
  const reported = failure(value).path;
  assert.ok(
    reported === path ||
      (path.startsWith("/graph/nodes/") && reported.startsWith(`${path}/`)),
    `expected ${path}, got ${reported}`,
  );
};

for (const id of ["$source", "$sink"])
  test(`reserved node ${id}`, () =>
    rejects((d) => {
      d.graph.nodes[id] = {};
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
      d.graph.edges[0] = { from, to, schema };
    }, message),
  );
test("duplicate edge ids", () =>
  rejects((d) => {
    d.graph.edges.push({ from: "A", to: "B", schema });
  }, 'edge "A->B" declared twice'));
test("trigger must be inbound", () =>
  rejects((d) => {
    d.graph.nodes.B.trigger = "B->$sink";
  }, 'Node "B" trigger references edge "B->$sink" which is not one of its inbound edges'));
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
    d.graph.edges.push({ from: "A", to: "$sink", schema });
  }, "sink.returns is required: $sink has inbound edges from B, A"));
test("prompt references inbound", () =>
  rejects((d) => {
    d.graph.nodes.B.prompt = "{{ wrong }}";
  }, 'Node "B" prompt references edge "wrong" which is not one of its inbound edges'));

test("removed contracts field is rejected", () => {
  assert.throws(
    () =>
      parse(
        variant((d) => {
          d.graph.nodes.B.contracts = { "A->B": "report" };
        }),
      ),
    ValidationError,
  );
});
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
for (const mode of ["input", "value", "empty"])
  test(`invalid emit ${mode}`, () =>
    rejects((d) => {
      d.graph.nodes.A = { kind: "emit", text: "go" };
      if (mode === "input")
        d.graph.edges.push({ from: "B", to: "A", kind: "message", schema });
      if (mode === "empty") d.graph.edges.shift();
    }, 'Node "A" (emit) must have no inbound edges and only message outbound edges (at least one)'));
test("YAML rejects a code module registry", () =>
  rejectsAt(
    variant((d) => {
      d.code = { B: "./impl.ts" };
    }),
    "/code",
  ));
test("identifiers, duplicates, source routes and sink results", () => {
  const routed = (routes: Json, extra: JsonObject[] = []): LooseDoc => ({
    graph: {
      source: { routes },
      nodes: { A: {}, B: {} },
      edges: [
        { from: "$source", to: "A", kind: "message", schema },
        ...base().graph.edges,
        ...extra,
      ],
    },
  });
  const wrapper = (routes?: Json): LooseDoc => ({
    graph: {
      nodes: {
        S: { kind: "code" },
        N: {
          kind: "graph",
          graph: {
            ...(routes === undefined ? {} : { source: { routes } }),
            nodes: { W: {} },
            edges: [{ from: "W", to: "$sink", schema }],
          },
        },
      },
      edges: [
        { from: "S", to: "N", schema },
        { from: "N", to: "$sink", schema },
      ],
    },
  });
  const emitter = (returns?: string): LooseDoc => ({
    graph: {
      ...(returns === undefined ? {} : { sink: { returns } }),
      nodes: { E: { kind: "emit", text: "go" }, C: { kind: "code" } },
      edges: [
        { from: "E", to: "$sink", kind: "message", schema },
        ...(returns === undefined
          ? []
          : [
              { from: "E", to: "C", kind: "message", schema },
              { from: "C", to: "$sink", schema },
            ]),
      ],
    },
  });
  const registries = { mcp: { m: { command: "x" } }, skills: { s: "./s" } };
  const rejected: [
    label: string,
    doc: LooseDoc,
    code: string,
    path: string,
    first?: string,
  ][] = [
    [
      "blank node key",
      variant((d) => {
        d.graph.nodes[" "] = {};
      }),
      "identifier",
      "/graph/nodes/ ",
    ],
    [
      "empty edge id",
      variant((d) => {
        d.graph.edges[0]!.id = "";
      }),
      "identifier",
      "/graph/edges/0/id",
    ],
    [
      "blank endpoint",
      variant((d) => {
        d.graph.edges[0]!.from = "\t";
      }),
      "identifier",
      "/graph/edges/0/from",
    ],
    [
      "blank registry key",
      variant((d) => {
        d.skills = { "": "./s" };
      }),
      "identifier",
      "/skills/",
    ],
    [
      "blank trigger",
      variant((d) => {
        d.graph.nodes.B!.trigger = " ";
      }),
      "identifier",
      "/graph/nodes/B/trigger",
    ],
    [
      "blank returns",
      variant((d) => {
        d.graph.sink = { returns: "" };
      }),
      "identifier",
      "/graph/sink/returns",
    ],
    [
      "blank route key",
      routed({ " ": ["$source~>A"] }),
      "identifier",
      "/graph/source/routes/ ",
    ],
    [
      "blank tool",
      variant((d) => {
        d.graph.nodes.A!.tools = [""];
      }),
      "identifier",
      "/graph/nodes/A/tools/0",
    ],
    [
      "duplicate edge",
      variant((d) => {
        d.graph.edges.push({ from: "A", to: "B", schema });
      }),
      "duplicate",
      "/graph/edges/2",
      "/graph/edges/0",
    ],
    [
      "duplicate trigger",
      variant((d) => {
        d.graph.nodes.B!.trigger = { any: ["A->B", "A->B"] };
      }),
      "duplicate",
      "/graph/nodes/B/trigger/any/1",
      "/graph/nodes/B/trigger/any/0",
    ],
    [
      "duplicate tool",
      variant((d) => {
        d.graph.nodes.A!.tools = ["read", "read"];
      }),
      "duplicate",
      "/graph/nodes/A/tools/1",
      "/graph/nodes/A/tools/0",
    ],
    [
      "duplicate mcp",
      variant((d) => {
        Object.assign(d, registries);
        d.graph.nodes.A!.mcp = ["m", "m"];
      }),
      "duplicate",
      "/graph/nodes/A/mcp/1",
      "/graph/nodes/A/mcp/0",
    ],
    [
      "duplicate skill",
      variant((d) => {
        Object.assign(d, registries);
        d.graph.nodes.A!.skills = ["s", "s"];
      }),
      "duplicate",
      "/graph/nodes/A/skills/1",
      "/graph/nodes/A/skills/0",
    ],
    [
      "duplicate route target",
      routed({ in: ["$source~>A", "$source~>A"] }),
      "duplicate",
      "/graph/source/routes/in/1",
      "/graph/source/routes/in/0",
    ],
    ["unrouted source edge", routed({}), "source-route", "/graph/edges/0"],
    [
      "missing parent route",
      wrapper(),
      "source-route",
      "/graph/nodes/N/graph/source/routes",
    ],
    [
      "source result",
      routed({ in: ["$source~>A", "$source~>$sink"] }, [
        { from: "$source", to: "$sink", kind: "message", schema },
      ]),
      "sink-result",
      "/graph/sink/returns",
    ],
    [
      "inferred source result",
      {
        graph: {
          source: { routes: { in: ["$source~>$sink", "$source~>A"] } },
          nodes: { A: {} },
          edges: [
            { from: "$source", to: "$sink", kind: "message", schema: {} },
            { from: "$source", to: "A", kind: "message", schema: {} },
          ],
        },
      },
      "sink-result",
      "/graph/edges/0",
    ],
    ["implicit emit result", emitter(), "sink-result", "/graph/edges/0"],
    [
      "explicit emit result",
      emitter("E"),
      "sink-result",
      "/graph/sink/returns",
    ],
  ];
  const sourceResult = rejected.find(([label]) => label === "source result")![1]
    .graph;
  sourceResult.sink = { returns: "$source" };
  for (const [label, doc, code, path, first] of rejected) {
    const error = failure(doc);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    assert.equal(error.path, path, `${label}: ${error.message}`);
    if (first !== undefined)
      assert.ok(error.help.includes(first), `${label}: ${error.help}`);
  }
  for (const doc of [
    routed({ in: ["$source~>A"], again: ["$source~>A"] }),
    wrapper({ "S->N": [] }),
    emitter("C"),
    variant((d) => {
      d.graph.edges.push({ from: "A", to: "B", id: "again", schema });
    }),
    variant((d) => {
      Object.assign(d, registries);
      d.graph.nodes.A!.skills = ["s"];
      d.graph.nodes.B!.skills = ["s"];
    }),
  ])
    parse(doc);
});
for (const [field, value] of [
  ["model", "p/m"],
  ["name", "B"],
] as const)
  test(`code node rejects ${field}`, () =>
    rejectsAt(
      variant((d) => {
        d.graph.nodes.B = { kind: "code", [field]: value };
      }),
      "/graph/nodes/B",
    ));
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
test("YAML and object parsing, default ids", () => {
  assert.equal(edgeId({ from: "A", to: "B", schema }), "A->B");
  assert.equal(edgeId({ from: "A", to: "B", kind: "message", schema }), "A~>B");
  const doc = base();
  assert.equal(parse(doc), doc);
  assert.deepEqual(
    parse(
      "graph:\n  nodes:\n    A: {}\n  edges: [{from: A, to: $sink, schema: {type: number}}]",
    ).graph.nodes.A,
    {},
  );
});
test("params substitute into YAML text before parsing", () => {
  const source =
    'graph:\n  nodes:\n    A:\n      description: "{{ params.description }}"\n  edges:\n    - from: A\n      to: $sink\n      schema: { type: number }\n';
  for (const text of [
    source,
    source.replace("{{ params.description }}", "{{params.description}}"),
  ]) {
    const node = parse(text, { params: { description: "p/m", unused: true } })
      .graph.nodes.A!;
    assert.equal(node.description, "p/m");
  }
  const missing = failure(source, { sourceName: "p.yml" });
  assert.equal(missing.code, "param");
  assert.equal(missing.sourceName, "p.yml");
  assert.deepEqual(missing.location, {
    start: { line: 4, column: 20 },
    end: { line: 4, column: 44 },
  });
  assert.match(missing.help, /params\.description/);
  const objectParams = failure(base(), { params: {} });
  assert.equal(objectParams.code, "param");
  assert.equal(objectParams.location, undefined);
});
test("invalid YAML and strict shape", () => {
  assert.equal(failure("graph: [").code, "yaml");
  for (const [value, code] of [
    [{ ...base(), extra: true }, "document"],
    [{ graph: { nodes: {}, edges: [] } }, "document"],
    [{ graph: { nodes: { A: {} } } }, "sink-result"],
  ] as const)
    assert.equal(failure(value).code, code);
});

type Point = readonly [line: number, column: number];
test("text diagnostics locate the offending token", () => {
  const valid =
    "graph:\n  nodes: { A: {} }\n  edges:\n    - { from: A, to: $sink, schema: { type: number } }\n";
  const block =
    "graph:\n  edges:\n    - from: A\n      to: $sink\n      schema: {}\n";
  const cases: [
    label: string,
    text: string,
    code: string,
    path: string,
    start?: Point,
    end?: Point,
    yaml?: string,
    options?: ParseOptions,
    markedLines?: readonly number[],
  ][] = [
    ["first column", "grph: {}\n", "document", "/", [1, 0], [2, 0]],
    [
      "unicode before token",
      'graph:\n  nodes: { "é😀": {} }\n  edges:\n    - { from: "é😀", to: Nope, schema: { type: number } }\n',
      "reference",
      "/graph/edges/0/to",
      [4, 25],
      [4, 29],
    ],
    [
      "CRLF",
      valid.replace("to: $sink", "to: Nope").replaceAll("\n", "\r\n"),
      "reference",
      "/graph/edges/0/to",
      [4, 21],
      [4, 25],
    ],
    [
      "missing field",
      "graph:\n  edges: []\n",
      "document",
      "/graph",
      [2, 2],
      [3, 0],
    ],
    [
      "missing field of a block container",
      block,
      "document",
      "/graph",
      [2, 2],
      [6, 0],
      undefined,
      undefined,
      [2],
    ],
    [
      "missing field of a CRLF block container",
      block.replaceAll("\n", "\r\n"),
      "document",
      "/graph",
      [2, 2],
      [6, 0],
      undefined,
      undefined,
      [2],
    ],
    [
      "alias-valued key",
      "graph:\n  nodes:\n    A: &node {}\n    $source: *node\n  edges:\n    - { from: A, to: $sink, schema: {} }\n",
      "node",
      "/graph/nodes/$source",
      [4, 4],
      [4, 11],
    ],
    [
      "alias-valued unknown property",
      "graph:\n  nodes: { A: &n {} }\n  extra: *n\n  edges:\n    - { from: A, to: $sink, schema: {} }\n",
      "document",
      "/graph/extra",
      [3, 2],
      [3, 7],
    ],
    [
      "missing field beside a merge",
      "graph:\n  nodes:\n    S: { kind: code }\n    N:\n      kind: graph\n      graph:\n        <<: { nodes: { W: {} }, edges: [{ from: W, to: $sink, schema: {} }] }\n  edges: [{ from: S, to: N, schema: {} }, { from: N, to: $sink, schema: {} }]\n",
      "source-route",
      "/graph/nodes/N/graph/source/routes",
      [7, 8],
      [8, 0],
      undefined,
      undefined,
      [7],
    ],
    [
      "unknown field",
      "graph:\n  nodes:\n    A: { kidn: code }\n  edges: []\n",
      "document",
      "/graph/nodes/A/kidn",
      [3, 9],
      [3, 13],
    ],
    [
      "escaped pointer id",
      "graph:\n  nodes:\n    a/b~c: { trigger: nope }\n  edges:\n    - { from: a/b~c, to: $sink, schema: { type: number } }\n",
      "trigger",
      "/graph/nodes/a~1b~0c/trigger",
      [3, 22],
      [3, 26],
    ],
    [
      "alias use",
      "graph:\n  nodes: { A: { description: &t Nope } }\n  edges:\n    - { from: A, to: *t, schema: { type: number } }\n",
      "reference",
      "/graph/edges/0/to",
      [4, 21],
      [4, 23],
    ],
    [
      "merged value",
      "graph:\n  nodes: { A: {}, B: {} }\n  edges:\n    - &e { id: x, from: A, to: $sink, schema: { type: number } }\n    - { <<: *e, from: B }\n",
      "duplicate",
      "/graph/edges/1/id",
      [5, 12],
      [5, 14],
    ],
    [
      "inline merge",
      "graph:\n  nodes:\n    A: {}\n    B:\n      <<: { kidn: code }\n  edges: []\n",
      "document",
      "/graph/nodes/B/kidn",
      [5, 10],
      [5, 24],
    ],
    [
      "multiline scalar",
      "graph:\n  nodes:\n    A:\n      prompt: |\n        hi {{ nope }}\n  edges:\n    - { from: A, to: $sink, schema: { type: number } }\n",
      "reference",
      "/graph/nodes/A/prompt",
      [4, 14],
      [6, 0],
    ],
    ["EOF", "graph:\n  edges: [", "yaml", "/", [2, 10], [2, 10]],
    ["EOF after newline", "graph:\n  edges: [\n", "yaml", "/", [3, 0], [3, 0]],
    [
      "duplicate key",
      `${valid}  edges: []\n`,
      "yaml",
      "/",
      [5, 2],
      [5, 3],
      "DUPLICATE_KEY",
    ],
    [
      "1 and '1'",
      "graph:\n  nodes:\n    1: {}\n    '1': {}\n",
      "yaml",
      "/",
      [4, 4],
      [4, 5],
      "DUPLICATE_KEY",
    ],
    [
      "complex key",
      "graph:\n  ? [a]\n  : {}\n",
      "yaml",
      "/",
      [2, 4],
      [2, 5],
      "NON_STRING_KEY",
    ],
    [
      "YAML 1.3",
      `%YAML 1.3\n---\n${valid}`,
      "yaml",
      "/",
      [1, 6],
      [1, 9],
      "BAD_DIRECTIVE",
    ],
    [
      "ambiguous alias",
      "a: &foo: bar\nb: *foo:\n",
      "yaml",
      "/",
      [1, 7],
      [1, 8],
      "BAD_ALIAS",
    ],
    [
      "unknown tag",
      "graph: !foo 1\n",
      "yaml",
      "/",
      [1, 7],
      [1, 11],
      "TAG_RESOLVE_FAILED",
    ],
    ["unknown alias", "graph: *nope\n", "yaml", "/", [1, 7], [1, 12]],
    [
      "cyclic alias",
      valid.replace(
        "{ type: number }",
        "&s { type: object, properties: { self: *s } }",
      ),
      "document",
      "/graph/edges/0/schema/properties/self",
      [4, 75],
      [4, 77],
    ],
    [
      "missing param",
      "graph:\n  name: {{ params.x }}\n",
      "param",
      "/",
      [2, 8],
      [2, 22],
      undefined,
      { sourceName: "t.yml" },
    ],
    [
      "expanded param",
      "graph:\n  name: {{ params.x }}\n  nodes: {}\n",
      "yaml",
      "/",
      [3, 2],
      [3, 3],
      undefined,
      { sourceName: "t.yml", params: { x: "[" } },
    ],
  ];
  let bomb = "a: &a [x, x, x, x, x, x, x, x, x, x]\n";
  for (const [prev, next] of ["ab", "bc", "cd", "de"])
    bomb += `${next}: &${next} [${Array(10).fill(`*${prev}`).join(", ")}]\n`;
  cases.push(["alias exhaustion", bomb, "yaml", "/"]);
  for (const [
    label,
    text,
    code,
    path,
    start,
    end,
    yaml,
    options,
    markedLines,
  ] of cases) {
    const error = failure(text, options);
    const at = `${label}: ${error.message}`;
    assert.equal(error.code, code, at);
    assert.equal(error.path, path, at);
    assert.equal(
      error.sourceName,
      options?.params ? "t.yml (expanded)" : (options?.sourceName ?? "<yaml>"),
      at,
    );
    assert.deepEqual(
      error.location,
      start && end
        ? {
            start: { line: start[0], column: start[1] },
            end: { line: end[0], column: end[1] },
          }
        : undefined,
      at,
    );
    if (yaml !== undefined)
      assert.ok(
        error.cause instanceof YAMLError && error.cause.code === yaml,
        at,
      );
    assert.ok(!error.message.includes("\x1b"), at);
    assert.match(error.message, /\nhelp: \S/, at);
    if (start === undefined || end === undefined) {
      assert.ok(!error.message.includes(" | "), at);
      continue;
    }
    assert.ok(error.message.includes(`:${start[0]}:${start[1] + 1}\n`), at);
    // Babel marks each highlighted line; the exclusive end line stays unmarked.
    const marked = [...error.message.matchAll(/^> +(\d+) \|/gm)].map(
      ([, line]) => Number(line),
    );
    const last = end[1] === 0 && end[0] > start[0] ? end[0] - 1 : end[0];
    assert.deepEqual(
      marked,
      markedLines ??
        Array.from({ length: last - start[0] + 1 }, (_, i) => start[0] + i),
      at,
    );
  }
});
test("object input reports the same error without a source frame", () => {
  const error = failure({
    graph: {
      nodes: { A: {} },
      edges: [{ from: "A", to: "Nope", schema: { type: "number" } }],
    },
  });
  assert.equal(error.code, "reference");
  assert.equal(error.path, "/graph/edges/0/to");
  assert.match(error.help, /declare "Nope"/);
  assert.equal(error.sourceName, undefined);
  assert.equal(error.location, undefined);
  assert.ok(!error.message.includes(" | "));
});
test("YAML merges, overrides and scalar keys keep their semantics", () => {
  const doc = parse(`graph:
  nodes:
    A: &code { kind: code, trigger: always }
    B:
      <<: *code
      <<: { description: merged }
      trigger: A->B
    C:
      <<: [{ kind: code }, *code]
  edges:
    - &edge { from: A, to: B, schema: { type: number } }
    - { <<: *edge, from: B, to: C }
    - { <<: *edge, from: C, to: $sink }
`);
  assert.deepEqual(doc.graph.nodes, {
    A: { kind: "code", trigger: "always" },
    B: { kind: "code", trigger: "A->B", description: "merged" },
    C: { kind: "code", trigger: "always" },
  });
  assert.deepEqual(doc.graph.edges?.[1], {
    from: "B",
    to: "C",
    schema: { type: "number" },
  });
  const keys = parse(
    "graph:\n  nodes: { 1: {}, true: {}, null: {} }\n  edges:\n    - { from: '1', to: 'true', schema: { type: number } }\n    - { from: 'true', to: 'null', schema: { type: number } }\n    - { from: 'null', to: $sink, schema: { type: number } }\n",
  );
  assert.deepEqual(Object.keys(keys.graph.nodes), ["1", "true", "null"]);
});

test("complete block YAML preserves every registry, node, edge and scalar", () => {
  const yaml = `# Complete grammar using block mappings.
mcp:
  fast:
    command: fixture-mcp
  full:
    command: fixture-mcp
    args: ["--stdio"]
    cwd: "."
    env:
      MODE: fixture
    timeout: 250
skills:
  guide: guide/SKILL.md
graph:
  name: full
  window: 2
  threads: 3
  source:
    description: external input fan-out
    routes:
      external: [ingress, start]
  sink:
    description: final result fan-in
    trigger:
      all: [done]
    returns: Final
  nodes:
    Seed:
      kind: code
      description: seeds message recipients
      trigger: start
    "Agent:1":
      kind: agent
      description: receives either input
      system: |-
        first system line
        second system line
      tools: [read, custom]
      mcp: [fast, full]
      skills: [guide]
      trigger:
        any: [ingress, seed]
      prompt: |-
        External: {{ ingress }}
        Seed: {{ seed }}
    Ralph:
      description: revises the seeded assignment
      system: revise the assignment
      tools: [custom]
      mcp: [full]
      skills: [guide]
      prompt: "{{ ralph-input }}"
    Child:
      kind: graph
      description: nested work
      trigger: ralph-output
      graph:
        name: child
        threads: unbounded
        source:
          description: child ingress
          routes:
            ralph-output: [child-input]
        sink:
          description: child egress
          trigger: child-result
          returns: Worker
        nodes:
          Worker:
            system: work
            trigger: child-input
            prompt: "{{ child-input }}"
        edges:
          - from: $source
            to: Worker
            kind: message
            id: child-input
            schema: &prompt
              type: object
              required: [kind, text]
              properties:
                kind: { const: prompt }
                text: { type: string }
          - from: Worker
            to: $sink
            id: child-result
            schema: &result { type: string }
    Final:
      system: combine both reports
      trigger:
        all: [agent-answer, child-answer]
      prompt: "{{ agent-answer }}\\n{{ child-answer }}"
  edges:
    - from: $source
      to: "Agent:1"
      kind: message
      id: ingress
      schema: *prompt
    - from: $source
      to: Seed
      kind: message
      id: start
      schema: *prompt
    - from: Seed
      to: "Agent:1"
      kind: message
      id: seed
      schema: *prompt
    - from: Seed
      to: Ralph
      kind: message
      id: ralph-input
      schema: *prompt
    - from: Ralph
      to: Child
      kind: message
      id: ralph-output
      schema: *result
    - from: "Agent:1"
      to: Final
      kind: value
      id: agent-answer
      schema: *result
    - from: Child
      to: Final
      id: child-answer
      schema: *result
    - from: Final
      to: $sink
      id: done
      schema: *result
`;
  const prompt = {
    type: "object",
    required: ["kind", "text"],
    properties: { kind: { const: "prompt" }, text: { type: "string" } },
  };
  const result = { type: "string" };
  const expected = {
    mcp: {
      fast: { command: "fixture-mcp" },
      full: {
        command: "fixture-mcp",
        args: ["--stdio"],
        cwd: ".",
        env: { MODE: "fixture" },
        timeout: 250,
      },
    },
    skills: { guide: "guide/SKILL.md" },
    graph: {
      name: "full",
      window: 2,
      threads: 3,
      source: {
        description: "external input fan-out",
        routes: { external: ["ingress", "start"] },
      },
      sink: {
        description: "final result fan-in",
        trigger: { all: ["done"] },
        returns: "Final",
      },
      nodes: {
        Seed: {
          kind: "code",
          description: "seeds message recipients",
          trigger: "start",
        },
        "Agent:1": {
          kind: "agent",
          description: "receives either input",
          system: "first system line\nsecond system line",
          tools: ["read", "custom"],
          mcp: ["fast", "full"],
          skills: ["guide"],
          trigger: { any: ["ingress", "seed"] },
          prompt: "External: {{ ingress }}\nSeed: {{ seed }}",
        },
        Ralph: {
          description: "revises the seeded assignment",
          system: "revise the assignment",
          tools: ["custom"],
          mcp: ["full"],
          skills: ["guide"],
          prompt: "{{ ralph-input }}",
        },
        Child: {
          kind: "graph",
          description: "nested work",
          trigger: "ralph-output",
          graph: {
            name: "child",
            threads: "unbounded",
            source: {
              description: "child ingress",
              routes: { "ralph-output": ["child-input"] },
            },
            sink: {
              description: "child egress",
              trigger: "child-result",
              returns: "Worker",
            },
            nodes: {
              Worker: {
                system: "work",
                trigger: "child-input",
                prompt: "{{ child-input }}",
              },
            },
            edges: [
              {
                from: "$source",
                to: "Worker",
                kind: "message",
                id: "child-input",
                schema: prompt,
              },
              {
                from: "Worker",
                to: "$sink",
                id: "child-result",
                schema: result,
              },
            ],
          },
        },
        Final: {
          system: "combine both reports",
          trigger: { all: ["agent-answer", "child-answer"] },
          prompt: "{{ agent-answer }}\n{{ child-answer }}",
        },
      },
      edges: [
        {
          from: "$source",
          to: "Agent:1",
          kind: "message",
          id: "ingress",
          schema: prompt,
        },
        {
          from: "$source",
          to: "Seed",
          kind: "message",
          id: "start",
          schema: prompt,
        },
        {
          from: "Seed",
          to: "Agent:1",
          kind: "message",
          id: "seed",
          schema: prompt,
        },
        {
          from: "Seed",
          to: "Ralph",
          kind: "message",
          id: "ralph-input",
          schema: prompt,
        },
        {
          from: "Ralph",
          to: "Child",
          kind: "message",
          id: "ralph-output",
          schema: result,
        },
        {
          from: "Agent:1",
          to: "Final",
          kind: "value",
          id: "agent-answer",
          schema: result,
        },
        { from: "Child", to: "Final", id: "child-answer", schema: result },
        { from: "Final", to: "$sink", id: "done", schema: result },
      ],
    },
  };
  const parsed = parse(yaml);
  assert.deepEqual(parsed, expected);
  // YAML anchors stay shared objects; parsing accepts acyclic aliases.
  assert.equal(parsed.graph.edges![0]!.schema, parsed.graph.edges![1]!.schema);
  assert.equal(parse(expected), expected);
  assert.deepEqual(Object.keys(parse(yaml).graph.nodes), [
    "Seed",
    "Agent:1",
    "Ralph",
    "Child",
    "Final",
  ]);
  assert.deepEqual(parse(yaml).graph.edges?.map(edgeId), [
    "ingress",
    "start",
    "seed",
    "ralph-input",
    "ralph-output",
    "agent-answer",
    "child-answer",
    "done",
  ]);
});

test("schema rejects non-documents and missing required fields at stable paths", () => {
  for (const value of [null, 1, true, [], "plain scalar"])
    rejectsAt(value, "/");
  rejectsAt({}, "/");
  const cases: [unknown, string][] = [
    [{ graph: {} }, "/graph"],
    [{ graph: { nodes: {} } }, "/graph/nodes"],
    [{ graph: { nodes: { A: { kind: "emit" } } } }, "/graph/nodes/A"],
    [{ graph: { nodes: { A: { kind: "graph" } } } }, "/graph/nodes/A"],
    [{ ...base(), mcp: { server: {} } }, "/mcp/server"],
  ];
  for (const [value, path] of cases) rejectsAt(value, path);
});

test("numeric grammar preserves positive widths and unrestricted integer MCP timeout", () => {
  for (const field of ["window", "threads"] as const) {
    for (const value of [1, 2, ...(field === "threads" ? ["unbounded"] : [])]) {
      const doc = variant((d) => {
        d.graph[field] = value;
      });
      assert.equal(parse(doc).graph[field], value);
    }
    for (const value of [0, -1, 1.5, "2", null, true, false]) {
      rejectsAt(
        variant((d) => {
          d.graph[field] = value;
        }),
        `/graph/${field}`,
      );
    }
  }
  for (const timeout of [-1, 0, 250]) {
    const doc = { ...base(), mcp: { server: { command: "unused", timeout } } };
    assert.equal(parse(doc).mcp?.server?.timeout, timeout);
  }
  for (const timeout of [1.5, "250"])
    rejectsAt(
      { ...base(), mcp: { server: { command: "unused", timeout } } },
      "/mcp/server/timeout",
    );
});

test("agents reject YAML model and thinking fields", () => {
  for (const field of [{ model: "p/m" }, { thinking: "high" }])
    rejectsAt(
      variant((d) => {
        Object.assign(d.graph.nodes.A, field);
      }),
      "/graph/nodes/A",
    );
});

test("strict object boundaries and malformed list/map entries", () => {
  const cases: [string, Mutate][] = [
    ["/extra", (d) => (d.extra = true)],
    [
      "/mcp/server/extra",
      (d) => (d.mcp = { server: { command: "unused", extra: true } }),
    ],
    ["/graph/extra", (d) => (d.graph.extra = true)],
    ["/graph/source/extra", (d) => (d.graph.source = { extra: true })],
    ["/graph/sink/extra", (d) => (d.graph.sink = { extra: true })],
    [
      "/graph/source/profiles",
      (d) => (d.graph.source = { profiles: { memory: "1 MB" } }),
    ],
    [
      "/graph/sink/profiles",
      (d) => (d.graph.sink = { profiles: { memory: "1 MB" } }),
    ],
    [
      "/graph/nodes/A/profiles/cpu",
      (d) => (d.graph.nodes.A.profiles = { cpu: "1 s" }),
    ],
    [
      "/graph/nodes/A/profiles/memory",
      (d) => (d.graph.nodes.A.profiles = { memory: "fast" }),
    ],
    ["/graph/edges/0/extra", (d) => (d.graph.edges[0].extra = true)],
    ...["agent", "emit", "graph"].map((kind): [string, Mutate] => [
      "/graph/nodes/A",
      (d) => {
        d.graph.nodes.A = {
          ...(kind === "graph"
            ? { graph: nested().graph }
            : kind === "emit"
              ? { text: "go" }
              : {}),
          kind,
          extra: true,
        };
      },
    ]),
    ["/graph/nodes/A", (d) => (d.graph.nodes.A.kind = "unknown")],
    ["/graph/edges/0/kind", (d) => (d.graph.edges[0].kind = "unknown")],
    ["/graph/edges/0/from", (d) => (d.graph.edges[0].from = 1)],
    ["/graph/edges/0/to", (d) => (d.graph.edges[0].to = null)],
    ["/graph/edges/0/id", (d) => (d.graph.edges[0].id = false)],
    [
      "/graph/edges",
      (d) => {
        const graph: JsonObject = d.graph;
        graph.edges = {};
      },
    ],
    [
      "/graph/source/routes/seed/0",
      (d) => (d.graph.source = { routes: { seed: [1] } }),
    ],
    [
      "/graph/source/routes/seed",
      (d) => (d.graph.source = { routes: { seed: "edge" } }),
    ],
    ["/skills/guide", (d) => (d.skills = { guide: 2 })],
    [
      "/mcp/server/env/MODE",
      (d) => (d.mcp = { server: { command: "unused", env: { MODE: false } } }),
    ],
    [
      "/mcp/server/args/0",
      (d) => (d.mcp = { server: { command: "unused", args: [1] } }),
    ],
    [
      "/mcp/server/cwd",
      (d) => (d.mcp = { server: { command: "unused", cwd: 1 } }),
    ],
    ...["tools", "skills", "mcp", "system", "prompt", "description"].map(
      (field): [string, Mutate] => [
        "/graph/nodes/A",
        (d) => {
          d.graph.nodes.A[field] = [2];
        },
      ],
    ),
  ];
  for (const [path, mutate] of cases) rejectsAt(variant(mutate), path);
  for (const trigger of [
    { all: [{ any: ["A->B"] }] },
    { not: "A->B" },
    { all: [], any: [] },
    { all: [], extra: true },
    { any: [2] },
  ]) {
    const doc = variant((d) => {
      d.graph.nodes.B.trigger = trigger;
    });
    rejectsAt(doc, "/graph/nodes/B");
    delete doc.graph.nodes.B.trigger;
    doc.graph.sink = { trigger };
    rejectsAt(doc, "/graph/sink/trigger");
  }
});

test("resource quantities parse on every node kind and reject unknown units", () => {
  const profiles = {
    memory: "512 MB",
    runtime: "1.5 s",
    tokens: "4000 tok",
    cost: "0.125 USD",
  };
  const doc = parse({
    graph: {
      nodes: {
        Start: { kind: "emit", text: "go", profiles },
        A: { profiles },
        C: { kind: "code", profiles },
        Inner: {
          kind: "graph",
          profiles,
          graph: {
            source: { routes: { "C->Inner": [] } },
            nodes: { W: {} },
            edges: [{ from: "W", to: "$sink", schema }],
          },
        },
      },
      edges: [
        { from: "Start", to: "A", kind: "message", schema },
        { from: "A", to: "C", schema },
        { from: "C", to: "Inner", schema },
        { from: "Inner", to: "$sink", schema },
      ],
    },
  });
  for (const node of Object.values(doc.graph.nodes))
    assert.deepEqual(node.profiles, profiles);
  const error = failure(
    variant((d) => {
      d.graph.nodes.A.profiles = { memory: "1 MBs" };
    }),
  );
  assert.equal(error.code, "profile");
  assert.equal(error.path, "/graph/nodes/A/profiles/memory");
  assert.match(error.message, /"MBs"/);
  assert.match(error.help, /MiB/);
  const costError = failure(
    variant((d) => {
      d.graph.nodes.A.profiles = { cost: "1 dollars" };
    }),
  );
  assert.equal(costError.path, "/graph/nodes/A/profiles/cost");
});

test("all builtins, collision identities and legal parallel edges", () => {
  for (const name of ["yield", "info", "send", "recv", "task"])
    rejects((d) => {
      d.graph.nodes.A.tools = [name];
    }, `tool "${name}" is builtin and always on`);
  rejects((d) => {
    d.graph.edges[0].id = "shared";
    d.graph.edges[1] = {
      from: "B",
      to: "$sink",
      kind: "message",
      id: "shared",
      schema,
    };
  }, 'edge "shared" declared twice');
  rejects((d) => {
    d.graph.edges.push({ from: "A", to: "B", kind: "value", schema });
  }, 'edge "A->B" declared twice');
  const doc = variant((d) => {
    d.graph.edges.push(
      { from: "A", to: "B", kind: "message", schema },
      { from: "A", to: "B", id: "custom", schema },
      { from: "B", to: "$sink", kind: "message", schema },
    );
    d.graph.nodes.B.prompt = "{{ custom }} / {{custom}}";
  });
  assert.deepEqual(parse(doc).graph.edges?.map(edgeId), [
    "A->B",
    "B->$sink",
    "A~>B",
    "custom",
    "B~>$sink",
  ]);
  doc.graph.edges.push({ from: "A", to: "$sink", schema });
  doc.graph.sink = { returns: "B" };
  assert.equal(parse(doc).graph.sink?.returns, "B");
  for (const edges of [undefined, []])
    rejectsAt(
      variant((d) => {
        const graph: JsonObject = d.graph;
        graph.edges = edges;
      }),
      "/graph",
    );
});

test("recursive validation accepts connected graphs with cycles", () => {
  const fixture = nested();
  const { routes } = fixture.graph.nodes.A.graph.source;
  const child: LooseGraph = fixture.graph.nodes.A.graph;
  const doc: LooseDoc = fixture;
  doc.graph.nodes.Seed = { kind: "emit", text: "go" };
  doc.graph.edges.unshift({
    from: "Seed",
    to: "A",
    kind: "message",
    id: "incoming",
    schema,
  });
  child.nodes.Other = {};
  child.edges.push({
    from: "$source",
    to: "Other",
    kind: "message",
    id: "other",
    schema,
  });
  child.edges.push({ from: "Other", to: "W", schema });
  routes.incoming.push("other");
  assert.equal(parse(doc), doc);
  for (const trigger of ["wrong", { all: ["incoming", "incoming"] }]) {
    doc.graph.nodes.A.trigger = trigger;
    rejectsAt(doc, "/graph/nodes/A/trigger");
  }
  delete doc.graph.nodes.A.trigger;
  for (const trigger of ["wrong", { any: ["A->$sink", "A->$sink"] }]) {
    doc.graph.sink = { trigger };
    assert.match(failure(doc).path, /^\/graph\/sink\/trigger/);
  }
  delete doc.graph.sink;
  routes.incoming = ["W->$sink"];
  rejectsAt(doc, "/graph/nodes/A/graph/source/routes/incoming");
  routes.incoming = ["$source~>W", "other"];
  for (const id of ["$source", "$sink"]) {
    child.nodes[id] = {};
    rejectsAt(doc, `/graph/nodes/A/graph/nodes/${id}`);
    delete child.nodes[id];
  }
  child.edges.push({ from: "Missing", to: "W", schema });
  rejectsAt(doc, `/graph/nodes/A/graph/edges/${child.edges.length - 1}/from`);
  child.edges.pop();
  child.edges.push({ from: "Other", to: "$sink", schema });
  rejectsAt(doc, "/graph/nodes/A/graph");
  child.sink = { returns: "W" };
  assert.equal(parse(doc), doc);
  const free = variant((d) => {
    d.graph.nodes.Root = {};
    d.graph.edges.push({ from: "Root", to: "A", schema });
    d.graph.edges.push(
      { from: "B", to: "A", kind: "message", schema },
      { from: "A", to: "A", kind: "message", schema },
    );
  });
  assert.equal(parse(free), free);
  rejectsAt(
    variant((d) => {
      d.graph.nodes["a/b~c"] = { prompt: "{{missing}}" };
    }),
    "/graph/nodes/a~1b~0c",
  );
});

test("emit fan-out degrees", () => {
  const doc = variant((d) => {
    d.graph.nodes.A = { kind: "emit", text: "go" };
    for (const e of d.graph.edges) e.kind = "message";
    d.graph.nodes.C = {};
    d.graph.edges.push(
      { from: "A", to: "C", kind: "message", schema },
      { from: "C", to: "B", schema },
    );
  });
  assert.equal(parse(doc), doc);
});

test("graph topology needs one entry, one exit and full connectivity", () => {
  const g = (edges: [string, string][], extra: JsonObject = {}) => {
    const nodes: Record<string, JsonObject> = {};
    for (const [from, to] of edges)
      for (const id of [from, to]) if (!id.startsWith("$")) nodes[id] ??= {};
    return {
      graph: {
        ...extra,
        nodes,
        edges: edges.map(([from, to]) => ({
          from,
          to,
          kind: from === "$source" || from === "E" ? "message" : "value",
          schema,
        })),
      },
    };
  };
  const emit = g(
    [
      ["E", "A"],
      ["E", "B"],
      ["A", "$sink"],
      ["B", "$sink"],
    ],
    {
      sink: { returns: "A" },
    },
  );
  emit.graph.nodes.E = { kind: "emit", text: "go" };
  for (const doc of [
    g([
      ["A", "B"],
      ["B", "$sink"],
    ]),
    g(
      [
        ["$source", "A"],
        ["$source", "B"],
        ["A", "C"],
        ["B", "C"],
        ["C", "$sink"],
      ],
      {
        source: { routes: { in: ["$source~>A", "$source~>B"] } },
      },
    ),
    emit,
    g([
      ["Root", "A"],
      ["A", "B"],
      ["B", "A"],
      ["B", "$sink"],
    ]),
  ])
    assert.equal(parse(doc), doc);
  const twoRoots = g(
    [
      ["A", "$sink"],
      ["B", "$sink"],
    ],
    { sink: { returns: "A" } },
  );
  const outer = g([["W", "$sink"]]);
  outer.graph.nodes.W = { kind: "graph", graph: twoRoots.graph };
  for (const [doc, code, path, ids] of [
    [twoRoots, "entry-count", "/graph/nodes", ["A", "B"]],
    [
      g([
        ["A", "$sink"],
        ["A", "Leaf"],
      ]),
      "exit-count",
      "/graph/nodes/Leaf",
      ["Leaf"],
    ],
    [
      g([
        ["A", "$sink"],
        ["B", "C"],
        ["C", "B"],
      ]),
      "unreachable",
      "/graph/nodes/B",
      ["B", "C"],
    ],
    [
      g([
        ["A", "$sink"],
        ["A", "B"],
        ["B", "C"],
        ["C", "B"],
      ]),
      "no-sink-path",
      "/graph/nodes/B",
      ["B", "C"],
    ],
    [
      g([
        ["A", "B"],
        ["B", "A"],
        ["B", "$sink"],
      ]),
      "entry-count",
      "/graph/nodes",
      ["(none)"],
    ],
    [
      variant((d) => {
        d.graph.nodes.Isolated = {};
      }),
      "entry-count",
      "/graph/nodes",
      ["Isolated"],
    ],
    [outer, "entry-count", "/graph/nodes/W/graph/nodes", ["A", "B"]],
  ] as const) {
    const error = failure(doc);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    for (const id of ids) assert.ok(error.message.includes(id), error.message);
  }
});

test("trigger forms and defaults mirror engine", () => {
  const doc = parse(base());
  const edges = wired(doc.graph);
  for (const [input, kind, rule] of [
    ["always", "all", []],
    ["never", "any", []],
    ["A->B", "all", ["A->B"]],
    [{ all: ["A->B"] }, "all", ["A->B"]],
    [{ any: ["A->B"] }, "any", ["A->B"]],
    [undefined, "all", ["A->B"]],
  ] as const) {
    assert.deepEqual(
      resolveTrigger(doc.graph, "B", edges, input as TriggerSpec),
      { kind, rule },
    );
  }
  assert.deepEqual(resolveTrigger(doc.graph, "A", edges), {
    kind: "all",
    rule: [],
  });
});
test("resolved node, wrapper and sink rules preserve ordering and native readiness", () => {
  const cases = [
    ["always", "all", [], [true, true, true, true]],
    ["never", "any", [], [false, false, false, false]],
    ["m", "all", ["m"], [false, true, false, true]],
    [{ all: ["m", "v"] }, "all", ["m", "v"], [false, false, false, true]],
    [{ any: ["m", "v"] }, "any", ["m", "v"], [false, true, true, true]],
    [{ all: [] }, "all", [], [true, true, true, true]],
    [{ any: [] }, "any", [], [false, false, false, false]],
    [undefined, "all", ["v", "m"], [false, false, false, true]],
  ] as const;
  for (const target of ["Consumer", "Wrapper", "$sink"]) {
    const spec: GraphSpec = {
      nodes: {},
      edges: [
        { from: "A", to: target, id: "v", schema: StringSchema },
        {
          from: "B",
          to: target,
          kind: "message",
          id: "m",
          schema: NumberSchema,
        },
      ],
    };
    const ports = new Map<string, graph.Edge<typeof NumberSchema, string>>([
      ["v", graph.Edge.value("v", StringSchema)],
      ["m", graph.Edge.message("m", NumberSchema)],
    ]);
    for (const [input, kind, order, expected] of cases) {
      const rule = resolveTrigger(spec, target, ports, input as TriggerSpec);
      assert.deepEqual(rule, { kind, rule: order });
      const truth: boolean[] = [];
      for (const [mReady, vReady] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ]) {
        const m = graph.Edge.message("m", NumberSchema);
        const v = graph.Edge.value("v", StringSchema);
        if (mReady && E.isLeft(m.transport)) m.transport.left.push(1);
        if (vReady) v.transport = E.right(O.some("value"));
        const inbound = new Map<
          graph.EdgeIdType,
          graph.Edge<typeof NumberSchema, string>
        >([
          [v.id, v],
          [m.id, m],
        ]);
        truth.push(
          graph.trigger.evaluateTrigger(
            rule,
            inbound,
            graph.NodeId.create(target),
          ),
        );
        assert.deepEqual(
          graph.trigger.satisfiedEdges(
            rule,
            inbound,
            graph.NodeId.create(target),
          ),
          order.filter((id) => (id === "m" ? mReady : vReady)),
        );
      }
      assert.deepEqual(truth, expected);
    }
  }
  assert.deepEqual(resolveTrigger(base().graph, "A", wired(base().graph)), {
    kind: "all",
    rule: [],
  });
  for (const id of ["always", "never"]) {
    const doc = variant((d) => {
      d.graph.edges[0].id = id;
      d.graph.nodes.B.trigger = { all: [id] };
    });
    const spec = parse(doc).graph;
    const edges = wired(spec);
    assert.deepEqual(resolveTrigger(spec, "B", edges, { all: [id] }), {
      kind: "all",
      rule: [id],
    });
    assert.deepEqual(resolveTrigger(spec, "B", edges, id), {
      kind: id === "always" ? "all" : "any",
      rule: [],
    });
  }
});

/** `base()` with its first edge (`A->B`) carrying `edgeSchema`. */
const withSchema = (edgeSchema: unknown) => {
  const { graph } = base();
  const [first, ...rest] = graph.edges;
  return {
    graph: { ...graph, edges: [{ ...first, schema: edgeSchema }, ...rest] },
  };
};
const rejectsSchema = (edgeSchema: unknown, path: string, message: RegExp) => {
  const error = failure(withSchema(edgeSchema));
  assert.equal(error.code, "edge-schema");
  assert.equal(error.path, `/graph/edges/0/schema${path}`);
  assert.match(error.message, message);
};

test("every edge kind at every level requires a schema mapping", () => {
  const rejectsWith = (value: unknown, code: string, path: string) => {
    const error = failure(value);
    assert.equal(error.code, code, error.message);
    assert.equal(error.path, path, error.message);
  };
  /** Set (or with `undefined`, delete) an edge's schema. */
  const setSchema = (edge: JsonObject, root: Json | undefined) => {
    if (root === undefined) delete edge.schema;
    else edge.schema = root;
  };
  /** A nested graph under an escaped id whose `kind` edge carries `root`. */
  const nestedEdge = (kind: string | undefined, root: Json | undefined) => {
    const index = kind === "message" ? 0 : 1;
    const edges: JsonObject[] = [
      { from: "$source", to: "W", kind: "message", schema },
      { from: "W", to: "$sink", ...(kind === "value" && { kind }), schema },
    ];
    setSchema(edges[index]!, root);
    const doc: LooseDoc = {
      graph: {
        nodes: {
          "N/a~b": {
            kind: "graph",
            graph: {
              source: { routes: { incoming: ["$source~>W"] } },
              nodes: { W: {} },
              edges,
            },
          },
        },
        edges: [{ from: "N/a~b", to: "$sink", schema }],
      },
    };
    return [doc, `/graph/nodes/N~1a~0b/graph/edges/${index}/schema`] as const;
  };
  const roots = [undefined, 1, "number", true, false, null, [], [schema]];
  for (const kind of [undefined, "value", "message"])
    for (const root of roots) {
      const doc = variant((d) => {
        if (kind === "message") d.graph.nodes.A = { kind: "emit", text: "go" };
        if (kind !== undefined) d.graph.edges[0]!.kind = kind;
        setSchema(d.graph.edges[0]!, root);
      });
      rejectsWith(doc, "edge-schema", "/graph/edges/0/schema");
      const [nestedDoc, path] = nestedEdge(kind, root);
      rejectsWith(nestedDoc, "edge-schema", path);
    }
  const [invalid] = nestedEdge(undefined, { type: "nope" });
  rejectsWith(
    invalid,
    "edge-schema",
    "/graph/nodes/N~1a~0b/graph/edges/1/schema/type",
  );
  // A missing schema under an unused node-union branch stays a document error.
  const [code] = nestedEdge(undefined, undefined);
  code.graph.nodes["N/a~b"]!.kind = "code";
  rejectsWith(code, "document", "/graph/nodes/N~1a~0b/graph");
  rejectsWith(
    variant((d) => {
      d.graph.nodes.A = { kind: "emit" };
    }),
    "document",
    "/graph/nodes/A/kind",
  );
  rejectsWith(
    variant((d) => {
      delete d.graph.edges[0]!.to;
    }),
    "document",
    "/graph/edges/0",
  );
});

test("JSON Schema mappings of every shape parse unchanged", () => {
  for (const edgeSchema of [
    {},
    { type: "number", minimum: 0 },
    {
      type: "object",
      required: ["count"],
      properties: { count: { type: "integer" }, open: true, closed: false },
      additionalProperties: { type: "string" },
    },
    { type: "array", items: { type: "string" }, minItems: 1 },
    { anyOf: [{ type: "number" }, { type: "string", format: "email" }] },
    { const: "done" },
    { enum: ["a", 1, null] },
    { $schema: "https://json-schema.org/draft/2020-12/schema", type: "null" },
    { title: "t", description: "d", $comment: "c", examples: [1] },
  ]) {
    const doc = withSchema(edgeSchema);
    assert.equal(parse(doc).graph.edges?.[0]?.schema, edgeSchema);
  }
});

test("invalid definitions fail at their schema path", () => {
  for (const [edgeSchema, path, message] of [
    [{ type: "nope" }, "/type", /allowed values/],
    [{ minimum: "x" }, "/minimum", /must be number/],
    [{ type: "string", pattern: "(" }, "/pattern", /regex/],
    [{ properties: { a: { type: 1 } } }, "/properties/a/type", /./],
    [{ typo: 1 }, "/typo", /unknown schema keyword "typo"/],
    [{ items: { typo: 1 } }, "/items/typo", /unknown schema keyword/],
    [{ format: "nope" }, "/format", /unknown format "nope"/],
    [
      { $schema: "http://json-schema.org/draft-07/schema#" },
      "/$schema",
      /dialect/,
    ],
    [{ $id: "urn:x" }, "/$id", /not supported/],
    [{ $anchor: "x" }, "/$anchor", /not supported/],
    [
      { $defs: { a: { $dynamicAnchor: "x" } } },
      "/$defs/a/$dynamicAnchor",
      /not supported/,
    ],
    [{ $dynamicRef: "#x" }, "/$dynamicRef", /not supported/],
  ] as const)
    rejectsSchema(edgeSchema, path, message);
});

test("schema data positions are never read as schemas", () => {
  const data = { $ref: "https://example.com", $id: "x", typo: 1, type: "nope" };
  const edgeSchema = {
    const: data,
    enum: [data],
    default: data,
    examples: [data],
  };
  assert.equal(
    parse(withSchema(edgeSchema)).graph.edges?.[0]?.schema,
    edgeSchema,
  );
  rejectsSchema(
    { const: { type: "object" }, $ref: "#/const" },
    "/$ref",
    /does not target a schema/,
  );
});

test("schemas must be acyclic JSON; shared YAML anchors are fine", () => {
  const cyclic: { type: string; properties: Record<string, unknown> } = {
    type: "object",
    properties: {},
  };
  cyclic.properties.self = cyclic;
  rejectsAt(withSchema(cyclic), "/graph/edges/0/schema/properties/self");
  for (const value of [undefined, () => 1, new Date(0), Number.NaN])
    rejectsSchema({ const: value }, "/const", /JSON value/);
  const shared = parse(`graph:
  nodes: { A: {} }
  edges:
    - from: A
      to: $sink
      schema:
        type: object
        properties: { a: &n { type: number }, b: *n }
`).graph.edges![0]!.schema as { properties: Record<string, unknown> };
  assert.equal(shared.properties.a, shared.properties.b);
  assert.throws(
    () =>
      parse(`graph:
  nodes: { A: {} }
  edges:
    - from: A
      to: $sink
      schema: &s { type: object, properties: { self: *s } }
`),
    /junco-syntax: \/graph\/edges\/0\/schema\/properties\/self: cyclic value/,
  );
  // A cyclic document alias is caught before the recursive document check.
  const doc = nested();
  const child: LooseGraph = doc.graph.nodes.A.graph;
  child.nodes.W = { kind: "graph", graph: doc.graph };
  rejectsAt(doc, "/graph/nodes/A/graph/nodes/W/graph");
});

test("local references resolve at parse time; others are rejected", () => {
  for (const edgeSchema of [
    { $defs: { n: { type: "number" } }, $ref: "#/$defs/n" },
    { $defs: { "a b/c": { type: "number" } }, $ref: "#/$defs/a%20b~1c" },
    { type: "object", properties: { next: { $ref: "#" } } },
    { type: "array", items: { $ref: "#" } },
    {
      $defs: {
        node: {
          type: "object",
          properties: {
            children: { type: "array", items: { $ref: "#/$defs/node" } },
          },
        },
      },
      $ref: "#/$defs/node",
    },
  ])
    assert.equal(
      parse(withSchema(edgeSchema)).graph.edges?.[0]?.schema,
      edgeSchema,
    );
  for (const [edgeSchema, path, message] of [
    [{ $ref: "#/$defs/missing" }, "/$ref", /has no target/],
    [{ $ref: "https://example.com/s.json" }, "/$ref", /external reference/],
    [{ $ref: "other.json#/x" }, "/$ref", /external reference/],
    [{ $ref: "#name" }, "/$ref", /anchor reference/],
    [{ $ref: "#" }, "", /reference cycle/],
    [
      {
        $defs: {
          a: { $ref: "#/$defs/b" },
          b: { allOf: [{ $ref: "#/$defs/a" }] },
        },
        $ref: "#/$defs/a",
      },
      "/$defs/a",
      /reference cycle never descends into the payload/,
    ],
  ] as const)
    rejectsSchema(edgeSchema, path, message);
});

/** `base()` with its first edge (`A->B`) of `kind` carrying `edgeSchema` and, unless undefined, `probe`. */
const probed = (
  kind: string | undefined,
  edgeSchema: Json,
  probe: Json | undefined,
) =>
  variant((d) => {
    if (kind === "message") d.graph.nodes.A = { kind: "emit", text: "go" };
    const edge = d.graph.edges[0]!;
    if (kind !== undefined) edge.kind = kind;
    edge.schema = edgeSchema;
    if (probe !== undefined) edge.probe = probe;
  });
test("probes require an explicit top-level numeric type on every edge kind", () => {
  for (const kind of [undefined, "value", "message"]) {
    for (const edgeSchema of [
      { type: "number" },
      { type: "integer" },
      { type: "number", minimum: -1, exclusiveMaximum: 9 },
      { type: "integer", $defs: { n: { minimum: 0 } }, $ref: "#/$defs/n" },
    ])
      assert.equal(
        parse(probed(kind, edgeSchema, true)).graph.edges?.[0]?.probe,
        true,
      );
    for (const edgeSchema of [
      { type: "string" },
      { type: "object" },
      { type: "array", items: { type: "number" } },
      {},
      { minimum: 0, maximum: 9 },
      { const: 1 },
      { enum: [1, 2] },
      { $defs: { n: { type: "number" } }, $ref: "#/$defs/n" },
      { anyOf: [{ type: "number" }, { type: "integer" }] },
      { type: ["number", "integer"] },
    ]) {
      rejectsAt(probed(kind, edgeSchema, true), "/graph/edges/0/probe");
      // Omitted and false probes never restrict the schema.
      for (const probe of [undefined, false])
        assert.equal(
          parse(probed(kind, edgeSchema, probe)).graph.edges?.[0]?.probe,
          probe,
        );
    }
  }
  const error = failure(probed(undefined, { type: "string" }, true));
  assert.equal(error.code, "document");
  assert.equal(error.path, "/graph/edges/0/probe");
  assert.match(error.help, /"integer"/);
});

test("non-boolean probes fail document validation", () => {
  // The derived edge type admits exactly a boolean flag.
  const flagged: EdgeSpec = { from: "A", to: "B", schema: {}, probe: true };
  // @ts-expect-error the flag is not a string
  const quoted: EdgeSpec = { from: "A", to: "B", schema: {}, probe: "true" };
  assert.equal(flagged.probe, true);
  assert.equal(quoted.probe, "true");
  for (const probe of [null, "true", 1, {}])
    rejectsAt(
      probed(undefined, { type: "number" }, probe),
      "/graph/edges/0/probe",
    );
});

test("probe flags survive YAML and are checked at nested levels", () => {
  const yaml = parse(`graph:
  nodes: { A: {} }
  edges:
    - { from: A, to: $sink, schema: { type: integer }, probe: true }
`);
  assert.equal(yaml.graph.edges?.[0]?.probe, true);
  const fixture = nested();
  const child: LooseGraph = fixture.graph.nodes.A.graph;
  const doc: LooseDoc = fixture;
  doc.graph.nodes.Seed = { kind: "emit", text: "go" };
  doc.graph.edges.push({
    from: "Seed",
    to: "A",
    kind: "message",
    id: "incoming",
    schema,
    probe: true,
  });
  child.edges[0]!.probe = true;
  child.edges[1]!.probe = true;
  assert.equal(parse(doc).graph.nodes.A?.kind, "graph");
  child.edges[1]!.schema = { type: "string" };
  rejectsAt(doc, "/graph/nodes/A/graph/edges/1/probe");
  child.edges[1]!.probe = false;
  doc.graph.edges[0]!.schema = { type: "boolean" };
  doc.graph.edges[0]!.probe = true;
  rejectsAt(doc, "/graph/edges/0/probe");
});
