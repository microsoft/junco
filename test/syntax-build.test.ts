import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { megabytes } from "dataflow-engine";
import {
  type AgenticInput,
  agent,
  Deterministic,
  graph,
  JuncoGraph,
  MockAgent,
  schedules,
  tools,
  tracer,
  trigger,
  workflows,
} from "junco-agency";
import { Type } from "typebox";
import {
  type BuildOptions,
  build,
  type DeterministicNode,
  resolveAgents,
} from "../src/syntax/build.ts";
import { parse } from "../src/syntax/parse.ts";
import {
  assistant,
  requestTexts,
  run,
  settle,
  userTexts,
} from "./deterministic-support.ts";
import { fauxRuntime } from "./support.ts";
import { Emitter } from "./syntax-code-nodes.fixture.ts";

const mock = (text: string, prompt?: string) =>
  new MockAgent({ prompt, runs: [run([settle(assistant(text))])] });
const document = () =>
  parse({
    graph: {
      nodes: {
        Start: { kind: "emit", text: "go" },
        Inner: {
          kind: "graph",
          trigger: "Start~>Inner",
          graph: {
            source: { routes: { "Start~>Inner": ["$source~>Worker"] } },
            nodes: { Worker: { trigger: "$source~>Worker" } },
            edges: [
              { from: "$source", to: "Worker", kind: "message" },
              { from: "Worker", to: "$sink" },
            ],
          },
        },
        Final: {
          trigger: "Inner~>Final",
          prompt: "got: {{Inner~>Final}}",
        },
      },
      edges: [
        { from: "Start", to: "Inner", kind: "message" },
        { from: "Inner", to: "Final", kind: "message" },
        { from: "Final", to: "$sink" },
      ],
    },
  });
const options = () => ({
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  tracer: new tracer.DummyTracer(),
});
const fauxLadder = schedules.uniformLadder({ model: "faux/faux-1" });

test("default agents require a ladder", async () => {
  await assert.rejects(
    build(document(), options()),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message ===
        "junco-syntax: a ladder is required to create agents; pass ladder or createAgent",
  );
});

for (const high of [{ model: "nope" }, undefined])
  test(`build validates every ladder rung even with a custom factory: ${JSON.stringify(high)}`, async () => {
    let created = 0;
    await assert.rejects(
      build(document(), {
        ...options(),
        ladder: { ...fauxLadder, high } as unknown as schedules.Ladder,
        createAgent: async () => {
          created++;
          return mock("unused");
        },
      }),
      (error) =>
        error instanceof graph.DataflowDefinitionError &&
        error.message === 'ladder.high.model must be "provider/model-id"',
    );
    assert.equal(created, 0);
  });

test("decision strength switches each selected agent's model and thinking", async () => {
  const worker = mock("WORKER-OUT", "work");
  const final = mock("FINAL-OUT");
  const execution = await build(document(), {
    ...options(),
    ladder: {
      smol: { model: "p/s", thinking: "low" },
      low: { model: "p/l" },
      med: { model: "p/m" },
      high: { model: "p/h", thinking: "high" },
      xhigh: { model: "p/x" },
    },
    scheduler: () =>
      schedules.strength(
        (_, id) => (id === "Final" ? "high" : "smol"),
        schedules.parallel(),
      ),
    createAgent: async (spec) => (spec.node === "Worker" ? worker : final),
  });
  try {
    await execution.run();
    assert.equal(resultText(execution.graph), "FINAL-OUT");
    for (const [instance, modelId, thinking] of [
      [worker, "s", "low"],
      [final, "h", "high"],
    ] as const)
      assert.deepEqual(
        instance.calls
          .filter(
            ({ method }) =>
              method === "setModel" || method === "setThinkingLevel",
          )
          .map(({ method, args }) => [method, args]),
        [
          ["setModel", [{ provider: "p", modelId }]],
          ["setThinkingLevel", [thinking]],
        ],
      );
  } finally {
    await execution.graph.close();
  }
});

test("fromYaml substitutes text params and runs the workflow", async () => {
  const source = `graph:
  nodes:
    A:
      description: "{{ params.greeting }}"
      prompt: work
  edges:
    - from: A
      to: $sink
`;
  const instance = mock("done");
  const execution = await JuncoGraph.fromYaml(source, {
    ...options(),
    params: { greeting: "hi" },
    createAgent: async () => instance,
  });
  try {
    assert.equal(
      execution.graph.getNode(graph.NodeId.create("A"))?.description,
      "hi",
    );
    await execution.run();
    assert.deepEqual(lastPrompts(instance), ["work"]);
    assert.equal(resultText(execution.graph), "done");
  } finally {
    await execution.graph.close();
  }
});

test("fromYaml accepts a parsed document and runs nested agents", async () => {
  const execution = await JuncoGraph.fromYaml(document(), {
    ...options(),
    createAgent: async (spec) =>
      mock(spec.node, spec.node === "Worker" ? "work" : undefined),
  });
  try {
    await execution.run();
    assert.equal(resultText(execution.graph), "Final");
  } finally {
    await execution.graph.close();
  }
});

test("fromYaml closes prepared agents once when YAML parsing fails", async () => {
  const { models } = await fauxRuntime([]);
  const { collection, events, active } = countedCollection();
  const instance = await agent.JuncoAgent.create({
    provider: "faux",
    model: "faux-1",
    models,
    tools: [],
    collection,
  });
  const dispose = instance[Symbol.asyncDispose].bind(instance);
  let disposals = 0;
  instance[Symbol.asyncDispose] = async () => {
    disposals++;
    await dispose();
  };
  try {
    await assert.rejects(
      JuncoGraph.fromYaml("graph: [", {
        ...options(),
        agents: { A: instance, B: instance },
      }),
      (error) =>
        error instanceof graph.DataflowDefinitionError &&
        /invalid YAML/.test(error.message),
    );
    assert.equal(disposals, 1);
    assert.deepEqual(events, ["bind-close:1"]);
    assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
  } finally {
    await instance.return();
    await collection.close();
  }
});

type AvailabilityFactory = NonNullable<BuildOptions["available"]>[string];
const lastPrompts = (instance: MockAgent) =>
  requestTexts(instance.requests).map((texts) => texts.at(-1));
/** Reads a settled result's text, failing the test when `id` has none. */
function resultText(
  g: graph.JuncoGraph,
  id: graph.NodeIdType = g.sink.id,
): string {
  const result = g.result(id);
  if (result._tag !== "Some") assert.fail(`${id} has no result`);
  return contentText(result.value.content);
}
/** Admits `id` while `allowed(triggered)` holds and keeps an already running node resumable. */
const resumable =
  (id: string, allowed: (triggered: boolean) => boolean): AvailabilityFactory =>
  ({ graph: g }) =>
  (_view, triggered) =>
    allowed(triggered) ||
    g.getNode(graph.NodeId.create(id))?.status === "running";
const enqueuePrompts = (
  execution: Awaited<ReturnType<typeof build>>,
  id: string,
  ...payloads: AgenticInput[]
) =>
  execution.graph.source.enqueue({
    messages: new Map([[graph.EdgeId.create(id), payloads]]),
    values: new Map(),
  });
const nodeFailure = (message: RegExp) => (error: unknown) =>
  error instanceof graph.DataflowNodeError &&
  message.test((error.error as Error).message);

function countedCollection(failure?: { binding: number; error: Error }): {
  collection: tools.ToolCollection;
  events: string[];
  active: { leases: number; bindings: number; creatorCloses: number };
} {
  const events: string[] = [];
  const active = { leases: 0, bindings: 0, creatorCloses: 0 };
  let leases = 0,
    bindings = 0,
    creatorClosed = false;
  const collection = {
    policy: tools.LockPolicy,
    tools: [] as AgentTool[],
    lease() {
      const id = ++leases;
      active.leases++;
      let closed = false;
      return {
        close: async () => {
          if (!closed) {
            closed = true;
            active.leases--;
            events.push(`lease-close:${id}`);
          }
        },
      };
    },
    bind() {
      const id = ++bindings;
      active.bindings++;
      let closing: Promise<void> | undefined;
      return {
        owner: `owner-${id}`,
        tools: new Map(),
        close: () =>
          (closing ??= Promise.resolve().then(() => {
            active.bindings--;
            events.push(`bind-close:${id}`);
            if (failure?.binding === id) throw failure.error;
          })),
      };
    },
    close: async () => {
      if (!creatorClosed) {
        creatorClosed = true;
        active.creatorCloses++;
        events.push("creator-close");
      }
    },
  } as unknown as tools.ToolCollection;
  return { collection, events, active };
}

test("named tools extend fresh builtins and cannot shadow them", async () => {
  const custom = (name: string): AgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      details: {},
    }),
  });
  const doc = parse({
    graph: {
      nodes: { A: { tools: ["custom"] } },
      edges: [{ from: "A", to: "$sink" }],
    },
  });
  const [spec] = await resolveAgents(doc, {
    cwd: process.cwd(),
    tools: { custom: custom("custom") },
  });
  assert.ok(spec);
  assert.deepEqual(
    spec.tools.map((t) => {
      assert.ok("name" in t);
      return t.name;
    }),
    ["yield", "info", "send", "recv", "task", "custom"],
  );
  const shadow = parse({
    graph: {
      nodes: { A: { tools: ["shadow"] } },
      edges: [{ from: "A", to: "$sink" }],
    },
  });
  await assert.rejects(
    resolveAgents(shadow, {
      cwd: process.cwd(),
      tools: { shadow: custom("yield") },
    }),
    /shadows builtin tool "yield"/,
  );
});

test("skills are loaded once, advertised and reject nonexistent registry paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "junco-yaml-skill-"));
  try {
    await mkdir(join(cwd, "guide"));
    const content =
      "---\nname: guide\ndescription: Follow the guide.\n---\nGuide body.\n";
    await writeFile(join(cwd, "guide", "SKILL.md"), content);
    const doc = parse({
      skills: { guide: "guide/SKILL.md" },
      graph: {
        nodes: {
          A: { system: "Base", skills: ["guide", "guide"] },
        },
        edges: [{ from: "A", to: "$sink" }],
      },
    });
    const [spec] = await resolveAgents(doc, { cwd });
    assert.ok(spec);
    assert.equal(spec.skills[0], spec.skills[1]);
    assert.equal(spec.skills[0]?.content, content);
    assert.ok(spec.systemPrompt?.startsWith("Base\n\n"));
    assert.ok(spec.systemPrompt?.includes("Follow the guide."));
    doc.skills!.guide = "guide/missing.md";
    await assert.rejects(
      resolveAgents(doc, { cwd }),
      (error) =>
        error instanceof graph.DataflowDefinitionError &&
        error.message.includes("is not a valid SKILL.md"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolution walks declarations depth-first and retains graph labels", async () => {
  const doc = parse({
    graph: {
      name: "root-label",
      nodes: {
        First: {},
        Child: {
          kind: "graph",
          graph: {
            name: "child-label",
            nodes: {
              Before: {},
              Grandchild: {
                kind: "graph",
                graph: {
                  nodes: { Deep: {} },
                  edges: [{ from: "Deep", to: "$sink" }],
                },
              },
              After: {},
            },
            sink: { returns: "After" },
            edges: [
              { from: "Before", to: "$sink" },
              { from: "After", to: "$sink" },
            ],
          },
        },
        Last: {},
      },
      edges: [{ from: "Last", to: "$sink" }],
    },
  });
  const specs = await resolveAgents(doc, { cwd: process.cwd() });
  assert.deepEqual(
    specs.map(({ graph, node }) => [graph, node]),
    [
      ["root-label", "First"],
      ["child-label", "Before"],
      ["Grandchild", "Deep"],
      ["child-label", "After"],
      ["root-label", "Last"],
    ],
  );
  const unnamed = await resolveAgents(
    parse({
      graph: {
        nodes: { A: {} },
        edges: [{ from: "A", to: "$sink" }],
      },
    }),
    { cwd: process.cwd() },
  );
  assert.equal(unnamed[0]?.graph, "graph");
});

test("collection tools win over code tools, code tools fill gaps, and builtins are fresh", async () => {
  const makeTool = (name: string, text: string): AgentTool => ({
    name,
    label: name,
    description: text,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text }], details: {} }),
  });
  const collectionTool = makeTool("shared", "collection");
  const shadowedCodeTool = makeTool("shared", "code");
  const fallback = makeTool("fallback", "fallback");
  const counted = countedCollection();
  counted.collection.tools.push(collectionTool);
  try {
    const specs = await resolveAgents(
      parse({
        graph: {
          nodes: {
            A: { tools: ["shared", "fallback"] },
            B: { tools: ["shared"] },
          },
          edges: [{ from: "A", to: "$sink" }],
        },
      }),
      {
        cwd: process.cwd(),
        collection: counted.collection,
        tools: { shared: shadowedCodeTool, fallback },
      },
    );
    const [a, b] = specs;
    assert.ok(a && b);
    assert.equal(a.tools[5], collectionTool);
    assert.equal(a.tools[6], fallback);
    assert.equal(b.tools[5], collectionTool);
    assert.ok(!a.tools.includes(shadowedCodeTool));
    for (const [index, name] of [
      "yield",
      "info",
      "send",
      "recv",
      "task",
    ].entries()) {
      const left = a.tools[index];
      const right = b.tools[index];
      assert.ok(left && right && "name" in left && "name" in right);
      assert.equal(left.name, name);
      assert.equal(right.name, name);
      assert.notEqual(left, right);
    }
    await assert.rejects(
      resolveAgents(
        parse({
          graph: {
            nodes: { Unknown: { tools: ["missing"] } },
            edges: [{ from: "Unknown", to: "$sink" }],
          },
        }),
        { cwd: process.cwd(), collection: counted.collection },
      ),
      (error) =>
        error instanceof TypeError &&
        error.message.includes('unknown tool "missing" for node "Unknown"'),
    );
    assert.deepEqual(counted.active, {
      leases: 0,
      bindings: 0,
      creatorCloses: 0,
    });
  } finally {
    await counted.collection.close();
  }
});

test("MCP definitions cache by registry name without opening a transport", async () => {
  const specs = await resolveAgents(
    parse(`
mcp:
  plain:
    command: junco-yaml-must-not-execute
  timed:
    command: junco-yaml-must-not-execute
    args: [--stdio]
    cwd: .
    env:
      MODE: fixture
    timeout: 250
graph:
  nodes:
    A:
      mcp: [plain, timed, plain]
    B:
      mcp: [timed, plain]
  edges:
    - from: A
      to: $sink
`),
    { cwd: process.cwd() },
  );
  const [a, b] = specs;
  assert.ok(a && b);
  assert.equal(a.tools[5], a.tools[7]);
  assert.equal(a.tools[5], b.tools[6]);
  assert.equal(a.tools[6], b.tools[5]);
  assert.notEqual(a.tools[5], a.tools[6]);
});

test("skills retain content, resolve same-directory symlinks and cache repeated registry references", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "junco-yaml-skill-resolution-"));
  try {
    await mkdir(join(cwd, "guide"));
    const content =
      "---\nname: guide\ndescription: Follow the guide fixture.\n---\nExact guide body.\n";
    await writeFile(join(cwd, "guide", "SKILL.md"), content);
    await symlink("SKILL.md", join(cwd, "guide", "alias.md"));
    const specs = await resolveAgents(
      parse({
        skills: { guide: "guide/SKILL.md", alias: "guide/alias.md" },
        graph: {
          nodes: {
            A: { skills: ["guide", "guide", "alias"] },
            B: { skills: ["alias", "guide"] },
          },
          edges: [{ from: "A", to: "$sink" }],
        },
      }),
      { cwd },
    );
    const [a, b] = specs;
    assert.ok(a && b);
    assert.equal(a.skills[0], a.skills[1]);
    assert.equal(a.skills[0], b.skills[1]);
    assert.equal(a.skills[2], b.skills[0]);
    for (const skill of [...a.skills, ...b.skills]) {
      assert.equal(skill.name, "guide");
      assert.equal(skill.content, content);
      assert.equal(skill.filePath, join(cwd, "guide", "SKILL.md"));
    }
    assert.ok(a.systemPrompt?.includes("<name>guide</name>"));
    assert.ok(a.systemPrompt?.includes("Follow the guide fixture."));
    assert.ok(a.systemPrompt?.includes(join(cwd, "guide", "SKILL.md")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const row of [
  {
    name: "malformed",
    file: "SKILL.md",
    content: "---\ndescription: [unterminated\n---\nBody\n",
    diagnostic: true,
  },
  {
    name: "missing-description",
    file: "SKILL.md",
    content: "---\nname: missing-description\n---\nBody\n",
    diagnostic: true,
  },
  {
    name: "non-skill",
    file: "notes.md",
    content: "# Ordinary Markdown\nNot a skill.\n",
    diagnostic: false,
  },
  { name: "absent", file: "missing.md", content: undefined, diagnostic: false },
] as const)
  test(`skill resolution rejects ${row.name} with definition diagnostics`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "junco-yaml-invalid-skill-"));
    try {
      await mkdir(join(cwd, row.name));
      if (row.content !== undefined)
        await writeFile(join(cwd, row.name, row.file), row.content);
      await assert.rejects(
        resolveAgents(
          parse({
            skills: { invalid: `${row.name}/${row.file}` },
            graph: {
              nodes: { A: { skills: ["invalid"] } },
              edges: [{ from: "A", to: "$sink" }],
            },
          }),
          { cwd },
        ),
        (error) => {
          assert.ok(error instanceof graph.DataflowDefinitionError);
          assert.ok(error.message.includes('skill "invalid"'));
          if (row.diagnostic) {
            assert.ok(
              error.message.startsWith('junco-syntax: skill "invalid":'),
            );
            if (row.name === "missing-description")
              assert.ok(error.message.includes("description is required"));
          } else {
            assert.ok(error.message.includes(join(cwd, row.name, row.file)));
            assert.ok(error.message.includes("is not a valid SKILL.md"));
          }
          return true;
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

test("nested message ingress and final egress stage the factory agent prompt", async () => {
  const final = mock("FINAL-OUT");
  const execution = await build(document(), {
    ...options(),
    createAgent: async (spec) =>
      spec.node === "Worker" ? mock("WORKER-OUT", "work") : final,
  });
  try {
    await execution.run();
    assert.equal(resultText(execution.graph), "FINAL-OUT");
    assert.deepEqual(lastPrompts(final), ["got: WORKER-OUT"]);
  } finally {
    await execution.graph.close();
  }
});

test("availability can prevent final activation", async () => {
  const execution = await build(document(), {
    ...options(),
    createAgent: async (spec) =>
      mock(spec.node, spec.node === "Worker" ? "work" : undefined),
    available: { Final: () => () => false },
  });
  try {
    await execution.run();
    assert.equal(
      execution.graph.result(graph.NodeId.create("Final"))._tag,
      "None",
    );
  } finally {
    await execution.graph.close();
  }
});

for (const decline of [false, true])
  test(`sink availability ${decline ? "can decline a graph level" : "gates publication after work completes"}`, async () => {
    let allowed = false;
    const execution = await build(document(), {
      ...options(),
      createAgent: async (spec) =>
        mock(spec.node, spec.node === "Worker" ? "work" : undefined),
      available: {
        $sink: ({ edges }) =>
          decline || !edges.has("Final->$sink")
            ? undefined
            : (_view, triggered) => allowed && triggered,
      },
    });
    try {
      await execution.run();
      assert.equal(
        resultText(execution.graph, graph.NodeId.create("Final")),
        "Final",
      );
      if (!decline) {
        assert.equal(
          execution.graph.result(execution.graph.sink.id)._tag,
          "None",
        );
        allowed = true;
        await execution.run();
      }
      assert.equal(resultText(execution.graph), "Final");
    } finally {
      await execution.graph.close();
    }
  });

const ralphDoc = () => parse(workflows.ralph);
const revision = (previous: string) =>
  `assignment\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

test("a value self-loop runs Ralph once per round and publishes only the last", async () => {
  const instance = new MockAgent({
    runs: ["draft-1", "draft-2", "draft-3"].map((text) =>
      run([settle(assistant(text))]),
    ),
  });
  const execution = await build(ralphDoc(), {
    ...options(),
    createAgent: async () => instance,
    ...schedules.ralph({ rounds: 3 }),
  });
  try {
    enqueuePrompts(execution, "assignment", {
      kind: "prompt",
      text: "assignment",
    });
    await execution.run();
    assert.deepEqual(lastPrompts(instance), [
      "assignment",
      revision("draft-1"),
      revision("draft-2"),
    ]);
    assert.equal(
      resultText(execution.graph, graph.NodeId.create("Ralph")),
      "draft-3",
    );
    assert.equal(resultText(execution.graph), "draft-3");
    assert.equal(execution.graph.available().size, 0);
  } finally {
    await execution.graph.close();
  }
});

test("default rounds is two and a staged round survives graph steps", async () => {
  const instance = new MockAgent({
    runs: ["draft-1", "draft-2", "draft-3"].map((text) =>
      run([settle(assistant(text))]),
    ),
  });
  const execution = await build(ralphDoc(), {
    ...options(),
    createAgent: async () => instance,
    ...schedules.ralph(),
  });
  try {
    enqueuePrompts(execution, "assignment", {
      kind: "prompt",
      text: "assignment",
    });
    for (let step = 0; instance.requests.length === 0 && step < 100; step++)
      await execution.step();
    assert.deepEqual(lastPrompts(instance), ["assignment"]);
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "None");
    await execution.run();
    assert.deepEqual(lastPrompts(instance), [
      "assignment",
      revision("draft-1"),
    ]);
    assert.equal(resultText(execution.graph), "draft-2");
  } finally {
    await execution.graph.close();
  }
});

for (const [name, draft, error] of [
  ["blank", assistant("   "), /^Ralph produced an empty report$/],
  [
    "length",
    { ...assistant("truncated"), stopReason: "length" as const },
    /^Ralph did not finish normally: length$/,
  ],
] as const)
  test(`an invalid intermediate draft (${name}) fails Ralph before the next round`, async () => {
    const instance = new MockAgent({
      runs: [assistant("draft-1"), draft, assistant("draft-3")].map((message) =>
        run([settle(message)]),
      ),
    });
    const execution = await build(ralphDoc(), {
      ...options(),
      createAgent: async () => instance,
      ...schedules.ralph({ rounds: 3 }),
    });
    try {
      enqueuePrompts(execution, "assignment", {
        kind: "prompt",
        text: "assignment",
      });
      await assert.rejects(execution.run(), nodeFailure(error));
      assert.equal(
        execution.graph.result(execution.graph.sink.id)._tag,
        "None",
      );
      assert.deepEqual(lastPrompts(instance), [
        "assignment",
        revision("draft-1"),
      ]);
    } finally {
      await execution.graph.close();
    }
  });

for (const [name, payloads] of [
  [
    "two prompts",
    [
      { kind: "prompt", text: "assignment" },
      { kind: "prompt", text: "extra" },
    ],
  ],
  ["followUp", [{ kind: "followUp", text: "assignment" }]],
  [
    "images",
    [
      {
        kind: "prompt",
        text: "assignment",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      },
    ],
  ],
] satisfies readonly (readonly [string, AgenticInput[]])[])
  test(`Ralph assignment admission rejects ${name}`, async () => {
    const instance = mock("unused");
    const execution = await build(ralphDoc(), {
      ...options(),
      createAgent: async () => instance,
      ...schedules.ralph(),
    });
    try {
      enqueuePrompts(execution, "assignment", ...payloads);
      await assert.rejects(
        execution.run(),
        nodeFailure(/^Ralph requires exactly one prompt assignment$/),
      );
      assert.equal(instance.requests.length, 0);
      assert.equal(
        execution.graph.result(execution.graph.sink.id)._tag,
        "None",
      );
    } finally {
      await execution.graph.close();
    }
  });

test("ralph rejects an invalid round count before building", () => {
  for (const rounds of [0, -1, 1.5, NaN, Infinity, 2 ** 53])
    assert.throws(() => schedules.ralph({ rounds }), {
      name: "RangeError",
      message: "Ralph rounds must be a positive safe integer",
    });
});

test("a nested Ralph level is driven while the outer sink is untouched", async () => {
  const inner = ralphDoc().graph;
  inner.source = { routes: { "$source~>Wrapper": ["$source~>Ralph"] } };
  const instance = new MockAgent({
    runs: ["draft-1", "draft-2"].map((text) => run([settle(assistant(text))])),
  });
  const final = mock("final reply");
  const execution = await build(
    parse({
      graph: {
        source: { routes: { seed: ["$source~>Wrapper"] } },
        nodes: {
          Wrapper: { kind: "graph", graph: inner },
          Final: { prompt: "{{ Wrapper~>Final }}" },
        },
        edges: [
          { from: "$source", to: "Wrapper", kind: "message" },
          { from: "Wrapper", to: "Final", kind: "message" },
          { from: "Final", to: "$sink" },
        ],
      },
    }),
    {
      ...options(),
      createAgent: async (spec) => (spec.node === "Ralph" ? instance : final),
      ...schedules.ralph({ rounds: 2 }),
    },
  );
  try {
    enqueuePrompts(execution, "seed", { kind: "prompt", text: "assignment" });
    await execution.run();
    assert.deepEqual(lastPrompts(instance), [
      "assignment",
      revision("draft-1"),
    ]);
    assert.deepEqual(lastPrompts(final), ["draft-2"]);
    assert.equal(resultText(execution.graph), "final reply");
  } finally {
    await execution.graph.close();
  }
});

test("value templates normalize final text", async () => {
  const doc = parse({
    graph: {
      nodes: {
        A: { prompt: "start" },
        B: { prompt: "value={{ A->B }}", trigger: "A->B" },
      },
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "$sink" },
      ],
    },
  });
  const b = mock("done");
  const execution = await build(doc, {
    ...options(),
    createAgent: async (spec) => (spec.node === "A" ? mock("  answer  ") : b),
  });
  try {
    await execution.run();
    assert.deepEqual(lastPrompts(b), ["value=answer"]);
  } finally {
    await execution.graph.close();
  }
});

for (const trigger of [
  undefined,
  { all: ["left", "right"] },
  { any: ["left", "right"] },
  "never",
] as const)
  test(`scheduled consumer readiness ${JSON.stringify(trigger)}`, async () => {
    let rightAllowed = false;
    const consumer = mock("joined");
    const execution = await build(
      parse({
        graph: {
          nodes: {
            Left: { prompt: "left" },
            Right: { prompt: "right" },
            Consumer: { trigger, prompt: "{{left}}/{{right}}" },
          },
          edges: [
            { from: "Left", to: "Consumer", id: "left" },
            { from: "Right", to: "Consumer", id: "right" },
            { from: "Consumer", to: "$sink" },
          ],
        },
      }),
      {
        ...options(),
        createAgent: async (spec) =>
          spec.node === "Consumer" ? consumer : mock(spec.node),
        available: { Right: resumable("Right", () => rightAllowed) },
      },
    );
    try {
      await execution.run();
      const early = typeof trigger === "object" && "any" in trigger;
      assert.equal(consumer.requests.length, early ? 1 : 0);
      if (early) assert.deepEqual(lastPrompts(consumer), ["Left/"]);
      rightAllowed = true;
      await execution.run();
      assert.equal(consumer.requests.length, trigger === "never" ? 0 : 1);
      if (!early && trigger !== "never")
        assert.deepEqual(lastPrompts(consumer), ["Left/Right"]);
    } finally {
      await execution.graph.close();
    }
  });

test("source fan-out preserves inbox payloads and sink waits for both value results", async () => {
  const allowed = new Set<string>();
  const agents = new Map([
    ["Left", mock("LEFT")],
    ["Right", mock("RIGHT")],
  ]);
  const retained = assistant("LEFT");
  agents.set("Left", new MockAgent({ runs: [run([settle(retained)])] }));
  const execution = await build(
    parse({
      graph: {
        window: 2,
        threads: 2,
        source: { routes: { seed: ["$source~>Left", "$source~>Right"] } },
        sink: { returns: "Left" },
        nodes: {
          Left: { prompt: "{{ $source~>Left }}" },
          Right: { prompt: "{{ $source~>Right }}" },
        },
        edges: [
          { from: "$source", to: "Left", kind: "message" },
          { from: "$source", to: "Right", kind: "message" },
          { from: "Left", to: "$sink" },
          { from: "Right", to: "$sink" },
        ],
      },
    }),
    {
      ...options(),
      createAgent: async (spec) => agents.get(spec.node)!,
      available: Object.fromEntries(
        ["Left", "Right"].map((id) => [
          id,
          resumable(id, () => allowed.has(id)),
        ]),
      ),
    },
  );
  try {
    const payload = {
      kind: "prompt" as const,
      text: "seed text",
      images: [
        { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
      ],
    };
    enqueuePrompts(execution, "seed", payload);
    await execution.run();
    const observation = execution.graph.observe();
    assert.equal(
      [...observation.nodes.values()].filter(
        (n) => n.state instanceof graph.nodes.Source,
      ).length,
      1,
    );
    assert.equal(
      [...observation.nodes.values()].filter(
        (n) => n.state instanceof graph.nodes.Sink,
      ).length,
      1,
    );
    assert.equal(
      observation.nodes.get(graph.NodeId.create("$source"))?.state,
      execution.graph.source,
    );
    assert.equal(
      observation.nodes.get(graph.NodeId.create("$sink"))?.state,
      execution.graph.sink,
    );
    assert.deepEqual(observation.links, [
      ["$source", "Left", "$source~>Left", "message"],
      ["$source", "Right", "$source~>Right", "message"],
      ["Left", "$sink", "Left->$sink", "value"],
      ["Right", "$sink", "Right->$sink", "value"],
    ]);
    for (const id of ["Left", "Right"]) {
      assert.deepEqual(
        observation.inputs
          .get(graph.NodeId.create(id))
          ?.messages.get(graph.EdgeId.create(`$source~>${id}`)),
        [payload],
      );
      assert.equal(agents.get(id)!.requests.length, 0);
    }
    allowed.add("Left");
    await execution.run();
    assert.equal(
      execution.graph.result(graph.NodeId.create("Left"))._tag,
      "Some",
    );
    assert.equal(
      execution.graph.result(graph.NodeId.create("Right"))._tag,
      "None",
    );
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "None");
    allowed.add("Right");
    await execution.run();
    for (const instance of agents.values())
      assert.deepEqual(lastPrompts(instance), ["seed text"]);
    const left = execution.graph.result(graph.NodeId.create("Left"));
    const sink = execution.graph.result(execution.graph.sink.id);
    assert.equal(left._tag, "Some");
    assert.equal(sink._tag, "Some");
    if (left._tag === "Some" && sink._tag === "Some")
      assert.equal(sink.value, left.value);
  } finally {
    await execution.graph.close();
  }
});

test("recursive graphs have fresh local ports and publish one final to messages and values", async () => {
  const doc = document();
  const inner = doc.graph.nodes.Inner;
  assert.ok(inner?.kind === "graph");
  doc.graph.nodes.Sibling = structuredClone(inner);
  doc.graph.nodes.Sibling.trigger = "siblingSeed";
  doc.graph.nodes.Sibling.graph.name = "sibling";
  doc.graph.nodes.Sibling.graph.source!.routes = {
    siblingSeed: ["$source~>Worker"],
  };
  doc.graph.nodes.Fan = { prompt: "{{ fan }}" };
  doc.graph.nodes.Final = {
    prompt: "{{Inner~>Final}}|{{childValue}}|{{siblingValue}}",
  };
  doc.graph.edges!.push(
    { from: "Start", to: "Sibling", kind: "message", id: "siblingSeed" },
    { from: "Inner", to: "Fan", kind: "message", id: "fan" },
    { from: "Inner", to: "Final", id: "childValue" },
    { from: "Sibling", to: "Final", id: "siblingValue" },
  );
  const final = mock("final"),
    fan = mock("fan");
  const execution = await build(parse(doc), {
    ...options(),
    createAgent: async (spec) =>
      spec.node === "Worker"
        ? mock(spec.graph === "sibling" ? "SIBLING" : "CHILD", "work")
        : spec.node === "Fan"
          ? fan
          : final,
  });
  try {
    const sources = new Set(),
      sinks = new Set();
    function visit(g: graph.JuncoGraph) {
      const view = g.observe();
      assert.equal(
        [...view.nodes.values()].filter(
          (n) => n.state instanceof graph.nodes.Source,
        ).length,
        1,
      );
      assert.equal(
        [...view.nodes.values()].filter(
          (n) => n.state instanceof graph.nodes.Sink,
        ).length,
        1,
      );
      assert.ok(!sources.has(g.source));
      assert.ok(!sinks.has(g.sink));
      sources.add(g.source);
      sinks.add(g.sink);
      assert.ok(
        view.links.every(
          ([from, to, , kind]) =>
            to !== "$source" &&
            from !== "$sink" &&
            (from !== "$source" || kind === "message"),
        ),
      );
      for (const n of view.nodes.values())
        if (n.state instanceof graph.JuncoGraph) visit(n.state);
    }
    visit(execution.graph);
    assert.equal(sources.size, 3);
    assert.equal(sinks.size, 3);
    await execution.run();
    assert.deepEqual(lastPrompts(final), ["CHILD|CHILD|SIBLING"]);
    assert.deepEqual(lastPrompts(fan), ["CHILD"]);
  } finally {
    await execution.graph.close();
  }
});

for (const routes of [undefined, { accepted: ["input"] }])
  test(`scheduled ingress rejects ${routes ? "unrouted input" : "closed source"}`, async () => {
    const execution = await build(
      parse({
        graph: {
          source: routes ? { routes } : undefined,
          nodes: { A: { prompt: "{{input}}" } },
          edges: [
            { from: "$source", to: "A", kind: "message", id: "input" },
            { from: "A", to: "$sink" },
          ],
        },
      }),
      { ...options(), createAgent: async () => mock("unused") },
    );
    try {
      enqueuePrompts(execution, "wrong", { kind: "prompt", text: "go" });
      await assert.rejects(
        execution.run(),
        routes
          ? /does not accept input on edge "wrong"/
          : /does not accept external input/,
      );
    } finally {
      await execution.graph.close();
    }
  });

test("value ingress becomes a prompt and empty routes drop only that input", async () => {
  const a = mock("done");
  const execution = await build(
    parse({
      graph: {
        source: { routes: { drop: [], value: ["input"] } },
        nodes: { A: { prompt: "{{input}}" } },
        edges: [
          { from: "$source", to: "A", kind: "message", id: "input" },
          { from: "A", to: "$sink" },
        ],
      },
    }),
    { ...options(), createAgent: async () => a },
  );
  try {
    execution.graph.source.enqueue({
      messages: new Map([
        [graph.EdgeId.create("drop"), [{ kind: "prompt", text: "discard" }]],
      ]),
      values: new Map([
        [graph.EdgeId.create("value"), assistant("  normalized  ")],
      ]),
    });
    await execution.run();
    assert.deepEqual(lastPrompts(a), ["normalized"]);
  } finally {
    await execution.graph.close();
  }
});

test("early sink identifies the selected predecessor that has not returned", async () => {
  const execution = await build(
    parse({
      graph: {
        sink: { trigger: "always" },
        nodes: { A: { trigger: "never" } },
        edges: [{ from: "A", to: "$sink" }],
      },
    }),
    { ...options(), createAgent: async () => mock("unused") },
  );
  try {
    await assert.rejects(
      execution.run(),
      nodeFailure(/^A did not produce a result$/),
    );
  } finally {
    await execution.graph.close();
  }
});

for (const text of ["", "   ", "bad-stop"])
  test(`invalid upstream report ${JSON.stringify(text)} prevents a consumer request`, async () => {
    const bad = {
      ...assistant(text),
      ...(text === "bad-stop" ? { stopReason: "length" as const } : {}),
    };
    const consumer = mock("unused");
    const execution = await build(
      parse({
        graph: {
          nodes: {
            A: { prompt: "go" },
            B: { prompt: "{{report}}" },
          },
          edges: [
            { from: "A", to: "B", id: "report" },
            { from: "B", to: "$sink" },
          ],
        },
      }),
      {
        ...options(),
        createAgent: async (spec) =>
          spec.node === "A"
            ? new MockAgent({ runs: [run([settle(bad)])] })
            : consumer,
      },
    );
    try {
      await assert.rejects(
        execution.run(),
        nodeFailure(
          text === "bad-stop"
            ? /did not finish normally: length/
            : /produced an empty report/,
        ),
      );
      assert.equal(consumer.requests.length, 0);
    } finally {
      await execution.graph.close();
    }
  });

test("mixed repeated placeholders preserve order, paragraph joins and optional emptiness", async () => {
  const consumer = mock("done");
  const execution = await build(
    parse({
      graph: {
        source: { routes: { seed: ["m"] } },
        nodes: {
          A: { prompt: "go" },
          Optional: { trigger: "never" },
          B: {
            trigger: { all: ["v", "m"] },
            prompt: "{{ m }}|{{v}}|{{m}}|{{optional}}",
          },
        },
        edges: [
          { from: "$source", to: "B", kind: "message", id: "m" },
          { from: "A", to: "B", id: "v" },
          { from: "Optional", to: "B", kind: "message", id: "optional" },
          { from: "B", to: "$sink" },
        ],
      },
    }),
    {
      ...options(),
      createAgent: async (spec) =>
        spec.node === "B" ? consumer : mock("VALUE"),
    },
  );
  try {
    enqueuePrompts(
      execution,
      "seed",
      { kind: "prompt", text: "first" },
      {
        kind: "appendMessage",
        message: { role: "user", content: "not text", timestamp: 0 },
      },
      { kind: "prompt", text: "third" },
    );
    await execution.run();
    assert.deepEqual(lastPrompts(consumer), [
      "first\n\n\n\nthird|VALUE|first\n\n\n\nthird|",
    ]);
  } finally {
    await execution.graph.close();
  }
});

test("explicit widths serialize real activations and nested work uses the shared tracer", async () => {
  const seen = new Set<unknown>();
  let running = 0,
    peak = 0,
    activations = 0;
  class Observer extends tracer.DummyTracer {
    override startRun<S, N, T, EH>(
      g: graph.DataflowGraph<S, N, T, EH>,
    ): tracer.DataflowRunTrace<N, T> {
      seen.add(g);
      return {
        startNode: () => {
          running++;
          activations++;
          peak = Math.max(peak, running);
          return {
            end: () => {
              running--;
            },
            fail: () => {
              running--;
            },
          };
        },
        end: () => {},
        fail: () => {},
      };
    }
  }
  const observer = new Observer();
  const doc = document();
  doc.graph.window = 1;
  doc.graph.threads = 1;
  const inner = doc.graph.nodes.Inner;
  assert.ok(inner?.kind === "graph");
  inner.graph.window = 1;
  inner.graph.threads = "unbounded";
  const execution = await build(doc, {
    ...options(),
    tracer: observer,
    createAgent: async (spec) =>
      mock(spec.node, spec.node === "Worker" ? "work" : undefined),
  });
  try {
    await execution.run();
    const child = execution.graph.getNode(graph.NodeId.create("Inner"))!.state;
    assert.ok(child instanceof graph.JuncoGraph);
    assert.ok(seen.has(child));
    assert.ok(seen.has(execution.graph));
    assert.equal(running, 0);
    assert.ok(activations >= 6);
    // The wrapper stays active while its child runs; no sibling root activation overlaps it.
    assert.equal(peak, 2);
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "Some");
  } finally {
    await execution.graph.close();
  }
});
for (const nested of [false, true])
  test(`default no-agent construction ${nested ? "recurses" : "stays native"} without a collection`, async () => {
    const child = {
      sink: { trigger: "never" },
      nodes: { Seed: { kind: "emit", text: "go" } },
      edges: [{ from: "Seed", to: "$sink", kind: "message" }],
    };
    const doc = parse({
      graph: nested
        ? {
            sink: { trigger: "never" },
            nodes: { Child: { kind: "graph", trigger: "never", graph: child } },
            edges: [{ from: "Child", to: "$sink" }],
          }
        : child,
    });
    const execution = await build(doc, options());
    try {
      await execution.run();
      assert.equal(
        execution.graph.result(execution.graph.sink.id)._tag,
        "None",
      );
    } finally {
      await execution.graph.close();
    }
  });

test("default build uses real offline agents and releases only borrowed collection holds", async () => {
  const { models, faux } = await fauxRuntime([
    fauxAssistantMessage("offline result"),
  ]);
  const { collection, events, active } = countedCollection();
  const execution = await build(
    parse({
      graph: {
        nodes: {
          A: {
            system: "fixture system",
            prompt: "offline task",
          },
        },
        edges: [{ from: "A", to: "$sink" }],
      },
    }),
    { ...options(), models, collection, ladder: fauxLadder },
  );
  try {
    assert.deepEqual(active, { leases: 1, bindings: 1, creatorCloses: 0 });
    await execution.run();
    assert.equal(resultText(execution.graph), "offline result");
    assert.equal(faux.state.callCount, 1);
  } finally {
    try {
      await execution.graph.close();
      await execution.graph.close();
      assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
      assert.equal(events.filter((x) => x === "bind-close:1").length, 1);
      assert.equal(events.filter((x) => x === "lease-close:1").length, 1);
    } finally {
      await collection.close();
    }
  }
  assert.equal(active.creatorCloses, 1);
});

test("pre-aborted build preserves its reason without acquiring agents or graph leases", async () => {
  const { models } = await fauxRuntime([]);
  const { collection, active } = countedCollection();
  const reason = new Error("pre-aborted fixture");
  try {
    await assert.rejects(
      build(
        parse({
          graph: {
            nodes: { A: {} },
            edges: [{ from: "A", to: "$sink" }],
          },
        }),
        {
          ...options(),
          models,
          collection,
          ladder: fauxLadder,
          signal: AbortSignal.abort(reason),
        },
      ),
      (error) => error === reason,
    );
    assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
  } finally {
    await collection.close();
  }
});

for (const row of [
  {
    name: "system-only",
    system: "Resource fixture base instructions.",
    skill: undefined,
  },
  { name: "skill-only", system: undefined, skill: "guide" },
  {
    name: "combined",
    system: "Resource fixture base instructions.",
    skill: "guide",
  },
  {
    name: "disabled",
    system: "Resource fixture base instructions.",
    skill: "hidden",
  },
] as const)
  test(`real offline default agent receives ${row.name} system context and releases borrowed resources`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "junco-yaml-system-context-"));
    const counted = countedCollection();
    try {
      for (const name of ["guide", "hidden"]) {
        await mkdir(join(cwd, name));
        await writeFile(
          join(cwd, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name === "guide" ? "Visible resource fixture description." : "Hidden resource fixture description."}\n${name === "hidden" ? "disable-model-invocation: true\n" : ""}---\n${name} body fixture.\n`,
        );
      }
      const doc = parse({
        skills: { guide: "guide/SKILL.md", hidden: "hidden/SKILL.md" },
        graph: {
          nodes: {
            A: {
              prompt: "Execute the resource fixture.",
              ...(row.system === undefined ? {} : { system: row.system }),
              ...(row.skill === undefined ? {} : { skills: [row.skill] }),
            },
          },
          edges: [{ from: "A", to: "$sink" }],
        },
      });
      let requests = 0;
      let inspect: () => void = () =>
        assert.fail("provider did not receive the fixture");
      const { models } = await fauxRuntime([
        (context) => {
          requests++;
          inspect = () => {
            const system = context.messages
              .filter((message) => message.role === "system")
              .map((message) => contentText(message.content))
              .join("\n\n");
            if (row.system !== undefined)
              assert.ok(system.includes(row.system));
            else
              assert.ok(
                !system.includes("Resource fixture base instructions."),
              );
            if (row.skill === "guide") {
              assert.ok(system.includes("<name>guide</name>"));
              assert.ok(
                system.includes("Visible resource fixture description."),
              );
              assert.ok(system.includes(join(cwd, "guide", "SKILL.md")));
              if (row.system !== undefined)
                assert.ok(
                  system.indexOf(row.system) <
                    system.indexOf("<available_skills>"),
                );
            } else {
              assert.ok(!system.includes("<available_skills>"));
              assert.ok(
                !system.includes("Visible resource fixture description."),
              );
            }
            assert.ok(!system.includes("Hidden resource fixture description."));
            assert.ok(!system.includes("<name>hidden</name>"));
            assert.deepEqual(userTexts(context.messages), [
              "Execute the resource fixture.",
            ]);
          };
          return fauxAssistantMessage(`completed ${row.name}`);
        },
      ]);
      if (row.skill === "hidden") {
        const [spec] = await resolveAgents(doc, {
          cwd,
          collection: counted.collection,
        });
        assert.equal(spec?.skills[0]?.disableModelInvocation, true);
        assert.ok(spec?.skills[0]?.content.includes("hidden body fixture."));
      }
      const execution = await build(doc, {
        ...options(),
        cwd,
        models,
        ladder: fauxLadder,
        collection: counted.collection,
      });
      try {
        assert.deepEqual(counted.active, {
          leases: 1,
          bindings: 1,
          creatorCloses: 0,
        });
        await execution.run();
        assert.equal(requests, 1);
        inspect();
        assert.equal(resultText(execution.graph), `completed ${row.name}`);
      } finally {
        await execution.graph.close();
      }
      await execution.graph.close();
      assert.deepEqual(counted.active, {
        leases: 0,
        bindings: 0,
        creatorCloses: 0,
      });
      assert.deepEqual([...counted.events].sort(), [
        "bind-close:1",
        "lease-close:1",
      ]);
    } finally {
      try {
        await counted.collection.close();
        assert.equal(counted.active.creatorCloses, 1);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

for (const advertised of [true, false])
  test(`builtin info exposes ${advertised ? "the receiver's declared contract" : "a missing-edge error for an empty contract map"}`, async () => {
    const expectation = "A complete ownership report for the receiver.";
    let inspected = false;
    const { models, faux } = await fauxRuntime([
      fauxAssistantMessage(
        [fauxToolCall("info", {}, { id: "inspect-contract" })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        const result = context.messages.find(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "inspect-contract",
        );
        assert.ok(
          result?.role === "toolResult",
          "the sender must see info's actual tool result on its next request",
        );
        const text = contentText(result.content);
        if (advertised) {
          assert.ok(!result.isError);
          assert.deepEqual(JSON.parse(text), {
            parents: [],
            children: [
              {
                id: "Receiver",
                edgeId: "handoff",
                kind: "message",
                expect: expectation,
              },
            ],
          });
        } else {
          assert.equal(result.isError, true);
          assert.match(text, /No contract for edge "handoff"/);
          assert.doesNotMatch(text, /"expect"\s*:/);
        }
        inspected = true;
        return fauxAssistantMessage("INSPECTED");
      },
    ]);
    const { collection, active } = countedCollection();
    let execution: Awaited<ReturnType<typeof build>> | undefined;
    try {
      execution = await build(
        parse({
          graph: {
            nodes: {
              Sender: {
                prompt: "Inspect the receiver's actual contract using info.",
              },
              Receiver: {
                trigger: "never",
                contracts: advertised ? { handoff: expectation } : {},
              },
            },
            edges: [
              {
                from: "Sender",
                to: "Receiver",
                kind: "message",
                id: "handoff",
              },
              { from: "Receiver", to: "$sink" },
            ],
          },
        }),
        { ...options(), models, collection, ladder: fauxLadder },
      );
      await execution.run();
      assert.equal(inspected, true);
      assert.equal(
        faux.state.callCount,
        2,
        "only the sender runs; contract lookup must not execute the receiver",
      );
      assert.equal(faux.getPendingResponseCount(), 0);
      assert.equal(
        resultText(execution.graph, graph.NodeId.create("Sender")),
        "INSPECTED",
      );
      assert.equal(
        execution.graph.result(graph.NodeId.create("Receiver"))._tag,
        "None",
      );
      assert.equal(
        execution.graph.result(execution.graph.sink.id)._tag,
        "None",
      );
      await execution.graph.close();
      assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
    } finally {
      try {
        await execution?.graph.close();
      } finally {
        await collection.close();
      }
    }
    assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 1 });
  });

for (const nested of [false, true])
  for (const cleanupFails of [false, true])
    test(`default construction rollback releases ${nested ? "nested" : "root"} holds${cleanupFails ? " despite a binding-close failure" : ""}`, async () => {
      const { models, faux } = await fauxRuntime([]);
      const sentinel = new Error("binding-close sentinel");
      const primary = new Error("construction registration sentinel");
      const { collection, events, active } = countedCollection(
        cleanupFails ? { binding: 2, error: sentinel } : undefined,
      );
      const successful = {
        nodes: {
          A: {},
          B: {},
        },
        edges: [{ from: "B", to: "$sink" }],
      };
      const doc = parse({
        graph: nested
          ? {
              nodes: {
                Child: { kind: "graph", graph: successful },
                Missing: {},
              },
              edges: [{ from: "Child", to: "$sink" }],
            }
          : {
              ...successful,
              nodes: {
                ...successful.nodes,
                Missing: {},
              },
            },
      });
      try {
        await assert.rejects(
          build(doc, {
            ...options(),
            models,
            collection,
            ladder: fauxLadder,
            available: {
              Missing: () => {
                throw primary;
              },
            },
          }),
          (error: unknown) => {
            const cause =
              error instanceof AggregateError ? error.errors[0] : error;
            assert.equal(cause, primary);
            const leaves = (failure: unknown): unknown[] =>
              failure instanceof AggregateError
                ? failure.errors.flatMap(leaves)
                : [failure];
            assert.equal(
              leaves(error).filter((failure) => failure === sentinel).length,
              cleanupFails ? 1 : 0,
            );
            if (cleanupFails) {
              assert.ok(error instanceof AggregateError);
              assert.equal(
                error.message,
                "build failed and agent cleanup failed",
              );
            } else assert.equal(error, primary);
            return true;
          },
        );
        assert.equal(faux.state.callCount, 0);
        assert.deepEqual(
          events.filter((event) => event.startsWith("bind-close:")),
          ["bind-close:2", "bind-close:1"],
        );
        assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
        assert.deepEqual(
          events.filter((event) => event.startsWith("lease-close:")).sort(),
          nested ? ["lease-close:1", "lease-close:2"] : ["lease-close:1"],
        );
      } finally {
        await collection.close();
      }
      assert.equal(active.creatorCloses, 1);
    });

const codeDocument = (id = "Emitter") =>
  parse({
    graph: {
      name: "Codes",
      nodes: { [id]: { kind: "code", trigger: "always" } },
      edges: [{ from: id, to: "$sink" }],
    },
  });
const codeOptions = (log: string[]) => ({
  cwd: join(import.meta.dir, ".."),
  scheduler: () => schedules.roundRobin(),
  policy: tools.EmptyPolicy,
  context: { log },
  code: { Emitter },
});
for (const hooked of [false, true])
  test(`code node registers its configured definition${hooked ? " over an availability hook" : ""}`, async () => {
    const log: string[] = [];
    const execution = await build(codeDocument(), {
      ...codeOptions(log),
      ...(hooked ? { available: { Emitter: () => () => false } } : {}),
    });
    try {
      assert.deepEqual(log, ["Codes/Emitter"]);
      await execution.run();
      assert.equal(resultText(execution.graph), "Codes/Emitter");
    } finally {
      await execution.graph.close();
    }
  });

test("nested code nodes resolve their configured definition by local node id", async () => {
  const log: string[] = [];
  const doc = codeDocument();
  const execution = await build(
    parse({
      graph: {
        nodes: { Nested: { kind: "graph", graph: doc.graph } },
        edges: [{ from: "Nested", to: "$sink" }],
      },
    }),
    codeOptions(log),
  );
  try {
    await execution.run();
    assert.equal(resultText(execution.graph), "Codes/Emitter");
  } finally {
    await execution.graph.close();
  }
});
test("code without a configured definition is a definition error", async () => {
  const log: string[] = [];
  await assert.rejects(
    build(codeDocument("Missing"), { ...codeOptions(log), code: {} }),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message ===
        'junco-syntax: code node "Missing" has no definition in options.code',
  );
  assert.deepEqual(log, []);
});

test("declared profiles admit a strict memory schedule and name an undeclared agent", async () => {
  for (const declared of [true, false]) {
    const doc = document();
    const inner = doc.graph.nodes.Inner!;
    assert.equal(inner.kind, "graph");
    if (inner.kind !== "graph") assert.fail("expected nested graph");
    inner.graph.nodes.Worker!.profiles = { memory: "100 MB" };
    if (declared) doc.graph.nodes.Final!.profiles = { memory: "100 MB" };
    const execution = await build(doc, {
      ...options(),
      scheduler: () =>
        schedules.limit({ memory: megabytes(1024) }, schedules.parallel()),
      createAgent: async (spec) =>
        mock(
          spec.node === "Worker" ? "leaf" : "done",
          spec.node === "Worker" ? "work" : undefined,
        ),
    });
    try {
      if (declared) {
        await execution.run();
        assert.equal(resultText(execution.graph), "done");
      } else {
        await assert.rejects(
          execution.run(),
          (error) =>
            nodeFailure(/limit: node "Final" has no memory profile/)(error) ||
            (error instanceof graph.DataflowDefinitionError &&
              /limit: node "Final" has no memory profile/.test(error.message)),
        );
      }
    } finally {
      await execution.graph[Symbol.asyncDispose]();
    }
  }
});

test("fitted profiles keyed by node path win over declarations", async () => {
  const doc = document();
  const inner = doc.graph.nodes.Inner!;
  if (inner.kind !== "graph") assert.fail("expected nested graph");
  inner.graph.nodes.Worker!.profiles = { memory: "1 MB" };
  const execution = await build(doc, {
    ...options(),
    createAgent: async () => mock("done"),
    profiles: {
      version: 1,
      nodes: {
        "Inner/Worker": {
          memory: {
            resource: "memory",
            unit: "MB",
            features: [],
            model: { kind: "constant" },
            fit: { n: 5, residP95: 0, fittedAt: "2026-10-20" },
            range: [],
            bound: 256,
          },
        },
      },
    },
  });
  try {
    const nested = execution.graph.getNode(graph.NodeId.create("Inner"))!.state;
    assert.ok(nested instanceof graph.JuncoGraph);
    assert.equal(
      (
        nested.getNode(graph.NodeId.create("Worker"))!
          .profiles as graph.ProfileSet
      ).memory!.predict([]).safe,
      256,
    );
    assert.equal(
      (
        execution.graph.getNode(execution.graph.sink.id)!
          .profiles as graph.ProfileSet
      ).memory!.predict([]).safe,
      0,
    );
  } finally {
    await execution.graph[Symbol.asyncDispose]();
  }
});

test("resources need the collection build creates", async () => {
  const message =
    "junco-syntax: resources and onResourceEvent apply to the collection build creates; open the supplied collection with them instead";
  for (const extra of [
    { createAgent: async () => mock("done"), resources: { pids: 1 } },
    { collection: {} as tools.ToolCollection, onResourceEvent: () => {} },
  ]) {
    await assert.rejects(
      build(document(), { ...options(), ...extra }),
      (error) =>
        error instanceof graph.DataflowDefinitionError &&
        error.message === message,
    );
  }
});

test("prepared agents use node paths, skip factory configuration and belong to the successful graph", async () => {
  const { models, faux } = await fauxRuntime([
    fauxAssistantMessage("prepared child result"),
    (context) => {
      assert.equal(
        userTexts(context.messages).at(-1),
        "got: prepared child result",
      );
      return fauxAssistantMessage("prepared final result");
    },
  ]);
  const { collection, active } = countedCollection();
  const worker = await agent.JuncoAgent.create({
    provider: "faux",
    model: "faux-1",
    models,
    tools: [],
    collection,
    prompt: "work",
  });
  const final = await agent.JuncoAgent.create({
    provider: "faux",
    model: "faux-1",
    models,
    tools: [],
    collection,
  });
  try {
    // No build collection/models/ladder: prepared agents retain their own configuration.
    const execution = await build(document(), {
      ...options(),
      agents: { "Inner/Worker": worker, Final: final },
    });
    try {
      assert.equal(execution.graph.collection, undefined);
      assert.deepEqual(active, { leases: 0, bindings: 2, creatorCloses: 0 });
      await execution.run();
      assert.equal(resultText(execution.graph), "prepared final result");
      assert.equal(faux.state.callCount, 2);
    } finally {
      await execution.graph[Symbol.asyncDispose]();
    }
    assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
  } finally {
    await worker.return();
    await final.return();
    await collection.close();
  }
});

for (const boundary of [
  "aborted",
  "code definition",
  "missing",
  "unused",
  "duplicate",
  "factory",
  "resources",
] as const)
  test(`prepared agents transfer ownership before ${boundary} failure`, async () => {
    const { models } = await fauxRuntime([]);
    const { collection, events, active } = countedCollection();
    const instance = await agent.JuncoAgent.create({
      provider: "faux",
      model: "faux-1",
      models,
      tools: [],
      collection,
    });
    const extra =
      boundary === "unused"
        ? await agent.JuncoAgent.create({
            provider: "faux",
            model: "faux-1",
            models,
            tools: [],
            collection,
          })
        : undefined;
    const reason = new Error("prepared pre-aborted fixture");
    const doc = parse({
      graph: {
        nodes: {
          A: {},
          ...(boundary === "missing" || boundary === "duplicate"
            ? { B: {} }
            : boundary === "code definition"
              ? { Missing: { kind: "code" } }
              : {}),
        },
        edges: [{ from: "A", to: "$sink" }],
      },
    });
    const expected = {
      aborted: /prepared pre-aborted fixture/,
      "code definition":
        /code node "Missing" has no definition in options.code/,
      missing: /missing prepared agent.*B/,
      unused: /unused prepared agents: Extra/,
      duplicate: /same agent to multiple node paths/,
      factory: /agents and createAgent are mutually exclusive/,
      resources:
        /resources and onResourceEvent apply to the collection build creates/,
    }[boundary];
    try {
      await assert.rejects(
        build(doc, {
          ...options(),
          agents: {
            A: instance,
            ...(extra ? { Extra: extra } : {}),
            ...(boundary === "duplicate" ? { B: instance } : {}),
          },
          ...(boundary === "aborted"
            ? { signal: AbortSignal.abort(reason) }
            : {}),
          ...(boundary === "factory"
            ? { createAgent: async () => instance }
            : {}),
          ...(boundary === "resources" ? { resources: { pids: 1 } } : {}),
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, expected);
          if (boundary === "aborted") assert.equal(error, reason);
          return true;
        },
      );
      assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
      assert.deepEqual(
        events,
        extra ? ["bind-close:2", "bind-close:1"] : ["bind-close:1"],
      );
    } finally {
      await instance.return();
      await extra?.return();
      await collection.close();
    }
  });

for (const [label, nested, failing] of [
  ["root", false, "B"],
  ["unadopted child", true, "B"],
  ["adopted child", true, "Last"],
] as const)
  for (const cleanupFails of [false, true])
    test(`prepared rollback closes every agent and ${label}${cleanupFails ? " despite cleanup failure" : ""}`, async () => {
      const { models } = await fauxRuntime([]);
      const primary = new Error("prepared registration sentinel");
      const cleanup = new Error("prepared cleanup sentinel");
      const { collection, events, active } = countedCollection(
        cleanupFails ? { binding: 2, error: cleanup } : undefined,
      );
      const members: agent.JuncoAgent[] = [];
      for (let i = 0; i < 3; i++)
        members.push(
          await agent.JuncoAgent.create({
            provider: "faux",
            model: "faux-1",
            models,
            tools: [],
            collection,
          }),
        );
      const child = {
        nodes: { A: {}, B: {} },
        edges: [{ from: "B", to: "$sink" }],
      };
      const graphs: graph.JuncoGraph[] = [];
      try {
        await assert.rejects(
          build(
            parse({
              graph: nested
                ? {
                    nodes: { Child: { kind: "graph", graph: child }, Last: {} },
                    edges: [{ from: "Child", to: "$sink" }],
                  }
                : {
                    ...child,
                    nodes: { ...child.nodes, Last: {} },
                  },
            }),
            {
              ...options(),
              collection,
              agents: {
                [nested ? "Child/A" : "A"]: members[0]!,
                [nested ? "Child/B" : "B"]: members[1]!,
                Last: members[2]!,
              },
              available: {
                $sink: ({ graph: g }) => {
                  graphs.push(g);
                  return undefined;
                },
                [failing]: () => {
                  throw primary;
                },
              },
            },
          ),
          (error) => {
            if (!cleanupFails) assert.equal(error, primary);
            else {
              assert.ok(error instanceof AggregateError);
              assert.equal(error.errors[0], primary);
              assert.ok(
                error.errors
                  .slice(1)
                  .some(
                    (failure) =>
                      failure === cleanup ||
                      (failure instanceof AggregateError &&
                        failure.errors.includes(cleanup)),
                  ),
              );
            }
            return true;
          },
        );
        assert.equal(graphs.length, nested ? 2 : 1);
        assert.ok(graphs.every((g) => g.signal.aborted));
        assert.deepEqual(
          events.filter((event) => event.startsWith("bind-close:")),
          ["bind-close:3", "bind-close:2", "bind-close:1"],
        );
        assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
      } finally {
        for (const member of members) await member.return().catch(() => {});
        await collection.close();
      }
    });

test("createAgent instances remain caller-owned when construction fails", async () => {
  const { models } = await fauxRuntime([]);
  const { collection, active } = countedCollection();
  const instance = await agent.JuncoAgent.create({
    provider: "faux",
    model: "faux-1",
    models,
    tools: [],
    collection,
  });
  const primary = new Error("factory registration sentinel");
  try {
    await assert.rejects(
      build(
        parse({
          graph: {
            nodes: { A: {}, B: {} },
            edges: [{ from: "B", to: "$sink" }],
          },
        }),
        {
          ...options(),
          createAgent: async () => instance,
          available: {
            B: () => {
              throw primary;
            },
          },
        },
      ),
      (error) => error === primary,
    );
    assert.deepEqual(active, { leases: 0, bindings: 1, creatorCloses: 0 });
  } finally {
    await instance.return();
    await collection.close();
  }
});

/** Counts every disposal of `instance`, whether by a graph or by its owner. */
function countDisposals(instance: MockAgent): { count: number } {
  const disposals = { count: 0 };
  const dispose = instance.return.bind(instance);
  instance.return = (value) => {
    disposals.count++;
    return dispose(value);
  };
  return disposals;
}
const aborts = (instance: MockAgent) =>
  instance.calls.filter(({ method }) => method === "abort").length;
const roundDoc = (prompt: string) =>
  parse({
    graph: {
      nodes: { A: { prompt } },
      edges: [{ from: "A", to: "$sink" }],
    },
  });

test("caller-owned factory agents survive each round's graph close and close once with their owner", async () => {
  const instance = new MockAgent({
    runs: ["answer-1", "answer-2"].map((text) =>
      run([settle(assistant(text))]),
    ),
  });
  const disposals = countDisposals(instance);
  try {
    for (const round of [1, 2]) {
      const execution = await build(roundDoc(`round ${round}`), {
        ...options(),
        createAgent: async () => instance,
        createAgentOwnership: "caller",
      });
      try {
        await execution.run();
        assert.equal(resultText(execution.graph), `answer-${round}`);
      } finally {
        await execution.graph.close();
      }
      assert.equal(aborts(instance), round, "close aborts and joins");
      assert.equal(disposals.count, 0);
      assert.notEqual(instance.status, "closed");
    }
    assert.deepEqual(lastPrompts(instance), ["round 1", "round 2"]);
  } finally {
    await instance.return();
  }
  assert.equal(disposals.count, 1);
  assert.equal(instance.status, "closed");
});

for (const ownership of [undefined, "graph"] as const)
  test(`${ownership ?? "default"} factory ownership disposes the agent on graph close`, async () => {
    const instance = mock("done");
    const disposals = countDisposals(instance);
    const execution = await build(roundDoc("work"), {
      ...options(),
      createAgent: async () => instance,
      ...(ownership ? { createAgentOwnership: ownership } : {}),
    });
    await execution.run();
    assert.notEqual(instance.status, "closed");
    await execution.graph.close();
    assert.equal(disposals.count, 1);
    assert.equal(instance.status, "closed");
  });

for (const nested of [false, true])
  test(`graph ownership of an agent dominates its caller-owned registration (${nested ? "graph" : "caller"} registration reached first)`, async () => {
    const instance = mock("unused");
    const disposals = countDisposals(instance);
    const nodes = { A: { prompt: "work" } };
    const edges = [{ from: "A", to: "$sink" }];
    const execution = await build(
      parse({
        graph: nested
          ? {
              nodes: { Child: { kind: "graph", graph: { nodes, edges } } },
              edges: [{ from: "Child", to: "$sink" }],
            }
          : { nodes, edges },
      }),
      {
        ...options(),
        createAgent: async () => instance,
        createAgentOwnership: "caller",
      },
    );
    execution.graph.addNode({
      id: graph.NodeId.create("Owned"),
      trigger: trigger.TriggerRule.always(),
      policy: tools.LockPolicy,
      state: instance,
    });
    await execution.graph.close();
    assert.equal(disposals.count, 1);
    assert.equal(instance.status, "closed");
  });

test("createAgentOwnership requires createAgent", async () => {
  await assert.rejects(
    build(document(), { ...options(), createAgentOwnership: "caller" }),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message ===
        "junco-syntax: createAgentOwnership requires createAgent",
  );
});

for (const boundary of ["factory", "code", "availability"] as const)
  for (const ownership of [undefined, "caller"] as const)
    for (const cleanupFails of [false, true])
      test(`a later ${boundary} failure rolls back ${ownership ?? "default"}-ownership leases and deterministic state without disposing earlier factory agents${cleanupFails ? ", cleanup failure after the primary" : ""}`, async () => {
        const primary = new Error(`${boundary} sentinel`);
        const cleanup = new Error("deterministic close sentinel");
        const { collection, active } = countedCollection();
        const earlier = mock("unused");
        const disposals = countDisposals(earlier);
        let deterministic: Deterministic | undefined;
        const Code: DeterministicNode = ({ policy, collection }) => {
          deterministic = new Deterministic<AgenticInput, AssistantMessage>(
            async function* () {
              yield [];
              return assistant("code");
            },
            policy,
            collection,
          );
          const close = deterministic.close.bind(deterministic);
          deterministic.close = () =>
            close().then(() => {
              if (cleanupFails) throw cleanup;
            });
          return { state: deterministic };
        };
        try {
          await assert.rejects(
            build(
              parse({
                graph: {
                  nodes: {
                    Child: {
                      kind: "graph",
                      graph: {
                        nodes: {
                          A: {},
                          Code: { kind: "code", trigger: "always" },
                        },
                        edges: [{ from: "A", to: "$sink" }],
                      },
                    },
                    Last:
                      boundary === "code"
                        ? { kind: "code", trigger: "always" }
                        : {},
                  },
                  edges: [{ from: "Child", to: "$sink" }],
                },
              }),
              {
                ...options(),
                collection,
                code: {
                  Code,
                  Last: () => {
                    throw primary;
                  },
                },
                createAgent: async (spec) => {
                  if (spec.node === "Last") throw primary;
                  return earlier;
                },
                ...(ownership ? { createAgentOwnership: ownership } : {}),
                ...(boundary === "availability"
                  ? {
                      available: {
                        Last: () => {
                          throw primary;
                        },
                      },
                    }
                  : {}),
              },
            ),
            (error) => {
              if (!cleanupFails) assert.equal(error, primary);
              else {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors, [primary, cleanup]);
              }
              return true;
            },
          );
          assert.equal(deterministic?.signal.aborted, true);
          assert.equal(active.leases, 0, "graph and deterministic leases");
          assert.equal(disposals.count, 0);
          assert.equal(aborts(earlier), 1);
          assert.notEqual(earlier.status, "closed");
        } finally {
          await earlier.return();
          await collection.close();
        }
      });
