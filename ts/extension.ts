import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolCollection } from "./collection.js";
import { createShellMuxOperations, shutdownShellMux } from "./operations.js";

export default function extension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    // ts/operations.ts owns the actual default-owner set; a second registry here would
    // only be a stale copy of it.
    const operations = createShellMuxOperations({
      principal: `pi-${ctx.sessionManager.getSessionId()}`,
    });
    const commandPrefix = SettingsManager.create(ctx.cwd).getShellCommandPrefix();
    // Same-name definitions (read, bash, edit, grep, find) replace the
    // built-ins; write, ls, and user_bash stay untouched.
    const collection = await ToolCollection.create(ctx.cwd, { bash: { operations, commandPrefix } });
    for (const tool of collection.tools) pi.registerTool(tool);
  });
  pi.on("session_shutdown", async () => {
    await shutdownShellMux();
  });
}
