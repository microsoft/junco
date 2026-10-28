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
import { assistant, run, settle } from "./deterministic-support.ts";

type YamlMock = MockAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;

const cwd = fileURLToPath(new URL("../", import.meta.url));
const mcpYamlText = readFileSync(
  new URL("../examples/mcp/mcp.yml", import.meta.url),
  "utf8",
);

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
        runs: [run([settle(spec.node === "Research" ? research : dependency)])],
      });
      if (spec.node === "Dependencies") downstream = instance;
      return instance;
    },
  });
  try {
    const results = await execution.run();
    assert.equal(results.get(execution.graph.sink.id), dependency);
    const request = downstream!.requests[0]!.messages.at(-1)!;
    assert.equal(request.role, "user");
    assert.ok(
      request.role === "user" &&
        contentText(request.content).includes("research-evidence"),
    );
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
