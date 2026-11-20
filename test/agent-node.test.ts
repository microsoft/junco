import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type ImageContent,
  type Message as ModelMessage,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  DataflowNodeError,
  DummyTracer,
  Edge,
  type EdgeIdType,
  from,
  Message,
  NodeId,
  type NodeIdType,
  type NodeOptions,
  type ParentView,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticOptions, JuncoAgentError } from "junco-agent";
import { EmptyPolicy, LockPolicy } from "junco-tools";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { renderTask } from "../src/agent-node.ts";
import {
  AssistantMessageSchema,
  agent as agentApi,
  Deterministic,
  JuncoGraph,
  MockAgent,
  schedules,
  Task,
  TaskSchema,
  tools as toolsApi,
} from "../src/index.ts";
import { nodePolicies, registeredNodeContexts } from "../src/node-policy.ts";
import {
  assistant,
  failed,
  plainContext,
  policyContext,
  requestTexts,
  run,
  STRATEGIES,
  settle,
  terminalPorts,
  textOf,
  userTexts,
  yieldsThen,
} from "./deterministic-support.ts";
import { nativeOptions } from "./support.ts";

// A complete task with fixed provenance, so expected steered text is deterministic.
const full = (text: string, taskId: string) =>
  ({ text, taskId, spec: "", deps: [], history: [] }) as const;
const asTask = (text: string, taskId: string) =>
  renderTask({ kind: "prompt", ...full(text, taskId) });

// The adapter is scheduler-agnostic: every scenario runs on both deterministic junco-scheduler
// policies. Execution scenarios keep the original MockAgent as node state; messaging scenarios use
// real JuncoAgents on faux providers, whose send/info calls run against their registrations.

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse())
    await close().catch(() => {});
});

type Chat = typeof TaskSchema;
type Graph = JuncoGraph;
const chatEdge = (id: string) =>
  Edge.message<Chat, AssistantMessage>(id, TaskSchema);
const answerEdge = (id: string) => Edge.value(id, AssistantMessageSchema);
type Route = {
  readonly id: string;
  readonly edgeId: string;
  readonly kind: string;
};
/** What `info` reports, as the model reads it from the tool's JSON text. */
type Topology = { readonly parents: Route[]; readonly children: Route[] };

const image = (data: string): ImageContent => ({
  type: "image",
  data,
  mimeType: "image/png",
});
const invalidState = (error: unknown) =>
  error instanceof JuncoAgentError && error.code === "invalid_state";

/** One faux assistant turn calling tool `name`. */
const call = (name: string, args: ToolCall["arguments"], id: string) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], {
    stopReason: "toolUse",
  });

/** The result of tool call `id` among `messages`. */
function resultOf(
  messages: readonly ModelMessage[],
  id: string,
): ToolResultMessage {
  const found = messages.find(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolCallId === id,
  );
  assert.ok(found, `no result for tool call ${id}`);
  return found;
}

/** The JSON text result of tool call `id` among `messages`, parsed. */
function jsonResult<R>(messages: readonly ModelMessage[], id: string): R {
  return JSON.parse(contentText(resultOf(messages, id).content)) as R;
}

/** Routes ordered by identity, so comparisons never depend on link traversal order. */
const sorted = (routes: readonly Route[]) =>
  [...routes].sort((a, b) =>
    `${a.id}|${a.edgeId}|${a.kind}`.localeCompare(
      `${b.id}|${b.edgeId}|${b.kind}`,
    ),
  );

/**
 * A real JuncoAgent with a genuine `yield` plus `tools`, serving `responses`.
 * Records each request's context and every tool result it commits. `N` is the graph's message schema.
 */
async function member<N extends TSchema = Chat>(
  responses: readonly FauxResponseStep[],
  {
    tools = [],
    prompt,
  }: {
    readonly tools?: readonly AgentTool[];
    readonly prompt?: AgenticOptions<
      Skill,
      PromptTemplate,
      AgentTool,
      N
    >["prompt"];
  } = {},
) {
  const contexts: Parameters<FauxResponseFactory>[0][] = [];
  const { faux, options } = await nativeOptions(
    responses.map(
      (step): FauxResponseFactory =>
        (context, ...rest) => {
          contexts.push(context);
          return typeof step === "function" ? step(context, ...rest) : step;
        },
    ),
  );
  const agent = await agentApi.JuncoAgent.fromResolved<
    Skill,
    PromptTemplate,
    AgentTool,
    N
  >({
    ...options,
    systemPrompt: "member",
    tools: [...tools],
    ...(prompt === undefined ? {} : { prompt }),
  });
  closers.push(() => agent.return());
  const results: ToolResultMessage[] = [];
  agent.events.on("message_end", ({ lane, message }) => {
    if (lane === "main" && message.role === "toolResult") results.push(message);
  });
  return { agent, faux, contexts, results };
}

/** A registered coroutine node that never runs. */
function inert(
  graph: Graph,
  options: {
    readonly id?: NodeIdType;
  } = {},
): NodeIdType {
  const body = new Deterministic<Chat, AssistantMessage>(async function* () {
    yield [];
    return assistant("inert");
  }, LockPolicy);
  return graph.addNode({
    ...options,
    trigger: TriggerRule.always(),
    is_available: () => false,
    state: body,
  });
}

/** A coroutine node `id` recording every payload delivered on `edge`. */
function sink(graph: Graph, edge: Edge<Chat, AssistantMessage>, id: string) {
  const delivered: Task[] = [];
  const body = new Deterministic<Chat, AssistantMessage>(async function* () {
    let view = yield [];
    while (true) {
      for (const payload of view.messages.get(edge.id) ?? [])
        delivered.push(payload);
      view = yield [];
    }
  }, LockPolicy);
  const node = graph.addNode({
    id: NodeId.create(id),
    trigger: TriggerRule.when(edge),
    state: body,
  });
  return { id: node, delivered };
}

/** Payloads queued on message edge `edgeId`, read without consuming them. */
function queued(graph: Graph, edgeId: EdgeIdType): number {
  let length = 0;
  graph.forEachLink((_from, _to, edge) => {
    if (edge.id === edgeId && E.isLeft(edge.transport))
      length += edge.transport.left.length;
  });
  return length;
}

/** Step `graph` until `reached` holds; fails rather than spin forever. */
async function stepUntil(
  graphContext: { step(): Promise<unknown> },
  reached: () => boolean,
): Promise<void> {
  for (let steps = 0; steps < 50 && !reached(); steps++)
    await graphContext.step();
  assert.ok(reached(), "the graph never reached the expected state");
}

for (const withhold of [false, true]) {
  test(
    withhold
      ? "scheduler reads override withholds messages from native requests and leaves queues intact"
      : "scheduler parallel steers ordered chat and numeric messages only to the wired native recipient",
    async () => {
      const numberSchema = Type.Number();
      type N = Chat | typeof numberSchema;
      const chat = chatEdge("sender->recipient");
      const numeric = Edge.message("sender-number->recipient", numberSchema);
      const unused = chatEdge("sender->bystander");
      const texts = ["first", "second", "third"];
      const recipient = await member<N>(
        [call("info", {}, "info-1"), fauxAssistantMessage("recipient done")],
        { prompt: "Read your inbox." },
      );
      const bystander = new MockAgent<Skill, PromptTemplate, AgentTool, N>({
        runs: [yieldsThen(0, "never")],
      });
      const ports = terminalPorts<N, typeof AssistantMessageSchema>(TaskSchema);
      const graph = new JuncoGraph(
        ports.source,
        ports.sink,
        Width.create(1),
        UNBOUNDED,
        new DummyTracer(),
        LockPolicy,
      );
      closers.push(() => graph.close());
      const execution = schedules.context({
        graph,
        scheduler: withhold
          ? schedules.reads(() => [], schedules.parallel())
          : schedules.parallel(),
      });
      const sender = graph.addNode({
        trigger: TriggerRule.always(),
        state: new Deterministic<N, AssistantMessage>(async function* () {
          yield [
            ...texts.map((text, i) =>
              Message.create(chat, {
                kind: "prompt",
                ...full(text, `1#${i + 1}`),
              }),
            ),
            Message.create(numeric, 42),
          ];
          return assistant("sender done");
        }, LockPolicy),
      });
      const r = graph.addNode({
        state: recipient.agent,
        policy: LockPolicy,
        trigger: TriggerRule.when(chat),
      });
      const b = graph.addNode({
        state: bystander,
        policy: LockPolicy,
        trigger: TriggerRule.when(unused),
      });
      graph
        .addEdge(sender, r, chat)
        .addEdge(sender, r, numeric)
        .addEdge(sender, b, unused);
      ports.connect(graph, r);
      await execution.run();

      // The info response guarantees a second request after Pi processes its steering queue.
      assert.equal(recipient.contexts.length, 2);
      assert.deepEqual(userTexts(recipient.contexts[1]!.messages), [
        "Read your inbox.",
        ...(withhold
          ? []
          : [
              ...texts.map((text, i) => asTask(text, `1#${i + 1}`)),
              JSON.stringify({ id: numeric.id, payload: 42 }),
            ]),
      ]);
      assert.deepEqual(bystander.requests, []);
      assert.ok(O.isNone(graph.result(b)));
      const messages = graph.observe().inputs.get(r)!.messages;
      assert.equal(messages.get(chat.id)?.length ?? 0, withhold ? 3 : 0);
      assert.equal(messages.get(numeric.id)?.length ?? 0, withhold ? 1 : 0);
    },
  );
}

for (const strategy of STRATEGIES) {
  describe(strategy, () => {
    test("a dependent's parent result is not injected: priming loses nothing and its staged prompt runs unchanged", async () => {
      const upstream = new MockAgent({
        prompt: "produce",
        runs: [yieldsThen(0, "upstream result")],
      });
      const dependent = new MockAgent({
        prompt: "use it",
        runs: [yieldsThen(2, "dependent done")],
      });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const edge = answerEdge("upstream->dependent");
      const u = graph.addNode({
        state: upstream,
        policy: LockPolicy,
        description: "upstream",
        trigger: TriggerRule.always(),
      });
      const d = graph.addNode({
        state: dependent,
        policy: LockPolicy,
        description: "dependent",
        trigger: TriggerRule.when(edge),
      });
      graph.addEdge(u, d, edge);

      graphPorts.connect(graph, d);
      assert.deepEqual([...graph.available().keys()], [u]);
      await graphContext.step(); // primes the upstream
      await graphContext.step(); // runs it to its result
      assert.ok(O.isSome(graph.result(u)));
      await graphContext.step(); // primes the dependent: no frame, input kept
      assert.equal(graph.getNode(d)!.status, "running");
      assert.equal(dependent.status, "ready");
      assert.deepEqual(dependent.requests, []);
      assert.deepEqual(dependent.history, []);
      await graphContext.run();

      assert.deepEqual(requestTexts(dependent.requests), [
        ["use it"],
        ["use it"],
        ["use it"],
      ]);
      assert.deepEqual(userTexts(dependent.history), ["use it"]);
      const result = graph.result(d);
      assert.ok(O.isSome(result) && textOf(result.value) === "dependent done");
    });

    test("a node re-armed through its value self-edge is not available until its trigger fires again", async () => {
      const member = new MockAgent({
        prompt: "round 1",
        runs: [yieldsThen(0, "round 1 done"), yieldsThen(0, "round 2 done")],
      });
      const assignment = chatEdge("assignment");
      const loop = answerEdge("worker->worker");
      const ports = terminalPorts();
      const execution = plainContext(ports.source, ports.sink, strategy);
      const graph = execution.graph;
      closers.push(() => graph.close());
      const feeder = graph.addNode({
        trigger: TriggerRule.always(),
        state: new Deterministic<Chat, AssistantMessage>(async function* () {
          yield [
            Message.create(
              assignment,
              Task.create({ kind: "prompt", text: "go", spec: "" }),
            ),
          ];
          return assistant("fed");
        }, LockPolicy),
      });
      const worker = graph.addNode({
        state: member,
        policy: LockPolicy,
        trigger: TriggerRule.when(assignment),
      });
      graph.addEdge(feeder, worker, assignment).addEdge(worker, worker, loop);
      ports.connect(graph, worker);

      await execution.run();
      assert.ok(O.isSome(graph.result(worker)));
      assert.equal(graph.getNode(worker)!.status, "ready"); // re-armed by the self-edge
      assert.equal(graph.available().has(worker), false); // trigger drained: not schedulable
      assert.deepEqual(requestTexts(member.requests), [["round 1"]]);

      member.stagePrompt("round 2");
      assert.equal(graph.available().has(worker), false); // a staged prompt alone is no trigger
      graph.emit(
        feeder,
        Message.create(
          assignment,
          Task.create({ kind: "prompt", text: "go again", spec: "" }),
        ),
      );
      assert.ok(graph.available().has(worker));
      await execution.run();
      assert.deepEqual(requestTexts(member.requests), [
        ["round 1"],
        ["round 1", "round 2"],
      ]);
    });

    test("delivered payload kinds are data and text payloads forward their images through steering", async () => {
      const images = [image("1"), image("2"), image("3"), image("4")] as const;
      const toRecipient = chatEdge("sender->recipient");
      const toBystander = chatEdge("sender->bystander");
      const payloads: Task[] = [
        {
          kind: "appendMessage",
          message: { role: "user", content: "note", timestamp: 1 },
        },
        {
          kind: "nextTurn",
          images: [images[0]],
          ...full("context first", "1#1"),
        },
        { kind: "prompt", images: [images[1]], ...full("then work", "1#2") },
        { kind: "steer", images: [images[2]], ...full("adjust", "1#3") },
        { kind: "followUp", ...full("confirm", "1#4") },
        {
          kind: "error",
          images: [images[3]],
          ...full("failed dependency", "1#5"),
        },
      ];
      const sender = new Deterministic<Chat, AssistantMessage>(
        async function* () {
          yield payloads.map((payload) => Message.create(toRecipient, payload));
          return assistant("sender done");
        },
        LockPolicy,
      );
      const recipient = await member([
        call("info", {}, "info-1"),
        fauxAssistantMessage("recipient done"),
      ]);
      const bystander = new MockAgent({ runs: [yieldsThen(0, "never")] });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      closers.push(() => graph.close());
      const s = graph.addNode({
        trigger: TriggerRule.always(),
        state: sender,
      });
      recipient.agent.stagePrompt("Read your inbox.");
      const r = graph.addNode({
        state: recipient.agent,
        policy: LockPolicy,
        trigger: TriggerRule.when(toRecipient),
      });
      const b = graph.addNode({
        state: bystander,
        policy: LockPolicy,
        trigger: TriggerRule.when(toBystander),
      });
      graph.addEdge(s, r, toRecipient).addEdge(s, b, toBystander);

      graphPorts.connect(graph, r);
      await graphContext.run();

      const users = recipient.contexts[1]!.messages.filter(
        (message) => message.role === "user",
      );
      assert.deepEqual(userTexts(recipient.contexts[1]!.messages), [
        "Read your inbox.",
        JSON.stringify({ id: toRecipient.id, payload: payloads[0] }),
        ...[
          "context first",
          "then work",
          "adjust",
          "confirm",
          "failed dependency",
        ].map((text, i) => asTask(text, `1#${i + 1}`)),
      ]);
      assert.deepEqual(
        users.flatMap((message) =>
          typeof message.content === "string"
            ? []
            : message.content.filter((part) => part.type === "image"),
        ),
        images,
      );
      assert.equal(recipient.faux.state.callCount, 2);
      assert.deepEqual(bystander.requests, []);
      assert.equal(bystander.status, "idle");
      assert.equal(graph.getNode(b)!.status, "ready");
      assert.ok(O.isNone(graph.result(b)));
      const result = graph.result(r);
      assert.ok(O.isSome(result) && textOf(result.value) === "recipient done");
    });

    test("a member with neither a staged nor a received prompt is quiescent", async () => {
      const idle = new MockAgent({ runs: [yieldsThen(0, "never")] });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const idleId = graph.addNode({
        state: idle,
        policy: LockPolicy,
        description: "idle",
        trigger: TriggerRule.always(),
      });

      graphPorts.connect(graph, idleId);
      assert.equal(graph.available().size, 0);
      await graphContext.run();
      assert.deepEqual(idle.requests, []);
      assert.equal(idle.status, "idle");
    });

    test("a delivery to a member without a prompt waits for a run, not a command", async () => {
      const edge = chatEdge("sender->member");
      const sender = new Deterministic<Chat, AssistantMessage>(
        async function* () {
          yield [
            Message.create(edge, {
              kind: "appendMessage",
              message: { role: "user", content: "remember this", timestamp: 1 },
            }),
          ];
          return assistant("sent");
        },
        LockPolicy,
      );
      const member = new MockAgent({
        runs: [run([settle(assistant("later"), { drain: ["steer"] })])],
      });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const s = graph.addNode({
        description: "sender",
        trigger: TriggerRule.always(),
        state: sender,
      });
      const m = graph.addNode({
        state: member,
        policy: LockPolicy,
        description: "member",
        trigger: TriggerRule.when(edge),
      });
      graph.addEdge(s, m, edge);

      graphPorts.connect(graph, s);
      await graphContext.run();

      assert.deepEqual(member.requests, []);
      assert.equal(member.status, "idle");
      assert.equal(graph.getNode(m)!.status, "running");
      assert.equal(graph.available().size, 0);
      assert.equal(textOf(await member.prompt("and now")), "later");
      assert.deepEqual(requestTexts(member.requests), [
        [
          "and now",
          JSON.stringify({
            id: edge.id,
            payload: {
              kind: "appendMessage",
              message: { role: "user", content: "remember this", timestamp: 1 },
            },
          }),
        ],
      ]);
    });

    for (const stopReason of ["error", "aborted"] as const) {
      test(`a ${stopReason} final message is returned as a node result without closing the member`, async () => {
        const erring = new MockAgent({
          prompt: "go",
          runs: [
            run([settle(assistant("", stopReason))]),
            yieldsThen(0, "recovered"),
          ],
        });
        const graphPorts = terminalPorts();
        const graphContext = plainContext(
          graphPorts.source,
          graphPorts.sink,
          strategy,
        );
        const graph = graphContext.graph;
        const id = graph.addNode({
          state: erring,
          policy: LockPolicy,
          description: "erring",
          trigger: TriggerRule.always(),
        });

        graphPorts.connect(graph, id);
        await graphContext.run();
        const result = graph.result(id);
        assert.ok(O.isSome(result) && result.value.stopReason === stopReason);
        assert.equal(erring.status, "idle");
        assert.equal(textOf(await erring.prompt("still usable")), "recovered");
      });
    }

    test("a failed run fails its node with the identical cause and activates no value dependent", async () => {
      const cause = new Error("provider down");
      const failing = new MockAgent({
        prompt: "go",
        runs: [run([{ step: failed(cause) }])],
      });
      const child = new MockAgent({
        prompt: "never",
        runs: [yieldsThen(0, "never")],
      });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const edge = answerEdge("failing->child");
      const f = graph.addNode({
        state: failing,
        policy: LockPolicy,
        description: "failing",
        trigger: TriggerRule.always(),
      });
      const c = graph.addNode({
        state: child,
        policy: LockPolicy,
        description: "child",
        trigger: TriggerRule.when(edge),
      });
      graph.addEdge(f, c, edge);

      graphPorts.connect(graph, c);
      const error = await graphContext.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === f);
      assert.equal(error.error, cause);
      assert.ok(O.isNone(graph.result(f)));
      assert.equal(graph.available().size, 0);
      assert.equal(graph.getNode(c)!.status, "ready");
      assert.deepEqual(child.requests, []);
      assert.equal(child.status, "ready");
    });

    test("an exhausted transcript fails its node instead of hanging", async () => {
      const exhausted = new MockAgent({ prompt: "go", runs: [] });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const id = graph.addNode({
        state: exhausted,
        policy: LockPolicy,
        description: "exhausted",
        trigger: TriggerRule.always(),
      });

      graphPorts.connect(graph, id);
      const error = await graphContext.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === id);
      assert.ok(invalidState(error.error));
      assert.ok(O.isNone(graph.result(id)));
    });

    test("a member closed before its run settles fails its node as closed", async () => {
      const member = new MockAgent({
        prompt: "go",
        runs: [yieldsThen(1, "never")],
      });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const id = graph.addNode({
        state: member,
        policy: LockPolicy,
        description: "member",
        trigger: TriggerRule.always(),
      });

      graphPorts.connect(graph, id);
      await graphContext.step(); // prime
      await graphContext.step(); // starts the run, which pauses
      assert.equal(member.status, "suspended");
      assert.deepEqual(await member.return(), { value: undefined, done: true });
      const error = await graphContext
        .step()
        .catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === id);
      assert.ok(
        error.error instanceof JuncoAgentError && error.error.code === "closed",
      );
    });

    test("a reused member runs its constructor prompt in one graph and an explicitly staged prompt in the next", async () => {
      const upstream = new MockAgent({
        prompt: "produce",
        runs: [yieldsThen(0, "context")],
      });
      const seen: ParentView<Chat, AssistantMessage>[] = [];
      const member = new MockAgent({
        prompt: (inputs) => {
          seen.push(inputs);
          return "round one";
        },
        runs: [yieldsThen(1, "first"), yieldsThen(0, "second")],
      });
      const firstPorts = terminalPorts();
      const firstContext = plainContext(
        firstPorts.source,
        firstPorts.sink,
        strategy,
      );
      const first = firstContext.graph;
      const edge = answerEdge("upstream->member");
      const upstreamId = first.addNode({
        state: upstream,
        policy: LockPolicy,
        description: "upstream",
        trigger: TriggerRule.always(),
      });
      const firstId = first.addNode({
        state: member,
        policy: LockPolicy,
        description: "member",
        trigger: TriggerRule.when(edge),
      });
      first.addEdge(upstreamId, firstId, edge);

      firstPorts.connect(first, firstId);
      assert.deepEqual([...first.available().keys()], [upstreamId]);
      await firstContext.run();
      const firstResult = first.result(firstId);
      assert.ok(O.isSome(firstResult) && textOf(firstResult.value) === "first");
      assert.equal(seen.length, 1);

      const secondPorts = terminalPorts();
      const secondContext = plainContext(
        secondPorts.source,
        secondPorts.sink,
        strategy,
      );
      const second = secondContext.graph;
      member.stagePrompt((inputs) => {
        seen.push(inputs);
        return "round two";
      });
      const secondId = second.addNode({
        state: member,
        policy: LockPolicy,
        description: "member",
        trigger: TriggerRule.always(),
      });
      secondPorts.connect(second, secondId);
      await secondContext.run();
      const secondResult = second.result(secondId);
      assert.ok(
        O.isSome(secondResult) && textOf(secondResult.value) === "second",
      );
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.values.get(edge.id), undefined);
      assert.equal(seen[1]!.messages.get(edge.id), undefined);
      // Value inputs remain callback data, never injected user messages.
      assert.deepEqual(userTexts(member.history), ["round one", "round two"]);
    });

    test("staging over a staged prompt is busy and preserves the original stage", async () => {
      const member = new MockAgent({
        prompt: "staged",
        runs: [yieldsThen(0, "staged result")],
      });
      let otherCalls = 0;
      assert.throws(
        () =>
          member.stagePrompt(() => {
            otherCalls++;
            return "other";
          }),
        (error: unknown) =>
          error instanceof JuncoAgentError && error.code === "busy",
      );
      assert.equal(member.status, "ready");
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const id = graph.addNode({
        state: member,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      graphPorts.connect(graph, id);
      await graphContext.run();
      const result = graph.result(id);
      assert.ok(O.isSome(result) && textOf(result.value) === "staged result");
      assert.deepEqual(userTexts(member.history), ["staged"]);
      assert.equal(otherCalls, 0);
    });

    test("a prompt callback sees the delivered inputs once, after priming, while messages are steered", async () => {
      const notes = chatEdge("notes->agent");
      const seed = answerEdge("seed=>agent");
      const seedMessage = assistant("seed");
      const note: Task = { kind: "prompt", ...full("note", "agent#1") };
      const seen: [unknown, unknown][] = [];
      const receiver = await member(
        [
          call("yield", { reason: "later" }, "yield-later"),
          fauxAssistantMessage("done"),
        ],
        {
          prompt: (inputs) => {
            seen.push([
              inputs.messages.get(notes.id),
              inputs.values.get(seed.id),
            ]);
            return "Use note with seed";
          },
        },
      );
      const graphPorts = terminalPorts();
      const graphContext = policyContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      closers.push(() => graph.close());
      const seedId = graph.addNode({
        id: NodeId.create("seed"),
        trigger: TriggerRule.always(),
        state: new Deterministic<Chat, AssistantMessage>(
          // biome-ignore lint/correctness/useYield: a source resolving on its first activation.
          async function* () {
            return seedMessage;
          },
          LockPolicy,
        ),
      });
      const notesId = inert(graph, { id: NodeId.create("notes") });
      const agentId = graph.addNode({
        state: receiver.agent,
        id: NodeId.create("agent"),
        policy: LockPolicy,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(notes),
          TriggerEntry.on(seed),
        ),
      });
      graph.addEdge(seedId, agentId, seed).addEdge(notesId, agentId, notes);

      graphPorts.connect(graph, agentId);
      await stepUntil(graphContext, () => O.isSome(graph.result(seedId)));
      await graphContext.run();
      assert.equal(seen.length, 0);
      assert.equal(receiver.faux.state.callCount, 0);

      graph.emit(notesId, Message.create(notes, note));
      await stepUntil(
        graphContext,
        () => graph.getNode(agentId)!.status === "running",
      );
      assert.equal(seen.length, 0);
      assert.equal(receiver.faux.state.callCount, 0);

      await graphContext.run();
      assert.deepEqual(seen, [[[note], seedMessage]]);
      const result = graph.result(agentId);
      assert.ok(O.isSome(result) && textOf(result.value) === "done");
      assert.deepEqual(userTexts(receiver.contexts.at(-1)!.messages), [
        "Use note with seed",
        asTask("note", "agent#1"),
      ]);
      const calls = receiver.faux.state.callCount;
      await graphContext.run();
      assert.equal(seen.length, 1);
      assert.equal(receiver.faux.state.callCount, calls);
    });

    test("a prompt callback's throw fails its node with the identical cause before any request", async () => {
      const cause = new Error("no prompt");
      const thrower = await member([fauxAssistantMessage("never")], {
        prompt: () => {
          throw cause;
        },
      });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      closers.push(() => graph.close());
      const id = graph.addNode({
        state: thrower.agent,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });

      graphPorts.connect(graph, id);
      const error = await graphContext.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === id);
      assert.equal(error.error, cause);
      assert.ok(O.isNone(graph.result(id)));
      assert.equal(thrower.faux.state.callCount, 0);
      assert.equal(thrower.agent.status, "idle");
    });

    test("an explicit step is registered unchanged, a step-less coroutine runs itself, and a step-less unsupported or bare graph spec is rejected", async () => {
      const mock = new MockAgent({
        prompt: "unused",
        runs: [yieldsThen(0, "never")],
      });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const id = graph.addNode({
        state: mock,
        // biome-ignore lint/correctness/useYield: a custom body resolving on its first activation.
        step: async function* () {
          return assistant("custom");
        },
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      graphPorts.connect(graph, id);
      await graphContext.run();
      const result = graph.result(id);
      assert.ok(O.isSome(result) && textOf(result.value) === "custom");
      assert.equal(mock.status, "ready");
      assert.deepEqual(mock.requests, []);

      const coroutine = new Deterministic<Chat, AssistantMessage>(
        async function* () {
          yield [];
          return assistant("coroutine");
        },
        LockPolicy,
      );
      const shorthand = graph.addNode({
        state: coroutine,
        trigger: TriggerRule.always(),
      });
      await graphContext.run();
      const coroutineResult = graph.result(shorthand);
      assert.ok(
        O.isSome(coroutineResult) &&
          textOf(coroutineResult.value) === "coroutine",
      );

      const rejectedPorts = terminalPorts();
      const rejectedGraph = plainContext(
        rejectedPorts.source,
        rejectedPorts.sink,
        strategy,
      ).graph;
      for (const state of [rejectedGraph, undefined]) {
        const targetPorts = terminalPorts();
        const targetContext = plainContext(
          targetPorts.source,
          targetPorts.sink,
          strategy,
        );
        const target = targetContext.graph;
        const nodeId = NodeId.create("stepless");
        assert.throws(
          () =>
            target.addNode({
              id: nodeId,
              state,
              policy: LockPolicy,
              trigger: TriggerRule.always(),
            } as never),
          TypeError,
        );
        assert.equal(target.getNode(nodeId), undefined);
      }
    });

    test("one shared availability predicate holds ready agent, coroutine and graph nodes until released", async () => {
      let admitted = false;
      const shared: NodeOptions<Chat, AssistantMessage> = {
        trigger: TriggerRule.always(),
        is_available: (_view, triggered) => admitted && triggered,
      };
      const agent = new MockAgent({
        prompt: "go",
        runs: [yieldsThen(1, "agent done")],
      });
      const inner = new MockAgent({
        prompt: "inner",
        runs: [yieldsThen(0, "inner done")],
      });
      const childPorts = terminalPorts();
      const childContext = plainContext(
        childPorts.source,
        childPorts.sink,
        strategy,
      );
      const child = childContext.graph;
      const innerId = child.addNode({
        state: inner,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      childPorts.connect(child, innerId);
      let entered = false;
      const coroutine = new Deterministic<Chat, AssistantMessage>(
        async function* () {
          entered = true;
          yield [];
          return assistant("coroutine done");
        },
        LockPolicy,
      );
      const consumer = new MockAgent({ runs: [yieldsThen(0, "consumed")] });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const fromAgent = answerEdge("agent->consumer");
      const a = graph.addNode({
        ...shared,
        policy: LockPolicy,
        state: agent,
        id: NodeId.create("agent"),
      });
      const d = graph.addNode({
        ...shared,
        id: NodeId.create("coroutine"),
        state: coroutine,
      });
      const g = graph.addNode({
        ...shared,
        id: NodeId.create("graph"),
        state: childContext,
      });
      consumer.stagePrompt("consume");
      const c = graph.addNode({
        state: consumer,
        policy: LockPolicy,
        trigger: TriggerRule.when(fromAgent),
      });
      graph.addEdge(a, c, fromAgent);

      graphPorts.connect(graph, c);
      assert.equal(graph.available().size, 0);
      assert.equal((await graphContext.run()).size, 0);
      assert.deepEqual(
        [agent.requests, inner.requests, consumer.requests],
        [[], [], []],
      );
      assert.equal(agent.status, "ready");
      assert.equal(entered, false);
      assert.ok([a, d, g, c].every((id) => O.isNone(graph.result(id))));

      admitted = true;
      await graphContext.run();

      const texts = [a, d, g, c].map((id) => {
        const result = graph.result(id);
        return O.isSome(result) ? textOf(result.value) : undefined;
      });
      assert.deepEqual(texts, [
        "agent done",
        "coroutine done",
        "inner done",
        "consumed",
      ]);
      assert.deepEqual(requestTexts(consumer.requests), [["consume"]]);
      assert.equal(graph.getNode(g)!.state, child);
    });

    test("an agent discovers its routes, receives steering and sends with tools, and pauses only at Yield and policy denials", async () => {
      const toAgent = chatEdge("source->agent");
      const seed = answerEdge("source=>agent");
      const toSink = chatEdge("agent->sink");
      const notes: Task[] = [
        { kind: "prompt", ...full("first", "agent#1") },
        { kind: "followUp", ...full("second", "agent#2") },
      ];
      const seedMessage = assistant("seed");
      const source = new Deterministic<Chat, AssistantMessage>(
        async function* () {
          yield notes.map((note) => Message.create(toAgent, note));
          return seedMessage;
        },
        LockPolicy,
      );
      const lookup: AgentTool = {
        name: "lookup",
        label: "lookup",
        description: "Looks something up.",
        parameters: Type.Object({}),
        execute: async () => {
          throw new Error("lookup failed");
        },
      };
      const publish: AgentTool = {
        name: "publish",
        label: "publish",
        description: "Publishes under policy.",
        parameters: Type.Object({}),
        execute: async () => {
          throw Object.assign(new Error("denied by policy"), {
            code: "MARSH_POLICY_DENIED",
          });
        },
      };
      const receiver = await member(
        [
          call("info", {}, "info-1"),
          call("lookup", {}, "lookup-1"),
          (context) => {
            // The route comes from info's actual result, never from the script.
            const route = jsonResult<Topology>(
              context.messages,
              "info-1",
            ).children.find(({ kind }) => kind === "message");
            assert.ok(route);
            return call(
              "send",
              {
                id: route.edgeId,
                payload: { kind: "prompt", text: "forwarded" },
                task: "agent#1",
                spec: "",
                handoff: "",
              },
              "send-1",
            );
          },
          call("yield", { reason: "checkpoint" }, "yield-1"),
          call("publish", {}, "publish-1"),
          fauxAssistantMessage("done"),
        ],
        {
          tools: [
            new toolsApi.SendTool(),
            new toolsApi.InfoTool(),
            lookup,
            publish,
          ],
        },
      );
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      closers.push(() => graph.close());
      const sourceId = graph.addNode({
        id: NodeId.create("source"),
        trigger: TriggerRule.always(),
        state: source,
      });
      receiver.agent.stagePrompt(
        "Inspect info, then work through your messages.",
      );
      const agentId = graph.addNode({
        state: receiver.agent,
        id: NodeId.create("agent"),
        policy: LockPolicy,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(toAgent),
          TriggerEntry.on(seed),
        ),
      });
      const out = sink(graph, toSink, "sink");
      graph
        .addEdge(sourceId, agentId, toAgent)
        .addEdge(sourceId, agentId, seed)
        .addEdge(agentId, out.id, toSink);
      const policy = nodePolicies.get(graph.getNode(agentId)!.step)!;

      graphPorts.connect(graph, agentId);
      await stepUntil(
        graphContext,
        () => receiver.agent.status === "suspended",
      );
      // The first public pause is the explicit Yield: every earlier tool ran in the same run.
      assert.deepEqual(
        policy.lastYield?.map(({ kind, toolName }) => [kind, toolName]),
        [["tool", "yield"]],
      );
      assert.equal(receiver.faux.state.callCount, 4);
      assert.deepEqual(
        receiver.results.map(({ toolName, isError }) => [toolName, isError]),
        [
          ["info", false],
          ["lookup", true],
          ["send", false],
          ["yield", false],
        ],
      );
      const info = jsonResult<Topology>(receiver.results, "info-1");
      assert.deepEqual(
        sorted(info.parents),
        sorted([
          {
            id: sourceId,
            edgeId: toAgent.id,
            kind: "message",
          },
          {
            id: sourceId,
            edgeId: seed.id,
            kind: "value",
          },
        ]),
      );
      assert.deepEqual(info.children, [
        {
          id: out.id,
          edgeId: toSink.id,
          kind: "message",
        },
        {
          id: graph.sink.id,
          edgeId: "terminal->$sink",
          kind: "value",
        },
      ]);
      assert.deepEqual(userTexts(receiver.contexts.at(-1)!.messages), [
        "Inspect info, then work through your messages.",
        asTask("first", "agent#1"),
        asTask("second", "agent#2"),
      ]);
      // send admitted exactly one message before the run resumed.
      assert.equal(queued(graph, toSink.id) + out.delivered.length, 1);

      await stepUntil(
        graphContext,
        () => policy.lastYield?.[0]?.kind === "policy",
      );
      assert.equal(receiver.agent.status, "suspended");
      assert.equal(receiver.faux.state.callCount, 5);
      assert.deepEqual(
        policy.lastYield?.map(({ kind, toolName }) => [kind, toolName]),
        [["policy", "publish"]],
      );
      const denied = resultOf(receiver.results, "publish-1");
      assert.ok(denied.isError);
      assert.match(contentText(denied.content), /denied by policy/);

      await graphContext.run();
      assert.equal(receiver.faux.state.callCount, 6);
      const result = graph.result(agentId);
      assert.ok(O.isSome(result) && textOf(result.value) === "done");
      assert.deepEqual(out.delivered, [
        {
          kind: "prompt",
          text: "forwarded",
          taskId: "agent#1",
          spec: "",
          deps: [],
          history: [{ node: "agent", desc: "first", handoff: "" }],
        },
      ]);
    });

    test("shared messaging carriers act for each agent's own registration; a copied carrier gains no graph authority", async () => {
      const direct: string[] = [];
      const directHost = {
        sendParameters: toolsApi.SendTool.parametersFor([]),
        send: () => void direct.push("send"),
        info: () => {
          direct.push("info");
          return { parents: [], children: [] };
        },
      };
      const shared = [
        new toolsApi.InfoTool(directHost),
        new toolsApi.SendTool(directHost),
      ];
      const script = (text: string, task: string) => [
        call("info", {}, "info-1"),
        (context: Parameters<FauxResponseFactory>[0]) => {
          const route = jsonResult<Topology>(
            context.messages,
            "info-1",
          ).children.find(({ kind }) => kind === "message");
          assert.ok(route);
          return call(
            "send",
            {
              id: route.edgeId,
              payload: { kind: "prompt", text },
              task,
              spec: "",
              handoff: "h",
            },
            "send-1",
          );
        },
        fauxAssistantMessage(`${text} done`),
      ];
      const p = await member(script("from P", "TP"), { tools: shared });
      const q = await member(script("from Q", "TQ"), { tools: shared });
      const copy = { ...new toolsApi.InfoTool() };
      const r = await member([
        call("info", {}, "info-1"),
        fauxAssistantMessage("R done"),
      ]);
      await r.agent.setTools([copy]);
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      closers.push(() => graph.close());
      const fromF = chatEdge("F->P");
      const fromFQ = chatEdge("F->Q");
      const feeder = graph.addNode({
        id: NodeId.create("F"),
        trigger: TriggerRule.always(),
        state: new Deterministic<Chat, AssistantMessage>(async function* () {
          yield [
            Message.create(fromF, { kind: "prompt", ...full("work", "TP") }),
            Message.create(fromFQ, { kind: "prompt", ...full("work", "TQ") }),
          ];
          return assistant("fed");
        }, LockPolicy),
      });
      const ids = [p, q, r].map((agent, index) => {
        agent.agent.stagePrompt("Report along your message route.");
        return graph.addNode({
          state: agent.agent,
          id: NodeId.create(["P", "Q", "R"][index]!),
          policy: LockPolicy,
          trigger: [
            TriggerRule.when(fromF),
            TriggerRule.when(fromFQ),
            TriggerRule.always(),
          ][index]!,
        });
      });
      const toP = chatEdge("P->sink");
      const toQ = chatEdge("Q->sink");
      const sinkP = sink(graph, toP, "sinkP");
      const sinkQ = sink(graph, toQ, "sinkQ");
      graph
        .addEdge(feeder, ids[0]!, fromF)
        .addEdge(feeder, ids[1]!, fromFQ)
        .addEdge(ids[0]!, sinkP.id, toP)
        .addEdge(ids[1]!, sinkQ.id, toQ);

      graphPorts.connect(graph, ids[2]!);
      await graphContext.run();

      for (const [agent, out, edge, inbound] of [
        [p, sinkP, toP, fromF],
        [q, sinkQ, toQ, fromFQ],
      ] as const) {
        assert.deepEqual(jsonResult<Topology>(agent.results, "info-1"), {
          parents: [{ id: feeder, edgeId: inbound.id, kind: "message" }],
          children: [{ id: out.id, edgeId: edge.id, kind: "message" }],
        });
      }
      for (const [node, sink] of [
        ["P", sinkP],
        ["Q", sinkQ],
      ] as const) {
        assert.deepEqual(sink.delivered, [
          {
            kind: "prompt",
            ...full(`from ${node}`, `T${node}`),
            history: [{ node, desc: "work", handoff: "h" }],
          },
        ]);
      }
      // Neither the constructors' direct host nor the copy acquired anyone's graph routes.
      assert.deepEqual(direct, []);
      assert.ok(resultOf(r.results, "info-1").isError);
      assert.equal(toolsApi.InfoTool.is(copy), false);
      await assert.rejects(
        toolsApi.InfoTool.invoke(
          copy as toolsApi.InfoTool,
          directHost,
          "info-2",
          {},
          new AbortController().signal,
        ),
        TypeError,
      );
      assert.deepEqual(direct, []);
    });

    test("a closed graph's registration rejects info and send instead of admitting", async () => {
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      const edge = chatEdge("a->b");
      const a = inert(graph, { id: NodeId.create("a") });
      const b = inert(graph, {
        id: NodeId.create("b"),
      });
      graph.addEdge(a, b, edge);
      graphPorts.connect(graph, b);
      const registration = registeredNodeContexts.get(graph.getNode(a)!)!;
      const late = Message.create(
        edge,
        Task.create({ kind: "prompt", text: "late", spec: "" }),
      );
      registration.send(late);
      assert.deepEqual(
        registration.info().children.map(({ id }) => id),
        [b],
      );

      await graph.close();

      assert.throws(() => registration.info());
      assert.throws(() => registration.send(late));
      assert.equal(queued(graph, edge.id), 1);
    });

    test("info reports every actual live route under engine node ids without running receivers", async () => {
      const ab1 = chatEdge("a-b-1");
      const ab2 = chatEdge("a-b-2");
      const abValue = answerEdge("a=>b");
      const bd = chatEdge("b-d");
      const self = chatEdge("b-self");
      const bw = chatEdge("b-w");
      const xy = chatEdge("b-d");
      const be = chatEdge("b-e");
      const b = await member([
        call("info", {}, "info-1"),
        call("yield", { reason: "topology may change" }, "yield-1"),
        call("info", {}, "info-2"),
        fauxAssistantMessage("inspected"),
      ]);
      // Topology discovery does not execute a receiving agent.
      const d = new MockAgent({ runs: [] });
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      closers.push(() => graph.close());
      const a = inert(graph, { id: NodeId.create("A") });
      b.agent.stagePrompt("Inspect your routes.");
      const bId = graph.addNode({
        state: b.agent,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      const dId = graph.addNode({
        state: d,
        policy: LockPolicy,
        trigger: TriggerRule.when(bd),
      });
      // A nested wrapper is exposed under its outer node id.
      const innerPorts = terminalPorts();
      const innerContext = plainContext(
        innerPorts.source,
        innerPorts.sink,
        strategy,
      );
      const inner = innerContext.graph;
      const innerId = inert(inner);
      innerPorts.connect(inner, innerId);
      const w = graph.addNode({
        id: NodeId.create("W"),
        trigger: TriggerRule.when(bw),
        state: innerContext,
      });
      // A disconnected link reusing B->D's edge id stays a separate route.
      const x = inert(graph, { id: NodeId.create("X") });
      const y = inert(graph, {
        id: NodeId.create("Y"),
      });
      const z = inert(graph, { id: NodeId.create("Z") });
      graph
        .addEdge(a, bId, ab1)
        .addEdge(a, bId, ab2)
        .addEdge(a, bId, abValue)
        .addEdge(bId, dId, bd)
        .addEdge(bId, bId, self)
        .addEdge(bId, w, bw)
        .addEdge(x, y, xy);
      const info = (id: NodeIdType) =>
        registeredNodeContexts.get(graph.getNode(id)!)!.info();

      graphPorts.connect(graph, bId);
      await stepUntil(graphContext, () => b.agent.status === "suspended");
      // While B is paused, add a route to the live graph.
      const e = inert(graph);
      graph.addEdge(bId, e, be);
      await graphContext.run();

      const parents = [
        { id: a, edgeId: ab1.id, kind: "message" },
        { id: a, edgeId: ab2.id, kind: "message" },
        { id: a, edgeId: abValue.id, kind: "value" },
        {
          id: bId,
          edgeId: self.id,
          kind: "message",
        },
      ];
      const children = [
        {
          id: graph.sink.id,
          edgeId: "terminal->$sink",
          kind: "value",
        },
        {
          id: bId,
          edgeId: self.id,
          kind: "message",
        },
        {
          id: w,
          edgeId: bw.id,
          kind: "message",
        },
      ];
      const first = jsonResult<Topology>(b.results, "info-1");
      assert.deepEqual(sorted(first.parents), sorted(parents));
      assert.deepEqual(
        sorted(first.children),
        sorted([
          ...children,
          {
            id: dId,
            edgeId: bd.id,
            kind: "message",
          },
        ]),
      );
      const second = jsonResult<Topology>(b.results, "info-2");
      assert.deepEqual(sorted(second.parents), sorted(parents));
      assert.deepEqual(
        sorted(second.children),
        sorted([
          ...children,
          {
            id: dId,
            edgeId: bd.id,
            kind: "message",
          },
          { id: e, edgeId: be.id, kind: "message" },
        ]),
      );
      // A's child routes to B mirror B's parent routes from A.
      assert.deepEqual(
        sorted(info(a).children),
        sorted(
          parents
            .filter((route) => route.id === a)
            .map((route) => ({ ...route, id: bId })),
        ),
      );
      assert.deepEqual(info(y), {
        parents: [
          {
            id: x,
            edgeId: xy.id,
            kind: "message",
          },
        ],
        children: [],
      });
      assert.deepEqual(info(z), { parents: [], children: [] });
      assert.deepEqual(d.requests, []);
      assert.equal(d.status, "idle");
      const result = graph.result(bId);
      assert.ok(O.isSome(result) && textOf(result.value) === "inspected");
    });
  });
}

test("a same-named tool that is not the genuine Yield, or a plain error, does not pause", async () => {
  const impostor: AgentTool = {
    name: "yield",
    label: "yield",
    description: "Not the scheduling primitive.",
    parameters: Type.Object({ reason: Type.String() }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "noted" }],
      details: params,
    }),
  };
  const failing: AgentTool = {
    name: "lookup",
    label: "lookup",
    description: "Fails.",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("lookup failed");
    },
  };
  const { faux, options } = await nativeOptions([
    call("yield", { reason: "not really" }, "yield-1"),
    call("lookup", {}, "lookup-1"),
    fauxAssistantMessage("continued"),
  ]);
  const agent = await agentApi.JuncoAgent.fromResolved({
    ...options,
    systemPrompt: "member",
    tools: [],
  });
  await agent.setTools([impostor, failing]);
  closers.push(() => agent.return());
  agent.prompt("go").catch(() => undefined);
  const step = await agent.next();
  assert.ok(
    step.value?.kind === "settled" &&
      textOf(step.value.message) === "continued",
  );
  assert.equal(faux.state.callCount, 3);
});

test("a collectionless real agent uses its node's policy", async () => {
  const { options } = await nativeOptions([
    fauxAssistantMessage("collectionless-ok"),
  ]);
  const agent = await agentApi.JuncoAgent.fromResolved({
    ...options,
    tools: [],
  });
  const graphPorts = terminalPorts();
  const graphContext = policyContext(
    graphPorts.source,
    graphPorts.sink,
    "parallel",
  );
  const graph = graphContext.graph;
  try {
    const id = NodeId.create("free");
    agent.stagePrompt("go");
    graph.addNode({
      state: agent,
      id,
      policy: EmptyPolicy,
      trigger: TriggerRule.always(),
    });
    graphPorts.connect(graph, id);
    const result = await graphContext.run();
    assert.equal(contentText(result.get(id)!.content), "collectionless-ok");
  } finally {
    await graph.close();
  }
});

describe("edge schemas reach each agent's messaging tools", () => {
  const NumberSchema = Type.Number();
  const StringSchema = Type.String();
  /** Chat ports, numeric and text routes between members. */
  type N = Chat | typeof NumberSchema | typeof StringSchema;
  type T = AssistantMessage;
  /** A parallel graph over chat ports whose members may route numbers and text. */
  const typedGraph = () => {
    const ports = terminalPorts<N, typeof AssistantMessageSchema>(TaskSchema);
    const graph = new JuncoGraph(
      ports.source,
      ports.sink,
      Width.create(1),
      UNBOUNDED,
      new DummyTracer(),
      LockPolicy,
    );
    closers.push(() => graph.close());
    return {
      ports,
      graph,
      execution: schedules.context({ graph, scheduler: schedules.parallel() }),
    };
  };
  /** A coroutine recording every payload delivered on `edge`. */
  const collector = <S extends N>(
    graph: JuncoGraph<N, T>,
    edge: Edge<S, T>,
    id: string,
  ) => {
    const delivered: Static<S>[] = [];
    const node = graph.addNode({
      id: NodeId.create(id),
      trigger: TriggerRule.when(edge),
      state: new Deterministic<N, T>(async function* () {
        let view = yield [];
        while (true) {
          delivered.push(...from(view, edge));
          view = yield [];
        }
      }, LockPolicy),
    });
    return { id: node, delivered };
  };
  /** The tool `name` the model saw in `context`: its system messages replayed in order. */
  const toolIn = (
    context: Parameters<FauxResponseFactory>[0],
    name: string,
  ) => {
    const tools = new Map<string, Tool>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const removed of message.toolsRemoved ?? [])
        tools.delete(removed.name);
      for (const added of message.toolsAdded ?? [])
        tools.set(added.name, added);
    }
    const tool = tools.get(name);
    assert.ok(tool, `request offers ${name}`);
    return tool;
  };

  // Non-task payloads pass through; send still requires its task fields.
  const noTask = { task: "none", spec: "", handoff: "" };

  test("one shared send carrier offers each agent its own route schema without mutating the original", async () => {
    const send = new toolsApi.SendTool();
    const original = send.parameters;
    const p = await member<N>(
      [
        call("send", { id: "P->x", payload: "seven", ...noTask }, "send-bad"),
        call("send", { id: "P->x", payload: 7, ...noTask }, "send-1"),
        fauxAssistantMessage("P done"),
      ],
      { tools: [send] },
    );
    const q = await member<N>(
      [
        call("send", { id: "Q->y", payload: "seven", ...noTask }, "send-1"),
        fauxAssistantMessage("Q done"),
      ],
      { tools: [send] },
    );
    const { ports, graph, execution } = typedGraph();
    const toX = Edge.message("P->x", NumberSchema);
    const toY = Edge.message("Q->y", StringSchema);
    const [pId, qId] = [p, q].map(({ agent }, index) => {
      agent.stagePrompt("Send along your route.");
      return graph.addNode({
        id: NodeId.create(["P", "Q"][index]!),
        state: agent,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
    });
    const x = collector(graph, toX, "x");
    const y = collector(graph, toY, "y");
    graph.addEdge(pId!, x.id, toX).addEdge(qId!, y.id, toY);
    ports.connect(graph, qId!);
    await execution.run();

    const pParameters = toolIn(p.contexts[0]!, "send").parameters;
    const qParameters = toolIn(q.contexts[0]!, "send").parameters;
    assert.ok(Value.Check(pParameters, { id: "P->x", payload: 7, ...noTask }));
    assert.ok(
      !Value.Check(pParameters, { id: "P->x", payload: "7", ...noTask }),
    );
    assert.ok(
      !Value.Check(pParameters, { id: "Q->y", payload: "seven", ...noTask }),
    );
    assert.ok(
      Value.Check(qParameters, { id: "Q->y", payload: "seven", ...noTask }),
    );
    assert.ok(!Value.Check(qParameters, { id: "P->x", payload: 7, ...noTask }));
    // The shared original keeps its own unhosted, impossible contract.
    assert.equal(send.parameters, original);
    assert.deepEqual(send.parameters, toolsApi.SendTool.parametersFor([]));
    // The string on the numeric route failed validation; the raw values arrived unchanged.
    assert.ok(resultOf(p.results, "send-bad").isError);
    assert.equal(resultOf(p.results, "send-1").isError, false);
    assert.deepEqual(x.delivered, [7]);
    assert.deepEqual(y.delivered, ["seven"]);
  });

  test("a send route added while suspended is validated at once and declared to the model", async () => {
    const feed = Edge.message("feed->A", NumberSchema);
    const late = Edge.message("A->B", NumberSchema);
    const a = await member<N>([
      call("send", { id: late.id, payload: 5, ...noTask }, "send-early"),
      call("yield", { reason: "await a route" }, "yield-1"),
      call("send", { id: late.id, payload: 5, ...noTask }, "send-1"),
      fauxAssistantMessage("A done"),
    ]);
    const { ports, graph, execution } = typedGraph();
    const feeder = graph.addNode({
      id: NodeId.create("feed"),
      trigger: TriggerRule.always(),
      state: new Deterministic<N, T>(async function* () {
        yield [Message.create(feed, 7)];
        return assistant("fed");
      }, LockPolicy),
    });
    a.agent.stagePrompt("Read, then send.");
    const aId = graph.addNode({
      id: NodeId.create("A"),
      state: a.agent,
      policy: LockPolicy,
      trigger: TriggerRule.when(feed),
    });
    graph.addEdge(feeder, aId, feed);
    ports.connect(graph, aId);
    await stepUntil(execution, () => a.agent.status === "suspended");

    // Before the route exists, send admits nothing.
    assert.ok(resultOf(a.results, "send-early").isError);
    assert.ok(
      !Value.Check(toolIn(a.contexts[1]!, "send").parameters, {
        id: late.id,
        payload: 5,
        ...noTask,
      }),
    );

    const b = collector(graph, late, "B");
    graph.addEdge(aId, b.id, late);
    await execution.run();

    // Validation reads the live route at once: the resumed send is admitted.
    assert.equal(resultOf(a.results, "send-1").isError, false);
    assert.deepEqual(b.delivered, [5]);
    // The suspension holds a request Pi had already assembled, so the model sees the new
    // route from the next request built after the edge exists.
    assert.ok(
      Value.Check(toolIn(a.contexts.at(-1)!, "send").parameters, {
        id: late.id,
        payload: 5,
        ...noTask,
      }),
    );
  });

  /** A source node emitting `tasks` on `edge` in one batch. */
  const feed = (
    graph: JuncoGraph<N, T>,
    edge: Edge<Chat, T>,
    tasks: Static<Chat>[],
  ) =>
    graph.addNode({
      id: NodeId.create("feed"),
      trigger: TriggerRule.always(),
      state: new Deterministic<N, T>(async function* () {
        yield tasks.map((task) => Message.create(edge, task));
        return assistant("fed");
      }, LockPolicy),
    });
  const task = (taskId: string, text: string, spec: string) =>
    ({
      kind: "prompt",
      text,
      taskId,
      spec,
      deps: [],
      history: [],
    }) as const;

  test("a handed-off task keeps its id and spec and accumulates each holder's history", async () => {
    const toA = Edge.message("feed~>A", TaskSchema);
    const toB = Edge.message("A~>B", TaskSchema);
    const toC = Edge.message("B~>C", TaskSchema);
    const a = await member<N>([
      call(
        "send",
        {
          id: toB.id,
          payload: { kind: "prompt", text: "finish X" },
          task: "T1",
          spec: "X works",
          handoff: "did half",
        },
        "send-1",
      ),
      fauxAssistantMessage("A done"),
    ]);
    const b = await member<N>([
      // A model cannot forge provenance inside the payload.
      call(
        "send",
        {
          id: toC.id,
          payload: { kind: "prompt", text: "X done", taskId: "forged" },
          task: "T1",
          spec: "X works",
          handoff: "finished",
        },
        "send-1",
      ),
      fauxAssistantMessage("B done"),
    ]);
    const { ports, graph, execution } = typedGraph();
    const source = feed(graph, toA, [task("T1", "do X", "X works")]);
    const [aId, bId] = (
      [
        ["A", a, toA],
        ["B", b, toB],
      ] as const
    ).map(([id, { agent }, edge]) => {
      agent.stagePrompt("Work on your task.");
      return graph.addNode({
        id: NodeId.create(id),
        state: agent,
        policy: LockPolicy,
        trigger: TriggerRule.when(edge),
      });
    });
    const c = collector(graph, toC, "C");
    graph
      .addEdge(source, aId!, toA)
      .addEdge(aId!, bId!, toB)
      .addEdge(bId!, c.id, toC);
    ports.connect(graph, bId!);
    await execution.run();

    const atA = { node: "A", desc: "do X", handoff: "did half" };
    assert.deepEqual(userTexts(b.contexts.at(-1)!.messages), [
      "Work on your task.",
      'finish X\n\nTask: {"taskId":"T1","spec":"X works","deps":[],"history":[{"node":"A","desc":"do X","handoff":"did half"}]}',
    ]);
    assert.deepEqual(c.delivered, [
      {
        ...task("T1", "X done", "X works"),
        history: [atA, { node: "B", desc: "finish X", handoff: "finished" }],
      },
    ]);
  });

  test("a different spec creates a subtask recorded in the named task's deps; send requires its task fields", async () => {
    const toA = Edge.message("feed~>A", TaskSchema);
    const out = Edge.message("A~>out", TaskSchema);
    const send = (args: Record<string, unknown>, id: string) =>
      call(
        "send",
        { id: out.id, payload: { kind: "prompt", text: id }, ...args },
        id,
      );
    const a = await member<N>([
      send(
        { task: "T1", spec: "tests green", handoff: "split off tests" },
        "subtask",
      ),
      send({ task: "nope", spec: "", handoff: "" }, "unknown"),
      send({ task: "T1", spec: "X works" }, "no-handoff"),
      send({ task: "T1", spec: "X works", handoff: "delegated" }, "handoff"),
      send({ task: "T2", spec: "Y works", handoff: "untouched" }, "other"),
      fauxAssistantMessage("A done"),
    ]);
    const { ports, graph, execution } = typedGraph();
    const source = feed(graph, toA, [
      task("T1", "do X", "X works"),
      task("T2", "do Y", "Y works"),
    ]);
    a.agent.stagePrompt("Work on your tasks.");
    const aId = graph.addNode({
      id: NodeId.create("A"),
      state: a.agent,
      policy: LockPolicy,
      trigger: TriggerRule.when(toA),
    });
    const sink = collector(graph, out, "out");
    graph.addEdge(source, aId, toA).addEdge(aId, sink.id, out);
    ports.connect(graph, aId);
    await execution.run();

    assert.ok(
      contentText(resultOf(a.results, "unknown").content).includes(
        'task "nope" was not received; received: T1, T2',
      ),
    );
    assert.ok(resultOf(a.results, "unknown").isError);
    assert.ok(resultOf(a.results, "no-handoff").isError);
    const [first] = sink.delivered;
    assert.ok(first !== undefined && "taskId" in first);
    const subtask = first.taskId;
    assert.match(subtask, /^[0-9a-f-]{36}$/);
    assert.deepEqual(sink.delivered, [
      {
        ...task(subtask, "subtask", "tests green"),
        history: [{ node: "A", desc: "do X", handoff: "split off tests" }],
      },
      {
        ...task("T1", "handoff", "X works"),
        deps: [subtask],
        history: [{ node: "A", desc: "do X", handoff: "delegated" }],
      },
      {
        ...task("T2", "other", "Y works"),
        history: [{ node: "A", desc: "do Y", handoff: "untouched" }],
      },
    ]);
  });
});
