import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { acquireShellMux, createShellMuxOperations } from "../dist/index.js";
import { readBtrfsFixture } from "./btrfs-fixture.mjs";
import {
  cleanup,
  deferred,
  hashlineTag,
  nativeEnv,
  release,
  settleAgent,
  text,
} from "./helpers.mjs";
import {
  scriptBashTurn,
  scriptedModel,
  toolResult,
} from "./scripted-model.mjs";

const extensionPath = fileURLToPath(
  new URL("../dist/extension.js", import.meta.url),
);

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
  await writeFile(
    join(state.agentDir, "settings.json"),
    `${JSON.stringify(
      {
        shellCommandPrefix: "export JUNCO_PERSISTED_PREFIX=prefix-ok",
        packages: [],
        compaction: { enabled: false },
        retry: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );
  process.env.PI_CODING_AGENT_DIR = state.agentDir;
  state.errors = [];
});

after(async () => {
  const session = state.session;
  state.session = undefined;
  await cleanup(
    () => (session ? closePackagedSession(session) : undefined),
    // Session shutdown closed the packaged extension's own collection and mux.
    () => {
      if (state.previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = state.previousAgentDir;
    },
    () =>
      state.testRoot
        ? rm(state.testRoot, { recursive: true, force: true })
        : undefined,
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
    () =>
      session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      }),
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
    modelRuntime: await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    }),
    settingsManager,
    sessionManager,
    resourceLoader,
    model: scripted.model,
  });
  try {
    await session.bindExtensions({
      onError: (error) => state.errors.push(error),
    });
    assert.deepEqual(state.errors, []);
    session.agent.streamFunction = scripted.streamFn;
  } catch (setupError) {
    // The caller never received this session, so nothing else can dispose it.
    try {
      await closePackagedSession(session);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        "Test session setup failed",
      );
    }
    throw setupError;
  }
  return { session, scripted };
}

/**
 * An idle handle proves nothing about usability; only an executed command confirms a fresh
 * owner can still open the seed and run on it.
 */
async function assertSeedUsable(seed) {
  const probe = createShellMuxOperations({
    principal: "seed-probe",
    policy: "GitPolicy",
  });
  try {
    const chunks = [];
    const result = await probe.exec("printf 'seed-usable\\n'", seed, {
      onData: (data) => chunks.push(data),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "seed-usable\n");
  } finally {
    await probe.close();
  }
}

/**
 * A persistent process on its own mux over the seed: Marsh always runs it in a managed shell, so
 * while it is live, ordinary default-owned commands stay off the exclusive direct route. It
 * prints `ready`, then exits on its own once the host creates `gate`.
 */
async function managedHold(t, { gate, ready, done }) {
  const lease = await acquireShellMux(state.seed, { policy: "GitPolicy" });
  const seen = deferred(t.signal, `${ready} readiness`);
  const hold = { lease, output: "" };
  try {
    hold.process = await lease.mux.spawn(
      {
        command: process.execPath,
        args: [
          "-e",
          [
            'const fs = require("node:fs");',
            `process.stdout.write(${JSON.stringify(`${ready}\n`)});`,
            `const gate = ${JSON.stringify(gate)};`,
            "const poll = setInterval(() => {",
            "  if (!fs.existsSync(gate)) return;",
            "  clearInterval(poll);",
            `  process.stdout.write(${JSON.stringify(`${done}\n`)});`,
            "  process.exit(0);",
            "}, 10);",
          ].join("\n"),
        ],
        cwd: state.seed,
        principal: `hold-${ready}`,
        env: nativeEnv(state.testRoot),
      },
      (error, data) => {
        if (error) throw error;
        hold.output += data.toString("utf8");
        if (hold.output.includes(ready)) seen.resolve();
      },
      (error) => {
        if (error) throw error;
      },
    );
    await Promise.race([
      seen.promise,
      hold.process.wait().then(() => {
        throw new Error(`${ready} hold ended before readiness`);
      }),
    ]);
    return hold;
  } catch (error) {
    hold.process?.abort();
    await Promise.allSettled([hold.process?.wait()]);
    await lease.release();
    throw error;
  }
}

/** Release a hold's gate, join its own exit, and drop its lease. */
async function settleHold(hold, gate) {
  await cleanup(
    () => release(gate),
    () => hold?.process?.wait(),
    () => hold?.lease.release(),
  );
}

test("the packaged extension registers bash with the persisted prefix", {
  timeout: 120_000,
}, async (t) => {
  state.sessionManager = SessionManager.inMemory(state.seed);
  const { session, scripted } = await packagedSession(state.sessionManager);
  state.session = session;
  state.sessionId = session.sessionId;

  // Pi seeds the active set with read/bash/edit/write and then adds extension tools whose
  // names are not built-ins, so the collection's same-name grep and find replacements are
  // registered but inactive until a caller selects them.
  const active = session.getActiveToolNames();
  assert.deepEqual(
    active.filter((name) => name === "bash"),
    ["bash"],
  );
  for (const name of [
    "read",
    "edit",
    "write",
    "ast_grep",
    "ast_edit",
    "diff",
  ]) {
    assert.ok(active.includes(name), `${name} is no longer available`);
  }
  const registered = session.getAllTools().map((tool) => tool.name);
  for (const name of [
    "read",
    "bash",
    "edit",
    "grep",
    "find",
    "ast_grep",
    "ast_edit",
    "diff",
  ]) {
    assert.ok(registered.includes(name), `${name} is no longer registered`);
  }

  // A direct write publishes no durable grants; a live managed process over the same seed
  // makes this extension command a managed publication that the later-session test can
  // challenge.
  const gate = join(state.testRoot, "claim-peer-gate");
  let peer;
  try {
    peer = await managedHold(t, {
      gate,
      ready: "CLAIM_READY",
      done: "CLAIM_DONE",
    });

    const capture = scriptBashTurn(scripted.faux, [
      {
        id: "prod-1",
        command:
          "printf '%s\\n' \"$JUNCO_PERSISTED_PREFIX\"; printf 'claimed\\n' > src/file0.txt",
      },
    ]);
    await session.agent.prompt("Run the scripted command");
    await session.agent.waitForIdle();

    const result = toolResult(capture.context.messages, "prod-1");
    assert.equal(
      result?.isError,
      false,
      `unexpected tool failure: ${result && text(result)}`,
    );
    assert.equal(text(result), "prefix-ok\n");
    assert.equal(
      await readFile(join(state.seed, "src/file0.txt"), "utf8"),
      "claimed\n",
    );
    assert.deepEqual(state.errors, []);
    await release(gate);
    assert.equal((await peer.process.wait()).exitCode, 0);
    assert.equal(peer.output, "CLAIM_READY\nCLAIM_DONE\n");
  } finally {
    await settleHold(peer, gate);
  }
});

test("the packaged extension drives a read into a hashline edit", {
  timeout: 120_000,
}, async () => {
  const session = state.session;
  assert.ok(
    session,
    "the packaged registration scenario did not produce a session",
  );
  const scripted = scriptedModel();
  session.agent.streamFunction = scripted.streamFn;

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
        [
          fauxToolCall(
            "edit",
            { input: `[src/hashline.txt#${tag}]\nPUT 1.=1:\n+PATCHED\n` },
            { id: "prod-edit" },
          ),
        ],
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
  assert.equal(
    await readFile(join(state.seed, "src/hashline.txt"), "utf8"),
    "PATCHED\n",
  );
  assert.deepEqual(state.errors, []);
});

test("reload keeps the session principal and replaces disposed operations", {
  timeout: 120_000,
}, async () => {
  const session = state.session;
  assert.ok(
    session,
    "the packaged registration scenario did not produce a session",
  );
  // Bindings must survive reload so extension ownership is transferred to the fresh operations.
  await session.reload();
  assert.equal(session.sessionId, state.sessionId);
  const scripted = scriptedModel();
  session.agent.streamFunction = scripted.streamFn;

  // A path no earlier session staked: reload disposes the old owner, so the next command
  // reopens the seed, and a recovered stake belongs to the snapshot that published it rather
  // than to a returning job name.
  const capture = scriptBashTurn(scripted.faux, [
    {
      id: "prod-reload",
      command: "printf 'reloaded\\n' > src/reloaded.txt; cat src/reloaded.txt",
    },
  ]);
  try {
    await session.agent.prompt("Run the reloaded command");
    await session.agent.waitForIdle();
    const result = toolResult(capture.context.messages, "prod-reload");
    assert.equal(
      result?.isError,
      false,
      `unexpected tool failure: ${result && text(result)}`,
    );
    assert.equal(text(result), "reloaded\n");
    assert.equal(
      await readFile(join(state.seed, "src/reloaded.txt"), "utf8"),
      "reloaded\n",
    );
  } finally {
    // dispose() neither emits nor awaits session_shutdown, so it cannot replace it. Cleared
    // whatever the outcome: a failed assertion must not leave this session for the suite's
    // backstop to close after the next case has already run.
    const closing = closePackagedSession(session);
    state.session = undefined;
    await closing;
  }
  await assertSeedUsable(state.seed);
});

test("a new session cannot inherit the previous principal's grants", {
  timeout: 120_000,
}, async (t) => {
  const sessionManager = SessionManager.inMemory(state.seed);
  const { session, scripted } = await packagedSession(sessionManager);
  try {
    assert.notEqual(session.sessionId, state.sessionId);
    // Direct writes do not consult durable grants; hold a managed process over the same seed
    // so this challenge uses the managed route that checked the earlier session's publication.
    const gate = join(state.testRoot, "denial-peer-gate");
    let peer;
    try {
      peer = await managedHold(t, {
        gate,
        ready: "DENIAL_READY",
        done: "DENIAL_DONE",
      });

      const capture = scriptBashTurn(scripted.faux, [
        {
          id: "prod-denied",
          command:
            "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file0.txt; true",
        },
      ]);
      await session.agent.prompt("Run the conflicting command");
      await session.agent.waitForIdle();

      const result = toolResult(capture.context.messages, "prod-denied");
      assert.equal(result?.isError, true);
      assert.equal(
        await readFile(join(state.seed, "src/file0.txt"), "utf8"),
        "claimed\n",
      );
      await assert.rejects(
        access(join(state.seed, "src/new.txt")),
        (error) => error.code === "ENOENT",
      );
      await release(gate);
      assert.equal((await peer.process.wait()).exitCode, 0);
      assert.equal(peer.output, "DENIAL_READY\nDENIAL_DONE\n");
    } finally {
      await settleHold(peer, gate);
    }
  } finally {
    await closePackagedSession(session);
  }
  await assertSeedUsable(state.seed);
});

test("a nested btrfs seed is refused without disturbing an open mux", {
  timeout: 120_000,
}, async () => {
  const options = { policy: "GitPolicy" };
  const lease = await acquireShellMux(state.seed, options);
  const nested = join(state.seed, "nested-seed");
  try {
    await promisify(execFile)("btrfs", ["subvolume", "create", nested]);
    await assert.rejects(lease.mux.validateCwd(nested), Error);
    await assert.rejects(lease.mux.validateCwd(state.testRoot), Error);
    const again = await acquireShellMux(join(state.seed, "src"), options);
    await again.release();
    assert.equal(await lease.mux.exists(state.seed, "src/file0.txt"), true);
    await assertSeedUsable(state.seed);
  } finally {
    // The fixture owner deletes every subvolume under its root, this one included.
    await lease.release();
  }
});
