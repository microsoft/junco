#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runBtrfsFixtureCommand } from "../tests/btrfs-fixture.mjs";

// Resolved here, before the child's working directory becomes the disposable fixture root.
const suites = [
  fileURLToPath(new URL("../tests/btrfs-fixture.test.mjs", import.meta.url)),
  fileURLToPath(new URL("../tests/extension.btrfs.test.mjs", import.meta.url)),
];

if (process.argv.length > 2) {
  console.error("Usage: test-btrfs.mjs");
  process.exitCode = 2;
} else {
  // The deadline belongs to the child suites; the fixture owner outlives it to reclaim the seed.
  process.exitCode = await runBtrfsFixtureCommand("timeout", [
    "--signal=TERM",
    "--kill-after=5s",
    "240s",
    process.execPath,
    "--test",
    "--test-concurrency=1",
    ...suites,
  ]);
}
