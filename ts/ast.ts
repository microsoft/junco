import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AstFindResult, AstMatchStrictness, AstReplaceResult } from "../native/index.js";
import type { NativeModule } from "./native.js";
import {
  type BoundedToolDetails,
  boundedToolResult,
  NATIVE_U32_MAX,
  requireU32,
  resolveToolPath,
  throwIfAborted,
  withNativeSignal,
} from "./tool-support.js";

const STRICTNESS_VALUES = ["cst", "smart", "ast", "relaxed", "signature", "template"] as const;

const strictnessSchema = Type.Optional(
  Type.Union(
    STRICTNESS_VALUES.map((value) => Type.Literal(value)),
    { description: "Pattern strictness; defaults to smart matching." },
  ),
);

const scopeSchema = {
  path: Type.Optional(
    Type.String({ description: "File or directory to scan (default: current directory)" }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Glob filter relative to the search root, e.g. '**/*.ts'" }),
  ),
  lang: Type.Optional(
    Type.String({ description: "Language override; otherwise inferred per file extension" }),
  ),
  selector: Type.Optional(
    Type.String({ description: "Rule selector for multi-rule ast-grep configurations" }),
  ),
  strictness: strictnessSchema,
};

const astGrepSchema = Type.Object({
  patterns: Type.Array(Type.String(), {
    description: "ast-grep patterns; a file matches when any pattern matches",
  }),
  ...scopeSchema,
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: NATIVE_U32_MAX, description: "Maximum matches (default: 50)" }),
  ),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, maximum: NATIVE_U32_MAX, description: "Matches to skip (default: 0)" }),
  ),
  includeMeta: Type.Optional(
    Type.Boolean({ description: "Include meta-variable bindings per match (default: false)" }),
  ),
});

const astEditSchema = Type.Object({
  rewrites: Type.Record(Type.String(), Type.String(), {
    description: "Map of ast-grep pattern to replacement template; an empty template deletes",
  }),
  ...scopeSchema,
  dryRun: Type.Optional(
    Type.Boolean({ description: "Preview without writing (default: true)" }),
  ),
  maxReplacements: Type.Optional(
    Type.Integer({ minimum: 1, maximum: NATIVE_U32_MAX, description: "Cap on applied replacements" }),
  ),
  maxFiles: Type.Optional(
    Type.Integer({ minimum: 1, maximum: NATIVE_U32_MAX, description: "Cap on modified files" }),
  ),
  failOnParseError: Type.Optional(
    Type.Boolean({ description: "Fail the run when a file cannot be parsed (default: false)" }),
  ),
});

/**
 * Structural search over files with ast-grep patterns.
 *
 * Match slices are spans, not full-line reads, so they intentionally grant no
 * hashline provenance: the model still needs `read` or `grep` for edit anchors.
 */
export function createAstGrepToolDefinition(
  cwd: string,
  native: NativeModule,
): ToolDefinition<typeof astGrepSchema, BoundedToolDetails<AstFindResult>> {
  return {
    name: "ast_grep",
    label: "AST Grep",
    description: "Search files with AST structural patterns; use read or grep for hashline edit anchors.",
    promptSnippet: "Search code by AST structure instead of text",
    parameters: astGrepSchema,
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const patterns = params.patterns.filter((pattern) => pattern.trim() !== "");
      if (patterns.length === 0) throw new Error("patterns must contain at least one pattern");
      if (params.limit !== undefined) requireU32("limit", params.limit, 1);
      if (params.offset !== undefined) requireU32("offset", params.offset, 0);

      const result = await withNativeSignal(signal, (nativeSignal) =>
        native.astGrep({
          patterns,
          path: resolveToolPath(cwd, params.path ?? "."),
          glob: params.glob,
          lang: params.lang,
          selector: params.selector,
          strictness: params.strictness as AstMatchStrictness | undefined,
          limit: params.limit,
          offset: params.offset,
          includeMeta: params.includeMeta,
          signal: nativeSignal,
        }),
      );
      throwIfAborted(signal);
      return boundedToolResult(JSON.stringify(result, null, 2), result);
    },
  };
}

/**
 * Structural rewrite of files with ast-grep patterns.
 *
 * Previews by default; only an explicit `dryRun: false` writes. There is no
 * proposal queue in this package, so an applying call mutates the filesystem
 * immediately and invalidates the walker's scan cache for the search root.
 */
export function createAstEditToolDefinition(
  cwd: string,
  native: NativeModule,
): ToolDefinition<typeof astEditSchema, BoundedToolDetails<AstReplaceResult>> {
  return {
    name: "ast_edit",
    label: "AST Edit",
    description: "Preview structural rewrites by default; set dryRun to false to apply them.",
    promptSnippet: "Rewrite code by AST structure",
    parameters: astEditSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const rewrites: Record<string, string> = {};
      for (const [pattern, replacement] of Object.entries(params.rewrites)) {
        if (pattern.trim() !== "") rewrites[pattern] = replacement;
      }
      if (Object.keys(rewrites).length === 0) {
        throw new Error("rewrites must contain at least one pattern");
      }
      if (params.maxReplacements !== undefined) requireU32("maxReplacements", params.maxReplacements, 1);
      if (params.maxFiles !== undefined) requireU32("maxFiles", params.maxFiles, 1);

      const root = resolveToolPath(cwd, params.path ?? ".");
      const applying = params.dryRun === false;
      let result: AstReplaceResult;
      try {
        result = await withNativeSignal(signal, (nativeSignal) =>
          native.astEdit({
            rewrites,
            path: root,
            glob: params.glob,
            lang: params.lang,
            selector: params.selector,
            strictness: params.strictness as AstMatchStrictness | undefined,
            dryRun: params.dryRun,
            maxReplacements: params.maxReplacements,
            maxFiles: params.maxFiles,
            failOnParseError: params.failOnParseError,
            signal: nativeSignal,
          }),
        );
      } finally {
        // Runs even on failure: a partially applied rewrite must not leave the
        // walker cache advertising pre-edit bytes.
        if (applying) native.invalidateFsScanCache(root);
      }
      throwIfAborted(signal);
      return boundedToolResult(JSON.stringify(result, null, 2), result);
    },
  };
}
