import { access } from "node:fs/promises";
import { resolve as resolveNodePath } from "node:path";
import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NativeModule } from "./native.js";
import { requireU32, throwIfAborted, withNativeSignal } from "./tool-support.js";

/**
 * Pi's find tool backed by the native walker.
 *
 * `FindOperations.glob` is Pi's supported substitution point, so the tool keeps
 * its schema, relativization, limits, and renderers while never spawning or
 * downloading `fd`. `fileType` stays unset so matching directories and symlinks
 * remain discoverable exactly as Pi's `fd` path leaves them.
 */
export function createNativeFindToolDefinition(
  cwd: string,
  native: NativeModule,
): ReturnType<typeof createFindToolDefinition> {
  const base = createFindToolDefinition(cwd);
  return {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      throwIfAborted(signal);
      if (params.limit !== undefined) requireU32("limit", params.limit, 1);
      // Built per call so concurrent invocations never share a mutable signal.
      const scoped = createFindToolDefinition(cwd, {
        operations: {
          async exists(absolutePath) {
            throwIfAborted(signal);
            try {
              await access(absolutePath);
              return true;
            } catch {
              return false;
            }
          },
          async glob(pattern, root, options) {
            throwIfAborted(signal);
            const result = await withNativeSignal(signal, (nativeSignal) =>
              native.glob({
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
            return result.matches.map((match) => resolveNodePath(root, match.path));
          },
        },
      });
      // No signal for the inner factory: its immediate-abort wrapper would
      // otherwise settle the call while a native worker is still draining.
      return scoped.execute(toolCallId, params, undefined, onUpdate, ctx);
    },
  };
}
