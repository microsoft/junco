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
  checkToolInput,
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

const RELEASE_OWNED = { ...RELEASE, operation: "owned" } as const;
const releaseOperation = (params: unknown) =>
  typeof params === "object" &&
  params !== null &&
  "owned" in params &&
  params.owned === true
    ? RELEASE_OWNED
    : RELEASE;

type ReleaseDetails = { released: string[] } | undefined;

// Only an awaited native release resolves the call.
const releaseMetrics = (result: { details: ReleaseDetails }) => ({
  counters: { releases: result.details?.released.length ?? 1 },
});

const releaseInput = Type.Union([
  Type.Object(
    {
      file: Type.String({
        minLength: 1,
        description:
          "The one file (or directory entry) to relinquish ownership of.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      owned: Type.Literal(true, {
        description:
          "Release every resource you currently own on this managed source, including generated and ignored files.",
      }),
    },
    { additionalProperties: false },
  ),
]);

// Providers that rebuild object schemas need visible properties; dispatch still validates the union.
const releaseSchema = Type.Object(
  {
    file: Type.Optional(releaseInput.anyOf[0].properties.file),
    owned: Type.Optional(releaseInput.anyOf[1].properties.owned),
  },
  { additionalProperties: false, anyOf: releaseInput.anyOf },
);

/**
 * Relinquishes the calling owner's ownership of one exact file, or explicitly all its currently
 * owned resources, as one always-managed marsh call through `mux`. Nothing is read or written;
 * success means Marsh published the release. Foreign ownership and read freshness are unchanged.
 */
export const ReleaseTool = {
  create(
    cwd: string,
    mux: NativeMux,
    recorder?:
      | ProfileRecorder<"operations">
      | (() => ProfileRecorder<"operations"> | undefined),
  ): AgentTool<typeof releaseSchema, ReleaseDetails> {
    const tool = {
      name: "release",
      label: "Release",
      description:
        'Choose exactly one selector: {file:"path"} releases one exact entry; {owned:true} releases all resources you currently own. Never send file and owned together. Writing takes ownership; deleting releases it automatically. Bulk release includes generated and ignored files but never another owner\'s files or freshens their reads.',
      promptSnippet:
        "Relinquish one file's ownership or explicitly all your ownership",
      parameters: releaseSchema,
      executionMode: "sequential",
      execute(_toolCallId, params, signal) {
        return profileToolCall(
          captureRecorder(recorder),
          releaseOperation(params),
          signal,
          async () => {
            throwIfAborted(signal);
            if (
              typeof params === "object" &&
              params !== null &&
              "file" in params &&
              "owned" in params
            )
              throw new TypeError(
                'release requires exactly one selector: {file:"path"} OR {owned:true}; omit the other field',
              );
            const input = checkToolInput("release", releaseInput, params);
            if ("owned" in input) {
              const released = await mux.releaseOwned(cwd);
              return {
                content: [
                  {
                    type: "text",
                    text: `Released ${released.length} owned resources: ${JSON.stringify(released)}`,
                  },
                ],
                details: { released },
              };
            }
            const { file } = input;
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
    } satisfies ToolDefinition<typeof releaseSchema, ReleaseDetails>;
    return markProfileOwned(tool, releaseOperation);
  },
};
