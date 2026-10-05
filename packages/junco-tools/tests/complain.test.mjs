import assert from "node:assert/strict";
import test from "node:test";
import {
  createComplainTool,
  invokeComplainTool,
  isComplainTool,
  issueLog,
} from "../dist/complain.js";

// Native-free: only dist/complain.js. issueLog is process-global and append-only, so every
// assertion inspects the delta after a recorded starting length.

/** A host delegating to the singleton exactly like JuncoAgent/MockAgent, counting its calls. */
function loggingHost() {
  const calls = [];
  return {
    calls,
    complain(issue, tracer) {
      calls.push({ issue, tracer });
      issueLog.append(issue, tracer);
    },
  };
}

function prompt(text = "hello") {
  return {
    systemPrompt: "system",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ],
    tools: [
      { name: "complain", description: "d", parameters: { type: "object" } },
    ],
  };
}

function context(nodeId = "worker", extra = {}) {
  return {
    nodeId,
    messages: [{ id: "a->b", payload: { kind: "prompt" } }],
    prompt: prompt(),
    ...extra,
  };
}

const since = (before) => issueLog.snapshot().slice(before);
const call = (tool, input, signal) =>
  (async () => tool.execute("call-1", input, signal))();

test("invalid complaint inputs reject and append nothing", async () => {
  const host = loggingHost();
  const tool = createComplainTool(host, () => context());
  const before = issueLog.length;
  for (const input of [
    {},
    { complaint: "" },
    { complaint: "  \n\t" },
    { complaint: 42 },
    { complaint: "ok", extra: true },
  ]) {
    await assert.rejects(call(tool, input), /^Error: Invalid complain input/);
  }
  assert.equal(host.calls.length, 0);
  assert.equal(issueLog.length, before);
});

test("a pre-aborted signal rejects before recording", async () => {
  const host = loggingHost();
  const tool = createComplainTool(host, () => context());
  const before = issueLog.length;
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    call(tool, { complaint: "x" }, controller.signal),
    /stop/,
  );
  await assert.rejects(
    (async () =>
      invokeComplainTool(
        tool,
        host,
        context(),
        "id",
        { complaint: "x" },
        controller.signal,
      ))(),
    /stop/,
  );
  assert.equal(host.calls.length, 0);
  assert.equal(issueLog.length, before);
});

test("unhosted execution rejects and appends nothing", async () => {
  const before = issueLog.length;
  for (const tool of [
    createComplainTool(),
    createComplainTool(loggingHost()),
    createComplainTool(undefined, () => context()),
  ]) {
    await assert.rejects(
      call(tool, { complaint: "x" }),
      /complain requires an agent context/,
    );
  }
  assert.equal(issueLog.length, before);
});

test("tool is genuine, frozen and copies are not genuine", () => {
  const tool = createComplainTool();
  assert.equal(tool.name, "complain");
  assert.equal(tool.executionMode, "sequential");
  assert.ok(isComplainTool(tool));
  assert.ok(Object.isFrozen(tool));
  assert.ok(Object.isFrozen(tool.parameters));
  assert.throws(() => {
    tool.name = "other";
  }, TypeError);
  assert.equal(isComplainTool({ ...tool }), false);
});

test("successful calls preserve order, repeats and node identity", async () => {
  const host = loggingHost();
  const before = issueLog.length;
  const a = createComplainTool(host, () => context("node-a"));
  const b = createComplainTool(host, () => context(""));
  await call(a, { complaint: " first " });
  await call(b, { complaint: "second" });
  await call(a, { complaint: " first " });
  assert.deepEqual(
    since(before).map(({ nodeId, complaint }) => [nodeId, complaint]),
    [
      ["node-a", " first "],
      ["", "second"],
      ["node-a", " first "],
    ],
  );
  assert.equal(host.calls.length, 3);
});

test("snapshots are frozen and cannot alter later history", async () => {
  const host = loggingHost();
  const tool = createComplainTool(host, () => context("snap"));
  const before = issueLog.length;
  await call(tool, { complaint: "one" });
  const snapshot = issueLog.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(issueLog));
  assert.throws(() => snapshot.pop(), TypeError);
  assert.throws(() => {
    snapshot[snapshot.length - 1] = {};
  }, TypeError);
  assert.throws(() => {
    snapshot.at(-1).complaint = "changed";
  }, TypeError);
  await call(tool, { complaint: "two" });
  assert.equal(snapshot.length, before + 1);
  assert.deepEqual(
    since(before).map((issue) => issue.complaint),
    ["one", "two"],
  );
});

test("mutating caller-owned prompt and messages after recording leaves the issue unchanged", async () => {
  const host = loggingHost();
  const ctx = context("mut");
  const payload = { kind: "prompt" };
  ctx.messages = [{ id: "e", payload }];
  const tool = createComplainTool(host, () => ctx);
  const before = issueLog.length;
  await call(tool, { complaint: "c" });
  ctx.prompt.systemPrompt = "changed";
  ctx.prompt.messages[0].content[0].text = "changed";
  ctx.prompt.messages[0].content[1].data = "BBBB";
  ctx.prompt.messages.push({ role: "user", content: "extra", timestamp: 2 });
  ctx.prompt.tools[0].name = "renamed";
  ctx.prompt.tools.push({ name: "x", description: "", parameters: {} });
  ctx.messages[0].id = "other";
  ctx.messages.push({ id: "f", payload: {} });
  const [issue] = since(before);
  assert.deepEqual(issue.prompt, prompt());
  assert.equal(issue.messages.length, 1);
  assert.equal(issue.messages[0].id, "e");
  assert.equal(issue.messages[0].payload, payload);
  assert.ok(Object.isFrozen(issue.prompt.messages[0].content[0]));
  assert.ok(Object.isFrozen(issue.messages));
});

test("observer receives node and complaint; a throwing observer cannot prevent recording", async (t) => {
  const seen = [];
  const host = loggingHost();
  const good = {
    complain: (nodeId, complaint) => seen.push([nodeId, complaint]),
  };
  const before = issueLog.length;
  await call(
    createComplainTool(host, () => context("obs", { tracer: good })),
    { complaint: "ok" },
  );
  assert.deepEqual(seen, [["obs", "ok"]]);
  // Silences the shared logger's warning; only the domain outcome is asserted.
  t.mock.method(console, "log", () => {});
  const bad = {
    complain() {
      throw new Error("observer down");
    },
  };
  await call(
    createComplainTool(host, () => context("obs", { tracer: bad })),
    { complaint: "kept" },
  );
  assert.deepEqual(
    since(before).map((i) => i.complaint),
    ["ok", "kept"],
  );
  assert.equal("tracer" in since(before)[1], false);
});

test("invokeComplainTool rejects non-genuine tools", async () => {
  const host = loggingHost();
  const before = issueLog.length;
  const fake = { ...createComplainTool(host, () => context()) };
  await assert.rejects(
    (async () =>
      invokeComplainTool(
        fake,
        host,
        context(),
        "id",
        { complaint: "x" },
        new AbortController().signal,
      ))(),
    (error) =>
      error instanceof TypeError && /Not a complain tool/.test(error.message),
  );
  assert.equal(issueLog.length, before);
});

test("invokeComplainTool ignores factory bindings", async () => {
  const bound = loggingHost();
  const current = loggingHost();
  const tool = createComplainTool(bound, () => context("bound"));
  const before = issueLog.length;
  await invokeComplainTool(
    tool,
    current,
    context("current"),
    "id",
    { complaint: "x" },
    new AbortController().signal,
  );
  assert.equal(bound.calls.length, 0);
  assert.equal(current.calls.length, 1);
  assert.deepEqual(
    since(before).map((i) => i.nodeId),
    ["current"],
  );
});

test("context and host failures propagate without acknowledgement", async () => {
  const before = issueLog.length;
  const tool = createComplainTool(loggingHost(), () => {
    throw new Error("no context");
  });
  await assert.rejects(call(tool, { complaint: "x" }), /no context/);
  const failing = {
    complain() {
      throw new Error("host failed");
    },
  };
  await assert.rejects(
    call(
      createComplainTool(failing, () => context()),
      { complaint: "x" },
    ),
    /host failed/,
  );
  await assert.rejects(
    invokeComplainTool(
      createComplainTool(),
      failing,
      context(),
      "id",
      { complaint: "x" },
      new AbortController().signal,
    ),
    /host failed/,
  );
  // An unclonable prompt fails the snapshot before insertion.
  const unclonable = context("bad", { prompt: { messages: [], fn: () => {} } });
  await assert.rejects(
    call(
      createComplainTool(loggingHost(), () => unclonable),
      { complaint: "x" },
    ),
  );
  assert.equal(issueLog.length, before);
});
