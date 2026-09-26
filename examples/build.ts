import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";

/** The standalone example programs, in the order `run.ts` executes them. */
export const standaloneNames = [
  "fibonacci",
  "multiplier",
  "word-count",
  "combine-per-key",
] as const;

const examplesDir = import.meta.dir;
const engineDir = resolve(examplesDir, "..");

const OPIK_BUILD_FAILED =
  "Opik example build failed. Install the optional dependencies in examples/ or use --no-tracing.";

/** Run `command` from the engine root with inherited stdio, failing on a nonzero exit. */
async function spawnStep(label: string, command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: engineDir,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
}

/**
 * Typecheck, preflight (Opik only) and bundle every example with the selected tracer, returning the
 * absolute paths of the compiled programs. Rejects before returning any path if a step fails, so a
 * caller can never execute a stale bundle.
 */
export async function buildExamples(noTracing = false): Promise<{
  outdir: string;
  standalone: readonly string[];
  cookbook: readonly string[];
}> {
  const standaloneSources = standaloneNames.map((name) =>
    join(engineDir, "examples", `${name}.ts`),
  );
  const cookbookSources = Array.from(
    new Glob("tests/*.example.ts").scanSync({ cwd: engineDir }),
    (path) => join(engineDir, path),
  ).sort();
  const outdir = join(examplesDir, "dist", noTracing ? "dummy" : "opik");
  const outputOf = (source: string) =>
    join(outdir, relative(engineDir, source).replace(/\.ts$/, ".js"));

  try {
    await spawnStep("Example typecheck", [
      "bun",
      "run",
      "--bun",
      "tsc",
      "-p",
      "examples/tsconfig.json",
      ...(noTracing ? ["--customConditions", "dataflow-no-tracing"] : []),
    ]);
    if (!noTracing) {
      // Constructs the SDK client, validating the current Opik configuration. Creates no trace.
      await spawnStep("Opik SDK preflight", [
        "bun",
        "--no-install",
        "--eval",
        'import "./examples/tracing-opik.ts";',
      ]);
    }

    rmSync(outdir, { recursive: true, force: true });
    const result = await Bun.build({
      entrypoints: [...standaloneSources, ...cookbookSources],
      root: engineDir,
      outdir,
      target: "bun",
      format: "esm",
      packages: "bundle",
      splitting: true,
      sourcemap: "external",
      env: "disable",
      naming: { entry: "[dir]/[name].[ext]" },
      tsconfig: join(examplesDir, "tsconfig.json"),
      conditions: noTracing ? ["dataflow-no-tracing"] : [],
      throw: false,
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error("Example bundling failed");
    }
  } catch (error) {
    if (!noTracing) console.error(OPIK_BUILD_FAILED);
    throw error;
  }

  return {
    outdir,
    standalone: standaloneSources.map(outputOf),
    cookbook: cookbookSources.map(outputOf),
  };
}

if (import.meta.main) {
  let noTracing = false;
  for (const argument of process.argv.slice(2)) {
    if (argument !== "--no-tracing") {
      console.error(`Unknown examples build argument: ${argument}`);
      process.exit(2);
    }
    noTracing = true;
  }
  try {
    const { outdir } = await buildExamples(noTracing);
    console.error(`Examples built into ${outdir}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
