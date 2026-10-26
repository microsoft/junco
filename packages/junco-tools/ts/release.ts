import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { NativeMux } from "../native/index.js";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import {
  displayToolPath,
  resolveToolPath,
  throwIfAborted,
} from "./tool-support.js";

const RELEASE = {
  resource: "operations",
  category: "release",
  tool: "release",
  operation: "execute",
} as const;

// Only an awaited native release resolves the call.
const releaseMetrics = () => ({ counters: { releases: 1 } });

const releaseSchema = Type.Object(
  {
    file: Type.String({
      minLength: 1,
      description:
        "The one file (or directory entry) to relinquish ownership of.",
    }),
  },
  { additionalProperties: false },
);

/**
 * Relinquishes the calling owner's ownership of one file, as one always-managed marsh call
 * through `mux`. Nothing is read or written; success means Marsh published the release. Releasing
 * a file another owner holds rejects as a policy denial; releasing an unowned file succeeds.
 */
export const ReleaseTool = {
  create(
    cwd: string,
    mux: NativeMux,
    recorder?:
      | ProfileRecorder<"operations">
      | (() => ProfileRecorder<"operations"> | undefined),
  ): AgentTool<typeof releaseSchema, undefined> {
    const tool = {
      name: "release",
      label: "Release",
      description:
        "Relinquish your ownership of one file you wrote, so other agents may edit it. Writing a file takes ownership; deleting it releases ownership automatically.",
      promptSnippet: "Relinquish ownership of a file you wrote",
      parameters: releaseSchema,
      executionMode: "sequential",
      execute(_toolCallId, { file }, signal) {
        return profileToolCall(
          captureRecorder(recorder),
          RELEASE,
          signal,
          async () => {
            throwIfAborted(signal);
            const absolutePath = resolveToolPath(cwd, file);
            await mux.release(cwd, absolutePath);
            return {
              content: [
                {
                  type: "text",
                  text: `Released ${displayToolPath(cwd, absolutePath)}`,
                },
              ],
              details: undefined,
            };
          },
          releaseMetrics,
        );
      },
    } satisfies ToolDefinition<typeof releaseSchema, undefined>;
    return markProfileOwned(tool, () => RELEASE);
  },
};
