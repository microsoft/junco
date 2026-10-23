import { test } from "bun:test";
import assert from "node:assert/strict";
import * as O from "fp-ts/lib/Option.js";
import { runFibonacci } from "../examples/fibonacci.ts";
import { ExampleTracer } from "../examples/tracing.ts";

test("cookbook: fibonacci via self-loop", async () => {
  const tracer = ExampleTracer.create("cookbook/fibonacci");
  try {
    const { results, completed, graph, fibId, sinkId } =
      await runFibonacci(tracer);
    assert.deepEqual(results, [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
    assert.equal(completed.get(fibId), "emitted 10 fibs");
    assert.equal(completed.has(sinkId), false);
    assert.deepEqual(graph.result(sinkId), O.none);
  } finally {
    await tracer.flush();
  }
});
