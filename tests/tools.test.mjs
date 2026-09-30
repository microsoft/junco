import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { ToolCollection, createBashTool, createShellMuxOperations } from "../dist/index.js";
import {
  cleanup, closeFixture, collector, deferred, fixture, heldChild,
  nativeEnv, release, sdkResources, settleAgent, text,
} from "./helpers.mjs";
import { scriptBashTurn, scriptedModel, toolResult } from "./scripted-model.mjs";

const workspacePrefix = fileURLToPath(new URL("../target/tools-test-", import.meta.url));

/**
 * A CopyTree seed holding `files`, plus a collection over a borrowed test-addon mux on it.
 * `root` is the seed; its marsh state lives beside it, inside the disposable scratch root.
 */
async function workspace(files = {}, { sandbox = "shared" } = {}) {
  const scratch = await mkdtemp(workspacePrefix);
  const root = join(scratch, "seed");
  let mux;
  try {
    await mkdir(root);
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(join(root, relative, ".."), { recursive: true });
      await writeFile(join(root, relative), content);
    }
    const native = await import("../target/native-test/index.js");
    mux = await native.NativeMux.openCopyTree(root, { sandbox });
    const collection = await ToolCollection.create(root, { mux, native });
    const byName = new Map(collection.tools.map((tool) => [tool.name, tool]));
    return {
      root,
      mux,
      collection,
      call: (name, input, signal) => byName.get(name).execute(`tools-${name}`, input, signal, undefined),
      file: (relative) => readFile(join(root, relative), "utf8"),
      write: (relative, content) => writeFile(join(root, relative), content),
      dispose: () => cleanup(() => mux.close(), () => rm(scratch, { recursive: true, force: true })),
    };
  } catch (error) {
    await cleanup(() => mux?.close(), () => rm(scratch, { recursive: true, force: true }));
    throw error;
  }
}

/** The 4-hex tag a tagged read/grep section advertises. */
function tagOf(output) {
  const match = /#([0-9A-Fa-f]{4})\]/.exec(output);
  assert.ok(match, `expected a hashline tag in:\n${output}`);
  return match[1];
}

test("a partial read anchors only the lines it displayed", { timeout: 30_000 }, async () => {
  const ws = await workspace({ "two.txt": "alpha\nbravo\n" });
  try {
    const first = text(await ws.call("read", { path: "two.txt", limit: 1 }));
    assert.match(first, /^1:alpha$/m);
    assert.doesNotMatch(first, /^2:/m);

    await assert.rejects(
      ws.call("edit", { input: `[two.txt#${tagOf(first)}]\nPUT 2.=2:\n+BRAVO\n` }),
      /never displayed/,
    );
    assert.equal(await ws.file("two.txt"), "alpha\nbravo\n");

    const second = text(await ws.call("read", { path: "two.txt", offset: 2 }));
    assert.match(second, /^2:bravo$/m);
    await ws.call("edit", { input: `[two.txt#${tagOf(second)}]\nPUT 2.=2:\n+BRAVO\n` });
    assert.equal(await ws.file("two.txt"), "alpha\nBRAVO\n");
  } finally {
    await ws.dispose();
  }
});

test("a natively shortened grep row carries no tag", { timeout: 30_000 }, async () => {
  const ws = await workspace({
    "long.txt": `${"x".repeat(600)}needle\n`,
    "short.txt": "needle\n",
  });
  try {
    const output = text(await ws.call("grep", { pattern: "needle", path: "." }));
    assert.match(output, /^\[long\.txt\]$/m, output);
    assert.doesNotMatch(output, /\[long\.txt#/);
    // A neighbouring complete row still anchors normally.
    assert.match(output, /^\[short\.txt#[0-9A-Fa-f]{4}\]$/m);
  } finally {
    await ws.dispose();
  }
});

test("tagged views fold BOM and CRLF while writes preserve them", { timeout: 30_000 }, async () => {
  const ws = await workspace({ "bom.txt": "\ufefffirst\r\nsecond  \r\n" });
  try {
    const read = text(await ws.call("read", { path: "bom.txt" }));
    assert.match(read, /^1:first$/m);
    // Trailing whitespace belongs to the editable view and must survive display.
    assert.match(read, /^2:second {2}$/m);

    const grep = text(await ws.call("grep", { pattern: "second", path: "bom.txt" }));
    assert.match(grep, /^\*2:second {2}$/m, grep);

    await ws.call("edit", { input: `[bom.txt#${tagOf(read)}]\nPUT 1.=1:\n+FIRST\n` });
    assert.equal(await ws.file("bom.txt"), "\ufeffFIRST\r\nsecond  \r\n");
  } finally {
    await ws.dispose();
  }
});

test("a notebook edits through its decoded cells", { timeout: 30_000 }, async () => {
  const source = JSON.stringify({
    cells: [{
      cell_type: "code",
      execution_count: null,
      metadata: { tags: ["keep"] },
      outputs: [],
      source: ["print('hi')\n"],
    }],
    metadata: { kernelspec: { name: "python3", display_name: "Python 3" }, custom: "untouched" },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1);
  const ws = await workspace({ "nb.ipynb": source });
  try {
    const read = text(await ws.call("read", { path: "nb.ipynb" }));
    assert.match(read, /^2:print\('hi'\)$/m, read);
    assert.doesNotMatch(read, /nbformat/);

    await ws.call("edit", { input: `[nb.ipynb#${tagOf(read)}]\nPUT 2.=2:\n+print('bye')\n` });
    const persisted = JSON.parse(await ws.file("nb.ipynb"));
    assert.deepEqual(persisted.cells[0].source, ["print('bye')\n"]);
    assert.deepEqual(persisted.cells[0].metadata, { tags: ["keep"] });
    assert.deepEqual(persisted.metadata, {
      kernelspec: { name: "python3", display_name: "Python 3" },
      custom: "untouched",
    });
    assert.equal(persisted.nbformat, 4);

    // A notebook's raw JSON lines are never what grep displays, so no anchor.
    const grep = text(await ws.call("grep", { pattern: "nbformat", path: "nb.ipynb" }));
    assert.match(grep, /^\[nb\.ipynb\]$/m, grep);
  } finally {
    await ws.dispose();
  }
});

test("unsnapshottable reads fall through without an anchor", { timeout: 60_000 }, async () => {
  const ws = await workspace({ "empty.txt": "" });
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(ws.root, "dot.png"), png);
    const image = await ws.call("read", { path: "dot.png" });
    assert.deepEqual(image.content.map((part) => part.type), ["text", "image"]);
    assert.doesNotMatch(text(image), /#[0-9A-Fa-f]{4}\]/);

    // Past pi-edit's 4 MiB snapshot cap: ordinary Pi read output, no tag.
    await writeFile(join(ws.root, "big.txt"), "line\n".repeat(900_000));
    const big = await ws.call("read", { path: "big.txt", limit: 2 });
    assert.equal(text(big).split("\n")[0], "line");
    assert.doesNotMatch(text(big), /#[0-9A-Fa-f]{4}\]/);

    // An empty file has a real snapshot; its tag must be the hash of "".
    const native = await import("../native/index.js");
    const empty = text(await ws.call("read", { path: "empty.txt" }));
    assert.equal(tagOf(empty), native.hashlineFileHash(""));
  } finally {
    await ws.dispose();
  }
});

test("a stale tag rejects an ambiguous anchor and recovers a stable one", { timeout: 30_000 }, async () => {
  const drifted = await workspace({ "drift.txt": "one\ntwo\nthree\n" });
  try {
    const tag = tagOf(text(await drifted.call("read", { path: "drift.txt" })));
    await drifted.write("drift.txt", "one\nCHANGED\nthree\n");
    await assert.rejects(
      drifted.call("edit", { input: `[drift.txt#${tag}]\nPUT 2.=2:\n+TWO\n` }),
      /file changed between read and edit/,
    );
    assert.equal(await drifted.file("drift.txt"), "one\nCHANGED\nthree\n");
  } finally {
    await drifted.dispose();
  }

  const stable = await workspace({ "drift.txt": "one\ntwo\nthree\n" });
  try {
    const tag = tagOf(text(await stable.call("read", { path: "drift.txt" })));
    await stable.write("drift.txt", "one\ntwo\nthree\nfour\n");
    const result = await stable.call("edit", { input: `[drift.txt#${tag}]\nPUT 1.=1:\n+ONE\n` });
    assert.match(text(result), /Recovered from a stale file hash/);
    assert.equal(await stable.file("drift.txt"), "ONE\ntwo\nthree\nfour\n");
  } finally {
    await stable.dispose();
  }
});

test("one invalid section stages nothing across files", { timeout: 30_000 }, async () => {
  const ws = await workspace({ "a.txt": "a1\n", "b.txt": "b1\n" });
  try {
    const tag = tagOf(text(await ws.call("read", { path: "a.txt" })));
    await ws.call("read", { path: "b.txt" });
    await assert.rejects(
      ws.call("edit", {
        input: `[a.txt#${tag}]\nPUT 1.=1:\n+A2\n[b.txt#DEAD]\nPUT 1.=1:\n+B2\n`,
      }),
      /#DEAD is not from this session/,
    );
    assert.equal(await ws.file("a.txt"), "a1\n");
    assert.equal(await ws.file("b.txt"), "b1\n");
  } finally {
    await ws.dispose();
  }
});

test("named registers live in the collection that cut them", { timeout: 30_000 }, async () => {
  const owner = await workspace({ "a.txt": "a1\n", "b.txt": "b1\n" });
  const other = await workspace({ "b.txt": "b1\n" });
  try {
    const cutTag = tagOf(text(await owner.call("read", { path: "a.txt" })));
    await owner.call("edit", { input: `[a.txt#${cutTag}]\nCUT 1.=1 @reg\n` });
    assert.equal(await owner.file("a.txt"), "");

    const pasteTag = tagOf(text(await owner.call("read", { path: "b.txt" })));
    await owner.call("edit", { input: `[b.txt#${pasteTag}]\nPUT <1 @reg\n` });
    assert.equal(await owner.file("b.txt"), "a1\nb1\n");

    // A separate collection owns a separate store: the register is not visible.
    const foreignTag = tagOf(text(await other.call("read", { path: "b.txt" })));
    await other
      .call("edit", { input: `[b.txt#${foreignTag}]\nPUT <1 @reg\n` })
      .catch(() => undefined);
    assert.equal(await other.file("b.txt"), "b1\n");
  } finally {
    await owner.dispose();
    await other.dispose();
  }
});

test("MV moves and REM deletes real files", { timeout: 30_000 }, async () => {
  const ws = await workspace({ "a.txt": "a1\n", "b.txt": "b1\n" });
  try {
    const moveTag = tagOf(text(await ws.call("read", { path: "a.txt" })));
    await ws.call("edit", { input: `[a.txt#${moveTag}]\nMV nested/moved.txt\n` });
    assert.equal(await ws.file("nested/moved.txt"), "a1\n");
    await assert.rejects(access(join(ws.root, "a.txt")), (error) => error.code === "ENOENT");

    const removeTag = tagOf(text(await ws.call("read", { path: "b.txt" })));
    await ws.call("edit", { input: `[b.txt#${removeTag}]\nREM\n` });
    await assert.rejects(access(join(ws.root, "b.txt")), (error) => error.code === "ENOENT");
  } finally {
    await ws.dispose();
  }
});

test("native search honours PCRE2, .gitignore, and literal patterns", { timeout: 30_000 }, async () => {
  const ws = await workspace({
    ".gitignore": "ignored.txt\n",
    "ignored.txt": "needle\n",
    "kept.txt": "needle\n",
    "meta.txt": "a.c\nabc\n",
    "look.txt": "foobar\nfoobaz\n",
  });
  try {
    await mkdir(join(ws.root, ".git"), { recursive: true });
    await writeFile(join(ws.root, ".git/HEAD"), "ref: refs/heads/main\n");

    const lookahead = text(await ws.call("grep", { pattern: "foo(?=bar)", path: "look.txt" }));
    assert.match(lookahead, /^\*1:foobar$/m);
    assert.doesNotMatch(lookahead, /foobaz/);

    const ignored = text(await ws.call("grep", { pattern: "needle", path: "." }));
    assert.match(ignored, /kept\.txt/);
    assert.doesNotMatch(ignored, /ignored\.txt/);
    assert.doesNotMatch(text(await ws.call("find", { pattern: "*.txt" })), /ignored\.txt/);

    const literal = text(await ws.call("grep", { pattern: "a.c", literal: true, path: "meta.txt" }));
    assert.match(literal, /^\*1:a\.c$/m);
    assert.doesNotMatch(literal, /^\*2:abc$/m);
    assert.match(text(await ws.call("grep", { pattern: "a.c", path: "meta.txt" })), /^\*2:abc$/m);
  } finally {
    await ws.dispose();
  }
});

test("pre-aborted calls reject without mutating or clobbering the signal", { timeout: 30_000 }, async () => {
  const ws = await workspace({ "a.txt": "a1\n" });
  try {
    const tag = tagOf(text(await ws.call("read", { path: "a.txt" })));
    const aborted = AbortSignal.abort();
    for (const [name, input] of [
      ["read", { path: "a.txt" }],
      ["grep", { pattern: "a1", path: "." }],
      ["find", { pattern: "*.txt" }],
      ["ast_grep", { patterns: ["$X"], path: "." }],
      ["ast_edit", { rewrites: { a1: "a2" }, path: ".", dryRun: false }],
      ["edit", { input: `[a.txt#${tag}]\nPUT 1.=1:\n+A2\n` }],
      ["diff", { oldText: "a\n", newText: "b\n" }],
    ]) {
      await assert.rejects(ws.call(name, input, aborted), /Operation aborted/, name);
    }
    assert.equal(await ws.file("a.txt"), "a1\n");

    // napi's AbortSignal conversion writes `onabort`; the caller's stays intact.
    const controller = new AbortController();
    let fired = 0;
    const handler = () => {
      fired += 1;
    };
    controller.signal.onabort = handler;
    await ws.call("grep", { pattern: "a1", path: "." }, controller.signal);
    assert.equal(controller.signal.onabort, handler);
    controller.abort();
    assert.equal(fired, 1);
  } finally {
    await ws.dispose();
  }
});

test("missing paths propagate real failures", { timeout: 30_000 }, async () => {
  const ws = await workspace({});
  try {
    for (const [name, input] of [
      ["read", { path: "nope" }],
      ["grep", { pattern: "x", path: "nope" }],
      ["find", { pattern: "*", path: "nope" }],
      ["ast_grep", { patterns: ["$X"], path: "nope" }],
    ]) {
      await assert.rejects(ws.call(name, input), /nope|no such file|not found/i, name);
    }
  } finally {
    await ws.dispose();
  }
});

async function readOnlyFileToolsFinishWhileBashHeld(t, sandbox) {
  const ws = await workspace({ "src/target.ts": "const value = seed;\n" }, { sandbox });
  const gate = join(ws.root, "..", "read-gate");
  const ready = deferred(t.signal, "held bash readiness");
  const output = collector((value) => {
    if (value.includes("READ_READY\n")) ready.resolve();
  });
  let run;
  let completion;
  let settled = false;
  let deadline;
  let checks;
  try {
    run = ws.mux.start({
      command: "printf 'const value = staged;\\n' > src/target.ts; "
        + heldChild({ gate, ready: "READ_READY", done: "READ_DONE" })
        + "; printf 'const value = final;\\n' > src/target.ts",
      cwd: ws.root,
      principal: "read-overlap-writer",
      env: nativeEnv(ws.root),
    }, output.onData);
    completion = run.wait();
    completion.then(() => { settled = true; }, () => { settled = true; });
    await Promise.race([
      ready.promise,
      completion.then(() => { throw new Error("bash exited before readiness"); }),
    ]);

    const expected = sandbox === "shared" ? "staged" : "seed";
    const expectedBytes = `const value = ${expected};\n`;
    checks = (async () => {
      await assert.rejects(access(gate), (error) => error.code === "ENOENT");
      const read = text(await ws.call("read", { path: "src/target.ts" }));
      assert.ok(read.split("\n").includes(`1:const value = ${expected};`), read);
      tagOf(read);

      const found = text(await ws.call("find", { pattern: "*.ts", path: "src" }));
      assert.match(found, /target\.ts/);

      const searched = text(await ws.call("grep", { pattern: expected, path: "src" }));
      assert.ok(searched.split("\n").includes(`*1:const value = ${expected};`), searched);
      tagOf(searched);
      assert.doesNotMatch(searched, /\.marsh/);

      const matches = (await ws.call("ast_grep", {
        patterns: [expected], path: "src", lang: "typescript",
      })).details.result.matches;
      assert.equal(matches.length, 1);
      assert.equal(matches[0].text, expected);
      assert.match(matches[0].path, /target\.ts$/);
      assert.doesNotMatch(matches[0].path, /\.marsh/);

      for (const input of [
        { rewrites: { [expected]: "preview" }, path: "src/target.ts" },
        { rewrites: { [expected]: "preview" }, path: "src/target.ts", dryRun: true },
      ]) {
        const preview = await ws.call("ast_edit", input);
        assert.equal(preview.details.result.totalReplacements, 1);
        assert.equal(preview.details.result.applied, false);
        assert.equal(await ws.file("src/target.ts"), expectedBytes);
      }

      assert.equal(
        (await ws.mux.readFile(join(ws.root, "src"), "target.ts")).toString("utf8"),
        expectedBytes,
      );
      assert.equal(await ws.mux.exists(ws.root, "src/missing.ts"), false);
      await assert.rejects(
        ws.call("read", { path: "src/missing.ts" }),
        /missing\.ts|no such file|not found/i,
      );
      assert.equal(output.output.includes("READ_DONE\n"), false);
      assert.equal(settled, false, "bash is still held while every read completes");
    })();
    try {
      await Promise.race([
        checks,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("read-only file tools waited for held bash")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }

    await release(gate);
    assert.deepEqual(await completion, { exitCode: 0, cancelled: false, timedOut: false });
    assert.equal(await ws.file("src/target.ts"), "const value = final;\n");
  } finally {
    clearTimeout(deadline);
    await cleanup(
      () => { run?.abort(); },
      () => release(gate),
      async () => { await completion?.catch(() => {}); },
      async () => { await checks?.catch(() => {}); },
      () => ws.dispose(),
    );
  }
}

test("read-only file tools finish while bash is held (shared)", { timeout: 60_000 },
  (t) => readOnlyFileToolsFinishWhileBashHeld(t, "shared"));

test("read-only file tools finish while bash is held (always)", { timeout: 60_000 },
  (t) => readOnlyFileToolsFinishWhileBashHeld(t, "always"));

/** The SDK harness shared with `agent.test.mjs`, with the collection supplying every tool. */
async function collectionSession(instance, principal) {
  const { agentDir, settingsManager, resourceLoader } = await sdkResources(
    instance,
    "Test the junco tool collection.",
  );
  const { faux, model, streamFn } = scriptedModel();
  const collection = await ToolCollection.create(instance.seed, {
    mux: instance.mux,
    native: instance.native,
    bash: { operations: createShellMuxOperations({ mux: instance.mux, principal }) },
  });
  const errors = [];
  const { session } = await createAgentSession({
    cwd: instance.seed,
    agentDir,
    authStorage: AuthStorage.inMemory(),
    settingsManager,
    sessionManager: SessionManager.inMemory(instance.seed),
    resourceLoader,
    model,
    customTools: collection.tools,
  });
  try {
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    session.agent.streamFn = streamFn;
  } catch (setupError) {
    // The caller never received this session, so nothing else can dispose it. The borrowed
    // mux stays the caller's, and is deliberately not closed here.
    try {
      await cleanup(() => settleAgent(session.agent), () => session.dispose());
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], "Test session setup failed");
    }
    throw setupError;
  }
  return { session, faux, errors };
}

test("the SDK drives a read into a hashline edit", { timeout: 60_000 }, async () => {
  const instance = await fixture();
  let session;
  try {
    let errors;
    let faux;
    ({ session, faux, errors } = await collectionSession(instance, "sdk-collection"));
    assert.deepEqual(errors, []);

    const active = session.getActiveToolNames();
    for (const name of ["read", "bash", "edit", "grep", "find", "ast_grep", "ast_edit", "diff"]) {
      assert.ok(active.includes(name), `${name} is not active`);
    }
    // Pi's own write tool is untouched by the collection.
    assert.ok(active.includes("write"), "built-in write is no longer available");

    const capture = {};
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("read", { path: "src/file0.txt" }, { id: "read-1" })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        const read = toolResult(context.messages, "read-1");
        capture.read = read;
        const tag = tagOf(text(read));
        return fauxAssistantMessage(
          [fauxToolCall(
            "edit",
            { input: `[src/file0.txt#${tag}]\nPUT 1.=1:\n+PATCHED\n` },
            { id: "edit-1" },
          )],
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        capture.edit = toolResult(context.messages, "edit-1");
        return fauxAssistantMessage("done");
      },
    ]);
    await session.agent.prompt("Read then patch the file");
    await session.agent.waitForIdle();

    assert.equal(capture.read?.isError, false);
    assert.match(text(capture.read), /^1:zero$/m);
    assert.equal(capture.edit?.isError, false);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "PATCHED\n");
    assert.deepEqual(errors, []);
  } finally {
    await cleanup(
      () => (session ? settleAgent(session.agent) : undefined),
      () => session?.dispose(),
      () => closeFixture(instance),
    );
  }
});

test("the collection's bash still enforces marsh publication policy", { timeout: 60_000 }, async () => {
  const instance = await fixture();
  let session;
  try {
    let errors;
    let faux;
    ({ session, faux, errors } = await collectionSession(instance, "sdk-policy"));
    assert.deepEqual(errors, []);

    const ok = scriptBashTurn(faux, [{
      id: "policy-ok",
      command: "printf 'agent-ok\\n' > src/agent.txt; cat src/agent.txt",
    }]);
    await session.agent.prompt("Run the scripted command");
    await session.agent.waitForIdle();
    assert.equal(text(toolResult(ok.context.messages, "policy-ok")), "agent-ok\n");
    assert.equal(await readFile(join(instance.seed, "src/agent.txt"), "utf8"), "agent-ok\n");

    // Another principal claims the file, so the session's publication conflicts.
    const claim = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "other-owner" }),
    });
    await claim.execute("claim-file", { command: "printf 'owned\\n' > src/file1.txt" }, undefined);

    const denied = scriptBashTurn(faux, [{
      id: "policy-denied",
      command: "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file1.txt; true",
    }]);
    await session.agent.prompt("Run the conflicting command");
    await session.agent.waitForIdle();
    const deniedResult = toolResult(denied.context.messages, "policy-denied");
    assert.equal(deniedResult?.isError, true);
    assert.match(text(deniedResult), /Marsh policy denied publication/);
    assert.equal(await readFile(join(instance.seed, "src/file1.txt"), "utf8"), "owned\n");
    await assert.rejects(access(join(instance.seed, "src/new.txt")), (error) => error.code === "ENOENT");
    assert.deepEqual(errors, []);
  } finally {
    await cleanup(
      () => (session ? settleAgent(session.agent) : undefined),
      () => session?.dispose(),
      () => closeFixture(instance),
    );
  }
});

test("writing file tools are gated by marsh publication", { timeout: 60_000 }, async () => {
  const ws = await workspace({ "src/claimed.ts": "const value = seed;\n" }, { sandbox: "always" });
  try {
    // Another principal claims the file through marsh, so any other principal's later
    // publication of it is refused.
    const claim = createBashTool(ws.root, {
      operations: createShellMuxOperations({ mux: ws.mux, principal: "other-owner" }),
    });
    await claim.execute("claim-file", { command: "printf 'const value = owned;\\n' > src/claimed.ts" }, undefined);
    const owned = "const value = owned;\n";
    assert.equal(await ws.file("src/claimed.ts"), owned);

    // Read-only calls run directly against the seed and are never refused.
    const read = text(await ws.call("read", { path: "src/claimed.ts" }));
    assert.match(read, /^1:const value = owned;$/m);
    const grep = text(await ws.call("grep", { pattern: "owned", path: "src" }));
    assert.match(grep, /^\*1:const value = owned;$/m, grep);

    await assert.rejects(
      ws.call("edit", { input: `[src/claimed.ts#${tagOf(read)}]\nPUT 1.=1:\n+const value = edited;\n` }),
      /Marsh policy denied publication/,
    );
    assert.equal(await ws.file("src/claimed.ts"), owned);

    const rewrite = { rewrites: { owned: "rewritten" }, path: "src/claimed.ts" };
    await assert.rejects(
      ws.call("ast_edit", { ...rewrite, dryRun: false }),
      /Marsh policy denied publication/,
    );
    assert.equal(await ws.file("src/claimed.ts"), owned);

    // A preview writes nothing, so it is not an edit and is never refused.
    for (const input of [rewrite, { ...rewrite, dryRun: true }]) {
      const preview = await ws.call("ast_edit", input);
      assert.equal(preview.details.result.totalReplacements, 1);
      assert.equal(preview.details.result.applied, false);
      assert.equal(await ws.file("src/claimed.ts"), owned);
    }
  } finally {
    await ws.dispose();
  }
});

test("a managed edit keeps hashline anchors and logical paths", { timeout: 60_000 }, async () => {
  const ws = await workspace({ "src/plain.txt": "alpha\nbravo\n" }, { sandbox: "always" });
  try {
    const read = text(await ws.call("read", { path: "src/plain.txt" }));
    const result = await ws.call("edit", {
      input: `[src/plain.txt#${tagOf(read)}]\nPUT 2.=2:\n+BRAVO\n`,
    });
    assert.equal(await ws.file("src/plain.txt"), "alpha\nBRAVO\n");
    assert.equal(result.details.files[0].path, join(ws.root, "src/plain.txt"));
    assert.doesNotMatch(text(result), /\.marsh/);

    const reread = text(await ws.call("read", { path: "src/plain.txt" }));
    assert.match(reread, /^2:BRAVO$/m);
    tagOf(reread);
  } finally {
    await ws.dispose();
  }
});

test("a collection needs a marsh seed", { timeout: 30_000 }, async () => {
  // The system temporary directory, not the checkout: a development checkout may itself sit in
  // a btrfs subvolume, which is a seed.
  const plain = await mkdtemp(join(tmpdir(), "junco-tools-plain-"));
  try {
    await assert.rejects(ToolCollection.create(plain));
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});
