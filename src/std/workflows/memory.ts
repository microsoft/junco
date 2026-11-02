import { parse } from "../../syntax/parse.js";
import type { JuncoDocument } from "../../syntax/schema.js";
import anyFanInSource from "./any-fan-in.yml" with { type: "text" };
import ralphSource from "./ralph.yml" with { type: "text" };

const ralph = parse(ralphSource).graph;
const selector = parse(anyFanInSource).graph;
const prompt = selector.edges?.find(
  (edge) => edge.from === "$source" && edge.to === "AnyFanIn",
)?.schema;
const assistant = selector.edges?.find(
  (edge) => edge.from === "AnyFanIn" && edge.to === "AnyFanIn",
)?.schema;
const ralphAssistant = ralph.edges?.find(
  (edge) => edge.from === "Ralph" && edge.to === "Ralph",
)?.schema;
if (
  prompt === undefined ||
  assistant === undefined ||
  ralphAssistant === undefined
)
  throw new TypeError("Memory workflows require prompt and assistant schemas");
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
    source: { routes: { assignment: ["$source~>Memory"] } },
    sink: {
      returns: "Ralph",
      trigger: { all: ["Ralph->$sink", "Memory~>$sink"] },
    },
    nodes: {
      Memory: {
        kind: "code",
        trigger: { any: ["$source~>Memory", "Ralph->Memory"] },
      },
      Ralph: { ...ralphAgent, trigger: "Memory~>Ralph" },
    },
    edges: [
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
        schema: prompt,
      },
      {
        id: "Ralph->Ralph",
        from: "Ralph",
        to: "Ralph",
        kind: "value",
        schema: ralphAssistant,
      },
      {
        id: "Ralph->Memory",
        from: "Ralph",
        to: "Memory",
        kind: "value",
        schema: ralphAssistant,
      },
      {
        id: "Ralph->$sink",
        from: "Ralph",
        to: "$sink",
        kind: "value",
        schema: ralphAssistant,
      },
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
    source: { routes: { candidates: ["$source~>MemoryCandidates"] } },
    sink: { stream: true },
    nodes: {
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
      routes: {
        assignment: ["$source~>MemoryAssignment"],
        updates: ["$source~>MemoryUpdate"],
      },
    },
    sink: { stream: true },
    nodes: {
      Memory: {
        kind: "code",
        trigger: {
          any: ["$source~>MemoryAssignment", "$source~>MemoryUpdate"],
        },
      },
    },
    edges: [
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
