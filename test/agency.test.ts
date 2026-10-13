import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DummyTracer,
  type Edge,
  NodeId,
  type NodeIdType,
  TriggerRule,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { PiScheduler, SchedulerInfo } from "junco-scheduler/agent";
import { LockPolicy } from "junco-tools";
import {
  type AgenticInput,
  Deterministic,
  JuncoGraph,
  MockAgent,
} from "../src/index.ts";
import {
  assistant,
  pause,
  reason,
  run,
  settle,
  textOf,
  userTexts,
  yieldsThen,
} from "./deterministic-support.ts";
import {
  agencyGraph,
  drive,
  type PiGraph,
  runAvailable,
  scheduleCall,
  schedulerInfoOf,
  schedulerModel,
  settledText,
} from "./support.ts";

// The agency scheduler adapter over real PiSchedulers and JuncoGraphs: candidate metadata, input
// selection, graph binding and member lifecycle. Members are mock agents; the scheduler's own model
// is a faux provider.

const resultText = (graph: JuncoGraph, id: NodeIdType) => {
  const result = graph.result(id);
  return O.isSome(result) ? textOf(result.value) : undefined;
};

/** The messages currently queued on message edge `edge`. */
const queued = (edge: Edge<AgenticInput, AssistantMessage>): AgenticInput[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

const member = (agent: MockAgent, description: string, id?: string) => ({
  ...(id === undefined ? {} : { id: NodeId.create(id) }),
  state: agent,
  policy: LockPolicy,
  description,
  trigger: TriggerRule.always(),
});

test("SchedulerInfo describes only candidate members: native description, Agentic status and latest pause reasons", async () => {
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
  const infos: SchedulerInfo[] = [];
  const transcripts: string[] = [];
  const { graph, scheduler } = await agencyGraph(
    (info) => {
      infos.push(info);
      return runAvailable(info);
    },
    { prompt: "go" },
  );
  const w = graph.addNode(member(worker, "the worker"));
  const i = graph.addNode(member(idle, IDLE));
  const raw = graph.addNode({
    policy: LockPolicy,
    description: "",
    trigger: TriggerRule.always(),
    state: new Deterministic<AgenticInput, AssistantMessage>(
      // biome-ignore lint/correctness/useYield: an inert state; the node's own step runs instead.
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
    state: new Deterministic<AgenticInput, AssistantMessage>(
      async function* () {
        yield [];
        return fauxAssistantMessage("quiet done");
      },
      LockPolicy,
    ),
  });
  scheduler.hooks.on("transform_context", ({ messages }) => {
    transcripts.push(JSON.stringify(messages));
    return undefined;
  });

  try {
    assert.equal(settledText(await drive(scheduler)), "graph quiescent");

    /** The agency's description fields, as the scheduler serialized them. */
    type Details =
      | {
          readonly description?: string;
          readonly agentStatus?: string;
          readonly lastYield?: unknown;
        }
      | undefined;
    const described = (id: NodeIdType) =>
      infos.flatMap((info) =>
        info.nodes
          .filter((node) => node.id === id)
          .map(({ status, details }) => ({
            status,
            details: details as Details,
          })),
      );
    const workerInfo = described(w);
    assert.deepEqual(workerInfo[0], {
      status: "ready",
      details: { description: "the worker", agentStatus: "ready" },
    });
    // Each suspended snapshot carries only the latest pause: the second replaces the first.
    const pauses = workerInfo
      .filter(({ details }) => details?.agentStatus === "suspended")
      .map(({ details }) => details?.lastYield)
      .filter(
        (yields, index, all) =>
          index === 0 ||
          JSON.stringify(yields) !== JSON.stringify(all[index - 1]),
      );
    assert.deepEqual(pauses, [[review], [approval]]);
    for (const { details } of workerInfo)
      assert.equal(details?.description, "the worker");
    assert.deepEqual(described(raw)[0], {
      status: "ready",
      details: { description: "" },
    });
    assert.ok(described(quiet).length > 0);
    for (const { details } of described(quiet))
      assert.equal(details, undefined);
    assert.deepEqual(described(i), []);

    assert.equal(transcripts.length, infos.length);
    for (const transcript of transcripts) {
      assert.equal(transcript.includes(IDLE), false);
      assert.equal(transcript.includes(RESULT), false);
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

test("an Opus agency graph's scheduler owns its session and members, even if a caller passes an adapter", async () => {
  const repo = new MemorySessionRepo();
  let session: Awaited<ReturnType<MemorySessionRepo["create"]>> | undefined;
  let scheduler: PiScheduler<AgenticInput, AssistantMessage> | undefined;
  let constructed: PiGraph | undefined;
  try {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("github-copilot", async () => ({
      type: "oauth",
      access: "pi-fixture-access",
      refresh: "pi-fixture-refresh",
      expires: Number.MAX_SAFE_INTEGER,
    }));
    const models = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const copilot = fauxProvider({
      provider: "github-copilot",
      models: [{ id: "claude-opus-5.5" }],
    });
    copilot.setResponses([fauxAssistantMessage("never")]);
    // The faux transport stands in for Copilot's; the login check still uses Copilot's own auth.
    models.registerNativeProvider({
      ...copilot.provider,
      auth: models.getProvider("github-copilot")!.auth,
    });
    session = await repo.create({}, BACKGROUND_CONTEXT);
    const ready = new MockAgent({
      prompt: "go",
      runs: [yieldsThen(0, "never")],
    });
    let replaced = 0;
    // An untyped caller's adapter: the factory's own adapter must still own the members.
    const callerOptions = {
      models,
      session,
      adapter: {
        abortDependents: () => {
          replaced++;
          return undefined;
        },
        closeDependents: () => {
          replaced++;
          return undefined;
        },
      },
    };
    constructed = await JuncoGraph.pi({
      ...callerOptions,
      policy: LockPolicy,
      tracer: new DummyTracer(),
    });
    scheduler = constructed.scheduler;
    constructed.addNode(member(ready, "member"));
    const selected = await scheduler.getModel();
    assert.equal(
      `${selected?.provider}/${selected?.id}`,
      "github-copilot/claude-opus-5.5",
    );

    await scheduler.return();

    assert.equal(ready.status, "closed");
    assert.equal(scheduler.status, "closed");
    assert.equal(replaced, 0);
    assert.equal(copilot.state.callCount, 0);
    assert.deepEqual(ready.requests, []);
    await assert.rejects(session.beginMutation(BACKGROUND_CONTEXT));
  } finally {
    if (constructed !== undefined) await constructed.close();
    else if (scheduler !== undefined) await scheduler.return();
    else await session?.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  }
});

test("a graph construction failure after Pi acquisition returns the scheduler and closes its session", async () => {
  const repo = new MemorySessionRepo();
  try {
    const { faux, models, model } = schedulerModel(runAvailable);
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    await assert.rejects(
      JuncoGraph.pi({
        session,
        models,
        model,
        prompt: "go",
        policy: LockPolicy,
        tracer: null as never,
      }),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === "JuncoGraph requires a tracer",
    );
    assert.equal(faux.state.callCount, 0);
    await assert.rejects(session.getEntries([], BACKGROUND_CONTEXT));
  } finally {
    await repo.close(BACKGROUND_CONTEXT);
  }
});

test("a direct scheduler abort cascades to its members, and its return waits for their close", async () => {
  const closeStarted = Promise.withResolvers<void>();
  const closeRelease = Promise.withResolvers<void>();
  /** A member recording `abort`/`return`, whose close holds until `closeRelease`. */
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
  // The priming window and the member's first activation run within one public next; the third
  // scheduler request then holds until aborted.
  const reached = Promise.withResolvers<void>();
  const scheduleAll: FauxResponseFactory = (context) =>
    fauxAssistantMessage(
      [
        scheduleCall(
          schedulerInfoOf(context).nodes.map((node) => [node.id]),
          `s${context.messages.length}`,
        ),
      ],
      { stopReason: "toolUse" },
    );
  const { graph, scheduler } = await agencyGraph(
    [
      scheduleAll,
      scheduleAll,
      async (_context, options) => {
        reached.resolve();
        await new Promise((resolve) =>
          options?.signal?.addEventListener("abort", resolve, { once: true }),
        );
        return fauxAssistantMessage("aborted", { stopReason: "aborted" });
      },
    ],
    { prompt: "go" },
  );
  try {
    graph.addNode(member(worker, "worker"));
    const pending = scheduler.next().catch(() => undefined);
    await reached.promise;
    assert.equal(worker.status, "suspended");

    const signal = graph.signal;
    await scheduler.abort();
    await pending;
    assert.deepEqual(worker.lifecycle, ["abort"]);
    assert.equal(signal.aborted, true);
    assert.notEqual(graph.signal, signal);
    assert.equal(graph.signal.aborted, false);
    assert.notEqual(worker.status, "closed");

    const returning = scheduler.return();
    const state = { settled: false };
    returning.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    await closeStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state.settled, false);

    closeRelease.resolve();
    await returning;
    assert.equal(scheduler.status, "closed");
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
