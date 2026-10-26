import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AssignedTaskTool,
  invokeTaskTool,
  isAssignedTaskTool,
  isTaskTool,
  TaskTool,
} from "../dist/task.js";
import { text } from "./helpers.mjs";
import { assistantText, scriptedModel, toolResult } from "./scripted-model.mjs";

// Native-free: only dist/task.js, Pi's bare Agent and an instance-scoped faux provider.

/** A host recording each request: one handle per launched task, the retried ID, none for ignore. */
function recordingHost() {
  const calls = [];
  const host = async (toolCallId, input, signal) => {
    calls.push({ toolCallId, input, signal });
    if ("action" in input)
      return input.action === "retry" ? [{ id: input.id }] : [];
    return input.tasks.map((item, index) => ({
      id: `handle-${calls.length}-${index}`,
      ...(item.name === undefined ? {} : { name: item.name }),
    }));
  };
  return { host, calls };
}

async function settle(agent) {
  try {
    agent.abort();
  } finally {
    await agent.waitForIdle();
  }
}

test("an explicitly hosted task tool works in a bare Pi agent and its handles reach the next request", async () => {
  const { host, calls } = recordingHost();
  const tool = new TaskTool(host);
  assert.equal(tool.name, "task");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(isTaskTool(tool), true);

  const { faux, model, streamFn } = scriptedModel();
  const capture = {};
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "task",
          {
            context: "shared",
            tasks: [{ name: "alpha", task: "do a" }, { task: "do b" }],
          },
          { id: "call-1" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      capture.context = context;
      return fauxAssistantMessage("continued");
    },
  ]);
  const agent = new Agent({
    initialState: { model, systemPrompt: "Delegate.", tools: [tool] },
    streamFn,
  });
  try {
    await agent.prompt("split the work");
    await agent.waitForIdle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolCallId, "call-1");
    const result = toolResult(capture.context.messages, "call-1");
    assert.ok(result, "the next model request never saw the task result");
    assert.equal(result.isError, false);
    assert.deepEqual(result.details, {
      tasks: [{ id: "handle-1-0", name: "alpha" }, { id: "handle-1-1" }],
    });
    // The serialized handles are what the model sees.
    assert.match(text(result, ""), /handle-1-0/);
    assert.match(text(result, ""), /handle-1-1/);
    assert.equal(assistantText(agent.state.messages.at(-1)), "continued");
    assert.equal(faux.state.callCount, 2);
  } finally {
    await settle(agent);
  }
});

test("an unhosted task call is an ordinary tool error and the agent continues", async () => {
  const tool = new TaskTool();
  const { faux, model, streamFn } = scriptedModel();
  const capture = {};
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "task",
          { context: "c", tasks: [{ task: "x" }] },
          { id: "lonely" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      capture.context = context;
      return fauxAssistantMessage("recovered");
    },
  ]);
  const agent = new Agent({
    initialState: { model, systemPrompt: "Delegate.", tools: [tool] },
    streamFn,
  });
  try {
    await agent.prompt("try");
    await agent.waitForIdle();
    const result = toolResult(capture.context.messages, "lonely");
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.equal(assistantText(agent.state.messages.at(-1)), "recovered");
  } finally {
    await settle(agent);
  }
  await assert.rejects(async () =>
    tool.execute("direct", { context: "c", tasks: [{ task: "x" }] }),
  );
});

test("invalid task input never reaches the host", async () => {
  const { host, calls } = recordingHost();
  const tool = new TaskTool(host);
  const invalid = [
    {},
    { context: "c", tasks: [] },
    { context: "c", tasks: [{ task: "" }] },
    { context: "c", tasks: [{ task: "  \n\t" }] },
    { context: "c", tasks: [{}] },
    { tasks: [{ task: "x" }] },
    { context: "   ", tasks: [{ task: "x" }] },
    { context: "c", tasks: [{ name: " ", task: "x" }] },
    {
      context: "c",
      tasks: [{ task: "x", model: { provider: " ", modelId: "m" } }],
    },
    {
      context: "c",
      tasks: [{ task: "x", model: { provider: "p", modelId: "" } }],
    },
    { context: "c", tasks: [{ task: "x", model: { provider: "p" } }] },
    {
      context: "c",
      tasks: [{ task: "x", model: { provider: "p", modelId: "m", extra: 1 } }],
    },
    { context: "c", tasks: [{ task: "x", surprise: true }] },
    { context: "c", tasks: [{ task: "x" }], surprise: true },
    { context: "c", tasks: [{ task: "x", tools: [1] }] },
  ];
  for (const input of invalid) {
    await assert.rejects(
      tool.execute("bad", input),
      /Invalid task input/,
      JSON.stringify(input),
    );
    await assert.rejects(
      invokeTaskTool(tool, host, "bad", input, new AbortController().signal),
      /Invalid task input/,
      JSON.stringify(input),
    );
  }
  assert.equal(calls.length, 0);
});

test("the host receives trimmed names, preserved text and a detached snapshot", async () => {
  const { host, calls } = recordingHost();
  const tool = new TaskTool(host);
  const input = {
    context: "  shared\n background  ",
    tasks: [
      {
        name: "  alpha  ",
        task: "  first\n task  ",
        model: { provider: "prov", modelId: "mod" },
        tools: ["read", "bash"],
      },
      { name: "alpha", task: "second" },
    ],
  };
  const result = await tool.execute("call", input);
  assert.equal(calls.length, 1);
  const seen = calls[0].input;
  assert.deepEqual(seen, {
    context: "  shared\n background  ",
    tasks: [
      {
        name: "alpha",
        task: "  first\n task  ",
        model: { provider: "prov", modelId: "mod" },
        tools: ["read", "bash"],
      },
      { name: "alpha", task: "second" },
    ],
  });
  // Duplicate labels are allowed; handles distinguish children.
  assert.deepEqual(
    result.details.tasks.map(({ name }) => name),
    ["alpha", "alpha"],
  );
  assert.notEqual(result.details.tasks[0].id, result.details.tasks[1].id);

  input.tasks[0].tools.push("edit");
  input.tasks[0].model.modelId = "other";
  input.tasks.push({ task: "late" });
  assert.deepEqual(seen.tasks[0].tools, ["read", "bash"]);
  assert.equal(seen.tasks[0].model.modelId, "mod");
  assert.equal(seen.tasks.length, 2);
});

test("host rejection and a mismatched handle count fail the call", async () => {
  const rejecting = new TaskTool(async () => {
    throw new Error("host refused");
  });
  await assert.rejects(
    rejecting.execute("a", { context: "c", tasks: [{ task: "x" }] }),
    /host refused/,
  );

  const short = new TaskTool(async () => [{ id: "only" }]);
  await assert.rejects(
    short.execute("b", { context: "c", tasks: [{ task: "x" }, { task: "y" }] }),
  );
  const long = new TaskTool(async () => [{ id: "one" }, { id: "two" }]);
  await assert.rejects(
    long.execute("c", { context: "c", tasks: [{ task: "x" }] }),
  );

  // Inside an agent the rejection is a model-visible tool error.
  const { faux, model, streamFn } = scriptedModel();
  const capture = {};
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "task",
          { context: "c", tasks: [{ task: "x" }] },
          { id: "refused" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      capture.context = context;
      return fauxAssistantMessage("after refusal");
    },
  ]);
  const agent = new Agent({
    initialState: { model, systemPrompt: "Delegate.", tools: [rejecting] },
    streamFn,
  });
  try {
    await agent.prompt("try");
    await agent.waitForIdle();
    const result = toolResult(capture.context.messages, "refused");
    assert.equal(result.isError, true);
    assert.match(text(result, ""), /host refused/);
    assert.equal(assistantText(agent.state.messages.at(-1)), "after refusal");
  } finally {
    await settle(agent);
  }
});

test("only factory-created tools are task primitives", async () => {
  const tool = new TaskTool();
  const copy = { ...tool };
  const impostor = { name: "task", label: "task", execute: tool.execute };
  assert.equal(isTaskTool(copy), false);
  assert.equal(isTaskTool(impostor), false);
  assert.equal(isTaskTool({ name: "task" }), false);

  const { host, calls } = recordingHost();
  const signal = new AbortController().signal;
  const input = { context: "c", tasks: [{ task: "x" }] };
  assert.throws(
    () => invokeTaskTool(copy, host, "c", input, signal),
    TypeError,
  );
  assert.throws(
    () => invokeTaskTool(impostor, host, "c", input, signal),
    TypeError,
  );
  assert.equal(calls.length, 0);

  // invokeTaskTool uses the supplied host, not the one the tool was created with.
  const own = recordingHost();
  const hosted = new TaskTool(own.host);
  const result = await invokeTaskTool(
    hosted,
    host,
    "via-invoke",
    input,
    signal,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolCallId, "via-invoke");
  assert.equal(calls[0].signal, signal);
  assert.equal(own.calls.length, 0);
  assert.equal(result.details.tasks.length, 1);
});

test("an already aborted signal stops admission before the host", async () => {
  const { host, calls } = recordingHost();
  const tool = new TaskTool(host);
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    tool.execute(
      "x",
      { context: "c", tasks: [{ task: "x" }] },
      controller.signal,
    ),
  );
  await assert.rejects(
    invokeTaskTool(
      tool,
      host,
      "x",
      { context: "c", tasks: [{ task: "x" }] },
      controller.signal,
    ),
  );
  assert.equal(calls.length, 0);
});

test("an assigned task tool launches its detached canonical batch from {}", async () => {
  const input = {
    context: "  shared  ",
    tasks: [
      {
        name: "  alpha ",
        task: "first",
        model: { provider: "p", modelId: "m" },
        tools: ["read"],
      },
      { task: "second", tools: [] },
    ],
  };
  const tool = new AssignedTaskTool(input);
  assert.equal(tool.name, "task");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(isTaskTool(tool), true);
  assert.equal(isAssignedTaskTool(tool), true);
  assert.equal(isAssignedTaskTool(new TaskTool()), false);
  // The batch is not published to the model.
  assert.doesNotMatch(JSON.stringify(tool.parameters), /first|second/);
  assert.doesNotMatch(tool.description, /first|second/);

  input.context = "changed";
  input.tasks[0].task = "rewritten";
  input.tasks[0].tools.push("bash");
  input.tasks[0].model.modelId = "other";
  input.tasks.push({ task: "late" });

  const expected = {
    context: "  shared  ",
    tasks: [
      {
        name: "alpha",
        task: "first",
        model: { provider: "p", modelId: "m" },
        tools: ["read"],
      },
      { task: "second", tools: [] },
    ],
  };
  const { host, calls } = recordingHost();
  const signal = new AbortController().signal;
  const result = await invokeTaskTool(tool, host, "go", {}, signal);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, expected);
  assert.deepEqual(result.details, {
    tasks: [{ id: "handle-1-0", name: "alpha" }, { id: "handle-1-1" }],
  });
  // Each launch gets its own snapshot: a host mutating one cannot alter the next.
  calls[0].input.tasks[0].tools.push("edit");
  await invokeTaskTool(tool, host, "again", {}, signal);
  assert.deepEqual(calls[1].input, expected);

  // Without a host, an assigned tool fails like an unhosted ordinary one.
  await assert.rejects(async () => tool.execute("direct", {}));
});

test("an assigned task tool rejects invalid batches and non-trigger launches", async () => {
  for (const input of [
    { context: "c", tasks: [] },
    { context: " ", tasks: [{ task: "x" }] },
    { context: "c", tasks: [{ task: "x", extra: 1 }] },
    { tasks: [{ task: "x" }] },
  ])
    assert.throws(
      () => new AssignedTaskTool(input),
      /Invalid task input/,
      JSON.stringify(input),
    );

  const tool = new AssignedTaskTool({ context: "c", tasks: [{ task: "x" }] });
  const { host, calls } = recordingHost();
  const signal = new AbortController().signal;
  for (const input of [
    { context: "c", tasks: [{ task: "replacement" }] },
    { context: "c" },
    { surprise: true },
  ])
    await assert.rejects(
      invokeTaskTool(tool, host, "bad", input, signal),
      /Invalid task input/,
      JSON.stringify(input),
    );
  // `{}` is only a trigger for an assigned batch.
  await assert.rejects(
    invokeTaskTool(new TaskTool(), host, "bad", {}, signal),
    /Invalid task input/,
  );
  assert.equal(calls.length, 0);
});

test("copies of an assigned task tool are not task primitives", () => {
  const tool = new AssignedTaskTool({ context: "c", tasks: [{ task: "x" }] });
  const copy = { ...tool };
  const impostor = { name: "task", label: "task", execute: tool.execute };
  const { host, calls } = recordingHost();
  const signal = new AbortController().signal;
  for (const fake of [copy, impostor]) {
    assert.equal(isTaskTool(fake), false);
    assert.equal(isAssignedTaskTool(fake), false);
    assert.throws(() => invokeTaskTool(fake, host, "c", {}, signal), TypeError);
  }
  assert.equal(calls.length, 0);
});

test("both task variants pass valid decisions to the host as exactly { action, id, attempt }", async () => {
  const signal = new AbortController().signal;
  for (const tool of [
    new TaskTool(),
    new AssignedTaskTool({ context: "c", tasks: [{ task: "x" }] }),
  ]) {
    const { host, calls } = recordingHost();
    const retried = await invokeTaskTool(
      tool,
      host,
      "r",
      { action: "retry", id: "task-1", attempt: 2 },
      signal,
    );
    assert.deepEqual(retried.details, { tasks: [{ id: "task-1" }] });
    assert.match(text(retried, ""), /task-1/);
    const ignored = await invokeTaskTool(
      tool,
      host,
      "i",
      { action: "ignore", id: "task-2", attempt: Number.MAX_SAFE_INTEGER },
      signal,
    );
    assert.deepEqual(ignored.details, { tasks: [] });
    assert.equal(text(ignored, ""), "Ignored task task-2.");
    assert.deepEqual(
      calls.map(({ toolCallId, input }) => [toolCallId, input]),
      [
        ["r", { action: "retry", id: "task-1", attempt: 2 }],
        [
          "i",
          { action: "ignore", id: "task-2", attempt: Number.MAX_SAFE_INTEGER },
        ],
      ],
    );
  }
});

test("invalid decisions never reach the host", async () => {
  const signal = new AbortController().signal;
  const invalid = [
    { action: "cancel", id: "t", attempt: 1 },
    { action: "retry", id: "t", attempt: 0 },
    { action: "retry", id: "t", attempt: 1.5 },
    { action: "retry", id: "t", attempt: -1 },
    { action: "retry", id: "t", attempt: Number.MAX_SAFE_INTEGER + 1 },
    { action: "retry", id: "t", attempt: "1" },
    { action: "ignore", id: " ", attempt: 1 },
    { action: "ignore", attempt: 1 },
    { action: "ignore", id: "t" },
    { action: "ignore", id: "t", attempt: 1, extra: true },
    {
      action: "retry",
      id: "t",
      attempt: 1,
      context: "c",
      tasks: [{ task: "x" }],
    },
  ];
  for (const tool of [
    new TaskTool(),
    new AssignedTaskTool({ context: "c", tasks: [{ task: "x" }] }),
  ]) {
    const { host, calls } = recordingHost();
    for (const input of invalid)
      await assert.rejects(
        invokeTaskTool(tool, host, "bad", input, signal),
        /Invalid task input/,
        JSON.stringify(input),
      );
    assert.equal(calls.length, 0);
  }
});

test("decision receipts must match the decision", async () => {
  const signal = new AbortController().signal;
  const retry = { action: "retry", id: "t", attempt: 1 };
  const ignore = { action: "ignore", id: "t", attempt: 1 };
  const tool = new TaskTool();
  for (const handles of [[], [{ id: "other" }], [{ id: "t" }, { id: "t" }]])
    await assert.rejects(
      invokeTaskTool(tool, async () => handles, "r", retry, signal),
      /for a retry of t/,
      JSON.stringify(handles),
    );
  await assert.rejects(
    invokeTaskTool(tool, async () => [{ id: "t" }], "i", ignore, signal),
    /returned handles for ignoring t/,
  );
  await assert.rejects(
    invokeTaskTool(
      tool,
      async () => {
        throw new Error("no such task");
      },
      "i",
      ignore,
      signal,
    ),
    /no such task/,
  );
});

/** A tiny ProfileRecorder collecting events; `sum`/`gauge` read one operation's metrics. */
function profileRecorder() {
  const events = [];
  const recorder = {
    path: "",
    add_context: () => recorder,
    record: (event) => events.push(event),
    flush: async () => {},
    close: async () => {},
    events,
    of: (operation) => events.filter((e) => e.operation === operation),
    count: (operation, kind, outcome) =>
      recorder
        .of(operation)
        .filter(
          (e) =>
            e.kind === kind && (outcome === undefined || e.outcome === outcome),
        ).length,
    sum: (operation, field) =>
      recorder
        .of(operation)
        .reduce((total, e) => total + (e.counters?.[field] ?? 0), 0),
  };
  recorder.root = recorder;
  return recorder;
}

test("task calls count once with bounded action labels", async () => {
  const recorder = profileRecorder();
  const { host } = recordingHost();
  const signal = new AbortController().signal;
  const tool = new TaskTool(host, recorder);
  await tool.execute(
    "a",
    { context: "c", tasks: [{ task: "x" }, { task: "y" }] },
    signal,
  );
  await invokeTaskTool(
    tool,
    host,
    "b",
    { context: "c", tasks: [{ task: "z" }] },
    signal,
  );
  await assert.rejects(
    tool.execute("c", { action: "explode", id: "x", attempt: 1 }, signal),
  );
  assert.equal(recorder.count("launch", "start"), 2);
  assert.equal(recorder.sum("launch", "handles_returned"), 3);
  assert.equal(recorder.count("invalid", "finish", "error"), 1);
});
