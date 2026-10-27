import assert from "node:assert/strict";
import type {
  AgentMessage,
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  Edge,
  EdgeId,
  type EdgeIdType,
  NodeId,
  TriggerEntry,
  TriggerRule,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import {
  type AgenticInput,
  AgenticInputSchema,
  AssistantMessageSchema,
  agent,
  Deterministic,
  JuncoGraph,
  schedules,
  type syntax,
  tools,
  tracer,
} from "junco-agency";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  policyContext,
  STRATEGIES,
  type Strategy,
  terminalPorts,
  textOf,
} from "./deterministic-support.ts";
import { leaf, nativeOptions } from "./support.ts";
import { Constant, Forward } from "./syntax-code-nodes.fixture.ts";

// Directly executable deterministic smoke: one producer/worker JuncoGraph per policy over real
// faux-backed JuncoAgents. The producer discovers its route through `info` and `send`s on it; the
// worker discovers its parents and consumes its retained inbox through `recv`. No credentials.

export type DeterministicSummary = {
  readonly scheduler: Strategy;
  readonly producer: string;
  readonly worker: string;
  readonly inputs: readonly string[];
  readonly closed: boolean;
};

type Route = {
  readonly id: string;
  readonly edgeId: string;
  readonly kind: "message" | "value";
  readonly expect: string;
};
type Info = { readonly parents: Route[]; readonly children: Route[] };
type Received = {
  readonly messages: { id: string; payload: AgenticInput }[];
  readonly values: { id: string; payload: AssistantMessage }[];
};

/** Parsed JSON results of every `name` tool call in `context`, in order. */
function results<R>(messages: readonly AgentMessage[], name: string): R[] {
  return messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === name
      ? [
          JSON.parse(
            message.content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join(""),
          ) as R,
        ]
      : [],
  );
}

const MESSAGE_EXPECT =
  "AgenticInput text messages retained in FIFO order for the worker's input list.";
const VALUE_EXPECT =
  "The producer's final assistant seed, consumed once before the worker finishes.";

/** Run the producer/worker agency on `strategy` to quiescence, close it, and summarize it. */
export async function runDeterministicFixture(
  strategy: Strategy,
): Promise<DeterministicSummary> {
  const handoff = Edge.message("producer->worker", AgenticInputSchema);
  const value = Edge.value("producer=>worker", AssistantMessageSchema);
  const infos: Record<"producer" | "worker", Info[]> = {
    producer: [],
    worker: [],
  };

  const sendOnRoute: FauxResponseFactory = (context) => {
    const info = results<Info>(context.messages, "info").at(-1)!;
    infos.producer.push(info);
    const route = info.children.find((child) => child.kind === "message");
    if (!route) return fauxAssistantMessage("no message route");
    return fauxAssistantMessage(
      [
        { kind: "nextTurn", text: "context first" },
        { kind: "prompt", text: "then work" },
      ].map((payload, index) =>
        fauxToolCall(
          "send",
          { id: route.edgeId, payload },
          { id: `send-${index}` },
        ),
      ),
      { stopReason: "toolUse" },
    );
  };
  const producer = await leaf(
    [
      fauxAssistantMessage(fauxToolCall("info", {}, { id: "info" }), {
        stopReason: "toolUse",
      }),
      sendOnRoute,
      fauxAssistantMessage(
        fauxToolCall("yield", { reason: "sent" }, { id: "y" }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("seed"),
    ],
    { prompt: "produce", tools: [new tools.InfoTool(), new tools.SendTool()] },
  );

  let received: Received[] = [];
  const work: FauxResponseFactory = (context) => {
    const info = results<Info>(context.messages, "info");
    if (info.length === 0)
      return fauxAssistantMessage(fauxToolCall("info", {}), {
        stopReason: "toolUse",
      });
    if (infos.worker.length === 0) infos.worker.push(info[0]!);
    const got = results<Received>(context.messages, "recv");
    const messages = got.flatMap((r) => r.messages);
    const values = got.flatMap((r) => r.values);
    if (messages.length >= 2 && values.length >= 1) {
      received = got;
      return fauxAssistantMessage("done");
    }
    return fauxAssistantMessage(
      context.messages.at(-1)?.role === "toolResult" &&
        (context.messages.at(-1) as { toolName?: string }).toolName === "recv"
        ? fauxToolCall("yield", { reason: "waiting for the seed" })
        : fauxToolCall("recv", {}),
      { stopReason: "toolUse" },
    );
  };
  const contracts: Record<string, tools.Contract> = {
    [handoff.id]: { expect: MESSAGE_EXPECT },
    [value.id]: { expect: VALUE_EXPECT },
  };
  const worker = await leaf(
    Array.from({ length: 12 }, () => work),
    {
      prompt: "work",
      tools: [new tools.InfoTool(), new tools.RecvTool()],
      contract: (edgeId: EdgeIdType) => {
        const contract = contracts[edgeId];
        if (!contract) throw new Error(`No contract for edge "${edgeId}"`);
        return contract;
      },
    },
  );

  const ports = terminalPorts();
  const graphContext = policyContext(ports.source, ports.sink, strategy);
  await using graph = graphContext.graph;
  const p = graph.addNode({
    id: NodeId.create("producer"),
    state: producer.agent,
    description: "produces the seed",
    policy: tools.LockPolicy,
    trigger: TriggerRule.always(),
  });
  const w = graph.addNode({
    id: NodeId.create("worker"),
    state: worker.agent,
    policy: tools.LockPolicy,
    description: "works from the seed",
    trigger: TriggerRule.anyOf(
      TriggerEntry.on(handoff),
      TriggerEntry.on(value),
    ),
  });
  graph.addEdge(p, w, handoff).addEdge(p, w, value);

  ports.connect(graph, w);
  await graphContext.run();

  const outputs = [p, w].map((id) => {
    const result = graph.result(id);
    assert.ok(O.isSome(result), `${id} has no result`);
    return textOf(result.value);
  });
  assert.deepEqual(outputs, ["seed", "done"]);

  const routes: Route[] = [
    { id: w, edgeId: handoff.id, kind: "message", expect: MESSAGE_EXPECT },
    { id: w, edgeId: value.id, kind: "value", expect: VALUE_EXPECT },
  ];
  const byEdge = (a: Route, b: Route) => a.edgeId.localeCompare(b.edgeId);
  const [producerInfo] = infos.producer;
  assert.deepEqual(producerInfo?.parents, []);
  assert.deepEqual(
    [...(producerInfo?.children ?? [])].sort(byEdge),
    [...routes].sort(byEdge),
  );
  assert.deepEqual(
    [...(infos.worker[0]?.parents ?? [])].sort(byEdge),
    routes.map((route) => ({ ...route, id: p })).sort(byEdge),
  );
  assert.deepEqual(infos.worker[0]?.children, [
    {
      id: graph.sink.id,
      edgeId: "terminal->$sink",
      kind: "value",
      expect:
        "Graph output consumes final work results and publishes messages.",
    },
  ]);

  // Parent result first, then message FIFO, from what recv actually returned.
  const inputs = [
    ...received
      .flatMap((r) => r.values)
      .map((v) => `upstream: ${textOf(v.payload)}`),
    ...received
      .flatMap((r) => r.messages)
      .map((m) => ("text" in m.payload ? m.payload.text : "")),
  ];
  assert.deepEqual(inputs, ["upstream: seed", "context first", "then work"]);

  await graph.close();
  const closed =
    graph.signal.aborted &&
    [producer.agent, worker.agent].every((agent) => agent.status === "closed");
  assert.ok(closed);
  return {
    scheduler: strategy,
    producer: outputs[0]!,
    worker: outputs[1]!,
    inputs,
    closed,
  };
}

// Numeric YAML scenarios: one document each, parsed from YAML text on Bun (Bun.YAML) and passed as
// the same parsed document on Node, which has no YAML parser.

/** `doc` as `fromYaml` input: YAML text on Bun, the parsed document on Node. */
const yamlInput = (doc: object): string | object =>
  typeof Bun === "undefined" ? doc : Bun.YAML.stringify(doc);

const NUMBER = { type: "number" };
const ASSISTANT = {
  type: "object",
  required: ["role", "content", "stopReason"],
  properties: {
    role: { const: "assistant" },
    content: { type: "array" },
    stopReason: { type: "string" },
  },
};

export type NumericMessagingSummary = {
  readonly scenario: "numeric-messaging";
  readonly received: readonly number[];
  readonly rejectedString: boolean;
  readonly closed: boolean;
};

/** The latest declaration of tool `name` in a request. */
const declared = (messages: readonly Message[], name: string) =>
  messages
    .flatMap((message) =>
      message.role === "system" ? (message.toolsAdded ?? []) : [],
    )
    .filter((tool) => tool.name === name)
    .at(-1);
/** The latest `name` tool result in `messages`. */
const latest = (messages: readonly Message[], name: string) =>
  messages
    .filter(
      (message) => message.role === "toolResult" && message.toolName === name,
    )
    .at(-1);

/**
 * A producer agent sends on its numeric `numbers` route; a consumer agent receives it with `recv`.
 * The model-visible `send` schema is the route's: a non-number fails as a tool error before the
 * numeric send succeeds, and the consumer's `recv` description advertises the same schema.
 */
export async function runNumericMessagingFixture(): Promise<NumericMessagingSummary> {
  let rejectedString = false;
  let sendSchema: TSchema | undefined;
  let recvDescription: string | undefined;
  let received: unknown;
  const producer = await nativeOptions([
    fauxAssistantMessage(
      // Pi coerces a numeric string such as "7" to the route's number, so the model sends a word.
      fauxToolCall("send", { id: "numbers", payload: "seven" }, { id: "s1" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = latest(context.messages, "send");
      rejectedString = result?.role === "toolResult" && result.isError;
      sendSchema = declared(context.messages, "send")?.parameters;
      return fauxAssistantMessage(
        fauxToolCall("send", { id: "numbers", payload: 7 }, { id: "s2" }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("produced"),
  ]);
  const consumer = await nativeOptions([
    (context) => {
      recvDescription = declared(context.messages, "recv")?.description;
      return fauxAssistantMessage(fauxToolCall("recv", {}, { id: "r" }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      const result = latest(context.messages, "recv");
      assert.ok(result?.role === "toolResult" && !result.isError);
      received = result.details;
      return fauxAssistantMessage("consumed");
    },
  ]);
  const agents: agent.JuncoAgent<
    Skill,
    PromptTemplate,
    AgentTool,
    TSchema,
    unknown
  >[] = [];
  const execution = await JuncoGraph.fromYaml(
    yamlInput({
      graph: {
        sink: { returns: "Consumer" },
        nodes: {
          Producer: { prompt: "Send the number seven on your route." },
          Consumer: { prompt: "Receive your numbers." },
        },
        edges: [
          {
            from: "Producer",
            to: "Consumer",
            kind: "message",
            id: "numbers",
            schema: NUMBER,
          },
          { from: "Consumer", to: "$sink", schema: ASSISTANT },
        ],
      },
    }),
    {
      cwd: process.cwd(),
      scheduler: () => schedules.parallel(),
      tracer: new tracer.DummyTracer(),
      createAgent: async (spec) => {
        const { options } = spec.node === "Producer" ? producer : consumer;
        const member = await agent.JuncoAgent.fromResolved({
          ...options,
          systemPrompt: spec.systemPrompt,
          tools: spec.tools,
        });
        agents.push(member);
        return member;
      },
    },
  );
  try {
    await execution.run();
  } finally {
    await execution.graph.close();
  }
  assert.equal(rejectedString, true);
  assert.ok(sendSchema && recvDescription);
  assert.ok(Value.Check(sendSchema, { id: "numbers", payload: 7 }));
  assert.ok(!Value.Check(sendSchema, { id: "numbers", payload: "7" }));
  const output = JSON.parse(
    recvDescription.slice(recvDescription.indexOf("{")),
  );
  const inbox = { messages: [{ id: "numbers", payload: 7 }], values: [] };
  assert.ok(Value.Check(output, inbox));
  assert.ok(
    !Value.Check(output, {
      ...inbox,
      messages: [{ id: "numbers", payload: "7" }],
    }),
  );
  // Raw details: the retained payload is the number itself, not a wrapper or text.
  assert.deepEqual(received, inbox);
  const result = execution.graph.result(execution.graph.sink.id);
  assert.ok(O.isSome(result));
  assert.ok(Value.Check(AssistantMessageSchema, result.value));
  assert.equal(textOf(result.value), "consumed");
  const closed =
    agents.length === 2 && agents.every((member) => member.status === "closed");
  assert.ok(closed);
  return {
    scenario: "numeric-messaging",
    received: inbox.messages.map((message) => message.payload),
    rejectedString,
    closed,
  };
}

export type NumericNestingSummary = {
  readonly scenario: "numeric-yaml-nesting";
  readonly received: readonly number[];
  readonly result: number;
  readonly closed: boolean;
};

/**
 * Code only: a parent value `7` enters a nested graph as a numeric message, the child returns it,
 * and the child's sink forwards it raw onto a numeric parent message edge to the terminal.
 */
export async function runNumericNestingFixture(): Promise<NumericNestingSummary> {
  const received: number[] = [];
  const Terminal: syntax.DeterministicNode = ({ policy }) => ({
    state: new Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      for (const payload of view.messages.get(
        EdgeId.create("Child~>Terminal"),
      ) ?? []) {
        if (typeof payload !== "number")
          throw new TypeError("Terminal expects numbers");
        received.push(payload);
      }
      return received.at(-1);
    }, policy),
  });
  const execution = await JuncoGraph.fromYaml(
    yamlInput({
      graph: {
        nodes: {
          Seven: { kind: "code", trigger: "always" },
          Child: {
            kind: "graph",
            graph: {
              source: { routes: { "Seven->Child": ["$source~>Echo"] } },
              nodes: { Echo: { kind: "code" } },
              edges: [
                {
                  from: "$source",
                  to: "Echo",
                  kind: "message",
                  schema: NUMBER,
                },
                { from: "Echo", to: "$sink", schema: NUMBER },
              ],
            },
          },
          Terminal: { kind: "code" },
        },
        edges: [
          { from: "Seven", to: "Child", schema: NUMBER },
          { from: "Child", to: "Terminal", kind: "message", schema: NUMBER },
          { from: "Terminal", to: "$sink", schema: NUMBER },
        ],
      },
    }),
    {
      cwd: process.cwd(),
      scheduler: () => schedules.parallel(),
      tracer: new tracer.DummyTracer(),
      code: {
        Seven: Constant(7),
        Echo: Forward("$source~>Echo"),
        Terminal,
      },
    },
  );
  let result: unknown;
  try {
    await execution.run();
    result = O.toUndefined(execution.graph.result(execution.graph.sink.id));
  } finally {
    await execution.graph.close();
  }
  assert.deepEqual(received, [7]);
  assert.ok(typeof result === "number");
  assert.equal(result, 7);
  const closed = execution.graph.signal.aborted;
  assert.ok(closed);
  return { scenario: "numeric-yaml-nesting", received, result, closed };
}

if (import.meta.main) {
  for (const strategy of STRATEGIES)
    console.log(JSON.stringify(await runDeterministicFixture(strategy)));
  console.log(JSON.stringify(await runNumericMessagingFixture()));
  console.log(JSON.stringify(await runNumericNestingFixture()));
}
