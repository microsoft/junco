import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const nonBlank = (description: string) =>
  Type.String({ pattern: "\\S", description });

const taskParameters = Type.Object(
  {
    context: nonBlank(
      "Shared background prepended to every task's instructions.",
    ),
    tasks: Type.Array(
      Type.Object(
        {
          name: Type.Optional(nonBlank("Display label; not an identity.")),
          task: nonBlank("Complete instructions for this subagent."),
          model: Type.Optional(
            Type.Object(
              {
                provider: nonBlank("Registered provider."),
                modelId: nonBlank("Model ID within that provider."),
              },
              { additionalProperties: false },
            ),
          ),
          tools: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Subset of your active tool names; [] leaves only the always-on complain tool.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

/** Details of an admitted `task` call: one ordered handle per requested subagent. */
export type TaskToolDetails = {
  readonly tasks: readonly { readonly id: string; readonly name?: string }[];
};

/**
 * Admits a validated task batch, returning one opaque handle per task in input order. It must not
 * wait for the subagents to run; their reports arrive later.
 */
export type TaskToolHost = (
  toolCallId: string,
  input: Static<typeof taskParameters>,
  signal: AbortSignal,
) => Promise<TaskToolDetails["tasks"]>;

type TaskTool = AgentTool<typeof taskParameters, TaskToolDetails>;

/** Tools this module created. Only these are graph primitives; a same-named or copied tool is not. */
const taskTools = new WeakSet<object>();

/** Shared by executions that receive no abort signal. */
const neverAborted = new AbortController().signal;

/**
 * A fresh `task` tool. Executing it admits subagents through `host`, or through the host a
 * `JuncoAgent` scopes to a graph activation; without either it fails rather than pretend success.
 */
export function createTaskTool(host?: TaskToolHost): TaskTool {
  const tool: TaskTool = {
    name: "task",
    label: "task",
    description:
      "Start one or more subagents. Each runs in a fresh session with only the instructions you " +
      "give it (plus the shared context prepended to each), so be complete. This returns one handle per task " +
      "immediately; keep working. Each subagent's final report later arrives as a message " +
      "carrying its handle ID. Optionally choose a registered model ({ provider, modelId }) or a " +
      "subset of your active tool names per task; omitted values inherit yours.",
    parameters: taskParameters,
    executionMode: "sequential",
    execute: (toolCallId, input, signal) => {
      if (!host) throw new Error("task requires an agentNode graph host");
      return admit(host, toolCallId, input, signal);
    },
  };
  taskTools.add(tool);
  return tool;
}

/** Whether `tool` is a `task` tool created by {@link createTaskTool}. */
export function isTaskTool(tool: object): tool is TaskTool {
  return taskTools.has(tool);
}

/** Executes a {@link createTaskTool} tool through `host`, ignoring any host it was created with. */
export function invokeTaskTool(
  tool: TaskTool,
  host: TaskToolHost,
  toolCallId: string,
  input: Static<typeof taskParameters>,
  signal: AbortSignal,
): Promise<AgentToolResult<TaskToolDetails>> {
  if (!isTaskTool(tool))
    throw new TypeError("Not a task tool created by createTaskTool");
  return admit(host, toolCallId, input, signal);
}

async function admit(
  host: TaskToolHost,
  toolCallId: string,
  input: Static<typeof taskParameters>,
  signal: AbortSignal = neverAborted,
): Promise<AgentToolResult<TaskToolDetails>> {
  if (!Value.Check(taskParameters, input)) {
    const [error] = Value.Errors(taskParameters, input);
    throw new Error(
      `Invalid task input${error ? `: ${error.instancePath} ${error.message}` : ""}`,
    );
  }
  signal.throwIfAborted();
  // A detached snapshot: later caller mutation cannot change what the host admitted.
  const snapshot: Static<typeof taskParameters> = {
    context: input.context,
    tasks: input.tasks.map((item) => ({
      ...(item.name === undefined ? {} : { name: item.name.trim() }),
      task: item.task,
      ...(item.model === undefined
        ? {}
        : {
            model: {
              provider: item.model.provider,
              modelId: item.model.modelId,
            },
          }),
      ...(item.tools === undefined ? {} : { tools: [...item.tools] }),
    })),
  };
  const handles = await host(toolCallId, snapshot, signal);
  if (handles.length !== snapshot.tasks.length) {
    throw new Error(
      `task host returned ${handles.length} handles for ${snapshot.tasks.length} tasks`,
    );
  }
  const tasks = handles.map(({ id, name }) =>
    name === undefined ? { id } : { id, name },
  );
  return {
    content: [
      {
        type: "text",
        text:
          `Scheduled ${tasks.length} subagent${tasks.length === 1 ? "" : "s"}; their reports ` +
          `arrive later as messages carrying these IDs.\n${JSON.stringify({ tasks })}`,
      },
    ],
    details: { tasks },
  };
}
