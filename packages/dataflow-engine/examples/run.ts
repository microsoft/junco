import { resolve } from "node:path";
import { buildExamples, standaloneNames } from "./build.ts";

const USAGE = `Invalid example arguments. Use [${[...standaloneNames, "--cookbook"].join("|")}] [--no-tracing].`;

/** Where traced examples export unless the caller sets `OPIK_URL_OVERRIDE`: a local Opik UI's API. */
const DEFAULT_OPIK_URL = "http://localhost:8888/api";

const isStandaloneName = (
  argument: string,
): argument is (typeof standaloneNames)[number] =>
  (standaloneNames as readonly string[]).includes(argument);

let name: (typeof standaloneNames)[number] | undefined;
let cookbook = false;
let noTracing = false;
for (const argument of process.argv.slice(2)) {
  if (argument === "--no-tracing" && !noTracing) noTracing = true;
  else if (argument === "--cookbook" && !cookbook) cookbook = true;
  else if (isStandaloneName(argument) && name === undefined) name = argument;
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
if (name !== undefined && cookbook) {
  console.error(USAGE);
  process.exit(2);
}

// Traced programs inherit the local default unless the caller configured an endpoint.
if (!noTracing) process.env.OPIK_URL_OVERRIDE ??= DEFAULT_OPIK_URL;

const built = await buildExamples(noTracing).catch((error: unknown) => {
  console.error(error);
  return process.exit(1);
});

const commands = cookbook
  ? [["bun", "--no-install", "test", ...built.cookbook]]
  : (name === undefined
      ? built.standalone
      : [built.standalone[standaloneNames.indexOf(name)]!]
    ).map((program) => ["bun", "--no-install", program]);

for (const command of commands) {
  const child = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, ".."),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
