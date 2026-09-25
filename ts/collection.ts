import {
  defineTool,
  type BashToolOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAstEditToolDefinition, createAstGrepToolDefinition } from "./ast.js";
import { createBashToolDefinition } from "./bash.js";
import { createDiffToolDefinition } from "./diff.js";
import { createHashlineEditToolDefinition } from "./edit.js";
import { createNativeFindToolDefinition } from "./find.js";
import { createNativeGrepToolDefinition } from "./grep.js";
import { createHashlineReadToolDefinition } from "./read.js";
import { resolveToolPath } from "./tool-support.js";

export interface ToolCollectionOptions {
  bash?: BashToolOptions;
}

/**
 * A complete set of Pi tool definitions backed by junco's native engines.
 *
 * One collection owns exactly one native `EditStore`, so `read`, `grep`, and
 * the hashline `edit` tool share snapshots, seen-line provenance, and clipboard
 * registers. `bash` keeps running through marsh; the file tools operate on the
 * ordinary filesystem at `cwd`, as Pi's own non-bash tools do.
 *
 * The returned `tools` array is directly usable as SDK `customTools` or with
 * `pi.registerTool`. Construction opens no shell mux and requires no btrfs
 * seed; path-existence problems stay execute-time errors.
 */
export class ToolCollection {
  readonly tools: ToolDefinition[];

  private constructor(tools: ToolDefinition[]) {
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
      defineTool(createHashlineReadToolDefinition(root, store, native)),
      defineTool(createBashToolDefinition(root, options.bash)),
      defineTool(createHashlineEditToolDefinition(root, store, native)),
      defineTool(createNativeGrepToolDefinition(root, store, native)),
      defineTool(createNativeFindToolDefinition(root, native)),
      defineTool(createAstGrepToolDefinition(root, native)),
      defineTool(createAstEditToolDefinition(root, native)),
      defineTool(createDiffToolDefinition(native)),
    ]);
  }
}
