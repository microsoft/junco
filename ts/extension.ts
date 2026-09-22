import {
  createBashToolDefinition,
  SettingsManager,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createShellMuxOperations, shutdownShellMux } from "./operations.js";

export default function extension(pi: ExtensionAPI): void {
  let operations: BashOperations | undefined;
  pi.on("session_start", (_event, ctx) => {
    operations = createShellMuxOperations({ principal: `pi-${ctx.sessionManager.getSessionId()}` });
    const commandPrefix = SettingsManager.create(ctx.cwd).getShellCommandPrefix();
    pi.registerTool(createBashToolDefinition(ctx.cwd, { operations, commandPrefix }));
  });
  pi.on("session_shutdown", async () => {
    try {
      await shutdownShellMux();
    } finally {
      operations = undefined;
    }
  });
}
