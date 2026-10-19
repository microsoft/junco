import { test } from "bun:test";
import assert from "node:assert/strict";
import { runTokenRace } from "../examples/resource-scenarios.ts";
import { ExampleTracer } from "../examples/tracing.ts";

test("cookbook: the cheapest token racer wins and losers never start", async () => {
  const tracer = ExampleTracer.create("cookbook/token-race");
  try {
    const { winner, waves, started, completedRacers } =
      await runTokenRace(tracer);
    assert.equal(winner, "R2");
    assert.deepEqual(waves, [["R2"], ["join"], ["join"], ["R2"]]);
    assert.deepEqual(started, ["R2"]);
    assert.deepEqual(completedRacers, ["R2"]);
  } finally {
    await tracer.flush();
  }
});
