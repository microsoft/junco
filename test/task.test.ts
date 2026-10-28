/// <reference lib="es2024.promise" />
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AgentMessage,
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type PromptTemplate,
  type Skill,
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
import { LockPolicy, type TaskToolDetails } from "junco-tools";
import { errorGraph } from "junco-tools/errors";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type AgenticInput,
  AgenticInputSchema,
  AssistantMessageSchema,
  agent as agentApi,
  Deterministic,
  graph,
  JuncoGraph,
  schedules,
  tools as toolsApi,
  tracer,
  trigger,
} from "../src/index.ts";
import {
  assistant,
  terminalPorts,
  userTexts,
} from "./deterministic-support.ts";
import { toolTurn, waitingTool } from "./support.ts";

// Real JuncoAgents on Pi's faux providers, driven as graph-registered agents on the parallel policy: a
// `task` call runs fresh subagents natively in the background while the caller's node stays itself.

type Agent = agentApi.JuncoAgent;
type Chat = typeof AgenticInputSchema;

const quiet = new tracer.DummyTracer();

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
  /** The task-schema identity of `name`'s model. */
  const model = (name: string) => ({
    provider: name,
    modelId: faux(name).getModel().id,
  });
  return {
    models,
    script: (name: string, responses: readonly FauxResponseStep[]) =>
      faux(name).setResponses([...responses]),
    model,
    calls: (name: string) => faux(name).state.callCount,
    /** An agent on `provider`'s model with `tools`, returned after the test. */
    async agent(
      provider: string,
      tools: AgentTool[],
      recorder?: toolsApi.ProfileRecorder<string>,
    ): Promise<Agent> {
      const resolved = models.getModels(provider)[0];
      assert.ok(resolved);
      const agent = await agentApi.JuncoAgent.fromResolved({
        session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
        models,
        model: resolved,
        systemPrompt: "sys",
        ...(recorder === undefined ? {} : { recorder }),
        tools,
      });
      closers.push(() => agent.return());
      return agent;
    },
    /**
     * Scripts `name`'s worker: its first `failures` attempts stop natively with an error and
     * partial output, later ones report `<name>-report`.
     */
    worker(name: string, failures = 0, prompts: string[] = []): string[] {
      faux(name).setResponses(
        Array.from(
          { length: failures + 2 },
          (_, index) => (context: Context) => {
            prompts.push(userTexts(context.messages)[0] ?? "");
            return index < failures
              ? fauxAssistantMessage(`${name} partial ${index + 1}`, {
                  stopReason: "error",
                  errorMessage: `${name} boom ${index + 1}`,
                })
              : fauxAssistantMessage(`${name}-report`);
          },
        ),
      );
      return prompts;
    },
    /** A task on `name`'s model with no tools. */
    task: (name: string): toolsApi.TaskInput["tasks"][number] => ({
      name,
      task: `do ${name}`,
      model: model(name),
      tools: [],
    }),
  };
}

/** Records every agent `caller.createSubagents` returns, recursively for descendants. */
function trackSubagents(
  caller: Agent,
  observe?: (parent: Agent, child: Agent, index: number) => void,
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

const textOf = (message: AgentMessage): string =>
  "content" in message ? contentText(message.content) : "";

/** Every task report among `context`'s user messages, parsed. */
const reportsIn = (context: Context): agentApi.TaskResult[] =>
  userTexts(context.messages)
    .filter((text) => text.startsWith('{"type":"task_result"'))
    .map((text): agentApi.TaskResult => JSON.parse(text));

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

function callerNode(caller: Agent, prompt = "Start") {
  caller.stagePrompt(prompt);
  return {
    id: graph.NodeId.create("caller"),
    trigger: trigger.TriggerRule.always(),
    policy: LockPolicy,
    state: caller,
  };
}

/** The caller graph's execution, and its terminal ports to `connect` to its result node. */
function taskExecution(
  observer: tracer.DataflowTracer = quiet,
  recorder?: toolsApi.ProfileRecorder<string>,
) {
  const ports = terminalPorts();
  const work = new JuncoGraph(
    ports.source,
    ports.sink,
    graph.Width.create(1),
    graph.UNBOUNDED,
    observer,
    LockPolicy,
    undefined,
    recorder,
  );
  return {
    execution: schedules.context({
      graph: work,
      scheduler: schedules.parallel(),
    }),
    ports,
  };
}

/** The ids of every batch-completion marker among `context`'s user messages. */
const markersIn = (context: Context): string[][] =>
  userTexts(context.messages)
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
  decide: ((report: agentApi.TaskResult) => ToolCall[]) | undefined,
  finish: (context: Context) => AssistantMessage,
): FauxResponseStep[] {
  const asked = new Set<string>();
  const step = (context: Context) => {
    for (const report of reportsIn(context)) {
      const key = `${report.id}#${report.attempt}`;
      if (decide === undefined || !report.decisionRequired || asked.has(key))
        continue;
      asked.add(key);
      return toolTurn(...decide(report));
    }
    return markersIn(context).length > 0
      ? finish(context)
      : fauxAssistantMessage("waiting for researchers");
  };
  return Array.from({ length: 16 }, () => step);
}

/** A caller whose first turn launches `names`' tasks under `policy`, then answers with `turns`. */
async function failingCaller(
  r: ReturnType<typeof registry>,
  names: string[],
  policy: agentApi.TaskFailurePolicy,
  turns: FauxResponseStep[],
  recorder?: toolsApi.ProfileRecorder<string>,
) {
  r.script("caller", [
    toolTurn(taskCall(names.map((name) => r.task(name)))),
    ...turns,
  ]);
  const caller = await r.agent(
    "caller",
    [new toolsApi.TaskTool()],
    recorder,
  );
  caller.setTaskFailurePolicy(policy);
  const { execution, ports } = taskExecution(quiet, recorder);
  const outer = execution.graph;
  closers.push(() => outer.close());
  const id = outer.addNode(callerNode(caller));
  ports.connect(outer, id);
  return { caller, outer, execution, id };
}

/** Identities of every member (id, node, state, step, trigger) and link of `work`, in order. */
function geometryOf<N extends TSchema, T>(work: JuncoGraph<N, T>): unknown[] {
  const parts: unknown[] = [];
  work.forEachNode((id, node) =>
    parts.push(id, node, node.state, node.step, node.trigger),
  );
  work.forEachLink((from, to, edge) => parts.push(from, to, edge));
  return parts;
}

/** Asserts `work` still holds exactly the members and links `before` captured, by identity. */
function assertGeometry<N extends TSchema, T>(
  work: JuncoGraph<N, T>,
  before: unknown[],
): void {
  const after = geometryOf(work);
  assert.equal(after.length, before.length, "no node or edge was added");
  for (const [index, part] of after.entries())
    assert.equal(part, before[index], "graph geometry is unchanged");
}

/** Every main-lane native run `agent` starts from now on. */
function mainRuns(agent: Agent): Set<string> {
  const ids = new Set<string>();
  agent.events.on("run_start", ({ lane, runId }) => {
    if (lane === "main") ids.add(runId);
  });
  return ids;
}

/** Handle ids of the task tool result for `callId` (the launch, by default) in `context`. */
function handleIdsOf(context: Context, callId = "task-call"): string[] {
  const result = toolResultsIn(context).get(callId);
  assert.ok(result && !result.isError, `task call ${callId} admitted`);
  const details = result.details as TaskToolDetails;
  return details.tasks.map(({ id }) => id);
}

/** `caller.getTaskResults()` matches exactly the genuine reports in `context`, in delivery order. */
function assertDelivered(caller: Agent, context: Context): void {
  assert.deepEqual(
    caller
      .getTaskResults()
      .map(({ id, attempt, status }) => [id, attempt, status]),
    reportsIn(context).map(({ id, attempt, status }) => [id, attempt, status]),
  );
}

describe("native tasks on a graph-driven caller", () => {
  test("a caller's accepted send stays queued when its run later fails on an undecided task failure", async () => {
    const r = registry("caller", "worker");
    const outbound = graph.Edge.message<Chat, AssistantMessage>(
      "accepted",
      AgenticInputSchema,
    );
    let failedContext: Context | undefined;
    r.worker("worker", 1);
    r.script("caller", [
      toolTurn(taskCall([r.task("worker")])),
      toolTurn(
        fauxToolCall(
          "send",
          {
            id: outbound.id,
            payload: { kind: "followUp", text: "accepted" },
          },
          { id: "accepted-send" },
        ),
      ),
      // The caller ends without deciding the failed worker's report.
      ...Array.from({ length: 4 }, () => (context: Context) => {
        failedContext = context;
        return fauxAssistantMessage("done without deciding");
      }),
    ]);
    const caller = await r.agent("caller", [
      new toolsApi.TaskTool(),
      new toolsApi.SendTool(),
    ]);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);
    const receiver = outer.addNode({
      id: graph.NodeId.create("receiver"),
      trigger: trigger.TriggerRule.allOf(trigger.TriggerEntry.on(outbound)),
      state: new Deterministic<Chat, AssistantMessage>(async function* () {
        yield [];
        return fauxAssistantMessage("receiver");
      }, LockPolicy),
    });
    outer.addEdge(id, receiver, outbound);
    const geometry = geometryOf(outer);

    const failure = await execution.run().then(
      () => assert.fail("the caller's run must fail"),
      (error: unknown) => error,
    );
    assert.ok(failedContext);
    const [failed] = reportsIn(failedContext);
    assert.ok(failed?.decisionRequired, "the failure was delivered");
    assert.deepEqual(handleIdsOf(failedContext), [failed.id]);
    assert.ok(
      [...errorGraph(failure)].some(
        (cause) =>
          cause instanceof agentApi.JuncoAgentError &&
          cause.message === `Task failure decisions required: ${failed.id}`,
      ),
      "the undecided task failure fails the caller's run",
    );
    assert.equal(
      toolResultsIn(failedContext).get("accepted-send")?.isError,
      false,
    );
    assert.deepEqual(
      outer.observe().inputs.get(receiver)?.messages.get(outbound.id) ?? [],
      [{ kind: "followUp", text: "accepted" }],
      "an accepted send stays queued on the real edge",
    );
    assert.equal(outer.getNode(id)?.state, caller);
    assertGeometry(outer, geometry);
  });

  test("workers start immediately while the caller keeps working in its one native run; their reports finish the original node", async () => {
    const hold = waitingTool("hold");
    const r = registry("caller", "alpha", "beta");
    const seen: {
      handles?: TaskToolDetails["tasks"];
      reports?: agentApi.TaskResult[];
    } = {};
    const order: string[] = [];
    const interim = Promise.withResolvers<void>();
    const betaSeen = Promise.withResolvers<void>();
    r.script("caller", [
      toolTurn(
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
        interim.resolve();
        return fauxAssistantMessage("interim: waiting for workers");
      },
      ...Array.from({ length: 4 }, () => (context: Context) => {
        const reports = reportsIn(context);
        if (markersIn(context).length === 0) {
          if (reports.some(({ name }) => name === "beta")) betaSeen.resolve();
          return fauxAssistantMessage("waiting for alpha");
        }
        seen.reports = reports;
        return fauxAssistantMessage("combined: alpha-report + beta-report");
      }),
    ]);
    const workerContexts: Context[] = [];
    r.script("alpha", [
      (context) => {
        workerContexts.push(context);
        return toolTurn(fauxToolCall("hold", {}, { id: "h1" }));
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
    const caller = await r.agent("caller", [
      new toolsApi.TaskTool(),
      hold.tool,
    ]);
    const created = trackSubagents(caller);
    const runIds = mainRuns(caller);

    const activations: { graph: object; id: graph.NodeIdType }[] = [];
    const observer: tracer.DataflowTracer = {
      startRun<S, N extends TSchema, T, EH>(
        traced: graph.DataflowGraph<S, N, T, EH>,
      ): tracer.DataflowRunTrace<N, T> {
        return {
          startNode(id) {
            activations.push({ graph: traced, id });
            return { end() {}, fail() {} };
          },
          end() {},
          fail() {},
        };
      },
      complain() {},
      async flush() {},
    };
    const { execution, ports } = taskExecution(observer);
    const outer = execution.graph;
    const id = outer.addNode(callerNode(caller, "Start the workers"));
    ports.connect(outer, id);
    closers.push(() => outer.close());
    const node = outer.getNode(id);
    const geometry = geometryOf(outer);
    const running = execution.run();

    // alpha is blocked in its tool while the caller answers and receives beta's fast report.
    await Promise.all([hold.started, interim.promise, betaSeen.promise]);
    assert.deepEqual(order, ["caller-interim"], "alpha is still held");
    assert.ok(
      O.isNone(outer.result(id)),
      "an interim answer is not the node's result",
    );
    assert.equal(outer.getNode(id), node, "the node itself is unchanged");
    assert.equal(node?.state, caller);
    assertGeometry(outer, geometry);
    const handles = seen.handles ?? [];
    assert.deepEqual(
      handles.map(({ name }) => name),
      ["alpha", "beta"],
    );
    const childIds = handles.map(({ id }) => id);
    assert.equal(new Set(childIds).size, 2);
    assert.equal(created.length, 2, "both workers were acquired");
    assert.equal(runIds.size, 1);

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
        [childIds[1], "beta", "beta-report", "completed"],
        [childIds[0], "alpha", "alpha-report", "completed"],
      ],
      "the fast report arrived first, each once",
    );
    assert.equal(
      runIds.size,
      1,
      "the caller's one native run took the reports",
    );
    for (const context of workerContexts) {
      assert.equal(
        userTexts(context.messages).some((text) =>
          text.includes("Start the workers"),
        ),
        false,
        "a worker's fresh session excludes the caller transcript",
      );
    }
    assert.deepEqual(
      workerContexts.map((context) => userTexts(context.messages)[0]).sort(),
      [childPrompt("do alpha"), childPrompt("do beta")],
    );
    for (const child of childIds)
      assert.ok(child.startsWith("task-"), "the worker has its real task ID");
    const members = new Set<string>();
    outer.forEachNode((member) => members.add(member));
    for (const event of activations) {
      assert.equal(event.graph, outer, "only the outer graph activates nodes");
      assert.ok(members.has(event.id), `${event.id} is a real graph member`);
    }
    assert.equal(outer.getNode(id), node);
    assertGeometry(outer, geometry);
  });

  test("a numeric outer agent keeps its numeric sibling routes while task traffic stays chat", async () => {
    const NumberSchema = Type.Number();
    // Graph ports are chat, the caller's own sibling routes numeric.
    type N = typeof NumberSchema | Chat;
    type T = number | AssistantMessage;
    type Received = {
      messages: { id: string; payload: unknown }[];
      values: { id: string; payload: unknown }[];
    };
    const r = registry("caller", "a", "b");
    r.worker("a", 1);
    r.worker("b");
    const inbound = graph.Edge.message("producer->caller", NumberSchema);
    const parentValue = graph.Edge.value("producer=>caller", NumberSchema);
    const outbound = graph.Edge.message("caller->consumer", NumberSchema);
    const result = graph.Edge.value("caller->$sink", AssistantMessageSchema);
    let call = 0;
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
      toolTurn(fauxToolCall(name, args, { id: `${name}-${++call}` }));
    const received = (context: Context): Received[] =>
      context.messages.flatMap((message) =>
        message.role === "toolResult" && message.toolName === "recv"
          ? [JSON.parse(contentText(message.content)) as Received]
          : [],
      );
    let finalContext: Context | undefined;
    const step = (context: Context) => {
      finalContext = context;
      const inbox = received(context);
      const messages = inbox.flatMap(({ messages }) => messages);
      const values = inbox.flatMap(({ values }) => values);
      if (messages.length === 0 || values.length === 0)
        return lastToolResult(context).toolName === "recv"
          ? tool("yield", { reason: "wait for numbers" })
          : tool("recv", {});
      const results = toolResultsIn(context);
      if (![...results.values()].some(({ toolName }) => toolName === "send"))
        return tool("send", { id: outbound.id, payload: 42 });
      if (!results.has("task-later"))
        return toolTurn(taskCall([r.task("b")], "task-later"));
      return markersIn(context).length >= 2
        ? fauxAssistantMessage("numeric done")
        : fauxAssistantMessage("waiting for researchers");
    };
    r.script("caller", [
      toolTurn(taskCall([r.task("a")])),
      ...Array.from({ length: 40 }, () => step),
    ]);
    const model = r.models.getModels("caller")[0];
    assert.ok(model);
    const tools: AgentTool[] = [
      new toolsApi.TaskTool(),
      new toolsApi.YieldTool(),
      new toolsApi.RecvTool(),
      new toolsApi.SendTool(),
    ];
    const caller = await agentApi.JuncoAgent.fromResolved<
      Skill,
      PromptTemplate,
      AgentTool,
      N,
      T
    >({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models: r.models,
      model,
      systemPrompt: "sys",
      tools,
    });
    closers.push(() => caller.return());
    caller.setTaskFailurePolicy({ retries: 1 });
    caller.stagePrompt("Start");
    const created = trackSubagents(caller);

    const source = new graph.nodes.Source<N, T>(
      () => {
        throw new graph.DataflowDefinitionError("No external input");
      },
      { id: graph.NodeId.create("$source"), schema: AgenticInputSchema },
    );
    const sink = new graph.nodes.Sink<N, T>(
      async function* () {
        const view = yield [];
        const value = view.values.get(result.id);
        assert.ok(value !== undefined);
        return value;
      },
      {
        id: graph.NodeId.create("$sink"),
        schema: AgenticInputSchema,
        trigger: trigger.TriggerRule.when(result),
      },
    );
    const outer = new JuncoGraph(
      source,
      sink,
      graph.Width.create(1),
      graph.UNBOUNDED,
      quiet,
      LockPolicy,
    );
    closers.push(() => outer.close());
    const execution = schedules.context({
      graph: outer,
      scheduler: schedules.parallel(),
    });
    const callerId = outer.addNode({
      id: graph.NodeId.create("caller"),
      trigger: trigger.TriggerRule.always(),
      policy: LockPolicy,
      state: caller,
    });
    const producerId = outer.addNode({
      id: graph.NodeId.create("producer"),
      trigger: trigger.TriggerRule.always(),
      state: new Deterministic<N, T>(async function* () {
        yield [graph.Message.create(inbound, 7)];
        return 3;
      }, LockPolicy),
    });
    const consumed: number[] = [];
    const consumerId = outer.addNode({
      id: graph.NodeId.create("consumer"),
      trigger: trigger.TriggerRule.when(outbound),
      state: new Deterministic<N, T>(async function* () {
        const view = yield [];
        consumed.push(...graph.from(view, outbound));
        return consumed.length;
      }, LockPolicy),
    });
    outer
      .addEdge(producerId, callerId, inbound)
      .addEdge(producerId, callerId, parentValue)
      .addEdge(callerId, consumerId, outbound)
      .addEdge(callerId, sink.id, result);
    const node = outer.getNode(callerId);
    const geometry = geometryOf(outer);

    const results = await execution.run();
    const final = results.get(callerId);
    assert.ok(Value.Check(AssistantMessageSchema, final));
    assert.equal(contentText(final.content), "numeric done");
    // The outbound number reached its real edge while tasks ran.
    assert.deepEqual(consumed, [42]);
    // Numeric messages and parent values reached the retained inbox; task reports never did.
    const context = finalContext;
    assert.ok(context);
    const inbox = received(context);
    assert.deepEqual(
      inbox.flatMap(({ messages }) => messages),
      [{ id: inbound.id, payload: 7 }],
    );
    assert.deepEqual(
      inbox.flatMap(({ values }) => values),
      [{ id: parentValue.id, payload: 3 }],
    );
    // Both batches resolved as chat reports: the retried `a` and the later `b`.
    assert.equal(markersIn(context).length, 2);
    assert.deepEqual(
      reportsIn(context)
        .map(({ name, attempt, status }) => [name, attempt, status])
        .sort(),
      [
        ["a", 2, "completed"],
        ["b", 1, "completed"],
      ],
    );
    assert.equal(created.length, 3, "initial, retried and later children");
    assert.equal(outer.getNode(callerId), node);
    assert.equal(node?.state, caller);
    assertGeometry(outer, geometry);
  });

  test("external edges preserve routing: recv postponed across Yield, values once, messages in order, info/send on the original node, only the final result downstream", async () => {
    const r = registry("caller", "alpha", "beta");
    type Edge = graph.Edge<Chat, AssistantMessage>;
    type Route = { id: string; edgeId: string; kind: string };
    type Info = { parents: Route[]; children: Route[] };
    type Received = {
      messages: { id: string; payload: AgenticInput }[];
      values: { id: string; payload: AssistantMessage }[];
    };
    const sourceEdge: Edge = graph.Edge.value(
      "source=>caller",
      AssistantMessageSchema,
    );
    const notesEdge: Edge = graph.Edge.message(
      "notes->caller",
      AgenticInputSchema,
    );
    const outboundEdge: Edge = graph.Edge.message(
      "caller->down",
      AgenticInputSchema,
    );
    const resultEdge: Edge = graph.Edge.value(
      "caller=>down",
      AssistantMessageSchema,
    );
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
    const childInfoErrors: boolean[] = [];
    const turn = (context: Context): AssistantMessage => {
      const tasks = context.messages.filter(
        (message) =>
          message.role === "toolResult" && message.toolName === "task",
      ).length;
      if (tasks === 0)
        return toolTurn(
          taskCall([
            {
              name: "alpha",
              task: "work",
              model: r.model("alpha"),
              tools: ["yield", "info"],
            },
          ]),
        );
      if (!called(context, "yield")) return toolTurn(yieldCall("checkpoint"));
      const infos = results<Info>(context, "info");
      if (infos.length === 0)
        return toolTurn(fauxToolCall("info", {}, { id: "info-1" }));
      const received = results<Received>(context, "recv");
      const messages = received.flatMap((batch) => batch.messages);
      if (messages.length < 5) {
        const last = context.messages.at(-1);
        return toolTurn(
          last?.role === "toolResult" && last.toolName === "recv"
            ? yieldCall("waiting for notes", `wait-${received.length}`)
            : fauxToolCall("recv", {}, { id: `recv-${received.length}` }),
        );
      }
      // A later admission while the first batch may still run.
      if (tasks === 1)
        return toolTurn(
          taskCall(
            [{ name: "beta", task: "more", model: r.model("beta"), tools: [] }],
            "task-2",
          ),
        );
      if (infos.length === 1)
        return toolTurn(fauxToolCall("info", {}, { id: "info-2" }));
      const sendResults = context.messages
        .filter((message) => message.role === "toolResult")
        .filter((message) => message.toolName === "send");
      if (sendResults.length < 2)
        return toolTurn(
          fauxToolCall(
            "send",
            {
              id: sendResults.length === 0 ? "missing" : resultEdge.id,
              payload: { kind: "followUp", text: "must not stage" },
            },
            { id: `invalid-send-${sendResults.length}` },
          ),
        );
      if (sendResults.length === 2) {
        callerInfos.push(...infos);
        const route = infos
          .at(-1)
          ?.children.find((child) => child.kind === "message");
        assert.ok(route, "info names an outgoing message route");
        return toolTurn(
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
      // Five individually delivered notes add six recv/yield turns; rejected sends add two.
      Array.from({ length: 40 }, () => turn),
    );
    r.script("alpha", [
      () => {
        alphaStarted = true;
        return toolTurn(fauxToolCall("info", {}, { id: "alpha-info" }));
      },
      (context) => {
        childInfoErrors.push(lastToolResult(context).isError);
        return toolTurn(yieldCall("alpha pause"));
      },
      fauxAssistantMessage("alpha-report"),
    ]);
    r.script("beta", [fauxAssistantMessage("beta-report")]);
    const caller = await r.agent(
      "caller",
      [
        new toolsApi.TaskTool(),
        new toolsApi.YieldTool(),
        new toolsApi.RecvTool(),
        new toolsApi.SendTool(),
        new toolsApi.InfoTool(),
      ],
    );
    const upstreamValue = fauxAssistantMessage("upstream value");
    const received: string[] = [];
    let downstreamValue: AssistantMessage | undefined;

    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const sourceId = outer.addNode({
      trigger: trigger.TriggerRule.always(),
      state: new Deterministic<Chat, AssistantMessage>(async function* () {
        yield [];
        return upstreamValue;
      }, LockPolicy),
    });
    const notesId = outer.addNode({
      // Emits once the worker is running, while the caller is suspended or working.
      trigger: trigger.TriggerRule.always(),
      is_available: () => alphaStarted,
      state: new Deterministic<Chat, AssistantMessage>(async function* () {
        for (let n = 1; n <= 5; n++)
          yield [
            {
              id: notesEdge.id,
              payload: { kind: "followUp", text: `note-${n}` },
            },
          ];
        return fauxAssistantMessage("notes done");
      }, LockPolicy),
    });
    caller.stagePrompt("Start");
    const callerId = outer.addNode({
      id: graph.NodeId.create("caller"),
      policy: LockPolicy,
      trigger: trigger.TriggerRule.anyOf(
        trigger.TriggerEntry.on(notesEdge),
        trigger.TriggerEntry.on(sourceEdge),
      ),
      state: caller,
    });
    const downId = outer.addNode({
      trigger: trigger.TriggerRule.anyOf(
        trigger.TriggerEntry.on(outboundEdge),
        trigger.TriggerEntry.on(resultEdge),
      ),
      state: new Deterministic<Chat, AssistantMessage>(async function* () {
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
      }, LockPolicy),
    });
    ports.connect(outer, downId);
    outer
      .addEdge(sourceId, callerId, sourceEdge)
      .addEdge(notesId, callerId, notesEdge)
      .addEdge(callerId, downId, outboundEdge)
      .addEdge(callerId, downId, resultEdge);
    const node = outer.getNode(callerId);
    const geometry = geometryOf(outer);

    const results_ = await execution.run();
    const final = results_.get(callerId);
    assert.ok(final);
    assert.equal(contentText(final.content), "final answer");
    assert.equal(results_.get(outer.sink.id), final);
    assert.equal(outer.getNode(callerId), node);
    assert.equal(node?.state, caller);
    assertGeometry(outer, geometry);
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
      Array.from({ length: 5 }, (_, n) => [notesEdge.id, `note-${n + 1}`]),
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
    const sendResults = finalContext.messages
      .filter((message) => message.role === "toolResult")
      .filter((message) => message.toolName === "send");
    assert.equal(sendResults.length, 3);
    assert.equal(sendResults[0]?.isError, true);
    assert.equal(sendResults[1]?.isError, true);
    assert.equal(sendResults[2]?.isError, false);
    assert.equal(
      userTexts(finalContext.messages).includes("note-1"),
      false,
      "notes are data, not prompts",
    );
    assert.deepEqual(
      reportsIn(finalContext)
        .map(({ output }) => output)
        .sort(),
      ["alpha-report", "beta-report"],
    );

    // The caller, before and after a later admission, reports its outer node's routes.
    const route = (id: string, edge: Edge, kind: string) => ({
      id,
      edgeId: edge.id,
      kind,
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
    // A child never inherits the caller's graph routes.
    assert.deepEqual(childInfoErrors, [true]);

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

  test("calls in one batch and a later call return ordered handles; each report reaches the caller once", async () => {
    const r = registry("caller", "worker");
    const contexts: Context[] = [];
    const step = (context: Context) => {
      const results = toolResultsIn(context);
      if (!results.has("t1"))
        return toolTurn(
          taskCall(
            [{ name: "alpha", task: "a", model: r.model("worker") }],
            "t1",
          ),
          taskCall(
            [{ name: "beta", task: "b", model: r.model("worker") }],
            "t2",
          ),
        );
      const markers = markersIn(context).length;
      if (markers === 2 && !results.has("t3")) {
        contexts.push(context);
        return toolTurn(
          taskCall(
            [{ name: "gamma", task: "c", model: r.model("worker") }],
            "t3",
          ),
        );
      }
      if (markers === 3) {
        contexts.push(context);
        return fauxAssistantMessage("final");
      }
      return fauxAssistantMessage("interim");
    };
    r.script(
      "caller",
      Array.from({ length: 12 }, () => step),
    );
    const report = (context: Context) =>
      fauxAssistantMessage(`${userTexts(context.messages)[0]}-report`);
    r.script("worker", [report, report, report]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const created = trackSubagents(caller);
    const runIds = mainRuns(caller);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);
    const geometry = geometryOf(outer);

    const results = await execution.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "final");
    assert.equal(contexts.length, 2);
    const [first, last] = contexts as [Context, Context];
    const [alpha] = handleIdsOf(last, "t1");
    const [beta] = handleIdsOf(last, "t2");
    const [gamma] = handleIdsOf(last, "t3");
    assert.ok(alpha && beta && gamma);
    assert.equal(new Set([alpha, beta, gamma]).size, 3);
    assert.equal(created.length, 3, "one child per task");
    const byName = (reports: agentApi.TaskResult[]) =>
      reports
        .map(({ id, name, output }) => [name, id, output])
        .sort(([a], [b]) => String(a).localeCompare(String(b)));
    assert.deepEqual(byName(reportsIn(first)), [
      ["alpha", alpha, `${childPrompt("a")}-report`],
      ["beta", beta, `${childPrompt("b")}-report`],
    ]);
    assert.deepEqual(
      markersIn(first)
        .map((ids) => ids.join())
        .sort(),
      [alpha, beta].sort(),
      "one marker per one-task batch",
    );
    assert.deepEqual(
      byName(reportsIn(last)),
      [
        ["alpha", alpha, `${childPrompt("a")}-report`],
        ["beta", beta, `${childPrompt("b")}-report`],
        ["gamma", gamma, `${childPrompt("c")}-report`],
      ],
      "the later report arrived, earlier reports kept once",
    );
    assert.deepEqual(markersIn(last).at(-1), [gamma]);
    assert.deepEqual(
      caller
        .getTaskResults()
        .map(({ id }) => id)
        .sort(),
      [alpha, beta, gamma].sort(),
    );
    assert.equal(runIds.size, 1);
    assert.equal(outer.getNode(id)?.state, caller);
    assertGeometry(outer, geometry);
  });

  test("a subagent's own task call runs its grandchild natively; the grandchild's report reaches the original caller", async () => {
    const r = registry("caller", "alpha", "grand");
    const combined = (prefix: string, interim: string) =>
      Array.from({ length: 4 }, () => (context: Context) => {
        const reports = reportsIn(context);
        return reports.length === 0
          ? fauxAssistantMessage(interim)
          : fauxAssistantMessage(
              `${prefix}${reports.map(({ output }) => output).join(",")}`,
            );
      });
    r.script("caller", [
      toolTurn(
        taskCall([
          {
            name: "alpha",
            task: "delegate",
            model: r.model("alpha"),
            tools: ["task"],
          },
        ]),
      ),
      ...combined("combined: ", "caller interim"),
    ]);
    r.script("alpha", [
      toolTurn(
        taskCall([
          { name: "grand", task: "leaf work", model: r.model("grand") },
        ]),
      ),
      ...combined("alpha saw ", "alpha interim"),
    ]);
    r.script("grand", [fauxAssistantMessage("grand-report")]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const parents: [Agent, Agent][] = [];
    const created = trackSubagents(caller, (parent, child) =>
      parents.push([parent, child]),
    );
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);
    const geometry = geometryOf(outer);

    const results = await execution.run();
    assert.equal(
      contentText(results.get(id)?.content ?? []),
      "combined: alpha saw grand-report",
    );
    const [alpha, grand] = created;
    assert.ok(alpha && grand);
    assert.equal(created.length, 2);
    assert.deepEqual(
      parents,
      [
        [caller, alpha],
        [alpha, grand],
      ],
      "the child acquired its own grandchild",
    );
    assert.equal(r.calls("grand"), 1);
    assert.equal(outer.getNode(id)?.state, caller);
    assertGeometry(outer, geometry);
  });

  test("a terminating hook, and reports queued while settlement is already pending, are processed once in the same native run", async () => {
    const r = registry("caller", "worker");
    const seen: Context[] = [];
    const step = (context: Context) => {
      seen.push(context);
      return markersIn(context).length === 2
        ? fauxAssistantMessage("final")
        : fauxAssistantMessage("after alpha");
    };
    r.script("caller", [
      toolTurn(
        taskCall(
          [{ name: "alpha", task: "a", model: r.model("worker") }],
          "t1",
        ),
      ),
      toolTurn(yieldCall("wait")),
      toolTurn(
        taskCall(
          [{ name: "gamma", task: "c", model: r.model("worker") }],
          "t2",
        ),
      ),
      ...Array.from({ length: 4 }, () => step),
    ]);
    r.script("worker", [
      fauxAssistantMessage("a-report"),
      fauxAssistantMessage("c-report"),
    ]);
    const caller = await r.agent("caller", [
      new toolsApi.TaskTool(),
      new toolsApi.YieldTool(),
    ]);
    caller.hooks.on("after_tool", ({ toolCallId }) =>
      toolCallId === "t2"
        ? { terminate: true, content: [{ type: "text", text: "rewritten" }] }
        : undefined,
    );
    const runIds = mainRuns(caller);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);
    const geometry = geometryOf(outer);

    const results = await execution.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "final");
    const last = seen.at(-1);
    assert.ok(last);
    assert.equal(
      contentText(toolResultsIn(last).get("t2")?.content ?? []),
      "rewritten",
      "the terminating hook's rewrite was kept",
    );
    assert.deepEqual(
      reportsIn(last)
        .map(({ output }) => output)
        .sort(),
      ["a-report", "c-report"],
      "each report entered the context once",
    );
    assert.equal(r.calls("worker"), 2);
    assert.equal(runIds.size, 1);
    assert.equal(outer.getNode(id)?.state, caller);
    assertGeometry(outer, geometry);
  });
});

describe("native task lifecycle and complaints", () => {
  test("an invalid batch fails as an ordinary tool error before any child is acquired, leaving the caller's node unchanged", async () => {
    const r = registry("caller", "worker");
    const errors: string[] = [];
    r.script("caller", [
      toolTurn(
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
        return toolTurn(taskCall([{ task: "bad", tools: ["missing"] }], "t2"));
      },
      (context) => {
        const result = lastToolResult(context);
        if (result.isError) errors.push(textOf(result));
        return fauxAssistantMessage("no tasks");
      },
    ]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const created = trackSubagents(caller);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);

    const results = await execution.run();
    assert.equal(contentText(results.get(id)?.content ?? []), "no tasks");
    assert.equal(outer.getNode(id)?.state, caller, "the node never expanded");
    assert.equal(created.length, 0);
    assert.equal(r.calls("worker"), 0);
    assert.equal(errors.length, 2);
    assert.match(errors[0]!, /Model not found: nope\/x/);
    assert.match(errors[1]!, /Unknown active tool: missing/);
  });

  test("an abort after acquisition and before admission closes the acquired children, admits nothing and keeps the caller's node", async () => {
    const r = registry("caller", "worker");
    r.script("caller", [
      toolTurn(
        taskCall(
          [
            { task: "a", model: r.model("worker") },
            { task: "b", model: r.model("worker") },
          ],
          "t1",
        ),
      ),
    ]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    let aborting: Promise<unknown> | undefined;
    const children = childrenOf(caller, (_provider, _child, nth) => {
      // Both children exist; the batch is still being prepared, so nothing is admitted yet.
      if (nth === 2) aborting = caller.abort();
    });
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);
    const node = outer.getNode(id);

    // The aborted native run settles as it does; what matters is that nothing was admitted.
    await execution.run().catch(() => undefined);
    assert.ok(aborting);
    await aborting;
    assert.equal(children("worker").length, 2);
    for (const child of children("worker"))
      assert.equal(child.status, "closed");
    assert.equal(outer.getNode(id), node, "the caller's node is unchanged");
    assert.equal(node?.state, caller);
    assert.equal(r.calls("worker"), 0, "no child ever started");
    assert.deepEqual(caller.getTaskResults(), []);
    assert.notEqual(
      caller.status,
      "closed",
      "the aborted caller stays reusable",
    );
  });

  test("closing the graph during acquisition creates no children", async () => {
    const r = registry("caller");
    r.script("caller", [toolTurn(taskCall([{ task: "a" }], "t1"))]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);
    let closing: Promise<unknown> | undefined;
    const acquired: Agent[] = [];
    caller.setSubagentObserver({
      // The graph closes while the batch is being acquired.
      acquiring: () => {
        closing = outer.close();
      },
      acquired: (child) => acquired.push(child),
    });
    await assert.rejects(execution.run());
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

  test("closing the graph while children run closes the caller and every running child, with no late reports", async () => {
    const holdA = waitingTool("holdA");
    const holdB = waitingTool("holdB");
    const r = registry("caller", "wa", "wb");
    r.script("caller", [
      toolTurn(
        taskCall([
          { task: "a", model: r.model("wa"), tools: ["holdA"] },
          { task: "b", model: r.model("wb"), tools: ["holdB"] },
        ]),
      ),
      fauxAssistantMessage("interim"),
    ]);
    r.script("wa", [
      toolTurn(fauxToolCall("holdA", {}, { id: "ha" })),
      fauxAssistantMessage("a-report"),
    ]);
    r.script("wb", [
      toolTurn(fauxToolCall("holdB", {}, { id: "hb" })),
      fauxAssistantMessage("b-report"),
    ]);
    const caller = await r.agent("caller", [
      new toolsApi.TaskTool(),
      holdA.tool,
      holdB.tool,
    ]);
    const created = trackSubagents(caller);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);
    const node = outer.getNode(id);
    const running = execution.run();
    await Promise.all([holdA.started, holdB.started]);
    assert.equal(outer.getNode(id), node);
    assert.equal(node?.state, caller, "the caller's node never changed");
    const closing = outer.close();
    holdA.release();
    holdB.release();
    await assert.rejects(running);
    await closing;
    assert.equal(caller.status, "closed");
    assert.equal(created.length, 2);
    for (const child of created) assert.equal(child.status, "closed");
    assert.equal(r.calls("wa"), 1, "no child answered after the close");
    assert.equal(r.calls("wb"), 1);
    assert.deepEqual(caller.getTaskResults(), [], "no late report arrived");
  });

  test("a caller-owned agent survives its round's close, which closes every child, and runs again in a fresh round with fresh task results", async () => {
    const r = registry("caller", "worker");
    r.script("caller", [
      toolTurn(taskCall([{ task: "a", model: r.model("worker") }])),
      fauxAssistantMessage("interim"),
      fauxAssistantMessage("round 1 final"),
      fauxAssistantMessage("round 2 final"),
    ]);
    r.script("worker", [fauxAssistantMessage("a-report")]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const created = trackSubagents(caller);
    const round = async (prompt: string) => {
      const execution = await JuncoGraph.fromYaml(
        `graph:\n  nodes:\n    caller:\n      prompt: ${prompt}\n  edges:\n    - from: caller\n      to: $sink\n      schema:\n        type: object\n        required: [role, content]\n`,
        {
          cwd: process.cwd(),
          scheduler: () => schedules.parallel(),
          tracer: quiet,
          createAgent: async () => caller,
          createAgentOwnership: "caller",
        },
      );
      try {
        const results = await execution.run();
        const result = results.get(graph.NodeId.create("caller"));
        assert.ok(Value.Check(AssistantMessageSchema, result));
        return {
          text: contentText(result.content),
          tasks: caller
            .getTaskResults()
            .map(({ status, output }) => `${status}:${output}`),
        };
      } finally {
        await execution.graph.close();
      }
    };

    assert.deepEqual(await round("Start"), {
      text: "round 1 final",
      tasks: ["completed:a-report"],
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]!.status, "closed");
    assert.notEqual(caller.status, "closed");
    assert.deepEqual(
      await round("Again"),
      { text: "round 2 final", tasks: [] },
      "the new round starts with fresh task results",
    );
    assert.equal(created.length, 1);
    assert.notEqual(caller.status, "closed");
  });

  test("a native error stop asks the caller with its real output by default; the caller's ignore finishes the batch", async () => {
    const r = registry("caller", "worker");
    let finalContext: Context | undefined;
    r.script("caller", [
      toolTurn(taskCall([{ name: "w", task: "a", model: r.model("worker") }])),
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
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);

    const results = await execution.run();
    assert.equal(
      outer.getNode(id)?.state,
      caller,
      "the caller's node never changed",
    );
    assert.equal(contentText(results.get(id)?.content ?? []), "final");
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
      caller
        .getTaskResults()
        .map((result) => ({ type: "task_result", ...result })),
      [report],
      "the delivered failure is the caller's one task result",
    );
    const ignored = toolResultsIn(finalContext).get("ignore-w");
    assert.equal(ignored?.isError, false);
    assert.equal(textOf(ignored!), `Ignored task ${report?.id}.`);
    assert.deepEqual(markersIn(finalContext), [[report?.id]]);
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
      toolTurn(
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
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    caller.setTaskFailurePolicy("ignore");
    let bad: Agent | undefined;
    trackSubagents(caller, (parent, child, index) => {
      if (parent !== caller || index !== 0) return;
      bad = child;
      explode(child, "worker exploded");
    });
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);

    const results = await execution.run();
    assert.equal(
      outer.getNode(id)?.state,
      caller,
      "the caller's node never changed",
    );
    assert.equal(contentText(results.get(id)?.content ?? []), "handled both");
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

    assert.deepEqual(
      caller.getTaskResults(),
      [
        {
          id: goodId,
          name: "good",
          attempt: 1,
          status: "completed",
          output: "good-report",
          stopReason: "stop",
        },
      ],
      "only the sibling's completion was delivered",
    );

    assert.ok(finalContext);
    assert.deepEqual(
      reportsIn(finalContext).map(({ id }) => id),
      [goodId],
      "the ignored failure never entered the caller's context",
    );
    assert.deepEqual(markersIn(finalContext), [[badId, goodId]]);

    assert.ok(bad);
    assert.equal(bad.status, "closed", "the failed child was closed");
  });

  test("an ignored failed task cancels its blocked grandchildren and is consumed once by the caller", async () => {
    const waiting = waitingTool("wait", { endOnAbort: true });
    const r = registry("caller", "child", "fast", "slow");
    let handles: TaskToolDetails["tasks"] = [];
    let finalContext: Context | undefined;
    r.script("caller", [
      toolTurn(
        taskCall([
          {
            name: "child",
            task: "delegate",
            model: r.model("child"),
            tools: ["task", "wait"],
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
      toolTurn(
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
            tools: ["wait"],
          },
        ]),
      ),
      // The child's run fails while its slow grandchild is blocked.
      async () => {
        await waiting.started;
        return fauxAssistantMessage("child partial", {
          stopReason: "error",
          errorMessage: "nested worker exploded",
        });
      },
      fauxAssistantMessage("child must not answer"),
    ]);
    r.script("fast", [fauxAssistantMessage("fast-report")]);
    r.script("slow", [
      toolTurn(fauxToolCall("wait", {}, { id: "slow-wait" })),
      fauxAssistantMessage("slow must not answer"),
    ]);
    const caller = await r.agent("caller", [
      new toolsApi.TaskTool(),
      waiting.tool,
    ]);
    caller.setTaskFailurePolicy("ignore");
    const created = trackSubagents(caller);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);

    const results = await execution.run();
    await waiting.aborted;
    assert.equal(
      outer.getNode(id)?.state,
      caller,
      "the caller's node never changed",
    );
    assert.equal(contentText(results.get(id)?.content ?? []), "caller handled");
    const [childHandle] = handles;
    assert.ok(childHandle && handles.length === 1);
    assert.equal(childHandle.name, "child");

    assert.deepEqual(caller.getTaskResults(), [], "the failure was ignored");
    assert.ok(finalContext);
    assert.deepEqual(
      reportsIn(finalContext),
      [],
      "no report reached the caller",
    );
    assert.deepEqual(markersIn(finalContext), [[childHandle.id]]);

    assert.equal(created.length, 3, "the child and both grandchildren");
    for (const agent of created) assert.equal(agent.status, "closed");
    assert.equal(r.calls("child"), 2, "the failed child never answered again");
    assert.equal(r.calls("slow"), 1, "the blocked grandchild was cancelled");
  });

  test("complaints keep naming the caller's node with its business messages while children keep their own task ids", async () => {
    const r = registry("caller", "worker");
    const complain = (complaint: string, id: string) =>
      toolTurn(fauxToolCall("complain", { complaint }, { id }));
    const seen: { handles?: TaskToolDetails["tasks"] } = {};
    r.script("caller", [
      complain("before launch", "c1"),
      toolTurn(
        taskCall([
          { name: "w", task: "do w", model: r.model("worker"), tools: [] },
        ]),
      ),
      (context) => {
        seen.handles = handlesIn(context);
        return complain("after launch", "c2");
      },
      fauxAssistantMessage("interim"),
      complain("with reports", "c3"),
      fauxAssistantMessage("combined"),
    ]);
    r.script("worker", [
      complain("child blocked", "w1"),
      fauxAssistantMessage("worker-report"),
    ]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const before = toolsApi.issueLog.length;
    const id = outer.addNode(callerNode(caller, "Start"));
    ports.connect(outer, id);
    const results = await execution.run();
    assert.equal(contentText(results.get(id)!.content), "combined");

    const [child] = seen.handles ?? [];
    assert.ok(child);
    const issues = toolsApi.issueLog.snapshot().slice(before);
    const byText = new Map(issues.map((issue) => [issue.complaint, issue]));
    assert.equal(issues.length, 4);
    assert.equal(byText.get("before launch")?.nodeId, id);
    assert.deepEqual(byText.get("before launch")?.messages, []);
    // Task admission never changes the caller's node: every caller complaint names it.
    assert.equal(byText.get("after launch")?.nodeId, id);
    assert.deepEqual(byText.get("after launch")?.messages, []);
    const reports = byText.get("with reports");
    assert.equal(reports?.nodeId, id);
    assert.deepEqual(
      reports?.messages,
      [],
      "reports are not business messages",
    );
    const delivered = reports?.prompt.messages.flatMap((message) =>
      message.role === "user" &&
      textOf(message).startsWith('{"type":"task_result"')
        ? [JSON.parse(textOf(message))]
        : [],
    );
    assert.deepEqual(delivered, [
      {
        type: "task_result",
        id: child.id,
        name: "w",
        attempt: 1,
        status: "completed",
        output: "worker-report",
        stopReason: "stop",
      },
    ]);
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
});

describe("native task failure policies", () => {
  test("an assigned batch launches its stored assignments from task({}) once; a rejected admission can be retried", async () => {
    const r = registry("caller", "a", "b");
    const prompts = { a: r.worker("a"), b: r.worker("b") };
    let finalContext: Context | undefined;
    const launch = (id: string) => fauxToolCall("task", {}, { id });
    r.script("caller", [
      toolTurn(launch("l1"), launch("l2"), launch("l3")),
      ...answering(undefined, (context) => {
        finalContext = context;
        return fauxAssistantMessage("final");
      }),
    ]);
    const caller = await r.agent("caller", [new toolsApi.TaskTool()]);
    const batch = {
      context: "Original context.",
      tasks: [r.task("a"), r.task("b")],
    };
    await caller.setTaskBatch(batch);
    batch.context = "tampered";
    batch.tasks[0]!.task = "tampered";
    batch.tasks.pop();
    let acquisitions = 0;
    const children = childrenOf(caller, undefined, () => {
      if (++acquisitions === 1) throw new Error("admission rejected");
    });
    const { execution, ports } = taskExecution();
    const outer = execution.graph;
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));
    ports.connect(outer, id);

    const results = await execution.run();
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
    assert.equal(outer.getNode(id)?.state, caller);
    assert.deepEqual(
      caller
        .getTaskResults()
        .map(({ id }) => id)
        .sort(),
      handles.map(({ id }) => id).sort(),
    );
    assert.deepEqual(markersIn(finalContext), [handles.map(({ id }) => id)]);
  });

  test("ignore: failed attempts are closed and dropped; the caller answers from the success after one marker", async () => {
    const r = registry("caller", "a", "b", "c");
    r.worker("a");
    r.worker("b", 1);
    r.worker("c");
    let finalContext: Context | undefined;
    const { caller, execution, id } = await failingCaller(
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

    const results = await execution.run();
    assert.equal(
      contentText(results.get(id)?.content ?? []),
      "final: c-report",
    );
    assert.ok(finalContext);
    assert.deepEqual(
      reportsIn(finalContext).map(({ name, status }) => [name, status]),
      [["c", "completed"]],
    );
    assert.deepEqual(markersIn(finalContext), [handleIdsOf(finalContext)]);
    assertDelivered(caller, finalContext);
    assert.equal(r.calls("a"), 0, "the thrown failure never reached its model");
    assert.equal(r.calls("b"), 1);
    for (const name of ["a", "b", "c"]) assert.equal(children(name).length, 1);
    for (const name of ["a", "b"])
      assert.equal(children(name)[0]?.status, "closed");
  });

  test("ignore: when every task fails, the caller answers after the marker in the same native run", async () => {
    const r = registry("caller", "a", "b", "c");
    r.worker("a");
    r.worker("b", 1);
    r.worker("c", 1);
    let finalContext: Context | undefined;
    const { caller, execution, id } = await failingCaller(
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
    const runs = mainRuns(caller);
    const results = await execution.run();
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
    assert.deepEqual(markersIn(finalContext), [handleIdsOf(finalContext)]);
    assert.match(
      userTexts(finalContext.messages).at(-1) ?? "",
      /^\{"type":"task_batch_complete"/,
      "the final answer follows the marker",
    );
    assert.deepEqual(caller.getTaskResults(), []);
    assert.equal(runs.size, 1, "one native caller run");
  });

  test("{ retries: 2 }: a task failing twice reruns with its pinned prompt and model while its sibling runs once", async () => {
    const r = registry("caller", "a", "b");
    const prompts = r.worker("a", 2);
    r.worker("b");
    let finalContext: Context | undefined;
    const { caller, execution } = await failingCaller(
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

    await execution.run();
    assert.ok(finalContext);
    const [a, b] = markersIn(finalContext)[0] ?? [];
    assert.ok(a && b);
    assert.deepEqual(handleIdsOf(finalContext), [a, b]);
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
    assertDelivered(caller, finalContext);
  });

  test("{ retries: 2 }: after exhaustion every failure asks; an explicit retry does not reset the budget", async () => {
    const r = registry("caller", "a", "b");
    r.worker("a", 4);
    r.worker("b");
    const questions: number[] = [];
    let finalContext: Context | undefined;
    const { caller, execution } = await failingCaller(
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

    await execution.run();
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
    r.worker("a", 1);
    r.worker("b");
    let finalContext: Context | undefined;
    let probed = false;
    const { caller, execution, id } = await failingCaller(
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
          return toolTurn(
            decision("ignore", { id: a!, attempt: 2 }, "completed"),
          );
        },
      ),
    );
    const children = childrenOf(caller);

    const results = await execution.run();
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
    assert.deepEqual(handleIdsOf(finalContext), [a, b]);
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
    assertDelivered(caller, finalContext);
  });

  test("a caller that settles with a consumed, undecided failure question fails its graph", async () => {
    const r = registry("caller", "a");
    r.worker("a", 1);
    const { caller, execution } = await failingCaller(
      r,
      ["a"],
      { retries: 0 },
      answering(undefined, () => assert.fail("no marker")),
    );
    const children = childrenOf(caller);
    const failure = await execution.run().then(
      () => assert.fail("the graph failed"),
      (error: unknown) => error,
    );
    assert.ok(
      [...errorGraph(failure)].some(
        (cause) =>
          cause instanceof agentApi.JuncoAgentError &&
          /^Task failure decisions required: task-/.test(cause.message),
      ),
    );
    assert.equal(children("a").length, 1);

    // A refused explicit retry restores the pending decision; settling without one still fails.
    {
      const r = registry("caller", "a");
      r.worker("a", 1);
      let acquisitions = 0;
      let rejections = 0;
      const { caller, execution } = await failingCaller(
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
      const failure = await execution.run().then(
        () => assert.fail("the graph failed"),
        (error: unknown) => error,
      );
      assert.equal(rejections, 1);
      assert.ok(
        [...errorGraph(failure)].some(
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
    r.worker("a", 1);
    let acquisitions = 0;
    let rejections = 0;
    const questions: agentApi.TaskResult[] = [];
    let finalContext: Context | undefined;
    const { caller, execution } = await failingCaller(
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

    await execution.run();
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
    assert.deepEqual(handleIdsOf(finalContext), [questions[0]?.id]);
    assert.equal(markersIn(finalContext).length, 1);
    assertDelivered(caller, finalContext);
  });

  test("a refused retry's thrown value replaces the worker error and is reported once, even undefined or cyclic", async () => {
    const leaf = new Error("leaf");
    const outer = new AggregateError([leaf, leaf], "outer");
    outer.cause = outer;
    for (const [fault, expected] of [
      [undefined, "undefined"],
      [outer, "AggregateError: outer\nError: leaf"],
    ] as const) {
      const r = registry("caller", "a");
      r.worker("a", 1);
      const questions: agentApi.TaskResult[] = [];
      let finalContext: Context | undefined;
      const { caller, execution, id } = await failingCaller(
        r,
        ["a"],
        { retries: 1 },
        answering(
          (report) => {
            questions.push(report);
            return [decision("ignore", report, "ignore")];
          },
          (context) => {
            finalContext = context;
            return fauxAssistantMessage("final");
          },
        ),
      );
      // The launch acquires; the automatic retry's acquisition throws the raw value.
      let acquisitions = 0;
      const children = childrenOf(caller, undefined, () => {
        if (++acquisitions > 1) throw fault;
      });

      const results = await execution.run();
      assert.equal(contentText(results.get(id)?.content ?? []), "final");
      assert.ok(finalContext);
      assert.equal(acquisitions, 2);
      assert.deepEqual(
        questions.map(({ attempt, status, error, decisionRequired }) => [
          attempt,
          status,
          error,
          decisionRequired,
        ]),
        [[1, "failed", expected, true]],
      );
      assert.equal(reportsIn(finalContext).length, 1);
      assert.deepEqual(markersIn(finalContext), [handleIdsOf(finalContext)]);
      assert.equal(children("a").length, 1);
    }
  });

  test("a failed attempt whose teardown fails fails the graph and starts no replacement, even under ignore", async () => {
    for (const policy of ["ignore", { retries: 1 }] as const) {
      const r = registry("caller", "a");
      r.worker("a", 1);
      const { caller, execution } = await failingCaller(
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
        const failure = await execution.run().then(
          () => assert.fail("the graph failed"),
          (error: unknown) => error,
        );
        const causes = [...errorGraph(failure)];
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

  test("closing the graph while a failed attempt retires closes it without retrying or reporting", async () => {
    const r = registry("caller", "a");
    let closing: Promise<unknown> | undefined;
    let outerGraph: JuncoGraph | undefined;
    r.script("a", [
      () => {
        closing = outerGraph?.close();
        return fauxAssistantMessage("a partial 1", {
          stopReason: "error",
          errorMessage: "a boom 1",
        });
      },
      fauxAssistantMessage("must not run"),
    ]);
    const { caller, outer, execution } = await failingCaller(
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
    await assert.rejects(execution.run());
    await closing?.catch(() => {});
    assert.equal(r.calls("a"), 1);
    assert.equal(children("a").length, 1);
    assert.equal(children("a")[0]?.status, "closed");
    assert.equal(caller.status, "closed");
    assert.deepEqual(caller.getTaskResults(), []);
  });

  test("an abort while a retry is acquired closes the new attempt before it starts", async () => {
    const r = registry("caller", "a");
    r.worker("a", 1);
    let aborted: Promise<unknown> | undefined;
    const { caller, execution } = await failingCaller(
      r,
      ["a"],
      { retries: 0 },
      answering(
        (report) => [decision("retry", report, "retry")],
        () => assert.fail("no marker"),
      ),
    );
    // The retry's child exists but has not started when its caller aborts.
    const children = childrenOf(caller, (_provider, _child, nth) => {
      if (nth === 2) aborted = caller.abort();
    });
    // The aborted native run settles (or fails) on its own terms; the tasks are what matter here.
    await execution.run().catch(() => {});
    await aborted;
    assert.notEqual(
      caller.status,
      "closed",
      "an aborted caller stays reusable",
    );
    assert.equal(children("a").length, 2, "the retry was allocated");
    for (const child of children("a")) assert.equal(child.status, "closed");
    assert.equal(r.calls("a"), 1, "the retry never ran");
    assert.deepEqual(caller.getTaskResults(), []);
  });
});

type Recorded = {
  readonly path: string;
  readonly event: toolsApi.ProfileEvent<string>;
};

/** A root recorder keeping every event with its context path; contexts come from the shared utility. */
function testRecorder() {
  const events: Recorded[] = [];
  const recorder: toolsApi.ProfileRecorder<string> = Object.freeze({
    get root() {
      return recorder;
    },
    path: "",
    add_context: (id: string) => contexts.add([], id),
    record: (event: toolsApi.ProfileEvent<string>) => {
      events.push({ path: "", event });
    },
    flush: async () => {},
    close: async () => {},
  });
  const contexts = toolsApi.profileContexts(
    recorder,
    (_ids, path, event) => events.push({ path, event }),
    () => {},
  );
  return { recorder, events };
}

/** Summed counters of `operation`'s metrics at `path`, and its latest gauges. */
function metricsAt(
  events: readonly Recorded[],
  path: string,
  operation: string,
) {
  const counters: Record<string, number> = {};
  let gauges: Record<string, number | null> = {};
  for (const { path: at, event } of events) {
    if (
      at !== path ||
      event.kind !== "metrics" ||
      event.operation !== operation
    )
      continue;
    for (const [key, value] of Object.entries(event.counters ?? {}))
      counters[key] = (counters[key] ?? 0) + value;
    gauges = { ...gauges, ...event.gauges };
  }
  return { counters, gauges };
}

/** Every path a graph event was recorded at. */
const graphPaths = (events: readonly Recorded[]) =>
  new Set(
    events.flatMap(({ path, event }) =>
      event.kind !== "usage" &&
      event.kind !== "resource" &&
      event.kind !== "probe" &&
      event.category === "graph"
        ? [path]
        : [],
    ),
  );

describe("native tasks under a recorder", () => {
  test("retries record lifecycle at caller and attempts at attempt paths, with only real graph paths", async () => {
    const r = registry("caller", "a", "b");
    r.worker("a", 2);
    r.worker("b");
    const { recorder, events } = testRecorder();
    const { caller, execution } = await failingCaller(
      r,
      ["a", "b"],
      { retries: 2 },
      answering(
        () => assert.fail("no failure question"),
        () => fauxAssistantMessage("final"),
      ),
      recorder,
    );

    await execution.run();
    const results = caller.getTaskResults();
    const a = results.find((result) => result.attempt === 3)?.id;
    const b = results.find((result) => result.attempt === 1)?.id;
    assert.ok(a && b && a !== b);
    const escaped = (id: string) => `caller::${toolsApi.profilePath([id])}`;
    assert.deepEqual(graphPaths(events), new Set(["", "caller", "$sink"]));
    assert.equal(escaped(`${a}:attempt:2`), `caller::${a}%3Aattempt%3A2`);
    const attemptPaths = new Set(
      events.flatMap(({ path }) => (path.startsWith("caller::") ? [path] : [])),
    );
    assert.deepEqual(
      attemptPaths,
      new Set([
        escaped(a),
        escaped(b),
        escaped(`${a}:attempt:2`),
        escaped(`${a}:attempt:3`),
      ]),
    );
    const { counters, gauges } = metricsAt(events, "caller", "lifecycle");
    assert.deepEqual(counters, {
      batches_admitted: 1,
      tasks_admitted: 2,
      attempts_admitted: 4,
      retry_attempts: 2,
      tasks_failed: 2,
      tasks_completed: 2,
      tasks_resolved: 2,
      batches_completed: 1,
    });
    assert.deepEqual(gauges, { tasks_outstanding: 0 });
    // The caller's node names its agent on every activation.
    const activations = events.flatMap(({ path: at, event }) =>
      at === "caller" && event.kind === "start" && event.activation
        ? [event.activation]
        : [],
    );
    assert.ok(activations.length > 0);
    for (const activation of activations) {
      assert.equal(activation.agent, caller);
      assert.equal(activation.owner, caller.owner);
    }
  });

  test("ignore resolves a failed task once", async () => {
    const r = registry("caller", "a", "b");
    r.worker("a", 1);
    r.worker("b");
    const { recorder, events } = testRecorder();
    const { execution } = await failingCaller(
      r,
      ["a", "b"],
      "ignore",
      answering(undefined, () => fauxAssistantMessage("final")),
      recorder,
    );

    await execution.run();
    assert.deepEqual(metricsAt(events, "caller", "lifecycle").counters, {
      batches_admitted: 1,
      tasks_admitted: 2,
      attempts_admitted: 2,
      tasks_failed: 1,
      tasks_ignored: 1,
      tasks_completed: 1,
      tasks_resolved: 2,
      batches_completed: 1,
    });
  });

  test("a rejected retry allocation adds no attempt", async () => {
    const r = registry("caller", "a");
    r.worker("a", 1);
    let acquisitions = 0;
    const { recorder, events } = testRecorder();
    const { caller, execution } = await failingCaller(
      r,
      ["a"],
      { retries: 1 },
      answering(
        (report) => [decision("ignore", report, "ignore")],
        () => fauxAssistantMessage("final"),
      ),
      recorder,
    );
    childrenOf(caller, undefined, () => {
      if (++acquisitions > 1) throw new Error("no capacity");
    });

    await execution.run();
    assert.deepEqual(metricsAt(events, "caller", "lifecycle").counters, {
      batches_admitted: 1,
      tasks_admitted: 1,
      attempts_admitted: 1,
      tasks_failed: 1,
      tasks_ignored: 1,
      tasks_resolved: 1,
      batches_completed: 1,
    });
  });
});

describe("graph recorder bridge", () => {
  /** nodeId1 ⊃ nodeId2 ⊃ NodeId_f, each graph traced by `delegate`. */
  function nested(
    delegate: tracer.DataflowTracer,
    recorder: toolsApi.ProfileRecorder<string>,
  ) {
    const level = (
      view:
        | toolsApi.ProfileRecorder<
            "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
          >
        | undefined,
      id: string,
      member: (g: JuncoGraph) => graph.NodeIdType,
    ) => {
      const ports = terminalPorts();
      const g = new JuncoGraph(
        ports.source,
        ports.sink,
        graph.Width.create(1),
        graph.UNBOUNDED,
        delegate,
        LockPolicy,
        undefined,
        view,
        id,
      );
      ports.connect(g, member(g));
      return schedules.context({ graph: g, scheduler: schedules.parallel() });
    };
    return level(recorder, "nodeId1", (outer) =>
      outer.addNode({
        id: graph.NodeId.create("nodeId2"),
        trigger: trigger.TriggerRule.always(),
        state: level(outer.recorder, "nodeId2", (inner) =>
          inner.addNode({
            id: graph.NodeId.create("NodeId_f"),
            trigger: trigger.TriggerRule.always(),
            state: new Deterministic<Chat, AssistantMessage>(
              async function* () {
                yield [];
                return assistant("f");
              },
              LockPolicy,
            ),
          }),
        ),
      }),
    );
  }

  /** A tracer counting its runs and activations, throwing from every callback when `fail`. */
  function counting(fail: boolean) {
    const seen = { runs: 0, nodes: 0, ends: 0 };
    const check = () => {
      if (fail) throw new Error("tracer failure");
    };
    const observer: tracer.DataflowTracer = {
      startRun: () => {
        seen.runs += 1;
        check();
        return {
          startNode: () => {
            seen.nodes += 1;
            check();
            return { end: check, fail: check };
          },
          end: () => {
            seen.ends += 1;
            check();
          },
          fail: check,
        };
      },
      complain: () => {},
      flush: async () => {},
    };
    return { observer, seen };
  }

  test("nested graphs record at wrapper paths once per run despite a throwing delegate", async () => {
    const { recorder, events } = testRecorder();
    const { observer, seen } = counting(true);
    const execution = nested(observer, recorder);
    closers.push(() => execution.graph.close());

    const results = await execution.run();
    assert.equal(
      contentText(results.get(execution.graph.sink.id)?.content ?? []),
      "f",
    );
    const paths = graphPaths(events);
    assert.ok(paths.has("nodeId1::nodeId2::NodeId_f"));
    assert.ok(paths.has("nodeId1::nodeId2"));
    for (const path of paths)
      assert.ok(
        path === "nodeId1" || path.startsWith("nodeId1::"),
        `no unplaced path ${path}`,
      );
    const evaluations = events.filter(
      ({ event }) =>
        event.kind === "start" &&
        event.category === "graph" &&
        event.operation === "evaluate",
    );
    assert.equal(evaluations.length, seen.runs, "one bridge per graph run");
    const leaf = events.find(
      ({ path, event }) =>
        path === "nodeId1::nodeId2::NodeId_f" && event.kind === "finish",
    )?.event;
    assert.equal(leaf?.kind === "finish" && leaf.outcome, "success");
    assert.equal(
      leaf?.kind === "finish" ? leaf.activation?.agent : "absent",
      undefined,
    );
    for (const { event } of evaluations)
      assert.equal(event.kind === "start" && event.activation, undefined);
  });

  test("a throwing recorder cannot hide delegate observations", async () => {
    const { observer, seen } = counting(false);
    const recorder = testRecorder().recorder;
    const throwing: toolsApi.ProfileRecorder<string> = {
      ...recorder,
      add_context: () => throwing,
      record: () => {
        throw new Error("recorder failure");
      },
    };
    const execution = nested(observer, throwing);
    closers.push(() => execution.graph.close());

    await execution.run();
    assert.ok(seen.runs >= 2 && seen.nodes > 0);
    assert.equal(seen.ends, seen.runs);
  });

  test("a nested graph from another session or none is rejected before work", () => {
    const { recorder } = testRecorder();
    assert.throws(
      () =>
        nested(new tracer.DummyTracer(), recorder).graph.addNode({
          id: graph.NodeId.create("stranger"),
          trigger: trigger.TriggerRule.always(),
          state: nested(new tracer.DummyTracer(), testRecorder().recorder),
        }),
      /ProfileRecorder instance mismatch/,
    );
    const ports = terminalPorts();
    const bare = new JuncoGraph(
      ports.source,
      ports.sink,
      graph.Width.create(1),
      graph.UNBOUNDED,
      quiet,
      LockPolicy,
    );
    assert.throws(
      () =>
        nested(new tracer.DummyTracer(), recorder).graph.addNode({
          id: graph.NodeId.create("bare"),
          trigger: trigger.TriggerRule.always(),
          state: schedules.context({
            graph: bare,
            scheduler: schedules.parallel(),
          }),
        }),
      /ProfileRecorder instance mismatch/,
    );
  });
});
