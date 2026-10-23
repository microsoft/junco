import { test } from "bun:test";
import assert from "node:assert/strict";
import { runCombinePerKey } from "../examples/combine-per-key.ts";
import { ExampleTracer } from "../examples/tracing.ts";

test("cookbook: combine-per-key sum and multiply from same source", async () => {
  const tracer = ExampleTracer.create("cookbook/combine-per-key");
  try {
    const { sums, products, completed, sourceId } =
      await runCombinePerKey(tracer);
    assert.deepEqual(
      sums.map((r) => [r.key, r.value]),
      [
        ["a", 6],
        ["b", 30],
        ["c", 100],
      ],
    );
    assert.deepEqual(
      products.map((r) => [r.key, r.value]),
      [
        ["a", 6],
        ["b", 200],
        ["c", 100],
      ],
    );
    assert.equal(completed.get(sourceId), "source done");
  } finally {
    await tracer.flush();
  }
});
