import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DataflowDefinitionError,
  DataflowGraph,
  NodeId,
  type ResourceKind,
  recordResourceMeasurement,
  TriggerRule,
  UNBOUNDED,
} from "dataflow-engine";
import type { TSchema } from "typebox";
import { context, parallel, type Snapshot } from "../src/index.ts";

test("each scheduler step sees only its nodes' latest requested measurements", async () => {
  const graph = new DataflowGraph<void, TSchema, void, never>(
    UNBOUNDED,
    UNBOUNDED,
  );
  const a = NodeId.create("A");
  const b = NodeId.create("B");
  for (const [id, start] of [
    [a, 0],
    [b, 40],
  ] as const) {
    graph.addNode({
      id,
      state: undefined,
      trigger: TriggerRule.always(),
      step: async function* () {
        for (let i = start; ; i += 2) {
          await Promise.resolve();
          recordResourceMeasurement("tokens", i);
          recordResourceMeasurement("tokens", i + 1);
          recordResourceMeasurement("memory", i * 100);
          recordResourceMeasurement("cost", 12);
          yield [];
        }
      },
    });
  }
  type View = Snapshot<void, TSchema, void, never>;
  const views: View["measurements"][] = [];
  const windows = new Map<ResourceKind, number>([
    ["tokens", 3],
    ["memory", 1],
    ["runtime", 2],
    ["cost", 0],
  ]);
  const execution = context({
    graph,
    measurementWindows: windows,
    scheduler: (snapshot) => {
      views.push(snapshot.measurements);
      return parallel()(snapshot);
    },
  });
  windows.clear();
  for (let i = 0; i < 5; i++) await execution.step();
  assert.equal(views[0]!.size, 0);
  assert.deepEqual(views[1]!.get(a)?.get("tokens"), [0, 1]);
  assert.deepEqual(views[4]!.get(a)?.get("tokens"), [5, 6, 7]);
  assert.deepEqual(views[4]!.get(b)?.get("tokens"), [45, 46, 47]);
  assert.deepEqual(views[4]!.get(a)?.get("memory"), [600]);
  assert.equal(views[4]!.get(b)?.has("cost"), false);
  const runtime = views[4]!.get(a)?.get("runtime");
  assert.equal(runtime?.length, 2);
  assert.ok(runtime?.every((n) => Number.isSafeInteger(n) && n >= 0));
  const fresh: number[] = [];
  const disabled = context({
    graph,
    scheduler: (s) => {
      fresh.push(s.measurements.size);
      return parallel()(s);
    },
  });
  await disabled.step();
  await disabled.step();
  assert.deepEqual(fresh, [0, 0]);
});

test("invalid window sizes fail at construction, before any work", () => {
  const graph = new DataflowGraph<void, TSchema, void, never>(
    UNBOUNDED,
    UNBOUNDED,
  );
  for (const n of [-1, 1.5, Infinity, NaN]) {
    assert.throws(
      () =>
        context({
          graph,
          scheduler: parallel(),
          measurementWindows: new Map([["tokens", n]]),
        }),
      DataflowDefinitionError,
    );
  }
});
