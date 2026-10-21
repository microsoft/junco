import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type ImageContent,
  type Message as ModelMessage,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  DataflowNodeError,
  Edge,
  type EdgeIdType,
  Message,
  NodeId,
  type NodeIdType,
  type NodeOptions,
  type ParentView,
  TriggerEntry,
  TriggerRule,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import {
  type AgenticOptions,
  JuncoAgentError,
  SYSTEM_INSTRUCTION,
} from "junco-agent";
import {
  type Contract,
  EmptyPolicy,
  LockPolicy,
  type Policy,
} from "junco-tools";
import { Type } from "typebox";
import {
  type AgenticInput,
  agent as agentApi,
  Deterministic,
  type JuncoGraph,
  MockAgent,
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

// The adapter is scheduler-agnostic: every scenario runs on both deterministic junco-scheduler
// policies. Execution scenarios keep the original MockAgent as node state; messaging scenarios use
// real JuncoAgents on faux providers, whose recv/send/info calls run against their registrations.

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse())
    await close().catch(() => {});
});

type Graph = JuncoGraph<AgenticInput, AssistantMessage>;
type Route = {
  readonly id: string;
  readonly edgeId: string;
  readonly kind: string;
  readonly expect: string;
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

/** A finite receiver's contracts by incoming edge id; it expects nothing on any other edge. */
function contracts(byEdge: Readonly<Record<string, string>>) {
  return (edgeId: EdgeIdType): Contract => {
    if (!Object.hasOwn(byEdge, edgeId))
      throw new JuncoAgentError(
        "invalid_state",
        `No contract for edge "${edgeId}"`,
      );
    return { expect: byEdge[edgeId]! };
  };
}

/**
 * A real JuncoAgent with a genuine `yield` plus `tools` (fresh recv/send/info by default), serving
 * `responses`. Records each request's context and every tool result it commits.
 */
async function member(
  responses: readonly FauxResponseStep[],
  {
    tools = [
      new toolsApi.RecvTool(),
      new toolsApi.SendTool(),
      new toolsApi.InfoTool(),
    ],
    contract,
    prompt,
  }: {
    readonly tools?: readonly AgentTool[];
    readonly contract?: (edgeId: EdgeIdType) => Contract;
    readonly prompt?: AgenticOptions["prompt"];
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
  const agent = await agentApi.JuncoAgent.fromResolved({
    ...options,
    systemPrompt: "member",
    tools: [new toolsApi.YieldTool(), ...tools],
    ...(contract === undefined ? {} : { contract }),
    ...(prompt === undefined ? {} : { prompt }),
  });
  closers.push(() => agent.return());
  const results: ToolResultMessage[] = [];
  agent.events.on("message_end", ({ lane, message }) => {
    if (lane === "main" && message.role === "toolResult") results.push(message);
  });
  return { agent, faux, contexts, results };
}

/** A registered coroutine node that never runs; a receiver under `contract` when given. */
function inert(
  graph: Graph,
  options: {
    readonly id?: NodeIdType;
    readonly contract?: (edgeId: EdgeIdType) => Contract;
  } = {},
): NodeIdType {
  const body = new Deterministic<AgenticInput, AssistantMessage>(
    async function* () {
      yield [];
      return assistant("inert");
    },
    LockPolicy,
  );
  return graph.addNode({
    ...options,
    trigger: TriggerRule.always(),
    is_available: () => false,
    state: body,
  });
}

/** A coroutine node `id` recording every payload delivered on `edge`, with its contract. */
function sink(
  graph: Graph,
  edge: Edge<AgenticInput, AssistantMessage>,
  id: string,
  expect: string,
) {
  const delivered: AgenticInput[] = [];
  const body = new Deterministic<AgenticInput, AssistantMessage>(
    async function* () {
      let view = yield [];
      while (true) {
        for (const payload of view.messages.get(edge.id) ?? [])
          delivered.push(payload);
        view = yield [];
      }
    },
    LockPolicy,
  );
  const node = graph.addNode({
    id: NodeId.create(id),
    trigger: TriggerRule.when(edge),
    contract: contracts({ [edge.id]: expect }),
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
      const edge = Edge.value<AgenticInput, AssistantMessage>(
        "upstream->dependent",
      );
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
      const assignment = Edge.message<AgenticInput, AssistantMessage>(
        "assignment",
      );
      const loop = Edge.value<AgenticInput, AssistantMessage>("worker->worker");
      const ports = terminalPorts();
      const execution = plainContext(ports.source, ports.sink, strategy);
      const graph = execution.graph;
      closers.push(() => graph.close());
      const feeder = graph.addNode({
        trigger: TriggerRule.always(),
        state: new Deterministic<AgenticInput, AssistantMessage>(
          async function* () {
            yield [Message.create(assignment, { kind: "prompt", text: "go" })];
            return assistant("fed");
          },
          LockPolicy,
        ),
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
        Message.create(assignment, { kind: "prompt", text: "go again" }),
      );
      assert.ok(graph.available().has(worker));
      await execution.run();
      assert.deepEqual(requestTexts(member.requests), [
        ["round 1"],
        ["round 1", "round 2"],
      ]);
    });

    test("delivered payloads of every kind reach only the wired recipient's recv, in order, as data", async () => {
      const images = [image("1"), image("2"), image("3"), image("4")] as const;
      const toRecipient = Edge.message<AgenticInput, AssistantMessage>(
        "sender->recipient",
      );
      const toBystander = Edge.message<AgenticInput, AssistantMessage>(
        "sender->bystander",
      );
      const payloads: AgenticInput[] = [
        {
          kind: "appendMessage",
          message: { role: "user", content: "note", timestamp: 1 },
        },
        { kind: "nextTurn", text: "context first", images: [images[0]] },
        { kind: "prompt", text: "then work", images: [images[1]] },
        { kind: "steer", text: "adjust", images: [images[2]] },
        { kind: "followUp", text: "confirm" },
        { kind: "error", text: "failed dependency", images: [images[3]] },
      ];
      const sender = new Deterministic<AgenticInput, AssistantMessage>(
        async function* () {
          yield payloads.map((payload) => Message.create(toRecipient, payload));
          return assistant("sender done");
        },
        LockPolicy,
      );
      const recipient = await member([
        call("recv", {}, "recv-1"),
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

      const received = resultOf(recipient.results, "recv-1");
      assert.deepEqual(received.details, {
        messages: payloads.map((payload) => ({ id: toRecipient.id, payload })),
        values: [],
      });
      // None of them acted as a native command: the only user message is the node prompt.
      assert.deepEqual(userTexts(recipient.contexts[1]!.messages), [
        "Read your inbox.",
      ]);
      assert.equal(recipient.faux.state.callCount, 2);
      assert.deepEqual(bystander.requests, []);
      assert.equal(bystander.status, "idle");
      assert.equal(graph.getNode(b)!.status, "ready");
      assert.ok(O.isNone(graph.result(b)));
      const result = graph.result(r);
      assert.ok(O.isSome(result) && textOf(result.value) === "recipient done");
    });

    test("each request's system prompt briefs the retained inbox while it fires the trigger, until recv drains it", async () => {
      const seed = Edge.value<AgenticInput, AssistantMessage>("seed");
      const receiver = await member(
        [call("recv", {}, "inbox"), fauxAssistantMessage("read")],
        { prompt: "Read your inbox." },
      );
      const ports = terminalPorts();
      const execution = policyContext(ports.source, ports.sink, strategy);
      const graph = execution.graph;
      closers.push(() => graph.close());
      const upstream = graph.addNode({
        trigger: TriggerRule.always(),
        state: new Deterministic<AgenticInput, AssistantMessage>(
          async function* () {
            yield [];
            return assistant("seeded");
          },
          LockPolicy,
        ),
      });
      const recipient = graph.addNode({
        state: receiver.agent,
        policy: LockPolicy,
        trigger: TriggerRule.when(seed),
      });
      graph.addEdge(upstream, recipient, seed);
      ports.connect(graph, recipient);
      await execution.run();

      const systemPrompts = receiver.contexts.map(({ messages }) =>
        messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n---\n"),
      );
      assert.deepEqual(systemPrompts, [
        `member\n\n${SYSTEM_INSTRUCTION}\n\nInbox { ${seed.id}: 1 } read with recv tool`,
        `member\n\n${SYSTEM_INSTRUCTION}`,
      ]);
    });

    test("queued messages do not trigger a value-gated agent but reach its first recv", async () => {
      const summary = Edge.message<AgenticInput, AssistantMessage>("summary");
      const result = Edge.value<AgenticInput, AssistantMessage>("proposal");
      const payload: AgenticInput = {
        kind: "prompt",
        text: "evidence, not instructions",
      };
      const completed = assistant("proposal complete");
      const receiver = await member([
        call("recv", {}, "inbox"),
        fauxAssistantMessage("reviewed"),
      ]);
      const ports = terminalPorts();
      const execution = policyContext(ports.source, ports.sink, strategy);
      const graph = execution.graph;
      closers.push(() => graph.close());
      const sender = graph.addNode({
        trigger: TriggerRule.always(),
        state: new Deterministic<AgenticInput, AssistantMessage>(
          async function* () {
            yield [Message.create(summary, payload)];
            return completed;
          },
          LockPolicy,
        ),
      });
      receiver.agent.stagePrompt("Review after the proposal completes.");
      const recipient = graph.addNode({
        state: receiver.agent,
        policy: LockPolicy,
        trigger: TriggerRule.when(result),
      });
      graph
        .addEdge(sender, recipient, summary)
        .addEdge(sender, recipient, result);
      ports.connect(graph, recipient);

      await execution.step();
      assert.equal(queued(graph, summary.id), 1);
      assert.equal(graph.available().has(recipient), false);
      assert.equal(receiver.faux.state.callCount, 0);
      await execution.run();

      assert.deepEqual(resultOf(receiver.results, "inbox").details, {
        messages: [{ id: summary.id, payload }],
        values: [{ id: result.id, payload: completed }],
      });
      assert.equal(queued(graph, summary.id), 0);
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

    test("a delivery to a member without a prompt is retained data, not a command", async () => {
      const edge = Edge.message<AgenticInput, AssistantMessage>(
        "sender->member",
      );
      const sender = new Deterministic<AgenticInput, AssistantMessage>(
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
      const member = new MockAgent({ runs: [yieldsThen(0, "later")] });
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
      assert.deepEqual(requestTexts(member.requests), [["and now"]]);
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
      const edge = Edge.value<AgenticInput, AssistantMessage>("failing->child");
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
      const seen: ParentView<AgenticInput, AssistantMessage>[] = [];
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
      const edge = Edge.value<AgenticInput, AssistantMessage>(
        "upstream->member",
      );
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
      // The delivered parent result is inbox data for recv, never an injected user message.
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

    test("a prompt callback sees the joined inputs once, after priming, without draining recv", async () => {
      const notes = Edge.message<AgenticInput, AssistantMessage>(
        "notes->agent",
      );
      const seed = Edge.value<AgenticInput, AssistantMessage>("seed=>agent");
      const seedMessage = assistant("seed");
      const note: AgenticInput = { kind: "prompt", text: "note" };
      const seen: [unknown, unknown][] = [];
      const receiver = await member(
        [
          call("recv", {}, "recv-inputs"),
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
        state: new Deterministic<AgenticInput, AssistantMessage>(
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
      assert.deepEqual(resultOf(receiver.results, "recv-inputs").details, {
        messages: [{ id: notes.id, payload: note }],
        values: [{ id: seed.id, payload: seedMessage }],
      });
      const result = graph.result(agentId);
      assert.ok(O.isSome(result) && textOf(result.value) === "done");
      assert.deepEqual(userTexts(receiver.contexts.at(-1)!.messages), [
        "Use note with seed",
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

      const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
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
      const shared: NodeOptions<AgenticInput, AssistantMessage> = {
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
      const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
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
      const fromAgent = Edge.value<AgenticInput, AssistantMessage>(
        "agent->consumer",
      );
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

    test("an agent discovers its routes, receives and sends as ordinary tools, and pauses only at Yield and policy denials", async () => {
      const toAgent = Edge.message<AgenticInput, AssistantMessage>(
        "source->agent",
      );
      const seed = Edge.value<AgenticInput, AssistantMessage>("source=>agent");
      const toSink = Edge.message<AgenticInput, AssistantMessage>(
        "agent->sink",
      );
      const notes: AgenticInput[] = [
        { kind: "prompt", text: "first" },
        { kind: "followUp", text: "second" },
      ];
      const seedMessage = assistant("seed");
      const source = new Deterministic<AgenticInput, AssistantMessage>(
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
          call("recv", {}, "recv-1"),
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
              },
              "send-1",
            );
          },
          call("recv", {}, "recv-2"),
          call("yield", { reason: "checkpoint" }, "yield-1"),
          call("publish", {}, "publish-1"),
          fauxAssistantMessage("done"),
        ],
        {
          tools: [
            new toolsApi.RecvTool(),
            new toolsApi.SendTool(),
            new toolsApi.InfoTool(),
            lookup,
            publish,
          ],
          contract: contracts({
            [toAgent.id]: "Ordered notes to work through.",
            [seed.id]: "The source's final seed.",
          }),
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
      receiver.agent.stagePrompt("Inspect info, then work through your inbox.");
      const agentId = graph.addNode({
        state: receiver.agent,
        id: NodeId.create("agent"),
        policy: LockPolicy,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(toAgent),
          TriggerEntry.on(seed),
        ),
      });
      const out = sink(
        graph,
        toSink,
        "sink",
        "Forwarded notes, kept in order.",
      );
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
      assert.equal(receiver.faux.state.callCount, 6);
      assert.deepEqual(
        receiver.results.map(({ toolName, isError }) => [toolName, isError]),
        [
          ["info", false],
          ["recv", false],
          ["lookup", true],
          ["send", false],
          ["recv", false],
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
            expect: "Ordered notes to work through.",
          },
          {
            id: sourceId,
            edgeId: seed.id,
            kind: "value",
            expect: "The source's final seed.",
          },
        ]),
      );
      assert.deepEqual(info.children, [
        {
          id: out.id,
          edgeId: toSink.id,
          kind: "message",
          expect: "Forwarded notes, kept in order.",
        },
        {
          id: graph.sink.id,
          edgeId: "terminal->$sink",
          kind: "value",
          expect:
            "Graph output consumes final work results and publishes messages.",
        },
      ]);
      // info consumed nothing: the first recv holds every delivery, and the second is empty.
      assert.deepEqual(resultOf(receiver.results, "recv-1").details, {
        messages: notes.map((payload) => ({ id: toAgent.id, payload })),
        values: [{ id: seed.id, payload: seedMessage }],
      });
      assert.deepEqual(resultOf(receiver.results, "recv-2").details, {
        messages: [],
        values: [],
      });
      // send admitted exactly one message before the run resumed.
      assert.equal(queued(graph, toSink.id) + out.delivered.length, 1);

      await stepUntil(
        graphContext,
        () => policy.lastYield?.[0]?.kind === "policy",
      );
      assert.equal(receiver.agent.status, "suspended");
      assert.equal(receiver.faux.state.callCount, 7);
      assert.deepEqual(
        policy.lastYield?.map(({ kind, toolName }) => [kind, toolName]),
        [["policy", "publish"]],
      );
      const denied = resultOf(receiver.results, "publish-1");
      assert.ok(denied.isError);
      assert.match(contentText(denied.content), /denied by policy/);

      await graphContext.run();
      assert.equal(receiver.faux.state.callCount, 8);
      const result = graph.result(agentId);
      assert.ok(O.isSome(result) && textOf(result.value) === "done");
      assert.deepEqual(out.delivered, [{ kind: "prompt", text: "forwarded" }]);
    });

    test("a postponed recv returns every retained batch in FIFO order and each value once; a stale value never starves a fresh message", async () => {
      const notes = Edge.message<AgenticInput, AssistantMessage>(
        "notes->agent",
      );
      const seed = Edge.value<AgenticInput, AssistantMessage>("seed=>agent");
      const seedMessage = assistant("seed");
      const note = (text: string): AgenticInput => ({ kind: "prompt", text });
      const receiver = await member([
        call("yield", { reason: "later" }, "yield-1"),
        call("recv", {}, "recv-1"),
        call("yield", { reason: "again" }, "yield-2"),
        call("recv", {}, "recv-2"),
        fauxAssistantMessage("done"),
      ]);
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
        state: new Deterministic<AgenticInput, AssistantMessage>(
          // biome-ignore lint/correctness/useYield: a source resolving on its first activation.
          async function* () {
            return seedMessage;
          },
          LockPolicy,
        ),
      });
      const notesId = inert(graph, { id: NodeId.create("notes") });
      receiver.agent.stagePrompt("Work through your inbox when ready.");
      const agentId = graph.addNode({
        state: receiver.agent,
        id: NodeId.create("agent"),
        policy: LockPolicy,
        trigger: TriggerRule.anyOf(
          TriggerEntry.on(notes),
          TriggerEntry.on(seed),
        ),
      });
      graph.addEdge(seedId, agentId, seed).addEdge(notesId, agentId, notes);
      const policy = nodePolicies.get(graph.getNode(agentId)!.step)!;

      graphPorts.connect(graph, agentId);
      graph.emit(notesId, Message.create(notes, note("n1")));
      graph.emit(notesId, Message.create(notes, note("n2")));
      await stepUntil(
        graphContext,
        () => receiver.agent.status === "suspended",
      );
      assert.ok(O.isSome(graph.result(seedId)));
      // Another batch arrives while the model postpones recv.
      graph.emit(notesId, Message.create(notes, note("n3")));
      await stepUntil(
        graphContext,
        () => policy.lastYield?.[0]?.reason === "again",
      );
      graph.emit(notesId, Message.create(notes, note("n4")));
      await graphContext.run();

      assert.deepEqual(resultOf(receiver.results, "recv-1").details, {
        messages: ["n1", "n2", "n3"].map((text) => ({
          id: notes.id,
          payload: note(text),
        })),
        values: [{ id: seed.id, payload: seedMessage }],
      });
      assert.deepEqual(resultOf(receiver.results, "recv-2").details, {
        messages: [{ id: notes.id, payload: note("n4") }],
        values: [],
      });
      const result = graph.result(agentId);
      assert.ok(O.isSome(result) && textOf(result.value) === "done");
    });

    test("shared messaging carriers act for each agent's own registration; a copied carrier gains no graph authority", async () => {
      const direct: string[] = [];
      const directHost = {
        view: { messages: new Map(), values: new Map() },
        consume: () => void direct.push("consume"),
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
      const script = (text: string) => [
        call("info", {}, "info-1"),
        (context: Parameters<FauxResponseFactory>[0]) => {
          const route = jsonResult<Topology>(
            context.messages,
            "info-1",
          ).children.find(({ kind }) => kind === "message");
          assert.ok(route);
          return call(
            "send",
            { id: route.edgeId, payload: { kind: "prompt", text } },
            "send-1",
          );
        },
        fauxAssistantMessage(`${text} done`),
      ];
      const p = await member(script("from P"), { tools: shared });
      const q = await member(script("from Q"), { tools: shared });
      const copy = { ...new toolsApi.InfoTool() };
      const r = await member(
        [call("info", {}, "info-1"), fauxAssistantMessage("R done")],
        { tools: [copy] },
      );
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      closers.push(() => graph.close());
      const ids = [p, q, r].map((agent, index) => {
        agent.agent.stagePrompt("Report along your message route.");
        return graph.addNode({
          state: agent.agent,
          id: NodeId.create(["P", "Q", "R"][index]!),
          policy: LockPolicy,
          trigger: TriggerRule.always(),
        });
      });
      const toP = Edge.message<AgenticInput, AssistantMessage>("P->sink");
      const toQ = Edge.message<AgenticInput, AssistantMessage>("Q->sink");
      const sinkP = sink(graph, toP, "sinkP", "P's report.");
      const sinkQ = sink(graph, toQ, "sinkQ", "Q's report.");
      graph.addEdge(ids[0]!, sinkP.id, toP).addEdge(ids[1]!, sinkQ.id, toQ);

      graphPorts.connect(graph, ids[2]!);
      await graphContext.run();

      for (const [agent, out, edge, expect] of [
        [p, sinkP, toP, "P's report."],
        [q, sinkQ, toQ, "Q's report."],
      ] as const) {
        assert.deepEqual(jsonResult<Topology>(agent.results, "info-1"), {
          parents: [],
          children: [{ id: out.id, edgeId: edge.id, kind: "message", expect }],
        });
      }
      assert.deepEqual(sinkP.delivered, [{ kind: "prompt", text: "from P" }]);
      assert.deepEqual(sinkQ.delivered, [{ kind: "prompt", text: "from Q" }]);
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
      const edge = Edge.message<AgenticInput, AssistantMessage>("a->b");
      const a = inert(graph, { id: NodeId.create("a") });
      const b = inert(graph, {
        id: NodeId.create("b"),
        contract: contracts({ [edge.id]: "Anything." }),
      });
      graph.addEdge(a, b, edge);
      graphPorts.connect(graph, b);
      const registration = registeredNodeContexts.get(graph.getNode(a)!)!;
      registration.assertSend(edge.id);
      assert.equal(queued(graph, edge.id), 0);
      const late = Message.create(edge, { kind: "prompt", text: "late" });
      registration.send(late);
      assert.deepEqual(
        registration.info().children.map(({ id }) => id),
        [b],
      );

      await graph.close();

      assert.throws(() => registration.info());
      assert.throws(() => registration.assertSend(edge.id));
      assert.throws(() => registration.send(late));
      assert.equal(queued(graph, edge.id), 1);
    });

    test("info reports every actual route with its receiver's live contract, under engine node ids", async () => {
      const ab1 = Edge.message<AgenticInput, AssistantMessage>("a-b-1");
      const ab2 = Edge.message<AgenticInput, AssistantMessage>("a-b-2");
      const abValue = Edge.value<AgenticInput, AssistantMessage>("a=>b");
      const bd = Edge.message<AgenticInput, AssistantMessage>("b-d");
      const self = Edge.message<AgenticInput, AssistantMessage>("b-self");
      const bw = Edge.message<AgenticInput, AssistantMessage>("b-w");
      const xy = Edge.message<AgenticInput, AssistantMessage>("b-d");
      const be = Edge.message<AgenticInput, AssistantMessage>("b-e");
      let dExpect = "D: first contract.";
      const b = await member(
        [
          call("info", {}, "info-1"),
          call("yield", { reason: "topology may change" }, "yield-1"),
          call("info", {}, "info-2"),
          fauxAssistantMessage("inspected"),
        ],
        {
          contract: contracts({
            [ab1.id]: "B: first note.",
            [ab2.id]: "B: second note.",
            [abValue.id]: "B: A's result.",
            [self.id]: "B: own reminder.",
          }),
        },
      );
      // A receiving agent answers contract queries without running.
      const d = new MockAgent({
        runs: [],
        contract: (edgeId) => {
          if (edgeId !== bd.id)
            throw new JuncoAgentError("invalid_state", "unexpected edge");
          return { expect: dExpect };
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
      // The wrapper's contract, not its selected inner result node's, describes its edge.
      const innerPorts = terminalPorts();
      const innerContext = plainContext(
        innerPorts.source,
        innerPorts.sink,
        strategy,
      );
      const inner = innerContext.graph;
      const innerId = inert(inner, {
        contract: contracts({ [bw.id]: "inner: unrelated." }),
      });
      innerPorts.connect(inner, innerId);
      const w = graph.addNode({
        id: NodeId.create("W"),
        trigger: TriggerRule.when(bw),
        state: innerContext,
        contract: contracts({ [bw.id]: "W: wrapper expectation." }),
      });
      // A disconnected link reusing B->D's edge id has its own receiver's contract.
      const x = inert(graph, { id: NodeId.create("X") });
      const y = inert(graph, {
        id: NodeId.create("Y"),
        contract: contracts({ [xy.id]: "Y: same edge id, other route." }),
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
      // While B is paused, a route is added and a receiver's contract changes.
      const e = inert(graph, {
        contract: contracts({ [be.id]: "E: late route." }),
      });
      graph.addEdge(bId, e, be);
      dExpect = "D: second contract.";
      await graphContext.run();

      const parents = [
        { id: a, edgeId: ab1.id, kind: "message", expect: "B: first note." },
        { id: a, edgeId: ab2.id, kind: "message", expect: "B: second note." },
        { id: a, edgeId: abValue.id, kind: "value", expect: "B: A's result." },
        {
          id: bId,
          edgeId: self.id,
          kind: "message",
          expect: "B: own reminder.",
        },
      ];
      const children = [
        {
          id: graph.sink.id,
          edgeId: "terminal->$sink",
          kind: "value",
          expect:
            "Graph output consumes final work results and publishes messages.",
        },
        {
          id: bId,
          edgeId: self.id,
          kind: "message",
          expect: "B: own reminder.",
        },
        {
          id: w,
          edgeId: bw.id,
          kind: "message",
          expect: "W: wrapper expectation.",
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
            expect: "D: first contract.",
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
            expect: "D: second contract.",
          },
          { id: e, edgeId: be.id, kind: "message", expect: "E: late route." },
        ]),
      );
      // A's child entries for B are B's own parent expectations for A.
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
            expect: "Y: same edge id, other route.",
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

    test("info fails without a partial result when a receiver lacks, throws or breaks its contract", () => {
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        strategy,
      );
      const graph = graphContext.graph;
      let contract: Contract | Error = { expect: "Anything." };
      const s = inert(graph, { id: NodeId.create("S") });
      const r = inert(graph, {
        id: NodeId.create("R"),
        contract: () => {
          if (contract instanceof Error) throw contract;
          return contract;
        },
      });
      graph.addEdge(s, r, Edge.message("s->r"));
      graphPorts.connect(graph, r);
      const info = () => registeredNodeContexts.get(graph.getNode(s)!)!.info();
      assert.deepEqual(
        info().children.map(({ expect }) => expect),
        ["Anything."],
      );

      const thrown = new Error("receiver broke");
      contract = thrown;
      assert.throws(info, (error: unknown) => error === thrown);
      for (const expect of ["", "  ", "two\nlines", "two\u2028lines"]) {
        contract = { expect };
        assert.throws(info, invalidState);
      }
      contract = {} as Contract;
      assert.throws(info, invalidState);

      // Registration accepts a receiver without a contract; only info about its route fails.
      contract = { expect: "Anything." };
      graph.addEdge(
        s,
        inert(graph, { id: NodeId.create("bare") }),
        Edge.message("s->bare"),
      );
      assert.throws(info, invalidState);
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
    tools: [impostor, failing],
  });
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
