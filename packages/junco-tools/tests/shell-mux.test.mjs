import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  acquireShellMux,
  createShellMuxOperations,
  shutdownShellMux,
  ToolCollection,
} from "../dist/index.js";
import {
  cleanup,
  closeFixture,
  collector,
  copyTreeNative,
  copyTreeOpens,
  deferred,
  fixture,
  nativeEnv,
  seedFixture,
  testNative,
  text,
} from "./helpers.mjs";

const tool = (collection, name) =>
  collection.tools.find((entry) => entry.name === name);

/** Runs `command` through operations and returns its exit code and output. */
async function run(operations, command, cwd) {
  const chunks = [];
  const result = await operations.exec(command, cwd, {
    onData: (data) => chunks.push(data),
  });
  return {
    exitCode: result.exitCode,
    output: Buffer.concat(chunks).toString(),
  };
}

/** A collector whose `until(text)` resolves once its output contains `text`. */
function watched(signal, label) {
  const waits = [];
  const state = collector((output) => {
    for (const wait of waits) {
      if (output.includes(wait.text)) wait.resolve();
    }
  });
  state.until = (text) => {
    const wait = deferred(signal, `${label}: ${text}`);
    if (state.output.includes(text)) wait.resolve();
    else waits.push({ text, resolve: wait.resolve });
    return wait.promise;
  };
  return state;
}

test("concurrent cold acquisitions open one mux and share it", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const opens = copyTreeOpens.length;
  const operations = createShellMuxOperations({
    native,
    principal: "cold-operations",
  });
  const leases = [];
  const collections = [];
  try {
    // The first call to reach acquisition names the adapter; every other one joins its open.
    const [first, second, lease, nested, executed] = await Promise.all([
      ToolCollection.create(seed, { native, sandbox: "always" }),
      ToolCollection.create(seed),
      acquireShellMux(seed, { native }),
      acquireShellMux(join(seed, "src")),
      run(operations, "printf 'operations ran\\n'", seed),
    ]);
    collections.push(first, second);
    leases.push(lease, nested);
    assert.equal(copyTreeOpens.length, opens + 1);
    const mux = copyTreeOpens.at(-1);
    assert.equal(lease.mux, mux);
    assert.equal(nested.mux, mux);
    assert.equal(lease.native, native);
    assert.equal(mux.sandbox, "always");
    assert.deepEqual(executed, { exitCode: 0, output: "operations ran\n" });

    assert.match(
      text(
        await tool(first, "read").execute("read", { path: "src/file0.txt" }),
      ),
      /^1:zero$/m,
    );
    const bash = await tool(second, "bash").execute("bash", {
      command: "printf 'collection ran\\n' > src/ran.txt; cat src/ran.txt",
    });
    assert.equal(text(bash), "collection ran\n");
    assert.equal(await mux.exists(seed, "src/ran.txt"), true);
    assert.equal(copyTreeOpens.length, opens + 1);
  } finally {
    await cleanup(
      ...collections.map((collection) => () => collection.close()),
      () => operations.close(),
      ...leases.map((lease) => () => lease.release()),
      () => shutdownShellMux(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("separately loaded module copies share the registry and its mux", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  // A second instance of the module, as a duplicated bundle or a second package copy has.
  const copy = await import(
    new URL("../dist/shell-mux.js?copy", import.meta.url).href
  );
  assert.notEqual(copy.acquireShellMux, acquireShellMux);
  let original;
  let copied;
  try {
    original = await acquireShellMux(seed, { native });
    copied = await copy.acquireShellMux(seed);
    assert.equal(copied.mux, original.mux);
    assert.equal(copied.native, native);
    // Either copy's shutdown is the one application shutdown.
    await copy.shutdownShellMux();
    assert.equal(original.closed, true);
    assert.equal(copied.closed, true);
    await assert.rejects(original.mux.exists(seed, "src/file0.txt"), /closed/);
  } finally {
    await cleanup(
      () => shutdownShellMux(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("under Bun, the TypeScript source and the built module share one mux and run on it", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const url = (path) => new URL(path, import.meta.url).href;
  // Only Bun loads the `ts/` sources; both copies then live in that subprocess's one realm.
  const script = `
    const source = await import(${JSON.stringify(url("../ts/index.ts"))});
    const built = await import(${JSON.stringify(url("../dist/index.js"))});
    const addon = await import(${JSON.stringify(url("../target/native-test/index.js"))});
    let opens = 0;
    const native = { ...addon, NativeMux: { open: (root, options, onPolicyDecision) => {
      opens += 1;
      return addon.NativeMux.openCopyTree(root, options, onPolicyDecision);
    } } };
    const seed = ${JSON.stringify(seed)};
    const [fromSource, fromBuilt] = await Promise.all([
      source.acquireShellMux(seed, { native }),
      built.acquireShellMux(seed),
    ]);
    const operations = built.createShellMuxOperations();
    const chunks = [];
    const result = await operations.exec("printf shared", seed, {
      onData: (data) => chunks.push(data),
    });
    await operations.close();
    fromSource.release();
    fromBuilt.release();
    await source.shutdownShellMux();
    console.log(JSON.stringify({
      distinctModules: source.acquireShellMux !== built.acquireShellMux,
      same: fromSource.mux === fromBuilt.mux,
      opens,
      exitCode: result.exitCode,
      output: Buffer.concat(chunks).toString(),
      closed: fromBuilt.closed,
    }));
  `;
  try {
    const { stdout } = await promisify(execFile)("bun", ["-e", script]);
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), {
      distinctModules: true,
      same: true,
      opens: 1,
      exitCode: 0,
      output: "shared",
      closed: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refused configurations and cwds leave the open singleton untouched", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(seed, "escape"));
  let lease;
  try {
    lease = await acquireShellMux(seed, { native, sandbox: "always" });
    const { mux } = lease;
    const opens = copyTreeOpens.length;
    const usable = async (label) =>
      assert.equal(await mux.exists(seed, "src/file0.txt"), true, label);

    const nested = await acquireShellMux(join(seed, "src"), { native });
    assert.equal(nested.mux, mux);
    nested.release();

    for (const cwd of [
      join(seed, "missing"),
      join(seed, "src/file0.txt"),
      outside,
      join(seed, "escape"),
      root,
    ]) {
      await assert.rejects(acquireShellMux(cwd), Error, cwd);
      await usable(cwd);
    }
    await assert.rejects(
      acquireShellMux(seed, { sandbox: "shared" }),
      /sandbox "shared" conflicts/,
    );
    await assert.rejects(
      acquireShellMux(seed, { native: await testNative() }),
      /different native module/,
    );
    await assert.rejects(
      acquireShellMux(seed, { mux }),
      /requires the native module/,
    );
    assert.throws(
      () => createShellMuxOperations({ mux }),
      /requires the native module/,
    );
    await usable("after refusals");
    assert.equal(copyTreeOpens.length, opens);
    assert.equal(lease.closed, false);
  } finally {
    await cleanup(
      () => lease?.release(),
      () => shutdownShellMux(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("releasing every lease never closes the mux", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  try {
    const [first, second] = await Promise.all([
      acquireShellMux(seed, { native }),
      acquireShellMux(seed, { native }),
    ]);
    first.release();
    first.release();
    second.release();
    assert.equal(first.closed, true);
    assert.equal(second.closed, true);
    assert.equal(await first.mux.exists(seed, "src/file0.txt"), true);
    const again = await acquireShellMux(seed);
    assert.equal(again.mux, first.mux);
    assert.equal(again.closed, false);
    again.release();
  } finally {
    await cleanup(
      () => shutdownShellMux(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("a failed raw open rejects every joiner and a later acquisition succeeds", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const opens = copyTreeOpens.length;
  const missing = join(root, "no-such-seed");
  let lease;
  try {
    const attempts = await Promise.allSettled([
      acquireShellMux(missing, { native }),
      acquireShellMux(missing),
      ToolCollection.create(missing),
    ]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      ["rejected", "rejected", "rejected"],
    );
    assert.equal(attempts[1].reason, attempts[0].reason);
    assert.equal(attempts[2].reason, attempts[0].reason);
    assert.equal(copyTreeOpens.length, opens);

    lease = await acquireShellMux(seed, { native });
    assert.equal(copyTreeOpens.length, opens + 1);
    assert.equal(await lease.mux.exists(seed, "src/file0.txt"), true);
  } finally {
    await cleanup(
      () => lease?.release(),
      () => shutdownShellMux(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("shutdown during opening closes once and fences the whole generation", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const real = await testNative();
  const entered = deferred(undefined, "open entered");
  const proceed = deferred(undefined, "open released");
  const opened = [];
  let closes = 0;
  // The real addon, its open held at a barrier this test controls.
  const barrier = {
    ...real,
    NativeMux: {
      async open(cwd, options, onPolicyDecision) {
        entered.resolve();
        await proceed.promise;
        const mux = await real.NativeMux.openCopyTree(
          cwd,
          options,
          onPolicyDecision,
        );
        const close = mux.close.bind(mux);
        mux.close = () => {
          closes += 1;
          return close();
        };
        opened.push(mux);
        return mux;
      },
    },
  };
  const dormant = createShellMuxOperations({
    native: barrier,
    principal: "dormant",
  });
  let next;
  try {
    // Observed at once: they reject only after the barrier opens, under shutdown's fence.
    const joiners = [
      acquireShellMux(seed, { native: barrier }),
      acquireShellMux(seed),
    ].map((joiner) => assert.rejects(joiner, /closed/));
    await entered.promise;
    const shutdown = shutdownShellMux();
    assert.equal(shutdownShellMux(), shutdown);
    // Fenced at once: nothing can join or replace the generation while it closes.
    await assert.rejects(acquireShellMux(seed), /closed/);
    proceed.resolve();
    await shutdown;
    await Promise.all(joiners);
    // Settled: a repeated call still joins this generation's result rather than starting one.
    const repeated = shutdownShellMux();
    assert.equal(repeated, shutdown);
    await repeated;
    assert.equal(opened.length, 1);
    assert.equal(closes, 1);
    await assert.rejects(opened[0].exists(seed, "src/file0.txt"), /closed/);
    await assert.rejects(run(dormant, "printf late", seed), /closed/);

    // A consumer created after shutdown completed opens a new generation.
    const native = await copyTreeNative();
    next = await acquireShellMux(seed, { native });
    assert.notEqual(next.mux, opened[0]);
    assert.equal(await next.mux.exists(seed, "src/file0.txt"), true);
    // The previous generation's mux is foreign to this one.
    await assert.rejects(
      acquireShellMux(seed, { native, mux: opened[0] }),
      /different mux/,
    );
    // The old owner stays closed, never silently moving to the new generation.
    await assert.rejects(run(dormant, "printf late", seed), /closed/);
    assert.equal(closes, 1);
  } finally {
    proceed.resolve();
    await cleanup(
      () => next?.release(),
      () => shutdownShellMux(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("settled shutdown replays its failure until a new consumer starts", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const real = await testNative();
  const injected = new Error("injected ShellMux close failure");
  const opened = [];
  let closes = 0;
  // The real addon, whose close really closes the mux and then reports the injected failure.
  const failing = {
    ...real,
    NativeMux: {
      async open(cwd, options, onPolicyDecision) {
        const mux = await real.NativeMux.openCopyTree(
          cwd,
          options,
          onPolicyDecision,
        );
        const close = mux.close.bind(mux);
        mux.close = async () => {
          closes += 1;
          await close();
          throw injected;
        };
        opened.push(mux);
        return mux;
      },
    },
  };
  const isInjected = (error) => error === injected;
  let next;
  let fresh;
  try {
    const old = await acquireShellMux(seed, { native: failing });
    const dormant = createShellMuxOperations({ principal: "dormant-failure" });
    const shutdown = shutdownShellMux();
    assert.equal(shutdownShellMux(), shutdown);
    await assert.rejects(shutdown, isInjected);
    // Settled, the generation still answers with its one close result.
    await assert.rejects(shutdownShellMux(), isInjected);
    assert.equal(closes, 1);
    assert.equal(old.closed, true);
    await assert.rejects(old.mux.exists(seed, "src/file0.txt"), /closed/);
    await assert.rejects(run(dormant, "printf late", seed), /closed/);

    // A new consumer explicitly starts the next generation.
    const native = await copyTreeNative();
    next = await acquireShellMux(seed, { native });
    assert.notEqual(next.mux, opened[0]);
    fresh = createShellMuxOperations({ principal: "reopened" });
    assert.deepEqual(await run(fresh, "printf reopened", seed), {
      exitCode: 0,
      output: "reopened",
    });
    assert.equal(old.closed, true);
    await assert.rejects(run(dormant, "printf late", seed), /closed/);
    assert.equal(closes, 1);
  } finally {
    await cleanup(
      () => fresh?.close(),
      () => next?.release(),
      () =>
        shutdownShellMux().catch((error) => {
          if (!isInjected(error)) throw error;
        }),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("a second raw open is refused while a mux is live and while it closes", {
  timeout: 30_000,
}, async (t) => {
  const instance = await fixture();
  const { seed, native } = instance;
  let mux = instance.mux;
  try {
    await assert.rejects(
      native.NativeMux.openCopyTree(seed),
      /already open or closing/,
    );
    // A live persistent process keeps the close in progress while the next open is tried.
    const stdout = watched(t.signal, "closing hold");
    const held = await mux.spawn(
      {
        command: process.execPath,
        args: [
          "-e",
          'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
        ],
        cwd: seed,
        principal: "closing-hold",
        env: nativeEnv(instance.root),
      },
      stdout.onData,
      collector().onData,
    );
    await stdout.until("ready\n");
    const closing = mux.close();
    const refused = native.NativeMux.openCopyTree(seed);
    await assert.rejects(refused, /already open or closing/);
    await closing;
    assert.equal((await held.wait()).cancelled, true);

    mux = await native.NativeMux.openCopyTree(seed);
    assert.equal(await mux.exists(seed, "src/file0.txt"), true);
  } finally {
    await closeFixture({ root: instance.root, mux });
  }
});

test("a persistent process keeps ordered input and separate output streams", {
  timeout: 60_000,
}, async (t) => {
  const instance = await fixture();
  const { seed, mux } = instance;
  try {
    const stdout = watched(t.signal, "echo stdout");
    const stderr = collector();
    const args = ["a b", "'q'", "", "''", "it''s", "$(x);y", "\\"];
    const echo = await mux.spawn(
      {
        command: process.execPath,
        args: [
          "-e",
          [
            'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n");',
            'let pending = "";',
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (data) => {',
            "  pending += data;",
            "  let end;",
            '  while ((end = pending.indexOf("\\n")) >= 0) {',
            "    const line = pending.slice(0, end);",
            "    pending = pending.slice(end + 1);",
            '    process.stdout.write("out:" + line + "\\n");',
            '    process.stderr.write("err:" + line + "\\n");',
            "  }",
            "});",
            'process.stdin.on("end", () => process.exit(0));',
          ].join("\n"),
          ...args,
        ],
        cwd: seed,
        principal: "echo",
        env: nativeEnv(instance.root),
      },
      stdout.onData,
      stderr.onData,
    );
    for (const line of ["first", "second", "third"]) {
      await echo.write(Buffer.from(`${line}\n`));
    }
    await stdout.until("out:third\n");
    const finishing = echo.finish(2_000);
    await assert.rejects(echo.write(Buffer.from("late\n")));
    const result = await finishing;
    assert.deepEqual(result, {
      exitCode: 0,
      cancelled: false,
      timedOut: false,
    });
    assert.deepEqual(await echo.wait(), result);
    assert.deepEqual(await echo.finish(), result);
    assert.equal(
      stdout.output,
      `${JSON.stringify(args)}\nout:first\nout:second\nout:third\n`,
    );
    assert.equal(stderr.output, "err:first\nerr:second\nerr:third\n");
    await assert.rejects(echo.write(Buffer.from("after\n")));
  } finally {
    await closeFixture(instance);
  }
});

test("persistent processes reject NUL and a missing cwd, abort as cancelled, and join close", {
  timeout: 60_000,
}, async (t) => {
  const instance = await fixture();
  const { seed, mux } = instance;
  const env = nativeEnv(instance.root);
  const forever =
    'process.stdout.write("ready " + process.pid + "\\n"); setInterval(() => {}, 1000);';
  try {
    await assert.rejects(
      mux.spawn(
        {
          command: process.execPath,
          args: ["a\0b"],
          cwd: seed,
          principal: "nul",
          env,
        },
        collector().onData,
        collector().onData,
      ),
    );
    // Refused asynchronously, after the worker took the admission; the mux still serves.
    await assert.rejects(
      mux.spawn(
        {
          command: process.execPath,
          args: ["-e", ""],
          cwd: join(seed, "missing-cwd"),
          principal: "missing-cwd",
          env,
        },
        collector().onData,
        collector().onData,
      ),
    );
    const admitted = collector();
    const valid = await mux.spawn(
      {
        command: process.execPath,
        args: ["-e", 'process.stdout.write("admitted\\n")'],
        cwd: seed,
        principal: "missing-cwd",
        env,
      },
      admitted.onData,
      collector().onData,
    );
    assert.deepEqual(await valid.wait(), {
      exitCode: 0,
      cancelled: false,
      timedOut: false,
    });
    assert.equal(admitted.output, "admitted\n");
    await assert.rejects(
      mux
        .spawn(
          {
            command: process.execPath,
            args: ["-e", ""],
            cwd: seed,
            principal: "timeout",
            env,
          },
          collector().onData,
          collector().onData,
        )
        .then((process) => process.finish(Number.NaN)),
    );

    const aborted = watched(t.signal, "aborted");
    const victim = await mux.spawn(
      {
        command: process.execPath,
        args: ["-e", forever],
        cwd: seed,
        principal: "abort",
        env,
      },
      aborted.onData,
      collector().onData,
    );
    await aborted.until("ready");
    victim.abort();
    assert.equal((await victim.wait()).cancelled, true);

    const live = watched(t.signal, "live at close");
    const survivor = await mux.spawn(
      {
        command: process.execPath,
        args: ["-e", forever],
        cwd: seed,
        principal: "close",
        env,
      },
      live.onData,
      collector().onData,
    );
    await live.until("\n");
    const pid = Number(/ready (\d+)/.exec(live.output)[1]);
    await mux.close();
    // Close returned only after the process was reaped.
    assert.equal((await survivor.wait()).cancelled, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await closeFixture(instance);
  }
});
