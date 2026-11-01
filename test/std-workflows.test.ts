import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import {
  AssistantMessageSchema,
  agent as agentApi,
  Deterministic,
  graph,
  JuncoGraph,
  MockAgent,
  type MockRun,
  schedules,
  syntax,
  tracer,
  workflows,
} from "junco";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  assistant,
  pause,
  reason,
  requestTexts,
  run,
  settle,
} from "./deterministic-support.ts";
import { nativeOptions } from "./support.ts";

const assignment = "Cover every section.\nKeep the original constraints.";
const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;
/** The text of a retained YAML result, which must be an assistant message. */
function textOf(result: unknown): string {
  assert.ok(Value.Check(AssistantMessageSchema, result));
  return contentText(result.content);
}

/** `source` over one native agent answering `responses` in order, recording each user prompt. */
async function nativeWorkflow(
  source: string,
  controller: Pick<syntax.FromYamlOptions, "available" | "code">,
  responses: readonly (string | AssistantMessage)[],
) {
  const prompts: string[] = [];
  const { options } = await nativeOptions(
    responses.map(
      (reply): FauxResponseStep =>
        (context) => {
          const last = context.messages.at(-1);
          if (last?.role === "user")
            prompts.push(
              typeof last.content === "string"
                ? last.content
                : contentText(last.content),
            );
          return typeof reply === "string"
            ? fauxAssistantMessage(reply)
            : reply;
        },
    ),
  );
  let agent:
    | agentApi.JuncoAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>
    | undefined;
  try {
    const execution = await JuncoGraph.fromYaml(source, {
      cwd: process.cwd(),
      scheduler: () => schedules.parallel(),
      tracer: new tracer.DummyTracer(),
      createAgent: async (spec) => {
        agent = await agentApi.JuncoAgent.fromResolved({
          ...options,
          systemPrompt: spec.systemPrompt,
          tools: spec.tools as AgentTool[],
          tool_block: [
            ...new Set([
              ...(options.tool_block ?? []),
              ...(spec.tool_block ?? []),
            ]),
          ],
        });
        return agent;
      },
      ...controller,
    });
    assert.ok(agent);
    return { execution, agent, prompts };
  } catch (error) {
    await agent?.return();
    throw error;
  }
}

async function ralphWorkflow(
  ralph: schedules.RalphOptions,
  responses: readonly (string | AssistantMessage)[],
) {
  const workflow = await nativeWorkflow(
    workflows.ralph,
    schedules.ralph(ralph),
    responses,
  );
  workflow.execution.graph.source.enqueue({
    messages: new Map([
      [
        graph.EdgeId.create("assignment"),
        [{ kind: "prompt", text: assignment }],
      ],
    ]),
    values: new Map(),
  });
  return workflow;
}

test("three rounds revise in one session and only the last draft is the result", async () => {
  const { execution, agent, prompts } = await ralphWorkflow({ rounds: 3 }, [
    "draft-1",
    "draft-2",
    "draft-3",
  ]);
  try {
    const results = await execution.run();
    assert.deepEqual(prompts, [
      assignment,
      revision("draft-1"),
      revision("draft-2"),
    ]);
    const final = results.get(graph.NodeId.create("Ralph"));
    assert.equal(textOf(final), "draft-3");
    assert.equal(results.get(execution.graph.sink.id), final);
    await execution.run();
    assert.deepEqual(prompts, [
      assignment,
      revision("draft-1"),
      revision("draft-2"),
    ]);
  } finally {
    await execution.graph.close();
  }
  assert.equal(agent.status, "closed");
}, 10_000);

test("rounds: 1 asks once", async () => {
  const { execution, prompts } = await ralphWorkflow({ rounds: 1 }, [
    "draft-1",
  ]);
  try {
    const results = await execution.run();
    assert.deepEqual(prompts, [assignment]);
    assert.equal(textOf(results.get(execution.graph.sink.id)), "draft-1");
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("a native yield resumes within a round and never counts as one", async () => {
  const { execution, prompts } = await ralphWorkflow({ rounds: 2 }, [
    fauxAssistantMessage(
      [fauxToolCall("yield", { reason: "continue" }, { id: "y1" })],
      {
        stopReason: "toolUse",
      },
    ),
    "draft-1",
    "draft-2",
  ]);
  try {
    const results = await execution.run();
    assert.deepEqual(prompts, [assignment, revision("draft-1")]);
    assert.equal(textOf(results.get(execution.graph.sink.id)), "draft-2");
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("until judges only completed drafts and publishes the accepted one", async () => {
  const judged: string[] = [];
  const { execution, prompts } = await ralphWorkflow(
    {
      until: (result) => {
        judged.push(contentText(result.content));
        return judged.length === 2;
      },
    },
    [
      fauxAssistantMessage(
        [fauxToolCall("yield", { reason: "continue" }, { id: "y1" })],
        { stopReason: "toolUse" },
      ),
      "draft-1",
      "draft-2",
      "unreachable",
    ],
  );
  try {
    const results = await execution.run();
    assert.deepEqual(judged, ["draft-1", "draft-2"]);
    assert.deepEqual(prompts, [assignment, revision("draft-1")]);
    assert.equal(textOf(results.get(execution.graph.sink.id)), "draft-2");
  } finally {
    await execution.graph.close();
  }
}, 10_000);

test("a blank intermediate draft fails before the next round", async () => {
  const { execution, prompts } = await ralphWorkflow({ rounds: 3 }, [
    "draft-1",
    "  ",
    "unreachable",
  ]);
  try {
    await assert.rejects(
      execution.run(),
      (error: unknown) =>
        error instanceof graph.DataflowNodeError &&
        error.nodeId === graph.NodeId.create("Ralph") &&
        error.error instanceof Error &&
        /^Ralph produced an empty report$/.test(error.error.message),
    );
    assert.deepEqual(prompts, [assignment, revision("draft-1")]);
    assert.ok(O.isNone(execution.graph.result(execution.graph.sink.id)));
  } finally {
    await execution.graph.close();
  }
}, 10_000);

type YamlMock = MockAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;
type Execution = Awaited<ReturnType<typeof JuncoGraph.fromYaml>>;
const OUT = "AnyFanInPublish~>$sink";
const yamlOptions = () => ({
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  tracer: new tracer.DummyTracer(),
});
/** A selector settling each of `results` in its own run. */
const selectorOf = (...results: (MockRun | AssistantMessage)[]): YamlMock =>
  new MockAgent({
    runs: results.map((result) =>
      "frames" in result ? result : run([settle(result)]),
    ),
  });
const enqueueCandidates = (execution: Execution, ...texts: string[]) =>
  execution.graph.source.enqueue({
    messages: new Map([
      [
        graph.EdgeId.create("candidates"),
        texts.map((text) => ({ kind: "prompt", text })),
      ],
    ]),
    values: new Map(),
  });
/** Every message the root sink staged, as `[edge, payload]` in delivery order. */
function drainSink(execution: Execution): [string, unknown][] {
  const delivered: [string, unknown][] = [];
  execution.graph.sink.drain((message) =>
    delivered.push([message.id, message.payload]),
  );
  return delivered;
}
/** The CURRENT_BATCH of every prompt staged on `selector`, in staging order. */
const stagedBatches = (selector: YamlMock): unknown[] =>
  selector.calls
    .filter(({ method }) => method === "stagePrompt")
    .map(({ args: [prompt] }) => {
      assert.ok(typeof prompt === "string");
      return JSON.parse(prompt.split("CURRENT_BATCH:\n")[1] ?? "null");
    });
/** The rejection of `drive`; fails when it resolves. */
async function rejection(drive: Promise<unknown>): Promise<unknown> {
  try {
    await drive;
  } catch (error) {
    return error;
  }
  assert.fail("expected the drive to fail");
}

test("allFanIn selects once, only after every candidate returned", async () => {
  for (const blank of [false, true]) {
    const inner = syntax.parse(workflows.allFanIn).graph;
    const answer = inner.edges?.[0]?.schema;
    inner.source = {
      routes: {
        "Left->Select": ["$source~>AllFanIn"],
        "Right->Select": ["$source~>AllFanIn"],
      },
    };
    const prompt = {
      type: "object",
      required: ["kind", "text"],
      properties: { kind: { const: "prompt" }, text: { type: "string" } },
    };
    const selected = assistant("right answer");
    const selector = selectorOf(selected);
    const agents = new Map<string, YamlMock>([
      ["Left", selectorOf(assistant("left answer"))],
      ["Right", selectorOf(assistant(blank ? "  " : "right answer"))],
      ["AllFanIn", selector],
    ]);
    const allowed = new Set<string>();
    const gate =
      (id: string): NonNullable<syntax.BuildOptions["available"]>[string] =>
      ({ graph: g }) =>
      (_view, triggered) =>
        (triggered && allowed.has(id)) ||
        g.getNode(graph.NodeId.create(id))?.status === "running";
    const execution = await JuncoGraph.fromYaml(
      syntax.parse({
        graph: {
          source: { routes: { seed: ["$source~>Left", "$source~>Right"] } },
          nodes: {
            Left: { prompt: "{{ $source~>Left }}" },
            Right: { prompt: "{{ $source~>Right }}" },
            Select: {
              kind: "graph",
              trigger: { all: ["Left->Select", "Right->Select"] },
              graph: inner,
            },
          },
          edges: [
            { from: "$source", to: "Left", kind: "message", schema: prompt },
            { from: "$source", to: "Right", kind: "message", schema: prompt },
            { from: "Left", to: "Select", schema: answer },
            { from: "Right", to: "Select", schema: answer },
            { from: "Select", to: "$sink", schema: answer },
          ],
        },
      }),
      {
        ...yamlOptions(),
        createAgent: async (spec) => agents.get(spec.node)!,
        available: { Left: gate("Left"), Right: gate("Right") },
      },
    );
    try {
      execution.graph.source.enqueue({
        messages: new Map([
          [graph.EdgeId.create("seed"), [{ kind: "prompt", text: "task" }]],
        ]),
        values: new Map(),
      });
      allowed.add("Left");
      await execution.run();
      assert.ok(O.isSome(execution.graph.result(graph.NodeId.create("Left"))));
      assert.equal(selector.requests.length, 0);
      allowed.add("Right");
      if (blank) {
        const error = await rejection(execution.run());
        assert.ok(error instanceof graph.DataflowNodeError, String(error));
        assert.equal(selector.requests.length, 0);
        assert.ok(O.isNone(execution.graph.result(execution.graph.sink.id)));
        continue;
      }
      await execution.run();
      assert.equal(selector.requests.length, 1);
      const [texts] = requestTexts(selector.requests);
      const request = texts?.at(-1) ?? "";
      assert.ok(
        request.includes("left answer") && request.includes("right answer"),
      );
      assert.equal(
        O.toUndefined(execution.graph.result(execution.graph.sink.id)),
        selected,
      );
    } finally {
      await execution.graph.close();
    }
  }
});

/** A code parent sending `texts` once as prompt candidates on `edge`, then gated off unreturned. */
const sender =
  (edge: string, ...texts: string[]): syntax.DeterministicNode =>
  ({ edges, policy }) => {
    const output = edges.get(edge);
    assert.ok(output);
    let sent = texts.length === 0;
    return {
      state: new Deterministic<TSchema, unknown>(async function* () {
        yield [];
        sent = true;
        yield texts.map((text) =>
          graph.Message.create(output, { kind: "prompt", text }),
        );
      }, policy),
      is_available: () => !sent,
    };
  };

/** `workflows.anyFanIn` as wrapper `Select` behind code parents `Left` and `Right`, tried in `order`. */
async function embeddedAnyFanIn(
  selector: YamlMock,
  order: readonly string[],
  left: readonly string[],
  right: readonly string[],
) {
  const inner = syntax.parse(workflows.anyFanIn).graph;
  const candidate = inner.edges?.[0]?.schema;
  const selection = inner.edges?.[1]?.schema;
  inner.source = {
    routes: {
      "left-message": ["$source~>AnyFanIn"],
      "right-message": ["$source~>AnyFanIn"],
    },
  };
  const controller = schedules.anyFanIn();
  return JuncoGraph.fromYaml(
    syntax.parse({
      graph: {
        source: { routes: { seed: ["$source~>Left", "$source~>Right"] } },
        sink: { stream: true },
        nodes: {
          Left: { kind: "code" },
          Right: { kind: "code" },
          Select: { kind: "graph", trigger: { any: order }, graph: inner },
        },
        edges: [
          { from: "$source", to: "Left", kind: "message", schema: candidate },
          { from: "$source", to: "Right", kind: "message", schema: candidate },
          {
            id: "left-message",
            from: "Left",
            to: "Select",
            kind: "message",
            schema: candidate,
          },
          {
            id: "right-message",
            from: "Right",
            to: "Select",
            kind: "message",
            schema: candidate,
          },
          { from: "Select", to: "$sink", kind: "message", schema: selection },
        ],
      },
    }),
    {
      ...yamlOptions(),
      createAgent: async () => selector,
      ...controller,
      code: {
        ...controller.code,
        Left: sender("left-message", ...left),
        Right: sender("right-message", ...right),
      },
    },
  );
}

test("anyFanIn selects a sent candidate while its parents have not returned", async () => {
  const selected = assistant("left candidate");
  const selector = selectorOf(selected);
  const execution = await embeddedAnyFanIn(
    selector,
    ["left-message", "right-message"],
    ["left candidate"],
    [],
  );
  try {
    await execution.run();
    assert.deepEqual(stagedBatches(selector), [["left candidate"]]);
    const [[edge, payload] = []] = drainSink(execution);
    assert.equal(edge, "Select~>$sink");
    assert.equal(payload, selected);
    const node = (id: string) =>
      execution.graph.getNode(graph.NodeId.create(id));
    assert.equal(node("Left")?.status, "running");
    assert.equal(node("Right")?.status, "ready");
    assert.equal(node("Select")?.status, "running");
    for (const id of ["Left", "Right", "Select"])
      assert.ok(O.isNone(execution.graph.result(graph.NodeId.create(id))));
  } finally {
    await execution.graph.close();
  }
  assert.equal(selector.status, "closed");
});

test("anyFanIn admits ready parents one queue at a time in trigger order", async () => {
  const [right, left] = [assistant("r2"), assistant("l1")];
  const selector = selectorOf(right, left);
  const execution = await embeddedAnyFanIn(
    selector,
    ["right-message", "left-message"],
    ["l1"],
    ["r1", "r2"],
  );
  try {
    await execution.run();
    assert.deepEqual(stagedBatches(selector), [["r1", "r2"], ["l1"]]);
    const delivered = drainSink(execution).map(([, payload]) => payload);
    assert.equal(delivered.length, 2);
    assert.ok(delivered[0] === right && delivered[1] === left);
  } finally {
    await execution.graph.close();
  }
});

test("anyFanIn judges each batch alone, even when the next arrives mid-selection", async () => {
  // Mid-selection arrival, then both views queued before the first drive.
  for (const early of [false, true]) {
    const [a, b] = [assistant("a-complete"), assistant("b-complete")];
    const selector = selectorOf(
      run([pause([reason("still comparing", "p1")]), settle(a)]),
      b,
    );
    const execution = await JuncoGraph.fromYaml(workflows.anyFanIn, {
      ...yamlOptions(),
      createAgent: async () => selector,
      ...schedules.anyFanIn(),
    });
    try {
      enqueueCandidates(execution, "a-incomplete", "a-complete");
      if (early) enqueueCandidates(execution, "b-incomplete", "b-complete");
      else {
        for (let steps = 0; selector.requests.length === 0; steps++) {
          assert.ok(steps < 64, "the selector never started");
          await execution.step();
        }
        assert.deepEqual(drainSink(execution), []);
        enqueueCandidates(execution, "b-incomplete", "b-complete");
      }
      await execution.run();
      assert.deepEqual(stagedBatches(selector), [
        ["a-incomplete", "a-complete"],
        ["b-incomplete", "b-complete"],
      ]);
      const delivered = drainSink(execution);
      assert.deepEqual(
        delivered.map(([edge]) => edge),
        [OUT, OUT],
      );
      assert.ok(delivered[0]?.[1] === a && delivered[1]?.[1] === b);
    } finally {
      await execution.graph.close();
    }
  }
});

test("anyFanIn publishes every selection, even the same result object twice", async () => {
  const same = assistant("shared");
  const selector = selectorOf(same, same);
  const execution = await JuncoGraph.fromYaml(workflows.anyFanIn, {
    ...yamlOptions(),
    createAgent: async () => selector,
    ...schedules.anyFanIn(),
  });
  try {
    enqueueCandidates(execution, "shared", "other-1");
    enqueueCandidates(execution, "other-2", "shared");
    await execution.step();
    for (let probe = 0; probe < 3; probe++) execution.graph.available();
    assert.deepEqual(stagedBatches(selector), [["shared", "other-1"]]);
    await execution.run();
    assert.deepEqual(stagedBatches(selector), [
      ["shared", "other-1"],
      ["other-2", "shared"],
    ]);
    const delivered = drainSink(execution);
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every(([, payload]) => payload === same));
  } finally {
    await execution.graph.close();
  }
});

test("anyFanIn parks while idle and a native selector resumes on later input", async () => {
  const { execution, agent, prompts } = await nativeWorkflow(
    workflows.anyFanIn,
    schedules.anyFanIn(),
    ["x-complete"],
  );
  try {
    await execution.run();
    enqueueCandidates(execution);
    await execution.run();
    assert.deepEqual([prompts, drainSink(execution)], [[], []]);
    enqueueCandidates(execution, "x-short", "x-complete");
    await execution.run();
    assert.equal(prompts.length, 1);
    assert.ok(
      prompts[0]?.endsWith(
        `CURRENT_BATCH:\n${JSON.stringify(["x-short", "x-complete"])}`,
      ),
    );
    const delivered = drainSink(execution);
    assert.deepEqual(
      delivered.map(([edge, payload]) => [edge, textOf(payload)]),
      [[OUT, "x-complete"]],
    );
    await execution.run();
    assert.deepEqual([prompts.length, drainSink(execution)], [1, []]);
    assert.ok(O.isNone(execution.graph.result(execution.graph.sink.id)));
  } finally {
    await execution.graph.close();
  }
  assert.equal(agent.status, "closed");
});

test("anyFanIn fails on bad candidates or selections without publishing or admitting more", async () => {
  const failures: [
    label: string,
    selection: AssistantMessage,
    candidates: readonly unknown[],
    message: string,
  ][] = [
    [
      "blank candidate",
      assistant("unused"),
      [{ kind: "prompt", text: "  " }],
      "AnyFanIn candidate text must not be empty",
    ],
    [
      "non-prompt candidate",
      assistant("unused"),
      [{ kind: "steer", text: "steer" }],
      "AnyFanIn requires prompt candidate messages",
    ],
    [
      "blank selection",
      assistant("  "),
      [{ kind: "prompt", text: "a" }],
      "AnyFanIn produced an empty report",
    ],
    [
      "abnormal selection",
      assistant("a", "error"),
      [{ kind: "prompt", text: "a" }],
      "AnyFanIn did not finish normally: error",
    ],
  ];
  for (const [label, selection, candidates, message] of failures) {
    const selector = selectorOf(selection, assistant("unreachable"));
    const doc = syntax.parse(workflows.anyFanIn);
    // Admit any payload so the controller, not the edge schema, judges the candidate.
    const input = doc.graph.edges?.[0];
    assert.ok(input);
    input.schema = {} as TSchema;
    const execution = await JuncoGraph.fromYaml(doc, {
      ...yamlOptions(),
      createAgent: async () => selector,
      ...schedules.anyFanIn(),
    });
    try {
      execution.graph.source.enqueue({
        messages: new Map([[graph.EdgeId.create("candidates"), candidates]]),
        values: new Map(),
      });
      const next = {
        messages: new Map([
          [
            graph.EdgeId.create("candidates"),
            [{ kind: "prompt", text: "next" }],
          ],
        ]),
        values: new Map(),
      };
      execution.graph.source.enqueue(next);
      const error = await rejection(execution.run());
      const cause =
        error instanceof graph.DataflowNodeError ? error.error : error;
      assert.ok(cause instanceof Error, label);
      assert.equal(cause.message, message, label);
      // Candidates fail before staging; selections fail after their one staged batch.
      const staged = label.endsWith("selection") ? 1 : 0;
      assert.equal(stagedBatches(selector).length, staged, label);
      assert.deepEqual(drainSink(execution), [], label);
      assert.deepEqual(execution.graph.source.peek(), next, label);
    } finally {
      await execution.graph.close();
    }
    assert.equal(selector.status, "closed", label);
  }
});

test("one anyFanIn controller keeps sibling levels independent and declines finite ones", async () => {
  const controller = schedules.anyFanIn();
  const ralph = schedules.ralph();
  const any = (name: string) => {
    const inner = syntax.parse(workflows.anyFanIn).graph;
    inner.name = name;
    inner.source = { routes: { [`$source~>${name}`]: ["$source~>AnyFanIn"] } };
    return inner;
  };
  const all = syntax.parse(workflows.allFanIn).graph;
  all.source = { routes: { "$source~>All": ["$source~>AllFanIn"] } };
  const revise = syntax.parse(workflows.ralph).graph;
  revise.source = { routes: { "$source~>Revise": ["$source~>Ralph"] } };
  const [candidate, selection] = [
    any("One").edges?.[0]?.schema,
    any("One").edges?.[1]?.schema,
  ];
  const assignment = revise.edges?.[0]?.schema;
  const [o1, o2, t1, t2] = [
    assistant("o1b"),
    assistant("o2"),
    assistant("t1"),
    assistant("t2b"),
  ];
  const allSelected = assistant("all-best");
  const agents = new Map<string, YamlMock>([
    ["One", selectorOf(o1, o2)],
    ["Two", selectorOf(t1, t2)],
    ["AllFanIn", selectorOf(allSelected)],
    ["Ralph", selectorOf(assistant("draft-1"), assistant("draft-2"))],
  ]);
  const execution = await JuncoGraph.fromYaml(
    syntax.parse({
      graph: {
        source: {
          routes: {
            one: ["$source~>One"],
            two: ["$source~>Two"],
            all: ["$source~>All"],
            assignment: ["$source~>Revise"],
          },
        },
        // A streaming sink keeps the default all-of trigger; stream each branch with `any`.
        sink: {
          stream: true,
          trigger: {
            any: ["One", "Two", "All", "Revise"].map(
              (from) => `${from}~>$sink`,
            ),
          },
        },
        nodes: {
          One: {
            kind: "graph",
            trigger: { any: ["$source~>One"] },
            graph: any("One"),
          },
          Two: {
            kind: "graph",
            trigger: { any: ["$source~>Two"] },
            graph: any("Two"),
          },
          All: { kind: "graph", graph: all },
          Revise: { kind: "graph", graph: revise },
        },
        edges: [
          ...["One", "Two"].map((to) => ({
            from: "$source",
            to,
            kind: "message",
            schema: candidate,
          })),
          { from: "$source", to: "All", kind: "message", schema: selection },
          {
            from: "$source",
            to: "Revise",
            kind: "message",
            schema: assignment,
          },
          ...["One", "Two", "All", "Revise"].map((from) => ({
            from,
            to: "$sink",
            kind: "message",
            schema: selection,
          })),
        ],
      },
    }),
    {
      ...yamlOptions(),
      createAgent: async (spec) => agents.get(spec.graph)!,
      ...controller,
      available: { ...ralph.available, ...controller.available },
    },
  );
  const enqueue = (route: string, payloads: readonly unknown[]) =>
    execution.graph.source.enqueue({
      messages: new Map([[graph.EdgeId.create(route), payloads]]),
      values: new Map(),
    });
  const prompts = (...texts: string[]) =>
    texts.map((text) => ({ kind: "prompt", text }));
  try {
    enqueue("one", prompts("o1a", "o1b"));
    enqueue("two", prompts("t1"));
    enqueue("all", [assistant("all-a"), assistant("all-best")]);
    enqueue("assignment", prompts("revise this"));
    await execution.run();
    enqueue("two", prompts("t2a", "t2b"));
    enqueue("one", prompts("o2"));
    await execution.run();
    assert.deepEqual(stagedBatches(agents.get("One")!), [
      ["o1a", "o1b"],
      ["o2"],
    ]);
    assert.deepEqual(stagedBatches(agents.get("Two")!), [
      ["t1"],
      ["t2a", "t2b"],
    ]);
    const delivered = drainSink(execution);
    const on = (edge: string) =>
      delivered.filter(([id]) => id === edge).map(([, payload]) => payload);
    assert.deepEqual(on("One~>$sink"), [o1, o2]);
    assert.deepEqual(on("Two~>$sink"), [t1, t2]);
    assert.deepEqual(on("All~>$sink"), [allSelected]);
    assert.deepEqual(on("Revise~>$sink").map(textOf), ["draft-2"]);
    for (const id of ["All", "Revise"])
      assert.equal(
        execution.graph.getNode(graph.NodeId.create(id))?.status,
        "done",
      );
  } finally {
    await execution.graph.close();
  }
});
