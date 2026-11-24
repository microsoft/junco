import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { graph, JuncoGraph, MockAgent, schedules, tracer } from "junco";
import type { TSchema } from "typebox";
import { Reports } from "../examples/mcp/mcp.ts";
import { assistant, pause, reason, run, settle } from "./deterministic-support.ts";

type YamlMock = MockAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;

const cwd = fileURLToPath(new URL("../", import.meta.url));
const mcpYamlText = readFileSync(
  new URL("../examples/mcp/mcp.yml", import.meta.url),
  "utf8",
);

test("First waits for both browsers and renders each completed report once", async () => {
  const source = readFileSync(new URL("../examples/first/first.yml", import.meta.url), "utf8");
  const review = assistant("reviewed table");
  let reviewer: YamlMock | undefined;
  const execution = await JuncoGraph.fromYaml(source, {
    cwd,
    scheduler: () => schedules.parallel(),
    tracer: new tracer.DummyTracer(),
    createAgent: async ({ node }) => {
      const result = node === "Reviewer" ? review : assistant(`${node} release`);
      const stop = settle(result, { drain: ["steer"] });
      const mock: YamlMock = new MockAgent({
        runs: [run(node === "Rust" ? [pause([reason("checking release", "rust")]), stop] : [stop])],
      });
      if (node === "Reviewer") reviewer = mock;
      return mock;
    },
  });
  try {
    const results = await execution.run();
    assert.equal(results.get(execution.graph.sink.id), review);
    assert.equal(reviewer!.requests.length, 1);
    const inputs = reviewer!.requests[0]!.messages.filter((message) => message.role === "user");
    assert.equal(inputs.length, 1);
    assert.match(contentText(inputs[0]!.content), /Bun:\nBun release\n\nRust:\nRust release$/);
  } finally {
    await execution.graph.close();
  }
});

test("MCP report code publishes the exact dependency result after validating both reports", async () => {
  const research = assistant("research-evidence");
  const dependency = assistant("dependency-evidence");
  let downstream: YamlMock | undefined;
  const execution = await JuncoGraph.fromYaml(mcpYamlText, {
    cwd,
    scheduler: () => schedules.parallel(),
    tracer: new tracer.DummyTracer(),
    code: { Reports },
    createAgent: async (spec) => {
      const instance: YamlMock = new MockAgent({
        runs: [run([settle(spec.node === "Research" ? research : dependency, { drain: ["steer"] })])],
      });
      if (spec.node === "Dependencies") downstream = instance;
      return instance;
    },
  });
  try {
    const results = await execution.run();
    assert.equal(results.get(execution.graph.sink.id), dependency);
    assert.equal(downstream!.requests.length, 1);
    const instructions = downstream!.requests[0]!.messages
      .filter((message) => message.role === "user")
      .map((message) => contentText(message.content));
    assert.equal(instructions.length, 1, "the interpolated report must not also be steered");
    assert.match(instructions[0]!, /<research-report>\s*research-evidence\s*<\/research-report>/);
  } finally {
    await execution.graph.close();
  }
});

for (const [message, expected] of [
  [assistant("  "), "Dependencies produced an empty report"],
  [
    { ...assistant("truncated"), stopReason: "length" as const },
    "Dependencies did not finish normally: length",
  ],
] as const)
  test(`MCP report code rejects ${expected}`, async () => {
    const execution = await JuncoGraph.fromYaml(mcpYamlText, {
      cwd,
      scheduler: () => schedules.parallel(),
      tracer: new tracer.DummyTracer(),
      code: { Reports },
      createAgent: async (spec) =>
        new MockAgent({
          runs: [
            run([
              settle(
                spec.node === "Research"
                  ? assistant("research-evidence")
                  : message,
              ),
            ]),
          ],
        }),
    });
    try {
      await assert.rejects(
        execution.run(),
        (error: unknown) =>
          error instanceof graph.DataflowNodeError &&
          error.nodeId === graph.NodeId.create("Reports") &&
          error.error instanceof Error &&
          error.error.message === expected,
      );
      assert.equal(
        execution.graph.result(execution.graph.sink.id)._tag,
        "None",
      );
    } finally {
      await execution.graph.close();
    }
  });
