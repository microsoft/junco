import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  type CallToolResult,
  type McpClient,
  McpConnectionClosedError,
  type Tool,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import { Type } from "typebox";

/** One connected server's discovered tools, in discovery order. */
export type McpServerTools = {
  readonly name: string;
  readonly client: McpClient;
  readonly tools: readonly Tool[];
  /** The failure that ended the server's connection, if one did. */
  readonly terminalError?: () => Error | undefined;
};

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
export function adaptMcpTools(servers: readonly McpServerTools[]): AgentTool[] {
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
  server: McpServerTools,
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
        throw restoreTerminalError(error, server.terminalError);
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
