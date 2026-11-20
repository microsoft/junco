import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deferred, WRITE_ALL_BODY } from "./helpers.mjs";

const fixtureModule = new URL("./btrfs-fixture.mjs", import.meta.url).href;
const checkout = fileURLToPath(new URL("../", import.meta.url));
const defaultTarget = fileURLToPath(new URL("../target", import.meta.url));
if (process.env.JUNCO_BTRFS_TEST_ROOT === undefined)
  await mkdir(defaultTarget, { recursive: true });
const target = await realpath(
  process.env.JUNCO_BTRFS_TEST_ROOT ?? defaultTarget,
);

/** The one line a probe prints once it holds its fixture; readiness is never a sleep. */
const RECEIPT = "BTRFS_FIXTURE_READY";
/** The line a launcher prints once the owner API returned, before setting its exit code. */
const DONE = "BTRFS_FIXTURE_DONE";
/** The line a TERM-ignoring grandchild prints the first time the owner drains its group. */
const DRAINING = "BTRFS_FIXTURE_DRAINING";

/** `mkdtemp` appends exactly six of these, so an allocated root is recognizable in a diagnostic. */
const ROOT_PATTERN = new RegExp(
  `${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/btrfs-test-[A-Za-z0-9]{6}`,
  "g",
);

/**
 * Every probe recovers its fixture from the working directory the owner gave it. The environment
 * selects only the allocation parent, never a seed.
 */
const PROBE_PRELUDE = [
  'import fs from "node:fs";',
  WRITE_ALL_BODY,
  `const { readBtrfsFixture } = await import(${JSON.stringify(fixtureModule)});`,
  "const fixture = await readBtrfsFixture();",
  'if (fs.statfsSync(fixture.seed).type !== 0x9123683e) throw new Error("not btrfs: " + fixture.seed);',
  'if (fs.readdirSync(fixture.seed).length) throw new Error("seed is not empty: " + fixture.seed);',
].join("\n");

const receiptLine = (extra = "{}") =>
  `writeAll(${JSON.stringify(RECEIPT)} + " " + JSON.stringify({ ...fixture, pid: process.pid, ...(${extra}) }) + "\\n");`;

/** The host releases a probe with one newline on stdin; end of file without one is a failure. */
const WAIT_FOR_RELEASE = [
  'process.stdin.setEncoding("utf8");',
  "await new Promise((resolve, reject) => {",
  '  let buffered = "";',
  '  process.stdin.on("data", (chunk) => {',
  "    buffered += chunk;",
  '    if (buffered.includes("\\n")) resolve();',
  "  });",
  '  process.stdin.once("end", () => reject(new Error("stdin ended before the host released this probe")));',
  "});",
  // The host keeps the write end open, so a listening stdin would pin this process open forever.
  "process.exit(0);",
].join("\n");

/**
 * Leftover marsh state: `<seed>/../.marsh/<seed>/snap` is where snapshots accumulate, plus a real
 * subvolume inside that snapshot. The snapshot alone sits below ordinary directories, so only the
 * nested one proves subvolumes are deleted child before parent.
 */
const LEFTOVER_SNAPSHOT = [
  'const { execFileSync } = await import("node:child_process");',
  'const snapshot = fixture.root + "/.marsh/seed/snap/leftover";',
  'fs.mkdirSync(fixture.root + "/.marsh/seed/snap", { recursive: true });',
  'execFileSync("btrfs", ["subvolume", "snapshot", fixture.seed, snapshot], { stdio: "ignore" });',
  'const nested = snapshot + "/nested";',
  'execFileSync("btrfs", ["subvolume", "create", nested], { stdio: "ignore" });',
].join("\n");

/** A launcher process: it owns one fixture around one real command and reports its status. */
function launcherSource(executable, args) {
  return [
    'import fs from "node:fs";',
    WRITE_ALL_BODY,
    `const { runBtrfsFixtureCommand } = await import(${JSON.stringify(fixtureModule)});`,
    `const status = await runBtrfsFixtureCommand(${JSON.stringify(executable)}, ${JSON.stringify(args)});`,
    // Written only once the API returned, so an uncaught rejection is distinguishable from a
    // failure the owner reported itself.
    `writeAll(${JSON.stringify(`${DONE} `)} + JSON.stringify({ status }) + "\\n");`,
    "process.exitCode = status;",
  ].join("\n");
}

function launch(signal, executable, args, env = process.env) {
  if (signal?.aborted)
    throw new Error("launcher requested with an already-aborted signal");

  const ready = deferred(signal, "fixture readiness receipt");
  const seen = { stdout: "", stderr: "" };
  const failures = [];
  const lines = [];
  const watchers = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let resolveClosed;
  // Deliberately not a deferred(signal, ...): abort must cancel the launcher, never reject the
  // promise that reaps it.
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", launcherSource(executable, args)],
    {
      cwd: checkout,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.once("error", (error) => failures.push(error));
  child.stdin.on("error", (error) => failures.push(error));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let consumed = 0;
  child.stdout.on("data", (chunk) => {
    seen.stdout += chunk;
    // Stream callbacks never throw: a malformed receipt is reported when the launcher settles.
    try {
      for (;;) {
        const index = seen.stdout.indexOf("\n", consumed);
        if (index === -1) break;
        const line = seen.stdout.slice(consumed, index);
        consumed = index + 1;
        lines.push(line);
        for (const watcher of watchers)
          if (watcher.marker === line) watcher.observed.resolve(line);
        if (line.startsWith(`${RECEIPT} `))
          ready.resolve(JSON.parse(line.slice(RECEIPT.length + 1)));
        else if (line.startsWith(`${DONE} `))
          resolveDone(JSON.parse(line.slice(DONE.length + 1)));
      }
    } catch (error) {
      failures.push(error);
    }
  });
  child.stderr.on("data", (chunk) => {
    seen.stderr += chunk;
  });

  let settling;
  const settle = () =>
    (settling ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM");
        } catch (error) {
          failures.push(error);
        }
      }
      const result = await closed;
      const receipt = await done;
      // After reaping, never instead of it.
      if (failures.length)
        throw new AggregateError(failures, "Launcher observation failed");
      return { ...result, receipt };
    })());

  const onAbort = () => {
    void settle().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  child.once("close", (code, closedBy) => {
    signal?.removeEventListener("abort", onAbort);
    ready.reject(
      new Error(
        `launcher exited (${code}/${closedBy}) before its readiness receipt\n${seen.stderr}`,
      ),
    );
    resolveDone(null);
    resolveClosed({ code, signal: closedBy });
  });

  return {
    child,
    seen,
    closed,
    done,
    ready: ready.promise,
    settle,
    /** Resolve once `marker` appears on its own output line. */
    watch(marker) {
      const observed = deferred(signal, `launcher line ${marker}`);
      if (lines.includes(marker)) observed.resolve(marker);
      else watchers.push({ marker, observed });
      return observed.promise;
    },
    release() {
      child.stdin.write("\n");
    },
  };
}

const gone = async (pid, budgetMs = 10_000) => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const absent = async (path) => {
  await assert.rejects(
    access(path),
    (error) => error.code === "ENOENT",
    `${path} still exists`,
  );
};

/** The distinct allocated roots a launcher's diagnostics named. */
const reportedRoots = (stderr) => [
  ...new Set(stderr.match(ROOT_PATTERN) ?? []),
];

test("an owned fixture is created, used and reclaimed", {
  timeout: 60_000,
}, async (t) => {
  const outside = await mkdtemp(join(target, "junco-external-"));
  const sentinel = join(outside, "sentinel.txt");
  await writeFile(sentinel, "outside\n");
  const launcher = launch(
    t.signal,
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        PROBE_PRELUDE,
        'fs.writeFileSync(fixture.seed + "/sentinel.txt", "owned\\n");',
        LEFTOVER_SNAPSHOT,
        `fs.symlinkSync(${JSON.stringify(sentinel)}, fixture.root + "/escape");`,
        receiptLine("{ snapshot, nested }"),
        WAIT_FOR_RELEASE,
      ].join("\n"),
    ],
    { ...process.env, JUNCO_BTRFS_TEST_ROOT: outside },
  );
  try {
    const owned = await launcher.ready;
    assert.equal(dirname(owned.root), outside);
    // Asserted while the probe still holds its fixture: teardown cannot race this read.
    assert.equal(
      await readFile(join(owned.seed, "sentinel.txt"), "utf8"),
      "owned\n",
    );
    launcher.release();

    const { code, signal } = await launcher.closed;
    assert.equal(signal, null);
    assert.equal(code, 0, `launcher failed:\n${launcher.seen.stderr}`);
    assert.deepEqual(await launcher.done, { status: 0 });
    for (const path of [
      owned.root,
      owned.seed,
      owned.tmpdir,
      owned.snapshot,
      owned.nested,
    ]) {
      await absent(path);
    }
    assert.equal(await readFile(sentinel, "utf8"), "outside\n");
  } finally {
    await settleQuietly(launcher);
    await rm(outside, { recursive: true, force: true });
  }
});

test("empty and relative allocation overrides are rejected", {
  timeout: 60_000,
}, async (t) => {
  for (const value of ["", "relative-fixture-base"]) {
    const launcher = launch(
      t.signal,
      process.execPath,
      ["-e", "process.exit(99)"],
      {
        ...process.env,
        JUNCO_BTRFS_TEST_ROOT: value,
      },
    );
    try {
      assert.deepEqual(await launcher.done, { status: 1 });
      const { code, signal } = await launcher.closed;
      assert.deepEqual([code, signal], [1, null]);
      assert.match(
        launcher.seen.stderr,
        /JUNCO_BTRFS_TEST_ROOT must be a nonempty absolute path/,
      );
    } finally {
      await settleQuietly(launcher);
    }
  }
});

test("a failing child still gives its fixture back", {
  timeout: 60_000,
}, async (t) => {
  const launcher = launch(t.signal, process.execPath, [
    "--input-type=module",
    "-e",
    [
      PROBE_PRELUDE,
      'fs.writeFileSync(fixture.seed + "/sentinel.txt", "failing\\n");',
      LEFTOVER_SNAPSHOT,
      receiptLine("{ snapshot, nested }"),
      "process.exit(7);",
    ].join("\n"),
  ]);
  try {
    const owned = await launcher.ready;
    const { code, signal } = await launcher.closed;
    assert.equal(signal, null);
    assert.equal(
      code,
      7,
      `expected the child status to pass through:\n${launcher.seen.stderr}`,
    );
    assert.deepEqual(await launcher.done, { status: 7 });
    for (const path of [
      owned.root,
      owned.seed,
      owned.tmpdir,
      owned.snapshot,
      owned.nested,
    ]) {
      await absent(path);
    }
  } finally {
    await settleQuietly(launcher);
  }
});

test("an interrupted owner kills its descendants and reclaims", {
  timeout: 30_000,
}, async (t) => {
  const grandchild = [
    'const fs = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    'process.on("SIGINT", () => {});',
    'fs.writeSync(1, "GRANDCHILD_READY\\n");',
    "setInterval(() => {}, 1000);",
    "setTimeout(() => process.exit(99), 60000);",
  ].join("\n");
  const launcher = launch(t.signal, process.execPath, [
    "--input-type=module",
    "-e",
    [
      PROBE_PRELUDE,
      'process.on("SIGTERM", () => {});',
      'process.on("SIGINT", () => {});',
      'const { spawn } = await import("node:child_process");',
      `const held = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {`,
      '  stdio: ["ignore", "pipe", "ignore"],',
      "});",
      "await new Promise((resolve, reject) => {",
      '  let observed = "";',
      '  held.stdout.setEncoding("utf8");',
      '  held.stdout.on("data", (chunk) => {',
      "    observed += chunk;",
      '    if (observed.includes("GRANDCHILD_READY")) resolve();',
      "  });",
      '  held.once("exit", () => reject(new Error("the grandchild exited before readiness")));',
      "});",
      receiptLine("{ held: held.pid }"),
      "setInterval(() => {}, 1000);",
      "setTimeout(() => process.exit(98), 60000);",
    ].join("\n"),
  ]);
  try {
    const owned = await launcher.ready;
    assert.ok(Number.isInteger(owned.pid) && Number.isInteger(owned.held));

    launcher.child.kill("SIGTERM");
    const { code, signal } = await launcher.closed;
    assert.equal(signal, null);
    assert.equal(
      code,
      143,
      `expected a handled SIGTERM status:\n${launcher.seen.stderr}`,
    );
    assert.deepEqual(await launcher.done, { status: 143 });
    assert.ok(await gone(owned.pid), `the child ${owned.pid} survived`);
    assert.ok(await gone(owned.held), `the grandchild ${owned.held} survived`);
    for (const path of [owned.root, owned.seed, owned.tmpdir])
      await absent(path);
  } finally {
    await settleQuietly(launcher);
  }
});

test("concurrent owners never share or reclaim each other's fixture", {
  timeout: 60_000,
}, async (t) => {
  const waiting = (value) =>
    [
      PROBE_PRELUDE,
      `fs.writeFileSync(fixture.seed + "/sentinel.txt", ${JSON.stringify(`${value}\n`)});`,
      receiptLine(),
      WAIT_FOR_RELEASE,
    ].join("\n");

  const first = launch(t.signal, process.execPath, [
    "--input-type=module",
    "-e",
    waiting("first"),
  ]);
  const second = launch(t.signal, process.execPath, [
    "--input-type=module",
    "-e",
    waiting("second"),
  ]);
  try {
    const [left, right] = await Promise.all([first.ready, second.ready]);
    assert.notEqual(left.root, right.root);
    assert.notEqual(left.seed, right.seed);
    assert.equal(
      await readFile(join(left.seed, "sentinel.txt"), "utf8"),
      "first\n",
    );
    assert.equal(
      await readFile(join(right.seed, "sentinel.txt"), "utf8"),
      "second\n",
    );

    first.release();
    const leftExit = await first.closed;
    assert.deepEqual(
      [leftExit.code, leftExit.signal],
      [0, null],
      first.seen.stderr,
    );
    await absent(left.root);
    assert.equal(
      await readFile(join(right.seed, "sentinel.txt"), "utf8"),
      "second\n",
    );

    second.release();
    const rightExit = await second.closed;
    assert.deepEqual(
      [rightExit.code, rightExit.signal],
      [0, null],
      second.seen.stderr,
    );
    await absent(left.root);
    await absent(right.root);
  } finally {
    const settled = await Promise.allSettled([first.settle(), second.settle()]);
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      // biome-ignore lint/correctness/noUnsafeFinally: teardown must report launchers that failed to settle.
      throw new AggregateError(
        failures,
        "Concurrent launchers failed to settle",
      );
    }
  }
});

test("a synchronous spawn failure reports the allocation it reclaimed", {
  timeout: 60_000,
}, async (t) => {
  // The NUL is constructed inside the launcher's own source, never placed in this process's argv.
  const launcher = launch(t.signal, "bad\u0000command", []);
  try {
    const { code, signal } = await launcher.closed;
    // The receipt is what separates an owner-reported failure from an uncaught rejected promise,
    // which would also exit 1.
    assert.deepEqual(await launcher.done, { status: 1 });
    assert.equal(signal, null);
    assert.equal(
      code,
      1,
      `expected a reported failure status:\n${launcher.seen.stderr}`,
    );
    assert.match(launcher.seen.stderr, /ERR_INVALID_ARG_VALUE/);
    const roots = reportedRoots(launcher.seen.stderr);
    assert.equal(
      roots.length,
      1,
      `expected exactly one named root in:\n${launcher.seen.stderr}`,
    );
    await absent(roots[0]);
  } finally {
    await settleQuietly(launcher);
  }
});

test("an asynchronous spawn failure reports the allocation it reclaimed", {
  timeout: 60_000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "junco-spawn-error-"));
  const launcher = launch(t.signal, join(scratch, "missing-executable"), []);
  try {
    const { code, signal } = await launcher.closed;
    assert.deepEqual(await launcher.done, { status: 1 });
    assert.equal(signal, null);
    assert.equal(
      code,
      1,
      `expected a reported failure status:\n${launcher.seen.stderr}`,
    );
    assert.match(launcher.seen.stderr, /ENOENT/);
    const roots = reportedRoots(launcher.seen.stderr);
    assert.equal(
      roots.length,
      1,
      `expected exactly one named root in:\n${launcher.seen.stderr}`,
    );
    await absent(roots[0]);
  } finally {
    await settleQuietly(launcher);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("cancelling a ready owner reclaims its fixture", {
  timeout: 30_000,
}, async (t) => {
  const controller = new AbortController();
  const launcher = launch(
    AbortSignal.any([t.signal, controller.signal]),
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        PROBE_PRELUDE,
        receiptLine(),
        "setInterval(() => {}, 1000);",
        "setTimeout(() => process.exit(98), 60000);",
      ].join("\n"),
    ],
  );
  try {
    const owned = await launcher.ready;
    // Cancellation goes through the harness, never a manual kill from this case.
    controller.abort();
    const { code, signal } = await launcher.closed;
    assert.equal(signal, null);
    assert.equal(
      code,
      143,
      `expected a handled SIGTERM status:\n${launcher.seen.stderr}`,
    );
    assert.deepEqual(await launcher.done, { status: 143 });
    assert.ok(await gone(owned.pid), `the child ${owned.pid} survived`);
    for (const path of [owned.root, owned.seed, owned.tmpdir])
      await absent(path);
  } finally {
    await settleQuietly(launcher);
  }
});

test("a signal during descendant draining still reports the interruption", {
  timeout: 30_000,
}, async (t) => {
  const grandchild = [
    'const fs = require("node:fs");',
    "let drained = false;",
    'process.on("SIGTERM", () => {',
    "  if (drained) return;",
    "  drained = true;",
    `  fs.writeSync(1, ${JSON.stringify(`${DRAINING}\n`)});`,
    "});",
    "setInterval(() => {}, 1000);",
    "setTimeout(() => process.exit(99), 60000);",
    'process.send("ready");',
  ].join("\n");
  const launcher = launch(t.signal, process.execPath, [
    "--input-type=module",
    "-e",
    [
      PROBE_PRELUDE,
      'const { spawn } = await import("node:child_process");',
      // Same process group, stdout inherited for the marker, IPC used only for readiness.
      `const held = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {`,
      '  stdio: ["ignore", "inherit", "inherit", "ipc"],',
      "});",
      "await new Promise((resolve, reject) => {",
      '  held.once("message", resolve);',
      '  held.once("exit", () => reject(new Error("the grandchild exited before readiness")));',
      "});",
      receiptLine("{ held: held.pid }"),
      "process.exit(0);",
    ].join("\n"),
  ]);
  try {
    const owned = await launcher.ready;
    assert.ok(Number.isInteger(owned.held));
    // Observed, never guessed: the owner's drain is what makes the grandchild print this.
    await launcher.watch(DRAINING);
    launcher.child.kill("SIGTERM");

    const { code, signal } = await launcher.closed;
    assert.equal(signal, null);
    assert.equal(
      code,
      143,
      `expected the interruption to win over the child's 0:\n${launcher.seen.stderr}`,
    );
    assert.deepEqual(await launcher.done, { status: 143 });
    assert.ok(await gone(owned.pid), `the child ${owned.pid} survived`);
    assert.ok(await gone(owned.held), `the grandchild ${owned.held} survived`);
    await absent(owned.root);
  } finally {
    await settleQuietly(launcher);
  }
});

/** Reap a launcher in a `finally` without masking the failure that brought us there. */
async function settleQuietly(launcher) {
  try {
    await launcher.settle();
  } catch (error) {
    console.error("launcher settle reported:", error);
  }
}
