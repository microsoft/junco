import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentText } from "@earendil-works/pi-ai";
import { graph, MockAgent, schedules, tracer } from "junco-agency";
import { assistant, run, settle } from "../../../test/deterministic-support.ts";
import { build, parse } from "../src/index.ts";

const cwd = fileURLToPath(new URL("../../../", import.meta.url));

test("MCP report code publishes the exact dependency result after validating both reports", async () => {
  const research = assistant("research-evidence");
  const dependency = assistant("dependency-evidence");
  let downstream: MockAgent | undefined;
  const execution = await build(
    parse(
      readFileSync(
        new URL("../../../examples/mcp/mcp.yml", import.meta.url),
        "utf8",
      ),
    ),
    {
      cwd,
      scheduler: () => schedules.parallel(),
      tracer: new tracer.DummyTracer(),
      createAgent: async (spec) => {
        const instance = new MockAgent({
          runs: [
            run([settle(spec.node === "Research" ? research : dependency)]),
          ],
        });
        if (spec.node === "Dependencies") downstream = instance;
        return instance;
      },
    },
  );
  try {
    const results = await execution.run();
    assert.equal(results.get(execution.graph.sink.id), dependency);
    assert.ok(
      contentText(downstream!.requests[0]!.messages.at(-1)!.content).includes(
        "research-evidence",
      ),
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
    const execution = await build(
      parse(
        readFileSync(
          new URL("../../../examples/mcp/mcp.yml", import.meta.url),
          "utf8",
        ),
      ),
      {
        cwd,
        scheduler: () => schedules.parallel(),
        tracer: new tracer.DummyTracer(),
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
      },
    );
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
