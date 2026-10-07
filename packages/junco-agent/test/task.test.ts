import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type Session,
} from "@earendil-works/pi-agent-core";
import {
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createTaskTool,
  isAssignedTaskTool,
  isComplainTool,
  isTaskTool,
  type TaskInput,
  type TaskToolDetails,
  type TaskToolHost,
} from "junco-tools";
import { type AgenticStep, JuncoAgent, JuncoAgentError } from "../src/index.ts";
import { countingTool, newAgent, scripted } from "./harness.ts";

const TIMEOUT = 5_000;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const toolTurn = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });
const taskCall = (id: string, input: ToolCall["arguments"]) =>
  fauxToolCall("task", input, { id });

function step(result: IteratorResult<AgenticStep, void>): AgenticStep {
  assert.ok(!result.done);
  return result.value;
}

function settledText(result: IteratorResult<AgenticStep, void>): string {
  const value = step(result);
  assert.equal(value.kind, "settled");
  if (value.kind !== "settled") return "";
  return value.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function blockText(content: string | readonly { type: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) =>
      block.type === "text" && "text" in block && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
}

function userTexts(messages: Context["messages"]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" ? [blockText(message.content)] : [],
  );
}

/** Asserts the optional tools in order, followed by exactly one genuine complain tool. */
function assertTools(actual: readonly object[], expected: readonly object[]) {
  assert.deepEqual(actual.slice(0, -1), expected);
  assert.equal(isComplainTool(actual.at(-1)!), true);
  assert.equal(actual.filter((tool) => isComplainTool(tool)).length, 1);
}

function toolResultOf(
  messages: Context["messages"],
  toolCallId: string,
): ToolResultMessage {
  const found = messages.findLast(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolCallId === toolCallId,
  );
  assert.ok(found, `no tool result for ${toolCallId}`);
  return found;
}

const isCode =
  (code: JuncoAgentError["code"]) =>
  (error: unknown): boolean =>
    error instanceof JuncoAgentError && error.code === code;

/** A host recording each request: one handle per launched task, the retried ID, none for ignore. */
function recordingHost(prefix = "h") {
  const calls: { toolCallId: string; input: Parameters<TaskToolHost>[1] }[] =
    [];
  const host: TaskToolHost = async (toolCallId, input) => {
    calls.push({ toolCallId, input });
    if ("action" in input)
      return input.action === "retry" ? [{ id: input.id }] : [];
    return input.tasks.map((item, index) => ({
      id: `${prefix}-${toolCallId}-${index}`,
      ...(item.name === undefined ? {} : { name: item.name }),
    }));
  };
  return { host, calls };
}

/** Records the sessions created by MemorySessionRepo while installed; restores on `restore`. */
function spySessions(onCreate?: (count: number) => void) {
  const original = MemorySessionRepo.prototype.create;
  const sessions: Session[] = [];
  MemorySessionRepo.prototype.create = async function (
    this: MemorySessionRepo,
    ...args: Parameters<MemorySessionRepo["create"]>
  ) {
    const session = await original.apply(this, args);
    sessions.push(session);
    onCreate?.(sessions.length);
    return session;
  };
  return {
    sessions,
    restore: () => {
      MemorySessionRepo.prototype.create = original;
    },
  };
}

async function isClosed(session: Session): Promise<boolean> {
  try {
    const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
    await mutation.end(BACKGROUND_CONTEXT);
    return false;
  } catch {
    return true;
  }
}

// Tool boundary -----------------------------------------------------------------------------------

test(
  "a hosted task call yields a task boundary, gates the next request, and resumes the same run",
  async () => {
    const { host, calls } = recordingHost();
    const capture: { context?: Context } = {};
    const { faux, agent } = await newAgent(
      [
        toolTurn(
          taskCall("t1", {
            context: "shared",
            tasks: [{ name: "alpha", task: "do a" }, { task: "do b" }],
          }),
        ),
        (context) => {
          capture.context = context;
          return fauxAssistantMessage("after handles");
        },
      ],
      { tools: [createTaskTool()], prompt: "split" },
    );
    const runs: string[] = [];
    const turns: string[] = [];
    agent.events.on("run_start", (event) => {
      if (event.lane === "main") runs.push(event.runId);
    });
    agent.events.on("turn_start", (event) => {
      if (event.lane === "main") turns.push(event.runId);
    });
    try {
      const paused = await agent.runWithTaskHost(host, async () =>
        step(await agent.next()),
      );
      assert.deepEqual(paused, {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "task",
            reason: "Scheduled 2 subagents",
          },
        ],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.toolCallId, "t1");
      await tick();
      await tick();
      assert.equal(faux.state.callCount, 1);
      assert.equal(agent.status, "suspended");

      assert.equal(settledText(await agent.next()), "after handles");
      assert.equal(faux.state.callCount, 2);
      const result = toolResultOf(capture.context!.messages, "t1");
      assert.equal(result.isError, false);
      assert.match(blockText(result.content), /h-t1-0/);
      assert.match(blockText(result.content), /h-t1-1/);
      assert.deepEqual(result.details, {
        tasks: [{ id: "h-t1-0", name: "alpha" }, { id: "h-t1-1" }],
      });
      // Resuming continued the admitted run rather than starting another.
      assert.equal(runs.length, 1);
      assert.ok(turns.length >= 2);
      assert.ok(turns.every((runId) => runId === runs[0]));
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "two task calls in one batch pause once with both admissions in source order",
  async () => {
    const { host, calls } = recordingHost();
    const { agent } = await newAgent(
      [
        toolTurn(
          taskCall("first", { context: "c", tasks: [{ task: "a" }] }),
          taskCall("second", {
            context: "c",
            tasks: [{ task: "b" }, { task: "c" }],
          }),
        ),
        fauxAssistantMessage("done"),
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    try {
      const paused = await agent.runWithTaskHost(host, async () =>
        step(await agent.next()),
      );
      assert.deepEqual(paused, {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "first",
            toolName: "task",
            reason: "Scheduled 1 subagents",
          },
          {
            kind: "tool",
            toolCallId: "second",
            toolName: "task",
            reason: "Scheduled 2 subagents",
          },
        ],
      });
      assert.deepEqual(
        calls.map(({ toolCallId }) => toolCallId),
        ["first", "second"],
      );
      assert.equal(settledText(await agent.next()), "done");
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "a task policy rejects an input as a tool error before admission, then admits a corrected call",
  async () => {
    const { host, calls } = recordingHost();
    const seen: string[] = [];
    const capture: { context?: Context } = {};
    const { agent } = await newAgent(
      [
        toolTurn(
          taskCall("narrowed", { context: "c", tasks: [{ task: "part" }] }),
        ),
        (context) => {
          capture.context = context;
          return toolTurn(
            taskCall("assigned", { context: "c", tasks: [{ task: "whole" }] }),
          );
        },
        fauxAssistantMessage("done"),
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    agent.setTaskPolicy((input) => {
      seen.push(input.tasks.map(({ task }) => task).join());
      if (input.tasks[0]?.task !== "whole")
        throw new Error("not the assigned batch");
    });
    try {
      const paused = await agent.runWithTaskHost(host, async () =>
        step(await agent.next()),
      );
      assert.deepEqual(paused, {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "assigned",
            toolName: "task",
            reason: "Scheduled 1 subagents",
          },
        ],
      });
      const rejected = toolResultOf(capture.context!.messages, "narrowed");
      assert.equal(rejected.isError, true);
      assert.match(blockText(rejected.content), /not the assigned batch/);
      assert.deepEqual(seen, ["part", "whole"]);
      assert.deepEqual(
        calls.map(({ toolCallId }) => toolCallId),
        ["assigned"],
      );
      assert.equal(settledText(await agent.next()), "done");
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "failed, unhosted, blocked and spoofed task calls never reach the host or pause",
  async () => {
    const cases: {
      label: string;
      input?: ToolCall["arguments"];
      tools: () => AgentTool[];
      activeToolNames?: string[];
      bind: boolean;
      block?: boolean;
      host?: TaskToolHost;
    }[] = [
      {
        label: "empty batch",
        input: { context: "c", tasks: [] },
        tools: () => [createTaskTool()],
        bind: true,
      },
      {
        label: "blank instructions",
        input: { context: "c", tasks: [{ task: "   " }] },
        tools: () => [createTaskTool()],
        bind: true,
      },
      {
        label: "unknown property",
        input: { context: "c", tasks: [{ task: "x", extra: 1 }] },
        tools: () => [createTaskTool()],
        bind: true,
      },
      {
        label: "missing context",
        input: { tasks: [{ task: "x" }] },
        tools: () => [createTaskTool()],
        bind: true,
      },
      { label: "no host bound", tools: () => [createTaskTool()], bind: false },
      {
        label: "host rejection",
        tools: () => [createTaskTool()],
        bind: true,
        host: async () => {
          throw new Error("refused");
        },
      },
      {
        label: "inactive task tool",
        tools: () => [createTaskTool(), countingTool("other").tool],
        activeToolNames: ["other"],
        bind: true,
      },
      {
        label: "same-named impostor",
        tools: () => [countingTool("task").tool],
        bind: true,
      },
      {
        label: "spread copy",
        tools: () => {
          const original: AgentTool = createTaskTool();
          return [{ ...original }];
        },
        bind: true,
      },
      {
        label: "blocked by hook",
        tools: () => [createTaskTool()],
        bind: true,
        block: true,
      },
    ];
    for (const item of cases) {
      const recorder = recordingHost();
      const capture: { context?: Context } = {};
      const { faux, agent } = await newAgent(
        [
          toolTurn(
            taskCall(
              "c1",
              item.input ?? { context: "c", tasks: [{ task: "x" }] },
            ),
          ),
          (context) => {
            capture.context = context;
            return fauxAssistantMessage("continued");
          },
        ],
        {
          tools: item.tools(),
          ...(item.activeToolNames
            ? { activeToolNames: item.activeToolNames }
            : {}),
          prompt: "go",
        },
      );
      if (item.block)
        agent.hooks.on("before_tool", ({ toolName }) =>
          toolName === "task" ? { block: { reason: "denied" } } : undefined,
        );
      let rejected = 0;
      const host: TaskToolHost =
        item.host === undefined
          ? recorder.host
          : async (...args) => {
              rejected += 1;
              return item.host!(...args);
            };
      try {
        const result = item.bind
          ? await agent.runWithTaskHost(host, () => agent.next())
          : await agent.next();
        assert.equal(settledText(result), "continued", item.label);
        assert.equal(faux.state.callCount, 2, item.label);
        assert.equal(recorder.calls.length, 0, item.label);
        if (item.host) assert.equal(rejected, 1, item.label);
        if (item.label !== "same-named impostor")
          assert.equal(
            toolResultOf(capture.context!.messages, "c1").isError,
            true,
            item.label,
          );
      } finally {
        await agent.return();
      }
    }
  },
  TIMEOUT,
);

test(
  "one branded task tool shared by two agents admits each call through its own agent's host",
  async () => {
    const shared = createTaskTool();
    const a = recordingHost("a");
    const b = recordingHost("b");
    const first = await newAgent(
      [
        toolTurn(taskCall("from-a", { context: "c", tasks: [{ task: "a" }] })),
        fauxAssistantMessage("a done"),
      ],
      { tools: [shared], prompt: "a" },
    );
    const second = await newAgent(
      [
        toolTurn(taskCall("from-b", { context: "c", tasks: [{ task: "b" }] })),
        fauxAssistantMessage("b done"),
      ],
      { tools: [shared], prompt: "b" },
    );
    try {
      const [pausedA, pausedB] = await Promise.all([
        first.agent.runWithTaskHost(a.host, async () =>
          step(await first.agent.next()),
        ),
        second.agent.runWithTaskHost(b.host, async () =>
          step(await second.agent.next()),
        ),
      ]);
      assert.equal(pausedA.kind, "yield");
      assert.equal(pausedB.kind, "yield");
      assert.deepEqual(
        a.calls.map(({ toolCallId }) => toolCallId),
        ["from-a"],
      );
      assert.deepEqual(
        b.calls.map(({ toolCallId }) => toolCallId),
        ["from-b"],
      );
      assert.equal(settledText(await first.agent.next()), "a done");
      assert.equal(settledText(await second.agent.next()), "b done");
    } finally {
      await Promise.all([first.agent.return(), second.agent.return()]);
    }
  },
  TIMEOUT,
);

test("binding a second task host while one is bound is busy", async () => {
  const { agent } = await newAgent([], { tools: [createTaskTool()] });
  const { host } = recordingHost();
  try {
    const inner = await agent.runWithTaskHost(host, async () => {
      await assert.rejects(
        agent.runWithTaskHost(host, async () => "nested"),
        isCode("busy"),
      );
      return "outer";
    });
    assert.equal(inner, "outer");
    // The binding ends with its work, whether it resolves or rejects.
    await assert.rejects(
      agent.runWithTaskHost(host, async () => {
        throw new Error("work failed");
      }),
      /work failed/,
    );
    assert.equal(
      await agent.runWithTaskHost(host, async () => "again"),
      "again",
    );
    assert.equal(agent.status, "idle");
  } finally {
    await agent.return();
  }
});

test(
  "aborting the agent while the host is gated aborts the host signal and creates no task pause",
  async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const host: TaskToolHost = (_id, _input, signal) => {
      started.resolve(signal);
      const { promise, reject } =
        Promise.withResolvers<TaskToolDetails["tasks"]>();
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      return promise;
    };
    const { agent } = await newAgent(
      [
        toolTurn(taskCall("held", { context: "c", tasks: [{ task: "x" }] })),
        fauxAssistantMessage("must not run"),
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    try {
      const outcome = agent.runWithTaskHost(host, () => agent.next());
      const signal = await started.promise;
      assert.equal(signal.aborted, false);
      await agent.abort();
      assert.equal(signal.aborted, true);
      const result = await outcome;
      assert.ok(result.done || result.value.kind !== "yield");
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "active-tool removal disables task and tool replacement admits through the new task tool",
  async () => {
    const { host, calls } = recordingHost();
    const other = countingTool("other");
    const capture: { context?: Context } = {};
    const { agent } = await newAgent(
      [
        toolTurn(
          taskCall("inactive", { context: "c", tasks: [{ task: "x" }] }),
        ),
        (context) => {
          capture.context = context;
          return fauxAssistantMessage("no task");
        },
        toolTurn(
          taskCall("replaced", { context: "c", tasks: [{ task: "y" }] }),
        ),
        fauxAssistantMessage("replaced done"),
      ],
      { tools: [createTaskTool(), other.tool] },
    );
    try {
      await agent.setActiveTools(["other"]);
      const first = await agent.runWithTaskHost(host, async () => {
        const prompt = agent.prompt("one");
        const result = await agent.next();
        await prompt;
        return result;
      });
      assert.equal(settledText(first), "no task");
      assert.equal(calls.length, 0);
      assert.equal(
        toolResultOf(capture.context!.messages, "inactive").isError,
        true,
      );

      const replacement = createTaskTool();
      await agent.setTools([replacement, other.tool]);
      assertTools(agent.getActiveTools(), [replacement, other.tool]);
      const paused = await agent.runWithTaskHost(host, async () => {
        void agent.prompt("two");
        return step(await agent.next());
      });
      assert.deepEqual(paused, {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "replaced",
            toolName: "task",
            reason: "Scheduled 1 subagents",
          },
        ],
      });
      assert.deepEqual(
        calls.map(({ toolCallId }) => toolCallId),
        ["replaced"],
      );
      assert.equal(settledText(await agent.next()), "replaced done");
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

// Assigned batches and decisions ------------------------------------------------------------------

const batch = (): TaskInput => ({
  context: "shared",
  tasks: [{ name: " alpha ", task: "do a", tools: [] }, { task: "do b" }],
});
const canonical: TaskInput = {
  context: "shared",
  tasks: [{ name: "alpha", task: "do a", tools: [] }, { task: "do b" }],
};

test(
  "setTaskBatch replaces the genuine task tool in place, keeping order and activity",
  async () => {
    const a = countingTool("a");
    const b = countingTool("b");
    const ordinary = createTaskTool();
    const active = await newAgent([], {
      tools: [a.tool, ordinary, b.tool],
      activeToolNames: ["task", "a"],
    });
    const inactive = await newAgent([], {
      tools: [a.tool, createTaskTool(), b.tool],
      activeToolNames: ["b"],
    });
    try {
      await active.agent.setTaskBatch(batch());
      const tools = active.agent.getTools();
      const assigned = tools[1]!;
      assert.notEqual(assigned, ordinary);
      assert.equal(isAssignedTaskTool(assigned), true);
      assertTools(tools, [a.tool, assigned, b.tool]);
      assertTools(active.agent.getActiveTools(), [assigned, a.tool]);
      // Replacing a not-yet-admitted batch is allowed.
      await active.agent.setTaskBatch(batch());
      assert.notEqual(active.agent.getTools()[1], assigned);
      assert.equal(isAssignedTaskTool(active.agent.getTools()[1]!), true);

      await inactive.agent.setTaskBatch(batch());
      assert.equal(isAssignedTaskTool(inactive.agent.getTools()[1]!), true);
      assertTools(inactive.agent.getActiveTools(), [b.tool]);
    } finally {
      await Promise.all([active.agent.return(), inactive.agent.return()]);
    }
  },
  TIMEOUT,
);

test(
  "setTaskBatch rejects a missing or spoofed task tool, an invalid batch and a busy agent",
  async () => {
    const none = await newAgent([], { tools: [countingTool("a").tool] });
    const spoofed = await newAgent([], { tools: [countingTool("task").tool] });
    const { host } = recordingHost();
    const held = await newAgent(
      [
        toolTurn(taskCall("t1", { context: "c", tasks: [{ task: "x" }] })),
        fauxAssistantMessage("done"),
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    try {
      for (const { agent } of [none, spoofed])
        await assert.rejects(
          agent.setTaskBatch(batch()),
          isCode("invalid_state"),
        );
      const original = held.agent.getTools();
      for (const input of [
        { context: "c", tasks: [] },
        { context: " ", tasks: [{ task: "x" }] },
        { context: "c", tasks: [{ task: "x", extra: 1 }] },
      ])
        await assert.rejects(
          held.agent.setTaskBatch(input as TaskInput),
          isCode("invalid_argument"),
          JSON.stringify(input),
        );
      assert.deepEqual(held.agent.getTools(), original);

      const paused = await held.agent.runWithTaskHost(host, async () =>
        step(await held.agent.next()),
      );
      assert.equal(paused.kind, "yield");
      assert.equal(held.agent.status, "suspended");
      await assert.rejects(held.agent.setTaskBatch(batch()), isCode("busy"));
      assert.deepEqual(held.agent.getTools(), original);
      assert.equal(settledText(await held.agent.next()), "done");
    } finally {
      await Promise.all(
        [none, spoofed, held].map(({ agent }) => agent.return()),
      );
    }
  },
  TIMEOUT,
);

test(
  "an assigned batch launches its canonical input once: a rejection may be retried, a duplicate may not",
  async () => {
    const recorder = recordingHost();
    let refuse = true;
    let attempts = 0;
    const host: TaskToolHost = async (...args) => {
      attempts += 1;
      if (refuse) {
        refuse = false;
        throw new Error("allocation refused");
      }
      return recorder.host(...args);
    };
    const contexts: Context[] = [];
    const { agent } = await newAgent(
      [
        toolTurn(taskCall("t1", {})),
        toolTurn(taskCall("t2", {})),
        (context) => {
          contexts.push(context);
          return toolTurn(taskCall("t3", {}));
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("done");
        },
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    const input = batch();
    await agent.setTaskBatch(input);
    // The batch was copied: later caller mutation changes nothing.
    input.tasks[0]!.tools!.push("bash");
    (input.tasks as TaskInput["tasks"][number][]).push({ task: "late" });
    try {
      const paused = await agent.runWithTaskHost(host, async () =>
        step(await agent.next()),
      );
      assert.deepEqual(paused, {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "t2",
            toolName: "task",
            reason: "Scheduled 2 subagents",
          },
        ],
      });

      const settled = await agent.runWithTaskHost(host, () => agent.next());
      assert.equal(settledText(settled), "done");
      const rejected = toolResultOf(contexts[0]!.messages, "t1");
      assert.equal(rejected.isError, true);
      assert.match(blockText(rejected.content), /allocation refused/);
      assert.deepEqual(
        recorder.calls.map(({ toolCallId, input }) => [toolCallId, input]),
        [["t2", canonical]],
      );
      assert.deepEqual(toolResultOf(contexts[0]!.messages, "t2").details, {
        tasks: [{ id: "h-t2-0", name: "alpha" }, { id: "h-t2-1" }],
      });
      const duplicate = toolResultOf(contexts[1]!.messages, "t3");
      assert.equal(duplicate.isError, true);
      assert.equal(
        blockText(duplicate.content),
        "Task batch already admitted; wait for its results.",
      );
      assert.equal(attempts, 2);
      assert.equal(recorder.calls.length, 1);
      // An admitted batch cannot be replaced either, though the agent is idle again.
      assert.equal(agent.status, "idle");
      await assert.rejects(
        agent.setTaskBatch(batch()),
        isCode("invalid_state"),
      );
      assert.equal(isAssignedTaskTool(agent.getTools()[0]!), true);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "a fulfilled host with a malformed receipt still consumes the assigned batch",
  async () => {
    let calls = 0;
    const host: TaskToolHost = async () => {
      calls += 1;
      return [];
    };
    const contexts: Context[] = [];
    const { agent } = await newAgent(
      [
        toolTurn(taskCall("t1", {})),
        (context) => {
          contexts.push(context);
          return toolTurn(taskCall("t2", {}));
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("done");
        },
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    await agent.setTaskBatch(batch());
    try {
      const result = await agent.runWithTaskHost(host, () => agent.next());
      assert.equal(settledText(result), "done");
      const malformed = toolResultOf(contexts[0]!.messages, "t1");
      assert.equal(malformed.isError, true);
      assert.match(blockText(malformed.content), /0 handles for 2 tasks/);
      const duplicate = toolResultOf(contexts[1]!.messages, "t2");
      assert.equal(duplicate.isError, true);
      assert.match(blockText(duplicate.content), /already admitted/);
      assert.equal(calls, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "two launches in one assistant message are serialized: a held admission is never duplicated",
  async () => {
    // Task calls execute sequentially, so the second launch observes the first's outcome rather
    // than racing it; the in-progress guard is defensive and unreachable from one agent's run.
    const release = Promise.withResolvers<TaskToolDetails["tasks"]>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const host: TaskToolHost = () => {
      calls += 1;
      started.resolve();
      return release.promise;
    };
    const capture: { context?: Context } = {};
    const { agent } = await newAgent(
      [
        toolTurn(taskCall("first", {}), taskCall("second", {})),
        (context) => {
          capture.context = context;
          return fauxAssistantMessage("done");
        },
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    await agent.setTaskBatch(batch());
    try {
      const outcome = agent.runWithTaskHost(host, async () =>
        step(await agent.next()),
      );
      await started.promise;
      for (let index = 0; index < 5; index += 1) await tick();
      assert.equal(calls, 1);
      release.resolve([{ id: "a", name: "alpha" }, { id: "b" }]);
      assert.deepEqual(await outcome, {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "first",
            toolName: "task",
            reason: "Scheduled 2 subagents",
          },
        ],
      });
      assert.equal(settledText(await agent.next()), "done");
      const second = toolResultOf(capture.context!.messages, "second");
      assert.equal(second.isError, true);
      assert.match(blockText(second.content), /already admitted/);
      assert.equal(calls, 1);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "decisions bypass the launch guard and task policy; a retry pauses, an ignore does not",
  async () => {
    const { host, calls } = recordingHost();
    const launches: TaskInput[] = [];
    const { agent } = await newAgent(
      [
        toolTurn(taskCall("launch", {})),
        toolTurn(
          taskCall("retry", { action: "retry", id: "h-launch-0", attempt: 1 }),
          taskCall("ignore", {
            action: "ignore",
            id: "h-launch-1",
            attempt: 1,
          }),
        ),
        toolTurn(
          taskCall("ignore-again", {
            action: "ignore",
            id: "h-launch-0",
            attempt: 2,
          }),
        ),
        fauxAssistantMessage("done"),
      ],
      { tools: [createTaskTool()], prompt: "go" },
    );
    await agent.setTaskBatch(batch());
    agent.setTaskPolicy((input) => {
      launches.push(input);
    });
    try {
      const launched = await agent.runWithTaskHost(host, async () =>
        step(await agent.next()),
      );
      assert.equal(launched.kind, "yield");
      // Decisions are not launches: the policy now refuses everything, the batch is admitted.
      agent.setTaskPolicy(() => {
        throw new Error("no launches");
      });
      const retried = await agent.runWithTaskHost(host, async () =>
        step(await agent.next()),
      );
      assert.deepEqual(retried, {
        kind: "yield",
        reasons: [
          {
            kind: "tool",
            toolCallId: "retry",
            toolName: "task",
            reason: "Scheduled 1 subagents",
          },
        ],
      });
      // An ignore alone admits nothing, so the run continues to its answer without a pause.
      const settled = await agent.runWithTaskHost(host, () => agent.next());
      assert.equal(settledText(settled), "done");
      assert.deepEqual(launches, [canonical]);
      assert.deepEqual(
        calls.map(({ toolCallId, input }) => [toolCallId, input]),
        [
          ["launch", canonical],
          ["retry", { action: "retry", id: "h-launch-0", attempt: 1 }],
          ["ignore", { action: "ignore", id: "h-launch-1", attempt: 1 }],
          ["ignore-again", { action: "ignore", id: "h-launch-0", attempt: 2 }],
        ],
      );
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "independent agents admit their own assigned batches",
  async () => {
    const first = recordingHost("a");
    const second = recordingHost("b");
    const agents = await Promise.all(
      ["a", "b"].map(() =>
        newAgent([toolTurn(taskCall("go", {})), fauxAssistantMessage("done")], {
          tools: [createTaskTool()],
          prompt: "go",
        }),
      ),
    );
    try {
      for (const { agent } of agents) await agent.setTaskBatch(batch());
      const [a, b] = agents.map(({ agent }) => agent);
      assert.equal(
        (
          await a!.runWithTaskHost(first.host, async () =>
            step(await a!.next()),
          )
        ).kind,
        "yield",
      );
      assert.equal(settledText(await a!.next()), "done");
      // The first agent's admission does not consume the second's.
      assert.equal(
        (
          await b!.runWithTaskHost(second.host, async () =>
            step(await b!.next()),
          )
        ).kind,
        "yield",
      );
      assert.equal(settledText(await b!.next()), "done");
      assert.deepEqual(
        [first.calls, second.calls].map((calls) =>
          calls.map(({ input }) => input),
        ),
        [[canonical], [canonical]],
      );
    } finally {
      await Promise.all(agents.map(({ agent }) => agent.return()));
    }
  },
  TIMEOUT,
);

test("task failure policy defaults to zero retries and validates retry counts", async () => {
  const { agent } = await newAgent([], { tools: [createTaskTool()] });
  try {
    assert.deepEqual(agent.getTaskFailurePolicy(), { retries: 0 });
    for (const retries of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      assert.throws(
        () => agent.setTaskFailurePolicy({ retries }),
        (error: unknown) =>
          isCode("invalid_argument")(error) &&
          (error as Error).message ===
            "Task retries must be a nonnegative safe integer",
        String(retries),
      );
    assert.deepEqual(agent.getTaskFailurePolicy(), { retries: 0 });
    const policy = { retries: 3 };
    agent.setTaskFailurePolicy(policy);
    policy.retries = 7;
    const read = agent.getTaskFailurePolicy() as { retries: number };
    assert.deepEqual(read, { retries: 3 });
    read.retries = 9;
    assert.deepEqual(agent.getTaskFailurePolicy(), { retries: 3 });
    agent.setTaskFailurePolicy({ retries: Number.MAX_SAFE_INTEGER });
    agent.setTaskFailurePolicy({ retries: 0 });
    assert.deepEqual(agent.getTaskFailurePolicy(), { retries: 0 });
    agent.setTaskFailurePolicy("ignore");
    assert.equal(agent.getTaskFailurePolicy(), "ignore");
  } finally {
    await agent.return();
  }
});

// createSubagents ---------------------------------------------------------------------------------

/** One Models with two faux providers: `faux` (reasoning `main`, non-reasoning `plain`) and `faux2`. */
async function twoProviderParent(
  tools: AgentTool[],
  options: { activeToolNames?: string[] } = {},
) {
  const main = fauxProvider({
    api: "faux",
    provider: "faux",
    models: [
      { id: "main", reasoning: true },
      { id: "plain", reasoning: false },
    ],
    tokenSize: { min: 4, max: 4 },
  });
  const second = fauxProvider({
    api: "faux2",
    provider: "faux2",
    models: [{ id: "other", reasoning: true }],
    tokenSize: { min: 4, max: 4 },
  });
  const models = createModels();
  models.setProvider(main.provider);
  models.setProvider(second.provider);
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  const agent = await JuncoAgent.fromResolved({
    session,
    models,
    policy: "GitPolicy",
    model: main.getModel("main")!,
    thinkingLevel: "high",
    systemPrompt: "sys",
    tools,
    ...options,
  });
  return { agent, main, second };
}

test(
  "subagents inherit the current model, thinking level and active tools in fresh sessions",
  async () => {
    const a = countingTool("a");
    const b = countingTool("b");
    const c = countingTool("c");
    const { agent, main, second } = await twoProviderParent(
      [a.tool, b.tool, c.tool],
      { activeToolNames: ["a", "b"] },
    );
    // What each child's model request contains: its users' text and the outcome of its tool call.
    const seen: { users: string[]; toolFailed: boolean }[] = [];
    const capture = (callId: string, reply: string) => (context: Context) => {
      seen.push({
        users: userTexts(context.messages),
        toolFailed: toolResultOf(context.messages, callId).isError,
      });
      return fauxAssistantMessage(reply);
    };
    main.setResponses([fauxAssistantMessage("parent reply")]);
    const children: JuncoAgent[] = [];
    try {
      assert.equal(
        (await agent.prompt("parent secret transcript")).stopReason,
        "stop",
      );
      assert.equal(settledText(await agent.next()), "parent reply");
      // Configuration changed after construction is what children inherit.
      await agent.setActiveTools(["c", "b"]);
      await agent.setModel({ provider: "faux2", modelId: "other" });

      children.push(
        ...(await agent.createSubagents([
          {},
          { tools: ["b"] },
          { tools: [] },
          { model: { provider: "faux", modelId: "main" }, tools: ["c"] },
        ])),
      );
      const [inherit, narrowed, none, overridden] = children;
      assert.ok(inherit && narrowed && none && overridden);
      for (const child of children) {
        assert.notEqual(child, agent);
        assert.equal(child.status, "idle");
        assert.equal(await child.getThinkingLevel(), "high");
      }
      assert.equal((await inherit.getModel())?.provider, "faux2");
      assertTools(inherit.getActiveTools(), [c.tool, b.tool]);
      assertTools(inherit.getTools(), [c.tool, b.tool]);
      assertTools(narrowed.getTools(), [b.tool]);
      assertTools(none.getTools(), []);
      assertTools(none.getActiveTools(), []);
      assert.notEqual(none.getTools()[0], agent.getTools().at(-1));
      assert.equal((await overridden.getModel())?.id, "main");
      assertTools(overridden.getActiveTools(), [c.tool]);

      second.setResponses([
        toolTurn(fauxToolCall("c", {}, { id: "i1" })),
        capture("i1", "inherit reply"),
        toolTurn(fauxToolCall("c", {}, { id: "n1" })),
        capture("n1", "none reply"),
      ]);
      main.setResponses([
        toolTurn(fauxToolCall("b", {}, { id: "o1" })),
        capture("o1", "override reply"),
      ]);
      const mainCalls = main.state.callCount;
      await inherit.prompt("child one");
      assert.equal(settledText(await inherit.next()), "inherit reply");
      await none.prompt("child none");
      assert.equal(settledText(await none.next()), "none reply");
      await overridden.prompt("child override");
      assert.equal(settledText(await overridden.next()), "override reply");
      assert.equal(second.state.callCount, 4);
      assert.equal(main.state.callCount, mainCalls + 2);
      // Only the inheriting child could execute c; `[]` and the narrowed subset cannot reach it or b.
      assert.deepEqual(seen, [
        { users: ["child one"], toolFailed: false },
        { users: ["child none"], toolFailed: true },
        { users: ["child override"], toolFailed: true },
      ]);
      assert.equal(c.state.executions, 1);
      assert.equal(b.state.executions, 0);
    } finally {
      await Promise.all([
        agent.return(),
        ...children.map((child) => child.return()),
      ]);
    }
  },
  TIMEOUT,
);

test(
  "an invalid entry anywhere in a batch fails before any child exists",
  async () => {
    const a = countingTool("a");
    const b = countingTool("b");
    const { agent } = await twoProviderParent([a.tool, b.tool], {
      activeToolNames: ["a"],
    });
    const spy = spySessions();
    try {
      await assert.rejects(
        agent.createSubagents([
          {},
          { model: { provider: "faux", modelId: "missing" } },
        ]),
        (error: unknown) =>
          isCode("invalid_argument")(error) &&
          error instanceof Error &&
          error.message === "Model not found: faux/missing",
      );
      await assert.rejects(
        agent.createSubagents([{}, { tools: ["b"] }]),
        isCode("invalid_argument"),
      );
      await assert.rejects(
        agent.createSubagents([{}, { tools: ["a", "a"] }]),
        isCode("invalid_argument"),
      );
      // Inherited thinking level "high" is unsupported by the non-reasoning model.
      await assert.rejects(
        agent.createSubagents([
          {},
          { model: { provider: "faux", modelId: "plain" } },
        ]),
        isCode("invalid_argument"),
      );
      const aborted = new AbortController();
      const reason = new Error("stopped");
      aborted.abort(reason);
      await assert.rejects(
        agent.createSubagents([{}], aborted.signal),
        (error) => error === reason,
      );
      assert.equal(spy.sessions.length, 0);
      assert.deepEqual(await agent.createSubagents([]), []);
      assert.equal(spy.sessions.length, 0);
      assert.equal(agent.status, "idle");
    } finally {
      spy.restore();
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "missing or failing credentials fail preflight with invalid_state and no child",
  async () => {
    const { models, model } = scripted([]);
    const failure = new Error("credential store unavailable");
    let auth: () => Promise<unknown> = async () => undefined;
    // The parent's Models, except credential lookup follows `auth`.
    const withAuth = new Proxy(models, {
      get(target, property) {
        if (property === "getAuth") return () => auth();
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const session = await new MemorySessionRepo().create(
      {},
      BACKGROUND_CONTEXT,
    );
    const parent = await JuncoAgent.fromResolved({
      session,
      models: withAuth,
      policy: "GitPolicy",
      model,
    });
    const spy = spySessions();
    const label = `${model.provider}/${model.id}`;
    try {
      await assert.rejects(
        parent.createSubagents([{}]),
        (error: unknown) =>
          isCode("invalid_state")(error) &&
          error instanceof Error &&
          error.message === `No usable credentials for ${label}`,
      );
      auth = async () => {
        throw failure;
      };
      await assert.rejects(
        parent.createSubagents([{}]),
        (error: unknown) =>
          isCode("invalid_state")(error) &&
          error instanceof Error &&
          error.message === `No usable credentials for ${label}` &&
          error.cause === failure,
      );
      assert.equal(spy.sessions.length, 0);
    } finally {
      spy.restore();
      await parent.return();
    }
  },
  TIMEOUT,
);

test(
  "an abort after the first child is acquired closes every created child and keeps the parent",
  async () => {
    const a = countingTool("a");
    const { agent, main } = await twoProviderParent([a.tool]);
    const controller = new AbortController();
    const reason = new Error("abort during acquisition");
    // Abort as the second child's session is acquired: the first child is complete by then.
    const spy = spySessions((count) => {
      if (count === 2) controller.abort(reason);
    });
    try {
      await assert.rejects(
        agent.createSubagents([{}, {}, {}], controller.signal),
        (error) => error === reason,
      );
      assert.equal(spy.sessions.length, 2);
      for (const session of spy.sessions)
        assert.equal(await isClosed(session), true);
      spy.restore();
      main.setResponses([fauxAssistantMessage("parent still works")]);
      await agent.prompt("after");
      assert.equal(settledText(await agent.next()), "parent still works");
    } finally {
      spy.restore();
      await agent.return();
    }
  },
  TIMEOUT,
);

test(
  "a child outlives its closed parent and keeps using caller-owned tools",
  async () => {
    const owned = countingTool("owned");
    const { agent, main } = await twoProviderParent([owned.tool]);
    const [child] = await agent.createSubagents([{}]);
    assert.ok(child);
    try {
      await agent.return();
      assert.equal(agent.status, "closed");
      assert.equal(child.status, "idle");
      main.setResponses([
        toolTurn(fauxToolCall("owned", {}, { id: "o1" })),
        fauxAssistantMessage("child finished"),
      ]);
      await child.prompt("use the tool");
      assert.equal(settledText(await child.next()), "child finished");
      assert.equal(owned.state.executions, 1);
      await child.return();
      assert.equal(child.status, "closed");
      // The externally owned tool is still the caller's and still works.
      await owned.tool.execute("direct", {});
      assert.equal(owned.state.executions, 2);
    } finally {
      await Promise.all([agent.return(), child.return()]);
    }
  },
  TIMEOUT,
);

test(
  "children get a fresh ordinary task tool, not the parent's assigned batch or policies",
  async () => {
    const a = countingTool("a");
    const { agent, main } = await twoProviderParent([createTaskTool(), a.tool]);
    await agent.setTaskBatch(batch());
    agent.setTaskFailurePolicy("ignore");
    agent.setTaskPolicy(() => {
      throw new Error("parent policy");
    });
    const assigned = agent.getTools()[0]!;
    const [child] = await agent.createSubagents([{}]);
    assert.ok(child);
    const { host, calls } = recordingHost();
    const contexts: Context[] = [];
    try {
      const fresh = child.getTools()[0]!;
      assert.notEqual(fresh, assigned);
      assert.equal(isTaskTool(fresh), true);
      assert.equal(isAssignedTaskTool(fresh), false);
      assertTools(child.getActiveTools(), [fresh, a.tool]);
      assert.deepEqual(child.getTaskFailurePolicy(), { retries: 0 });

      // `{}` is no launch for an ordinary tool; a full launch skips the parent's policy.
      main.setResponses([
        toolTurn(taskCall("empty", {})),
        (context) => {
          contexts.push(context);
          return toolTurn(
            taskCall("own", { context: "c", tasks: [{ task: "x" }] }),
          );
        },
        fauxAssistantMessage("child done"),
      ]);
      const paused = await child.runWithTaskHost(host, async () => {
        void child.prompt("delegate");
        return step(await child.next());
      });
      assert.equal(paused.kind, "yield");
      assert.equal(settledText(await child.next()), "child done");
      assert.equal(toolResultOf(contexts[0]!.messages, "empty").isError, true);
      assert.deepEqual(calls, [
        { toolCallId: "own", input: { context: "c", tasks: [{ task: "x" }] } },
      ]);
      // The child's own batch is independent of the parent's (still unadmitted) one.
      await child.setTaskBatch(batch());
      assert.equal(agent.getTools()[0], assigned);
    } finally {
      await Promise.all([agent.return(), child.return()]);
    }
  },
  TIMEOUT,
);

test(
  "a subagent observer gates acquisition, sees each child first, and is not inherited",
  async () => {
    const a = countingTool("a");
    const { agent, main } = await twoProviderParent([a.tool]);
    const refused = new Error("acquisition refused");
    const rejected = new Error("child refused");
    const seen: { child: JuncoAgent; index: number; status: string }[] = [];
    let requests: unknown[] = [];
    let refuseAt: number | undefined;
    agent.setSubagentObserver({
      acquiring: (options) => {
        requests = [...options];
        if (options.length === 3) throw refused;
      },
      acquired: (child, index) => {
        seen.push({ child, index, status: child.status });
        if (index === refuseAt) throw rejected;
        // Attached before anything runs the child.
        child.hooks.on("before_tool", () => ({
          block: { reason: "observed" },
        }));
      },
    });
    const spy = spySessions();
    const children: JuncoAgent[] = [];
    try {
      // Throwing from `acquiring` creates nothing.
      await assert.rejects(
        agent.createSubagents([{}, {}, { tools: [] }]),
        (error) => error === refused,
      );
      assert.equal(requests.length, 3);
      assert.equal(spy.sessions.length, 0);
      assert.equal(seen.length, 0);

      // Throwing from `acquired` closes every child the batch created.
      refuseAt = 1;
      await assert.rejects(
        agent.createSubagents([{}, {}]),
        (error) => error === rejected,
      );
      assert.deepEqual(
        seen.map(({ index }) => index),
        [0, 1],
      );
      assert.equal(spy.sessions.length, 2);
      for (const session of spy.sessions)
        assert.equal(await isClosed(session), true);
      for (const { child } of seen) assert.equal(child.status, "closed");

      // Each child is seen unstarted, in batch order, before the caller receives it.
      refuseAt = undefined;
      seen.length = 0;
      children.push(...(await agent.createSubagents([{}, { tools: ["a"] }])));
      assert.deepEqual(
        seen.map(({ child, index, status }) => [child, index, status]),
        [
          [children[0], 0, "idle"],
          [children[1], 1, "idle"],
        ],
      );
      main.setResponses([
        toolTurn(fauxToolCall("a", {}, { id: "blocked" })),
        fauxAssistantMessage("child done"),
      ]);
      await children[1]!.prompt("use a");
      assert.equal(settledText(await children[1]!.next()), "child done");
      assert.equal(a.state.executions, 0);

      // Children do not inherit the observer; `undefined` removes it from the parent.
      seen.length = 0;
      children.push(...(await children[0]!.createSubagents([{}])));
      assert.equal(seen.length, 0);
      agent.setSubagentObserver(undefined);
      children.push(...(await agent.createSubagents([{}, {}, {}])));
      assert.equal(seen.length, 0);
    } finally {
      spy.restore();
      await Promise.all([
        agent.return(),
        ...children.map((child) => child.return()),
      ]);
    }
  },
  TIMEOUT,
);
