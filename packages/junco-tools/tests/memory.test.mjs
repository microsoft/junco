import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NodeId } from "dataflow-engine";
import { invokeMemoryTool, isMemoryTool, JuncoMemory } from "../dist/memory.js";

// Native-free: import the memory module directly, with real SQLite and engine identities.
const filename = (id) =>
  `${createHash("sha256").update(id, "utf8").digest("hex")}.sqlite`;
const call = async (tools, node, name, params, signal) => {
  const result = await invokeMemoryTool(
    tools.find((tool) => tool.name === name),
    node === undefined ? undefined : NodeId.create(node),
    "memory-test",
    params,
    signal,
  );
  assert.deepEqual(result.content, [
    { type: "text", text: JSON.stringify(result.details) },
  ]);
  assert.deepEqual(result.structuredContent, result.details);
  return result.details;
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "junco-memory-"));
  const wrappers = [];
  t.after(async () => {
    try {
      for (const wrapper of wrappers) wrapper.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    open(path = directory) {
      const memory = new JuncoMemory({ directory: path });
      wrappers.push(memory);
      return memory;
    },
  };
}

test("memory persists exact text and source across reopen, then durably forgets", async (t) => {
  const f = await fixture(t);
  let memory = f.open();
  const text = "Project Junco uses SQLite for durable memory";
  const saved = await call(memory.tools(), "Worker", "save_memory", { text });
  assert.deepEqual(saved, { id: saved.id, text });
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  memory.close();
  const db = new DatabaseSync(join(f.directory, filename("Worker")), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT key, value, source FROM semantic WHERE key = ?")
      .get(saved.id);
    assert.deepEqual(
      { ...row },
      { key: saved.id, value: text, source: "Worker" },
    );
  } finally {
    db.close();
  }
  memory = f.open();
  assert.deepEqual(
    await call(memory.tools(), "Worker", "search_memory", { query: "durable" }),
    { memories: [saved] },
  );
  assert.deepEqual(
    await call(memory.tools(), "Worker", "forget_memory", { id: saved.id }),
    { id: saved.id, forgotten: true },
  );
  memory.close();
  memory = f.open();
  assert.deepEqual(
    await call(memory.tools(), "Worker", "search_memory", { query: "durable" }),
    { memories: [] },
  );
  assert.deepEqual(
    await call(memory.tools(), "Worker", "forget_memory", { id: saved.id }),
    { id: saved.id, forgotten: false },
  );
});

test("memory scopes are case-sensitive, reject foreign exact deletion and share committed files only", async (t) => {
  const f = await fixture(t);
  const memory = f.open();
  const tools = memory.tools();
  const upper = await call(tools, "Worker", "save_memory", {
    text: "sentinel upper",
  });
  const lower = await call(tools, "worker", "save_memory", {
    text: "sentinel lower",
  });
  assert.notEqual(upper.id, lower.id);
  for (const [node, own, foreign] of [
    ["Worker", upper, lower],
    ["worker", lower, upper],
  ]) {
    assert.deepEqual(
      await call(tools, node, "search_memory", { query: "sentinel" }),
      { memories: [own] },
    );
    assert.deepEqual(
      await call(tools, node, "forget_memory", { id: foreign.id }),
      { id: foreign.id, forgotten: false },
    );
  }
  const other = f.open();
  assert.deepEqual(
    await call(other.tools(), "Worker", "search_memory", { query: "sentinel" }),
    { memories: [upper] },
  );
  const next = await call(other.tools(), "Worker", "save_memory", {
    text: "committed visibility",
  });
  assert.deepEqual(
    await call(tools, "Worker", "search_memory", { query: "visibility" }),
    { memories: [next] },
  );
  assert.deepEqual(
    await call(
      f.open(join(f.directory, "separate")).tools(),
      "Worker",
      "search_memory",
      { query: "sentinel" },
    ),
    { memories: [] },
  );
  memory.close();
  other.close();
  const reopened = f.open().tools();
  for (const [node, own] of [
    ["Worker", upper],
    ["worker", lower],
  ]) {
    assert.deepEqual(
      await call(reopened, node, "search_memory", { query: "sentinel" }),
      { memories: [own] },
    );
  }
});

test("memory applies ranking limits within exact hashed namespaces, including unsafe path characters", async (t) => {
  const f = await fixture(t);
  const memory = f.open();
  const tools = memory.tools();
  for (let i = 0; i < 8; i++)
    await call(tools, "Other", "save_memory", {
      text: `matching sentinel ${i}`,
    });
  const caller = await call(tools, "Caller", "save_memory", {
    text: "matching sentinel caller",
  });
  assert.deepEqual(
    await call(tools, "Caller", "search_memory", { query: "sentinel", k: 1 }),
    { memories: [caller] },
  );
  assert.equal(
    (await call(tools, "Other", "search_memory", { query: "sentinel" }))
      .memories.length,
    5,
  );
  assert.equal(
    (await call(tools, "Other", "search_memory", { query: "sentinel", k: 20 }))
      .memories.length,
    8,
  );
  const ids = ["../escape", "a/b", "..", "Worker:!?", "工人/Δ", "工人/δ"];
  const saved = [];
  for (const node of ids)
    saved.push(
      await call(tools, node, "save_memory", { text: `scopemarker ${node}` }),
    );
  memory.close();
  const reopened = f.open().tools();
  for (const [i, node] of ids.entries()) {
    assert.deepEqual(
      await call(reopened, node, "search_memory", { query: "scopemarker" }),
      { memories: [saved[i]] },
    );
  }
  const files = await readdir(f.directory, { withFileTypes: true });
  assert.ok(
    files.every(
      (file) =>
        file.isFile() && /^[a-f0-9]{64}\.sqlite(?:-wal|-shm)?$/.test(file.name),
    ),
  );
  for (const node of ["Other", "Caller", ...ids])
    assert.ok(files.some((file) => file.name === filename(node)));
});

test("memory construction, unbound calls and copied tools cannot create a fallback namespace", async (t) => {
  const f = await fixture(t);
  for (const options of [
    undefined,
    {},
    { directory: "" },
    { directory: " \n\t" },
    { directory: 42 },
  ]) {
    assert.throws(
      () => new JuncoMemory(options),
      /directory must be a non-empty string/,
    );
  }
  const memory = f.open();
  const tools = memory.tools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["save_memory", "search_memory", "forget_memory"],
  );
  const fresh = memory.tools();
  const params = [{ text: "denied" }, { query: "denied" }, { id: "denied" }];
  for (const [i, tool] of tools.entries()) {
    assert.notEqual(tool, fresh[i]);
    assert.equal(isMemoryTool(tool), true);
    await assert.rejects(
      async () => tool.execute("unbound", params[i]),
      /requires a NodeId-bound agent context/,
    );
    await assert.rejects(
      () => call(tools, undefined, tool.name, params[i]),
      /requires a NodeId-bound agent context/,
    );
    const copy = { ...tool };
    assert.equal(isMemoryTool(copy), false);
    assert.throws(
      () => invokeMemoryTool(copy, NodeId.create("Worker"), "copy", params[i]),
      /Not a memory tool constructed by JuncoMemory/,
    );
  }
  assert.deepEqual(await readdir(f.directory), []);
});

test("memory rejects invalid input without opening storage or mutating valid records", async (t) => {
  const f = await fixture(t);
  const tools = f.open().tools();
  const invalid = [
    [
      "save_memory",
      [
        {},
        { text: "" },
        { text: " \t\n" },
        { text: 1 },
        { text: "bad", nodeId: "Other" },
        { text: "bad", scope: "Other" },
        { text: "bad", database: "other" },
      ],
    ],
    [
      "search_memory",
      [
        {},
        { query: "" },
        { query: " \t" },
        { query: 1 },
        { query: "x", k: 0 },
        { query: "x", k: 21 },
        { query: "x", k: 1.5 },
        { query: "x", k: "1" },
        { query: "x", nodeId: "Other" },
      ],
    ],
    [
      "forget_memory",
      [{}, { id: "" }, { id: " \n" }, { id: 1 }, { id: "x", nodeId: "Other" }],
    ],
  ];
  for (const [name, inputs] of invalid)
    for (const input of inputs) {
      await assert.rejects(
        () => call(tools, "Worker", name, input),
        /Invalid .* input/,
      );
    }
  assert.deepEqual(await readdir(f.directory), []);
  const original = '  punctuation sentinel "quoted" C++ (x:y) * - OR  ';
  const saved = await call(tools, "Worker", "save_memory", { text: original });
  const duplicate = await call(tools, "Worker", "save_memory", {
    text: original,
  });
  assert.notEqual(saved.id, duplicate.id);
  for (const query of ['"quoted"', "C++ (x:y) * - OR"]) {
    const result = await call(tools, "Worker", "search_memory", { query });
    assert.equal(result.memories.length, 2);
    assert.deepEqual(
      new Set(result.memories.map((item) => item.id)),
      new Set([saved.id, duplicate.id]),
    );
    assert.ok(result.memories.every((item) => item.text === original));
  }
  for (const [name, inputs] of invalid)
    for (const input of inputs) {
      await assert.rejects(() => call(tools, "Worker", name, input));
    }
  assert.equal(
    (await call(tools, "Worker", "search_memory", { query: "sentinel", k: 20 }))
      .memories.length,
    2,
  );
  assert.deepEqual(
    await call(tools, "Worker", "forget_memory", { id: saved.id.slice(0, -1) }),
    { id: saved.id.slice(0, -1), forgotten: false },
  );
});

test("memory preabort and close fence writes without removing durable files", async (t) => {
  const f = await fixture(t);
  const memory = f.open();
  const tools = memory.tools();
  const aborted = AbortSignal.abort(new Error("cancel memory"));
  await assert.rejects(
    () =>
      call(
        tools,
        "Worker",
        "save_memory",
        { text: "aborted sentinel" },
        aborted,
      ),
    /cancel memory/,
  );
  assert.deepEqual(await readdir(f.directory), []);
  const saved = await call(tools, "Worker", "save_memory", {
    text: "retained sentinel",
  });
  await assert.rejects(
    () =>
      call(
        tools,
        "Worker",
        "save_memory",
        { text: "aborted sentinel" },
        aborted,
      ),
    /cancel memory/,
  );
  await assert.rejects(
    () => call(tools, "Worker", "forget_memory", { id: saved.id }, aborted),
    /cancel memory/,
  );
  assert.deepEqual(
    await call(tools, "Worker", "search_memory", { query: "sentinel" }),
    { memories: [saved] },
  );
  memory.close();
  memory.close();
  for (const [name, input] of [
    ["save_memory", { text: "closed" }],
    ["search_memory", { query: "sentinel" }],
    ["forget_memory", { id: saved.id }],
  ]) {
    await assert.rejects(
      () => call(tools, "Worker", name, input),
      /JuncoMemory is closed/,
    );
  }
  assert.ok((await readdir(f.directory)).includes(filename("Worker")));
  assert.deepEqual(
    await call(f.open().tools(), "Worker", "search_memory", {
      query: "sentinel",
    }),
    { memories: [saved] },
  );
});

test("memory storage failures propagate on the first scoped operation and can be retried", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.directory, "not-a-directory");
  await writeFile(blocked, "block SQLite directory creation");
  const tools = f.open(blocked).tools();
  for (const [name, input] of [
    ["save_memory", { text: "sentinel" }],
    ["search_memory", { query: "sentinel" }],
    ["forget_memory", { id: "unknown" }],
  ]) {
    await assert.rejects(() => call(tools, "Worker", name, input));
  }
  await rm(blocked);
  const saved = await call(tools, "Worker", "save_memory", {
    text: "recovered sentinel",
  });
  assert.deepEqual(
    await call(tools, "Worker", "search_memory", { query: "sentinel" }),
    { memories: [saved] },
  );
});
