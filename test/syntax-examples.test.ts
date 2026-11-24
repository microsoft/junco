import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { graph, JuncoGraph, schedules, syntax, tracer } from "junco";
import { Reports } from "../examples/mcp/mcp.ts";
import { userTexts } from "./deterministic-support.ts";
import { countedCollection, offlineLadder } from "./support.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const mcpYamlText = readFileSync(
  new URL("../examples/mcp/mcp.yml", import.meta.url),
  "utf8",
);

async function build(source: string, respond: FauxResponseFactory) {
  await using setup = new AsyncDisposableStack();
  const collection = setup.adopt(countedCollection().collection, (c) => c.close());
  const execution = await JuncoGraph.fromYaml(source, {
    args: { cwd, collection, tracer: new tracer.DummyTracer(), code: { Reports } },
    parameters: { scheduler: () => schedules.parallel(), ladder: await offlineLadder(respond) },
  });
  setup.defer(() => execution.graph.close());
  const owned = setup.move();
  return { execution, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test("First waits for both browsers and renders each completed report once", async () => {
  const source = readFileSync(new URL("../examples/first/first.yml", import.meta.url), "utf8");
  const reviews: string[][] = [];
  let rustTurns = 0;
  const respond: FauxResponseFactory = (context) => {
    const texts = userTexts(context.messages);
    const prompt = texts[0]!;
    if (prompt.includes("for Bun only")) return fauxAssistantMessage("Bun release");
    if (prompt.includes("for Rust only")) {
      return ++rustTurns === 1
        ? fauxAssistantMessage(fauxToolCall("yield", { reason: "checking release" }), { stopReason: "toolUse" })
        : fauxAssistantMessage("Rust release");
    }
    assert.ok(prompt.startsWith("Merge the two answers"));
    reviews.push(texts);
    return fauxAssistantMessage("reviewed table");
  };
  await using flow = await build(source, respond);
  const { execution } = flow;
  const results = await execution.run();
  const review = results.get(graph.NodeId.create("Reviewer"));
  assert.equal(syntax.finalText(review, "Reviewer"), "reviewed table");
  assert.equal(results.get(execution.graph.sink.id), review);
  assert.equal(rustTurns, 2);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.length, 1);
  assert.match(reviews[0]![0]!, /Bun:\nBun release\n\nRust:\nRust release$/);
});

function mcpResponse(dependency: AssistantMessage, requests: string[][] = []): FauxResponseFactory {
  return (context) => {
    const texts = userTexts(context.messages);
    if (texts[0]!.startsWith("Complete the assignment")) return fauxAssistantMessage("research-evidence");
    assert.ok(texts[0]!.startsWith("The research report below"));
    requests.push(texts);
    return dependency;
  };
}

test("MCP report code publishes the exact dependency result after validating both reports", async () => {
  const requests: string[][] = [];
  const respond = mcpResponse(fauxAssistantMessage("dependency-evidence"), requests);
  await using flow = await build(mcpYamlText, respond);
  const { execution } = flow;
  const results = await execution.run();
  const dependency = results.get(graph.NodeId.create("Dependencies"));
  assert.equal(syntax.finalText(dependency, "Dependencies"), "dependency-evidence");
  assert.equal(results.get(execution.graph.sink.id), dependency);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.length, 1, "the interpolated report must not also be steered");
  assert.match(requests[0]![0]!, /<research-report>\s*research-evidence\s*<\/research-report>/);
});

for (const [message, expected] of [
  [fauxAssistantMessage("  "), "Dependencies produced an empty report"],
  [
    fauxAssistantMessage("truncated", { stopReason: "length" }),
    "Dependencies did not finish normally: error: Assistant request exceeded the context window",
  ],
] as const)
  test(`MCP report code rejects ${expected}`, async () => {
    const respond = mcpResponse(message);
    await using flow = await build(mcpYamlText, respond);
    const { execution } = flow;
    await assert.rejects(
      execution.run(),
      (error: unknown) =>
        error instanceof graph.DataflowNodeError &&
        error.nodeId === graph.NodeId.create("Reports") &&
        error.error instanceof Error &&
        error.error.message === expected,
    );
    assert.equal(execution.graph.result(execution.graph.sink.id)._tag, "None");
  });
