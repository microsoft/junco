import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  Edge,
  EdgeId,
  Message as EdgeMessage,
  NodeId,
  TriggerEntry,
  TriggerRule,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import {
  AssistantMessageSchema,
  agent,
  Deterministic,
  JuncoGraph,
  schedules,
  type syntax,
  Task,
  TaskSchema,
  tools,
  tracer,
} from "junco";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  policyContext,
  STRATEGIES,
  type Strategy,
  terminalPorts,
  textOf,
  userTexts,
} from "./deterministic-support.ts";
import { countedCollection, leaf, offlineLadder } from "./support.ts";
import { Constant, Forward } from "./syntax-code-nodes.fixture.ts";

// Directly executable deterministic smoke: real faux-backed JuncoAgents, no credentials.
// The worker reads producer messages from its user transcript and values from its prompt callback.

export type DeterministicSummary = {
  readonly scheduler: Strategy;
  readonly producer: string;
  readonly worker: string;
  readonly inputs: readonly string[];
  readonly consumerUserTexts: readonly string[];
  readonly closed: boolean;
};

/** Run the producer/worker agency on `strategy` to quiescence, close it, and summarize it. */
export async function runDeterministicFixture(
  strategy: Strategy,
): Promise<DeterministicSummary> {
  const handoff = Edge.message("producer->worker", TaskSchema);
  const seed = Edge.message("$source->producer", TaskSchema);
  const seedTask = Task.create({
    kind: "prompt",
    text: "produce",
    spec: "worker done",
  });
  const value = Edge.value("producer=>worker", AssistantMessageSchema);
  const producer = await leaf(
    [
      fauxAssistantMessage(
        [
          { kind: "nextTurn", text: "context first" },
          { kind: "prompt", text: "then work" },
        ].map((payload, index) =>
          fauxToolCall(
            "send",
            {
              id: handoff.id,
              payload,
              handoff: "sent",
              task: seedTask.taskId,
              spec: seedTask.spec,
            },
            { id: `send-${index}` },
          ),
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("yield", { reason: "sent" }, { id: "y" }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("seed"),
    ],
    { tools: [new tools.SendTool()] },
  );

  let consumerUserTexts: string[] = [];
  let upstream: string | undefined;
  const worker = await leaf([
    (context) => {
      consumerUserTexts = userTexts(context.messages);
      return fauxAssistantMessage("done");
    },
  ]);
  await worker.agent.setSteeringMode("all");

  const ports = terminalPorts();
  const graphContext = policyContext(ports.source, ports.sink, strategy);
  await using graph = graphContext.graph;
  const p = graph.addNode({
    id: NodeId.create("producer"),
    state: producer.agent,
    prompt: "produce",
    description: "produces the seed",
    policy: tools.LockPolicy,
    trigger: TriggerRule.when(seed),
  });
  const w = graph.addNode({
    id: NodeId.create("worker"),
    state: worker.agent,
    prompt: (view) => {
      const result = view.values.get(value.id);
      assert.ok(Value.Check(AssistantMessageSchema, result));
      upstream = textOf(result);
      return `upstream: ${upstream}`;
    },
    policy: tools.LockPolicy,
    description: "works from the seed",
    trigger: TriggerRule.allOf(
      TriggerEntry.on(handoff),
      TriggerEntry.on(value),
    ),
  });
  graph
    .addEdge(p, w, handoff)
    .addEdge(p, w, value)
    .addEdge(ports.source.id, p, seed);
  graph.emit(ports.source.id, EdgeMessage.create(seed, seedTask));

  ports.connect(graph, w);
  await graphContext.run();

  const outputs = [p, w].map((id) => {
    const result = graph.result(id);
    assert.ok(O.isSome(result), `${id} has no result`);
    return textOf(result.value);
  });
  assert.deepEqual(outputs, ["seed", "done"]);

  assert.equal(upstream, "seed");
  assert.deepEqual(
    consumerUserTexts.map((text) => text.split("\n\nTask: ")[0]),
    ["upstream: seed", "context first", "then work"],
  );
  const inputs = consumerUserTexts;

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
    consumerUserTexts,
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
 * A producer agent sends on its numeric `numbers` route; the consumer reads the steered JSON.
 * The model-visible `send` schema rejects a non-number before the numeric send succeeds.
 */
export async function runNumericMessagingFixture(): Promise<NumericMessagingSummary> {
  let rejectedString = false;
  let sendSchema: TSchema | undefined;
  let consumerUserTexts: string[] = [];
  const ladder = await offlineLadder((context) => {
    const users = userTexts(context.messages);
    if (users[0] === "Receive your numbers.") {
      consumerUserTexts = users;
      return fauxAssistantMessage("consumed");
    }
    assert.equal(users[0], "Send the number seven on your route.");
    const previous = latest(context.messages, "send");
    if (previous?.role === "toolResult" && previous.toolCallId === "s2") {
      assert.equal(previous.isError, false);
      return fauxAssistantMessage("produced");
    }
    if (previous?.role === "toolResult") {
      assert.equal(previous.toolCallId, "s1");
      rejectedString = previous.isError;
      sendSchema = declared(context.messages, "send")?.parameters;
    }
    // Pi coerces numeric strings, so send a word before retrying with a number.
    return fauxAssistantMessage(
      fauxToolCall(
        "send",
        {
          id: "numbers",
          payload: previous ? 7 : "seven",
          handoff: "",
          task: "",
          spec: "",
        },
        { id: previous ? "s2" : "s1" },
      ),
      { stopReason: "toolUse" },
    );
  });
  const { collection } = countedCollection();
  await using _lifetime = { [Symbol.asyncDispose]: () => collection.close() };
  const execution = await JuncoGraph.fromYaml(
    yamlInput({
      graph: {
        sink: { returns: "Consumer" },
        nodes: {
          Start: {
            kind: "emit",
            text: "Send seven.",
            spec: "One numeric delivery.",
          },
          Producer: { prompt: "Send the number seven on your route." },
          Consumer: { prompt: "Receive your numbers." },
        },
        edges: [
          {
            from: "Start",
            to: "Producer",
            kind: "message",
            schema: { type: "object" },
          },
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
      args: {
        cwd: process.cwd(),
        collection,
        tracer: new tracer.DummyTracer(),
      },
      parameters: { scheduler: () => schedules.parallel(), ladder },
    },
  );
  const agents = ["Producer", "Consumer"].map(
    (id) => execution.graph.getNode(NodeId.create(id))?.state,
  );
  try {
    await execution.run();
  } finally {
    await execution.graph.close();
  }
  assert.equal(rejectedString, true);
  assert.ok(sendSchema);
  assert.ok(
    Value.Check(sendSchema, {
      id: "numbers",
      payload: 7,
      handoff: "",
      task: "",
      spec: "",
    }),
  );
  assert.ok(
    !Value.Check(sendSchema, {
      id: "numbers",
      payload: "7",
      handoff: "",
      task: "",
      spec: "",
    }),
  );
  assert.deepEqual(consumerUserTexts, [
    "Receive your numbers.",
    '{"id":"numbers","payload":7}',
  ]);
  const received = consumerUserTexts
    .slice(1)
    .map((text) => JSON.parse(text).payload);
  assert.deepEqual(received, [7]);
  const result = execution.graph.result(execution.graph.sink.id);
  assert.ok(O.isSome(result));
  assert.ok(Value.Check(AssistantMessageSchema, result.value));
  assert.equal(textOf(result.value), "consumed");
  const closed = agents.every(
    (member) =>
      member instanceof agent.JuncoAgent && member.status === "closed",
  );
  assert.ok(closed);
  return {
    scenario: "numeric-messaging",
    received,
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
  const Terminal: syntax.DeterministicNode = ({ policy }) =>
    new Deterministic<TSchema, unknown>(async function* () {
      const view = yield [];
      for (const payload of view.messages.get(
        EdgeId.create("Child~>Terminal"),
      ) ?? []) {
        if (typeof payload !== "number")
          throw new TypeError("Terminal expects numbers");
        received.push(payload);
      }
      return received.at(-1);
    }, policy);
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
      args: {
        cwd: process.cwd(),
        tracer: new tracer.DummyTracer(),
        code: { Seven: Constant(7), Echo: Forward("$source~>Echo"), Terminal },
      },
      parameters: { scheduler: () => schedules.parallel() },
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
