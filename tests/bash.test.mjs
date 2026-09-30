import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { NativeMux } from "../target/native-test/index.js";
import {
  createBashTool, createShellMuxOperations, isMarshPolicyDenied, shutdownShellMux,
} from "../dist/index.js";
import {
  childCommand,
  closeFixture,
  collector,
  deferred,
  expectedLines,
  fixture,
  heldChild,
  nativeEnv,
  numberedLines,
  quote,
  release,
  text,
} from "./helpers.mjs";

const spillOf = (message) => /Full output: ([^\]\n]+)/.exec(message)?.[1];

test("complete multi-chunk UTF-8 output and final marker precede settlement", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const outputFiles = new Set();
  try {
    const operations = createShellMuxOperations({ mux: instance.mux, principal: "output-owner" });
    const tool = createBashTool(instance.seed, { operations });
    const expected = "λ🙂".repeat(40000) + "\nFINAL-MARKER-雪\n";
    const producer = "const fs = require('node:fs'); const output = Buffer.from('λ🙂'.repeat(40000) + '\\nFINAL-MARKER-雪\\n'); for (let offset = 0; offset < output.length; offset += 4093) fs.writeSync(1, output.subarray(offset, offset + 4093));";
    const updates = [];
    const result = await tool.execute("complete-output", {
      command: `${quote(process.execPath)} -e ${quote(producer)}`,
    }, t.signal, (update) => {
      if (update.details?.fullOutputPath) outputFiles.add(update.details.fullOutputPath);
      updates.push(update);
    });
    assert.ok(result.details?.fullOutputPath);
    outputFiles.add(result.details.fullOutputPath);
    assert.equal(await readFile(result.details.fullOutputPath, "utf8"), expected);
    assert.ok(text(result).includes("FINAL-MARKER-雪\n"));
    // The final streaming update carries the marker before execute() settles.
    const final = updates.at(-1);
    assert.ok(text(final).includes("FINAL-MARKER-雪"));
    assert.equal(final.details?.fullOutputPath, result.details.fullOutputPath);
  } finally {
    await closeFixture(instance, outputFiles);
  }
});

test("callback failure rejects without killing Node or disabling the session", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const operations = createShellMuxOperations({ mux: instance.mux, principal: "callback-owner" });
    const tool = createBashTool(instance.seed, { operations });
    let receivedOutput = false;
    await assert.rejects(tool.execute("throwing-consumer", {
      // Readiness comes from the running external, as in marsh's own forced-stop fixtures.
      command: "sh -c 'printf callback-ready; exec sleep 30'",
    }, t.signal, (update) => {
      if (text(update).includes("callback-ready")) {
        receivedOutput = true;
        throw new Error("output consumer failed");
      }
    }), (error) => error instanceof Error && !isMarshPolicyDenied(error));
    assert.equal(receivedOutput, true);
    const result = await tool.execute("reuse-session", { command: "printf 'session survived\\n'" }, t.signal);
    assert.equal(text(result), "session survived\n");
  } finally {
    await closeFixture(instance);
  }
});

test("a zero-exit policy denial leaves all seed contents unchanged", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const owner = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "file-owner" }),
    });
    const intruder = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "another-agent" }),
    });
    await owner.execute("claim-file", { command: "printf 'owned\\n' > src/file0.txt" }, t.signal);
    await assert.rejects(intruder.execute("denied-publication", {
      command: "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file0.txt; true",
    }, t.signal), isMarshPolicyDenied);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(instance.seed, "src/file1.txt"), "utf8"), "one\n");
    await assert.rejects(access(join(instance.seed, "src/new.txt")), (error) => error.code === "ENOENT");

    // The raw native run rejects with the same typed denial, not only Pi's bash tool.
    const run = instance.mux.start({
      command: "printf 'stolen\\n' > src/file0.txt; true",
      cwd: instance.seed,
      principal: "native-intruder",
      env: nativeEnv(instance.root),
    }, collector().onData);
    await assert.rejects(run.wait(), isMarshPolicyDenied);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "owned\n");
  } finally {
    await closeFixture(instance);
  }
});

test("a pipeline result is returned and published to the seed", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "publish-owner" }),
    });
    const result = await tool.execute("sorted", {
      command: "printf 'b\\na\\n' | sort > src/sorted.txt; cat src/sorted.txt",
    }, t.signal);
    assert.equal(text(result), "a\nb\n");
    assert.equal(await readFile(join(instance.seed, "src/sorted.txt"), "utf8"), "a\nb\n");
  } finally {
    await closeFixture(instance);
  }
});

test("stdout and stderr both reach the tool result", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "streams-owner" }),
    });
    const result = await tool.execute("streams", {
      command: "printf 'stdout-marker\\n'; printf 'stderr-marker\\n' >&2",
    }, t.signal);
    // Independent pumps: require both markers, not an order between them.
    assert.ok(text(result).includes("stdout-marker\n"));
    assert.ok(text(result).includes("stderr-marker\n"));
  } finally {
    await closeFixture(instance);
  }
});

test("a nonzero process status rejects with its output and code", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "status-owner" }),
    });
    await assert.rejects(tool.execute("failing", {
      command: "printf 'before-failure\\n'; exit 7",
    }, t.signal), (error) => {
      assert.match(error.message, /before-failure/);
      assert.match(error.message, /Command exited with code 7/);
      return true;
    });
  } finally {
    await closeFixture(instance);
  }
});

test("commands run without a PTY and receive a real stdin EOF", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "stdin-owner" }),
    });
    const result = await tool.execute("stdin-eof", {
      command: childCommand([
        'writeAll("stdin-tty=" + Boolean(process.stdin.isTTY) + "\\n");',
        'writeAll("stdout-tty=" + Boolean(process.stdout.isTTY) + "\\n");',
        'process.stdin.on("end", () => writeAll("EOF\\n"));',
        "process.stdin.resume();",
      ].join("\n")),
    }, t.signal);
    const output = text(result);
    assert.ok(output.includes("stdin-tty=false\n"));
    assert.ok(output.includes("stdout-tty=false\n"));
    assert.ok(output.includes("EOF\n"));
  } finally {
    await closeFixture(instance);
  }
});

test("cwd, prefix, hook and literal environment reach the command verbatim", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const nested = join(instance.seed, "sub dir's");
  const literal = "quote'\"; $(touch injected)\nend";
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "probe.txt"), "nested\n");
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "context-owner" }),
      commandPrefix: "export JUNCO_PREFIX=prefix-value",
      // Supplied operations own execution, so this unusable local shell is never consulted.
      shellPath: "/junco-no-such-shell",
      spawnHook: (context) => ({
        command: `${context.command}; printf hook-tail`,
        cwd: nested,
        env: { ...context.env, JUNCO_LITERAL: literal, JUNCO_UNDEFINED: undefined },
      }),
    });
    const result = await tool.execute("context", {
      command: childCommand([
        'writeAll(JSON.stringify({',
        '  probe: fs.readFileSync("probe.txt", "utf8"),',
        '  literal: process.env.JUNCO_LITERAL ?? null,',
        '  hasUndefined: Object.hasOwn(process.env, "JUNCO_UNDEFINED"),',
        '  prefix: process.env.JUNCO_PREFIX ?? null,',
        "}));",
      ].join("\n")),
    }, t.signal);
    const output = text(result);
    assert.ok(output.endsWith("hook-tail"));
    assert.deepEqual(JSON.parse(output.slice(0, -"hook-tail".length)), {
      probe: "nested\n",
      literal,
      hasUndefined: false,
      prefix: "prefix-value",
    });
    await assert.rejects(access(join(nested, "injected")), (error) => error.code === "ENOENT");
    await assert.rejects(access(join(instance.seed, "injected")), (error) => error.code === "ENOENT");
    assert.equal(process.env.JUNCO_LITERAL, undefined);
    assert.equal(process.env.JUNCO_PREFIX, undefined);
  } finally {
    await closeFixture(instance);
  }
});

test("a working directory outside the seed never silently runs at its root", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const outside = join(instance.root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(instance.seed, "escape"), "dir");
    const operations = createShellMuxOperations({ mux: instance.mux, principal: "cwd-owner" });
    const rejected = [
      [join(instance.seed, "missing"), /Working directory does not exist/],
      [join(instance.seed, "src/file0.txt"), /Working directory is not a directory/],
      // Resolves to a directory, so only the native seed-containment check can reject it.
      [join(instance.seed, "escape"), /is outside ShellMux seed/],
    ];
    for (const [cwd, expected] of rejected) {
      await assert.rejects(createBashTool(cwd, { operations }).execute("bad-cwd", {
        command: "printf 'must-not-run\\n' > src/escaped.txt",
      }, t.signal), expected);
    }
    await assert.rejects(access(join(instance.seed, "src/escaped.txt")), (error) => error.code === "ENOENT");
    await assert.rejects(access(join(outside, "src")), (error) => error.code === "ENOENT");
    const result = await createBashTool(instance.seed, { operations }).execute("good-cwd", {
      command: "printf 'valid cwd\\n'",
    }, t.signal);
    assert.equal(text(result), "valid cwd\n");
  } finally {
    await closeFixture(instance);
  }
});

test("each call gets a fresh shell over a durable filesystem", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "reuse-owner" }),
    });
    await tool.execute("set-transient", {
      command: "export JUNCO_TEST_TRANSIENT=present; printf 'durable\\n' > src/durable.txt",
    }, t.signal);
    const result = await tool.execute("read-transient", {
      command: "printf '%s\\n' \"${JUNCO_TEST_TRANSIENT-unset}\"; cat src/durable.txt",
    }, t.signal);
    assert.equal(text(result), "unset\ndurable\n");
  } finally {
    await closeFixture(instance);
  }
});

test("a silent successful command uses Pi's empty-output result", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "silent-owner" }),
    });
    const result = await tool.execute("silent", { command: "true" }, t.signal);
    assert.equal(text(result), "(no output)");
    assert.equal(result.details, undefined);
  } finally {
    await closeFixture(instance);
  }
});

test("the line limit bounds the tail and persists complete output", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const outputFiles = new Set();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "lines-owner" }),
    });
    const track = (updates) => (update) => {
      if (update.details?.fullOutputPath) outputFiles.add(update.details.fullOutputPath);
      updates.push(update);
    };

    const atLimit = await tool.execute("at-line-limit", {
      command: childCommand(numberedLines(DEFAULT_MAX_LINES)),
    }, t.signal, track([]));
    assert.equal(text(atLimit), expectedLines(DEFAULT_MAX_LINES));
    assert.equal(atLimit.details, undefined);

    const updates = [];
    const overLimit = await tool.execute("over-line-limit", {
      command: childCommand(numberedLines(3000)),
    }, t.signal, track(updates));
    const truncation = overLimit.details?.truncation;
    assert.equal(truncation?.truncatedBy, "lines");
    assert.equal(truncation.totalLines, 3000);
    assert.equal(truncation.outputLines, DEFAULT_MAX_LINES);
    assert.ok(truncation.totalBytes < DEFAULT_MAX_BYTES);
    const tail = text(overLimit);
    assert.ok(tail.includes("line-1001\n"));
    assert.ok(tail.includes("line-3000"));
    assert.ok(!tail.includes("line-0001"));
    outputFiles.add(overLimit.details.fullOutputPath);
    assert.equal(await readFile(overLimit.details.fullOutputPath, "utf8"), expectedLines(3000));
    const final = updates.findLast((update) => text(update).length > 0);
    assert.ok(text(final).includes("line-3000"));
    assert.equal(final.details?.fullOutputPath, overLimit.details.fullOutputPath);
  } finally {
    await closeFixture(instance, outputFiles);
  }
});

test("the byte limit truncates only past its boundary and keeps every byte", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const outputFiles = new Set();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "bytes-owner" }),
    });
    const line = (count) => childCommand(`writeAll("x".repeat(${count}));`);

    const atLimit = await tool.execute("at-byte-limit", { command: line(DEFAULT_MAX_BYTES) }, t.signal);
    assert.equal(text(atLimit), "x".repeat(DEFAULT_MAX_BYTES));
    assert.equal(atLimit.details, undefined);

    const overLimit = await tool.execute("over-byte-limit", {
      command: line(DEFAULT_MAX_BYTES + 1),
    }, t.signal, (update) => {
      if (update.details?.fullOutputPath) outputFiles.add(update.details.fullOutputPath);
    });
    const truncation = overLimit.details?.truncation;
    assert.equal(truncation?.truncatedBy, "bytes");
    assert.equal(truncation.lastLinePartial, true);
    assert.equal(truncation.totalBytes, DEFAULT_MAX_BYTES + 1);
    outputFiles.add(overLimit.details.fullOutputPath);
    assert.equal(
      await readFile(overLimit.details.fullOutputPath, "utf8"),
      "x".repeat(DEFAULT_MAX_BYTES + 1),
    );
  } finally {
    await closeFixture(instance, outputFiles);
  }
});

test("aborting a running command keeps its output and publishes nothing", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const gate = join(instance.root, "cancel-gate");
  const outputFiles = new Set();
  const controller = new AbortController();
  let run;
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "cancel-owner" }),
    });
    const held = heldChild({
      gate,
      ready: "CANCEL_READY",
      done: "CANCEL_DONE",
      prelude: numberedLines(3000),
    });
    let readySeen = false;
    run = tool.execute("cancelled", {
      command: `printf 'staged\\n' > src/cancelled.txt; ${held}`,
    }, AbortSignal.any([t.signal, controller.signal]), (update) => {
      if (update.details?.fullOutputPath) outputFiles.add(update.details.fullOutputPath);
      if (!readySeen && text(update).includes("CANCEL_READY")) {
        readySeen = true;
        controller.abort();
      }
    });
    let spill;
    await assert.rejects(run, (error) => {
      assert.match(error.message, /Command aborted/);
      spill = spillOf(error.message);
      assert.ok(spill, `no spill path in: ${error.message}`);
      outputFiles.add(spill);
      return true;
    });
    assert.equal(readySeen, true);
    const persisted = await readFile(spill, "utf8");
    assert.equal(persisted, `${expectedLines(3000)}CANCEL_READY\n`);
    await assert.rejects(access(join(instance.seed, "src/cancelled.txt")), (error) => error.code === "ENOENT");
    const recovered = await tool.execute("recovered", { command: "printf recovered" }, t.signal);
    assert.equal(text(recovered), "recovered");
  } finally {
    controller.abort();
    await Promise.allSettled([run]);
    await closeFixture(instance, outputFiles);
  }
});

test("a timeout keeps its output and publishes nothing", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const gate = join(instance.root, "timeout-gate");
  const outputFiles = new Set();
  let run;
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "timeout-owner" }),
    });
    const held = heldChild({
      gate,
      ready: "TIMEOUT_READY",
      done: "TIMEOUT_DONE",
      prelude: numberedLines(3000),
    });
    let readySeen = false;
    run = tool.execute("timed-out", {
      command: `printf 'staged\\n' > src/timed-out.txt; ${held}`,
      timeout: 2,
    }, t.signal, (update) => {
      if (update.details?.fullOutputPath) outputFiles.add(update.details.fullOutputPath);
      if (text(update).includes("TIMEOUT_READY")) readySeen = true;
    });
    let spill;
    await assert.rejects(run, (error) => {
      assert.match(error.message, /Command timed out after 2 seconds/);
      spill = spillOf(error.message);
      assert.ok(spill, `no spill path in: ${error.message}`);
      outputFiles.add(spill);
      return true;
    });
    // A silent timeout would not cover partial-output retention.
    assert.equal(readySeen, true);
    const persisted = await readFile(spill, "utf8");
    assert.equal(persisted, `${expectedLines(3000)}TIMEOUT_READY\n`);
    await assert.rejects(access(join(instance.seed, "src/timed-out.txt")), (error) => error.code === "ENOENT");
    const recovered = await tool.execute("recovered", { command: "printf recovered" }, t.signal);
    assert.equal(text(recovered), "recovered");
  } finally {
    await release(gate).catch(() => {});
    await Promise.allSettled([run]);
    await closeFixture(instance, outputFiles);
  }
});

test("a pre-aborted signal rejects before the command can run", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "pre-abort-owner" }),
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tool.execute("pre-aborted", {
      command: "printf 'ran\\n' > src/must-not-run.txt",
    }, controller.signal), /Command aborted/);
    await assert.rejects(access(join(instance.seed, "src/must-not-run.txt")), (error) => error.code === "ENOENT");
    const result = await tool.execute("after-pre-abort", { command: "printf 'usable\\n'" }, t.signal);
    assert.equal(text(result), "usable\n");
  } finally {
    await closeFixture(instance);
  }
});

test("invalid timeouts are rejected before any work is admitted", { timeout: 30_000 }, async () => {
  const instance = await fixture();
  try {
    const operations = createShellMuxOperations({ mux: instance.mux, principal: "validation-owner" });
    // Direct calls: NaN and Infinity have no JSON tool-argument representation.
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483.648]) {
      await assert.rejects(
        operations.exec("printf 'must-not-run\\n' > src/invalid.txt", instance.seed, {
          onData: () => {},
          timeout,
        }),
        /Invalid timeout/,
        `timeout ${timeout} was not rejected`,
      );
    }
    await assert.rejects(access(join(instance.seed, "src/invalid.txt")), (error) => error.code === "ENOENT");
    const chunks = [];
    const result = await operations.exec("printf valid", instance.seed, {
      onData: (data) => chunks.push(data),
      timeout: 2147483.647,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "valid");
  } finally {
    await closeFixture(instance);
  }
});

test("a cancelled queue member cannot release its successor early", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const gate = join(instance.root, "queue-gate");
  const runs = [];
  try {
    const env = nativeEnv(instance.root);
    const ready = deferred(t.signal, "queue head readiness");
    const headOutput = collector((output) => {
      if (output.includes("QUEUE_READY")) ready.resolve();
    });
    // Synchronous start() calls fix admission order; tool.execute would race on stat().
    const head = instance.mux.start({
      command: `printf 'A' > src/first.txt; ${heldChild({ gate, ready: "QUEUE_READY", done: "QUEUE_DONE" })}`,
      cwd: instance.seed,
      principal: "queue-owner",
      env,
    }, headOutput.onData);
    runs.push(head);
    await ready.promise;

    const cancelledOutput = collector();
    const cancelled = instance.mux.start({
      command: "printf B > src/cancelled-queue.txt",
      cwd: instance.seed,
      principal: "queue-owner",
      env,
    }, cancelledOutput.onData);
    runs.push(cancelled);
    cancelled.abort();

    const successorOutput = collector();
    const successor = instance.mux.start({
      command: "cat src/first.txt; printf C",
      cwd: instance.seed,
      principal: "queue-owner",
      env,
      timeoutMs: 1000,
    }, successorOutput.onData);
    runs.push(successor);

    // Deliberately longer than the successor's deadline: queue wait is not execution time.
    await delay(1200);
    assert.equal(successorOutput.output, "");
    await release(gate);

    const [headResult, cancelledResult, successorResult] = await Promise.all(runs.map((run) => run.wait()));
    assert.deepEqual(headResult, { exitCode: 0, cancelled: false, timedOut: false });
    assert.equal(cancelledResult.cancelled, true);
    assert.deepEqual(successorResult, { exitCode: 0, cancelled: false, timedOut: false });
    assert.equal(successorOutput.output, "AC");
    assert.equal(await readFile(join(instance.seed, "src/first.txt"), "utf8"), "A");
    assert.equal(cancelledOutput.output, "");
    await assert.rejects(access(join(instance.seed, "src/cancelled-queue.txt")), (error) => error.code === "ENOENT");
  } finally {
    for (const run of runs) run.abort();
    await release(gate).catch(() => {});
    await Promise.allSettled(runs.map((run) => run.wait()));
    await closeFixture(instance);
  }
});

test("independent principals overlap without cross-routing output", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const gates = { a: join(instance.root, "gate-a"), b: join(instance.root, "gate-b") };
  const runs = [];
  try {
    const env = nativeEnv(instance.root);
    const readyA = deferred(t.signal, "agent-a readiness");
    const readyB = deferred(t.signal, "agent-b readiness");
    const outputA = collector((output) => {
      if (output.includes("READY-A")) readyA.resolve();
    });
    const outputB = collector((output) => {
      if (output.includes("READY-B")) readyB.resolve();
    });
    // Read-only holds: a shared file would turn a routing failure into a policy failure.
    const runA = instance.mux.start({
      command: heldChild({ gate: gates.a, ready: "READY-A", done: "DONE-A" }),
      cwd: instance.seed,
      principal: "agent-a",
      env,
    }, outputA.onData);
    runs.push(runA);
    const runB = instance.mux.start({
      command: heldChild({ gate: gates.b, ready: "READY-B", done: "DONE-B" }),
      cwd: instance.seed,
      principal: "agent-b",
      env,
    }, outputB.onData);
    runs.push(runB);

    await Promise.all([readyA.promise, readyB.promise]);
    await release(gates.b);
    const resultB = await runB.wait();
    await release(gates.a);
    const resultA = await runA.wait();

    assert.deepEqual(resultA, { exitCode: 0, cancelled: false, timedOut: false });
    assert.deepEqual(resultB, { exitCode: 0, cancelled: false, timedOut: false });
    assert.equal(outputA.output, "READY-A\nDONE-A\n");
    assert.equal(outputB.output, "READY-B\nDONE-B\n");
  } finally {
    for (const run of runs) run.abort();
    await Promise.all([release(gates.a).catch(() => {}), release(gates.b).catch(() => {})]);
    await Promise.allSettled(runs.map((run) => run.wait()));
    await closeFixture(instance);
  }
});

test("fresh shells and reopened seeds do not inherit a reused name's grants", { timeout: 30_000 }, async () => {
  const instance = await fixture();
  let mux = instance.mux;
  try {
    const claim = collector();
    const retained = mux.start({
      command: "printf 'claimed\\n' > src/file0.txt",
      cwd: instance.seed,
      principal: "file-owner",
      env: nativeEnv(instance.root),
    }, claim.onData);
    const claimed = await retained.wait();
    assert.deepEqual(claimed, { exitCode: 0, cancelled: false, timedOut: false });
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "claimed\n");

    const owner = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux, principal: "file-owner" }),
    });
    const intruder = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux, principal: "another-agent" }),
    });
    // A fresh shell gets an opaque owner unrelated to any principal name: reusing the name that
    // took the earlier stake grants no ownership of it, even against the same live mux.
    await assert.rejects(owner.execute("reclaim", {
      command: "printf 'reclaimed\\n' > src/file0.txt; printf ok",
    }, undefined), isMarshPolicyDenied);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "claimed\n");

    await assert.rejects(intruder.execute("denied-live", {
      command: "printf 'new\\n' > src/intruder.txt; printf 'stolen\\n' > src/file0.txt; true",
    }, undefined), isMarshPolicyDenied);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "claimed\n");
    await assert.rejects(access(join(instance.seed, "src/intruder.txt")), (error) => error.code === "ENOENT");

    await mux.close();
    // The retained run reference stays alive across this reopen on purpose.
    mux = await NativeMux.openCopyTree(instance.seed, { sandbox: "always" });
    assert.deepEqual(await retained.wait(), claimed);

    // A fresh shell after reopen is exactly as unprivileged as a fresh shell before it: a
    // returning name inherits nothing an earlier session left unsettled.
    const returning = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux, principal: "file-owner" }),
    });
    await assert.rejects(returning.execute("denied-after-reopen", {
      command: "printf 'stolen\\n' > src/file0.txt; true",
    }, undefined), isMarshPolicyDenied);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "claimed\n");

    // Recovering a stake must not invent one: an unclaimed path is still free after a reopen.
    const fresh = await returning.execute("fresh-after-reopen", {
      command: "printf 'fresh\\n' > src/after-reopen.txt; printf ok",
    }, undefined);
    assert.equal(text(fresh), "ok");
    assert.equal(await readFile(join(instance.seed, "src/after-reopen.txt"), "utf8"), "fresh\n");
  } finally {
    await closeFixture({ root: instance.root, mux });
  }
});

test("close fences admission, joins runs, and discards staged work", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  let mux = instance.mux;
  // Deliberately never released: close must reclaim the held job itself.
  const gate = join(instance.root, "close-gate");
  try {
    const env = nativeEnv(instance.root);
    const ready = deferred(t.signal, "close fence readiness");
    const held = collector((output) => {
      if (output.includes("CLOSE_READY")) ready.resolve();
    });
    const active = mux.start({
      command: `printf 'staged\\n' > src/closed.txt; ${heldChild({ gate, ready: "CLOSE_READY", done: "CLOSE_DONE" })}`,
      cwd: instance.seed,
      principal: "close-owner",
      env,
    }, held.onData);
    await ready.promise;
    const queued = collector();
    const pending = mux.start({
      command: "printf 'queued\\n' > src/queued.txt",
      cwd: instance.seed,
      principal: "close-owner",
      env,
    }, queued.onData);

    const closings = [mux.close(), mux.close()];
    const lateRead = assert.rejects(mux.readFile(instance.seed, "src/file0.txt"), /closed/);
    assert.throws(() => mux.start({
      command: "printf late",
      cwd: instance.seed,
      principal: "close-owner",
      env,
    }, collector().onData), /closed/);

    const [activeResult, pendingResult] = await Promise.all([active.wait(), pending.wait()]);
    await Promise.all([...closings, lateRead]);
    assert.equal(activeResult.cancelled, true);
    assert.equal(pendingResult.cancelled, true);
    assert.equal(queued.output, "");
    const settledCalls = held.calls;
    assert.ok(settledCalls > 0);
    await assert.rejects(access(join(instance.seed, "src/closed.txt")), (error) => error.code === "ENOENT");
    await assert.rejects(access(join(instance.seed, "src/queued.txt")), (error) => error.code === "ENOENT");

    mux = await NativeMux.openCopyTree(instance.seed, { sandbox: "always" });
    const reused = collector();
    const reopened = mux.start({
      command: "printf reopened",
      cwd: instance.seed,
      principal: "close-owner",
      env,
    }, reused.onData);
    assert.deepEqual(await reopened.wait(), { exitCode: 0, cancelled: false, timedOut: false });
    assert.equal(reused.output, "reopened");
    // A new session must never deliver output to the closed session's callback.
    assert.equal(held.calls, settledCalls);
  } finally {
    await closeFixture({ root: instance.root, mux });
  }
});

test("shutdownShellMux leaves a borrowed mux and its active run alone", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const gate = join(instance.root, "borrowed-gate");
  let run;
  try {
    const tool = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "borrowed-owner" }),
    });
    const ready = deferred(t.signal, "borrowed readiness");
    run = tool.execute("borrowed", {
      command: heldChild({ gate, ready: "BORROW_READY", done: "BORROW_DONE" }),
    }, t.signal, (update) => {
      if (text(update).includes("BORROW_READY")) ready.resolve();
    });
    await ready.promise;
    await shutdownShellMux();
    await release(gate);
    const result = await run;
    assert.ok(text(result).includes("BORROW_DONE\n"));
    const after = await tool.execute("after-shutdown", { command: "printf 'still open\\n'" }, t.signal);
    assert.equal(text(after), "still open\n");
  } finally {
    await release(gate).catch(() => {});
    await Promise.allSettled([run]);
    await closeFixture(instance);
  }
});
