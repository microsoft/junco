import { test } from "bun:test";
import assert from "node:assert/strict";
import { bytes, gigabytes, mebibytes, megabytes } from "../src/index.ts";

test("information units distinguish decimal and binary scales", () => {
  assert.equal(megabytes(3000).in(gigabytes).amount, 3);
  assert.equal(mebibytes(1).in(bytes).amount, 1048576);
});
