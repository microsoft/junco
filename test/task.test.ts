import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AgentMessage,
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  contentText,
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type JsonValue,
  type ToolCall,
} from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import type { TaskToolDetails } from "junco-tools";
import { Type } from "typebox";
import {
  type AgenticInput,
  agent as agentApi,
  agentNode,
  createParallelAgentGraph,
  Deterministic,
  deterministicNode,
  graph,
  JuncoGraph,
  tools as toolsApi,
  trigger,
} from "../src/index.ts";
import { waitingTool } from "./support.ts";

// Real JuncoAgents on Pi's faux providers, driven through agentNode on the parallel policy: a
// `task` call expands the caller's node into a Spawn graph whose workers report back through queues.

type Agent = agentApi.JuncoAgent;
type Report = {
  id: string;
  name?: string;
  attempt: number;
  status: string;
  output: string;
  stopReason: string;
  error?: string;
  decisionRequired?: true;
};

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse())
    await close().catch(() => {});
});

/** One Models registry with a faux provider per name; `script` sets a provider's responses. */
function registry(...names: string[]) {
  const models = createModels();
  const providers = new Map<string, ReturnType<typeof fauxProvider>>();
  for (const name of names) {
    const faux = fauxProvider({
      api: name,
      provider: name,
      tokenSize: { min: 4, max: 4 },
    });
    models.setProvider(faux.provider);
    providers.set(name, faux);
  }
  const faux = (name: string) => {
    const provider = providers.get(name);
    assert.ok(provider, `faux provider ${name}`);
    return provider;
  };
  return {
    models,
    script: (name: string, responses: readonly FauxResponseStep[]) =>
      faux(name).setResponses([...responses]),
    /** The task-schema identity of `name`'s model. */
    model: (name: string) => ({
      provider: name,
      modelId: faux(name).getModel().id,
    }),
    calls: (name: string) => faux(name).state.callCount,
  };
}

async function newCaller(
  models: ReturnType<typeof registry>["models"],
  provider: string,
  tools: AgentTool[],
  contract?: (edgeId: graph.EdgeIdType) => toolsApi.Contract,
): Promise<Agent> {
  const model = models.getModels(provider)[0];
  assert.ok(model);
  const agent = await agentApi.JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model,
    systemPrompt: "sys",
    tools,
    policy: "LockPolicy",
    ...(contract === undefined ? {} : { contract }),
  });
  closers.push(() => agent.return());
  return agent;
}

/** Observes each real child `parent.createSubagents` returned, before the caller receives it. */
type ChildObserver = (parent: Agent, child: Agent, index: number) => void;

/** Records every agent `caller.createSubagents` returns, recursively for descendants. */
function trackSubagents(
  caller: Agent,
  observe?: ChildObserver,
  created: Agent[] = [],
): Agent[] {
  caller.setSubagentObserver({
    acquired: (child, index) => {
      created.push(child);
      trackSubagents(child, observe, created);
      observe?.(caller, child, index);
    },
  });
  return created;
}

/**
 * Each fresh direct child of `caller` by its task's model provider, in acquisition order.
 * `instrument` sees each before it starts; `reject` may refuse an acquisition before it creates any.
 */
function childrenOf(
  caller: Agent,
  instrument?: (provider: string, child: Agent, nth: number) => void,
  reject?: (options: readonly agentApi.TaskAgentOptions[]) => void,
) {
  const byProvider = new Map<string, Agent[]>();
  let batch: readonly agentApi.TaskAgentOptions[] = [];
  caller.setSubagentObserver({
    acquiring: (options) => {
      reject?.(options);
      batch = options;
    },
    acquired: (child, index) => {
      const provider = batch[index]?.model?.provider ?? "";
      const list = byProvider.get(provider) ?? [];
      list.push(child);
      byProvider.set(provider, list);
      instrument?.(provider, child, list.length);
    },
  });
  return (provider: string) => byProvider.get(provider) ?? [];
}

/** Makes `child`'s first run throw before it reaches its model. */
const explode = (child: Agent, message: string) =>
  child.hooks.on("before_drive", ({ operation }) => {
    if (operation === "run") throw new Error(message);
  });

/** A tool whose calls block until `release()`; `started` resolves on the first call. */
function holdTool(name = "hold") {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const tool: AgentTool = {
    name,
    label: name,
    description: "waits",
    parameters: Type.Object({}),
    execute: async () => {
      started.resolve();
      await released.promise;
      return { content: [{ type: "text", text: "held" }], details: undefined };
    },
  };
  return {
    tool,
    started: started.promise,
    release: () => released.resolve(),
  };
}

const textOf = (message: AgentMessage): string =>
  "content" in message ? contentText(message.content) : "";

const userTexts = (context: Context): string[] =>
  context.messages.filter((message) => message.role === "user").map(textOf);

/** Every task report among `context`'s user messages, parsed. */
const reportsIn = (context: Context): Report[] =>
  userTexts(context)
    .filter((text) => text.startsWith('{"type":"task_result"'))
    .map((text): Report => JSON.parse(text));

/** A task report as it was queued for the caller's root: its input kind and its parsed report. */
type QueuedReport = { kind: AgenticInput["kind"]; report: Report };

/**
 * Drives `outer` window by window until nothing is available, snapshotting every task report
 * queued for the expanded `id`'s root before the next window consumes it.
 */
async function driveObservingReports(
  outer: JuncoGraph,
  id = graph.NodeId("caller"),
): Promise<QueuedReport[]> {
  const queued: QueuedReport[] = [];
  // A report may stay queued across windows; record each queued input once.
  const seen = new Set<AgenticInput>();
  while (outer.available().size > 0) {
    await outer.step();
    const state = outer.getNode(id)?.state;
    if (!(state instanceof JuncoGraph)) continue;
    const messages = state.available().get(graph.NodeId("root"))?.view.messages;
    for (const edge of messages?.keys() ?? []) {
      for (const input of messages?.get(edge) ?? []) {
        if (seen.has(input)) continue;
        seen.add(input);
        if ("text" in input && input.text.startsWith('{"type":"task_result"'))
          queued.push({ kind: input.kind, report: JSON.parse(input.text) });
      }
    }
  }
  return queued;
}

/** The latest tool result in `context`. */
function lastToolResult(context: Context) {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role === "toolResult") return message;
  }
  assert.fail("a tool result reached the model");
}

/** Handles of the latest task result in `context`. */
function handlesIn(context: Context): TaskToolDetails["tasks"] {
  const result = lastToolResult(context);
  assert.equal(result.toolName, "task");
  assert.equal(result.isError, false);
  const details = result.details;
  assert.ok(
    typeof details === "object" &&
      details !== null &&
      "tasks" in details &&
      Array.isArray(details.tasks),
  );
  return details.tasks.map((handle) => {
    assert.ok(
      typeof handle === "object" &&
        handle !== null &&
        !Array.isArray(handle) &&
        typeof handle.id === "string",
    );
    return typeof handle.name === "string"
      ? { id: handle.id, name: handle.name }
      : { id: handle.id };
  });
}

const TASK_CONTEXT = "Shared background for every subagent.";
/** The prompt a child receives for `task`: the call's shared context, then its own instructions. */
const childPrompt = (task: string) => `${TASK_CONTEXT}\n\n${task}`;
const taskCall = (tasks: JsonValue[], id = "task-call") =>
  fauxToolCall("task", { context: TASK_CONTEXT, tasks }, { id });
const yieldCall = (reason: string, id = "yield-call") =>
  fauxToolCall("yield", { reason }, { id });
const toolUse = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

function callerNode(caller: Agent, prompt = "Start") {
  return agentNode(
    caller,
    {
      id: graph.NodeId("caller"),
      trigger: trigger.always(),
      policy: "LockPolicy",
    },
    { prompt },
  );
}

/** The expanded node's inner graph. */
function innerOf(outer: JuncoGraph, id = graph.NodeId("caller")): JuncoGraph {
  const state = outer.getNode(id)?.state;
  assert.ok(state instanceof JuncoGraph, "the node's state is its Spawn graph");
  return state;
}

function linksOf(g: JuncoGraph): string[] {
  const links: string[] = [];
  g.forEachLink((from, to) => links.push(`${from}->${to}`));
  return links.sort();
}

const pairedLinks = (ids: readonly string[]) =>
  ids.flatMap((id) => [`root->${id}`, `${id}->root`]).sort();

/** The ids of every batch-completion marker among `context`'s user messages. */
const markersIn = (context: Context): string[][] =>
  userTexts(context)
    .filter((text) => text.startsWith('{"type":"task_batch_complete"'))
    .map((text) => JSON.parse(text).ids);

/** Every tool result in `context` by its call id. */
const toolResultsIn = (context: Context) =>
  new Map(
    context.messages.flatMap((message) =>
      message.role === "toolResult"
        ? [[message.toolCallId, message] as const]
        : [],
    ),
  );

const decision = (
  action: "retry" | "ignore",
  { id, attempt }: { id: string; attempt: number },
  callId = `${action}-${id}-${attempt}`,
) => fauxToolCall("task", { action, id, attempt }, { id: callId });

/**
 * Caller turns answered from context, however many turns the reports take: each new failure
 * question gets `decide`'s calls, a context with a completion marker gets `finish`, and anything
 * else answers `waiting for researchers`.
 */
function answering(
  decide: ((report: Report) => ToolCall[]) | undefined,
  finish: (context: Context) => AssistantMessage,
): FauxResponseStep[] {
  const asked = new Set<string>();
  const step = (context: Context) => {
    for (const report of reportsIn(context)) {
      const key = `${report.id}#${report.attempt}`;
      if (decide === undefined || !report.decisionRequired || asked.has(key))
        continue;
      asked.add(key);
      return toolUse(...decide(report));
    }
    return markersIn(context).length > 0
      ? finish(context)
      : fauxAssistantMessage("waiting for researchers");
  };
  return Array.from({ length: 16 }, () => step);
}

/** A one-turn worker answer: a native error stop, or a completed `<name>-report`. */
const outcome = (name: string, failed: boolean, attempt: number) =>
  failed
    ? fauxAssistantMessage(`${name} partial ${attempt}`, {
        stopReason: "error",
        errorMessage: `${name} boom ${attempt}`,
      })
    : fauxAssistantMessage(`${name}-report`);

/** Scripts `name`'s worker: its first `failures` attempts stop with an error, later ones report. */
function worker(
  r: ReturnType<typeof registry>,
  name: string,
  failures = 0,
  prompts: string[] = [],
): string[] {
  r.script(
    name,
    Array.from({ length: failures + 2 }, (_, index) => (context: Context) => {
      prompts.push(userTexts(context)[0] ?? "");
      return outcome(name, index < failures, index + 1);
    }),
  );
  return prompts;
}

/** A task on `name`'s model with no tools. */
const taskOn = (r: ReturnType<typeof registry>, name: string) => ({
  name,
  task: `do ${name}`,
  model: r.model(name),
  tools: [],
});

/** A caller whose first turn launches `names`' tasks under `policy`, then answers with `turns`. */
async function failingCaller(
  r: ReturnType<typeof registry>,
  names: string[],
  policy: agentApi.TaskFailurePolicy,
  turns: FauxResponseStep[],
) {
  r.script("caller", [
    toolUse(taskCall(names.map((name) => taskOn(r, name)))),
    ...turns,
  ]);
  const caller = await newCaller(r.models, "caller", [
    toolsApi.createTaskTool(),
  ]);
  caller.setTaskFailurePolicy(policy);
  const outer = createParallelAgentGraph("LockPolicy");
  closers.push(() => outer.close());
  const id = outer.addNode(callerNode(caller));
  return { caller, outer, id };
}

/** The node ids under the expanded caller's Spawn root, in registration order. */
function taskNodes(outer: JuncoGraph): string[] {
  const ids: string[] = [];
  innerOf(outer).forEachNode((child) => {
    if (child !== "root") ids.push(child);
  });
  return ids;
}

/** `error` and everything reachable through `cause` and `AggregateError.errors`. */
function causesOf(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const value = pending.pop();
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof AggregateError) pending.push(...value.errors);
    if (value instanceof Error && "cause" in value) pending.push(value.cause);
  }
  return [...seen];
}

describe("task tool through agentNode", () => {
  test("workers run under a Spawn root while the caller continues; their reports finish the original node", async () => {
    const hold = holdTool();
    const r = registry("caller", "alpha", "beta");
    const seen: { handles?: TaskToolDetails["tasks"]; reports?: Report[] } = {};
    const order: string[] = [];
    r.script("caller", [
      toolUse(
        taskCall([
          {
            name: " alpha ",
            task: "do alpha",
            model: r.model("alpha"),
            tools: ["hold"],
          },
          { name: "beta", task: "do beta", model: r.model("beta"), tools: [] },
        ]),
      ),
      (context) => {
        seen.handles = handlesIn(context);
        order.push("caller-interim");
        return fauxAssistantMessage("interim: waiting for workers");
      },
      (context) => {
        seen.reports = reportsIn(context);
        return fauxAssistantMessage("combined: alpha-report + beta-report");
      },
    ]);
    const workerContexts: Context[] = [];
    r.script("alpha", [
      (context) => {
        workerContexts.push(context);
        return toolUse(fauxToolCall("hold", {}, { id: "h1" }));
      },
      () => {
        order.push("alpha-done");
        return fauxAssistantMessage("alpha-report");
      },
    ]);
    r.script("beta", [
      (context) => {
        workerContexts.push(context);
        return fauxAssistantMessage("beta-report");
      },
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
      hold.tool,
    ]);
    const runIds = new Set<string>();
    caller.events.on("run_start", ({ lane, runId }) => {
      if (lane === "main") runIds.add(runId);
    });

    const outer = createParallelAgentGraph("LockPolicy");
    const id = outer.addNode(callerNode(caller, "Start the workers"));
    closers.push(() => outer.close());
    const node = outer.getNode(id);
    const running = outer.run();

    await hold.started;
    assert.deepEqual(
      order,
      ["caller-interim"],
      "the caller answered while alpha is held",
    );
    assert.ok(
      O.isNone(outer.result(id)),
      "an interim answer is not the node's result",
    );
    assert.equal(outer.getNode(id), node, "the node itself is unchanged");
    const inner = innerOf(outer);
    assert.equal(inner.getNode(graph.NodeId("root"))?.state, caller);
    const handles = seen.handles ?? [];
    assert.deepEqual(
      handles.map(({ name }) => name),
      ["alpha", "beta"],
    );
    const childIds = handles.map(({ id }) => id);
    assert.equal(new Set(childIds).size, 2);
    assert.deepEqual(linksOf(inner), pairedLinks(childIds));
    assert.equal(runIds.size, 1, "the handoff kept the caller's one run");

    hold.release();
    const results = await running;
    const final = results.get(id);
    assert.ok(final);
    assert.equal(
      contentText(final.content),
      "combined: alpha-report + beta-report",
    );
    assert.deepEqual(
      (seen.reports ?? []).map(({ id, name, output, status }) => [
        id,
        name,
        output,
        status,
      ]),
      [
        [childIds[0], "alpha", "alpha-report", "completed"],
        [childIds[1], "beta", "beta-report", "completed"],
      ],
    );
    assert.equal(runIds.size, 2, "one more caller run processed the reports");
    for (const context of workerContexts) {
      assert.equal(
        userTexts(context).some((text) => text.includes("Start the workers")),
        false,
        "a worker's fresh session excludes the caller transcript",
      );
    }
    assert.deepEqual(
      workerContexts.map((context) => userTexts(context)[0]).sort(),
      [childPrompt("do alpha"), childPrompt("do beta")],
    );
    for (const child of childIds) {
      const member = inner.getNode(graph.NodeId(child));
      assert.ok(member && member.state !== caller);
      assert.ok(O.isSome(inner.result(graph.NodeId(child))));
    }
  });

  test("external edges keep their contract: recv postponed across Yield, values once, messages in order, info/send pinned to the original node, only the final result downstream", async () => {
    const r = registry("caller", "alpha", "beta");
    type Edge = graph.Edge<AgenticInput, AssistantMessage>;
    type Route = { id: string; edgeId: string; kind: string; expect: string };
    type Info = { parents: Route[]; children: Route[] };
    type Received = {
      messages: { id: string; payload: AgenticInput }[];
      values: { id: string; payload: AssistantMessage }[];
    };
    const sourceEdge: Edge = graph.valueEdge("source=>caller");
    const notesEdge: Edge = graph.messageEdge("notes->caller");
    const outboundEdge: Edge = graph.messageEdge("caller->down");
    const resultEdge: Edge = graph.valueEdge("caller=>down");
    const expects: Record<string, string> = {
      [sourceEdge.id]: "caller takes the upstream value",
      [notesEdge.id]: "caller takes ordered notes",
      [outboundEdge.id]: "down records follow-up texts",
      [resultEdge.id]: "down returns the final caller answer",
    };
    const contract = (edgeId: graph.EdgeIdType) => {
      const expect = expects[edgeId];
      assert.ok(expect, `contract for ${edgeId}`);
      return { expect };
    };
    /** Parsed JSON results of every `name` tool call in `context`, in order. */
    const results = <R>(context: Context, name: string): R[] =>
      context.messages.flatMap((message) =>
        message.role === "toolResult" && message.toolName === name
          ? [JSON.parse(contentText(message.content)) as R]
          : [],
      );
    const called = (context: Context, name: string) =>
      context.messages.some(
        (message) => message.role === "toolResult" && message.toolName === name,
      );
    let alphaStarted = false;
    let finalContext: Context | undefined;
    const callerInfos: Info[] = [];
    const childInfos: Info[] = [];
    const turn = (context: Context): AssistantMessage => {
      const tasks = context.messages.filter(
        (message) =>
          message.role === "toolResult" && message.toolName === "task",
      ).length;
      if (tasks === 0)
        return toolUse(
          taskCall([
            {
              name: "alpha",
              task: "work",
              model: r.model("alpha"),
              tools: ["yield", "info"],
            },
          ]),
        );
      if (!called(context, "yield")) return toolUse(yieldCall("checkpoint"));
      const infos = results<Info>(context, "info");
      if (infos.length === 0)
        return toolUse(fauxToolCall("info", {}, { id: "info-1" }));
      const received = results<Received>(context, "recv");
      const messages = received.flatMap((batch) => batch.messages);
      if (messages.length < 2) {
        const last = context.messages.at(-1);
        return toolUse(
          last?.role === "toolResult" && last.toolName === "recv"
            ? yieldCall("waiting for notes", `wait-${received.length}`)
            : fauxToolCall("recv", {}, { id: `recv-${received.length}` }),
        );
      }
      // A later admission joins the already promoted Spawn graph.
      if (tasks === 1)
        return toolUse(
          taskCall(
            [{ name: "beta", task: "more", model: r.model("beta"), tools: [] }],
            "task-2",
          ),
        );
      if (infos.length === 1)
        return toolUse(fauxToolCall("info", {}, { id: "info-2" }));
      if (!called(context, "send")) {
        callerInfos.push(...infos);
        const route = infos
          .at(-1)
          ?.children.find((child) => child.kind === "message");
        assert.ok(route, "info names an outgoing message route");
        return toolUse(
          fauxToolCall(
            "send",
            {
              id: route.edgeId,
              payload: { kind: "followUp", text: "checkpoint" },
            },
            { id: "send-1" },
          ),
        );
      }
      if (reportsIn(context).length < 2) return fauxAssistantMessage("interim");
      finalContext = context;
      return fauxAssistantMessage("final answer");
    };
    r.script(
      "caller",
      Array.from({ length: 24 }, () => turn),
    );
    r.script("alpha", [
      () => {
        alphaStarted = true;
        return toolUse(fauxToolCall("info", {}, { id: "alpha-info" }));
      },
      (context) => {
        childInfos.push(...results<Info>(context, "info"));
        return toolUse(yieldCall("alpha pause"));
      },
      fauxAssistantMessage("alpha-report"),
    ]);
    r.script("beta", [fauxAssistantMessage("beta-report")]);
    const caller = await newCaller(
      r.models,
      "caller",
      [
        toolsApi.createTaskTool(),
        toolsApi.createYieldTool(),
        toolsApi.RecvTool(),
        toolsApi.SendTool(),
        toolsApi.InfoTool(),
      ],
      contract,
    );
    const upstreamValue = fauxAssistantMessage("upstream value");
    const received: string[] = [];
    let downstreamValue: AssistantMessage | undefined;

    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const sourceId = outer.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, AssistantMessage>(async function* () {
          yield [];
          return upstreamValue;
        }, "LockPolicy"),
        { trigger: trigger.always(), policy: "LockPolicy" },
      ),
    );
    const notesId = outer.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, AssistantMessage>(async function* () {
          yield [
            { id: notesEdge.id, payload: { kind: "followUp", text: "note-1" } },
            { id: notesEdge.id, payload: { kind: "followUp", text: "note-2" } },
          ];
          return fauxAssistantMessage("notes done");
        }, "LockPolicy"),
        // Emits once the worker is running, while the caller's node is expanded and suspended.
        {
          trigger: trigger.always(),
          is_available: () => alphaStarted,
          policy: "LockPolicy",
        },
      ),
    );
    const callerId = outer.addNode(
      agentNode(
        caller,
        {
          id: graph.NodeId("caller"),
          policy: "LockPolicy",
          trigger: trigger.anyOf(trigger.on(notesEdge), trigger.on(sourceEdge)),
        },
        { prompt: "Start" },
      ),
    );
    const downId = outer.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, AssistantMessage>(async function* () {
          let view = yield [];
          while (true) {
            for (const input of view.messages.get(outboundEdge.id) ?? [])
              if (input.kind === "followUp") received.push(input.text);
            const value = view.values.get(resultEdge.id);
            if (value !== undefined) {
              downstreamValue = value;
              return value;
            }
            view = yield [];
          }
        }, "LockPolicy"),
        {
          policy: "LockPolicy",
          trigger: trigger.anyOf(
            trigger.on(outboundEdge),
            trigger.on(resultEdge),
          ),
          contract,
        },
      ),
    );
    outer
      .addEdge(sourceId, callerId, sourceEdge)
      .addEdge(notesId, callerId, notesEdge)
      .addEdge(callerId, downId, outboundEdge)
      .addEdge(callerId, downId, resultEdge);
    const node = outer.getNode(callerId);
    const links = linksOf(outer);

    const results_ = await outer.run();
    const final = results_.get(callerId);
    assert.ok(final);
    assert.equal(contentText(final.content), "final answer");
    assert.equal(outer.getNode(callerId), node);
    assert.deepEqual(linksOf(outer), links, "external edges are unchanged");
    assert.ok(finalContext);

    // Postponed recv: every retained note once, in FIFO order, and the stale value exactly once.
    const batches = results<Received>(finalContext, "recv");
    assert.deepEqual(
      batches.flatMap((batch) =>
        batch.messages.map(({ id, payload }) => [
          id,
          "text" in payload ? payload.text : "",
        ]),
      ),
      [
        [notesEdge.id, "note-1"],
        [notesEdge.id, "note-2"],
      ],
    );
    assert.deepEqual(
      batches.flatMap((batch) =>
        batch.values.map(({ id, payload }) => [
          id,
          contentText(payload.content),
        ]),
      ),
      [[sourceEdge.id, "upstream value"]],
    );
    assert.equal(
      userTexts(finalContext).includes("note-1"),
      false,
      "notes are data, not prompts",
    );
    assert.deepEqual(
      reportsIn(finalContext)
        .map(({ output }) => output)
        .sort(),
      ["alpha-report", "beta-report"],
    );

    // The promoted caller, before and after a later admission, still reports its outer node.
    const route = (id: string, edge: Edge, kind: string) => ({
      id,
      edgeId: edge.id,
      kind,
      expect: expects[edge.id],
    });
    const byEdge = (a: Route, b: Route) => a.edgeId.localeCompare(b.edgeId);
    const outerInfo = {
      parents: [
        route(sourceId, sourceEdge, "value"),
        route(notesId, notesEdge, "message"),
      ].sort(byEdge),
      children: [
        route(downId, outboundEdge, "message"),
        route(downId, resultEdge, "value"),
      ].sort(byEdge),
    };
    assert.equal(callerInfos.length, 2);
    for (const info of callerInfos)
      assert.deepEqual(
        {
          parents: [...info.parents].sort(byEdge),
          children: [...info.children].sort(byEdge),
        },
        outerInfo,
      );
    // The child shares the caller's info carrier yet reports its own inner-graph registration.
    const [childInfo] = childInfos;
    assert.ok(childInfo);
    for (const entry of [...childInfo.parents, ...childInfo.children]) {
      assert.equal(entry.id, "root");
      assert.equal(entry.kind, "message");
      assert.ok(entry.expect.length > 0);
    }
    assert.equal(childInfo.parents.length, 1);
    assert.equal(childInfo.children.length, 1);

    assert.deepEqual(
      received,
      ["checkpoint"],
      "only the explicit send reaches down",
    );
    assert.equal(
      downstreamValue,
      final,
      "only the final caller result reaches downstream",
    );
  });

  test("calls in one batch and a later call add ordered siblings under one root", async () => {
    const r = registry("caller", "worker");
    const contexts: Context[] = [];
    r.script("caller", [
      toolUse(
        taskCall(
          [{ name: "alpha", task: "a", model: r.model("worker") }],
          "t1",
        ),
        taskCall([{ name: "beta", task: "b", model: r.model("worker") }], "t2"),
      ),
      fauxAssistantMessage("interim"),
      (context) => {
        contexts.push(context);
        return toolUse(
          taskCall(
            [{ name: "gamma", task: "c", model: r.model("worker") }],
            "t3",
          ),
        );
      },
      fauxAssistantMessage("interim 2"),
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage("final");
      },
    ]);
    r.script("worker", [
      (context) => fauxAssistantMessage(`${userTexts(context)[0]}-report`),
      (context) => fauxAssistantMessage(`${userTexts(context)[0]}-report`),
      (context) => fauxAssistantMessage(`${userTexts(context)[0]}-report`),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const results = await outer.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "final");
    const inner = innerOf(outer);
    const children: string[] = [];
    inner.forEachNode((child, member) => {
      if (child !== "root") children.push(member.description ?? "");
    });
    assert.deepEqual(children, ["alpha", "beta", "gamma"]);
    const ids: string[] = [];
    inner.forEachNode((child) => {
      if (child !== "root") ids.push(child);
    });
    assert.deepEqual(linksOf(inner), pairedLinks(ids));
    assert.deepEqual(
      reportsIn(contexts[0]!).map(({ name, output }) => [name, output]),
      [
        ["alpha", `${childPrompt("a")}-report`],
        ["beta", `${childPrompt("b")}-report`],
      ],
    );
    assert.deepEqual(
      reportsIn(contexts[1]!).map(({ name }) => name),
      ["alpha", "beta", "gamma"],
      "the new sibling's return queue was drained, earlier reports kept once",
    );
  });

  test("a subagent's own task call nests its node; the grandchild's report reaches the original caller", async () => {
    const r = registry("caller", "alpha", "grand");
    r.script("caller", [
      toolUse(
        taskCall([
          {
            name: "alpha",
            task: "delegate",
            model: r.model("alpha"),
            tools: ["task"],
          },
        ]),
      ),
      fauxAssistantMessage("caller interim"),
      (context) =>
        fauxAssistantMessage(
          `combined: ${reportsIn(context)
            .map(({ output }) => output)
            .join(",")}`,
        ),
    ]);
    r.script("alpha", [
      toolUse(
        taskCall([
          { name: "grand", task: "leaf work", model: r.model("grand") },
        ]),
      ),
      fauxAssistantMessage("alpha interim"),
      (context) =>
        fauxAssistantMessage(
          `alpha saw ${reportsIn(context)
            .map(({ output }) => output)
            .join(",")}`,
        ),
    ]);
    r.script("grand", [fauxAssistantMessage("grand-report")]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const created = trackSubagents(caller);
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const results = await outer.run();
    assert.equal(
      contentText(results.get(id)?.content ?? []),
      "combined: alpha saw grand-report",
    );
    const inner = innerOf(outer);
    const nested: JuncoGraph[] = [];
    inner.forEachNode((child, member) => {
      if (child !== "root" && member.state instanceof JuncoGraph)
        nested.push(member.state);
    });
    assert.equal(nested.length, 1, "one nested child scope");
    const [alpha, grand] = created;
    assert.ok(alpha && grand);
    assert.equal(nested[0]!.getNode(graph.NodeId("root"))?.state, alpha);
    let grandFound = false;
    nested[0]!.forEachNode((child, member) => {
      if (child !== "root") grandFound = member.state === grand;
    });
    assert.ok(grandFound);
    assert.equal(r.calls("grand"), 1);
  });

  test("a terminating hook, and a report queued while settlement is already pending, are processed once in the same session", async () => {
    const r = registry("caller", "worker");
    const seen: Context[] = [];
    r.script("caller", [
      toolUse(
        taskCall(
          [{ name: "alpha", task: "a", model: r.model("worker") }],
          "t1",
        ),
      ),
      toolUse(yieldCall("wait")),
      toolUse(
        taskCall(
          [{ name: "gamma", task: "c", model: r.model("worker") }],
          "t2",
        ),
      ),
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("after alpha");
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("final");
      },
    ]);
    r.script("worker", [
      fauxAssistantMessage("a-report"),
      fauxAssistantMessage("c-report"),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
      toolsApi.createYieldTool(),
    ]);
    caller.hooks.on("after_tool", ({ toolCallId }) =>
      toolCallId === "t2"
        ? { terminate: true, content: [{ type: "text", text: "rewritten" }] }
        : undefined,
    );
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const results = await outer.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "final");
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((context) => reportsIn(context).map(({ output }) => output)),
      [["a-report"], ["a-report", "c-report"]],
    );
    assert.equal(innerOf(outer).getNode(graph.NodeId("root"))?.state, caller);
  });

  test("an invalid batch fails as an ordinary tool error before any child or graph change", async () => {
    const r = registry("caller", "worker");
    const errors: string[] = [];
    r.script("caller", [
      toolUse(
        taskCall(
          [
            { task: "ok", model: r.model("worker") },
            { task: "bad", model: { provider: "nope", modelId: "x" } },
          ],
          "t1",
        ),
      ),
      (context) => {
        const result = lastToolResult(context);
        if (result.isError) errors.push(textOf(result));
        return toolUse(taskCall([{ task: "bad", tools: ["missing"] }], "t2"));
      },
      (context) => {
        const result = lastToolResult(context);
        if (result.isError) errors.push(textOf(result));
        return fauxAssistantMessage("no tasks");
      },
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const created = trackSubagents(caller);
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const results = await outer.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "no tasks");
    assert.equal(outer.getNode(id)?.state, caller, "the node never expanded");
    assert.equal(created.length, 0);
    assert.equal(r.calls("worker"), 0);
    assert.equal(errors.length, 2);
    assert.match(errors[0]!, /Model not found: nope\/x/);
    assert.match(errors[1]!, /Unknown active tool: missing/);
  });

  test("an abort after acquisition and before publication closes the acquired children and keeps the caller's node", async () => {
    const r = registry("caller", "worker");
    r.script("caller", [
      toolUse(taskCall([{ task: "a" }, { task: "b" }], "t1")),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const created = trackSubagents(caller);
    caller.hooks.on("after_tool", ({ toolCallId }) => {
      // The batch was admitted; abort before the node can publish it.
      if (toolCallId === "t1") void caller.abort();
      return undefined;
    });
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    await assert.rejects(outer.run());
    assert.equal(created.length, 2);
    for (const child of created) assert.equal(child.status, "closed");
    assert.equal(outer.getNode(id)?.state, caller, "nothing was published");
    assert.equal(r.calls("worker"), 0);
  });

  test("closing the graph during acquisition creates no children", async () => {
    const r = registry("caller");
    r.script("caller", [toolUse(taskCall([{ task: "a" }], "t1"))]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const outer = createParallelAgentGraph("LockPolicy");
    const id = outer.addNode(callerNode(caller));
    let closing: Promise<unknown> | undefined;
    const acquired: Agent[] = [];
    caller.setSubagentObserver({
      // The graph closes while the batch is being acquired.
      acquiring: () => {
        closing = outer.close();
      },
      acquired: (child) => acquired.push(child),
    });
    await assert.rejects(outer.run());
    assert.ok(closing);
    await closing;
    assert.equal(caller.status, "closed");
    assert.equal(outer.getNode(id)?.state, caller);
    assert.equal(
      acquired.length,
      0,
      "acquisition was refused, so no child exists",
    );
  });

  test("closing the graph after publication closes the caller and every worker", async () => {
    const hold = holdTool();
    const r = registry("caller", "worker");
    r.script("caller", [
      toolUse(
        taskCall([
          { task: "a", model: r.model("worker"), tools: ["hold"] },
          { task: "b", model: r.model("worker"), tools: [] },
        ]),
      ),
      fauxAssistantMessage("interim"),
    ]);
    r.script("worker", [
      toolUse(fauxToolCall("hold", {}, { id: "h" })),
      fauxAssistantMessage("b-report"),
      fauxAssistantMessage("a-report"),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
      hold.tool,
    ]);
    const created = trackSubagents(caller);
    const outer = createParallelAgentGraph("LockPolicy");
    const id = outer.addNode(callerNode(caller));
    const running = outer.run();
    await hold.started;
    assert.ok(outer.getNode(id)?.state instanceof JuncoGraph);
    const closing = outer.close();
    hold.release();
    await assert.rejects(running);
    await closing;
    assert.equal(caller.status, "closed");
    assert.equal(created.length, 2);
    for (const child of created) assert.equal(child.status, "closed");
  });

  test("a native error stop asks the caller with its real output by default; the caller's ignore finishes the batch", async () => {
    const r = registry("caller", "worker");
    let finalContext: Context | undefined;
    r.script("caller", [
      toolUse(taskCall([{ name: "w", task: "a", model: r.model("worker") }])),
      ...answering(
        (report) => [decision("ignore", report, "ignore-w")],
        (context) => {
          finalContext = context;
          return fauxAssistantMessage("final");
        },
      ),
    ]);
    r.script("worker", [
      fauxAssistantMessage("partial output", {
        stopReason: "error",
        errorMessage: "boom",
      }),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const queued = await driveObservingReports(outer);
    const final = outer.result(id);
    assert.ok(O.isSome(final), "the caller's original node finished");
    assert.equal(contentText(final.value.content), "final");
    assert.ok(finalContext);
    const reports = reportsIn(finalContext);
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.equal(report?.status, "failed");
    assert.equal(report?.attempt, 1);
    assert.equal(report?.decisionRequired, true);
    assert.equal(report?.stopReason, "error");
    assert.equal(report?.error, "boom");
    assert.equal(report?.output, "partial output");
    assert.deepEqual(
      queued.map(({ kind, report }) => [kind, report.id, report.status]),
      [["error", report?.id, "failed"]],
    );
    const ignored = toolResultsIn(finalContext).get("ignore-w");
    assert.equal(ignored?.isError, false);
    assert.equal(textOf(ignored!), `Ignored task ${report?.id}.`);
    assert.deepEqual(markersIn(finalContext), [[report?.id]]);
    const value = innerOf(outer).result(graph.NodeId(report?.id ?? ""));
    assert.ok(
      O.isSome(value),
      "a genuine error stop keeps its assistant result",
    );
    assert.equal(contentText(value.value.content), "partial output");
    assert.equal(value.value.stopReason, "error");
    assert.equal(value.value.errorMessage, "boom");
  });

  test("an ignored thrown worker failure is consumed internally; only its sibling's report and the completion marker reach the caller", async () => {
    const r = registry("caller", "bad", "good");
    let handles: TaskToolDetails["tasks"] = [];
    let finalContext: Context | undefined;
    const afterReports = answering(undefined, (context) => {
      finalContext = context;
      return fauxAssistantMessage("handled both");
    });
    r.script("caller", [
      toolUse(
        taskCall([
          { name: "bad", task: "explode", model: r.model("bad"), tools: [] },
          { name: "good", task: "work", model: r.model("good"), tools: [] },
        ]),
      ),
      (context) => {
        handles = handlesIn(context);
        return fauxAssistantMessage("interim");
      },
      ...afterReports,
    ]);
    r.script("bad", [fauxAssistantMessage("must not run")]);
    r.script("good", [fauxAssistantMessage("good-report")]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    caller.setTaskFailurePolicy("ignore");
    let bad: Agent | undefined;
    trackSubagents(caller, (parent, child, index) => {
      if (parent !== caller || index !== 0) return;
      bad = child;
      explode(child, "worker exploded");
    });
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const queued = await driveObservingReports(outer);
    const final = outer.result(id);
    assert.ok(O.isSome(final), "the caller's original node finished");
    assert.equal(contentText(final.value.content), "handled both");
    assert.deepEqual(
      handles.map(({ name }) => name),
      ["bad", "good"],
    );
    const [badId, goodId] = handles.map(({ id }) => id);
    assert.ok(badId && goodId);
    assert.equal(
      r.calls("bad"),
      0,
      "the failed worker never reached its model",
    );

    for (const handle of [badId, goodId])
      assert.equal(
        queued.filter(({ report }) => report.id === handle).length,
        1,
        `one queued report for ${handle}`,
      );
    assert.equal(queued.length, 2);
    const failed = queued.find(({ report }) => report.id === badId)!;
    assert.equal(failed.kind, "error");
    assert.equal(failed.report.name, "bad");
    assert.equal(failed.report.status, "failed");
    assert.equal(failed.report.output, "");
    assert.equal(failed.report.stopReason, "error");
    assert.match(failed.report.error ?? "", /worker exploded/);
    const completed = queued.find(({ report }) => report.id === goodId)!;
    assert.equal(completed.kind, "followUp");
    assert.equal(completed.report.name, "good");
    assert.equal(completed.report.status, "completed");
    assert.equal(completed.report.output, "good-report");

    assert.ok(finalContext);
    assert.deepEqual(
      reportsIn(finalContext).map(({ id }) => id),
      [goodId],
      "the ignored failure never entered the caller's context",
    );
    assert.deepEqual(markersIn(finalContext), [[badId, goodId]]);

    const inner = innerOf(outer);
    const badNode = inner.getNode(graph.NodeId(badId));
    assert.ok(bad);
    assert.equal(badNode?.state, bad);
    assert.equal(badNode?.status, "done");
    assert.ok(O.isNone(inner.result(graph.NodeId(badId))), "no invented value");
    assert.equal(bad.status, "closed");
    const goodValue = inner.result(graph.NodeId(goodId));
    assert.ok(O.isSome(goodValue));
    assert.equal(contentText(goodValue.value.content), "good-report");
    await outer.close();
  });

  test("an ignored failed expanded task cancels its blocked descendants and is consumed once by its parent", async () => {
    const waiting = waitingTool("wait", { endOnAbort: true });
    const r = registry("caller", "child", "fast", "slow");
    let handles: TaskToolDetails["tasks"] = [];
    let finalContext: Context | undefined;
    r.script("caller", [
      toolUse(
        taskCall([
          {
            name: "child",
            task: "delegate",
            model: r.model("child"),
            tools: ["task", "yield", "wait"],
          },
        ]),
      ),
      (context) => {
        handles = handlesIn(context);
        return fauxAssistantMessage("caller interim");
      },
      ...answering(undefined, (context) => {
        finalContext = context;
        return fauxAssistantMessage("caller handled");
      }),
    ]);
    r.script("child", [
      toolUse(
        taskCall([
          {
            name: "fast",
            task: "fast work",
            model: r.model("fast"),
            tools: [],
          },
          {
            name: "slow",
            task: "slow work",
            model: r.model("slow"),
            tools: ["yield", "wait"],
          },
        ]),
      ),
      fauxAssistantMessage("child interim"),
      fauxAssistantMessage("child must not answer"),
    ]);
    r.script("fast", [fauxAssistantMessage("fast-report")]);
    r.script("slow", [
      toolUse(yieldCall("let fast report")),
      // The child's root takes the delivered report in the next window.
      toolUse(yieldCall("let the child take the report", "yield-2")),
      toolUse(fauxToolCall("wait", {}, { id: "w1" })),
      fauxAssistantMessage("slow-report"),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
      toolsApi.createYieldTool(),
      waiting.tool,
    ]);
    caller.setTaskFailurePolicy("ignore");
    const created = trackSubagents(caller, (parent, child) => {
      if (parent !== caller) return;
      let runs = 0;
      child.hooks.on("before_drive", async ({ operation }) => {
        if (operation !== "run" || ++runs !== 2) return;
        // The slow grandchild is blocked in the same column when the child's root fails.
        await waiting.started;
        throw new Error("nested worker exploded");
      });
    });
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const queued = await driveObservingReports(outer);
    await waiting.aborted;
    const final = outer.result(id);
    assert.ok(O.isSome(final), "the caller's original node finished");
    assert.equal(contentText(final.value.content), "caller handled");
    const [childHandle] = handles;
    assert.ok(childHandle && handles.length === 1);
    assert.equal(childHandle.name, "child");

    assert.equal(
      queued.length,
      1,
      "only the child's report was queued for the caller",
    );
    const [{ kind, report }] = queued as [QueuedReport];
    assert.equal(kind, "error");
    assert.equal(report.id, childHandle.id);
    assert.equal(report.name, "child");
    assert.equal(report.status, "failed");
    assert.equal(report.output, "");
    assert.equal(report.stopReason, "error");
    assert.match(report.error ?? "", /nested worker exploded/);
    assert.ok(finalContext);
    assert.deepEqual(reportsIn(finalContext), [], "the failure was ignored");
    assert.deepEqual(markersIn(finalContext), [[childHandle.id]]);

    assert.equal(created.length, 3, "the child and both grandchildren");
    for (const agent of created) assert.equal(agent.status, "closed");
    const inner = innerOf(outer);
    const childNode = inner.getNode(graph.NodeId(childHandle.id));
    assert.ok(childNode?.state instanceof JuncoGraph, "the task had expanded");
    assert.equal(childNode.status, "done");
    assert.ok(O.isNone(inner.result(graph.NodeId(childHandle.id))));
    await outer.close();
  }, 5_000);

  test("complaints follow the caller into its Spawn root and children keep their own task ids", async () => {
    const r = registry("caller", "worker");
    const complain = (complaint: string, id: string) =>
      toolUse(fauxToolCall("complain", { complaint }, { id }));
    const seen: { handles?: TaskToolDetails["tasks"] } = {};
    r.script("caller", [
      complain("before expansion", "c1"),
      toolUse(
        taskCall([
          { name: "w", task: "do w", model: r.model("worker"), tools: [] },
        ]),
      ),
      (context) => {
        seen.handles = handlesIn(context);
        return complain("after expansion", "c2");
      },
      fauxAssistantMessage("interim"),
      complain("with reports", "c3"),
      fauxAssistantMessage("combined"),
    ]);
    r.script("worker", [
      complain("child blocked", "w1"),
      fauxAssistantMessage("worker-report"),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const before = toolsApi.issueLog.length;
    const id = outer.addNode(callerNode(caller, "Start"));
    const results = await outer.run();
    assert.equal(contentText(results.get(id)!.content), "combined");

    const [child] = seen.handles ?? [];
    assert.ok(child);
    const issues = toolsApi.issueLog.snapshot().slice(before);
    const byText = new Map(issues.map((issue) => [issue.complaint, issue]));
    assert.equal(issues.length, 4);
    assert.equal(byText.get("before expansion")?.nodeId, id);
    assert.deepEqual(byText.get("before expansion")?.messages, []);
    // Task admission no longer pauses: the same run complains before its node is promoted.
    assert.equal(byText.get("after expansion")?.nodeId, id);
    assert.deepEqual(byText.get("after expansion")?.messages, []);
    const reports = byText.get("with reports");
    assert.equal(reports?.nodeId, "root");
    assert.deepEqual(
      reports?.messages.map((message) => message.id),
      [`${child.id}->root`],
    );
    const payload = reports?.messages[0]?.payload as AgenticInput | undefined;
    assert.ok(payload?.kind === "followUp");
    assert.deepEqual(JSON.parse(payload.text), {
      type: "task_result",
      id: child.id,
      name: "w",
      attempt: 1,
      status: "completed",
      output: "worker-report",
      stopReason: "stop",
    });
    const childIssue = byText.get("child blocked");
    assert.equal(childIssue?.nodeId, child.id);
    // The child starts from its bound task prompt, not a delivered message.
    assert.deepEqual(childIssue?.messages, []);
    assert.ok(
      childIssue?.prompt.messages.some(
        (message) =>
          message.role === "user" && textOf(message) === childPrompt("do w"),
      ),
    );
  }, 5_000);

  test("an assigned batch launches its stored assignments from task({}) once; a rejected admission can be retried", async () => {
    const r = registry("caller", "a", "b");
    const prompts = { a: worker(r, "a"), b: worker(r, "b") };
    let finalContext: Context | undefined;
    const launch = (id: string) => fauxToolCall("task", {}, { id });
    r.script("caller", [
      toolUse(launch("l1"), launch("l2"), launch("l3")),
      ...answering(undefined, (context) => {
        finalContext = context;
        return fauxAssistantMessage("final");
      }),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    const batch = {
      context: "Original context.",
      tasks: [taskOn(r, "a"), taskOn(r, "b")],
    };
    await caller.setTaskBatch(batch);
    batch.context = "tampered";
    batch.tasks[0]!.task = "tampered";
    batch.tasks.pop();
    let acquisitions = 0;
    const children = childrenOf(caller, undefined, () => {
      if (++acquisitions === 1) throw new Error("admission rejected");
    });
    const outer = createParallelAgentGraph("LockPolicy");
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const results = await outer.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "final");
    assert.ok(finalContext);
    const tools = toolResultsIn(finalContext);
    assert.equal(tools.get("l1")?.isError, true);
    assert.match(textOf(tools.get("l1")!), /admission rejected/);
    assert.equal(tools.get("l2")?.isError, false);
    const handles = (tools.get("l2")!.details as TaskToolDetails).tasks;
    assert.deepEqual(
      handles.map(({ name }) => name),
      ["a", "b"],
    );
    assert.equal(tools.get("l3")?.isError, true);
    assert.equal(
      textOf(tools.get("l3")!),
      "Task batch already admitted; wait for its results.",
    );
    assert.equal(acquisitions, 2);
    assert.equal(children("a").length, 1);
    assert.equal(children("b").length, 1);
    assert.deepEqual(prompts, {
      a: ["Original context.\n\ndo a"],
      b: ["Original context.\n\ndo b"],
    });
    assert.deepEqual(
      taskNodes(outer),
      handles.map(({ id }) => id),
    );
    assert.deepEqual(markersIn(finalContext), [handles.map(({ id }) => id)]);
  });

  test("ignore: failed attempts are closed and dropped; the caller answers from the success after one marker", async () => {
    const r = registry("caller", "a", "b", "c");
    worker(r, "a");
    worker(r, "b", 1);
    worker(r, "c");
    let finalContext: Context | undefined;
    const { caller, outer, id } = await failingCaller(
      r,
      ["a", "b", "c"],
      "ignore",
      answering(undefined, (context) => {
        finalContext = context;
        const outputs = reportsIn(context).map(({ output }) => output);
        return fauxAssistantMessage(`final: ${outputs.join(",")}`);
      }),
    );
    const children = childrenOf(caller, (provider, child) => {
      if (provider === "a") explode(child, "a exploded");
    });

    const results = await outer.run();
    assert.equal(
      contentText(results.get(id)?.content ?? []),
      "final: c-report",
    );
    assert.ok(finalContext);
    assert.deepEqual(
      reportsIn(finalContext).map(({ name, status }) => [name, status]),
      [["c", "completed"]],
    );
    assert.deepEqual(markersIn(finalContext), [taskNodes(outer)]);
    assert.equal(r.calls("a"), 0, "the thrown failure never reached its model");
    assert.equal(r.calls("b"), 1);
    for (const name of ["a", "b", "c"]) assert.equal(children(name).length, 1);
    for (const name of ["a", "b"])
      assert.equal(children(name)[0]?.status, "closed");
  });

  test("ignore: when every task fails, the marker wakes the settled caller for a fresh final answer", async () => {
    const r = registry("caller", "a", "b", "c");
    worker(r, "a");
    worker(r, "b", 1);
    worker(r, "c", 1);
    let finalContext: Context | undefined;
    const { caller, outer, id } = await failingCaller(
      r,
      ["a", "b", "c"],
      "ignore",
      answering(undefined, (context) => {
        finalContext = context;
        return fauxAssistantMessage("fresh final");
      }),
    );
    childrenOf(caller, (provider, child) => {
      if (provider === "a") explode(child, "a exploded");
    });

    const results = await outer.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "fresh final");
    assert.ok(finalContext);
    assert.ok(
      finalContext.messages.some(
        (message) =>
          message.role === "assistant" &&
          textOf(message) === "waiting for researchers",
      ),
      "the caller answered before the marker",
    );
    assert.deepEqual(reportsIn(finalContext), []);
    assert.deepEqual(markersIn(finalContext), [taskNodes(outer)]);
  });

  test("{ retries: 2 }: a task failing twice reruns with its pinned prompt and model while its sibling runs once", async () => {
    const r = registry("caller", "a", "b");
    const prompts = worker(r, "a", 2);
    worker(r, "b");
    let finalContext: Context | undefined;
    const { caller, outer } = await failingCaller(
      r,
      ["a", "b"],
      { retries: 2 },
      answering(
        () => assert.fail("no failure question"),
        (context) => {
          finalContext = context;
          return fauxAssistantMessage("final");
        },
      ),
    );
    const children = childrenOf(caller);

    await outer.run();
    assert.ok(finalContext);
    const [a, b] = markersIn(finalContext)[0] ?? [];
    assert.ok(a && b);
    assert.deepEqual(taskNodes(outer), [
      a,
      b,
      `${a}:attempt:2`,
      `${a}:attempt:3`,
    ]);
    assert.equal(children("a").length, 3);
    assert.equal(children("b").length, 1);
    assert.equal(r.calls("a"), 3);
    assert.deepEqual(prompts, Array(3).fill(childPrompt("do a")));
    const toolNames = children("a").map((child) =>
      child.getActiveTools().map(({ name }) => name),
    );
    assert.ok(!toolNames[0]?.includes("task"), "the assignment's tool subset");
    for (const names of toolNames) assert.deepEqual(names, toolNames[0]);
    const reports = reportsIn(finalContext);
    assert.deepEqual(
      [a, b].map((id) =>
        reports
          .filter((report) => report.id === id)
          .map(({ attempt, status }) => [attempt, status]),
      ),
      [[[3, "completed"]], [[1, "completed"]]],
    );
    assert.equal(markersIn(finalContext).length, 1);
  });

  test("{ retries: 2 }: after exhaustion every failure asks; an explicit retry does not reset the budget", async () => {
    const r = registry("caller", "a", "b");
    worker(r, "a", 4);
    worker(r, "b");
    const questions: number[] = [];
    let finalContext: Context | undefined;
    const { caller, outer } = await failingCaller(
      r,
      ["a", "b"],
      { retries: 2 },
      answering(
        (report) => {
          questions.push(report.attempt);
          return [
            decision(questions.length === 1 ? "retry" : "ignore", report),
          ];
        },
        (context) => {
          finalContext = context;
          return fauxAssistantMessage("final");
        },
      ),
    );
    const children = childrenOf(caller);

    await outer.run();
    assert.ok(finalContext);
    assert.deepEqual(questions, [3, 4]);
    const [a, b] = markersIn(finalContext)[0] ?? [];
    assert.ok(a && b);
    assert.equal(children("a").length, 4);
    assert.equal(children("b").length, 1);
    const tools = toolResultsIn(finalContext);
    assert.deepEqual(
      (tools.get(`retry-${a}-3`)!.details as TaskToolDetails).tasks,
      [{ id: a, name: "a" }],
    );
    assert.deepEqual(
      (tools.get(`ignore-${a}-4`)!.details as TaskToolDetails).tasks,
      [],
    );
    assert.deepEqual(
      reportsIn(finalContext)
        .filter(({ id }) => id === a)
        .map(({ attempt, status, decisionRequired }) => [
          attempt,
          status,
          decisionRequired,
        ]),
      [
        [3, "failed", true],
        [4, "failed", true],
      ],
    );
    assert.equal(markersIn(finalContext).length, 1);
  });

  test("{ retries: 0 }: the first failure asks; invalid decisions change nothing and a retry reuses the logical id", async () => {
    const r = registry("caller", "a", "b");
    worker(r, "a", 1);
    worker(r, "b");
    let finalContext: Context | undefined;
    let probed = false;
    const { caller, outer, id } = await failingCaller(
      r,
      ["a", "b"],
      { retries: 0 },
      answering(
        (report) => [
          decision("ignore", { id: "task-unknown", attempt: 1 }, "unknown"),
          decision("retry", { id: report.id, attempt: 2 }, "stale"),
          decision("retry", report, "retry"),
          decision("ignore", report, "repeated"),
        ],
        (context) => {
          finalContext = context;
          if (probed) return fauxAssistantMessage("final");
          probed = true;
          const [a] = markersIn(context)[0] ?? [];
          // The retried attempt completed: no decision about it is pending.
          return toolUse(
            decision("ignore", { id: a!, attempt: 2 }, "completed"),
          );
        },
      ),
    );
    const children = childrenOf(caller);

    const results = await outer.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "final");
    assert.ok(finalContext);
    const [a, b] = markersIn(finalContext)[0] ?? [];
    assert.ok(a && b);
    const tools = toolResultsIn(finalContext);
    for (const call of ["unknown", "stale", "repeated", "completed"])
      assert.equal(tools.get(call)?.isError, true, call);
    assert.equal(tools.get("retry")?.isError, false);
    assert.deepEqual((tools.get("retry")!.details as TaskToolDetails).tasks, [
      { id: a, name: "a" },
    ]);
    assert.equal(children("a").length, 2);
    assert.equal(children("b").length, 1);
    assert.deepEqual(taskNodes(outer), [a, b, `${a}:attempt:2`]);
    assert.deepEqual(
      reportsIn(finalContext)
        .filter((report) => report.id === a)
        .map(({ attempt, status, decisionRequired }) => [
          attempt,
          status,
          decisionRequired,
        ]),
      [
        [1, "failed", true],
        [2, "completed", undefined],
      ],
    );
    assert.equal(markersIn(finalContext).length, 1);
  });

  test("a caller that settles with a consumed, undecided failure question fails its graph", async () => {
    const r = registry("caller", "a");
    worker(r, "a", 1);
    const { caller, outer } = await failingCaller(
      r,
      ["a"],
      { retries: 0 },
      answering(undefined, () => assert.fail("no marker")),
    );
    const children = childrenOf(caller);
    const failure = await outer.run().then(
      () => assert.fail("the graph failed"),
      (error: unknown) => error,
    );
    assert.ok(
      causesOf(failure).some(
        (cause) =>
          cause instanceof agentApi.JuncoAgentError &&
          /^Task failure decisions required: task-/.test(cause.message),
      ),
    );
    assert.equal(children("a").length, 1);

    // A refused explicit retry restores the pending decision; settling without one still fails.
    {
      const r = registry("caller", "a");
      worker(r, "a", 1);
      let acquisitions = 0;
      let rejections = 0;
      const { caller, outer } = await failingCaller(
        r,
        ["a"],
        { retries: 0 },
        answering(
          (report) => [decision("retry", report, "retry")],
          () => assert.fail("no marker"),
        ),
      );
      const children = childrenOf(caller, undefined, () => {
        if (++acquisitions === 1) return;
        rejections += 1;
        throw new Error("no capacity");
      });
      const failure = await outer.run().then(
        () => assert.fail("the graph failed"),
        (error: unknown) => error,
      );
      assert.equal(rejections, 1);
      assert.ok(
        causesOf(failure).some(
          (cause) =>
            cause instanceof agentApi.JuncoAgentError &&
            cause.code === "invalid_state" &&
            /^Task failure decisions required:/.test(cause.message),
        ),
      );
      assert.equal(children("a").length, 1);
    }
  });

  test("a rejected retry allocation consumes a retry and creates no attempt; exhaustion asks the caller", async () => {
    const r = registry("caller", "a");
    worker(r, "a", 1);
    let acquisitions = 0;
    let rejections = 0;
    const questions: Report[] = [];
    let finalContext: Context | undefined;
    const { caller, outer } = await failingCaller(
      r,
      ["a"],
      { retries: 1 },
      answering(
        (report) => {
          questions.push(report);
          return [
            decision("retry", report, "retry"),
            decision("ignore", report, "ignore"),
          ];
        },
        (context) => {
          finalContext = context;
          return fauxAssistantMessage("final");
        },
      ),
    );
    // Only the launch acquires; every retry allocation is refused.
    const children = childrenOf(caller, undefined, () => {
      if (++acquisitions === 1) return;
      rejections += 1;
      throw new Error("no capacity");
    });

    await outer.run();
    assert.ok(finalContext);
    assert.equal(rejections, 2, "the automatic and the explicit retry");
    assert.deepEqual(
      questions.map(({ attempt, decisionRequired }) => [
        attempt,
        decisionRequired,
      ]),
      [[1, true]],
    );
    assert.match(questions[0]?.error ?? "", /no capacity/);
    const tools = toolResultsIn(finalContext);
    assert.equal(tools.get("retry")?.isError, true);
    assert.match(textOf(tools.get("retry")!), /no capacity/);
    assert.equal(tools.get("ignore")?.isError, false);
    assert.equal(children("a").length, 1);
    assert.deepEqual(taskNodes(outer), [questions[0]?.id]);
    assert.equal(markersIn(finalContext).length, 1);
  });

  test("a failed attempt whose teardown fails fails the graph and starts no replacement, even under ignore", async () => {
    for (const policy of ["ignore", { retries: 1 }] as const) {
      const r = registry("caller", "a");
      worker(r, "a", 1);
      const { caller, outer } = await failingCaller(
        r,
        ["a"],
        policy,
        answering(undefined, () => fauxAssistantMessage("final")),
      );
      // Sessions created while the caller acquires a child refuse to close.
      let arm = false;
      const create = MemorySessionRepo.prototype.create;
      MemorySessionRepo.prototype.create = async function (...args) {
        const session = await create.apply(this, args);
        if (arm) {
          const close = session.close.bind(session);
          session.close = async (...rest) => {
            await close(...rest);
            throw new Error("session close failed");
          };
        }
        return session;
      };
      try {
        const children = childrenOf(caller, undefined, () => {
          arm = true;
        });
        const failure = await outer.run().then(
          () => assert.fail("the graph failed"),
          (error: unknown) => error,
        );
        const causes = causesOf(failure);
        assert.ok(
          causes.some(
            (cause) =>
              cause instanceof Error &&
              cause.message === "session close failed",
          ),
        );
        assert.equal(children("a").length, 1, "no replacement attempt");
        assert.equal(r.calls("a"), 1);
      } finally {
        MemorySessionRepo.prototype.create = create;
      }
    }
  });

  test("closing the graph while a failure retires propagates cancellation without retrying", async () => {
    const r = registry("caller", "a");
    let closing: Promise<unknown> | undefined;
    let outerGraph: JuncoGraph | undefined;
    r.script("a", [
      () => {
        closing = outerGraph?.close();
        return outcome("a", true, 1);
      },
      fauxAssistantMessage("must not run"),
    ]);
    const { caller, outer } = await failingCaller(
      r,
      ["a"],
      { retries: 2 },
      answering(
        () => assert.fail("no question"),
        () => assert.fail("no marker"),
      ),
    );
    outerGraph = outer;
    const children = childrenOf(caller);
    await assert.rejects(outer.run());
    await closing?.catch(() => {});
    assert.equal(r.calls("a"), 1);
    assert.equal(children("a").length, 1);
    assert.equal(children("a")[0]?.status, "closed");
    assert.equal(caller.status, "closed");
  });

  test("an abort after a retry is allocated and before publication closes the new attempt", async () => {
    const r = registry("caller", "a");
    worker(r, "a", 1);
    const { caller, outer } = await failingCaller(
      r,
      ["a"],
      { retries: 0 },
      answering(
        (report) => [decision("retry", report, "retry")],
        () => assert.fail("no marker"),
      ),
    );
    caller.hooks.on("after_tool", ({ toolCallId }) => {
      if (toolCallId === "retry") void caller.abort();
      return undefined;
    });
    const children = childrenOf(caller);
    await assert.rejects(outer.run());
    assert.equal(children("a").length, 2, "the retry was allocated");
    for (const child of children("a")) assert.equal(child.status, "closed");
    assert.equal(r.calls("a"), 1, "the retry never ran");
  });
});
