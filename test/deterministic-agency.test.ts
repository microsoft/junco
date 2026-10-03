import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  allOf,
  always,
  anyOf,
  DataflowDefinitionError,
  DataflowNodeError,
  type Edge,
  from,
  messageEdge,
  msg,
  type Message,
  NodeId,
  type NodeOptions,
  type NodeSchedule,
  on,
  triggerInputs,
  UNBOUNDED,
  valueEdge,
  when,
  Width,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgentError } from "junco-agent";
import { createParallelScheduler, createScheduler } from "junco-scheduler";
import {
  type AgenticInput,
  agentNode,
  Deterministic,
  deterministicNode,
  graphNode,
  JuncoGraph,
  MockAgent,
  type MockHook,
  type MockRun,
} from "../src/index.ts";
import {
  assistant,
  pause,
  type PolicyScheduler,
  policyGraph,
  reason,
  requestTexts,
  run,
  settle,
  STRATEGIES,
  textOf,
  userTexts,
  yieldsThen,
} from "./deterministic-support.ts";

// JuncoGraphs of mock members, coroutines and nested graphs on the real round-robin and parallel
// policies. Graphs, schedulers, recursive lifecycle and cancellation are real.

type PolicyGraph = JuncoGraph<AgenticInput, AssistantMessage, unknown, PolicyScheduler>;

const TIMEOUT_MS = 30_000;
const invalidState = (error: unknown) => error instanceof JuncoAgentError && error.code === "invalid_state";
const closedGraph = (error: unknown) => error instanceof JuncoAgentError && error.code === "closed";

/** A scripted `before_drive` hook whose registered handler must return nothing. */
const DRIVE: MockHook = { name: "before_drive", event: { operation: "run", lane: "main", runId: "run" }, results: [undefined] };

/** A run whose first frame waits in its `before_drive` hook, then settles `text`. */
const gatedRun = (text: string, yields = 0): MockRun =>
  run([
    ...Array.from({ length: yields }, (_, index) =>
      pause([reason(`pause ${index + 1}`, `g${index + 1}`)], index === 0 ? { hooks: [DRIVE] } : {}),
    ),
    settle(assistant(text), yields === 0 ? { hooks: [DRIVE] } : {}),
  ]);

/**
 * A `before_drive` handler that records its start and its run Context's cancellation, and returns
 * once released — or, with `endOnAbort`, once cancelled.
 */
type Barrier = {
  readonly handler: (event: unknown, context: Context) => Promise<undefined>;
  readonly started: Promise<void>;
  readonly aborted: Promise<void>;
  readonly release: () => void;
  readonly finished: boolean;
};

function barrier({ endOnAbort = false }: { readonly endOnAbort?: boolean } = {}): Barrier {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const state = { finished: false };
  const handler = async (_event: unknown, context: Context): Promise<undefined> => {
    started.resolve();
    const signal = context.abortSignal;
    if (signal?.aborted) aborted.resolve();
    else signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
    await (endOnAbort ? Promise.race([released.promise, aborted.promise]) : released.promise);
    state.finished = true;
    return undefined;
  };
  return {
    handler,
    started: started.promise,
    aborted: aborted.promise,
    release: () => released.resolve(),
    get finished() {
      return state.finished;
    },
  };
}

/** A gated member: its `before_drive` handler is `gate.handler`. */
function gated(agent: MockAgent, gate: Barrier): MockAgent {
  agent.hooks.on("before_drive", gate.handler);
  return agent;
}

/** A mock member recording every `abort` and `return` it receives. */
class Counted extends MockAgent {
  readonly lifecycle: string[] = [];
  override abort() {
    this.lifecycle.push("abort");
    return super.abort();
  }
  override return(value?: void | PromiseLike<void>) {
    this.lifecycle.push("return");
    return super.return(value);
  }
}

/** An idle member whose abort fails with `failure`. */
const failingAbort = (failure: Error): MockAgent =>
  new (class extends MockAgent {
    protected override abortDependents(): Promise<void> {
      return Promise.reject(failure);
    }
  })({ runs: [] });

const member = (agent: MockAgent, description = "member", id?: string) =>
  agentNode(agent, { ...(id === undefined ? {} : { id: NodeId(id) }), description, trigger: always() });

/** A nested-graph node its parent never runs: the test drives `child` itself. */
const detached = (child: PolicyGraph, result: NodeId, description = "nested") =>
  graphNode(child, { description, trigger: always(), is_available: () => false }, { result });

/** The messages currently queued on message edge `edge`. */
const queued = (edge: Edge<AgenticInput, AssistantMessage>): AgenticInput[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

const resultText = (graph: Pick<PolicyGraph, "result">, id: NodeId): string | undefined => {
  const result = graph.result(id);
  return O.isSome(result) ? textOf(result.value) : undefined;
};

/** The stop reason of `id`'s retained result. */
const stopReason = (graph: Pick<PolicyGraph, "result">, id: NodeId) => {
  const result = graph.result(id);
  return O.isSome(result) ? result.value.stopReason : undefined;
};

/** The rejection of `drive`, or `undefined` once it fulfils; observed immediately. */
const outcome = (drive: Promise<unknown>): Promise<unknown> => drive.then(() => undefined, (error: unknown) => error);

/** Step the graph until `done` holds; a bounded loop, so a regression fails instead of spinning. */
async function stepUntil(graph: Pick<PolicyGraph, "step">, done: () => boolean): Promise<void> {
  for (let windows = 0; windows < 64; windows++) {
    if (done()) return;
    await graph.step();
  }
  assert.fail("condition not reached within 64 graph windows");
}

/** Let every queued microtask run; shows only that nothing progressed, never waits for progress. */
const flushMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const strategy of STRATEGIES) {
  describe(strategy, () => {
    test("a suspended member stays schedulable with its policy reasons until it settles", async () => {
      const sender = new MockAgent({ prompt: "send", runs: [yieldsThen(1, "sent")] });
      const first = [reason("first pause", "y1")];
      const second = [reason("bash denied by policy", "p1", "policy"), reason("after denial", "y2")];
      const worker = new MockAgent({ runs: [run([pause(first), pause(second), settle(assistant("worker done"))])] });
      const child = new MockAgent({ prompt: "child", runs: [yieldsThen(0, "child done")] });
      const graph = policyGraph(strategy);
      const work = messageEdge<AgenticInput, AssistantMessage>("sender->worker");
      const result = valueEdge<AgenticInput, AssistantMessage>("worker->child");
      const s = graph.addNode(
        agentNode(
          sender,
          { description: "sender", trigger: always() },
          { emit: () => [msg(work, { kind: "prompt", text: "work" })] },
        ),
      );
      const w = graph.addNode(
        agentNode(
          worker,
          { description: "worker", trigger: when(work) },
          { receive: (view) => view.messages.get(work.id) ?? [] },
        ),
      );
      const c = graph.addNode(agentNode(child, { description: "child", trigger: when(result) }));
      graph.addEdge(s, w, work).addEdge(w, c, result);

      await stepUntil(graph, () => worker.requests.length === 1);
      assert.deepEqual(queued(work), []);
      assert.equal(worker.status, "suspended");
      assert.ok(graph.available().has(w));
      assert.ok(!graph.available().has(c));
      assert.ok(O.isNone(graph.result(w)));

      await stepUntil(graph, () => worker.requests.length === 2);
      assert.equal(worker.status, "suspended");
      assert.ok(graph.available().has(w));
      assert.ok(!graph.available().has(c));
      assert.ok(O.isNone(graph.result(w)));

      await graph.run();
      assert.equal(resultText(graph, w), "worker done");
      assert.equal(resultText(graph, c), "child done");
      assert.deepEqual(requestTexts(worker.requests), [["work"], ["work"], ["work"]]);
      await graph.close();
      assert.equal(worker.status, "closed");
    });

    test("an any trigger reads a newer message although a delivered result stays satisfied", async () => {
      const source = new MockAgent({ prompt: "value", runs: [yieldsThen(0, "the value")] });
      const messenger = new MockAgent({ runs: [yieldsThen(1, "messenger done")] });
      const drainFollowUp = { drain: ["followUp"] } as const;
      const reader = new MockAgent({
        prompt: "read",
        runs: [
          run([
            pause([reason("ask for more", "r1")]),
            pause([reason("waiting", "r2")], drainFollowUp),
            pause([reason("waiting", "r3")], drainFollowUp),
            pause([reason("waiting", "r4")], drainFollowUp),
            settle(assistant("reader after more"), drainFollowUp),
          ]),
        ],
      });
      const graph = policyGraph(strategy);
      const value = valueEdge<AgenticInput, AssistantMessage>("a->c");
      const ask = messageEdge<AgenticInput, AssistantMessage>("c->b");
      const more = messageEdge<AgenticInput, AssistantMessage>("b->c");
      const a = graph.addNode(member(source, "source", "a"));
      const b = graph.addNode(
        agentNode(
          messenger,
          { id: NodeId("b"), description: "messenger", trigger: when(ask) },
          {
            receive: (view) => view.messages.get(ask.id) ?? [],
            emit: () => [msg(more, { kind: "followUp", text: "more" })],
          },
        ),
      );
      const c = graph.addNode(
        agentNode(
          reader,
          { id: NodeId("c"), description: "reader", trigger: anyOf(on(value), on(more)) },
          {
            receive: (view) => [
              ...[...view.values.keys()].map(
                (id): AgenticInput => ({ kind: "nextTurn", text: `got ${textOf(view.values.get(id)!)}` }),
              ),
              ...(view.messages.get(more.id) ?? []),
            ],
            emit: (step) =>
              step.reasons[0]?.reason === "ask for more" ? [msg(ask, { kind: "prompt", text: "help" })] : [],
          },
        ),
      );
      graph.addEdge(a, c, value).addEdge(c, b, ask).addEdge(b, c, more);

      await graph.run();

      assert.deepEqual(
        [a, b, c].map((id) => resultText(graph, id)),
        ["the value", "messenger done", "reader after more"],
      );
      assert.deepEqual(userTexts(reader.history), ["got the value", "read", "more"]);
      assert.deepEqual(
        reader.calls.map(({ method, args }) => [method, args[0]]),
        [
          ["nextTurn", "got the value"],
          ["followUp", "more"],
        ],
      );
      assert.deepEqual(queued(more), []);
      await graph.close();
    });

    test("an all trigger reads both message edges together or neither", async () => {
      const outbox: Message<AgenticInput>[] = [];
      const sender = new MockAgent({ prompt: "send", runs: [yieldsThen(12, "sent")] });
      const gatedMember = new MockAgent({
        prompt: "start",
        followUpMode: "all",
        runs: [
          run([
            ...Array.from({ length: 8 }, (_, index) => pause([reason("wait", `m${index}`)], { drain: ["followUp"] })),
            settle(assistant("member done"), { drain: ["followUp"] }),
          ]),
        ],
      });
      const graph = policyGraph(strategy);
      const left = messageEdge<AgenticInput, AssistantMessage>("left");
      const right = messageEdge<AgenticInput, AssistantMessage>("right");
      const s = graph.addNode(
        agentNode(sender, { id: NodeId("s"), description: "sender", trigger: always() }, { emit: () => outbox.splice(0) }),
      );
      const m = graph.addNode(
        agentNode(
          gatedMember,
          { id: NodeId("m"), description: "gated", trigger: allOf(on(left), on(right)) },
          { receive: (view) => [...(view.messages.get(left.id) ?? []), ...(view.messages.get(right.id) ?? [])] },
        ),
      );
      graph.addEdge(s, m, left).addEdge(s, m, right);
      const followUp = (text: string): AgenticInput => ({ kind: "followUp", text });
      const containing = (text: string) => requestTexts(gatedMember.requests).findIndex((texts) => texts.includes(text));

      outbox.push(msg(left, followUp("x1")));
      await stepUntil(graph, () => queued(left).length === 1);
      assert.ok(!graph.available().has(m));
      assert.equal(gatedMember.status, "ready");
      assert.deepEqual(gatedMember.requests, []);

      outbox.push(msg(right, followUp("y1")));
      await stepUntil(graph, () => gatedMember.requests.length === 1);
      assert.deepEqual([queued(left), queued(right)], [[], []]);
      assert.deepEqual(requestTexts(gatedMember.requests), [["start", "x1", "y1"]]);

      outbox.push(msg(left, followUp("x2")));
      await stepUntil(graph, () => queued(left).length === 1);
      const before = gatedMember.requests.length;
      await stepUntil(graph, () => gatedMember.requests.length > before);
      assert.deepEqual([queued(left), queued(right)], [[followUp("x2")], []]);
      assert.equal(containing("x2"), -1);

      outbox.push(msg(right, followUp("y2")));
      await stepUntil(graph, () => queued(left).length === 0 && queued(right).length === 0);
      const index = containing("x2");
      assert.ok(index > 0);
      assert.deepEqual(requestTexts(gatedMember.requests)[index], ["start", "x1", "y1", "x2", "y2"]);
      assert.equal(containing("y2"), index);

      await graph.run();
      assert.equal(resultText(graph, m), "member done");
      assert.deepEqual(userTexts(gatedMember.history), ["start", "x1", "y1", "x2", "y2"]);
      await graph.close();
    });

    test("a nested graph triggered by one message finishes and hands its selected result on", async () => {
      const source = new MockAgent({ prompt: "send", runs: [yieldsThen(1, "sent")] });
      const inner = new MockAgent({ prompt: "inner", runs: [yieldsThen(2, "inner done")] });
      const consumer = new MockAgent({ runs: [yieldsThen(0, "reviewed")] });
      const child = policyGraph(strategy);
      const innerId = child.addNode(member(inner, "inner"));
      const graph = policyGraph(strategy);
      const go = messageEdge<AgenticInput, AssistantMessage>("source->nested");
      const selected = valueEdge<AgenticInput, AssistantMessage>("nested=>consumer");
      const s = graph.addNode(
        agentNode(source, { trigger: always() }, { emit: () => [msg(go, { kind: "prompt", text: "go" })] }),
      );
      const n = graph.addNode(graphNode(child, { id: NodeId("nested"), trigger: when(go) }, { result: innerId }));
      const c = graph.addNode(
        agentNode(
          consumer,
          { trigger: when(selected) },
          {
            receive: (view) => [{ kind: "prompt", text: `review ${textOf(view.values.get(selected.id)!)}` }],
          },
        ),
      );
      graph.addEdge(s, n, go).addEdge(n, c, selected);

      await stepUntil(graph, () => inner.requests.length === 1);
      // The one trigger message is consumed, yet the started nested graph keeps running.
      assert.deepEqual(queued(go), []);
      assert.ok(graph.available().has(n));
      assert.ok(O.isNone(graph.result(n)));

      await graph.run();
      assert.equal(inner.requests.length, 3);
      assert.equal(resultText(child, innerId), "inner done");
      assert.equal(resultText(graph, n), "inner done");
      assert.equal(resultText(graph, c), "reviewed");
      assert.deepEqual(requestTexts(consumer.requests), [["review inner done"]]);
      assert.equal(graph.getNode(n)?.state, child);
      await graph.close();
      assert.ok([source, inner, consumer].every((agent) => agent.status === "closed"));
      assert.ok(child.signal.aborted);
    });

    test("nested graph routes final messages", async () => {
      const inputText = (input: AgenticInput): string =>
        input.kind === "prompt" ? input.text : assert.fail("expected a prompt input");
      for (const kind of ["all", "any"] as const) {
        const parent = policyGraph(strategy);
        const left = messageEdge<AgenticInput, AssistantMessage>("left->nested");
        const right = messageEdge<AgenticInput, AssistantMessage>("right->nested");
        const toN3 = messageEdge<AgenticInput, AssistantMessage>("nested->n3");
        const toN4 = messageEdge<AgenticInput, AssistantMessage>("nested->n4");
        const prompt = (text: string): AgenticInput => ({ kind: "prompt", text });

        const childScheduler = createScheduler<{ readonly texts: string[] }, AgenticInput, AssistantMessage>({
          state: { texts: [] },
          schedule: (available) => {
            const lanes: NodeSchedule[][] = [];
            for (const [id, candidate] of available) lanes.push([{ id, inputs: triggerInputs(candidate) }]);
            return lanes;
          },
        });
        const child = new JuncoGraph(childScheduler, Width(1), UNBOUNDED);
        const innerId = child.addNode(
          deterministicNode(
            new Deterministic<AgenticInput, AssistantMessage>(async function* () {
              yield [];
              while (childScheduler.state.texts.length < 2) yield [];
              return assistant(childScheduler.state.texts.join("+"));
            }),
            { id: NodeId("inner"), trigger: always() },
          ),
        );

        const source = (edge: Edge<AgenticInput, AssistantMessage>, text: string, delay: number) =>
          deterministicNode(
            new Deterministic<AgenticInput, AssistantMessage>(async function* () {
              for (let index = 0; index < delay; index++) yield [];
              yield [msg(edge, prompt(text))];
              return assistant(`${text} sent`);
            }),
            { id: NodeId(text), trigger: always() },
          );
        const observed = { n3: [] as string[][], n4: [] as string[][] };
        const consumer = (edge: Edge<AgenticInput, AssistantMessage>, name: "n3" | "n4") =>
          deterministicNode(
            new Deterministic<AgenticInput, AssistantMessage>(async function* () {
              const view = yield [];
              observed[name].push(from(view, edge).map(inputText));
              return assistant(`${name} done`);
            }),
            { id: NodeId(name), trigger: when(edge) },
          );

        const deliveries: string[][] = [];
        const l = parent.addNode(source(left, "left", 0));
        const r = parent.addNode(source(right, "right", 1));
        const n: NodeId = parent.addNode(
          graphNode(
            child,
            { id: NodeId("nested"), trigger: kind === "all" ? allOf(on(left), on(right)) : anyOf(on(left), on(right)) },
            {
              result: innerId,
              receive: (view) => {
                const batch = [...from(view, left), ...from(view, right)].map(inputText);
                if (batch.length === 0) return;
                deliveries.push(batch);
                childScheduler.state.texts.push(...batch);
              },
              afterStep: () => {
                const retained = child.result(innerId);
                if (O.isNone(retained)) return;
                const answer = textOf(retained.value);
                parent.emit(n, msg(toN3, prompt(`n3: ${answer}`)));
                parent.emit(n, msg(toN4, prompt(`n4: ${answer}`)));
              },
            },
          ),
        );
        const n3 = parent.addNode(consumer(toN3, "n3"));
        const n4 = parent.addNode(consumer(toN4, "n4"));
        parent.addEdge(l, n, left).addEdge(r, n, right).addEdge(n, n3, toN3).addEdge(n, n4, toN4);

        await stepUntil(parent, () => queued(left).length === 1);
        assert.deepEqual(queued(right), []);
        if (kind === "all") {
          await stepUntil(parent, () => queued(right).length === 1);
          await stepUntil(parent, () => parent.getNode(n)!.status === "running");
          // The conjunction held and the node primed, yet neither queue was read.
          assert.deepEqual([queued(left), queued(right)], [[prompt("left")], [prompt("right")]]);
          assert.deepEqual(deliveries, []);
          await stepUntil(parent, () => deliveries.length === 1);
          assert.deepEqual(deliveries, [["left", "right"]]);
        } else {
          await stepUntil(parent, () => deliveries.length === 2);
          assert.deepEqual(deliveries, [["left"], ["right"]]);
        }
        assert.deepEqual([queued(left), queued(right)], [[], []]);

        for (let windows = 0; O.isNone(parent.result(n)); windows++) {
          assert.ok(windows < 64, "nested node did not complete within 64 graph windows");
          assert.deepEqual([queued(toN3), queued(toN4), observed.n3, observed.n4], [[], [], [], []]);
          await parent.step();
        }
        // The completing activation both emitted and published its result: no extra step.
        assert.equal(resultText(parent, n), "left+right");
        assert.deepEqual([queued(toN3), queued(toN4)], [[prompt("n3: left+right")], [prompt("n4: left+right")]]);
        assert.deepEqual(observed, { n3: [], n4: [] });

        await parent.run();
        assert.deepEqual(observed, { n3: [["n3: left+right"]], n4: [["n4: left+right"]] });
        assert.deepEqual([queued(toN3), queued(toN4)], [[], []]);
        await parent.run();
        assert.deepEqual(observed, { n3: [["n3: left+right"]], n4: [["n4: left+right"]] });
        assert.equal(parent.getNode(n)?.state, child);
        await parent.close();
      }
    });

    test("a nested graph quiescent without its selected result fails before its dependent runs", async () => {
      const idle = new MockAgent({ runs: [] });
      const child = policyGraph(strategy);
      const idleId = child.addNode(member(idle, "idle"));
      const graph = policyGraph(strategy);
      const selected = valueEdge<AgenticInput, AssistantMessage>("nested=>dependent");
      let ran = false;
      const n = graph.addNode(graphNode(child, { trigger: always() }, { result: idleId }));
      const d = graph.addNode(
        deterministicNode(
          new Deterministic<AgenticInput, AssistantMessage>(async function* () {
            yield [];
            ran = true;
            return assistant("unused");
          }),
          { trigger: when(selected) },
        ),
      );
      graph.addEdge(n, d, selected);

      const error = await outcome(graph.run());
      assert.ok(error instanceof DataflowNodeError && invalidState(error.cause));
      assert.equal(ran, false);
      assert.ok(O.isNone(graph.result(n)) && O.isNone(graph.result(d)));
      assert.deepEqual(idle.requests, []);
      await graph.close();
    });

    test("an empty graph runs to an empty result map; a nested node must select a registered result", async () => {
      const empty = policyGraph(strategy);
      assert.equal((await empty.run()).size, 0);
      assert.throws(
        () => graphNode(empty, { trigger: always() }, { result: NodeId("missing") }),
        (error) => error instanceof DataflowDefinitionError,
      );
      await empty.close();
    });

    test("one shared availability predicate holds agent, coroutine and graph nodes until released", async () => {
      let admitted = false;
      const shared: NodeOptions<AgenticInput, AssistantMessage> = {
        trigger: always(),
        is_available: (_view, triggered) => admitted && triggered,
      };
      const agent = new MockAgent({ prompt: "go", runs: [yieldsThen(1, "agent done")] });
      const coroutine = new Deterministic<AgenticInput, AssistantMessage>(async function* () {
        yield [];
        return assistant("coroutine done");
      });
      const inner = new MockAgent({ prompt: "inner", runs: [yieldsThen(0, "inner done")] });
      const child = policyGraph(strategy);
      const innerId = child.addNode(member(inner, "inner"));
      const graph = policyGraph(strategy);
      const a = graph.addNode(agentNode(agent, { ...shared, id: NodeId("agent") }));
      const d = graph.addNode(deterministicNode(coroutine, { ...shared, id: NodeId("coroutine") }));
      const n = graph.addNode(graphNode(child, { ...shared, id: NodeId("nested") }, { result: innerId }));

      assert.equal((await graph.run()).size, 0);
      assert.equal(graph.available().size, 0);
      assert.ok([a, d, n].every((id) => O.isNone(graph.result(id))));
      assert.deepEqual([agent.requests, inner.requests], [[], []]);

      admitted = true;
      await graph.run();
      assert.deepEqual(
        [a, d, n].map((id) => resultText(graph, id)),
        ["agent done", "coroutine done", "inner done"],
      );
      const state = graph.getNode(a)?.state;
      assert.ok(state instanceof MockAgent && state === agent);
      assert.equal(state.requests.length, 2);
      assert.equal(inner.requests.length, 1);
      await graph.close();
    });

    test("an abort reaches every nested graph and joins a cooperative sibling", async () => {
      const grandchildGate = barrier({ endOnAbort: true });
      const grandchild = gated(new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }), grandchildGate);
      const siblingGate = barrier();
      const sibling = gated(new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }), siblingGate);
      const child = policyGraph(strategy);
      const g = child.addNode(member(grandchild, "grandchild"));
      const root = policyGraph(strategy);
      root.addNode(detached(child, g, "child graph"));
      const sb = root.addNode(member(sibling, "sibling"));

      await child.step(); // primes the grandchild
      await root.step(); // primes the sibling; the detached child graph is never available
      const [childSignal, rootSignal] = [child.signal, root.signal];
      const childWindow = outcome(child.step());
      const rootWindow = outcome(root.step());
      await Promise.all([grandchildGate.started, siblingGate.started]);

      let aborted = false;
      const aborting = root.abort().then(() => {
        aborted = true;
      });
      await Promise.all([grandchildGate.aborted, siblingGate.aborted]);
      assert.equal(await childWindow, childSignal.reason);
      await flushMacrotask();
      assert.equal(aborted, false);
      assert.equal(siblingGate.finished, false);
      siblingGate.release();
      await aborting;
      assert.ok(siblingGate.finished);
      assert.equal(await rootWindow, rootSignal.reason);
      assert.equal(childSignal.reason, rootSignal.reason);
      assert.equal(stopReason(child, g), "aborted");
      assert.equal(stopReason(root, sb), "aborted");
      // Abort leaves both graphs reusable; close then reaches every level.
      assert.ok(!root.signal.aborted && !child.signal.aborted);
      await root.close();
      for (const agent of [grandchild, sibling]) assert.equal(agent.status, "closed");
      assert.ok(child.signal.aborted);
    });

    test("failing member aborts never skip a gated sibling, and the graph reports them in order", async () => {
      const first = new Error("first abort failed");
      const nested = new Error("nested abort failed");
      const siblingGate = barrier({ endOnAbort: true });
      const sibling = gated(new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }), siblingGate);
      const child = policyGraph(strategy);
      // Idle, so never scheduled: only the abort cascade reaches them.
      const nestedId = child.addNode(member(failingAbort(nested), "nested failing"));
      const root = policyGraph(strategy);
      root.addNode(member(failingAbort(first), "failing"));
      const sb = root.addNode(member(sibling, "sibling"));
      root.addNode(detached(child, nestedId));
      await root.step(); // primes the sibling
      const signal = root.signal;
      const window = outcome(root.step());
      await siblingGate.started;

      const error = await outcome(root.abort());
      // The aggregate reports only the original failures, after the sibling was cancelled and joined.
      assert.ok(siblingGate.finished);
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, nested]);
      assert.equal(await window, signal.reason);
      assert.equal(stopReason(root, sb), "aborted");
      await root.close();
    });

    test("a caller signal cancels only its own drive after the active column drains", async () => {
      const gate = barrier();
      const worker = gated(new MockAgent({ prompt: "go", runs: [gatedRun("resumed", 1)] }), gate);
      const graph = policyGraph(strategy);
      const id = graph.addNode(member(worker, "worker"));
      const controller = new AbortController();
      const cancelled = new Error("drive cancelled");
      let settled = false;
      const running = graph.run({ signal: controller.signal }).finally(() => {
        settled = true;
      });

      await gate.started;
      controller.abort(cancelled);
      await flushMacrotask();
      assert.equal(settled, false);
      gate.release();
      await assert.rejects(running, (error) => error === cancelled);
      assert.equal(worker.requests.length, 1);
      assert.equal(worker.status, "suspended");
      assert.equal(graph.getNode(id)!.status, "running");
      assert.ok(O.isNone(graph.result(id)));

      // The graph itself was neither aborted nor closed: a plain drive resumes the member.
      assert.equal(graph.signal.aborted, false);
      await graph.run();
      assert.equal(resultText(graph, id), "resumed");
      assert.equal(worker.requests.length, 2);
      await graph.close();
    });

    test("a plain drive observes graph abort, and later work runs under a fresh signal", async () => {
      const gate = barrier({ endOnAbort: true });
      const worker = gated(new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }), gate);
      const graph = policyGraph(strategy);
      const id = graph.addNode(member(worker, "worker"));
      const signal = graph.signal;
      const running = outcome(graph.run());
      await gate.started;

      const cancelled = new Error("graph aborted");
      await graph.abort(cancelled);
      assert.equal(await running, cancelled);
      assert.equal(signal.reason, cancelled);
      assert.equal(stopReason(graph, id), "aborted");
      assert.notEqual(graph.signal, signal);
      assert.equal(graph.signal.aborted, false);

      const fresh = new MockAgent({ prompt: "again", runs: [yieldsThen(0, "fresh")] });
      const f = graph.addNode(member(fresh, "fresh"));
      await graph.run();
      assert.equal(resultText(graph, f), "fresh");
      await graph.close();
    });

    test("a plain drive observes graph close; results stay readable and new drives reject", async () => {
      const first = new MockAgent({ prompt: "first", runs: [yieldsThen(0, "first")] });
      const graph = policyGraph(strategy);
      const f = graph.addNode(member(first, "first"));
      await graph.run();
      const gate = barrier({ endOnAbort: true });
      const worker = gated(new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }), gate);
      graph.addNode(member(worker, "worker"));
      const signal = graph.signal;
      const running = outcome(graph.run());
      await gate.started;

      const closing = graph.close();
      await closing;
      const error = await running;
      assert.equal(error, signal.reason);
      assert.ok([first, worker].every((agent) => agent.status === "closed"));

      assert.equal(graph.close(), closing);
      await graph[Symbol.asyncDispose]();
      assert.equal(resultText(graph, f), "first");
      await assert.rejects(graph.run(), (thrown) => thrown === graph.signal.reason);
      await assert.rejects(graph.step(), (thrown) => thrown === graph.signal.reason);
      await assert.rejects(graph.abort(), closedGraph);
    });

    test("closing a suspended graph closes each member once, without aborting it", async () => {
      const counted = new Counted({ runs: [] });
      const grandchild = new Counted({ prompt: "go", runs: [yieldsThen(1, "unused")] });
      const child = policyGraph(strategy);
      const g = child.addNode(member(grandchild, "grandchild"));
      const root = policyGraph(strategy);
      root.addNode(detached(child, g, "child graph"));
      root.addNode(member(counted, "counted"));
      await child.step();
      await child.step();
      assert.equal(grandchild.status, "suspended");

      await root.close();
      assert.deepEqual([counted.lifecycle, grandchild.lifecycle], [["return"], ["return"]]);
      for (const agent of [grandchild, counted]) assert.equal(agent.status, "closed");
      assert.ok(root.signal.aborted && child.signal.aborted);
      await root.close();
      await root[Symbol.asyncDispose]();
      await child.close();
      assert.deepEqual([counted.lifecycle, grandchild.lifecycle], [["return"], ["return"]]);
    });

    test("cyclic and shared nested graphs are visited once per cascade", async () => {
      const agents = [0, 1, 2].map(() => new Counted({ runs: [] }));
      const graphs = agents.map(() => policyGraph(strategy));
      const [a, b, shared] = graphs.map((graph, index) => ({
        graph,
        id: graph.addNode(member(agents[index]!, `member ${index}`)),
      }));
      // a ⇄ b form a cycle, and both nest the same shared graph.
      a!.graph.addNode(detached(b!.graph, b!.id));
      a!.graph.addNode(detached(shared!.graph, shared!.id));
      b!.graph.addNode(detached(a!.graph, a!.id));
      b!.graph.addNode(detached(shared!.graph, shared!.id));
      const signals = graphs.map((graph) => graph.signal);

      const cancelled = new Error("cyclic abort");
      await a!.graph.abort(cancelled);
      assert.ok(signals.every((signal) => signal.reason === cancelled));
      assert.ok(graphs.every((graph) => !graph.signal.aborted));
      assert.deepEqual(
        agents.map((agent) => agent.lifecycle),
        [["abort"], ["abort"], ["abort"]],
      );

      await a!.graph.close();
      assert.ok(graphs.every((graph) => graph.signal.aborted));
      assert.deepEqual(
        agents.map((agent) => agent.lifecycle),
        [
          ["abort", "return"],
          ["abort", "return"],
          ["abort", "return"],
        ],
      );
      await assert.rejects(b!.graph.abort(), closedGraph);
    });

    test(
      "abort and close cascade through 4096 nested graphs without growing the stack",
      async () => {
        const innermost = new MockAgent({ runs: [] });
        const bottom = policyGraph(strategy);
        let graph = bottom;
        let selected = graph.addNode(member(innermost, "innermost"));
        for (let depth = 0; depth < 4096; depth++) {
          const parent = policyGraph(strategy);
          selected = parent.addNode(detached(graph, selected, `level ${depth}`));
          graph = parent;
        }
        const signal = bottom.signal;

        const cancelled = new Error("deep abort");
        await graph.abort(cancelled);
        assert.equal(signal.reason, cancelled);
        assert.equal(bottom.signal.aborted, false);
        await graph.close();
        assert.equal(innermost.status, "closed");
        assert.ok(bottom.signal.aborted);
      },
      TIMEOUT_MS,
    );

    test("a direct nested close during an enclosing abort closes its members before the abort settles", async () => {
      const siblingGate = barrier();
      const sibling = gated(new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }), siblingGate);
      const inner = new Counted({ runs: [] });
      const child = policyGraph(strategy);
      const ii = child.addNode(member(inner, "inner"));
      const parent = policyGraph(strategy);
      parent.addNode(detached(child, ii));
      const sb = parent.addNode(member(sibling, "sibling"));
      await parent.step(); // primes the sibling
      const parentSignal = parent.signal;
      const window = outcome(parent.step());
      await siblingGate.started;

      const cancelled = new Error("parent abort");
      let aborted = false;
      const aborting = parent.abort(cancelled).then(() => {
        aborted = true;
      });
      await siblingGate.aborted;
      assert.equal(child.signal.reason, cancelled);

      await child.close();
      assert.equal(inner.status, "closed");
      assert.deepEqual(inner.lifecycle, ["abort", "return"]);
      assert.equal(aborted, false);
      assert.equal(siblingGate.finished, false);
      const closedSignal = child.signal;
      assert.ok(closedSignal.aborted && closedSignal.reason !== cancelled);

      siblingGate.release();
      await aborting;
      assert.equal(await window, cancelled);
      assert.equal(stopReason(parent, sb), "aborted");
      // The older abort neither suppressed the close nor restored the closed child's signal.
      assert.equal(child.signal, closedSignal);
      await assert.rejects(child.abort(), closedGraph);
      // The completed abort left the parent nonterminal, with a fresh signal for new work.
      assert.notEqual(parent.signal, parentSignal);
      assert.equal(parent.signal.aborted, false);
      const fresh = new MockAgent({ prompt: "again", runs: [yieldsThen(0, "fresh")] });
      const f = parent.addNode(member(fresh, "fresh"));
      await parent.run();
      assert.equal(resultText(parent, f), "fresh");
      await parent.close();
      assert.deepEqual(inner.lifecycle, ["abort", "return"]);
    });

    test("a member whose close fails can join another graph; the failed close is cached", async () => {
      const failure = new Error("member close failed");
      let attempts = 0;
      class FailingCloseOnce extends MockAgent {
        override return(value?: void | PromiseLike<void>) {
          if (++attempts > 1) return super.return(value);
          return Promise.reject(failure);
        }
      }
      const stubborn = new FailingCloseOnce({ prompt: "go", runs: [yieldsThen(0, "later")] });
      const first = policyGraph(strategy);
      first.addNode(member(stubborn, "stubborn"));
      const error = await outcome(first.close());
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      assert.equal(stubborn.status, "ready");
      // Repeated close and disposal join the same failed close.
      await assert.rejects(first.close(), (thrown) => thrown === error);
      await assert.rejects(first[Symbol.asyncDispose](), (thrown) => thrown === error);
      assert.equal(attempts, 1);

      const second = policyGraph(strategy);
      const id = second.addNode(member(stubborn, "stubborn"));
      await second.run();
      assert.equal(resultText(second, id), "later");
      await second.close();
      assert.equal(stubborn.status, "closed");
    });
  });
}

describe("nested graphs", () => {
  test("a selected undefined result is a present parent value", async () => {
    type Maybe = AssistantMessage | undefined;
    const child = new JuncoGraph<AgenticInput, Maybe>(createParallelScheduler(), Width(1), UNBOUNDED);
    const empty = child.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, Maybe>(async function* () {
          return undefined;
        }),
        { trigger: always() },
      ),
    );
    const parent = new JuncoGraph<AgenticInput, Maybe>(createParallelScheduler(), Width(1), UNBOUNDED);
    const selected = valueEdge<AgenticInput, Maybe>("nested=>reader");
    let observed: { readonly delivered: boolean; readonly value: Maybe } | undefined;
    const n = parent.addNode(graphNode(child, { trigger: always() }, { result: empty }));
    const r = parent.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, Maybe>(async function* () {
          const view = yield [];
          observed = { delivered: view.values.has(selected.id), value: view.values.get(selected.id) };
          return assistant("read");
        }),
        { trigger: when(selected) },
      ),
    );
    parent.addEdge(n, r, selected);

    await parent.run();
    assert.deepEqual(parent.result(n), O.some(undefined));
    assert.deepEqual(observed, { delivered: true, value: undefined });
    await parent.close();
  });

  test("cancellation uses the activation's captured child signal after abort resets it", async () => {
    const child = new JuncoGraph<AgenticInput, AssistantMessage>(createParallelScheduler(), Width(1), UNBOUNDED);
    const source = child.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, AssistantMessage>(async function* () {
          return assistant("child-result");
        }),
        { trigger: always() },
      ),
    );
    const parent = new JuncoGraph<AgenticInput, AssistantMessage>(createParallelScheduler(), Width(1), UNBOUNDED);
    const cancelled = new Error("child cancelled");
    let captured: AbortSignal | undefined;
    const nested = parent.addNode(
      graphNode(
        child,
        { trigger: always() },
        {
          result: source,
          // Fully settle the child's abort, which gives it a fresh signal, before completion is tested.
          afterStep: async () => {
            captured = child.signal;
            await child.abort(cancelled);
          },
        },
      ),
    );

    const failure = await parent.run().then(
      () => assert.fail("the cancelled nested graph published its result"),
      (error: unknown) => error,
    );
    assert.ok(failure instanceof DataflowNodeError && failure.nodeId === nested && failure.cause === cancelled);
    assert.equal(captured?.reason, cancelled);
    assert.equal(child.signal.aborted, false);
    assert.ok(O.isNone(parent.result(nested)));
    const retained = child.result(source);
    assert.ok(O.isSome(retained) && textOf(retained.value) === "child-result");
    await parent.close();
  });
});

describe("round-robin", () => {
  test("advances one id per window in string order and keeps its cursor", async () => {
    const graph = policyGraph("round-robin");
    const agents = new Map(
      ["2", "1", "10"].map((id) => [id, new MockAgent({ prompt: `go ${id}`, runs: [yieldsThen(1, `done ${id}`)] })]),
    );
    for (const [id, agent] of agents) graph.addNode(member(agent, id, id));
    const statuses = () => [...agents].map(([id, agent]) => [id, agent.status, graph.getNode(NodeId(id))!.status]);

    for (let window = 0; window < 4; window++) await graph.step();

    assert.deepEqual(statuses(), [
      ["2", "ready", "running"],
      ["1", "suspended", "running"],
      ["10", "ready", "running"],
    ]);
    assert.equal(graph.scheduler.state, "1");
    assert.deepEqual(
      [...agents.values()].map((agent) => agent.requests.length),
      [0, 1, 0],
    );

    await graph.run();
    for (const id of agents.keys()) assert.equal(resultText(graph, NodeId(id)), `done ${id}`);
    assert.deepEqual(
      [...agents.values()].map((agent) => agent.requests.length),
      [2, 2, 2],
    );
    await graph.close();
  });
});

describe("parallel", () => {
  test("runs every available member in one window and settles them together", async () => {
    const gate = Promise.withResolvers<void>();
    const started: Promise<void>[] = [];
    const agents = [0, 1, 2].map((index) => {
      const entered = Promise.withResolvers<void>();
      started.push(entered.promise);
      const agent = new MockAgent({ prompt: `go ${index}`, runs: [gatedRun(`done ${index}`)] });
      agent.hooks.on("before_drive", async () => {
        entered.resolve();
        await gate.promise;
        return undefined;
      });
      return agent;
    });
    const graph = policyGraph("parallel");
    const ids = agents.map((agent, index) => graph.addNode(member(agent, `member ${index}`)));

    await graph.step();
    assert.deepEqual(
      ids.map((id) => graph.getNode(id)!.status),
      ["running", "running", "running"],
    );
    assert.deepEqual(
      agents.map((agent) => agent.status),
      ["ready", "ready", "ready"],
    );

    const window = graph.step();
    await Promise.all(started);
    assert.ok(ids.every((id) => O.isNone(graph.result(id))));
    gate.resolve();
    await window;
    assert.deepEqual(
      ids.map((id) => resultText(graph, id)),
      ["done 0", "done 1", "done 2"],
    );
    await graph.close();
  });

  test("rejects a plan wider than its finite threads before any member starts", async () => {
    const agents = [0, 1, 2].map((index) => new MockAgent({ prompt: `go ${index}`, runs: [yieldsThen(0, `done ${index}`)] }));
    const graph = policyGraph("parallel", { threads: Width(2) });
    const ids = agents.map((agent, index) => graph.addNode(member(agent, `member ${index}`)));

    await assert.rejects(graph.step(), (error) => error instanceof DataflowDefinitionError);
    assert.deepEqual(
      ids.map((id) => graph.getNode(id)!.status),
      ["ready", "ready", "ready"],
    );
    assert.ok(agents.every((agent) => agent.status === "ready" && agent.requests.length === 0));
    await graph.close();
  });
});
