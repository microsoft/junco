import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graph, tracer } from "junco-agency";
import { LockPolicy } from "junco-tools";
import {
  type GraftCheckpoint,
  type GraftEdge,
  type GraftMetadata,
  type GraftTopology,
  graftCheckpoints,
  loadGraftGraph,
  parseGraftGraph,
} from "../skills/junco-graph-create/scripts/graft.ts";
import { terminalPorts } from "./deterministic-support.ts";

function node(id: string): GraftMetadata {
  return {
    id,
    name: id,
    kind: "function",
    path: "src/units.ts",
    span: "L1-L2",
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: "hash",
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}
function edge(
  source: string,
  target: string,
  relation: GraftEdge["relation"] = "calls",
): GraftEdge {
  return { source, target, relation, confidence: "extracted" };
}
function fixture(
  nodes = ["a", "b", "c", "d", "e", "z"].map(node),
  edges = [
    edge("a", "b"),
    edge("b", "a"),
    edge("b", "c"),
    edge("c", "d"),
    edge("d", "e"),
    edge("e", "c"),
    edge("a", "b", "contains"),
    edge("b", "external", "imports"),
  ],
) {
  return {
    meta: {
      version: 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      languages: ["typescript"],
      scopes: [{ prefix: "", label: "", markers: ["package.json"] }],
    },
    nodes,
    edges,
  };
}
function bridgeEdges(topology: GraftTopology): GraftEdge[] {
  return [...topology.bridgeIds].map(
    (id) => topology.skeleton.getLinkById(id)!.data,
  );
}

// Stage 1: complete input validation, selection and disk precedence.
test("parser preserves metadata identity, link order, file nodes, external edges and exact scope cuts", () => {
  const input = fixture();
  input.nodes[5] = {
    ...input.nodes[5]!,
    kind: "file",
    summary_state: "stale",
    chars: 123,
    owner: "Owner",
    body_text: "optional",
    arity: 2,
    variadic: true,
    crux: { code: "return 1", span: "L1-L1" },
  };
  const topology = parseGraftGraph(input);
  assert.equal(topology.meta, input.meta);
  assert.equal(topology.skeleton.getNode("z")!.data, input.nodes[5]);
  const links: GraftEdge[] = [];
  topology.skeleton.forEachLink((link) => {
    links.push(link.data);
  });
  assert.deepEqual(links, input.edges.slice(0, 6));
  for (let i = 0; i < links.length; i++) assert.equal(links[i], input.edges[i]);
  assert.deepEqual(topology.externalEdges, [input.edges[7]]);
  assert.equal(topology.skeleton.getNode("external"), undefined);
  const scoped = parseGraftGraph(input, new Set(["b", "z"]));
  assert.equal(scoped.skeleton.getNodeCount(), 2);
  assert.equal(scoped.skeleton.getLinkCount(), 0);
  assert.equal(scoped.meta.nodeCount, 6);
  assert.deepEqual(scoped.externalEdges, [input.edges[7]]);
  assert.equal(parseGraftGraph(input, new Set()).skeleton.getNodeCount(), 0);
  assert.deepEqual(parseGraftGraph(fixture([], [])).regions, []);
  assert.throws(
    () => parseGraftGraph(input, new Set(["missing-z", "missing-a"])),
    /Unknown graft node IDs: missing-a, missing-z/,
  );
});

test("parser rejects malformed complete input even outside selected scope", () => {
  assert.throws(() => parseGraftGraph(null), /Invalid graft graph: root/);
  assert.throws(
    () => parseGraftGraph({ meta: { version: 2 } }),
    /Unsupported graft graph version: 2; expected 1/,
  );
  const mutations: [string, (input: any) => void][] = [
    [
      "meta.nodeCount",
      (input) => {
        input.meta.nodeCount++;
      },
    ],
    [
      "meta.edgeCount",
      (input) => {
        input.meta.edgeCount = -1;
      },
    ],
    [
      "meta.languages",
      (input) => {
        input.meta.languages = [7];
      },
    ],
    [
      "meta.languages[0]",
      (input) => {
        delete input.meta.languages[0];
      },
    ],
    [
      "meta.scopes[0]",
      (input) => {
        delete input.meta.scopes[0];
      },
    ],
    [
      "nodes[0]",
      (input) => {
        delete input.nodes[0];
      },
    ],
    [
      "edges[0]",
      (input) => {
        delete input.edges[0];
      },
    ],
    [
      "meta.scopes",
      (input) => {
        input.meta.scopes[0].markers = [false];
      },
    ],
    [
      "nodes",
      (input) => {
        input.nodes = {};
      },
    ],
    [
      "edges",
      (input) => {
        input.edges = null;
      },
    ],
    [
      "nodes[1].id",
      (input) => {
        input.nodes[1].id = "a";
      },
    ],
    [
      "nodes[1].id",
      (input) => {
        input.nodes[1].id = "";
      },
    ],
    [
      "nodes[1].path",
      (input) => {
        input.nodes[1].path = "../outside.ts";
      },
    ],
    [
      "nodes[1].path",
      (input) => {
        input.nodes[1].path = "/outside.ts";
      },
    ],
    [
      "nodes[1].path",
      (input) => {
        input.nodes[1].path = "C:\\outside.ts";
      },
    ],
    [
      "nodes[1].path",
      (input) => {
        input.nodes[1].path = "C:outside.ts";
      },
    ],
    [
      "nodes[1].path",
      (input) => {
        input.nodes[1].path = "src/../outside.ts";
      },
    ],
    [
      "nodes[1].span",
      (input) => {
        input.nodes[1].span = "L2-L1";
      },
    ],
    [
      "nodes[1].span",
      (input) => {
        input.nodes[1].span = "L0-L1";
      },
    ],
    [
      "nodes[1].kind",
      (input) => {
        input.nodes[1].kind = "agent";
      },
    ],
    [
      "nodes[1].signature",
      (input) => {
        delete input.nodes[1].signature;
      },
    ],
    [
      "nodes[1].summary",
      (input) => {
        input.nodes[1].summary = 2;
      },
    ],
    [
      "nodes[1].summary_state",
      (input) => {
        input.nodes[1].summary_state = "done";
      },
    ],
    [
      "nodes[1].crux",
      (input) => {
        input.nodes[1].crux = { code: 2, span: "L1-L2" };
      },
    ],
    [
      "nodes[1].exported",
      (input) => {
        input.nodes[1].exported = 1;
      },
    ],
    [
      "nodes[1].origin",
      (input) => {
        input.nodes[1].origin = "model";
      },
    ],
    [
      "nodes[1].body_hash",
      (input) => {
        delete input.nodes[1].body_hash;
      },
    ],
    [
      "nodes[1].owner",
      (input) => {
        input.nodes[1].owner = null;
      },
    ],
    [
      "nodes[1].arity",
      (input) => {
        input.nodes[1].arity = 0.5;
      },
    ],
    [
      "nodes[1].chars",
      (input) => {
        input.nodes[1].chars = -1;
      },
    ],
    [
      "nodes[1].body_text",
      (input) => {
        input.nodes[1].body_text = false;
      },
    ],
    [
      "nodes[1].variadic",
      (input) => {
        input.nodes[1].variadic = 1;
      },
    ],
    [
      "edges[0].source",
      (input) => {
        input.edges[0].source = "absent";
      },
    ],
    [
      "edges[0].target",
      (input) => {
        input.edges[0].target = "absent";
      },
    ],
    [
      "edges[6].target",
      (input) => {
        input.edges[6].target = "absent";
      },
    ],
    [
      "edges[0].relation",
      (input) => {
        input.edges[0].relation = "depends";
      },
    ],
    [
      "edges[0].confidence",
      (input) => {
        input.edges[0].confidence = "certain";
      },
    ],
    [
      "edges[1]",
      (input) => {
        input.edges[1] = { ...input.edges[0] };
      },
    ],
  ];
  for (const [field, mutate] of mutations) {
    const input = structuredClone(fixture());
    mutate(input);
    assert.throws(
      () => parseGraftGraph(input, new Set()),
      (error) =>
        error instanceof Error &&
        error.message.startsWith(`Invalid graft graph: ${field}`),
      field,
    );
  }
  for (const relation of [
    "imports",
    "references",
    "implements",
    "extends",
  ] as const) {
    const input = fixture([node("a")], [edge("a", "missing", relation)]);
    assert.deepEqual(parseGraftGraph(input).externalEdges, input.edges);
  }
});

test("loader uses current then legacy paths without falling back from broken preferred files", async () => {
  const repo = await mkdtemp(join(tmpdir(), "junco-graft-test-"));
  const current = join(repo, ".trail/cache/.graph/wiring.json");
  const legacy = join(repo, "graft/.graph/wiring.json");
  try {
    await assert.rejects(loadGraftGraph(repo), {
      message: `No graft graph found for ${repo}; run trail build ${repo}`,
    });
    await mkdir(join(repo, "graft/.graph"), { recursive: true });
    await writeFile(legacy, JSON.stringify(fixture([node("legacy")], [])));
    assert.ok((await loadGraftGraph(repo)).skeleton.getNode("legacy"));
    await mkdir(join(repo, ".trail/cache/.graph"), { recursive: true });
    await writeFile(current, JSON.stringify(fixture([node("current")], [])));
    assert.ok((await loadGraftGraph(repo)).skeleton.getNode("current"));
    await writeFile(current, "{broken");
    await assert.rejects(
      loadGraftGraph(repo),
      (error) =>
        error instanceof Error &&
        error.message.includes(current) &&
        error.cause instanceof SyntaxError,
    );
    await writeFile(current, JSON.stringify({ meta: { version: 99 } }));
    await assert.rejects(
      loadGraftGraph(repo),
      /Unsupported graft graph version: 99/,
    );
    await writeFile(current, JSON.stringify({ ...fixture(), nodes: [] }));
    await assert.rejects(
      loadGraftGraph(repo),
      /Invalid graft graph: meta.nodeCount/,
    );
    await rm(current);
    await mkdir(current);
    await assert.rejects(
      loadGraftGraph(repo),
      (error) => (error as NodeJS.ErrnoException).code === "EISDIR",
    );
    assert.ok(
      JSON.parse(await readFile(legacy, "utf8")).nodes[0].id === "legacy",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Stage 2: true undirected multigraph bridges, never weak components or containment hubs.
test("bridge removal partitions joined cycles and isolated metadata without changing links", () => {
  const topology = parseGraftGraph(fixture());
  assert.deepEqual(topology.regions, [
    { id: "a", nodeIds: ["a", "b"], predecessorIds: [] },
    { id: "c", nodeIds: ["c", "d", "e"], predecessorIds: ["a"] },
    { id: "z", nodeIds: ["z"], predecessorIds: [] },
  ]);
  assert.deepEqual(bridgeEdges(topology), [edge("b", "c")]);
  assert.equal(topology.skeleton.getLinkCount(), 6);
});

test("parallel relations, reversed links and self loops are not bridges", () => {
  for (const links of [
    [edge("a", "b"), edge("a", "b", "references")],
    [edge("a", "b"), edge("b", "a")],
  ]) {
    const topology = parseGraftGraph(
      fixture([node("b"), node("a")], [...links, edge("a", "a")]),
    );
    assert.equal(topology.bridgeIds.size, 0);
    assert.deepEqual(topology.regions, [
      { id: "a", nodeIds: ["a", "b"], predecessorIds: [] },
    ]);
    assert.equal(topology.skeleton.getLinkCount(), 3);
  }
});

test("long chain uses iterative traversals without overflowing the call stack", () => {
  const nodes = Array.from({ length: 20_000 }, (_, i) =>
    node(String(i).padStart(5, "0")),
  );
  const topology = parseGraftGraph(
    fixture(
      nodes,
      nodes.slice(1).map((n, i) => edge(nodes[i]!.id, n.id)),
    ),
  );
  assert.equal(topology.regions.length, 20_000);
  assert.equal(topology.bridgeIds.size, 19_999);
  assert.deepEqual(topology.regions[19_999], {
    id: "19999",
    nodeIds: ["19999"],
    predecessorIds: ["19998"],
  });
});

function work<T>(
  value: T,
  before?: () => void,
  waits = 0,
): graph.nodes.AgenticNode<never, T> {
  return {
    trigger: graph.trigger.TriggerRule.always(),
    state: new graph.nodes.Deterministic<never, T>(async function* () {
      before?.();
      for (let i = 0; i < waits; i++) yield [];
      return value;
    }, LockPolicy),
  };
}
const observer = new tracer.DummyTracer();

// Stage 3: real bounded execution windows, including gates and failing assertions.
test("checkpoints wait for every region member and async validation/reporting, not unrelated longer branches", async () => {
  const topology = parseGraftGraph(fixture());
  const events: string[] = [];
  const checkpoints: GraftCheckpoint<string>[] = [];
  const controller = graftCheckpoints<never, string>(topology, {
    validate: async (region, results) => {
      events.push(`validate:${region.id}`);
      assert.deepEqual([...results.keys()], region.nodeIds);
      for (const [id, value] of results) assert.equal(value, id);
      await Bun.sleep(1);
      events.push(`validated:${region.id}`);
    },
    progress: async (checkpoint) => {
      await Bun.sleep(1);
      checkpoints.push(checkpoint);
      events.push(`progress:${checkpoint.region.id}`);
    },
  });
  const ports = terminalPorts<never, string>();
  const workflow = graph.JuncoGraph.map(
    topology.skeleton,
    (metadata) =>
      controller.gate(
        metadata,
        work(
          metadata.id,
          () => events.push(`start:${metadata.id}`),
          metadata.id === "a" ? 3 : metadata.id === "z" ? 9 : 0,
        ),
      ),
    {
      source: ports.source,
      sink: ports.sink,
      policy: LockPolicy,
      tracer: observer,
    },
  );
  ports.connect(workflow.graph, graph.NodeId.create("z"));
  try {
    const results = await controller.run(workflow);
    assert.deepEqual([...results].sort(), [
      ["$sink", "z"],
      ...["a", "b", "c", "d", "e", "z"].map((id) => [id, id]),
    ]);
    assert.ok(events.indexOf("start:b") < events.indexOf("validate:a"));
    assert.ok(events.indexOf("validated:a") < events.indexOf("progress:a"));
    assert.ok(events.indexOf("progress:a") < events.indexOf("start:c"));
    assert.ok(events.indexOf("progress:a") < events.indexOf("start:d"));
    assert.ok(events.indexOf("progress:c") < events.indexOf("validate:z"));
    assert.deepEqual(
      checkpoints.map((c) => [
        c.region.id,
        c.completedRegions,
        c.totalRegions,
        c.completedNodes,
        c.totalNodes,
      ]),
      [
        ["a", 1, 3, 2, 6],
        ["c", 2, 3, 5, 6],
        ["z", 3, 3, 6, 6],
      ],
    );
    assert.deepEqual(
      [...checkpoints[0]!.results],
      [
        ["a", "a"],
        ["b", "b"],
      ],
    );
  } finally {
    await workflow.graph.close();
  }
});

test("joining region waits for every predecessor while disconnected roots run independently", async () => {
  const topology = parseGraftGraph(
    fixture(
      [node("x"), node("a"), node("b")],
      [edge("a", "x"), edge("b", "x")],
    ),
  );
  const events: string[] = [];
  const controller = graftCheckpoints<never, undefined>(topology, {
    validate: (_region, values) => {
      assert.ok([...values.values()].every((value) => value === undefined));
    },
    progress: (checkpoint) => {
      events.push(`pass:${checkpoint.region.id}`);
    },
  });
  const ports = terminalPorts<never, undefined>();
  const workflow = graph.JuncoGraph.map(
    topology.skeleton,
    (metadata) =>
      controller.gate(
        metadata,
        work(
          undefined,
          () => events.push(`start:${metadata.id}`),
          metadata.id === "b" ? 4 : 0,
        ),
      ),
    {
      source: ports.source,
      sink: ports.sink,
      policy: LockPolicy,
      tracer: observer,
    },
  );
  ports.connect(workflow.graph, graph.NodeId.create("x"));
  try {
    const results = await controller.run(workflow);
    assert.equal(results.size, 4);
    assert.ok(results.has(graph.NodeId.create("x")));
    assert.ok(events.indexOf("start:b") < events.indexOf("pass:a"));
    assert.ok(events.indexOf("pass:a") < events.indexOf("start:x"));
    assert.ok(events.indexOf("pass:b") < events.indexOf("start:x"));
    assert.deepEqual(
      events.filter((e) => e.startsWith("pass:")),
      ["pass:a", "pass:b", "pass:x"],
    );
  } finally {
    await workflow.graph.close();
  }
});

test("validator cause and progress failure stop successors and never report false success", async () => {
  for (const failureAt of ["validate", "progress"]) {
    const topology = parseGraftGraph(
      fixture([node("a"), node("b")], [edge("a", "b")]),
    );
    const cause = new Error("assertion failed");
    const started: string[] = [];
    const reported: string[] = [];
    const controller = graftCheckpoints<never, string>(topology, {
      validate: async () => {
        if (failureAt === "validate") throw cause;
      },
      progress: (checkpoint) => {
        if (failureAt === "progress") throw cause;
        reported.push(checkpoint.region.id);
      },
    });
    const ports = terminalPorts<never, string>();
    const workflow = graph.JuncoGraph.map(
      topology.skeleton,
      (metadata) =>
        controller.gate(
          metadata,
          work(metadata.id, () => started.push(metadata.id)),
        ),
      {
        source: ports.source,
        sink: ports.sink,
        policy: LockPolicy,
        tracer: observer,
      },
    );
    ports.connect(workflow.graph, graph.NodeId.create("b"));
    try {
      await assert.rejects(controller.run(workflow), (error) =>
        failureAt === "validate"
          ? error instanceof Error &&
            error.message === 'Checkpoint failed for region "a"' &&
            error.cause === cause
          : error === cause,
      );
      assert.deepEqual(started, ["a"]);
      assert.deepEqual(reported, []);
    } finally {
      await workflow.graph.close();
    }
  }
});

test("quiescence is an unfinished-node error, triggers are checked, and empty topology invents no progress", async () => {
  const topology = parseGraftGraph(fixture([node("b"), node("a")], []));
  const controller = graftCheckpoints<never, string>(topology, {
    validate: () => assert.fail("unavailable work must not validate"),
    progress: () => assert.fail("unavailable work must not report"),
  });
  const invalid = work("a");
  assert.throws(
    () =>
      controller.gate(node("a"), {
        ...invalid,
        trigger: graph.trigger.TriggerRule.never(),
      }),
    /Repository work nodes require TriggerRule.always\(\)/,
  );
  const ports = terminalPorts<never, string>();
  const workflow = graph.JuncoGraph.map(
    topology.skeleton,
    (metadata) =>
      controller.gate(metadata, {
        ...work(metadata.id),
        is_available: () => false,
      }),
    {
      source: ports.source,
      sink: ports.sink,
      policy: LockPolicy,
      tracer: observer,
    },
  );
  ports.connect(workflow.graph, graph.NodeId.create("b"));
  try {
    await assert.rejects(controller.run(workflow), {
      message: "Graft workflow quiesced with unfinished nodes: a, b",
    });
  } finally {
    await workflow.graph.close();
  }
  const empty = parseGraftGraph(fixture([], []));
  const emptyController = graftCheckpoints<never, string>(empty, {
    validate: () => assert.fail(),
    progress: () => assert.fail(),
  });
  const emptySource = new graph.nodes.Source<never, string>(
    () => {
      throw new graph.DataflowDefinitionError(
        "Empty mapped graph does not accept external input",
      );
    },
    { id: graph.NodeId.create("$source") },
  );
  const emptySink = new graph.nodes.Sink<never, string>(
    async function* () {
      throw new Error("Empty mapped graph has no terminal result");
    },
    {
      id: graph.NodeId.create("$sink"),
      trigger: graph.trigger.TriggerRule.never(),
    },
  );
  const emptyWorkflow = graph.JuncoGraph.map(
    empty.skeleton,
    (metadata) => emptyController.gate(metadata, work("unused")),
    {
      source: emptySource,
      sink: emptySink,
      policy: LockPolicy,
      tracer: observer,
    },
  );
  try {
    assert.equal((await emptyController.run(emptyWorkflow)).size, 0);
  } finally {
    await emptyWorkflow.graph.close();
  }
});
