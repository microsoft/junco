import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ParentView } from "../src/index.ts";
import { allOf, anyOf, EdgeId, triggerInputs } from "../src/index.ts";

const EMPTY_VIEW: ParentView<number, string> = {
  messages: new Map(),
  values: new Map(),
};

test("triggerInputs: `all` reads every rule edge whole, `any` reads only the first satisfied edge", () => {
  const a = EdgeId("a");
  const b = EdgeId("b");
  const view = EMPTY_VIEW;
  const status = "ready";

  const conjunction = allOf<number, string>(a, b);
  assert.deepEqual(
    [
      ...triggerInputs({
        view,
        trigger: conjunction,
        satisfied: [a, b],
        status,
      }),
    ],
    [
      [a, "all"],
      [b, "all"],
    ],
  );
  // Atomicity: a partially satisfied `all` reads nothing. Only a started actor kept available by
  // its own hook can be admitted in that state.
  assert.deepEqual(
    [
      ...triggerInputs({
        view,
        trigger: conjunction,
        satisfied: [a],
        status: "running",
      }),
    ],
    [],
  );

  const disjunction = anyOf<number, string>(a, b);
  assert.deepEqual(
    [
      ...triggerInputs({
        view,
        trigger: disjunction,
        satisfied: [b, a],
        status,
      }),
    ],
    [[b, "all"]],
  );
  assert.deepEqual(
    [...triggerInputs({ view, trigger: disjunction, satisfied: [], status })],
    [],
  );
});
