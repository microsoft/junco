import { test } from "bun:test";
import assert from "node:assert/strict";
import { runMemoryLimit } from "../examples/resource-scenarios.ts";
import { ExampleTracer } from "../examples/tracing.ts";

test("cookbook: memory limit never pairs two 3000 MB sinks under 4 GB", async () => {
  const tracer = ExampleTracer.create("cookbook/memory-limit");
  try {
    const { waves, consumed, sourceResult } = await runMemoryLimit(tracer);
    assert.deepEqual(waves, [["source"], ["source", "A", "D"], ["A", "D"], ["B"], ["B"], ["C"], ["C"]]);
    assert.ok(waves.every(wave => !(wave.includes("A") && wave.includes("B"))));
    assert.deepEqual(consumed, ["A", "D", "B", "C"]);
    assert.equal(sourceResult, "source done");
  } finally {
    await tracer.flush();
  }
});
