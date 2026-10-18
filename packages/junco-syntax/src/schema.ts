import { type Static, Type } from "typebox";

const strict = { additionalProperties: false } as const;
export const BUILTIN_TOOL_NAMES = [
  "yield",
  "info",
  "send",
  "recv",
  "task",
] as const;
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
    id: Type.Optional(Type.String()),
  },
  strict,
);
const common = { description: Type.Optional(Type.String()) };
const agentFields = {
  ...common,
  model: Type.String({ pattern: "^[^/]+/.+$" }),
  thinking: Type.Optional(
    Type.Union([
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ]),
  ),
  system: Type.Optional(Type.String()),
  tools: Type.Optional(strings),
  mcp: Type.Optional(strings),
  skills: Type.Optional(strings),
  prompt: Type.Optional(Type.String()),
  contracts: Type.Optional(Type.Record(Type.String(), Type.String())),
};
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
              ...common,
              routes: Type.Optional(Type.Record(Type.String(), strings)),
            },
            strict,
          ),
        ),
        sink: Type.Optional(
          Type.Object(
            {
              ...common,
              trigger: Type.Optional(trigger),
              returns: Type.Optional(Type.String()),
            },
            strict,
          ),
        ),
        nodes: Type.Record(
          Type.String(),
          Type.Union([
            Type.Object(
              {
                ...agentFields,
                kind: Type.Optional(Type.Literal("agent")),
                trigger: Type.Optional(trigger),
              },
              strict,
            ),
            Type.Object(
              {
                ...agentFields,
                kind: Type.Literal("ralph"),
                trigger: Type.Optional(trigger),
                rounds: Type.Optional(Type.Integer({ minimum: 1 })),
              },
              strict,
            ),
            Type.Object(
              {
                ...common,
                kind: Type.Literal("emit"),
                trigger: Type.Optional(trigger),
                text: Type.String(),
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
    mcp: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            command: Type.String(),
            args: Type.Optional(strings),
            cwd: Type.Optional(Type.String()),
            env: Type.Optional(Type.Record(Type.String(), Type.String())),
            timeout: Type.Optional(Type.Integer()),
          },
          strict,
        ),
      ),
    ),
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
