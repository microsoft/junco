import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL(".", import.meta.url));
const owner = "junco\n";

async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function bundledSkills(sourceRoot: string): Promise<string[]> {
  const names: string[] = [];
  for (const child of await readdir(sourceRoot, { withFileTypes: true })) {
    if (
      child.isDirectory() &&
      (await entry(join(sourceRoot, child.name, "SKILL.md")))?.isFile()
    ) {
      names.push(child.name);
    }
  }
  if (names.length === 0) throw new Error(`No bundled skills in ${sourceRoot}`);
  return names.sort();
}

async function skillState(path: string) {
  const current = await entry(path);
  if (!current) return "missing";
  if (!current.isDirectory()) return "conflict";
  const marker = join(path, ".junco-installed");
  return (await entry(marker))?.isFile() &&
    (await readFile(marker, "utf8")) === owner
    ? "managed"
    : "conflict";
}

async function skillConflicts(
  names: readonly string[],
  roots: readonly string[],
) {
  const conflicts: string[] = [];
  for (const root of roots) {
    for (const name of names) {
      const path = join(root, name);
      if ((await skillState(path)) === "conflict") conflicts.push(path);
    }
  }
  return conflicts;
}

/** Copies whole bundled skills; only Junco-marked directories may be replaced. */
export async function installSkills(
  sourceRoot: string,
  targetRoots: readonly string[],
): Promise<void> {
  const names = await bundledSkills(sourceRoot);
  const roots = [...new Set(targetRoots.map((root) => resolve(root)))];
  const conflicts = await skillConflicts(names, roots);
  if (conflicts.length) {
    throw new Error(`Skill destination conflicts:\n${conflicts.join("\n")}`);
  }
  const installed: string[] = [];
  try {
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      for (const name of names) {
        const destination = join(root, name);
        const stage = await mkdtemp(join(root, `.junco-${name}-`));
        const payload = join(stage, "payload");
        const backup = join(stage, "previous");
        let displaced = false;
        try {
          await cp(join(sourceRoot, name), payload, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
          await writeFile(join(payload, ".junco-installed"), owner, {
            flag: "wx",
          });
          const state = await skillState(destination);
          if (state === "conflict") {
            throw new Error(`Skill destination conflict: ${destination}`);
          }
          if (state === "managed") {
            await rename(destination, backup);
            displaced = true;
          }
          try {
            await rename(payload, destination);
          } catch (error) {
            if (displaced) {
              try {
                await rename(backup, destination);
                displaced = false;
              } catch (restoreError) {
                throw new AggregateError(
                  [error, restoreError],
                  `Could not restore ${destination}; previous skill retained at ${backup}`,
                );
              }
            }
            throw error;
          }
          displaced = false;
          installed.push(destination);
        } finally {
          // A failed restoration leaves the only previous copy here; never delete it.
          if (!displaced) await rm(stage, { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    const partial = installed.length
      ? `\nInstalled before failure:\n${installed.join("\n")}`
      : "";
    throw new Error(`Skill installation failed.${partial}`, { cause: error });
  }
  for (const path of installed) console.log(`Installed skill: ${path}`);
}

function bun(args: string[], cwd = repository, capture = false): string {
  const child = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `bun ${args.join(" ")} failed (${child.signal ?? child.status})`,
    );
  }
  return child.stdout ?? "";
}

function configured(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

async function binConflict(path: string, target: string): Promise<boolean> {
  const current = await entry(path);
  if (!current) return false;
  if (!current.isSymbolicLink()) return true;
  if (resolve(dirname(path), await readlink(path)) === target) return false;
  try {
    return (await realpath(path)) !== (await realpath(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function main(args: string[]): Promise<number> {
  if (args.length) {
    console.error("Usage: bun run install");
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Junco installation requires an interactive terminal (stdin and stdout).",
    );
    return 2;
  }
  try {
    const home = homedir();
    if (!isAbsolute(home)) throw new Error("HOME must be an absolute path");
    const codex = configured("CODEX_HOME");
    const harnesses = [
      {
        id: "copilot",
        label: "GitHub Copilot CLI",
        root: join(
          configured("COPILOT_HOME") ?? join(home, ".copilot"),
          "skills",
        ),
      },
      {
        id: "claude",
        label: "Claude Code",
        root: join(
          configured("CLAUDE_CONFIG_DIR") ?? join(home, ".claude"),
          "skills",
        ),
      },
      {
        id: "pi",
        label: "Pi",
        root: join(
          configured("PI_CODING_AGENT_DIR") ?? join(home, ".pi/agent"),
          "skills",
        ),
      },
      {
        id: "codex",
        label: "OpenAI Codex",
        root: codex ? join(codex, "skills") : join(home, ".agents/skills"),
      },
      {
        id: "opencode",
        label: "OpenCode",
        root: join(
          configured("OPENCODE_CONFIG_DIR") ??
            join(
              configured("XDG_CONFIG_HOME") ?? join(home, ".config"),
              "opencode",
            ),
          "skills",
        ),
      },
    ];
    bun(["install", "--frozen-lockfile", "--ignore-scripts"]);
    const { default: checkbox } = await import("@inquirer/checkbox");
    console.log(
      "Codex's default .agents/skills is shared and may also be discovered by compatible harnesses.",
    );
    const selected = await checkbox({
      message: "Install Junco skills for which CLI harnesses?",
      choices: harnesses.map(({ id, label, root }) => ({
        name: `${label}: ${root}`,
        value: id,
      })),
      required: true,
    });
    const roots = [
      ...new Set(
        harnesses
          .filter(({ id }) => selected.includes(id))
          .map(({ root }) => root),
      ),
    ];
    const source = join(repository, "skills");
    const names = await bundledSkills(source);
    const bin = bun(["pm", "bin", "-g"], repository, true).replace(
      /\r?\n$/u,
      "",
    );
    if (!isAbsolute(bin))
      throw new Error(
        `Bun returned a non-absolute global bin directory: ${bin}`,
      );
    const executables = [
      ["junco-profile-optimizer", join(repository, "dist/optimizer-cli.js")],
      ["profile-fit", join(repository, "packages/dataflow-profile/src/cli.ts")],
    ] as const;
    const conflicts = await skillConflicts(names, roots);
    for (const [name, target] of executables) {
      const path = join(bin, name);
      if (await binConflict(path, target)) conflicts.push(path);
    }
    if (conflicts.length) {
      throw new Error(`Installation conflicts:\n${conflicts.join("\n")}`);
    }
    bun(["run", "build"]);
    for (const [, target] of executables) {
      const mode = (await lstat(target)).mode;
      if ((mode & 0o111) !== 0o111)
        await chmod(target, (mode & 0o7777) | 0o111);
    }
    bun(["link", "--ignore-scripts"]);
    console.log(`Registered junco from ${repository}`);
    bun(
      ["link", "--ignore-scripts"],
      join(repository, "packages/dataflow-profile"),
    );
    console.log(
      `Registered dataflow-profile from ${join(repository, "packages/dataflow-profile")}`,
    );
    await mkdir(bin, { recursive: true });
    for (const [name, target] of executables) {
      const path = join(bin, name);
      if (await binConflict(path, target))
        throw new Error(`Executable destination conflict: ${path}`);
      if (!(await entry(path))) await symlink(target, path);
      console.log(`Installed executable: ${path}`);
    }
    await installSkills(source, roots);
    console.log(
      "Consumers: bun link junco. Keep this checkout, its node_modules and built outputs in place.",
    );
    if (!(process.env.PATH ?? "").split(":").includes(bin)) {
      console.log(`export PATH='${bin.replaceAll("'", "'\\''")}':"$PATH"`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      console.error("Install cancelled; no global links or skills changed.");
      return 130;
    }
    console.error(error);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
