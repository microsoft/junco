import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  captureUsageContext,
  DummyTracer,
  Edge,
  gigabytes,
  NodeId,
  type NodeOptions,
  TriggerEntry,
  TriggerRule,
  tokens,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import {
  AssistantMessageSchema,
  JuncoAgent,
  type TaskSchema,
} from "junco-agent";
import { LockPolicy, TaskTool } from "junco-tools";
import { Type } from "typebox";
import {
  type Agentic,
  Deterministic,
  JuncoGraph,
  MockAgent,
  schedules,
  graph as std,
} from "../src/index.ts";
import { terminalPorts, textOf, yieldsThen } from "./deterministic-support.ts";
import { NATIVE_TOOL_BLOCK, toolTurn } from "./support.ts";

type Policy = schedules.Scheduler<
  Agentic<typeof TaskSchema, AssistantMessage>,
  typeof TaskSchema,
  AssistantMessage,
  schedules.AgencyNodeMetadata
>;
const member = (
  name: string,
  agent: MockAgent,
  options: Partial<
    Pick<NodeOptions<typeof TaskSchema, AssistantMessage>, "is_available">
  > = {},
) => ({
  id: NodeId.create(name),
  state: agent,
  policy: LockPolicy,
  trigger: TriggerRule.always<typeof TaskSchema, AssistantMessage>(),
  ...options,
});
function recorded(inner: Policy): {
  readonly waves: string[][];
  readonly scheduler: Policy;
} {
  const waves: string[][] = [];
  return {
    waves,
    scheduler: async (s, signal) => {
      const d = await inner(s, signal);
      waves.push(schedules.nodeIds(d.selected));
      return d;
    },
  };
}
const memberWaves = (waves: string[][], names: string[]) =>
  waves
    .map((wave) => wave.filter((name) => names.includes(name)))
    .filter((wave) => wave.length > 0);

test("memory admission packs calibrated floors and isolates unmeasured mock members", async () => {
  const floors: Readonly<Record<string, number>> = {
    A: 3e9,
    B: 3e9,
    C: 2e9,
    D: 1e9,
  };
  const names = Object.keys(floors);
  for (const calibrated of [false, true]) {
    const { ports, graph } = agencyGraph();
    try {
      const members = names.map((name) =>
        graph.addNode(
          member(
            name,
            new MockAgent({ prompt: "go", runs: [yieldsThen(0, name)] }),
          ),
        ),
      );
      ports.connect(graph, members[3]!);
      const { waves, scheduler } = recorded(
        schedules.limit(
          {
            memory: gigabytes(4),
            ...(calibrated ? { memoryFloor: (id: string) => floors[id] } : {}),
          },
          schedules.parallel(),
        ),
      );
      const results = await schedules
        .context({
          graph,
          measurementWindows: new Map([["memory", 1]]),
          scheduler: (snapshot, signal) => {
            assert.equal(snapshot.measurements.size, 0);
            return scheduler(snapshot, signal);
          },
        })
        .run();
      if (calibrated)
        assert.deepEqual(memberWaves(waves, names), [
          ["A", "D"],
          ["A", "D"],
          ["B"],
          ["B"],
          ["C"],
          ["C"],
        ]);
      else assert.ok(waves.every((wave) => wave.length === 1));
      members.forEach((id, i) =>
        assert.equal(textOf(results.get(id)!), names[i]),
      );
      assert.equal(textOf(results.get(ports.sink.id)!), "D");
    } finally {
      await graph.close();
    }
  }
});

test("a scheduler's token estimates pick the cheapest racer; losers never start", async () => {
  const estimatedTokens: Readonly<Record<string, number>> = {
    R1: 900,
    R2: 100,
    R3: 300,
  };
  const names = Object.keys(estimatedTokens);
  const agents = names.map(
    (name) =>
      new MockAgent({
        prompt: "go",
        runs: [yieldsThen(0, name)],
      }),
  );
  const ports = terminalPorts();
  const graph = new JuncoGraph(
    ports.source,
    ports.sink,
    Width.create(1),
    UNBOUNDED,
    new DummyTracer(),
    LockPolicy,
  );
  let winner: string | undefined;
  try {
    const racers = names.map((name, i) => {
      const agent = agents[i]!;
      return graph.addNode(
        member(name, agent, {
          is_available: (_view, triggered) =>
            triggered && (winner === undefined || agent.status !== "ready"),
        }),
      );
    });
    const edges = names.map((name) =>
      Edge.value(`${name}->join`, AssistantMessageSchema),
    );
    const join = new Deterministic<typeof TaskSchema, AssistantMessage>(
      async function* () {
        const view = yield [];
        for (const edge of edges) {
          const value = view.values.get(edge.id);
          if (value !== undefined) {
            winner = textOf(value);
            return value;
          }
        }
        throw new Error("join fired without a value");
      },
      LockPolicy,
    );
    const joinId = graph.addNode({
      id: NodeId.create("join"),
      trigger: TriggerRule.anyOf(...edges.map((edge) => TriggerEntry.on(edge))),
      state: join,
    });
    racers.forEach((racer, i) => {
      graph.addEdge(racer, joinId, edges[i]!);
    });
    ports.connect(graph, joinId);
    const { waves, scheduler } = recorded(
      schedules.choose<
        Agentic<typeof TaskSchema, AssistantMessage>,
        typeof TaskSchema,
        AssistantMessage,
        schedules.AgencyNodeMetadata
      >({
        // Non-racer work (the join and ports) takes priority over starting another racer.
        rank: (_, a, b) =>
          (estimatedTokens[a] ?? -1) - (estimatedTokens[b] ?? -1),
        width: () => 1,
      }),
    );
    const results = await schedules.context({ graph, scheduler }).run();
    assert.deepEqual(memberWaves(waves, [...names, "join"]), [
      ["R2"],
      ["R2"],
      ["join"],
      ["join"],
    ]);
    assert.equal(textOf(results.get(joinId)!), "R2");
    assert.equal(agents[0]!.requests.length, 0);
    assert.equal(agents[2]!.requests.length, 0);
    assert.equal(results.has(racers[0]!), false);
    assert.equal(results.has(racers[2]!), false);
  } finally {
    await graph.close();
  }
});

test("agency ladders switch model and thinking before work, only when strength changes", async () => {
  const rung = { model: "p/default" };
  const ladder: schedules.Ladder = {
    smol: { model: "p/s", thinking: "low" },
    low: rung,
    med: rung,
    high: { model: "p/h/variant" },
    xhigh: rung,
  };
  for (const configured of [undefined, ladder]) {
    const agent = new MockAgent({
      prompt: "go",
      runs: [yieldsThen(1, "done")],
    });
    const ports = terminalPorts();
    const graph = new JuncoGraph(
      ports.source,
      ports.sink,
      Width.create(1),
      UNBOUNDED,
      new DummyTracer(),
      LockPolicy,
    );
    try {
      const id = graph.addNode(member("worker", agent));
      ports.connect(graph, id);
      const scheduler: Policy = schedules.strength(
        (snapshot) => (snapshot.history.length === 0 ? "smol" : "high"),
        schedules.parallel(),
      );
      const execution = schedules.context({
        graph,
        scheduler,
        ladder: configured,
      });
      const results = await execution.run();
      assert.equal(textOf(results.get(id)!), "done");
      assert.deepEqual(
        agent.calls
          .filter(
            ({ method }) =>
              method === "setModel" || method === "setThinkingLevel",
          )
          .map(({ method, args }) => [method, args]),
        configured === undefined
          ? []
          : [
              ["setModel", [{ provider: "p", modelId: "s" }]],
              ["setThinkingLevel", ["low"]],
              ["setModel", [{ provider: "p", modelId: "h/variant" }]],
              ["setThinkingLevel", ["off"]],
            ],
      );
    } finally {
      await graph.close();
    }
  }
});

// Usage limits on real agents --------------------------------------------------------------------

/** A caller-owned tool counting its executions. */
function countingTool() {
  const state = { executions: 0 };
  const tool: AgentTool = {
    name: "mock_tool",
    label: "mock_tool",
    description: "counts executions",
    parameters: Type.Object({}),
    execute: async () => {
      state.executions++;
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
  return { state, tool };
}

/** One Models registry; each `name` gets its own scripted faux provider. */
function providers(scripts: Record<string, readonly FauxResponseStep[]>) {
  const models = createModels();
  const faux = Object.fromEntries(
    Object.entries(scripts).map(([name, responses]) => {
      const provider = fauxProvider({ api: name, provider: name });
      provider.setResponses([...responses]);
      models.setProvider(provider.provider);
      return [name, provider];
    }),
  );
  return { models, faux };
}

/** A real agent on `provider`'s model, staged with a prompt. */
async function placed(
  models: ReturnType<typeof createModels>,
  provider: string,
  tools: AgentTool[],
) {
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  const agent = await JuncoAgent.fromResolved({
    session,
    models,
    model: models.getModels(provider)[0]!,
    systemPrompt: "sys",
    tools,
    tool_block: NATIVE_TOOL_BLOCK,
    prompt: "go",
  });
  return { agent, session };
}

function agencyGraph() {
  const ports = terminalPorts();
  const graph = new JuncoGraph(
    ports.source,
    ports.sink,
    Width.create(1),
    UNBOUNDED,
    new DummyTracer(),
    LockPolicy,
  );
  return { ports, graph };
}

const memberOf = (name: string, agent: JuncoAgent) => ({
  id: NodeId.create(name),
  trigger: TriggerRule.always<typeof TaskSchema, AssistantMessage>(),
  policy: LockPolicy,
  state: agent,
});

async function usageFailure(work: Promise<unknown>) {
  const error = await work.then(
    () => assert.fail("expected a usage limit failure"),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof std.UsageLimitError, String(error));
  assert.equal(error.code, "JUNCO_USAGE_LIMIT_EXCEEDED");
  return error;
}

test("an outer evaluation budget spans native task subagents and its exhaustion is never retried", async () => {
  const mock = countingTool();
  const { models, faux } = providers({
    caller: [
      toolTurn(
        fauxToolCall(
          "task",
          {
            context: "ctx",
            tasks: [
              {
                name: "w",
                task: "work",
                model: { provider: "worker", modelId: "faux-1" },
              },
            ],
          },
          { id: "t1" },
        ),
      ),
      ...Array.from({ length: 8 }, () => fauxAssistantMessage("waiting")),
    ],
    worker: [
      toolTurn(fauxToolCall("mock_tool", {}, { id: "m1" })),
      toolTurn(fauxToolCall("mock_tool", {}, { id: "m2" })),
      fauxAssistantMessage("report"),
      toolTurn(fauxToolCall("mock_tool", {}, { id: "retry" })),
      fauxAssistantMessage("report"),
    ],
  });
  assert.equal(faux.worker!.getModel().id, "faux-1");
  const { agent: caller } = await placed(models, "caller", [
    new TaskTool(),
    mock.tool,
  ]);
  caller.setTaskFailurePolicy({ retries: 2 });
  let acquired = 0;
  caller.setSubagentObserver({ acquired: () => acquired++ });
  const { ports, graph } = agencyGraph();
  try {
    ports.connect(graph, graph.addNode(memberOf("caller", caller)));
    const error = await usageFailure(
      schedules
        .context({
          graph,
          scheduler: schedules.limit({ tools: 2 }, schedules.parallel()),
        })
        .run(),
    );
    // The caller's task call and the worker's first call; the second never ran.
    assert.equal(mock.state.executions, 1);
    assert.equal(acquired, 1);
    assert.equal(faux.worker!.state.callCount, 2);
    const { details } = error;
    assert.equal(details.resource, "tools");
    assert.equal(details.scope, "evaluation");
    assert.equal(details.used, 2);
    assert.equal(details.nodePath[0], "caller");
    assert.match(details.nodePath[1] ?? "", /^task-/);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), {
      code: "JUNCO_USAGE_LIMIT_EXCEEDED",
      message: error.message,
      ...details,
    });
  } finally {
    await graph.close();
    await caller.return();
  }
});

test("nested activation and evaluation limits each count every agent call exactly once", async () => {
  const mocks = [countingTool(), countingTool(), countingTool()];
  const call = (id: string) => fauxToolCall("mock_tool", {}, { id });
  const { models } = providers({
    a: [toolTurn(call("a1")), fauxAssistantMessage("a")],
    b: [toolTurn(call("b1")), fauxAssistantMessage("b")],
    c: [toolTurn(call("c1"), call("c2")), fauxAssistantMessage("c")],
  });
  const { ports, graph } = agencyGraph();
  const agents: JuncoAgent[] = [];
  try {
    for (const [index, name] of ["a", "b", "c"].entries()) {
      const { agent } = await placed(models, name, [mocks[index]!.tool]);
      agents.push(agent);
      const id = graph.addNode(memberOf(name, agent));
      if (name === "c") ports.connect(graph, id);
    }
    const error = await usageFailure(
      schedules
        .context({
          graph,
          scheduler: schedules.limit(
            { tools: 4 },
            schedules.limit(
              { tools: 1, scope: "activation" },
              schedules.parallel(),
            ),
          ),
        })
        .run(),
    );
    assert.deepEqual(
      mocks.map(({ state }) => state.executions),
      [1, 1, 1],
    );
    assert.equal(error.details.scope, "activation");
    assert.deepEqual(error.details.nodePath, ["c"]);
  } finally {
    await graph.close();
    await Promise.all(agents.map((agent) => agent.return()));
  }
});

test("an evaluation tool cap denies the call past it before its body; an adequate cap keeps the fixed result", async () => {
  for (const cap of [2, 3]) {
    const mock = countingTool();
    const call = (id: string) => fauxToolCall("mock_tool", {}, { id });
    const { models, faux } = providers({
      solo: [
        toolTurn(call("m1")),
        toolTurn(call("m2")),
        toolTurn(call("m3")),
        fauxAssistantMessage("final"),
      ],
    });
    const { agent } = await placed(models, "solo", [mock.tool]);
    const { ports, graph } = agencyGraph();
    try {
      const id = graph.addNode(memberOf("solo", agent));
      ports.connect(graph, id);
      const run = schedules
        .context({
          graph,
          scheduler: schedules.limit({ tools: cap }, schedules.parallel()),
        })
        .run();
      if (cap === 2) {
        const error = await usageFailure(run);
        assert.equal(mock.state.executions, 2);
        assert.equal(error.details.resource, "tools");
        assert.equal(error.details.scope, "evaluation");
        assert.equal(error.details.used, 2);
        assert.deepEqual(error.details.nodePath, ["solo"]);
        // The denied third call ends the run: no further model request follows.
        assert.equal(faux.solo!.state.callCount, 3);
      } else {
        const results = await run;
        assert.equal(mock.state.executions, 3);
        assert.equal(textOf(results.get(id)!), "final");
      }
    } finally {
      await graph.close();
      await agent.return();
    }
  }
});

test("admitted parallel requests finish and count; no peer starts new work after the shared failure", async () => {
  const mocks = [countingTool(), countingTool()];
  const { models, faux } = providers({
    a: [
      toolTurn(fauxToolCall("mock_tool", {}, { id: "a1" })),
      fauxAssistantMessage("a"),
    ],
    b: [
      toolTurn(fauxToolCall("mock_tool", {}, { id: "b1" })),
      fauxAssistantMessage("b"),
    ],
  });
  const { ports, graph } = agencyGraph();
  const members: Awaited<ReturnType<typeof placed>>[] = [];
  // Both first requests pass admission at zero usage before either commits.
  const dispatched = Promise.withResolvers<void>();
  let waiting = 0;
  let ledger: { readonly usedTokens: number } | undefined;
  try {
    for (const [index, name] of ["a", "b"].entries()) {
      const member = await placed(models, name, [mocks[index]!.tool]);
      members.push(member);
      member.agent.hooks.on("before_request", async () => {
        // Native work runs in its admission context: the activation's ledgers.
        ledger ??= captureUsageContext()?.budgets[0];
        if (++waiting === 2) dispatched.resolve();
        await dispatched.promise;
        return undefined;
      });
      const id = graph.addNode(memberOf(name, member.agent));
      if (name === "b") ports.connect(graph, id);
    }
    const error = await usageFailure(
      schedules
        .context({
          graph,
          scheduler: schedules.limit(
            { tokens: tokens(1) },
            schedules.parallel(),
          ),
        })
        .run(),
    );
    assert.equal(error.details.resource, "tokens");
    assert.deepEqual(
      mocks.map(({ state }) => state.executions),
      [0, 0],
    );
    assert.deepEqual(
      [faux.a!.state.callCount, faux.b!.state.callCount],
      [1, 1],
    );
    let committed = 0;
    for (const { session } of members)
      committed += (await session.getStats(BACKGROUND_CONTEXT)).usage
        .totalTokens;
    assert.ok(ledger !== undefined);
    assert.equal(ledger.usedTokens, committed);
  } finally {
    await graph.close();
    await Promise.all(members.map(({ agent }) => agent.return()));
  }
});
