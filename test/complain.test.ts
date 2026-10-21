import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AssistantMessage,
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DummyTracer, type NodeIdType } from "dataflow-engine";
import { LockPolicy } from "junco-tools";
import {
  type AgenticInput,
  agent as agentApi,
  Deterministic,
  graph,
  JuncoGraph,
  MockAgent,
  schedules,
  tools,
  trigger,
} from "../src/index.ts";
import { terminalPorts } from "./deterministic-support.ts";
import { nativeOptions } from "./support.ts";

// Real JuncoAgents on faux providers inside real graphs: the always-on complain tool records the
// activation's node, delivered batch and full request in the one shared issue log, and only the
// owning graph's tracer observes it.

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse())
    await close().catch(() => {});
});

class RecordingTracer extends DummyTracer {
  readonly complaints: [NodeIdType, string][] = [];
  override complain(nodeId: NodeIdType, complaint: string): void {
    this.complaints.push([nodeId, complaint]);
  }
}

class ThrowingTracer extends DummyTracer {
  override complain(): void {
    throw new Error("observer failed");
  }
}

const input: AgenticInput = {
  kind: "prompt",
  text: "Contact the coordinator.",
};

/** A real agent that receives its inbox, complains `complaint` once and then answers "continued". */
async function worker(
  complaint: string,
  systemPrompt: string = "complaint system",
) {
  const { options } = await nativeOptions([
    fauxAssistantMessage([fauxToolCall("recv", {}, { id: "recv-1" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      [fauxToolCall("complain", { complaint }, { id: "complaint-1" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("continued"),
  ]);
  const member = await agentApi.JuncoAgent.fromResolved({
    ...options,
    systemPrompt,
    tools: [new tools.RecvTool()],
  });
  closers.push(() => member.return());
  return member;
}

/** The user and tool-result texts of a complaint's request snapshot. */
const promptTexts = (issue: tools.Issue) =>
  issue.prompt.messages.flatMap((message) =>
    message.role === "user" || message.role === "toolResult"
      ? [
          typeof message.content === "string"
            ? message.content
            : contentText(message.content),
        ]
      : [],
  );

/** `member` registered behind a deterministic source sending `delivered` on `source->worker`. */
function wire(
  flow: JuncoGraph,
  member: agentApi.JuncoAgent,
  id?: NodeIdType,
  delivered: AgenticInput = input,
) {
  const edge = graph.Edge.message<AgenticInput, AssistantMessage>(
    "source->worker",
  );
  const source = new Deterministic<AgenticInput, AssistantMessage>(
    async function* () {
      yield [graph.Message.create(edge, delivered)];
      return fauxAssistantMessage("seeded");
    },
    LockPolicy,
  );
  const sourceId = flow.addNode({
    id: graph.NodeId.create(`source-${crypto.randomUUID()}`),
    trigger: trigger.TriggerRule.always(),
    state: source,
  });
  member.stagePrompt("Call recv and follow the delivered request.");
  const workerId = flow.addNode({
    ...(id === undefined ? {} : { id }),
    state: member,
    policy: LockPolicy,
    trigger: trigger.TriggerRule.when(edge),
  });
  flow.addEdge(sourceId, workerId, edge);
  return { edge, workerId };
}

function newGraph(tracer: DummyTracer = new RecordingTracer()) {
  const ports = terminalPorts();
  const flow = new JuncoGraph(
    ports.source,
    ports.sink,
    graph.Width.create(1),
    graph.UNBOUNDED,
    tracer,
    LockPolicy,
  );
  const execution = schedules.context({
    graph: flow,
    scheduler: schedules.parallel(),
  });
  closers.push(() => flow.close());
  return { execution, ports };
}

const resultText = (
  results: ReadonlyMap<NodeIdType, AssistantMessage>,
  id: NodeIdType,
) => contentText(results.get(id)!.content);

describe("complaints through real graphs", () => {
  test("a worker's complaint records its node, delivered batch and full request", async () => {
    const tracer = new RecordingTracer();
    const { execution: flowContext, ports: flowPorts } = newGraph(tracer);
    const flow = flowContext.graph;
    const member = await worker("I cannot reach the coordinator.");
    const { edge, workerId } = wire(
      flow,
      member,
      graph.NodeId.create("worker"),
    );
    const before = tools.issueLog.length;
    flowPorts.connect(flow, workerId);

    const results = await flowContext.run();
    assert.equal(resultText(results, workerId), "continued");
    const issues = tools.issueLog.snapshot().slice(before);
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.equal(issue!.nodeId, workerId);
    assert.equal(issue!.complaint, "I cannot reach the coordinator.");
    assert.deepEqual(issue!.messages, [{ id: edge.id, payload: input }]);
    assert.equal(
      issue!.prompt.systemPrompt,
      `complaint system\n\n${agentApi.SYSTEM_INSTRUCTION}`,
    );
    // The delivered payload reached the request as recv's result, not as a native user message.
    assert.ok(promptTexts(issue!).some((text) => text.includes(input.text)));
    assert.deepEqual(issue!.prompt.tools?.map((tool) => tool.name).sort(), [
      "complain",
      "recv",
    ]);
    assert.deepEqual(tracer.complaints, [
      [workerId, "I cannot reach the coordinator."],
    ]);

    await flow.close();
    assert.equal(tools.issueLog.snapshot()[before], issue);
  }, 5_000);

  test("every agent and graph shares one issue log that survives closing", async () => {
    const first = await worker("first");
    const second = await worker("second");
    const { execution: firstGraphContext, ports: firstGraphPorts } = newGraph();
    const firstGraph = firstGraphContext.graph;
    const { execution: secondGraphContext, ports: secondGraphPorts } =
      newGraph();
    const secondGraph = secondGraphContext.graph;
    assert.equal(first.issueLog, tools.issueLog);
    assert.equal(second.issueLog, tools.issueLog);
    assert.equal(firstGraph.issueLog, tools.issueLog);
    assert.equal(secondGraph.issueLog, tools.issueLog);

    const before = tools.issueLog.length;
    const firstWiring = wire(firstGraph, first);
    firstGraphPorts.connect(firstGraph, firstWiring.workerId);
    await firstGraphContext.run();
    await firstGraph.close();
    await first.return();
    assert.deepEqual(
      tools.issueLog
        .snapshot()
        .slice(before)
        .map(({ complaint }) => complaint),
      ["first"],
    );
  }, 5_000);

  test("auto and empty-string node ids are recorded as registered", async () => {
    const { execution: autoContext, ports: autoPorts } = newGraph();
    const auto = autoContext.graph;
    const { execution: emptyContext, ports: emptyPorts } = newGraph();
    const empty = emptyContext.graph;
    const autoWorker = wire(auto, await worker("auto"));
    const emptyWorker = wire(
      empty,
      await worker("empty"),
      graph.NodeId.create(""),
    );
    const before = tools.issueLog.length;
    autoPorts.connect(auto, autoWorker.workerId);
    emptyPorts.connect(empty, emptyWorker.workerId);
    await autoContext.run();
    await emptyContext.run();
    const issues = tools.issueLog.snapshot().slice(before);
    assert.deepEqual(
      issues.map(({ nodeId, complaint }) => [nodeId, complaint]),
      [
        [autoWorker.workerId, "auto"],
        ["", "empty"],
      ],
    );
    assert.equal(emptyWorker.workerId, "");
  }, 5_000);

  test("concurrent graphs with the same local node id keep their batches, requests and tracers apart", async () => {
    const tracerA = new RecordingTracer();
    const tracerB = new RecordingTracer();
    const { execution: aContext, ports: aPorts } = newGraph(tracerA);
    const a = aContext.graph;
    const { execution: bContext, ports: bPorts } = newGraph(tracerB);
    const b = bContext.graph;
    const id = graph.NodeId.create("worker");
    const inputA = {
      kind: "prompt",
      text: "Contact coordinator A.",
    } as const satisfies AgenticInput;
    const inputB = {
      kind: "prompt",
      text: "Contact coordinator B.",
    } as const satisfies AgenticInput;
    const wiredA = wire(a, await worker("from A", "system A"), id, inputA);
    const wiredB = wire(b, await worker("from B", "system B"), id, inputB);
    const before = tools.issueLog.length;
    aPorts.connect(a, wiredA.workerId);
    bPorts.connect(b, wiredB.workerId);
    const [ra, rb] = await Promise.all([aContext.run(), bContext.run()]);
    assert.equal(resultText(ra, id), "continued");
    assert.equal(resultText(rb, id), "continued");
    assert.deepEqual(tracerA.complaints, [[id, "from A"]]);
    assert.deepEqual(tracerB.complaints, [[id, "from B"]]);
    const issues = tools.issueLog.snapshot().slice(before);
    const byComplaint = new Map(
      issues.map((issue) => [issue.complaint, issue]),
    );
    assert.equal(issues.length, 2);
    assert.deepEqual([...byComplaint.keys()].sort(), ["from A", "from B"]);
    for (const [complaint, systemPrompt, wired, own, foreign] of [
      ["from A", "system A", wiredA, inputA, inputB],
      ["from B", "system B", wiredB, inputB, inputA],
    ] as const) {
      const issue = byComplaint.get(complaint)!;
      assert.equal(wired.workerId, id);
      assert.equal(issue.nodeId, id);
      assert.deepEqual(issue.messages, [{ id: wired.edge.id, payload: own }]);
      assert.equal(
        issue.prompt.systemPrompt,
        `${systemPrompt}\n\n${agentApi.SYSTEM_INSTRUCTION}`,
      );
      const texts = promptTexts(issue);
      assert.ok(texts.some((text) => text.includes(own.text)));
      assert.ok(!texts.some((text) => text.includes(foreign.text)));
    }
  }, 5_000);

  test("a throwing complaint observer leaves the graph result and issue intact", async () => {
    const { execution: flowContext, ports: flowPorts } = newGraph(
      new ThrowingTracer(),
    );
    const flow = flowContext.graph;
    const { workerId } = wire(flow, await worker("observer throws"));
    const before = tools.issueLog.length;
    const print = console.log;
    console.log = () => {};
    try {
      flowPorts.connect(flow, workerId);
      const results = await flowContext.run();
      assert.equal(resultText(results, workerId), "continued");
    } finally {
      console.log = print;
    }
    assert.deepEqual(
      tools.issueLog
        .snapshot()
        .slice(before)
        .map(({ complaint }) => complaint),
      ["observer throws"],
    );
  }, 5_000);

  test("a nested graph's complaint reaches only its inner node id and tracer", async () => {
    const innerTracer = new RecordingTracer();
    const outerTracer = new RecordingTracer();
    const { execution: innerContext, ports: innerPorts } =
      newGraph(innerTracer);
    const inner = innerContext.graph;
    const { workerId } = wire(
      inner,
      await worker("nested"),
      graph.NodeId.create("inner-worker"),
    );
    const { execution: outerContext, ports: outerPorts } =
      newGraph(outerTracer);
    const outer = outerContext.graph;
    innerPorts.connect(inner, workerId);
    const wrapper = outer.addNode({
      id: graph.NodeId.create("wrapper"),
      trigger: trigger.TriggerRule.always(),
      state: innerContext,
    });
    const before = tools.issueLog.length;
    outerPorts.connect(outer, wrapper);
    const results = await outerContext.run();
    assert.equal(resultText(results, wrapper), "continued");
    assert.deepEqual(innerTracer.complaints, [[workerId, "nested"]]);
    assert.deepEqual(outerTracer.complaints, []);
    assert.deepEqual(
      tools.issueLog
        .snapshot()
        .slice(before)
        .map(({ nodeId }) => nodeId),
      [workerId],
    );
  }, 5_000);

  test("a spec registered in two graphs reports only to the graph that runs it", async () => {
    const tracerA = new RecordingTracer();
    const tracerB = new RecordingTracer();
    const member = await worker("shared spec");
    member.stagePrompt("go");
    const spec = {
      id: graph.NodeId.create("shared"),
      state: member,
      policy: LockPolicy,
      trigger: trigger.TriggerRule.always(),
    };
    const { execution: aContext, ports: aPorts } = newGraph(tracerA);
    const a = aContext.graph;
    const { execution: bContext, ports: bPorts } = newGraph(tracerB);
    const b = bContext.graph;
    const id = a.addNode(spec);
    b.addNode(spec);
    aPorts.connect(a, id);
    bPorts.connect(b, id);
    const results = await aContext.run();
    assert.equal(resultText(results, id), "continued");
    assert.deepEqual(tracerA.complaints, [[id, "shared spec"]]);
    assert.deepEqual(tracerB.complaints, []);
  }, 5_000);
});

describe("direct Agentic.complain", () => {
  test("real and mock agents record supplied issues in the shared log", async () => {
    const { options } = await nativeOptions();
    const real = await agentApi.JuncoAgent.fromResolved({ ...options });
    closers.push(() => real.return());
    const mock = new MockAgent({ runs: [] });
    closers.push(() => mock.return());
    const protocols: agentApi.Agentic[] = [real, mock];
    const graphs = [newGraph().execution.graph, newGraph().execution.graph];
    for (const owner of [real, mock, ...graphs])
      assert.equal(owner.issueLog, tools.issueLog);

    const nodeId = graph.NodeId.create("supplied-node");
    assert.notEqual(nodeId, real.nodeId);
    const edgeId = graph.Edge.message<AgenticInput, AssistantMessage>(
      "edge",
    ).id;
    const lateId = graph.Edge.message<AgenticInput, AssistantMessage>(
      "late",
    ).id;
    const messages = [{ id: edgeId, payload: input }];
    const original = {
      role: "user" as const,
      content: "original",
      timestamp: 1,
    };
    const promptMessages: tools.Prompt["messages"][number][] = [original];
    const prompt = { systemPrompt: "supplied", messages: promptMessages };
    const observer = new RecordingTracer();
    const before = tools.issueLog.length;

    const returned: void[] = [
      protocols[0]!.complain(
        { nodeId, messages, prompt, complaint: "real direct" },
        observer,
      ),
      protocols[1]!.complain({
        nodeId,
        messages,
        prompt,
        complaint: "mock direct",
      }),
    ];
    assert.deepEqual(returned, [undefined, undefined]);
    messages.push({ id: lateId, payload: input });
    promptMessages.push({ role: "user", content: "late", timestamp: 2 });
    original.content = "rewritten";

    const issues = tools.issueLog.snapshot().slice(before);
    assert.deepEqual(
      issues.map(({ complaint }) => complaint),
      ["real direct", "mock direct"],
    );
    for (const issue of issues) {
      assert.equal(issue.nodeId, nodeId);
      assert.deepEqual(issue.messages, [{ id: edgeId, payload: input }]);
      assert.deepEqual(issue.prompt, {
        systemPrompt: "supplied",
        messages: [{ role: "user", content: "original", timestamp: 1 }],
      });
    }
    assert.deepEqual(observer.complaints, [[nodeId, "real direct"]]);
    assert.equal(real.status, "idle");
    assert.deepEqual(mock.requests, []);

    const print = console.log;
    console.log = () => {};
    try {
      real.complain(
        { nodeId, messages: [], prompt, complaint: "observer throws" },
        new ThrowingTracer(),
      );
    } finally {
      console.log = print;
    }
    assert.equal(
      tools.issueLog.snapshot().at(-1)?.complaint,
      "observer throws",
    );

    await real.return();
    await mock.return();
    const closedLength = tools.issueLog.length;
    for (const closed of protocols) {
      assert.throws(
        () =>
          closed.complain({
            nodeId,
            messages: [],
            prompt,
            complaint: "too late",
          }),
        (error: unknown) =>
          error instanceof agentApi.JuncoAgentError && error.code === "closed",
      );
    }
    assert.equal(tools.issueLog.length, closedLength);
    assert.equal(tools.issueLog.snapshot()[before]?.complaint, "real direct");
  });
});
