import { test } from "bun:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { formatTuiPayload } from "../src/tui-tracer.ts";

test("payload formatting snapshots immediately without application hooks", () => {
  let hooks = 0;
  const payload = {
    value: "before",
    bigint: 12345678901234567890n,
    long: "x".repeat(100_000),
    get computed() {
      hooks++;
      return "unsafe";
    },
    [inspect.custom]() {
      hooks++;
      return "unsafe";
    },
    cycle: undefined as unknown,
  };
  payload.cycle = payload;
  const formatted = formatTuiPayload(payload);
  payload.value = "after";
  assert.ok(formatted.includes("before"));
  assert.ok(!formatted.includes("after"));
  assert.ok(formatted.includes("12345678901234567890n"));
  assert.ok(formatted.includes(payload.long));
  assert.match(formatted, /Circular/);
  assert.equal(hooks, 0);
});

test("Error diagnostics retain data messages even when stack headers omit them", () => {
  const error = new Error("retained failure message");
  error.stack = "Error\n    at consumer";
  assert.ok(formatTuiPayload(error).includes("retained failure message"));
  let getters = 0;
  Object.defineProperty(error, "message", {
    get() {
      getters++;
      return "unsafe";
    },
  });
  formatTuiPayload(error);
  assert.equal(getters, 0);
});
