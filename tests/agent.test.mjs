import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AuthStorage, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createGrepTool,
  createReadTool,
  createShellMuxOperations,
} from "../dist/index.js";
import {
  cleanup,
  closeFixture,
  fixture,
  hashlineTag,
  heldChild,
  nativeEnv,
  release,
  sdkResources,
  settleAgent,
  text,
} from "./helpers.mjs";
import { assistantText, scriptBashTurn, scriptedModel, toolResult } from "./scripted-model.mjs";

function bashAgent(instance, { principal, toolExecution = "sequential" }) {
  const { faux, model, streamFn } = scriptedModel();
  const tool = createBashTool(instance.seed, {
    operations: createShellMuxOperations({ mux: instance.mux, principal }),
  });
  const agent = new Agent({
    initialState: { model, systemPrompt: "Test the marsh-backed bash tool.", tools: [tool] },
    streamFn,
    toolExecution,
  });
  const events = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  return { agent, faux, events };
}

test("the agent loop returns a published bash result to the model", { timeout: 30_000 }, async () => {
  const instance = await fixture();
  let agent;
  try {
    let faux;
    let events;
    ({ agent, faux, events } = bashAgent(instance, { principal: "agent-success" }));
    const capture = scriptBashTurn(faux, [{
      id: "bash-1",
      command: "printf 'agent-ok\\n' > src/agent.txt; cat src/agent.txt",
    }]);

    await agent.prompt("Run the scripted command");
    await agent.waitForIdle();

    assert.equal(await readFile(join(instance.seed, "src/agent.txt"), "utf8"), "agent-ok\n");
    const result = toolResult(capture.context.messages, "bash-1");
    assert.ok(result, "the next model request never saw the tool result");
    assert.equal(result.toolName, "bash");
    assert.equal(result.isError, false);
    assert.equal(text(result), "agent-ok\n");

    const lifecycle = events.filter((event) => event.toolCallId === "bash-1");
    assert.equal(lifecycle.at(0)?.type, "tool_execution_start");
    assert.equal(lifecycle.at(-1)?.type, "tool_execution_end");
    assert.equal(lifecycle.at(-1).isError, false);
    assert.ok(lifecycle.some((event) => event.type === "tool_execution_update" && text(event.partialResult).length > 0));
    const endIndex = events.lastIndexOf(lifecycle.at(-1));
    assert.ok(!events.slice(endIndex + 1).some((event) => event.toolCallId === "bash-1"));

    const last = agent.state.messages.at(-1);
    assert.equal(last.role, "assistant");
    assert.equal(assistantText(last), "verified");
    assert.equal(agent.state.pendingToolCalls.size, 0);
    assert.equal(agent.state.isStreaming, false);
  } finally {
    await cleanup(
      () => (agent ? settleAgent(agent) : undefined),
      () => closeFixture(instance),
    );
  }
});

test("a nonzero exit becomes a model-visible error result", { timeout: 30_000 }, async () => {
  const instance = await fixture();
  let agent;
  try {
    let faux;
    let events;
    ({ agent, faux, events } = bashAgent(instance, { principal: "agent-failure" }));
    const capture = scriptBashTurn(faux, [{ id: "bash-exit", command: "printf 'before-failure\\n'; exit 7" }]);

    await agent.prompt("Run the failing command");
    await agent.waitForIdle();

    const end = events.findLast((event) => event.type === "tool_execution_end" && event.toolCallId === "bash-exit");
    assert.ok(end);
    assert.equal(end.isError, true);
    const result = toolResult(capture.context.messages, "bash-exit");
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.match(text(result), /before-failure/);
    assert.match(text(result), /Command exited with code 7/);
  } finally {
    await cleanup(
      () => (agent ? settleAgent(agent) : undefined),
      () => closeFixture(instance),
    );
  }
});

test("a conflicting zero-exit publication becomes a model-visible policy error", { timeout: 30_000 }, async () => {
  const instance = await fixture();
  let agent;
  try {
    const owner = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "file-owner" }),
    });
    await owner.execute("claim-file", { command: "printf 'owned\\n' > src/file0.txt" }, undefined);

    let faux;
    let events;
    ({ agent, faux, events } = bashAgent(instance, { principal: "agent-intruder" }));
    const capture = scriptBashTurn(faux, [{
      id: "bash-denied",
      command: "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file0.txt; true",
    }]);

    await agent.prompt("Run the conflicting command");
    await agent.waitForIdle();

    const end = events.findLast((event) => event.type === "tool_execution_end" && event.toolCallId === "bash-denied");
    assert.equal(end?.isError, true);
    const result = toolResult(capture.context.messages, "bash-denied");
    assert.equal(result?.isError, true);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(instance.seed, "src/file1.txt"), "utf8"), "one\n");
    await assert.rejects(access(join(instance.seed, "src/new.txt")), (error) => error.code === "ENOENT");
  } finally {
    await cleanup(
      () => (agent ? settleAgent(agent) : undefined),
      () => closeFixture(instance),
    );
  }
});

test("aborting the agent cancels its bash call and publishes nothing", { timeout: 30_000 }, async () => {
  const instance = await fixture();
  const gate = join(instance.root, "agent-gate");
  let agent;
  try {
    let faux;
    let events;
    ({ agent, faux, events } = bashAgent(instance, { principal: "agent-abort" }));
    const held = heldChild({ gate, ready: "AGENT_READY", done: "AGENT_DONE" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", {
        command: `printf 'staged\\n' > src/agent-cancelled.txt; ${held}`,
      }, { id: "bash-abort" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("unreachable"),
    ]);
    let abortSent = false;
    const unsubscribe = agent.subscribe((event) => {
      if (abortSent || event.type !== "tool_execution_update" || event.toolCallId !== "bash-abort") return;
      if (!text(event.partialResult).includes("AGENT_READY")) return;
      abortSent = true;
      agent.abort();
    });

    await agent.prompt("Run the held command");
    await agent.waitForIdle();
    unsubscribe();

    assert.equal(abortSent, true, "the held command never reached the agent as streaming output");
    const result = toolResult(agent.state.messages, "bash-abort");
    assert.ok(result, "no tool result was recorded for the aborted call");
    assert.equal(result.isError, true);
    assert.match(text(result), /Command aborted/);
    await assert.rejects(access(join(instance.seed, "src/agent-cancelled.txt")), (error) => error.code === "ENOENT");
    const endIndex = events.findLastIndex((event) =>
      event.type === "tool_execution_end" && event.toolCallId === "bash-abort");
    assert.ok(endIndex >= 0);
    assert.ok(!events.slice(endIndex + 1).some((event) => event.toolCallId === "bash-abort"));
    assert.equal(agent.state.pendingToolCalls.size, 0);

    const capture = scriptBashTurn(faux, [{
      id: "bash-recovered",
      command: "printf 'recovered\\n' > src/recovered.txt; cat src/recovered.txt",
    }]);
    await agent.prompt("Run the recovery command");
    await agent.waitForIdle();
    assert.equal(await readFile(join(instance.seed, "src/recovered.txt"), "utf8"), "recovered\n");
    const recovered = toolResult(capture.context.messages, "bash-recovered");
    assert.equal(recovered?.isError, false);
    assert.equal(text(recovered), "recovered\n");
  } finally {
    await cleanup(
      () => (agent ? settleAgent(agent) : undefined),
      () => release(gate),
      () => closeFixture(instance),
    );
  }
});

for (const toolExecution of ["parallel", "sequential"]) {
  test(`a ${toolExecution} bash batch finalizes one result per call`, { timeout: 30_000 }, async () => {
    const instance = await fixture();
    let agent;
    try {
      let faux;
      let events;
      ({ agent, faux, events } = bashAgent(instance, { principal: `agent-${toolExecution}`, toolExecution }));
      const capture = scriptBashTurn(faux, [
        { id: "batch-a", command: "printf 'marker-a\\n' > src/batch-a.txt; printf 'marker-a\\n'" },
        { id: "batch-b", command: "printf 'marker-b\\n' > src/batch-b.txt; printf 'marker-b\\n'" },
      ]);

      await agent.prompt("Run both scripted commands");
      await agent.waitForIdle();

      for (const [id, marker] of [["batch-a", "marker-a"], ["batch-b", "marker-b"]]) {
        const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === id);
        assert.equal(ends.length, 1, `${id} did not finalize exactly once`);
        assert.equal(ends[0].isError, false);
        assert.equal(text(ends[0].result), `${marker}\n`);
        assert.equal(await readFile(join(instance.seed, `src/${id}.txt`), "utf8"), `${marker}\n`);
        const result = toolResult(capture.context.messages, id);
        assert.equal(result?.isError, false);
        assert.equal(text(result), `${marker}\n`);
      }

      const order = capture.context.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId);
      assert.deepEqual(order, ["batch-a", "batch-b"]);
      const persisted = agent.state.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId);
      assert.deepEqual(persisted, ["batch-a", "batch-b"]);

      if (toolExecution === "sequential") {
        const endA = events.findIndex((event) => event.type === "tool_execution_end" && event.toolCallId === "batch-a");
        const startB = events.findIndex((event) => event.type === "tool_execution_start" && event.toolCallId === "batch-b");
        assert.ok(endA >= 0 && startB > endA, "sequential mode overlapped its tool calls");
      }
    } finally {
      await cleanup(
        () => (agent ? settleAgent(agent) : undefined),
        () => closeFixture(instance),
      );
    }
  });
}

test("standalone AgentTools preserve shared hashline provenance", { timeout: 60_000 }, async () => {
  const instance = await fixture();
  let agent;
  try {
    await writeFile(join(instance.seed, "src/file0.txt"), "alpha\nbravo\n");
    const { native, mux } = instance;
    // Constructed independently, not through ToolCollection: only the explicitly
    // shared store connects what read/grep displayed to what edit accepts.
    const store = new native.EditStore();
    const { faux, model, streamFn } = scriptedModel();
    agent = new Agent({
      initialState: {
        model,
        systemPrompt: "Test the standalone file tools.",
        tools: [
          createReadTool(instance.seed, store, native, mux),
          createGrepTool(instance.seed, store, native, mux),
          createEditTool(instance.seed, store, native, mux),
        ],
      },
      streamFn,
    });

    // Each factory only records the previous result and derives the next call from
    // its advertised tag; faux would turn a thrown assertion into a model error.
    const seen = {};
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: "src/file0.txt", limit: 1 }, { id: "read-partial" }),
      ], { stopReason: "toolUse" }),
      (context) => {
        seen.read = toolResult(context.messages, "read-partial");
        const tag = hashlineTag(text(seen.read ?? { content: [] }));
        return fauxAssistantMessage([fauxToolCall("edit", {
          input: `[src/file0.txt#${tag}]\nPUT 2.=2:\n+FORBIDDEN\n`,
        }, { id: "edit-unseen" })], { stopReason: "toolUse" });
      },
      (context) => {
        seen.denied = toolResult(context.messages, "edit-unseen");
        return fauxAssistantMessage([
          fauxToolCall("grep", { pattern: "bravo", path: "src/file0.txt" }, { id: "grep-hit" }),
        ], { stopReason: "toolUse" });
      },
      (context) => {
        seen.grep = toolResult(context.messages, "grep-hit");
        const tag = hashlineTag(text(seen.grep ?? { content: [] }));
        return fauxAssistantMessage([fauxToolCall("edit", {
          input: `[src/file0.txt#${tag}]\nPUT 2.=2:\n+BRAVO\n`,
        }, { id: "edit-seen" })], { stopReason: "toolUse" });
      },
      (context) => {
        seen.applied = toolResult(context.messages, "edit-seen");
        return fauxAssistantMessage("verified");
      },
    ]);

    await agent.prompt("Patch the second line");
    await agent.waitForIdle();

    assert.equal(seen.read?.isError, false);
    const read = text(seen.read);
    assert.match(read, /^\[src\/file0\.txt#[0-9A-Fa-f]{4}\]$/m, read);
    assert.match(read, /^1:alpha$/m, read);
    assert.doesNotMatch(read, /^2:/m, read);

    assert.equal(seen.denied?.isError, true);
    assert.match(text(seen.denied), /never displayed/);

    assert.equal(seen.grep?.isError, false);
    const grep = text(seen.grep);
    assert.match(grep, /^\[src\/file0\.txt#[0-9A-Fa-f]{4}\]$/m, grep);
    assert.match(grep, /^\*2:bravo$/m, grep);

    assert.equal(seen.applied?.isError, false, seen.applied && text(seen.applied));
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "alpha\nBRAVO\n");
  } finally {
    await cleanup(
      () => (agent ? settleAgent(agent) : undefined),
      () => closeFixture(instance),
    );
  }
});

test("an SDK-registered bash override executes through marsh", { timeout: 60_000 }, async () => {
  const instance = await fixture();
  const errors = [];
  let session;
  try {
    const { agentDir, settingsManager, resourceLoader } = await sdkResources(
      instance,
      "Test the registered bash tool.",
    );
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const { faux, model, streamFn } = scriptedModel();
    const operations = createShellMuxOperations({ mux: instance.mux, principal: "sdk-agent" });
    ({ session } = await createAgentSession({
      cwd: instance.seed,
      agentDir,
      authStorage: AuthStorage.inMemory(),
      settingsManager,
      sessionManager: SessionManager.inMemory(instance.seed),
      resourceLoader,
      model,
      // `tools` is omitted so read/edit/write stay enabled beside the override.
      customTools: [createBashTool(instance.seed, { operations })],
    }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.deepEqual(errors, []);
    session.agent.streamFn = streamFn;

    const active = session.getActiveToolNames();
    assert.deepEqual(active.filter((name) => name === "bash"), ["bash"]);
    for (const name of ["read", "edit", "write"]) {
      assert.ok(active.includes(name), `${name} is no longer available`);
    }

    const capture = scriptBashTurn(faux, [{
      id: "sdk-1",
      command: "printf 'agent-ok\\n' > src/agent.txt; cat src/agent.txt",
    }]);
    await session.agent.prompt("Run the scripted command");
    await session.agent.waitForIdle();
    assert.equal(await readFile(join(instance.seed, "src/agent.txt"), "utf8"), "agent-ok\n");
    const registered = toolResult(capture.context.messages, "sdk-1");
    assert.equal(registered?.isError, false);
    assert.equal(text(registered), "agent-ok\n");

    // Registration alone cannot distinguish the override from Pi's local backend.
    const other = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "other-owner" }),
    });
    await other.execute("claim-file", { command: "printf 'owned\\n' > src/file0.txt" }, undefined);
    const denied = scriptBashTurn(faux, [{
      id: "sdk-denied",
      command: "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file0.txt; true",
    }]);
    await session.agent.prompt("Run the conflicting command");
    await session.agent.waitForIdle();
    const deniedResult = toolResult(denied.context.messages, "sdk-denied");
    assert.equal(deniedResult?.isError, true);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "owned\n");
    await assert.rejects(access(join(instance.seed, "src/new.txt")), (error) => error.code === "ENOENT");
  } finally {
    await cleanup(
      () => (session ? settleAgent(session.agent) : undefined),
      () => session?.dispose(),
      // Disposal is not native teardown: the borrowed mux is closed explicitly.
      () => closeFixture(instance),
    );
  }
  assert.deepEqual(errors, []);
});

test("fixture cleanup survives an output-file removal failure", { timeout: 30_000 }, async () => {
  const instance = await fixture();
  try {
    // An output-file entry that is a nonempty directory: closeFixture removes those
    // nonrecursively on purpose, so this is a real ERR_FS_EISDIR from Node's own rm.
    const stubborn = join(instance.root, "stubborn");
    await mkdir(stubborn, { recursive: true });
    await writeFile(join(stubborn, "entry.txt"), "kept\n");

    await assert.rejects(closeFixture(instance, [stubborn]), (error) => {
      assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${error}`);
      const codes = error.errors.map((failure) => failure.code);
      assert.ok(codes.includes("ERR_FS_EISDIR"), `no ERR_FS_EISDIR among ${codes.join(", ")}`);
      return true;
    });

    // The failed entry stopped neither the close that preceded it nor the root removal.
    await assert.rejects(access(instance.root), (error) => error.code === "ENOENT");
    assert.throws(() => instance.mux.start({
      command: "printf late",
      cwd: instance.seed,
      principal: "cleanup-owner",
      env: nativeEnv(instance.root),
    }, () => {}), /closed/);
  } finally {
    await closeFixture(instance);
  }
});
