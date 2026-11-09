#!/usr/bin/env node
/**
 * A real stdio language server and real CLI diagnostic executables, for Node and Bun.
 *
 * Server: node lsp-fixture.mjs stdio-server [--control=control.json]
 *         [--mode=cached-response,chunked] [--options='{"delayMs":100}']
 * Control precedence: .lsp-fixture.json, LSP_FIXTURE_OPTIONS, --control, --options.
 * LSP_FIXTURE_MODE and --mode add comma-separated modes. Configuration is read once
 * in the server's actual cwd; tests changing it must admit a new server runtime.
 * --events=PATH (or events in control JSON) opts into an external harness JSONL log
 * with {method,pid,counter,phase:'dispatch'|'response'}; no log is written otherwise.
 *
 * Useful modes: empty, all-fail, partial-fail, init-fail, cached-response, flat-symbols,
 * unversioned, stale-version, initial-empty, no-push, no-pull, dynamic-diagnostics,
 * apply-edit, readonly-apply-edit, apply-edit-prefix-failure, write-restore, raw-writes,
 * delayed, cancel, descendant, transport-junk, malformed-json, duplicate-length,
 * length-overflow, oversized-body, header-overflow, partial-frame, stream-failure,
 * chunked, stderr-flood, command-fail, will-rename-unsupported, will-rename-fail.
 *
 * Options include per-method responses/errors/delays, failFiles, files, fileTypes,
 * diagnostics, locationForm ('single'/'array'/'link'), capabilities, positionEncoding,
 * applyEdit (a WorkspaceEdit), applyEditMethod, renameEdit, willRenameEdit, codeActions,
 * commandPath/commandText, writePath/writeText, gate, descendant, and transportMethod.
 * Response/edit string values AND keys expand ${cwd}, ${uri}, and ${file:relative}.
 * fixture/state exposes observed requests, configuration responses, documents and PIDs.
 * fixture/echo, fixture/null, fixture/error, fixture/read, fixture/write,
 * fixture/writeRestore, fixture/applyEdit, fixture/descendant and fixture/delay are
 * explicit raw methods. Other methods return -32601 unless responses configures them.
 *
 * CLI: node lsp-fixture.mjs checker [cargo|tsc|go|pyright] [original command argv...]
 *      node lsp-fixture.mjs biome lint --reporter=json a.fixture
 *      node lsp-fixture.mjs swiftlint lint --quiet --reporter json a.fixture
 * Options: readPaths, writePath/writeText, writeRestore, exitCode, noOutput, output,
 * delayMs, tracePath (append-only JSONL start/end events), goUse (go work discovery).
 * checkers:{cargo:{...},tsc:{...},go:{...},pyright:{...},biome:{...},swiftlint:{...}}
 * overrides options per executable. Symlinking this executable as cargo/npx/tsc/go/
 * pyright/biome/swiftlint also selects the corresponding checker mode automatically.
 * All checker filesystem access is real; no tracer/policy or client is simulated.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ownPath = fileURLToPath(import.meta.url);
const MAX_HEADER = 16 * 1024;
const MAX_BODY = 256 * 1024 * 1024;
const sourceExtensions = new Set([
  ".fixture",
  ".txt",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".rs",
  ".js",
  ".ts",
  ".py",
  ".swift",
]);
const methodNotFound = (method) =>
  Object.assign(new Error(`Unknown fixture method: ${method}`), {
    code: -32601,
  });
const cancelledError = () =>
  Object.assign(new Error("Fixture request cancelled"), { code: -32800 });
const identifierChar = /[$\p{ID_Continue}]/u;
const identifier = /[$\p{ID_Start}][$\p{ID_Continue}]*/gu;
const own = (value, key) => Object.hasOwn(value, key);

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const key = arg.slice(2, equal === -1 ? undefined : equal);
    // Leave CLI tool flags alone: only these belong to the fixture.
    if (!["control", "mode", "options", "kind", "events"].includes(key))
      continue;
    const value = equal === -1 ? argv[++index] : arg.slice(equal + 1);
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    options[key] = value;
  }
  return { options, positional };
}

function objectJson(text, label) {
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${label} must contain a JSON object`);
  return value;
}

function readControl(path, optional) {
  try {
    return objectJson(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (optional && error.code === "ENOENT") return {};
    throw error;
  }
}

export function fixtureOptions(argv = [], provided = {}) {
  const { options } = parseArgs(argv);
  const merged = {
    ...readControl(resolve(".lsp-fixture.json"), true),
    ...(process.env.LSP_FIXTURE_OPTIONS
      ? objectJson(process.env.LSP_FIXTURE_OPTIONS, "LSP_FIXTURE_OPTIONS")
      : {}),
    ...(options.control ? readControl(resolve(options.control), false) : {}),
    ...(options.options ? objectJson(options.options, "--options") : {}),
    ...provided,
  };
  merged.mode = [merged.mode, process.env.LSP_FIXTURE_MODE, options.mode]
    .filter(Boolean)
    .join(",");
  if (options.events) merged.events = options.events;
  return merged;
}

function modesOf(options) {
  return new Set(
    String(options.mode ?? "")
      .split(",")
      .map((mode) => mode.trim().toLowerCase().replaceAll("_", "-"))
      .filter(Boolean),
  );
}

function pathOf(value) {
  if (typeof value !== "string")
    throw new Error("Expected a file path or file URI");
  return value.startsWith("file:") ? fileURLToPath(value) : resolve(value);
}

function uriOf(path) {
  return pathToFileURL(pathOf(path)).href;
}

function expand(value, uri = "") {
  const string = (text) =>
    text.replace(/\$\{(cwd|uri|file:([^}]+))\}/g, (_match, kind, file) =>
      kind === "cwd" ? process.cwd() : kind === "uri" ? uri : uriOf(file),
    );
  if (typeof value === "string") return string(value);
  if (Array.isArray(value)) return value.map((item) => expand(item, uri));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        string(key),
        expand(item, uri),
      ]),
    );
  return value;
}

function writeFile(path, value) {
  const target = pathOf(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function workspaceFiles(options) {
  if (options.files) return options.files.map(pathOf).sort();
  const extensions = options.fileTypes
    ? new Set(
        options.fileTypes.map((type) =>
          type.startsWith(".") ? type.toLowerCase() : `.${type.toLowerCase()}`,
        ),
      )
    : sourceExtensions;
  const result = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "target"
      )
        continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (
        entry.isFile() &&
        child !== ownPath &&
        extensions.has(extname(child).toLowerCase())
      )
        result.push(child);
    }
  }
  visit(process.cwd());
  return result;
}

function offsetAt(text, position) {
  if (
    !Number.isInteger(position?.line) ||
    !Number.isInteger(position?.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new Error("Invalid UTF-16 position");
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const next = text.indexOf("\n", offset);
    if (next === -1) throw new Error("Line is outside the document");
    offset = next + 1;
  }
  let end = text.indexOf("\n", offset);
  if (end === -1) end = text.length;
  if (end > offset && text[end - 1] === "\r") end -= 1;
  if (position.character > end - offset)
    throw new Error("Character is outside the line");
  const result = offset + position.character;
  if (
    result > offset &&
    /[\uD800-\uDBFF]/.test(text[result - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[result] ?? "")
  )
    throw new Error("Position splits a surrogate pair");
  return result;
}

function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

function rangeAt(text, offset, length) {
  return {
    start: positionAt(text, offset),
    end: positionAt(text, offset + length),
  };
}

function symbolAt(text, position) {
  const offset = offsetAt(text, position);
  for (const match of text.matchAll(identifier)) {
    if (match.index <= offset && offset <= match.index + match[0].length)
      return match[0];
  }
  throw new Error("No identifier at the requested position");
}

function occurrences(text, word) {
  const result = [];
  if (!word) return result;
  for (
    let offset = text.indexOf(word);
    offset !== -1;
    offset = text.indexOf(word, offset + word.length)
  ) {
    const before = Array.from(text.slice(0, offset)).at(-1);
    const after = Array.from(text.slice(offset + word.length))[0];
    if (
      (!before || !identifierChar.test(before)) &&
      (!after || !identifierChar.test(after))
    )
      result.push({ range: rangeAt(text, offset, word.length), offset });
  }
  return result;
}

export function contentLengthFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

function streamWrite(stream, bytes) {
  return new Promise((resolveWrite, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolveWrite())),
  );
}

async function waitFor(ms, signal, gate) {
  if (signal?.aborted) throw cancelledError();
  try {
    if (gate)
      while (!existsSync(pathOf(gate))) await sleep(10, undefined, { signal });
    if (ms > 0) await sleep(ms, undefined, { signal });
  } catch (error) {
    if (error.name === "AbortError") throw cancelledError();
    throw error;
  }
}

/** No native addon/client is loaded by this server. All I/O is ordinary traced child I/O. */
export async function runStdioServer(argv = [], provided = {}) {
  const options = fixtureOptions(argv, provided);
  const modes = modesOf(options);
  const has = (...names) => names.some((name) => modes.has(name));
  const documents = new Map();
  const pending = new Map();
  const active = new Map();
  const descendants = new Map();
  const notifications = [];
  const requests = [];
  const clientResponses = [];
  const cachedReads = new Map();
  const timers = new Set();
  let nextId = 100000;
  let counter = 0;
  let input = Buffer.alloc(0);
  let output = Promise.resolve();
  let faultSent = false;
  let applySent = false;
  let stopping = false;
  let initialized = false;
  let initializeParams;
  let settings = {};
  let clientSetup = Promise.resolve();

  function fatal(error) {
    if (stopping) return;
    stopping = true;
    // stderr is intentionally private server output; the native client must gate it.
    process.stderr.write(`fixture transport failure: ${error.message}\n`);
    for (const controller of active.values()) controller.abort();
    for (const child of descendants.values()) child.kill("SIGKILL");
    process.exitCode = 1;
    process.stdin.destroy();
  }

  function queueBytes(bytes) {
    output = output.then(async () => {
      const chunk = options.chunkBytes ?? (has("chunked") ? 7 : bytes.length);
      if (!Number.isInteger(chunk) || chunk <= 0)
        throw new Error("chunkBytes must be positive");
      for (let start = 0; start < bytes.length; start += chunk) {
        await streamWrite(process.stdout, bytes.subarray(start, start + chunk));
        if (chunk < bytes.length)
          await new Promise((resolveTurn) => setImmediate(resolveTurn));
      }
    });
    output.catch(fatal);
    return output;
  }

  function send(message) {
    return queueBytes(contentLengthFrame(message));
  }
  function notify(method, params) {
    return send({ jsonrpc: "2.0", method, params });
  }
  function ask(method, params) {
    const id = nextId++;
    return new Promise((resolveResponse, reject) => {
      pending.set(id, { resolve: resolveResponse, reject });
      send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        pending.delete(id);
        reject(error);
      });
    });
  }

  function recordEvent(method, phase) {
    if (!options.events) return;
    const path = pathOf(options.events);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ method, pid: process.pid, counter, phase })}\n`,
    );
  }

  async function response(id, result, error, method) {
    recordEvent(method, "response");
    const trigger = options.transportMethod ?? "textDocument/hover";
    if (!faultSent && method === trigger) {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
      if (has("duplicate-length", "duplicatelength")) {
        faultSent = true;
        return queueBytes(
          Buffer.concat([
            Buffer.from(
              `Content-Length: ${body.length}\r\nContent-Length: ${body.length}\r\n\r\n`,
            ),
            body,
          ]),
        );
      }
      if (has("invalid-length", "negative-length", "nonnumeric-length")) {
        faultSent = true;
        return queueBytes(
          Buffer.from(
            `Content-Length: ${has("negative-length") ? "-1" : "not-a-number"}\r\n\r\n`,
          ),
        );
      }
      if (has("length-overflow", "overflow")) {
        faultSent = true;
        return queueBytes(
          Buffer.from("Content-Length: 184467440737095516160\r\n\r\n"),
        );
      }
      if (has("oversized-body")) {
        faultSent = true;
        return queueBytes(
          Buffer.from(`Content-Length: ${MAX_BODY + 1}\r\n\r\n`),
        );
      }
      if (has("header-overflow")) {
        faultSent = true;
        return queueBytes(
          Buffer.from(
            `X-Fixture: ${"x".repeat(MAX_HEADER)}\r\nContent-Length: 0\r\n\r\n`,
          ),
        );
      }
      if (has("partial-frame")) {
        faultSent = true;
        await queueBytes(
          Buffer.concat([
            Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
            body.subarray(0, Math.max(1, body.length >> 1)),
          ]),
        );
        process.exit(1);
      }
      if (has("stream-failure")) process.exit(1);
      if (has("malformed-json")) {
        faultSent = true;
        await queueBytes(Buffer.from("Content-Length: 1\r\n\r\n{"));
      }
    }
    return send(
      error
        ? { jsonrpc: "2.0", id, error }
        : { jsonrpc: "2.0", id, result: result ?? null },
    );
  }

  function currentDocument(uri) {
    const disk = readFileSync(pathOf(uri), "utf8");
    return {
      uri,
      disk,
      text: documents.get(uri)?.text ?? disk,
      version: documents.get(uri)?.version ?? null,
    };
  }

  function locations(uri, position) {
    const document = currentDocument(uri);
    const word = symbolAt(document.text, position);
    return workspaceFiles(options).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return occurrences(text, word).map(({ range }) => ({
        uri: uriOf(file),
        range,
      }));
    });
  }

  function diagnostics(uri) {
    const document = currentDocument(uri);
    if (has("empty")) return [];
    if (Array.isArray(options.diagnostics))
      return expand(options.diagnostics, uri);
    const result = [];
    for (const [line, text] of document.disk.split(/\r?\n/).entries()) {
      const match = /\b(ERROR|WARN(?:ING)?|TODO)\b/i.exec(text);
      if (!match) continue;
      result.push({
        range: {
          start: { line, character: match.index },
          end: { line, character: match.index + match[0].length },
        },
        severity: /^ERROR$/i.test(match[0])
          ? 1
          : /^WARN/i.test(match[0])
            ? 2
            : 3,
        source: options.name ?? "fixture",
        code: "fixture-diagnostic",
        message: `Fixture diagnostic: ${text.trim()}`,
      });
    }
    return result;
  }

  function publish(uri, empty = false) {
    if (has("no-push")) return Promise.resolve();
    const version = documents.get(uri)?.version;
    const params = { uri, diagnostics: empty ? [] : diagnostics(uri) };
    if (!has("unversioned") && version !== undefined)
      params.version = has("stale-version") ? version - 1 : version;
    return notify("textDocument/publishDiagnostics", params);
  }

  function publishSoon(uri) {
    const delay = options.diagnosticDelayMs ?? (has("initial-empty") ? 50 : 0);
    if (has("initial-empty")) publish(uri, true).catch(fatal);
    if (!delay) {
      publish(uri).catch(fatal);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (documents.has(uri)) publish(uri).catch(fatal);
    }, delay);
    timers.add(timer);
  }

  function editForRename(uri, position, newName) {
    if (options.renameEdit) return expand(options.renameEdit, uri);
    if (has("empty")) return null;
    const document = currentDocument(uri);
    const word = symbolAt(document.text, position);
    const changes = {};
    for (const file of workspaceFiles(options)) {
      const text = readFileSync(file, "utf8");
      const edits = occurrences(text, word).map(({ range }) => ({
        range,
        newText: newName,
      }));
      if (edits.length) changes[uriOf(file)] = edits;
    }
    if (options.versionedEdits)
      return {
        documentChanges: Object.entries(changes).map(([target, edits]) => ({
          textDocument: {
            uri: target,
            version:
              documents.get(target)?.version ?? options.unknownVersion ?? 1,
          },
          edits,
        })),
      };
    return { changes };
  }

  function symbols(uri, flat = false) {
    if (has("empty")) return [];
    const { text } = currentDocument(uri);
    const result = [];
    const declarations =
      /\b(function|fn|def|class|struct|enum|let|const|var|int|void|double|float)\s+([$\p{ID_Start}][$\p{ID_Continue}]*)/gu;
    for (const match of text.matchAll(declarations)) {
      const offset = match.index + match[0].lastIndexOf(match[2]);
      const range = rangeAt(text, offset, match[2].length);
      const kind = /class|struct/.test(match[1])
        ? 5
        : /function|fn|def|int|void|double|float/.test(match[1])
          ? 12
          : 13;
      result.push(
        flat
          ? {
              name: match[2],
              kind,
              location: { uri, range },
              containerName: basename(pathOf(uri)),
            }
          : {
              name: match[2],
              kind,
              range,
              selectionRange: range,
              children: [],
            },
      );
    }
    if (!result.length) {
      const match = text.match(identifier);
      if (match) {
        const range = rangeAt(text, text.indexOf(match[0]), match[0].length);
        result.push(
          flat
            ? { name: match[0], kind: 13, location: { uri, range } }
            : {
                name: match[0],
                kind: 13,
                range,
                selectionRange: range,
                children: [],
              },
        );
      }
    }
    return result;
  }

  function defaultApplyEdit(uri) {
    const edit = {
      textDocument: { uri, version: null },
      edits: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "// applied by fixture\n",
        },
      ],
    };
    return has("apply-edit-prefix-failure", "failure-prefix")
      ? {
          documentChanges: [
            edit,
            {
              kind: "delete",
              uri: uriOf(".fixture-missing"),
              options: { ignoreIfNotExists: false },
            },
          ],
        }
      : { documentChanges: [edit] };
  }

  async function applyEdit(uri, edit) {
    const result = await ask("workspace/applyEdit", {
      label: "Fixture server edit",
      edit: expand(edit ?? options.applyEdit ?? defaultApplyEdit(uri), uri),
    });
    clientResponses.push({ method: "workspace/applyEdit", result });
    return result;
  }

  function mutate(params = {}, restore = false, fallbackUri) {
    const file = pathOf(
      params.path ??
        params.uri ??
        options.writePath ??
        fallbackUri ??
        "written.fixture",
    );
    const old = existsSync(file) ? readFileSync(file) : null;
    const text =
      params.text ??
      options.writeText ??
      `${old?.toString("utf8") ?? ""}// fixture write\n`;
    writeFile(file, text);
    if (restore) {
      if (old === null)
        throw new Error("writeRestore requires an existing file");
      writeFileSync(file, old);
    }
    return { path: file, bytes: Buffer.byteLength(text), restored: restore };
  }

  async function startDescendant(config = {}) {
    const child = spawn(
      process.execPath,
      [ownPath, "descendant", `--options=${JSON.stringify(config)}`],
      { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    descendants.set(child.pid, child);
    child.stderr.on("data", (bytes) => process.stderr.write(bytes));
    let buffer = "";
    await new Promise((ready, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(new Error(`Descendant exited before ready: ${code ?? signal}`)),
      );
      child.stdout.on("data", (bytes) => {
        buffer += bytes.toString("utf8");
        const end = buffer.indexOf("\n");
        if (end !== -1) {
          try {
            const message = JSON.parse(buffer.slice(0, end));
            if (message.ready) ready();
          } catch (error) {
            reject(error);
          }
          buffer = buffer.slice(end + 1);
        }
      });
    });
    child.on("exit", () => descendants.delete(child.pid));
    return { pid: child.pid, parentPid: process.pid };
  }

  async function serverRequests() {
    const calls = [
      [
        "workspace/configuration",
        {
          items: (
            options.configurationSections ?? [
              options.configurationSection ?? "fixture",
              "fixture.nested",
              null,
            ]
          ).map((section) => (section === null ? {} : { section })),
        },
      ],
      ["workspace/workspaceFolders", {}],
      ["window/workDoneProgress/create", { token: "fixture-index" }],
      [
        "client/registerCapability",
        {
          registrations: [
            {
              id: "fixture-diagnostics",
              method: has("dynamic-diagnostics")
                ? "textDocument/diagnostic"
                : "workspace/didChangeWatchedFiles",
              registerOptions: has("dynamic-diagnostics")
                ? {
                    documentSelector: null,
                    identifier: "fixture",
                    interFileDependencies: true,
                    workspaceDiagnostics: false,
                  }
                : { watchers: [{ globPattern: "**/*.fixture" }] },
            },
          ],
        },
      ],
    ];
    if (options.requestClientMethods)
      calls.push(...options.requestClientMethods.map((method) => [method, {}]));
    if (options.requestClientRequests)
      calls.push(
        ...options.requestClientRequests.map(({ method, params }) => [
          method,
          expand(params),
        ]),
      );
    await Promise.all(
      calls.map(async ([method, params]) => {
        try {
          clientResponses.push({ method, result: await ask(method, params) });
        } catch (error) {
          clientResponses.push({
            method,
            error: { code: error.code, message: error.message },
          });
        }
      }),
    );
    await notify("$/progress", {
      token: "fixture-index",
      value: { kind: "begin", title: "Fixture indexing" },
    });
    if (options.progressDelayMs) await waitFor(options.progressDelayMs);
    await notify("$/progress", {
      token: "fixture-index",
      value: { kind: "end", message: "Fixture ready" },
    });
    await notify("experimental/serverStatus", {
      health: "ok",
      quiescent: true,
      message: null,
    });
  }

  async function dispatch(method, params = {}, signal) {
    const uri = params?.textDocument?.uri ?? params?.uri;
    if (own(options.errors ?? {}, method)) {
      const configured = options.errors[method];
      throw Object.assign(
        new Error(
          typeof configured === "string"
            ? configured
            : (configured.message ?? "Configured fixture failure"),
        ),
        { code: configured.code ?? -32001, data: expand(configured.data, uri) },
      );
    }
    if (own(options.responses ?? {}, method))
      return expand(options.responses[method], uri);
    if (method === "initialize")
      await waitFor(
        options.delays?.[method] ?? options.initializeDelayMs ?? 0,
        signal,
        options.gates?.[method],
      );
    if (method === "initialize") {
      initializeParams = params;
      if (has("init-fail"))
        throw Object.assign(
          new Error(options.errorMessage ?? "Fixture initialization failed"),
          { code: -32002 },
        );
      if (has("descendant")) await startDescendant(options.descendant ?? {});
      if (options.startupRead) readFileSync(pathOf(options.startupRead));
      if (options.startupWrite)
        writeFile(
          options.startupWrite,
          options.startupText ?? "fixture startup write\n",
        );
      const capabilities = {
        positionEncoding: options.positionEncoding ?? "utf-16",
        textDocumentSync: {
          openClose: true,
          change: 1,
          save: { includeText: true },
        },
        definitionProvider: true,
        typeDefinitionProvider: true,
        implementationProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: {
          resolveProvider: true,
          codeActionKinds: ["quickfix", "refactor", "refactor.rename"],
        },
        executeCommandProvider: {
          commands: [
            "fixture.write",
            "fixture.writeRestore",
            "fixture.read",
            "fixture.applyEdit",
            "fixture.fail",
          ],
        },
        workspace: {
          workspaceFolders: { supported: true, changeNotifications: true },
          fileOperations: {
            willRename: {
              filters: [{ scheme: "file", pattern: { glob: "**/*" } }],
            },
            didRename: {
              filters: [{ scheme: "file", pattern: { glob: "**/*" } }],
            },
          },
        },
      };
      if (!has("no-pull", "dynamic-diagnostics"))
        capabilities.diagnosticProvider = {
          identifier: "fixture",
          interFileDependencies: true,
          workspaceDiagnostics: false,
        };
      return {
        capabilities: { ...capabilities, ...options.capabilities },
        serverInfo: { name: options.name ?? "junco-lsp-fixture", version: "1" },
      };
    }
    if (method === "shutdown") return null;
    const query =
      method.startsWith("textDocument/") ||
      method.startsWith("workspace/") ||
      method === "codeAction/resolve";
    const partial =
      has("partial-fail") &&
      uri &&
      (options.failFiles ?? ["fail.fixture"]).some(
        (file) =>
          basename(pathOf(uri)) === file || pathOf(uri) === pathOf(file),
      );
    if (query && (has("all-fail", "fail") || partial))
      throw Object.assign(
        new Error(options.errorMessage ?? `Fixture failure for ${method}`),
        { code: -32001 },
      );
    if (has("cancel") && query)
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(cancelledError()), {
          once: true,
        }),
      );
    await waitFor(
      options.delays?.[method] ??
        (has("delayed", "delay") ? (options.delayMs ?? 1000) : 0),
      signal,
      options.gates?.[method] ?? options.gate,
    );
    if (signal.aborted) throw cancelledError();
    if (
      !applySent &&
      (options.applyEdit ||
        has(
          "apply-edit",
          "readonly-apply-edit",
          "readonlyapplyedit",
          "read-only-apply-edit",
          "apply-edit-prefix-failure",
          "failure-prefix",
        )) &&
      (options.applyEditMethod ?? "textDocument/hover") === method
    ) {
      applySent = true;
      await applyEdit(uri ?? uriOf(options.file ?? "a.fixture"));
    }

    switch (method) {
      case "textDocument/hover": {
        if (has("empty")) return null;
        const cached = has("cached-response", "cached");
        let disk = cachedReads.get(uri);
        if (!cached || disk === undefined) {
          disk = readFileSync(pathOf(uri), "utf8");
          if (cached) cachedReads.set(uri, disk);
        }
        if (has("write-restore", "write_restore")) mutate({}, true, uri);
        if (has("raw-writes", "raw-write")) mutate({}, false, uri);
        const document = documents.get(uri);
        const body = `pid=${process.pid} counter=${counter} cwd=${process.cwd()}\ncontent=${disk}\noverlay=${document?.text ?? disk}\ndescendants=${[...descendants.keys()].join(",")}`;
        if (options.hoverForm === "string") return { contents: body };
        if (options.hoverForm === "marked")
          return { contents: { language: "fixture", value: body } };
        if (options.hoverForm === "array")
          return {
            contents: ["Fixture hover", { language: "fixture", value: body }],
          };
        return {
          contents: {
            kind: "markdown",
            value: `### Fixture hover\n\n\`\`\`text\n${body}\n\`\`\``,
          },
        };
      }
      case "textDocument/definition":
      case "textDocument/typeDefinition":
      case "textDocument/implementation": {
        if (has("empty")) return null;
        const found = locations(uri, params.position);
        if (!found.length) return options.locationForm === "array" ? [] : null;
        if (options.locationForm === "link" || has("location-link"))
          return [
            {
              targetUri: found[0].uri,
              targetRange: found[0].range,
              targetSelectionRange: found[0].range,
              originSelectionRange: rangeAt(
                currentDocument(uri).text,
                offsetAt(currentDocument(uri).text, params.position),
                0,
              ),
            },
          ];
        if (options.locationForm === "array" || has("location-array"))
          return found;
        return found[0];
      }
      case "textDocument/references": {
        if (has("empty")) return [];
        const found = locations(uri, params.position);
        if (
          options.declarationOnlyCount &&
          requests.filter((request) => request.method === method).length <=
            options.declarationOnlyCount
        )
          return found.slice(0, 1);
        return params.context?.includeDeclaration === false
          ? found.slice(1)
          : found;
      }
      case "textDocument/prepareRename": {
        const document = currentDocument(uri);
        const word = symbolAt(document.text, params.position);
        return {
          range: occurrences(document.text, word).find(
            ({ offset }) =>
              offset <= offsetAt(document.text, params.position) &&
              offsetAt(document.text, params.position) <= offset + word.length,
          )?.range,
          placeholder: word,
        };
      }
      case "textDocument/rename":
        return editForRename(uri, params.position, params.newName);
      case "textDocument/documentSymbol":
        return symbols(
          uri,
          options.symbolForm === "flat" || has("flat-symbols"),
        );
      case "workspace/symbol": {
        if (has("empty")) return [];
        const query = String(params.query ?? "").toLowerCase();
        return workspaceFiles(options)
          .flatMap((file) => symbols(uriOf(file), true))
          .filter((symbol) => symbol.name.toLowerCase().includes(query));
      }
      case "textDocument/diagnostic":
        if (has("pull-fail"))
          throw Object.assign(new Error("Fixture pull diagnostics failed"), {
            code: -32001,
          });
        return {
          kind: "full",
          resultId: `fixture-${counter}`,
          items: diagnostics(uri),
        };
      case "workspace/diagnostic":
        return {
          items: workspaceFiles(options).map((file) => ({
            uri: uriOf(file),
            version: documents.get(uriOf(file))?.version ?? null,
            kind: "full",
            items: diagnostics(uriOf(file)),
          })),
        };
      case "textDocument/codeAction": {
        if (has("empty")) return [];
        if (options.codeActions) return expand(options.codeActions, uri);
        const document = currentDocument(uri);
        const position = params.range?.start ?? { line: 0, character: 0 };
        let word;
        try {
          word = symbolAt(document.text, position);
        } catch {
          word = document.text.match(identifier)?.[0];
        }
        const data = {
          uri,
          position,
          word,
          newName: options.codeActionNewName ?? `${word ?? "value"}_fixed`,
        };
        const command = {
          title: "Fixture command",
          command: "fixture.write",
          arguments: [
            {
              path: options.commandPath ?? "command.fixture",
              text: options.commandText ?? "fixture command executed\n",
            },
          ],
        };
        const actions = [
          {
            title: "Fixture quick fix",
            kind: "quickfix",
            diagnostics: diagnostics(uri),
            data,
          },
          {
            title: "Fixture edit and command",
            kind: "refactor.rename",
            edit: word
              ? editForRename(uri, position, data.newName)
              : { changes: {} },
            command,
          },
          {
            title: "Fixture direct command",
            command: command.command,
            arguments: command.arguments,
          },
        ];
        return params.context?.only?.length
          ? actions.filter(
              (action) =>
                action.kind &&
                params.context.only.some(
                  (kind) =>
                    action.kind === kind || action.kind.startsWith(`${kind}.`),
                ),
            )
          : actions;
      }
      case "codeAction/resolve": {
        const data = params.data;
        const command =
          options.resolveCommand === false
            ? undefined
            : expand(
                options.resolveCommand ?? {
                  title: "Fixture resolved command",
                  command: "fixture.write",
                  arguments: [
                    {
                      path: options.commandPath ?? "command.fixture",
                      text:
                        options.commandText ??
                        "fixture resolved command executed\n",
                    },
                  ],
                },
                data?.uri,
              );
        return data
          ? {
              ...params,
              edit: editForRename(data.uri, data.position, data.newName),
              command,
            }
          : params;
      }
      case "workspace/executeCommand": {
        const args = params.arguments ?? [];
        const argument =
          typeof args[0] === "object" && args[0] !== null
            ? args[0]
            : { path: args[0], text: args[1] };
        if (params.command === "fixture.write") {
          const result = mutate(argument, false);
          if (has("command-fail"))
            throw new Error("Fixture command failed after writing");
          return result;
        }
        if (params.command === "fixture.writeRestore")
          return mutate(argument, true);
        if (params.command === "fixture.read")
          return readFileSync(
            pathOf(argument.path ?? options.readPath ?? "a.fixture"),
            "utf8",
          );
        if (params.command === "fixture.applyEdit")
          return applyEdit(
            argument.uri ?? uriOf(options.file ?? "a.fixture"),
            argument.edit,
          );
        if (params.command === "fixture.fail") {
          if (argument.path) mutate(argument);
          throw new Error("Fixture command failure");
        }
        throw methodNotFound(params.command);
      }
      case "workspace/willRenameFiles": {
        if (has("will-rename-unsupported")) throw methodNotFound(method);
        if (has("will-rename-fail"))
          throw new Error("Fixture willRenameFiles failed");
        if (has("empty")) return null;
        if (options.willRenameEdit)
          return expand(options.willRenameEdit, params.files?.[0]?.oldUri);
        const changes = {};
        for (const file of workspaceFiles(options)) {
          const text = readFileSync(file, "utf8");
          const edits = [];
          for (const rename of params.files ?? []) {
            const oldName = basename(pathOf(rename.oldUri));
            const newName = basename(pathOf(rename.newUri));
            for (
              let offset = text.indexOf(oldName);
              offset !== -1;
              offset = text.indexOf(oldName, offset + oldName.length)
            )
              edits.push({
                range: rangeAt(text, offset, oldName.length),
                newText: newName,
              });
          }
          if (edits.length) changes[uriOf(file)] = edits;
        }
        return { changes };
      }
      case "rust-analyzer/reloadWorkspace":
      case "workspace/reload":
        return null;
      case "rust-analyzer/analyzerStatus":
        return "Fixture ready";
      case "rust-analyzer/serverStatus":
      case "experimental/serverStatus":
        return { health: "ok", quiescent: true };
      case "fixture/state": {
        await clientSetup;
        return {
          pid: process.pid,
          counter,
          cwd: process.cwd(),
          initialized,
          settings,
          initializeParams,
          configuration:
            clientResponses.findLast(
              (response) => response.method === "workspace/configuration",
            )?.result ?? null,
          childPids: [...descendants.keys()],
          requests,
          notifications,
          clientResponses,
          documents: [...documents.entries()].map(([uri, document]) => ({
            uri,
            ...document,
          })),
        };
      }
      case "fixture/echo":
        return params;
      case "fixture/null":
        return null;
      case "fixture/error": {
        const message = params?.readPath
          ? readFileSync(pathOf(params.readPath), "utf8")
          : (params?.message ?? "Fixture requested error");
        if (params?.writeBefore) mutate(params.writeBefore);
        throw Object.assign(new Error(message), {
          code: params?.code ?? -32001,
          data: params?.data,
        });
      }
      case "fixture/read":
        return readFileSync(
          pathOf(params.path ?? params.uri ?? options.readPath ?? "a.fixture"),
          "utf8",
        );
      case "fixture/write":
        return mutate(params);
      case "fixture/writeRestore":
        return mutate(params, true);
      case "fixture/applyEdit":
        return applyEdit(
          params.uri ?? uriOf(options.file ?? "a.fixture"),
          params.edit,
        );
      case "fixture/descendant":
        return startDescendant(params);
      case "fixture/delay":
        await waitFor(
          params.ms ?? options.delayMs ?? 60000,
          signal,
          params.gate,
        );
        return { pid: process.pid, counter };
      default:
        throw methodNotFound(method);
    }
  }

  async function notification(method, params = {}) {
    notifications.push({ method, params });
    switch (method) {
      case "initialized":
        initialized = true;
        clientSetup = serverRequests();
        clientSetup.catch(fatal);
        if (has("stderr-flood"))
          process.stderr.write(
            "fixture stderr\n".repeat(options.stderrLines ?? 16384),
          );
        break;
      case "textDocument/didOpen": {
        const document = params.textDocument;
        documents.set(document.uri, {
          languageId: document.languageId,
          version: document.version,
          text: document.text,
        });
        publishSoon(document.uri);
        break;
      }
      case "textDocument/didChange": {
        const document = documents.get(params.textDocument.uri);
        if (!document)
          throw new Error("didChange for a document that is not open");
        for (const change of params.contentChanges ?? []) {
          if (change.range) {
            const start = offsetAt(document.text, change.range.start);
            const end = offsetAt(document.text, change.range.end);
            document.text =
              document.text.slice(0, start) +
              change.text +
              document.text.slice(end);
          } else document.text = change.text;
        }
        document.version = params.textDocument.version;
        publishSoon(params.textDocument.uri);
        break;
      }
      case "textDocument/didClose":
        documents.delete(params.textDocument.uri);
        break;
      case "textDocument/didSave":
        if (params.text !== undefined) {
          const document = documents.get(params.textDocument.uri);
          if (document) document.savedText = params.text;
        }
        break;
      case "workspace/didChangeConfiguration":
        settings = params.settings ?? {};
        break;
      case "workspace/didRenameFiles":
        for (const file of params.files ?? []) {
          const document = documents.get(file.oldUri);
          if (document) {
            documents.delete(file.oldUri);
            documents.set(file.newUri, document);
          }
        }
        break;
      case "$/cancelRequest":
        active.get(params.id)?.abort();
        break;
      case "exit":
        stopping = true;
        for (const child of descendants.values()) child.kill("SIGKILL");
        for (const timer of timers) clearTimeout(timer);
        process.stdin.destroy();
        break;
      default:
        break;
    }
  }

  function receive(message) {
    if (typeof message?.method !== "string") {
      const request = pending.get(message?.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error)
        request.reject(
          Object.assign(new Error(message.error.message), message.error),
        );
      else request.resolve(message.result);
      return;
    }
    if (!own(message, "id")) {
      notification(message.method, message.params).catch(fatal);
      return;
    }
    const controller = new AbortController();
    active.set(message.id, controller);
    counter += 1;
    requests.push({
      id: message.id,
      method: message.method,
      params: message.params,
    });
    recordEvent(message.method, "dispatch");
    dispatch(message.method, message.params, controller.signal)
      .then(
        (result) => response(message.id, result, undefined, message.method),
        (error) =>
          response(
            message.id,
            undefined,
            {
              code: Number.isInteger(error.code) ? error.code : -32603,
              message: error.message,
              ...(error.data !== undefined ? { data: error.data } : {}),
            },
            message.method,
          ),
      )
      .catch(fatal)
      .finally(() => active.delete(message.id));
  }

  if (has("transport-junk", "junk"))
    await queueBytes(Buffer.from("fixture startup banner: not an LSP frame\n"));
  process.stdin.on("data", (chunk) => {
    input = input.length ? Buffer.concat([input, chunk]) : chunk;
    try {
      while (input.length) {
        const end = input.indexOf("\r\n\r\n");
        if (end === -1) {
          if (input.length > MAX_HEADER)
            throw new Error("Client header exceeds limit");
          break;
        }
        if (end > MAX_HEADER) throw new Error("Client header exceeds limit");
        const headers = input.subarray(0, end).toString("ascii").split("\r\n");
        const lengths = headers.filter((header) =>
          /^Content-Length\s*:/i.test(header),
        );
        if (
          lengths.length !== 1 ||
          !/^Content-Length\s*:\s*\d+\s*$/i.test(lengths[0])
        )
          throw new Error("Invalid client Content-Length");
        const length = Number(
          lengths[0].slice(lengths[0].indexOf(":") + 1).trim(),
        );
        if (!Number.isSafeInteger(length) || length > MAX_BODY)
          throw new Error("Client body exceeds limit");
        const start = end + 4;
        if (input.length < start + length) break;
        const body = input.subarray(start, start + length).toString("utf8");
        input = input.subarray(start + length);
        receive(JSON.parse(body));
      }
    } catch (error) {
      fatal(error);
    }
  });
  process.stdin.on("error", fatal);
  process.stdout.on("error", fatal);
  await new Promise((resolveEnd) => {
    process.stdin.once("end", resolveEnd);
    process.stdin.once("close", resolveEnd);
  });
  for (const controller of active.values()) controller.abort();
  for (const request of pending.values())
    request.reject(new Error("Client closed the stream"));
  pending.clear();
  for (const timer of timers) clearTimeout(timer);
  for (const child of descendants.values()) child.kill("SIGKILL");
  await output;
  if (input.length && !stopping)
    throw new Error("Client closed an incomplete frame");
}

/** A child used to prove cancellation/retirement drains descendants, not just the server. */
export async function runDescendant(argv = [], provided = {}) {
  const options = fixtureOptions(argv, provided);
  if (options.readPath) readFileSync(pathOf(options.readPath));
  if (options.writePath && !options.writeIntervalMs)
    writeFile(options.writePath, options.writeText ?? "descendant write\n");
  const timer = options.writeIntervalMs
    ? setInterval(
        () =>
          writeFile(
            options.writePath ?? "descendant.fixture",
            `${options.writeText ?? "descendant"} ${Date.now()}\n`,
          ),
        options.writeIntervalMs,
      )
    : setInterval(() => {}, 60000);
  await streamWrite(
    process.stdout,
    Buffer.from(
      `${JSON.stringify({ ready: true, pid: process.pid, parentPid: process.ppid, cwd: process.cwd() })}\n`,
    ),
  );
  process.stdin.resume();
  await new Promise((done) => {
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
  clearInterval(timer);
}

/** Real checker/linter process. tracePath may be outside the seed for harness observations. */
export async function runChecker(kind = "cargo", argv = [], provided = {}) {
  const base = fixtureOptions(argv, provided);
  const options = { ...base, ...base.checkers?.[kind] };
  const modes = modesOf(options);
  const has = (...names) => names.some((name) => modes.has(name));
  const invocation = { pid: process.pid, kind, cwd: process.cwd(), argv };
  function trace(event) {
    if (!options.tracePath) return;
    const path = pathOf(options.tracePath);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ ...invocation, event, time: Date.now() })}\n`,
    );
  }
  trace("start");
  try {
    if (kind === "go" && argv.includes("work") && argv.includes("-json")) {
      const work = readFileSync(resolve("go.work"), "utf8");
      if (has("go-discovery-fail")) {
        process.exitCode = 1;
        return;
      }
      const use =
        options.goUse ??
        [
          ...work.matchAll(/(?:^\s*use\s+|^\s+)(\.\.?\/[^\s)]+|\.)(?=\s|$)/gm),
        ].map((match) => match[1]);
      await streamWrite(
        process.stdout,
        Buffer.from(
          `${JSON.stringify({ Go: "1.24", Use: use.map((DiskPath) => ({ DiskPath })) })}\n`,
        ),
      );
      return;
    }
    const files = options.readPaths
      ? options.readPaths.map(pathOf)
      : ["biome", "swiftlint"].includes(kind)
        ? argv
            .filter(
              (arg) =>
                !arg.startsWith("-") &&
                existsSync(resolve(arg)) &&
                statSync(resolve(arg)).isFile(),
            )
            .map(pathOf)
        : workspaceFiles(options);
    const contents = files.map((path) => ({
      path,
      text: readFileSync(path, "utf8"),
    }));
    // Root manifests are actual checker inputs too, including a clean/no-output run.
    for (const manifest of {
      cargo: ["Cargo.toml"],
      tsc: ["tsconfig.json"],
      go: ["go.mod", "go.work"],
      pyright: ["pyproject.toml", "pyrightconfig.json"],
    }[kind] ?? []) {
      if (existsSync(resolve(manifest))) readFileSync(resolve(manifest));
    }
    if (
      options.writePath ||
      options.writeRestore ||
      has("raw-writes", "write-restore")
    ) {
      const target = pathOf(
        options.writePath ?? contents[0]?.path ?? "checker.fixture",
      );
      const original = existsSync(target) ? readFileSync(target) : null;
      writeFile(target, options.writeText ?? "checker wrote workspace\n");
      if (options.writeRestore || has("write-restore")) {
        if (original === null)
          throw new Error("Checker writeRestore requires an existing file");
        writeFileSync(target, original);
      }
    }
    await waitFor(
      options.delayMs ?? (has("delayed") ? 1000 : 0),
      undefined,
      options.gate,
    );
    const diagnostics = has("empty")
      ? []
      : contents.flatMap(({ path, text }) =>
          text.split(/\r?\n/).flatMap((line, index) => {
            const marker = /\b(ERROR|WARN(?:ING)?)\b/i.exec(line);
            return marker
              ? [
                  {
                    path,
                    text,
                    line: index + 1,
                    character: marker.index + 1,
                    severity: /^ERROR$/i.test(marker[0]) ? "error" : "warning",
                    message: `Fixture ${kind}: ${line.trim()}`,
                  },
                ]
              : [];
          }),
        );
    const noOutput = options.noOutput || has("no-output", "nonzero-no-output");
    if (!noOutput) {
      let body;
      if (options.output !== undefined) body = String(options.output);
      else if (kind === "biome")
        body = JSON.stringify({
          summary: {
            errors: diagnostics.filter((item) => item.severity === "error")
              .length,
            warnings: diagnostics.filter((item) => item.severity === "warning")
              .length,
          },
          diagnostics: diagnostics.map((item) => ({
            category: "lint/fixture",
            severity: item.severity,
            message: item.message,
            location: {
              path: relative(process.cwd(), item.path),
              start: { line: item.line, column: item.character },
              end: { line: item.line, column: item.character + 1 },
            },
          })),
        });
      else if (kind === "swiftlint")
        body = JSON.stringify(
          diagnostics.map((item) => ({
            file: item.path,
            line: item.line,
            character: item.character,
            severity: item.severity === "error" ? "Error" : "Warning",
            reason: item.message,
            rule_id: "fixture",
            type: "Fixture Rule",
          })),
        );
      else
        body = diagnostics
          .map(
            (item) =>
              `${relative(process.cwd(), item.path)}:${item.line}:${item.character}: ${item.severity}: ${item.message}`,
          )
          .join("\n");
      if (body)
        await streamWrite(
          options.stderr ? process.stderr : process.stdout,
          Buffer.from(`${body}\n`),
        );
    }
    process.exitCode =
      options.exitCode ??
      (has("nonzero", "nonzero-no-output", "all-fail") ||
      diagnostics.some((item) => item.severity === "error")
        ? 1
        : 0);
  } finally {
    trace("end");
  }
}

// A runnable check for the shared framing/UTF-16 primitives; it never loads a native addon.
export function selfTest() {
  const source = "a😀b\r\nadd\n";
  assert.equal(offsetAt(source, { line: 0, character: 3 }), 3);
  assert.throws(() => offsetAt(source, { line: 0, character: 2 }), /surrogate/);
  assert.throws(() => offsetAt(source, { line: 0, character: 5 }), /outside/);
  assert.deepEqual(rangeAt(source, 6, 3), {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 3 },
  });
  assert.equal(symbolAt(source, { line: 1, character: 1 }), "add");
  assert.equal(occurrences("add added add;", "add").length, 2);
  const frame = contentLengthFrame({ jsonrpc: "2.0", id: 1, result: "😀" });
  const split = frame.indexOf("\r\n\r\n");
  assert.equal(
    Number(frame.subarray(0, split).toString().split(":")[1]),
    frame.length - split - 4,
  );
  assert.equal(
    expand({ "${uri}": "${file:a.fixture}" }, "file:///example")[
      "file:///example"
    ],
    uriOf("a.fixture"),
  );
}

/** Enumerate only descendants of this harness, including children spawned by native threads. */
export async function harnessDescendants(root = process.pid) {
  const { readdir, readFile } = await import("node:fs/promises");
  const seen = new Set([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    let tasks;
    try {
      tasks = await readdir(`/proc/${pid}/task`);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const tid of tasks) {
      let children;
      try {
        children = await readFile(`/proc/${pid}/task/${tid}/children`, "utf8");
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ESRCH") continue;
        throw error;
      }
      for (const child of children
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
  }
  return queue.slice(1);
}

/** Real clangd + real CopyTree addon; missing binaries/kernel support are fatal prerequisites. */
export async function smokeClangd() {
  const { access, constants, mkdir, readFile, rm } = await import(
    "node:fs/promises"
  );
  const { cleanup, nativeEnv, quote, seedFixture, testNative, text } =
    await import("./helpers.mjs");
  const { LspTool, isMarshPolicyDenied } = await import("../dist/index.js");
  const binary = process.env.LSP_SMOKE_SERVER;
  assert.ok(binary, "LSP_SMOKE_SERVER must name the real clangd executable");
  await access(binary, constants.X_OK);
  const original =
    "int add(int a, int b) { return a + b; }\nint main() { return add(1, 2); }\n";
  const { root, seed } = await seedFixture({
    files: {
      "main.cpp": original,
      ".omp/lsp.json": JSON.stringify({
        servers: {
          clangd: {
            command: binary,
            args: ["--background-index=false", "--clang-tidy=false"],
            fileTypes: ["cpp"],
            rootMarkers: ["."],
            languageId: "cpp",
            warmupTimeoutMs: 15000,
          },
        },
      }),
    },
  });
  const environment = {
    ...nativeEnv(join(root, "home")),
    TMPDIR: join(root, "tmp"),
  };
  const keys = [
    ...Object.keys(environment),
    "PI_CONFIG_DIR",
    "CLAUDE_CONFIG_DIR",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  let mux;
  const decisions = [];
  const observedPids = [];
  try {
    await mkdir(environment.HOME);
    await mkdir(environment.TMPDIR);
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    const native = await testNative();
    mux = await native.NativeMux.openCopyTree(
      seed,
      { sandbox: "always", policyDebug: true },
      (error, event) => {
        if (error) throw error;
        decisions.push(event);
      },
    );
    const owner = mux.forkOwner();
    const blocker = mux.forkOwner();
    const tool = await LspTool.create(seed, {
      native,
      mux: owner,
      trustedWorkspace: true,
    });
    const execute = tool.execute;
    const run = async (input) => {
      const result = await execute("clangd-smoke", input);
      assert.equal(result.details.success, true, text(result));
      assert.ok(!result.isError, text(result));
      assert.ok(!text(result).includes(".marsh/"), text(result));
      return result;
    };
    const clangdPid = async () => {
      const found = [];
      for (const pid of await harnessDescendants()) {
        let command;
        try {
          command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split(
            "\0",
          );
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ESRCH") continue;
          throw error;
        }
        if (basename(command[0] ?? "") === basename(binary)) found.push(pid);
      }
      assert.equal(
        found.length,
        1,
        `expected exactly this harness's clangd child: ${found}`,
      );
      observedPids.push(found[0]);
      return found[0];
    };
    const dead = (pid) => {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    };
    const query = { action: "hover", file: "main.cpp", line: 1, symbol: "add" };
    const first = await run(query);
    assert.match(text(first), /add/);
    const oldPid = await clangdPid();
    await run({
      action: "references",
      file: "main.cpp",
      line: 1,
      symbol: "add",
    });
    await run({ action: "status" });
    await run(query);
    assert.equal(
      await clangdPid(),
      oldPid,
      "non-mutating clangd calls retain the actual process",
    );
    await run({
      action: "rename",
      file: "main.cpp",
      line: 1,
      symbol: "add",
      new_name: "sum",
    });
    const renamed = await readFile(join(seed, "main.cpp"), "utf8");
    assert.equal(renamed, original.replaceAll("add", "sum"));
    dead(oldPid);
    await run({
      action: "definition",
      file: "main.cpp",
      line: 2,
      symbol: "sum",
    });
    const freshPid = await clangdPid();
    assert.notEqual(freshPid, oldPid);
    await owner.release(seed, "main.cpp");
    const locked = await blocker
      .start(
        {
          command: `cat main.cpp >/dev/null; printf ${quote(renamed)} > main.cpp`,
          cwd: seed,
          principal: "clangd-blocker",
          env: environment,
        },
        () => {},
      )
      .wait();
    assert.equal(locked.exitCode, 0);
    // The peer's equal-byte publication can retain a valid parked view; denial must retire it.
    await run({ action: "hover", file: "main.cpp", line: 1, symbol: "sum" });
    const deniedPid = await clangdPid();
    let denial;
    await assert.rejects(
      execute("clangd-denied", {
        action: "rename",
        file: "main.cpp",
        line: 1,
        symbol: "sum",
        new_name: "total",
      }),
      (error) => {
        denial = { name: error.name, code: error.code };
        assert.ok(isMarshPolicyDenied(error));
        assert.ok(Object.hasOwn(error, "code"));
        assert.equal(error.code, "MARSH_POLICY_DENIED");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(await readFile(join(seed, "main.cpp"), "utf8"), renamed);
    dead(deniedPid);
    await LspTool.shutdown();
    await mux.close();
    assert.ok(
      decisions.some(
        (event) =>
          event.granted &&
          event.action === "Read" &&
          event.principal === owner.owner,
      ),
    );
    assert.ok(
      decisions.some((event) => !event.granted && event.action === "Edit"),
    );
    process.stdout.write(
      `${JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", oldPid, freshPid, deniedPid, observedPids, actions: decisions.map(({ action, principal, granted, resource }) => ({ action, principal, granted, path: resource.join("/") })), source: renamed, denial }, null, 2)}\n`,
    );
  } finally {
    await cleanup(
      () => LspTool.shutdown(),
      () => mux?.close(),
      () => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      },
      () => rm(root, { recursive: true, force: true }),
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [mode = "stdio-server", ...rest] = argv;
  if (mode === "stdio-server") return runStdioServer(rest);
  if (mode === "descendant") return runDescendant(rest);
  if (mode === "self-test") return selfTest();
  if (mode === "smoke-clangd") return smokeClangd();
  if (mode === "biome" || mode === "swiftlint") return runChecker(mode, rest);
  if (mode === "checker") {
    const { options, positional } = parseArgs(rest);
    const kind =
      options.kind ??
      (["cargo", "tsc", "go", "pyright"].includes(positional[0])
        ? positional[0]
        : "cargo");
    return runChecker(kind, rest);
  }
  throw new Error(`Unknown LSP fixture mode: ${mode}`);
}

const executableKind = {
  cargo: "cargo",
  npx: "tsc",
  tsc: "tsc",
  go: "go",
  pyright: "pyright",
  biome: "biome",
  swiftlint: "swiftlint",
}[basename(process.argv[1] ?? "")];
if (
  process.argv[1] &&
  (resolve(process.argv[1]) === ownPath ||
    (executableKind && realpathSync(process.argv[1]) === ownPath))
) {
  const run = executableKind
    ? runChecker(executableKind, process.argv.slice(2))
    : main();
  run.catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
