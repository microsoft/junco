import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBtrfsFixtureCommand } from "./btrfs-fixture.mjs";

// `extension.btrfs.mjs` only runs with an owned fixture as its working directory, so a general
// runner (plain `bun test`) reaches it through the fixture owner, under Node like `test:btrfs`.
test("the packaged extension lane passes in an owned btrfs fixture", {
  timeout: 240_000,
}, async () => {
  const suite = fileURLToPath(
    new URL("./extension.btrfs.mjs", import.meta.url),
  );
  const status = await runBtrfsFixtureCommand("node", [
    "--test",
    "--test-concurrency=1",
    suite,
  ]);
  assert.equal(status, 0);
});
