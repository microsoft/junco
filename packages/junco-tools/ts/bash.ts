import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type BashToolOptions,
  createBashTool as createPiBashTool,
  createBashToolDefinition as createPiBashToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi's bash tool over caller-supplied operations, normally a ShellMux operations owner the
 * caller closes. Missing operations are refused before either Pi factory runs, so the tool can
 * never fall back to host bash.
 *
 * The upstream AgentTool contributes the four-argument executor; the upstream
 * definition object it is merged into keeps Pi's renderers and prompt metadata,
 * so the same object serves a bare Agent and Pi registration. Both factories
 * receive one options object, so they share a single operations owner.
 */
export function createBashTool(
  cwd: string,
  options: BashToolOptions & {
    operations: NonNullable<BashToolOptions["operations"]>;
  },
): AgentTool<any> {
  // Guards JavaScript callers the type cannot.
  if (options?.operations === undefined) {
    throw new TypeError("createBashTool: options.operations is required");
  }
  return Object.assign(
    createPiBashToolDefinition(cwd, options),
    createPiBashTool(cwd, options),
  );
}
