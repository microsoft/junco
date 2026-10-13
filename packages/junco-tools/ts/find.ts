import { resolve as resolveNodePath } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createFindTool as createPiFindTool,
  createFindToolDefinition as createPiFindToolDefinition,
  type FindToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { NativeMux } from "../native/index.js";
import type { NativeModule } from "./native.js";
import {
  requireU32,
  throwIfAborted,
  withNativeSignal,
} from "./tool-support.js";

/**
 * Pi's find tool backed by the native walker.
 *
 * `FindOperations.glob` is Pi's supported substitution point, so the tool keeps
 * its schema, relativization, limits, and renderers while never spawning or
 * downloading `fd`. `fileType` stays unset so matching directories and symlinks
 * remain discoverable exactly as Pi's `fd` path leaves them. The existence
 * probe and the walk are routed marsh reads through `mux`, which `native`
 * created.
 */
export const FindTool = {
  create(
    cwd: string,
    native: NativeModule,
    mux: NativeMux,
  ): AgentTool<
    ReturnType<typeof createPiFindTool>["parameters"],
    FindToolDetails | undefined
  > {
    const base = createPiFindToolDefinition(cwd);
    const tool = {
      ...base,
      async execute(toolCallId, params, signal, onUpdate) {
        throwIfAborted(signal);
        if (params.limit !== undefined) requireU32("limit", params.limit, 1);
        // Built per call so concurrent invocations never share a mutable signal.
        const scoped = createPiFindTool(cwd, {
          operations: {
            async exists(absolutePath) {
              throwIfAborted(signal);
              return mux.exists(cwd, absolutePath);
            },
            async glob(pattern, root, options) {
              throwIfAborted(signal);
              const result = await withNativeSignal(signal, (nativeSignal) =>
                mux.glob(cwd, {
                  pattern,
                  path: root,
                  recursive: true,
                  hidden: true,
                  gitignore: true,
                  cache: false,
                  includeNodeModules: false,
                  maxResults: options.limit,
                  signal: nativeSignal,
                }),
              );
              // Pi's adapter relativizes against the search root, so hand it
              // absolute paths rather than the walker's root-relative ones.
              return result.matches.map((match) =>
                resolveNodePath(root, match.path),
              );
            },
          },
        });
        // No signal for the inner factory: its immediate-abort wrapper would
        // otherwise settle the call while a native worker is still draining.
        return scoped.execute(toolCallId, params, undefined, onUpdate);
      },
    } satisfies ToolDefinition<
      ReturnType<typeof createPiFindTool>["parameters"],
      FindToolDetails | undefined
    >;
    return tool;
  },
};
