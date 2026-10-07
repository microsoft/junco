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
  allOf,
  always,
  anyOf,
  DataflowNodeError,
  type Edge,
  type EdgeIdType,
  messageEdge,
  msg,
  NodeId,
  type NodeIdType,
  type NodeOptions,
  on,
  valueEdge,
  when,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgentError } from "junco-agent";
import type { Contract } from "junco-tools";
import { Type } from "typebox";
import {
  type AgenticInput,
  agent as agentApi,
  agentNode,
  Deterministic,
  deterministicNode,
  graphNode,
  type JuncoGraph,
  MockAgent,
  tools as toolsApi,
} from "../src/index.ts";
import { nodePolicies, registeredNodeContexts } from "../src/node-policy.ts";
import {
  assistant,
  failed,
  type PolicyScheduler,
  plainGraph,
  policyGraph,
  requestTexts,
  run,
  STRATEGIES,
  settle,
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

type Graph = JuncoGraph<
  AgenticInput,
  AssistantMessage,
  unknown,
  PolicyScheduler
>;
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
    tools = [toolsApi.RecvTool(), toolsApi.SendTool(), toolsApi.InfoTool()],
    contract,
  }: {
    readonly tools?: readonly AgentTool[];
    readonly contract?: (edgeId: EdgeIdType) => Contract;
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
    tools: [toolsApi.createYieldTool(), ...tools],
    ...(contract === undefined ? {} : { contract }),
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
    "LockPolicy",
  );
  return graph.addNode(
    deterministicNode(body, {
      ...options,
      policy: "LockPolicy",
      trigger: always(),
      is_available: () => false,
    }),
  );
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
    "LockPolicy",
  );
  const node = graph.addNode(
    deterministicNode(body, {
      id: NodeId(id),
      policy: "LockPolicy",
      trigger: when(edge),
      contract: contracts({ [edge.id]: expect }),
    }),
  );
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
async function stepUntil(graph: Graph, reached: () => boolean): Promise<void> {
  for (let steps = 0; steps < 50 && !reached(); steps++) await graph.step();
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
      const graph = plainGraph(strategy);
      const edge = valueEdge<AgenticInput, AssistantMessage>(
        "upstream->dependent",
      );
      const u = graph.addNode(
        agentNode(upstream, {
          policy: "LockPolicy",
          description: "upstream",
          trigger: always(),
        }),
      );
      const d = graph.addNode(
        agentNode(dependent, {
          policy: "LockPolicy",
          description: "dependent",
          trigger: when(edge),
        }),
      );
      graph.addEdge(u, d, edge);

      assert.deepEqual([...graph.available().keys()], [u]);
      await graph.step(); // primes the upstream
      await graph.step(); // runs it to its result
      assert.ok(O.isSome(graph.result(u)));
      await graph.step(); // primes the dependent: no frame, input kept
      assert.equal(graph.getNode(d)!.status, "running");
      assert.equal(dependent.status, "ready");
      assert.deepEqual(dependent.requests, []);
      assert.deepEqual(dependent.history, []);
      await graph.run();

      assert.deepEqual(requestTexts(dependent.requests), [
        ["use it"],
        ["use it"],
        ["use it"],
      ]);
      assert.deepEqual(userTexts(dependent.history), ["use it"]);
      const result = graph.result(d);
      assert.ok(O.isSome(result) && textOf(result.value) === "dependent done");
    });

    test("delivered payloads of every kind reach only the wired recipient's recv, in order, as data", async () => {
      const images = [image("1"), image("2"), image("3"), image("4")] as const;
      const toRecipient = messageEdge<AgenticInput, AssistantMessage>(
        "sender->recipient",
      );
      const toBystander = messageEdge<AgenticInput, AssistantMessage>(
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
          yield payloads.map((payload) => msg(toRecipient, payload));
          return assistant("sender done");
        },
        "LockPolicy",
      );
      const recipient = await member([
        call("recv", {}, "recv-1"),
        fauxAssistantMessage("recipient done"),
      ]);
      const bystander = new MockAgent({ runs: [yieldsThen(0, "never")] });
      const graph = plainGraph(strategy);
      closers.push(() => graph.close());
      const s = graph.addNode(
        deterministicNode(sender, {
          policy: "LockPolicy",
          trigger: always(),
        }),
      );
      const r = graph.addNode(
        agentNode(
          recipient.agent,
          { policy: "LockPolicy", trigger: when(toRecipient) },
          { prompt: "Read your inbox." },
        ),
      );
      const b = graph.addNode(
        agentNode(bystander, {
          policy: "LockPolicy",
          trigger: when(toBystander),
        }),
      );
      graph.addEdge(s, r, toRecipient).addEdge(s, b, toBystander);

      await graph.run();

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

    test("a member with neither a staged nor a received prompt is quiescent", async () => {
      const idle = new MockAgent({ runs: [yieldsThen(0, "never")] });
      const graph = plainGraph(strategy);
      graph.addNode(
        agentNode(idle, {
          policy: "LockPolicy",
          description: "idle",
          trigger: always(),
        }),
      );

      assert.equal(graph.available().size, 0);
      await graph.run();
      assert.deepEqual(idle.requests, []);
      assert.equal(idle.status, "idle");
    });

    test("a delivery to a member without a prompt is retained data, not a command", async () => {
      const edge = messageEdge<AgenticInput, AssistantMessage>(
        "sender->member",
      );
      const sender = new Deterministic<AgenticInput, AssistantMessage>(
        async function* () {
          yield [
            msg(edge, {
              kind: "appendMessage",
              message: { role: "user", content: "remember this", timestamp: 1 },
            }),
          ];
          return assistant("sent");
        },
        "LockPolicy",
      );
      const member = new MockAgent({ runs: [yieldsThen(0, "later")] });
      const graph = plainGraph(strategy);
      const s = graph.addNode(
        deterministicNode(sender, {
          policy: "LockPolicy",
          description: "sender",
          trigger: always(),
        }),
      );
      const m = graph.addNode(
        agentNode(member, {
          policy: "LockPolicy",
          description: "member",
          trigger: when(edge),
        }),
      );
      graph.addEdge(s, m, edge);

      await graph.run();

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
        const graph = plainGraph(strategy);
        const id = graph.addNode(
          agentNode(erring, {
            policy: "LockPolicy",
            description: "erring",
            trigger: always(),
          }),
        );

        await graph.run();
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
      const graph = plainGraph(strategy);
      const edge = valueEdge<AgenticInput, AssistantMessage>("failing->child");
      const f = graph.addNode(
        agentNode(failing, {
          policy: "LockPolicy",
          description: "failing",
          trigger: always(),
        }),
      );
      const c = graph.addNode(
        agentNode(child, {
          policy: "LockPolicy",
          description: "child",
          trigger: when(edge),
        }),
      );
      graph.addEdge(f, c, edge);

      const error = await graph.run().catch((thrown: unknown) => thrown);
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
      const graph = plainGraph(strategy);
      const id = graph.addNode(
        agentNode(exhausted, {
          policy: "LockPolicy",
          description: "exhausted",
          trigger: always(),
        }),
      );

      const error = await graph.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === id);
      assert.ok(invalidState(error.error));
      assert.ok(O.isNone(graph.result(id)));
    });

    test("a member closed before its run settles fails its node as closed", async () => {
      const member = new MockAgent({
        prompt: "go",
        runs: [yieldsThen(1, "never")],
      });
      const graph = plainGraph(strategy);
      const id = graph.addNode(
        agentNode(member, {
          policy: "LockPolicy",
          description: "member",
          trigger: always(),
        }),
      );

      await graph.step(); // prime
      await graph.step(); // starts the run, which pauses
      assert.equal(member.status, "suspended");
      assert.deepEqual(await member.return(), { value: undefined, done: true });
      const error = await graph.step().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === id);
      assert.ok(
        error.error instanceof JuncoAgentError && error.error.code === "closed",
      );
    });

    test("a node prompt starts an idle member once in each graph", async () => {
      const upstream = new MockAgent({
        prompt: "produce",
        runs: [yieldsThen(0, "context")],
      });
      const member = new MockAgent({
        runs: [yieldsThen(1, "first"), yieldsThen(0, "second")],
      });
      const first = plainGraph(strategy);
      const edge = valueEdge<AgenticInput, AssistantMessage>(
        "upstream->member",
      );
      const upstreamId = first.addNode(
        agentNode(upstream, {
          policy: "LockPolicy",
          description: "upstream",
          trigger: always(),
        }),
      );
      const firstId = first.addNode(
        agentNode(
          member,
          {
            policy: "LockPolicy",
            description: "member",
            trigger: when(edge),
          },
          { prompt: "round one" },
        ),
      );
      first.addEdge(upstreamId, firstId, edge);

      assert.deepEqual([...first.available().keys()], [upstreamId]);
      await first.run();
      const firstResult = first.result(firstId);
      assert.ok(O.isSome(firstResult) && textOf(firstResult.value) === "first");

      const second = plainGraph(strategy);
      const secondId = second.addNode(
        agentNode(
          member,
          {
            policy: "LockPolicy",
            description: "member",
            trigger: always(),
          },
          { prompt: "round two" },
        ),
      );
      await second.run();
      const secondResult = second.result(secondId);
      assert.ok(
        O.isSome(secondResult) && textOf(secondResult.value) === "second",
      );
      // The delivered parent result is inbox data for recv, never an injected user message.
      assert.deepEqual(userTexts(member.history), ["round one", "round two"]);
    });

    test("a node prompt conflicts with a staged prompt", async () => {
      const member = new MockAgent({
        prompt: "staged",
        runs: [yieldsThen(0, "staged result")],
      });
      const graph = plainGraph(strategy);
      const id = graph.addNode(
        agentNode(
          member,
          {
            policy: "LockPolicy",
            description: "member",
            trigger: always(),
          },
          { prompt: "node" },
        ),
      );

      const error = await graph.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === id);
      assert.ok(invalidState(error.error));
      assert.deepEqual(member.requests, []);
      assert.equal(member.status, "ready");
    });

    test("one shared availability predicate holds ready agent, coroutine and graph nodes until released", async () => {
      let admitted = false;
      const shared: NodeOptions<AgenticInput, AssistantMessage> & {
        readonly policy: "LockPolicy";
      } = {
        policy: "LockPolicy",
        trigger: always(),
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
      const child = plainGraph(strategy);
      const innerId = child.addNode(
        agentNode(inner, { policy: "LockPolicy", trigger: always() }),
      );
      let entered = false;
      const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
        async function* () {
          entered = true;
          yield [];
          return assistant("coroutine done");
        },
        "LockPolicy",
      );
      const consumer = new MockAgent({ runs: [yieldsThen(0, "consumed")] });
      const graph = plainGraph(strategy);
      const fromAgent = valueEdge<AgenticInput, AssistantMessage>(
        "agent->consumer",
      );
      const a = graph.addNode(
        agentNode(agent, { ...shared, id: NodeId("agent") }),
      );
      const d = graph.addNode(
        deterministicNode(coroutine, { ...shared, id: NodeId("coroutine") }),
      );
      const g = graph.addNode(
        graphNode(
          child,
          { ...shared, id: NodeId("graph") },
          { result: innerId },
        ),
      );
      const c = graph.addNode(
        agentNode(
          consumer,
          { policy: "LockPolicy", trigger: when(fromAgent) },
          { prompt: "consume" },
        ),
      );
      graph.addEdge(a, c, fromAgent);

      assert.equal(graph.available().size, 0);
      assert.equal((await graph.run()).size, 0);
      assert.deepEqual(
        [agent.requests, inner.requests, consumer.requests],
        [[], [], []],
      );
      assert.equal(agent.status, "ready");
      assert.equal(entered, false);
      assert.ok([a, d, g, c].every((id) => O.isNone(graph.result(id))));

      admitted = true;
      await graph.run();

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
      const toAgent = messageEdge<AgenticInput, AssistantMessage>(
        "source->agent",
      );
      const seed = valueEdge<AgenticInput, AssistantMessage>("source=>agent");
      const toSink = messageEdge<AgenticInput, AssistantMessage>("agent->sink");
      const notes: AgenticInput[] = [
        { kind: "prompt", text: "first" },
        { kind: "followUp", text: "second" },
      ];
      const seedMessage = assistant("seed");
      const source = new Deterministic<AgenticInput, AssistantMessage>(
        async function* () {
          yield notes.map((note) => msg(toAgent, note));
          return seedMessage;
        },
        "LockPolicy",
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
            toolsApi.RecvTool(),
            toolsApi.SendTool(),
            toolsApi.InfoTool(),
            lookup,
            publish,
          ],
          contract: contracts({
            [toAgent.id]: "Ordered notes to work through.",
            [seed.id]: "The source's final seed.",
          }),
        },
      );
      const graph = plainGraph(strategy);
      closers.push(() => graph.close());
      const sourceId = graph.addNode(
        deterministicNode(source, {
          id: NodeId("source"),
          policy: "LockPolicy",
          trigger: always(),
        }),
      );
      const agentId = graph.addNode(
        agentNode(
          receiver.agent,
          {
            id: NodeId("agent"),
            policy: "LockPolicy",
            trigger: allOf(on(toAgent), on(seed)),
          },
          { prompt: "Inspect info, then work through your inbox." },
        ),
      );
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

      await stepUntil(graph, () => receiver.agent.status === "suspended");
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

      await stepUntil(graph, () => policy.lastYield?.[0]?.kind === "policy");
      assert.equal(receiver.agent.status, "suspended");
      assert.equal(receiver.faux.state.callCount, 7);
      assert.deepEqual(
        policy.lastYield?.map(({ kind, toolName }) => [kind, toolName]),
        [["policy", "publish"]],
      );
      const denied = resultOf(receiver.results, "publish-1");
      assert.ok(denied.isError);
      assert.match(contentText(denied.content), /denied by policy/);

      await graph.run();
      assert.equal(receiver.faux.state.callCount, 8);
      const result = graph.result(agentId);
      assert.ok(O.isSome(result) && textOf(result.value) === "done");
      assert.deepEqual(out.delivered, [{ kind: "prompt", text: "forwarded" }]);
    });

    test("a postponed recv returns every retained batch in FIFO order and each value once; a stale value never starves a fresh message", async () => {
      const notes = messageEdge<AgenticInput, AssistantMessage>("notes->agent");
      const seed = valueEdge<AgenticInput, AssistantMessage>("seed=>agent");
      const seedMessage = assistant("seed");
      const note = (text: string): AgenticInput => ({ kind: "prompt", text });
      const receiver = await member([
        call("yield", { reason: "later" }, "yield-1"),
        call("recv", {}, "recv-1"),
        call("yield", { reason: "again" }, "yield-2"),
        call("recv", {}, "recv-2"),
        fauxAssistantMessage("done"),
      ]);
      const graph = policyGraph(strategy);
      closers.push(() => graph.close());
      const seedId = graph.addNode(
        deterministicNode(
          new Deterministic<AgenticInput, AssistantMessage>(
            // biome-ignore lint/correctness/useYield: a source resolving on its first activation.
            async function* () {
              return seedMessage;
            },
            "LockPolicy",
          ),
          { id: NodeId("seed"), policy: "LockPolicy", trigger: always() },
        ),
      );
      const notesId = inert(graph, { id: NodeId("notes") });
      const agentId = graph.addNode(
        agentNode(
          receiver.agent,
          {
            id: NodeId("agent"),
            policy: "LockPolicy",
            trigger: anyOf(on(notes), on(seed)),
          },
          { prompt: "Work through your inbox when ready." },
        ),
      );
      graph.addEdge(seedId, agentId, seed).addEdge(notesId, agentId, notes);
      const policy = nodePolicies.get(graph.getNode(agentId)!.step)!;

      graph.emit(notesId, msg(notes, note("n1")));
      graph.emit(notesId, msg(notes, note("n2")));
      await stepUntil(graph, () => receiver.agent.status === "suspended");
      assert.ok(O.isSome(graph.result(seedId)));
      // Another batch arrives while the model postpones recv.
      graph.emit(notesId, msg(notes, note("n3")));
      await stepUntil(graph, () => policy.lastYield?.[0]?.reason === "again");
      graph.emit(notesId, msg(notes, note("n4")));
      await graph.run();

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
        toolsApi.InfoTool(directHost),
        toolsApi.SendTool(directHost),
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
      const copy = { ...toolsApi.InfoTool() };
      const r = await member(
        [call("info", {}, "info-1"), fauxAssistantMessage("R done")],
        { tools: [copy] },
      );
      const graph = plainGraph(strategy);
      closers.push(() => graph.close());
      const ids = [p, q, r].map((agent, index) =>
        graph.addNode(
          agentNode(
            agent.agent,
            {
              id: NodeId(["P", "Q", "R"][index]!),
              policy: "LockPolicy",
              trigger: always(),
            },
            { prompt: "Report along your message route." },
          ),
        ),
      );
      const toP = messageEdge<AgenticInput, AssistantMessage>("P->sink");
      const toQ = messageEdge<AgenticInput, AssistantMessage>("Q->sink");
      const sinkP = sink(graph, toP, "sinkP", "P's report.");
      const sinkQ = sink(graph, toQ, "sinkQ", "Q's report.");
      graph.addEdge(ids[0]!, sinkP.id, toP).addEdge(ids[1]!, sinkQ.id, toQ);

      await graph.run();

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
      const copied = resultOf(r.results, "info-1");
      assert.ok(copied.isError);
      assert.match(
        contentText(copied.content),
        /requires an agentNode graph host/,
      );
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
      const graph = plainGraph(strategy);
      const edge = messageEdge<AgenticInput, AssistantMessage>("a->b");
      const a = inert(graph, { id: NodeId("a") });
      const b = inert(graph, {
        id: NodeId("b"),
        contract: contracts({ [edge.id]: "Anything." }),
      });
      graph.addEdge(a, b, edge);
      const registration = registeredNodeContexts.get(graph.getNode(a)!)!;
      const late = msg(edge, { kind: "prompt", text: "late" });
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

    test("info reports every actual route with its receiver's live contract, under engine node ids", async () => {
      const ab1 = messageEdge<AgenticInput, AssistantMessage>("a-b-1");
      const ab2 = messageEdge<AgenticInput, AssistantMessage>("a-b-2");
      const abValue = valueEdge<AgenticInput, AssistantMessage>("a=>b");
      const bd = messageEdge<AgenticInput, AssistantMessage>("b-d");
      const self = messageEdge<AgenticInput, AssistantMessage>("b-self");
      const bw = messageEdge<AgenticInput, AssistantMessage>("b-w");
      const xy = messageEdge<AgenticInput, AssistantMessage>("b-d");
      const be = messageEdge<AgenticInput, AssistantMessage>("b-e");
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
      const graph = plainGraph(strategy);
      closers.push(() => graph.close());
      const a = inert(graph, { id: NodeId("A") });
      const bId = graph.addNode(
        agentNode(
          b.agent,
          { policy: "LockPolicy", trigger: always() },
          { prompt: "Inspect your routes." },
        ),
      );
      const dId = graph.addNode(
        agentNode(d, { policy: "LockPolicy", trigger: when(bd) }),
      );
      // The wrapper's contract, not its selected inner result node's, describes its edge.
      const inner = plainGraph(strategy);
      const innerId = inert(inner, {
        contract: contracts({ [bw.id]: "inner: unrelated." }),
      });
      const w = graph.addNode(
        graphNode(
          inner,
          { id: NodeId("W"), policy: "LockPolicy", trigger: when(bw) },
          {
            result: innerId,
            contract: contracts({ [bw.id]: "W: wrapper expectation." }),
          },
        ),
      );
      // A disconnected link reusing B->D's edge id has its own receiver's contract.
      const x = inert(graph, { id: NodeId("X") });
      const y = inert(graph, {
        id: NodeId("Y"),
        contract: contracts({ [xy.id]: "Y: same edge id, other route." }),
      });
      const z = inert(graph, { id: NodeId("Z") });
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

      await stepUntil(graph, () => b.agent.status === "suspended");
      // While B is paused, a route is added and a receiver's contract changes.
      const e = inert(graph, {
        contract: contracts({ [be.id]: "E: late route." }),
      });
      graph.addEdge(bId, e, be);
      dExpect = "D: second contract.";
      await graph.run();

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
      const graph = plainGraph(strategy);
      let contract: Contract | Error = { expect: "Anything." };
      const s = inert(graph, { id: NodeId("S") });
      const r = inert(graph, {
        id: NodeId("R"),
        contract: () => {
          if (contract instanceof Error) throw contract;
          return contract;
        },
      });
      graph.addEdge(s, r, messageEdge("s->r"));
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
        inert(graph, { id: NodeId("bare") }),
        messageEdge("s->bare"),
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
