import { test } from "bun:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type {
  NodeAvailability,
  NodeIdType,
  ParentView,
  Schedule,
} from "../src/index.ts";
import {
  allOf,
  always,
  anyOf,
  EdgeId,
  NodeId,
  ReadyScheduler,
  RoundRobinScheduler,
  triggerInputs,
} from "../src/index.ts";

const EMPTY_VIEW: ParentView<number, string> = {
  messages: new Map(),
  values: new Map(),
};
const AVAILABLE: NodeAvailability<number, string> = {
  view: EMPTY_VIEW,
  trigger: always<number, string>(),
  satisfied: [],
};

const availableOf = (
  ...names: readonly string[]
): ReadonlyMap<NodeIdType, NodeAvailability<number, string>> =>
  new Map(names.map((name) => [NodeId(name), AVAILABLE]));

/** Existing assertions are about placement, not reads: project each plan back to its ids. */
const ids = (schedule: Schedule): NodeIdType[][] =>
  schedule.map((lane) => lane.map((entry) => entry.id));

test("ReadyScheduler: one lane per available node, in iteration order", () => {
  const scheduler = new ReadyScheduler<number, string>();
  scheduler.create(1, Number.POSITIVE_INFINITY);
  assert.deepEqual(ids(scheduler.schedule(availableOf("a", "b", "c"))), [
    ["a"],
    ["b"],
    ["c"],
  ]);
});

test("ReadyScheduler: nothing available plans nothing", () => {
  const scheduler = new ReadyScheduler<number, string>();
  scheduler.create(1, Number.POSITIVE_INFINITY);
  assert.deepEqual(ids(scheduler.schedule(availableOf())), []);
});

test("RoundRobinScheduler: 2x2 over 5 ids fills lanes round-robin then resumes at the leftover", () => {
  const scheduler = new RoundRobinScheduler<number, string>();
  scheduler.create(2, 2);
  const available = availableOf("a", "b", "c", "d", "e");
  assert.deepEqual(ids(scheduler.schedule(available)), [
    ["a", "c"],
    ["b", "d"],
  ]);
  assert.deepEqual(ids(scheduler.schedule(available)), [
    ["e", "b"],
    ["a", "c"],
  ]);
});

test("RoundRobinScheduler: capacity is clamped to the available count", () => {
  const scheduler = new RoundRobinScheduler<number, string>();
  scheduler.create(4, 4);
  assert.deepEqual(ids(scheduler.schedule(availableOf("a", "b", "c"))), [
    ["a"],
    ["b"],
    ["c"],
  ]);
});

test("RoundRobinScheduler: nothing available plans nothing", () => {
  const scheduler = new RoundRobinScheduler<number, string>();
  scheduler.create(2, 2);
  assert.deepEqual(ids(scheduler.schedule(availableOf())), []);
});

test("RoundRobinScheduler: plans are duplicate-free, exactly min(n, threads*window) wide, within lane bounds", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), {
        minLength: 1,
        maxLength: 12,
      }),
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 1, max: 4 }),
      (names, threads, window) => {
        const scheduler = new RoundRobinScheduler<number, string>();
        scheduler.create(window, threads);
        const schedule = scheduler.schedule(availableOf(...names));
        const flat = schedule.flat().map((entry) => entry.id);

        assert.equal(flat.length, Math.min(names.length, threads * window));
        assert.equal(new Set(flat).size, flat.length);
        assert.ok(schedule.length <= threads);
        for (const lane of schedule) assert.ok(lane.length <= window);
        for (const id of flat) assert.ok(names.includes(id as string));
      },
    ),
  );
});

test("RoundRobinScheduler: rotation eventually reaches every starved node", () => {
  const scheduler = new RoundRobinScheduler<number, string>();
  scheduler.create(1, 1);
  const available = availableOf("a", "b", "c");
  const seen = [
    ids(scheduler.schedule(available)).flat(),
    ids(scheduler.schedule(available)).flat(),
    ids(scheduler.schedule(available)).flat(),
  ].flat();
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("triggerInputs: `all` reads every rule edge whole, `any` reads only the first satisfied edge", () => {
  const a = EdgeId("a");
  const b = EdgeId("b");
  const view = EMPTY_VIEW;

  const conjunction = allOf<number, string>(a, b);
  assert.deepEqual(
    [...triggerInputs({ view, trigger: conjunction, satisfied: [a, b] })],
    [
      [a, "all"],
      [b, "all"],
    ],
  );
  // Atomicity: a partially satisfied `all` reads nothing.
  assert.deepEqual(
    [...triggerInputs({ view, trigger: conjunction, satisfied: [a] })],
    [],
  );

  const disjunction = anyOf<number, string>(a, b);
  assert.deepEqual(
    [...triggerInputs({ view, trigger: disjunction, satisfied: [b, a] })],
    [[b, "all"]],
  );
  assert.deepEqual(
    [...triggerInputs({ view, trigger: disjunction, satisfied: [] })],
    [],
  );
});
