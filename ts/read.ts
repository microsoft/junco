import { isUtf8 } from "node:buffer";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createReadTool as createPiReadTool,
  createReadToolDefinition as createPiReadToolDefinition,
  type ExtensionContext,
  type ReadOperations,
  type ReadToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EditStore, NativeMux } from "../native/index.js";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "./mime.js";
import type { NativeModule } from "./native.js";
import { displayToolPath, normalizeEditableText, throwIfAborted } from "./tool-support.js";

/** pi-edit refuses to snapshot anything larger; do not number what it will not anchor. */
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const HASHLINE_NOTE =
  "Eligible UTF-8 text files up to 4 MiB include [path#TAG] and N:text rows for the hashline edit tool.";

/**
 * Private control-flow marker: the captured bytes cannot back a hashline
 * snapshot (binary, invalid UTF-8, or oversized), so the call must fall back
 * to Pi's unmodified reader.
 */
class Unsnapshottable extends Error {
  constructor() {
    super("unsnapshottable");
    this.name = "Unsnapshottable";
  }
}

/**
 * The line numbers a returned read body actually displayed.
 *
 * Only complete `N:text` source rows grant provenance; Pi's continuation and
 * oversized-line notices must never be mistaken for seen content.
 */
function visibleLineNumbers(body: string): number[] {
  const lines: number[] = [];
  for (const row of body.split("\n")) {
    const separator = row.indexOf(":");
    if (separator <= 0) continue;
    const digits = row.slice(0, separator);
    if (!/^[0-9]+$/.test(digits)) continue;
    const lineNumber = Number(digits);
    if (Number.isSafeInteger(lineNumber) && lineNumber > 0) lines.push(lineNumber);
  }
  return lines;
}

/**
 * Pi's read tool, with snapshot-anchored hashline output.
 *
 * Eligible text is renumbered into `N:text` rows and tagged `[path#TAG]`, and
 * the exact editable view behind that tag is recorded in `store` so the
 * hashline edit tool can verify both content and provenance. Images, binary,
 * invalid UTF-8, and oversized files fall through to Pi's reader over the same
 * bytes. Every byte comes from `mux` as a routed marsh read of the seed.
 *
 * The runtime context is optional: Pi's SDK passes one (its model drives the
 * non-vision image notice), while a bare Agent calls with four arguments and
 * gets Pi's context-free reader behavior.
 */
export function createReadTool(
  cwd: string,
  store: EditStore,
  native: NativeModule,
  mux: NativeMux,
): AgentTool<ReturnType<typeof createPiReadTool>["parameters"], ReadToolDetails | undefined> {
  const fallback = createPiReadToolDefinition(cwd);
  const tool = {
    ...fallback,
    description: `${fallback.description} ${HASHLINE_NOTE}`,
    async execute(toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) {
      throwIfAborted(signal);
      // Pi probes, sniffs, and reads the same path: one routed read serves them all.
      const loads = new Map<string, Promise<Buffer>>();
      const load = (absolutePath: string): Promise<Buffer> => {
        let loading = loads.get(absolutePath);
        if (!loading) {
          loading = mux.readFile(cwd, absolutePath);
          loads.set(absolutePath, loading);
        }
        return loading;
      };
      const access = async (absolutePath: string): Promise<void> => {
        throwIfAborted(signal);
        await load(absolutePath);
      };
      let captured: { absolutePath: string; view: string } | undefined;
      // Built per call: the operations close over this call's signal and
      // capture slot, so concurrent reads never observe each other's state.
      const numbered = createPiReadTool(cwd, {
        operations: {
          access,
          async readFile(absolutePath) {
            throwIfAborted(signal);
            const raw = await load(absolutePath);
            throwIfAborted(signal);
            if (raw.byteLength > SNAPSHOT_MAX_BYTES || raw.includes(0) || !isUtf8(raw)) {
              throw new Unsnapshottable();
            }
            const text = raw.toString("utf-8");
            const view = /\.ipynb$/i.test(absolutePath)
              ? native.notebookToEditableText(text, displayToolPath(cwd, absolutePath))
              : normalizeEditableText(text);
            captured = { absolutePath, view };
            // A terminal LF closes the last line; numbering it would invent an
            // addressable empty line the editable view does not have.
            const display = view.endsWith("\n") ? view.slice(0, -1) : view;
            return Buffer.from(native.hashlineFormatNumberedLines(display, 1), "utf-8");
          },
          // `detectImageMimeType` is intentionally absent: this branch only
          // ever produces numbered text, and images go to the fallback.
        },
      });

      let result;
      try {
        // The inner factory gets no signal: its immediate-abort wrapper could
        // otherwise settle while this read is still capturing a snapshot.
        result = await numbered.execute(toolCallId, params, undefined, onUpdate);
      } catch (error) {
        if (error instanceof Unsnapshottable) {
          // Pi's unmodified reader, over the bytes this call already loaded.
          const operations: ReadOperations = {
            access,
            readFile: load,
            detectImageMimeType: async (absolutePath) =>
              detectSupportedImageMimeType((await load(absolutePath)).subarray(0, IMAGE_TYPE_SNIFF_BYTES)),
          };
          if (ctx !== undefined) {
            return createPiReadToolDefinition(cwd, { operations }).execute(
              toolCallId,
              params,
              signal,
              onUpdate,
              ctx,
            );
          }
          return createPiReadTool(cwd, { operations }).execute(toolCallId, params, signal, onUpdate);
        }
        throw error;
      }
      throwIfAborted(signal);
      if (!captured) return result;

      const body = result.content.find((part) => part.type === "text");
      if (!body) return result;
      const seen = visibleLineNumbers(body.text);
      // No complete source row means nothing was displayed to anchor against.
      if (seen.length === 0) return result;

      const tag = store.recordSnapshot(captured.absolutePath, captured.view, seen);
      const header = native.hashlineFormatHeader(
        displayToolPath(cwd, captured.absolutePath),
        tag,
      );
      return {
        ...result,
        content: result.content.map((part) =>
          part === body ? { ...part, text: `${header}\n${part.text}` } : part,
        ),
      };
    },
  } satisfies ToolDefinition<ReturnType<typeof createPiReadTool>["parameters"], ReadToolDetails | undefined>;
  return tool;
}
