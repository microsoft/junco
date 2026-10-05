import {
  type ExtensionAPI,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ToolCollection } from "./collection.js";

export default function extension(pi: ExtensionAPI): void {
  // The collection holds a lease on the process's one ShellMux; session shutdown closes only
  // the collection. The containing process owns the final shutdownShellMux().
  let collection: ToolCollection | undefined;
  pi.on("session_start", async (_event, ctx) => {
    await collection?.close();
    const commandPrefix = SettingsManager.create(
      ctx.cwd,
    ).getShellCommandPrefix();
    // Same-name definitions (read, bash, edit, grep, find) replace the
    // built-ins; write, ls, and user_bash stay untouched.
    collection = await ToolCollection.create(ctx.cwd, {
      principal: `pi-${ctx.sessionManager.getSessionId()}`,
      bash: { commandPrefix },
    });
    for (const tool of collection.tools) pi.registerTool(tool);
  });
  pi.on("session_shutdown", async () => {
    await collection?.close();
    collection = undefined;
  });
}
