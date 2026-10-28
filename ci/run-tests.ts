#!/usr/bin/env bun
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(
  repository,
  "packages/junco-tools/scripts/with-junco-build-env.mjs",
);
const signalStatus = (signal: NodeJS.Signals) =>
  128 + osConstants.signals[signal];

async function main(argv: string[]): Promise<number> {
  const [scope, ...options] = argv;
  if (options[0] === "--") options.shift();
  const option = options[0];
  if (
    (scope !== "junco" && scope !== "marsh") ||
    options.length > 1 ||
    (option !== undefined &&
      (!option.startsWith("--btrfs=") || option.length === "--btrfs=".length))
  ) {
    console.error(
      "Usage: bun ci/run-tests.ts <junco|marsh> [--] [--btrfs=<existing-directory>]",
    );
    return 2;
  }

  const script = scope === "marsh" ? "test-marsh.sh" : "test.sh";
  const baseArgument = option?.slice("--btrfs=".length);
  let interrupted: NodeJS.Signals | undefined;
  let activeChild: ChildProcess | undefined;
  let scratch: string | undefined;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
  const handlers = signals.map((signal) => {
    const handler = () => {
      interrupted ??= signal;
      if (activeChild?.pid === undefined) return;
      try {
        // Each child owns its process group, so cancellation also reaches the wrapper's children.
        process.kill(-activeChild.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error(`Failed to forward ${signal}:`, error);
        }
      }
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  async function run(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    captureOutput = false,
  ): Promise<{ status: number; stdout: string }> {
    if (interrupted) return { status: signalStatus(interrupted), stdout: "" };
    let stdout = "";
    let failed = false;
    try {
      const child = spawn(executable, args, {
        cwd: repository,
        env,
        shell: false,
        detached: true,
        stdio: captureOutput ? ["inherit", "pipe", "inherit"] : "inherit",
      });
      activeChild = child;
      if (child.stdout) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
      }
      const status = await new Promise<number>((resolveStatus) => {
        child.once("error", (error) => {
          failed = true;
          console.error(`Failed to start ${executable}: ${error.message}`);
        });
        child.once("close", (code, signal) => {
          resolveStatus(
            interrupted
              ? signalStatus(interrupted)
              : failed
                ? 1
                : signal
                  ? signalStatus(signal)
                  : (code ?? 1),
          );
        });
      });
      return { status, stdout };
    } catch (error) {
      console.error(`Failed to run ${executable}:`, error);
      return { status: interrupted ? signalStatus(interrupted) : 1, stdout };
    } finally {
      activeChild = undefined;
    }
  }

  try {
    if (baseArgument === undefined) {
      const build = await run("docker", [
        "build",
        "--tag",
        "junco-ci",
        join(repository, "ci"),
      ]);
      if (build.status !== 0) return build.status;
      const args = [
        "run",
        "--rm",
        "--privileged",
        "--volume",
        `${repository}:/src:ro`,
      ];
      for (const name of ["CARGO_BUILD_JOBS", "BTRFS_SIZE"]) {
        if (process.env[name] !== undefined)
          args.push("--env", `${name}=${process.env[name]}`);
      }
      args.push("junco-ci", "bash", `ci/${script}`);
      return (await run("docker", args)).status;
    }

    const base = await realpath(baseArgument);
    if (!(await lstat(base)).isDirectory()) {
      throw new Error(`Btrfs allocation base is not a real directory: ${base}`);
    }
    await access(base, constants.W_OK | constants.X_OK);
    const mountResult = await run(
      "findmnt",
      [
        "--json",
        "--first-only",
        "--target",
        base,
        "--output",
        "FSTYPE,OPTIONS,TARGET",
      ],
      process.env,
      true,
    );
    if (mountResult.status !== 0) return mountResult.status;
    let mount:
      | { fstype?: string; options?: string; target?: string }
      | undefined;
    try {
      mount = JSON.parse(mountResult.stdout)?.filesystems?.[0];
    } catch (cause) {
      throw new Error(`findmnt produced invalid JSON for ${base}`, { cause });
    }
    const mountOptions =
      typeof mount?.options === "string" ? mount.options.split(",") : [];
    if (
      mount?.fstype !== "btrfs" ||
      !mountOptions.includes("rw") ||
      mountOptions.includes("ro") ||
      !mountOptions.includes("user_subvol_rm_allowed")
    ) {
      throw new Error(
        `--btrfs requires a writable Btrfs mount with user_subvol_rm_allowed: ${base} ` +
          `(${mount?.target ?? "unknown mount"}, ${mount?.fstype ?? "unknown filesystem"}, ${mount?.options ?? "no options"})`,
      );
    }
    if (interrupted) return signalStatus(interrupted);

    // Resolve the original user's Rust homes before giving the child an isolated Btrfs HOME.
    const env = { ...process.env };
    env.CARGO_HOME ??= join(homedir(), ".local/share/junco-tools/cargo");
    env.RUSTUP_HOME ??= join(homedir(), ".local/share/junco-tools/rustup");
    scratch = await mkdtemp(join(base, ".junco-tests-"));
    const identity = await lstat(scratch, { bigint: true });
    if (!identity.isDirectory())
      throw new Error(`Scratch allocation is not a real directory: ${scratch}`);
    if (interrupted) return signalStatus(interrupted);
    env.HOME = join(scratch, "home");
    env.JUNCO_BTRFS_TEST_ROOT = join(scratch, "fixtures");
    await mkdir(env.HOME, { mode: 0o700 });
    if (interrupted) return signalStatus(interrupted);
    await mkdir(env.JUNCO_BTRFS_TEST_ROOT, { mode: 0o700 });

    const args = [wrapper, "bash", join(repository, "ci", script)];
    const inContainer = process.env.JUNCO_TEST_CONTAINER === "1";
    const outcome = inContainer
      ? await run("node", args, env)
      : await run(
          "systemd-run",
          ["--user", "--scope", "-p", "Delegate=yes", "--", "node", ...args],
          env,
        );
    if (outcome.status !== 0) {
      if (!inContainer && !interrupted) {
        console.error(
          "Local tests require systemd-run --user --scope -p Delegate=yes. " +
            "If the user manager or cgroup delegation is unavailable, use " +
            `${scope === "marsh" ? "bun test:marsh" : "bun run test"} without --btrfs for Docker.`,
        );
      }
      return outcome.status;
    }
    if (interrupted) return signalStatus(interrupted);

    const current = await lstat(scratch, { bigint: true });
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error(
        `Refusing cleanup: ${scratch} is no longer the original scratch directory`,
      );
    }
    if (interrupted) return signalStatus(interrupted);
    await rm(scratch, { recursive: true });
    scratch = undefined;
    return interrupted ? signalStatus(interrupted) : 0;
  } catch (error) {
    console.error("Test execution failed:", error);
    return interrupted ? signalStatus(interrupted) : 1;
  } finally {
    if (scratch !== undefined)
      console.error(`Retained test scratch directory: ${scratch}`);
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
