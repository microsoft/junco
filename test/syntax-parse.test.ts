import { test } from "bun:test";
import assert from "node:assert/strict";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { graph } from "junco-agency";
import { edgeId, parse, resolveTrigger } from "../src/syntax/parse.ts";

const base = () => ({
  graph: {
    nodes: { A: {}, B: {} },
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "$sink" },
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
            { from: "$source", to: "W", kind: "message" },
            { from: "W", to: "$sink" },
          ],
        },
      },
    },
    edges: [{ from: "A", to: "$sink" }],
  },
});
/** A mutated copy of `base()`; loose typing lets cases spell invalid shapes. */
const variant = (mutate: (doc: any) => void) => {
  const doc: any = base();
  mutate(doc);
  return doc;
};
const rejects = (mutate: (doc: any) => void, message: string) => {
  assert.throws(
    () => parse(variant(mutate)),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message.includes(message),
  );
};
const rejectsAt = (value: unknown, path: string) =>
  assert.throws(
    () => parse(value),
    (error) => {
      if (!(error instanceof graph.DataflowDefinitionError)) return false;
      // TypeBox may identify the union boundary or a selected variant's field.
      const reported = error.message.match(/^junco-syntax: ([^:]+):/)?.[1];
      return (
        reported === path ||
        (path.startsWith("/graph/nodes/") &&
          reported?.startsWith(`${path}/`) === true)
      );
    },
  );

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
test("YAML rejects a code module registry", () =>
  rejectsAt(
    variant((d) => {
      d.code = { B: "./impl.ts" };
    }),
    "/code",
  ));
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
  assert.equal(edgeId({ from: "A", to: "B" }), "A->B");
  assert.equal(edgeId({ from: "A", to: "B", kind: "message" }), "A~>B");
  const doc = base();
  assert.equal(parse(doc), doc);
  assert.deepEqual(
    parse("graph:\n  nodes:\n    A: {}\n  edges: [{from: A, to: $sink}]").graph
      .nodes.A,
    {},
  );
});
test("params substitute into YAML text before parsing", () => {
  const source =
    'graph:\n  nodes:\n    A:\n      description: "{{ params.description }}"\n  edges:\n    - from: A\n      to: $sink\n';
  for (const text of [
    source,
    source.replace("{{ params.description }}", "{{params.description}}"),
  ]) {
    const node = parse(text, { params: { description: "p/m", unused: true } })
      .graph.nodes.A!;
    assert.equal(node.description, "p/m");
  }
  assert.throws(
    () => parse(source),
    /junco-syntax: missing param "description"/,
  );
  assert.throws(
    () => parse(base(), { params: {} }),
    /params apply to YAML text/,
  );
});
test("invalid YAML and strict shape", () => {
  assert.throws(() => parse("graph: ["), /junco-syntax: invalid YAML:/);
  assert.throws(() => parse({ ...base(), extra: true }), /junco-syntax:/);
  assert.throws(
    () => parse({ graph: { nodes: {}, edges: [] } }),
    /junco-syntax:/,
  );
  assert.throws(() => parse({ graph: { nodes: { A: {} } } }), /junco-syntax:/);
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
      external: [ingress]
  sink:
    description: final result fan-in
    trigger:
      all: [done]
    returns: Final
  nodes:
    Seed:
      kind: emit
      description: seeds message recipients
      trigger: always
      text: |
        seed text
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
      contracts:
        ingress: external prompt
        seed: seed prompt
    Ralph:
      description: revises the seeded assignment
      system: revise the assignment
      tools: [custom]
      mcp: [full]
      skills: [guide]
      prompt: "{{ ralph-input }}"
      contracts:
        ralph-input: complete assignment
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
            contracts:
              child-input: revised assignment
        edges:
          - from: $source
            to: Worker
            kind: message
            id: child-input
          - from: Worker
            to: $sink
            id: child-result
    Final:
      system: combine both reports
      trigger:
        all: [agent-answer, child-answer]
      prompt: "{{ agent-answer }}\\n{{ child-answer }}"
      contracts:
        agent-answer: direct final
        child-answer: child final
  edges:
    - from: $source
      to: "Agent:1"
      kind: message
      id: ingress
    - from: Seed
      to: "Agent:1"
      kind: message
      id: seed
    - from: Seed
      to: Ralph
      kind: message
      id: ralph-input
    - from: Ralph
      to: Child
      kind: message
      id: ralph-output
    - from: "Agent:1"
      to: Final
      kind: value
      id: agent-answer
    - from: Child
      to: Final
      id: child-answer
    - from: Final
      to: $sink
      id: done
`;
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
        routes: { external: ["ingress"] },
      },
      sink: {
        description: "final result fan-in",
        trigger: { all: ["done"] },
        returns: "Final",
      },
      nodes: {
        Seed: {
          kind: "emit",
          description: "seeds message recipients",
          trigger: "always",
          text: "seed text\n",
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
          contracts: { ingress: "external prompt", seed: "seed prompt" },
        },
        Ralph: {
          description: "revises the seeded assignment",
          system: "revise the assignment",
          tools: ["custom"],
          mcp: ["full"],
          skills: ["guide"],
          prompt: "{{ ralph-input }}",
          contracts: { "ralph-input": "complete assignment" },
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
                contracts: { "child-input": "revised assignment" },
              },
            },
            edges: [
              {
                from: "$source",
                to: "Worker",
                kind: "message",
                id: "child-input",
              },
              { from: "Worker", to: "$sink", id: "child-result" },
            ],
          },
        },
        Final: {
          system: "combine both reports",
          trigger: { all: ["agent-answer", "child-answer"] },
          prompt: "{{ agent-answer }}\n{{ child-answer }}",
          contracts: {
            "agent-answer": "direct final",
            "child-answer": "child final",
          },
        },
      },
      edges: [
        { from: "$source", to: "Agent:1", kind: "message", id: "ingress" },
        { from: "Seed", to: "Agent:1", kind: "message", id: "seed" },
        { from: "Seed", to: "Ralph", kind: "message", id: "ralph-input" },
        { from: "Ralph", to: "Child", kind: "message", id: "ralph-output" },
        { from: "Agent:1", to: "Final", kind: "value", id: "agent-answer" },
        { from: "Child", to: "Final", id: "child-answer" },
        { from: "Final", to: "$sink", id: "done" },
      ],
    },
  };
  assert.deepEqual(parse(yaml), expected);
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
  for (const field of ["window", "threads"]) {
    for (const value of [1, 2, ...(field === "threads" ? ["unbounded"] : [])]) {
      const doc = variant((d) => {
        d.graph[field] = value;
      });
      assert.equal((parse(doc).graph as any)[field], value);
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
  const cases: [string, (d: any) => void][] = [
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
    ...["agent", "emit", "graph"].map(
      (kind) =>
        [
          "/graph/nodes/A",
          (d: any) => {
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
        ] as [string, (d: any) => void],
    ),
    ["/graph/nodes/A", (d) => (d.graph.nodes.A.kind = "unknown")],
    ["/graph/edges/0/kind", (d) => (d.graph.edges[0].kind = "unknown")],
    ["/graph/edges/0/from", (d) => (d.graph.edges[0].from = 1)],
    ["/graph/edges/0/to", (d) => (d.graph.edges[0].to = null)],
    ["/graph/edges/0/id", (d) => (d.graph.edges[0].id = false)],
    ["/graph/edges", (d) => (d.graph.edges = {})],
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
    ...[
      "tools",
      "skills",
      "mcp",
      "contracts",
      "system",
      "prompt",
      "description",
    ].map(
      (field) =>
        [
          "/graph/nodes/A",
          (d: any) => {
            d.graph.nodes.A[field] = field === "contracts" ? { x: 2 } : [2];
          },
        ] as [string, (d: any) => void],
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
  const profiles = { memory: "512 MB", runtime: "1.5 s", tokens: "4000 tok" };
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
            nodes: { W: {} },
            edges: [{ from: "W", to: "$sink" }],
          },
        },
      },
      edges: [
        { from: "Start", to: "A", kind: "message" },
        { from: "A", to: "$sink" },
      ],
    },
  });
  for (const node of Object.values(doc.graph.nodes))
    assert.deepEqual(node.profiles, profiles);
  assert.throws(
    () =>
      parse(
        variant((d) => {
          d.graph.nodes.A.profiles = { memory: "1 MBs" };
        }),
      ),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message ===
        'junco-syntax: /graph/nodes/A/profiles/memory: profile memory: unknown unit "MBs"',
  );
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
    };
  }, 'edge "shared" declared twice');
  rejects((d) => {
    d.graph.edges.push({ from: "A", to: "B", kind: "value" });
  }, 'edge "A->B" declared twice');
  const doc = variant((d) => {
    d.graph.edges.push(
      { from: "A", to: "B", kind: "message" },
      { from: "A", to: "B", id: "custom" },
      { from: "B", to: "$sink", kind: "message" },
    );
    d.graph.nodes.B.prompt = "{{ custom }} / {{custom}}";
    d.graph.nodes.B.contracts = { custom: "report" };
  });
  assert.deepEqual(parse(doc).graph.edges?.map(edgeId), [
    "A->B",
    "B->$sink",
    "A~>B",
    "custom",
    "B~>$sink",
  ]);
  doc.graph.edges.push({ from: "A", to: "$sink" });
  doc.graph.sink = { returns: "B" };
  assert.equal(parse(doc).graph.sink?.returns, "B");
  for (const edges of [undefined, []])
    rejectsAt(
      variant((d) => {
        d.graph.edges = edges;
      }),
      "/graph",
    );
});

test("recursive validation and ports do not impose connectivity or acyclicity", () => {
  const doc: any = nested();
  doc.graph.nodes.Seed = { kind: "emit", text: "go" };
  doc.graph.edges.unshift({
    from: "Seed",
    to: "A",
    kind: "message",
    id: "incoming",
  });
  const child = doc.graph.nodes.A.graph;
  child.nodes.Other = {};
  child.edges.push({
    from: "$source",
    to: "Other",
    kind: "message",
    id: "other",
  });
  child.source.routes.incoming.push("other");
  assert.equal(parse(doc), doc);
  for (const trigger of ["wrong", { all: ["incoming", "incoming"] }]) {
    doc.graph.nodes.A.trigger = trigger;
    rejectsAt(doc, "/graph");
  }
  delete doc.graph.nodes.A.trigger;
  for (const trigger of ["wrong", { any: ["A->$sink", "A->$sink"] }]) {
    doc.graph.sink = { trigger };
    rejectsAt(doc, "/graph");
  }
  delete doc.graph.sink;
  child.source.routes.incoming = ["W->$sink"];
  rejectsAt(doc, "/graph/nodes/A/graph");
  child.source.routes.incoming = ["$source~>W"];
  for (const id of ["$source", "$sink"]) {
    child.nodes[id] = {};
    rejectsAt(doc, `/graph/nodes/A/graph/nodes/${id}`);
    delete child.nodes[id];
  }
  child.edges.push({ from: "Missing", to: "W" });
  rejectsAt(doc, "/graph/nodes/A/graph");
  child.edges.pop();
  child.edges.push({ from: "Other", to: "$sink" });
  rejectsAt(doc, "/graph/nodes/A/graph");
  child.sink = { returns: "W" };
  assert.equal(parse(doc), doc);
  const free = variant((d) => {
    d.graph.nodes.Isolated = {};
    d.graph.edges.push(
      { from: "B", to: "A", kind: "message" },
      { from: "A", to: "A", kind: "message" },
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
    d.graph.edges.push({ from: "A", to: "C", kind: "message" });
  });
  assert.equal(parse(doc), doc);
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
    const spec: any = {
      nodes: {},
      edges: [
        { from: "A", to: target, id: "v" },
        { from: "B", to: target, kind: "message", id: "m" },
      ],
    };
    for (const [input, kind, order, expected] of cases) {
      const rule = resolveTrigger<number, string>(spec, target, input as any);
      assert.deepEqual(rule, { kind, rule: order });
      const truth: boolean[] = [];
      for (const [mReady, vReady] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ]) {
        const m = graph.Edge.message<number, string>("m");
        const v = graph.Edge.value<number, string>("v");
        if (mReady && E.isLeft(m.transport)) m.transport.left.push(1);
        if (vReady) v.transport = E.right(O.some("value"));
        const inbound = new Map([
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
  assert.deepEqual(resolveTrigger(base().graph, "A"), {
    kind: "all",
    rule: [],
  });
  for (const id of ["always", "never"]) {
    const doc = variant((d) => {
      d.graph.edges[0].id = id;
      d.graph.nodes.B.trigger = { all: [id] };
    });
    assert.deepEqual(resolveTrigger(parse(doc).graph, "B", { all: [id] }), {
      kind: "all",
      rule: [id],
    });
    assert.deepEqual(resolveTrigger(doc.graph, "B", id), {
      kind: id === "always" ? "all" : "any",
      rule: [],
    });
  }
});
