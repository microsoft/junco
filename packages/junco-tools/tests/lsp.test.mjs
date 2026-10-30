import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  rename as move,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMarshPolicyDenied, LspTool } from "../dist/index.js";
import {
  cleanup,
  nativeEnv,
  quote,
  seedFixture,
  testNative,
  text,
} from "./helpers.mjs";
import { harnessDescendants } from "./lsp-fixture.mjs";

const serverScript = fileURLToPath(
  new URL("./lsp-fixture.mjs", import.meta.url),
);
const A = "const add = 1;\nadd;\n";
const B = "add;\n";
const hover = { action: "hover", file: "a.fixture" };
const rename = {
  action: "rename",
  file: "a.fixture",
  line: 1,
  symbol: "add",
  new_name: "sum",
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const identity = (result) => {
  const output = result.text ?? text(result);
  const match = /pid=(\d+) counter=(\d+)/.exec(output);
  assert.ok(match, output);
  return { pid: Number(match[1]), counter: Number(match[2]) };
};
const server = (overrides = {}) => ({
  command: process.execPath,
  args: [serverScript, "stdio-server", "--control=control.json"],
  fileTypes: ["fixture"],
  rootMarkers: ["."],
  languageId: "fixture",
  warmupTimeoutMs: 15_000,
  ...overrides,
});
const semantic = (error) => {
  assert.ok(error instanceof Error);
  assert.equal(error.cause?.isError, true);
  assert.equal(error.cause?.details.success, false);
  return true;
};
const denied = (error) => {
  assert.ok(isMarshPolicyDenied(error));
  assert.ok(Object.hasOwn(error, "code"));
  assert.equal(error.code, "MARSH_POLICY_DENIED");
  assert.equal(
    error.cause,
    undefined,
    "denial must not carry a private semantic result",
  );
  return true;
};

// Environment is captured at construction, not left to the user's home/config/PATH.
// node:test runs these top-level cases sequentially, including their awaited teardown.
async function workspace(
  t,
  {
    control = {},
    files = {},
    options = {},
    env = {},
    cwd = "",
    expectedLspCloseFailure,
  } = {},
) {
  const fixture = await seedFixture({
    files: {
      "a.fixture": A,
      "b.fixture": B,
      "control.json": JSON.stringify(control),
      ".omp/lsp.json": JSON.stringify({ servers: { fixture: server() } }),
      ...files,
    },
  });
  const { root, seed } = fixture;
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  await Promise.all([mkdir(home), mkdir(tmp)]);
  const environment = { ...nativeEnv(home), TMPDIR: tmp, ...env };
  const keys = new Set([
    ...Object.keys(environment),
    "PI_CONFIG_DIR",
    "CLAUDE_CONFIG_DIR",
    "LSP_FIXTURE_OPTIONS",
    "LSP_FIXTURE_MODE",
  ]);
  const previous = Object.fromEntries(
    [...keys].map((key) => [key, process.env[key]]),
  );
  for (const key of keys) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  let native, mux;
  const handles = [];
  t.after(() =>
    cleanup(
      ...(expectedLspCloseFailure
        ? [() => expectedLspCloseFailure(handles, native)]
        : [
            () => LspTool.shutdown(),
            ...handles.map((handle) => () => handle.close()),
          ]),
      () => mux?.close(),
      () => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      },
      () => rm(root, { recursive: true, force: true }),
    ),
  );
  native = await testNative();
  const decisions = [];
  const resourceEvents = [];
  mux = await native.NativeMux.openCopyTree(
    seed,
    { sandbox: "always", policyDebug: true, ...options },
    (error, event) => {
      if (error) throw error;
      decisions.push(event);
    },
    options.resources?.monitorIntervalMs
      ? (error, event) => {
          if (error) throw error;
          resourceEvents.push(event);
        }
      : undefined,
  );
  const owner = mux.forkOwner();
  const at = join(seed, cwd);
  const ws = {
    ...fixture,
    native,
    mux,
    owner,
    decisions,
    resourceEvents,
    environment,
    cwd: at,
    file: (path) => readFile(join(seed, path), "utf8"),
    async write(path, content) {
      const target = join(seed, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    track(handle) {
      handles.push(handle);
      return handle;
    },
    async js(extra = {}) {
      return LspTool.create(at, { native, mux: owner, ...extra });
    },
    async direct(extra = {}, handle = owner) {
      const tool = await native.NativeLsp.open(at, extra, handle);
      handles.push(tool);
      return tool;
    },
    async run(command, handle = owner) {
      const result = await handle
        .start(
          { command, cwd: at, principal: "lsp-test", env: environment },
          () => {},
        )
        .wait();
      assert.equal(result.exitCode, 0);
      return result;
    },
    async events(method) {
      let body;
      try {
        body = await readFile(join(root, "events.jsonl"), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      return body
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .filter(
          (event) =>
            (!method || event.method === method) && event.phase === "dispatch",
        );
    },
    async dispatched(method, count = 1) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const events = await ws.events(method);
        if (events.length >= count) return events.at(-1);
        await sleep(5);
      }
      assert.fail(`real server did not dispatch ${method}`);
    },
  };
  // The log is outside the seed: observing a gate must not invalidate the work view.
  const config = JSON.parse(await ws.file(".omp/lsp.json"));
  if (config.servers?.fixture?.args) {
    config.servers.fixture.args.push(`--events=${join(root, "events.jsonl")}`);
    await ws.write(".omp/lsp.json", JSON.stringify(config));
  }
  return ws;
}
const call = (tool, input, signal, onUpdate) =>
  tool.execute("lsp-test", input, signal, onUpdate);
const raw = async (tool, query, payload, file = "a.fixture") =>
  JSON.parse(
    text(
      await call(tool, {
        action: "request",
        file,
        query,
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      }),
    ),
  );
const state = (tool) => raw(tool, "fixture/state");
const success = (result) => {
  assert.equal(result.details.success, true, text(result));
  assert.ok(!result.isError, text(result));
  assert.doesNotMatch(text(result), /\.marsh\//);
  return result;
};

const normalCases = [
  [
    { action: "diagnostics", file: "a.fixture" },
    /a\.fixture:3:\d+.*(?:error|Error)/,
  ],
  [
    { action: "definition", file: "a.fixture", line: 1, symbol: "add" },
    /a\.fixture:1:/,
  ],
  [
    { action: "references", file: "a.fixture", line: 1, symbol: "add" },
    /Found \d+ references/,
  ],
  [hover, /### Fixture hover/],
  [{ action: "symbols", file: "a.fixture" }, /Symbols in a\.fixture/],
  [{ ...rename, apply: false }, /sum/],
  [
    {
      action: "rename_file",
      file: "b.fixture",
      new_name: "renamed.fixture",
      apply: false,
    },
    /renamed\.fixture/,
  ],
  [
    { action: "code_actions", file: "a.fixture", symbol: "add" },
    /Fixture quick fix/,
  ],
  [
    { action: "type_definition", file: "a.fixture", symbol: "add" },
    /a\.fixture:1:/,
  ],
  [
    { action: "implementation", file: "a.fixture", symbol: "add" },
    /a\.fixture:1:/,
  ],
  [{ action: "status" }, /fixture/],
  [{ action: "reload", file: "*" }, /fixture/i],
  [{ action: "capabilities" }, /hoverProvider/],
  [
    { action: "request", query: "fixture/echo", payload: '{"normal":true}' },
    /"normal": true/,
  ],
];

test("all fourteen native actions retain public results and renderer formats", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, {
    files: { "a.fixture": `${A}// ERROR fixture marker\n` },
  });
  const tool = await ws.js();
  const execute = tool.execute;
  for (const [input, expected] of normalCases) {
    const result = success(await execute("matrix", input));
    assert.equal(result.details.action, input.action);
    assert.match(text(result), expected, input.action);
    if (result.details.request) assert.equal(result.details.request, input);
  }
  assert.equal(await ws.file("a.fixture"), `${A}// ERROR fixture marker\n`);
  assert.equal(await ws.file("b.fixture"), B);
  assert.equal(
    JSON.parse(
      text(await call(tool, { action: "request", query: "fixture/null" })),
    ),
    null,
  );
  success(await call(tool, { action: "symbols", file: "*", query: "add" }));
  success(await call(tool, { action: "reload" }));
});

test("empty actions, optional workspace selectors and required inputs preserve categories", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, { control: { mode: "empty" } });
  const tool = await ws.js();
  for (const [input] of normalCases) {
    const result = success(await call(tool, input));
    if (
      [
        "definition",
        "type_definition",
        "implementation",
        "references",
        "symbols",
      ].includes(input.action)
    )
      assert.equal(result.useless, true, input.action);
    if (input.action === "hover") {
      assert.match(text(result), /No hover information/);
      assert.ok(!result.useless);
    }
  }
  const missing = [
    ...[
      "diagnostics",
      "definition",
      "references",
      "hover",
      "symbols",
      "rename",
      "rename_file",
      "code_actions",
      "type_definition",
      "implementation",
    ].map((action) => ({ action })),
    { action: "symbols", file: "*", query: " " },
    { action: "rename", file: "a.fixture", new_name: "" },
    { action: "rename_file", file: "a.fixture", new_name: "a.fixture" },
    { action: "request", query: " " },
    { action: "request", query: "fixture/echo", payload: "{" },
  ];
  for (const input of missing)
    await assert.rejects(call(tool, input), semantic, JSON.stringify(input));
  for (const line of [-1, 0, 1.5, 1000, Infinity, NaN])
    await assert.rejects(call(tool, { ...rename, line }), semantic);
  assert.equal(await ws.file("a.fixture"), A);
  const readonly = await ws.js({ readOnly: true });
  for (const action of [
    "rename",
    "rename_file",
    "code_actions",
    "reload",
    "request",
  ]) {
    await assert.rejects(
      call(readonly, { action }),
      (error) => error.name === "ToolError" && !error.cause,
    );
  }
  await assert.rejects(call(tool, { action: "Hover", file: "a.fixture" }));
});

test("pure and cached hovers reauthorize owner reads and retain the same native PID", {
  timeout: 90_000,
}, async (t) => {
  const ws = await workspace(t, {
    control: { mode: "cached-response,chunked,stderr-flood" },
  });
  const tool = await ws.js();
  const first = identity(success(await call(tool, hover)));
  const firstReads = ws.decisions.filter(
    (event) =>
      event.granted &&
      event.action === "Read" &&
      event.resource.join("/") === "a.fixture",
  );
  assert.ok(firstReads.length);
  assert.ok(firstReads.every((event) => event.principal === ws.owner.owner));
  const offset = ws.decisions.length;
  const second = identity(success(await call(tool, hover)));
  assert.equal(second.pid, first.pid);
  assert.ok(second.counter > first.counter);
  assert.ok(
    ws.decisions
      .slice(offset)
      .some(
        (event) =>
          event.granted &&
          event.action === "Read" &&
          event.principal === ws.owner.owner &&
          event.resource.join("/") === "a.fixture",
      ),
  );
  assert.match(
    text(await call(tool, { action: "status" })),
    /fixture.*(?:live|ready|running)/i,
  );
  await ws.owner.readFile(ws.seed, "b.fixture");
  assert.equal(
    identity(await call(tool, hover)).pid,
    first.pid,
    "an equal view survives an unrelated native read",
  );
  await LspTool.shutdown();
  assert.equal(alive(first.pid), false);
});

test("denied cross-file rename releases no output or prefix; release permits publication before resolution", {
  timeout: 120_000,
}, async (t) => {
  const ws = await workspace(t);
  const a = ws.mux.forkOwner();
  const tool = await ws.js();
  const before = identity(await call(tool, hover));
  await ws.run(`cat b.fixture >/dev/null; printf 'add;\\n' > b.fixture`, a);
  const updates = [];
  await assert.rejects(
    call(tool, rename, undefined, (result) => updates.push(result)),
    denied,
  );
  assert.deepEqual(updates, []);
  assert.equal(await ws.file("a.fixture"), A);
  assert.equal(await ws.file("b.fixture"), B);
  assert.equal(alive(before.pid), false);
  await a.release(ws.seed, "b.fixture");
  const previewPid = identity(await call(tool, hover)).pid;
  success(await call(tool, { ...rename, apply: false }));
  assert.equal(await ws.file("a.fixture"), A);
  success(await call(tool, rename));
  assert.equal(await ws.file("a.fixture"), "const sum = 1;\nsum;\n");
  assert.equal(await ws.file("b.fixture"), "sum;\n");
  assert.equal(alive(previewPid), false);
  const after = identity(await call(tool, hover));
  assert.notEqual(after.pid, previewPid);
  assert.match(text(await call(tool, hover)), /content=const sum/);
});

test("readOnly is an action filter, not an exemption for server initiated edits", {
  timeout: 180_000,
}, async (t) => {
  for (const mode of ["apply-edit", "apply-edit-prefix-failure"])
    await t.test(mode, async (t) => {
      const ws = await workspace(t, { control: { mode } });
      const tool = await ws.js({ readOnly: true });
      if (mode.endsWith("prefix-failure")) {
        await assert.rejects(call(tool, hover));
        assert.equal(await ws.file("a.fixture"), A);
      } else {
        const blocker = ws.mux.forkOwner();
        await ws.run(
          `cat a.fixture >/dev/null; printf ${quote(A)} > a.fixture`,
          blocker,
        );
        await assert.rejects(call(tool, hover), denied);
        assert.equal(await ws.file("a.fixture"), A);
        await blocker.release(ws.seed, "a.fixture");
        success(await call(tool, hover));
        assert.equal(await ws.file("a.fixture"), `// applied by fixture\n${A}`);
      }
      const servers = await ws.events("textDocument/hover");
      assert.ok(servers.length);
      assert.ok(
        servers.every(({ pid }) => !alive(pid)),
        "any mutation/failure retires the native tree",
      );
    });
});

test("resource edits, selected code actions and commands share the same receipt", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t);
  const tool = await ws.js();
  const edit = {
    documentChanges: [
      { kind: "create", uri: "${file:created.fixture}" },
      {
        textDocument: { uri: "${file:created.fixture}", version: null },
        edits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "created\n",
          },
        ],
      },
      {
        kind: "rename",
        oldUri: "${file:created.fixture}",
        newUri: "${file:moved.fixture}",
      },
      { kind: "delete", uri: "${file:b.fixture}" },
    ],
  };
  assert.equal((await raw(tool, "fixture/applyEdit", { edit })).applied, true);
  assert.equal(await ws.file("moved.fixture"), "created\n");
  await assert.rejects(ws.file("created.fixture"), { code: "ENOENT" });
  await assert.rejects(ws.file("b.fixture"), { code: "ENOENT" });
  success(
    await call(tool, {
      action: "code_actions",
      file: "a.fixture",
      symbol: "add",
      query: "refactor",
      apply: false,
    }),
  );
  assert.equal(await ws.file("a.fixture"), A);
  success(
    await call(tool, {
      action: "code_actions",
      file: "a.fixture",
      symbol: "add",
      query: "1",
      apply: true,
    }),
  );
  assert.match(await ws.file("a.fixture"), /add_fixed/);
  assert.match(await ws.file("command.fixture"), /command executed/);
  const pid = (await state(tool)).pid;
  const bytes = await ws.file("a.fixture");
  await raw(tool, "fixture/writeRestore", {
    path: join(ws.seed, "a.fixture"),
    text: "temporary",
  });
  assert.equal(await ws.file("a.fixture"), bytes);
  assert.equal(alive(pid), false, "write then restore is still a mutation");
  for (const query of ["99", "not a title"])
    success(
      await call(tool, {
        action: "code_actions",
        file: "a.fixture",
        query,
        apply: true,
      }),
    );
});

test("authorized operation errors discard writes; denied errors cannot leak protected content", {
  timeout: 120_000,
}, async (t) => {
  const secret = "const confidential_fixture_marker = 1;\n";
  const ws = await workspace(t, { files: { "b.fixture": secret } });
  const owner = ws.mux.forkOwner();
  await ws.run(
    `cat b.fixture >/dev/null; printf ${quote(secret)} > b.fixture`,
    owner,
  );
  const tool = await ws.js();
  const input = {
    action: "request",
    file: "a.fixture",
    query: "fixture/error",
    payload: JSON.stringify({
      readPath: join(ws.seed, "b.fixture"),
      writeBefore: { path: join(ws.seed, "b.fixture"), text: "partial" },
    }),
  };
  await assert.rejects(call(tool, input), (error) => {
    denied(error);
    assert.doesNotMatch(error.message, /confidential_fixture_marker/);
    return true;
  });
  assert.equal(await ws.file("b.fixture"), secret);
  await owner.release(ws.seed, "b.fixture");
  await assert.rejects(call(tool, input), (error) => {
    semantic(error);
    assert.match(error.message, /confidential_fixture_marker/);
    return true;
  });
  assert.equal(await ws.file("b.fixture"), secret);
});

test("configuration merges actual JSON/YAML, keeps invalid overrides and replaces settings", {
  timeout: 180_000,
}, async (t) => {
  const lower = server({
    fileTypes: [null, "", 3, "fixture"],
    rootMarkers: [false, "", "."],
    args: [serverScript, "stdio-server", "", "--control=control.json"],
    settings: { fixture: { low: true }, old: true },
    initOptions: { source: "low" },
  });
  const ws = await workspace(t, {
    files: {
      ".omp/lsp.json": JSON.stringify({
        servers: {
          fixture: lower,
          unrelated: server({ fileTypes: ["other"] }),
          filtered: server({ rootMarkers: ["missing.marker"] }),
          disabled: server({ disabled: true }),
          "rust-analyzer": { disabled: true },
        },
      }),
      "lsp.yaml":
        "servers:\n  fixture:\n    command: ''\n  legacy:\n    command: " +
        JSON.stringify(process.execPath) +
        "\n    args: [" +
        JSON.stringify(serverScript) +
        ", stdio-server, '--control=control.json']\n    extensionToLanguage: {legacy: fixture}\n    initializationOptions: {source: legacy-alias}\n",
      "lsp.json": JSON.stringify({
        servers: {
          fixture: {
            settings: {
              fixture: { high: true },
              "fixture.nested": "literal-section",
            },
            initOptions: { source: "root-json" },
          },
          disabled: { disabled: true },
        },
      }),
      ".lsp.json": JSON.stringify({
        servers: { fixture: { settings: { wrong: true } } },
      }),
      ".claude/lsp.json": "{malformed",
      ".codex/lsp.yaml": "[]\n",
      "sample.legacy": "const legacy = 1;\n",
    },
  });
  const tool = await ws.js();
  const observed = await state(tool);
  assert.deepEqual(observed.settings, {
    fixture: { high: true },
    "fixture.nested": "literal-section",
  });
  assert.deepEqual(observed.initializeParams.initializationOptions, {
    source: "root-json",
  });
  assert.deepEqual(observed.configuration.slice(0, 2), [
    { high: true },
    "literal-section",
  ]);
  const status = text(await call(tool, { action: "status" }));
  assert.match(status, /unrelated/);
  assert.match(status, /legacy/);
  assert.doesNotMatch(status, /filtered|disabled|rust-analyzer/);
  success(await call(tool, { action: "hover", file: "sample.legacy" }));
  assert.deepEqual(
    (await raw(tool, "fixture/state", undefined, "sample.legacy"))
      .initializeParams.initializationOptions,
    { source: "legacy-alias" },
  );
  await ws.write(
    "lsp.json",
    JSON.stringify({
      servers: { fixture: { settings: { fixture: { reloaded: true } } } },
    }),
  );
  success(await call(tool, { action: "reload", file: "*" }));
  assert.deepEqual((await state(tool)).settings, {
    fixture: { reloaded: true },
  });
});

test("project binary precedence, root globs, home sources and opt-in foreign configuration are real", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, {
    files: { "package.json": "{}", "marker/one.flag": "yes" },
    env: { PI_CONFIG_DIR: "/chosen" },
  });
  const writeOutside = async (path, body) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  };
  const launcher = `#!${process.execPath}\nimport {runStdioServer} from ${JSON.stringify(pathToFileURL(serverScript).href)};\nawait runStdioServer([], {name: 'project-local'});\n`;
  await ws.write("node_modules/.bin/fixture-server", launcher);
  await chmod(join(ws.seed, "node_modules/.bin/fixture-server"), 0o755);
  const pathBin = join(ws.root, "bin");
  await writeOutside(
    join(pathBin, "fixture-server"),
    `#!${process.execPath}\nthrow new Error('PATH binary must not win');\n`,
  );
  await chmod(join(pathBin, "fixture-server"), 0o755);
  process.env.PATH = `${pathBin}:${ws.environment.PATH}`;
  await ws.write(
    ".omp/lsp.json",
    JSON.stringify({
      servers: {
        fixture: server({
          command: "fixture-server",
          args: [],
          rootMarkers: ["marker/*.flag"],
        }),
      },
    }),
  );
  const home = ws.environment.HOME;
  await writeOutside(
    join(home, "chosen/agent/lsp.json"),
    JSON.stringify({
      servers: { "native-home": server({ fileTypes: ["other"] }) },
    }),
  );
  await writeOutside(
    join(home, ".claude/lsp.json"),
    JSON.stringify({
      servers: { "foreign-user": server({ fileTypes: ["other"] }) },
    }),
  );
  const tool = await ws.js();
  success(await call(tool, hover));
  assert.equal(
    resolve((await state(tool)).initializeParams.rootPath),
    resolve(ws.seed),
  );
  let status = text(await call(tool, { action: "status" }));
  assert.match(status, /native-home/);
  assert.doesNotMatch(status, /foreign-user/);
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  const foreign = await ws.js();
  status = text(await call(foreign, { action: "status" }));
  assert.match(status, /foreign-user/);
});

test("logical absolute paths, URI spaces, flags, config values and nested cwd stay in the private view", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, {
    cwd: "nested",
    files: {
      "nested/a.fixture": A,
      "nested/space name.fixture": "space marker\n",
      "nested/control.json": "{}",
      "nested/.omp/lsp.json": JSON.stringify({
        servers: { fixture: server() },
      }),
    },
  });
  const local = join(ws.cwd, "server.mjs");
  await ws.write(
    "nested/server.mjs",
    `#!${process.execPath}\nimport {runStdioServer} from ${JSON.stringify(pathToFileURL(serverScript).href)}; await runStdioServer(process.argv.slice(2));\n`,
  );
  await chmod(local, 0o755);
  await ws.write(
    "nested/.omp/lsp.json",
    JSON.stringify({
      servers: {
        fixture: server({
          command: local,
          args: [
            "--control=control.json",
            `--events=${join(ws.root, "events.jsonl")}`,
          ],
          settings: {
            fixture: {
              path: join(ws.cwd, "a.fixture"),
              uri: pathToFileURL(join(ws.cwd, "space name.fixture")).href,
              flag: `--root=${ws.cwd}`,
            },
          },
        }),
      },
    }),
  );
  const sibling = `${ws.seed}-sibling`;
  await mkdir(sibling);
  t.after(() => rm(sibling, { recursive: true, force: true }));
  await writeFile(join(sibling, "note"), "outside-prefix-marker\n");
  const tool = await ws.js();
  const input = { action: "hover", file: join(ws.cwd, "a.fixture") };
  const result = success(await call(tool, input));
  assert.match(text(result), /content=const add/);
  if (result.details.request) assert.equal(result.details.request, input);
  for (const [path, expected] of [
    [pathToFileURL(join(ws.cwd, "space name.fixture")).href, "space marker"],
    [join(sibling, "note"), "outside-prefix-marker"],
  ])
    assert.match(
      await raw(tool, "fixture/read", { path }),
      new RegExp(expected),
    );
  const settings = (await state(tool)).settings.fixture;
  assert.equal(settings.path, join(ws.cwd, "a.fixture"));
  assert.equal(
    settings.uri,
    pathToFileURL(join(ws.cwd, "space name.fixture")).href,
  );
  assert.equal(settings.flag, `--root=${ws.cwd}`);
  const blocker = ws.mux.forkOwner();
  await ws.run(
    `cat 'space name.fixture' >/dev/null; printf 'space marker\\n' > 'space name.fixture'`,
    blocker,
  );
  await assert.rejects(
    raw(tool, "fixture/write", {
      uri: pathToFileURL(join(ws.cwd, "space name.fixture")).href,
      text: "denied",
    }),
    denied,
  );
  assert.equal(await ws.file("nested/space name.fixture"), "space marker\n");
  await blocker.release(ws.cwd, "space name.fixture");
  await raw(tool, "fixture/write", {
    path: join(ws.cwd, "space name.fixture"),
    text: "allowed\n",
  });
  assert.equal(await ws.file("nested/space name.fixture"), "allowed\n");
  success(await call(tool, { action: "reload", file: "*" }));
});

test("host and marsh changes invalidate parked views before a request, never after-dispatch replay", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t);
  const tool = await ws.js();
  const first = identity(await call(tool, hover));
  await ws.write("a.fixture", "const host_changed = 2;\n");
  const second = identity(await call(tool, hover));
  assert.notEqual(second.pid, first.pid);
  assert.equal(alive(first.pid), false);
  assert.match(text(await call(tool, hover)), /host_changed/);
  const peer = ws.mux.forkOwner();
  await ws.run(
    "cat a.fixture >/dev/null; printf 'const peer_changed = 3;\\n' > a.fixture",
    peer,
  );
  const third = identity(await call(tool, hover));
  assert.notEqual(third.pid, second.pid);
  assert.equal(alive(second.pid), false);
  const gate = join(ws.root, "response-gate");
  const pending = raw(tool, "fixture/delay", { ms: 0, gate });
  pending.catch(() => {});
  await ws.dispatched("fixture/delay");
  await ws.run(
    "cat a.fixture >/dev/null; printf 'const post_dispatch = 4;\\n' > a.fixture",
    peer,
  );
  await writeFile(gate, "release");
  await assert.rejects(pending);
  assert.equal((await ws.events("fixture/delay")).length, 1);
  assert.equal(await ws.file("a.fixture"), "const post_dispatch = 4;\n");
  assert.equal(alive(third.pid), false);
});

test("pre-abort, queued abort and active abort are isolated; descendants drain", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, {
    control: { mode: "descendant", delays: { "fixture/delay": 0 } },
  });
  const tool = await ws.js();
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(call(tool, hover, pre.signal));
  assert.equal((await ws.events("initialize")).length, 0);
  assert.equal(
    ws.decisions.length,
    0,
    "pre-abort performs no native workspace work",
  );
  const gate = join(ws.root, "active-gate");
  const active = raw(tool, "fixture/delay", { ms: 0, gate });
  active.catch(() => {});
  const event = await ws.dispatched("fixture/delay");
  const descendants = await harnessDescendants();
  assert.ok(descendants.includes(event.pid));
  const queuedCancel = new AbortController();
  const queued = call(tool, hover, queuedCancel.signal);
  queued.catch(() => {});
  queuedCancel.abort();
  await assert.rejects(queued, { name: "AbortError" });
  await writeFile(gate, "release");
  await active;
  assert.equal(identity(await call(tool, hover)).pid, event.pid);
  const snapshot = await state(tool);
  assert.ok(snapshot.childPids.length);
  const abort = new AbortController();
  const pending = call(
    tool,
    {
      action: "request",
      file: "a.fixture",
      query: "fixture/delay",
      payload: JSON.stringify({ ms: 30_000 }),
    },
    abort.signal,
  );
  pending.catch(() => {});
  await ws.dispatched("fixture/delay", 2);
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  for (const pid of [snapshot.pid, ...snapshot.childPids])
    assert.equal(alive(pid), false);
  assert.equal(await ws.file("a.fixture"), A);
});

test("deadline and malformed transports fail closed without unpublished writes", {
  timeout: 240_000,
}, async (t) => {
  const faults = [
    "duplicate-length",
    "length-overflow",
    "oversized-body",
    "header-overflow",
    "partial-frame",
    "stream-failure",
  ];
  for (const mode of faults)
    await t.test(mode, async (t) => {
      const ws = await workspace(t, {
        control: { mode, transportMethod: "textDocument/hover" },
      });
      const tool = await ws.js();
      await assert.rejects(call(tool, { ...hover, timeout: 5 }));
      assert.equal(await ws.file("a.fixture"), A);
      assert.ok(
        (await ws.events("textDocument/hover")).every(({ pid }) => !alive(pid)),
      );
    });
  await t.test("total deadline", async (t) => {
    const ws = await workspace(t, { control: { mode: "descendant" } });
    const tool = await ws.js();
    const before = await state(tool);
    await assert.rejects(
      call(tool, {
        action: "request",
        query: "fixture/delay",
        payload: '{"ms":30000}',
        timeout: 5,
      }),
    );
    for (const pid of [before.pid, ...before.childPids])
      assert.equal(alive(pid), false);
    assert.equal(await ws.file("a.fixture"), A);
  });
});

test("native close is idempotent and mux/global close drain active and queued calls", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t);
  await assert.rejects(
    ws.native.NativeLsp.open(ws.seed, {}, ws.mux),
    (error) =>
      error.name === "ToolError" &&
      error.message === "LspTool requires an owner-bound NativeMux",
  );
  const first = await ws.direct();
  const sibling = await ws.direct();
  const nativeState = async (tool) =>
    JSON.parse(
      (await tool.start({ action: "request", query: "fixture/state" }).wait())
        .text,
    );
  const firstPid = (await nativeState(first)).pid;
  const siblingPid = (await nativeState(sibling)).pid;
  await first.close();
  await first.close();
  assert.equal(alive(firstPid), false);
  assert.equal((await nativeState(sibling)).pid, siblingPid);
  assert.equal((await ws.owner.readFile(ws.seed, "a.fixture")).toString(), A);
  const active = sibling
    .start({
      action: "request",
      query: "fixture/delay",
      payload: '{"ms":30000}',
    })
    .wait();
  active.catch(() => {});
  await ws.dispatched("fixture/delay");
  const queued = sibling.start(hover).wait();
  queued.catch(() => {});
  await ws.mux.close();
  await assert.rejects(active);
  await assert.rejects(queued);
  assert.equal(alive(siblingPid), false);
  const other = ws.track(
    await ws.native.NativeMux.openCopyTree(ws.seed, { sandbox: "always" }),
  );
  const owner = other.forkOwner();
  const a = await ws.native.NativeLsp.open(ws.seed, {}, owner);
  const b = await ws.native.NativeLsp.open(ws.seed, {}, owner);
  const pids = [(await nativeState(a)).pid, (await nativeState(b)).pid];
  await ws.native.NativeLsp.shutdownAll();
  await ws.native.NativeLsp.shutdownAll();
  for (const pid of pids) assert.equal(alive(pid), false);
  const later = await ws.native.NativeLsp.open(ws.seed, {}, owner);
  assert.ok((await nativeState(later)).pid);
  await later.close();
  assert.equal((await owner.readFile(ws.seed, "a.fixture")).toString(), A);
});

test("public shutdown drains injected addons, repeats and permits later construction", {
  timeout: 120_000,
}, async (t) => {
  const ws = await workspace(t);
  const a = await ws.js();
  const b = await ws.js();
  const pids = [
    identity(await call(a, hover)).pid,
    identity(await call(b, hover)).pid,
  ];
  await LspTool.shutdown();
  await LspTool.shutdown();
  for (const pid of pids) assert.equal(alive(pid), false);
  await assert.rejects(call(a, hover));
  const later = await ws.js();
  success(await call(later, hover));
  assert.equal((await ws.owner.readFile(ws.seed, "a.fixture")).toString(), A);
});

test("initialization negative cache respects shortened budgets and reload", {
  timeout: 180_000,
}, async (t) => {
  for (const shortened of [false, true])
    await t.test(String(shortened), async (t) => {
      const ws = await workspace(t, { control: { mode: "init-fail" } });
      const tool = await ws.js();
      const input = { ...hover, ...(shortened ? { timeout: 5 } : {}) };
      await assert.rejects(call(tool, input));
      await assert.rejects(call(tool, input));
      assert.equal((await ws.events("initialize")).length, shortened ? 2 : 1);
      if (!shortened) {
        try {
          await call(tool, { action: "reload", file: "a.fixture" });
        } catch (error) {
          semantic(error);
        }
        await assert.rejects(call(tool, input));
        assert.equal((await ws.events("initialize")).length, 2);
      }
    });
});

test("glob diagnostics cap targets, merge partial failures and fail only all concrete attempts", {
  timeout: 180_000,
}, async (t) => {
  const files = Object.fromEntries(
    Array.from({ length: 22 }, (_, index) => [
      `glob/${String(index).padStart(2, "0")}.fixture`,
      "// ERROR marker\n",
    ]),
  );
  const ws = await workspace(t, { files });
  const tool = await ws.js();
  const capped = text(
    success(
      await call(tool, { action: "diagnostics", file: "glob/*.fixture" }),
    ),
  );
  assert.match(capped, /20/);
  const targets = new Set(
    (await ws.events("textDocument/diagnostic")).map(({ counter }) => counter),
  );
  assert.equal(targets.size, 20);
  success(
    await call(tool, { action: "diagnostics", file: "missing/*.fixture" }),
  );
  await ws.write(
    ".omp/lsp.json",
    JSON.stringify({
      servers: {
        fixture: server(),
        broken: server({
          args: [serverScript, "stdio-server", '--options={"mode":"all-fail"}'],
        }),
      },
    }),
  );
  success(await call(tool, { action: "reload", file: "*" }));
  success(await call(tool, { action: "diagnostics", file: "a.fixture" }));
  await ws.write("control.json", '{"mode":"all-fail"}');
  await assert.rejects(
    call(tool, { action: "diagnostics", file: "a.fixture" }),
    semantic,
  );
});

async function executable(ws, name, kind) {
  const path = join(ws.root, "bin", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `#!${process.execPath}\nimport {runChecker} from ${JSON.stringify(pathToFileURL(serverScript).href)}; await runChecker(${JSON.stringify(kind)}, process.argv.slice(2));\n`,
  );
  await chmod(path, 0o755);
  return path;
}

test("polyglot checkers and custom linters read/write through owner policy receipts", {
  timeout: 240_000,
}, async (t) => {
  const ws = await workspace(t, {
    files: {
      "Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n",
      "tsconfig.json": "{}",
      "go.work": "go 1.24\nuse ./module\n",
      "pyproject.toml": "[project]\nname='fixture'\n",
      "a.fixture": `${A}// ERROR marker\n`,
    },
  });
  for (const [name, kind] of [
    ["cargo", "cargo"],
    ["npx", "tsc"],
    ["go", "go"],
    ["pyright", "pyright"],
    ["biome", "biome"],
    ["swiftlint", "swiftlint"],
  ])
    await executable(ws, name, kind);
  process.env.PATH = `${join(ws.root, "bin")}:${ws.environment.PATH}`;
  const tracePath = join(ws.root, "checkers.jsonl");
  await ws.write(
    ".lsp-fixture.json",
    JSON.stringify({
      tracePath,
      delayMs: 30,
      readPaths: ["a.fixture"],
      checkers: {
        cargo: { writePath: "checker.fixture", writeText: "checker receipt\n" },
        pyright: { exitCode: 1, noOutput: true },
      },
    }),
  );
  const tool = await ws.js();
  const result = success(
    await call(tool, { action: "diagnostics", file: "*" }),
  );
  const output = text(result);
  assert.match(output, /unverified/i);
  assert.equal(await ws.file("checker.fixture"), "checker receipt\n");
  const records = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  let active = 0;
  const seen = new Set();
  for (const record of records) {
    const event = `${record.pid}:${record.event}`;
    assert.equal(
      seen.has(event),
      false,
      `duplicate checker invocation event: ${event}`,
    );
    seen.add(event);
    active += record.event === "start" ? 1 : -1;
    assert.ok(active >= 0 && active <= 2, JSON.stringify(records));
  }
  assert.equal(active, 0);
  const order = [...output.matchAll(/^(Rust|TypeScript|Go|Python):/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(order, ["Rust", "TypeScript", "Go", "Python"]);
  await ws.write(
    ".omp/lsp.json",
    JSON.stringify({
      servers: {
        fixture: { disabled: true },
        biome: server({ command: join(ws.root, "bin/biome"), isLinter: true }),
        swiftlint: server({
          command: join(ws.root, "bin/swiftlint"),
          isLinter: true,
        }),
      },
    }),
  );
  const linters = await ws.js();
  const diagnostics = text(
    success(await call(linters, { action: "diagnostics", file: "a.fixture" })),
  );
  assert.match(diagnostics, /a\.fixture:\d+:\d+.*error/i);
  const holder = ws.mux.forkOwner();
  await ws.run(
    "cat b.fixture >/dev/null; printf 'add;\\n' > b.fixture",
    holder,
  );
  await ws.write(
    ".lsp-fixture.json",
    JSON.stringify({
      readPaths: ["a.fixture"],
      writePath: "b.fixture",
      writeText: "linter denied",
    }),
  );
  await assert.rejects(
    call(linters, { action: "diagnostics", file: "a.fixture" }),
    denied,
  );
  assert.equal(await ws.file("b.fixture"), B);
});

test("resource monitors preserve the supplied owner across parks and finish before mux close", {
  timeout: 120_000,
}, async (t) => {
  // Delegated cgroup-v2 is a prerequisite, not a reason to run unaccounted host children.
  const ws = await workspace(t, {
    options: { resources: { pids: 32, monitorIntervalMs: 50 } },
  });
  const tool = await ws.js();
  const first = identity(await call(tool, hover));
  const second = identity(await call(tool, hover));
  assert.equal(first.pid, second.pid);
  const cgroup = await raw(tool, "fixture/read", { path: "/proc/self/cgroup" });
  const groupPath = /^0::(.*)$/m.exec(cgroup)?.[1];
  assert.ok(groupPath, cgroup);
  assert.equal(
    (
      await raw(tool, "fixture/read", {
        path: `/sys/fs/cgroup${groupPath}/pids.max`,
      })
    ).trim(),
    "32",
  );
  assert.equal(identity(await call(tool, hover)).pid, first.pid);
  await ws.mux.close();
  const starts = ws.resourceEvents.filter(({ kind }) => kind === "started");
  const finishes = ws.resourceEvents.filter(({ kind }) => kind === "finished");
  assert.ok(starts.length, JSON.stringify(ws.resourceEvents));
  assert.equal(finishes.length, starts.length);
  for (const start of starts) {
    assert.equal(start.owner, ws.owner.owner);
    const finish = finishes.filter(
      ({ pipelineId }) => pipelineId === start.pipelineId,
    );
    assert.equal(finish.length, 1);
    assert.equal(finish[0].owner, ws.owner.owner);
    assert.equal(finish[0].sample.pids, 0);
  }
  assert.equal(alive(first.pid), false);
});

test("location unions, hover forms, flat symbols and UTF-16 symbol selectors work over real protocol", {
  timeout: 240_000,
}, async (t) => {
  for (const [locationForm, hoverForm, symbolForm] of [
    ["single", "string", "flat"],
    ["array", "marked", "hierarchical"],
    ["link", "array", "flat"],
  ])
    await t.test(locationForm, async (t) => {
      const ws = await workspace(t, {
        control: { locationForm, hoverForm, symbolForm },
        files: { "a.fixture": "// 😀 added ADD add add\r\nconst add = 1;\r\n" },
      });
      const tool = await ws.js();
      for (const action of [
        "definition",
        "type_definition",
        "implementation",
      ]) {
        assert.match(
          text(
            success(
              await call(tool, {
                action,
                file: "a.fixture",
                line: 2,
                symbol: "add",
              }),
            ),
          ),
          /a\.fixture:\d+:\d+/,
        );
      }
      const rendered = text(success(await call(tool, hover)));
      assert.match(rendered, /pid=\d+/);
      if (hoverForm !== "string") assert.match(rendered, /```/);
      assert.match(
        text(
          success(await call(tool, { action: "symbols", file: "a.fixture" })),
        ),
        /add/,
      );
      for (const [symbol, character] of [
        ["add", 16],
        ["add#0", 16],
        ["add#2", 20],
        ["ADD", 12],
      ]) {
        await call(tool, {
          action: "hover",
          file: "a.fixture",
          line: 1,
          symbol,
        });
        const request = (await state(tool)).requests.findLast(
          ({ method }) => method === "textDocument/hover",
        );
        assert.deepEqual(request.params.position, { line: 0, character });
      }
      await assert.rejects(
        call(tool, {
          action: "hover",
          file: "a.fixture",
          line: 1,
          symbol: "add#3",
        }),
        semantic,
      );
      for (const action of ["definition", "references", "rename"])
        await assert.rejects(
          call(tool, {
            action,
            file: "a.fixture",
            line: 1,
            ...(action === "rename" ? { new_name: "sum" } : {}),
          }),
          semantic,
        );
      // Type definition does not inherit the project-aware explicit-line symbol restriction.
      success(
        await call(tool, {
          action: "type_definition",
          file: "a.fixture",
          line: 2,
        }),
      );
    });
});

test("server requests are serviced with standard responses and literal settings sections", {
  timeout: 120_000,
}, async (t) => {
  const methods = [
    "window/showMessageRequest",
    "window/showDocument",
    "workspace/semanticTokens/refresh",
    "workspace/inlayHint/refresh",
    "workspace/codeLens/refresh",
    "workspace/codeAction/refresh",
    "workspace/inlineValue/refresh",
    "workspace/foldingRange/refresh",
    "workspace/diagnostic/refresh",
    "fixture/unknownClientMethod",
  ];
  const ws = await workspace(t, {
    control: {
      mode: "dynamic-diagnostics,no-push",
      requestClientMethods: methods,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 1,
          message: "dynamic pull diagnostic",
        },
      ],
    },
  });
  const tool = await ws.js();
  success(await call(tool, hover));
  const observed = await state(tool);
  const responses = new Map(
    observed.clientResponses.map((response) => [response.method, response]),
  );
  assert.deepEqual(responses.get("window/showDocument").result, {
    success: false,
  });
  assert.equal(responses.get("fixture/unknownClientMethod").error.code, -32601);
  for (const method of methods.filter(
    (method) =>
      !["window/showDocument", "fixture/unknownClientMethod"].includes(method),
  ))
    assert.equal(responses.get(method).result, null, method);
  assert.equal(
    responses.get("workspace/workspaceFolders").result[0].uri,
    pathToFileURL(ws.seed).href,
  );
  assert.equal(responses.get("window/workDoneProgress/create").result, null);
  const diagnostics = await call(tool, {
    action: "diagnostics",
    file: "a.fixture",
  });
  success(diagnostics);
  assert.match(text(diagnostics), /dynamic pull diagnostic/);
  const noPosition = JSON.parse(
    text(
      await call(tool, {
        action: "request",
        file: "a.fixture",
        query: "fixture/echo",
      }),
    ),
  );
  assert.equal(
    noPosition.textDocument.uri,
    pathToFileURL(join(ws.seed, "a.fixture")).href,
  );
  assert.equal(noPosition.position, undefined);
  const withPosition = JSON.parse(
    text(
      await call(tool, {
        action: "request",
        file: "a.fixture",
        line: 2,
        query: "fixture/echo",
      }),
    ),
  );
  assert.deepEqual(withPosition.position, { line: 1, character: 0 });
  assert.deepEqual(
    JSON.parse(
      text(await call(tool, { action: "request", query: "fixture/echo" })),
    ),
    {},
  );
  await assert.rejects(
    raw(tool, "fixture/unknown", { long: "x".repeat(800) }),
    (error) => {
      semantic(error);
      assert.ok(!error.message.includes("x".repeat(401)));
      return true;
    },
  );
});

test("diagnostics handle initial emptiness, unversioned quiet, malformed frames and failed pulls", {
  timeout: 240_000,
}, async (t) => {
  for (const mode of [
    "initial-empty,no-pull",
    "unversioned,no-pull",
    "stale-version",
    "malformed-json,transport-junk",
  ])
    await t.test(mode, async (t) => {
      const ws = await workspace(t, {
        control: { mode, diagnosticDelayMs: 40 },
        files: { "a.fixture": "// ERROR real diagnostic\n" },
      });
      const tool = await ws.js();
      success(await call(tool, hover));
      const result = text(
        success(await call(tool, { action: "diagnostics", file: "a.fixture" })),
      );
      assert.match(result, /1 diagnostics \(1 errors\)/);
      assert.match(result, /a\.fixture:1:\d+ error:/);
    });
  await t.test("pull failure is not clean", async (t) => {
    const ws = await workspace(t, { control: { mode: "pull-fail,no-push" } });
    const tool = await ws.js();
    await assert.rejects(
      call(tool, { action: "diagnostics", file: "a.fixture" }),
      semantic,
    );
  });
});

test("rename-file merges prioritize project edits, previews tolerate RPC failure, apply does not", {
  timeout: 240_000,
}, async (t) => {
  const change = (newText, start = 0, end = 3) => ({
    changes: {
      "${file:b.fixture}": [
        {
          range: {
            start: { line: 0, character: start },
            end: { line: 0, character: end },
          },
          newText,
        },
      ],
    },
  });
  const ws = await workspace(t, {
    files: {
      "b.fixture": "add a.fixture\n",
      ".omp/lsp.json": JSON.stringify({
        servers: {
          fixture: server({
            args: [
              serverScript,
              "stdio-server",
              `--options=${JSON.stringify({ willRenameEdit: change("sum") })}`,
            ],
          }),
          linter: server({
            isLinter: true,
            args: [
              serverScript,
              "stdio-server",
              `--options=${JSON.stringify({ willRenameEdit: change("wrong") })}`,
            ],
          }),
          extra: server({
            args: [
              serverScript,
              "stdio-server",
              `--options=${JSON.stringify({ willRenameEdit: change("renamed.fixture", 4, 13) })}`,
            ],
          }),
        },
      }),
    },
  });
  const tool = await ws.js();
  const input = {
    action: "rename_file",
    file: "a.fixture",
    new_name: "renamed.fixture",
  };
  const preview = text(success(await call(tool, { ...input, apply: false })));
  assert.match(preview, /overlap/i);
  assert.equal(await ws.file("a.fixture"), A);
  success(await call(tool, input));
  assert.equal(await ws.file("renamed.fixture"), A);
  assert.equal(await ws.file("b.fixture"), "sum renamed.fixture\n");
  await assert.rejects(ws.file("a.fixture"), { code: "ENOENT" });
  await ws.write(
    ".omp/lsp.json",
    JSON.stringify({
      servers: {
        fixture: server({
          args: [
            serverScript,
            "stdio-server",
            '--options={"mode":"will-rename-fail"}',
          ],
        }),
      },
    }),
  );
  const failureTool = await ws.js();
  const blocked = {
    action: "rename_file",
    file: "renamed.fixture",
    new_name: "blocked.fixture",
  };
  success(await call(failureTool, { ...blocked, apply: false }));
  await assert.rejects(call(failureTool, blocked), semantic);
  assert.equal(await ws.file("renamed.fixture"), A);
  await assert.rejects(ws.file("blocked.fixture"), { code: "ENOENT" });
  await ws.write(
    ".omp/lsp.json",
    JSON.stringify({
      servers: {
        fixture: server({
          args: [
            serverScript,
            "stdio-server",
            '--options={"mode":"will-rename-unsupported"}',
          ],
        }),
      },
    }),
  );
  const unsupported = await ws.js();
  success(await call(unsupported, blocked));
  assert.equal(await ws.file("blocked.fixture"), A);
});

test("directory rename validates file bounds and never moves an invalid destination", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, {
    files: { "directory/a.fixture": A, "directory/nested/b.fixture": B },
  });
  const tool = await ws.js();
  await mkdir(join(ws.seed, "empty"));
  for (const input of [
    { file: "empty", new_name: "empty-moved" },
    { file: "a.fixture", new_name: "b.fixture" },
    { file: "a.fixture", new_name: "a.fixture" },
  ])
    await assert.rejects(
      call(tool, { action: "rename_file", ...input }),
      semantic,
    );
  await assert.rejects(
    call(tool, {
      action: "rename_file",
      file: "absent.fixture",
      new_name: "present.fixture",
    }),
  );
  success(
    await call(tool, {
      action: "rename_file",
      file: "directory",
      new_name: "moved-directory",
    }),
  );
  assert.equal(await ws.file("moved-directory/a.fixture"), A);
  assert.equal(await ws.file("moved-directory/nested/b.fixture"), B);
  await assert.rejects(ws.file("directory/a.fixture"), { code: "ENOENT" });
  const many = join(ws.seed, "many");
  await mkdir(many);
  // Real files, not a fabricated directory iterator result.
  for (let index = 0; index < 1001; index += 1)
    await writeFile(join(many, `${index}.fixture`), "add;\n");
  await assert.rejects(
    call(tool, { action: "rename_file", file: "many", new_name: "too-many" }),
    semantic,
  );
  assert.equal(await ws.file("many/1000.fixture"), B);
});

test("text edit batches validate UTF-16, versions, overlaps and resource prefixes before publication", {
  timeout: 240_000,
}, async (t) => {
  const position = (character) => ({ line: 0, character });
  const edit = (start, end, newText, more = {}) => ({
    range: { start: position(start), end: position(end) },
    newText,
    ...more,
  });
  const ws = await workspace(t, { files: { "a.fixture": "😀 add\r\n" } });
  const tool = await ws.js();
  await call(tool, hover);
  for (const edits of [
    [edit(1, 2, "bad")],
    [edit(3, 5, "one"), edit(4, 6, "two")],
    [edit(3, 6, "${1:snippet}", { insertTextFormat: 2 })],
    [edit(0, 100, "outside")],
  ]) {
    await assert.rejects(
      raw(tool, "fixture/applyEdit", {
        edit: { changes: { "${file:a.fixture}": edits } },
      }),
    );
    assert.equal(await ws.file("a.fixture"), "😀 add\r\n");
  }
  await call(tool, hover);
  const observed = await state(tool);
  const known = observed.documents.find(({ uri }) =>
    uri.endsWith("a.fixture"),
  )?.version;
  assert.ok(Number.isInteger(known));
  await assert.rejects(
    raw(tool, "fixture/applyEdit", {
      edit: {
        documentChanges: [
          {
            textDocument: { uri: "${file:a.fixture}", version: known + 1 },
            edits: [edit(3, 6, "sum")],
          },
        ],
      },
    }),
  );
  assert.equal(await ws.file("a.fixture"), "😀 add\r\n");
  // Touching ranges and duplicate nonempty edits are accepted, ordered insertions stay ordered.
  const accepted = [
    edit(3, 4, "s"),
    edit(4, 6, "um"),
    edit(4, 6, "um"),
    edit(6, 6, "1"),
    edit(6, 6, "2"),
  ];
  assert.equal(
    (
      await raw(tool, "fixture/applyEdit", {
        edit: { changes: { "${file:a.fixture}": accepted } },
      })
    ).applied,
    true,
  );
  assert.equal(await ws.file("a.fixture"), "😀 sum12\r\n");
  const before = await ws.file("a.fixture");
  await assert.rejects(
    raw(tool, "fixture/applyEdit", {
      edit: {
        documentChanges: [
          {
            textDocument: { uri: "${file:a.fixture}", version: null },
            edits: [edit(3, 6, "bad")],
          },
          {
            kind: "rename",
            oldUri: "${file:missing.fixture}",
            newUri: "${file:new.fixture}",
          },
        ],
      },
    }),
  );
  assert.equal(await ws.file("a.fixture"), before);
  await assert.rejects(ws.file("new.fixture"), { code: "ENOENT" });
});

test("source comparison failure rejects before dispatch rather than retrying the action", {
  timeout: 120_000,
}, async (t) => {
  const ws = await workspace(t, {
    expectedLspCloseFailure: async (handles, native) => {
      let receipt;
      const retained = (error) => {
        assert.equal(error.name, "ToolError");
        assert.match(error.message, /shell infrastructure failure:/);
        assert.match(error.message, /No such file or directory \(os error 2\)/);
        receipt ??= error.message;
        assert.equal(error.message, receipt);
        return true;
      };
      // The unavailable source poisons this session: acknowledge its receipt, then sweep it.
      await cleanup(
        ...handles.map(
          (handle) => () => assert.rejects(handle.close(), retained),
        ),
        () => assert.rejects(native.NativeLsp.shutdownAll(), retained),
        ...handles.map(
          (handle) => () => assert.rejects(handle.close(), retained),
        ),
        () => native.NativeLsp.shutdownAll(),
        () => LspTool.shutdown(),
      );
    },
  });
  const tool = await ws.direct();
  const old = identity(await tool.start(hover).wait());
  const dispatches = (await ws.events("textDocument/hover")).length;
  const unavailable = join(ws.root, "temporarily-unavailable-seed");
  await move(ws.seed, unavailable);
  try {
    await assert.rejects(tool.start(hover).wait());
  } finally {
    await move(unavailable, ws.seed);
  }
  assert.equal((await ws.events("textDocument/hover")).length, dispatches);
  assert.equal(alive(old.pid), false);
  assert.equal(await ws.file("a.fixture"), A);
});

test("cancellation discards first-startup writes and drains adopted descendants", {
  timeout: 120_000,
}, async (t) => {
  const ws = await workspace(t, {
    control: {
      mode: "descendant",
      startupWrite: "unpublished.fixture",
      startupText: "must not escape",
      delays: { "textDocument/hover": 30000 },
    },
  });
  const tool = await ws.js();
  const abort = new AbortController();
  const pending = call(tool, hover, abort.signal);
  pending.catch(() => {});
  const event = await ws.dispatched("textDocument/hover");
  const pids = await harnessDescendants();
  assert.ok(pids.includes(event.pid));
  await assert.rejects(ws.file("unpublished.fixture"), { code: "ENOENT" });
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  for (const pid of pids) assert.equal(alive(pid), false);
  await assert.rejects(ws.file("unpublished.fixture"), { code: "ENOENT" });
});

test("empty server selection and missing checkers are explicit, not false clean results", {
  timeout: 120_000,
}, async (t) => {
  const ws = await workspace(t, {
    env: { PATH: "" },
    files: {
      ".omp/lsp.json": JSON.stringify({
        servers: { fixture: { disabled: true } },
      }),
    },
  });
  const tool = await ws.js();
  success(await call(tool, { action: "status" }));
  assert.equal((await ws.events("initialize")).length, 0);
  success(await call(tool, { action: "diagnostics", file: "a.fixture" }));
  success(await call(tool, { action: "diagnostics", file: "*" }));
  for (const action of ["capabilities", "reload"])
    await assert.rejects(call(tool, { action }), semantic);
  await assert.rejects(
    call(tool, { action: "request", query: "fixture/echo" }),
    semantic,
  );
  await ws.write("Cargo.toml", "[package]\nname='fixture'\nversion='0.1.0'\n");
  const output = text(
    success(await call(tool, { action: "diagnostics", file: "*" })),
  );
  assert.match(output, /spawn\/check failure/i);
});

test("references retry declaration-only results while workspace symbols merge partial responses", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, { control: { declarationOnlyCount: 2 } });
  const tool = await ws.js();
  const result = text(
    success(
      await call(tool, {
        action: "references",
        file: "a.fixture",
        line: 1,
        symbol: "add",
      }),
    ),
  );
  assert.match(result, /Found 3 references/);
  assert.equal(
    (await state(tool)).requests.filter(
      ({ method }) => method === "textDocument/references",
    ).length,
    3,
  );
  await ws.write(
    ".omp/lsp.json",
    JSON.stringify({
      servers: {
        fixture: server(),
        broken: server({
          args: [serverScript, "stdio-server", '--options={"mode":"all-fail"}'],
        }),
      },
    }),
  );
  const partial = await ws.js();
  const symbols = text(
    success(
      await call(partial, { action: "symbols", file: "*", query: "add" }),
    ),
  );
  assert.match(symbols, /add/);
  assert.match(symbols, /warning/i);
  await ws.write("control.json", '{"mode":"all-fail"}');
  await assert.rejects(
    call(partial, { action: "symbols", file: "*", query: "add" }),
    semantic,
  );
});

test("workspace symbols cap displayed results and capabilities retain partial startup success", {
  timeout: 180_000,
}, async (t) => {
  const symbols = Array.from({ length: 205 }, (_, index) => ({
    name: `item_${index}`,
    kind: 13,
    location: {
      uri: "${file:a.fixture}",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    },
  }));
  const ws = await workspace(t, {
    control: { responses: { "workspace/symbol": symbols } },
    files: {
      ".omp/lsp.json": JSON.stringify({
        servers: {
          fixture: server(),
          failed: server({
            args: [
              serverScript,
              "stdio-server",
              '--options={"mode":"init-fail"}',
            ],
          }),
        },
      }),
    },
  });
  const tool = await ws.js();
  const rendered = text(
    success(await call(tool, { action: "symbols", file: "*", query: "item_" })),
  );
  const displayed = new Set(rendered.match(/item_\d+/g));
  assert.equal(displayed.size, 200);
  const capabilities = text(
    success(await call(tool, { action: "capabilities", file: "*" })),
  );
  assert.match(capabilities, /hoverProvider/);
  assert.match(capabilities, /failed/);
  await assert.rejects(
    call(tool, { action: "capabilities", file: "no-server.unknown" }),
    semantic,
  );
});

test("workspace checkers cap output, discover Go roots and discard denied native writes", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, {
    files: {
      "Cargo.toml": "[package]\nname='fixture'\nversion='0.1.0'\n",
      "go.work": "go 1.24\nuse ./module\n",
    },
  });
  await executable(ws, "cargo", "cargo");
  await executable(ws, "go", "go");
  process.env.PATH = `${join(ws.root, "bin")}:${ws.environment.PATH}`;
  const tracePath = join(ws.root, "checker-events.jsonl");
  const output = Array.from(
    { length: 65 },
    (_, index) => `checker-line-${String(index).padStart(3, "0")}`,
  ).join("\n");
  await ws.write(
    ".lsp-fixture.json",
    JSON.stringify({
      tracePath,
      readPaths: ["a.fixture"],
      checkers: { cargo: { output }, go: { goUse: ["./module", "./second"] } },
    }),
  );
  const tool = await ws.js();
  const result = text(
    success(await call(tool, { action: "diagnostics", file: "*" })),
  );
  assert.match(result, /checker-line-049/);
  assert.doesNotMatch(result, /checker-line-050/);
  const records = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    records.some(
      ({ kind, argv }) =>
        kind === "go" &&
        argv.includes("./module/...") &&
        argv.includes("./second/..."),
    ),
  );
  const blocker = ws.mux.forkOwner();
  await ws.run(
    "cat b.fixture >/dev/null; printf 'add;\\n' > b.fixture",
    blocker,
  );
  await ws.write(
    ".lsp-fixture.json",
    JSON.stringify({
      tracePath,
      readPaths: ["a.fixture"],
      checkers: {
        cargo: { writePath: "b.fixture", writeText: "checker native write" },
        go: { mode: "go-discovery-fail" },
      },
    }),
  );
  const updates = [];
  await assert.rejects(
    call(tool, { action: "diagnostics", file: "*" }, undefined, (result) =>
      updates.push(result),
    ),
    denied,
  );
  assert.deepEqual(updates, []);
  assert.equal(await ws.file("b.fixture"), B);
  await blocker.release(ws.seed, "b.fixture");
  success(await call(tool, { action: "diagnostics", file: "*" }));
  assert.equal(await ws.file("b.fixture"), "checker native write");
  const fallbackRecords = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    fallbackRecords.some(
      ({ kind, argv }) =>
        kind === "go" && argv.includes("build") && argv.includes("./..."),
    ),
  );
});

test("idle reaping and incompatible position encoding do not reuse an invalid runtime", {
  timeout: 120_000,
}, async (t) => {
  const ws = await workspace(t);
  const config = JSON.parse(await ws.file(".omp/lsp.json"));
  config.idleTimeoutMs = 100;
  await ws.write(".omp/lsp.json", JSON.stringify(config));
  const tool = await ws.js();
  const first = identity(await call(tool, hover));
  await sleep(120);
  const second = identity(await call(tool, hover));
  assert.notEqual(second.pid, first.pid);
  assert.equal(alive(first.pid), false);
  await ws.write("control.json", '{"positionEncoding":"utf-8"}');
  await assert.rejects(call(tool, hover));
  assert.ok((await ws.events("initialize")).every(({ pid }) => !alive(pid)));
});

test("native close and global shutdown cancel active and queued application work", {
  timeout: 240_000,
}, async (t) => {
  for (const mode of ["native-close", "native-shutdown", "public-shutdown"])
    await t.test(mode, async (t) => {
      const ws = await workspace(t, { control: { mode: "descendant" } });
      let active;
      let queued;
      let close;
      if (mode === "public-shutdown") {
        const tool = await ws.js();
        active = call(tool, {
          action: "request",
          query: "fixture/delay",
          payload: '{"ms":30000}',
        });
        active.catch(() => {});
        await ws.dispatched("fixture/delay");
        queued = call(tool, hover);
        close = () => LspTool.shutdown();
      } else {
        const tool = await ws.direct();
        active = tool
          .start({
            action: "request",
            query: "fixture/delay",
            payload: '{"ms":30000}',
          })
          .wait();
        active.catch(() => {});
        await ws.dispatched("fixture/delay");
        queued = tool.start(hover).wait();
        close =
          mode === "native-close"
            ? () => tool.close()
            : () => ws.native.NativeLsp.shutdownAll();
      }
      queued.catch(() => {});
      const pids = await harnessDescendants();
      assert.ok(
        pids.length >= 2,
        "real server and descendant are present before closing",
      );
      await close();
      await assert.rejects(active);
      await assert.rejects(queued);
      for (const pid of pids) assert.equal(alive(pid), false);
      assert.equal(
        (await ws.owner.readFile(ws.seed, "a.fixture")).toString(),
        A,
      );
      assert.equal(
        (await ws.events("textDocument/hover")).length,
        0,
        "queued work never reached the server",
      );
    });
});

test("resource operation options preserve create/rename/delete semantics and discard late failure", {
  timeout: 180_000,
}, async (t) => {
  const ws = await workspace(t, {
    files: {
      "old.fixture": "old\n",
      "destination.fixture": "destination\n",
      "tree/child.fixture": "child\n",
    },
  });
  const tool = await ws.js();
  const apply = (documentChanges) =>
    raw(tool, "fixture/applyEdit", { edit: { documentChanges } });
  assert.equal(
    (
      await apply([
        {
          kind: "create",
          uri: "${file:old.fixture}",
          options: { ignoreIfExists: true },
        },
      ])
    ).applied,
    true,
  );
  assert.equal(await ws.file("old.fixture"), "old\n");
  assert.equal(
    (
      await apply([
        {
          kind: "rename",
          oldUri: "${file:old.fixture}",
          newUri: "${file:destination.fixture}",
          options: { ignoreIfExists: true },
        },
      ])
    ).applied,
    true,
  );
  assert.equal(await ws.file("old.fixture"), "old\n");
  assert.equal(await ws.file("destination.fixture"), "destination\n");
  assert.equal(
    (
      await apply([
        {
          kind: "rename",
          oldUri: "${file:old.fixture}",
          newUri: "${file:destination.fixture}",
          options: { overwrite: true, ignoreIfExists: true },
        },
      ])
    ).applied,
    true,
  );
  assert.equal(await ws.file("destination.fixture"), "old\n");
  await assert.rejects(ws.file("old.fixture"), { code: "ENOENT" });
  assert.equal(
    (
      await apply([
        {
          kind: "create",
          uri: "${file:destination.fixture}",
          options: { overwrite: true, ignoreIfExists: true },
        },
      ])
    ).applied,
    true,
  );
  assert.equal(await ws.file("destination.fixture"), "");
  assert.equal(
    (
      await apply([
        { kind: "delete", uri: "${file:tree}", options: { recursive: true } },
        {
          kind: "delete",
          uri: "${file:absent.fixture}",
          options: { ignoreIfNotExists: true },
        },
      ])
    ).applied,
    true,
  );
  await assert.rejects(ws.file("tree/child.fixture"), { code: "ENOENT" });
  await assert.rejects(
    apply([
      { kind: "create", uri: "${file:prefix-created.fixture}" },
      {
        kind: "rename",
        oldUri: "${file:missing.fixture}",
        newUri: "${file:destination.fixture}",
        options: { overwrite: true },
      },
    ]),
  );
  await assert.rejects(ws.file("prefix-created.fixture"), { code: "ENOENT" });
  assert.equal(
    await ws.file("destination.fixture"),
    "",
    "a failed move must not lose the old destination",
  );
});

test("code-action resolution, title selection and direct commands are transactional", {
  timeout: 240_000,
}, async (t) => {
  for (const [query, expected] of [
    ["0", "add_fixed"],
    ["QUICK FIX", "add_fixed"],
    ["DIRECT COMMAND", "add"],
  ])
    await t.test(query, async (t) => {
      const ws = await workspace(t);
      const tool = await ws.js();
      const pid = identity(await call(tool, hover)).pid;
      const input = {
        action: "code_actions",
        file: "a.fixture",
        symbol: "add",
        apply: true,
      };
      success(await call(tool, input));
      assert.equal(
        await ws.file("a.fixture"),
        A,
        "apply without a selection lists only",
      );
      success(await call(tool, { ...input, query }));
      assert.match(
        await ws.file("a.fixture"),
        new RegExp(`const ${expected} =`),
      );
      assert.match(await ws.file("command.fixture"), /command executed/);
      assert.equal(alive(pid), false);
      const requests = await ws.events("codeAction/resolve");
      assert.equal(requests.length, query === "DIRECT COMMAND" ? 0 : 1);
    });
  await t.test(
    "command failure discards both edit and native write",
    async (t) => {
      const ws = await workspace(t, { control: { mode: "command-fail" } });
      const tool = await ws.js();
      await assert.rejects(
        call(tool, {
          action: "code_actions",
          file: "a.fixture",
          symbol: "add",
          query: "1",
          apply: true,
        }),
        semantic,
      );
      assert.equal(await ws.file("a.fixture"), A);
      assert.equal(await ws.file("b.fixture"), B);
      await assert.rejects(ws.file("command.fixture"), { code: "ENOENT" });
    },
  );
});

test("Python, Ruby and Go project executable roots take precedence over PATH", {
  timeout: 240_000,
}, async (t) => {
  for (const [marker, directory] of [
    ["pyproject.toml", ".venv/bin"],
    ["Gemfile", "vendor/bundle/bin"],
    ["go.mod", "bin"],
  ])
    await t.test(marker, async (t) => {
      const ws = await workspace(t, { files: { [marker]: "" } });
      const launcher = `#!${process.execPath}\nimport {runStdioServer} from ${JSON.stringify(pathToFileURL(serverScript).href)}; await runStdioServer([], {name: ${JSON.stringify(marker)}});\n`;
      await ws.write(`${directory}/fixture-language-server`, launcher);
      await chmod(join(ws.seed, directory, "fixture-language-server"), 0o755);
      await ws.write(
        ".omp/lsp.json",
        JSON.stringify({
          servers: {
            fixture: server({ command: "fixture-language-server", args: [] }),
          },
        }),
      );
      const tool = await ws.js();
      success(await call(tool, hover));
      assert.equal(
        (await state(tool)).initializeParams.rootUri,
        pathToFileURL(ws.seed).href,
      );
    });
});

test("awaited native calls survive temporary handle finalization", {
  timeout: 120_000,
}, async (t) => {
  const gc =
    typeof globalThis.gc === "function"
      ? () => globalThis.gc()
      : typeof globalThis.Bun?.gc === "function"
        ? () => globalThis.Bun.gc(true)
        : undefined;
  if (!gc) {
    const child = spawnSync(
      "node",
      [
        "--expose-gc",
        "--test",
        "--test-name-pattern=^awaited native calls survive temporary handle finalization$",
        fileURLToPath(import.meta.url),
      ],
      { encoding: "utf8", timeout: 110_000, env: process.env },
    );
    assert.equal(
      child.status,
      0,
      child.stderr || child.stdout || String(child.error),
    );
    return;
  }
  const ws = await workspace(t);
  const tool = await ws.direct();
  const gate = join(ws.root, "awaited-gc-gate");
  // Keep the handle out of the suspended test frame's conservative GC roots.
  const { pending, reference } = (() => {
    const handle = tool.start({
      action: "request",
      file: "a.fixture",
      query: "fixture/delay",
      payload: JSON.stringify({ ms: 0, gate }),
    });
    return { pending: handle.wait(), reference: new WeakRef(handle) };
  })();
  pending.catch(() => {});
  const event = await ws.dispatched("fixture/delay");
  const deadline = Date.now() + 5000;
  let collected = false;
  while (Date.now() < deadline) {
    await sleep(0);
    gc();
    if (reference.deref() === undefined) {
      collected = true;
      break;
    }
  }
  assert.ok(
    collected,
    "the temporary native call handle was actually finalized",
  );
  await writeFile(gate, "release");
  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.text).pid, event.pid);
  assert.equal(await ws.file("a.fixture"), A);
});
