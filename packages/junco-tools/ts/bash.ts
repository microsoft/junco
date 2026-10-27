import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type BashToolOptions,
  createBashTool as createPiBashTool,
  createBashToolDefinition as createPiBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";

const BASH = {
  resource: "memory",
  category: "bash",
  tool: "bash",
  operation: "execute",
} as const;

/**
 * Pi's bash tool over caller-supplied operations, normally a ShellMux operations owner the
 * caller closes. Missing operations are refused before either Pi factory runs, so the tool can
 * never fall back to host bash.
 *
 * The upstream AgentTool contributes the four-argument executor; the upstream
 * definition object it is merged into keeps Pi's renderers and prompt metadata,
 * so the same object serves a bare Agent and Pi registration. Both factories
 * receive one options object, so they share a single operations owner.
 *
 * Each call records as `bash` in `recorder` (or the invocation's); Pi's nonzero-exit result
 * counts as an error.
 */
export const BashTool = {
  create(
    cwd: string,
    options: BashToolOptions & {
      operations: NonNullable<BashToolOptions["operations"]>;
    },
    recorder?:
      | ProfileRecorder<"memory">
      | (() => ProfileRecorder<"memory"> | undefined),
  ): AgentTool {
    // Guards JavaScript callers the type cannot.
    if (options?.operations === undefined) {
      throw new TypeError("BashTool.create: options.operations is required");
    }
    const tool = Object.assign(
      createPiBashToolDefinition(cwd, options),
      createPiBashTool(cwd, options),
    );
    const { execute } = tool;
    tool.execute = (toolCallId, params, signal, onUpdate) =>
      profileToolCall(captureRecorder(recorder), BASH, signal, () =>
        execute(toolCallId, params, signal, onUpdate),
      );
    return markProfileOwned(tool, () => BASH);
  },
};
