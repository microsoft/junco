import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type ImageContent,
} from "@earendil-works/pi-ai";
import {
  DataflowNodeError,
  DummyTracer,
  Edge,
  type NodeGenerator,
  NodeId,
  type NodeIdType,
  Sink,
  Source,
  TriggerEntry,
  type TriggerEntry as TriggerEntryType,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent, JuncoAgentError } from "junco-agent";
import { parallel } from "junco-scheduler";
import { LockPolicy, YieldTool } from "junco-tools";
import createGraph from "ngraph.graph";
import { type AgenticInput, JuncoGraph } from "../src/index.ts";
import { context } from "../src/node-policy.ts";
import { Ralph } from "../src/workflows/index.ts";
import { nativeOptions, waitingTool } from "./support.ts";

// Ralph over real native agents on faux models, using scheduled parent source and sink ports.

const quiet = new DummyTracer();

const TIMEOUT_MS = 10_000;
const assignment = "Cover every section.\nKeep the original constraints.";
const prompt = (text: string): AgenticInput => ({ kind: "prompt", text });

/** What one provider request saw: every user and assistant text in its transcript. */
type Request = {
  readonly users: string[];
  readonly assistants: string[];
};
type Reply = string | AssistantMessage | (() => AssistantMessage);

function record(context: Context): Request {
  const users: string[] = [];
  const assistants: string[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      users.push(
        typeof message.content === "string"
          ? message.content
          : contentText(message.content),
      );
    } else if (message.role === "assistant") {
      assistants.push(contentText(message.content));
    }
  }
  return { users, assistants };
}

/** A native agent answering `replies` in order and recording every request it serves. */
async function member(
  replies: readonly Reply[],
  {
    tools = [],
    staged,
  }: { readonly tools?: readonly AgentTool[]; readonly staged?: string } = {},
) {
  const requests: Request[] = [];
  const { options } = await nativeOptions(
    replies.map(
      (reply): FauxResponseStep =>
        (context) => {
          requests.push(record(context));
          if (typeof reply === "string") return fauxAssistantMessage(reply);
          return typeof reply === "function" ? reply() : reply;
        },
    ),
  );
  const agent = await JuncoAgent.fromResolved({
    ...options,
    tools: [...tools],
    ...(staged === undefined ? {} : { prompt: staged }),
  });
  return { agent, requests };
}

/** The messages currently queued on message edge `edge`. */
const queued = (edge: Edge<AgenticInput, AssistantMessage>): AgenticInput[] =>
  E.isLeft(edge.transport) ? [...edge.transport.left] : [];

/** Step the graph until `done` holds; a bounded loop, so a regression fails instead of spinning. */
async function stepUntil(
  graph: { step(): Promise<unknown> },
  done: () => boolean,
): Promise<void> {
  for (let windows = 0; windows < 64; windows++) {
    if (done()) return;
    await graph.step();
  }
  assert.ok(done(), "condition not reached within 64 graph windows");
}

const resultText = (graph: JuncoGraph, id: NodeIdType): string | undefined => {
  const result = graph.result(id);
  return O.isSome(result) ? contentText(result.value.content) : undefined;
};

/** `error` with every node-error wrapper removed. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (current instanceof DataflowNodeError) current = current.cause;
  return current;
}

type Boundary = {
  entries: TriggerEntryType<AgenticInput, AssistantMessage>[];
  results: NodeIdType[];
  recorders: Map<string, (values: readonly AgenticInput[]) => void>;
};
const boundaries = new WeakMap<JuncoGraph, Boundary>();
function parentContext() {
  const config: Boundary = { entries: [], results: [], recorders: new Map() };
  const source = new Source<AgenticInput, AssistantMessage>(
    (view) =>
      [...view.messages.keys()].flatMap((id) =>
        (view.messages.get(id) ?? []).map((payload) => ({ id, payload })),
      ),
    { id: NodeId.create("$source") },
  );
  const sink: Sink<AgenticInput, AssistantMessage> = new Sink<
    AgenticInput,
    AssistantMessage
  >(
    async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
      const view = yield [];
      for (const edge of view.messages.keys())
        config.recorders.get(edge)?.(view.messages.get(edge) ?? []);
      const result = graph.result(config.results.at(-1)!);
      assert.ok(O.isSome(result));
      return result.value;
    },
    {
      id: NodeId.create("$sink"),
      trigger: { kind: "all", rule: config.entries },
      is_available: (_view, triggered) =>
        triggered && config.results.length > 0,
    },
  );
  const graph: JuncoGraph<AgenticInput, AssistantMessage> = new JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    quiet,
    LockPolicy,
  );
  boundaries.set(graph, config);
  const work = parallel();
  return context({
    graph,
    scheduler: (snapshot, signal) => {
      // Admit external batches before advancing controllers whose native inbox was still empty
      // when this column's reads were planned.
      if (snapshot.available.has(source.id)) return { selected: [source.id] };
      return work(snapshot, signal);
    },
  });
}
function mappedPorts() {
  let graph: JuncoGraph;
  const final = Edge.value<AgenticInput, AssistantMessage>("work->$sink");
  const source = new Source<AgenticInput, AssistantMessage>(
    () => {
      throw new Error("No external input");
    },
    { id: NodeId.create("$source") },
  );
  const sink: Sink<AgenticInput, AssistantMessage> = new Sink<
    AgenticInput,
    AssistantMessage
  >(
    async function* (): NodeGenerator<AgenticInput, AssistantMessage> {
      yield [];
      const result = graph.result(NodeId.create("work"));
      assert.ok(O.isSome(result));
      return result.value;
    },
    { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) },
  );
  return {
    source,
    sink,
    wire(value: JuncoGraph) {
      graph = value;
      graph.addEdge(NodeId.create("work"), sink.id, final);
    },
  };
}

let edges = 0;

/**
 * Register a Ralph over `agent` in `parent` between a dormant source and a recording sink. If
 * registration fails, the agent never became the graph's and is closed here.
 */
function attach(parent: JuncoGraph, agent: JuncoAgent, rounds?: number) {
  const tag = ++edges;
  const input = Edge.message<AgenticInput, AssistantMessage>(
    `source->ralph-${tag}`,
  );
  const output = Edge.message<AgenticInput, AssistantMessage>(
    `ralph->sink-${tag}`,
  );
  const delivered: string[] = [];
  let sinkRuns = 0;
  const final = Edge.value<AgenticInput, AssistantMessage>(
    `ralph-result-${tag}`,
  );
  const config = boundaries.get(parent)!;
  config.entries.push(TriggerEntry.on(output), TriggerEntry.on(final));
  config.recorders.set(output.id, (values) => {
    sinkRuns++;
    for (const value of values)
      delivered.push(value.kind === "appendMessage" ? "" : value.text);
  });
  let id: NodeIdType;
  try {
    id = Ralph.register(parent, agent, {
      input,
      output,
      policy: LockPolicy,
      ...(rounds === undefined ? {} : { rounds }),
    });
  } catch (error) {
    void agent.return();
    throw error;
  }
  parent
    .addEdge(parent.source.id, id, input)
    .addEdge(id, parent.sink.id, output)
    .addEdge(id, parent.sink.id, final);
  config.results.push(id);
  return {
    id,
    input,
    output,
    delivered,
    sinkRuns: () => sinkRuns,
    send: (...inputs: AgenticInput[]) => {
      parent.source.enqueue({
        messages: new Map([[input.id, inputs]]),
        values: new Map(),
      });
    },
  };
}

const revision = (previous: string) =>
  `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;

describe("ralph workflow", () => {
  for (const invalid of ["foreign message", "value input"] as const) {
    test(
      `rejects ${invalid} at the scheduled source before provider work`,
      async () => {
        const execution = parentContext();
        await using parent = execution.graph;
        const { agent, requests } = await member(["unused"]);
        const flow = attach(parent, agent);
        const child = parent.getNode(flow.id)?.state;
        assert.ok(child instanceof JuncoGraph);
        const foreign = Edge.message<AgenticInput, AssistantMessage>("foreign");
        child.source.enqueue(
          invalid === "foreign message"
            ? {
                messages: new Map([[foreign.id, [prompt(assignment)]]]),
                values: new Map(),
              }
            : {
                messages: new Map(),
                values: new Map([
                  [foreign.id, fauxAssistantMessage("invalid")],
                ]),
              },
        );
        flow.send(prompt(assignment));
        await assert.rejects(execution.run(), DataflowNodeError);
        assert.equal(requests.length, 0);
        assert.ok(O.isNone(parent.result(flow.id)));
        assert.deepEqual(flow.delivered, []);
      },
      TIMEOUT_MS,
    );
  }

  test(
    "maps a direct assignment without an input edge, retaining only the final answer across native yields",
    async () => {
      const { agent, requests } = await member(
        [
          fauxAssistantMessage(
            [
              fauxToolCall(
                "yield",
                { reason: "continue" },
                { id: "mapped-yield" },
              ),
            ],
            { stopReason: "toolUse" },
          ),
          "draft-1",
          "draft-2",
        ],
        { tools: [new YieldTool()] },
      );
      const skeleton = createGraph<string>();
      skeleton.addNode("work", assignment);
      let assignments = 0;
      const spec = Ralph.node(agent, {
        assignment: (view) => {
          assignments++;
          assert.equal(requests.length, 0);
          assert.ok(view);
          return assignment;
        },
        trigger: TriggerRule.always(),
        policy: LockPolicy,
        tracer: quiet,
      });
      assert.ok(
        "graph" in spec.state && spec.state.graph instanceof JuncoGraph,
      );
      assert.equal("policy" in spec, false);
      assert.equal("step" in spec, false);
      assert.equal(spec.state.graph.tracer, quiet);
      const ports = mappedPorts();
      const execution = JuncoGraph.map(skeleton, () => spec, {
        source: ports.source,
        sink: ports.sink,
        policy: LockPolicy,
        tracer: quiet,
      });
      const parent = execution.graph;
      ports.wire(parent);
      const id = NodeId.create("work");
      try {
        assert.equal(assignments, 0);
        assert.equal(requests.length, 0);
        await stepUntil(execution, () => requests.length >= 2);
        assert.ok(O.isNone(parent.result(id)));
        await execution.run();
        assert.equal(assignments, 1);
        assert.equal(requests.length, 3);
        assert.equal(resultText(parent, id), "draft-2");
        assert.equal(requests[0]!.users.at(-1), assignment);
        assert.equal(requests[2]!.users.at(-1), revision("draft-1"));
        assert.equal(requests[2]!.users[0], assignment);
        await execution.run();
        assert.equal(assignments, 1);
        assert.equal(requests.length, 3);
      } finally {
        await parent.close();
      }
      assert.ok(spec.state.graph.signal.aborted);
      assert.equal(agent.status, "closed");
    },
    TIMEOUT_MS,
  );

  for (const invalid of ["throws", "non-string"] as const) {
    test(
      `a mapped assignment callback that ${invalid} fails before a provider request`,
      async () => {
        const { agent, requests } = await member(["unused"]);
        const failure = new Error("assignment failed");
        let assignments = 0;
        const skeleton = createGraph<string>();
        skeleton.addNode("work", assignment);
        const ports = mappedPorts();
        const execution = JuncoGraph.map(
          skeleton,
          () =>
            Ralph.node(agent, {
              assignment: () => {
                assignments++;
                if (invalid === "throws") throw failure;
                return 42 as unknown as string;
              },
              trigger: TriggerRule.always(),
              policy: LockPolicy,
              tracer: quiet,
            }),
          {
            source: ports.source,
            sink: ports.sink,
            policy: LockPolicy,
            tracer: quiet,
          },
        );
        const parent = execution.graph;
        ports.wire(parent);
        try {
          await assert.rejects(execution.run(), (error: unknown) => {
            const cause = rootCause(error);
            if (invalid === "throws") assert.equal(cause, failure);
            else {
              assert.ok(cause instanceof TypeError);
              assert.equal(cause.message, "Ralph assignment must be a string");
            }
            return true;
          });
          assert.equal(assignments, 1);
          assert.equal(requests.length, 0);
          assert.ok(O.isNone(parent.result(NodeId.create("work"))));
        } finally {
          await parent.close();
        }
        assert.equal(agent.status, "closed");
      },
      TIMEOUT_MS,
    );
  }

  test(
    "runs two rounds by default and queues only the final draft on its completing step",
    async () => {
      const execution = parentContext();
      await using parent = execution.graph;
      const { agent, requests } = await member(["draft-1", "draft-2"]);
      const flow = attach(parent, agent);

      await execution.run();
      assert.equal(requests.length, 0);
      assert.ok(O.isNone(parent.result(flow.id)));
      assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);

      flow.send(prompt(assignment));
      await stepUntil(execution, () => requests.length === 1);
      assert.equal(requests[0]!.users.at(-1), assignment);
      assert.ok(O.isNone(parent.result(flow.id)));
      assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);

      for (let windows = 0; O.isNone(parent.result(flow.id)); windows++) {
        assert.ok(
          windows < 64,
          "Ralph did not complete within 64 graph windows",
        );
        assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
        await execution.step();
      }
      // The completing activation both emitted and published its result: no extra step.
      assert.equal(resultText(parent, flow.id), "draft-2");
      assert.deepEqual(queued(flow.output), [prompt("draft-2")]);
      assert.deepEqual(flow.delivered, []);

      await execution.run();
      assert.deepEqual(flow.delivered, ["draft-2"]);
      const sinkResult = parent.result(parent.sink.id);
      const workflowResult = parent.result(flow.id);
      assert.ok(O.isSome(sinkResult) && O.isSome(workflowResult));
      assert.equal(sinkResult.value, workflowResult.value);
      assert.deepEqual([queued(flow.input), queued(flow.output)], [[], []]);
      await execution.run();
      assert.equal(requests.length, 2);
      assert.deepEqual(flow.delivered, ["draft-2"]);

      const second = requests[1]!;
      assert.equal(second.users.at(-1), revision("draft-1"));
      assert.deepEqual(second.users, [assignment, revision("draft-1")]);
      assert.deepEqual(second.assistants, ["draft-1"]);
    },
    TIMEOUT_MS,
  );

  for (const rounds of [1, 3]) {
    test(
      `rounds: ${rounds} runs exactly ${rounds} full rounds and publishes only the last`,
      async () => {
        const execution = parentContext();
        await using parent = execution.graph;
        const drafts = Array.from(
          { length: rounds },
          (_, index) => `draft-${index + 1}`,
        );
        const { agent, requests } = await member(drafts);
        const flow = attach(parent, agent, rounds);

        flow.send(prompt(assignment));
        for (let round = 1; round <= rounds; round++) {
          await stepUntil(execution, () => requests.length === round);
          if (round < rounds)
            assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
        }
        await execution.run();
        await execution.run();

        assert.equal(requests.length, rounds);
        assert.equal(resultText(parent, flow.id), drafts.at(-1));
        assert.deepEqual(flow.delivered, [drafts.at(-1)]);
        requests.forEach((request, index) => {
          const latest = request.users.at(-1)!;
          assert.ok(latest.startsWith(assignment));
          assert.equal(
            latest,
            index === 0 ? assignment : revision(drafts[index - 1]!),
          );
          assert.deepEqual(request.assistants, drafts.slice(0, index));
        });
        if (rounds === 3) {
          const latest = requests[2]!.users.at(-1)!;
          assert.ok(latest.includes("draft-2") && !latest.includes("draft-1"));
          assert.deepEqual(requests[2]!.users, [
            assignment,
            revision("draft-1"),
            revision("draft-2"),
          ]);
        }
      },
      TIMEOUT_MS,
    );
  }

  test(
    "an invalid round count throws before registering anything",
    async () => {
      const execution = parentContext();
      await using parent = execution.graph;
      const input = Edge.message<AgenticInput, AssistantMessage>("in");
      const output = Edge.message<AgenticInput, AssistantMessage>("out");
      const nodes = () => {
        const ids: NodeIdType[] = [];
        parent.forEachNode((id) => ids.push(id));
        return ids;
      };
      assert.deepEqual(nodes(), [
        NodeId.create("$source"),
        NodeId.create("$sink"),
      ]);
      for (const rounds of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const { agent, requests } = await member(["unused"]);
        try {
          const before = nodes();
          assert.throws(
            () =>
              Ralph.register(parent, agent, {
                input,
                output,
                rounds,
                policy: LockPolicy,
              }),
            RangeError,
          );
          assert.deepEqual(nodes(), before);
          assert.equal(requests.length, 0);
        } finally {
          await agent.return();
        }
      }
    },
    TIMEOUT_MS,
  );

  const image: ImageContent = {
    type: "image",
    data: "AA==",
    mimeType: "image/png",
  };
  const malformed: ReadonlyArray<readonly [string, readonly AgenticInput[]]> = [
    ["two prompts in one batch", [prompt(assignment), prompt("another")]],
    [
      "a followUp instead of a prompt",
      [{ kind: "followUp", text: assignment }],
    ],
    [
      "a prompt with images",
      [{ kind: "prompt", text: assignment, images: [image] }],
    ],
  ];
  for (const [name, inputs] of malformed) {
    test(
      `rejects ${name} before any model work`,
      async () => {
        const execution = parentContext();
        await using parent = execution.graph;
        const { agent, requests } = await member(["draft-1", "draft-2"]);
        const flow = attach(parent, agent);

        flow.send(...inputs);
        await assert.rejects(execution.run(), DataflowNodeError);
        assert.equal(requests.length, 0);
        assert.ok(O.isNone(parent.result(flow.id)));
        assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
      },
      TIMEOUT_MS,
    );
  }

  test(
    "a second assignment after the first round is rejected, not restarted",
    async () => {
      const execution = parentContext();
      await using parent = execution.graph;
      const { agent, requests } = await member([
        "draft-1",
        "draft-2",
        "draft-3",
      ]);
      const flow = attach(parent, agent, 3);

      flow.send(prompt(assignment));
      await stepUntil(execution, () => requests.length === 1);
      flow.send(prompt("a replacement assignment"));
      await assert.rejects(execution.run(), DataflowNodeError);
      assert.equal(requests.length, 1);
      assert.ok(O.isNone(parent.result(flow.id)));
      assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
    },
    TIMEOUT_MS,
  );

  const failures: ReadonlyArray<readonly [string, readonly Reply[], number]> = [
    [
      "a thrown second request",
      [
        "draft-1",
        () => {
          throw new Error("second round failed");
        },
      ],
      2,
    ],
    ["a whitespace-only final reply", ["draft-1", "  \n "], 2],
    ["a blank first round", [" ", "draft-2"], 1],
    [
      "a non-stop final reply",
      ["draft-1", fauxAssistantMessage("draft-2", { stopReason: "length" })],
      2,
    ],
  ];
  for (const [name, replies, attempted] of failures) {
    test(
      `${name} rejects without publishing an earlier draft`,
      async () => {
        const execution = parentContext();
        await using parent = execution.graph;
        const { agent, requests } = await member(replies);
        const flow = attach(parent, agent);

        flow.send(prompt(assignment));
        await assert.rejects(execution.run(), DataflowNodeError);
        await execution.run().catch(() => undefined);
        assert.equal(requests.length, attempted);
        assert.ok(O.isNone(parent.result(flow.id)));
        assert.deepEqual(
          [queued(flow.output), flow.delivered, flow.sinkRuns()],
          [[], [], 0],
        );
      },
      TIMEOUT_MS,
    );
  }

  test(
    "native yields resume within a round and never count as one",
    async () => {
      const execution = parentContext();
      await using parent = execution.graph;
      const { agent, requests } = await member(
        [
          fauxAssistantMessage(
            [fauxToolCall("yield", { reason: "continue" }, { id: "y1" })],
            { stopReason: "toolUse" },
          ),
          "draft-1",
          "draft-2",
        ],
        { tools: [new YieldTool()] },
      );
      const flow = attach(parent, agent);

      flow.send(prompt(assignment));
      await execution.run();
      assert.equal(requests.length, 3);
      assert.deepEqual(requests.at(-1)!.users, [
        assignment,
        revision("draft-1"),
      ]);
      assert.equal(resultText(parent, flow.id), "draft-2");
      assert.deepEqual(flow.delivered, ["draft-2"]);
    },
    TIMEOUT_MS,
  );

  test(
    "a staged agent is not idle and is rejected before its staged prompt runs",
    async () => {
      const execution = parentContext();
      await using parent = execution.graph;
      const { agent, requests } = await member(["staged answer"], {
        staged: "staged",
      });
      const flow = attach(parent, agent);

      flow.send(prompt(assignment));
      const failure = await execution.run().then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof DataflowNodeError);
      const cause = rootCause(failure);
      assert.ok(
        cause instanceof JuncoAgentError && cause.code === "invalid_state",
      );
      assert.equal(requests.length, 0);
      assert.deepEqual(flow.delivered, []);
    },
    TIMEOUT_MS,
  );

  test(
    "aborting the parent mid-round cancels Ralph with the abort reason",
    async () => {
      const execution = parentContext();
      await using parent = execution.graph;
      const hold = waitingTool("hold", { endOnAbort: true });
      const { agent, requests } = await member(
        [
          fauxAssistantMessage([fauxToolCall("hold", {}, { id: "h1" })], {
            stopReason: "toolUse",
          }),
          "draft-1",
          "draft-2",
        ],
        { tools: [hold.tool] },
      );
      const flow = attach(parent, agent);

      flow.send(prompt(assignment));
      const pending = execution.run().then(
        () => undefined,
        (error: unknown) => error,
      );
      await hold.started;
      const reason = new Error("caller cancelled");
      await parent.abort(reason);
      const failure = await pending;
      assert.equal(failure, reason);
      assert.equal(requests.length, 1);
      assert.ok(O.isNone(parent.result(flow.id)));
      assert.deepEqual([queued(flow.output), flow.delivered], [[], []]);
    },
    TIMEOUT_MS,
  );

  test(
    "independent Ralphs in one parent share nothing and close with it",
    async () => {
      const execution = parentContext();
      const parent = execution.graph;
      let children: unknown[] = [];
      let agents: JuncoAgent[] = [];
      try {
        const a = await member(["a-1"]);
        const flowA = attach(parent, a.agent, 1);
        const b = await member(["b-1", "b-2"]);
        const flowB = attach(parent, b.agent, 2);
        agents = [a.agent, b.agent];
        assert.notEqual(flowA.id, flowB.id);
        children = [flowA.id, flowB.id].map((id) => parent.getNode(id)?.state);

        flowA.send(prompt("assignment A"));
        flowB.send(prompt("assignment B"));
        await execution.run();

        assert.deepEqual(
          a.requests.map((request) => request.users),
          [["assignment A"]],
        );
        assert.equal(b.requests.length, 2);
        assert.ok(
          b.requests.every((request) => request.users[0] === "assignment B"),
        );
        assert.ok(
          b.requests
            .flatMap((request) => request.users)
            .every(
              (text) => !text.includes("assignment A") && !text.includes("a-1"),
            ),
        );
        assert.deepEqual(
          [flowA.delivered, flowB.delivered],
          [["a-1"], ["b-2"]],
        );
        assert.equal(resultText(parent, flowA.id), "a-1");
        assert.equal(resultText(parent, flowB.id), "b-2");
      } finally {
        await parent.close();
      }
      assert.ok(
        children.length === 2 &&
          children.every(
            (child) => child instanceof JuncoGraph && child.signal.aborted,
          ),
      );
      assert.ok(agents.every((agent) => agent.status === "closed"));
    },
    TIMEOUT_MS,
  );
});
