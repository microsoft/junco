import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import { checkToolInput } from "./tool-support.js";

type Recorder =
  | ProfileRecorder<"operations">
  | (() => ProfileRecorder<"operations"> | undefined);

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
            Type.Array(nonBlank("Tool name."), {
              uniqueItems: true,
              description:
                "Additional tool names to inherit; defaults remain unless blocked. [] selects no additions.",
            }),
          ),
          tool_block: Type.Optional(
            Type.Array(nonBlank("Tool name."), {
              uniqueItems: true,
              description:
                "Tool names to exclude; extends the parent block. Must not overlap tools.",
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

/**
 * Tools this module constructed, with their recorders and constructor-supplied hosts. Only these
 * are task primitives; a same-named, copied or prototype-forged tool is not.
 */
const taskTools = new WeakMap<
  object,
  { readonly recorder?: Recorder; readonly host?: TaskToolHost }
>();

/** Shared by executions that receive no abort signal. */
const neverAborted = new AbortController().signal;

const DECISION_HELP =
  'A failed report marked decisionRequired waits for you: call task({ action: "retry" | ' +
  '"ignore", id, attempt }) with its handle ID and attempt before finishing.';
const START_HELP =
  "Subagents start immediately in the background; you can continue working while their reports arrive.";

/** What both `task` variants share; each supplies only how a call without `action` launches. */
abstract class TaskToolBase<P extends TSchema>
  implements AgentTool<P, TaskToolDetails>
{
  readonly name = "task";
  readonly label = "task";
  abstract readonly description: string;
  abstract readonly parameters: P;
  readonly executionMode = "sequential";
  /**
   * Accepts input as a model or caller supplies it, keeping both variants assignable to
   * `AgentTool`, whose `execute` receives unchecked parameters; {@link invoke} validates it.
   */
  readonly execute: (
    toolCallId: string,
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<TaskToolDetails>>;

  constructor(host?: TaskToolHost, recorder?: Recorder) {
    this.execute = (toolCallId, input, signal) => {
      if (!host) throw new Error("task requires a host");
      return this.invoke(
        host,
        toolCallId,
        input as TaskCall,
        signal ?? neverAborted,
      );
    };
    taskTools.set(this, { recorder, host });
    markProfileOwned(this, (args) => this.#operation(args));
  }

  /** The host this tool was constructed with; copies gain no authority. */
  get host(): TaskToolHost | undefined {
    return taskTools.get(this)?.host;
  }

  /** Executes this genuine task tool through `host`, ignoring any host it was created with. */
  invoke(
    host: TaskToolHost,
    toolCallId: string,
    input: TaskCall,
    signal: AbortSignal,
  ): Promise<AgentToolResult<TaskToolDetails>> {
    const binding = taskTools.get(this);
    if (binding === undefined)
      throw new TypeError("Not a task tool constructed by TaskTool");
    return profileToolCall(
      captureRecorder(binding.recorder),
      this.#operation(input),
      signal,
      async () => {
        const request = this.#request(input);
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
            throw new Error(
              `task host returned handles for ignoring ${request.id}`,
            );
          text = `Ignored task ${request.id}.`;
        }
        return { content: [{ type: "text", text }], details: { tasks } };
      },
      ({ details }) => ({
        counters: { handles_returned: details.tasks.length },
      }),
    );
  }

  /** The validated launch a call without `action` makes. */
  protected abstract launch(input: unknown): TaskInput;

  /** A detached snapshot: later caller mutation cannot change what a host admits. */
  protected snapshot(input: TaskInput): TaskInput {
    return {
      context: input.context,
      tasks: input.tasks.map((item, index) => {
        const toolBlock =
          item.tool_block === undefined ? undefined : [...item.tool_block];
        if (
          toolBlock !== undefined &&
          item.tools?.some((name) => toolBlock.includes(name))
        ) {
          const name = item.tools.find((candidate) =>
            toolBlock.includes(candidate),
          );
          throw new Error(
            `task: tasks[${index}].tools and tool_block both list "${name}"; remove it from either list`,
          );
        }
        return {
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
          ...(toolBlock === undefined ? {} : { tool_block: toolBlock }),
        };
      }),
    };
  }

  /** The request `input` makes of the host. */
  #request(input: unknown): TaskRequest {
    if (typeof input === "object" && input !== null && "action" in input) {
      const { action, id, attempt } = checkToolInput(
        "task",
        decisionSchema,
        input,
      );
      return { action, id, attempt };
    }
    return this.snapshot(this.launch(input));
  }

  /** The bounded labels of a call with raw `args`, following {@link #request}'s decoding. */
  #operation(args: unknown) {
    const operation =
      typeof args !== "object" || args === null
        ? "invalid"
        : "action" in args
          ? args.action === "retry" || args.action === "ignore"
            ? args.action
            : "invalid"
          : this instanceof AssignedTaskTool
            ? "assigned"
            : "launch";
    return {
      resource: "operations",
      category: "task",
      tool: "task",
      operation,
    } as const;
  }
}

/**
 * A free-form `task` tool: the model supplies the whole batch. Executing it admits subagents
 * through `host`, or through the native host of the `JuncoAgent` running it; without either it
 * fails rather than pretend success.
 */
export class TaskTool extends TaskToolBase<typeof taskParameters> {
  readonly description =
    "Start one or more subagents. Each runs in a fresh session with only the instructions you " +
    "give it (plus the shared context prepended to each), so be complete. This returns one handle per task " +
    "immediately. Each subagent's final report later arrives as a message carrying its handle ID. " +
    `${START_HELP} Optionally choose a registered model ({ provider, modelId }), additional inherited ` +
    `tool names, or further exclusions in tool_block per task. ${DECISION_HELP}`;
  readonly parameters = taskParameters;

  /** Whether {@link TaskTool} or {@link AssignedTaskTool} built `tool`; copies are not task tools. */
  static is(tool: object): tool is TaskTool | AssignedTaskTool {
    return taskTools.has(tool);
  }

  protected launch(input: unknown): TaskInput {
    return checkToolInput("task", launchSchema, input);
  }
}

/**
 * A `task` tool launching one validated, detached batch: the model calls it with `{}`, and may
 * also send decisions about failed tasks. It admits through `host`, or through the native host of
 * the `JuncoAgent` running it.
 */
export class AssignedTaskTool extends TaskToolBase<typeof assignedParameters> {
  readonly description: string;
  readonly parameters = assignedParameters;
  /** The stored batch, kept off the model-facing schema. */
  readonly #batch: TaskInput;

  constructor(input: TaskInput, host?: TaskToolHost, recorder?: Recorder) {
    super(host, recorder);
    this.#batch = this.snapshot(checkToolInput("task", launchSchema, input));
    const count = this.#batch.tasks.length;
    this.description =
      `Start your ${count} assigned subagent${count === 1 ? "" : "s"}: call task({}) once; the ` +
      "assignments are fixed. This returns one handle per task immediately; each subagent's " +
      `final report later arrives as a message carrying its handle ID. ${START_HELP} ${DECISION_HELP}`;
  }

  /** Whether {@link AssignedTaskTool} built `tool`; copies and forgeries are not. */
  static is(tool: object): tool is AssignedTaskTool {
    return taskTools.has(tool) && tool instanceof AssignedTaskTool;
  }

  protected launch(input: unknown): TaskInput {
    checkToolInput("task", triggerSchema, input);
    return this.#batch;
  }
}
