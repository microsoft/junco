import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  always,
  anyOf,
  DataflowNodeError,
  type Edge,
  messageEdge,
  msg,
  on,
  valueEdge,
  when,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgentError } from "junco-agent";
import type { ToolCollection } from "junco-tools";
import {
  type AgenticInput,
  agentNode,
  createParallelAgentGraph,
  Deterministic,
  deterministicNode,
  graph as graphApi,
  graphNode,
  MockAgent,
} from "../src/index.ts";

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

const unresolved = <N, T>(edge: Edge<N, T>): boolean =>
  E.isRight(edge.transport) && O.isNone(edge.transport.right);

/** A coroutine consumer recording whether the engine ever primed it. */
function consumer<T>(result: T) {
  const state = { ran: false };
  const coroutine = new Deterministic<string, T>(async function* () {
    state.ran = true;
    yield [];
    return result;
  }, "LockPolicy");
  return {
    coroutine,
    get ran() {
      return state.ran;
    },
  };
}

describe("abort", () => {
  test("joins a gated finally, cleans up once and starts no downstream work", async () => {
    const graph = createParallelAgentGraph<string, string>("LockPolicy");
    const result = valueEdge<string, string>("waiting-result");
    const entered = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cleaned = 0;
    const waiting = new Deterministic<string, string>(async function* (signal) {
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
    }, "LockPolicy");
    const downstream = consumer("downstream");
    const waitingId = graph.addNode(
      deterministicNode(waiting, { policy: "LockPolicy", trigger: always() }),
    );
    const downstreamId = graph.addNode(
      deterministicNode(downstream.coroutine, {
        policy: "LockPolicy",
        trigger: when(result),
      }),
    );
    graph.addEdge(waitingId, downstreamId, result);

    const drive = failureOf(graph.run());
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
    assert.equal((await graph.run()).has(downstreamId), false);
    assert.equal(downstream.ran, false);
    assert.ok(unresolved(result));
    assert.ok(O.isNone(graph.result(waitingId)));

    await graph.close();
    assert.equal(cleaned, 1);
  });

  test("preserves an unrelated cleanup error, which a later close does not report again", async () => {
    const graph = createParallelAgentGraph<string, string>("LockPolicy");
    const entered = Promise.withResolvers<void>();
    const unrelated = new Error("cleanup failed");
    const failing = new Deterministic<string, string>(async function* (signal) {
      yield [];
      entered.resolve();
      try {
        await untilAborted(signal);
      } catch {
        throw unrelated;
      }
      return "never";
    }, "LockPolicy");
    const id = graph.addNode(
      deterministicNode(failing, { policy: "LockPolicy", trigger: always() }),
    );

    const drive = failureOf(graph.run());
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
    const graph = createParallelAgentGraph<string, string>("LockPolicy");
    const broken = new Error("body failed");
    let cleaned = 0;
    const failing = new Deterministic<string, string>(async function* () {
      try {
        yield [];
        throw broken;
      } finally {
        cleaned++;
      }
    }, "LockPolicy");
    const id = graph.addNode(
      deterministicNode(failing, { policy: "LockPolicy", trigger: always() }),
    );

    const failure = await failureOf(graph.run());
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

describe("close", () => {
  test("drains suspended and waiting coroutines without routing cleanup output or publishing results", async () => {
    const graph = createParallelAgentGraph<string, string>("LockPolicy");
    const input = messageEdge<string, string>("input");
    const suspendedCleanup = messageEdge<string, string>("suspended-cleanup");
    const waitingCleanup = messageEdge<string, string>("waiting-cleanup");
    const suspendedReady = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleaned = { suspended: 0, waiting: 0 };
    const suspended = new Deterministic<string, string>(async function* () {
      yield [];
      try {
        suspendedReady.resolve();
        yield [];
      } finally {
        yield [msg(suspendedCleanup, "suspended cleanup")];
        cleaned.suspended++;
      }
      return "suspended result";
    }, "LockPolicy");
    const waiting = new Deterministic<string, string>(async function* (signal) {
      yield [];
      entered.resolve();
      try {
        await untilAborted(signal);
      } finally {
        cleanupStarted.resolve();
        await release.promise;
        cleaned.waiting++;
        yield [msg(waitingCleanup, "waiting cleanup")];
      }
      return "waiting result";
    }, "LockPolicy");
    const downstream = consumer("downstream");
    const suspendedId = graph.addNode(
      deterministicNode(suspended, {
        policy: "LockPolicy",
        trigger: when(input),
      }),
    );
    const waitingId = graph.addNode(
      deterministicNode(waiting, { policy: "LockPolicy", trigger: always() }),
    );
    const downstreamId = graph.addNode(
      deterministicNode(downstream.coroutine, {
        policy: "LockPolicy",
        trigger: anyOf(on(suspendedCleanup), on(waitingCleanup)),
      }),
    );
    // The trigger edge must be inbound; the coroutine never emits on it.
    graph.addEdge(suspendedId, suspendedId, input);
    graph.addEdge(suspendedId, downstreamId, suspendedCleanup);
    graph.addEdge(waitingId, downstreamId, waitingCleanup);
    assert.ok(E.isLeft(input.transport));
    input.transport.left.push("go");

    const drive = failureOf(graph.run());
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
    await assert.rejects(graph.run(), (error) => error === graph.signal.reason);
  });

  test("a finally error rejects close without preventing a sibling agent's close", async () => {
    const graph = createParallelAgentGraph("LockPolicy");
    const failure = new Error("finally failed");
    const coroutine = new Deterministic<AgenticInput, AssistantMessage>(
      async function* () {
        try {
          yield [];
        } finally {
          // biome-ignore lint/correctness/noUnsafeFinally: the case under test is a throwing finally block.
          throw failure;
        }
      },
      "LockPolicy",
    );
    const sibling = new MockAgent({ runs: [] });
    graph.addNode(
      deterministicNode(coroutine, {
        policy: "LockPolicy",
        trigger: always(),
      }),
    );
    graph.addNode(
      agentNode(sibling, {
        policy: "LockPolicy",
        trigger: always(),
        is_available: () => false,
      }),
    );
    await graph.step();

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
    const graph = createParallelAgentGraph<string, string>("LockPolicy");
    const entered = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cleaned = 0;
    const waiting = new Deterministic<string, string>(async function* (signal) {
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
    }, "LockPolicy");
    const id = graph.addNode(
      deterministicNode(waiting, { policy: "LockPolicy", trigger: always() }),
    );

    const drive = failureOf(graph.run());
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
    await assert.rejects(graph.run(), (error) => error === graph.signal.reason);
    await assert.rejects(
      graph.abort(),
      (error) => error instanceof JuncoAgentError && error.code === "closed",
    );
  });

  test("graph close joins a shared coroutine's async disposal hook", async () => {
    const external = Promise.withResolvers<void>();
    const counts = { disposals: 0, cleanup: 0, external: 0 };
    class Owned extends Deterministic<string, string> {
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
    }, "LockPolicy");
    const child = createParallelAgentGraph<string, string>("LockPolicy");
    const result = child.addNode(
      deterministicNode(coroutine, {
        policy: "LockPolicy",
        trigger: always(),
      }),
    );
    const parent = createParallelAgentGraph<string, string>("LockPolicy");
    parent.addNode(
      deterministicNode(coroutine, {
        policy: "LockPolicy",
        trigger: always(),
        is_available: () => false,
      }),
    );
    parent.addNode(
      graphNode(
        child,
        {
          policy: "LockPolicy",
          trigger: always(),
          is_available: () => false,
        },
        { result },
      ),
    );
    await child.step();

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
    const first = createParallelAgentGraph<string, string>("LockPolicy");
    // biome-ignore lint/correctness/useYield: a coroutine that completes without yielding.
    const shared = new Deterministic<string, string>(async function* () {
      return "first";
    }, "LockPolicy");
    const firstId = first.addNode(
      deterministicNode(shared, { policy: "LockPolicy", trigger: always() }),
    );
    await first.run();
    assert.deepEqual(first.result(firstId), O.some("first"));

    const second = createParallelAgentGraph<string, string>("LockPolicy");
    const value = valueEdge<string, string>("shared-result");
    const downstream = consumer("downstream");
    const againId = second.addNode(
      deterministicNode(shared, { policy: "LockPolicy", trigger: always() }),
    );
    const downstreamId = second.addNode(
      deterministicNode(downstream.coroutine, {
        policy: "LockPolicy",
        trigger: when(value),
      }),
    );
    second.addEdge(againId, downstreamId, value);

    await assert.rejects(
      second.run(),
      (error) =>
        error instanceof DataflowNodeError &&
        error.nodeId === againId &&
        error.cause instanceof JuncoAgentError &&
        error.cause.code === "invalid_state",
    );
    assert.ok(unresolved(value));
    assert.ok(O.isNone(second.result(againId)));
    assert.equal((await second.run()).has(downstreamId), false);
    assert.equal(downstream.ran, false);

    await first.close();
    await second.close();
  });

  test("a coroutine closed before priming fails on activation without resolving its value edge", async () => {
    const graph = createParallelAgentGraph<string, string>("LockPolicy");
    const value = valueEdge<string, string>("closed-result");
    let bodyRan = false;
    // biome-ignore lint/correctness/useYield: a coroutine that completes without yielding.
    const closed = new Deterministic<string, string>(async function* () {
      bodyRan = true;
      return "never";
    }, "LockPolicy");
    const downstream = consumer("downstream");
    const closedId = graph.addNode(
      deterministicNode(closed, { policy: "LockPolicy", trigger: always() }),
    );
    const downstreamId = graph.addNode(
      deterministicNode(downstream.coroutine, {
        policy: "LockPolicy",
        trigger: when(value),
      }),
    );
    graph.addEdge(closedId, downstreamId, value);
    await closed.close();

    await assert.rejects(
      graph.run(),
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
    const graph = createParallelAgentGraph<string, string | undefined>(
      "LockPolicy",
    );
    const value = valueEdge<string, string | undefined>("undefined-result");
    const source = new Deterministic<string, string | undefined>(
      // biome-ignore lint/correctness/useYield: a coroutine that completes without yielding.
      async function* () {
        return undefined;
      },
      "LockPolicy",
    );
    let observed:
      | { readonly has: boolean; readonly value: string | undefined }
      | undefined;
    const dependent = new Deterministic<string, string | undefined>(
      async function* () {
        const view = yield [];
        observed = {
          has: view.values.has(value.id),
          value: view.values.get(value.id),
        };
        return "consumed";
      },
      "LockPolicy",
    );
    const sourceId = graph.addNode(
      deterministicNode(source, { policy: "LockPolicy", trigger: always() }),
    );
    const dependentId = graph.addNode(
      deterministicNode(dependent, {
        policy: "LockPolicy",
        trigger: when(value),
      }),
    );
    graph.addEdge(sourceId, dependentId, value);

    await graph.run();
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
    const coroutine = new graphApi.nodes.Deterministic<number, string>(
      async function* () {
        try {
          yield [];
          return "natural";
        } finally {
          cleaned += 1;
        }
      },
      "LockPolicy",
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
    const coroutine = new graphApi.nodes.Deterministic<number, string>(
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
      "LockPolicy",
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
    const edge = messageEdge<number, string>("numbers");
    let cleaned = 0;
    const coroutine = new graphApi.nodes.Deterministic<number, string>(
      async function* () {
        try {
          yield [msg(edge, 1)];
          yield [msg(edge, 2)];
          return "done";
        } finally {
          cleaned += 1;
        }
      },
      "LockPolicy",
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
function countedCollection(
  policy: "LockPolicy" | "EmptyPolicy",
  events: string[],
) {
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
  test("constructors reject a missing policy or a collection with another policy", () => {
    const body = async function* () {
      yield [];
      return "x";
    };
    const empty = countedCollection("EmptyPolicy", []);
    assert.throws(
      () => new Deterministic<string, string>(body, "gitpolicy" as never),
      (error) =>
        error instanceof TypeError &&
        error.message === 'policy must be "LockPolicy" or "EmptyPolicy"',
    );
    assert.throws(
      () => new Deterministic<string, string>(body, "LockPolicy", empty),
      TypeError,
    );
    assert.throws(
      () => createParallelAgentGraph("LockPolicy", undefined, empty),
      TypeError,
    );
    assert.throws(
      () => createParallelAgentGraph(undefined as never),
      TypeError,
    );
  });

  test("addNode requires a real state's policy to equal its spec's; a mock takes the spec's", async () => {
    const graph = createParallelAgentGraph<string, string>("LockPolicy");
    const coroutine = new Deterministic<string, string>(async function* () {
      yield [];
      return "x";
    }, "LockPolicy");
    assert.throws(
      () =>
        graph.addNode(
          deterministicNode(coroutine, {
            policy: "EmptyPolicy",
            trigger: always(),
          }),
        ),
      (error) =>
        error instanceof TypeError &&
        error.message === "Node policy does not match its state",
    );
    const child = createParallelAgentGraph<string, string>("EmptyPolicy");
    const childId = child.addNode(
      deterministicNode(
        new Deterministic<string, string>(async function* () {
          yield [];
          return "y";
        }, "EmptyPolicy"),
        { policy: "EmptyPolicy", trigger: always() },
      ),
    );
    assert.throws(
      () =>
        graph.addNode(
          graphNode(
            child,
            { policy: "LockPolicy", trigger: always() },
            { result: childId },
          ),
        ),
      TypeError,
    );
    graph.addNode(
      graphNode(
        child,
        { policy: "EmptyPolicy", trigger: always() },
        { result: childId },
      ),
    );
    const agents = createParallelAgentGraph("LockPolicy");
    agents.addNode(
      agentNode(new MockAgent({ runs: [] }), {
        policy: "EmptyPolicy",
        trigger: always(),
      }),
    );
    await Promise.all([graph.close(), agents.close(), coroutine.close()]);
  });

  test("a coroutine hands its body the collection and releases its lease after cleanup", async () => {
    const events: string[] = [];
    const collection = countedCollection("EmptyPolicy", events);
    let seen: unknown;
    const coroutine = new Deterministic<string, string>(
      async function* (_signal, borrowed) {
        seen = borrowed;
        try {
          yield [];
          return "x";
        } finally {
          events.push("finally");
        }
      },
      "EmptyPolicy",
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
    const collection = countedCollection("LockPolicy", events);
    const root = createParallelAgentGraph<string, string>(
      "LockPolicy",
      undefined,
      collection,
    );
    const child = createParallelAgentGraph<string, string>(
      "LockPolicy",
      undefined,
      collection,
    );
    const coroutine = new Deterministic<string, string>(
      async function* () {
        try {
          yield [];
          return "x";
        } finally {
          events.push("finally");
        }
      },
      "LockPolicy",
      collection,
    );
    const childId = child.addNode(
      deterministicNode(coroutine, { policy: "LockPolicy", trigger: always() }),
    );
    root.addNode(
      graphNode(
        child,
        { policy: "LockPolicy", trigger: always() },
        { result: childId },
      ),
    );
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
