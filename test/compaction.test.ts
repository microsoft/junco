import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AgentMessage,
  type AgentTool,
  estimateTokens,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  Edge,
  Message,
  NodeId,
  type NodeIdType,
  Sink,
  Source,
  TriggerRule,
} from "dataflow-engine";
import { JuncoAgentError } from "junco-agent";
import { LockPolicy } from "junco-tools";
import {
  type CompactionPolicy,
  Deterministic,
  JuncoGraph,
  MockAgent,
  type MockMaintenance,
  type MockTranscript,
  TaskSchema,
} from "../src/index.ts";
import {
  addPromptRun,
  assistant,
  plainContext,
  resultText,
  run,
  settle,
  terminalPorts,
  user,
  userTexts,
  yieldsThen,
} from "./deterministic-support.ts";
import { flushMacrotasks } from "./support.ts";

// Graph compaction policies over real dataflow graphs of MockAgent members whose scripted
// compaction replaces history with `user("x")` (one token). Every model has a 100-token window.

const model = (contextWindow: number): Model<Api> => ({
  id: "mock",
  name: "mock",
  api: "mock",
  provider: "mock",
  baseUrl: "",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow,
  maxTokens: 10,
});
const COMPACTED: MockMaintenance = {
  method: "compact",
  args: [],
  result: { ok: true },
  history: [user("x")],
};

/** History of exactly `tokens` estimated tokens: four characters per token. */
const seeded = (tokens: number): AgentMessage[] =>
  tokens === 0 ? [] : [user("t".repeat(4 * tokens))];

/** A member measuring `tokens` against `window` (`null`: no model), whose single compaction succeeds. */
function member(
  tokens: number,
  transcript: Partial<MockTranscript<Skill, PromptTemplate, AgentTool>> = {},
  window: number | null = 100,
): MockAgent {
  return new MockAgent({
    history: seeded(tokens),
    maintenance: [COMPACTED],
    runs: [],
    ...(window === null
      ? {}
      : {
          models: [model(window)],
          model: { provider: "mock", modelId: "mock" },
        }),
    ...transcript,
  });
}

const node = (agent: MockAgent, id: string) => ({
  id: NodeId.create(id),
  state: agent,
  policy: LockPolicy,
  description: id,
  prompt: id,
  trigger: TriggerRule.always(),
});

/**
 * Available a=40, b=41, f=20; c=39 waits for input; d=70 has a never trigger;
 * e=90 consumed its only assignment before the others were added.
 */
async function compactionFixture() {
  const graphPorts = terminalPorts();
  const graphContext = plainContext(
    graphPorts.source,
    graphPorts.sink,
    "round-robin",
  );
  const graph = graphContext.graph;
  const finished = assistant("e done");
  const e = member(90 - estimateTokens(user("e")) - estimateTokens(finished), {
    runs: [run([settle(finished)])],
  });
  const eId = addPromptRun(graph, e, "e");
  graphPorts.connect(graph, eId);
  await graphContext.run();
  assert.equal(resultText(graph, eId), "e done");
  assert.equal(await e.context_size(), 90);

  const scripted = (tokens: number, name: string) =>
    member(tokens, {
      runs: [run([settle(assistant(`${name} done`))])],
    });
  const agents = {
    a: scripted(40, "a"),
    b: scripted(41, "b"),
    c: scripted(39, "c"),
    d: scripted(70, "d"),
    e,
    f: scripted(20, "f"),
  };
  const ids = {
    a: addPromptRun(graph, agents.a, "a"),
    b: addPromptRun(graph, agents.b, "b"),
  } as Record<keyof typeof agents, NodeIdType>;
  const never = Edge.message<typeof TaskSchema, AssistantMessage>(
    "d->c",
    TaskSchema,
  );
  ids.c = graph.addNode({
    ...node(agents.c, "c"),
    trigger: TriggerRule.when(never),
  });
  ids.d = graph.addNode({
    ...node(agents.d, "d"),
    trigger: TriggerRule.never(),
  });
  ids.e = eId;
  ids.f = addPromptRun(graph, agents.f, "f");
  graph.addEdge(ids.d, ids.c, never);
  assert.deepEqual([...graph.available().keys()], [ids.a, ids.b, ids.f]);
  return { graph, graphContext, agents, ids };
}

const POLICIES: readonly (readonly [CompactionPolicy, readonly string[]])[] = [
  ["all", ["a", "b", "c", "d", "e", "f"]],
  ["more-than-forty", ["b", "d", "e"]],
  ["all-available", ["a", "b", "f"]],
  ["more-than-forty-available", ["b"]],
];

describe("policy selection", () => {
  for (const [name, expected] of POLICIES) {
    test(`${name} compacts exactly ${expected.join(",")} and leaves graph state to normal execution`, async () => {
      const { graph, graphContext, agents, ids } = await compactionFixture();
      const before = Object.fromEntries(
        await Promise.all(
          Object.entries(agents).map(
            async ([key, agent]) => [key, await agent.context_size()] as const,
          ),
        ),
      );
      assert.equal(await JuncoGraph.compact(graph, name), undefined);

      for (const [key, agent] of Object.entries(agents)) {
        const changed = expected.includes(key);
        assert.equal(
          await agent.context_size(),
          changed ? 1 : before[key],
          `context of ${key}`,
        );
        assert.equal(
          agent.calls.filter((call) => call.method === "compact").length,
          changed ? 1 : 0,
          `requests of ${key}`,
        );
        // Compaction must not start any new prompt run.
        assert.equal(agent.requests.length, key === "e" ? 1 : 0);
      }
      assert.deepEqual([...graph.available().keys()], [ids.a, ids.b, ids.f]);

      await graphContext.run();
      assert.equal(resultText(graph, ids.e), "e done");
      for (const key of ["a", "b", "f"] as const) {
        assert.equal(resultText(graph, ids[key]), `${key} done`);
        assert.deepEqual(
          userTexts(agents[key].requests[0]!.messages)[0],
          expected.includes(key) ? "x" : "t".repeat(4 * before[key]!),
        );
      }
      for (const key of ["c", "d"] as const)
        assert.equal(resultText(graph, ids[key]), undefined);
    });
  }
});

describe("policy boundaries", () => {
  test("an empty graph or selection completes without requests", async () => {
    for (const [policy] of POLICIES) {
      const source = new Source<typeof TaskSchema, AssistantMessage>(
        () => {
          throw new DataflowDefinitionError(
            "Empty compaction graph does not accept external input",
          );
        },
        { id: NodeId.create("$source"), schema: TaskSchema },
      );
      const sink = new Sink<typeof TaskSchema, AssistantMessage>(
        async function* () {
          throw new Error("Empty compaction graph has no terminal result");
        },
        {
          id: NodeId.create("$sink"),
          schema: TaskSchema,
          trigger: TriggerRule.never(),
        },
      );
      const execution = plainContext(source, sink, "parallel");
      assert.equal(
        await JuncoGraph.compact(execution.graph, policy),
        undefined,
      );
    }
    const graphPorts = terminalPorts();
    const graphContext = plainContext(
      graphPorts.source,
      graphPorts.sink,
      "parallel",
    );
    const graph = graphContext.graph;
    // No compaction record: a wrongly selected member would reject.
    const quiet = member(40, { maintenance: [] });
    const quietId = graph.addNode(node(quiet, "quiet"));
    graphPorts.connect(graph, quietId);
    assert.equal(await JuncoGraph.compact(graph, "more-than-forty"), undefined);
    assert.equal(
      await JuncoGraph.compact(graph, "more-than-forty-available"),
      undefined,
    );
    assert.equal(await quiet.context_size(), 40);
  });

  test("an unknown policy rejects before inspecting the graph", async () => {
    const graphPorts = terminalPorts();
    const graphContext = plainContext(
      graphPorts.source,
      graphPorts.sink,
      "parallel",
    );
    const graph = graphContext.graph;
    const full = member(90);
    const fullId = graph.addNode(node(full, "full"));
    graphPorts.connect(graph, fullId);
    await assert.rejects(
      // @ts-expect-error the runtime boundary rejects a selector outside CompactionPolicy
      JuncoGraph.compact(graph, "most"),
      (error: unknown) => {
        assert.ok(error instanceof JuncoAgentError);
        assert.equal(error.code, "invalid_argument");
        return true;
      },
    );
    assert.equal(await full.context_size(), 90);
    assert.deepEqual(userTexts(full.history), ["t".repeat(360)]);
    assert.deepEqual(full.calls, []);
  });

  test("an unknown context window rejects a threshold policy before any history changes", async () => {
    for (const window of [null, 0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const graphPorts = terminalPorts();
      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        "parallel",
      );
      const graph = graphContext.graph;
      const full = member(90);
      const unknown = member(90, {}, window);
      const fullId = graph.addNode(node(full, "full"));
      graphPorts.connect(graph, fullId);
      graph.addNode(node(unknown, "unknown"));
      for (const policy of [
        "more-than-forty",
        "more-than-forty-available",
      ] as const) {
        await assert.rejects(
          JuncoGraph.compact(graph, policy),
          (error: unknown) => {
            assert.ok(error instanceof JuncoAgentError);
            assert.equal(error.code, "invalid_state");
            return true;
          },
        );
      }
      assert.equal(await full.context_size(), 90);
      assert.deepEqual(full.calls, []);
    }
  });

  test("available-only policies never measure unavailable members", async () => {
    class Measured extends MockAgent {
      modelReads = 0;
      override getModel() {
        this.modelReads++;
        return super.getModel();
      }
    }
    const graphPorts = terminalPorts();
    const graphContext = plainContext(
      graphPorts.source,
      graphPorts.sink,
      "parallel",
    );
    const graph = graphContext.graph;
    const available = member(90, {
      runs: [yieldsThen(0, "done")],
    });
    // Without a model it could not be measured at all.
    const hidden = new Measured({
      history: seeded(90),
      runs: [],
    });
    const availableId = graph.addNode(node(available, "available"));
    graphPorts.connect(graph, availableId);
    graph.addNode({ ...node(hidden, "hidden"), trigger: TriggerRule.never() });
    assert.equal(
      await JuncoGraph.compact(graph, "more-than-forty-available"),
      undefined,
    );
    assert.equal(hidden.modelReads, 0);
    assert.equal(await available.context_size(), 1);
    assert.equal(await hidden.context_size(), 90);
  });

  test("selection is the invocation snapshot, not readiness after measurement", async () => {
    const gate = Promise.withResolvers<void>();
    const measuring = Promise.withResolvers<void>();
    class Gated extends MockAgent {
      override async context_size() {
        measuring.resolve();
        await gate.promise;
        return super.context_size();
      }
    }
    const early = new Gated({
      history: seeded(90),
      models: [model(100)],
      model: { provider: "mock", modelId: "mock" },
      maintenance: [COMPACTED],
      runs: [yieldsThen(0, "early done")],
    });
    const late = member(90);
    const graphPorts = terminalPorts();
    const graphContext = plainContext(
      graphPorts.source,
      graphPorts.sink,
      "parallel",
    );
    const graph = graphContext.graph;
    const earlyId = addPromptRun(graph, early, "early");
    const release = Edge.message<typeof TaskSchema, AssistantMessage>(
      "release",
      TaskSchema,
    );
    const lateId = graph.addNode({
      ...node(late, "late"),
      trigger: TriggerRule.when(release),
    });
    graph.addEdge(graph.source.id, lateId, release);
    graphPorts.connect(graph, earlyId);
    const compaction = JuncoGraph.compact(graph, "more-than-forty-available");
    await measuring.promise;
    await graphContext.step(); // prime early
    await graphContext.step(); // consume its only assignment
    graph.emit(
      graph.source.id,
      Message.create(release, {
        kind: "prompt",
        text: "start",
        taskId: "late",
        spec: "",
        deps: [],
        history: [],
      }),
    );
    assert.ok(!graph.available().has(earlyId) && graph.available().has(lateId));
    gate.resolve();
    assert.equal(await compaction, undefined);
    assert.equal(await early.context_size(), 1);
    assert.equal(await late.context_size(), 90);
  });

  test("a later idle member compacts while an earlier selected member is still yielded", async () => {
    const graphPorts = terminalPorts();
    const graphContext = plainContext(
      graphPorts.source,
      graphPorts.sink,
      "round-robin",
    );
    const graph = graphContext.graph;
    const held = member(50, {
      runs: [yieldsThen(1, "held done")],
    });
    const idle = member(50);
    const heldId = addPromptRun(graph, held, "held", "hold");
    graph.addNode({ ...node(idle, "idle"), trigger: TriggerRule.never() });
    graphPorts.connect(graph, heldId);
    for (let windows = 0; held.status !== "suspended"; windows++) {
      assert.ok(windows < 8, "member never yielded");
      await graphContext.step();
    }
    const compaction = JuncoGraph.compact(graph, "all");
    void compaction.catch(() => undefined);
    await flushMacrotasks();
    assert.equal(await idle.context_size(), 1);
    assert.equal(held.status, "suspended");
    assert.deepEqual(userTexts(held.history), ["t".repeat(200), "hold"]);

    // Driving the graph lets the held run settle normally; its compaction follows.
    await graphContext.run();
    assert.equal(await compaction, undefined);
    assert.equal(resultText(graph, heldId), "held done");
    assert.deepEqual(userTexts(held.history), ["x"]);
  });

  test("every selected request finishes; failures aggregate in request order", async () => {
    const first = new Error("first failed");
    const second = new Error("second failed");
    const failing = (error: Error) =>
      member(90, {
        maintenance: [
          { method: "compact", args: [], result: { ok: false, error } },
        ],
      });
    const graphPorts = terminalPorts();
    const graphContext = plainContext(
      graphPorts.source,
      graphPorts.sink,
      "parallel",
    );
    const graph = graphContext.graph;
    const a = failing(first);
    const b = member(90);
    const c = failing(second);
    graph.addNode(node(a, "a"));
    const bId = graph.addNode(node(b, "b"));
    graphPorts.connect(graph, bId);
    graph.addNode(node(c, "c"));
    await assert.rejects(JuncoGraph.compact(graph, "all"), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, second]);
      return true;
    });
    assert.equal(await b.context_size(), 1);
    assert.equal(await a.context_size(), 90);
    assert.equal(await c.context_size(), 90);
  });

  test("heterogeneous graphs compact only direct prompt agents; nested graphs and coroutines are skipped", async () => {
    class Measured extends MockAgent {
      reads = 0;
      override context_size() {
        this.reads++;
        return super.context_size();
      }
      override getModel() {
        this.reads++;
        return super.getModel();
      }
    }
    /**
     * Adds a nested graph whose full, available member would reject any compaction, and a
     * coroutine, to `graph`.
     */
    const addSkipped = (graph: JuncoGraph) => {
      const inner = new Measured({
        history: seeded(90),
        models: [model(100)],
        model: { provider: "mock", modelId: "mock" },
        maintenance: [],
        runs: [yieldsThen(0, "inner done")],
      });
      const childPorts = terminalPorts();
      const childContext = plainContext(
        childPorts.source,
        childPorts.sink,
        "parallel",
      );
      const child = childContext.graph;
      const innerId = addPromptRun(child, inner, "inner");
      const coroutine = new Deterministic<typeof TaskSchema, AssistantMessage>(
        async function* () {
          started.add(coroutine);
          yield [];
          return assistant("coroutine done");
        },
        LockPolicy,
      );
      childPorts.connect(child, innerId);
      const childId = graph.addNode({
        id: NodeId.create("child"),
        trigger: TriggerRule.always(),
        state: childContext,
      });
      const coroutineId = graph.addNode({
        id: NodeId.create("coroutine"),
        trigger: TriggerRule.always(),
        state: coroutine,
      });
      return { inner, child, coroutine, childId, coroutineId };
    };
    const started = new Set<Deterministic>();

    for (const [name, expected] of POLICIES) {
      // Without a compactable direct state, nothing is measured or requested.
      const barePorts = terminalPorts();
      const bareContext = plainContext(
        barePorts.source,
        barePorts.sink,
        "parallel",
      );
      const bare = bareContext.graph;
      const alone = addSkipped(bare);
      barePorts.connect(bare, alone.childId);
      assert.equal(bare.available().size, 2, name);
      assert.equal(await JuncoGraph.compact(bare, name), undefined, name);
      assert.equal(alone.inner.reads, 0, name);
      assert.deepEqual(alone.inner.calls, [], name);

      const graphPorts = terminalPorts();

      const graphContext = plainContext(
        graphPorts.source,
        graphPorts.sink,
        "parallel",
      );

      const graph = graphContext.graph;
      const nested = addSkipped(graph);
      const { childId, coroutineId } = nested;
      const full = member(90, {
        runs: [yieldsThen(0, "full done")],
      });
      const small = member(20, {
        runs: [yieldsThen(0, "small done")],
      });
      const fullId = addPromptRun(graph, full, "full");
      const smallId = addPromptRun(graph, small, "small");
      graphPorts.connect(graph, fullId);
      assert.equal(graph.available().size, 4, name);
      assert.equal(await JuncoGraph.compact(graph, name), undefined, name);

      // POLICIES' fixture compacts b (41 tokens) under every policy and f (20) only without a threshold.
      assert.equal(await full.context_size(), 1, name);
      assert.equal(
        await small.context_size(),
        expected.includes("f") ? 1 : 20,
        name,
      );
      assert.equal(nested.inner.reads, 0, name);
      assert.deepEqual(nested.inner.calls, [], name);
      assert.ok(
        !started.has(alone.coroutine) && !started.has(nested.coroutine),
        name,
      );
      assert.equal(graph.getNode(childId)!.state, nested.child);
      assert.equal(graph.getNode(coroutineId)!.state, nested.coroutine);

      // The skipped states then execute normally, the nested member with its uncompacted history.
      await graphContext.run();
      assert.deepEqual(
        [childId, coroutineId, fullId, smallId].map((id) =>
          resultText(graph, id),
        ),
        ["inner done", "coroutine done", "full done", "small done"],
        name,
      );
      assert.deepEqual(
        userTexts(nested.inner.requests[0]!.messages),
        ["t".repeat(360), "inner"],
        name,
      );
    }
  });
});
