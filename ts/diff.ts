import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DiffStreamResult } from "../native/index.js";
import type { NativeModule } from "./native.js";
import {
  type BoundedToolDetails,
  boundedToolResult,
  NATIVE_U32_MAX,
  requireU32,
  throwIfAborted,
} from "./tool-support.js";

const diffSchema = Type.Object({
  oldText: Type.String({ description: "Original text" }),
  newText: Type.String({ description: "Updated text" }),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: NATIVE_U32_MAX,
      description: "Context lines around each hunk (default: 4)",
    }),
  ),
});

/**
 * Unified diff between two in-memory texts, computed by pi-diff's exact Myers
 * implementation over JavaScript's own UTF-16 code units. Touches no files.
 */
export function createDiffToolDefinition(
  native: NativeModule,
): ToolDefinition<typeof diffSchema, BoundedToolDetails<DiffStreamResult>> {
  return {
    name: "diff",
    label: "Diff",
    description: "Compute a unified diff between oldText and newText without changing files.",
    promptSnippet: "Diff two texts without touching the filesystem",
    parameters: diffSchema,
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      if (params.context !== undefined) requireU32("context", params.context, 0);

      const stream = new native.DiffStream();
      stream.push(native.DiffSide.Old, params.oldText);
      stream.push(native.DiffSide.New, params.newText);
      stream.finishSide(native.DiffSide.Old);
      stream.finishSide(native.DiffSide.New);
      // Myers has no internal interruption point, so the worker is always
      // awaited to completion; cancellation is reported after it settles.
      const result = await stream.finish(params.context);
      throwIfAborted(signal);

      if (result.hunks.length === 0) {
        return { content: [{ type: "text", text: "No differences." }], details: { result } };
      }
      const lines = ["--- before", "+++ after"];
      for (const hunk of result.hunks) {
        lines.push(
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          ...hunk.lines,
        );
      }
      return boundedToolResult(lines.join("\n"), result);
    },
  };
}
