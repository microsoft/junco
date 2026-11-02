import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "fp-ts/lib/Either.js";
import { context } from "junco-scheduler";
import { Type } from "typebox";
import { graph, schedules, tracer, trigger, workflows } from "../src/index.ts";

// The root `graph`, `schedules`, `tracer` and `trigger` namespaces compose into one runnable graph:
// constant fan-out sources feed an ordered fan-in, a persistent sink and a one-shot marker.
test("root namespaces compose a fan-out/fan-in graph that runs once to quiescence", async () => {
  const NumberSchema = Type.Number();
  const ListSchema = Type.Array(NumberSchema);
  type Payload = typeof NumberSchema | typeof ListSchema;
  const observer = new tracer.DummyTracer();
  const g = new graph.DataflowGraph<void, Payload, string, never>(
    graph.Width.create(1),
    graph.Width.create(1),
    observer,
  );
  const execution = context({ graph: g, scheduler: schedules.roundRobin() });
  const a = graph.Edge.message<typeof NumberSchema, string>("a", NumberSchema);
  const b = graph.Edge.message<typeof NumberSchema, string>("b", NumberSchema);
  const list = graph.Edge.message<typeof ListSchema, string>(
    "list",
    ListSchema,
  );

  const left = g.addNode(
    new graph.nodes.ConstFanout(1, [a], { state: undefined, ret: "left" }),
  );
  const right = g.addNode(
    new graph.nodes.ConstFanout(2, [b], { state: undefined, ret: "right" }),
  );
  const join = g.addNode(
    new graph.nodes.ConstFanin([b, a], list, {
      state: undefined,
      ret: "joined",
    }),
  );
  const seen: number[][] = [];
  const sink = g.addNode(
    new graph.nodes.StepNode<void, Payload, string>(
      (_state, view) => {
        seen.push(...graph.from(view, list));
        return [];
      },
      {
        state: undefined,
        trigger: trigger.TriggerRule.when(list),
      },
    ),
  );
  const marker = g.addNode(
    new graph.nodes.EmitOnce<void, Payload, string>(() => [], "marker", {
      state: undefined,
      trigger: graph.trigger.TriggerRule.always(),
    }),
  );
  g.addEdge(left, join, a).addEdge(right, join, b).addEdge(join, sink, list);

  const results = await execution.run();
  assert.deepEqual(seen, [[2, 1]]);
  assert.equal(results.get(left), "left");
  assert.equal(results.get(right), "right");
  assert.equal(results.get(join), "joined");
  assert.equal(results.get(marker), "marker");
  assert.ok(E.isLeft(list.transport));
  assert.deepEqual([...list.transport.left], []);

  const again = await execution.run();
  assert.deepEqual(seen, [[2, 1]]);
  assert.deepEqual([...again], [...results]);
});

// Every runtime export of the std namespaces has a row in the AGENTS.md index (type-only exports
// are listed by hand). `graph.trigger` is the `trigger` module and is covered by its rows.
test("every runtime std export is indexed in AGENTS.md", () => {
  const index = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const namespaces: Record<string, object> = {
    graph,
    "graph.nodes": graph.nodes,
    trigger,
    schedules,
    tracer,
    workflows,
  };
  const missing = Object.entries(namespaces).flatMap(([namespace, members]) =>
    Object.keys(members)
      .filter((name) => !index.includes(`\`${namespace}.${name}\``))
      .map((name) => `${namespace}.${name}`),
  );
  assert.deepEqual(missing, []);
});
