import { readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import createGraph, { type Graph, type Link } from "ngraph.graph";
import { graph, type schedules } from "junco-agency";

export type GraphMetaV1 = {
  readonly version: 1;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly languages: readonly string[];
  readonly scopes?: readonly {
    readonly prefix: string;
    readonly label: string;
    readonly markers: readonly string[];
  }[];
};

export type GraftMetadata = {
  readonly id: string;
  readonly name: string;
  readonly kind: "file" | "class" | "function" | "method" | "interface" | "type" | "enum" | "struct" | "trait" | "module" | "constant" | "variable";
  readonly owner?: string;
  readonly path: string;
  readonly span: string;
  readonly signature: string | null;
  readonly exported: boolean;
  readonly origin: "ast" | "generic";
  readonly body_hash: string;
  readonly chars?: number;
  readonly body_text?: string;
  readonly arity?: number;
  readonly variadic?: boolean;
  readonly summary_state: "pending" | "ready" | "stale";
  readonly summary: string | null;
  readonly crux: { readonly code: string; readonly span: string } | null;
};

export type GraftEdge = {
  readonly source: string;
  readonly target: string;
  readonly relation: "contains" | "calls" | "imports" | "references" | "implements" | "extends";
  readonly confidence: "lsp_resolved" | "lsp_dispatch" | "extracted" | "inferred";
};

export type GraftRegion = {
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly predecessorIds: readonly string[];
};

export type GraftTopology = {
  readonly meta: GraphMetaV1;
  readonly skeleton: Graph<GraftMetadata, GraftEdge>;
  readonly regions: readonly GraftRegion[];
  readonly bridgeIds: ReadonlySet<string>;
  readonly externalEdges: readonly GraftEdge[];
};

function invalid(field: string, reason: string): never {
  throw new Error(`Invalid graft graph: ${field} ${reason}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(field, "must be an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, nonempty = false): asserts value is string {
  if (typeof value !== "string" || (nonempty && value.length === 0))
    invalid(field, nonempty ? "must be a nonempty string" : "must be a string");
}

function integer(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(field, "must be a nonnegative safe integer");
}

function strings(value: unknown, field: string): void {
  if (!Array.isArray(value)) invalid(field, "must be an array of strings");
  for (const [i, entry] of value.entries()) string(entry, `${field}[${i}]`);
}

function literal(value: unknown, field: string, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value))
    invalid(field, `must be one of ${allowed.join(", ")}`);
}

function nullableString(value: unknown, field: string): void {
  if (value !== null) string(value, field);
}

/** Validate the whole persisted GraphV1 before ngraph can manufacture any nodes. */
export function parseGraftGraph(value: unknown, selectedIds?: ReadonlySet<string>): GraftTopology {
  const root = object(value, "root");
  const meta = object(root.meta, "meta");
  if (meta.version !== 1)
    throw new Error(`Unsupported graft graph version: ${String(meta.version)}; expected 1`);
  integer(meta.nodeCount, "meta.nodeCount");
  integer(meta.edgeCount, "meta.edgeCount");
  strings(meta.languages, "meta.languages");
  if (meta.scopes !== undefined) {
    if (!Array.isArray(meta.scopes)) invalid("meta.scopes", "must be an array");
    for (const [i, entry] of meta.scopes.entries()) {
      const scope = object(entry, `meta.scopes[${i}]`);
      string(scope.prefix, `meta.scopes[${i}].prefix`);
      string(scope.label, `meta.scopes[${i}].label`);
      strings(scope.markers, `meta.scopes[${i}].markers`);
    }
  }
  if (!Array.isArray(root.nodes)) invalid("nodes", "must be an array");
  if (!Array.isArray(root.edges)) invalid("edges", "must be an array");
  if (meta.nodeCount !== root.nodes.length) invalid("meta.nodeCount", "must match nodes.length");
  if (meta.edgeCount !== root.edges.length) invalid("meta.edgeCount", "must match edges.length");
  const ids = new Set<string>();
  for (const [i, entry] of root.nodes.entries()) {
    const field = `nodes[${i}]`;
    const node = object(entry, field);
    string(node.id, `${field}.id`, true);
    if (ids.has(node.id)) invalid(`${field}.id`, "must be unique");
    ids.add(node.id);
    string(node.name, `${field}.name`);
    literal(node.kind, `${field}.kind`, ["file", "class", "function", "method", "interface", "type", "enum", "struct", "trait", "module", "constant", "variable"]);
    string(node.path, `${field}.path`, true);
    if (posix.isAbsolute(node.path) || win32.isAbsolute(node.path) || /^[A-Za-z]:/.test(node.path) || node.path.split(/[\\/]/).includes(".."))
      invalid(`${field}.path`, "must be repo-relative without parent traversal");
    string(node.span, `${field}.span`);
    const span = /^L([1-9]\d*)-L([1-9]\d*)$/.exec(node.span);
    if (!span || !Number.isSafeInteger(Number(span[1])) || !Number.isSafeInteger(Number(span[2])) || Number(span[1]) > Number(span[2]))
      invalid(`${field}.span`, "must be L<start>-L<end> with positive ordered integers");
    nullableString(node.signature, `${field}.signature`);
    if (typeof node.exported !== "boolean") invalid(`${field}.exported`, "must be a boolean");
    literal(node.origin, `${field}.origin`, ["ast", "generic"]);
    string(node.body_hash, `${field}.body_hash`);
    literal(node.summary_state, `${field}.summary_state`, ["pending", "ready", "stale"]);
    nullableString(node.summary, `${field}.summary`);
    if (node.crux !== null) {
      const crux = object(node.crux, `${field}.crux`);
      string(crux.code, `${field}.crux.code`);
      string(crux.span, `${field}.crux.span`);
    }
    for (const key of ["owner", "body_text"])
      if (node[key] !== undefined) string(node[key], `${field}.${key}`);
    for (const key of ["chars", "arity"])
      if (node[key] !== undefined) integer(node[key], `${field}.${key}`);
    if (node.variadic !== undefined && typeof node.variadic !== "boolean")
      invalid(`${field}.variadic`, "must be a boolean");
  }
  const triples = new Set<string>();
  for (const [i, entry] of root.edges.entries()) {
    const field = `edges[${i}]`;
    const edge = object(entry, field);
    string(edge.source, `${field}.source`, true);
    string(edge.target, `${field}.target`, true);
    literal(edge.relation, `${field}.relation`, ["contains", "calls", "imports", "references", "implements", "extends"]);
    literal(edge.confidence, `${field}.confidence`, ["lsp_resolved", "lsp_dispatch", "extracted", "inferred"]);
    if (!ids.has(edge.source)) invalid(`${field}.source`, "must name an existing node");
    if (!ids.has(edge.target) && (edge.relation === "contains" || edge.relation === "calls"))
      invalid(`${field}.target`, "must name an existing node for this relation");
    const triple = JSON.stringify([edge.source, edge.relation, edge.target]);
    if (triples.has(triple)) invalid(field, "duplicates a (source, relation, target) triple");
    triples.add(triple);
  }
  if (selectedIds !== undefined) {
    const unknown = [...selectedIds].filter(id => !ids.has(id)).sort();
    if (unknown.length) throw new Error(`Unknown graft node IDs: ${unknown.join(", ")}`);
  }
  // All objects passed to ngraph are the original persisted metadata, including unknown v1 fields.
  const nodes = root.nodes as GraftMetadata[];
  const edges = root.edges as GraftEdge[];
  const skeleton = createGraph<GraftMetadata, GraftEdge>({ multigraph: true });
  for (const node of nodes)
    if (selectedIds === undefined || selectedIds.has(node.id)) skeleton.addNode(node.id, node);
  const externalEdges: GraftEdge[] = [];
  for (const edge of edges) {
    if (edge.relation === "contains" || !skeleton.getNode(edge.source)) continue;
    if (!ids.has(edge.target)) externalEdges.push(edge);
    else if (skeleton.getNode(edge.target)) skeleton.addLink(edge.source, edge.target, edge);
  }
  const { regions, bridgeIds } = dependencyRegions(skeleton);
  return { meta: meta as GraphMetaV1, skeleton, regions, bridgeIds, externalEdges };
}

/** Read the first existing map; a broken preferred map must never hide behind a legacy one. */
export async function loadGraftGraph(repoRoot: string, selectedIds?: ReadonlySet<string>): Promise<GraftTopology> {
  for (const path of [join(repoRoot, ".trail/cache/.graph/wiring.json"), join(repoRoot, "graft/.graph/wiring.json")]) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (cause) { throw new Error(`Invalid JSON in graft graph ${path}`, { cause }); }
    return parseGraftGraph(value, selectedIds);
  }
  throw new Error(`No graft graph found for ${repoRoot}; run trail build ${repoRoot}`);
}

/** Iterative low-link DFS over undirected link identities, followed by bridge-free components. */
function dependencyRegions(skeleton: Graph<GraftMetadata, GraftEdge>): Pick<GraftTopology, "regions" | "bridgeIds"> {
  type Frame = { id: string; parent?: string; parentLink?: string; links: Iterator<Link<GraftEdge>> };
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const bridgeIds = new Set<string>();
  let time = 0;
  const enter = (id: string, parent?: string, parentLink?: string): Frame => {
    discovery.set(id, ++time);
    low.set(id, time);
    return { id, parent, parentLink, links: (skeleton.getLinks(id) ?? new Set<Link<GraftEdge>>()).values() };
  };
  skeleton.forEachNode(node => {
    const root = String(node.id);
    if (discovery.has(root)) return;
    const stack = [enter(root)];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = frame.links.next();
      if (next.done) {
        stack.pop();
        if (frame.parent !== undefined) {
          const childLow = low.get(frame.id)!;
          low.set(frame.parent, Math.min(low.get(frame.parent)!, childLow));
          if (childLow > discovery.get(frame.parent)!) bridgeIds.add(frame.parentLink!);
        }
        continue;
      }
      const link = next.value;
      if (link.id === frame.parentLink) continue;
      const other = String(link.fromId === frame.id ? link.toId : link.fromId);
      if (!discovery.has(other)) stack.push(enter(other, frame.id, link.id));
      else low.set(frame.id, Math.min(low.get(frame.id)!, discovery.get(other)!));
    }
  });
  const membership = new Map<string, string>();
  const regions: { id: string; nodeIds: string[]; predecessorIds: string[] }[] = [];
  skeleton.forEachNode(node => {
    const start = String(node.id);
    if (membership.has(start)) return;
    const nodeIds: string[] = [];
    const pending = [start];
    membership.set(start, start);
    while (pending.length) {
      const id = pending.pop()!;
      nodeIds.push(id);
      for (const link of skeleton.getLinks(id) ?? []) {
        if (bridgeIds.has(link.id)) continue;
        const other = String(link.fromId === id ? link.toId : link.fromId);
        if (membership.has(other)) continue;
        membership.set(other, start);
        pending.push(other);
      }
    }
    nodeIds.sort();
    const id = nodeIds[0]!;
    for (const member of nodeIds) membership.set(member, id);
    regions.push({ id, nodeIds, predecessorIds: [] });
  });
  regions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const predecessors = new Map(regions.map(region => [region.id, new Set<string>()]));
  skeleton.forEachLink(link => {
    if (bridgeIds.has(link.id)) predecessors.get(membership.get(String(link.toId))!)!.add(membership.get(String(link.fromId))!);
  });
  for (const region of regions) region.predecessorIds = [...predecessors.get(region.id)!].sort();
  return { regions, bridgeIds };
}

export type GraftCheckpoint<T> = {
  readonly region: GraftRegion;
  readonly results: ReadonlyMap<graph.NodeIdType, T>;
  readonly completedRegions: number;
  readonly totalRegions: number;
  readonly completedNodes: number;
  readonly totalNodes: number;
};

/** Gate finite assignments at region boundaries; assertion and reporting settle before admission. */
export function graftCheckpoints<N, T>(topology: GraftTopology, options: {
  readonly validate: (region: GraftRegion, results: ReadonlyMap<graph.NodeIdType, T>) => void | Promise<void>;
  readonly progress: (checkpoint: GraftCheckpoint<T>) => void | Promise<void>;
}): {
  gate(metadata: GraftMetadata, spec: graph.nodes.AgenticNode<N, T>): graph.nodes.AgenticNode<N, T>;
  run(workflow: schedules.SchedulerContext<graph.nodes.Agentic<N, T>, N, T, never, graph.JuncoGraph<N, T>>): Promise<ReadonlyMap<graph.NodeIdType, T>>;
} {
  const membership = new Map<string, GraftRegion>();
  const unlocked = new Set<string>();
  const validated = new Map<string, ReadonlyMap<graph.NodeIdType, T>>();
  for (const region of topology.regions) {
    for (const id of region.nodeIds) membership.set(id, region);
    if (region.predecessorIds.length === 0) unlocked.add(region.id);
  }
  let completedNodes = 0;
  return {
    gate(metadata, spec) {
      if (spec.trigger.kind !== "all" || spec.trigger.rule.length !== 0)
        throw new Error("Repository work nodes require TriggerRule.always()");
      const region = membership.get(metadata.id);
      if (!region) throw new Error(`Unknown graft node IDs: ${metadata.id}`);
      const originalAvailability = spec.is_available;
      return { ...spec, is_available: (view, triggered) => unlocked.has(region.id) && (originalAvailability?.(view, triggered) ?? triggered) };
    },
    async run(workflow) {
      while (true) {
        const results = await workflow.step();
        for (const region of topology.regions) {
          if (!unlocked.has(region.id) || validated.has(region.id) || !region.nodeIds.every(id => results.has(graph.NodeId.create(id)))) continue;
          const snapshot: ReadonlyMap<graph.NodeIdType, T> = new Map(region.nodeIds.map(id => {
            const key = graph.NodeId.create(id);
            return [key, results.get(key) as T];
          }));
          try { await options.validate(region, snapshot); }
          catch (cause) { throw new Error(`Checkpoint failed for region "${region.id}"`, { cause }); }
          validated.set(region.id, snapshot);
          completedNodes += region.nodeIds.length;
          await options.progress({ region, results: snapshot, completedRegions: validated.size, totalRegions: topology.regions.length, completedNodes, totalNodes: topology.skeleton.getNodeCount() });
          for (const successor of topology.regions)
            if (successor.predecessorIds.every(id => validated.has(id))) unlocked.add(successor.id);
        }
        if (validated.size === topology.regions.length) return await workflow.run();
        if (workflow.graph.available().size === 0) {
          const unfinished = [...membership.keys()].filter(id => !results.has(graph.NodeId.create(id))).sort();
          throw new Error(`Graft workflow quiesced with unfinished nodes: ${unfinished.join(", ")}`);
        }
      }
    },
  };
}
