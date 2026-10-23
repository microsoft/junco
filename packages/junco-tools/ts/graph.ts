import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { NativeMux } from "../native/index.js";
import type { NativeModule } from "./native.js";
import {
  type BoundedToolDetails,
  boundedToolResult,
  requireU32,
  resolveToolPath,
  throwIfAborted,
  withNativeSignal,
} from "./tool-support.js";

export type GraphNodeKind =
  | "file"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "module"
  | "constant"
  | "field"
  | "macro";
export type GraphRelation =
  | "contains"
  | "calls"
  | "imports"
  | "references"
  | "implements"
  | "extends";

export interface GraphNode {
  id: string;
  name: string;
  kind: GraphNodeKind;
  path: string;
  owner: string | null;
  start_line: number;
  end_line: number;
  signature: string;
  exported: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: GraphRelation;
  confidence: "extracted" | "inferred";
}

export interface GraphSearchResult {
  hits: {
    node: GraphNode;
    score: number;
    in_degree: number;
    out_degree: number;
  }[];
  total_candidates: number;
}

export interface GraphDependencyResult {
  seed: GraphNode;
  nodes: { node: GraphNode; depth: number }[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface GraphHub {
  id: string;
  name: string;
  kind: GraphNodeKind;
  path: string;
  start_line: number;
  in_degree: number;
}

export interface GraphMapResult {
  files: number;
  symbols: number;
  edges: number;
  languages: string[];
  clusters: {
    dir: string;
    files: number;
    symbols: number;
    languages: string[];
    hubs: GraphHub[];
  }[];
  hotspots: GraphHub[];
}

const KINDS: GraphNodeKind[] = [
  "file",
  "function",
  "method",
  "class",
  "interface",
  "type",
  "module",
  "constant",
  "field",
  "macro",
];
const RELATIONS: GraphRelation[] = [
  "calls",
  "imports",
  "references",
  "implements",
  "extends",
  "contains",
];

const rootSchema = Type.Optional(
  Type.String({
    description: "Repository root (default: current directory)",
  }),
);

export type CodeGraphAction = "map" | "search" | "deps";
export type CodeGraphResult =
  | GraphMapResult
  | GraphSearchResult
  | GraphDependencyResult;

const ACTIONS: CodeGraphAction[] = ["map", "search", "deps"];

const codeGraphSchema = Type.Object({
  action: Type.Union(
    ACTIONS.map((a) => Type.Literal(a)),
    {
      description:
        "map = orient (directory clusters, hubs, hotspots); search = rank symbols and files by words; deps = walk callers/callees/importers/heritage of one symbol or file",
    },
  ),
  path: rootSchema,
  query: Type.Optional(
    Type.String({
      description: "search: words, identifiers, or a path fragment",
    }),
  ),
  kinds: Type.Optional(
    Type.Array(Type.Union(KINDS.map((k) => Type.Literal(k))), {
      description: "search: keep only these node kinds",
    }),
  ),
  pathPrefix: Type.Optional(
    Type.String({
      description: "search: keep nodes under this root-relative path",
    }),
  ),
  lang: Type.Optional(
    Type.String({ description: "search: language name or alias" }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: "search: maximum hits (default: 10)",
    }),
  ),
  symbol: Type.Optional(
    Type.String({
      description:
        "deps: symbol name, node id (path#Owner.name:line), or file path",
    }),
  ),
  symbolPath: Type.Optional(
    Type.String({
      description: "deps: root-relative file that disambiguates symbol",
    }),
  ),
  direction: Type.Optional(
    Type.Union(
      [Type.Literal("in"), Type.Literal("out"), Type.Literal("both")],
      {
        description:
          "deps: in = who depends on it, out = what it depends on (default: in)",
      },
    ),
  ),
  depth: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "deps: hops to follow (default: 1)",
    }),
  ),
  relations: Type.Optional(
    Type.Array(Type.Union(RELATIONS.map((r) => Type.Literal(r))), {
      description: "deps: edge kinds to follow (default: all but contains)",
    }),
  ),
});

/** The deterministic tree-sitter code graph as one routed read on `mux`; the index builds on first use and refreshes on every call. */
export const CodeGraphTool = {
  create(
    cwd: string,
    _native: NativeModule,
    mux: NativeMux,
  ): AgentTool<typeof codeGraphSchema, BoundedToolDetails<CodeGraphResult>> {
    const tool = {
      name: "code_graph",
      label: "Code Graph",
      description:
        'Deterministic tree-sitter code graph of a repository (symbols, calls, imports, heritage); it indexes on first use and re-parses only changed files on every call, so there is no setup step. action=map: directory clusters, hubs and hotspots for orientation. action=search: rank symbols and files by words (BM25 over name, path, signature; exact-name and in-degree boosts). action=deps: callers/callees/importers/heritage of one symbol or file to a depth; in = who depends on it (impact radius), out = what it depends on; a file path with relations ["contains"] and direction out lists that file\'s definitions.',
      promptSnippet:
        "Map a repo, find symbols, trace callers via the code graph",
      parameters: codeGraphSchema,
      async execute(_toolCallId, params, signal) {
        if (params.action === "search") {
          if ((params.query ?? "").trim() === "")
            throw new Error("search requires query");
          if (params.limit !== undefined) requireU32("limit", params.limit, 1);
        } else if (params.action === "deps") {
          if ((params.symbol ?? "").trim() === "")
            throw new Error("deps requires symbol");
          if (params.depth !== undefined) requireU32("depth", params.depth, 1);
        }
        throwIfAborted(signal);
        const json = await withNativeSignal(signal, (nativeSignal) =>
          mux.graph(cwd, {
            ...params,
            path: resolveToolPath(cwd, params.path ?? "."),
            signal: nativeSignal,
          }),
        );
        throwIfAborted(signal);
        return boundedToolResult(json, JSON.parse(json) as CodeGraphResult);
      },
    } satisfies ToolDefinition<
      typeof codeGraphSchema,
      BoundedToolDetails<CodeGraphResult>
    >;
    return tool;
  },
};
