import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  acquireShellMux,
  createShellMuxOperations,
  isMarshPolicyDenied,
  ToolCollection,
} from "../dist/index.js";
import {
  cleanup,
  closeFixture,
  collector,
  copyTreeNative,
  deferred,
  fixture,
  heldChild,
  nativeEnv,
  release,
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

test("two collections over one seed keep their own policies and lifetimes", {
  timeout: 60_000,
}, async (t) => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const collections = [];
  try {
    const [git, empty] = await Promise.all([
      ToolCollection.create(seed, {
        native,
        policy: "LockPolicy",
        sandbox: "always",
        principal: "git",
      }),
      ToolCollection.create(seed, {
        native,
        policy: "EmptyPolicy",
        sandbox: "always",
        principal: "empty",
      }),
    ]);
    collections.push(git, empty);
    assert.notEqual(git.mux, empty.mux);
    assert.equal(git.mux.policy, "LockPolicy");
    assert.equal(empty.mux.policy, "EmptyPolicy");
    const bash = (collection, command, signal) =>
      tool(collection, "bash").execute("bash", { command }, signal);
    const file = join(seed, "src/file0.txt");

    // Empty claims the file; Git refuses to touch another owner's dirty file; Empty may.
    await bash(
      empty,
      "cat src/file0.txt > /dev/null; printf owned > src/file0.txt",
    );
    await assert.rejects(
      bash(git, "printf stolen > src/file0.txt"),
      isMarshPolicyDenied,
    );
    assert.equal(await readFile(file, "utf8"), "owned");
    await bash(empty, "printf allowed > src/file0.txt");
    assert.equal(await readFile(file, "utf8"), "allowed");

    // Both collections hold an admitted command; closing Empty drains only its own.
    const gitGate = join(root, "git-gate");
    const emptyGate = join(root, "empty-gate");
    const ready = (gate) => heldChild({ gate, ready: "ready", done: "done" });
    const updates = (label) => {
      const seen = deferred(t.signal, label);
      return {
        seen: seen.promise,
        onUpdate: (update) => {
          if (text(update).includes("ready")) seen.resolve();
        },
      };
    };
    const gitReady = updates("git ready");
    const gitRun = tool(git, "bash").execute(
      "held-git",
      { command: ready(gitGate) },
      undefined,
      gitReady.onUpdate,
    );
    const emptyReady = updates("empty ready");
    const emptyRun = tool(empty, "bash").execute(
      "held-empty",
      { command: ready(emptyGate) },
      undefined,
      emptyReady.onUpdate,
    );
    emptyRun.catch(() => {});
    await Promise.all([gitReady.seen, emptyReady.seen]);

    // A borrower's hold keeps Empty alive across its creator's release.
    const hold = empty.lease();
    await empty.close();
    assert.equal(await empty.mux.exists(seed, "src/file0.txt"), true);
    const final = hold.close();
    assert.equal(hold.close(), final);
    await final;
    await assert.rejects(emptyRun);
    await assert.rejects(empty.mux.exists(seed, "src/file0.txt"), /closed/);
    await empty.close();
    await assert.rejects(bash(empty, "printf late"), /closed/);

    await release(gitGate);
    assert.match(text(await gitRun), /done/);
    assert.equal(text(await bash(git, "printf survivor")), "survivor");
  } finally {
    await cleanup(
      ...collections.map((collection) => () => collection.close()),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("a mux opened at seed/src shares authority with one opened at seed", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const src = join(seed, "src");
  const leases = [];
  const owners = [];
  try {
    const options = { native, policy: "LockPolicy", sandbox: "always" };
    const outer = await acquireShellMux(seed, options);
    leases.push(outer);
    const inner = await acquireShellMux(src, options);
    leases.push(inner);
    await outer.mux.validateCwd(src);
    const borrow = (lease, principal) => {
      const owner = createShellMuxOperations({
        native,
        mux: lease.mux,
        principal,
      });
      owners.push(owner);
      return owner;
    };
    const innerOps = borrow(inner, "inner");
    const outerOps = borrow(outer, "outer");
    assert.equal(
      (
        await run(
          innerOps,
          "cat file0.txt > /dev/null; printf inner > file0.txt",
          src,
        )
      ).exitCode,
      0,
    );
    // One source authority: the outer mux sees the inner mux's ownership of the file.
    await assert.rejects(
      run(outerOps, "printf outer > src/file0.txt", seed),
      isMarshPolicyDenied,
    );
    assert.equal(await readFile(join(src, "file0.txt"), "utf8"), "inner");
  } finally {
    await cleanup(
      ...owners.map((owner) => () => owner.close()),
      ...leases.map((lease) => () => lease.release()),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("a separately loaded module copy opens and releases its own mux", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const copy = await import(
    new URL("../dist/shell-mux.js?copy", import.meta.url).href
  );
  assert.notEqual(copy.acquireShellMux, acquireShellMux);
  let original;
  let copied;
  try {
    original = await acquireShellMux(seed, { native, policy: "LockPolicy" });
    copied = await copy.acquireShellMux(seed, { native, policy: "LockPolicy" });
    await copied.release();
    assert.equal(copied.closed, true);
    await assert.rejects(copied.mux.exists(seed, "src/file0.txt"), /closed/);
    assert.equal(original.closed, false);
    assert.equal(await original.mux.exists(seed, "src/file0.txt"), true);
  } finally {
    await cleanup(
      () => original?.release(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("refused cwds and policies close only what they opened", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(seed, "escape"));
  let lease;
  try {
    lease = await acquireShellMux(seed, {
      native,
      policy: "LockPolicy",
      sandbox: "always",
    });
    for (const cwd of [
      join(seed, "missing"),
      join(seed, "src/file0.txt"),
      join(root, "no-such-seed"),
    ]) {
      await assert.rejects(
        acquireShellMux(cwd, { native, policy: "LockPolicy" }),
        Error,
        cwd,
      );
      assert.equal(await lease.mux.exists(seed, "src/file0.txt"), true, cwd);
    }
    // A mux refuses cwds outside its own seed.
    for (const cwd of [outside, join(seed, "escape"), root]) {
      await assert.rejects(lease.mux.validateCwd(cwd), Error, cwd);
    }
    await assert.rejects(
      ToolCollection.create(join(root, "no-such-seed"), {
        native,
        policy: "LockPolicy",
      }),
    );
    for (const policy of [undefined, "gitpolicy"]) {
      await assert.rejects(
        acquireShellMux(seed, { native, policy }),
        TypeError,
      );
      await assert.rejects(
        ToolCollection.create(seed, { native, policy }),
        TypeError,
      );
    }
    const { mux } = lease;
    assert.throws(
      () => createShellMuxOperations({ mux }),
      /requires the native module/,
    );
    assert.throws(
      () => createShellMuxOperations({ native, mux, policy: "EmptyPolicy" }),
      /conflicts/,
    );
    assert.throws(
      () => createShellMuxOperations({ native, mux, sandbox: "shared" }),
      /conflicts/,
    );
    assert.equal(lease.closed, false);
  } finally {
    await cleanup(
      () => lease?.release(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("a lazy owner closed during its open never admits or reopens", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const real = await testNative();
  const entered = deferred(undefined, "open entered");
  const proceed = deferred(undefined, "open released");
  const opened = [];
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
        opened.push(mux);
        return mux;
      },
    },
  };
  const owner = createShellMuxOperations({
    native: barrier,
    principal: "lazy",
  });
  try {
    const pending = run(owner, "printf admitted > src/late.txt", seed);
    await entered.promise;
    const closing = owner.close();
    assert.equal(owner.close(), closing);
    proceed.resolve();
    await assert.rejects(pending, /closed/);
    await closing;
    await assert.rejects(run(owner, "printf late", seed), /closed/);
    assert.equal(opened.length, 1);
    await assert.rejects(opened[0].exists(seed, "src/file0.txt"), /closed/);
    assert.equal(
      await stat(join(seed, "src/late.txt")).catch(() => null),
      null,
    );
  } finally {
    proceed.resolve();
    await cleanup(
      () => owner.close(),
      () => rm(root, { recursive: true, force: true }),
    );
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
