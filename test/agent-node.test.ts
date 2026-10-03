import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
  always,
  DataflowNodeError,
  messageEdge,
  msg,
  NodeId,
  type NodeOptions,
  type ParentView,
  valueEdge,
  when,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgentError } from "junco-agent";
import {
  type AgenticInput,
  type AgentNodeBinding,
  agentNode,
  Deterministic,
  deterministicNode,
  graph as graphApi,
  graphNode,
  MockAgent,
} from "../src/index.ts";
import {
  assistant,
  failed,
  pause,
  plainGraph,
  reason,
  requestTexts,
  run,
  STRATEGIES,
  settle,
  textOf,
  userTexts,
  yieldsThen,
} from "./deterministic-support.ts";

// The adapter is scheduler-agnostic: every scenario runs on both deterministic junco-scheduler
// policies, over JuncoGraphs whose node state stays the original MockAgent.

const image = (data: string): ImageContent => ({
  type: "image",
  data,
  mimeType: "image/png",
});
const invalidState = (error: unknown) =>
  error instanceof JuncoAgentError && error.code === "invalid_state";

for (const strategy of STRATEGIES) {
  describe(strategy, () => {
    test("a dependent gets its parent's result once, before its staged prompt, and priming loses nothing", async () => {
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
        agentNode(upstream, { description: "upstream", trigger: always() }),
      );
      const d = graph.addNode(
        agentNode(
          dependent,
          { description: "dependent", trigger: when(edge) },
          {
            receive: (view) =>
              [...view.values.keys()].map((id) => ({
                kind: "nextTurn",
                text: `upstream: ${textOf(view.values.get(id)!)}`,
              })),
          },
        ),
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
        ["upstream: upstream result", "use it"],
        ["upstream: upstream result", "use it"],
        ["upstream: upstream result", "use it"],
      ]);
      assert.deepEqual(userTexts(dependent.history), [
        "upstream: upstream result",
        "use it",
      ]);
      const result = graph.result(d);
      assert.ok(O.isSome(result) && textOf(result.value) === "dependent done");
    });

    test("all five dispatched methods keep their order and reach only the wired recipient", async () => {
      const images = [image("1"), image("2"), image("3"), image("4")] as const;
      const note = { role: "user", content: "note", timestamp: 1 } as const;
      const sender = new MockAgent({
        prompt: "start",
        runs: [yieldsThen(1, "sender done")],
      });
      const recipient = new MockAgent({
        runs: [
          run([
            pause([reason("first", "r1")]),
            settle(assistant("recipient done"), {
              drain: ["steer", "followUp"],
            }),
          ]),
        ],
      });
      const bystander = new MockAgent({ runs: [yieldsThen(0, "never")] });
      const graph = plainGraph(strategy);
      const toRecipient = messageEdge<AgenticInput, AssistantMessage>(
        "sender->recipient",
      );
      const toBystander = messageEdge<AgenticInput, AssistantMessage>(
        "sender->bystander",
      );
      const s = graph.addNode(
        graphApi.nodes.agentNode(
          sender,
          { description: "sender", trigger: always() },
          {
            emit: () => [
              msg(toRecipient, { kind: "appendMessage", message: note }),
              msg(toRecipient, {
                kind: "nextTurn",
                text: "context first",
                images: [images[0]],
              }),
              msg(toRecipient, {
                kind: "prompt",
                text: "then work",
                images: [images[1]],
              }),
              msg(toRecipient, {
                kind: "steer",
                text: "adjust",
                images: [images[2]],
              }),
              msg(toRecipient, {
                kind: "followUp",
                text: "confirm",
                images: [images[3]],
              }),
            ],
          },
        ),
      );
      const byMessages = (edge: typeof toRecipient): AgentNodeBinding => ({
        receive: (view: ParentView<AgenticInput, AssistantMessage>) =>
          view.messages.get(edge.id) ?? [],
      });
      const r = graph.addNode(
        graphApi.nodes.agentNode(
          recipient,
          { description: "recipient", trigger: when(toRecipient) },
          byMessages(toRecipient),
        ),
      );
      const b = graph.addNode(
        graphApi.nodes.agentNode(
          bystander,
          { description: "bystander", trigger: when(toBystander) },
          byMessages(toBystander),
        ),
      );
      graph.addEdge(s, r, toRecipient);
      graph.addEdge(s, b, toBystander);

      await graph.run();

      assert.deepEqual(
        recipient.calls.map(({ method }) => method),
        ["appendMessage", "nextTurn", "prompt", "steer", "followUp"],
      );
      assert.equal(recipient.calls[0]!.args[0], note);
      recipient.calls.slice(1).forEach(({ args }, index) => {
        const options = args[1];
        assert.ok(
          typeof options === "object" &&
            options !== null &&
            "images" in options &&
            Array.isArray(options.images),
        );
        assert.equal(options.images[0], images[index]);
      });
      const history = recipient.history;
      assert.deepEqual(userTexts(history), [
        "note",
        "context first",
        "then work",
        "adjust",
        "confirm",
      ]);
      const users = history.filter((message) => message.role === "user");
      users.slice(1).forEach((message, index) => {
        assert.ok(Array.isArray(message.content));
        assert.equal(message.content[1], images[index]);
      });
      assert.deepEqual(requestTexts(recipient.requests), [
        ["note", "context first", "then work"],
        ["note", "context first", "then work", "adjust", "confirm"],
      ]);
      assert.deepEqual(bystander.calls, []);
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
        agentNode(idle, { description: "idle", trigger: always() }),
      );

      assert.equal(graph.available().size, 0);
      await graph.run();
      assert.deepEqual(idle.requests, []);
      assert.equal(idle.status, "idle");
    });

    test("a control-only delivery leaves the member idle without blocking the graph", async () => {
      const sender = new MockAgent({
        prompt: "go",
        runs: [yieldsThen(1, "sent")],
      });
      const member = new MockAgent({ runs: [yieldsThen(0, "later")] });
      const graph = plainGraph(strategy);
      const edge = messageEdge<AgenticInput, AssistantMessage>(
        "sender->member",
      );
      const s = graph.addNode(
        agentNode(
          sender,
          { description: "sender", trigger: always() },
          {
            emit: () => [
              msg(edge, {
                kind: "appendMessage",
                message: {
                  role: "user",
                  content: "remember this",
                  timestamp: 1,
                },
              }),
            ],
          },
        ),
      );
      const m = graph.addNode(
        agentNode(
          member,
          { description: "member", trigger: when(edge) },
          { receive: (view) => view.messages.get(edge.id) ?? [] },
        ),
      );
      graph.addEdge(s, m, edge);

      await graph.run();

      assert.deepEqual(member.requests, []);
      assert.equal(member.status, "idle");
      assert.equal(graph.getNode(m)!.status, "running");
      assert.equal(graph.available().size, 0);
      assert.equal(textOf(await member.prompt("and now")), "later");
      assert.deepEqual(requestTexts(member.requests), [
        ["remember this", "and now"],
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
        const graph = plainGraph(strategy);
        const id = graph.addNode(
          agentNode(erring, { description: "erring", trigger: always() }),
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
        agentNode(failing, { description: "failing", trigger: always() }),
      );
      const c = graph.addNode(
        agentNode(child, { description: "child", trigger: when(edge) }),
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
        agentNode(exhausted, { description: "exhausted", trigger: always() }),
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
        agentNode(member, { description: "member", trigger: always() }),
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

    test("a node runs one prompt: a received prompt conflicts with a staged one", async () => {
      const upstream = new MockAgent({
        prompt: "produce",
        runs: [yieldsThen(0, "up")],
      });
      const member = new MockAgent({
        prompt: "staged",
        runs: [yieldsThen(0, "staged result")],
      });
      const graph = plainGraph(strategy);
      const edge = valueEdge<AgenticInput, AssistantMessage>("up->member");
      const u = graph.addNode(
        agentNode(upstream, { description: "upstream", trigger: always() }),
      );
      const m = graph.addNode(
        agentNode(
          member,
          { description: "member", trigger: when(edge) },
          { receive: () => [{ kind: "prompt", text: "received" }] },
        ),
      );
      graph.addEdge(u, m, edge);

      const error = await graph.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === m);
      assert.ok(invalidState(error.error));
      assert.deepEqual(member.requests, []);
      assert.deepEqual(member.calls, []);
      assert.equal(member.status, "ready");
      // The staged run's transcript is untouched.
      const staged = await member.next();
      assert.ok(
        staged.value?.kind === "settled" &&
          textOf(staged.value.message) === "staged result",
      );
    });

    test("a node prompt starts an idle member after its delivered inputs, once in each graph", async () => {
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
        agentNode(upstream, { description: "upstream", trigger: always() }),
      );
      const firstId = first.addNode(
        agentNode(
          member,
          { description: "member", trigger: when(edge) },
          {
            prompt: "round one",
            receive: (view) =>
              [...view.values.keys()].map((id) => ({
                kind: "nextTurn",
                text: `upstream: ${textOf(view.values.get(id)!)}`,
              })),
          },
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
          { description: "member", trigger: always() },
          { prompt: "round two" },
        ),
      );
      await second.run();
      const secondResult = second.result(secondId);
      assert.ok(
        O.isSome(secondResult) && textOf(secondResult.value) === "second",
      );
      assert.deepEqual(userTexts(member.history), [
        "upstream: context",
        "round one",
        "round two",
      ]);
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
          { description: "member", trigger: always() },
          { prompt: "node" },
        ),
      );

      const error = await graph.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === id);
      assert.ok(invalidState(error.error));
      assert.deepEqual(member.requests, []);
      assert.equal(member.status, "ready");
    });

    test("a node runs one prompt: a second received prompt after the run started fails it", async () => {
      const sender = new MockAgent({
        prompt: "send",
        runs: [
          run([
            pause([reason("first", "s1")]),
            pause([reason("wait", "s2")]),
            pause([reason("second", "s3")]),
            settle(assistant("sent")),
          ]),
        ],
      });
      const member = new MockAgent({ runs: [yieldsThen(1, "never")] });
      const graph = plainGraph(strategy);
      const edge = messageEdge<AgenticInput, AssistantMessage>(
        "sender->member",
      );
      const s = graph.addNode(
        agentNode(
          sender,
          { description: "sender", trigger: always() },
          {
            emit: (step) => {
              const text = step.reasons[0]!.reason;
              return text === "wait"
                ? []
                : [msg(edge, { kind: "prompt", text })];
            },
          },
        ),
      );
      const m = graph.addNode(
        agentNode(
          member,
          { description: "member", trigger: when(edge) },
          { receive: (view) => view.messages.get(edge.id) ?? [] },
        ),
      );
      graph.addEdge(s, m, edge);

      const error = await graph.run().catch((thrown: unknown) => thrown);
      assert.ok(error instanceof DataflowNodeError && error.nodeId === m);
      assert.ok(invalidState(error.error));
      assert.deepEqual(
        member.calls.map(({ method, args }) => [method, args[0]]),
        [["prompt", "first"]],
      );
      assert.deepEqual(requestTexts(member.requests), [["first"]]);
      assert.equal(member.status, "suspended");
    });

    test("one shared availability predicate holds ready agent, coroutine and graph nodes until released", async () => {
      let admitted = false;
      const shared: NodeOptions<AgenticInput, AssistantMessage> = {
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
      const innerId = child.addNode(agentNode(inner, { trigger: always() }));
      let entered = false;
      const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
        async function* () {
          entered = true;
          yield [];
          return assistant("coroutine done");
        },
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
          { trigger: when(fromAgent) },
          {
            receive: (view) => [
              {
                kind: "prompt",
                text: `got ${textOf(view.values.get(fromAgent.id)!)}`,
              },
            ],
          },
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
      assert.deepEqual(requestTexts(consumer.requests), [["got agent done"]]);
      assert.equal(graph.getNode(g)!.state, child);
    });
  });
}
