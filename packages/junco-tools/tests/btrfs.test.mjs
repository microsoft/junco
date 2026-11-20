import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The Btrfs suites run only as fixture children, so a general runner (plain `bun test`) reaches
// them through `test:btrfs`: in Docker unless JUNCO_BTRFS_TEST_ROOT names a btrfs base.
test("the Btrfs lane passes", { timeout: 600_000 }, async () => {
  const script = fileURLToPath(
    new URL("../scripts/test-btrfs.mjs", import.meta.url),
  );
  const child = spawn("node", [script], { stdio: "inherit" });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (...status) => resolve(status));
  });
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});
