import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { NodeId, type NodeIdType, TriggerRule } from "dataflow-engine";
import type { SchedulerRequest } from "junco-scheduler/agent";
import { LockPolicy } from "junco-tools";
import {
  type AgenticInputSchema,
  Deterministic,
  MockAgent,
} from "../src/index.ts";
import type { AgencyNodeMetadata } from "../src/node-policy.ts";
import {
  assistant,
  pause,
  reason,
  resultText,
  run,
  settle,
  terminalPorts,
  yieldsThen,
} from "./deterministic-support.ts";
import {
  agencyGraph,
  runAvailable,
  scheduleCall,
  schedulerRequestOf,
} from "./support.ts";

const member = (agent: MockAgent, description: string, id?: string) => ({
  ...(id === undefined ? {} : { id: NodeId.create(id) }),
  state: agent,
  policy: LockPolicy,
  description,
  trigger: TriggerRule.always(),
});

test("SchedulerRequest carries native descriptions and source-exact latest agency metadata only for candidates", async () => {
  const IDLE = "IDLE-DESCRIPTION-91f";
  const RESULT = "WORKER-RESULT-7d1";
  const review = reason("need review", "y1");
  const approval = reason("need approval", "y2");
  const worker = new MockAgent({
    prompt: "work",
    runs: [
      run([pause([review]), pause([approval]), settle(assistant(RESULT))]),
    ],
  });
  const idle = new MockAgent({ runs: [] });
  const requests: SchedulerRequest<AgencyNodeMetadata>[] = [];
  const ports = terminalPorts();
  const { context } = await agencyGraph(
    ports.source,
    ports.sink,
    (request) => {
      requests.push(request);
      return runAvailable(request);
    },
    { prompt: "go" },
  );
  const graph = context.graph;
  const w = graph.addNode(member(worker, "the worker"));
  const i = graph.addNode(member(idle, IDLE));
  const raw = graph.addNode({
    policy: LockPolicy,
    description: "",
    trigger: TriggerRule.always(),
    state: new Deterministic<typeof AgenticInputSchema, AssistantMessage>(
      async function* () {
        return fauxAssistantMessage("unused");
      },
      LockPolicy,
    ),
    step: async function* () {
      yield [];
      return fauxAssistantMessage("raw done");
    },
  });
  const quiet = graph.addNode({
    trigger: TriggerRule.always(),
    state: new Deterministic<typeof AgenticInputSchema, AssistantMessage>(
      async function* () {
        yield [];
        return fauxAssistantMessage("quiet done");
      },
      LockPolicy,
    ),
  });
  ports.connect(graph, w);
  try {
    await context.run();
    const described = (id: NodeIdType) =>
      requests.flatMap((request) =>
        request.nodes
          .filter((node) => node.id === id)
          .map((node) => ({
            status: node.status,
            description: node.description,
            metadata: new Map(request.context).get(id),
          })),
      );
    const workerInfo = described(w);
    assert.deepEqual(workerInfo[0], {
      status: "ready",
      description: "the worker",
      metadata: { agentStatus: "ready" },
    });
    const pauses = workerInfo
      .filter(({ metadata }) => metadata?.agentStatus === "suspended")
      .map(({ metadata }) => metadata?.lastYield)
      .filter(
        (yields, index, all) =>
          index === 0 ||
          JSON.stringify(yields) !== JSON.stringify(all[index - 1]),
      );
    assert.deepEqual(pauses, [[review], [approval]]);
    for (const info of workerInfo) assert.equal(info.description, "the worker");
    assert.deepEqual(described(raw)[0], {
      status: "ready",
      description: "",
      metadata: undefined,
    });
    assert.ok(described(quiet).length > 0);
    for (const info of described(quiet)) assert.equal(info.metadata, undefined);
    assert.deepEqual(described(i), []);
    for (const request of requests) {
      const encoded = JSON.stringify(request);
      assert.equal(encoded.includes(IDLE), false);
      assert.equal(encoded.includes(RESULT), false);
      for (const node of request.nodes)
        assert.ok(
          Object.keys(node).every((key) =>
            ["id", "status", "description"].includes(key),
          ),
        );
      assert.equal(new Map(request.context).has(graph.sink.id), false);
      assert.equal(new Map(request.context).has(graph.source.id), false);
    }
    assert.deepEqual(
      [w, raw, quiet].map((id) => resultText(graph, id)),
      [RESULT, "raw done", "quiet done"],
    );
    assert.equal(idle.status, "idle");
    assert.deepEqual(idle.requests, []);
  } finally {
    await graph.close();
  }
});

test("graph abort joins a pending oracle and member abort; repeated close joins member cleanup", async () => {
  const closeStarted = Promise.withResolvers<void>();
  const closeRelease = Promise.withResolvers<void>();
  class LifecycleMember extends MockAgent {
    readonly lifecycle: string[] = [];
    override abort() {
      this.lifecycle.push("abort");
      return super.abort();
    }
    override return(value?: void | PromiseLike<void>) {
      this.lifecycle.push("return");
      return super.return(value);
    }
    protected override closeDependents(): Promise<void> {
      closeStarted.resolve();
      return closeRelease.promise;
    }
  }
  const worker = new LifecycleMember({
    prompt: "work",
    runs: [yieldsThen(1, "unused")],
  });
  const reached = Promise.withResolvers<void>();
  const providerFinished = Promise.withResolvers<void>();
  const scheduleAll: FauxResponseFactory = (request) =>
    fauxAssistantMessage(
      [
        scheduleCall(
          [schedulerRequestOf(request).nodes.map((node) => node.id)],
          "all",
        ),
      ],
      { stopReason: "toolUse" },
    );
  const ports = terminalPorts();
  const { context } = await agencyGraph(ports.source, ports.sink, [
    scheduleAll,
    scheduleAll,
    async (_request, options) => {
      reached.resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      providerFinished.resolve();
      return fauxAssistantMessage("aborted", { stopReason: "aborted" });
    },
  ]);
  const graph = context.graph;
  const id = graph.addNode(member(worker, "worker"));
  ports.connect(graph, id);
  try {
    const pending = context.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    await reached.promise;
    assert.equal(worker.status, "suspended");
    const signal = graph.signal;
    await graph.abort();
    await providerFinished.promise;
    assert.equal(await pending, signal.reason);
    assert.deepEqual(worker.lifecycle, ["abort"]);
    assert.equal(signal.aborted, true);
    assert.notEqual(graph.signal, signal);
    assert.equal(graph.signal.aborted, false);
    assert.notEqual(worker.status, "closed");
    let settled = false;
    const closing = graph.close().then(() => {
      settled = true;
    });
    await closeStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    closeRelease.resolve();
    await closing;
    assert.equal(worker.status, "closed");
    assert.equal(graph.signal.aborted, true);
    assert.deepEqual(worker.lifecycle, ["abort", "return"]);
    await graph.close();
    assert.deepEqual(worker.lifecycle, ["abort", "return"]);
  } finally {
    closeRelease.resolve();
    await graph.close();
  }
});
