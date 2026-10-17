/**
 * MCP stdio server fixture for native transport tests, run as
 * `process.execPath <this file> [args...]`. It uses only Node built-ins and erasable
 * TypeScript, so both Bun and Node can run it. Diagnostics go to stderr, never stdout.
 *
 * `JUNCO_MCP_FIXTURE_MODE` holds comma-separated flags:
 * - `split`: write every frame in three-byte pieces, splitting UTF-8 sequences.
 * - `coalesce`: write the frames produced in one turn as a single chunk.
 * - `crlf`: end frames with CRLF and precede each with blank lines.
 * - `list-failure`: `tools/list` fails with -32603 "fixture list failure".
 * - `exit-on-start`: exit with code 3 before reading any request.
 * - `ignore-eof`: keep running after stdin ends; the default SIGTERM action applies.
 * - `ignore-term`: keep running after stdin ends and ignore SIGTERM.
 * - `alias-dash`: also list tool `a-b`; `alias-underscore`: also list `a_b`; `alias-both`: list
 *   both. Each alias call returns its own original tool name as text.
 * - `hold-initialize` / `hold-list`: on `initialize` / `tools/list`, write the stderr line
 *   `hold-initialize-ready` / `hold-list-ready` and never reply to that request. The held
 *   request does not keep the server alive: stdin EOF still exits as usual.
 *
 * `JUNCO_MCP_FIXTURE_MARKER` is echoed by `read_state`. Unknown methods fail with -32601.
 */
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

const ROLE = process.env.JUNCO_MCP_FIXTURE_ROLE;
const SELF = fileURLToPath(import.meta.url);
const MODE = new Set(
  ((process.env.JUNCO_MCP_FIXTURE_MODE_FILE === undefined
    ? null
    : readOptional(process.env.JUNCO_MCP_FIXTURE_MODE_FILE)) ?? process.env.JUNCO_MCP_FIXTURE_MODE ?? "")
    .split(",")
    .map((flag) => flag.trim())
    .filter(Boolean),
);
/** Keep running after stdin ends. */
const PERSISTENT = MODE.has("ignore-eof") || MODE.has("ignore-term");
/** Exercises split UTF-8 frames: two-, three-, and four-byte sequences. */
const UNICODE_SAMPLE = "héllo wörld – ✓ 🌍";

const TOOLS = [
  {
    name: "read_state",
    description:
      "Process id, physical cwd, argv, environment marker, call count, held/cancelled requests, and optionally a file's contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        env: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "echo",
    description: `Return text unchanged (default: ${UNICODE_SAMPLE}).`,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "write_file",
    description:
      "Write a file directly, or staged through a sibling temporary file and a rename.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        staged: { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "descendant_write",
    description: "Write a file from a child process and await its exit.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "spawn_holder",
    description:
      "Start a descendant that inherits stdout and stderr and keeps running.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hold",
    description:
      "Reply only after `release` with the same key; report each progress message first. Cancellation drops the reply.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        progress: { type: "array", items: { type: "string" } },
      },
      required: ["key"],
    },
  },
  {
    name: "release",
    description: "Release a held reply, or pre-release a key not yet held.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "list_roots",
    description: "Ask the client for its roots.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "misbehave",
    description:
      "malformed | invalid-utf8 | oversized | incomplete | exit | reply-then-exit | stall-stdin",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        bytes: { type: "number" },
        code: { type: "number" },
      },
      required: ["kind"],
    },
  },
];

const ALIASES = [
  ...(MODE.has("alias-dash") || MODE.has("alias-both") ? ["a-b"] : []),
  ...(MODE.has("alias-underscore") || MODE.has("alias-both") ? ["a_b"] : []),
];

const LISTED_TOOLS = [
  ...TOOLS,
  ...ALIASES.map((name) => ({
    name,
    description: `Return the original tool name ${name}.`,
    inputSchema: { type: "object", properties: {} },
  })),
];

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringParam(params: JsonObject, name: string): string {
  const value = params[name];
  if (typeof value !== "string") throw new RpcError(-32602, `${name} required`);
  return value;
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function log(message: string): void {
  process.stderr.write(`junco-mcp fixture ${process.pid}: ${message}\n`);
}

function keepAlive(): void {
  setInterval(() => {}, 1 << 30);
}

// ---------------------------------------------------------------------------
// Output: one ordered queue of stdout writes.

let output: Promise<void> = Promise.resolve();
let coalesced: string[] = [];

function writeRaw(data: string | Uint8Array): Promise<void> {
  output = output.then(() => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    process.stdout.write(data, (error) => (error ? reject(error) : resolve()));
    return promise;
  });
  return output;
}

function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function send(message: JsonObject): Promise<void> {
  const frame = MODE.has("crlf")
    ? `\r\n\n${JSON.stringify(message)}\r\n`
    : `${JSON.stringify(message)}\n`;
  if (MODE.has("coalesce")) {
    coalesced.push(frame);
    if (coalesced.length === 1) {
      output = output.then(async () => {
        await nextTurn();
        const frames = coalesced.join("");
        coalesced = [];
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        process.stdout.write(frames, (error) =>
          error ? reject(error) : resolve(),
        );
        await promise;
      });
    }
    return output;
  }
  if (MODE.has("split")) {
    const bytes = Buffer.from(frame, "utf8");
    output = output.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 3) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        process.stdout.write(bytes.subarray(offset, offset + 3), (error) =>
          error ? reject(error) : resolve(),
        );
        await promise;
        await nextTurn();
      }
    });
    return output;
  }
  return writeRaw(frame);
}

function reply(id: RequestId, result: unknown): Promise<void> {
  return send({ jsonrpc: "2.0", id, result });
}

function fail(id: RequestId, code: number, message: string): Promise<void> {
  return send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text: string, structuredContent?: JsonObject): JsonObject {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

// ---------------------------------------------------------------------------
// Server state.

let calls = 0;
/** Requests being handled, excluding replies parked in `hold`. */
let active = 0;
let stdinEnded = false;
let nextServerRequest = 0;
const held = new Map<string, { id: RequestId; reply: () => void }>();
const released = new Set<string>();
const heldRequests = new Map<RequestId, string>();
const cancelled: RequestId[] = [];
const serverRequests = new Map<
  RequestId,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function request(method: string, params?: JsonObject): Promise<unknown> {
  const id = `fixture-${++nextServerRequest}`;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  serverRequests.set(id, { resolve, reject });
  void send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  return promise;
}

function exitAfterOutput(code: number): void {
  void output.finally(() => process.exit(code));
}

/** After EOF, exit once every unparked request has replied. Held replies are abandoned. */
function exitWhenIdle(): void {
  if (stdinEnded && active === 0 && !PERSISTENT) exitAfterOutput(0);
}

async function callTool(
  id: RequestId,
  name: string,
  params: JsonObject,
  progressToken: unknown,
): Promise<JsonObject | undefined> {
  switch (name) {
    case "read_state": {
      const path = params.path;
      const names = Array.isArray(params.env) ? params.env : [];
      const state = {
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        marker: process.env.JUNCO_MCP_FIXTURE_MARKER ?? null,
        env: Object.fromEntries(
          names.map((key) => [String(key), process.env[String(key)] ?? null]),
        ),
        calls,
        file: typeof path === "string" ? readOptional(path) : null,
        held: [...held.keys()],
        cancelled,
      };
      return textResult(JSON.stringify(state), state);
    }
    case "echo": {
      const text = params.text;
      return textResult(typeof text === "string" ? text : UNICODE_SAMPLE);
    }
    case "write_file": {
      const path = stringParam(params, "path");
      const content = stringParam(params, "content");
      if (params.staged === true) {
        const staging = `${path}.staging-${process.pid}`;
        writeFileSync(staging, content);
        renameSync(staging, path);
      } else {
        writeFileSync(path, content);
      }
      return textResult(`wrote ${path}`, { path });
    }
    case "descendant_write": {
      const path = stringParam(params, "path");
      const content = stringParam(params, "content");
      const child = spawn(process.execPath, [SELF], {
        env: {
          ...process.env,
          JUNCO_MCP_FIXTURE_ROLE: "writer",
          JUNCO_MCP_FIXTURE_PATH: path,
          JUNCO_MCP_FIXTURE_CONTENT: content,
        },
        stdio: ["ignore", "ignore", "inherit"],
      });
      const exited = Promise.withResolvers<number | null>();
      child.once("error", exited.reject);
      child.once("exit", (code) => exited.resolve(code));
      const exitCode = await exited.promise;
      return {
        ...textResult(`descendant ${child.pid} exited with ${exitCode}`, {
          pid: child.pid ?? null,
          exitCode,
        }),
        isError: exitCode !== 0,
      };
    }
    case "spawn_holder": {
      const child = spawn(process.execPath, [SELF], {
        env: { ...process.env, JUNCO_MCP_FIXTURE_ROLE: "holder" },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.unref();
      return textResult(`holder ${child.pid}`, { pid: child.pid ?? null });
    }
    case "hold": {
      const key = stringParam(params, "key");
      const messages = Array.isArray(params.progress) ? params.progress : [];
      if (progressToken !== undefined) {
        for (const [index, message] of messages.entries()) {
          await send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken,
              progress: index + 1,
              total: messages.length,
              message: String(message),
            },
          });
        }
      }
      if (released.delete(key)) return textResult(`released ${key}`);
      const done = Promise.withResolvers<void>();
      held.set(key, { id, reply: done.resolve });
      heldRequests.set(id, key);
      active -= 1;
      exitWhenIdle();
      await done.promise;
      active += 1;
      heldRequests.delete(id);
      // A cancelled request receives no reply.
      if (cancelled.includes(id)) return undefined;
      return textResult(`released ${key}`);
    }
    case "release": {
      const key = stringParam(params, "key");
      const entry = held.get(key);
      if (!entry) {
        released.add(key);
        return textResult(`pre-released ${key}`);
      }
      held.delete(key);
      entry.reply();
      return textResult(`released ${key}`);
    }
    case "list_roots":
      return textResult(JSON.stringify(await request("roots/list")));
    case "misbehave":
      return misbehave(id, stringParam(params, "kind"), params);
    default:
      if (ALIASES.includes(name)) return textResult(name);
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function misbehave(
  id: RequestId,
  kind: string,
  params: JsonObject,
): Promise<JsonObject | undefined> {
  const code = typeof params.code === "number" ? params.code : undefined;
  switch (kind) {
    case "malformed":
      await writeRaw('{"jsonrpc":"2.0", this is not json\n');
      return undefined;
    case "invalid-utf8":
      await writeRaw(Uint8Array.of(0xff, 0xfe, 0x0a));
      return undefined;
    case "oversized": {
      const bytes = typeof params.bytes === "number" ? params.bytes : 1 << 20;
      return textResult("x".repeat(bytes));
    }
    case "incomplete":
      await writeRaw(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{`);
      exitAfterOutput(code ?? 0);
      return undefined;
    case "exit":
      log(`exiting with ${code ?? 3} before replying`);
      process.exit(code ?? 3);
      return undefined;
    case "reply-then-exit":
      await reply(id, textResult("final reply"));
      log(`exiting with ${code ?? 0} after the final reply`);
      exitAfterOutput(code ?? 0);
      return undefined;
    case "stall-stdin":
      await reply(id, textResult("stalling stdin"));
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
      keepAlive();
      log("stopped reading stdin");
      return undefined;
    default:
      throw new RpcError(-32602, `Unknown misbehavior: ${kind}`);
  }
}

async function handleRequest(
  id: RequestId,
  method: string,
  params: JsonObject,
): Promise<void> {
  active += 1;
  try {
    switch (method) {
      case "initialize":
        if (MODE.has("hold-initialize")) {
          process.stderr.write("hold-initialize-ready\n");
          return;
        }
        await reply(id, {
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "junco-mcp-fixture", version: "1.0.0" },
        });
        return;
      case "ping":
        await reply(id, {});
        return;
      case "tools/list":
        if (MODE.has("hold-list")) {
          process.stderr.write("hold-list-ready\n");
          return;
        }
        if (MODE.has("list-failure")) {
          await fail(id, -32603, "fixture list failure");
          return;
        }
        await reply(id, { tools: LISTED_TOOLS });
        return;
      case "tools/call": {
        calls += 1;
        const name = stringParam(params, "name");
        const args = isRecord(params.arguments) ? params.arguments : {};
        const meta = isRecord(params._meta) ? params._meta : {};
        const result = await callTool(id, name, args, meta.progressToken);
        if (result) await reply(id, result);
        return;
      }
      default:
        await fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    await fail(
      id,
      error instanceof RpcError ? error.code : -32603,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    active -= 1;
    exitWhenIdle();
  }
}

function handleMessage(message: unknown): void {
  if (!isRecord(message)) {
    log("ignoring a non-object message");
    return;
  }
  const id = message.id;
  const method = message.method;
  const params = isRecord(message.params) ? message.params : {};
  if (typeof method !== "string") {
    // A response to one of this server's requests.
    if (typeof id !== "string" && typeof id !== "number") return;
    const pending = serverRequests.get(id);
    serverRequests.delete(id);
    if (isRecord(message.error)) {
      pending?.reject(new Error(String(message.error.message)));
    } else {
      pending?.resolve(message.result);
    }
    return;
  }
  if (id === undefined) {
    if (method === "notifications/cancelled") {
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number")
        return;
      const key = heldRequests.get(requestId);
      if (key === undefined) return;
      cancelled.push(requestId);
      const entry = held.get(key);
      held.delete(key);
      entry?.reply();
    }
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") return;
  void handleRequest(id, method, params);
}

function runServer(): void {
  log(`started in ${process.cwd()}`);
  if (MODE.has("exit-on-start")) {
    log("exiting with 3 on start");
    process.exit(3);
  }
  if (MODE.has("ignore-term")) {
    process.on("SIGTERM", () => log("ignoring SIGTERM"));
  }
  if (PERSISTENT) keepAlive();
  let pending = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (
      let newline = pending.indexOf(0x0a);
      newline >= 0;
      newline = pending.indexOf(0x0a)
    ) {
      const line = pending.subarray(0, newline).toString("utf8").trim();
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        log(`ignoring malformed input: ${String(error)}`);
      }
    }
  });
  process.stdin.on("end", () => {
    log("stdin closed");
    stdinEnded = true;
    exitWhenIdle();
  });
}

if (ROLE === "writer") {
  writeFileSync(
    process.env.JUNCO_MCP_FIXTURE_PATH ?? "",
    process.env.JUNCO_MCP_FIXTURE_CONTENT ?? "",
  );
} else if (ROLE === "holder") {
  log("holder started");
  keepAlive();
} else {
  runServer();
}
