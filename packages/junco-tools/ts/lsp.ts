import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { type TUnsafe, Type } from "typebox";
import type { NativeMux } from "../native/index.js";
import type { NativeModule } from "./native.js";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import { resolveToolPath, throwIfAborted } from "./tool-support.js";

const ACTIONS = [
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
  "status",
  "reload",
  "capabilities",
  "request",
] as const;
const READ_ACTIONS = new Set<string>([
  "diagnostics",
  "definition",
  "references",
  "hover",
  "symbols",
  "type_definition",
  "implementation",
  "status",
  "capabilities",
]);

/** Arguments for native LSP actions. Lines are one-based; timeouts are in seconds. */
export interface LspToolInput {
  action: (typeof ACTIONS)[number];
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  new_name?: string;
  apply?: boolean;
  timeout?: number;
  payload?: string;
}

/** Structured details accompanying an authorized LSP result. */
export interface LspToolDetails {
  serverName?: string;
  action: LspToolInput["action"];
  success: boolean;
  request?: LspToolInput;
}

/** Options for {@link LspTool.create}. Inject the same addon that created `mux`. */
export interface LspToolOptions {
  /** Reject write-tier actions before server contact; not a filesystem capability boundary. */
  readonly readOnly?: boolean;
  /** Host approval to execute workspace code, including repo config and local bins. Default false; never take approval from repo files or model input. */
  readonly trustedWorkspace?: boolean;
  /** Borrow this owner-bound mux's policy, environment and resource configuration. */
  readonly mux?: NativeMux;
  readonly native?: NativeModule;
}

const parameters: TUnsafe<LspToolInput> = Type.Unsafe<LspToolInput>(
  Type.Object({
    action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    symbol: Type.Optional(Type.String()),
    query: Type.Optional(Type.String()),
    new_name: Type.Optional(Type.String()),
    apply: Type.Optional(Type.Boolean()),
    timeout: Type.Optional(Type.Number({ minimum: 5, maximum: 300 })),
    payload: Type.Optional(Type.String()),
  }),
);
const bindings = new Set<NativeModule>();
type LspResult = AgentToolResult<LspToolDetails | undefined>;

/**
 * Native Rust LSP tool for Node and Bun. Importing the package does not load the addon.
 * The cwd constructor uses marsh's default LockPolicy; an optional owner-bound mux
 * shares its selected policy and resources. Results and semantic errors are released
 * only after policy authorization/publication. Observed workspace mutations retire
 * servers before another call; marsh is not whole-host filesystem confinement.
 * Install language-server binaries separately. This tool is opt-in, not part of
 * ToolCollection or the Pi extension's default registration.
 */
export type LspTool = AgentTool<
  TUnsafe<LspToolInput>,
  LspToolDetails | undefined
> & {
  readonly name: "lsp";
  readonly label: "LSP";
  readonly summary: string;
  readonly loadMode: "discoverable";
  readonly strict: true;
  readonly approval: (args: unknown) => "read" | "write";
  readonly formatApprovalDetails: (args: unknown) => string[];
  /** Extractable executor. Semantic failures reject with the Pi result as Error.cause. */
  readonly execute: (
    toolCallId: string,
    params: LspToolInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<LspToolDetails | undefined>,
  ) => Promise<LspResult>;
};

export const LspTool = {
  /** Open a native tool rooted at cwd, resolved against process.cwd(). */
  async create(
    cwd: string,
    options: LspToolOptions = {},
    recorder?:
      | ProfileRecorder<"operations">
      | (() => ProfileRecorder<"operations"> | undefined),
  ): Promise<LspTool> {
    const native = options.native ?? (await import("junco-tools/native"));
    bindings.add(native);
    const handle = await native.NativeLsp.open(
      resolveToolPath(process.cwd(), cwd),
      {
        readOnly: options.readOnly,
        trustedWorkspace: options.trustedWorkspace,
      },
      options.mux,
    );
    const describe = (args: unknown) => {
      const action = (args as { action?: unknown } | null | undefined)?.action;
      return {
        resource: "operations",
        category: "lsp",
        tool: "lsp",
        operation:
          typeof action === "string" &&
          ACTIONS.some((value) => value === action)
            ? action
            : "invalid",
      } as const;
    };
    const tool: LspTool = {
      name: "lsp",
      label: "LSP",
      description:
        "Query language servers for diagnostics, navigation, symbols, refactoring, and raw requests.",
      summary:
        "Query LSP (language server) for diagnostics, hover info, and references",
      loadMode: "discoverable",
      strict: true,
      approval: (args) => {
        const action = (args as Partial<LspToolInput> | null)?.action;
        return typeof action === "string" &&
          READ_ACTIONS.has(action.toLowerCase())
          ? "read"
          : "write";
      },
      formatApprovalDetails: (args) => {
        const params = args as Partial<LspToolInput> | null;
        const lines = [
          `Action: ${typeof params?.action === "string" ? params.action : "(missing)"}`,
        ];
        if (typeof params?.file === "string" && params.file.length > 0)
          lines.push(`File: ${params.file}`);
        return lines;
      },
      parameters,
      execute: (_toolCallId, params, signal, _onUpdate) =>
        profileToolCall(
          captureRecorder(recorder),
          describe(params),
          signal,
          async () => {
            throwIfAborted(signal);
            const call = handle.start(params);
            const abort = () => call.abort();
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            try {
              const result = await call.wait();
              const converted = {
                content: [{ type: "text" as const, text: result.text }],
                details: {
                  ...result.details,
                  ...(result.details.request == null
                    ? {}
                    : { request: params }),
                },
                isError: result.isError || result.details.success === false,
                ...(result.useless == null ? {} : { useless: result.useless }),
              };
              if (converted.isError) {
                throw new Error(contentText(converted.content, "\n"), {
                  cause: converted,
                });
              }
              return converted;
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          },
        ),
    };
    return markProfileOwned(tool, describe);
  },

  /** Drain all native LSP instances, including injected addons. Repeatable; later opens work. */
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...bindings].map((native) => native.NativeLsp.shutdownAll()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "LSP shutdown failed");
  },
};
