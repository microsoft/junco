import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { createAstEditTool, createAstGrepTool } from "./ast.js";
import { createBashTool } from "./bash.js";
import { createDiffTool } from "./diff.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createReadTool } from "./read.js";
import { resolveToolPath } from "./tool-support.js";

export interface ToolCollectionOptions {
  bash?: BashToolOptions;
}

/**
 * A complete set of junco AgentTools backed by its native engines.
 *
 * One collection owns exactly one native `EditStore`, so `read`, `grep`, and
 * the hashline `edit` tool share snapshots, seen-line provenance, and clipboard
 * registers. `bash` keeps running through marsh; the file tools operate on the
 * ordinary filesystem at `cwd`, as Pi's own non-bash tools do.
 *
 * The returned `tools` come from the same factories exported standalone and
 * are directly usable as a bare Agent's tools, SDK `customTools`, or with
 * `pi.registerTool`. Construction opens no shell mux and requires no btrfs
 * seed; path-existence problems stay execute-time errors.
 */
export class ToolCollection {
  readonly tools: AgentTool<any>[];

  private constructor(tools: AgentTool<any>[]) {
    this.tools = tools;
  }

  static async create(cwd: string, options: ToolCollectionOptions = {}): Promise<ToolCollection> {
    const root = resolveToolPath(process.cwd(), cwd);
    // Dynamic by design: a static import would load the addon at module
    // evaluation, so `import { ToolCollection }` would fail before a caller
    // could report a missing or mismatched binary. `ts/operations.ts` defers
    // the same way. A load failure rejects here; there is no second backend.
    const native = await import("../native/index.js");
    const store = new native.EditStore();
    return new ToolCollection([
      createReadTool(root, store, native),
      createBashTool(root, options.bash),
      createEditTool(root, store, native),
      createGrepTool(root, store, native),
      createFindTool(root, native),
      createAstGrepTool(root, native),
      createAstEditTool(root, native),
      createDiffTool(native),
    ]);
  }
}
