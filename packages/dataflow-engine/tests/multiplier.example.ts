import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { runMultiplier } from "../examples/multiplier.ts";
import { ExampleTracer } from "../examples/tracing.ts";

test("cookbook: end-to-end three stage multiplier graph", async () => {
  const tracer = ExampleTracer.create("cookbook/multiplier");
  try {
    const { results, completed, graph, sourceId, multiplierId, sinkId } =
      await runMultiplier(tracer);
    assert.deepEqual(results, [2, 4, 6]);
    assert.equal(completed.get(sourceId), "source done");
    // Multiplier & sink never return: `graph.result(id)` stays `O.none`.
    assert.equal(completed.has(multiplierId), false);
    assert.equal(completed.has(sinkId), false);
    assert.deepEqual(graph.result(multiplierId), O.none);
    assert.deepEqual(graph.result(sinkId), O.none);
  } finally {
    await tracer.flush();
  }
});
