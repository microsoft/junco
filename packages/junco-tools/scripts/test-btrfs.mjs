#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { runBtrfsFixtureCommand } from "../tests/btrfs-fixture.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);
// Resolved here, before the child's working directory becomes the disposable fixture root.
const suites = [
  fileURLToPath(new URL("../tests/btrfs-fixture.btrfs.mjs", import.meta.url)),
  fileURLToPath(new URL("../tests/extension.btrfs.mjs", import.meta.url)),
];

/** `command`'s exit status; this process's termination signals are forwarded to it. */
async function run(command, args, stdio = "inherit") {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const child = spawn(command, args, { stdio });
  const forward = (signal) => child.kill(signal);
  for (const signal of signals) process.on(signal, forward);
  try {
    return await new Promise((resolve) => {
      child.once("error", (error) => {
        console.error(`${command}: ${error.message}`);
        resolve(127);
      });
      child.once("close", (code, signal) =>
        resolve(code ?? 128 + constants.signals[signal]),
      );
    });
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
}

if (process.argv.length > 2) {
  console.error("Usage: test-btrfs.mjs");
  process.exitCode = 2;
} else if (process.env.JUNCO_BTRFS_TEST_ROOT === undefined) {
  // No configured base: rerun this lane in the CI image over this checkout and its host builds,
  // on a fresh loop btrfs that `ci/btrfs-bind-run.sh` mounts and names in JUNCO_BTRFS_TEST_ROOT.
  // `--init` reaps the orphaned grandchildren the suites kill; a bare PID 1 keeps them as zombies.
  process.exitCode =
    (await run(
      "docker",
      ["build", "--quiet", "--tag", "junco-ci", `${repository}/ci`],
      ["ignore", "ignore", "inherit"],
    )) ||
    (await run("docker", [
      "run",
      "--rm",
      "--init",
      "--privileged",
      "--volume",
      `${repository}:${repository}`,
      "--env",
      `HOST_UID=${process.getuid()}`,
      "--env",
      `HOST_GID=${process.getgid()}`,
      "--entrypoint",
      `${repository}/ci/btrfs-bind-run.sh`,
      "junco-ci",
      "node",
      fileURLToPath(import.meta.url),
    ]));
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
