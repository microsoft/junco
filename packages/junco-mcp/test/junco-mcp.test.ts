import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  LATEST_PROTOCOL_VERSION,
  McpAbortError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  type Tool,
} from "@earendil-works/pi-mcp";
import {
  createInMemoryTransportPair,
  type InMemoryTransport,
} from "@earendil-works/pi-mcp/testing";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getJuncoMcpToolIdentity, JuncoMcpTools } from "../src/index.ts";
import { adaptMcpTools, type McpServerTools } from "../src/tools.ts";

type Handler = (request: JsonRpcRequest) => unknown | Promise<unknown>;

const CallParams = Type.Object({
  name: Type.String(),
  _meta: Type.Optional(Type.Object({ progressToken: Type.Number() })),
});
const PageParams = Type.Object({ cursor: Type.Optional(Type.String()) });
const CancelledParams = Type.Object({ requestId: Type.Number() });

/** The `tools/call` tool name. */
function toolNameOf(request: JsonRpcRequest): string {
  return Value.Parse(CallParams, request.params).name;
}

interface TestServer {
  readonly transport: InMemoryTransport;
  readonly messages: JsonRpcMessage[];
  handle(method: string, handler: Handler): void;
}

const clients: McpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** A JSON-RPC server over upstream's in-memory transport, as in pi-mcp's client tests. */
async function createServer(): Promise<{
  clientTransport: InMemoryTransport;
  server: TestServer;
}> {
  const pair = createInMemoryTransportPair();
  const handlers = new Map<string, Handler>();
  const messages: JsonRpcMessage[] = [];
  pair.server.onMessage((message) => {
    messages.push(message);
    if (!("id" in message) || !("method" in message)) return;
    const request = message as JsonRpcRequest;
    const handler = handlers.get(request.method);
    queueMicrotask(async () => {
      try {
        if (!handler) {
          throw new McpError(-32601, `Method not found: ${request.method}`);
        }
        const result = await handler(request);
        await pair.server.send({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        const mcpError =
          error instanceof McpError
            ? error
            : new McpError(-32603, String(error));
        await pair.server
          .send({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: mcpError.code, message: mcpError.message },
          })
          .catch(() => {});
      }
    });
  });
  await pair.server.start();
  handlers.set("initialize", () => ({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1.0.0" },
  }));
  return {
    clientTransport: pair.client,
    server: {
      transport: pair.server,
      messages,
      handle(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

/** Tools whose `tools/call` answers with `<server>:<tool>`, listed one page per entry. */
function serveTools(
  server: TestServer,
  name: string,
  pages: readonly (readonly Tool[])[],
): void {
  server.handle("tools/list", (request) => {
    const { cursor } = Value.Parse(PageParams, request.params ?? {});
    const index = cursor === undefined ? 0 : Number(cursor);
    return {
      tools: pages[index],
      ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
    };
  });
  server.handle("tools/call", (request) => ({
    content: [{ type: "text", text: `${name}:${toolNameOf(request)}` }],
  }));
}

async function connectServer(
  name: string,
  setup: (server: TestServer) => void,
  terminalError?: () => Error | undefined,
): Promise<McpServerTools & { readonly server: TestServer }> {
  const { clientTransport, server } = await createServer();
  setup(server);
  const client = new McpClient({ name: "junco-mcp-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(clientTransport);
  return {
    name,
    client,
    server,
    tools: await client.listTools(),
    ...(terminalError ? { terminalError } : {}),
  };
}

const tool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object" },
});

const hashed = (base: string, server: string, original: string) =>
  `${base.slice(0, 55)}_${createHash("sha256").update(`${server}\0${original}`).digest("hex").slice(0, 8)}`;

function text(result: AgentToolResult<unknown>): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function named(tools: readonly AgentTool[], name: string): AgentTool {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

function nativeAddonLoaded(): boolean {
  return readFileSync("/proc/self/maps", "utf8").includes("junco_tools");
}

test("JuncoMcpTools.add validates names without changing the definition", async () => {
  const definition = new JuncoMcpTools();
  assert.equal(
    definition.add({ name: "a", type: "stdio", command: "server-a" }),
    definition,
  );
  for (const name of ["", "  \t"]) {
    assert.throws(
      () =>
        definition.add({ name, type: "bogus" as "stdio", command: "blank" }),
      { message: "JuncoMcpTools: server name must not be empty" },
    );
  }
  assert.throws(
    () =>
      definition.add({ name: "a", type: "bogus" as "stdio", command: "dup" }),
    { message: 'JuncoMcpTools: duplicate server name "a"' },
  );
  // Names are exact: a differently spelled name is a different server.
  definition.add({
    name: "A",
    type: "stdio",
    command: "server-c",
    closeTimeoutMs: -1,
  });
  // Validation runs in insertion order before acquisition. Had a rejected entry been kept,
  // its unsupported transport would have been reported first.
  await assert.rejects(definition.connect(), {
    message: "JuncoMcpTools: closeTimeoutMs must be finite and non-negative",
  });

  const built = JuncoMcpTools.add({
    name: "one",
    type: "stdio",
    command: "one",
  });
  assert.ok(built instanceof JuncoMcpTools);
  assert.equal(
    built.add({ name: "two", type: "bogus" as "stdio", command: "two" }),
    built,
  );
  await assert.rejects(built.connect(), {
    message: 'JuncoMcpTools: unsupported transport "bogus"',
  });
  assert.equal(nativeAddonLoaded(), false);
});

test("connect rejects invalid close timeouts before acquiring the ShellMux", async () => {
  for (const closeTimeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      JuncoMcpTools.add({
        name: "server",
        type: "stdio",
        command: "server",
        closeTimeoutMs,
      }).connect({ cwd: "/nonexistent" }),
      {
        message:
          "JuncoMcpTools: closeTimeoutMs must be finite and non-negative",
      },
    );
  }
  assert.equal(nativeAddonLoaded(), false);
});

test("an empty definition connects without loading the native addon", async () => {
  const connection = await new JuncoMcpTools().connect({ cwd: "/nonexistent" });
  assert.deepEqual(connection.tools, []);
  await connection.close();
  await connection.close();
  assert.equal(nativeAddonLoaded(), false);
});

test("snapshot is a detached definition and acquires nothing", async () => {
  const original = JuncoMcpTools.add({
    name: "a",
    type: "stdio",
    command: "server-a",
  });
  const copy = original.snapshot();
  assert.ok(copy instanceof JuncoMcpTools);
  assert.notEqual(copy, original);
  // The copy carries the existing servers.
  assert.throws(
    () => copy.add({ name: "a", type: "stdio", command: "again" }),
    {
      message: 'JuncoMcpTools: duplicate server name "a"',
    },
  );
  // Later additions stay on the definition they were made to.
  original.add({ name: "b", type: "bogus" as "stdio", command: "b" });
  copy.add({ name: "b", type: "stdio", command: "b", closeTimeoutMs: -1 });
  await assert.rejects(original.connect(), {
    message: 'JuncoMcpTools: unsupported transport "bogus"',
  });
  await assert.rejects(copy.connect(), {
    message: "JuncoMcpTools: closeTimeoutMs must be finite and non-negative",
  });

  const empty = new JuncoMcpTools();
  const emptyCopy = empty.snapshot();
  empty.add({ name: "late", type: "bogus" as "stdio", command: "late" });
  const connection = await emptyCopy.connect({ cwd: "/nonexistent" });
  assert.deepEqual(connection.tools, []);
  await connection.close();
  assert.equal(nativeAddonLoaded(), false);
});

test("an already aborted connect rejects with McpAbortError before acquiring the ShellMux", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    JuncoMcpTools.add({
      name: "server",
      type: "stdio",
      command: "server",
    }).connect({
      cwd: "/nonexistent",
      signal: controller.signal,
    }),
    (error) => error instanceof McpAbortError,
  );
  assert.equal(nativeAddonLoaded(), false);
});

test("a nonempty definition without a collection rejects before starting anything", async () => {
  const definition = JuncoMcpTools.add({
    name: "server",
    type: "stdio",
    command: "server",
  });
  assert.equal(definition.size, 1);
  await assert.rejects(definition.connect({ cwd: "/nonexistent" }), {
    name: "TypeError",
    message: "JuncoMcpTools: a nonempty definition requires a collection",
  });
  assert.equal(nativeAddonLoaded(), false);
});

test("tool names are sanitized, bounded, and collision-hashed independent of order", async () => {
  const long = "x".repeat(80);
  const pages = [
    [tool("lookup-item"), tool("plain.name")],
    [tool("lookup_item"), tool(long)],
  ];
  const primary = await connectServer("srv", (server) =>
    serveTools(server, "srv", pages),
  );
  const other = await connectServer("other", (server) =>
    serveTools(server, "other", [[tool("lookup-item")]]),
  );
  const reversed = await connectServer("srv", (server) =>
    serveTools(
      server,
      "srv",
      [...pages].reverse().map((page) => [...page].reverse()),
    ),
  );

  const tools = adaptMcpTools([primary, other]);
  const longBase = `mcp__srv__${long}`;
  const expected = new Map([
    [hashed("mcp__srv__lookup_item", "srv", "lookup-item"), "srv:lookup-item"],
    ["mcp__srv__plain_name", "srv:plain.name"],
    [hashed("mcp__srv__lookup_item", "srv", "lookup_item"), "srv:lookup_item"],
    [hashed(longBase, "srv", long), `srv:${long}`],
    ["mcp__other__lookup_item", "other:lookup-item"],
  ]);
  assert.deepEqual(
    tools.map((candidate) => candidate.name),
    [...expected.keys()],
  );
  for (const candidate of tools) assert.ok(candidate.name.length <= 64);

  // Every tool dispatches to its original server and MCP name.
  for (const [name, reply] of expected) {
    const result = await named(tools, name).execute("call", {});
    assert.equal(text(result), reply);
  }

  // Discovery order does not change which tool receives which name.
  const reordered = adaptMcpTools([other, reversed]);
  const dispatch = async (list: readonly AgentTool[]) =>
    new Map(
      await Promise.all(
        list.map(
          async (candidate) =>
            [
              candidate.name,
              text(await candidate.execute("call", {})),
            ] as const,
        ),
      ),
    );
  assert.deepEqual(await dispatch(reordered), await dispatch(tools));
});

test("servers whose names sanitize alike get distinct hashed tool names", async () => {
  const dashed = await connectServer("a-b", (server) =>
    serveTools(server, "a-b", [[tool("c")]]),
  );
  const underscored = await connectServer("a_b", (server) =>
    serveTools(server, "a_b", [[tool("c")]]),
  );
  const tools = adaptMcpTools([dashed, underscored]);
  assert.deepEqual(
    tools.map((candidate) => candidate.name),
    [hashed("mcp__a_b__c", "a-b", "c"), hashed("mcp__a_b__c", "a_b", "c")],
  );
  assert.equal(
    text(await named(tools, tools[0]?.name ?? "").execute("1", {})),
    "a-b:c",
  );
  assert.equal(
    text(await named(tools, tools[1]?.name ?? "").execute("2", {})),
    "a_b:c",
  );
});

test("a tool repeated across pages is rejected instead of overwritten", async () => {
  const repeated = await connectServer("srv", (server) =>
    serveTools(server, "srv", [[tool("dup")], [tool("dup")]]),
  );
  assert.throws(() => adaptMcpTools([repeated]), {
    message: `JuncoMcpTools: duplicate tool name "${hashed("mcp__srv__dup", "srv", "dup")}"`,
  });
});

test("wrappers carry a frozen server and original tool identity; colliding originals stay distinct", async () => {
  const srv = await connectServer("srv", (server) =>
    serveTools(server, "srv", [[tool("a-b"), tool("a_b")]]),
  );
  const other = await connectServer("other", (server) =>
    serveTools(server, "other", [[tool("a-b")]]),
  );
  const tools = adaptMcpTools([srv, other]);
  const expected = [
    [hashed("mcp__srv__a_b", "srv", "a-b"), "srv", "a-b"],
    [hashed("mcp__srv__a_b", "srv", "a_b"), "srv", "a_b"],
    ["mcp__other__a_b", "other", "a-b"],
  ] as const;
  assert.deepEqual(
    tools.map((candidate) => candidate.name),
    expected.map(([name]) => name),
  );
  for (const [name, serverName, originalToolName] of expected) {
    const wrapper = named(tools, name);
    const identity = getJuncoMcpToolIdentity(wrapper);
    assert.deepEqual(identity, { serverName, originalToolName });
    assert.ok(Object.isFrozen(identity));
    // The wrapper dispatches exactly the operation its identity names.
    assert.equal(
      text(await wrapper.execute("call", {})),
      `${serverName}:${originalToolName}`,
    );
  }

  // Copies and same-named tools carry no provenance.
  const [first] = tools;
  assert.ok(first);
  assert.equal(getJuncoMcpToolIdentity({ ...first }), undefined);
  assert.equal(
    getJuncoMcpToolIdentity({
      name: "mcp__other__a_b",
      label: "a-b",
      description: "impostor",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    }),
    undefined,
  );
});

test("tool results keep structured, text, image, and error content", async () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const server = await connectServer("srv", (fixture) => {
    serveTools(fixture, "srv", [
      [tool("structured"), tool("media"), tool("failed"), tool("failed-empty")],
    ]);
    fixture.handle("tools/call", (request) => {
      switch (toolNameOf(request)) {
        case "structured":
          return { structuredContent: { count: 3 } };
        case "media":
          return { content: [{ type: "text", text: "hello" }, image] };
        case "failed":
          return {
            content: [{ type: "text", text: "bad input" }],
            isError: true,
          };
        default:
          return { isError: true };
      }
    });
  });
  const tools = adaptMcpTools([server]);

  const structured = await named(tools, "mcp__srv__structured").execute(
    "1",
    {},
  );
  assert.deepEqual(structured.structuredContent, { count: 3 });
  assert.equal(structured.isError, false);
  assert.deepEqual(JSON.parse(text(structured)), { count: 3 });

  const media = await named(tools, "mcp__srv__media").execute("2", {});
  assert.deepEqual(media.content, [{ type: "text", text: "hello" }, image]);
  assert.equal(media.isError, false);

  const failed = await named(tools, "mcp__srv__failed").execute("3", {});
  assert.equal(failed.isError, true);
  assert.equal(text(failed), "bad input");

  const empty = await named(tools, "mcp__srv__failed_empty").execute("4", {});
  assert.equal(empty.isError, true);
  assert.equal(text(empty), "MCP tool failed-empty failed");
});

test("progress of a pending call reaches onUpdate", async () => {
  const server = await connectServer("srv", (fixture) => {
    serveTools(fixture, "srv", [[tool("slow")]]);
    fixture.handle("tools/call", async (request) => {
      const progressToken = Value.Parse(CallParams, request.params)._meta
        ?.progressToken;
      assert.equal(typeof progressToken, "number");
      await fixture.transport.send({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: 1, total: 2, message: "halfway" },
      });
      await fixture.transport.send({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: 2, total: 2 },
      });
      return { content: [{ type: "text", text: "done" }] };
    });
  });
  const [slow] = adaptMcpTools([server]);
  assert.ok(slow);
  const updates: AgentToolResult<unknown>[] = [];
  const result = await slow.execute("1", {}, undefined, (update) =>
    updates.push(update),
  );
  assert.equal(text(result), "done");
  assert.deepEqual(updates, [
    { content: [{ type: "text", text: "halfway" }], details: undefined },
    { content: [{ type: "text", text: "Progress 2" }], details: undefined },
  ]);
});

test("a cancelled call stays rejected when its reply arrives later", async () => {
  const arrived = Promise.withResolvers<void>();
  const held = Promise.withResolvers<unknown>();
  const server = await connectServer("srv", (fixture) => {
    serveTools(fixture, "srv", [[tool("held"), tool("quick")]]);
    fixture.handle("tools/call", (request) => {
      if (toolNameOf(request) === "quick") {
        return { content: [{ type: "text", text: "quick" }] };
      }
      arrived.resolve();
      return held.promise;
    });
  });
  const errors: Error[] = [];
  const lateReply = Promise.withResolvers<void>();
  server.client.onError((error) => {
    errors.push(error);
    lateReply.resolve();
  });
  const tools = adaptMcpTools([server]);
  const controller = new AbortController();
  const call = named(tools, "mcp__srv__held").execute(
    "1",
    {},
    controller.signal,
  );
  await arrived.promise;
  controller.abort("stop");
  await assert.rejects(call, (error) => error instanceof McpAbortError);

  const cancellation = server.server.messages.find(
    (message) =>
      "method" in message && message.method === "notifications/cancelled",
  );
  assert.ok(cancellation && "params" in cancellation);
  const { requestId } = Value.Parse(CancelledParams, cancellation.params);

  // The server answers anyway; the client reports it as unknown and the call stays failed.
  held.resolve({ content: [{ type: "text", text: "too late" }] });
  await lateReply.promise;
  assert.match(
    errors[0]?.message ?? "",
    new RegExp(`request ${String(requestId)}$`),
  );
  await assert.rejects(call, (error) => error instanceof McpAbortError);
  assert.equal(
    text(await named(tools, "mcp__srv__quick").execute("2", {})),
    "quick",
  );
});

test("a closed connection rejects with its terminal failure, other errors unchanged", async () => {
  const denial = Object.assign(new Error("publication denied"), {
    code: "MARSH_POLICY_DENIED",
  });
  let terminal: Error | undefined;
  const arrived = Promise.withResolvers<void>();
  const setup = (fixture: TestServer) => {
    serveTools(fixture, "srv", [[tool("held"), tool("broken")]]);
    fixture.handle("tools/call", (request) => {
      if (toolNameOf(request) === "broken") {
        throw new McpError(1234, "tool exploded");
      }
      arrived.resolve();
      return Promise.withResolvers<never>().promise;
    });
  };
  const restored = await connectServer("srv", setup, () => terminal);
  const tools = adaptMcpTools([restored]);

  await assert.rejects(named(tools, "mcp__srv__broken").execute("1", {}), {
    name: "McpError",
    message: "tool exploded",
  });

  const pending = named(tools, "mcp__srv__held").execute("2", {});
  await arrived.promise;
  terminal = denial;
  await restored.server.transport.close();
  await assert.rejects(pending, (error) => error === denial);
  // Retained tools reject through the closed client and never reconnect.
  await assert.rejects(
    named(tools, "mcp__srv__broken").execute("3", {}),
    (error) => error === denial,
  );

  const plain = await connectServer("plain", setup);
  const [held] = adaptMcpTools([plain]);
  assert.ok(held);
  await plain.client.close();
  await assert.rejects(
    held.execute("4", {}),
    (error) => error instanceof McpConnectionClosedError,
  );
});
