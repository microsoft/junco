import { parse } from "../../syntax/parse.js";
import { edgeId, type GraphSpec, type JuncoDocument } from "../../syntax/schema.js";
import anyFanInSource from "./any-fan-in.yml" with { type: "text" };
import ralphSource from "./ralph.yml" with { type: "text" };

const ralph = parse(ralphSource).graph;
const selector = parse(anyFanInSource).graph;
function edge(graph: GraphSpec, id: string) {
  const found = graph.edges?.find((candidate) => edgeId(candidate) === id);
  if (!found) throw new TypeError(`${graph.name} requires ${id}`);
  return found;
}
const prompt = edge(selector, "$source~>AnyFanIn").schema;
const assistant = edge(selector, "AnyFanInPublish~>$sink").schema;
const credits = [
  edge(selector, "ingress-open"),
  { ...edge(selector, "ingress-ack"), from: "Memory" },
];
const IngressOpen = selector.nodes.IngressOpen;
if (IngressOpen?.kind !== "emit") throw new TypeError("AnyFanIn requires IngressOpen");
const broadcast = { anyOf: [prompt, assistant] };
const ralphAgent = ralph.nodes.Ralph;
const selectorAgent = selector.nodes.AnyFanIn;
if (
  ralphAgent === undefined ||
  (ralphAgent.kind !== undefined && ralphAgent.kind !== "agent")
)
  throw new TypeError("Ralph must be an agent node");
if (
  selectorAgent === undefined ||
  (selectorAgent.kind !== undefined && selectorAgent.kind !== "agent")
)
  throw new TypeError("AnyFanIn must be an agent node");

const ralphDocument: JuncoDocument = {
  graph: {
    name: "MemoryRalphLoop",
    source: { ...selector.source, routes: { assignment: ["$source~>Memory"] } },
    sink: {
      returns: "Ralph",
      trigger: { all: ["Ralph->$sink", "Memory~>$sink"] },
    },
    nodes: {
      IngressOpen,
      Memory: {
        kind: "code",
        trigger: { any: ["$source~>Memory", "ralph-complete"] },
      },
      Ralph: { ...ralphAgent, trigger: "Memory~>Ralph" },
    },
    edges: [
      ...credits,
      {
        id: "$source~>Memory",
        from: "$source",
        to: "Memory",
        kind: "message",
        schema: prompt,
      },
      {
        id: "Memory~>Ralph",
        from: "Memory",
        to: "Ralph",
        kind: "message",
        schema: edge(ralph, "RalphControl~>Ralph").schema,
      },
      { ...edge(ralph, "ralph-complete"), to: "Memory" },
      { ...edge(ralph, "Ralph->$sink"), id: "Ralph->$sink", kind: "value" },
      {
        id: "Memory~>$sink",
        from: "Memory",
        to: "$sink",
        kind: "message",
        schema: prompt,
      },
    ],
  },
};

const fanInDocument: JuncoDocument = {
  graph: {
    name: "MemoryFanIn",
    source: { ...selector.source, routes: { candidates: ["$source~>MemoryCandidates"] } },
    sink: { stream: true },
    nodes: {
      IngressOpen,
      Memory: {
        kind: "code",
        trigger: { any: ["$source~>MemoryCandidates", "Select~>Memory"] },
      },
      Select: {
        kind: "graph",
        trigger: "Memory~>Select",
        graph: {
          ...selector,
          source: {
            ...selector.source,
            routes: { "Memory~>Select": ["$source~>AnyFanIn"] },
          },
          nodes: {
            ...selector.nodes,
            AnyFanIn: {
              ...selectorAgent,
              tool_block: [
                ...(selectorAgent.tool_block ?? []),
                "save_memory",
                "search_memory",
                "forget_memory",
              ],
            },
          },
        },
      },
    },
    edges: [
      ...credits,
      {
        id: "$source~>MemoryCandidates",
        from: "$source",
        to: "Memory",
        kind: "message",
        schema: prompt,
      },
      {
        id: "Memory~>Select",
        from: "Memory",
        to: "Select",
        kind: "message",
        schema: prompt,
      },
      {
        id: "Select~>Memory",
        from: "Select",
        to: "Memory",
        kind: "message",
        schema: assistant,
      },
      {
        id: "Memory~>$sink",
        from: "Memory",
        to: "$sink",
        kind: "message",
        schema: assistant,
      },
    ],
  },
};

const fanOutDocument: JuncoDocument = {
  graph: {
    name: "MemoryFanOut",
    source: {
      ...selector.source,
      routes: {
        assignment: ["$source~>MemoryAssignment"],
        updates: ["$source~>MemoryUpdate"],
      },
    },
    sink: { stream: true },
    nodes: {
      IngressOpen,
      Memory: {
        kind: "code",
        trigger: {
          any: ["$source~>MemoryAssignment", "$source~>MemoryUpdate"],
        },
      },
    },
    edges: [
      ...credits,
      {
        id: "$source~>MemoryAssignment",
        from: "$source",
        to: "Memory",
        kind: "message",
        schema: prompt,
      },
      {
        id: "$source~>MemoryUpdate",
        from: "$source",
        to: "Memory",
        kind: "message",
        schema: assistant,
      },
      {
        id: "Memory~>$sink",
        from: "Memory",
        to: "$sink",
        kind: "message",
        schema: broadcast,
      },
    ],
  },
};

/** Ralph revisions persisted before decisions, with fresh recall before each round. */
export const memoryRalphLoop: string = JSON.stringify(ralphDocument);
/** Persistent streaming best-so-far selection; candidates must arrive on message edges. */
export const memoryFanIn: string = JSON.stringify(fanInDocument);
/** Recall assignments and broadcast already-persisted selections to caller-owned workers. */
export const memoryFanOut: string = JSON.stringify(fanOutDocument);
