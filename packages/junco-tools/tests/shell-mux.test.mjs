import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runWithUsageBudgets } from "dataflow-engine";
import {
  EmptyPolicy,
  isMarshPolicyDenied,
  LockPolicy,
  Policy,
  ShellMuxLease,
  ShellMuxOperations,
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
  testRecorder,
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
        policy: LockPolicy,
        sandbox: "always",
        principal: "git",
      }),
      ToolCollection.create(seed, {
        native,
        policy: EmptyPolicy,
        sandbox: "always",
        principal: "empty",
      }),
    ]);
    collections.push(git, empty);
    assert.notEqual(git.mux, empty.mux);
    assert.equal(git.policy, LockPolicy);
    assert.equal(empty.policy, EmptyPolicy);
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

test("a collection's resources limit and monitor only its own commands", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const probe =
    "/bin/sh -c 'd=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); cat $d/pids.max'";
  const base = { native, policy: LockPolicy, sandbox: "always" };
  const bash = (collection, command) =>
    tool(collection, "bash").execute("bash", { command }, undefined);
  const collections = [];
  const events = [];
  try {
    // Refused before anything opens, with or without cgroup delegation.
    await assert.rejects(
      ToolCollection.create(seed, {
        ...base,
        resources: { monitorIntervalMs: 100 },
      }),
      /monitorIntervalMs requires an onResourceEvent callback/,
    );
    await assert.rejects(
      ToolCollection.create(seed, { ...base, onResourceEvent: () => {} }),
      /onResourceEvent requires resources\.monitorIntervalMs/,
    );
    for (const pids of [0, -1, 1.5, 2 ** 32, NaN, Infinity]) {
      await assert.rejects(
        ToolCollection.create(seed, { ...base, resources: { pids } }),
        /pids must be positive/,
      );
    }
    await assert.rejects(
      ToolCollection.create(seed, { ...base, resources: { memoryBytes: 1.5 } }),
      /memoryBytes must be a positive integer/,
    );
    await assert.rejects(
      ToolCollection.create(seed, {
        ...base,
        resources: { monitorIntervalMs: Number.MIN_VALUE },
        onResourceEvent: () => {},
      }),
      /monitorIntervalMs is out of range/,
    );

    const limited = await ToolCollection.create(seed, {
      ...base,
      principal: "limited",
      resources: { pids: 4, monitorIntervalMs: 100 },
      onResourceEvent: (event) => events.push(event),
    });
    collections.push(limited);
    assert.throws(
      () =>
        new ShellMuxOperations({
          native,
          mux: limited.mux,
          resources: { pids: 1 },
        }),
      /keeps the resources/,
    );
    const first = await bash(limited, probe);
    assert.ok(!first.isError, text(first));
    assert.equal(text(first), "4\n");
    const binding = limited.bind();
    try {
      await binding.tools
        .get(tool(limited, "bash"))
        .execute("bash", { command: probe }, undefined);
    } finally {
      await binding.close();
    }

    const plain = await ToolCollection.create(seed, {
      ...base,
      principal: "plain",
      resources: { pids: 5 },
    });
    collections.push(plain);
    assert.equal(text(await bash(plain, probe)), "5\n");

    const free = await ToolCollection.create(seed, {
      ...base,
      principal: "free",
    });
    collections.push(free);
    assert.doesNotMatch(
      text(await bash(free, "/bin/cat /proc/self/cgroup")),
      /\/brush-/,
    );

    // An owned operations mux takes the same options.
    const owned = new ShellMuxOperations({
      native,
      principal: "owned",
      resources: { pids: 6 },
    });
    try {
      assert.equal((await run(owned, probe, seed)).output, "6\n");
    } finally {
      await owned.close();
    }

    // Final release drains both pipelines, then nothing.
    await limited.close();
    const started = events.filter((event) => event.kind === "started");
    const finished = events.filter((event) => event.kind === "finished");
    assert.equal(started.length, 2, JSON.stringify(events));
    // The collection's own tools act as its forked owner, distinct from the binding's.
    assert.equal(typeof started[0].owner, "string");
    assert.notEqual(started[0].owner, binding.owner);
    assert.equal(started[0].command, probe);
    assert.equal(typeof binding.owner, "string");
    assert.equal(started[1].owner, binding.owner);
    assert.equal(finished.length, 2, JSON.stringify(events));
    for (const event of started) {
      const ended = finished.filter(
        (end) => end.pipelineId === event.pipelineId,
      );
      assert.equal(ended.length, 1);
      assert.equal(ended[0].owner, event.owner);
      assert.equal(ended[0].sample.pids, 0);
    }
    assert.ok(
      events.every((event) =>
        started.some((start) => start.pipelineId === event.pipelineId),
      ),
    );
  } finally {
    await cleanup(
      ...collections.map((collection) => () => collection.close()),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("memory histories receive each native pipeline's peak before command completion, even on a shared owner", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const collection = await ToolCollection.create(seed, {
    native: await copyTreeNative(),
    measureMemory: true,
  });
  const binding = collection.bind();
  const read = "/bin/dd if=/dev/zero of=/dev/null bs=1M count=1";
  try {
    const run = async (node, command) => {
      const samples = [];
      const result = await runWithUsageBudgets(
        [],
        node,
        () => binding.exec(command, seed, { onData() {} }),
        (kind, value) => {
          assert.equal(kind, "memory");
          assert.ok(
            Number.isSafeInteger(value) && value > 0,
            `not a measured cgroup peak: ${value}`,
          );
          samples.push(value);
        },
      );
      assert.equal(result.exitCode, 0);
      return samples.length;
    };
    assert.deepEqual(
      await Promise.all([
        run("two", `${read}; ${read}`),
        run("one", read),
        run("builtin", ":"),
      ]),
      [2, 1, 0],
    );
  } finally {
    await cleanup(
      () => binding.close(),
      () => collection.close(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("policies compose under and, or and not", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await copyTreeNative();
  const collections = [];
  const open = async (policy) => {
    const collection = await ToolCollection.create(seed, {
      native,
      policy,
      sandbox: "always",
    });
    collections.push(collection);
    return (command) =>
      tool(collection, "bash").execute("bash", { command }, undefined);
  };
  try {
    // Another owner claims file0; file1 stays unclaimed.
    const owner = await open(EmptyPolicy);
    await owner("cat src/file0.txt > /dev/null; printf owned > src/file0.txt");
    const file0 = join(seed, "src/file0.txt");
    const file1 = join(seed, "src/file1.txt");
    const before1 = await readFile(file1, "utf8");

    const both = await open(Policy.and(LockPolicy, EmptyPolicy));
    await assert.rejects(
      both("printf and > src/file0.txt"),
      isMarshPolicyDenied,
    );
    assert.equal(await readFile(file0, "utf8"), "owned");

    const either = await open(Policy.or(LockPolicy, EmptyPolicy));
    await either("printf or > src/file0.txt");
    assert.equal(await readFile(file0, "utf8"), "or");

    // Policy.not(LockPolicy) grants exactly the steal LockPolicy refuses, and refuses a free write.
    const inverted = await open(Policy.not(LockPolicy));
    await assert.rejects(
      inverted("printf free > src/file1.txt"),
      isMarshPolicyDenied,
    );
    assert.equal(await readFile(file1, "utf8"), before1);
    await inverted("printf not > src/file0.txt");
    assert.equal(await readFile(file0, "utf8"), "not");

    const nothing = await open(Policy.not(EmptyPolicy));
    await assert.rejects(
      nothing("printf none > src/file1.txt"),
      isMarshPolicyDenied,
    );
    assert.equal(await readFile(file1, "utf8"), before1);
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
    const options = { native, policy: LockPolicy, sandbox: "always" };
    const outer = await ShellMuxLease.create(seed, options);
    leases.push(outer);
    const inner = await ShellMuxLease.create(src, options);
    leases.push(inner);
    await outer.mux.validateCwd(src);
    const borrow = (lease, principal) => {
      const owner = new ShellMuxOperations({
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
  // Relative with a query: Bun ignores the query on a `file:` URL and would return the cached module.
  const copy = await import("../dist/shell-mux.js?copy");
  assert.notEqual(copy.ShellMuxLease, ShellMuxLease);
  let original;
  let copied;
  try {
    original = await ShellMuxLease.create(seed, { native, policy: LockPolicy });
    copied = await copy.ShellMuxLease.create(seed, {
      native,
      policy: LockPolicy,
    });
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
    lease = await ShellMuxLease.create(seed, {
      native,
      policy: LockPolicy,
      sandbox: "always",
    });
    for (const cwd of [
      join(seed, "missing"),
      join(seed, "src/file0.txt"),
      join(root, "no-such-seed"),
    ]) {
      await assert.rejects(
        ShellMuxLease.create(cwd, { native, policy: LockPolicy }),
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
        policy: LockPolicy,
      }),
    );
    // An omitted policy is LockPolicy.
    const defaulted = await ToolCollection.create(seed, { native });
    try {
      assert.equal(defaulted.policy, LockPolicy);
    } finally {
      await defaulted.close();
    }
    const { mux } = lease;
    assert.throws(
      () => new ShellMuxOperations({ mux }),
      /requires the native module/,
    );
    assert.throws(
      () => new ShellMuxOperations({ native, mux, policy: EmptyPolicy }),
      /keeps the policy/,
    );
    assert.throws(
      () => new ShellMuxOperations({ native, mux, sandbox: "shared" }),
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
  const owner = new ShellMuxOperations({
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

/** Runs `command` at `seed` on `mux` under display label `label`; resolves its exit code. */
async function managed(mux, seed, command, label) {
  const result = await mux
    .start(
      { command, cwd: seed, principal: label, env: nativeEnv(seed) },
      () => {},
    )
    .wait();
  return result.exitCode;
}

test("forked owners: one owner across calls, distinct siblings, labels and other muxes grant nothing", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await testNative();
  const decisions = [];
  const mux = await native.NativeMux.openCopyTree(
    seed,
    { sandbox: "always", policyDebug: true },
    (error, decision) => {
      if (error === null) decisions.push(decision);
    },
  );
  try {
    const owner = mux.forkOwner();
    const sibling = mux.forkOwner();
    // Repeated transient calls and commands of one fork act as one owner; each unforked call
    // acts as its own fresh shell. Distinct resources tell the calls apart in the log.
    assert.equal(
      await managed(owner, seed, "cat src/file0.txt", "shared-label"),
      0,
    );
    assert.equal(
      await managed(owner, seed, "printf a > src/owned.txt", "shared-label"),
      0,
    );
    await owner.release(seed, "src/owner-call.txt");
    await mux.release(seed, "src/fresh-1.txt");
    await mux.release(seed, "src/fresh-2.txt");

    // The same display label grants a sibling nothing, and it cannot release the owner's file.
    await assert.rejects(
      managed(sibling, seed, "printf b > src/owned.txt", "shared-label"),
      isMarshPolicyDenied,
    );
    await assert.rejects(
      sibling.release(seed, "src/owned.txt"),
      isMarshPolicyDenied,
    );

    // Opening and closing a second mux over the seed clears no lock.
    const other = await native.NativeMux.openCopyTree(seed, {
      sandbox: "always",
    });
    await other.readFile(seed, "src/file0.txt");
    await other.close();
    await assert.rejects(
      managed(sibling, seed, "printf b > src/owned.txt", "sibling"),
      isMarshPolicyDenied,
    );
    assert.equal(await readFile(join(seed, "src/owned.txt"), "utf8"), "a");

    // The owner's later release lets the sibling take the file once it reads the owner's edit.
    await owner.release(seed, "src/owned.txt");
    await assert.rejects(
      managed(sibling, seed, "printf b > src/owned.txt", "sibling"),
      isMarshPolicyDenied,
    );
    assert.equal(
      await managed(
        sibling,
        seed,
        "cat src/owned.txt >/dev/null && printf b > src/owned.txt",
        "sibling",
      ),
      0,
    );
    assert.equal(await readFile(join(seed, "src/owned.txt"), "utf8"), "b");

    // Close drains the policy log.
    await mux.close();
    const principalsOf = (path, granted = true) =>
      new Set(
        decisions
          .filter(
            (decision) =>
              decision.resource.join("/") === path &&
              decision.granted === granted,
          )
          .map(({ principal }) => principal),
      );
    const [ownerPrincipal, ...extra] = [
      ...principalsOf("src/file0.txt"),
      ...principalsOf("src/owner-call.txt"),
    ];
    assert.deepEqual(extra, [ownerPrincipal]);
    assert.ok(principalsOf("src/owned.txt").has(ownerPrincipal));
    const fresh = [
      ...principalsOf("src/fresh-1.txt"),
      ...principalsOf("src/fresh-2.txt"),
    ];
    assert.equal(new Set(fresh).size, 2);
    assert.ok(!fresh.includes(ownerPrincipal));
    const denied = principalsOf("src/owned.txt", false);
    assert.equal(denied.size, 1);
    assert.ok(!denied.has(ownerPrincipal));
    assert.ok(decisions.some(({ action }) => action === "Release"));
  } finally {
    await cleanup(
      () => mux.close(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("a release in shared mode publishes without a live peer", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await testNative();
  const mux = await native.NativeMux.openCopyTree(seed);
  assert.equal(mux.sandbox, "shared");
  const env = nativeEnv(seed);
  /** A live persistent shell sharing the seed, making shared-mode commands managed. */
  const peer = () =>
    mux.spawn(
      { command: "cat", cwd: seed, principal: "peer", env },
      () => {},
      () => {},
    );
  try {
    const owner = mux.forkOwner();
    const challenger = mux.forkOwner();
    let live = await peer();
    assert.equal(
      await managed(owner, seed, "printf a > src/shared.txt", "owner"),
      0,
    );
    await assert.rejects(
      managed(challenger, seed, "printf b > src/shared.txt", "challenger"),
      isMarshPolicyDenied,
    );
    assert.equal((await live.finish()).exitCode, 0);

    // No peer is alive: the release still takes the managed route and publishes.
    await owner.release(seed, "src/shared.txt");

    live = await peer();
    assert.equal(
      await managed(
        challenger,
        seed,
        "cat src/shared.txt >/dev/null && printf b > src/shared.txt",
        "challenger",
      ),
      0,
    );
    assert.equal((await live.finish()).exitCode, 0);
    assert.equal(await readFile(join(seed, "src/shared.txt"), "utf8"), "b");
  } finally {
    await cleanup(
      () => mux.close(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("bulk release in shared mode publishes without a peer and is source scoped", {
  timeout: 60_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const native = await testNative();
  const mux = await native.NativeMux.openCopyTree(seed);
  try {
    const owner = mux.forkOwner();
    const foreign = mux.forkOwner();
    const live = await mux.spawn(
      { command: "cat", cwd: seed, principal: "peer", env: nativeEnv(seed) },
      () => {},
      () => {},
    );
    assert.equal(
      await managed(
        owner,
        seed,
        "printf a > src/bulk-a.txt; printf b > src/bulk-b.txt",
        "owner",
      ),
      0,
    );
    assert.equal(
      await managed(
        foreign,
        seed,
        "printf foreign > src/bulk-foreign.txt",
        "foreign",
      ),
      0,
    );
    assert.equal((await live.finish()).exitCode, 0);

    // Cwd validates the call, but selection and reported paths cover the whole source.
    assert.deepEqual(await owner.releaseOwned(join(seed, "src")), [
      "src/bulk-a.txt",
      "src/bulk-b.txt",
    ]);
    assert.deepEqual(await owner.releaseOwned(seed), []);
    await assert.rejects(
      owner.release(seed, "src/bulk-foreign.txt"),
      isMarshPolicyDenied,
    );
    assert.equal(await readFile(join(seed, "src/bulk-a.txt"), "utf8"), "a");
    assert.equal(await readFile(join(seed, "src/bulk-b.txt"), "utf8"), "b");
    assert.deepEqual(await foreign.releaseOwned(seed), [
      "src/bulk-foreign.txt",
    ]);
  } finally {
    await cleanup(
      () => mux.close(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});

test("a recorder lease pins each pipeline's view and composes with onResourceEvent", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const real = await testNative();
  // The real CopyTree mux, with its resource callback captured to deliver monitor events.
  const opened = [];
  const native = {
    ...real,
    NativeMux: {
      async open(at, options, onPolicyDecision, onResourceEvent) {
        opened.push({ options, emit: onResourceEvent });
        return real.NativeMux.openCopyTree(
          at,
          options,
          onPolicyDecision,
          onResourceEvent,
        );
      },
    },
  };
  const recorder = testRecorder();
  const { events } = recorder.root;
  const leaseView = recorder.add_context("lease");
  const callerEvents = [];
  let callerThrows = false;
  let recorderThrows = false;
  const failing = {
    ...leaseView,
    record: (event) => {
      if (recorderThrows) throw new Error("recorder failed");
      leaseView.record(event);
    },
  };
  const leases = [];
  try {
    const lease = await ShellMuxLease.create(seed, {
      native,
      resources: { pids: 4 },
      recorder: failing,
      onResourceEvent: (event) => {
        callerEvents.push(event);
        if (callerThrows) throw new Error("caller failed");
      },
    });
    leases.push(lease);
    assert.equal(lease.recorder, failing);
    assert.deepEqual(opened[0].options.resources, {
      pids: 4,
      monitorIntervalMs: 1000,
    });
    const emit = (kind, owner, pipelineId) =>
      opened[0].emit(null, { kind, owner, pipelineId, sample: undefined });

    lease.registerRecorderOwner("o1", () => recorder.add_context("A"));
    emit("started", "o1", 1);
    // A later registration affects later pipelines only, until this one finishes.
    lease.registerRecorderOwner("o1", () => recorder.add_context("B"));
    emit("sample", "o1", 1);
    emit("finished", "o1", 1);
    emit("started", "o1", 2);
    emit("started", "unknown", 3);
    emit("started", undefined, 4);
    lease.registerRecorderOwner("o2", () => undefined);
    emit("started", "o2", 5);
    assert.deepEqual(
      events.map((event) => [
        event.at,
        event.event.kind,
        event.event.pipelineId,
      ]),
      [
        ["A", "started", 1],
        ["A", "sample", 1],
        ["A", "finished", 1],
        ["B", "started", 2],
        ["lease", "started", 3],
        ["lease", "started", 4],
        ["lease", "started", 5],
      ],
    );
    assert.ok(
      events.every(
        (event) => event.resource === "memory" && event.kind === "resource",
      ),
    );
    assert.ok(events.every((event) => event.source === events[0].source));
    assert.equal(callerEvents.length, 7);

    // Either consumer failing still delivers to the other, then surfaces.
    recorderThrows = true;
    assert.throws(() => emit("sample", undefined, 4), /recorder failed/);
    assert.equal(callerEvents.length, 8);
    recorderThrows = false;
    callerThrows = true;
    assert.throws(() => emit("sample", undefined, 4), /caller failed/);
    assert.equal(events.length, 8);
    callerThrows = false;

    // An explicit interval stays; a distinct lease has a distinct source.
    const second = await ShellMuxLease.create(seed, {
      native,
      resources: { monitorIntervalMs: 50 },
      recorder: leaseView,
    });
    leases.push(second);
    assert.deepEqual(opened[1].options.resources, { monitorIntervalMs: 50 });
    opened[1].emit(null, { kind: "started", owner: "o1", pipelineId: 1 });
    assert.notEqual(events.at(-1).source, events[0].source);

    // Without a recorder the paired-option validation is unchanged.
    await assert.rejects(
      ShellMuxLease.create(seed, {
        native,
        resources: { monitorIntervalMs: 100 },
      }),
      /monitorIntervalMs requires an onResourceEvent callback/,
    );
  } finally {
    await cleanup(...leases.map((lease) => () => lease.release()), () =>
      rm(root, { recursive: true, force: true }),
    );
  }
});

test("collection bindings attribute their owner's pipelines to the bound view", {
  timeout: 30_000,
}, async () => {
  const { root, seed } = await seedFixture();
  const real = await testNative();
  let emit;
  const native = {
    ...real,
    NativeMux: {
      async open(at, options, onPolicyDecision, onResourceEvent) {
        emit = onResourceEvent;
        return real.NativeMux.openCopyTree(
          at,
          options,
          onPolicyDecision,
          onResourceEvent,
        );
      },
    },
  };
  const recorder = testRecorder();
  const { events } = recorder.root;
  const collection = await ToolCollection.create(seed, { native, recorder });
  try {
    let current = recorder.add_context("first");
    const binding = collection.bind(() => current);
    const fallback = collection.bind();
    emit(null, { kind: "started", owner: binding.owner, pipelineId: 1 });
    current = recorder.add_context("second");
    emit(null, { kind: "sample", owner: binding.owner, pipelineId: 1 });
    emit(null, { kind: "started", owner: binding.owner, pipelineId: 2 });
    emit(null, { kind: "started", owner: fallback.owner, pipelineId: 3 });
    // Closing a binding keeps its attribution for pipelines still draining.
    await binding.close();
    emit(null, { kind: "finished", owner: binding.owner, pipelineId: 2 });
    await fallback.close();
    assert.deepEqual(
      events.map((event) => event.at),
      ["first", "first", "second", "", "second"],
    );
  } finally {
    await cleanup(
      () => collection.close(),
      () => rm(root, { recursive: true, force: true }),
    );
  }
});
