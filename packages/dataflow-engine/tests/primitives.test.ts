import { test } from "bun:test";
import assert from "node:assert/strict";
import type { EdgeIdType, ParentView } from "../src/index.ts";
import { emptyQueue, from, messageEdge, Queue } from "../src/index.ts";

test("Queue wraps its backing array: pushes and consumption mutate that store", () => {
  const backing = [1, 2];
  const queue = Queue(backing);
  queue.push(3);
  const consumed = queue.splice(0, 2);
  assert.deepEqual(consumed, [1, 2]);
  assert.deepEqual(backing, [3]);
});

test("emptyQueue results are independent stores", () => {
  const left = emptyQueue<string>();
  const right = emptyQueue<string>();
  left.push("l1", "l2");
  right.push("r1");
  assert.deepEqual(left.splice(0, 1), ["l1"]);
  assert.deepEqual([...left], ["l2"]);
  assert.deepEqual([...right], ["r1"]);
});

test("from returns a present edge's batch and an empty batch for an absent edge", () => {
  const present = messageEdge<number, string>("present");
  const absent = messageEdge<number, string>("absent");
  const view: ParentView<number, string> = {
    messages: new Map<EdgeIdType, readonly number[]>([[present.id, [7, 9]]]),
    values: new Map<EdgeIdType, string>(),
  };
  assert.deepEqual(from(view, present), [7, 9]);
  assert.deepEqual(from(view, absent), []);
});
