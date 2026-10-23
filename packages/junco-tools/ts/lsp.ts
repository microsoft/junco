import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
  LspTool as UpstreamLspTool,
  LspToolDetails as UpstreamLspToolDetails,
} from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type TUnsafe, Type } from "typebox";
import { resolveToolPath } from "./tool-support.js";

/** Options for {@link LspTool.create}. */
export interface LspToolOptions {
  /**
   * Restrict the tool to upstream's read-only actions. Write-tier actions
   * (`code_actions`, `reload`, `rename`, `rename_file`, `request`) are
   * rejected by the upstream tool before contacting a language server.
   * Defaults to full upstream action support.
   */
  readonly readOnly?: boolean;
}

/**
 * Arguments accepted by {@link LspTool.execute}: the upstream oh-my-pi `lsp`
 * parameters. Navigation actions take a one-based `line` plus the `symbol`
 * text on that line; `timeout` is in seconds (default 20, schema range 5–300).
 */
export type LspToolInput = Parameters<UpstreamLspTool["execute"]>[1];

/** Structured details reported by the upstream `lsp` tool for each action. */
export type LspToolDetails = UpstreamLspToolDetails;

type UpstreamLspResult = Awaited<ReturnType<UpstreamLspTool["execute"]>>;
type LspResult = AgentToolResult<LspToolDetails | undefined>;

let sharedLspParameters: TUnsafe<LspToolInput> | undefined;
let shutdownUpstream: (() => Promise<void>) | undefined;

function toPiLspResult(result: UpstreamLspResult): LspResult {
  return {
    ...result,
    details: result.details,
    isError: result.isError === true || result.details?.success === false,
  };
}

/** Upstream metadata and the bound executor carried by every {@link LspTool}. */
interface LspToolFields {
  readonly name: UpstreamLspTool["name"];
  readonly label: UpstreamLspTool["label"];
  readonly description: string;
  /** Plain JSON Schema converted once from upstream's schema and shared by all tools. */
  readonly parameters: TUnsafe<LspToolInput>;
  /**
   * Run one upstream `lsp` action. Bound to its tool, so a host may extract
   * or copy it.
   *
   * @param toolCallId Identifier of the tool call.
   * @param params Upstream action arguments; see {@link LspToolInput}.
   * @param signal Aborts the request; aborts and upstream exceptions propagate unchanged.
   * @param onUpdate Receives partial results, flagged `isError` on semantic failure.
   * @returns The successful upstream result.
   * @throws {Error} On semantic failure, with the upstream text as message and
   *   the original upstream result as `cause`.
   */
  readonly execute: (
    toolCallId: string,
    params: LspToolInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<LspToolDetails | undefined>,
  ) => Promise<LspResult>;
}

/**
 * The oh-my-pi `lsp` tool (from the npm `@oh-my-pi/pi-coding-agent` package)
 * as an Earendil Pi {@link AgentTool}, passed directly in any existing
 * `tools` array.
 *
 * - Requires Bun >=1.3.14 to create and run; importing this module under Node
 *   is safe, but {@link LspTool.create} rejects there.
 * - Language-server binaries are installed by the caller and discovered by
 *   upstream configuration (`lsp.json`, defaults, PATH); nothing is installed.
 * - Runs with upstream host filesystem and process behavior: it does **not**
 *   go through marsh's sandbox or hashline provenance, and is not part of
 *   `ToolCollection` or the Pi extension registration.
 * - Semantic failures (upstream `isError` or `details.success === false`)
 *   reject with the upstream text; the original result is `Error.cause`.
 * - Language-server clients are process-wide; release them with
 *   {@link LspTool.shutdown} once every LSP-using agent has drained.
 *
 * @example
 * ```ts
 * import { LspTool } from "junco-tools";
 *
 * const lsp = await LspTool.create(process.cwd());
 * try {
 *   const status = await lsp.execute("status-1", { action: "status" });
 *   console.log(status.content);
 *   const definition = await lsp.execute("definition-1", {
 *     action: "definition",
 *     file: "src/index.ts",
 *     line: 12, // one-based
 *     symbol: "createAgent",
 *   });
 *   console.log(definition.content);
 *   // Or pass it to an agent (junco-agent): JuncoAgent.fromResolved({ ...options, tools: [lsp] })
 * } finally {
 *   await LspTool.shutdown();
 * }
 * ```
 */
export type LspTool = AgentTool<
  TUnsafe<LspToolInput>,
  LspToolDetails | undefined
> &
  LspToolFields &
  Pick<
    UpstreamLspTool,
    "summary" | "loadMode" | "strict" | "approval" | "formatApprovalDetails"
  >;

/** Creates {@link LspTool}s and releases their process-wide language-server clients. */
export const LspTool = {
  /**
   * Create a headless upstream `lsp` tool rooted at `cwd`.
   *
   * @param cwd Workspace directory, resolved against `process.cwd()`. It is
   *   not created or validated here; upstream execution reports path failures.
   * @param options See {@link LspToolOptions}.
   * @returns A Pi `AgentTool` delegating to upstream oh-my-pi.
   * @throws {Error} `LspTool requires Bun >=1.3.14` when not running under Bun.
   */
  async create(cwd: string, options: LspToolOptions = {}): Promise<LspTool> {
    if (!("Bun" in globalThis)) {
      throw new Error("LspTool requires Bun >=1.3.14");
    }
    const resolvedCwd = resolveToolPath(process.cwd(), cwd);
    // Dynamic by design: OMP ships Bun-only TypeScript sources, so a static
    // import would make `import { LspTool }` fail under Node at module load.
    const [{ LspTool: Upstream }, { Settings }, { shutdownAll }] =
      await Promise.all([
        import("@oh-my-pi/pi-coding-agent/lsp"),
        import("@oh-my-pi/pi-coding-agent/config/settings"),
        import("@oh-my-pi/pi-coding-agent/lsp/client"),
      ]);
    shutdownUpstream = shutdownAll;
    const delegate = new Upstream({
      cwd: resolvedCwd,
      hasUI: false,
      getSessionFile: () => null,
      getSessionSpawns: () => null,
      settings: Settings.isolated(),
      enableLsp: true,
      lspReadOnly: options.readOnly,
    } satisfies ToolSession);
    sharedLspParameters ??= Type.Unsafe<LspToolInput>(
      delegate.parameters.toJsonSchema(),
    );
    return {
      name: delegate.name,
      label: delegate.label,
      description: delegate.description,
      summary: delegate.summary,
      loadMode: delegate.loadMode,
      strict: delegate.strict,
      approval: delegate.approval,
      formatApprovalDetails: delegate.formatApprovalDetails,
      parameters: sharedLspParameters,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const result = await delegate.execute(
          toolCallId,
          params,
          signal,
          onUpdate && ((partial) => onUpdate(toPiLspResult(partial))),
        );
        const converted = toPiLspResult(result);
        if (converted.isError) {
          throw new Error(contentText(result.content, "\n"), { cause: result });
        }
        return converted;
      },
    };
  },

  /**
   * Shut down every language-server client started by any `LspTool` in this
   * process (upstream's global client registry). Call only after all
   * LSP-using agents and calls have drained, not per agent disposal.
   * Resolves immediately when no tool was ever created.
   *
   * @returns Resolves once upstream shutdown completes.
   */
  async shutdown(): Promise<void> {
    await shutdownUpstream?.();
  },
};
