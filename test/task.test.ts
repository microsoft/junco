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
  status: string;
  output: string;
  stopReason: string;
  error?: string;
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
): Promise<Agent> {
  const model = models.getModels(provider)[0];
  assert.ok(model);
  const agent = await agentApi.JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models,
    model,
    systemPrompt: "sys",
    tools,
  });
  closers.push(() => agent.return());
  return agent;
}

/** Observes each real child `parent.createSubagents` returned, before the caller receives it. */
type SubagentObserver = (parent: Agent, child: Agent, index: number) => void;

/** Records every agent `caller.createSubagents` returns, recursively for descendants. */
function trackSubagents(
  caller: Agent,
  observe?: SubagentObserver,
  created: Agent[] = [],
): Agent[] {
  const create = caller.createSubagents.bind(caller);
  caller.createSubagents = async (options, signal) => {
    const children = await create(options, signal);
    children.forEach((child, index) => {
      created.push(child);
      trackSubagents(child, observe, created);
      observe?.(caller, child, index);
    });
    return children;
  };
  return created;
}

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
  while (outer.available().size > 0) {
    await outer.step();
    const state = outer.getNode(id)?.state;
    if (!(state instanceof JuncoGraph)) continue;
    const messages = state.available().get(graph.NodeId("root"))?.view.messages;
    for (const edge of messages?.keys() ?? []) {
      for (const input of messages?.get(edge) ?? []) {
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
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

function callerNode(caller: Agent, prompt = "Start") {
  return agentNode(
    caller,
    { id: graph.NodeId("caller"), trigger: trigger.always() },
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

    const outer = createParallelAgentGraph();
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

  test("external edges keep their contract: a value once, messages in order, yields routed out, only the final result downstream", async () => {
    const r = registry("caller", "alpha");
    type Edge = graph.Edge<AgenticInput, AssistantMessage>;
    const sourceEdge: Edge = graph.valueEdge("source=>caller");
    const notesEdge: Edge = graph.messageEdge("notes->caller");
    const outboundEdge: Edge = graph.messageEdge("caller->down");
    const resultEdge: Edge = graph.valueEdge("caller=>down");
    const [source, notes, outbound, result] = [
      sourceEdge.id,
      notesEdge.id,
      outboundEdge.id,
      resultEdge.id,
    ];
    let alphaStarted = false;
    let finalContext: Context | undefined;
    r.script("caller", [
      toolUse(
        taskCall([
          {
            name: "alpha",
            task: "work",
            model: r.model("alpha"),
            tools: ["yield"],
          },
        ]),
      ),
      toolUse(yieldCall("checkpoint")),
      fauxAssistantMessage("interim"),
      (context) => {
        finalContext = context;
        return fauxAssistantMessage("final answer");
      },
    ]);
    r.script("alpha", [
      () => {
        alphaStarted = true;
        return toolUse(yieldCall("alpha pause"));
      },
      fauxAssistantMessage("alpha-report"),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
      toolsApi.createYieldTool(),
    ]);
    const upstreamValue = fauxAssistantMessage("upstream value");
    const received: string[] = [];
    let downstreamValue: AssistantMessage | undefined;

    const outer = createParallelAgentGraph();
    closers.push(() => outer.close());
    const sourceId = outer.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, AssistantMessage>(async function* () {
          yield [];
          return upstreamValue;
        }),
        { trigger: trigger.always() },
      ),
    );
    const notesId = outer.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, AssistantMessage>(async function* () {
          yield [
            { id: notes, payload: { kind: "followUp", text: "note-1" } },
            { id: notes, payload: { kind: "followUp", text: "note-2" } },
          ];
          return fauxAssistantMessage("notes done");
        }),
        // Emits once the worker is running, while the caller's node is expanded.
        { trigger: trigger.always(), is_available: () => alphaStarted },
      ),
    );
    const callerId = outer.addNode(
      agentNode(
        caller,
        {
          id: graph.NodeId("caller"),
          trigger: trigger.anyOf(trigger.on(notesEdge), trigger.on(sourceEdge)),
        },
        {
          prompt: "Start",
          receive: (view): AgenticInput[] => [
            ...(view.values.has(source)
              ? [
                  {
                    kind: "appendMessage" as const,
                    message: {
                      role: "user" as const,
                      content: "upstream value: seen",
                      timestamp: 0,
                    },
                  },
                ]
              : []),
            ...(view.messages.get(notes) ?? []),
          ],
          emit: (step) =>
            step.reasons.map(({ reason }) => ({
              id: outbound,
              payload: { kind: "followUp" as const, text: reason },
            })),
        },
      ),
    );
    const downId = outer.addNode(
      deterministicNode(
        new Deterministic<AgenticInput, AssistantMessage>(async function* () {
          let view = yield [];
          while (true) {
            for (const input of view.messages.get(outbound) ?? [])
              if (input.kind === "followUp") received.push(input.text);
            const value = view.values.get(result);
            if (value !== undefined) {
              downstreamValue = value;
              return value;
            }
            view = yield [];
          }
        }),
        {
          trigger: trigger.anyOf(
            trigger.on(outboundEdge),
            trigger.on(resultEdge),
          ),
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

    const results = await outer.run();
    const final = results.get(callerId);
    assert.ok(final);
    assert.equal(contentText(final.content), "final answer");
    assert.equal(outer.getNode(callerId), node);
    assert.deepEqual(linksOf(outer), links, "external edges are unchanged");
    assert.ok(finalContext);
    const texts = userTexts(finalContext);
    assert.equal(
      texts.filter((text) => text === "upstream value: seen").length,
      1,
    );
    const [first, second] = [texts.indexOf("note-1"), texts.indexOf("note-2")];
    assert.ok(first !== -1 && first < second, "messages arrive once, in order");
    assert.equal(texts.lastIndexOf("note-1"), first);
    assert.deepEqual(
      reportsIn(finalContext).map(({ output }) => output),
      ["alpha-report"],
    );
    assert.deepEqual(received, ["Scheduled 1 subagents", "checkpoint"]);
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
    const outer = createParallelAgentGraph();
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
    const outer = createParallelAgentGraph();
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
    const outer = createParallelAgentGraph();
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
    const outer = createParallelAgentGraph();
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
    const outer = createParallelAgentGraph();
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
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const create = caller.createSubagents.bind(caller);
    const acquisition: unknown[] = [];
    caller.createSubagents = async (options, signal) => {
      entered.resolve();
      await gate.promise;
      try {
        const children = await create(options, signal);
        acquisition.push(...children);
        return children;
      } catch (error) {
        acquisition.push(error);
        throw error;
      }
    };
    const outer = createParallelAgentGraph();
    const id = outer.addNode(callerNode(caller));
    const running = outer.run();
    await entered.promise;
    const closing = outer.close();
    gate.resolve();
    await assert.rejects(running);
    await closing;
    assert.equal(caller.status, "closed");
    assert.equal(outer.getNode(id)?.state, caller);
    assert.equal(acquisition.length, 1);
    assert.ok(
      acquisition[0] instanceof agentApi.JuncoAgentError &&
        acquisition[0].code === "closed",
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
    const outer = createParallelAgentGraph();
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

  test("a native error stop is queued as an error report with its real output, while the child keeps its assistant result", async () => {
    const r = registry("caller", "worker");
    let reports: Report[] = [];
    r.script("caller", [
      toolUse(taskCall([{ name: "w", task: "a", model: r.model("worker") }])),
      fauxAssistantMessage("interim"),
      (context) => {
        reports = reportsIn(context);
        return fauxAssistantMessage("final");
      },
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
    const outer = createParallelAgentGraph();
    closers.push(() => outer.close());
    const id = outer.addNode(callerNode(caller));

    const queued = await driveObservingReports(outer);
    const final = outer.result(id);
    assert.ok(O.isSome(final), "the caller's original node finished");
    assert.equal(contentText(final.value.content), "final");
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.equal(report?.status, "failed");
    assert.equal(report?.stopReason, "error");
    assert.equal(report?.error, "boom");
    assert.equal(report?.output, "partial output");
    assert.deepEqual(
      queued.map(({ kind, report }) => [kind, report.id, report.status]),
      [["error", report?.id, "failed"]],
    );
    const value = innerOf(outer).result(graph.NodeId(report?.id ?? ""));
    assert.ok(
      O.isSome(value),
      "a genuine error stop keeps its assistant result",
    );
    assert.equal(contentText(value.value.content), "partial output");
    assert.equal(value.value.stopReason, "error");
    assert.equal(value.value.errorMessage, "boom");
  });

  test("a thrown worker failure reaches the caller as one error report beside its sibling's follow-up report", async () => {
    const r = registry("caller", "bad", "good");
    let handles: TaskToolDetails["tasks"] = [];
    let finalContext: Context | undefined;
    // Reports may arrive in one or two caller runs; it answers finally once both are in context.
    const afterReports = (context: Context) => {
      if (reportsIn(context).length < 2)
        return fauxAssistantMessage("still waiting");
      finalContext = context;
      return fauxAssistantMessage("handled both");
    };
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
      afterReports,
      afterReports,
    ]);
    r.script("bad", [fauxAssistantMessage("must not run")]);
    r.script("good", [fauxAssistantMessage("good-report")]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
    ]);
    let bad: Agent | undefined;
    trackSubagents(caller, (parent, child, index) => {
      if (parent !== caller || index !== 0) return;
      bad = child;
      child.hooks.on("before_drive", () => {
        throw new Error("worker exploded");
      });
    });
    const outer = createParallelAgentGraph();
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
    const finalReports = reportsIn(finalContext);
    assert.deepEqual(
      finalReports.map(({ id }) => id).sort(),
      [badId, goodId].sort(),
      "one final-context report per handle",
    );
    assert.deepEqual(
      finalReports.find(({ id }) => id === badId),
      failed.report,
    );

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

  test("a failed expanded task cancels its blocked descendants and reports once to its parent", async () => {
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
      (context) => {
        finalContext = context;
        return fauxAssistantMessage("caller handled");
      },
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
      toolUse(fauxToolCall("wait", {}, { id: "w1" })),
      fauxAssistantMessage("slow-report"),
    ]);
    const caller = await newCaller(r.models, "caller", [
      toolsApi.createTaskTool(),
      toolsApi.createYieldTool(),
      waiting.tool,
    ]);
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
    const outer = createParallelAgentGraph();
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
      "only the child's report reached the caller",
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
    assert.deepEqual(
      reportsIn(finalContext).map(({ id }) => id),
      [childHandle.id],
    );

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
    const outer = createParallelAgentGraph();
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
    assert.equal(byText.get("after expansion")?.nodeId, "root");
    assert.deepEqual(
      byText.get("after expansion")?.messages,
      [],
      "the Spawn root's prime activation delivers no batch",
    );
    const reports = byText.get("with reports");
    assert.equal(reports?.nodeId, "root");
    assert.deepEqual(
      reports?.messages.map((message) => message.id),
      [`${child.id}->root`],
    );
    assert.deepEqual(reports?.messages[0]?.payload, {
      kind: "followUp",
      text: JSON.stringify({
        type: "task_result",
        id: child.id,
        name: "w",
        status: "completed",
        output: "worker-report",
        stopReason: "stop",
      }),
    });
    const childIssue = byText.get("child blocked");
    assert.equal(childIssue?.nodeId, child.id);
    assert.deepEqual(childIssue?.messages, [
      {
        id: `root->${child.id}`,
        payload: { kind: "prompt", text: childPrompt("do w") },
      },
    ]);
    assert.ok(
      childIssue?.prompt.messages.some(
        (message) =>
          message.role === "user" && textOf(message) === childPrompt("do w"),
      ),
    );
  }, 5_000);
});
