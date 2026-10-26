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
export type GraphClusterView = "list" | "members" | "neighbors";

export interface GraphClusterSummary {
  id: string;
  top: string;
  weight: number;
  library: boolean;
  file_count: number;
  sample_files: string[];
}

export interface GraphClusterMatch {
  cluster: GraphClusterSummary;
  matching_files: number;
  contained: boolean;
}

export interface GraphClusterEdge {
  from: string;
  to: string;
  edges: number;
  targets: number;
}

export interface GraphClusterNeighbor {
  cluster: GraphClusterSummary;
  incoming: GraphClusterEdge | null;
  outgoing: GraphClusterEdge | null;
}

export type GraphClusterResult = {
  k: number;
  omnipresent_threshold: number;
  total: number;
  offset: number;
  next_offset: number | null;
} & (
  | { view: "list"; clusters: GraphClusterMatch[] }
  | { view: "members"; cluster: GraphClusterSummary; members: GraphNode[] }
  | {
      view: "neighbors";
      cluster: GraphClusterSummary;
      neighbors: GraphClusterNeighbor[];
    }
);

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

export type CodeGraphAction = "map" | "search" | "deps" | "cluster";
export type CodeGraphResult =
  | GraphMapResult
  | GraphSearchResult
  | GraphDependencyResult
  | GraphClusterResult;

const ACTIONS: CodeGraphAction[] = ["map", "search", "deps", "cluster"];
const CLUSTER_VIEWS: GraphClusterView[] = ["list", "members", "neighbors"];

const codeGraphSchema = Type.Object({
  action: Type.Union(
    ACTIONS.map((a) => Type.Literal(a)),
    {
      description:
        "map = directory buckets and hubs; search = rank symbols/files; deps = walk code dependencies; cluster = browse symbol groupings, members and one-hop neighbors",
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
    Type.String({
      description:
        "search: language name or alias, including rocq/coq, lean/lean4, verus, fstar/f*, and rust",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description:
        "Maximum rows: search default 10; cluster default 20, maximum 100",
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
          "Code dependency direction: in = consumers, out = dependencies; deps default in, cluster neighbors default both",
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
  clusterView: Type.Optional(
    Type.Union(
      CLUSTER_VIEWS.map((v) => Type.Literal(v)),
      {
        description: "cluster: list (default), members, or one-hop neighbors",
      },
    ),
  ),
  directory: Type.Optional(
    Type.String({
      description:
        "cluster list: root-relative POSIX directory; projects complete clusters, including cross-directory groups",
    }),
  ),
  clusterId: Type.Optional(
    Type.String({
      description:
        "cluster members/neighbors: exact ID from list, valid for the same graph/maxSize/omnipresent",
    }),
  ),
  maxSize: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 4294967295,
      description:
        "cluster grouping size cap (default 20); indivisible cycles/library may exceed it, not an agent count",
    }),
  ),
  omnipresent: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 4294967295,
      description:
        "cluster shared-library in-degree threshold (default automatic)",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 4294967295,
      description:
        "cluster page offset (default 0); follow next_offset until null for relevant rows",
    }),
  ),
  fstar: Type.Optional(
    Type.Object(
      {
        cwd: Type.Optional(
          Type.String({
            description:
              "F* working directory; relative to the repository root",
          }),
        ),
        fstarExe: Type.Optional(
          Type.String({
            description:
              "fstar.exe whose installation provides the default library (not run)",
          }),
        ),
        options: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "fstar.exe arguments; --include, --cache_dir, --no_default_includes, --with_fstarc and @respfile select files",
          }),
        ),
        includeDirs: Type.Optional(
          Type.Array(Type.String(), {
            description: "Appended as --include <dir> after options",
          }),
        ),
      },
      {
        description:
          "F* include paths: each field replaces that field of the nearest *.fst.config.json (arrays too; [] clears); relative paths resolve from the effective cwd",
      },
    ),
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
        'Deterministic tree-sitter code graph of a repository (symbols, calls, imports, heritage); indexes on first use and refreshes changed files on every call. Includes Rocq/Coq (.v), Lean (.lean), Verus syntax in .rs alongside ordinary Rust, and F* (.fst/.fsti) with injected Pulse bodies. F* modules resolve through the compiler include roots of the nearest *.fst.config.json (overridable via fstar); library files outside the root appear as ../-prefixed paths. F* val/body pairs prefer the implementation for references while retaining interface declarations as source nodes. These are static source dependencies, not elaboration or proof verification. path is always the repository root. map: directory buckets, hubs and hotspots, not symbol cluster IDs. search: rank symbols and files by words. deps: callers/callees/importers/heritage to a depth; in = consumers, out = dependencies; file path with relations ["contains"] and direction out lists definitions. cluster: list symbol groupings (optionally matching directory), members with source spans, or one-hop neighbors. Clusters can cross directories; directory never changes membership. sample_files contains at most five sorted paths; file_count counts all files. Follow next_offset for pagination, reduce limit if bounded output truncates bytes rather than infer missing rows are absent. Keep root/maxSize/omnipresent fixed while browsing; IDs are snapshot-local and may change after edits. Cluster edges are symbol-only code dependencies, not workflow ordering: from references/calls to, edges counts distinct symbol pairs, targets counts distinct target symbols. Neighbors include both actual direction fields, even when one direction selected the row. Ordinary deps handles file imports; depth is deps-only. Extraction gaps are not proof of absent implementation.',
      promptSnippet:
        "Map a repo, find symbols, trace dependencies and browse symbol clusters",
      parameters: codeGraphSchema,
      async execute(_toolCallId, params, signal) {
        if (params.action === "cluster") {
          if (params.maxSize === 0)
            throw new Error("max_size must be greater than zero");
          if (
            params.limit !== undefined &&
            Number.isInteger(params.limit) &&
            (params.limit < 1 || params.limit > 100)
          )
            throw new Error("cluster limit must be between 1 and 100");
        }
        for (const [field, minimum] of [
          ["limit", 1],
          ["depth", 1],
          ["maxSize", 1],
          ["omnipresent", 0],
          ["offset", 0],
        ] as const) {
          if (params[field] !== undefined)
            requireU32(field, params[field], minimum);
        }
        if (params.action === "search") {
          if ((params.query ?? "").trim() === "")
            throw new Error("search requires query");
        } else if (params.action === "cluster") {
          const view = params.clusterView ?? "list";
          if (!CLUSTER_VIEWS.includes(view))
            throw new Error(`invalid cluster view: ${view}`);
          if (
            params.direction !== undefined &&
            !["in", "out", "both"].includes(params.direction)
          )
            throw new Error(`invalid direction: ${params.direction}`);
          if (view === "list") {
            if (
              params.clusterId !== undefined ||
              params.direction !== undefined
            )
              throw new Error(
                "cluster list does not accept clusterId or direction",
              );
          } else {
            if ((params.clusterId ?? "").trim() === "")
              throw new Error(`cluster ${view} requires clusterId`);
            if (
              view === "members" &&
              (params.directory !== undefined || params.direction !== undefined)
            )
              throw new Error(
                "cluster members does not accept directory or direction",
              );
            if (view === "neighbors" && params.directory !== undefined)
              throw new Error("cluster neighbors does not accept directory");
          }
        } else if (params.action === "deps") {
          if ((params.symbol ?? "").trim() === "")
            throw new Error("deps requires symbol");
          // Direction and relation names are validated by the native prepare branch.
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
