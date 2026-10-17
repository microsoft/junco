import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  DataflowNodeError,
  DummyTracer,
  Edge,
  EdgeId,
  type ParentView,
  from,
  Message,
  NodeId,
  Sink,
  Source,
  type NodeOptions,
  type NodeGenerator,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgentError } from "junco-agent";
import { parallel, type Decision, type SchedulerContext } from "junco-scheduler";
import { LockPolicy, type Policy } from "junco-tools";
import {
  type Agentic,
  type AgenticInput,
  Deterministic,
  graph as graphApi,
  JuncoGraph,
  MockAgent,
  schedulers,
  type MockHook,
  type MockRun,
} from "../src/index.ts";
import {
  assistant,
  pause,
  policyContext,
  terminalPorts,
  reason,
  requestTexts,
  run,
  STRATEGIES,
  settle,
  textOf,
  userTexts,
  yieldsThen,
} from "./deterministic-support.ts";

// JuncoGraphs of mock members, coroutines and nested graphs on the real round-robin and parallel
// policies. Graphs, schedulers, recursive lifecycle and cancellation are real.

type PolicyGraph = JuncoGraph<AgenticInput, AssistantMessage>;
type PolicyContext = SchedulerContext<Agentic<AgenticInput, AssistantMessage>, AgenticInput, AssistantMessage, schedulers.AgencyNodeMetadata, PolicyGraph>;

const TIMEOUT_MS = 30_000;
const invalidState = (error: unknown) =>
  error instanceof JuncoAgentError && error.code === "invalid_state";
const closedGraph = (error: unknown) =>
  error instanceof JuncoAgentError && error.code === "closed";

/** A scripted `before_drive` hook whose registered handler must return nothing. */
const DRIVE: MockHook = {
  name: "before_drive",
  event: { operation: "run", lane: "main", runId: "run" },
  results: [undefined],
};

/** A run whose first frame waits in its `before_drive` hook, then settles `text`. */
const gatedRun = (text: string, yields = 0): MockRun =>
  run([
    ...Array.from({ length: yields }, (_, index) =>
      pause(
        [reason(`pause ${index + 1}`, `g${index + 1}`)],
        index === 0 ? { hooks: [DRIVE] } : {},
      ),
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

function barrier({
  endOnAbort = false,
}: {
  readonly endOnAbort?: boolean;
} = {}): Barrier {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const state = { finished: false };
  const handler = async (
    _event: unknown,
    context: Context,
  ): Promise<undefined> => {
    started.resolve();
    const signal = context.abortSignal;
    if (signal?.aborted) aborted.resolve();
    else
      signal?.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
    await (endOnAbort
      ? Promise.race([released.promise, aborted.promise])
      : released.promise);
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

const member = (agent: MockAgent, description = "member", id?: string) => ({
  ...(id === undefined ? {} : { id: NodeId.create(id) }),
  state: agent,
  description,
  policy: LockPolicy,
  trigger: TriggerRule.always(),
});

/** A nested-graph node its parent never runs: the test drives `child` itself. */
const detached = (
  child: PolicyContext,
  description = "nested",
) => ({
  description,
  trigger: TriggerRule.always(),
  is_available: () => false,
  state: child,
});

/** The messages currently queued on message edge `edge`. */
const queued = (edge: Edge<AgenticInput, AssistantMessage>): AgenticInput[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

const resultText = (
  graph: Pick<PolicyGraph, "result">,
  id: NodeId,
): string | undefined => {
  const result = graph.result(id);
  return O.isSome(result) ? textOf(result.value) : undefined;
};

/** The stop reason of `id`'s retained result. */
const stopReason = (graph: Pick<PolicyGraph, "result">, id: NodeId) => {
  const result = graph.result(id);
  return O.isSome(result) ? result.value.stopReason : undefined;
};

/** The rejection of `drive`, or `undefined` once it fulfils; observed immediately. */
const outcome = (drive: Promise<unknown>): Promise<unknown> =>
  drive.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Step the graph until `done` holds; a bounded loop, so a regression fails instead of spinning. */
async function stepUntil(
  graph: Pick<PolicyContext, "step">,
  done: () => boolean,
): Promise<void> {
  for (let windows = 0; windows < 64; windows++) {
    if (done()) return;
    await graph.step();
  }
  assert.fail("condition not reached within 64 graph windows");
}

/** Let every queued microtask run; shows only that nothing progressed, never waits for progress. */
const flushMacrotask = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

for (const strategy of STRATEGIES) {
  describe(strategy, () => {
    test("a suspended member stays schedulable with its policy reasons until it settles", async () => {
      const sender = new MockAgent({
        prompt: "send",
        runs: [yieldsThen(1, "sent")],
      });
      const first = [reason("first pause", "y1")];
      const second = [
        reason("bash denied by policy", "p1", "policy"),
        reason("after denial", "y2"),
      ];
      const worker = new MockAgent({
        runs: [
          run([pause(first), pause(second), settle(assistant("worker done"))]),
        ],
      });
      const child = new MockAgent({
        prompt: "child",
        runs: [yieldsThen(0, "child done")],
      });
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const work = Edge.message<AgenticInput, AssistantMessage>(
        "sender->worker",
      );
      const result = Edge.value<AgenticInput, AssistantMessage>(
        "worker->child",
      );
      const s = graph.addNode({
        state: sender,
        description: "sender",
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      worker.stagePrompt("work");
      const w = graph.addNode({
        state: worker,
        description: "worker",
        policy: LockPolicy,
        trigger: TriggerRule.when(work),
      });
      const c = graph.addNode({
        state: child,
        description: "child",
        policy: LockPolicy,
        trigger: TriggerRule.when(result),
      });
      graph.addEdge(s, w, work).addEdge(w, c, result);
      graphPorts.connect(graph, c);
      graph.emit(s, Message.create(work, { kind: "prompt", text: "work" }));

      await stepUntil(graphContext, () => worker.requests.length === 1);
      assert.deepEqual(queued(work), []);
      assert.equal(worker.status, "suspended");
      assert.ok(graph.available().has(w));
      assert.ok(!graph.available().has(c));
      assert.ok(O.isNone(graph.result(w)));

      await stepUntil(graphContext, () => worker.requests.length === 2);
      assert.equal(worker.status, "suspended");
      assert.ok(graph.available().has(w));
      assert.ok(!graph.available().has(c));
      assert.ok(O.isNone(graph.result(w)));

      await graphContext.run();
      assert.equal(resultText(graph, w), "worker done");
      assert.equal(resultText(graph, c), "child done");
      assert.deepEqual(requestTexts(worker.requests), [
        ["work"],
        ["work"],
        ["work"],
      ]);
      await graph.close();
      assert.equal(worker.status, "closed");
    });

    test("an all trigger reads both message edges together or neither", async () => {
      const sender = new MockAgent({
        prompt: "send",
        runs: [yieldsThen(12, "sent")],
      });
      const gatedMember = new MockAgent({
        prompt: "start",
        followUpMode: "all",
        runs: [
          run([
            ...Array.from({ length: 8 }, (_, index) =>
              pause([reason("wait", `m${index}`)], { drain: ["followUp"] }),
            ),
            settle(assistant("member done"), { drain: ["followUp"] }),
          ]),
        ],
      });
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const left = Edge.message<AgenticInput, AssistantMessage>("left");
      const right = Edge.message<AgenticInput, AssistantMessage>("right");
      const s = graph.addNode({
        id: NodeId.create("s"),
        state: sender,
        description: "sender",
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      const m = graph.addNode({
        id: NodeId.create("m"),
        state: gatedMember,
        description: "gated",
        policy: LockPolicy,
        trigger: TriggerRule.allOf(
          TriggerEntry.on(left),
          TriggerEntry.on(right),
        ),
      });
      graph.addEdge(s, m, left).addEdge(s, m, right);
      graphPorts.connect(graph, m);
      const followUp = (text: string): AgenticInput => ({
        kind: "followUp",
        text,
      });
      graph.emit(s, Message.create(left, followUp("x1")));
      await stepUntil(graphContext, () => queued(left).length === 1);
      assert.ok(!graph.available().has(m));
      assert.equal(gatedMember.status, "ready");
      assert.deepEqual(gatedMember.requests, []);

      graph.emit(s, Message.create(right, followUp("y1")));
      await stepUntil(graphContext, () => gatedMember.requests.length === 1);
      assert.deepEqual([queued(left), queued(right)], [[], []]);
      assert.deepEqual(requestTexts(gatedMember.requests), [["start"]]);

      graph.emit(s, Message.create(left, followUp("x2")));
      await stepUntil(graphContext, () => queued(left).length === 1);
      const before = gatedMember.requests.length;
      await stepUntil(graphContext, () => gatedMember.requests.length > before);
      assert.deepEqual([queued(left), queued(right)], [[followUp("x2")], []]);

      graph.emit(s, Message.create(right, followUp("y2")));
      await stepUntil(
        graphContext,
        () => queued(left).length === 0 && queued(right).length === 0,
      );

      await graphContext.run();
      assert.equal(resultText(graph, m), "member done");
      // Delivered messages are retained data for recv, never injected as native follow-ups.
      assert.deepEqual(userTexts(gatedMember.history), ["start"]);
      await graph.close();
    });

    test("a nested graph triggered by one message finishes and hands its selected result on", async () => {
      const source = new MockAgent({
        prompt: "send",
        runs: [yieldsThen(1, "sent")],
      });
      const inner = new MockAgent({
        prompt: "inner",
        runs: [yieldsThen(2, "inner done")],
      });
      const consumer = new MockAgent({ runs: [yieldsThen(0, "reviewed")] });
      const childPorts = terminalPorts();
      const childSource = new Source<AgenticInput, AssistantMessage>((view) => {
        assert.deepEqual([...view.messages.keys()], [go.id]);
        assert.deepEqual(from(view, go), [{ kind: "prompt", text: "go" }]);
        assert.equal([...view.values.keys()].length, 0);
        return [];
      }, { id: NodeId.create("$source") });
      const childContext = policyContext(childSource, childPorts.sink, strategy);
      const child = childContext.graph;
      const innerId = child.addNode(member(inner, "inner"));
      childPorts.connect(child, innerId);
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const go = Edge.message<AgenticInput, AssistantMessage>("source->nested");
      const selected = Edge.value<AgenticInput, AssistantMessage>(
        "nested=>consumer",
      );
      const s = graph.addNode({
        state: source,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      const n = graph.addNode({
        id: NodeId.create("nested"),
        trigger: TriggerRule.when(go),
        state: childContext,
      });
      consumer.stagePrompt("review");
      const c = graph.addNode({
        state: consumer,
        policy: LockPolicy,
        trigger: TriggerRule.when(selected),
      });
      graph.addEdge(s, n, go).addEdge(n, c, selected);
      graphPorts.connect(graph, c);
      graph.emit(s, Message.create(go, { kind: "prompt", text: "go" }));

      await stepUntil(graphContext, () => inner.requests.length === 1);
      // The one trigger message is consumed, yet the started nested graph keeps running.
      assert.deepEqual(queued(go), []);
      assert.ok(graph.available().has(n));
      assert.ok(O.isNone(graph.result(n)));

      await graphContext.run();
      assert.equal(inner.requests.length, 3);
      assert.equal(resultText(child, innerId), "inner done");
      assert.equal(resultText(graph, n), "inner done");
      assert.equal(resultText(graph, c), "reviewed");
      assert.deepEqual(requestTexts(consumer.requests), [["review"]]);
      assert.equal(graph.getNode(n)?.state, child);
      await graph.close();
      assert.ok(
        [source, inner, consumer].every((agent) => agent.status === "closed"),
      );
      assert.ok(child.signal.aborted);
    });

    test("nested graph routes final messages", async () => {
      const inputText = (input: AgenticInput): string =>
        input.kind === "prompt"
          ? input.text
          : assert.fail("expected a prompt input");
      for (const kind of ["all", "any"] as const) {
        const parentPorts = terminalPorts();
        const parentContext = policyContext(parentPorts.source, parentPorts.sink, strategy);
        const parent = parentContext.graph;
        const left = Edge.message<AgenticInput, AssistantMessage>(
          "left->nested",
        );
        const right = Edge.message<AgenticInput, AssistantMessage>(
          "right->nested",
        );
        const toN3 = Edge.message<AgenticInput, AssistantMessage>("nested->n3");
        const toN4 = Edge.message<AgenticInput, AssistantMessage>("nested->n4");
        const prompt = (text: string): AgenticInput => ({
          kind: "prompt",
          text,
        });

        const texts: string[] = [];
        const deliveries: string[][] = [];
        const childSource = new Source<AgenticInput, AssistantMessage>((view) => {
          const batch = [...from(view, left), ...from(view, right)].map(inputText);
          assert.ok(batch.length > 0);
          assert.equal([...view.values.keys()].length, 0);
          deliveries.push(batch);
          texts.push(...batch);
          return [];
        }, { id: NodeId.create("$source") });
        const final = Edge.value<AgenticInput, AssistantMessage>("inner->$sink");
        const childSink: Sink<AgenticInput, AssistantMessage> = new Sink<AgenticInput, AssistantMessage>(async function* (sink): NodeGenerator<AgenticInput, AssistantMessage> {
          yield [];
          const retained = child.result(innerId);
          assert.ok(O.isSome(retained));
          const answer = textOf(retained.value);
          sink.send(Message.create(toN3, prompt(`n3: ${answer}`)));
          sink.send(Message.create(toN4, prompt(`n4: ${answer}`)));
          return retained.value;
        }, { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) });
        const childContext = schedulers.context({ scheduler: parallel(), graph: new JuncoGraph(
          childSource, childSink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy,
        ) });
        const child: PolicyGraph = childContext.graph;
        const innerId = child.addNode({
          id: NodeId.create("inner"),
          trigger: TriggerRule.always(),
          state: new Deterministic<AgenticInput, AssistantMessage>(
            async function* () {
              yield [];
              while (texts.length < 2) yield [];
              return assistant(texts.join("+"));
            },
            LockPolicy,
          ),
        });

        const source = (
          edge: Edge<AgenticInput, AssistantMessage>,
          text: string,
          delay: number,
        ) => ({
          id: NodeId.create(text),
          trigger: TriggerRule.always(),
          state: new Deterministic<AgenticInput, AssistantMessage>(
            async function* () {
              for (let index = 0; index < delay; index++) yield [];
              yield [Message.create(edge, prompt(text))];
              return assistant(`${text} sent`);
            },
            LockPolicy,
          ),
        });
        const observed = { n3: [] as string[][], n4: [] as string[][] };
        const consumer = (
          edge: Edge<AgenticInput, AssistantMessage>,
          name: "n3" | "n4",
        ) => ({
          id: NodeId.create(name),
          trigger: TriggerRule.when(edge),
          state: new Deterministic<AgenticInput, AssistantMessage>(
            async function* () {
              const view = yield [];
              observed[name].push(from(view, edge).map(inputText));
              return assistant(`${name} done`);
            },
            LockPolicy,
          ),
        });

        child.addEdge(innerId, childSink.id, final);
        const l = parent.addNode(source(left, "left", 0));
        const r = parent.addNode(source(right, "right", 1));
        const n: NodeId = parent.addNode({
          id: NodeId.create("nested"),
          trigger:
            kind === "all"
              ? TriggerRule.allOf(TriggerEntry.on(left), TriggerEntry.on(right))
              : TriggerRule.anyOf(
                  TriggerEntry.on(left),
                  TriggerEntry.on(right),
                ),
          state: childContext,

        });
        const n3 = parent.addNode(consumer(toN3, "n3"));
        const n4 = parent.addNode(consumer(toN4, "n4"));
        parentPorts.connect(parent, n4);
        parent
          .addEdge(l, n, left)
          .addEdge(r, n, right)
          .addEdge(n, n3, toN3)
          .addEdge(n, n4, toN4);

        await stepUntil(parentContext, () => queued(left).length === 1);
        assert.deepEqual(queued(right), []);
        if (kind === "all") {
          await stepUntil(parentContext, () => queued(right).length === 1);
          await stepUntil(
            parentContext,
            () => parent.getNode(n)!.status === "running",
          );
          // The conjunction held and the node primed, yet neither queue was read.
          assert.deepEqual(
            [queued(left), queued(right)],
            [[prompt("left")], [prompt("right")]],
          );
          assert.deepEqual(deliveries, []);
          await stepUntil(parentContext, () => deliveries.length === 1);
          assert.deepEqual(deliveries, [["left", "right"]]);
        } else {
          await stepUntil(parentContext, () => deliveries.length === 2);
          assert.deepEqual(deliveries, [["left"], ["right"]]);
        }
        assert.deepEqual([queued(left), queued(right)], [[], []]);

        for (let windows = 0; O.isNone(parent.result(n)); windows++) {
          assert.ok(
            windows < 64,
            "nested node did not complete within 64 graph windows",
          );
          assert.deepEqual(
            [queued(toN3), queued(toN4), observed.n3, observed.n4],
            [[], [], [], []],
          );
          await parentContext.step();
        }
        // The completing activation both emitted and published its result: no extra step.
        assert.equal(resultText(parent, n), "left+right");
        assert.deepEqual(
          [queued(toN3), queued(toN4)],
          [[prompt("n3: left+right")], [prompt("n4: left+right")]],
        );
        assert.deepEqual(observed, { n3: [], n4: [] });

        await parentContext.run();
        assert.deepEqual(observed, {
          n3: [["n3: left+right"]],
          n4: [["n4: left+right"]],
        });
        assert.deepEqual([queued(toN3), queued(toN4)], [[], []]);
        await parentContext.run();
        assert.deepEqual(observed, {
          n3: [["n3: left+right"]],
          n4: [["n4: left+right"]],
        });
        assert.equal(parent.getNode(n)?.state, child);
        await parent.close();
      }
    });

    test("a nested graph quiescent without its sink result fails before its dependent runs", async () => {
      const idle = new MockAgent({ runs: [] });
      const childPorts = terminalPorts();
      const childContext = policyContext(childPorts.source, childPorts.sink, strategy);
      const child = childContext.graph;
      const idleId = child.addNode(member(idle, "idle"));
      childPorts.connect(child, idleId);
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const selected = Edge.value<AgenticInput, AssistantMessage>(
        "nested=>dependent",
      );
      let ran = false;
      const n = graph.addNode({
        trigger: TriggerRule.always(),
        state: childContext,
      });
      const d = graph.addNode({
        trigger: TriggerRule.when(selected),
        state: new Deterministic<AgenticInput, AssistantMessage>(
          async function* () {
            yield [];
            ran = true;
            return assistant("unused");
          },
          LockPolicy,
        ),
      });
      graph.addEdge(n, d, selected);
      graphPorts.connect(graph, d);

      const error = await outcome(graphContext.run());
      assert.ok(
        error instanceof DataflowNodeError && invalidState(error.cause),
      );
      assert.equal(ran, false);
      assert.ok(O.isNone(graph.result(n)) && O.isNone(graph.result(d)));
      assert.deepEqual(idle.requests, []);
      await graph.close();
    });

    test("dormant ports stay quiescent and invalid boundaries reject before registration", async () => {
      const emptyPorts = {
        source: new Source<AgenticInput, AssistantMessage>(() => {
          throw new DataflowDefinitionError("Empty fixture does not accept external input");
        }, { id: NodeId.create("$source") }),
        sink: new Sink<AgenticInput, AssistantMessage>(async function* () {
          throw new Error("Empty fixture has no output work");
        }, { id: NodeId.create("$sink"), trigger: TriggerRule.never() }),
      };
      const emptyContext = policyContext(emptyPorts.source, emptyPorts.sink, strategy);
      const empty = emptyContext.graph;
      assert.equal((await emptyContext.run()).size, 0);
      const parentPorts = {
        source: new Source<AgenticInput, AssistantMessage>(() => {
          throw new DataflowDefinitionError("Boundary rejection fixture does not accept external input");
        }, { id: NodeId.create("$source") }),
        sink: new Sink<AgenticInput, AssistantMessage>(async function* () {
          throw new Error("Boundary rejection fixture has no output work");
        }, { id: NodeId.create("$sink"), trigger: TriggerRule.never() }),
      };
      const parentContext = policyContext(parentPorts.source, parentPorts.sink, strategy);
      const parent = parentContext.graph;
      assert.throws(() => Reflect.apply(parent.addNode, parent, [{ trigger: TriggerRule.always(), state: empty }]), TypeError);
      assert.throws(() => Reflect.construct(JuncoGraph, [emptyPorts.source, parentPorts.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy]), TypeError);
      const ids: NodeId[] = [];
      parent.forEachNode((id) => ids.push(id));
      assert.deepEqual(ids, [parentPorts.source.id, parentPorts.sink.id]);
      await parent.close();
      await empty.close();
    });

    test("one shared availability predicate holds agent, coroutine and graph nodes until released", async () => {
      let admitted = false;
      const shared: NodeOptions<AgenticInput, AssistantMessage> = {
        trigger: TriggerRule.always(),
        is_available: (_view, triggered) => admitted && triggered,
      };
      const agent = new MockAgent({
        prompt: "go",
        runs: [yieldsThen(1, "agent done")],
      });
      const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
        async function* () {
          yield [];
          return assistant("coroutine done");
        },
        LockPolicy,
      );
      const inner = new MockAgent({
        prompt: "inner",
        runs: [yieldsThen(0, "inner done")],
      });
      const childPorts = terminalPorts();
      const childContext = policyContext(childPorts.source, childPorts.sink, strategy);
      const child = childContext.graph;
      const innerId = child.addNode(member(inner, "inner"));
      childPorts.connect(child, innerId);
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const a = graph.addNode({
        ...shared,
        id: NodeId.create("agent"),
        state: agent,
        policy: LockPolicy,
      });
      const d = graph.addNode({
        ...shared,
        id: NodeId.create("coroutine"),
        state: coroutine,
      });
      const n = graph.addNode({
        ...shared,
        id: NodeId.create("nested"),
        state: childContext,
      });

      graphPorts.connect(graph, n);
      assert.equal((await graphContext.run()).size, 0);
      assert.equal(graph.available().size, 0);
      assert.ok([a, d, n].every((id) => O.isNone(graph.result(id))));
      assert.deepEqual([agent.requests, inner.requests], [[], []]);

      admitted = true;
      await graphContext.run();
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
      const grandchild = gated(
        new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }),
        grandchildGate,
      );
      const siblingGate = barrier();
      const sibling = gated(
        new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }),
        siblingGate,
      );
      const childPorts = terminalPorts();
      const childContext = policyContext(childPorts.source, childPorts.sink, strategy);
      const child = childContext.graph;
      const g = child.addNode(member(grandchild, "grandchild"));
      childPorts.connect(child, g);
      const rootPorts = terminalPorts();
      const rootContext = policyContext(rootPorts.source, rootPorts.sink, strategy);
      const root = rootContext.graph;
      root.addNode(detached(childContext, "child graph"));
      const sb = root.addNode(member(sibling, "sibling"));
      rootPorts.connect(root, sb);

      await childContext.step(); // primes the grandchild
      await rootContext.step(); // primes the sibling; the detached child graph is never available
      const [childSignal, rootSignal] = [child.signal, root.signal];
      const childWindow = outcome(childContext.step());
      const rootWindow = outcome(rootContext.step());
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
      for (const agent of [grandchild, sibling])
        assert.equal(agent.status, "closed");
      assert.ok(child.signal.aborted);
    });

    test("failing member aborts never skip a gated sibling, and the graph reports them in order", async () => {
      const first = new Error("first abort failed");
      const nested = new Error("nested abort failed");
      const siblingGate = barrier({ endOnAbort: true });
      const sibling = gated(
        new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }),
        siblingGate,
      );
      const childPorts = terminalPorts();
      const childContext = policyContext(childPorts.source, childPorts.sink, strategy);
      const child = childContext.graph;
      // Idle, so never scheduled: only the abort cascade reaches them.
      const nestedId = child.addNode(
        member(failingAbort(nested), "nested failing"),
      );
      childPorts.connect(child, nestedId);
      const rootPorts = terminalPorts();
      const rootContext = policyContext(rootPorts.source, rootPorts.sink, strategy);
      const root = rootContext.graph;
      root.addNode(member(failingAbort(first), "failing"));
      const sb = root.addNode(member(sibling, "sibling"));
      rootPorts.connect(root, sb);
      root.addNode(detached(childContext));
      await rootContext.step(); // primes the sibling
      const signal = root.signal;
      const window = outcome(rootContext.step());
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

    test("a caller signal aborts the active member and waits for its column to drain", async () => {
      const gate = barrier();
      const worker = gated(
        new MockAgent({ prompt: "go", runs: [gatedRun("resumed", 1)] }),
        gate,
      );
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const id = graph.addNode(member(worker, "worker"));
      graphPorts.connect(graph, id);
      const controller = new AbortController();
      const cancelled = new Error("drive cancelled");
      let settled = false;
      const running = graphContext.run({ signal: controller.signal }).finally(() => {
        settled = true;
      });

      await gate.started;
      controller.abort(cancelled);
      await gate.aborted;
      await flushMacrotask();
      assert.equal(settled, false);
      gate.release();
      await assert.rejects(running, (error) => error === cancelled);
      assert.equal(stopReason(graph, id), "aborted");
      assert.equal(graph.getNode(id)?.status, "done");

      // Caller cancellation is nonterminal.
      assert.equal(graph.signal.aborted, false);
      await graphContext.run();
      await graph.close();
    });

    test("a plain drive observes graph abort, and later work runs under a fresh signal", async () => {
      const gate = barrier({ endOnAbort: true });
      const worker = gated(
        new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }),
        gate,
      );
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const id = graph.addNode(member(worker, "worker"));
      graphPorts.connect(graph, id);
      const signal = graph.signal;
      const running = outcome(graphContext.run());
      await gate.started;

      const cancelled = new Error("graph aborted");
      await graph.abort(cancelled);
      assert.equal(await running, cancelled);
      assert.equal(signal.reason, cancelled);
      assert.equal(stopReason(graph, id), "aborted");
      assert.notEqual(graph.signal, signal);
      assert.equal(graph.signal.aborted, false);

      const fresh = new MockAgent({
        prompt: "again",
        runs: [yieldsThen(0, "fresh")],
      });
      const f = graph.addNode(member(fresh, "fresh"));
      await graphContext.run();
      assert.equal(resultText(graph, f), "fresh");
      await graph.close();
    });

    test("a plain drive observes graph close; results stay readable and new drives reject", async () => {
      const first = new MockAgent({
        prompt: "first",
        runs: [yieldsThen(0, "first")],
      });
      const graphPorts = terminalPorts();
      const graphContext = policyContext(graphPorts.source, graphPorts.sink, strategy);
      const graph = graphContext.graph;
      const f = graph.addNode(member(first, "first"));
      graphPorts.connect(graph, f);
      await graphContext.run();
      const gate = barrier({ endOnAbort: true });
      const worker = gated(
        new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }),
        gate,
      );
      graph.addNode(member(worker, "worker"));
      const signal = graph.signal;
      const running = outcome(graphContext.run());
      await gate.started;

      const closing = graph.close();
      await closing;
      const error = await running;
      assert.equal(error, signal.reason);
      assert.ok([first, worker].every((agent) => agent.status === "closed"));

      assert.equal(graph.close(), closing);
      await graph[Symbol.asyncDispose]();
      assert.equal(resultText(graph, f), "first");
      await assert.rejects(
        graphContext.run(),
        (thrown) => thrown === graph.signal.reason,
      );
      await assert.rejects(
        graphContext.step(),
        (thrown) => thrown === graph.signal.reason,
      );
      await assert.rejects(graph.abort(), closedGraph);
    });

    test("closing a suspended graph closes each member once, without aborting it", async () => {
      const counted = new Counted({ runs: [] });
      const grandchild = new Counted({
        prompt: "go",
        runs: [yieldsThen(1, "unused")],
      });
      const childPorts = terminalPorts();
      const childContext = policyContext(childPorts.source, childPorts.sink, strategy);
      const child = childContext.graph;
      const g = child.addNode(member(grandchild, "grandchild"));
      childPorts.connect(child, g);
      const rootPorts = terminalPorts();
      const rootContext = policyContext(rootPorts.source, rootPorts.sink, strategy);
      const root = rootContext.graph;
      root.addNode(detached(childContext, "child graph"));
      const countedId = root.addNode(member(counted, "counted"));
      rootPorts.connect(root, countedId);
      await childContext.step();
      await childContext.step();
      assert.equal(grandchild.status, "suspended");

      await root.close();
      assert.deepEqual(
        [counted.lifecycle, grandchild.lifecycle],
        [["return"], ["return"]],
      );
      for (const agent of [grandchild, counted])
        assert.equal(agent.status, "closed");
      assert.ok(root.signal.aborted && child.signal.aborted);
      await root.close();
      await root[Symbol.asyncDispose]();
      await child.close();
      assert.deepEqual(
        [counted.lifecycle, grandchild.lifecycle],
        [["return"], ["return"]],
      );
    });

    test("cyclic and shared nested graphs are visited once per cascade", async () => {
      const agents = [0, 1, 2].map(() => new Counted({ runs: [] }));
      const members = agents.map((agent, index) => {
        const ports = terminalPorts();
        const context = policyContext(ports.source, ports.sink, strategy);
        const id = context.graph.addNode(member(agent, `member ${index}`));
        ports.connect(context.graph, id);
        return { context, graph: context.graph };
      });
      const [a, b, shared] = members;
      const graphs = members.map(({ graph }) => graph);
      // a ⇄ b form a cycle, and both nest the same shared graph.
      a!.graph.addNode(detached(b!.context));
      a!.graph.addNode(detached(shared!.context));
      b!.graph.addNode(detached(a!.context));
      b!.graph.addNode(detached(shared!.context));
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
        const bottomPorts = terminalPorts();
        const bottomContext = policyContext(bottomPorts.source, bottomPorts.sink, strategy);
        const bottom = bottomContext.graph;
        let context = bottomContext;
        let graph = bottom;
        let selected = graph.addNode(member(innermost, "innermost"));
        bottomPorts.connect(bottom, selected);
        for (let depth = 0; depth < 4096; depth++) {
          const parentPorts = terminalPorts();
          const parentContext = policyContext(parentPorts.source, parentPorts.sink, strategy);
          const parent = parentContext.graph;
          selected = parent.addNode(
            detached(context, `level ${depth}`),
          );
          parentPorts.connect(parent, selected);
          context = parentContext;
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
      const sibling = gated(
        new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }),
        siblingGate,
      );
      const inner = new Counted({ runs: [] });
      const childPorts = terminalPorts();
      const childContext = policyContext(childPorts.source, childPorts.sink, strategy);
      const child = childContext.graph;
      const ii = child.addNode(member(inner, "inner"));
      childPorts.connect(child, ii);
      const parentPorts = terminalPorts();
      const parentContext = policyContext(parentPorts.source, parentPorts.sink, strategy);
      const parent = parentContext.graph;
      parent.addNode(detached(childContext));
      const sb = parent.addNode(member(sibling, "sibling"));
      parentPorts.connect(parent, sb);
      await parentContext.step(); // primes the sibling
      const parentSignal = parent.signal;
      const window = outcome(parentContext.step());
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
      const fresh = new MockAgent({
        prompt: "again",
        runs: [yieldsThen(0, "fresh")],
      });
      const f = parent.addNode(member(fresh, "fresh"));
      await parentContext.run();
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
      const stubborn = new FailingCloseOnce({
        prompt: "go",
        runs: [yieldsThen(0, "later")],
      });
      const firstPorts = terminalPorts();
      const firstContext = policyContext(firstPorts.source, firstPorts.sink, strategy);
      const first = firstContext.graph;
      const firstId = first.addNode(member(stubborn, "stubborn"));
      firstPorts.connect(first, firstId);
      const error = await outcome(first.close());
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      assert.equal(stubborn.status, "ready");
      // Repeated close and disposal join the same failed close.
      await assert.rejects(first.close(), (thrown) => thrown === error);
      await assert.rejects(
        first[Symbol.asyncDispose](),
        (thrown) => thrown === error,
      );
      assert.equal(attempts, 1);

      const secondPorts = terminalPorts();
      const secondContext = policyContext(secondPorts.source, secondPorts.sink, strategy);
      const second = secondContext.graph;
      const id = second.addNode(member(stubborn, "stubborn"));
      secondPorts.connect(second, id);
      await secondContext.run();
      assert.equal(resultText(second, id), "later");
      await second.close();
      assert.equal(stubborn.status, "closed");
    });
  });
}

describe("nested graphs", () => {
  test("an undefined sink result is a present parent value", async () => {
    type Maybe = AssistantMessage | undefined;
    const childPorts = terminalPorts<AgenticInput, Maybe>();
    const childContext = schedulers.context({ scheduler: parallel(), graph: new JuncoGraph(childPorts.source, childPorts.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy) });
    const child = childContext.graph;
    const empty = child.addNode({ trigger: TriggerRule.always(), state: new Deterministic<AgenticInput, Maybe>(async function* () { return undefined; }, LockPolicy) });
    childPorts.connect(child, empty);
    const parentPorts = terminalPorts<AgenticInput, Maybe>();
    const parentContext = schedulers.context({ scheduler: parallel(), graph: new JuncoGraph(parentPorts.source, parentPorts.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy) });
    const parent = parentContext.graph;
    const selected = Edge.value<AgenticInput, Maybe>("nested=>reader");
    let observed: { readonly delivered: boolean; readonly value: Maybe } | undefined;
    const n = parent.addNode({ trigger: TriggerRule.always(), state: childContext });
    const r = parent.addNode({ trigger: TriggerRule.when(selected), state: new Deterministic<AgenticInput, Maybe>(async function* () {
      const view = yield [];
      observed = { delivered: view.values.has(selected.id), value: view.values.get(selected.id) };
      return assistant("read");
    }, LockPolicy) });
    parent.addEdge(n, r, selected);
    parentPorts.connect(parent, r);
    await parentContext.run();
    assert.deepEqual(child.result(child.sink.id), O.some(undefined));
    assert.deepEqual(parent.result(n), O.some(undefined));
    assert.deepEqual(observed, { delivered: true, value: undefined });
    await parent.close();
  });

  test("cancellation uses the activation's captured child signal after abort resets it", async () => {
    const gate = barrier({ endOnAbort: true });
    const worker = gated(new MockAgent({ prompt: "go", runs: [gatedRun("unused")] }), gate);
    const childPorts = terminalPorts();
    const childContext = policyContext(childPorts.source, childPorts.sink, "parallel");
    const child = childContext.graph;
    const work = child.addNode(member(worker, "gated child"));
    childPorts.connect(child, work);
    const parentPorts = terminalPorts();
    const parentContext = policyContext(parentPorts.source, parentPorts.sink, "parallel");
    const parent = parentContext.graph;
    const nested = parent.addNode({ trigger: TriggerRule.always(), state: childContext });
    parentPorts.connect(parent, nested);
    const captured = child.signal;
    const running = outcome(parentContext.run());
    try {
      await gate.started;
      const cancelled = new Error("child cancelled");
      await child.abort(cancelled);
      const failure = await running;
      assert.ok(failure instanceof DataflowNodeError && failure.nodeId === nested && failure.cause === cancelled);
      assert.equal(captured.reason, cancelled);
      assert.notEqual(child.signal, captured);
      assert.equal(child.signal.aborted, false);
      assert.ok(O.isNone(parent.result(nested)));
      assert.ok(O.isNone(child.result(child.sink.id)));
    } finally { gate.release(); await running; await parent.close(); }
  });
});

describe("round-robin", () => {
  test("advances one id per window in string order and derives progress from history", async () => {
    const graphPorts = terminalPorts();
    const graphContext = policyContext(graphPorts.source, graphPorts.sink, "round-robin");
    const graph = graphContext.graph;
    const agents = new Map(
      ["2", "1", "10"].map((id) => [
        id,
        new MockAgent({
          prompt: `go ${id}`,
          runs: [yieldsThen(1, `done ${id}`)],
        }),
      ]),
    );
    for (const [id, agent] of agents) graph.addNode(member(agent, id, id));
    graphPorts.connect(graph, NodeId.create("2"));
    const statuses = () =>
      [...agents].map(([id, agent]) => [
        id,
        agent.status,
        graph.getNode(NodeId.create(id))!.status,
      ]);

    for (let window = 0; window < 4; window++) await graphContext.step();

    assert.deepEqual(statuses(), [
      ["2", "ready", "running"],
      ["1", "suspended", "running"],
      ["10", "ready", "running"],
    ]);
    assert.deepEqual(
      [...agents.values()].map((agent) => agent.requests.length),
      [0, 1, 0],
    );

    await graphContext.run();
    for (const id of agents.keys())
      assert.equal(resultText(graph, NodeId.create(id)), `done ${id}`);
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
      const agent = new MockAgent({
        prompt: `go ${index}`,
        runs: [gatedRun(`done ${index}`)],
      });
      agent.hooks.on("before_drive", async () => {
        entered.resolve();
        await gate.promise;
        return undefined;
      });
      return agent;
    });
    const graphPorts = terminalPorts();
    const graphContext = policyContext(graphPorts.source, graphPorts.sink, "parallel");
    const graph = graphContext.graph;
    const ids = agents.map((agent, index) =>
      graph.addNode(member(agent, `member ${index}`)),
    );

    graphPorts.connect(graph, ids[2]!);
    await graphContext.step();
    assert.deepEqual(
      ids.map((id) => graph.getNode(id)!.status),
      ["running", "running", "running"],
    );
    assert.deepEqual(
      agents.map((agent) => agent.status),
      ["ready", "ready", "ready"],
    );

    const window = graphContext.step();
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
    const agents = [0, 1, 2].map(
      (index) =>
        new MockAgent({
          prompt: `go ${index}`,
          runs: [yieldsThen(0, `done ${index}`)],
        }),
    );
    const graphPorts = terminalPorts();
    const graphContext = policyContext(graphPorts.source, graphPorts.sink, "parallel", { threads: Width.create(2) });
    const graph = graphContext.graph;
    const ids = agents.map((agent, index) =>
      graph.addNode(member(agent, `member ${index}`)),
    );

    graphPorts.connect(graph, ids[2]!);
    await assert.rejects(
      graphContext.step(),
      (error) => error instanceof DataflowDefinitionError,
    );
    assert.deepEqual(
      ids.map((id) => graph.getNode(id)!.status),
      ["ready", "ready", "ready"],
    );
    assert.ok(
      agents.every(
        (agent) => agent.status === "ready" && agent.requests.length === 0,
      ),
    );
    await graph.close();
  });
});

describe("source and sink boundaries", () => {
  test("queued ingress is detached FIFO work and sink delivery acknowledges only successful prefixes", async () => {
    type Payload = { number: number; tag?: string };
    type Result = { readonly numbers: readonly number[] } | undefined;
    const input = Edge.message<Payload, Result>("external input");
    const empty = Edge.message<Payload, Result>("empty input");
    const presentUndefined = EdgeId.create("present undefined");
    const opaqueKey = EdgeId.create("opaque value");
    const work = Edge.message<Payload, Result>("$source->worker");
    const final = Edge.value<Payload, Result>("worker->$sink");
    const external = Edge.message<Payload, Result>("external output");
    const seven: Payload = { number: 7 };
    const eight: Payload = { number: 8 };
    const nine: Payload = { number: 9 };
    const opaque: Result = { numbers: [99] };
    const answer: Result = { numbers: [7, 8, 9] };
    const routed: ParentView<Payload, Result>[] = [];
    const source = new Source<Payload, Result>((view) => {
      routed.push(view);
      return (view.messages.get(input.id) ?? []).map((payload) => Message.create(work, payload));
    }, { id: NodeId.create("$source") });
    const sink: Sink<Payload, Result> = new Sink<Payload, Result>(async function* (sink): NodeGenerator<Payload, Result> {
      yield [];
      yield [Message.create(external, seven)];
      const result = graph.result(worker);
      assert.ok(O.isSome(result));
      sink.send(Message.create(external, eight));
      sink.send(Message.create(external, nine));
      return result.value;
    }, { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) });
    const graph: JuncoGraph<Payload, Result> = new JuncoGraph(source, sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
    const histories: (readonly Decision[])[] = [];
    const execution = schedulers.context({ graph, scheduler: (snapshot) => {
      histories.push(snapshot.history);
      return parallel()(snapshot);
    } });
    const received: number[] = [];
    const worker = graph.addNode({ id: NodeId.create("worker"), trigger: TriggerRule.when(work),
      state: new Deterministic<Payload, Result>(async function* () {
        let view = yield [];
        while (true) {
          received.push(...from(view, work).map((payload) => payload.number));
          if (received.length === 3) return answer;
          view = yield [];
        }
      }, LockPolicy),
    });
    graph.addEdge(source.id, worker, work).addEdge(worker, sink.id, final);
    try {
      const before = graph.observe();
      source.enqueue({ messages: new Map([[empty.id, []]]), values: new Map() });
      assert.equal(source.revision, 0);
      assert.equal(source.peek(), undefined);
      assert.equal(graph.observe(), before);
      assert.equal(graph.available().size, 0);
      const originalBatch = [seven, eight];
      const messages = new Map([[input.id, originalBatch], [empty.id, [] as Payload[]]]);
      const values = new Map<EdgeId, Result>([[presentUndefined, undefined], [opaqueKey, opaque]]);
      source.enqueue({ messages, values });
      source.enqueue({ messages: new Map([[input.id, [nine]]]), values: new Map() });
      originalBatch.splice(0, originalBatch.length, nine);
      messages.delete(empty.id);
      values.clear();
      const peeked = source.peek();
      assert.ok(peeked);
      assert.deepEqual(peeked.messages.get(input.id), [seven, eight]);
      assert.equal(peeked.messages.has(empty.id), true);
      assert.deepEqual(peeked.messages.get(empty.id), []);
      assert.equal(peeked.values.has(presentUndefined), true);
      assert.equal(peeked.values.get(presentUndefined), undefined);
      assert.equal(peeked.values.get(opaqueKey), opaque);
      assert.equal(peeked.messages.get(input.id)?.[0], seven);
      assert.ok(Object.isFrozen(peeked));
      assert.ok(Object.isFrozen(peeked.messages.get(input.id)));
      const admitted = graph.observe();
      assert.ok(admitted.version > before.version);
      assert.equal(source.peek(), peeked);
      assert.equal(graph.observe(), admitted);
      await execution.step();
      assert.equal(routed.length, 1);
      assert.equal(routed[0], peeked);
      assert.equal(source.revision, 3);
      assert.ok(graph.observe().version > admitted.version);
      assert.deepEqual(source.peek()?.messages.get(input.id), [nine]);
      const results = await execution.run();
      assert.deepEqual(routed.map((view) => (view.messages.get(input.id) ?? []).map((payload) => payload.number)), [[7, 8], [9]]);
      assert.deepEqual(received, [7, 8, 9]);
      assert.equal(results.get(sink.id), answer);
      assert.equal(results.get(worker), answer);
      assert.equal(source.revision, 4);
      assert.equal(graph.available().size, 0);
      assert.equal(source.peek(), undefined);
      assert.equal(graph.getNode(source.id)?.state, source);
      assert.equal(graph.getNode(sink.id)?.state, sink);
      assert.deepEqual([...graph.observe().nodes.keys()], [source.id, sink.id, worker]);
      assert.ok(histories.some((history) => history.some((decision) => decision.selected.includes(source.id))));
      assert.ok(histories.some((history) => history.some((decision) => decision.selected.includes(sink.id))));
      const deliveryFailure = new Error("delivery failed");
      const delivered: Payload[] = [];
      assert.throws(() => sink.drain((message) => {
        assert.equal(message.id, external.id);
        if (message.payload === eight) throw deliveryFailure;
        delivered.push(message.payload);
      }), (error) => error === deliveryFailure);
      assert.deepEqual(delivered, [seven]);
      sink.drain((message) => delivered.push(message.payload));
      sink.drain(() => assert.fail("empty drains deliver nothing"));
      assert.deepEqual(delivered, [seven, eight, nine]);
    } finally { await graph.close(); }
  });

  test("source admission invalidates a pending policy but reads and empty ingress do not", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const edge = Edge.message<AgenticInput, AssistantMessage>("external");
    let admitted = 0;
    let activated = 0;
    const ports = terminalPorts();
    const source = new Source<AgenticInput, AssistantMessage>((view) => {
      assert.deepEqual(from(view, edge), [{ kind: "prompt", text: "go" }]);
      admitted++;
      return [];
    }, { id: NodeId.create("$source") });
    const graph = new JuncoGraph(source, ports.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
    let waiting = true;
    const execution = schedulers.context({ graph, scheduler: async (snapshot) => {
      if (waiting) { started.resolve(); await gate.promise; }
      return parallel()(snapshot);
    } });
    const work = graph.addNode({ trigger: TriggerRule.always(), state: new Deterministic<AgenticInput, AssistantMessage>(async function* () {
      activated++;
      return assistant("done");
    }, LockPolicy) });
    ports.connect(graph, work);
    const version = graph.observe().version;
    const running = outcome(execution.step());
    try {
      await started.promise;
      source.peek();
      source.enqueue({ messages: new Map(), values: new Map() });
      assert.equal(graph.observe().version, version);
      source.enqueue({ messages: new Map([[edge.id, [{ kind: "prompt", text: "go" }]]]), values: new Map() });
      assert.ok(graph.observe().version > version);
      gate.resolve();
      assert.ok(await running instanceof DataflowDefinitionError);
      assert.equal(admitted, 0);
      assert.equal(activated, 0);
      waiting = false;
      const results = await execution.run();
      assert.equal(admitted, 1);
      assert.equal(activated, 1);
      assert.equal(results.get(ports.sink.id), results.get(work));
    } finally { gate.resolve(); await running; await graph.close(); }
  });

  test("constructor port identities and prohibited wiring reject before effects", async () => {
    const ports = terminalPorts<number, string>();
    const graph = new JuncoGraph(ports.source, ports.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
    const graphWork = graph.addNode({ trigger: TriggerRule.always(), state: new Deterministic<number, string>(async function* () { return "boundary work"; }, LockPolicy) });
    ports.connect(graph, graphWork);
    const extra = terminalPorts<number, string>();
    const args = [Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy];
    assert.throws(() => Reflect.construct(JuncoGraph, [{}, extra.sink, ...args]), TypeError);
    assert.throws(() => Reflect.construct(JuncoGraph, [extra.source, {}, ...args]), TypeError);
    assert.throws(() => Reflect.construct(JuncoGraph, [ports.source, extra.sink, ...args]), TypeError);
    assert.throws(() => Reflect.construct(JuncoGraph, [extra.source, ports.sink, ...args]), TypeError);
    const invalid = Reflect.construct(Source, [() => [], { id: 42 }]);
    assert.throws(() => Reflect.construct(JuncoGraph, [invalid, extra.sink, ...args]), TypeError);
    const duplicateSource = new Source<number, string>(() => { throw new DataflowDefinitionError("closed"); }, { id: NodeId.create("") });
    const duplicateSink = new Sink<number, string>(async function* () { return "unused"; }, { id: NodeId.create(""), trigger: TriggerRule.never() });
    assert.throws(() => new JuncoGraph(duplicateSource, duplicateSink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy), DataflowDefinitionError);
    const validSink: Sink<number, string> = new Sink<number, string>(async function* (): NodeGenerator<number, string> { yield []; const retained = valid.result(work); assert.ok(O.isSome(retained)); return retained.value; }, { id: NodeId.create("$sink"), trigger: TriggerRule.when(Edge.value<number, string>("work->$sink")) });
    const valid: JuncoGraph<number, string> = new JuncoGraph(duplicateSource, validSink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
    const work = valid.addNode({ trigger: TriggerRule.always(), state: new Deterministic<number, string>(async function* () { return "done"; }, LockPolicy) });
    valid.addEdge(work, validSink.id, Edge.value<number, string>("work->$sink"));
    const execution = schedulers.context({ graph: valid, scheduler: parallel() });
    try {
      const before = graph.observe();
      assert.throws(() => graph.addEdge(graphWork, ports.source.id, Edge.message<number, string>("inbound")), DataflowDefinitionError);
      assert.throws(() => graph.addEdge(ports.source.id, graphWork, Edge.value<number, string>("unresolved")), DataflowDefinitionError);
      assert.throws(() => graph.addEdge(ports.sink.id, graphWork, Edge.message<number, string>("outbound")), DataflowDefinitionError);
      assert.equal(graph.observe(), before);
      assert.deepEqual(before.links, [[graphWork, ports.sink.id, "terminal->$sink", "value"]]);
      assert.equal((await execution.run()).get(validSink.id), "done");
      assert.equal(valid.source.id, "");
    } finally { await graph.close(); await valid.close(); }
  });
});

describe("nested sink publication", () => {
  test("a precompleted child publishes its retained sink result and outbox once without a child decision", async () => {
    const output = Edge.message<AgenticInput, AssistantMessage>("nested->reader");
    const final = Edge.value<AgenticInput, AssistantMessage>("worker->$sink");
    const answer = assistant("already complete");
    const rejectedIngress = new Error("Completed child does not accept external input");
    let decisions = 0;
    const source = new Source<AgenticInput, AssistantMessage>(() => {
      throw rejectedIngress;
    }, { id: NodeId.create("$source") });
    const sink: Sink<AgenticInput, AssistantMessage> = new Sink<AgenticInput, AssistantMessage>(async function* (sink): NodeGenerator<AgenticInput, AssistantMessage> {
      yield [];
      const retained = child.result(work);
      assert.ok(O.isSome(retained));
      sink.send(Message.create(output, { kind: "prompt", text: "final message" }));
      return retained.value;
    }, { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) });
    const child: PolicyGraph = new JuncoGraph(source, sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
    const childContext = schedulers.context({ graph: child, scheduler: (snapshot) => {
      decisions++;
      return parallel()(snapshot);
    } });
    const work = child.addNode({ trigger: TriggerRule.always(), state: new Deterministic<AgenticInput, AssistantMessage>(async function* () { return answer; }, LockPolicy) });
    child.addEdge(work, sink.id, final);
    await childContext.run();
    const completedDecisions = decisions;
    const ports = terminalPorts();
    const parentContext = policyContext(ports.source, ports.sink, "parallel");
    const parent = parentContext.graph;
    const nested = parent.addNode({ trigger: TriggerRule.always(), state: childContext });
    const observed: AgenticInput[] = [];
    const reader = parent.addNode({ trigger: TriggerRule.when(output), state: new Deterministic<AgenticInput, AssistantMessage>(async function* () {
      const view = yield [];
      observed.push(...from(view, output));
      return assistant("read");
    }, LockPolicy) });
    parent.addEdge(nested, reader, output);
    ports.connect(parent, nested);
    const secondPorts = terminalPorts();
    const ingress = Edge.message<AgenticInput, AssistantMessage>("new external input");
    const delivery = Edge.message<AgenticInput, AssistantMessage>("$source->nested");
    const secondSource = new Source<AgenticInput, AssistantMessage>((view) => {
      assert.deepEqual([...view.messages.keys()], [ingress.id]);
      assert.equal([...view.values.keys()].length, 0);
      return from(view, ingress).map((payload) => Message.create(delivery, payload));
    }, { id: NodeId.create("$source") });
    const secondContext = policyContext(secondSource, secondPorts.sink, "parallel");
    const second = secondContext.graph;
    try {
      const results = await parentContext.run();
      assert.equal(results.get(nested), answer);
      assert.equal(results.get(ports.sink.id), answer);
      assert.equal(child.results().get(sink.id), answer);
      assert.equal(parent.getNode(nested)?.state, child);
      assert.equal(decisions, completedDecisions);
      assert.equal(source.revision, 0);
      assert.deepEqual(observed, [{ kind: "prompt", text: "final message" }]);
      await parentContext.run();
      assert.equal(decisions, completedDecisions);
      assert.equal(observed.length, 1);
      const freshNested = second.addNode({ trigger: TriggerRule.when(delivery), state: childContext });
      second.addEdge(secondSource.id, freshNested, delivery);
      secondPorts.connect(second, freshNested);
      secondSource.enqueue({ messages: new Map([[ingress.id, [{ kind: "prompt", text: "unexpected" }]]]), values: new Map() });
      const failure = await outcome(secondContext.run());
      assert.ok(failure instanceof DataflowNodeError && failure.nodeId === freshNested);
      assert.ok(failure.cause instanceof DataflowNodeError && failure.cause.nodeId === source.id);
      assert.equal(failure.cause.cause, rejectedIngress);
      assert.ok(decisions > completedDecisions);
      assert.ok(O.isNone(second.result(freshNested)));
      sink.drain(() => assert.fail("already delivered output must not replay"));
    } finally { await parent.close(); await second.close(); }
  });

  for (const mode of ["failure", "abort"] as const) {
    test(`a child ${mode} retains staged output without publishing it to its parent`, async () => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failure = new Error(`child ${mode}`);
      const output = Edge.message<AgenticInput, AssistantMessage>("nested->reader");
      const final = Edge.value<AgenticInput, AssistantMessage>("worker->$sink");
      const source = new Source<AgenticInput, AssistantMessage>(() => {
        throw new DataflowDefinitionError("Child does not accept external input");
      }, { id: NodeId.create("$source") });
      const message: AgenticInput = { kind: "prompt", text: "staged, not published" };
      const sink: Sink<AgenticInput, AssistantMessage> = new Sink<AgenticInput, AssistantMessage>(async function* (sink): NodeGenerator<AgenticInput, AssistantMessage> {
        yield [];
        sink.send(Message.create(output, message));
        started.resolve();
        if (mode === "failure") throw failure;
        await release.promise;
        const retained = child.result(work);
        assert.ok(O.isSome(retained));
        return retained.value;
      }, { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) });
      const child: PolicyGraph = new JuncoGraph(source, sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
      const childContext = schedulers.context({ graph: child, scheduler: parallel() });
      const work = child.addNode({ trigger: TriggerRule.always(), state: new Deterministic<AgenticInput, AssistantMessage>(async function* () { return assistant("work done"); }, LockPolicy) });
      child.addEdge(work, sink.id, final);
      const ports = terminalPorts();
      const parentContext = policyContext(ports.source, ports.sink, "parallel");
      const parent = parentContext.graph;
      const nested = parent.addNode({ trigger: TriggerRule.always(), state: childContext });
      let consumed = false;
      const reader = parent.addNode({ trigger: TriggerRule.when(output), state: new Deterministic<AgenticInput, AssistantMessage>(async function* () {
        yield [];
        consumed = true;
        return assistant("unused");
      }, LockPolicy) });
      parent.addEdge(nested, reader, output);
      ports.connect(parent, reader);
      const running = outcome(parentContext.run());
      try {
        await started.promise;
        if (mode === "abort") {
          const aborting = child.abort(failure);
          release.resolve();
          await aborting;
        }
        const error = await running;
        assert.ok(error instanceof DataflowNodeError && error.nodeId === nested);
        assert.equal(consumed, false);
        assert.deepEqual(queued(output), []);
        assert.ok(O.isNone(parent.result(nested)));
        const retained: AgenticInput[] = [];
        sink.drain((outgoing) => retained.push(outgoing.payload));
        assert.deepEqual(retained, [message]);
      } finally { release.resolve(); await running; await parent.close(); }
    });
  }
});
