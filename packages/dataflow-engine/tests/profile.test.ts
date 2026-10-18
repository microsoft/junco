import { test } from "bun:test";
import assert from "node:assert/strict";
import { seconds } from "@buge/ts-units/time";
import { constantProfile, DataflowDefinitionError, DataflowGraph, Edge, EdgeId, NodeId, StepNode, TriggerRule, UNBOUNDED, bytes, gigabytes, mebibytes, megabytes, tokens, type ProfileData, type ResourceKind, type ResourceUnit } from "../src/index.ts";

function stub<R extends ResourceKind>(resource: R, unit: ResourceUnit<R>, ...ports: string[]): ProfileData<R> {
  return { resource, unit, features: ports.map(port => ({ port: EdgeId.create(port), measure: "count" })), predict: () => ({ value: 0, safe: 0, source: "model" }) };
}

test("unprofiled nodes expose the shared empty profiles through observations", () => {
  const graph = new DataflowGraph<void, number, string, never>(UNBOUNDED, UNBOUNDED);
  const id = graph.addNode(new StepNode<void, number, string>(() => [], { state: undefined, trigger: TriggerRule.always() }));
  assert.deepEqual(graph.getNode(id)!.profiles, {});
  assert.equal(graph.observe().nodes.get(id)!.profiles, graph.getNode(id)!.profiles);
});

test("resource keys cannot disguise another profile kind", () => {
  const graph = new DataflowGraph<void, number, string, never, "memory">(UNBOUNDED, UNBOUNDED);
  assert.throws(() => graph.addNode(new StepNode<void, number, string, "memory">(() => [], {
    state: undefined, trigger: TriggerRule.always(), profiles: { memory: stub("runtime", seconds) as never },
  })), error => error instanceof DataflowDefinitionError && error.message.includes('maps resource "memory"'));
});

test("profile ports must be inbound message edges at evaluation", async () => {
  const graph = new DataflowGraph<void, number, string, never, "memory">(UNBOUNDED, UNBOUNDED);
  const node = graph.addNode(new StepNode<void, number, string, "memory">(() => [], {
    id: NodeId.create("consumer"), state: undefined, trigger: TriggerRule.always(), profiles: { memory: stub("memory", megabytes, "x") },
  }));
  const rejects = () => assert.rejects(graph.evaluate(() => undefined), error => error instanceof DataflowDefinitionError && [node, "memory", "x"].every(s => error.message.includes(s)));
  await rejects();
  const source = graph.addNode(new StepNode<void, number, string, "memory">(() => [], {
    state: undefined, trigger: TriggerRule.always(), profiles: { memory: stub("memory", megabytes) },
  }));
  graph.addEdge(source, node, Edge.value("x"));
  await rejects();
  // A distinct consumer demonstrates valid wiring without mutating an existing edge.
  const valid = new DataflowGraph<void, number, string, never, "memory">(UNBOUNDED, UNBOUNDED);
  const src = valid.addNode(new StepNode<void, number, string, "memory">(() => [], { state: undefined, trigger: TriggerRule.always(), profiles: { memory: stub("memory", megabytes) } }));
  const dst = valid.addNode(new StepNode<void, number, string, "memory">(() => [], { state: undefined, trigger: TriggerRule.always(), profiles: { memory: stub("memory", megabytes, "x") } }));
  valid.addEdge(src, dst, Edge.message("x"));
  await valid.evaluate(() => undefined);
});

test("information units distinguish decimal and binary scales", () => {
  assert.equal(megabytes(3000).in(gigabytes).amount, 3);
  assert.equal(mebibytes(1).in(bytes).amount, 1048576);
});

test("constant profiles preserve quantities and reuse a frozen estimate", () => {
  const memory = constantProfile("memory", megabytes(3000));
  const token = constantProfile("tokens", tokens(10));
  const runtime = constantProfile("runtime", seconds(2));
  for (const [profile, unit, amount] of [[memory, megabytes, 3000], [token, tokens, 10], [runtime, seconds, 2]] as const) {
    assert.equal(profile.unit, unit);
    const estimate = profile.predict([]);
    assert.deepEqual(estimate, { value: amount, safe: amount, source: "fallback", reason: "constant" });
    assert.equal(profile.predict([1]), estimate);
    assert.ok(Object.isFrozen(estimate));
  }
  assert.equal(constantProfile("memory", megabytes(0)).predict([]).safe, 0);
  for (const amount of [-1, NaN, Infinity])
    assert.throws(() => constantProfile("memory", megabytes(amount)), error =>
      error instanceof DataflowDefinitionError && error.message === "constantProfile: memory must be a finite non-negative quantity");
});
