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
import { cleanup, deferred, hashlineTag, heldChild, release, settleAgent, text } from "./helpers.mjs";
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

/** An idle handle proves nothing about usability; only an executed command confirms the seed still works. */
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

test("default owners run concurrently over shared source authority", { timeout: 120_000 }, async (t) => {
  // A held direct command excludes every other admission; keep this source managed so the
  // independent default owner can exercise concurrent publication authority.
  const holder = await NativeMux.open(state.seed, { sandbox: "always" });
  const contender = createShellMuxOperations({ principal: "opening-owner" });
  const gate = join(state.testRoot, "shared-authority-gate");
  let held;
  let heldSettled = false;
  try {
    await assertSeedReusable(state.seed);

    const holding = createShellMuxOperations({ principal: "holding-owner", mux: holder });
    const ready = deferred(t.signal, "shared-authority hold readiness");
    let output = "";
    held = holding.exec(heldChild({ gate, ready: "SHARE_READY", done: "SHARE_DONE" }), state.seed, {
      signal: t.signal,
      onData: (data) => {
        output += data.toString("utf8");
        if (output.includes("SHARE_READY")) ready.resolve();
      },
    });
    const settled = () => { heldSettled = true; };
    held.then(settled, settled);
    await Promise.race([
      ready.promise,
      held.then(() => { throw new Error("shared-authority hold ended before readiness"); }),
    ]);

    // Read-only: an unrelated file write here could turn a source-sharing test into a
    // policy or stale-view test, copying tests/bash.test.mjs's independent-principal pattern.
    const concurrentChunks = [];
    const concurrentResult = await contender.exec("printf 'concurrent-ok\\n'", state.seed, {
      signal: t.signal,
      onData: (data) => concurrentChunks.push(data),
    });
    assert.equal(concurrentResult.exitCode, 0);
    assert.equal(Buffer.concat(concurrentChunks).toString("utf8"), "concurrent-ok\n");
    assert.equal(heldSettled, false);

    await release(gate);
    const heldResult = await held;
    assert.equal(heldResult.exitCode, 0);
    assert.equal(output, "SHARE_READY\nSHARE_DONE\n");
    await holder.close();

    // The same retained native session recovers: closing the borrowed mux disposed neither it
    // nor the default owners' shared source authority.
    const chunks = [];
    const result = await contender.exec("printf 'reopened\\n'", state.seed, {
      onData: (data) => chunks.push(data),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "reopened\n");
  } finally {
    await cleanup(
      () => release(gate),
      () => holder.close(),
      () => Promise.allSettled([held]),
      () => shutdownShellMux(),
    );
  }

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

  // Constructor rejection and retry: the filesystem root is not an admissible seed, and that
  // failure is the opening promise's own.
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
  const peerGate = join(state.testRoot, "shutdown-peer-gate");
  const peer = await NativeMux.open(state.seed, { sandbox: "always" });
  const owner = createShellMuxOperations({ principal: "shutdown-owner" });
  const concurrentOwner = createShellMuxOperations({ principal: "concurrent-during-shutdown" });
  let held;
  let peerRun;
  let heldSettled = false;
  try {
    // An independent managed shell keeps both default-owned commands off the exclusive direct route.
    const peerReady = deferred(t.signal, "production managed-peer readiness");
    let peerOutput = "";
    peerRun = createShellMuxOperations({ mux: peer, principal: "shutdown-managed-peer" }).exec(
      heldChild({ gate: peerGate, ready: "PEER_READY", done: "PEER_DONE" }),
      state.seed,
      {
        signal: t.signal,
        onData: (data) => {
          peerOutput += data.toString("utf8");
          if (peerOutput.includes("PEER_READY")) peerReady.resolve();
        },
      },
    );
    await Promise.race([
      peerReady.promise,
      peerRun.then(() => { throw new Error("managed peer ended before readiness"); }),
    ]);

    const ready = deferred(t.signal, "production hold readiness");
    let output = "";
    held = owner.exec(heldChild({ gate, ready: "PROD_READY", done: "PROD_DONE" }), state.seed, {
      signal: t.signal,
      onData: (data) => {
        output += data.toString("utf8");
        if (output.includes("PROD_READY")) ready.resolve();
      },
    });
    const settled = () => { heldSettled = true; };
    held.then(settled, settled);
    await Promise.race([
      ready.promise,
      held.then(() => { throw new Error("production hold ended before readiness"); }),
    ]);

    // A second default owner runs concurrently over the same shared source authority while
    // the first command is still held; shutdown, not admission, must stop the active command.
    const concurrentChunks = [];
    const concurrentResult = await concurrentOwner.exec("printf 'not-blocked\\n'", state.seed, {
      signal: t.signal,
      onData: (data) => concurrentChunks.push(data),
    });
    assert.equal(concurrentResult.exitCode, 0);
    assert.equal(Buffer.concat(concurrentChunks).toString("utf8"), "not-blocked\n");
    assert.equal(heldSettled, false);

    const shutdown = shutdownShellMux();
    await Promise.all([assert.rejects(held, Error), shutdown]);
    await assert.rejects(owner.exec("printf late", state.seed, { onData: () => {} }), /closed/);
    await release(peerGate);
    assert.equal((await peerRun).exitCode, 0);
    assert.equal(peerOutput, "PEER_READY\nPEER_DONE\n");
    await peer.close();

    // The seed is a usable source again after shutdown settled; this is an execution probe,
    // never proof that some exclusive lease was reacquired.
    await assertSeedReusable(state.seed);
  } finally {
    await cleanup(
      () => release(gate),
      () => release(peerGate),
      () => Promise.allSettled([held, peerRun]),
      () => peer.close(),
      () => shutdownShellMux(),
    );
  }
});

test("the packaged extension registers bash with the persisted prefix", { timeout: 120_000 }, async (t) => {
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

  // A direct write publishes no durable grants; another live managed shell makes this
  // extension command a managed publication that the later-session test can challenge.
  const peer = await NativeMux.open(state.seed, { sandbox: "always" });
  const gate = join(state.testRoot, "claim-peer-gate");
  let peerRun;
  try {
    const ready = deferred(t.signal, "managed claim peer readiness");
    let output = "";
    peerRun = createShellMuxOperations({ mux: peer, principal: "managed-claim-peer" }).exec(
      heldChild({ gate, ready: "CLAIM_READY", done: "CLAIM_DONE" }),
      state.seed,
      {
        signal: t.signal,
        onData: (data) => {
          output += data.toString("utf8");
          if (output.includes("CLAIM_READY")) ready.resolve();
        },
      },
    );
    await Promise.race([
      ready.promise,
      peerRun.then(() => { throw new Error("claim peer ended before readiness"); }),
    ]);

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
    await release(gate);
    assert.equal((await peerRun).exitCode, 0);
    assert.equal(output, "CLAIM_READY\nCLAIM_DONE\n");
  } finally {
    await cleanup(
      () => release(gate),
      () => Promise.allSettled([peerRun]),
      () => peer.close(),
    );
  }
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
      const tag = hashlineTag(text(capture.read));
      assert.ok(tag, `no hashline tag in read output:\n${text(capture.read)}`);
      return fauxAssistantMessage(
        [fauxToolCall(
          "edit",
          { input: `[src/hashline.txt#${tag}]\nPUT 1.=1:\n+PATCHED\n` },
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

test("a new session cannot inherit the previous principal's grants", { timeout: 120_000 }, async (t) => {
  const sessionManager = SessionManager.inMemory(state.seed);
  const { session, scripted } = await packagedSession(sessionManager);
  try {
    assert.notEqual(session.sessionId, state.sessionId);
    // Direct writes do not consult durable grants; hold another shell so this challenge
    // uses the managed route that checked the earlier session's publication.
    const peer = await NativeMux.open(state.seed, { sandbox: "always" });
    const gate = join(state.testRoot, "denial-peer-gate");
    let peerRun;
    try {
      const ready = deferred(t.signal, "managed denial peer readiness");
      let output = "";
      peerRun = createShellMuxOperations({ mux: peer, principal: "managed-denial-peer" }).exec(
        heldChild({ gate, ready: "DENIAL_READY", done: "DENIAL_DONE" }),
        state.seed,
        {
          signal: t.signal,
          onData: (data) => {
            output += data.toString("utf8");
            if (output.includes("DENIAL_READY")) ready.resolve();
          },
        },
      );
      await Promise.race([
        ready.promise,
        peerRun.then(() => { throw new Error("denial peer ended before readiness"); }),
      ]);

      const capture = scriptBashTurn(scripted.faux, [{
        id: "prod-denied",
        command: "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file0.txt; true",
      }]);
      await session.agent.prompt("Run the conflicting command");
      await session.agent.waitForIdle();

      const result = toolResult(capture.context.messages, "prod-denied");
      assert.equal(result?.isError, true);
      assert.equal(await readFile(join(state.seed, "src/file0.txt"), "utf8"), "claimed\n");
      await assert.rejects(access(join(state.seed, "src/new.txt")), (error) => error.code === "ENOENT");
      await release(gate);
      assert.equal((await peerRun).exitCode, 0);
      assert.equal(output, "DENIAL_READY\nDENIAL_DONE\n");
    } finally {
      await cleanup(
        () => release(gate),
        () => Promise.allSettled([peerRun]),
        () => peer.close(),
      );
    }
  } finally {
    await closePackagedSession(session);
  }
  await assertSeedReusable(state.seed);
});
