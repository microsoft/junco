import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { shutdownShellMux } from "../dist/index.js";

const fixturePrefix = fileURLToPath(
  new URL("../target/bash-test-", import.meta.url),
);

export const text = (result) =>
  result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

export const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export const hashlineTag = (output) => /#([0-9A-Fa-f]{4})\]/.exec(output)?.[1];

/**
 * Attempt every release step, in order, even after one of them fails.
 *
 * Sequential on purpose: these are resource releases a test already owes in a definite order,
 * and running them concurrently would let a mux close race the removal of the tree it owns.
 * Every failure is reported together rather than the first one hiding the rest.
 */
export async function cleanup(...steps) {
  const failures = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Test cleanup failed");
}

/** Stop an agent and wait for it to go idle, attempting the wait even when abort throws. */
export async function settleAgent(agent) {
  await cleanup(
    () => agent.abort(),
    () => agent.waitForIdle(),
  );
}

/**
 * A CopyTree seed with optional seed-relative `files` (strings or Buffers), defaulting to
 * `src/file0.txt` ("zero\n") and `src/file1.txt` ("one\n"), inside a fresh temporary root.
 * Nothing is opened: automatic-acquisition tests let the first consumer open the singleton.
 */
export async function seedFixture(options = {}) {
  const root = await mkdtemp(fixturePrefix);
  const seed = join(root, "seed");
  try {
    await mkdir(seed, { recursive: true });
    for (const [relative, content] of Object.entries(
      options.files ?? {
        "src/file0.txt": "zero\n",
        "src/file1.txt": "one\n",
      },
    )) {
      const path = join(seed, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    return { root, seed };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** The test-fs addon, imported lazily so production-only suites never load it. */
export function testNative() {
  return import("../target/native-test/index.js");
}

/** Every mux the {@link copyTreeNative} adapter opened, in order. */
export const copyTreeOpens = [];

let copyTreeAdapter;

/**
 * The test addon with `NativeMux.open` delegating to its real `openCopyTree`, so automatic
 * acquisition opens a CopyTree seed. One stable object per process: the singleton compares
 * native modules by identity. Each opened mux is appended to {@link copyTreeOpens}.
 */
export function copyTreeNative() {
  copyTreeAdapter ??= testNative().then((native) => ({
    ...native,
    NativeMux: {
      async open(root, options, onPolicyDecision) {
        const mux = await native.NativeMux.openCopyTree(
          root,
          options,
          onPolicyDecision,
        );
        copyTreeOpens.push(mux);
        return mux;
      },
    },
  }));
  return copyTreeAdapter;
}

/**
 * {@link seedFixture} plus one raw test-addon mux over it. `sandbox` defaults to "always",
 * which keeps every shell command on the managed route the suites were written against;
 * `native` is the addon that created `mux`. Passing `mux` to an operations owner or a
 * collection adopts it as the application singleton; {@link closeFixture} shuts that down.
 */
export async function fixture(options = {}) {
  const { root, seed } = await seedFixture(options);
  try {
    const native = await testNative();
    const mux = await native.NativeMux.openCopyTree(seed, {
      sandbox: options.sandbox ?? "always",
    });
    return { root, seed, mux, native };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Application shutdown — which closes the fixture's mux if a consumer adopted it — then the
 * raw close (idempotent) for a mux nothing adopted, then the tree. Either way the addon's one
 * mux slot is free again before the next raw generation.
 */
export async function closeFixture({ root, mux }, outputFiles = []) {
  await cleanup(
    () => shutdownShellMux(),
    () => mux.close(),
    // Deliberately nonrecursive: an output-file entry that is not a file is a real failure,
    // and it must not stop the remaining files or the root from being attempted.
    ...[...outputFiles].map((path) => () => rm(path, { force: true })),
    () => rm(root, { recursive: true, force: true }),
  );
}

/**
 * The SDK resource bootstrap the agent-session suites share: an isolated agent dir
 * plus an in-memory settings manager and a reloaded loader with every ambient
 * resource (extensions, skills, prompt templates, themes, context files) disabled,
 * so a suite observes only the tools it registers.
 */
export async function sdkResources(instance, systemPrompt) {
  const agentDir = join(instance.root, "agent");
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    packages: [],
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: instance.seed,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager, resourceLoader };
}

/** The synchronous full-write stdout helper the CJS and ESM probe preludes share. */
export const WRITE_ALL_BODY = [
  "const writeAll = (value) => {",
  '  const payload = Buffer.from(value, "utf8");',
  "  let offset = 0;",
  "  while (offset < payload.length) offset += fs.writeSync(1, payload, offset, payload.length - offset);",
  "};",
].join("\n");

const CHILD_PRELUDE = ['const fs = require("node:fs");', WRITE_ALL_BODY].join(
  "\n",
);

/** A real external Node process, invoked through the shell under test. */
export function childCommand(body) {
  return `${quote(process.execPath)} -e ${quote(`${CHILD_PRELUDE}\n${body}`)}`;
}

/**
 * A real external process that emits `ready` on stdout, then polls a host-created
 * absolute gate file outside the marsh snapshot until the host releases it. Readiness
 * comes from observed output, never from a preparatory builtin or an arbitrary sleep.
 */
export function heldChild({ gate, ready, done, prelude = "" }) {
  return childCommand(
    [
      prelude,
      `writeAll(${JSON.stringify(`${ready}\n`)});`,
      `const gate = ${JSON.stringify(gate)};`,
      "const poll = setInterval(() => {",
      "  if (!fs.existsSync(gate)) return;",
      "  clearInterval(poll);",
      `  writeAll(${JSON.stringify(`${done}\n`)});`,
      "  process.exit(0);",
      "}, 10);",
    ].join("\n"),
  );
}

/** Child body emitting `line-0001\n` … `line-<count>\n`, numbered from 1. */
export function numberedLines(count) {
  return [
    'let numbered = "";',
    `for (let index = 1; index <= ${count}; index++) {`,
    '  numbered += "line-" + String(index).padStart(4, "0") + "\\n";',
    "}",
    "writeAll(numbered);",
  ].join("\n");
}

/** The exact bytes `numberedLines(count)` writes, for byte-for-byte spill comparison. */
export function expectedLines(count) {
  let payload = "";
  for (let index = 1; index <= count; index++) {
    payload += `line-${String(index).padStart(4, "0")}\n`;
  }
  return payload;
}

/** Environment for direct native calls, which have no Pi shell-env defaulting. */
export function nativeEnv(root) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    LANG: "C.UTF-8",
  };
}

/** Collect native `(error, data)` receipts; a non-null error must reject its run. */
export function collector(onOutput) {
  const chunks = [];
  const state = {
    chunks,
    calls: 0,
    get output() {
      return Buffer.concat(chunks).toString("utf8");
    },
    onData(error, data) {
      if (error) throw error;
      state.calls += 1;
      chunks.push(data);
      onOutput?.(state.output);
    },
  };
  return state;
}

/** A promise resolved by observed output and rejected when `signal` aborts. */
export function deferred(signal, label = "fixture wait") {
  let resolve;
  let reject;
  const promise = new Promise((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  promise.catch(() => {});
  const onAbort = () =>
    reject(new Error(`${label} aborted before it was satisfied`));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    resolve: (value) => resolve(value),
    reject: (error) => reject(error),
  };
}

/** Create the gate file that releases a `heldChild`. */
export async function release(gate) {
  await writeFile(gate, "release\n");
}
