import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DataflowNodeError,
  DummyTracer,
  Edge,
  Message,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgentError, type TaskSchema } from "junco-agent";
import {
  EmptyPolicy,
  LockPolicy,
  type Policy,
  type ToolCollection,
} from "junco-tools";
import { type TNumber, type TSchema, type TString, Type } from "typebox";
import {
  Deterministic,
  graph as graphApi,
  JuncoGraph,
  MockAgent,
  schedules,
} from "../src/index.ts";

import { terminalPorts } from "./deterministic-support.ts";

const quiet = new DummyTracer();

// Deterministic coroutines inside real JuncoGraphs on the real parallel policy: cooperative abort,
// draining close and the single-consumer guard, observed through graph drives, edges and results.

/** Settles once `signal` aborts, rejecting with its reason. */
function untilAborted(signal: AbortSignal): Promise<void> {
  const { promise, reject } = Promise.withResolvers<void>();
  if (signal.aborted) reject(signal.reason);
  else
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  return promise;
}

/** Let every queued microtask run; shows only that nothing progressed, never waits for progress. */
function flushMacrotask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** Whether `promise` has settled yet, observed without consuming its outcome. */
function settlement(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  promise.then(settle, settle);
  return state;
}

/** The error a drive rejected with; fails the test if it resolved. */
const failureOf = (drive: Promise<unknown>): Promise<unknown> =>
  drive.then(
    () => assert.fail("the drive resolved"),
    (error: unknown) => error,
  );

/** A drive cancelled with `reason`: the reason itself, or the node error it caused. */
const cancelledBy = (error: unknown, reason: unknown): boolean =>
  error === reason ||
  (error instanceof DataflowNodeError && error.cause === reason);

const unresolved = <N extends TSchema, T>(edge: Edge<N, T>): boolean =>
  E.isRight(edge.transport) && O.isNone(edge.transport.right);

/** A coroutine consumer recording whether the engine ever primed it. */
function consumer<T>(result: T) {
  const state = { ran: false };
  const coroutine = new Deterministic<TString, T>(async function* () {
    state.ran = true;
    yield [];
    return result;
  }, LockPolicy);
  return {
    coroutine,
    get ran() {
      return state.ran;
    },
  };
}

describe("abort", () => {
  test("joins a gated finally, cleans up once and starts no downstream work", async () => {
    const graphPorts = terminalPorts(Type.String(), Type.String());
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const result = Edge.value("waiting-result", Type.String());
    const entered = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cleaned = 0;
    const waiting = new Deterministic<TString, string>(async function* (
      signal,
    ) {
      yield [];
      entered.resolve();
      try {
        await untilAborted(signal);
      } finally {
        cleanupStarted.resolve();
        await release.promise;
        cleaned++;
      }
      return "never";
    }, LockPolicy);
    const downstream = consumer("downstream");
    const waitingId = graph.addNode({
      trigger: TriggerRule.always(),
      state: waiting,
    });
    const downstreamId = graph.addNode({
      trigger: TriggerRule.when(result),
      state: downstream.coroutine,
    });
    graph.addEdge(waitingId, downstreamId, result);
    graphPorts.connect(graph, downstreamId);
    const drive = failureOf(graphContext.run());
    await entered.promise;
    const reason = new Error("consumer cancellation");
    const aborting = graph.abort(reason);
    const abortState = settlement(aborting);
    await cleanupStarted.promise;
    await flushMacrotask();
    assert.equal(abortState.settled, false);
    assert.equal(cleaned, 0);

    release.resolve();
    await aborting;
    assert.equal(cleaned, 1);
    assert.ok(cancelledBy(await drive, reason));
    assert.equal(waiting.signal.reason, reason);

    // A fresh signal: a plain drive runs, yet nothing downstream of the cancelled coroutine starts.
    assert.equal(graph.signal.aborted, false);
    assert.equal((await graphContext.run()).has(downstreamId), false);
    assert.equal(downstream.ran, false);
    assert.ok(unresolved(result));
    assert.ok(O.isNone(graph.result(waitingId)));

    await graph.close();
    assert.equal(cleaned, 1);
  });

  test("preserves an unrelated cleanup error, which a later close does not report again", async () => {
    const graphPorts = terminalPorts(Type.String(), Type.String());
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const entered = Promise.withResolvers<void>();
    const unrelated = new Error("cleanup failed");
    const failing = new Deterministic<TString, string>(async function* (
      signal,
    ) {
      yield [];
      entered.resolve();
      try {
        await untilAborted(signal);
      } catch {
        throw unrelated;
      }
      return "never";
    }, LockPolicy);
    const id = graph.addNode({
      trigger: TriggerRule.always(),
      state: failing,
    });

    graphPorts.connect(graph, id);
    const drive = failureOf(graphContext.run());
    await entered.promise;
    const aborted = await failureOf(graph.abort(new Error("stop")));
    assert.ok(aborted instanceof AggregateError);
    assert.deepEqual(aborted.errors, [unrelated]);
    const failure = await drive;
    assert.ok(
      failure instanceof DataflowNodeError &&
        failure.nodeId === id &&
        failure.cause === unrelated,
    );

    await graph.close();
    await failing.close();
  });

  test("a run failure already delivered to its drive is not reported again by close", async () => {
    const graphPorts = terminalPorts(Type.String(), Type.String());
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const broken = new Error("body failed");
    let cleaned = 0;
    const failing = new Deterministic<TString, string>(async function* () {
      try {
        yield [];
        throw broken;
      } finally {
        cleaned++;
      }
    }, LockPolicy);
    const id = graph.addNode({
      trigger: TriggerRule.always(),
      state: failing,
    });

    graphPorts.connect(graph, id);
    const failure = await failureOf(graphContext.run());
    assert.ok(
      failure instanceof DataflowNodeError &&
        failure.nodeId === id &&
        failure.cause === broken,
    );
    // Failed, not closed: a further direct advance is refused instead of reporting a fresh result.
    await assert.rejects(
      failing.next(),
      (error) =>
        error instanceof JuncoAgentError && error.code === "invalid_state",
    );
    await graph.close();
    assert.equal(cleaned, 1);
  });
});

test("caller cancellation interrupts nested work and joins its cleanup", async () => {
  const parentPorts = terminalPorts(Type.String(), Type.String());
  const parent = new JuncoGraph(
    parentPorts.source,
    parentPorts.sink,
    Width.create(1),
    UNBOUNDED,
    quiet,
    LockPolicy,
  );
  const parentContext = schedules.context({
    graph: parent,
    scheduler: schedules.parallel(),
  });
  const childPorts = terminalPorts(Type.String(), Type.String());
  const child = new JuncoGraph(
    childPorts.source,
    childPorts.sink,
    Width.create(1),
    UNBOUNDED,
    quiet,
    LockPolicy,
  );
  const childContext = schedules.context({
    graph: child,
    scheduler: schedules.parallel(),
  });
  const caller = new AbortController();
  const reason = new Error("caller stopped");
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleaned = false;
  const worker = new Deterministic<TString, string>(async function* (signal) {
    yield [];
    entered.resolve();
    try {
      await untilAborted(signal);
    } finally {
      cleaning.resolve();
      await release.promise;
      cleaned = true;
    }
    return "never";
  }, LockPolicy);
  const result = child.addNode({
    state: worker,
    trigger: TriggerRule.always(),
  });
  childPorts.connect(child, result);
  const nested = parent.addNode({
    state: childContext,
    trigger: TriggerRule.always(),
  });
  parentPorts.connect(parent, nested);
  const drive = failureOf(parentContext.run({ signal: caller.signal }));
  const state = settlement(drive);
  try {
    await entered.promise;
    caller.abort(reason);
    await flushMacrotask();
    assert.equal(
      worker.signal.aborted,
      true,
      "running child received cancellation",
    );
    await cleaning.promise;
    assert.equal(state.settled, false, "drive waits for cleanup");
    release.resolve();
    assert.ok(cancelledBy(await drive, reason));
    assert.equal(cleaned, true);
    assert.ok(O.isNone(child.result(result)));
    assert.equal(
      parent.signal.aborted,
      false,
      "abort leaves graph nonterminal",
    );
  } finally {
    release.resolve();
    await parent.close();
    await drive;
  }
});

describe("close", () => {
  test("drains suspended and waiting coroutines without routing cleanup output or publishing results", async () => {
    const graphPorts = terminalPorts(Type.String(), Type.String());
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const input = Edge.message<TString, string>("input", Type.String());
    const suspendedCleanup = Edge.message<TString, string>(
      "suspended-cleanup",
      Type.String(),
    );
    const waitingCleanup = Edge.message<TString, string>(
      "waiting-cleanup",
      Type.String(),
    );
    const suspendedReady = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleaned = { suspended: 0, waiting: 0 };
    const suspended = new Deterministic<TString, string>(async function* () {
      yield [];
      try {
        suspendedReady.resolve();
        yield [];
      } finally {
        yield [Message.create(suspendedCleanup, "suspended cleanup")];
        cleaned.suspended++;
      }
      return "suspended result";
    }, LockPolicy);
    const waiting = new Deterministic<TString, string>(async function* (
      signal,
    ) {
      yield [];
      entered.resolve();
      try {
        await untilAborted(signal);
      } finally {
        cleanupStarted.resolve();
        await release.promise;
        cleaned.waiting++;
        yield [Message.create(waitingCleanup, "waiting cleanup")];
      }
      return "waiting result";
    }, LockPolicy);
    const downstream = consumer("downstream");
    const suspendedId = graph.addNode({
      trigger: TriggerRule.when(input),
      state: suspended,
    });
    const waitingId = graph.addNode({
      trigger: TriggerRule.always(),
      state: waiting,
    });
    const downstreamId = graph.addNode({
      trigger: TriggerRule.anyOf(
        TriggerEntry.on(suspendedCleanup),
        TriggerEntry.on(waitingCleanup),
      ),
      state: downstream.coroutine,
    });
    // The trigger edge must be inbound; the coroutine never emits on it.
    graph.addEdge(suspendedId, suspendedId, input);
    graph.addEdge(suspendedId, downstreamId, suspendedCleanup);
    graph.addEdge(waitingId, downstreamId, waitingCleanup);
    graphPorts.connect(graph, downstreamId);
    assert.ok(E.isLeft(input.transport));
    input.transport.left.push("go");

    const drive = failureOf(graphContext.run());
    await Promise.all([suspendedReady.promise, entered.promise]);
    await flushMacrotask();

    const closing = graph.close();
    const closeState = settlement(closing);
    assert.equal(graph.close(), closing);
    assert.equal(graph[Symbol.asyncDispose](), closing);
    await cleanupStarted.promise;
    await flushMacrotask();
    assert.equal(closeState.settled, false);

    release.resolve();
    await closing;
    assert.deepEqual(cleaned, { suspended: 1, waiting: 1 });
    // The waiting advance ended in cleanup output: its drive sees the coroutine's cancellation.
    assert.ok(cancelledBy(await drive, waiting.signal.reason));

    assert.deepEqual(suspendedCleanup.transport, E.left([]));
    assert.deepEqual(waitingCleanup.transport, E.left([]));
    assert.equal(downstream.ran, false);
    assert.ok(O.isNone(graph.result(suspendedId)));
    assert.ok(O.isNone(graph.result(waitingId)));
    assert.ok(O.isNone(graph.result(downstreamId)));

    await graph[Symbol.asyncDispose]();
    await waiting.close();
    assert.deepEqual(cleaned, { suspended: 1, waiting: 1 });
    await assert.rejects(
      waiting.next(),
      (error) => error instanceof JuncoAgentError && error.code === "closed",
    );
    await assert.rejects(
      graphContext.run(),
      (error) => error === graph.signal.reason,
    );
  });

  test("a finally error rejects close without preventing a sibling agent's close", async () => {
    const graphPorts = terminalPorts();
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const failure = new Error("finally failed");
    const coroutine = new Deterministic<typeof TaskSchema, AssistantMessage>(
      async function* () {
        try {
          yield [];
        } finally {
          // biome-ignore lint/correctness/noUnsafeFinally: the case under test is a throwing finally block.
          throw failure;
        }
      },
      LockPolicy,
    );
    const sibling = new MockAgent({ runs: [] });
    const coroutineId = graph.addNode({
      trigger: TriggerRule.always(),
      state: coroutine,
    });
    graph.addNode({
      state: sibling,
      policy: LockPolicy,
      trigger: TriggerRule.always(),
      is_available: () => false,
    });
    graphPorts.connect(graph, coroutineId);
    await graphContext.step();

    const closing = graph.close();
    const closed = await failureOf(closing);
    assert.ok(closed instanceof AggregateError);
    assert.deepEqual(closed.errors, [failure]);
    assert.equal(sibling.status, "closed");
    assert.equal(
      sibling.calls.some((call) => call.method === "abort"),
      false,
    );

    assert.equal(graph.close(), closing);
    await assert.rejects(
      graph[Symbol.asyncDispose](),
      (error) => error === closed,
    );
  });

  test("close during a pending abort keeps the abort reason as cancellation, not failure", async () => {
    const graphPorts = terminalPorts(Type.String(), Type.String());
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const entered = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cleaned = 0;
    const waiting = new Deterministic<TString, string>(async function* (
      signal,
    ) {
      yield [];
      entered.resolve();
      try {
        await untilAborted(signal);
      } finally {
        cleanupStarted.resolve();
        await release.promise;
        cleaned++;
      }
      return "never";
    }, LockPolicy);
    const id = graph.addNode({
      trigger: TriggerRule.always(),
      state: waiting,
    });

    graphPorts.connect(graph, id);
    const drive = failureOf(graphContext.run());
    await entered.promise;
    const reason = new Error("abort first");
    const aborting = graph.abort(reason);
    await cleanupStarted.promise;
    const closing = graph.close();
    const closeState = settlement(closing);
    await flushMacrotask();
    assert.equal(closeState.settled, false);

    release.resolve();
    await Promise.all([aborting, closing]);
    assert.equal(cleaned, 1);
    assert.equal(waiting.signal.reason, reason);
    assert.ok(cancelledBy(await drive, reason));
    assert.ok(O.isNone(graph.result(id)));

    // The settled abort leaves the graph terminal under its close reason.
    assert.ok(graph.signal.aborted);
    assert.notEqual(graph.signal.reason, reason);
    await assert.rejects(
      graphContext.run(),
      (error) => error === graph.signal.reason,
    );
    await assert.rejects(
      graph.abort(),
      (error) => error instanceof JuncoAgentError && error.code === "closed",
    );
  });

  test("graph close joins a shared coroutine's async disposal hook", async () => {
    const external = Promise.withResolvers<void>();
    const counts = { disposals: 0, cleanup: 0, external: 0 };
    class Owned extends Deterministic<TString, string> {
      override async [Symbol.asyncDispose](): Promise<void> {
        counts.disposals++;
        await super[Symbol.asyncDispose]();
        await external.promise;
        counts.external++;
      }
    }
    const coroutine = new Owned(async function* () {
      try {
        yield [];
      } finally {
        counts.cleanup++;
      }
      return "never published";
    }, LockPolicy);
    const childPorts = terminalPorts(Type.String(), Type.String());
    const child = new JuncoGraph(
      childPorts.source,
      childPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const childContext = schedules.context({
      graph: child,
      scheduler: schedules.parallel(),
    });
    const result = child.addNode({
      trigger: TriggerRule.always(),
      state: coroutine,
    });
    const parentPorts = terminalPorts(Type.String(), Type.String());
    const parent = new JuncoGraph(
      parentPorts.source,
      parentPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    parent.addNode({
      trigger: TriggerRule.always(),
      is_available: () => false,
      state: coroutine,
    });
    const nested = parent.addNode({
      trigger: TriggerRule.always(),
      is_available: () => false,
      state: childContext,
    });
    parentPorts.connect(parent, nested);
    childPorts.connect(child, result);
    await childContext.step();

    try {
      const closing = parent.close();
      // The subtype's hook starts synchronously, once, despite two registrations.
      assert.equal(counts.disposals, 1);
      const closeState = settlement(closing);
      await flushMacrotask();
      assert.equal(counts.cleanup, 1);
      assert.equal(closeState.settled, false);

      external.resolve();
      await closing;
      assert.deepEqual(counts, { disposals: 1, cleanup: 1, external: 1 });
      assert.ok(O.isNone(child.result(result)));
      assert.ok(parent.signal.aborted && child.signal.aborted);

      await Promise.all([
        parent.close(),
        parent[Symbol.asyncDispose](),
        child.close(),
        child[Symbol.asyncDispose](),
        coroutine.close(),
      ]);
      assert.deepEqual(counts, { disposals: 1, cleanup: 1, external: 1 });
    } finally {
      external.resolve();
    }
  });
});

describe("single consumer", () => {
  test("a second registration fails on activation without resolving its value edge", async () => {
    const firstPorts = terminalPorts(Type.String(), Type.String());
    const first = new JuncoGraph(
      firstPorts.source,
      firstPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const firstContext = schedules.context({
      graph: first,
      scheduler: schedules.parallel(),
    });
    // biome-ignore lint/correctness/useYield: a coroutine that completes without yielding.
    const shared = new Deterministic<TString, string>(async function* () {
      return "first";
    }, LockPolicy);
    const firstId = first.addNode({
      trigger: TriggerRule.always(),
      state: shared,
    });
    firstPorts.connect(first, firstId);
    await firstContext.run();
    assert.deepEqual(first.result(firstId), O.some("first"));

    const secondPorts = terminalPorts(Type.String(), Type.String());

    const second = new JuncoGraph(
      secondPorts.source,
      secondPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );

    const secondContext = schedules.context({
      graph: second,
      scheduler: schedules.parallel(),
    });
    const value = Edge.value("shared-result", Type.String());
    const downstream = consumer("downstream");
    const againId = second.addNode({
      trigger: TriggerRule.always(),
      state: shared,
    });
    const downstreamId = second.addNode({
      trigger: TriggerRule.when(value),
      state: downstream.coroutine,
    });
    second.addEdge(againId, downstreamId, value);
    secondPorts.connect(second, downstreamId);

    await assert.rejects(
      secondContext.run(),
      (error) =>
        error instanceof DataflowNodeError &&
        error.nodeId === againId &&
        error.cause instanceof JuncoAgentError &&
        error.cause.code === "invalid_state",
    );
    assert.ok(unresolved(value));
    assert.ok(O.isNone(second.result(againId)));
    assert.equal((await secondContext.run()).has(downstreamId), false);
    assert.equal(downstream.ran, false);

    await first.close();
    await second.close();
  });

  test("a coroutine closed before priming fails on activation without resolving its value edge", async () => {
    const graphPorts = terminalPorts(Type.String(), Type.String());
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const value = Edge.value("closed-result", Type.String());
    let bodyRan = false;
    // biome-ignore lint/correctness/useYield: a coroutine that completes without yielding.
    const closed = new Deterministic<TString, string>(async function* () {
      bodyRan = true;
      return "never";
    }, LockPolicy);
    const downstream = consumer("downstream");
    const closedId = graph.addNode({
      trigger: TriggerRule.always(),
      state: closed,
    });
    const downstreamId = graph.addNode({
      trigger: TriggerRule.when(value),
      state: downstream.coroutine,
    });
    graph.addEdge(closedId, downstreamId, value);
    graphPorts.connect(graph, downstreamId);
    await closed.close();

    await assert.rejects(
      graphContext.run(),
      (error) =>
        error instanceof DataflowNodeError &&
        error.nodeId === closedId &&
        error.cause instanceof JuncoAgentError &&
        error.cause.code === "closed",
    );
    assert.equal(bodyRan, false);
    assert.ok(unresolved(value));
    assert.ok(O.isNone(graph.result(closedId)));
    assert.equal(downstream.ran, false);

    await graph.close();
  });

  test("a body genuinely returning undefined resolves its value edge", async () => {
    const graphPorts = terminalPorts(
      Type.String(),
      Type.Union([Type.String(), Type.Undefined()]),
    );
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const value = Edge.value(
      "undefined-result",
      Type.Union([Type.String(), Type.Undefined()]),
    );
    const source = new Deterministic<TString, string | undefined>(
      // biome-ignore lint/correctness/useYield: a coroutine that completes without yielding.
      async function* () {
        return undefined;
      },
      LockPolicy,
    );
    let observed:
      | { readonly has: boolean; readonly value: string | undefined }
      | undefined;
    const dependent = new Deterministic<TString, string | undefined>(
      async function* () {
        const view = yield [];
        observed = {
          has: view.values.has(value.id),
          value: view.values.get(value.id),
        };
        return "consumed";
      },
      LockPolicy,
    );
    const sourceId = graph.addNode({
      trigger: TriggerRule.always(),
      state: source,
    });
    const dependentId = graph.addNode({
      trigger: TriggerRule.when(value),
      state: dependent,
    });
    graph.addEdge(sourceId, dependentId, value);
    graphPorts.connect(graph, dependentId);

    await graphContext.run();
    assert.deepEqual(graph.result(sourceId), O.some(undefined));
    assert.deepEqual(observed, { has: true, value: undefined });
    assert.deepEqual(graph.result(dependentId), O.some("consumed"));
    // Finished, not closed: a further direct advance is refused rather than reporting a new result.
    await assert.rejects(
      source.next(),
      (error) =>
        error instanceof JuncoAgentError && error.code === "invalid_state",
    );

    await graph.close();
  });
});

describe("direct protocol", () => {
  test("return completes with the forced value, cleans up once and refuses later advances", async () => {
    let cleaned = 0;
    const coroutine = new graphApi.nodes.Deterministic<TNumber, string>(
      async function* () {
        try {
          yield [];
          return "natural";
        } finally {
          cleaned += 1;
        }
      },
      LockPolicy,
    );
    assert.deepEqual(await coroutine.next(), { done: false, value: [] });
    assert.deepEqual(await coroutine.return("forced"), {
      done: true,
      value: "forced",
    });
    assert.equal(cleaned, 1);
    await assert.rejects(
      coroutine.next(),
      (error) =>
        error instanceof JuncoAgentError && error.code === "invalid_state",
    );
    await coroutine.close();
    assert.equal(cleaned, 1);
  });

  test("throw delivers the same error into the body, which may recover", async () => {
    const sentinel = new Error("injected");
    let caught: unknown;
    let cleaned = 0;
    const coroutine = new graphApi.nodes.Deterministic<TNumber, string>(
      async function* () {
        try {
          yield [];
          return "unreached";
        } catch (error) {
          caught = error;
          return "recovered";
        } finally {
          cleaned += 1;
        }
      },
      LockPolicy,
    );
    await coroutine.next();
    assert.deepEqual(await coroutine.throw(sentinel), {
      done: true,
      value: "recovered",
    });
    assert.equal(caught, sentinel);
    assert.equal(cleaned, 1);
    await coroutine.close();
    assert.equal(cleaned, 1);
  });

  test("for await consumes every emitted batch and completes cleanup", async () => {
    const edge = Edge.message<TNumber, string>("numbers", Type.Number());
    let cleaned = 0;
    const coroutine = new graphApi.nodes.Deterministic<TNumber, string>(
      async function* () {
        try {
          yield [Message.create(edge, 1)];
          yield [Message.create(edge, 2)];
          return "done";
        } finally {
          cleaned += 1;
        }
      },
      LockPolicy,
    );
    const payloads: number[] = [];
    for await (const batch of coroutine)
      payloads.push(...batch.map((message) => message.payload));
    assert.deepEqual(payloads, [1, 2]);
    assert.equal(cleaned, 1);
    await coroutine.close();
  });
});

/** A collection double counting holds; only `policy`, `lease()` and `close()` are exercised. */
function countedCollection(policy: Policy, events: string[]) {
  let holds = 1;
  const collection = {
    policy,
    lease() {
      holds++;
      let released = false;
      return {
        close: async () => {
          if (released) return;
          released = true;
          events.push(`release:${--holds}`);
        },
      };
    },
    close: async () => void events.push(`creator:${--holds}`),
  };
  return collection as unknown as ToolCollection;
}

describe("policy and borrowed collections", () => {
  test("constructors reject a collection with another policy", () => {
    const body = async function* () {
      yield [];
      return "x";
    };
    const empty = countedCollection(EmptyPolicy, []);
    assert.throws(
      () => new Deterministic<TString, string>(body, LockPolicy, empty),
      TypeError,
    );
    assert.throws(() => {
      const ports = terminalPorts();
      return new JuncoGraph(
        ports.source,
        ports.sink,
        Width.create(1),
        UNBOUNDED,
        undefined,
        LockPolicy,
        empty,
      );
    }, TypeError);
    assert.throws(() => {
      const ports = terminalPorts();
      return new JuncoGraph(
        ports.source,
        ports.sink,
        Width.create(1),
        UNBOUNDED,
        undefined,
        undefined as never,
      );
    }, TypeError);
  });

  test("addNode takes a managed state's policy and rejects any supplied one; an explicit step must match its state", async () => {
    const graphPorts = terminalPorts(Type.String(), Type.String());
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const coroutine = new Deterministic<TString, string>(async function* () {
      yield [];
      return "x";
    }, LockPolicy);
    const childPorts = terminalPorts(Type.String(), Type.String());
    const child = new JuncoGraph(
      childPorts.source,
      childPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      EmptyPolicy,
    );
    const childContext = schedules.context({
      graph: child,
      scheduler: schedules.parallel(),
    });
    const childId = child.addNode({
      trigger: TriggerRule.always(),
      state: new Deterministic<TString, string>(async function* () {
        yield [];
        return "y";
      }, EmptyPolicy),
    });
    childPorts.connect(child, childId);
    const managed = [
      { trigger: TriggerRule.always(), state: coroutine },
      { trigger: TriggerRule.always(), state: childContext },
    ];
    for (const spec of managed) {
      for (const policy of [
        spec.state instanceof Deterministic
          ? spec.state.policy
          : spec.state.graph.policy,
        EmptyPolicy,
        LockPolicy,
        {},
      ]) {
        assert.throws(
          () => graph.addNode({ ...spec, policy } as never),
          TypeError,
        );
      }
    }
    assert.throws(
      () =>
        graph.addNode({
          trigger: TriggerRule.always(),
          state: coroutine,
          policy: undefined,
        }),
      TypeError,
    );
    assert.throws(
      () =>
        graph.addNode({
          trigger: TriggerRule.always(),
          state: childContext,
          policy: undefined,
        }),
      TypeError,
    );
    assert.throws(
      () =>
        graph.addNode({
          policy: EmptyPolicy,
          trigger: TriggerRule.always(),
          state: coroutine,
          step: coroutine.step,
        }),
      TypeError,
    );
    let registered = 0;
    graph.forEachNode(() => registered++);
    assert.equal(registered, 2);
    const nested = graph.addNode({
      trigger: TriggerRule.always(),
      state: childContext,
    });
    graphPorts.connect(graph, nested);
    const agentsPorts = terminalPorts();
    const agents = new JuncoGraph(
      agentsPorts.source,
      agentsPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const agentId = agents.addNode({
      state: new MockAgent({ runs: [] }),
      policy: EmptyPolicy,
      trigger: TriggerRule.always(),
    });
    agentsPorts.connect(agents, agentId);
    await Promise.all([graph.close(), agents.close(), coroutine.close()]);
  });

  test("a LockPolicy parent runs an EmptyPolicy child and coroutine without registration policies", async () => {
    let closes = 0;
    // biome-ignore lint/correctness/useYield: a coroutine that completes without yielding.
    const state = new Deterministic<never, number>(async function* () {
      try {
        return 42;
      } finally {
        closes++;
      }
    }, EmptyPolicy);
    const childPorts = terminalPorts(Type.Never(), Type.Number());
    const child = new JuncoGraph(
      childPorts.source,
      childPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      EmptyPolicy,
    );
    const childContext = schedules.context({
      graph: child,
      scheduler: schedules.parallel(),
    });
    const answer = child.addNode({ state, trigger: TriggerRule.always() });
    childPorts.connect(child, answer);
    const parentPorts = terminalPorts(Type.Never(), Type.Number());
    const parent = new JuncoGraph(
      parentPorts.source,
      parentPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
    );
    const parentContext = schedules.context({
      graph: parent,
      scheduler: schedules.parallel(),
    });
    const nested = parent.addNode({
      state: childContext,
      trigger: TriggerRule.always(),
    });
    try {
      parentPorts.connect(parent, nested);
      assert.equal((await parentContext.run()).get(nested), 42);
    } finally {
      await parent.close();
    }
    assert.ok(state.signal.aborted);
    assert.equal(closes, 1);
  });

  test("a coroutine hands its body the collection and releases its lease after cleanup", async () => {
    const events: string[] = [];
    const collection = countedCollection(EmptyPolicy, events);
    let seen: unknown;
    const coroutine = new Deterministic<TString, string>(
      async function* (_signal, borrowed) {
        seen = borrowed;
        try {
          yield [];
          return "x";
        } finally {
          events.push("finally");
        }
      },
      EmptyPolicy,
      collection,
    );
    assert.equal(coroutine.collection, collection);
    await coroutine.next();
    // A generator body runs on its first step.
    assert.equal(seen, collection);
    await coroutine.close();
    await coroutine.close();
    assert.deepEqual(events, ["finally", "release:1"]);
  });

  test("graph close settles members before releasing every visited graph's lease; abort releases none", async () => {
    const events: string[] = [];
    const collection = countedCollection(LockPolicy, events);
    const rootPorts = terminalPorts(Type.String(), Type.String());
    const root = new JuncoGraph(
      rootPorts.source,
      rootPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
      collection,
    );
    const childPorts = terminalPorts(Type.String(), Type.String());
    const child = new JuncoGraph(
      childPorts.source,
      childPorts.sink,
      Width.create(1),
      UNBOUNDED,
      quiet,
      LockPolicy,
      collection,
    );
    const childContext = schedules.context({
      graph: child,
      scheduler: schedules.parallel(),
    });
    const coroutine = new Deterministic<TString, string>(
      async function* () {
        try {
          yield [];
          return "x";
        } finally {
          events.push("finally");
        }
      },
      LockPolicy,
      collection,
    );
    const childId = child.addNode({
      trigger: TriggerRule.always(),
      state: coroutine,
    });
    childPorts.connect(child, childId);
    const nested = root.addNode({
      trigger: TriggerRule.always(),
      state: childContext,
    });
    rootPorts.connect(root, nested);
    assert.equal(root.collection, collection);
    await coroutine.next();
    await root.abort();
    assert.deepEqual(events, []);
    await root.close();
    await root.close();
    assert.deepEqual(events, [
      "finally",
      "release:3",
      "release:2",
      "release:1",
    ]);
    await collection.close();
    assert.deepEqual(events.at(-1), "creator:0");
  });
});
