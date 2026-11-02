import { test } from "bun:test";
import assert from "node:assert/strict";
import { ExampleTracer } from "../examples/tracing.ts";
import { runWordCount } from "../examples/word-count.ts";

test("cookbook: OR-trigger unified word counter from split outputs", async () => {
  const tracer = ExampleTracer.create("cookbook/or-unified-counter");
  const { unifiedCounts, totalChars, unifiedFireCount, completed, sourceId } =
    await runWordCount(tracer);
  const expected: [string, number][] = [
    ["A", 2],
    ["fantastic", 1],
    ["new", 2],
    ["of", 1],
    ["point", 1],
    ["view", 1],
    ["whole", 1],
    ["world", 1],
  ];
  assert.deepEqual([...unifiedCounts.entries()].sort(), expected.sort());
  assert.deepEqual(totalChars, [46]);
  assert.equal(unifiedFireCount, 2);
  assert.equal(completed.get(sourceId), "source done");
});
