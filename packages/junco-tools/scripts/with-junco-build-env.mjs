#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const [executable, ...args] = process.argv.slice(2);
if (!executable) {
  console.error("Usage: with-junco-build-env.mjs <executable> [arguments...]");
  process.exitCode = 2;
} else {
  const env = { ...process.env };
  env.CARGO_HOME ??= join(homedir(), ".local/share/junco-tools/cargo");
  env.RUSTUP_HOME ??= join(homedir(), ".local/share/junco-tools/rustup");
  env.PATH = `${join(env.CARGO_HOME, "bin")}${delimiter}${env.PATH ?? ""}`;
  env.CARGO = join(env.CARGO_HOME, "bin/cargo");
  // Compiles `xutf` (pi-edit's transitive nightly-only dependency) with the
  // unstable-feature escape hatch while every other crate, junco's included,
  // stays on plain stable rustc. See scripts/rustc-bootstrap-shim.sh.
  env.RUSTC_WRAPPER ??= fileURLToPath(new URL("rustc-bootstrap-shim.sh", import.meta.url));
  env.CARGO_NET_GIT_FETCH_WITH_CLI = "true";
  env.GIT_TERMINAL_PROMPT = "0";

  const child = spawn(executable, args, { env, cwd: process.cwd(), stdio: "inherit", shell: false });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let failed = false;
  child.on("error", (error) => {
    failed = true;
    console.error(`Failed to spawn ${executable}: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (failed) return;
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
