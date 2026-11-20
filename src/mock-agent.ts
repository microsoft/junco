import { isDeepStrictEqual } from "node:util";
import {
  type AgentHarnessResources,
  type AgentHarnessStreamOptions,
  type AgentMessage,
  type AgentTool,
  BACKGROUND_CONTEXT,
  type Context,
  estimateTokens,
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  type HarnessEvent,
  type HookInvocation,
  type HookMap,
  type HookName,
  type ModelIdentity,
  type NavigationResult,
  type PromptTemplate,
  type QueueMode,
  type Skill,
  type ThinkingLevel,
  withCancel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
} from "@earendil-works/pi-ai";
import {
  bytes,
  constantProfile,
  type ParentView,
  type ProfileSet,
  type ResourceQuantity,
  tokens,
} from "dataflow-engine";
import {
  type AgenticOptions,
  type AgenticStatus,
  type AgenticStep,
  type ErrorHandler,
  JuncoAgentError,
  type Agentic as JuncoAgentProtocol,
  resolveStagedPrompt,
  type TaskSchema,
  validateActiveTools,
} from "junco-agent";
import { type Issue, issueLog, trackPromise } from "junco-tools";
import type { TSchema } from "typebox";

// An Agentic replaying a constant transcript: no provider, harness, tool or session is involved.
// Hook outcomes and maintenance results come from typed records; the iterator, admission, queue,
// cancellation and close semantics follow JuncoAgent's.

/** A run's last boundary: its settlement or failure. */
export type MockTerminal = Exclude<AgenticStep, { kind: "yield" }>;

/** One scripted hook invocation, with the results its registered handlers must return in order. */
export type MockHook = {
  [K in HookName]: {
    readonly name: K;
    readonly event: HookInvocation<K>;
    readonly results: readonly HookMap[K]["result"][];
  };
}[HookName];

/** One scripted request of a run, ending at boundary `step`. */
export type MockFrame<B extends AgenticStep = AgenticStep> = {
  readonly step: B;
  /** Queues drained, in this order, before the request. */
  readonly drain?: readonly ("steer" | "followUp")[];
  readonly hooks?: readonly MockHook[];
  /** Appended to the history after the request snapshot; a settled terminal follows them. */
  readonly messages?: readonly AgentMessage[];
  /** Delivered in order before the boundary is published. */
  readonly events?: readonly HarnessEvent[];
};

/** One admitted run: zero or more yields then exactly one terminal, and its cancellation outcome. */
export type MockRun = {
  readonly frames: readonly MockFrame[];
  readonly interrupted: Omit<MockFrame<MockTerminal>, "drain" | "hooks">;
};

/** One scripted `compact` (its queued outcome) or `navigateTree` call (its native result). */
export type MockMaintenance =
  | {
      readonly method: "compact";
      readonly args: Parameters<JuncoAgentProtocol["compact"]>;
      readonly result:
        | { readonly ok: true }
        | { readonly ok: false; readonly error: unknown };
      readonly history?: readonly AgentMessage[];
      readonly tipId?: string | null;
    }
  | {
      readonly method: "navigateTree";
      readonly args: Parameters<JuncoAgentProtocol["navigateTree"]>;
      readonly result: NavigationResult;
      readonly history?: readonly AgentMessage[];
      readonly tipId?: string | null;
    };

/** Everything a {@link MockAgent} will do, fixed at construction. */
export type MockTranscript<
  S extends Skill,
  P extends PromptTemplate,
  T extends AgentTool,
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> = {
  readonly prompt?: AgenticOptions<S, P, T, N, V>["prompt"];
  readonly errorHandler?: ErrorHandler<N, V>;
  readonly images?: ImageContent[];
  readonly history?: readonly AgentMessage[];
  readonly models?: readonly Model<Api>[];
  readonly model?: ModelIdentity;
  readonly tools?: readonly T[];
  readonly activeToolNames?: readonly string[];
  readonly resources?: AgentHarnessResources<S, P>;
  /** Constant resource usage this agent exhibits; see {@link MockAgent.profiles}. */
  readonly usage?: MockUsage;
  readonly thinkingLevel?: ThinkingLevel;
  readonly streamOptions?: AgentHarnessStreamOptions;
  readonly steeringMode?: QueueMode;
  readonly followUpMode?: QueueMode;
  readonly runs: readonly MockRun[];
  readonly maintenance?: readonly MockMaintenance[];
};

/** What one frame's request would have sent, captured after its queue drains and hooks. */
export type MockRequest<T extends AgentTool> = {
  readonly messages: readonly AgentMessage[];
  readonly model: Model<Api> | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: readonly T[];
  readonly streamOptions: AgentHarnessStreamOptions;
};

/** One command, as called. */
export type MockCall = {
  readonly method: string;
  readonly args: readonly unknown[];
};

/** The results the registered handlers returned for one scripted hook. */
export type MockHookResult = {
  readonly name: HookName;
  readonly results: readonly unknown[];
};

type StoredListener = (
  event: HarnessEvent,
  context: Context,
) => void | Promise<void>;
type StoredHook = {
  readonly id?: string;
  readonly handler: (event: MockHook["event"], context: Context) => unknown;
};

class RunRecord {
  readonly context: Context;
  readonly cancel: (reason?: unknown) => void;
  stopping = false;
  held: GatedBoundary | undefined;

  constructor() {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    this.context = context;
    this.cancel = cancel;
  }
}

type Resolvers<R> = {
  readonly promise: Promise<R>;
  readonly resolve: (value: R) => void;
  readonly reject: (reason?: unknown) => void;
};
type Boundary = {
  readonly step: AgenticStep;
  readonly run?: RunRecord;
  readonly gate?: undefined;
};
/** A boundary whose run waits on `gate`; only these are ever held. */
type GatedBoundary = Omit<Boundary, "gate"> & {
  readonly gate: Resolvers<void>;
};
type Demand<N extends TSchema, V> = Resolvers<
  IteratorResult<AgenticStep, void>
> & {
  acted: boolean;
  /** The graph view this `next` carried, read only by a staged prompt function. */
  readonly inputs?: ParentView<N, V>;
};

const closedError = () => new JuncoAgentError("closed", "MockAgent is closed");
const invalidTranscript = () =>
  new JuncoAgentError("invalid_argument", "Invalid MockAgent transcript");

/** Declared constant memory and token usage of a mock activation. */
export type MockUsage = {
  readonly [R in "memory" | "tokens"]?: ResourceQuantity<R>;
};

/** Constant per-activation profiles for declared mock usage; no runtime measurement. */
export function constantProfiles(usage: MockUsage): ProfileSet {
  for (const quantity of [usage.memory, usage.tokens])
    if (
      quantity !== undefined &&
      (!Number.isFinite(quantity.amount) || quantity.amount < 0)
    )
      throw invalidTranscript();
  return Object.freeze({
    ...(usage.memory === undefined
      ? {}
      : { memory: constantProfile("memory", usage.memory) }),
    ...(usage.tokens === undefined
      ? {}
      : { tokens: constantProfile("tokens", usage.tokens) }),
  });
}

/** Zero memory and zero tokens: the profiles of a mock that declares no usage. */
export const NO_USAGE: ProfileSet = constantProfiles({
  memory: bytes(0),
  tokens: tokens(0),
});

function validateRun(run: MockRun): void {
  const { frames } = run;
  // Checked at runtime too: a transcript may come from untyped data.
  const { kind } = run.interrupted.step;
  if (frames.length === 0 || (kind !== "settled" && kind !== "failed"))
    throw invalidTranscript();
  frames.forEach((frame, index) => {
    if ((frame.step.kind === "yield") !== index < frames.length - 1)
      throw invalidTranscript();
  });
}

/** A scripted `JuncoAgentProtocol` replaying its {@link MockTranscript}: no model requests; profiles come from declared usage. */
export class MockAgent<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> implements JuncoAgentProtocol<S, P, T, N, V>
{
  readonly errorHandler: ErrorHandler<N, V> | undefined;
  /** Profiles a MockJuncoGraph attaches to this agent's node: one constant per declared kind. */
  readonly profiles: ProfileSet;
  readonly #transcript: MockTranscript<S, P, T, N, V>;
  #runCursor = 0;
  #maintenanceCursor = 0;
  #clock = 0;

  #history: AgentMessage[];
  #tipId: string | null = null;
  readonly #requests: MockRequest<T>[] = [];
  readonly #calls: MockCall[] = [];
  readonly #hookResults: MockHookResult[] = [];
  readonly #listenerErrors: unknown[] = [];

  #tools: T[];
  #activeNames: string[];
  #resources: AgentHarnessResources<S, P>;
  #model: ModelIdentity | undefined;
  #thinkingLevel: ThinkingLevel;
  #streamOptions: AgentHarnessStreamOptions;
  #steeringMode: QueueMode;
  #followUpMode: QueueMode;
  #toolMutation: Promise<void> = Promise.resolve();

  readonly #steer: AgentMessage[] = [];
  readonly #followUp: AgentMessage[] = [];
  readonly #nextTurn: AgentMessage[] = [];

  readonly #listeners = new Map<string, Set<StoredListener>>();
  readonly #hooks = new Map<HookName, StoredHook[]>();

  #staged:
    | {
        readonly text: NonNullable<AgenticOptions<S, P, T, N, V>["prompt"]>;
        readonly images?: ImageContent[];
      }
    | undefined;
  #run: RunRecord | undefined;
  readonly #drives = new Set<Promise<unknown>>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #boundaries: (Boundary | GatedBoundary)[] = [];
  readonly #held: GatedBoundary[] = [];
  readonly #demands: Demand<N, V>[] = [];
  /** FIFO of queued compactions; never rejects, so one failure cannot poison later requests. */
  #compactionTail: Promise<void> = Promise.resolve();
  #pendingCompactions = 0;
  #aborting = false;
  #closing = false;
  #closed = false;
  #close: Promise<void> | undefined;

  constructor(transcript: MockTranscript<S, P, T, N, V>) {
    for (const run of transcript.runs) validateRun(run);
    this.#transcript = transcript;
    this.errorHandler = transcript.errorHandler;
    this.#history = [...(transcript.history ?? [])];
    this.#tools = [...(transcript.tools ?? [])];
    this.#activeNames = [
      ...(transcript.activeToolNames ?? this.#tools.map((tool) => tool.name)),
    ];
    validateActiveTools(this.#tools, this.#activeNames);
    this.profiles = constantProfiles(transcript.usage ?? {});
    this.#resources = transcript.resources ?? {};
    this.#model = transcript.model;
    this.#thinkingLevel = transcript.thinkingLevel ?? "off";
    this.#streamOptions = transcript.streamOptions ?? {};
    this.#steeringMode = transcript.steeringMode ?? "one-at-a-time";
    this.#followUpMode = transcript.followUpMode ?? "one-at-a-time";
    if (transcript.prompt !== undefined) {
      this.#staged = {
        text: transcript.prompt,
        ...(transcript.images === undefined
          ? {}
          : { images: transcript.images }),
      };
    }
  }

  // Observations -----------------------------------------------------------------------------------

  /** The conversation so far: transcript history, user inputs, scripted messages and terminals. */
  get history(): readonly AgentMessage[] {
    return [...this.#history];
  }
  /** One snapshot per executed frame. */
  get requests(): readonly MockRequest<T>[] {
    return [...this.#requests];
  }
  /** Every command (execution, control, configuration, maintenance) in call order. */
  get calls(): readonly MockCall[] {
    return [...this.#calls];
  }
  get tipId(): string | null {
    return this.#tipId;
  }
  get hookResults(): readonly MockHookResult[] {
    return [...this.#hookResults];
  }
  /** Errors thrown by event listeners, isolated from the run and from later listeners. */
  get listenerErrors(): readonly unknown[] {
    return [...this.#listenerErrors];
  }

  get status(): AgenticStatus {
    if (this.#closing) return "closed";
    if (this.#boundaries.length > 0) return "pending";
    if (this.#held.length > 0) return "suspended";
    if (this.#operations.size > 0) return "running";
    return this.#staged === undefined ? "idle" : "ready";
  }

  // Subscriptions ----------------------------------------------------------------------------------

  readonly events: JuncoAgentProtocol["events"] = {
    on: (type, listener) => {
      if (this.#closing) throw closedError();
      // The type key selects exactly the events this listener accepts.
      const stored = listener as StoredListener;
      let listeners = this.#listeners.get(type);
      if (listeners === undefined) {
        listeners = new Set();
        this.#listeners.set(type, listeners);
      }
      const set = listeners;
      const wrapped: StoredListener = (event, context) =>
        stored(event, context);
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },
  };

  readonly hooks: JuncoAgentProtocol["hooks"] = {
    on: (name, handler, options) => {
      if (this.#closing) throw closedError();
      let registrations = this.#hooks.get(name);
      if (registrations === undefined) {
        registrations = [];
        this.#hooks.set(name, registrations);
      }
      const list = registrations;
      // The name key selects exactly the invocations this handler accepts.
      const invoke = handler as StoredHook["handler"];
      const registration: StoredHook = {
        ...(options?.id === undefined ? {} : { id: options.id }),
        handler: (event, context) => invoke(event, context),
      };
      list.push(registration);
      return () => {
        const index = list.indexOf(registration);
        if (index !== -1) list.splice(index, 1);
      };
    },
  };

  // Run admission ----------------------------------------------------------------------------------

  prompt(
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<AssistantMessage> {
    this.#record("prompt", options === undefined ? [text] : [text, options]);
    return this.#explicitRun(() => this.#user(text, options?.images));
  }

  stagePrompt(
    prompt: NonNullable<AgenticOptions<S, P, T, N, V>["prompt"]>,
    options?: { images?: ImageContent[] },
  ): void {
    this.#record(
      "stagePrompt",
      options === undefined ? [prompt] : [prompt, options],
    );
    if (this.#closing) throw closedError();
    if (this.#pendingCompactions > 0)
      throw new JuncoAgentError("busy", "MockAgent compaction is pending");
    if (this.status !== "idle" || this.#aborting || this.#demands.length > 0) {
      throw new JuncoAgentError(
        "busy",
        "MockAgent already has a pending prompt or run",
      );
    }
    this.#staged = {
      text: prompt,
      ...(options?.images === undefined ? {} : { images: options.images }),
    };
  }

  skill(
    name: string,
    additionalInstructions?: string,
  ): Promise<AssistantMessage> {
    this.#record(
      "skill",
      additionalInstructions === undefined
        ? [name]
        : [name, additionalInstructions],
    );
    return this.#explicitRun(() => {
      const skill = this.#resources.skills?.find(
        (candidate) => candidate.name === name,
      );
      return skill === undefined
        ? undefined
        : this.#user(formatSkillInvocation(skill, additionalInstructions));
    });
  }

  promptFromTemplate(name: string, args?: string[]): Promise<AssistantMessage> {
    this.#record(
      "promptFromTemplate",
      args === undefined ? [name] : [name, args],
    );
    return this.#explicitRun(() => {
      const template = this.#resources.promptTemplates?.find(
        (candidate) => candidate.name === name,
      );
      return template === undefined
        ? undefined
        : this.#user(formatPromptTemplateInvocation(template, args));
    });
  }

  #explicitRun(
    resolve: () => AgentMessage | undefined,
  ): Promise<AssistantMessage> {
    if (this.#closing) return Promise.reject(closedError());
    if (this.#pendingCompactions > 0) {
      return Promise.reject(
        new JuncoAgentError("busy", "MockAgent compaction is pending"),
      );
    }
    if (
      this.#staged !== undefined ||
      this.#aborting ||
      this.#run !== undefined
    ) {
      return Promise.reject(
        new JuncoAgentError(
          "busy",
          "MockAgent already has a pending prompt or run",
        ),
      );
    }
    const prompt = resolve();
    if (prompt === undefined) {
      const error = new JuncoAgentError(
        "invalid_argument",
        "Unknown MockAgent resource",
      );
      this.#publish({ step: { kind: "failed", error } });
      return Promise.reject(error);
    }
    return this.#admit(prompt);
  }

  #admit(prompt: AgentMessage): Promise<AssistantMessage> {
    const script = this.#transcript.runs[this.#runCursor];
    if (script !== undefined) this.#runCursor++;
    // Next-turn messages reach only this run, ahead of its own prompt.
    this.#history.push(...this.#nextTurn.splice(0), prompt);
    const run = new RunRecord();
    this.#run = run;
    const settlement = trackPromise(
      this.#operations,
      trackPromise(this.#drives, this.#drive(run, script)),
    );
    settlement.then(
      (message) => this.#settle(run, { kind: "settled", message }),
      (error: unknown) => this.#settle(run, { kind: "failed", error }),
    );
    return settlement;
  }

  async #drive(
    run: RunRecord,
    script: MockRun | undefined,
  ): Promise<AssistantMessage> {
    if (script === undefined)
      throw new JuncoAgentError(
        "invalid_state",
        "MockAgent transcript exhausted",
      );
    // Frame work never runs inside the admitting call.
    await undefined;
    for (const frame of script.frames) {
      if (run.stopping) return this.#interrupt(run, script);
      for (const queue of frame.drain ?? []) this.#drain(queue);
      for (const hook of frame.hooks ?? []) {
        try {
          await this.#invokeHook(run, hook);
        } catch (error) {
          // A waiter released by cancellation is not the run's failure.
          if (run.stopping) return this.#interrupt(run, script);
          throw error;
        }
        if (run.stopping) return this.#interrupt(run, script);
      }
      this.#requests.push(this.#snapshot());
      const { step } = frame;
      this.#history.push(...(frame.messages ?? []));
      if (step.kind === "settled") this.#history.push(step.message);
      await this.#deliver(run, frame.events);
      if (run.stopping) return this.#interrupt(run, script);
      if (step.kind === "settled") return step.message;
      if (step.kind === "failed") throw step.error;
      const boundary: GatedBoundary = {
        step,
        run,
        gate: Promise.withResolvers<void>(),
      };
      run.held = boundary;
      this.#publish(boundary);
      await boundary.gate.promise;
    }
    // Validation ends every run with a terminal frame, which returned or threw above.
    throw invalidTranscript();
  }

  async #interrupt(run: RunRecord, script: MockRun): Promise<AssistantMessage> {
    const { step, messages, events } = script.interrupted;
    this.#history.push(...(messages ?? []));
    if (step.kind === "settled") this.#history.push(step.message);
    await this.#deliver(run, events);
    if (step.kind === "settled") return step.message;
    throw step.error;
  }

  #settle(run: RunRecord, step: AgenticStep): void {
    if (this.#run === run) this.#run = undefined;
    run.held = undefined;
    this.#publish({ step, run });
  }

  #drain(queue: "steer" | "followUp"): void {
    const items = queue === "steer" ? this.#steer : this.#followUp;
    const mode = queue === "steer" ? this.#steeringMode : this.#followUpMode;
    this.#history.push(...items.splice(0, mode === "all" ? items.length : 1));
  }

  async #invokeHook(run: RunRecord, hook: MockHook): Promise<void> {
    const results: unknown[] = [];
    for (const { handler } of [...(this.#hooks.get(hook.name) ?? [])]) {
      results.push(await handler(hook.event, run.context));
    }
    this.#hookResults.push({ name: hook.name, results });
    if (!isDeepStrictEqual(results, hook.results)) {
      throw new JuncoAgentError(
        "invalid_state",
        `MockAgent ${hook.name} hook results differ from its transcript`,
      );
    }
  }

  async #deliver(
    run: RunRecord,
    events: readonly HarnessEvent[] | undefined,
  ): Promise<void> {
    for (const event of events ?? []) {
      for (const listener of [...(this.#listeners.get(event.type) ?? [])]) {
        try {
          await listener(event, run.context);
        } catch (error) {
          this.#listenerErrors.push(error);
        }
      }
    }
  }

  #snapshot(): MockRequest<T> {
    return {
      messages: [...this.#history],
      model: this.#lookupModel(),
      thinkingLevel: this.#thinkingLevel,
      tools: this.getActiveTools(),
      streamOptions: this.#streamOptions,
    };
  }

  #lookupModel(): Model<Api> | undefined {
    const identity = this.#model;
    if (identity === undefined) return undefined;
    return this.#transcript.models?.find(
      (model) =>
        model.provider === identity.provider && model.id === identity.modelId,
    );
  }

  #user(text: string, images?: ImageContent[]): AgentMessage {
    return {
      role: "user",
      content: [{ type: "text", text }, ...(images ?? [])],
      timestamp: ++this.#clock,
    };
  }

  #record(method: string, args: readonly unknown[]): void {
    this.#calls.push({ method, args });
  }

  // Queue and conversation controls ----------------------------------------------------------------

  #operation<R>(start: () => Promise<R>): Promise<R> {
    if (this.#closing) return Promise.reject(closedError());
    try {
      return trackPromise(this.#operations, start());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this.#record("steer", options === undefined ? [text] : [text, options]);
    return this.#operation(async () => {
      this.#steer.push(this.#user(text, options?.images));
    });
  }

  followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this.#record("followUp", options === undefined ? [text] : [text, options]);
    return this.#operation(async () => {
      this.#followUp.push(this.#user(text, options?.images));
    });
  }

  nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this.#record("nextTurn", options === undefined ? [text] : [text, options]);
    return this.#operation(async () => {
      this.#nextTurn.push(this.#user(text, options?.images));
    });
  }

  appendMessage(message: AgentMessage): Promise<void> {
    this.#record("appendMessage", [message]);
    return this.#operation(async () => {
      this.#history.push(message);
    });
  }

  // Complaints -------------------------------------------------------------------------------------

  /** Append a complete `issue` to the shared {@link issueLog}. */
  complain<C extends TSchema>(issue: Issue<C>): void {
    this.#record("complain", [issue]);
    if (this.#closing) throw closedError();
    issueLog.append(issue);
  }

  /** The process-wide complaint history every agent and graph shares. */
  get issueLog(): typeof issueLog {
    return issueLog;
  }

  // Configuration ----------------------------------------------------------------------------------

  getTools(): T[] {
    return [...this.#tools];
  }

  getActiveTools(): T[] {
    return this.#activeNames.map((name) => {
      const tool = this.#tools.find((tool) => tool.name === name);
      if (tool === undefined)
        throw new JuncoAgentError(
          "invalid_state",
          `Unknown active tool "${name}"`,
        );
      return tool;
    });
  }

  getResources(): AgentHarnessResources<S, P> {
    return this.#resources;
  }

  #mutateTools(work: () => void): Promise<void> {
    return this.#operation(() => {
      const pending = this.#toolMutation.then(() => {
        if (this.#closing) throw closedError();
        work();
      });
      this.#toolMutation = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    });
  }

  setTools(tools: T[], activeToolNames?: string[]): Promise<void> {
    this.#record(
      "setTools",
      activeToolNames === undefined ? [tools] : [tools, activeToolNames],
    );
    const nextTools = [...tools];
    const names =
      activeToolNames === undefined
        ? nextTools.map((tool) => tool.name)
        : [...activeToolNames];
    return this.#mutateTools(() => {
      validateActiveTools(nextTools, names);
      this.#tools = nextTools;
      this.#activeNames = names;
    });
  }

  setActiveTools(names: string[]): Promise<void> {
    this.#record("setActiveTools", [names]);
    const selection = [...names];
    return this.#mutateTools(() => {
      validateActiveTools(this.#tools, selection);
      this.#activeNames = selection;
    });
  }

  setResources(resources: AgentHarnessResources<S, P>): Promise<void> {
    this.#record("setResources", [resources]);
    return this.#operation(async () => {
      this.#resources = resources;
    });
  }

  setModel(model: ModelIdentity): Promise<void> {
    this.#record("setModel", [model]);
    return this.#operation(async () => {
      this.#model = model;
    });
  }

  getModel(): Promise<Model<Api> | undefined> {
    return this.#operation(async () => this.#lookupModel());
  }

  setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.#record("setThinkingLevel", [level]);
    return this.#operation(async () => {
      this.#thinkingLevel = level;
    });
  }

  getThinkingLevel(): Promise<ThinkingLevel> {
    return this.#operation(async () => this.#thinkingLevel);
  }

  setStreamOptions(options: AgentHarnessStreamOptions): Promise<void> {
    this.#record("setStreamOptions", [options]);
    return this.#operation(async () => {
      this.#streamOptions = options;
    });
  }

  setSteeringMode(mode: QueueMode): Promise<void> {
    this.#record("setSteeringMode", [mode]);
    return this.#operation(async () => {
      this.#steeringMode = mode;
    });
  }

  setFollowUpMode(mode: QueueMode): Promise<void> {
    this.#record("setFollowUpMode", [mode]);
    return this.#operation(async () => {
      this.#followUpMode = mode;
    });
  }

  // Maintenance ------------------------------------------------------------------------------------

  /** Consume the next maintenance record when it is `method` with exactly `args`. */
  #maintain(
    method: MockMaintenance["method"],
    args: readonly unknown[],
  ): MockMaintenance {
    const record = this.#transcript.maintenance?.[this.#maintenanceCursor];
    if (
      record === undefined ||
      record.method !== method ||
      !isDeepStrictEqual(record.args, args)
    ) {
      throw new JuncoAgentError(
        "invalid_state",
        `MockAgent ${method} differs from its transcript`,
      );
    }
    this.#maintenanceCursor++;
    if (record.result.ok) {
      if (record.history !== undefined) this.#history = [...record.history];
      if (record.tipId !== undefined) this.#tipId = record.tipId;
    }
    return record;
  }

  /** Pi's estimate over the eligible scripted history; the mock has no provider usage. */
  context_size(): Promise<number> {
    return this.#operation(async () => {
      let tokens = 0;
      for (const message of this.#history) {
        const unsuccessful =
          message.role === "assistant" &&
          (message.stopReason === "error" ||
            message.stopReason === "aborted" ||
            message.stopReason === "deferred");
        if (!unsuccessful) tokens += estimateTokens(message);
      }
      return tokens;
    });
  }

  compact(...args: Parameters<JuncoAgentProtocol["compact"]>): Promise<void> {
    this.#record("compact", args);
    // Captured by value: the request runs later, after the admitted run.
    const captured = args.map((options) => options && { ...options });
    return this.#operation(() => {
      this.#pendingCompactions++;
      const job = this.#compactionTail
        .then(() => this.#compactWhenIdle(captured))
        .finally(() => {
          this.#pendingCompactions--;
          this.#pump();
        });
      this.#compactionTail = job.then(
        () => undefined,
        () => undefined,
      );
      return job;
    });
  }

  async #compactWhenIdle(args: readonly unknown[]): Promise<void> {
    if (this.#closing) throw closedError();
    // Runs admitted before this request finish first; new runs are busy while it is pending.
    await Promise.allSettled([...this.#drives]);
    if (this.#closing) throw closedError();
    const record = this.#maintain("compact", args);
    if (record.method !== "compact") throw invalidTranscript();
    if (!record.result.ok) throw record.result.error;
  }

  navigateTree(
    ...args: Parameters<JuncoAgentProtocol["navigateTree"]>
  ): Promise<NavigationResult> {
    this.#record("navigateTree", args);
    return this.#operation(async () => {
      if (this.#pendingCompactions > 0)
        throw new JuncoAgentError("busy", "MockAgent compaction is pending");
      const record = this.#maintain("navigateTree", args);
      if (record.method !== "navigateTree") throw invalidTranscript();
      return record.result;
    });
  }

  // Cancellation -----------------------------------------------------------------------------------

  /** Owner hook: abort what this agent runs on its behalf. */
  protected abortDependents(): Promise<void> | undefined {
    return undefined;
  }

  /** Owner hook: close what this agent runs on its behalf. */
  protected closeDependents(): Promise<void> | undefined {
    return undefined;
  }

  #startDependents(kind: "abort" | "close"): Promise<void> {
    let started: Promise<void>;
    try {
      started = Promise.resolve(
        kind === "abort" ? this.abortDependents() : this.closeDependents(),
      );
    } catch (error) {
      started = Promise.reject(error);
    }
    void started.catch(() => {});
    return started;
  }

  #suppressGates(run: RunRecord): void {
    const held = run.held;
    run.held = undefined;
    if (held === undefined) return;
    const unread = this.#boundaries.indexOf(held);
    if (unread !== -1) this.#boundaries.splice(unread, 1);
    const consumed = this.#held.indexOf(held);
    if (consumed !== -1) this.#held.splice(consumed, 1);
    held.gate.resolve();
  }

  /** Mark the active run stopping and release its hold; its Context is cancelled separately. */
  #markStopping(): RunRecord | undefined {
    const run = this.#run;
    if (run === undefined) return undefined;
    run.stopping = true;
    this.#suppressGates(run);
    return run;
  }

  abort(): Promise<{
    readonly clearedSteer: AgentMessage[];
    readonly clearedFollowUp: AgentMessage[];
  }> {
    this.#record("abort", []);
    if (this.#closing) return Promise.reject(closedError());
    if (this.#aborting)
      return Promise.reject(
        new JuncoAgentError("busy", "MockAgent abort is pending"),
      );
    this.#aborting = true;
    const stopping = this.#markStopping();
    const dependents = this.#startDependents("abort");
    stopping?.cancel(
      new JuncoAgentError("invalid_state", "MockAgent run was aborted"),
    );
    const clearedSteer = this.#steer.splice(0);
    const clearedFollowUp = this.#followUp.splice(0);
    this.#pump();
    const joined = (async () => {
      let failure: { readonly error: unknown } | undefined;
      try {
        await dependents;
      } catch (error) {
        failure = { error };
      }
      while (this.#drives.size > 0) await Promise.allSettled([...this.#drives]);
      if (failure !== undefined) throw failure.error;
      return { clearedSteer, clearedFollowUp };
    })();
    return trackPromise(
      this.#operations,
      joined.finally(() => {
        this.#aborting = false;
        this.#pump();
      }),
    );
  }

  // FIFO scheduling iterator -----------------------------------------------------------------------

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(inputs?: ParentView<N, V>): Promise<IteratorResult<AgenticStep, void>> {
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    const demand: Demand<N, V> = {
      ...Promise.withResolvers<IteratorResult<AgenticStep, void>>(),
      acted: false,
      ...(inputs === undefined ? {} : { inputs }),
    };
    this.#demands.push(demand);
    this.#pump();
    return demand.promise;
  }

  #publish(boundary: Boundary | GatedBoundary): void {
    this.#boundaries.push(boundary);
    this.#pump();
  }

  #pump(): void {
    while (!this.#closing) {
      const demand = this.#demands[0];
      if (demand === undefined) return;
      const boundary = this.#boundaries[0];
      if (boundary !== undefined) {
        this.#boundaries.shift();
        this.#demands.shift();
        if (boundary.gate !== undefined) this.#held.push(boundary);
        demand.resolve({ value: boundary.step, done: false });
        continue;
      }
      if (this.#aborting || demand.acted) return;
      // A staged prompt waits for queued compaction; a held yield still resumes.
      if (
        this.#held.length === 0 &&
        this.#staged !== undefined &&
        this.#pendingCompactions > 0
      )
        return;
      demand.acted = true;
      const held = this.#held.shift();
      if (held !== undefined) {
        if (held.run?.held === held) held.run.held = undefined;
        held.gate.resolve();
      } else if (this.#staged !== undefined) {
        const { text, images } = this.#staged;
        this.#staged = undefined;
        if (this.#run !== undefined) {
          this.#publish({
            step: {
              kind: "failed",
              error: new JuncoAgentError("busy", "MockAgent already has a run"),
            },
          });
        } else {
          // A function reads, without draining, the graph view of this `next`.
          let prompt: string;
          try {
            prompt = resolveStagedPrompt(text, demand.inputs);
          } catch (error) {
            this.#publish({ step: { kind: "failed", error } });
            return;
          }
          void this.#admit(this.#user(prompt, images)).catch(() => {});
        }
      }
      return;
    }
  }

  return(
    value?: void | PromiseLike<void>,
  ): Promise<IteratorResult<AgenticStep, void>> {
    return this.#beginClose().then(async () => ({
      value: await value,
      done: true,
    }));
  }

  throw(error: unknown): Promise<IteratorResult<AgenticStep, void>> {
    return this.#beginClose().then(
      () => {
        throw error;
      },
      (failure: unknown) => {
        const causes =
          failure instanceof AggregateError ? failure.errors : [failure];
        throw new AggregateError(
          [error, ...causes],
          "MockAgent closed with errors",
          { cause: error },
        );
      },
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.return();
  }

  #beginClose(): Promise<void> {
    if (this.#close !== undefined) return this.#close;
    this.#closing = true;
    this.#staged = undefined;
    this.#steer.length = 0;
    this.#followUp.length = 0;
    this.#nextTurn.length = 0;
    const stopping = this.#markStopping();
    const dependents = this.#startDependents("close");
    stopping?.cancel(closedError());
    for (const boundary of this.#held.splice(0)) boundary.gate.resolve();
    for (let index = this.#boundaries.length - 1; index >= 0; index--) {
      const boundary = this.#boundaries[index];
      if (boundary.gate === undefined) continue;
      this.#boundaries.splice(index, 1);
      boundary.gate.resolve();
    }
    this.#close = this.#finishClose(dependents);
    return this.#close;
  }

  async #finishClose(dependents: Promise<void>): Promise<void> {
    const failures: unknown[] = [];
    try {
      await dependents;
    } catch (error) {
      failures.push(error);
    }
    while (this.#operations.size > 0)
      await Promise.allSettled([...this.#operations]);
    this.#closed = true;
    const failure =
      failures.length > 0
        ? new AggregateError(failures, "MockAgent close failed")
        : undefined;
    for (const demand of this.#demands.splice(0)) {
      const index = this.#boundaries.findIndex(
        (boundary) => boundary.gate === undefined,
      );
      if (index !== -1)
        demand.resolve({
          value: this.#boundaries.splice(index, 1)[0].step,
          done: false,
        });
      else if (failure !== undefined) demand.reject(failure);
      else demand.resolve({ value: undefined, done: true });
    }
    this.#boundaries.length = 0;
    this.#listeners.clear();
    this.#hooks.clear();
    if (failure !== undefined) throw failure;
  }
}
