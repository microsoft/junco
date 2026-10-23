import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { checkToolInput } from "./tool-support.js";

const nonBlank = (description: string) =>
  Type.String({ pattern: "\\S", description });

const launchSchema = Type.Object(
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

const decisionFields = {
  action: Type.Union([Type.Literal("retry"), Type.Literal("ignore")], {
    description:
      "For a failed task report marked decisionRequired: run it once more, or give it up.",
  }),
  id: nonBlank("Handle ID of the failed task awaiting your decision."),
  attempt: Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    description: "The attempt number of that failed report.",
  }),
};
const decisionSchema = Type.Object(decisionFields, {
  additionalProperties: false,
});
const triggerSchema = Type.Object({}, { additionalProperties: false });

const optionalDecision = {
  action: Type.Optional(decisionFields.action),
  id: Type.Optional(decisionFields.id),
  attempt: Type.Optional(decisionFields.attempt),
};
// Model-facing schemas stay one object (providers reject top-level unions); calls are checked
// against the exact launch, trigger or decision shape before any host sees them.
const taskParameters = Type.Object(
  {
    context: Type.Optional(launchSchema.properties.context),
    tasks: Type.Optional(launchSchema.properties.tasks),
    ...optionalDecision,
  },
  { additionalProperties: false },
);
const assignedParameters = Type.Object(optionalDecision, {
  additionalProperties: false,
});

/** A validated `task` launch: shared context and one entry per requested subagent. */
export type TaskInput = Static<typeof launchSchema>;

/** The caller's decision about one failed task whose report asked for it. */
export type TaskDecision = {
  readonly action: "retry" | "ignore";
  readonly id: string;
  readonly attempt: number;
};

/** What a host receives: a detached launch, or a decision about a failed task. */
export type TaskRequest = TaskInput | TaskDecision;

/** What a task tool accepts: a request, or `{}` launching an assigned tool's stored batch. */
export type TaskCall = TaskRequest | Readonly<Record<string, never>>;

/** Details of an admitted `task` call: one ordered handle per scheduled subagent. */
export type TaskToolDetails = {
  readonly tasks: readonly { readonly id: string; readonly name?: string }[];
};

/**
 * Performs a validated request without waiting for any subagent to run; reports arrive later. A
 * launch returns one handle per task in input order, a retry the retried task's one handle, an
 * ignore none. Rejection must mean nothing was admitted.
 */
export type TaskToolHost = (
  toolCallId: string,
  input: TaskRequest,
  signal: AbortSignal,
) => Promise<TaskToolDetails["tasks"]>;

/** Tools this module created. Only these are graph primitives; a same-named or copied tool is not. */
const taskTools = new WeakSet<object>();
/** The detached batch of each assigned tool, kept off its model-facing schema. */
const assignedInputs = new WeakMap<object, TaskInput>();

/** Shared by executions that receive no abort signal. */
const neverAborted = new AbortController().signal;

const DECISION_HELP =
  'A failed report marked decisionRequired waits for you: call task({ action: "retry" | ' +
  '"ignore", id, attempt }) with its handle ID and attempt before finishing.';
const START_HELP =
  "Subagents start when you explicitly call yield or finish your current run; call yield when " +
  "you need their reports before continuing.";

/** A free-form `task` tool: the model supplies the whole batch. */
export type TaskTool = AgentTool<typeof taskParameters, TaskToolDetails>;

/** A `task` tool launching one stored batch: the model only sends `{}`. */
export type AssignedTaskTool = AgentTool<
  typeof assignedParameters,
  TaskToolDetails
>;

/**
 * Constructs a fresh {@link TaskTool}. Executing it admits subagents through `host`, or through
 * the host a `JuncoAgent` scopes to a graph activation; without either it fails rather than
 * pretend success.
 */
export const TaskTool: new (host?: TaskToolHost) => TaskTool = class {
  name = "task";
  label = "task";
  description =
    "Start one or more subagents. Each runs in a fresh session with only the instructions you " +
    "give it (plus the shared context prepended to each), so be complete. This returns one handle per task " +
    "immediately. Each subagent's final report later arrives as a message carrying its handle ID. " +
    `${START_HELP} Optionally choose a registered model ({ provider, modelId }) or a ` +
    `subset of your active tool names per task; omitted values inherit yours. ${DECISION_HELP}`;
  parameters = taskParameters;
  executionMode: TaskTool["executionMode"] = "sequential";
  execute: TaskTool["execute"];

  constructor(host?: TaskToolHost) {
    this.execute = (toolCallId, input, signal) => {
      if (!host) throw new Error("task requires a JuncoGraph host");
      return admit(this, host, toolCallId, input, signal);
    };
    taskTools.add(this);
  }
};

/**
 * Constructs an {@link AssignedTaskTool} whose launch is the validated, detached `input`: the
 * model calls it with `{}`, and may also send decisions about failed tasks. It has no host of its
 * own.
 */
export const AssignedTaskTool: new (input: TaskInput) => AssignedTaskTool =
  class {
    name = "task";
    label = "task";
    description: string;
    parameters = assignedParameters;
    executionMode: AssignedTaskTool["executionMode"] = "sequential";
    execute: AssignedTaskTool["execute"] = () => {
      throw new Error("task requires a JuncoGraph host");
    };

    constructor(input: TaskInput) {
      const batch = detach(checkToolInput("task", launchSchema, input));
      const count = batch.tasks.length;
      this.description =
        `Start your ${count} assigned subagent${count === 1 ? "" : "s"}: call task({}) once; the ` +
        "assignments are fixed. This returns one handle per task immediately; each subagent's " +
        `final report later arrives as a message carrying its handle ID. ${START_HELP} ${DECISION_HELP}`;
      taskTools.add(this);
      assignedInputs.set(this, batch);
    }
  };

/** Whether `tool` is a `task` tool constructed by {@link TaskTool} or {@link AssignedTaskTool}. */
export function isTaskTool(tool: object): tool is TaskTool | AssignedTaskTool {
  return taskTools.has(tool);
}

/** Whether `tool` is a `task` tool constructed by {@link AssignedTaskTool}. */
export function isAssignedTaskTool(tool: object): tool is AssignedTaskTool {
  return assignedInputs.has(tool);
}

/** Executes a genuine task tool through `host`, ignoring any host it was created with. */
export function invokeTaskTool(
  tool: TaskTool | AssignedTaskTool,
  host: TaskToolHost,
  toolCallId: string,
  input: TaskCall,
  signal: AbortSignal,
): Promise<AgentToolResult<TaskToolDetails>> {
  if (!isTaskTool(tool))
    throw new TypeError("Not a task tool constructed by TaskTool");
  return admit(tool, host, toolCallId, input, signal);
}

/** A detached snapshot: later caller mutation cannot change what a host admits. */
function detach(input: TaskInput): TaskInput {
  return {
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
}

/** The request `input` makes of `tool`'s host. */
function requestOf(tool: object, input: unknown): TaskRequest {
  if (typeof input === "object" && input !== null && "action" in input) {
    const { action, id, attempt } = checkToolInput(
      "task",
      decisionSchema,
      input,
    );
    return { action, id, attempt };
  }
  const assigned = assignedInputs.get(tool);
  if (assigned === undefined)
    return detach(checkToolInput("task", launchSchema, input));
  checkToolInput("task", triggerSchema, input);
  return detach(assigned);
}

async function admit(
  tool: object,
  host: TaskToolHost,
  toolCallId: string,
  input: unknown,
  signal: AbortSignal = neverAborted,
): Promise<AgentToolResult<TaskToolDetails>> {
  const request = requestOf(tool, input);
  signal.throwIfAborted();
  const handles = await host(toolCallId, request, signal);
  const tasks = handles.map(({ id, name }) =>
    name === undefined ? { id } : { id, name },
  );
  let text: string;
  if (!("action" in request)) {
    if (tasks.length !== request.tasks.length)
      throw new Error(
        `task host returned ${tasks.length} handles for ${request.tasks.length} tasks`,
      );
    text =
      `Scheduled ${tasks.length} subagent${tasks.length === 1 ? "" : "s"}; their reports ` +
      `arrive later as messages carrying these IDs. ${START_HELP}\n${JSON.stringify({ tasks })}`;
  } else if (request.action === "retry") {
    if (tasks.length !== 1 || tasks[0]?.id !== request.id)
      throw new Error(
        `task host returned ${JSON.stringify(tasks)} for a retry of ${request.id}`,
      );
    text =
      `Retrying task ${request.id}; its report arrives later as a message carrying this ID. ` +
      `${START_HELP}\n${JSON.stringify({ tasks })}`;
  } else {
    if (tasks.length !== 0)
      throw new Error(`task host returned handles for ignoring ${request.id}`);
    text = `Ignored task ${request.id}.`;
  }
  return { content: [{ type: "text", text }], details: { tasks } };
}
