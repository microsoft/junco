import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import {
  graph,
  MockAgent,
  type MockFrame,
  type MockRun,
  schedulers,
  tracer,
} from "junco-agency";
import { Type } from "typebox";
import { build, resolveAgents } from "../src/build.ts";
import { parse } from "../src/parse.ts";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "mock",
    provider: "mock",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}
const settle = (message: AssistantMessage): MockFrame => ({
  step: { kind: "settled", message },
});
const run = (frames: readonly MockFrame[]): MockRun => ({
  frames,
  interrupted: {
    step: {
      kind: "settled",
      message: { ...assistant("aborted"), stopReason: "aborted" },
    },
  },
});
const mock = (text: string, prompt?: string) =>
  new MockAgent({ prompt, runs: [run([settle(assistant(text))])] });
const userTexts = (messages: readonly AgentMessage[]) =>
  messages.flatMap((m) =>
    m.role === "user"
      ? [typeof m.content === "string" ? m.content : contentText(m.content)]
      : [],
  );
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
            nodes: { Worker: { model: "faux/w", trigger: "$source~>Worker" } },
            edges: [
              { from: "$source", to: "Worker", kind: "message" },
              { from: "Worker", to: "$sink" },
            ],
          },
        },
        Final: {
          model: "faux/f",
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
  scheduler: () => schedulers.parallel(),
  tracer: new tracer.DummyTracer(),
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
    const result = execution.graph.result(execution.graph.sink.id);
    assert.equal(result._tag, "Some");
    if (result._tag === "Some")
      assert.equal(contentText(result.value.content), "FINAL-OUT");
    assert.deepEqual(
      final.requests.flatMap((r) => userTexts(r.messages)),
      ["got: WORKER-OUT"],
    );
  } finally {
    await execution.graph.close();
  }
});

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
      nodes: { A: { model: "p/m", tools: ["custom"] } },
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
      nodes: { A: { model: "p/m", tools: ["shadow"] } },
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

test("value templates normalize final text", async () => {
  const doc = parse({
    graph: {
      nodes: {
        A: { model: "p/m", prompt: "start" },
        B: { model: "p/m", prompt: "value={{ A->B }}", trigger: "A->B" },
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
    assert.deepEqual(
      b.requests.flatMap((r) => userTexts(r.messages)),
      ["value=answer"],
    );
  } finally {
    await execution.graph.close();
  }
});

test("skills are loaded once, advertised and reject nonexistent registry paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "junco-syntax-skill-"));
  try {
    await mkdir(join(cwd, "guide"));
    const content =
      "---\nname: guide\ndescription: Follow the guide.\n---\nGuide body.\n";
    await writeFile(join(cwd, "guide", "SKILL.md"), content);
    const doc = parse({
      skills: { guide: "guide/SKILL.md" },
      graph: {
        nodes: {
          A: { model: "p/m", system: "Base", skills: ["guide", "guide"] },
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
