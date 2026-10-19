import { graph } from "junco-agency";
import { Value } from "typebox/value";
import {
  BUILTIN_TOOL_NAMES,
  type EdgeSpec,
  type GraphSpec,
  type JuncoDocument,
  JuncoDocumentSchema,
  type TriggerSpec,
} from "./schema.js";

export const edgeId = (edge: EdgeSpec): string =>
  edge.id ?? `${edge.from}${edge.kind === "message" ? "~>" : "->"}${edge.to}`;
export const inboundEdges = (spec: GraphSpec, id: string): EdgeSpec[] =>
  (spec.edges ?? []).filter((e) => e.to === id);
export const outboundEdges = (spec: GraphSpec, id: string): EdgeSpec[] =>
  (spec.edges ?? []).filter((e) => e.from === id);
export const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolveTrigger<N = never, T = never>(
  spec: GraphSpec,
  id: string,
  trigger?: TriggerSpec,
): graph.trigger.TriggerRule<N, T> {
  const { TriggerRule, TriggerEntry } = graph.trigger;
  if (trigger === "always") return TriggerRule.always();
  if (trigger === "never") return TriggerRule.never();
  const entries =
    typeof trigger === "string"
      ? [trigger]
      : trigger === undefined
        ? inboundEdges(spec, id).map(edgeId)
        : "all" in trigger
          ? trigger.all
          : trigger.any;
  const on = entries.map((id) => TriggerEntry.on(graph.Edge.value<N, T>(id)));
  return typeof trigger === "object" && "any" in trigger
    ? TriggerRule.anyOf(...on)
    : TriggerRule.allOf(...on);
}
const pointer = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");
const fail = (path: string, message: string): never => {
  throw new graph.DataflowDefinitionError(`junco-syntax: ${path}: ${message}`);
};

export function parse(source: string | unknown): JuncoDocument {
  let value: unknown = source;
  if (typeof source === "string") {
    try {
      value = Bun.YAML.parse(source);
    } catch (error) {
      throw new graph.DataflowDefinitionError(
        `junco-syntax: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!Value.Check(JuncoDocumentSchema, value)) {
    const [error] = Value.Errors(JuncoDocumentSchema, value);
    fail(error?.instancePath || "/", error?.message ?? "invalid value");
  }
  const doc = value as JuncoDocument;
  function checkGraph(
    spec: GraphSpec,
    path: string,
    label: string,
    parent?: { inbound: EdgeSpec[]; outbound: EdgeSpec[] },
  ): void {
    const edges = spec.edges ?? [];
    const ids = new Set<string>();
    for (const id of Object.keys(spec.nodes))
      if (id === "$source" || id === "$sink")
        fail(`${path}/nodes/${pointer(id)}`, `node id "${id}" is reserved`);
    for (const edge of edges) {
      const id = edgeId(edge);
      if (edge.to === "$source")
        fail(path, "Graph source cannot have inbound edges");
      if (edge.from === "$sink")
        fail(path, "Graph sink cannot have outbound edges");
      if (edge.from === "$source" && edge.kind !== "message")
        fail(path, "Graph source cannot produce value edges");
      for (const [node, port] of [
        [edge.from, "$source"],
        [edge.to, "$sink"],
      ]) {
        if (node !== port && !Object.hasOwn(spec.nodes, node!))
          fail(path, `edge "${id}" references unknown node "${node}"`);
      }
      if (ids.has(id)) fail(path, `edge "${id}" declared twice`);
      ids.add(id);
    }
    function checkTrigger(id: string, trigger?: TriggerSpec): void {
      const inbound = new Set(inboundEdges(spec, id).map(edgeId));
      const entries =
        typeof trigger === "object"
          ? "all" in trigger
            ? trigger.all
            : trigger.any
          : trigger === undefined || trigger === "always" || trigger === "never"
            ? []
            : [trigger];
      const seen = new Set<string>();
      for (const e of entries) {
        if (!inbound.has(e))
          fail(
            path,
            `Node "${id}" trigger references edge "${e}" which is not one of its inbound edges`,
          );
        if (seen.has(e))
          fail(path, `Node "${id}" trigger lists edge "${e}" twice`);
        seen.add(e);
      }
    }
    const predecessors = [
      ...new Set(inboundEdges(spec, "$sink").map((e) => e.from)),
    ];
    if (predecessors.length === 0)
      fail(path, "$sink needs at least one inbound edge");
    if (
      spec.sink?.returns !== undefined &&
      !predecessors.includes(spec.sink.returns)
    )
      fail(path, `sink.returns "${spec.sink.returns}" has no edge to $sink`);
    if (spec.sink?.returns === undefined && predecessors.length > 1)
      fail(
        path,
        `sink.returns is required: $sink has inbound edges from ${predecessors.join(", ")}`,
      );
    checkTrigger("$sink", spec.sink?.trigger);
    for (const [id, node] of Object.entries(spec.nodes)) {
      const nodePath = `${path}/nodes/${pointer(id)}`;
      const inbound = inboundEdges(spec, id);
      const outbound = outboundEdges(spec, id);
      if (node.kind !== "ralph") checkTrigger(id, node.trigger);
      if (node.kind === "graph")
        checkGraph(node.graph, `${nodePath}/graph`, node.graph.name ?? id, {
          inbound,
          outbound,
        });
      else if (node.kind === "emit") {
        if (
          inbound.length ||
          !outbound.length ||
          outbound.some((e) => e.kind !== "message")
        )
          fail(
            nodePath,
            `Node "${id}" (emit) must have no inbound edges and only message outbound edges (at least one)`,
          );
      } else if (node.kind === "code") {
        if (!Object.hasOwn(doc.code ?? {}, node.name))
          fail(nodePath, `Node "${id}" references unknown code "${node.name}"`);
      } else {
        if (
          node.kind === "ralph" &&
          (inbound.length !== 1 ||
            inbound[0]!.kind !== "message" ||
            outbound.filter((e) => e.kind === "message").length !== 1 ||
            Object.hasOwn(node, "trigger"))
        )
          fail(
            nodePath,
            `Node "${id}" (ralph) needs exactly one inbound message edge and one outbound message edge, and no trigger`,
          );
        const inboundIds = new Set(inbound.map(edgeId));
        for (const [field, refs] of [
          ["contracts", Object.keys(node.contracts ?? {})],
          [
            "prompt",
            [...(node.prompt ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]!),
          ],
        ] as const) {
          for (const e of refs)
            if (!inboundIds.has(e))
              fail(
                nodePath,
                `Node "${id}" ${field} references edge "${e}" which is not one of its inbound edges`,
              );
        }
        for (const name of node.mcp ?? [])
          if (!Object.hasOwn(doc.mcp ?? {}, name))
            fail(nodePath, `Node "${id}" references unknown mcp "${name}"`);
        for (const name of node.skills ?? [])
          if (!Object.hasOwn(doc.skills ?? {}, name))
            fail(nodePath, `Node "${id}" references unknown skill "${name}"`);
        const seen = new Set<string>();
        for (const name of node.tools ?? []) {
          if ((BUILTIN_TOOL_NAMES as readonly string[]).includes(name))
            fail(
              nodePath,
              `Node "${id}": tool "${name}" is builtin and always on`,
            );
          if (seen.has(name))
            fail(nodePath, `Node "${id}" lists tool "${name}" twice`);
          seen.add(name);
        }
      }
    }
    for (const [key, targets] of Object.entries(spec.source?.routes ?? {})) {
      if (parent && !parent.inbound.some((e) => edgeId(e) === key))
        fail(path, `Graph "${label}" routes unknown parent edge "${key}"`);
      for (const target of targets)
        if (!edges.some((e) => e.from === "$source" && edgeId(e) === target))
          fail(
            path,
            `Graph "${label}" route target "${target}" is not an edge from $source`,
          );
    }
  }
  checkGraph(doc.graph, "/graph", doc.graph.name ?? "graph");
  return doc;
}
