import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  McpAbortError,
  McpClient,
  type McpClientOptions,
  type StdioTransportOptions,
  type Tool,
} from "@earendil-works/pi-mcp";
import type { ToolCollection } from "junco-tools";
import { ShellMuxStdioTransport } from "./stdio.js";
import { adaptMcpTools, restoreTerminalError } from "./tools.js";

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

/** Fresh clients and processes for every server of a definition, with their tools. */
export interface JuncoMcpConnection {
  readonly tools: AgentTool[];
  /** Close every server in reverse order and release the collection lease. Idempotent. */
  close(): Promise<void>;
}

interface ServerDefinition {
  readonly name: string;
  readonly options: JuncoMcpServerOptions;
}

interface ServerRecord {
  readonly name: string;
  readonly client: McpClient;
  readonly transport: ShellMuxStdioTransport;
  tools: readonly Tool[];
}

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
   * Connect every server in insertion order and adapt its tools. Later {@link add} calls
   * affect later connections only. An empty definition acquires nothing.
   */
  async connect(
    options: JuncoMcpConnectOptions = {},
  ): Promise<JuncoMcpConnection> {
    const base = resolve(options.cwd ?? process.cwd());
    const signal = options.signal;
    const servers = this.#servers.map(({ name, options: server }) => ({
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
      const tools = adaptMcpTools(
        records.map(({ name, client, transport, tools }) => ({
          name,
          client,
          tools,
          terminalError: () => transport.terminalError,
        })),
      );
      let closing: Promise<void> | undefined;
      if (signal?.aborted) throw new McpAbortError();
      return {
        tools,
        close() {
          closing ??= closeServers(records, lease).then((failures) => {
            if (failures.length > 0) {
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
