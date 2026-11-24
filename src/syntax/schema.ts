import * as graph from "dataflow-engine";
import { type Static, type TSchema, Type } from "typebox";
import { pointer } from "./errors.js";

const strict = { additionalProperties: false } as const;
const strings = Type.Array(Type.String());
const trigger = Type.Union([
  Type.Literal("always"),
  Type.Literal("never"),
  Type.String(),
  Type.Object({ all: strings }, strict),
  Type.Object({ any: strings }, strict),
]);
const edge = Type.Object(
  {
    from: Type.String(),
    to: Type.String(),
    kind: Type.Optional(
      Type.Union([Type.Literal("value"), Type.Literal("message")]),
    ),
    on: Type.Optional(Type.Literal("return")),
    id: Type.Optional(Type.String()),
    // JuncoGraphValidator checks the mapping's contents (Draft 2020-12, local refs only).
    schema: Type.Unsafe<TSchema>(Type.Object({})),
    // Record each published value under the recorder's `probe` resource; numeric types only.
    probe: Type.Optional(Type.Boolean()),
  },
  strict,
);
const common = {
  description: Type.Optional(Type.String()),
  repeat: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
};
export const AgentNodeSchema = Type.Object({
  ...common,
  kind: Type.Optional(Type.Literal("agent")),
  trigger: Type.Optional(trigger),
  system: Type.Optional(Type.String()),
  tool_block: Type.Optional(strings),
  skills: Type.Optional(strings),
  prompt: Type.Optional(Type.String({ pattern: "\\S" })),
}, strict);
// TypeBox 1.x spells recursive schemas Cyclic (Recursive was removed).
const graphSchema = Type.Cyclic(
  {
    Graph: Type.Object(
      {
        name: Type.Optional(Type.String()),
        window: Type.Optional(Type.Integer({ minimum: 1 })),
        threads: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("unbounded")]),
        ),
        source: Type.Optional(
          Type.Object(
            {
              description: common.description,
              trigger: Type.Optional(trigger),
              routes: Type.Optional(Type.Record(Type.String(), strings)),
            },
            strict,
          ),
        ),
        sink: Type.Optional(
          Type.Object(
            {
              description: common.description,
              trigger: Type.Optional(trigger),
              returns: Type.Optional(Type.String()),
              stream: Type.Optional(Type.Literal(true)),
            },
            strict,
          ),
        ),
        nodes: Type.Record(
          Type.String(),
          Type.Union([
            AgentNodeSchema,
            Type.Object(
              {
                ...common,
                kind: Type.Literal("emit"),
                trigger: Type.Optional(trigger),
                text: Type.String(),
                /** When the emitted task counts as complete. */
                spec: Type.String(),
              },
              strict,
            ),
            Type.Object(
              {
                ...common,
                kind: Type.Literal("graph"),
                trigger: Type.Optional(trigger),
                graph: Type.Ref("Graph"),
              },
              strict,
            ),
            Type.Object(
              {
                ...common,
                kind: Type.Literal("code"),
                trigger: Type.Optional(trigger),
              },
              strict,
            ),
          ]),
          { minProperties: 1 },
        ),
        edges: Type.Optional(Type.Array(edge)),
      },
      strict,
    ),
  },
  "Graph",
);

export const JuncoDocumentSchema = Type.Object(
  {
    skills: Type.Optional(Type.Record(Type.String(), Type.String())),
    graph: graphSchema,
  },
  strict,
);
export type JuncoDocument = Static<typeof JuncoDocumentSchema>;
export type GraphSpec = JuncoDocument["graph"];
export type NodeSpec = GraphSpec["nodes"][string];
export type EdgeSpec = Static<typeof edge>;
export type TriggerSpec = Static<typeof trigger>;

export const nodeKey = (parent: string, id: string): graph.NodeIdType =>
  graph.NodeId.create(parent ? `${parent}/${pointer(id)}` : pointer(id));

/** Declared nodes in construction order; keys escape individual path segments. */
export function* walk(spec: GraphSpec, label = spec.name ?? "graph", path = ""):
  Generator<{ id: string; node: NodeSpec; key: graph.NodeIdType; label: string }> {
  for (const [id, node] of Object.entries(spec.nodes)) {
    const key = nodeKey(path, id);
    yield { id, node, key, label };
    if (node.kind === "graph") yield* walk(node.graph, node.graph.name ?? id, key);
  }
}

export const edgeId = (edge: EdgeSpec): string =>
  edge.id ?? `${edge.from}${edge.kind === "message" ? "~>" : "->"}${edge.to}`;
export const inboundEdges = (spec: GraphSpec, id: string): EdgeSpec[] =>
  (spec.edges ?? []).filter((e) => e.to === id);
export const outboundEdges = (spec: GraphSpec, id: string): EdgeSpec[] =>
  (spec.edges ?? []).filter((e) => e.from === id);
export const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Expand the scalar spellings; an omitted trigger watches all inbound edges. */
export function declaredTrigger(
  trigger: TriggerSpec,
): Exclude<TriggerSpec, string> {
  if (typeof trigger !== "string") return trigger;
  if (trigger === "never") return { any: [] };
  return { all: trigger === "always" ? [] : [trigger] };
}

export function resolveTrigger<N extends TSchema, T>(
  spec: GraphSpec,
  id: string,
  edges: ReadonlyMap<string, graph.Edge<N, T>>,
  trigger?: TriggerSpec,
): graph.TriggerRule<N, T> {
  const { TriggerRule, TriggerEntry } = graph;
  const rule = declaredTrigger(
    trigger ?? { all: inboundEdges(spec, id).map(edgeId) },
  );
  const entries = "all" in rule ? rule.all : rule.any;
  const on = entries.map((entry) => {
    const edge = edges.get(entry);
    if (edge === undefined)
      throw new graph.DataflowDefinitionError(
        `Node "${id}" trigger references edge "${entry}" which is not one of its inbound edges`,
      );
    return TriggerEntry.on(edge);
  });
  return "all" in rule ? TriggerRule.allOf(...on) : TriggerRule.anyOf(...on);
}
