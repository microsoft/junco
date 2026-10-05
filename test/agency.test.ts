import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  always,
  anyOf,
  DummyTracer,
  type Edge,
  messageEdge,
  msg,
  NodeId,
  type NodeIdType,
  on,
  UNBOUNDED,
  valueEdge,
  when,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticStep, JuncoAgentError } from "junco-agent";
import type { PiScheduler, SchedulerInfo } from "junco-scheduler/agent";
import {
  type AgenticInput,
  agentNode,
  createAgencyScheduler,
  Deterministic,
  deterministicNode,
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
  newScheduler,
  type PiGraph,
  runAvailable,
  settledText,
} from "./support.ts";

// The agency scheduler adapter over real PiSchedulers and JuncoGraphs: candidate metadata, input
// selection, graph binding and member lifecycle. Members are mock agents; the scheduler's own model
// is a faux provider.

const invalidState = (error: unknown) =>
  error instanceof JuncoAgentError && error.code === "invalid_state";

/** The failure of a failed step, unwrapped from node-error causes. */
function failureOf(step: AgenticStep): unknown {
  assert.equal(step.kind, "failed");
  let error: unknown = step.kind === "failed" ? step.error : undefined;
  while (
    error instanceof Error &&
    !(error instanceof JuncoAgentError) &&
    error.cause !== undefined
  )
    error = error.cause;
  return error;
}

const resultText = (graph: JuncoGraph, id: NodeIdType) => {
  const result = graph.result(id);
  return O.isSome(result) ? textOf(result.value) : undefined;
};

/** The messages currently queued on message edge `edge`. */
const queued = (edge: Edge<AgenticInput, AssistantMessage>): AgenticInput[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

const member = (agent: MockAgent, description: string, id?: string) =>
  agentNode(agent, {
    ...(id === undefined ? {} : { id: NodeId(id) }),
    description,
    trigger: always(),
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
    description: "",
    trigger: always(),
    state: new Deterministic<AgenticInput, AssistantMessage>(
      // biome-ignore lint/correctness/useYield: an inert state; the node's own step runs instead.
      async function* () {
        return fauxAssistantMessage("unused");
      },
    ),
    step: async function* () {
      yield [];
      return fauxAssistantMessage("raw done");
    },
  });
  const quiet = graph.addNode(
    deterministicNode(
      new Deterministic<AgenticInput, AssistantMessage>(async function* () {
        yield [];
        return fauxAssistantMessage("quiet done");
      }),
      { trigger: always() },
    ),
  );
  scheduler.hooks.on("transform_context", ({ messages }) => {
    transcripts.push(JSON.stringify(messages));
    return undefined;
  });

  try {
    assert.equal(settledText((await drive(scheduler)).last), "graph quiescent");

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

test("an any trigger reads a newer message although a delivered result stays satisfied", async () => {
  const source = new MockAgent({
    prompt: "value",
    runs: [yieldsThen(0, "the value")],
  });
  const messenger = new MockAgent({
    runs: [yieldsThen(1, "messenger done")],
  });
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
  const { graph, scheduler } = await agencyGraph(runAvailable, {
    prompt: "go",
  });
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
      {
        id: NodeId("c"),
        description: "reader",
        trigger: anyOf(on(value), on(more)),
      },
      {
        receive: (view) => [
          ...[...view.values.keys()].map(
            (id): AgenticInput => ({
              kind: "nextTurn",
              text: `got ${textOf(view.values.get(id)!)}`,
            }),
          ),
          ...(view.messages.get(more.id) ?? []),
        ],
        emit: (step) =>
          step.reasons[0]?.reason === "ask for more"
            ? [msg(ask, { kind: "prompt", text: "help" })]
            : [],
      },
    ),
  );
  graph.addEdge(a, c, value).addEdge(c, b, ask).addEdge(b, c, more);

  try {
    assert.equal(settledText((await drive(scheduler)).last), "graph quiescent");
    assert.deepEqual(
      [a, b, c].map((id) => resultText(graph, id)),
      ["the value", "messenger done", "reader after more"],
    );
    assert.deepEqual(userTexts(reader.history), [
      "got the value",
      "read",
      "more",
    ]);
    assert.deepEqual(
      reader.calls.map(({ method, args }) => [method, args[0]]),
      [
        ["nextTurn", "got the value"],
        ["followUp", "more"],
      ],
    );
    assert.deepEqual(queued(more), []);
  } finally {
    await graph.close();
  }
});

test("a missing or foreign graph getter fails before provider work and touches no unrelated members", async () => {
  const missing = await newScheduler(() => undefined, runAvailable, {
    prompt: "go",
  });
  assert.ok(invalidState(failureOf((await drive(missing.scheduler)).last)));
  assert.equal(missing.faux.state.callCount, 0);
  await missing.scheduler.abort();
  await missing.scheduler.return();
  assert.equal(missing.scheduler.status, "closed");

  const bystander = new MockAgent({
    prompt: "go",
    runs: [yieldsThen(0, "never")],
  });
  const other = await agencyGraph(runAvailable, { prompt: "other" });
  try {
    other.graph.addNode(member(bystander, "bystander"));
    const foreign = await newScheduler(() => other.graph, runAvailable, {
      prompt: "go",
    });
    assert.ok(invalidState(failureOf((await drive(foreign.scheduler)).last)));
    assert.equal(foreign.faux.state.callCount, 0);

    const abortError = await foreign.scheduler.abort().then(
      () => undefined,
      (error: unknown) => error,
    );
    const closeError = await foreign.scheduler.return().then(
      () => undefined,
      (error: unknown) => error,
    );
    for (const error of [abortError, closeError]) {
      const errors = error instanceof AggregateError ? error.errors : [error];
      assert.ok(errors.length > 0 && errors.every(invalidState));
    }
    assert.equal(foreign.scheduler.status, "closed");
    assert.equal(other.graph.signal.aborted, false);
    assert.equal(bystander.status, "ready");
    assert.deepEqual(bystander.requests, []);
    assert.equal(other.scheduler.status, "ready");
  } finally {
    await other.graph.close();
  }
  assert.equal(bystander.status, "closed");
});

test("an Opus agency scheduler owns its session and members, even if a caller passes an adapter", async () => {
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
    let graph: PiGraph | undefined;
    scheduler = await createAgencyScheduler(() => graph, callerOptions);
    constructed = new JuncoGraph(
      scheduler,
      UNBOUNDED,
      UNBOUNDED,
      new DummyTracer(),
    );
    graph = constructed;
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

test("a graph constructed on the scheduler but not yet published fails admission before provider work", async () => {
  let current: PiGraph | undefined;
  const { scheduler, faux } = await newScheduler(() => current, runAvailable, {
    prompt: "go",
  });
  const constructed: PiGraph = new JuncoGraph(
    scheduler,
    UNBOUNDED,
    UNBOUNDED,
    new DummyTracer(),
  );
  const ready = new MockAgent({
    prompt: "go",
    runs: [yieldsThen(0, "never")],
  });
  try {
    constructed.addNode(member(ready, "member"));

    // The engine binding is in place, so this failure is the agency's own guard.
    assert.ok(invalidState(failureOf((await drive(scheduler)).last)));
    assert.equal(faux.state.callCount, 0);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.requests, []);
  } finally {
    current = constructed;
    await constructed.close();
  }
  assert.equal(ready.status, "closed");
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
  const { graph, scheduler } = await agencyGraph(runAvailable, {
    prompt: "go",
  });
  try {
    graph.addNode(member(worker, "worker"));
    // The priming window, then the member's first activation.
    for (let window = 0; window < 2; window++) {
      const step = await scheduler.next();
      assert.ok(
        step.done === false && step.value.kind === "yield",
        JSON.stringify(step),
      );
    }
    assert.equal(worker.status, "suspended");

    const signal = graph.signal;
    await scheduler.abort();
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
