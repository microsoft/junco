import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { NativeMux } from "../native/index.js";
import { createShellMuxOperations, shutdownShellMux } from "../dist/index.js";
import { readBtrfsFixture } from "./btrfs-fixture.mjs";
import { cleanup, deferred, heldChild, release, settleAgent, text } from "./helpers.mjs";
import { scriptBashTurn, scriptedModel, toolResult } from "./scripted-model.mjs";

const extensionPath = fileURLToPath(new URL("../dist/extension.js", import.meta.url));

const state = {};

before(async () => {
  // Captured before the first await: teardown restores exactly what this process inherited.
  state.previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // The runner handed this suite its disposable fixture as the working directory, and owns its
  // removal. Nothing here creates, selects, or deletes a seed.
  const { seed, tmpdir } = await readBtrfsFixture();
  state.seed = seed;
  await mkdir(join(seed, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(seed, "src/file0.txt"), "zero\n"),
    writeFile(join(seed, "src/file1.txt"), "one\n"),
    writeFile(join(seed, "src/hashline.txt"), "anchor\n"),
  ]);
  // Config, sessions and gate files stay outside the seed under test, inside the owned root.
  state.testRoot = await mkdtemp(join(tmpdir, "junco-btrfs-"));
  state.agentDir = join(state.testRoot, "agent");
  await mkdir(state.agentDir, { recursive: true });
  await writeFile(join(state.agentDir, "settings.json"), `${JSON.stringify({
    shellCommandPrefix: "export JUNCO_PERSISTED_PREFIX=prefix-ok",
    packages: [],
    compaction: { enabled: false },
    retry: { enabled: false },
  }, null, 2)}\n`);
  process.env.PI_CODING_AGENT_DIR = state.agentDir;
  state.errors = [];
});

after(async () => {
  const session = state.session;
  state.session = undefined;
  await cleanup(
    () => (session ? closePackagedSession(session) : undefined),
    // The separate final native backstop: a leaked extension lease must fail here rather
    // than be hidden by the per-case reopen probes, which deliberately run earlier.
    () => shutdownShellMux(),
    () => {
      if (state.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = state.previousAgentDir;
    },
    () => (state.testRoot ? rm(state.testRoot, { recursive: true, force: true }) : undefined),
  );
});

/**
 * Shut one packaged session down the way a host quits: settle its agent, emit the event the
 * extension's own hook listens for, and dispose it.
 *
 * Pi's ExtensionRunner.emit() catches handler exceptions and reports them to `onError`, so
 * awaiting the emission is not error detection; the suite's accumulator is.
 */
async function closePackagedSession(session) {
  await cleanup(
    () => settleAgent(session.agent),
    () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    () => assert.deepEqual(state.errors, []),
    () => session.dispose(),
  );
}

/** Load the packaged extension through Pi's own resource loader; no test-only hooks. */
async function packagedSession(sessionManager) {
  const settingsManager = SettingsManager.create(state.seed, state.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: state.seed,
    agentDir: state.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Test the packaged bash extension.",
    appendSystemPrompt: [],
    additionalExtensionPaths: [extensionPath],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const scripted = scriptedModel();
  const { session } = await createAgentSession({
    cwd: state.seed,
    agentDir: state.agentDir,
    authStorage: AuthStorage.inMemory(),
    settingsManager,
    sessionManager,
    resourceLoader,
    model: scripted.model,
  });
  try {
    await session.bindExtensions({ onError: (error) => state.errors.push(error) });
    assert.deepEqual(state.errors, []);
    session.agent.streamFn = scripted.streamFn;
  } catch (setupError) {
    // The caller never received this session, so nothing else can dispose it.
    try {
      await closePackagedSession(session);
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], "Test session setup failed");
    }
    throw setupError;
  }
  return { session, scripted };
}

/** An idle handle proves nothing about a lease; only an executed command reacquires one. */
async function assertSeedReusable(seed) {
  const mux = await NativeMux.open(seed);
  try {
    const probe = createShellMuxOperations({ principal: "lease-reopen-probe", mux });
    const chunks = [];
    const result = await probe.exec("printf 'lease-reacquired\\n'", seed, {
      onData: (data) => chunks.push(data),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "lease-reacquired\n");
  } finally {
    await mux.close();
  }
}

test("default owners lease lazily and retry a busy first command", { timeout: 120_000 }, async () => {
  const holder = await NativeMux.open(state.seed);
  const contender = createShellMuxOperations({ principal: "opening-owner" });
  try {
    // Discovery alone materializes no state directory, so it cannot have taken a lease either.
    await assert.rejects(
      access(join(state.seed, "..", ".marsh", "seed")),
      (error) => error.code === "ENOENT",
    );
    await assertSeedReusable(state.seed);

    const holding = createShellMuxOperations({ principal: "holding-owner", mux: holder });
    const holderChunks = [];
    const holderResult = await holding.exec("printf 'holder-ready\\n'", state.seed, {
      onData: (data) => holderChunks.push(data),
    });
    assert.equal(holderResult.exitCode, 0);
    assert.equal(Buffer.concat(holderChunks).toString("utf8"), "holder-ready\n");

    // An idle handle over a leased seed stays legal; only a command contends for the lease.
    const idle = await NativeMux.open(state.seed);
    await idle.close();

    const blocked = [];
    await assert.rejects(
      contender.exec(
        "printf blocked; printf forbidden > src/lease-must-not-run.txt",
        state.seed,
        { onData: (data) => blocked.push(data) },
      ),
      Error,
    );
    assert.equal(Buffer.concat(blocked).length, 0);
    await assert.rejects(
      access(join(state.seed, "src/lease-must-not-run.txt")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await holder.close();
  }

  // The same retained native session recovers: a busy first command poisons nothing.
  const chunks = [];
  const result = await contender.exec("printf 'reopened\\n'", state.seed, {
    onData: (data) => chunks.push(data),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "reopened\n");
  await shutdownShellMux();

  const concurrent = createShellMuxOperations({ principal: "concurrent-owner" });
  try {
    const collected = [[], []];
    const results = await Promise.all([
      concurrent.exec("printf first", state.seed, { onData: (data) => collected[0].push(data) }),
      concurrent.exec("printf second", state.seed, { onData: (data) => collected[1].push(data) }),
    ]);
    assert.deepEqual(results.map((entry) => entry.exitCode), [0, 0]);
    assert.equal(Buffer.concat(collected[0]).toString("utf8"), "first");
    assert.equal(Buffer.concat(collected[1]).toString("utf8"), "second");
  } finally {
    await shutdownShellMux();
  }

  // Constructor rejection and retry, which the lazy lease did not replace: the filesystem root
  // is not an admissible seed, and that failure is the opening promise's own.
  const discovery = createShellMuxOperations({ principal: "discovery-owner" });
  try {
    const rejected = [];
    await assert.rejects(
      discovery.exec("printf must-not-run", "/", { onData: (data) => rejected.push(data) }),
      Error,
    );
    assert.equal(Buffer.concat(rejected).length, 0);
    const retried = [];
    const retriedResult = await discovery.exec("printf 'discovery-retried\\n'", state.seed, {
      onData: (data) => retried.push(data),
    });
    assert.equal(retriedResult.exitCode, 0);
    assert.equal(Buffer.concat(retried).toString("utf8"), "discovery-retried\n");
  } finally {
    await shutdownShellMux();
  }
});

test("owned shutdown joins active work and closes admission", { timeout: 120_000 }, async (t) => {
  const gate = join(state.testRoot, "shutdown-gate");
  const owner = createShellMuxOperations({ principal: "shutdown-owner" });
  const blockedOwner = createShellMuxOperations({ principal: "failing-owner" });
  let held;
  try {
    const ready = deferred(t.signal, "production hold readiness");
    let output = "";
    held = owner.exec(heldChild({ gate, ready: "PROD_READY", done: "PROD_DONE" }), state.seed, {
      onData: (data) => {
        output += data.toString("utf8");
        if (output.includes("PROD_READY")) ready.resolve();
      },
    });
    held.catch(() => {});
    await ready.promise;

    // A second default owner whose first command cannot lease the seed while it is held.
    await assert.rejects(blockedOwner.exec("printf blocked", state.seed, { onData: () => {} }), Error);

    const shutdown = shutdownShellMux();
    await Promise.all([assert.rejects(held, Error), shutdown]);
    await assert.rejects(owner.exec("printf late", state.seed, { onData: () => {} }), /closed/);

    // The lease was released before shutdown settled, and is actually reacquirable.
    await assertSeedReusable(state.seed);
  } finally {
    await cleanup(
      () => release(gate),
      () => Promise.allSettled([held]),
      () => shutdownShellMux(),
    );
  }
});

test("the packaged extension registers bash with the persisted prefix", { timeout: 120_000 }, async () => {
  state.sessionManager = SessionManager.inMemory(state.seed);
  const { session, scripted } = await packagedSession(state.sessionManager);
  state.session = session;
  state.sessionId = session.sessionId;

  // Pi 0.80.6 seeds the active set with read/bash/edit/write and then adds extension tools whose
  // names are not built-ins, so the collection's same-name grep and find replacements are
  // registered but inactive until a caller selects them.
  const active = session.getActiveToolNames();
  assert.deepEqual(active.filter((name) => name === "bash"), ["bash"]);
  for (const name of ["read", "edit", "write", "ast_grep", "ast_edit", "diff"]) {
    assert.ok(active.includes(name), `${name} is no longer available`);
  }
  const registered = session.getAllTools().map((tool) => tool.name);
  for (const name of ["read", "bash", "edit", "grep", "find", "ast_grep", "ast_edit", "diff"]) {
    assert.ok(registered.includes(name), `${name} is no longer registered`);
  }

  const capture = scriptBashTurn(scripted.faux, [{
    id: "prod-1",
    command: "printf '%s\\n' \"$JUNCO_PERSISTED_PREFIX\"; printf 'claimed\\n' > src/file0.txt",
  }]);
  await session.agent.prompt("Run the scripted command");
  await session.agent.waitForIdle();

  const result = toolResult(capture.context.messages, "prod-1");
  assert.equal(result?.isError, false, `unexpected tool failure: ${result && text(result)}`);
  assert.equal(text(result), "prefix-ok\n");
  assert.equal(await readFile(join(state.seed, "src/file0.txt"), "utf8"), "claimed\n");
  assert.deepEqual(state.errors, []);
});

test("the packaged extension drives a read into a hashline edit", { timeout: 120_000 }, async () => {
  const session = state.session;
  assert.ok(session, "the packaged registration scenario did not produce a session");
  const scripted = scriptedModel();
  session.agent.streamFn = scripted.streamFn;

  const capture = {};
  scripted.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("read", { path: "src/hashline.txt" }, { id: "prod-read" })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      capture.read = toolResult(context.messages, "prod-read");
      const tag = /#([0-9A-Fa-f]{4})\]/.exec(text(capture.read));
      assert.ok(tag, `no hashline tag in read output:\n${text(capture.read)}`);
      return fauxAssistantMessage(
        [fauxToolCall(
          "edit",
          { input: `[src/hashline.txt#${tag[1]}]\nPUT 1.=1:\n+PATCHED\n` },
          { id: "prod-edit" },
        )],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      capture.edit = toolResult(context.messages, "prod-edit");
      return fauxAssistantMessage("done");
    },
  ]);
  await session.agent.prompt("Read then patch the hashline fixture");
  await session.agent.waitForIdle();

  assert.equal(capture.read?.isError, false);
  assert.match(text(capture.read), /^1:anchor$/m);
  assert.equal(
    capture.edit?.isError,
    false,
    `unexpected edit failure: ${capture.edit && text(capture.edit)}`,
  );
  assert.equal(await readFile(join(state.seed, "src/hashline.txt"), "utf8"), "PATCHED\n");
  assert.deepEqual(state.errors, []);
});

test("reload keeps the session principal and replaces disposed operations", { timeout: 120_000 }, async () => {
  const session = state.session;
  assert.ok(session, "the packaged registration scenario did not produce a session");
  // Bindings must survive: 0.80.6 only re-emits session_start when they exist.
  await session.reload();
  assert.equal(session.sessionId, state.sessionId);
  const scripted = scriptedModel();
  session.agent.streamFn = scripted.streamFn;

  // A path no earlier session staked: reload disposes the old owner, so the next command
  // reopens the seed, and a recovered stake belongs to the snapshot that published it rather
  // than to a returning job name.
  const capture = scriptBashTurn(scripted.faux, [{
    id: "prod-reload",
    command: "printf 'reloaded\\n' > src/reloaded.txt; cat src/reloaded.txt",
  }]);
  try {
    await session.agent.prompt("Run the reloaded command");
    await session.agent.waitForIdle();
    const result = toolResult(capture.context.messages, "prod-reload");
    assert.equal(result?.isError, false, `unexpected tool failure: ${result && text(result)}`);
    assert.equal(text(result), "reloaded\n");
    assert.equal(await readFile(join(state.seed, "src/reloaded.txt"), "utf8"), "reloaded\n");
  } finally {
    // dispose() neither emits nor awaits session_shutdown, so it cannot replace it. Cleared
    // whatever the outcome: a failed assertion must not leave this session for the suite's
    // backstop to close after the next case has already run.
    const closing = closePackagedSession(session);
    state.session = undefined;
    await closing;
  }
  await assertSeedReusable(state.seed);
});

test("a new session cannot inherit the previous principal's grants", { timeout: 120_000 }, async () => {
  const sessionManager = SessionManager.inMemory(state.seed);
  const { session, scripted } = await packagedSession(sessionManager);
  try {
    assert.notEqual(session.sessionId, state.sessionId);
    const capture = scriptBashTurn(scripted.faux, [{
      id: "prod-denied",
      command: "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file0.txt; true",
    }]);
    await session.agent.prompt("Run the conflicting command");
    await session.agent.waitForIdle();

    const result = toolResult(capture.context.messages, "prod-denied");
    assert.equal(result?.isError, true);
    assert.match(text(result), /Marsh policy denied publication/);
    assert.equal(await readFile(join(state.seed, "src/file0.txt"), "utf8"), "claimed\n");
    await assert.rejects(access(join(state.seed, "src/new.txt")), (error) => error.code === "ENOENT");
  } finally {
    await closePackagedSession(session);
  }
  await assertSeedReusable(state.seed);
});
