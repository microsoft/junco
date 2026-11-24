import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  type JsonObject,
  type Tool,
} from "@earendil-works/pi-ai";
import { captureUsageContext } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import {
  agent,
  Deterministic,
  graph,
  JuncoGraph,
  schedules,
  type Task,
  tools,
  tracer,
  workflows,
} from "junco";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { renderTask } from "../src/agent-node.ts";
import {
  build,
  type CodeContext,
  type DeterministicNode,
  type JuncoArgs,
  type JuncoParameters,
  resolveAgents,
} from "../src/syntax/build.ts";
import { ValidationError } from "../src/syntax/errors.ts";
import { parse } from "../src/syntax/parse.ts";
import type { JuncoDocument } from "../src/syntax/schema.ts";
import { assistant, userTexts } from "./deterministic-support.ts";
import {
  copyTreeNative,
  countedCollection,
  fauxRuntime,
  NATIVE_TOOL_BLOCK,
  offlineLadder,
} from "./support.ts";
import {
  Collect,
  Constant,
  Emitter,
  Forward,
  Increment,
  Relay,
} from "./syntax-code-nodes.fixture.ts";

const asTask = (text: string, taskId: string) =>
  renderTask({ kind: "prompt", text, taskId, spec: "", deps: [], history: [] });

/** Edge schemas: chat inputs (Task) and native assistant results. */
const prompt = {
  anyOf: [
    {
      type: "object",
      required: ["kind", "text"],
      properties: {
        kind: { enum: ["prompt", "steer", "followUp", "nextTurn", "error"] },
        text: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["kind", "message"],
      properties: {
        kind: { const: "appendMessage" },
        message: {
          type: "object",
          required: ["role"],
          properties: { role: { type: "string" } },
        },
      },
    },
  ],
};
const reply = {
  type: "object",
  required: ["role", "content", "stopReason"],
  properties: {
    role: { const: "assistant" },
    content: { type: "array" },
    stopReason: { type: "string" },
  },
};
/** A single role's model responses and the actual requests that consumed them. */
type RoleScript = { requests: Context[]; respond: FauxResponseFactory };
function script(...steps: (string | FauxResponseStep)[]): RoleScript {
  const requests: Context[] = [];
  const respond: FauxResponseFactory = (...args) => {
    const step = steps[requests.length];
    requests.push(structuredClone(args[0]));
    assert.notEqual(step, undefined, "unexpected extra model request");
    return typeof step === "function"
      ? step(...args)
      : typeof step === "string"
        ? fauxAssistantMessage(step)
        : step!;
  };
  return { requests, respond };
}

const requestTexts = (requests: readonly Context[]) =>
  requests.map(({ messages }) => userTexts(messages));
const lastPrompts = ({ requests }: RoleScript) =>
  requestTexts(requests).map((texts) => texts.at(-1));

type Overrides = {
  args?: Partial<JuncoArgs>;
  parameters?: Partial<JuncoParameters>;
};

async function offline(
  roles: Record<string, RoleScript>,
  overrides: Overrides = {},
) {
  // A short scripted "length" turn really reached its output cap, not the context window.
  const ladder = await offlineLadder(
    (...args) => {
      const path = captureUsageContext()?.nodePath.join("/");
      assert.ok(
        path && Object.hasOwn(roles, path),
        `unexpected model request from ${path}`,
      );
      return roles[path]!.respond(...args);
    },
    { id: "faux-1", maxTokens: 1 },
  );
  const defaults = options();
  return {
    args: {
      ...defaults.args,
      collection: countedCollection().collection,
      agentOptions: new Map(
        Object.keys(roles).map((path) => [
          graph.NodeId.create(path),
          {
            steeringMode: "all" as const,
            retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
          },
        ]),
      ),
      ...overrides.args,
    },
    parameters: { ...defaults.parameters, ladder, ...overrides.parameters },
  };
}
const document = () =>
  parse({
    graph: {
      nodes: {
        Start: { kind: "emit", text: "go", spec: "done" },
        Inner: {
          kind: "graph",
          trigger: "Start~>Inner",
          graph: {
            source: { routes: { "Start~>Inner": ["$source~>Worker"] } },
            nodes: { Worker: { prompt: "work", trigger: "$source~>Worker" } },
            edges: [
              {
                from: "$source",
                to: "Worker",
                kind: "message",
                schema: prompt,
              },
              { from: "Worker", to: "$sink", schema: reply },
            ],
          },
        },
        Final: {
          trigger: "Inner->Final",
          prompt: "got: {{Inner->Final}}",
        },
      },
      edges: [
        { from: "Start", to: "Inner", kind: "message", schema: prompt },
        {
          from: "Inner",
          to: "Final",
          id: "Inner->Final",
          kind: "message",
          on: "return",
          schema: reply,
        },
        { from: "Final", to: "$sink", schema: reply },
      ],
    },
  });
const options = ({ args, parameters }: Overrides = {}) => ({
  args: { cwd: process.cwd(), tracer: new tracer.DummyTracer(), ...args },
  parameters: { scheduler: () => schedules.parallel(), ...parameters },
});
const fauxLadder = schedules.uniformLadder({ model: "faux/faux-1" });

for (const repeat of [0, 1, 2, undefined]) {
  test(`YAML repeat=${repeat} limits prompt runs, not model turns`, async () => {
    const role = script(
      fauxAssistantMessage(
        [fauxToolCall("yield", { reason: "continue this run" })],
        { stopReason: "toolUse" },
      ),
      "first",
      "second",
    );
    const config = await offline({ A: role });
    const execution = await JuncoGraph.fromYaml(
      `graph:
  nodes:
    Seed: {kind: emit, text: Begin, spec: Done}
    A:
      prompt: Generate a unit test
      trigger: always
      ${repeat === undefined ? "" : `repeat: ${repeat}`}
  sink: {stream: true, trigger: never}
  edges:
    - {from: Seed, to: A, kind: message, schema: {}}
    - {from: A, to: A, schema: {}}
    - {from: A, to: $sink, kind: message, on: return, id: product, schema: {}}
`,
      config,
    );
    const g = execution.graph;
    const seedId = graph.NodeId.create("Seed");
    const products = () =>
      g
        .observe()
        .inputs.get(g.sink.id)!
        .messages.get(graph.EdgeId.create("product")) ?? [];
    const expected = repeat ?? 2;
    try {
      await stepUntil(
        execution,
        () => products().length >= expected && !g.available().has(seedId),
      );
      assert.deepEqual(
        products().map((x) => contentText((x as AssistantMessage).content)),
        ["first", "second"].slice(0, expected),
      );
      assert.equal(
        g.available().has(graph.NodeId.create("A")),
        repeat === undefined,
      );
      if (repeat !== undefined) await execution.run();
      assert.equal(role.requests.length, expected === 0 ? 0 : expected + 1);
    } finally {
      await g.close();
      await config.args.collection.close();
    }
  });
}

test("YAML repeat lets a code node finish its last continuation", async () => {
  let calls = 0;
  const execution = await JuncoGraph.fromYaml(
    {
      graph: {
        nodes: { Work: { kind: "code", trigger: "always", repeat: 2 } },
        sink: { stream: true },
        edges: [
          {
            from: "Work",
            to: "$sink",
            id: "out",
            kind: "message",
            schema: { type: "string" },
          },
        ],
      },
    },
    options({
      args: {
        code: {
          Work: ({ edges, policy }) =>
            new Deterministic<TSchema, unknown>(async function* () {
              const out = edges.get("out")!;
              yield [];
              while (true) {
                calls++;
                yield { resume: [graph.Message.create(out, `start ${calls}`)] };
                yield [graph.Message.create(out, `finish ${calls}`)];
              }
            }, policy),
        },
      },
    }),
  );
  try {
    for (let i = 0; i < 12 && execution.graph.available().size; i++)
      await execution.step();
    assert.equal(execution.graph.available().size, 0);
    const delivered: unknown[] = [];
    execution.graph.sink.drain((m) => delivered.push(m.payload));
    assert.deepEqual(delivered, ["start 1", "finish 1", "start 2", "finish 2"]);
  } finally {
    await execution.graph.close();
  }
});

test("YAML repeat rejects non-counts at validation", () => {
  for (const repeat of [-1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        parse({
          graph: {
            nodes: { A: { prompt: "Work", repeat } },
            edges: [{ from: "A", to: "$sink", schema: {} }],
          },
        }),
      ValidationError,
    );
});

test("an agent present only in a nested graph still requires a ladder", async () => {
  const child = roundDoc("nested").graph;
  const doc = parse({
    graph: {
      nodes: { Child: { kind: "graph", graph: child } },
      edges: [{ from: "Child", to: "$sink", schema: reply }],
    },
  });
  await assert.rejects(
    build(doc, options()),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message === "junco-syntax: a ladder is required for agent nodes",
  );
});

test("ModelLadder rejects rungs outside the runtime's catalog", async () => {
  const { models } = await fauxRuntime([], "p", [
    { id: "s", reasoning: true },
    { id: "n" },
  ]);
  const base = schedules.uniformLadder({ model: "p/s" });
  const rejects = (high: unknown, message: string) =>
    assert.throws(
      () =>
        new schedules.ModelLadder(models, {
          ...base,
          high,
        } as unknown as schedules.Ladder),
      (error) =>
        error instanceof graph.DataflowDefinitionError &&
        error.message === message,
    );
  rejects({ model: "nope" }, 'ladder.high.model must be "provider/model-id"');
  rejects(undefined, 'ladder.high.model must be "provider/model-id"');
  rejects(
    { model: "p/missing" },
    "ladder.high.model p/missing is not in the model catalog",
  );
  rejects(
    { model: "p/n", thinking: "high" },
    "ladder.high.thinking high is not supported by p/n (supported: off)",
  );
  const ladder = new schedules.ModelLadder(models, {
    ...base,
    high: { model: "p/s", thinking: "high" },
  });
  assert.equal(ladder.models, models);
  assert.equal(ladder.rungs.high.thinking, "high");
});

test("decision strength switches each selected agent's model and thinking", async () => {
  const calls: [string, string, unknown][] = [];
  const respond: FauxResponseFactory = (_ctx, options, _state, model) => {
    const path = captureUsageContext()?.nodePath.join("/") ?? "";
    calls.push([path, model.id, options?.reasoning]);
    return fauxAssistantMessage(path === "Final" ? "FINAL-OUT" : "WORKER-OUT");
  };
  const { models } = await fauxRuntime(
    [respond, respond],
    "p",
    ["s", "l", "m", "h", "x"].map((id) => ({ id, reasoning: true })),
  );
  const execution = await build(
    document(),
    options({
      args: { collection: countedCollection().collection },
      parameters: {
        ladder: new schedules.ModelLadder(models, {
          smol: { model: "p/s", thinking: "low" },
          low: { model: "p/l" },
          med: { model: "p/m" },
          high: { model: "p/h", thinking: "high" },
          xhigh: { model: "p/x" },
        }),
        scheduler: () =>
          schedules.strength(
            (_, id) => (id === "Final" ? "high" : "smol"),
            schedules.parallel(),
          ),
      },
    }),
  );
  try {
    await execution.run();
    assert.equal(resultText(execution.graph), "FINAL-OUT");
    assert.deepEqual(calls, [
      ["Inner/Worker", "s", "low"],
      ["Final", "h", "high"],
    ]);
  } finally {
    await execution.graph.close();
  }
});

test("fromYaml substitutes text params and runs the workflow", async () => {
  const source = `graph:
  nodes:
    Start: { kind: emit, text: begin, spec: done }
    A:
      description: "{{ params.greeting }}"
      prompt: work
  edges:
    - { from: Start, to: A, kind: message, schema: { type: object } }
    - from: A
      to: $sink
      schema: { type: object, required: [role], properties: { role: { const: assistant } } }
`;
  const instance = script("done");
  const execution = await JuncoGraph.fromYaml(
    source,
    await offline(
      { A: instance },
      {
        args: { params: { greeting: "hi" } },
      },
    ),
  );
  try {
    assert.equal(
      execution.graph.getNode(graph.NodeId.create("A"))?.description,
      "hi",
    );
    await execution.run();
    assert.equal(requestTexts(instance.requests)[0]?.[0], "work");
    assert.equal(resultText(execution.graph), "done");
  } finally {
    await execution.graph.close();
  }
});

test("fromYaml accepts a parsed document and runs nested agents", async () => {
  const execution = await JuncoGraph.fromYaml(
    document(),
    await offline({ "Inner/Worker": script("Worker"), Final: script("Final") }),
  );
  try {
    await execution.run();
    assert.equal(resultText(execution.graph), "Final");
  } finally {
    await execution.graph.close();
  }
});

async function countedSession(failure?: Error) {
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  const close = session.close.bind(session);
  const contexts: (typeof BACKGROUND_CONTEXT)[] = [];
  session.close = async (context) => {
    contexts.push(context);
    await close(context);
    if (failure) throw failure;
  };
  return { session, contexts };
}

test("fromYaml releases transferred sessions when parsing fails, preserving clean-up failures", async () => {
  const failure = new Error("session close failed");
  const a = await countedSession(failure),
    b = await countedSession();
  await assert.rejects(
    JuncoGraph.fromYaml(
      "graph: [",
      options({
        args: {
          sourceName: "pipeline.yml",
          agentOptions: new Map([
            [graph.NodeId.create("A"), { session: a.session }],
            [graph.NodeId.create("B"), { session: b.session }],
          ]),
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors[0] instanceof ValidationError);
      assert.equal(error.errors[0].code, "yaml");
      assert.match(error.errors[0].message, /pipeline.yml:1:9/);
      assert.ok(error.errors.includes(failure));
      return true;
    },
  );
  assert.deepEqual(a.contexts, [BACKGROUND_CONTEXT]);
  assert.deepEqual(b.contexts, [BACKGROUND_CONTEXT]);
});

test("fromYaml rejects an invalid document before creating any agent", async () => {
  const { collection, events } = countedCollection();
  for (const [source, code] of [
    [
      "graph:\n  nodes: { A: { prompt: work } }\n  edges: [{ from: A, to: $sink }]\n",
      "edge-schema",
    ],
    [
      "graph:\n  nodes: { A: { prompt: work } }\n  edges: [{ from: A, to: Nope, schema: {} }]\n",
      "reference",
    ],
  ])
    await assert.rejects(
      JuncoGraph.fromYaml(source, options({ args: { collection } })),
      (error) => error instanceof ValidationError && error.code === code,
    );
  assert.deepEqual(events, []);
});

test("nested agent rejects a blank prompt before acquisition", async () => {
  const child = {
    nodes: { A: { system: "Not a prompt", prompt: " \t " } },
    edges: [{ from: "A", to: "$sink", schema: reply }],
  };
  const source = JSON.stringify({
    graph: {
      nodes: { Child: { kind: "graph", graph: child } },
      edges: [{ from: "Child", to: "$sink", schema: reply }],
    },
  });
  await assert.rejects(
    JuncoGraph.fromYaml(source, options()),
    (error) =>
      error instanceof ValidationError &&
      error.path === "/graph/nodes/Child/graph/nodes/A/prompt",
  );
});

/** Reads a settled result's text, failing the test when `id` has none. */
function resultText(
  g: Pick<graph.JuncoGraph<TSchema, unknown>, "result" | "sink">,
  id: graph.NodeIdType = g.sink.id,
): string {
  const result = g.result(id);
  if (result._tag !== "Some") assert.fail(`${id} has no result`);
  assert.ok(Value.Check(agent.AssistantMessageSchema, result.value));
  return contentText(result.value.content);
}
const enqueuePrompts = (
  execution: Awaited<ReturnType<typeof build>>,
  id: string,
  ...payloads: Task[]
) =>
  execution.graph.source.enqueue({
    messages: new Map([[graph.EdgeId.create(id), payloads]]),
    values: new Map(),
  });
const nodeFailure = (message: RegExp) => (error: unknown) =>
  error instanceof graph.DataflowNodeError &&
  message.test((error.error as Error).message);

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
          A: { prompt: "work", system: "Base", skills: ["guide"] },
          B: { prompt: "work", skills: ["guide"] },
        },
        edges: [
          { from: "A", to: "B", schema: reply },
          { from: "B", to: "$sink", schema: reply },
        ],
      },
    });
    const [spec, other] = await resolveAgents(doc, { cwd });
    assert.ok(spec && other);
    assert.equal(spec.skills[0], other.skills[0]);
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
        First: { prompt: "work" },
        Child: {
          kind: "graph",
          graph: {
            name: "child-label",
            source: { routes: { "First->Child": [] } },
            nodes: {
              Before: { prompt: "work" },
              Grandchild: {
                kind: "graph",
                graph: {
                  source: { routes: { "Before->Grandchild": [] } },
                  nodes: { Deep: { prompt: "work" } },
                  edges: [{ from: "Deep", to: "$sink", schema: reply }],
                },
              },
              After: { prompt: "work" },
            },
            sink: { returns: "After" },
            edges: [
              { from: "Before", to: "Grandchild", schema: reply },
              { from: "Grandchild", to: "After", schema: reply },
              { from: "After", to: "$sink", schema: reply },
            ],
          },
        },
        Last: { prompt: "work" },
      },
      edges: [
        { from: "First", to: "Child", schema: reply },
        { from: "Child", to: "Last", schema: reply },
        { from: "Last", to: "$sink", schema: reply },
      ],
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
        nodes: { A: { prompt: "work" } },
        edges: [{ from: "A", to: "$sink", schema: reply }],
      },
    }),
    { cwd: process.cwd() },
  );
  assert.equal(unnamed[0]?.graph, "graph");
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
            A: { prompt: "work", skills: ["guide", "alias"] },
            B: { prompt: "work", skills: ["alias", "guide"] },
          },
          edges: [
            { from: "A", to: "B", schema: reply },
            { from: "B", to: "$sink", schema: reply },
          ],
        },
      }),
      { cwd },
    );
    const [a, b] = specs;
    assert.ok(a && b);
    assert.equal(a.skills[0], b.skills[1]);
    assert.equal(a.skills[1], b.skills[0]);
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
              nodes: { A: { prompt: "work", skills: ["invalid"] } },
              edges: [{ from: "A", to: "$sink", schema: reply }],
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

test("nested message ingress and final egress stage the owning agent's prompt", async () => {
  const final = script("FINAL-OUT");
  const execution = await build(
    document(),
    await offline({ "Inner/Worker": script("WORKER-OUT"), Final: final }),
  );
  try {
    await execution.run();
    assert.equal(resultText(execution.graph), "FINAL-OUT");
    assert.deepEqual(lastPrompts(final), ["got: WORKER-OUT"]);
  } finally {
    await execution.graph.close();
  }
});

test("a promptless YAML member can be staged by its controller", async () => {
  const a = script("manually staged");
  const doc = roundDoc("remove me");
  doc.graph.nodes.A = {};
  const execution = await build(doc, await offline({ A: a }));
  try {
    const instance = execution.graph.getNode(graph.NodeId.create("A"))!.state;
    assert.ok(instance instanceof agent.JuncoAgent);
    instance.stagePrompt("controller instruction");
    await execution.run();
    assert.equal(requestTexts(a.requests)[0]?.[0], "controller instruction");
    assert.equal(resultText(execution.graph), "manually staged");
  } finally {
    await execution.graph.close();
  }
});

const ralphDoc = () => parse(workflows.ralph);
const ralphAgent = ralphDoc().graph.nodes.Ralph;
assert.ok(ralphAgent && "prompt" in ralphAgent);
const workMessage = (
  phase: "revise" | "retry",
  round: number,
  objectives = ["assignment"],
) =>
  JSON.stringify({
    id: "RalphControl~>Ralph",
    payload: { phase, round, objectives },
  });

test("Ralph runs its YAML prompt once per round and publishes only the last", async () => {
  const instance = script("draft-1", "draft-2", "draft-3");
  const execution = await build(
    ralphDoc(),
    await offline(
      { Ralph: instance },
      { args: schedules.ralph({ rounds: 3 }) },
    ),
  );
  try {
    enqueuePrompts(execution, "assignment", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    await execution.run();
    assert.deepEqual(lastPrompts(instance), [
      asTask("assignment", "Ralph#1"),
      workMessage("revise", 2),
      workMessage("revise", 3),
    ]);
    assert.deepEqual(requestTexts(instance.requests)[0], [
      ralphAgent.prompt,
      asTask("assignment", "Ralph#1"),
    ]);
    for (const texts of requestTexts(instance.requests))
      assert.equal(texts.at(-2), ralphAgent.prompt);
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
  const instance = script("draft-1", "draft-2", "draft-3");
  const execution = await build(
    ralphDoc(),
    await offline({ Ralph: instance }, { args: schedules.ralph() }),
  );
  try {
    enqueuePrompts(execution, "assignment", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    for (let step = 0; instance.requests.length === 0 && step < 100; step++)
      await execution.step();
    assert.deepEqual(lastPrompts(instance), [asTask("assignment", "Ralph#1")]);
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "None");
    await execution.run();
    assert.deepEqual(lastPrompts(instance), [
      asTask("assignment", "Ralph#1"),
      workMessage("revise", 2),
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
    const instance = script(assistant("draft-1"), draft, assistant("draft-3"));
    const execution = await build(
      ralphDoc(),
      await offline(
        { Ralph: instance },
        { args: schedules.ralph({ rounds: 3 }) },
      ),
    );
    try {
      enqueuePrompts(execution, "assignment", {
        kind: "prompt",
        text: "assignment",
        taskId: "Ralph#1",
        spec: "",
        deps: [],
        history: [],
      });
      await assert.rejects(execution.run(), { message: error });
      assert.equal(
        execution.graph.result(execution.graph.sink.id)._tag,
        "None",
      );
      assert.deepEqual(lastPrompts(instance), [
        asTask("assignment", "Ralph#1"),
        workMessage("revise", 2),
      ]);
    } finally {
      await execution.graph.close();
    }
  });

for (const [name, payloads] of [
  [
    "followUp",
    [
      {
        kind: "followUp",
        text: "assignment",
        taskId: "Ralph#1",
        spec: "",
        deps: [],
        history: [],
      },
    ],
  ],
  [
    "images",
    [
      {
        kind: "prompt",
        text: "assignment",
        taskId: "Ralph#1",
        spec: "",
        deps: [],
        history: [],
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      },
    ],
  ],
] satisfies readonly (readonly [string, Task[]])[])
  test(`Ralph assignment admission rejects ${name}`, async () => {
    const instance = script();
    const execution = await build(
      ralphDoc(),
      await offline({ Ralph: instance }, { args: schedules.ralph() }),
    );
    try {
      enqueuePrompts(execution, "assignment", ...payloads);
      await assert.rejects(execution.run(), {
        message: /^Ralph requires one or more prompt objectives$/,
      });
      assert.equal(instance.requests.length, 0);
      assert.equal(
        execution.graph.result(execution.graph.sink.id)._tag,
        "None",
      );
    } finally {
      await execution.graph.close();
    }
  });

test("several prompts on the assignment route are ordered objectives in every round and the check", async () => {
  const instance = script("draft-1", "draft-2");
  const judged: (readonly string[])[] = [];
  const execution = await build(
    ralphDoc(),
    await offline(
      { Ralph: instance },
      {
        args: schedules.ralph({
          until: (_result, { objectives, round }) => {
            judged.push(objectives);
            return round === 2;
          },
        }),
      },
    ),
  );
  try {
    enqueuePrompts(
      execution,
      "assignment",
      {
        kind: "prompt",
        text: "first goal",
        taskId: "Ralph#1",
        spec: "",
        deps: [],
        history: [],
      },
      {
        kind: "prompt",
        text: "second goal",
        taskId: "Ralph#2",
        spec: "",
        deps: [],
        history: [],
      },
    );
    await execution.run();
    assert.deepEqual(requestTexts(instance.requests)[0], [
      ralphAgent.prompt,
      asTask("first goal", "Ralph#1"),
      asTask("second goal", "Ralph#2"),
    ]);
    assert.deepEqual(lastPrompts(instance).slice(1), [
      workMessage("revise", 2, ["first goal", "second goal"]),
    ]);
    assert.deepEqual(judged, [
      ["first goal", "second goal"],
      ["first goal", "second goal"],
    ]);
    assert.equal(resultText(execution.graph), "draft-2");
  } finally {
    await execution.graph.close();
  }
});

test("a provider-error result re-runs the round up to retries times", async () => {
  const instance = script(assistant("refused", "error"), "draft-1", "draft-2");
  const execution = await build(
    ralphDoc(),
    await offline(
      { Ralph: instance },
      { args: schedules.ralph({ retries: 1 }) },
    ),
  );
  try {
    enqueuePrompts(execution, "assignment", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    await execution.run();
    assert.deepEqual(lastPrompts(instance), [
      asTask("assignment", "Ralph#1"),
      workMessage("retry", 1),
      workMessage("revise", 2),
    ]);
    assert.equal(resultText(execution.graph), "draft-2");
    assert.equal(execution.graph.available().size, 0);
  } finally {
    await execution.graph.close();
  }
});

test("an exhausted provider error cannot start a normal revision", async () => {
  const instance = script(
    assistant("refused", "error"),
    assistant("refused again", "error"),
    "draft-1",
  );
  const execution = await build(
    ralphDoc(),
    await offline(
      { Ralph: instance },
      { args: schedules.ralph({ retries: 1 }) },
    ),
  );
  try {
    enqueuePrompts(execution, "assignment", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    await assert.rejects(execution.run(), {
      message: /did not finish normally: error/,
    });
  } finally {
    await execution.graph.close();
  }
});

test("a fixed final round publishes its raw provider error after exhausting retries", async () => {
  const failure = assistant("refused", "error");
  const instance = script(failure, failure);
  const execution = await build(
    ralphDoc(),
    await offline(
      { Ralph: instance },
      { args: schedules.ralph({ rounds: 1, retries: 1 }) },
    ),
  );
  try {
    enqueuePrompts(execution, "assignment", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    const results = await execution.run();
    const published = results.get(execution.graph.sink.id);
    assert.ok(Value.Check(agent.AssistantMessageSchema, published));
    assert.equal(published.stopReason, "error");
    assert.equal(published, results.get(graph.NodeId.create("Ralph")));
    assert.deepEqual(lastPrompts(instance), [
      asTask("assignment", "Ralph#1"),
      workMessage("retry", 1),
    ]);
  } finally {
    await execution.graph.close();
  }
});

test("ralph rejects invalid options before building", () => {
  for (const rounds of [0, -1, 1.5, NaN, Infinity, 2 ** 53])
    for (const until of [undefined, () => true])
      assert.throws(() => schedules.ralph({ rounds, until }), {
        name: "RangeError",
        message: "Ralph rounds must be a positive safe integer",
      });
  for (const retries of [-1, 1.5, NaN, Infinity, 2 ** 53])
    assert.throws(() => schedules.ralph({ retries }), {
      name: "RangeError",
      message: "Ralph retries must be a non-negative safe integer",
    });
  assert.throws(
    () =>
      schedules.ralph({ until: true as unknown as schedules.RalphPredicate }),
    { name: "TypeError", message: "Ralph until must be a function" },
  );
});

type RalphCall = {
  readonly text: string;
  readonly objectives: readonly string[];
  readonly round: number;
  readonly label: string;
  readonly published: boolean;
};
/** `ralphDoc()` in success mode, recording each `until` call and whether $sink had published by then. */
async function untilRalph(
  drafts: readonly AssistantMessage[],
  decide: (text: string) => unknown,
  rounds?: number,
) {
  const instance = script(...drafts);
  const calls: RalphCall[] = [];
  const execution = await build(
    ralphDoc(),
    await offline(
      { Ralph: instance },
      {
        args: schedules.ralph({
          rounds,
          until: (result, context) => {
            const text = contentText(result.content);
            calls.push({
              text,
              ...context,
              published: O.isSome(
                execution.graph.result(execution.graph.sink.id),
              ),
            });
            return decide(text) as boolean;
          },
        }),
      },
    ),
  );
  enqueuePrompts(execution, "assignment", {
    kind: "prompt",
    text: "assignment",
    taskId: "Ralph#1",
    spec: "",
    deps: [],
    history: [],
  });
  return { execution, instance, calls };
}
const ralphCall = (round: number): RalphCall => ({
  text: `draft-${round}`,
  objectives: ["assignment"],
  round,
  label: "Ralph",
  published: false,
});
const NO_REJECTION = Symbol("no rejection");
/** The rejection value of `run`, which may be falsy; `NO_REJECTION` when it resolves. */
async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return NO_REJECTION;
  } catch (error) {
    return error;
  }
}

test("until runs uncapped rounds and publishes only the accepted draft", async () => {
  const { execution, instance, calls } = await untilRalph(
    ["draft-1", "draft-2", "draft-3", "unreachable"].map((text) =>
      assistant(text),
    ),
    (text) => text === "draft-3",
  );
  try {
    await execution.run();
    assert.deepEqual(calls, [1, 2, 3].map(ralphCall));
    assert.deepEqual(lastPrompts(instance), [
      asTask("assignment", "Ralph#1"),
      workMessage("revise", 2),
      workMessage("revise", 3),
    ]);
    assert.equal(resultText(execution.graph), "draft-3");
    assert.equal(execution.graph.available().size, 0);
    await execution.run();
    assert.equal(calls.length, 3);
  } finally {
    await execution.graph.close();
  }
});

test("Ralph judges identical settlements separately before admitting a queued second assignment", async () => {
  const draft = assistant("same");
  let decisions = 0;
  const { execution, instance, calls } = await untilRalph(
    [draft, draft],
    () => ++decisions === 2,
  );
  const second: Task = {
    kind: "prompt",
    text: "too late",
    taskId: "Ralph#2",
    spec: "",
    deps: [],
    history: [],
  };
  try {
    enqueuePrompts(execution, "assignment", second);
    for (let i = 0; instance.requests.length < 2 && i < 100; i++)
      await execution.step();
    assert.equal(instance.requests.length, 2);
    assert.equal(decisions, 1);
    assert.equal(
      execution.graph.source
        .peek()
        ?.messages.get(graph.EdgeId.create("assignment"))?.[0],
      second,
    );
    execution.graph.available();
    execution.graph.available();
    assert.equal(decisions, 1);
    await assert.rejects(
      execution.run(),
      /Ralph accepts only one assignment batch/,
    );
    assert.deepEqual(
      calls.map(({ round, text }) => [round, text]),
      [
        [1, "same"],
        [2, "same"],
      ],
    );
    assert.equal(instance.requests.length, 2);
  } finally {
    await execution.graph.close();
  }
});

test("until accepting the first draft never revises", async () => {
  const { execution, instance, calls } = await untilRalph(
    [assistant("draft-1"), assistant("unreachable")],
    () => true,
  );
  try {
    await execution.run();
    assert.deepEqual(calls, [ralphCall(1)]);
    assert.deepEqual(lastPrompts(instance), [asTask("assignment", "Ralph#1")]);
    assert.equal(resultText(execution.graph), "draft-1");
  } finally {
    await execution.graph.close();
  }
});

test("until with explicit rounds fails at the cap unless that round succeeds", async () => {
  const drafts = ["draft-1", "draft-2", "unreachable"].map((text) =>
    assistant(text),
  );
  const failing = await untilRalph(drafts, () => false, 2);
  try {
    const error = await rejection(failing.execution.run());
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof graph.DataflowNodeError));
    assert.equal(
      error.message,
      "Ralph reached the round limit without success",
    );
    assert.deepEqual(failing.calls, [1, 2].map(ralphCall));
    assert.equal(failing.instance.requests.length, 2);
    assert.ok(
      O.isNone(failing.execution.graph.result(failing.execution.graph.sink.id)),
    );
  } finally {
    await failing.execution.graph.close();
  }
  const succeeding = await untilRalph(drafts, (text) => text === "draft-2", 2);
  try {
    await succeeding.execution.run();
    assert.deepEqual(succeeding.calls, [1, 2].map(ralphCall));
    assert.equal(resultText(succeeding.execution.graph), "draft-2");
  } finally {
    await succeeding.execution.graph.close();
  }
});

for (const [name, draft, message] of [
  ["blank", assistant("   "), "Ralph produced an empty report"],
  [
    "length",
    { ...assistant("truncated"), stopReason: "length" as const },
    "Ralph did not finish normally: length",
  ],
] as const)
  test(`until never sees an invalid draft (${name})`, async () => {
    const { execution, instance, calls } = await untilRalph(
      [draft, assistant("unreachable")],
      () => true,
    );
    try {
      const error = await rejection(execution.run());
      assert.ok(error instanceof Error);
      assert.equal(error.message, message);
      assert.equal(calls.length, 0);
      assert.equal(instance.requests.length, 1);
      assert.ok(O.isNone(execution.graph.result(execution.graph.sink.id)));
    } finally {
      await execution.graph.close();
    }
  });

for (const [name, decide, expected] of [
  [
    "throws a falsy value",
    () => {
      throw undefined;
    },
    (error: unknown) => error === undefined,
  ],
  [
    "returns a non-boolean",
    () => "yes",
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "Ralph until must return a boolean",
  ],
  [
    "returns a Promise",
    async () => true,
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "Ralph until must return a boolean",
  ],
] as const)
  test(`an until that ${name} fails Ralph once and the failure is cached`, async () => {
    const { execution, instance, calls } = await untilRalph(
      [assistant("draft-1"), assistant("unreachable")],
      decide,
    );
    try {
      const error = await rejection(execution.run());
      assert.ok(expected(error));
      assert.doesNotThrow(() => execution.graph.available());
      assert.equal(await rejection(execution.run()), error);
      assert.equal(calls.length, 1);
      assert.equal(instance.requests.length, 1);
      assert.ok(O.isNone(execution.graph.result(execution.graph.sink.id)));
    } finally {
      await execution.graph.close();
    }
  });

test("nested Ralph levels sharing one controller succeed independently", async () => {
  const nested = (name: string) => {
    const inner = ralphDoc().graph;
    return {
      ...inner,
      name,
      source: {
        ...inner.source,
        routes: { [`$source~>${name}`]: ["$source~>Ralph"] },
      },
    };
  };
  const final = script("final reply");
  const calls: string[] = [];
  const execution = await build(
    parse({
      graph: {
        source: { routes: { seed: ["$source~>Left", "$source~>Right"] } },
        nodes: {
          Left: { kind: "graph", graph: nested("Left") },
          Right: { kind: "graph", graph: nested("Right") },
          Final: {
            trigger: { all: ["Left->Final", "Right->Final"] },
            prompt: "{{ Left->Final }} | {{ Right->Final }}",
          },
        },
        edges: [
          { from: "$source", to: "Left", kind: "message", schema: prompt },
          { from: "$source", to: "Right", kind: "message", schema: prompt },
          ...["Left", "Right"].map((from) => ({
            from,
            to: "Final",
            id: `${from}->Final`,
            kind: "message",
            on: "return",
            schema: reply,
          })),
          { from: "Final", to: "$sink", schema: reply },
        ],
      },
    }),
    await offline(
      {
        "Left/Ralph": script("Left-1", "Left-2", "Left-3"),
        "Right/Ralph": script("Right-1", "Right-2"),
        Final: final,
      },
      {
        args: schedules.ralph({
          until: (result, { round, label }) => {
            calls.push(`${label}:${round}:${contentText(result.content)}`);
            return round === (label === "Left" ? 3 : 2);
          },
        }),
      },
    ),
  );
  try {
    enqueuePrompts(execution, "seed", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    await execution.run();
    assert.deepEqual(calls.sort(), [
      "Left:1:Left-1",
      "Left:2:Left-2",
      "Left:3:Left-3",
      "Right:1:Right-1",
      "Right:2:Right-2",
    ]);
    assert.deepEqual(lastPrompts(final), ["Left-3 | Right-2"]);
    assert.equal(resultText(execution.graph), "final reply");
  } finally {
    await execution.graph.close();
  }
});

test("same-named sibling and deep wrappers bind agents and strengths by unique path", async () => {
  // Every wrapper is labelled "Team" and every leaf is local `Worker`: only paths tell them apart.
  const team = (route: string, inner?: object) => ({
    name: "Team",
    source: {
      routes: { [route]: [inner ? "$source~>Inner" : "$source~>Worker"] },
    },
    nodes: inner
      ? {
          Inner: {
            kind: "graph" as const,
            trigger: "$source~>Inner",
            graph: inner,
          },
        }
      : { Worker: { trigger: "$source~>Worker", prompt: "work" } },
    edges: [
      {
        from: "$source",
        to: inner ? "Inner" : "Worker",
        kind: "message" as const,
        schema: prompt,
      },
      { from: inner ? "Inner" : "Worker", to: "$sink", schema: reply },
    ],
  });
  const rungs: Record<string, schedules.ModelStrengthName> = {
    "Left/Worker": "smol",
    "Right/Worker": "high",
    "Deep/Inner/Worker": "low",
    Final: "xhigh",
  };
  const calls = new Map<
    string,
    { model: string; prompt: string | undefined }
  >();
  const respond: FauxResponseFactory = (context, _options, _state, model) => {
    const path = captureUsageContext()?.nodePath.join("/");
    assert.ok(
      path && Object.hasOwn(rungs, path),
      `unexpected request from ${path}`,
    );
    calls.set(path, {
      model: model.id,
      prompt: userTexts(context.messages).at(-1),
    });
    return fauxAssistantMessage(`report:${path}`);
  };
  const levels: [string, string][] = [];
  const { models } = await fauxRuntime(
    Object.keys(rungs).map(() => respond),
    "p",
    ["s", "l", "m", "h", "x"].map((id) => ({ id, reasoning: true })),
  );
  const { recorder, probes } = probeRecorder();
  const execution = await build(
    parse({
      graph: {
        name: "Team",
        source: {
          routes: {
            seed: ["$source~>Left", "$source~>Right", "$source~>Deep"],
          },
        },
        nodes: {
          Left: { kind: "graph", graph: team("$source~>Left") },
          Right: { kind: "graph", graph: team("$source~>Right") },
          Deep: {
            kind: "graph",
            graph: team("$source~>Deep", team("$source~>Inner")),
          },
          Final: {
            trigger: { all: ["Left->Final", "Right->Final", "Deep->Final"] },
            prompt:
              "{{ Left->Final }} | {{ Right->Final }} | {{ Deep->Final }}",
          },
        },
        edges: [
          ...["Left", "Right", "Deep"].flatMap((id) => [
            {
              from: "$source",
              to: id,
              kind: "message" as const,
              schema: prompt,
            },
            {
              from: id,
              to: "Final",
              id: `${id}->Final`,
              kind: "message",
              on: "return",
              schema: reply,
            },
          ]),
          { from: "Final", to: "$sink", schema: reply },
        ],
      },
    }),
    options({
      args: {
        recorder: recorder.add_context("root"),
        collection: countedCollection().collection,
      },
      parameters: {
        ladder: new schedules.ModelLadder(models, {
          smol: { model: "p/s" },
          low: { model: "p/l" },
          med: { model: "p/m" },
          high: { model: "p/h" },
          xhigh: { model: "p/x" },
        }),
        scheduler: (label, graphPath) => {
          levels.push([label, graphPath]);
          return schedules.strength(
            (_, id) =>
              rungs[graphPath === "" ? id : `${graphPath}/${id}`] ?? "med",
            schedules.parallel(),
          );
        },
      },
    }),
  );
  try {
    for (const path of Object.keys(rungs)) {
      let state: unknown = execution.graph;
      for (const id of path.split("/")) {
        assert.ok(state instanceof JuncoGraph);
        state = state.getNode(graph.NodeId.create(id))?.state;
      }
      assert.ok(state instanceof agent.JuncoAgent);
      state.recorder?.record({
        kind: "probe",
        resource: "probe",
        edgeId: path,
        value: 1,
      });
    }
    assert.deepEqual(probes, [
      ["root::Left::Worker", "Left/Worker", 1],
      ["root::Right::Worker", "Right/Worker", 1],
      ["root::Deep::Inner::Worker", "Deep/Inner/Worker", 1],
      ["root::Final", "Final", 1],
    ]);
    enqueuePrompts(execution, "seed", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    await execution.run();
    assert.deepEqual(levels, [
      ["Team", ""],
      ["Team", "Left"],
      ["Team", "Right"],
      ["Team", "Deep"],
      ["Team", "Deep/Inner"],
    ]);
    assert.equal(
      calls.get("Final")?.prompt,
      "report:Left/Worker | report:Right/Worker | report:Deep/Inner/Worker",
    );
    assert.equal(resultText(execution.graph), "report:Final");
    const models = { smol: "s", low: "l", med: "m", high: "h", xhigh: "x" };
    for (const [path, rung] of Object.entries(rungs))
      assert.equal(calls.get(path)?.model, models[rung], path);
  } finally {
    await execution.graph.close();
  }
});

test("a nested Ralph level is driven while the outer sink is untouched", async () => {
  const inner = ralphDoc().graph;
  inner.source = {
    ...inner.source,
    routes: { "$source~>Wrapper": ["$source~>Ralph"] },
  };
  const instance = script("draft-1", "draft-2");
  const final = script("final reply");
  const execution = await build(
    parse({
      graph: {
        source: { routes: { seed: ["$source~>Wrapper"] } },
        nodes: {
          Wrapper: { kind: "graph", graph: inner },
          Final: { prompt: "{{ Wrapper->Final }}" },
        },
        edges: [
          { from: "$source", to: "Wrapper", kind: "message", schema: prompt },
          {
            from: "Wrapper",
            to: "Final",
            id: "Wrapper->Final",
            kind: "message",
            on: "return",
            schema: reply,
          },
          { from: "Final", to: "$sink", schema: reply },
        ],
      },
    }),
    await offline(
      { "Wrapper/Ralph": instance, Final: final },
      { args: schedules.ralph({ rounds: 2 }) },
    ),
  );
  try {
    enqueuePrompts(execution, "seed", {
      kind: "prompt",
      text: "assignment",
      taskId: "Ralph#1",
      spec: "",
      deps: [],
      history: [],
    });
    await execution.run();
    assert.deepEqual(lastPrompts(instance), [
      asTask("assignment", "Ralph#1"),
      workMessage("revise", 2),
    ]);
    assert.deepEqual(lastPrompts(final), ["draft-2"]);
    assert.equal(resultText(execution.graph), "final reply");
  } finally {
    await execution.graph.close();
  }
});

test("message-edge prompt placeholders fail before a model request", async () => {
  const instance = script();
  await assert.rejects(
    build(
      parse({
        graph: {
          nodes: {
            Start: { kind: "emit", text: "data", spec: "done" },
            Reader: { prompt: "{{Start~>Reader}}" },
          },
          edges: [
            { from: "Start", to: "Reader", kind: "message", schema: prompt },
            { from: "Reader", to: "$sink", schema: reply },
          ],
        },
      }),
      await offline({ Reader: instance }),
    ),
    new graph.DataflowDefinitionError(
      'junco-syntax: prompt placeholder {{Start~>Reader}} of node "Reader" names message edge "Start~>Reader"; placeholders require a value or on: return edge',
    ),
  );
  assert.deepEqual(instance.requests, []);
});

async function stepUntil(
  execution: { step(): Promise<unknown> },
  reached: () => boolean,
) {
  for (let n = 0; n < 64 && !reached(); n++) await execution.step();
  assert.ok(reached(), "expected graph state within 64 decisions");
}

for (const sameProduct of [false, true])
  test(`always stages the YAML prompt once per settlement (identical products: ${sameProduct})`, async () => {
    const first = assistant("first");
    const second = sameProduct ? first : assistant("second");
    const instance = script(
      fauxAssistantMessage(fauxToolCall("yield", { reason: "pause" }), {
        stopReason: "toolUse",
      }),
      first,
      second,
    );
    const execution = await JuncoGraph.fromYaml(
      `graph:
  nodes:
    A:
      prompt: Generate a new unit test
      trigger: always
  sink: { stream: true, trigger: never }
  edges:
    - { from: A, to: $sink, kind: message, on: return, schema: {type: object} }
`,
      await offline({ A: instance }),
    );
    const id = graph.NodeId.create("A");
    const member = execution.graph.getNode(id)!.state;
    assert.ok(member instanceof agent.JuncoAgent);
    const queued = () =>
      execution.graph
        .observe()
        .inputs.get(execution.graph.sink.id)
        ?.messages.get(graph.EdgeId.create("A~>$sink")) ?? [];
    try {
      for (let i = 0; i < 3; i++)
        assert.ok(execution.graph.available().has(id));
      assert.equal(member.status, "ready");
      await stepUntil(execution, () => instance.requests.length === 1);
      assert.deepEqual(requestTexts(instance.requests)[0], [
        "Generate a new unit test",
      ]);
      assert.equal(queued().length, 0);
      await stepUntil(execution, () => queued().length === 2);
      const published = queued().map((message) => {
        assert.ok(Value.Check(agent.AssistantMessageSchema, message));
        return contentText(message.content);
      });
      assert.deepEqual(published, ["first", sameProduct ? "first" : "second"]);
      assert.equal(O.toUndefined(execution.graph.result(id)), queued()[1]);
      assert.deepEqual(requestTexts(instance.requests).at(-1), [
        "Generate a new unit test",
        "Generate a new unit test",
      ]);
      assert.ok(execution.graph.available().has(id));
    } finally {
      await execution.graph.close();
    }
  });

for (const transport of ["value", "return"] as const)
  test(`one upstream settlement drives a ${transport} template`, async () => {
    const repeated = transport === "value";
    const first = assistant("one"),
      second = assistant("two");
    const a = script("  answer  ");
    const b = script(first, second);
    const execution = await build(
      parse({
        graph: {
          nodes: {
            Start: { kind: "emit", text: "Provide an answer", spec: "done" },
            A: { prompt: "Answer the assignment." },
            B: { prompt: "value={{report}}", trigger: "report" },
          },
          edges: [
            { from: "Start", to: "A", kind: "message", schema: prompt },
            {
              from: "A",
              to: "B",
              id: "report",
              schema: reply,
              ...(repeated ? {} : { kind: "message", on: "return" }),
            },
            { from: "B", to: "$sink", schema: reply },
          ],
        },
      }),
      await offline({ A: a, B: b }),
    );
    const id = graph.NodeId.create("B");
    try {
      await stepUntil(execution, () => O.isSome(execution.graph.result(id)));
      assert.equal(resultText(execution.graph, id), "one");
      if (repeated)
        await stepUntil(
          execution,
          () => resultText(execution.graph, id) === "two",
        );
      else {
        await execution.run();
        await execution.run();
      }
      assert.deepEqual(
        lastPrompts(b),
        repeated ? ["value=answer", "value=answer"] : ["value=answer"],
      );
      assert.deepEqual(requestTexts(b.requests)[0], ["value=answer"]);
      assert.equal(a.requests.length, 1);
      assert.equal(execution.graph.available().has(id), repeated);
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
    const consumer = script("early", "late");
    const execution = await build(
      parse({
        graph: {
          sink: trigger === "never" ? { trigger } : undefined,
          source: { routes: { left: ["seed-left"], right: ["seed-right"] } },
          nodes: {
            Left: { prompt: "left" },
            Right: { prompt: "right" },
            Consumer: { trigger, prompt: "{{left}}/{{right}}" },
          },
          edges: [
            {
              from: "$source",
              to: "Left",
              id: "seed-left",
              kind: "message",
              schema: prompt,
            },
            {
              from: "$source",
              to: "Right",
              id: "seed-right",
              kind: "message",
              schema: prompt,
            },
            {
              from: "Left",
              to: "Consumer",
              id: "left",
              kind: "message",
              on: "return",
              schema: reply,
            },
            {
              from: "Right",
              to: "Consumer",
              id: "right",
              kind: "message",
              on: "return",
              schema: reply,
            },
            { from: "Consumer", to: "$sink", schema: reply },
          ],
        },
      }),
      await offline({
        Left: script("Left"),
        Right: script("Right"),
        Consumer: consumer,
      }),
    );
    try {
      enqueuePrompts(execution, "left", {
        kind: "prompt",
        text: "go",
        taskId: "seed",
        spec: "",
        deps: [],
        history: [],
      });
      await execution.run();
      const early = typeof trigger === "object" && "any" in trigger;
      assert.equal(consumer.requests.length, early ? 1 : 0);
      if (early) assert.deepEqual(lastPrompts(consumer), ["Left/"]);
      enqueuePrompts(execution, "right", {
        kind: "prompt",
        text: "go",
        taskId: "seed",
        spec: "",
        deps: [],
        history: [],
      });
      await execution.run();
      assert.equal(
        consumer.requests.length,
        trigger === "never" ? 0 : early ? 2 : 1,
      );
      if (early) assert.deepEqual(lastPrompts(consumer), ["Left/", "/Right"]);
      if (!early && trigger !== "never")
        assert.deepEqual(lastPrompts(consumer), ["Left/Right"]);
    } finally {
      await execution.graph.close();
    }
  });

test("source fan-out preserves queued payloads and sink waits for both value results", async () => {
  const agents = { Left: script("LEFT"), Right: script("RIGHT") };
  const execution = await build(
    parse({
      graph: {
        window: 2,
        threads: 2,
        source: { routes: { seed: ["$source~>Left", "$source~>Right"] } },
        sink: { returns: "Left" },
        nodes: {
          Left: { prompt: "Read the following input." },
          Right: { prompt: "Read the following input." },
        },
        edges: [
          { from: "$source", to: "Left", kind: "message", schema: prompt },
          { from: "$source", to: "Right", kind: "message", schema: prompt },
          { from: "Left", to: "$sink", schema: reply },
          { from: "Right", to: "$sink", schema: reply },
        ],
      },
    }),
    await offline(agents, {
      parameters: { scheduler: () => schedules.roundRobin() },
    }),
  );
  try {
    const payload = {
      kind: "prompt" as const,
      text: "seed text",
      taskId: "T1",
      spec: "",
      deps: [],
      history: [],
      images: [
        { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
      ],
    };
    enqueuePrompts(execution, "seed", payload);
    await stepUntil(execution, () =>
      execution.graph.available().has(graph.NodeId.create("Left")),
    );
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
    for (const id of ["Left", "Right"] as const) {
      assert.deepEqual(
        observation.inputs
          .get(graph.NodeId.create(id))
          ?.messages.get(graph.EdgeId.create(`$source~>${id}`)),
        [payload],
      );
      assert.equal(agents[id].requests.length, 0);
    }
    await stepUntil(execution, () =>
      O.isSome(execution.graph.result(graph.NodeId.create("Left"))),
    );
    assert.equal(
      execution.graph.result(graph.NodeId.create("Left"))._tag,
      "Some",
    );
    assert.equal(
      execution.graph.result(graph.NodeId.create("Right"))._tag,
      "None",
    );
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "None");
    await execution.run();
    for (const instance of Object.values(agents))
      assert.deepEqual(lastPrompts(instance), [asTask("seed text", "T1")]);
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
  doc.graph.nodes.Fan = { prompt: "Read the following result." };
  doc.graph.sink = { returns: "Final" };
  doc.graph.nodes.Final = {
    prompt: "{{Inner->Final}}|{{childValue}}|{{siblingValue}}",
  };
  doc.graph.edges!.push(
    {
      from: "Start",
      to: "Sibling",
      kind: "message",
      id: "siblingSeed",
      schema: prompt,
    },
    { from: "Inner", to: "Fan", kind: "message", id: "fan", schema: reply },
    { from: "Inner", to: "Final", id: "childValue", schema: reply },
    { from: "Sibling", to: "Final", id: "siblingValue", schema: reply },
    { from: "Fan", to: "$sink", schema: reply },
  );
  const final = script("final"),
    fan = script("fan");
  const execution = await build(
    parse(doc),
    await offline({
      "Inner/Worker": script("CHILD"),
      "Sibling/Worker": script("SIBLING"),
      Fan: fan,
      Final: final,
    }),
  );
  try {
    const sources = new Set(),
      sinks = new Set();
    function visit(g: graph.JuncoGraph<TSchema, unknown>) {
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
    assert.deepEqual(JSON.parse(lastPrompts(fan)[0]!), {
      id: "fan",
      payload: O.toUndefined(
        execution.graph.result(graph.NodeId.create("Inner")),
      ),
    });
  } finally {
    await execution.graph.close();
  }
});

test("scheduled ingress rejects unrouted input", async () => {
  const execution = await build(
    parse({
      graph: {
        source: { routes: { accepted: ["input"] } },
        nodes: { A: { prompt: "Read the following input." } },
        edges: [
          {
            from: "$source",
            to: "A",
            kind: "message",
            id: "input",
            schema: prompt,
          },
          { from: "A", to: "$sink", schema: reply },
        ],
      },
    }),
    await offline({ A: script() }),
  );
  try {
    enqueuePrompts(execution, "wrong", {
      kind: "prompt",
      text: "go",
      taskId: "T1",
      spec: "",
      deps: [],
      history: [],
    });
    await assert.rejects(
      execution.run(),
      /does not accept input on edge "wrong"/,
    );
  } finally {
    await execution.graph.close();
  }
});

test("unrouted source edges are rejected at parse time", () => {
  assert.throws(
    () =>
      parse({
        graph: {
          nodes: { A: { prompt: "Read the following input." } },
          edges: [
            {
              from: "$source",
              to: "A",
              kind: "message",
              id: "input",
              schema: prompt,
            },
            { from: "A", to: "$sink", schema: reply },
          ],
        },
      }),
    (error) =>
      error instanceof ValidationError && error.code === "source-route",
  );
});

test("value ingress is forwarded raw and empty routes drop only that input", async () => {
  const a = script("done");
  const execution = await build(
    parse({
      graph: {
        source: { routes: { drop: [], value: ["input"] } },
        nodes: { A: { prompt: "Read the following input." } },
        edges: [
          {
            from: "$source",
            to: "A",
            kind: "message",
            id: "input",
            schema: { anyOf: [prompt, reply] },
          },
          { from: "A", to: "$sink", schema: reply },
        ],
      },
    }),
    await offline({ A: a }),
  );
  const input = assistant("  normalized  ");
  try {
    execution.graph.source.enqueue({
      messages: new Map([
        [graph.EdgeId.create("drop"), [{ kind: "prompt", text: "discard" }]],
      ]),
      values: new Map([[graph.EdgeId.create("value"), input]]),
    });
    await execution.run();
    assert.deepEqual(JSON.parse(lastPrompts(a)[0]!), {
      id: "input",
      payload: input,
    });
  } finally {
    await execution.graph.close();
  }
});

test("early sink identifies the selected predecessor that has not returned", async () => {
  const execution = await build(
    parse({
      graph: {
        sink: { trigger: "always" },
        nodes: { A: { prompt: "work", trigger: "never" } },
        edges: [{ from: "A", to: "$sink", schema: reply }],
      },
    }),
    await offline({ A: script() }),
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
    const consumer = script();
    const execution = await build(
      parse({
        graph: {
          nodes: {
            Start: { kind: "emit", text: "Begin the task.", spec: "done" },
            A: { prompt: "go" },
            B: { prompt: "{{report}}" },
          },
          edges: [
            { from: "Start", to: "A", kind: "message", schema: prompt },
            { from: "A", to: "B", id: "report", schema: reply },
            { from: "B", to: "$sink", schema: reply },
          ],
        },
      }),
      await offline({ A: script(bad), B: consumer }),
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

for (const transport of ["value", "return"] as const)
  test(`repeated ${transport} placeholders preserve order and optional emptiness without duplicating messages`, async () => {
    const edgeKind =
      transport === "return"
        ? ({ kind: "message", on: "return" } as const)
        : {};
    const consumer = script("done");
    const execution = await build(
      parse({
        graph: {
          source: { routes: { seed: ["m", "seed-a", "seed-optional"] } },
          nodes: {
            A: { prompt: "go" },
            Optional: { prompt: "work", trigger: "never" },
            B: {
              trigger: { all: ["v", "m"] },
              prompt: "{{v}}|{{v}}|{{optional}}",
            },
          },
          edges: [
            {
              from: "$source",
              to: "B",
              kind: "message",
              id: "m",
              schema: prompt,
            },
            {
              from: "$source",
              to: "A",
              kind: "message",
              id: "seed-a",
              schema: prompt,
            },
            {
              from: "$source",
              to: "Optional",
              kind: "message",
              id: "seed-optional",
              schema: prompt,
            },
            { from: "A", to: "B", id: "v", schema: reply, ...edgeKind },
            {
              from: "Optional",
              to: "B",
              id: "optional",
              schema: reply,
              ...edgeKind,
            },
            { from: "B", to: "$sink", schema: reply },
          ],
        },
      }),
      await offline({ B: consumer, A: script("VALUE"), Optional: script() }),
    );
    try {
      enqueuePrompts(
        execution,
        "seed",
        {
          kind: "prompt",
          text: "first",
          taskId: "B#1",
          spec: "",
          deps: [],
          history: [],
        },
        {
          kind: "appendMessage",
          message: { role: "user", content: "not text", timestamp: 0 },
        },
        {
          kind: "prompt",
          text: "third",
          taskId: "B#2",
          spec: "",
          deps: [],
          history: [],
        },
      );
      await execution.run();
      assert.deepEqual(requestTexts(consumer.requests), [
        [
          "VALUE|VALUE|",
          asTask("first", "B#1"),
          '{"id":"m","payload":{"kind":"appendMessage","message":{"role":"user","content":"not text","timestamp":0}}}',
          asTask("third", "B#2"),
        ],
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
    override startRun<S, N extends TSchema, T, EH>(
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
  const execution = await build(
    doc,
    await offline(
      { "Inner/Worker": script("Worker"), Final: script("Final") },
      {
        args: { tracer: observer },
      },
    ),
  );
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
      nodes: {
        Seed: { kind: "emit", text: "go", spec: "done" },
        Terminal: { kind: "code", trigger: "never" },
      },
      edges: [
        { from: "Seed", to: "Terminal", kind: "message", schema: prompt },
        { from: "Terminal", to: "$sink", schema: { type: "null" } },
      ],
    };
    const doc = parse({
      graph: nested
        ? {
            sink: { trigger: "never" },
            nodes: { Child: { kind: "graph", trigger: "never", graph: child } },
            edges: [{ from: "Child", to: "$sink", schema: reply }],
          }
        : child,
    });
    const execution = await build(
      doc,
      options({ args: { code: { Terminal: Constant(null) } } }),
    );
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
          Start: { kind: "emit", text: "Begin the task.", spec: "done" },
          A: {
            system: "fixture system",
            prompt: "offline task",
          },
        },
        edges: [
          { from: "Start", to: "A", kind: "message", schema: prompt },
          { from: "A", to: "$sink", schema: reply },
        ],
      },
    }),
    options({
      args: { collection },
      parameters: { ladder: new schedules.ModelLadder(models, fauxLadder) },
    }),
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
  const transferred = await countedSession();
  try {
    await assert.rejects(
      build(
        parse({
          graph: {
            nodes: { A: { prompt: "work" } },
            edges: [{ from: "A", to: "$sink", schema: reply }],
          },
        }),
        options({
          args: {
            collection,
            signal: AbortSignal.abort(reason),
            agentOptions: new Map([
              [graph.NodeId.create("A"), { session: transferred.session }],
            ]),
          },
          parameters: { ladder: new schedules.ModelLadder(models, fauxLadder) },
        }),
      ),
      (error) => error === reason,
    );
    assert.deepEqual(transferred.contexts, [BACKGROUND_CONTEXT]);
    assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
  } finally {
    await collection.close();
  }
});

test("deleted construction options cannot invoke a factory, adopt a supplied agent or open a mux", async () => {
  const { models, faux } = await fauxRuntime([]);
  const { collection, active } = countedCollection();
  const supplied = await agent.JuncoAgent.create({
    provider: "faux",
    model: "faux-1",
    models,
    collection,
  });
  const open = spyOn(tools.ToolCollection, "create");
  try {
    for (const [key, value] of [
      ["agents", { A: supplied }],
      ["createAgent", () => assert.fail("removed factory called")],
      ["createAgentOwnership", "caller"],
    ] as const) {
      const config = options({
        args: { [key]: value },
        parameters: { ladder: new schedules.ModelLadder(models, fauxLadder) },
      });
      await assert.rejects(
        build(roundDoc("ignored"), config),
        new RegExp(`${key}.*no longer supported`),
      );
      assert.equal(supplied.status, "idle");
      assert.equal(active.bindings, 1);
    }
    assert.equal(open.mock.calls.length, 0);
    assert.equal(faux.state.callCount, 0);
  } finally {
    open.mockRestore();
    try {
      await supplied.return();
    } finally {
      await collection.close();
    }
  }
});

test("node maps reject non-agents, unknown paths and invalid values before acquisition", async () => {
  const { collection, events } = countedCollection();
  const ladder = await offlineLadder([]);
  const doc = document();
  doc.graph.nodes.Code = { kind: "code" };
  doc.graph.edges!.push(
    { from: "Start", to: "Code", kind: "message", schema: prompt },
    { from: "Code", to: "Final", schema: reply },
  );
  const { args, parameters } = options({
    args: { collection, code: { Code: Constant(null) } },
    parameters: { ladder },
  });
  for (const name of ["tools", "agentOptions"] as const)
    for (const path of [
      "Missing",
      "$sink",
      "Inner",
      "Inner/$source",
      "Start",
      "Code",
    ]) {
      const entry = await countedSession();
      const key = graph.NodeId.create(path);
      const map = new Map([[key, { session: entry.session }]]);
      const overrides =
        name === "tools"
          ? {
              tools: new Map([[key, collection]]),
              agentOptions: new Map([
                [graph.NodeId.create("Final"), { session: entry.session }],
              ]),
            }
          : { agentOptions: map };
      await assert.rejects(
        build(doc, { args: { ...args, ...overrides }, parameters }),
        (error) =>
          error instanceof ValidationError &&
          error.code === "node-map" &&
          error.path === `/options/${name}` &&
          error.message.includes(path),
      );
      assert.deepEqual(entry.contexts, [BACKGROUND_CONTEXT]);
    }
  for (const invalid of [
    {},
    { Final: collection },
    new Map([[graph.NodeId.create("Final"), undefined]]),
  ])
    await assert.rejects(
      build(doc, {
        args: { ...args, tools: invalid as JuncoArgs["tools"] },
        parameters,
      }),
      /map|ToolCollection/i,
    );
  for (const field of [
    "provider",
    "model",
    "models",
    "thinkingLevel",
    "prompt",
    "systemPrompt",
    "tools",
    "recorder",
    "parallelToolCalls",
    "resources",
  ]) {
    const value = field === "resources" ? { skills: [] } : null;
    const config = new Map([
      [graph.NodeId.create("Final"), { [field]: value }],
    ]);
    await assert.rejects(
      build(doc, { args: { ...args, agentOptions: config }, parameters }),
      new RegExp(field),
    );
  }
  assert.deepEqual(events, []);
});

test("two paths cannot share a session, and promptless nodes cannot discard supplied images", async () => {
  const ladder = await offlineLadder([]);
  const { collection, events } = countedCollection();
  const { session, contexts } = await countedSession();
  await assert.rejects(
    build(
      document(),
      options({
        args: {
          collection,
          agentOptions: new Map(
            ["Inner/Worker", "Final"].map((path) => [
              graph.NodeId.create(path),
              { session },
            ]),
          ),
        },
        parameters: { ladder },
      }),
    ),
    /same session/,
  );
  assert.deepEqual(contexts, [BACKGROUND_CONTEXT]);
  const doc = roundDoc("omitted");
  doc.graph.nodes.A = {};
  await assert.rejects(
    build(
      doc,
      options({
        args: {
          collection,
          agentOptions: new Map([
            [
              graph.NodeId.create("A"),
              {
                images: [
                  { type: "image", mimeType: "image/png", data: "AA==" },
                ],
              },
            ],
          ]),
        },
        parameters: { ladder },
      }),
    ),
    /images.*prompt/,
  );
  assert.deepEqual(events, []);
});

test("failure registering the second agent releases every graph, agent, binding and pending session", async () => {
  const primary = new Error("second registration failed"),
    binding = new Error("binding close failed"),
    pending = new Error("pending close failed");
  const { collection, active, events } = countedCollection({
    binding: 2,
    error: binding,
  });
  const holders = [
    await countedSession(),
    await countedSession(),
    await countedSession(pending),
  ];
  const paths = ["Child/A", "Child/B", "Later"];
  const doc = parse({
    graph: {
      nodes: {
        Child: {
          kind: "graph",
          graph: {
            nodes: { A: { prompt: "first" }, B: { prompt: "second" } },
            edges: [
              { from: "A", to: "B", schema: reply },
              { from: "B", to: "$sink", schema: reply },
            ],
          },
        },
        Later: { prompt: "last" },
      },
      edges: [
        { from: "Child", to: "Later", schema: reply },
        { from: "Later", to: "$sink", schema: reply },
      ],
    },
  });
  const graphs = new Set<JuncoGraph<TSchema, unknown>>();
  const members: { readonly status: string }[] = [];
  const original = JuncoGraph.prototype.addNode;
  const registration = spyOn(
    JuncoGraph.prototype,
    "addNode",
  ).mockImplementation(function (this: JuncoGraph<TSchema, unknown>, spec) {
    graphs.add(this);
    if (spec.state instanceof agent.JuncoAgent) {
      members.push(spec.state);
      if (spec.id === "B") throw primary;
    }
    return Reflect.apply(original, this, [spec]);
  });
  try {
    await assert.rejects(
      build(
        doc,
        options({
          args: {
            collection,
            agentOptions: new Map(
              paths.map((path, i) => [
                graph.NodeId.create(path),
                { session: holders[i]!.session },
              ]),
            ),
          },
          parameters: { ladder: await offlineLadder([]) },
        }),
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        const leaves = (e: unknown): unknown[] =>
          e instanceof AggregateError ? e.errors.flatMap(leaves) : [e];
        assert.deepEqual(leaves(error), [primary, binding, pending]);
        return true;
      },
    );
    assert.deepEqual(
      members.map((m) => m.status),
      ["closed", "closed"],
    );
    assert.equal(graphs.size, 2);
    assert.ok([...graphs].every((g) => g.signal.aborted));
    assert.deepEqual(
      holders.map((h) => h.contexts.length),
      [1, 1, 1],
    );
    assert.deepEqual(active, { bindings: 0, leases: 0, creatorCloses: 0 });
    assert.deepEqual(events.sort(), [
      "bind-close:1",
      "bind-close:2",
      "lease-close:1",
      "lease-close:2",
    ]);
  } finally {
    registration.mockRestore();
    await collection.close();
  }
});

test("nested agents request only their mapped tools, run them under their own paths, and share one native fallback", async () => {
  const native = await copyTreeNative();
  const root = await mkdtemp(join(tmpdir(), "junco-yaml-grants-"));
  const names = ["Left", "Right", "Default"] as const;
  const borrowed = new Map<graph.NodeIdType, tools.ToolCollection>();
  const calls: string[] = [],
    traced: object[] = [],
    monitored: object[] = [];
  const toolReceipts: [string, string][] = [];
  const { recorder } = probeRecorder((path, event) => {
    if (
      event.kind === "finish" &&
      event.outcome === "success" &&
      event.tool.startsWith("private_")
    )
      toolReceipts.push([path, event.tool]);
  });
  const trace = Object.assign(new tracer.DummyTracer(), {
    observeAgent(node: { state: object }) {
      traced.push(node.state);
      return () => {};
    },
  });
  const branch = (name: string) => ({
    kind: "graph",
    graph: {
      source: { routes: { [`Start~>${name}`]: ["$source~>Worker"] } },
      nodes: {
        Worker: {
          prompt: `instruction:${name}`,
          system: `system:${name}`,
          ...(name === "Left" ? { skills: ["guide"] } : {}),
          tool_block: [...NATIVE_TOOL_BLOCK, "task"],
        },
      },
      edges: [
        { from: "$source", to: "Worker", kind: "message", schema: prompt },
        { from: "Worker", to: "$sink", schema: reply },
      ],
    },
  });
  const doc = parse({
    skills: { guide: "guide/SKILL.md" },
    graph: {
      nodes: {
        Start: { kind: "emit", text: "start", spec: "work" },
        ...Object.fromEntries(names.map((name) => [name, branch(name)])),
        Final: {
          prompt: names.map((name) => `{{${name}->Final}}`).join(" / "),
          tool_block: NATIVE_TOOL_BLOCK,
        },
      },
      edges: [
        ...names.flatMap((name) => [
          { from: "Start", to: name, kind: "message", schema: prompt },
          {
            from: name,
            to: "Final",
            id: `${name}->Final`,
            kind: "message",
            on: "return",
            schema: reply,
          },
        ]),
        { from: "Final", to: "$sink", schema: reply },
      ],
    },
  });
  const image = { type: "image", data: "AA==", mimeType: "image/png" } as const;
  const respond: FauxResponseFactory = (context, options, _state, model) => {
    const path = captureUsageContext()?.nodePath.join("/");
    assert.ok(path);
    calls.push(path);
    const [name] = path.split("/");
    const granted = getCurrentTools(context.messages).map((t) => t.name);
    assert.deepEqual(
      granted.filter((t) => t.startsWith("private_")),
      name === "Left" || name === "Right" ? [`private_${name}`] : [],
    );
    assert.ok(!granted.includes("bash"));
    if (name === "Final") {
      assert.deepEqual(userTexts(context.messages), [
        "receipt:Left / receipt:Right / receipt:Default",
      ]);
      return fauxAssistantMessage("joined");
    }
    const first = context.messages.find((m) => m.role === "user");
    assert.ok(
      first && userTexts(context.messages)[0] === `instruction:${name}`,
    );
    const system = context.messages
      .filter((m) => m.role === "system")
      .map((m) => contentText(m.content))
      .join("\n");
    assert.ok(system.includes(`system:${name}`));
    assert.equal(
      system.includes("Role-specific skill description."),
      name === "Left",
    );
    if (name === "Left") {
      assert.ok(
        Array.isArray(first.content) &&
          first.content.some(
            (block) => block.type === "image" && block.data === image.data,
          ),
      );
      assert.equal(model.id, "large");
      assert.equal(options?.reasoning, "high");
    } else assert.equal(model.id, "small");
    if (name !== "Default") {
      const result = context.messages.find((m) => m.role === "toolResult");
      if (!result)
        return fauxAssistantMessage(fauxToolCall(`private_${name}`, {}), {
          stopReason: "toolUse",
        });
      assert.equal(result.isError, false);
      assert.equal(contentText(result.content), `tool:${name}`);
    }
    return fauxAssistantMessage(`receipt:${name}`);
  };
  const { models } = await fauxRuntime(
    Array.from({ length: 6 }, () => respond),
    "faux",
    [{ id: "small" }, { id: "large", reasoning: true }],
  );
  const ladder = new schedules.ModelLadder(models, {
    ...schedules.uniformLadder({ model: "faux/small" }),
    high: { model: "faux/large", thinking: "high" },
  });
  try {
    await mkdir(join(root, "guide"));
    await writeFile(
      join(root, "guide", "SKILL.md"),
      "---\nname: guide\ndescription: Role-specific skill description.\n---\nGuide.\n",
    );
    for (const name of ["Left", "Right"]) {
      const dir = join(root, name);
      await mkdir(dir);
      borrowed.set(
        graph.NodeId.create(`${name}/Worker`),
        await tools.ToolCollection.create(dir, {
          native,
          policy: tools.LockPolicy,
          recorder,
          extend: async () => ({
            tools: [
              {
                name: `private_${name}`,
                label: name,
                description: name,
                parameters: Type.Object({}),
                execute: async () => ({
                  content: [{ type: "text", text: `tool:${name}` }],
                  details: {},
                }),
              },
            ],
            close: async () => {},
          }),
        }),
      );
    }
    // Inject only the filesystem backend; creation, owner bindings and teardown are real.
    const create = tools.ToolCollection.create.bind(tools.ToolCollection);
    const open = spyOn(tools.ToolCollection, "create").mockImplementation(
      (cwd, init) => create(cwd, { ...init, native }),
    );
    try {
      const { args, parameters } = options({
        args: { cwd: root, tools: borrowed, recorder, tracer: trace },
        parameters: { ladder },
      });
      await assert.rejects(
        build(doc, {
          args: { ...args, policy: tools.EmptyPolicy },
          parameters,
        }),
        /policy/i,
      );
      await assert.rejects(
        build(doc, {
          args: { ...args, recorder: probeRecorder().recorder },
          parameters,
        }),
        /recorder/i,
      );
      assert.equal(open.mock.calls.length, 0);
      const execution = await build(doc, {
        args: {
          ...args,
          agentOptions: new Map([
            [
              graph.NodeId.create("Left/Worker"),
              {
                images: [image],
                tokenMonitor: {
                  tokenThreshold: 1,
                  onThreshold: (owner) => {
                    monitored.push(owner);
                  },
                },
              },
            ],
          ]),
        },
        parameters: {
          ...parameters,
          scheduler: (_label, path) =>
            schedules.strength(
              () => (path === "Left" ? "high" : "med"),
              schedules.parallel(),
            ),
        },
      });
      const fallback = execution.graph.collection;
      try {
        assert.equal(open.mock.calls.length, 1);
        assert.ok(fallback);
        const actual = names.map((name) => {
          const child = execution.graph.getNode(
            graph.NodeId.create(name),
          )?.state;
          assert.ok(child instanceof JuncoGraph);
          assert.equal(child.collection, fallback);
          const worker = child.getNode(graph.NodeId.create("Worker"))?.state;
          assert.ok(worker instanceof agent.JuncoAgent);
          assert.equal(
            worker.collection,
            borrowed.get(graph.NodeId.create(`${name}/Worker`)) ?? fallback,
          );
          return worker;
        });
        await execution.run();
        assert.equal(resultText(execution.graph), "joined");
        assert.deepEqual(calls.sort(), [
          "Default/Worker",
          "Final",
          "Left/Worker",
          "Left/Worker",
          "Right/Worker",
          "Right/Worker",
        ]);
        assert.ok(
          monitored.length > 0 &&
            monitored.every((owner) => owner === actual[0]),
        );
        for (const worker of actual)
          assert.equal(traced.filter((owner) => owner === worker).length, 1);
        assert.deepEqual(toolReceipts.sort(), [
          ["Left::Worker", "private_Left"],
          ["Right::Worker", "private_Right"],
        ]);
      } finally {
        await execution.graph.close();
      }
      assert.throws(() => fallback!.lease(), /closed/);
      for (const collection of borrowed.values())
        await collection.lease().close();
      const same = borrowed.get(graph.NodeId.create("Left/Worker"))!;
      const fullyMapped = new Map([
        ...borrowed,
        [graph.NodeId.create("Default/Worker"), same] as const,
        [graph.NodeId.create("Final"), same] as const,
      ]);
      const mappedArgs = { ...args, tools: fullyMapped };
      await assert.rejects(
        build(doc, {
          args: mappedArgs,
          parameters: { ...parameters, tool_pruning: true },
        }),
        /tool_pruning/,
      );
      const mapped = await build(doc, { args: mappedArgs, parameters });
      try {
        assert.equal(
          open.mock.calls.length,
          1,
          "all paths mapped: no default opened",
        );
        assert.equal(mapped.graph.collection, undefined);
        const owners = new Set<string>();
        for (const name of ["Left", "Default"]) {
          const child = mapped.graph.getNode(graph.NodeId.create(name))!.state;
          assert.ok(child instanceof JuncoGraph);
          const worker = child.getNode(graph.NodeId.create("Worker"))!.state;
          assert.ok(
            worker instanceof agent.JuncoAgent && worker.owner !== undefined,
          );
          assert.equal(worker.collection, same);
          owners.add(worker.owner);
        }
        assert.equal(owners.size, 2);
      } finally {
        await mapped.graph.close();
      }
      doc.graph.nodes.Final = { kind: "code" };
      const primary = new Error("cannot register final");
      const rolledBack: tools.ToolCollection[] = [];
      await assert.rejects(
        build(doc, {
          args: {
            ...args,
            code: {
              Final: ({ collection }) => {
                assert.ok(collection);
                rolledBack.push(collection);
                throw primary;
              },
            },
          },
          parameters,
        }),
        (error) => error === primary,
      );
      assert.equal(rolledBack.length, 1);
      assert.throws(() => rolledBack[0]!.lease(), /closed/);
      for (const collection of borrowed.values())
        await collection.lease().close();
    } finally {
      open.mockRestore();
    }
  } finally {
    try {
      await Promise.all(
        [...borrowed.values()].map((collection) => collection.close()),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
            Start: { kind: "emit", text: "Begin the task.", spec: "done" },
            A: {
              prompt: "Execute the resource fixture.",
              ...(row.system === undefined ? {} : { system: row.system }),
              ...(row.skill === undefined ? {} : { skills: [row.skill] }),
            },
          },
          edges: [
            { from: "Start", to: "A", kind: "message", schema: prompt },
            { from: "A", to: "$sink", schema: reply },
          ],
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
            assert.equal(
              userTexts(context.messages)[0],
              "Execute the resource fixture.",
            );
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
      const execution = await build(
        doc,
        options({
          args: { cwd, collection: counted.collection },
          parameters: { ladder: new schedules.ModelLadder(models, fauxLadder) },
        }),
      );
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

test("builtin info exposes routes without receiver contracts", async () => {
  let inspected = false;
  const { models, faux } = await fauxRuntime([
    fauxAssistantMessage([fauxToolCall("info", {}, { id: "inspect-routes" })], {
      stopReason: "toolUse",
    }),
    (context) => {
      const result = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === "inspect-routes",
      );
      assert.ok(
        result?.role === "toolResult",
        "the sender must see info's actual tool result on its next request",
      );
      const text = contentText(result.content);
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(text), {
        parents: [{ id: "Start", edgeId: "Start~>Sender", kind: "message" }],
        children: [{ id: "Receiver", edgeId: "handoff", kind: "message" }],
      });
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
          sink: { trigger: "never" },
          nodes: {
            Start: { kind: "emit", text: "Begin the task.", spec: "done" },
            Sender: {
              prompt: "Inspect the receiver's routes using info.",
            },
            Receiver: {
              trigger: "never",
              prompt: "Receive the handoff.",
            },
          },
          edges: [
            { from: "Start", to: "Sender", kind: "message", schema: prompt },
            {
              from: "Sender",
              to: "Receiver",
              kind: "message",
              id: "handoff",
              schema: prompt,
            },
            { from: "Receiver", to: "$sink", schema: reply },
          ],
        },
      }),
      options({
        args: { collection },
        parameters: { ladder: new schedules.ModelLadder(models, fauxLadder) },
      }),
    );
    await execution.run();
    assert.equal(inspected, true);
    assert.equal(
      faux.state.callCount,
      2,
      "only the sender runs; topology discovery must not execute the receiver",
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
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "None");
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
          A: { prompt: "work" },
          B: { prompt: "work" },
        },
        edges: [
          { from: "A", to: "B", schema: reply },
          { from: "B", to: "$sink", schema: reply },
        ],
      };
      const doc = parse({
        graph: nested
          ? {
              nodes: {
                Child: { kind: "graph", graph: successful },
                Missing: { kind: "code" },
              },
              edges: [
                { from: "Child", to: "Missing", schema: reply },
                { from: "Missing", to: "$sink", schema: reply },
              ],
            }
          : {
              ...successful,
              nodes: {
                ...successful.nodes,
                Missing: { kind: "code" },
              },
              edges: [
                { from: "A", to: "B", schema: reply },
                { from: "B", to: "Missing", schema: reply },
                { from: "Missing", to: "$sink", schema: reply },
              ],
            },
      });
      try {
        await assert.rejects(
          build(
            doc,
            options({
              args: {
                collection,
                code: {
                  Missing: () => {
                    throw primary;
                  },
                },
              },
              parameters: {
                ladder: new schedules.ModelLadder(models, fauxLadder),
              },
            }),
          ),
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
          ["bind-close:1", "bind-close:2"],
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
      edges: [{ from: id, to: "$sink", schema: reply }],
    },
  });
const codeOptions = (
  log: string[],
  code: JuncoArgs<{ log: string[] }>["code"] = { Emitter },
) => ({
  args: {
    cwd: join(import.meta.dir, ".."),
    policy: tools.EmptyPolicy,
    context: { log },
    code,
  },
  parameters: { scheduler: () => schedules.roundRobin() },
});
test("fromYaml resolves a code node from args.code without reading parameters.code", async () => {
  const log: string[] = [];
  const config = codeOptions(log);
  const parameters = {
    ...config.parameters,
    get code(): never {
      throw new Error("parameters.code must not be read");
    },
  };
  const execution = await JuncoGraph.fromYaml(codeDocument(), {
    args: config.args,
    parameters,
  });
  try {
    assert.deepEqual(log, ["Codes/Emitter"]);
    await execution.run();
    assert.equal(resultText(execution.graph), "Codes/Emitter");
  } finally {
    await execution.graph.close();
  }
});

test("code factory returning a legacy registration is rejected by node name", async () => {
  const state = new Deterministic<TSchema, unknown>(async function* () {
    yield [];
    return null;
  }, tools.EmptyPolicy);
  const legacy = () => ({ state });
  await assert.rejects(
    build(
      codeDocument(),
      codeOptions([], { Emitter: legacy as unknown as DeterministicNode }),
    ),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      /Emitter/.test(error.message),
  );
  assert.ok(
    state.signal.aborted,
    "unregistered deterministic state must be released",
  );
});

test("nested code nodes resolve their configured definition by local node id", async () => {
  const log: string[] = [];
  const doc = codeDocument();
  const execution = await build(
    parse({
      graph: {
        nodes: { Nested: { kind: "graph", graph: doc.graph } },
        edges: [{ from: "Nested", to: "$sink", schema: reply }],
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
    build(codeDocument("Missing"), codeOptions(log, {})),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      error.message ===
        'junco-syntax: code node "Missing" has no definition in args.code',
  );
  assert.deepEqual(log, []);
});

test("fromYaml collects only requested measurements, separately at each graph level", async () => {
  const measured = new Set<string>();
  const { args, parameters: baseline } = await offline(
    {
      "Inner/Worker": script("leaf", "leaf"),
      Final: script("done", "done"),
    },
    {
      parameters: {
        scheduler: (_, path) => (snapshot) => {
          if (snapshot.history.length === 0)
            assert.equal(snapshot.measurements.size, 0);
          for (const [id, resources] of snapshot.measurements) {
            assert.ok(snapshot.nodes.has(id));
            assert.deepEqual([...resources.keys()], ["runtime"]);
            const samples = resources.get("runtime")!;
            assert.equal(samples.length, 1);
            assert.ok(Number.isSafeInteger(samples[0]) && samples[0]! >= 0);
            measured.add(`${path}/${id}`);
          }
          return { selected: schedules.select(snapshot, snapshot.available) };
        },
      },
    },
  );
  const withWindow: JuncoParameters = {
    ...baseline,
    measurementWindows: new Map([["runtime", 1]]),
  };
  const doc = document();
  try {
    for (const parameters of [baseline, withWindow]) {
      measured.clear();
      const execution = await JuncoGraph.fromYaml(doc, { args, parameters });
      try {
        await execution.run();
        assert.equal(resultText(execution.graph), "done");
        if (parameters === baseline) assert.equal(measured.size, 0);
        else {
          assert.ok(measured.has("/Final"));
          assert.ok(measured.has("Inner/Worker"));
        }
      } finally {
        await execution.graph.close();
      }
    }
  } finally {
    await args.collection.close();
  }
});

test("native options apply only to a collection created by the builder", async () => {
  const { collection } = countedCollection();
  const ladder = await offlineLadder([]);
  for (const extra of [
    { resources: { pids: 1 } },
    { onResourceEvent() {} },
    { tool_pruning: true },
  ])
    await assert.rejects(
      build(
        document(),
        options({ args: { collection }, parameters: { ladder, ...extra } }),
      ),
      /apply|applies/,
    );
  const loopGuard = new agent.LoopGuard();
  const specs = await resolveAgents(document(), {
    cwd: process.cwd(),
    loopGuard,
  });
  assert.deepEqual(
    specs.map(({ path, loopGuard: guard }) => [path, guard === loopGuard]),
    [
      ["Inner/Worker", true],
      ["Final", true],
    ],
  );
});

const roundDoc = (instruction: string) =>
  parse({
    graph: {
      nodes: {
        Start: { kind: "emit", text: "Begin the task.", spec: "done" },
        A: { prompt: instruction },
      },
      edges: [
        { from: "Start", to: "A", kind: "message", schema: prompt },
        { from: "A", to: "$sink", schema: reply },
      ],
    },
  });

// Raw payloads: edge schemas reach admission; ports and nested graphs forward values unchanged.

const number = { type: "number" };
const counted = {
  type: "object",
  required: ["count"],
  properties: { count: { type: "number" } },
};
const codeBuild = (
  doc: JuncoDocument,
  code: JuncoArgs["code"],
  extra: Pick<JuncoArgs, "recorder"> = {},
) =>
  build(doc, options({ args: { policy: tools.EmptyPolicy, code, ...extra } }));

/** A session keeping each probe event with its interned context's path. */
function probeRecorder(
  receipt?: (path: string, event: tools.ProfileEvent<string>) => void,
) {
  const probes: [path: string, edgeId: string, value: number][] = [];
  const views = new Map<string, tools.ProfileRecorder<string>>();
  const view = (path: string): tools.ProfileRecorder<string> => {
    const known = views.get(path);
    if (known !== undefined) return known;
    const created: tools.ProfileRecorder<string> = Object.freeze({
      root: probes,
      path,
      add_context: (id: string) =>
        id === ""
          ? created
          : view(`${path === "" ? "" : `${path}::`}${tools.profilePath([id])}`),
      record: (event: tools.ProfileEvent<string>) => {
        receipt?.(path, event);
        if (event.kind === "probe")
          probes.push([path, event.edgeId, event.value]);
      },
      flush: async () => {},
      close: async () => {},
    });
    views.set(path, created);
    return created;
  };
  return { recorder: view(""), probes };
}
const sorted = (probes: readonly (readonly unknown[])[]) =>
  probes.map((probe) => JSON.stringify(probe)).sort();

/** A numeric result crossing a nested graph; `probe` marks every edge but the array result. */
const nestedNumbers = (
  schema: object,
  probe: boolean | undefined,
): JuncoDocument => {
  const flag = probe === undefined ? {} : { probe };
  return parse({
    graph: {
      nodes: {
        Seven: { kind: "code", trigger: "always" },
        Child: {
          kind: "graph",
          graph: {
            source: { routes: { "Seven->Child": ["$source~>Echo"] } },
            nodes: { Echo: { kind: "code" } },
            edges: [
              { from: "$source", to: "Echo", kind: "message", schema, ...flag },
              { from: "Echo", to: "$sink", schema, ...flag },
            ],
          },
        },
        Tail: { kind: "code" },
      },
      edges: [
        { from: "Seven", to: "Child", schema, ...flag },
        { from: "Child", to: "Tail", kind: "message", schema, ...flag },
        { from: "Child", to: "Tail", id: "childValue", schema, ...flag },
        { from: "Tail", to: "$sink", schema: { type: "array" } },
      ],
    },
  });
};
const nestedCode = (value: unknown) => ({
  Seven: Constant(value),
  Echo: Forward("$source~>Echo"),
  Tail: Collect("Child~>Tail", "childValue"),
});

for (const [name, schema, value] of [
  ["numeric", number, 7],
  ["object", counted, { count: 7 }],
] as const)
  test(`a ${name} code result crosses a nested graph raw onto parent message and value edges`, async () => {
    const execution = await codeBuild(
      nestedNumbers(schema, undefined),
      nestedCode(value),
    );
    try {
      await execution.run();
      const result = execution.graph.result(execution.graph.sink.id);
      assert.ok(result._tag === "Some" && Array.isArray(result.value));
      const [message, child] = result.value;
      assert.equal(message, value);
      assert.equal(child, value);
    } finally {
      await execution.graph.close();
    }
  });

/** A streaming root relaying its `in` messages through streaming child `Child`'s `Echo`. */
const streamingDocument = () => {
  const schema = { type: "object" };
  return parse({
    graph: {
      source: { routes: { in: ["$source~>Child"] } },
      sink: { stream: true },
      nodes: {
        Child: {
          kind: "graph",
          trigger: { any: ["$source~>Child"] },
          graph: {
            name: "child",
            source: { routes: { "$source~>Child": ["$source~>Echo"] } },
            sink: { stream: true },
            nodes: { Echo: { kind: "code", trigger: "$source~>Echo" } },
            edges: [
              { from: "$source", to: "Echo", kind: "message", schema },
              { from: "Echo", to: "$sink", kind: "message", schema },
            ],
          },
        },
      },
      edges: [
        { from: "$source", to: "Child", kind: "message", schema },
        { from: "Child", to: "$sink", kind: "message", schema },
      ],
    },
  });
};

test("streaming sinks deliver every batch without a terminal result", async () => {
  const execution = await codeBuild(streamingDocument(), {
    Echo: Relay("$source~>Echo", "Echo~>$sink"),
  });
  const root = execution.graph;
  const enqueue = (...payloads: object[]) =>
    root.source.enqueue({
      messages: new Map([[graph.EdgeId.create("in"), payloads]]),
      values: new Map(),
    });
  const drain = () => {
    const delivered: unknown[] = [];
    root.sink.drain((message) => {
      assert.equal(message.id, "Child~>$sink");
      delivered.push(message.payload);
    });
    return delivered;
  };
  const child = root.getNode(graph.NodeId.create("Child"));
  assert.ok(child?.state instanceof JuncoGraph);
  const nested = child.state;
  const [a, b, c, d] = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
  try {
    enqueue(a);
    await execution.run();
    const first = drain();
    assert.deepEqual(first, [a]);
    assert.equal(first[0], a);
    enqueue(b, c);
    await execution.run();
    const second = drain();
    assert.deepEqual(second, [b, c]);
    assert.ok(second[0] === b && second[1] === c);
    await execution.run();
    assert.deepEqual(drain(), []);
    for (const [g, id] of [
      [root, child.id],
      [root, root.sink.id],
      [nested, nested.sink.id],
    ] as const)
      assert.ok(O.isNone(g.result(id)));
    assert.equal(child.status, "running");

    enqueue(d);
    enqueue(a);
    assert.ok(root.source.peek());
    await execution.run();
    assert.deepEqual(drain(), [d, a]);
    assert.equal(root.source.peek(), undefined);
  } finally {
    await root.close();
  }
  assert.ok(nested.signal.aborted);
});

test("probed edges record each publication once in their owning graph's context", async () => {
  const { recorder, probes } = probeRecorder();
  const code = nestedCode(7);
  let echo: CodeContext | undefined;
  const execution = await codeBuild(
    nestedNumbers(number, true),
    {
      ...code,
      Echo(context) {
        echo = context;
        return code.Echo(context);
      },
    },
    { recorder: recorder.add_context("root") },
  );
  try {
    await execution.run();
    const result = execution.graph.result(execution.graph.sink.id);
    assert.ok(result._tag === "Some");
    assert.deepEqual(result.value, [7, 7]);
    assert.deepEqual(
      sorted(probes),
      sorted([
        ["root", "Seven->Child", 7],
        ["root::Child", "$source~>Echo", 7],
        ["root::Child", "Echo->$sink", 7],
        ["root", "Child~>Tail", 7],
        ["root", "childValue", 7],
      ]),
    );
    assert.ok(echo);
    const context = echo;
    const probe = () =>
      context.recorder?.record({
        kind: "probe",
        resource: "probe",
        edgeId: "placement",
        value: 7,
      });
    await context.graph.runWithRecorder(recorder.add_context("moved"), probe);
    probe();
    assert.deepEqual(probes.slice(-2), [
      ["moved::Echo", "placement", 7],
      ["root::Child::Echo", "placement", 7],
    ]);
  } finally {
    await execution.graph.close();
  }
});

test("unprobed edges record nothing, and probes without a recorder run unchanged", async () => {
  for (const probe of [undefined, false]) {
    const { recorder, probes } = probeRecorder();
    const execution = await codeBuild(
      nestedNumbers(number, probe),
      nestedCode(7),
      { recorder },
    );
    try {
      await execution.run();
      assert.deepEqual(probes, []);
    } finally {
      await execution.graph.close();
    }
  }
  const execution = await codeBuild(nestedNumbers(number, true), nestedCode(7));
  try {
    await execution.run();
    const result = execution.graph.result(execution.graph.sink.id);
    assert.ok(result._tag === "Some");
    assert.deepEqual(result.value, [7, 7]);
  } finally {
    await execution.graph.close();
  }
});

test("a probed source route records once per target edge; an empty route records nothing", async () => {
  const { recorder, probes } = probeRecorder();
  const execution = await codeBuild(
    parse({
      graph: {
        source: {
          routes: { input: ["$source~>A", "$source~>B"], empty: [] },
        },
        sink: { returns: "A" },
        nodes: { A: { kind: "code" }, B: { kind: "code" } },
        edges: [
          {
            from: "$source",
            to: "A",
            kind: "message",
            schema: number,
            probe: true,
          },
          {
            from: "$source",
            to: "B",
            kind: "message",
            schema: number,
            probe: true,
          },
          { from: "A", to: "$sink", schema: number },
          { from: "B", to: "$sink", schema: number },
        ],
      },
    }),
    { A: Forward("$source~>A"), B: Forward("$source~>B") },
    { recorder },
  );
  try {
    execution.graph.source.enqueue({
      messages: new Map([
        [graph.EdgeId.create("input"), [3]],
        [graph.EdgeId.create("empty"), [4]],
      ]),
      values: new Map(),
    });
    await execution.run();
    assert.deepEqual(
      sorted(probes),
      sorted([
        ["", "$source~>A", 3],
        ["", "$source~>B", 3],
      ]),
    );
  } finally {
    await execution.graph.close();
  }
});

test("an invalid code result fails its value edge and publishes nothing", async () => {
  const { recorder, probes } = probeRecorder();
  const execution = await codeBuild(
    parse({
      graph: {
        nodes: { Seven: { kind: "code", trigger: "always" } },
        edges: [{ from: "Seven", to: "$sink", schema: number, probe: true }],
      },
    }),
    { Seven: Constant("7") },
    { recorder },
  );
  try {
    await assert.rejects(execution.run(), (error) => {
      const cause =
        error instanceof graph.DataflowNodeError ? error.error : error;
      return (
        cause instanceof graph.DataflowDefinitionError &&
        cause.message.startsWith(
          'Invalid payload for value edge "Seven->$sink"',
        )
      );
    });
    assert.equal(
      execution.graph.result(graph.NodeId.create("Seven"))._tag,
      "None",
    );
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "None");
    assert.deepEqual(probes, []);
  } finally {
    await execution.graph.close();
  }
});

test("a numeric placeholder fails naming its edge before the agent is asked", async () => {
  const consumer = script();
  const execution = await build(
    parse({
      graph: {
        nodes: {
          Seven: { kind: "code", trigger: "always" },
          A: { prompt: "count: {{Seven->A}}" },
        },
        edges: [
          { from: "Seven", to: "A", schema: number },
          { from: "A", to: "$sink", schema: reply },
        ],
      },
    }),
    await offline({ A: consumer }, { args: { code: { Seven: Constant(7) } } }),
  );
  try {
    await assert.rejects(
      execution.run(),
      nodeFailure(/^Prompt placeholder \{\{Seven->A\}\} renders only/),
    );
    assert.equal(consumer.requests.length, 0);
  } finally {
    await execution.graph.close();
  }
});

test("an agent sends a number through its edge schema", async () => {
  const seen: { sendError?: string; tools?: Tool[] } = {};
  const lastResult = (context: Pick<Context, "messages">, name: string) =>
    context.messages
      .filter(
        (message) => message.role === "toolResult" && message.toolName === name,
      )
      .at(-1);
  const { models } = await fauxRuntime([
    (context) => {
      seen.tools = context.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []) : [],
      );
      return fauxAssistantMessage(
        fauxToolCall(
          "send",
          // Pi coerces a numeric string such as "7" to the route's number before execution.
          {
            id: "Worker~>Tail",
            payload: "seven",
            handoff: "h",
            task: "t",
            spec: "s",
          },
          { id: "s1" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const result = lastResult(context, "send");
      if (result?.role === "toolResult" && result.isError)
        seen.sendError = contentText(result.content);
      return fauxAssistantMessage(
        fauxToolCall(
          "send",
          {
            id: "Worker~>Tail",
            payload: 7,
            handoff: "h",
            task: "t",
            spec: "s",
          },
          { id: "s2" },
        ),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("done"),
  ]);
  const { recorder, probes } = probeRecorder();
  const execution = await build(
    parse({
      graph: {
        sink: { returns: "Tail" },
        nodes: {
          Seven: { kind: "code", trigger: "always" },
          Worker: { prompt: "work", tool_block: NATIVE_TOOL_BLOCK },
          Tail: { kind: "code" },
        },
        edges: [
          {
            from: "Seven",
            to: "Worker",
            id: "Seven->Worker",
            kind: "message",
            on: "return",
            schema: number,
            probe: true,
          },
          {
            from: "Worker",
            to: "Tail",
            kind: "message",
            schema: number,
            probe: true,
          },
          { from: "Tail", to: "$sink", schema: number, probe: true },
        ],
      },
    }),
    options({
      args: {
        code: { Seven: Constant(7), Tail: Increment("Worker~>Tail") },
        collection: countedCollection().collection,
        recorder,
      },
      parameters: { ladder: new schedules.ModelLadder(models, fauxLadder) },
    }),
  );
  try {
    await execution.run();
    // Pi validates the model's call against the advertised edge schema before `send` runs.
    assert.match(seen.sendError!, /payload: must be number/);
    const send = seen.tools?.find((tool) => tool.name === "send");
    assert.ok(send);
    assert.ok(
      Value.Check(send.parameters, {
        id: "Worker~>Tail",
        payload: 7,
        handoff: "h",
        task: "t",
        spec: "s",
      }),
    );
    assert.ok(
      !Value.Check(send.parameters, {
        id: "Worker~>Tail",
        payload: "7",
        handoff: "h",
        task: "t",
        spec: "s",
      }),
    );
    const result = execution.graph.result(execution.graph.sink.id);
    assert.ok(result._tag === "Some");
    assert.equal(result.value, 8);
    // The rejected call published nothing; the accepted send was validated, then sampled once.
    assert.deepEqual(probes, [
      ["", "Seven->Worker", 7],
      ["", "Worker~>Tail", 7],
      ["", "Tail->$sink", 8],
    ]);
  } finally {
    await execution.graph.close();
  }
});

test("memory: YAML host NodeIds isolate Worker from worker through real agent calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "junco-yaml-memory-"));
  const memory = new tools.JuncoMemory({ directory });
  const seed = join(directory, "seed");
  let collection: tools.ToolCollection | undefined;
  const trace = new tracer.DummyTracer();
  const names = ["Worker", "worker"] as const;
  const saved = new Map<string, { id: string; text: string }>();
  const completed = new Set<string>();
  const bothSaved = Promise.withResolvers<void>();
  const bothSearched = Promise.withResolvers<void>();
  const searched = new Set<string>();
  const respond = async (context: Context): Promise<AssistantMessage> => {
    const name = names.find((name) =>
      userTexts(context.messages).includes(`scope:${name}`),
    );
    assert.ok(name, "each request retains its YAML node's assignment");
    const other = name === "Worker" ? "worker" : "Worker";
    const text = `Junco SQLite durable memory owned by ${name}`;
    const results = context.messages.filter(
      (message) => message.role === "toolResult",
    );
    const result = results.at(-1);
    const call = (toolName: string, args: JsonObject) =>
      fauxAssistantMessage(
        fauxToolCall(toolName, args, { id: `${name}-${results.length}` }),
        { stopReason: "toolUse" },
      );
    if (!result) return call("save_memory", { text });
    assert.equal(result.isError, false, contentText(result.content));
    const details = JSON.parse(contentText(result.content));
    switch (results.length) {
      case 1:
        assert.equal(result.toolName, "save_memory");
        assert.equal(details.text, text);
        assert.equal(typeof details.id, "string");
        assert.ok(details.id.length > 0);
        saved.set(name, { id: details.id, text });
        if (saved.size === 2) bothSaved.resolve();
        await bothSaved.promise;
        assert.notEqual(saved.get(name)!.id, saved.get(other)!.id);
        return call("search_memory", { query: "Junco SQLite", k: 20 });
      case 2:
        assert.equal(result.toolName, "search_memory");
        assert.deepEqual(details, { memories: [saved.get(name)] });
        searched.add(name);
        if (searched.size === 2) bothSearched.resolve();
        await bothSearched.promise;
        return call("forget_memory", { id: saved.get(other)!.id });
      case 3:
        assert.equal(result.toolName, "forget_memory");
        assert.deepEqual(details, {
          id: saved.get(other)!.id,
          forgotten: false,
        });
        return call("forget_memory", { id: saved.get(name)!.id });
      case 4:
        assert.equal(result.toolName, "forget_memory");
        assert.deepEqual(details, { id: saved.get(name)!.id, forgotten: true });
        return call("search_memory", { query: "Junco SQLite" });
      case 5:
        assert.equal(result.toolName, "search_memory");
        assert.deepEqual(details, { memories: [] });
        completed.add(name);
        return fauxAssistantMessage(`finished:${name}`);
      default:
        assert.fail(`unexpected extra request for ${name}`);
    }
  };
  let execution: Awaited<ReturnType<typeof JuncoGraph.fromYaml>> | undefined;
  try {
    await mkdir(seed);
    collection = await tools.ToolCollection.create(seed, {
      native: await copyTreeNative(),
      memory,
    });
    const { models, faux } = await fauxRuntime(
      Array.from({ length: 12 }, () => respond),
    );
    const ladder = new schedules.ModelLadder(models, fauxLadder);
    execution = await JuncoGraph.fromYaml(
      JSON.stringify({
        graph: {
          sink: {
            returns: "Worker",
            trigger: { all: ["Worker->$sink", "worker->$sink"] },
          },
          nodes: {
            Start: {
              kind: "emit",
              text: "Exercise scoped memory",
              spec: "done",
            },
            ...Object.fromEntries(
              names.map((name) => [
                name,
                {
                  prompt: `scope:${name}`,
                  tool_block: NATIVE_TOOL_BLOCK,
                },
              ]),
            ),
          },
          edges: [
            ...names.map((to) => ({
              from: "Start",
              to,
              kind: "message",
              schema: prompt,
            })),
            ...names.map((from) => ({ from, to: "$sink", schema: reply })),
          ],
        },
      }),
      options({ args: { tracer: trace, collection }, parameters: { ladder } }),
    );
    await execution.run();
    assert.deepEqual([...completed].sort(), [...names].sort());
    for (const name of names) {
      const result = execution.graph.result(graph.NodeId.create(name));
      assert.ok(O.isSome(result));
      const message = result.value as AssistantMessage;
      assert.equal(message.stopReason, "stop");
      assert.equal(contentText(message.content), `finished:${name}`);
    }
    assert.equal(resultText(execution.graph), "finished:Worker");
    assert.equal(faux.state.callCount, 12);
    assert.equal(faux.getPendingResponseCount(), 0);
  } finally {
    try {
      await execution?.graph.close();
    } finally {
      try {
        try {
          await collection?.close();
        } finally {
          memory.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
