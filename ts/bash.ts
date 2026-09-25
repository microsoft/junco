import {
  createBashTool as createPiBashTool,
  createBashToolDefinition as createPiBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createShellMuxOperations } from "./operations.js";

/**
 * Pi's bash tool, running through marsh ShellMux unless the caller supplies
 * its own operations.
 *
 * The upstream AgentTool contributes the four-argument executor; the upstream
 * definition object it is merged into keeps Pi's renderers and prompt metadata,
 * so the same object serves a bare Agent and Pi registration. Both factories
 * receive one options object, so they share a single operations owner.
 */
export const createBashTool: typeof createPiBashTool = (cwd, options) => {
  const resolvedOptions = {
    ...options,
    operations: options?.operations ?? createShellMuxOperations(),
  };
  return Object.assign(
    createPiBashToolDefinition(cwd, resolvedOptions),
    createPiBashTool(cwd, resolvedOptions),
  );
};
