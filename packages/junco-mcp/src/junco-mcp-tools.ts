import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  type CallToolResult,
  McpAbortError,
  McpClient,
  type McpClientOptions,
  McpConnectionClosedError,
  type StdioTransportOptions,
  type Tool,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type { ToolCollection } from "junco-tools";
import { Type } from "typebox";
import { ShellMuxStdioTransport } from "./stdio.js";

/** One MCP server, launched over stdio as a managed job of a Junco ToolCollection's ShellMux. */
export type JuncoMcpServerOptions = {
  readonly name: string;
  readonly type: "stdio";
  readonly clientOptions?: Omit<McpClientOptions, "name" | "version">;
} & StdioTransportOptions;

export interface JuncoMcpConnectOptions {
  /** Base for relative server `cwd`s. Default: `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Cancels acquisition only: an abort before the connection is returned stops every server
   * it started and rejects with `McpAbortError`. A returned connection ignores it.
   */
  readonly signal?: AbortSignal;
  /**
   * Default: "connection", keeping servers until close. "call" closes discovery and opens a
   * fresh originating server per invocation. Independent of `discardOnClose`.
   */
  readonly toolLifetime?: "connection" | "call";
  /**
   * Close each server by cancelling it, so none of its effects (file writes, caches) publish
   * to the checkout. A server that exits on its own before cancellation fails `close`.
   * Default: `false`, which ends standard input and publishes the server's effects.
   */
  readonly discardOnClose?: boolean;
  /**
   * Collection whose ShellMux (and so authorization policy) runs every server. Required by a
   * nonempty definition; the connection holds a lease on it until closed.
   */
  readonly collection?: ToolCollection;
}

/** Discovered tools and their connection- or call-scoped clients and processes. */
export interface JuncoMcpConnection {
  readonly tools: AgentTool[];
  /** Fence new calls, close all owned servers, and release the collection lease. Idempotent. */
  close(): Promise<void>;
}

interface ServerDefinition {
  readonly name: string;
  readonly options: JuncoMcpServerOptions;
}

/** One connected server and its discovered tools, in discovery order. */
export interface ServerRecord {
  readonly name: string;
  readonly client: McpClient;
  readonly transport: ShellMuxStdioTransport;
  tools: readonly Tool[];
}

type CallRecord = {
  readonly settled: Promise<void>;
  cleanupFailures?: readonly unknown[];
};

const CLIENT_IDENTITY = { name: "junco-mcp", version: "0.1.0" } as const;

/**
 * A declarative, ordered collection of MCP stdio servers. Defining servers does no process
 * or network work; each {@link connect} starts fresh clients and processes on the
 * supplied collection's ShellMux.
 */
export class JuncoMcpTools {
  readonly #servers: ServerDefinition[] = [];

  /** `new JuncoMcpTools().add(options)`. */
  static add(options: JuncoMcpServerOptions): JuncoMcpTools {
    return new JuncoMcpTools().add(options);
  }

  /** Append a server. Rejects blank and duplicate names without changing the definition. */
  add(options: JuncoMcpServerOptions): this {
    const name = options.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("JuncoMcpTools: server name must not be empty");
    }
    if (this.#servers.some((server) => server.name === name)) {
      throw new Error(`JuncoMcpTools: duplicate server name "${name}"`);
    }
    this.#servers.push({ name, options });
    return this;
  }

  /** Number of servers in the definition. */
  get size(): number {
    return this.#servers.length;
  }

  /**
   * A detached copy of the current definition: server options, arguments, environment and
   * client options are copied, callbacks are shared. Acquires nothing; later {@link add} calls
   * on either definition do not affect the other.
   */
  snapshot(): JuncoMcpTools {
    const copy = new JuncoMcpTools();
    for (const { name, options } of this.#servers) {
      copy.#servers.push({ name, options: copyServerOptions(options) });
    }
    return copy;
  }

  /**
   * Discover every server in insertion order and adapt its tools. Later {@link add} calls
   * affect later connections only. Call lifetime closes discovery before returning and starts
   * only the originating server for each invocation. An empty definition acquires nothing.
   */
  async connect(
    options: JuncoMcpConnectOptions = {},
  ): Promise<JuncoMcpConnection> {
    if (
      options.toolLifetime !== undefined &&
      options.toolLifetime !== "connection" &&
      options.toolLifetime !== "call"
    ) {
      throw new TypeError(
        'JuncoMcpTools: toolLifetime must be "connection" or "call"',
      );
    }
    return options.toolLifetime === "call"
      ? this.#connectPerCall(options)
      : this.#connectPhysical(options);
  }

  async #connectPhysical(
    options: Omit<JuncoMcpConnectOptions, "toolLifetime">,
    definitions: readonly ServerDefinition[] = this.#servers,
    call?: CallRecord,
  ): Promise<JuncoMcpConnection> {
    const base = resolve(options.cwd ?? process.cwd());
    const signal = options.signal;
    const servers = definitions.map(({ name, options: server }) => ({
      ...copyServerOptions(server),
      name,
      cwd: resolve(base, server.cwd ?? "."),
    }));
    for (const server of servers) {
      if (server.type !== "stdio") {
        throw new Error(
          `JuncoMcpTools: unsupported transport "${String(server.type)}"`,
        );
      }
      const timeout = server.closeTimeoutMs;
      if (
        timeout !== undefined &&
        !(Number.isFinite(timeout) && timeout >= 0)
      ) {
        throw new Error(
          "JuncoMcpTools: closeTimeoutMs must be finite and non-negative",
        );
      }
    }
    if (servers.length === 0) {
      return { tools: [], close: () => Promise.resolve() };
    }
    if (signal?.aborted) throw new McpAbortError();
    const collection = options.collection;
    if (collection === undefined) {
      throw new TypeError(
        "JuncoMcpTools: a nonempty definition requires a collection",
      );
    }

    const lease = collection.lease();
    const mux = collection.mux;
    const records: ServerRecord[] = [];
    try {
      if (signal?.aborted) throw new McpAbortError();
      for (const server of servers) {
        try {
          await mux.validateCwd(server.cwd);
        } catch (error) {
          throw new Error(
            `JuncoMcpTools: failed to initialize server "${server.name}"`,
            { cause: error },
          );
        }
        if (signal?.aborted) throw new McpAbortError();
      }
      for (const server of servers) {
        const { name, type: _type, clientOptions, ...stdio } = server;
        const transport = new ShellMuxStdioTransport(mux, {
          ...stdio,
          ...(options.discardOnClose ? { discardOnClose: true } : {}),
        });
        const client = new McpClient({
          ...clientOptions,
          ...CLIENT_IDENTITY,
          roots: clientOptions?.roots ?? [
            { uri: pathToFileURL(server.cwd).href, name },
          ],
        });
        const record: ServerRecord = { name, client, transport, tools: [] };
        records.push(record);
        // `connect` takes no signal: an abort closes the client, failing the handshake.
        const onAbort = () => {
          client.close().catch(() => {}); // Its failure resurfaces on `transport.closed`.
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          await client.connect(transport);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) throw new McpAbortError();
          record.tools = await client.listTools({ signal });
          if (signal?.aborted) throw new McpAbortError();
        } catch (error) {
          if (signal?.aborted) throw new McpAbortError();
          throw new Error(
            `JuncoMcpTools: failed to initialize server "${name}"`,
            {
              cause: restoreTerminalError(error, () => transport.terminalError),
            },
          );
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }
      const tools = adaptMcpTools(records);
      let closing: Promise<void> | undefined;
      if (signal?.aborted) throw new McpAbortError();
      return {
        tools,
        close() {
          closing ??= closeServers(records, lease).then((failures) => {
            if (failures.length > 0) {
              if (call) call.cleanupFailures = failures;
              throw new AggregateError(failures, "JuncoMcpTools close failed", {
                cause: failures[0],
              });
            }
          });
          return closing;
        },
      };
    } catch (primary) {
      const failures = await closeServers(records, lease, primary);
      if (call && failures.length > 0) call.cleanupFailures = failures;
      if (failures.length === 0) throw primary;
      throw new AggregateError(
        [primary, ...failures],
        "JuncoMcpTools connection cleanup failed",
        { cause: primary },
      );
    }
  }

  async #connectPerCall(
    options: Omit<JuncoMcpConnectOptions, "toolLifetime">,
  ): Promise<JuncoMcpConnection> {
    const definition = this.snapshot();
    const cwd = resolve(options.cwd ?? process.cwd());
    const collection = options.collection;
    const discardOnClose = options.discardOnClose;
    const signal = options.signal;
    const physicalOptions = { cwd, collection, discardOnClose };
    if (definition.size === 0) {
      const closed = Promise.resolve();
      return { tools: [], close: () => closed };
    }
    if (collection === undefined || signal?.aborted) {
      return definition.#connectPhysical({ ...physicalOptions, signal });
    }

    const lease = collection.lease();
    try {
      const discovery = await definition.#connectPhysical({
        ...physicalOptions,
        signal,
      });
      const tools = discovery.tools;
      await discovery.close();
      if (signal?.aborted) throw new McpAbortError();

      const stop = new AbortController();
      const calls = new Set<CallRecord>();
      let closing: Promise<void> | undefined;
      for (const tool of tools) {
        const identity = getJuncoMcpToolIdentity(tool)!;
        const server = definition.#servers.find(
          ({ name }) => name === identity.serverName,
        )!;
        tool.execute = (toolCallId, params, signal, onUpdate) => {
          if (closing !== undefined) {
            return Promise.reject(new McpConnectionClosedError());
          }
          const callSignal = signal
            ? AbortSignal.any([signal, stop.signal])
            : stop.signal;
          const { promise: settled, resolve } = Promise.withResolvers<void>();
          const call: CallRecord = { settled };
          calls.add(call);
          const invocation = (async () => {
            if (callSignal.aborted) throw new McpAbortError();
            let connection: JuncoMcpConnection | undefined;
            let failed = false;
            let primary: unknown;
            let result: Awaited<ReturnType<AgentTool["execute"]>> | undefined;
            try {
              connection = await definition.#connectPhysical(
                { ...physicalOptions, signal: callSignal },
                [server],
                call,
              );
              const matches = connection.tools.filter((candidate) => {
                const fresh = getJuncoMcpToolIdentity(candidate);
                return (
                  fresh?.serverName === identity.serverName &&
                  fresh.originalToolName === identity.originalToolName
                );
              });
              if (matches.length !== 1) {
                throw new Error(
                  `JuncoMcpTools: expected one tool "${identity.serverName}/${identity.originalToolName}", found ${matches.length}`,
                );
              }
              result = await matches[0]!.execute(
                toolCallId,
                params,
                callSignal,
                onUpdate,
              );
              if (callSignal.aborted) throw new McpAbortError();
            } catch (error) {
              failed = true;
              primary = error;
            }
            try {
              await connection?.close();
            } catch (closeFailure) {
              if (failed) {
                throw new AggregateError(
                  [primary, closeFailure],
                  "JuncoMcpTools call cleanup failed",
                  { cause: primary },
                );
              }
              throw closeFailure;
            }
            if (failed) throw primary;
            if (callSignal.aborted) throw new McpAbortError();
            return result!;
          })();
          const finish = () => {
            resolve();
            calls.delete(call);
          };
          invocation.then(finish, finish);
          return invocation;
        };
      }
      return {
        tools,
        close() {
          if (closing === undefined) {
            const active = [...calls];
            closing = Promise.resolve().then(async () => {
              stop.abort(new McpConnectionClosedError());
              await Promise.all(active.map(({ settled }) => settled));
              const failures = active.flatMap(
                ({ cleanupFailures }) => cleanupFailures ?? [],
              );
              await lease.close().catch((error) => failures.push(error));
              if (failures.length > 0) {
                throw new AggregateError(
                  failures,
                  "JuncoMcpTools close failed",
                  {
                    cause: failures[0],
                  },
                );
              }
            });
          }
          return closing;
        },
      };
    } catch (primary) {
      const failures: unknown[] = [];
      await lease.close().catch((error) => failures.push(error));
      if (failures.length === 0) throw primary;
      throw new AggregateError(
        [primary, ...failures],
        "JuncoMcpTools connection cleanup failed",
        { cause: primary },
      );
    }
  }
}

/** Copies a server's data (arguments, environment, client options, static roots); callbacks are shared. */
function copyServerOptions(
  server: JuncoMcpServerOptions,
): JuncoMcpServerOptions {
  const clientOptions = server.clientOptions;
  return {
    ...server,
    args: server.args ? [...server.args] : undefined,
    env: server.env ? { ...server.env } : undefined,
    clientOptions: clientOptions && {
      ...clientOptions,
      capabilities:
        clientOptions.capabilities &&
        structuredClone(clientOptions.capabilities),
      roots:
        typeof clientOptions.roots === "function"
          ? clientOptions.roots
          : clientOptions.roots && structuredClone(clientOptions.roots),
    },
  };
}

/**
 * Close every client in reverse order, attempting all of them, then release the lease.
 * Upstream clears its transport before awaiting it and initialization cleanup swallows its
 * failure, so each transport's `closed` fence is awaited as well. Failures already carried
 * by `primary` are not repeated.
 */
async function closeServers(
  records: readonly ServerRecord[],
  lease: { close(): Promise<void> },
  primary?: unknown,
): Promise<unknown[]> {
  const seen = new Set<unknown>();
  if (primary !== undefined) {
    seen.add(primary);
    if (primary instanceof Error && primary.cause !== undefined) {
      seen.add(primary.cause);
    }
  }
  const failures: unknown[] = [];
  const collect = (error: unknown) => {
    if (seen.has(error)) return;
    seen.add(error);
    failures.push(error);
  };
  for (const { client, transport } of [...records].reverse()) {
    await client.close().catch(collect);
    await transport.closed.catch(collect);
  }
  await lease.close().catch(collect);
  return failures;
}

/** The protocol operation an adapted MCP wrapper dispatches, independent of its published name. */
export type JuncoMcpToolIdentity = {
  readonly serverName: string;
  readonly originalToolName: string;
};

/** Wrappers created by {@link adaptMcpTools}, keyed by object identity. */
const toolIdentities = new WeakMap<AgentTool, JuncoMcpToolIdentity>();

/** The server and original MCP tool name behind a wrapper created by this package. */
export function getJuncoMcpToolIdentity(
  tool: AgentTool,
): JuncoMcpToolIdentity | undefined {
  return toolIdentities.get(tool);
}

/** Provider tool names are limited to 64 characters. */
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_LENGTH = 8;

/**
 * Upstream reduces every transport failure to `McpConnectionClosedError`; restore the
 * failure that actually ended the connection (for example a Marsh policy denial).
 */
export function restoreTerminalError(
  error: unknown,
  terminalError: (() => Error | undefined) | undefined,
): unknown {
  if (!(error instanceof McpConnectionClosedError)) return error;
  return terminalError?.() ?? error;
}

function hashedToolName(base: string, server: string, tool: string): string {
  const hash = createHash("sha256")
    .update(`${server}\0${tool}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${base.slice(0, MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Adapt every discovered tool of a connection. Names follow Pi's production policy:
 * `mcp__<server>__<tool>` with everything outside `[A-Za-z0-9_]` replaced by `_`. A name
 * that is too long, or that any other tool of the connection sanitizes to as well, gets a
 * hash suffix of its original server and tool names, independent of discovery order.
 */
export function adaptMcpTools(servers: readonly ServerRecord[]): AgentTool[] {
  const entries = servers.flatMap((server) =>
    server.tools.map((tool) => ({
      server,
      tool,
      base: `mcp__${server.name}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_"),
    })),
  );
  const counts = new Map<string, number>();
  for (const { base } of entries) counts.set(base, (counts.get(base) ?? 0) + 1);
  const names = new Set<string>();
  return entries.map(({ server, tool, base }) => {
    const name =
      base.length <= MAX_TOOL_NAME_LENGTH && counts.get(base) === 1
        ? base
        : hashedToolName(base, server.name, tool.name);
    if (names.has(name)) {
      throw new Error(`JuncoMcpTools: duplicate tool name "${name}"`);
    }
    names.add(name);
    return adaptMcpTool(server, tool, name);
  });
}

function adaptMcpTool(
  server: ServerRecord,
  tool: Tool,
  name: string,
): AgentTool {
  const adapted: AgentTool = {
    name,
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.title ?? `MCP tool ${tool.name}`,
    // Providers require an object schema, and some reject one without `properties`.
    parameters: Type.Unsafe({
      ...tool.inputSchema,
      type: "object",
      properties: tool.inputSchema.properties ?? {},
    }),
    ...(tool.outputSchema
      ? {
          outputSchema: Type.Unsafe<Record<string, unknown>>(tool.outputSchema),
        }
      : {}),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      let result: CallToolResult;
      try {
        result = await server.client.callTool(
          tool.name,
          params as Record<string, unknown>,
          {
            signal,
            onProgress: (progress) => {
              const text = progress.message ?? `Progress ${progress.progress}`;
              onUpdate?.({
                content: [{ type: "text", text }],
                details: undefined,
              });
            },
          },
        );
      } catch (error) {
        throw restoreTerminalError(error, () => server.transport.terminalError);
      }
      const content = toLlmContent(result);
      if (result.isError && content.length === 0) {
        content.push({ type: "text", text: `MCP tool ${tool.name} failed` });
      }
      return {
        content,
        details: undefined,
        structuredContent: result.structuredContent as JsonValue | undefined,
        // MCP reports tool failures in the result instead of as a protocol error.
        isError: result.isError === true,
      };
    },
  };
  toolIdentities.set(
    adapted,
    Object.freeze({ serverName: server.name, originalToolName: tool.name }),
  );
  return adapted;
}
