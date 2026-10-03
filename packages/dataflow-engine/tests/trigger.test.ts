import { test } from "bun:test";
import assert from "node:assert/strict";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { Edge, EdgeIdType } from "../src/index.ts";
import {
  allOf,
  always,
  anyOf,
  DataflowDefinitionError,
  EdgeId,
  evaluateTrigger,
  messageEdge,
  NodeId,
  never,
  on,
  satisfiedEdges,
  valueEdge,
} from "../src/index.ts";

const NODE = NodeId("n");

/** A fresh message edge preloaded with `items`, so each test owns its own queue state. */
const msgEdge = (
  id: string,
  items: readonly number[] = [],
): Edge<number, string> => {
  const edge = messageEdge<number, string>(id);
  if (E.isLeft(edge.transport)) edge.transport.left.push(...items);
  return edge;
};

/** A fresh value edge, resolved to `value` when one is given and left unresolved otherwise. */
const valEdge = (id: string, value?: string): Edge<number, string> => {
  const edge = valueEdge<number, string>(id);
  if (value !== undefined) edge.transport = E.right(O.some(value));
  return edge;
};

const inboundOf = (
  ...edges: readonly Edge<number, string>[]
): ReadonlyMap<EdgeIdType, Edge<number, string>> =>
  new Map(edges.map((edge) => [edge.id, edge]));

test("all: fires only when every entry has something queued", () => {
  const fire = (
    aItems: readonly number[],
    bItems: readonly number[],
  ): boolean => {
    const a = msgEdge("a", aItems);
    const b = msgEdge("b", bItems);
    return evaluateTrigger(
      allOf<number, string>(on(a), on(b)),
      inboundOf(a, b),
      NODE,
    );
  };
  assert.equal(fire([1], []), false);
  assert.equal(fire([], [1]), false);
  assert.equal(fire([1], [2]), true);
});

test("any: fires as soon as one entry has something queued", () => {
  const fire = (
    aItems: readonly number[],
    bItems: readonly number[],
  ): boolean => {
    const a = msgEdge("a", aItems);
    const b = msgEdge("b", bItems);
    return evaluateTrigger(
      anyOf<number, string>(on(a), on(b)),
      inboundOf(a, b),
      NODE,
    );
  };
  assert.equal(fire([], []), false);
  assert.equal(fire([1], []), true);
  assert.equal(fire([], [1]), true);
});

test("empty rule: all/always fire, any/never do not", () => {
  const a = msgEdge("a");
  const b = msgEdge("b");
  const inbound = inboundOf(a, b);
  assert.equal(evaluateTrigger(always<number, string>(), inbound, NODE), true);
  assert.equal(evaluateTrigger(allOf<number, string>(), inbound, NODE), true);
  assert.equal(evaluateTrigger(never<number, string>(), inbound, NODE), false);
  assert.equal(evaluateTrigger(anyOf<number, string>(), inbound, NODE), false);
});

test("an entry is satisfied at any non-zero queue length, not at zero", () => {
  const fire = (items: readonly number[]): boolean => {
    const a = msgEdge("a", items);
    return evaluateTrigger(allOf<number, string>(on(a)), inboundOf(a), NODE);
  };
  assert.equal(fire([]), false);
  assert.equal(fire([1]), true);
  assert.equal(fire([1, 2, 3, 4, 5, 6, 7, 8, 9]), true);
});

test("value edge: unresolved is unsatisfied, resolved is satisfied", () => {
  const check = (value: string | undefined): boolean => {
    const v = valEdge("v", value);
    return evaluateTrigger(allOf<number, string>(on(v)), inboundOf(v), NODE);
  };
  assert.equal(check(undefined), false);
  assert.equal(check("done"), true);
});

test("satisfiedEdges: rule insertion order, satisfied subset only", () => {
  const satisfied = (
    aItems: readonly number[],
    bItems: readonly number[],
    cItems: readonly number[],
  ): readonly EdgeIdType[] => {
    const a = msgEdge("a", aItems);
    const b = msgEdge("b", bItems);
    const c = msgEdge("c", cItems);
    return satisfiedEdges(
      anyOf<number, string>(on(c), on(a), on(b)),
      inboundOf(a, b, c),
      NODE,
    );
  };
  assert.deepEqual(satisfied([1], [2], [3]), [
    EdgeId("c"),
    EdgeId("a"),
    EdgeId("b"),
  ]);
  assert.deepEqual(satisfied([], [2], []), [EdgeId("b")]);
  assert.deepEqual(satisfied([], [], []), []);
});

test("rule key outside the node's inbound set is a definition error", () => {
  const a = msgEdge("a");
  const b = msgEdge("b");
  assert.throws(
    () => evaluateTrigger(allOf<number, string>(on(b)), inboundOf(a), NODE),
    DataflowDefinitionError,
  );
});

test("all: a later rule entry outside the inbound set still throws when an earlier entry is unsatisfied", () => {
  const a = msgEdge("a");
  const b = msgEdge("b");
  assert.throws(
    () =>
      evaluateTrigger(allOf<number, string>(on(a), on(b)), inboundOf(a), NODE),
    DataflowDefinitionError,
  );
});

test("a duplicated edge id in one rule is a definition error", () => {
  const a = msgEdge("a");
  assert.throws(
    () => allOf<number, string>(on(a), on(a)),
    DataflowDefinitionError,
  );
  assert.throws(
    () => anyOf<number, string>(on(a), on(a)),
    DataflowDefinitionError,
  );
});
