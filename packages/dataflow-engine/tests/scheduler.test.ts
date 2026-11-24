import { test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ParentView } from "../src/index.ts";
import {
  Edge,
  TriggerEntry,
  TriggerRule,
  triggerInputs,
} from "../src/index.ts";

const NumberSchema = Type.Number();

const EMPTY_VIEW: ParentView<typeof NumberSchema, string> = {
  messages: new Map(),
  values: new Map(),
};

test("triggerInputs: `all` reads every rule edge whole, `any` reads only the first satisfied edge", () => {
  const edgeA = Edge.message<typeof NumberSchema, string>("a", NumberSchema);
  const edgeB = Edge.message<typeof NumberSchema, string>("b", NumberSchema);
  const a = edgeA.id;
  const b = edgeB.id;
  const view = EMPTY_VIEW;
  const status = "ready";

  const conjunction = TriggerRule.allOf(
    TriggerEntry.on(edgeA),
    TriggerEntry.on(edgeB),
  );
  assert.deepEqual(
    [
      ...triggerInputs({
        view,
        trigger: conjunction,
        satisfied: [a, b],
        continuationOnly: false,
        status,
      }),
    ],
    [
      [a, "all"],
      [b, "all"],
    ],
  );
  // A continuation can be admitted before the next atomic join is ready.
  assert.deepEqual(
    [
      ...triggerInputs({
        view,
        trigger: conjunction,
        satisfied: [a],
        continuationOnly: true,
        status: "running",
      }),
    ],
    [],
  );

  const disjunction = TriggerRule.anyOf(
    TriggerEntry.on(edgeA),
    TriggerEntry.on(edgeB),
  );
  assert.deepEqual(
    [
      ...triggerInputs({
        view,
        trigger: disjunction,
        satisfied: [b, a],
        continuationOnly: false,
        status,
      }),
    ],
    [[b, "all"]],
  );
  assert.deepEqual(
    [...triggerInputs({ view, trigger: disjunction, satisfied: [], status, continuationOnly: false })],
    [],
  );
});
