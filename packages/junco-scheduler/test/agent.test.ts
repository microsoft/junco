import { Type } from "typebox";
/// <reference lib="es2024.promise" />

import { test } from "bun:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  type AssistantMessage,
  type Context,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  DataflowGraph,
  DataflowNodeError,
  Edge,
  type NodeAvailability,
  type NodeGenerator,
  NodeId,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import { Value } from "typebox/value";
import { type PiOptions, pi, type SchedulerRequest } from "../src/agent.ts";
import { context, parallel, separate } from "../src/index.ts";
import {
  nativeOptions,
  type Plan,
  runAvailable,
  scheduleCall,
  schedulerRequestOf,
  toolTurn,
  userTexts,
} from "./support.ts";

const StringSchema = Type.String();

type Script<C> =
  | ((request: SchedulerRequest<C>, index: number) => Plan)
  | readonly FauxResponseStep[];

function newScheduler<C = never>(
  script: Script<C> = runAvailable,
  extra: Omit<PiOptions, "models" | "model"> = {},
) {
  let requests = 0;
  const respond: FauxResponseFactory = (context) => {
    if (typeof script !== "function")
      throw new Error("expected a decision callback");
    faux.appendResponses([respond]);
    const decision = script(schedulerRequestOf<C>(context), requests++);
    return toolTurn(scheduleCall(decision.waves, `schedule-${requests}`));
  };
  const { faux, options } = nativeOptions(
    typeof script === "function" ? [respond] : script,
  );
  return { scheduler: pi({ ...options, ...extra }), faux };
}

const id = NodeId.create;
const makeGraph = () =>
  new DataflowGraph<void, typeof StringSchema, string, unknown>(
    Width.create(1),
    UNBOUNDED,
  );
const twoStep = (log: string[], result: string) =>
  async function* (): NodeGenerator<typeof StringSchema, string> {
    log.push("prime");
    yield [];
    log.push("resume");
    return result;
  };

function finite(
  graph: ReturnType<typeof makeGraph>,
  name: string,
  log: string[],
) {
  return graph.addNode({
    id: id(name),
    state: undefined,
    trigger: TriggerRule.always(),
    step: twoStep(log, name),
  });
}

/** The model seam keeps native response/option types while making settlement controllable. */
function oracle(completeSimple: PiOptions["models"]["completeSimple"]) {
  const { options } = nativeOptions();
  return pi({ model: options.model, models: { completeSimple } });
}

test("empty IDs execute through fresh schedule requests, without a quiescent call", async () => {
  const requests: SchedulerRequest<never>[] = [];
  const { scheduler, faux } = newScheduler((request) => {
    requests.push(request);
    return runAvailable(request);
  });
  const graph = makeGraph();
  const log: string[] = [];
  graph.addNode({
    id: id(""),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      log.push("prime");
      yield [];
      log.push("resume");
      yield [];
      log.push("complete");
      return "empty-id result";
    },
  });
  const execution = context({ graph, scheduler });
  assert.deepEqual([...(await execution.run())], [["", "empty-id result"]]);
  assert.deepEqual(log, ["prime", "resume", "complete"]);
  assert.equal(faux.state.callCount, 3);
  assert.deepEqual(
    requests.map((request) =>
      request.history.map((decision) => decision.selected),
    ),
    [
      [],
      [[{ nodeId: id(""), modelStrength: 2, readEdges: [] }]],
      [
        [{ nodeId: id(""), modelStrength: 2, readEdges: [] }],
        [{ nodeId: id(""), modelStrength: 2, readEdges: [] }],
      ],
    ],
  );
  assert.deepEqual([...(await execution.step())], [["", "empty-id result"]]);
  assert.equal(faux.state.callCount, 3);
  const dormant = makeGraph();
  dormant.addNode({
    state: undefined,
    trigger: TriggerRule.never(),
    step: twoStep([], "never"),
  });
  await context({ graph: dormant, scheduler }).run();
  assert.equal(faux.state.callCount, 3);
});

test("only the first applicable wave runs, and the next decision asks again", async () => {
  const requests: SchedulerRequest<never>[] = [];
  const { scheduler, faux } = newScheduler((request, index) => {
    requests.push(request);
    return index === 0
      ? { waves: [["missing"], ["b", "b", "a"], ["later"]] }
      : { waves: [["later"]] };
  });
  const graph = makeGraph();
  const activated: string[] = [];
  for (const name of ["a", "b", "later"])
    graph.addNode({
      id: id(name),
      state: undefined,
      trigger: TriggerRule.always(),
      step: async function* () {
        activated.push(name);
        return name;
      },
    });
  const execution = context({ graph, scheduler });
  assert.deepEqual(
    [...(await execution.step())],
    [
      ["b", "b"],
      ["a", "a"],
    ],
  );
  assert.deepEqual(activated, ["b", "a"]);
  assert.deepEqual(
    [...(await execution.run())],
    [
      ["b", "b"],
      ["a", "a"],
      ["later", "later"],
    ],
  );
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(requests[1]?.history, [
    {
      selected: [
        { nodeId: id("b"), modelStrength: 2, readEdges: [] },
        { nodeId: id("a"), modelStrength: 2, readEdges: [] },
      ],
    },
  ]);
});

test("a Pi policy is reusable across graphs with independent histories", async () => {
  const requests: SchedulerRequest<never>[] = [];
  const { scheduler } = newScheduler((request) => {
    requests.push(request);
    return runAvailable(request);
  });
  const left = makeGraph();
  const right = makeGraph();
  finite(left, "left", []);
  finite(right, "right", []);
  const a = context({ graph: left, scheduler });
  const b = context({ graph: right, scheduler });
  await a.step();
  await b.step();
  await a.run();
  await b.run();
  assert.deepEqual(
    requests.map((request) => request.history),
    [
      [],
      [],
      [{ selected: [{ nodeId: id("left"), modelStrength: 2, readEdges: [] }] }],
      [
        {
          selected: [{ nodeId: id("right"), modelStrength: 2, readEdges: [] }],
        },
      ],
    ],
  );
});

test("the request uses one strict tool, caller prompt first, snapshot last and no conversation", async () => {
  const captured: Context[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const { options } = nativeOptions();
  const controller = new AbortController();
  const stray = new AbortController();
  const supplied = { temperature: 0.25, signal: stray.signal };
  const scheduler = pi({
    model: options.model,
    models: {
      completeSimple: async (_model, request, streamOptions) => {
        captured.push(request);
        signals.push(streamOptions?.signal);
        assert.equal(streamOptions?.temperature, 0.25);
        return toolTurn(scheduleCall([[""]], "decision"));
      },
    },
    systemPrompt: "Caller instruction.",
    prompt: "Coordinate this work.",
    streamOptions: supplied,
  });
  const graph = makeGraph();
  finite(graph, "", []);
  await context({ graph, scheduler }).run({ signal: controller.signal });
  assert.equal(captured.length, 2);
  for (const request of captured) {
    assert.equal(request.messages.length, 2);
    assert.equal(userTexts(request.messages)[0], "Coordinate this work.");
    assert.ok(
      userTexts(request.messages)[1]?.startsWith("SchedulerSnapshot:\n"),
    );
    assert.ok(
      request.messages.every(
        (message) => typeof message.timestamp === "number",
      ),
    );
    assert.deepEqual(
      request.tools?.map((tool) => tool.name),
      ["schedule"],
    );
    const tool = request.tools?.[0];
    assert.ok(tool);
    assert.equal(Value.Check(tool.parameters, { waves: [[""]] }), true);
    assert.equal(Value.Check(tool.parameters, { waves: [[1]] }), false);
    assert.equal(Value.Check(tool.parameters, { waves: [], lanes: [] }), false);
  }
  assert.deepEqual(signals, [controller.signal, controller.signal]);
  assert.deepEqual(schedulerRequestOf<never>(captured[0]!).history, []);
  assert.deepEqual(schedulerRequestOf<never>(captured[1]!).history, [
    { selected: [{ nodeId: id(""), modelStrength: 2, readEdges: [] }] },
  ]);
});

test("wire snapshots only disclose available owned nodes' metadata and raw measurements", async () => {
  const STATE = "private-state";
  const PAYLOAD = "private-message";
  const RESULT = "private-result";
  const requests: Context[] = [];
  const graph = new DataflowGraph<
    Readonly<{ secret: string }>,
    typeof StringSchema,
    string,
    never
  >(Width.create(1), UNBOUNDED);
  const finished = graph.addNode({
    id: id("finished"),
    state: { secret: STATE },
    trigger: TriggerRule.always(),
    step: async function* () {
      return RESULT;
    },
  });
  await context({ graph, scheduler: parallel() }).step();
  const described: string[] = [];
  const describeNode = (
    name: ReturnType<typeof id>,
    candidate: NodeAvailability<typeof StringSchema, string>,
  ) => {
    described.push(name);
    return name === "worker"
      ? {
          trigger: candidate.trigger.kind,
          satisfied: candidate.satisfied.length,
        }
      : undefined;
  };
  type Metadata = Exclude<ReturnType<typeof describeNode>, undefined>;
  const shown: SchedulerRequest<Metadata>[] = [];
  let plainReady = true;
  for (const name of ["worker", "plain", "unowned", "dormant"])
    graph.addNode({
      id: id(name),
      state: { secret: STATE },
      description: name === "worker" ? "" : undefined,
      trigger: name === "dormant" ? TriggerRule.never() : TriggerRule.always(),
      is_available: (_view, triggered) =>
        triggered && (name !== "plain" || plainReady),
      step: twoStep([], name),
    });
  const queued = Edge.message<typeof StringSchema, string>(
    "private-queue",
    StringSchema,
  );
  const value = Edge.value("private-value", StringSchema);
  graph.addEdge(id("dormant"), id("worker"), queued);
  graph.addEdge(finished, id("worker"), value);
  graph.emit(id("dormant"), { id: queued.id, payload: PAYLOAD });
  const scheduler = oracle(async (_model, request) => {
    requests.push(request);
    const snapshot = schedulerRequestOf<Metadata>(request);
    shown.push(snapshot);
    return toolTurn(scheduleCall(runAvailable(snapshot).waves, "decision"));
  });
  const execution = context({
    graph,
    describeNode,
    measurementWindows: new Map([["runtime", 2]]),
    scheduler: separate(
      (_snapshot, name) => name === "worker" || name === "plain",
      scheduler,
      parallel(),
    ),
  });
  await execution.step();
  plainReady = false;
  await execution.step();
  assert.deepEqual(
    shown.map((request) => request.nodes),
    [
      [
        { id: "worker", status: "ready", description: "" },
        { id: "plain", status: "ready" },
      ],
      [{ id: "worker", status: "running", description: "" }],
    ],
  );
  assert.deepEqual(shown[0]?.context, [
    ["worker", { trigger: "all", satisfied: 0 }],
  ]);
  assert.deepEqual(shown[1]?.context, [
    ["worker", { trigger: "all", satisfied: 0 }],
  ]);
  assert.deepEqual(shown[0]?.measurements, []);
  const samples = shown[1]?.measurements;
  assert.deepEqual(
    samples?.map(([name]) => name),
    ["worker"],
  );
  const runtime = samples?.[0]?.[1].runtime;
  assert.equal(runtime?.length, 1);
  assert.ok(runtime && Number.isSafeInteger(runtime[0]) && runtime[0]! >= 0);
  assert.deepEqual(shown[1]?.history, [
    {
      selected: [
        { nodeId: id("worker"), modelStrength: 2, readEdges: [] },
        { nodeId: id("plain"), modelStrength: 2, readEdges: [] },
      ],
    },
  ]);
  assert.ok(shown.every((request) => request.threads === null));
  assert.ok(shown.every((request) => request.lastError === null));
  assert.ok(
    described.every((name) => name !== "finished" && name !== "dormant"),
  );
  for (const request of requests) {
    const wire = JSON.stringify(request);
    for (const hidden of [
      STATE,
      PAYLOAD,
      RESULT,
      "private-queue",
      "private-value",
      "dormant",
      "unowned",
      "finished",
    ])
      assert.equal(wire.includes(hidden), false, hidden);
  }
  assert.deepEqual(graph.result(finished), { _tag: "Some", value: RESULT });
});

test("exhausted ownership does not invoke the model", async () => {
  let calls = 0;
  const scheduler = oracle(async () => {
    calls++;
    throw new Error("must not invoke");
  });
  const graph = makeGraph();
  finite(graph, "work", []);
  await context({
    graph,
    scheduler: separate(() => false, scheduler, parallel()),
  }).run();
  assert.equal(calls, 0);
});

const invalidProtocol: readonly [string, AssistantMessage][] = [
  ["text-only", fauxAssistantMessage("done")],
  ["no calls", fauxAssistantMessage([], { stopReason: "toolUse" })],
  [
    "two calls",
    toolTurn(scheduleCall([["work"]], "one"), scheduleCall([["work"]], "two")),
  ],
  ["unknown tool", toolTurn(fauxToolCall("other", { waves: [["work"]] }))],
  [
    "wrong stop reason",
    fauxAssistantMessage(scheduleCall([["work"]], "one"), {
      stopReason: "stop",
    }),
  ],
];
for (const [name, response] of invalidProtocol)
  test(`rejects ${name} before graph work`, async () => {
    const { scheduler } = newScheduler([response]);
    const graph = makeGraph();
    const log: string[] = [];
    finite(graph, "work", log);
    const version = graph.observe().version;
    await assert.rejects(
      context({ graph, scheduler }).step(),
      DataflowDefinitionError,
    );
    assert.deepEqual(log, []);
    assert.equal(graph.observe().version, version);
  });

const invalidArguments: readonly Parameters<typeof fauxToolCall>[1][] = [
  {},
  { lanes: [["work"]] },
  { waves: [["work"]], lanes: [] },
  { waves: [[1]] },
  { waves: ["work"] },
  { waves: null },
  { waves: [[null]] },
];
for (const arguments_ of invalidArguments)
  test(`rejects invalid waves ${JSON.stringify(arguments_)} without coercion`, async () => {
    const { scheduler } = newScheduler([
      toolTurn(fauxToolCall("schedule", arguments_)),
    ]);
    const graph = makeGraph();
    const log: string[] = [];
    finite(graph, "work", log);
    const version = graph.observe().version;
    await assert.rejects(
      context({ graph, scheduler }).step(),
      DataflowDefinitionError,
    );
    assert.deepEqual(log, []);
    assert.equal(graph.observe().version, version);
  });

test("provider and native error settlements fail without fallback or work", async () => {
  const sentinel = new Error("provider failed");
  const cases: readonly [
    PiOptions["models"]["completeSimple"],
    string | Error,
  ][] = [
    [
      async () => {
        throw sentinel;
      },
      sentinel,
    ],
    [
      async () =>
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "native error",
        }),
      "native error",
    ],
    [
      async () => fauxAssistantMessage([], { stopReason: "aborted" }),
      "Scheduler model stopped with aborted",
    ],
  ];
  for (const [completeSimple, expected] of cases) {
    const graph = makeGraph();
    const log: string[] = [];
    finite(graph, "work", log);
    await assert.rejects(
      context({ graph, scheduler: oracle(completeSimple) }).step(),
      (error) =>
        expected instanceof Error
          ? error === expected
          : error instanceof Error && error.message === expected,
    );
    assert.deepEqual(log, []);
  }
});

test("non-serializable application metadata fails before invoking the provider", async () => {
  let calls = 0;
  const graph = makeGraph();
  finite(graph, "work", []);
  const execution = context({
    graph,
    describeNode: () => 1n,
    scheduler: oracle(async () => {
      calls++;
      return toolTurn(scheduleCall([["work"]], "never"));
    }),
  });
  await assert.rejects(execution.step(), TypeError);
  assert.equal(calls, 0);
  assert.equal(graph.getNode(id("work"))?.status, "ready");
});

test("cancellation drains a pending request, wins over provider failure and admits no work", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("cancel request");
  let cleaned = false;
  let calls = 0;
  const scheduler = oracle(async (_model, _request, options) => {
    calls++;
    assert.equal(options?.signal, controller.signal);
    started.resolve();
    try {
      await release.promise;
      throw new Error("provider failed after abort");
    } finally {
      cleaned = true;
    }
  });
  const graph = makeGraph();
  const log: string[] = [];
  finite(graph, "work", log);
  const execution = context({ graph, scheduler });
  let settled = false;
  const outcome = execution.step({ signal: controller.signal }).then(
    (value) => {
      settled = true;
      return { value, error: undefined };
    },
    (error: unknown) => {
      settled = true;
      return { value: undefined, error };
    },
  );
  try {
    await started.promise;
    await assert.rejects(
      context({ graph, scheduler }).step(),
      DataflowDefinitionError,
    );
    assert.equal(calls, 1);
    controller.abort(reason);
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(cleaned, false);
  } finally {
    release.resolve();
  }
  assert.equal((await outcome).error, reason);
  assert.equal(cleaned, true);
  assert.deepEqual(log, []);
});

test("abort after a model reply wins over malformed protocol", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel at settlement");
  const graph = makeGraph();
  const log: string[] = [];
  finite(graph, "work", log);
  const scheduler = oracle(async () => {
    controller.abort(reason);
    return fauxAssistantMessage("not a schedule");
  });
  await assert.rejects(
    context({ graph, scheduler }).step({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.deepEqual(log, []);
});

test("a failed native column drains its sibling and is retained in the next request history", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("node failed");
  const requests: SchedulerRequest<never>[] = [];
  const { scheduler } = newScheduler((request) => {
    requests.push(request);
    return runAvailable(request);
  });
  const graph = makeGraph();
  let cleaned = false;
  graph.addNode({
    id: id("fails"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      throw failure;
    },
  });
  graph.addNode({
    id: id("sibling"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      started.resolve();
      await release.promise;
      cleaned = true;
      yield [];
      return "sibling";
    },
  });
  const execution = context({ graph, scheduler });
  let settled = false;
  const outcome = execution.step().then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await started.promise;
    await nextTurn();
    assert.equal(settled, false);
  } finally {
    release.resolve();
  }
  const error = await outcome;
  assert.ok(error instanceof DataflowNodeError);
  assert.equal(error.cause, failure);
  assert.equal(cleaned, true);
  await execution.run();
  assert.deepEqual(requests[1]?.history, [
    {
      selected: [
        { nodeId: id("fails"), modelStrength: 2, readEdges: [] },
        { nodeId: id("sibling"), modelStrength: 2, readEdges: [] },
      ],
    },
  ]);
  assert.deepEqual(graph.result(id("sibling")), {
    _tag: "Some",
    value: "sibling",
  });
});

test("defined scalar metadata survives wire encoding and finite capacity stays numeric", async () => {
  for (const metadata of [0, false, null, ""] as const) {
    const requests: SchedulerRequest<typeof metadata>[] = [];
    const scheduler = oracle(async (_model, request) => {
      const snapshot = schedulerRequestOf<typeof metadata>(request);
      requests.push(snapshot);
      return toolTurn(scheduleCall(runAvailable(snapshot).waves, "scalar"));
    });
    const graph = new DataflowGraph<void, typeof StringSchema, string, never>(
      Width.create(1),
      Width.create(1),
    );
    finite(graph, "work", []);
    await context({ graph, scheduler, describeNode: () => metadata }).run();
    assert.ok(requests.every((request) => request.threads === 1));
    assert.deepEqual(
      requests.map((request) => request.context),
      [[["work", metadata]], [["work", metadata]]],
    );
  }
});

test("the Pi context reads selected queues in FIFO order without speculative matrix execution", async () => {
  const { scheduler } = newScheduler();
  const graph = makeGraph();
  const flow = Edge.message<typeof StringSchema, string>("flow", StringSchema);
  const batches: (readonly string[])[] = [];
  graph.addNode({
    id: id("source"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* () {
      yield ["1", "2", "3", "4", "5"].map((payload) => ({
        id: flow.id,
        payload,
      }));
      return "source";
    },
  });
  graph.addNode({
    id: id("worker"),
    state: undefined,
    trigger: TriggerRule.when(flow),
    step: async function* () {
      let view = yield [];
      let count = 0;
      for (;;) {
        const batch = view.messages.get(flow.id) ?? [];
        batches.push(batch);
        count += batch.length;
        if (count === 5) return "worker";
        view = yield [];
      }
    },
  });
  graph.addEdge(id("source"), id("worker"), flow);
  const execution = context({
    graph,
    scheduler,
    readInputs: (name, candidate) =>
      name === "worker"
        ? new Map([
            [
              flow.id,
              Math.min(2, candidate.view.messages.get(flow.id)?.length ?? 0),
            ],
          ])
        : new Map(),
  });
  assert.deepEqual(
    [...(await execution.run())],
    [
      ["source", "source"],
      ["worker", "worker"],
    ],
  );
  assert.deepEqual(batches, [["1", "2", "3", "4", "5"]]);
  assert.equal(graph.available().size, 0);
});

for (const mode of ["all", "any"] as const)
  test(`the Pi context preserves ${mode} trigger input semantics`, async () => {
    const { scheduler } = newScheduler();
    const graph = makeGraph();
    const left = Edge.message<typeof StringSchema, string>(
      "left",
      StringSchema,
    );
    const right = Edge.message<typeof StringSchema, string>(
      "right",
      StringSchema,
    );
    const batches: string[][] = [];
    const trigger =
      mode === "all"
        ? TriggerRule.allOf(TriggerEntry.on(left), TriggerEntry.on(right))
        : TriggerRule.anyOf(TriggerEntry.on(left), TriggerEntry.on(right));
    graph.addNode({
      id: id("source"),
      state: undefined,
      trigger: TriggerRule.always(),
      step: async function* () {
        yield [
          { id: left.id, payload: "left" },
          { id: right.id, payload: "right" },
        ];
        return "source";
      },
    });
    graph.addNode({
      id: id("worker"),
      state: undefined,
      trigger,
      step: async function* () {
        let view = yield [];
        let total = 0;
        for (;;) {
          const batch = [...view.messages.keys()].flatMap((edge) => [
            ...(view.messages.get(edge) ?? []),
          ]);
          batches.push(batch);
          total += batch.length;
          if (total === 2) return "worker";
          view = yield [];
        }
      },
    });
    graph.addEdge(id("source"), id("worker"), left);
    graph.addEdge(id("source"), id("worker"), right);
    await context({ graph, scheduler }).run();
    assert.deepEqual(
      batches,
      mode === "all" ? [["left", "right"]] : [["left"], ["right"]],
    );
  });
