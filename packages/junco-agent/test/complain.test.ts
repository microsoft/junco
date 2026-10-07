import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentMessage,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type Context,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { EdgeId, NodeId } from "dataflow-engine";
import { createComplainTool, isComplainTool, issueLog } from "junco-tools";
import { type AgenticStep, JuncoAgent, JuncoAgentError } from "../src/index.ts";
import { countingTool, newAgent, scripted } from "./harness.ts";

const toolTurn = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });
const complainCall = (complaint: string, id: string) =>
  fauxToolCall("complain", { complaint }, { id });

const isCode =
  (code: JuncoAgentError["code"]) =>
  (error: unknown): boolean =>
    error instanceof JuncoAgentError && error.code === code;

function text(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" ? [text(message.content)] : [],
  );
}

function settledText(result: IteratorResult<AgenticStep, void>): string {
  assert.equal(result.done, false);
  const value = result.value as AgenticStep;
  assert.equal(value.kind, "settled");
  if (value.kind !== "settled") return "";
  return text(value.message.content);
}

function toolResult(messages: Context["messages"], id: string) {
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === id,
  );
  assert.ok(result && result.role === "toolResult");
  return result;
}

/** Tool names advertised to the model, as the harness announces them in system messages. */
const offered = (context: Context) =>
  context.messages.flatMap((message) =>
    message.role === "system"
      ? (message.toolsAdded?.map((tool) => tool.name) ?? [])
      : [],
  );

/** Default conversion for the standard message roles used by these tests. */
const passthrough = (messages: AgentMessage[]): Message[] =>
  messages.filter(
    (message): message is Message =>
      message.role === "system" ||
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult",
  );

/** Responses that complain once with `complaint` and then settle, recording each request. */
function complainThenSettle(
  complaint: string,
  id: string,
  requests: Context[],
) {
  return [
    (context: Context) => {
      requests.push(context);
      return toolTurn(complainCall(complaint, id));
    },
    (context: Context) => {
      requests.push(context);
      const result = toolResult(context.messages, id);
      return fauxAssistantMessage(
        !result.isError ? "settled" : `failed: ${text(result.content)}`,
      );
    },
  ];
}

/** Prompt, expecting the run to settle with "settled" and no yield boundary. */
async function promptSettles(agent: JuncoAgent, prompt: string) {
  assert.equal((await agent.prompt(prompt)).stopReason, "stop");
  assert.equal(settledText(await agent.next()), "settled");
}

function assertOnlyComplain(tools: readonly object[]) {
  assert.equal(tools.length, 1);
  assert.equal(isComplainTool(tools[0]!), true);
}

test("complaint-only configurations still offer and execute exactly one genuine complain tool", async () => {
  const cases: [
    string,
    () => Promise<{ agent: JuncoAgent; requests: Context[] }>,
  ][] = [
    [
      "fromResolved empty",
      async () => {
        const requests: Context[] = [];
        const { agent } = await newAgent(
          complainThenSettle("empty", "c-empty", requests),
          { tools: [], activeToolNames: [] },
        );
        return { agent, requests };
      },
    ],
    [
      "create",
      async () => {
        const requests: Context[] = [];
        const { faux } = scripted(
          complainThenSettle("create", "c-create", requests),
        );
        const credentials = new InMemoryCredentialStore();
        await credentials.modify("faux", async () => ({
          type: "api_key",
          key: "fixture-login",
        }));
        const models = await ModelRuntime.create({
          credentials,
          modelsPath: null,
          refreshOnCreate: false,
        });
        models.registerNativeProvider(faux.provider);
        const agent = await JuncoAgent.create({
          models,
          policy: "LockPolicy",
          provider: "faux",
          model: "faux-1",
          tools: [],
        });
        assert.equal((await agent.getModel())?.id, "faux-1");
        return { agent, requests };
      },
    ],
    [
      "setActiveTools([])",
      async () => {
        const requests: Context[] = [];
        const { agent } = await newAgent(
          complainThenSettle("active", "c-active", requests),
          { tools: [countingTool("one").tool] },
        );
        await agent.setActiveTools([]);
        return { agent, requests };
      },
    ],
    [
      "setTools([])",
      async () => {
        const requests: Context[] = [];
        const { agent } = await newAgent(
          complainThenSettle("tools", "c-tools", requests),
          { tools: [countingTool("one").tool] },
        );
        await agent.setTools([]);
        assertOnlyComplain(agent.getTools());
        return { agent, requests };
      },
    ],
    [
      "setTools(getTools())",
      async () => {
        const requests: Context[] = [];
        const { agent } = await newAgent(
          complainThenSettle("again", "c-again", requests),
          { tools: [] },
        );
        const before = agent.getTools()[0];
        await agent.setTools(agent.getTools());
        assertOnlyComplain(agent.getTools());
        assert.equal(agent.getTools()[0], before);
        return { agent, requests };
      },
    ],
  ];
  for (const [label, make] of cases) {
    const before = issueLog.length;
    const { agent, requests } = await make();
    try {
      assertOnlyComplain(agent.getActiveTools());
      await promptSettles(agent, `go ${label}`);
      assert.deepEqual(
        requests.map(offered),
        [["complain"], ["complain"]],
        label,
      );
      const issues = issueLog.snapshot().slice(before);
      assert.equal(issues.length, 1, label);
      assert.equal(issues[0]!.nodeId, agent.nodeId);
      assert.deepEqual(issues[0]!.messages, []);
    } finally {
      await agent.return();
    }
  }
});

test("impostors, duplicates and unknown names are rejected, leaving the old tools usable", async () => {
  const one = countingTool("one");
  const impostor = { ...countingTool("complain").tool };
  const { models, model } = scripted([]);
  const repo = new MemorySessionRepo();
  for (const tools of [
    [impostor],
    [createComplainTool(), createComplainTool()],
  ]) {
    await assert.rejects(
      JuncoAgent.fromResolved({
        session: await repo.create({}, BACKGROUND_CONTEXT),
        models,
        policy: "LockPolicy",
        model,
        tools,
      }),
      isCode("invalid_argument"),
    );
  }
  const { agent } = await newAgent(
    [
      toolTurn(fauxToolCall("one", {}, { id: "o1" })),
      fauxAssistantMessage("settled"),
    ],
    { tools: [one.tool] },
  );
  try {
    const genuine = agent.getTools().at(-1)!;
    const copied = { ...genuine };
    for (const tools of [
      [one.tool, impostor],
      [one.tool, copied],
      [one.tool, createComplainTool(), createComplainTool()],
    ])
      await assert.rejects(agent.setTools(tools), isCode("invalid_argument"));
    for (const names of [
      ["one", "one"],
      ["missing"],
      ["complain", "complain"],
    ]) {
      await assert.rejects(
        agent.setActiveTools(names),
        isCode("invalid_argument"),
      );
      await assert.rejects(
        agent.setTools([one.tool], names),
        isCode("invalid_argument"),
      );
    }
    assert.equal(agent.getTools()[0], one.tool);
    assert.equal(agent.getTools()[1], genuine);
    assert.equal(Object.isFrozen(genuine), true);
    assert.equal(Reflect.set(genuine, "name", "renamed"), false);
    assert.equal(
      Reflect.set(genuine, "execute", async () => undefined),
      false,
    );
    assert.equal(genuine.name, "complain");
    await promptSettles(agent, "use one");
    assert.equal(one.state.executions, 1);
  } finally {
    await agent.return();
  }
});

test("a legacy persisted selection is repaired with complain on reopen without reactivating others", async () => {
  const one = countingTool("one");
  const two = countingTool("two");
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const { faux, models, model } = scripted([]);
  const native = (tool: typeof one.tool): AgentHarnessTool<undefined> => ({
    ...tool,
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      details: undefined,
    }),
  });
  const { harness } = await AgentHarness.create<undefined>(
    {
      session,
      models,
      model,
      tools: [native(one.tool), native(two.tool)],
      activeToolNames: ["two"],
    },
    BACKGROUND_CONTEXT,
  );
  const lane = await harness.lane("main", BACKGROUND_CONTEXT);
  await lane.setActiveTools(["two"], BACKGROUND_CONTEXT);
  assert.deepEqual(await lane.getActiveTools(BACKGROUND_CONTEXT), ["two"]);
  await harness.close(BACKGROUND_CONTEXT);

  const requests: Context[] = [];
  faux.setResponses(complainThenSettle("legacy", "c-legacy", requests));
  const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
  const agent = await JuncoAgent.fromResolved({
    session: reopened,
    models,
    policy: "LockPolicy",
    model,
    tools: [one.tool, two.tool],
  });
  try {
    assert.deepEqual(
      agent.getActiveTools().map((tool) => tool.name),
      ["two", "complain"],
    );
    await promptSettles(agent, "reopened");
    assert.deepEqual(offered(requests[0]!), ["two", "complain"]);
    assert.equal(one.state.executions, 0);
  } finally {
    await agent.return();
  }
});

test("a tool-free subagent complains with its own identity and fresh request", async () => {
  const requests: Context[] = [];
  const { faux, agent: parent } = await newAgent(
    [fauxAssistantMessage("parent")],
    {
      tools: [countingTool("one").tool],
    },
  );
  try {
    assert.equal((await parent.prompt("parent secret")).stopReason, "stop");
    settledText(await parent.next());
    const [child] = await parent.createSubagents([{ tools: [] }]);
    assert.ok(child);
    try {
      assert.notEqual(child.nodeId, parent.nodeId);
      assert.match(child.nodeId, /^agent-/);
      assertOnlyComplain(child.getTools());
      assert.notEqual(child.getTools()[0], parent.getTools().at(-1));
      faux.setResponses(complainThenSettle("child", "c-child", requests));
      const before = issueLog.length;
      await promptSettles(child, "child task");
      const issues = issueLog.snapshot().slice(before);
      assert.equal(issues.length, 1);
      assert.equal(issues[0]!.nodeId, child.nodeId);
      assert.deepEqual(userTexts(issues[0]!.prompt.messages as Message[]), [
        "child task",
      ]);
    } finally {
      await child.return();
    }
  } finally {
    await parent.return();
  }
});

test("agents sharing one Models registry keep their request snapshots isolated", async () => {
  const respond = (context: Context) => {
    const users = userTexts(context.messages);
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage("settled");
    return toolTurn(complainCall(`from ${users[0]}`, `c-${users[0]}`));
  };
  const { models, model } = scripted([respond, respond, respond, respond]);
  const repo = new MemorySessionRepo();
  const make = async () =>
    JuncoAgent.fromResolved({
      session: await repo.create({}, BACKGROUND_CONTEXT),
      models,
      policy: "LockPolicy",
      model,
      tools: [],
    });
  const alpha = await make();
  const beta = await make();
  try {
    const before = issueLog.length;
    await Promise.all([
      promptSettles(alpha, "alpha"),
      promptSettles(beta, "beta"),
    ]);
    const issues = issueLog.snapshot().slice(before);
    assert.equal(issues.length, 2);
    for (const [agent, name] of [
      [alpha, "alpha"],
      [beta, "beta"],
    ] as const) {
      const issue = issues.find((item) => item.complaint === `from ${name}`);
      assert.ok(issue);
      assert.equal(issue.nodeId, agent.nodeId);
      assert.deepEqual(userTexts(issue.prompt.messages as Message[]), [name]);
    }
  } finally {
    await alpha.return();
    await beta.return();
  }
});

test("the saved prompt is the final converted request, unaffected by later requests", async () => {
  const image = {
    type: "image" as const,
    data: "aGVsbG8=",
    mimeType: "image/png",
  };
  const converted: Message = {
    role: "user",
    content: [{ type: "text", text: "converted input" }, image],
    timestamp: 1,
  };
  const { agent } = await newAgent(
    [
      toolTurn(complainCall("blocked", "c-final")),
      fauxAssistantMessage("settled"),
    ],
    {
      systemPrompt: "initial system",
      tools: [],
      toProviderMessages: () => [converted],
    },
  );
  let requestCount = 0;
  agent.hooks.on("transform_context", () => {
    requestCount++;
    return { systemPrompt: `hooked system ${requestCount}` };
  });
  try {
    const before = issueLog.length;
    await promptSettles(agent, "original input");
    assert.equal(requestCount, 2);
    const [issue] = issueLog.snapshot().slice(before);
    assert.ok(issue);
    assert.equal(
      issue.prompt.systemPrompt,
      "hooked system 1\n\nAfter you write to a file use release to relinquish ownership",
    );
    assert.deepEqual(issue.prompt.messages, [converted]);
    const tools = issue.prompt.tools ?? [];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["complain"],
    );
    assert.deepEqual(Object.keys(tools[0]!.parameters.properties ?? {}), [
      "complaint",
    ]);
    assert.equal(Object.isFrozen(issue.prompt), true);
  } finally {
    await agent.return();
  }
});

test("a bound complaint context is cleared after normal and thrown work", async () => {
  const observed: [string, string][] = [];
  const tracer = {
    complain: (id: string, complaint: string) => observed.push([id, complaint]),
  };
  const { agent } = await newAgent(
    [
      toolTurn(complainCall("bound", "c-bound")),
      fauxAssistantMessage("settled"),
      toolTurn(complainCall("standalone", "c-standalone")),
      fauxAssistantMessage("settled"),
    ],
    { tools: [] },
  );
  try {
    const nodeId = NodeId("bound-node");
    const messages = [
      { id: EdgeId("source->worker"), payload: { kind: "prompt" } },
    ];
    const before = issueLog.length;
    await agent.runWithNodeContext(
      { complaint: { nodeId, messages, tracer } },
      () => promptSettles(agent, "bound"),
    );
    await assert.rejects(
      agent.runWithNodeContext(
        { complaint: { nodeId, messages } },
        async () => {
          await assert.rejects(
            agent.runWithNodeContext(
              { complaint: { nodeId, messages } },
              async () => {},
            ),
            isCode("busy"),
          );
          throw new Error("work failed");
        },
      ),
      /work failed/,
    );
    await promptSettles(agent, "standalone");
    const issues = issueLog.snapshot().slice(before);
    assert.deepEqual(
      issues.map((issue) => [issue.nodeId, issue.messages, issue.complaint]),
      [
        [nodeId, messages, "bound"],
        [agent.nodeId, [], "standalone"],
      ],
    );
    assert.deepEqual(observed, [["bound-node", "bound"]]);
  } finally {
    await agent.return();
  }
});

test("a failed request snapshot does not block responses, and complaints from it record nothing", async () => {
  let poison = true;
  const requests: Context[] = [];
  const { agent } = await newAgent(
    [
      fauxAssistantMessage("unrelated"),
      toolTurn(complainCall("unrecorded", "c-poison")),
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("after error");
      },
    ],
    {
      tools: [],
      toProviderMessages: (messages) => {
        const converted = passthrough(messages);
        // A function value makes the request impossible to structuredClone.
        return poison
          ? converted.map((message) => ({
              ...message,
              poison: () => undefined,
            }))
          : converted;
      },
    },
  );
  try {
    const before = issueLog.length;
    assert.equal((await agent.prompt("first")).stopReason, "stop");
    assert.equal(settledText(await agent.next()), "unrelated");
    assert.equal((await agent.prompt("second")).stopReason, "stop");
    assert.equal(settledText(await agent.next()), "after error");
    const result = toolResult(requests[0]!.messages, "c-poison");
    assert.equal(result.isError, true);
    assert.match(text(result.content), /model request snapshot unavailable/);
    assert.equal(issueLog.length, before);
    poison = false;
  } finally {
    await agent.return();
  }
});
