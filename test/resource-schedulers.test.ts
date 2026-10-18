import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DataflowDefinitionError, DummyTracer, Edge, NodeId, TriggerEntry, TriggerRule, UNBOUNDED, Width, megabytes, gigabytes, tokens, type NodeOptions, type ProfileSet } from "dataflow-engine";
import { LockPolicy } from "junco-tools";
import { JuncoAgentError } from "junco-agent";
import { MockAgent, MockJuncoGraph, JuncoGraph, Deterministic, schedulers, type Agentic, type AgenticInput } from "../src/index.ts";
import { terminalPorts, yieldsThen, textOf } from "./deterministic-support.ts";

type Policy = schedulers.Scheduler<Agentic<AgenticInput, AssistantMessage>, AgenticInput, AssistantMessage, schedulers.AgencyNodeMetadata>;
const member = (name: string, agent: MockAgent, options: Partial<Pick<NodeOptions<AgenticInput, AssistantMessage>, "is_available">> = {}) => ({ id: NodeId.create(name), state: agent, policy: LockPolicy, trigger: TriggerRule.always<AgenticInput, AssistantMessage>(), ...options });
function recorded(inner: Policy): { readonly waves: string[][]; readonly scheduler: Policy } {
  const waves: string[][] = [];
  return { waves, scheduler: async (s, signal) => { const d = await inner(s, signal); waves.push([...d.selected]); return d; } };
}
const memberWaves = (waves: string[][], names: string[]) => waves.map(wave => wave.filter(name => names.includes(name))).filter(wave => wave.length > 0);

// Profiles describe mock usage, not the harness resources in MockTranscript.resources.
test("MockAgent usage becomes constant node profiles", async () => {
  const agent = new MockAgent({ runs: [], usage: { memory: megabytes(3000), tokens: tokens(100) } });
  const empty = new MockAgent({ runs: [] });
  const ports = terminalPorts();
  const graph = new MockJuncoGraph(ports.source, ports.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
  try {
    assert.equal(agent.profiles.memory!.unit, megabytes);
    assert.equal(agent.profiles.memory!.predict([]).safe, 3000);
    const estimate = agent.profiles.tokens!.predict([]);
    assert.equal(estimate.safe, 100);
    assert.equal(estimate.source, "fallback");
    assert.equal(estimate.reason, "constant");
    assert.equal(agent.profiles.tokens!.predict([]), estimate);
    assert.ok(Object.isFrozen(estimate));
    assert.deepEqual(empty.profiles, {});
    for (const amount of [-1, NaN, Infinity])
      assert.throws(() => new MockAgent({ runs: [], usage: { memory: megabytes(amount) } }), (error: unknown) => error instanceof JuncoAgentError && error.code === "invalid_argument");
    const node = graph.addNode(member("empty", empty));
    assert.equal((graph.getNode(node)!.profiles as ProfileSet).memory!.predict([]).safe, 0);
    assert.equal((graph.getNode(graph.sink.id)!.profiles as ProfileSet).tokens!.predict([]).safe, 0);
  } finally {
    await graph.close();
    await agent.return();
  }
});

for (const Graph of [MockJuncoGraph, JuncoGraph]) {
  const mocked = Graph === MockJuncoGraph;
  test(mocked ? "mock members under a memory limit never share a column beyond 4 GB" : "a plain JuncoGraph's ports are unprofiled, so limit rejects them", async () => {
    const names = ["A", "B", "C", "D"];
    const agents = names.map((name, i) => new MockAgent({ prompt: "go", runs: [yieldsThen(0, name)], usage: { memory: megabytes([3000, 3000, 2000, 1000][i]!) } }));
    const ports = terminalPorts();
    const graph = new Graph(ports.source, ports.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
    try {
      const members = names.map((name, i) => graph.addNode({ ...member(name, agents[i]!), ...(mocked ? {} : { profiles: agents[i]!.profiles }) }));
      ports.connect(graph, members[3]!);
      const limited: Policy = schedulers.limit<Agentic<AgenticInput, AssistantMessage>, AgenticInput, AssistantMessage, schedulers.AgencyNodeMetadata>({ memory: gigabytes(4) }, schedulers.parallel());
      if (mocked) {
        const { waves, scheduler } = recorded(limited);
        const results = await schedulers.context({ graph, scheduler }).run();
        assert.deepEqual(memberWaves(waves, names), [["A", "D"], ["A", "D"], ["B"], ["B"], ["C"], ["C"]]);
        assert.ok(waves.every(wave => !(wave.includes("A") && wave.includes("B"))));
        members.forEach((node, i) => assert.equal(textOf(results.get(node)!), names[i]));
        assert.equal(textOf(results.get(ports.sink.id)!), "D");
      } else {
        await assert.rejects(() => schedulers.context({ graph, scheduler: limited }).run(), (error: unknown) => error instanceof DataflowDefinitionError && error.message.includes('"$sink"') && error.message.includes("has no memory profile"));
      }
    } finally {
      await graph.close();
    }
  });
}

test("the cheapest mock racer reaches an anyOf consumer; losers never start", async () => {
  const names = ["R1", "R2", "R3"];
  const agents = names.map((name, i) => new MockAgent({ prompt: "go", runs: [yieldsThen(0, name)], usage: { tokens: tokens([900, 100, 300][i]!) } }));
  const ports = terminalPorts();
  const graph = new MockJuncoGraph(ports.source, ports.sink, Width.create(1), UNBOUNDED, new DummyTracer(), LockPolicy);
  let winner: string | undefined;
  try {
    const racers = names.map((name, i) => {
      const agent = agents[i]!;
      return graph.addNode(member(name, agent, { is_available: (_view, triggered) => triggered && (winner === undefined || agent.status !== "ready") }));
    });
    const edges = names.map(name => Edge.value<AgenticInput, AssistantMessage>(`${name}->join`));
    const join = new Deterministic<AgenticInput, AssistantMessage>(async function* () {
      const view = yield [];
      for (const edge of edges) {
        const value = view.values.get(edge.id);
        if (value !== undefined) { winner = textOf(value); return value; }
      }
      throw new Error("join fired without a value");
    }, LockPolicy);
    const joinId = graph.addNode({ id: NodeId.create("join"), trigger: TriggerRule.anyOf(...edges.map(edge => TriggerEntry.on(edge))), state: join });
    racers.forEach((racer, i) => graph.addEdge(racer, joinId, edges[i]!));
    ports.connect(graph, joinId);
    const { waves, scheduler } = recorded(schedulers.choose<Agentic<AgenticInput, AssistantMessage>, AgenticInput, AssistantMessage, schedulers.AgencyNodeMetadata>({ rank: schedulers.lowest("tokens"), width: () => 1 }));
    const results = await schedulers.context({ graph, scheduler }).run();
    assert.deepEqual(memberWaves(waves, [...names, "join"]), [["R2"], ["R2"], ["join"], ["join"]]);
    assert.equal(textOf(results.get(joinId)!), "R2");
    assert.equal(agents[0]!.requests.length, 0);
    assert.equal(agents[2]!.requests.length, 0);
    assert.equal(results.has(racers[0]!), false);
    assert.equal(results.has(racers[2]!), false);
  } finally {
    await graph.close();
  }
});
