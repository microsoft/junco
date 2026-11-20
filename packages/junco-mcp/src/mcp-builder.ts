import { ToolCollection, type ToolCollectionOptions } from "junco-tools";
import {
  type JuncoMcpServerOptions,
  JuncoMcpTools,
} from "./junco-mcp-tools.js";

/** Options of {@link McpBuilder.build}: the collection's, plus cancellation of server acquisition (`JuncoMcpConnectOptions.signal`). */
export type McpBuilderOptions = ToolCollectionOptions & {
  readonly signal?: AbortSignal;
};

/**
 * MCP servers as ordinary collection tools. `build` opens a ToolCollection, connects every added
 * server on its mux and publishes the discovered `mcp__<server>__<tool>` wrappers in
 * `collection.tools`, so every agent over the collection gets them as defaults (`tool_block` opts
 * out by name). One client and process per server per collection, shared by all its owners and
 * closed by the collection's `close()` before its mux.
 */
export class McpBuilder {
  readonly #servers = new JuncoMcpTools();

  /** Append a server; same rules as `JuncoMcpTools.add` (nonblank, unique `name`). */
  add(options: JuncoMcpServerOptions): this {
    this.#servers.add(options);
    return this;
  }

  /** Open a collection in `cwd` (also the base of relative server `cwd`s) with every added server connected on it. */
  build(
    cwd: string,
    { signal, ...options }: McpBuilderOptions = {},
  ): Promise<ToolCollection> {
    return ToolCollection.create(cwd, {
      ...options,
      extend: (collection) =>
        this.#servers.connect({ cwd, collection, signal }),
    });
  }
}
