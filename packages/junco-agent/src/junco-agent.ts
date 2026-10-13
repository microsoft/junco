import { resolve } from "node:path";
import {
  AgentHarness,
  type AgentHarnessResources,
  type AgentHarnessStreamOptions,
  type AgentHarnessTool,
  type AgentLane,
  type AgentMessage,
  type AgentTool,
  type AgentToolCall,
  BACKGROUND_CONTEXT,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  estimateContextTokens,
  estimateTokens,
  type HarnessEvent,
  MemorySessionRepo,
  type ModelIdentity,
  type NavigationResult,
  type OperationRequest,
  type PromptTemplate,
  type QueueMode,
  type Session,
  type Skill,
  type ThinkingLevel,
  withCancel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type DataflowTracer,
  type EdgeIdType,
  NodeId,
  type NodeIdType,
  type ParentView,
} from "dataflow-engine";
import {
  getJuncoMcpToolIdentity,
  type JuncoMcpConnection,
  type JuncoMcpToolIdentity,
  JuncoMcpTools,
} from "junco-mcp";
import {
  AssignedTaskTool,
  ComplainTool,
  type ComplaintContext,
  type Contract,
  InfoTool,
  type Issue,
  invokeComplainTool,
  invokeTaskTool,
  isAssignedTaskTool,
  isComplainTool,
  issueLog,
  isTaskTool,
  isYieldTool,
  type Prompt,
  RecvTool,
  SendTool,
  type TaskCall,
  type TaskInput,
  TaskTool,
  type TaskToolHost,
  type ToolBinding,
  ToolCollection,
  YieldTool,
} from "junco-tools";
import { isMarshPolicyDenied } from "junco-tools/errors";
import type {
  Agentic,
  AgenticInput,
  AgenticOptions,
  AgenticStatus,
  AgenticStep,
  AgenticYieldReason,
} from "./agentic.js";

export class JuncoAgentError extends Error {
  constructor(
    readonly code: "invalid_argument" | "invalid_state" | "busy" | "closed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JuncoAgentError";
  }
}

/** A subclass's view of one admitted native run. */
export interface AgenticRun {
  readonly kind: "prompt" | "skill" | "prompt_template";
  /** Cancellation of this run's caller waiter (distinct from a native tool effect gate). */
  readonly signal: AbortSignal | undefined;
  readonly stopping: boolean;
}

/**
 * Factory-only tool sources: concrete tools and MCP definitions, in order. Each definition is
 * connected for the agent being created; its discovered tools take its place in the list.
 */
export type JuncoAgentTools<T extends AgentTool = AgentTool> =
  | JuncoMcpTools
  | readonly (T | JuncoMcpTools)[];

/** {@link JuncoAgent.fromResolved}'s options, with factory-only tool sources. */
export type JuncoAgentResolvedOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Omit<AgenticOptions<S, P, T>, "tools"> & {
  /** Base directory MCP server definitions connect from; default `process.cwd()`. */
  readonly cwd?: string;
  readonly tools?: JuncoAgentTools<T>;
};

/** Pi login-backed model resolution and optional owned default tools for {@link JuncoAgent.create}. */
export type JuncoAgentCreateOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Omit<AgenticOptions<S, P, T>, "session" | "models" | "model" | "tools"> & {
  readonly provider: string;
  readonly model: string;
  /** Reuse a Pi runtime; otherwise load Pi's saved login and model configuration. */
  readonly models?: ModelRuntime;
  /** Transferred to JuncoAgent; its harness closes the supplied session. */
  readonly session?: Session;
  /**
   * Base directory of the default or MCP-required ToolCollection (when none is supplied) and of
   * MCP server definitions; default `process.cwd()`.
   */
  readonly cwd?: string;
  /**
   * Concrete tools are caller-owned; MCP definitions are connected for, and closed with, this
   * agent. Omitted tools include the collection's tools, task and yield.
   */
  readonly tools?: JuncoAgentTools<T>;
};

/** Per-subagent overrides of {@link JuncoAgent.createSubagents}; omitted values inherit the caller's. */
export type TaskAgentOptions = {
  readonly model?: ModelIdentity;
  /** Names among the caller's active tools; `[]` permits none. */
  readonly tools?: readonly string[];
};

/**
 * What one graph activation binds while a {@link JuncoAgent} runs: the node's retained inbox,
 * outgoing routes and topology for recv/send/info, its task host, and complaint attribution.
 */
export type JuncoAgentNodeContext<N = unknown, T = unknown> = {
  readonly messaging?: NonNullable<
    ConstructorParameters<typeof RecvTool<N, T>>[0]
  > &
    NonNullable<ConstructorParameters<typeof SendTool<N>>[0]> &
    NonNullable<ConstructorParameters<typeof InfoTool>[0]>;
  readonly task?: TaskToolHost;
  readonly complaint?: Omit<ComplaintContext<N>, "prompt">;
};

/** Checks a hosted `task` launch before admission; throwing rejects it. See {@link JuncoAgent.setTaskPolicy}. */
export type TaskPolicy = (input: TaskInput) => void;

/**
 * What a graph does with a failed task: drop it silently, or run it again up to `retries` more
 * times and then ask the caller to retry or ignore it. See {@link JuncoAgent.setTaskFailurePolicy}.
 */
export type TaskFailurePolicy = "ignore" | { readonly retries: number };

/** Sees the subagents one agent acquires; see {@link JuncoAgent.setSubagentObserver}. */
export type SubagentObserver = {
  /** Before anything is acquired for a batch; throwing rejects the batch with nothing created. */
  readonly acquiring?: (options: readonly TaskAgentOptions[]) => void;
  /**
   * Each fresh, unstarted child in batch order, before the caller receives the batch; throwing
   * fails the batch and closes every child it created.
   */
  readonly acquired?: (child: JuncoAgent, index: number) => void;
};

/** One MCP definition an agent connected: what subagents reconnect, and which wrappers it produced. */
type McpSourceRegistration = {
  readonly source: JuncoMcpTools;
  /** The resolved base directory it connected from. */
  readonly cwd: string;
  readonly tools: readonly AgentTool[];
};

type OwnedResources = {
  /** Connections this agent's factory opened, in acquisition order. */
  mcp?: JuncoMcpConnection[];
  /** The definitions behind `mcp`, in the same order, for subagents to inherit. */
  mcpSources?: McpSourceRegistration[];
  /** This agent's creator hold on `toolCollection`, when its factory created it. */
  collection?: { close(): Promise<void> };
  /** This agent's own policy owner over `toolCollection`, which also holds it. */
  binding?: ToolBinding;
  /** The actual collection MCP connections run on and the agent binds. */
  toolCollection?: ToolCollection;
  repo?: MemorySessionRepo;
};

async function releaseOwned(owned: OwnedResources): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const release of [
    ...[...(owned.mcp ?? [])]
      .reverse()
      .map((connection) => () => connection.close()),
    owned.binding && (() => owned.binding!.close()),
    owned.collection && (() => owned.collection!.close()),
    owned.repo && (() => owned.repo!.close(BACKGROUND_CONTEXT)),
  ]) {
    if (release === undefined) continue;
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Before construction a factory owns the session and every acquired resource: closes the
 * session, then releases `owned`, and rethrows `primary` — aggregated with any cleanup failure.
 */
async function failBeforeConstruction(
  primary: unknown,
  session: Session | undefined,
  owned: OwnedResources,
  message: string,
): Promise<never> {
  const failures: unknown[] = [];
  try {
    await session?.close(BACKGROUND_CONTEXT);
  } catch (failure) {
    failures.push(failure);
  }
  failures.push(...(await releaseOwned(owned)));
  if (failures.length > 0) {
    throw new AggregateError([primary, ...failures], message, {
      cause: primary,
    });
  }
  throw primary;
}

/**
 * Expands factory-only sources in order: concrete tools keep their identity, and each MCP
 * definition is connected from `cwd` on `owned.toolCollection`, recorded in `owned` before its
 * tools are appended. A nonempty definition without a collection first creates one under the
 * collection default, owned by `owned`. `signal` cancels connection acquisition only.
 */
async function resolveToolSources(
  sources: JuncoAgentTools | undefined,
  cwd: string,
  owned: OwnedResources,
  signal?: AbortSignal,
): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  if (sources === undefined) return tools;
  for (const source of sources instanceof JuncoMcpTools ? [sources] : sources) {
    if (source instanceof JuncoMcpTools) {
      if (source.size > 0 && owned.toolCollection === undefined) {
        owned.toolCollection = await ToolCollection.create(cwd);
        owned.collection = owned.toolCollection;
      }
      const connection = await source.connect({
        cwd,
        signal,
        collection: owned.toolCollection,
      });
      owned.mcp ??= [];
      owned.mcp.push(connection);
      owned.mcpSources ??= [];
      owned.mcpSources.push({ source, cwd, tools: connection.tools });
      tools.push(...connection.tools);
    } else {
      tools.push(source);
    }
  }
  return tools;
}

function validateActiveTools(
  tools: readonly AgentTool[],
  names: readonly string[],
): void {
  const available = new Set<string>();
  for (const tool of tools) {
    if (available.has(tool.name)) {
      throw new JuncoAgentError(
        "invalid_argument",
        `Duplicate tool name: ${tool.name}`,
      );
    }
    available.add(tool.name);
  }
  const active = new Set<string>();
  for (const name of names) {
    if (active.has(name))
      throw new JuncoAgentError(
        "invalid_argument",
        `Duplicate active tool: ${name}`,
      );
    if (!available.has(name))
      throw new JuncoAgentError(
        "invalid_argument",
        `Unknown active tool: ${name}`,
      );
    active.add(name);
  }
}

/**
 * `tools` with every genuine complaint tool replaced in place by `own`, or `own` appended when none
 * is present, and the collection's genuine `release` tool appended when absent. Duplicates and
 * same-named impostors are left for validation to reject.
 */
function withRequiredTools<T extends AgentTool>(
  tools: readonly T[],
  own: ComplainTool,
  release: AgentTool | undefined,
): (T | ComplainTool)[] {
  let found = false;
  const result = tools.map((tool): T | ComplainTool => {
    if (!isComplainTool(tool)) return tool;
    found = true;
    return own;
  });
  if (!found) result.push(own);
  if (release !== undefined && !result.includes(release as T))
    result.push(release as T);
  return result;
}

/** An active-tool selection that always includes `complain`, and `release` when required. */
function withRequiredNames(
  names: readonly string[],
  release: AgentTool | undefined,
): string[] {
  const result = [...names];
  for (const name of release === undefined
    ? ["complain"]
    : ["complain", "release"])
    if (!result.includes(name)) result.push(name);
  return result;
}

/** The sentence every model request's system prompt carries. */
const RELEASE_INSTRUCTION =
  "After you write to a file use release to relinquish ownership";

function valueOrThrow<T, E>(
  result: { ok: true; value: T } | { ok: false; error: E },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function track<T>(
  pending: Set<Promise<unknown>>,
  promise: Promise<T>,
): Promise<T> {
  pending.add(promise);
  const settled = () => pending.delete(promise);
  promise.then(settled, settled);
  return promise;
}
type RunRequest = Extract<
  OperationRequest,
  { kind: "prompt" | "skill" | "prompt_template" }
>;

/** Pi's context filter: unsuccessful assistant replies are not part of the model context. */
function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

class RollbackFailure extends Error {
  constructor(
    readonly errors: unknown[],
    readonly closing: Promise<unknown>,
  ) {
    super("JuncoAgent tool configuration rollback failed");
  }
}

class RunRecord implements AgenticRun {
  readonly signal: AbortSignal | undefined;
  readonly cancel: (reason?: unknown) => void;
  readonly context: ReturnType<typeof withCancel>["context"];
  operationId: string | undefined;
  stopping = false;
  lastMessage: AssistantMessage | undefined;
  batch:
    | {
        readonly reasons: Map<string, AgenticYieldReason>;
        readonly executedYields: Map<string, AgentTool>;
      }
    | undefined;
  held: Boundary | undefined;
  /** The latest model request of this run, snapshotted at the provider boundary. */
  prompt: Prompt | undefined;
  /** Why the latest request could not be snapshotted, when it could not. */
  promptCaptureError: unknown;

  constructor(readonly kind: AgenticRun["kind"]) {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    this.context = context;
    this.cancel = cancel;
    this.signal = context.abortSignal;
  }
}

type Boundary = {
  readonly step: AgenticStep;
  readonly run?: RunRecord;
  readonly gate?: PromiseWithResolvers<void>;
  /** A turn_end yield becomes readable only after the complete public event has been delivered. */
  ready?: boolean;
};
type Demand = PromiseWithResolvers<IteratorResult<AgenticStep, void>> & {
  acted: boolean;
  /** The graph view this `next` carried, read only by a staged prompt function. */
  readonly inputs?: ParentView<AgenticInput, AssistantMessage>;
};
const closedError = () => new JuncoAgentError("closed", "JuncoAgent is closed");

/** A staged prompt's text: a function reads, without draining, the graph view of its `next`. */
function stagedText(
  prompt: NonNullable<AgenticOptions["prompt"]>,
  inputs: ParentView<AgenticInput, AssistantMessage> | undefined,
): string {
  if (typeof prompt === "string") return prompt;
  if (inputs === undefined)
    throw new JuncoAgentError(
      "invalid_state",
      "A prompt function requires ParentView inputs",
    );
  const text: unknown = prompt(inputs);
  if (typeof text !== "string")
    throw new JuncoAgentError(
      "invalid_argument",
      "A prompt function must return a string",
    );
  return text;
}

/** A cooperative iterator around a single native Pi lane; the native lane is never public. */
export class JuncoAgent<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> implements Agentic<S, P, T | ComplainTool>
{
  /**
   * An agent over already resolved options. `tools` may also hold MCP definitions, connected
   * from `cwd` before construction and closed with the agent; the supplied session is
   * transferred, and closed if construction fails.
   */
  static fromResolved<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
    T extends AgentTool = AgentTool,
  >(
    options: AgenticOptions<S, P, T> & { readonly cwd?: string },
  ): Promise<JuncoAgent<S, P, T>>;
  static fromResolved<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
  >(
    options: JuncoAgentResolvedOptions<S, P, AgentTool>,
  ): Promise<JuncoAgent<S, P, AgentTool>>;
  static async fromResolved(
    options: JuncoAgentResolvedOptions,
  ): Promise<JuncoAgent> {
    const { cwd, tools, collection, ...native } = options;
    const owned: OwnedResources = { toolCollection: collection };
    let agent: JuncoAgent;
    try {
      const resolved = await resolveToolSources(
        tools,
        resolve(cwd ?? process.cwd()),
        owned,
      );
      agent = new JuncoAgent(
        {
          ...native,
          collection: owned.toolCollection,
          tools: resolved,
        },
        owned,
      );
    } catch (error) {
      // Before construction the factory owns the transferred session and every connection.
      return await failBeforeConstruction(
        error,
        native.session,
        owned,
        "JuncoAgent.fromResolved cleanup failed",
      );
    }
    await agent.initialize();
    return agent;
  }

  static create<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
    T extends AgentTool = AgentTool,
  >(
    options: JuncoAgentCreateOptions<S, P, T> & { readonly tools: T[] },
  ): Promise<JuncoAgent<S, P, T>>;
  static create<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
  >(
    options: JuncoAgentCreateOptions<S, P, AgentTool>,
  ): Promise<JuncoAgent<S, P, AgentTool>>;
  static async create(options: JuncoAgentCreateOptions): Promise<JuncoAgent> {
    const {
      provider,
      model: modelId,
      models: suppliedModels,
      session: suppliedSession,
      cwd,
      tools,
      collection,
      ...native
    } = options;
    const owned: OwnedResources = { toolCollection: collection };
    let session: Session | undefined = suppliedSession;
    let agent: JuncoAgent | undefined;
    try {
      const models =
        suppliedModels ??
        (await (
          await import("@earendil-works/pi-coding-agent")
        ).ModelRuntime.create());
      const model = models.getModel(provider, modelId);
      if (model === undefined) {
        throw new JuncoAgentError(
          "invalid_argument",
          `Model not found: ${provider}/${modelId}`,
        );
      }
      if (
        native.thinkingLevel !== undefined &&
        !getSupportedThinkingLevels(model).includes(native.thinkingLevel)
      ) {
        throw new JuncoAgentError(
          "invalid_argument",
          `${provider}/${modelId} does not support thinking level ${native.thinkingLevel}`,
        );
      }
      try {
        if (
          !(await models.listCredentials()).some(
            ({ providerId }) => providerId === provider,
          )
        ) {
          throw new Error(`No saved Pi credentials for ${provider}`);
        }
        if ((await models.getAuth(model)) === undefined) {
          throw new Error(`Pi could not resolve credentials for ${provider}`);
        }
      } catch (cause) {
        throw new JuncoAgentError(
          "invalid_state",
          `No usable Pi login for ${provider}. Run pi and use /login for ${provider}, then retry.`,
          { cause },
        );
      }
      if (suppliedSession === undefined) {
        owned.repo = new MemorySessionRepo();
        session = await owned.repo.create({}, BACKGROUND_CONTEXT);
      } else {
        session = suppliedSession;
      }
      let agentTools: AgentTool[];
      if (tools === undefined) {
        // Explicit-tool construction does not allocate a local execution environment or addon.
        if (owned.toolCollection === undefined) {
          owned.toolCollection = await ToolCollection.create(
            resolve(cwd ?? process.cwd()),
          );
          owned.collection = owned.toolCollection;
        }
        agentTools = [
          ...owned.toolCollection.tools,
          new TaskTool(),
          new YieldTool(),
          new RecvTool(),
          new SendTool(),
          new InfoTool(),
        ];
      } else {
        agentTools = await resolveToolSources(
          tools,
          resolve(cwd ?? process.cwd()),
          owned,
        );
      }
      agent = new JuncoAgent(
        {
          ...native,
          session,
          models,
          model,
          collection: owned.toolCollection,
          tools: agentTools,
        },
        owned,
      );
      await agent.initialize();
      return agent;
    } catch (error) {
      // Once constructed, initialize() owns failure cleanup; before then the factory does.
      if (agent !== undefined) throw error;
      return await failBeforeConstruction(
        error,
        session,
        owned,
        "JuncoAgent.create cleanup failed",
      );
    }
  }

  readonly #options: AgenticOptions<S, P, T>;
  /**
   * The collection selecting this agent's authorization policy and lifetime, borrowed: the agent
   * holds it through its own binding, whose tools act as this agent's one policy owner. Take
   * `collection.lease()` to keep it beyond the agent; never close it directly.
   */
  readonly collection: ToolCollection | undefined;
  readonly #owned: OwnedResources;
  #harness: AgentHarness<undefined> | undefined;
  #lane: AgentLane | undefined;
  get #nativeLane(): AgentLane {
    if (this.#lane === undefined)
      throw new JuncoAgentError(
        "invalid_state",
        "JuncoAgent lane is not initialized",
      );
    return this.#lane;
  }
  /** This agent's identity for complaints made outside a bound graph node. */
  readonly nodeId: NodeIdType = NodeId.create(`agent-${crypto.randomUUID()}`);
  /** The always-on complaint tool this agent owns; supplied genuine ones are rebound to it. */
  readonly #complainTool: ComplainTool = new ComplainTool();
  /** The collection's genuine `release` tool, always present and active with a collection. */
  readonly #releaseTool: AgentTool | undefined;
  #tools: (T | ComplainTool)[];
  #activeNames: string[] = [];
  #resources: AgentHarnessResources<S, P>;
  #toolMutation: Promise<void> = Promise.resolve();
  readonly #runsByToolSignal = new WeakMap<AbortSignal, RunRecord>();
  /** The one admitted run; admission permits no second until it settles. */
  #currentRun: RunRecord | undefined;
  readonly #drives = new Set<Promise<unknown>>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #boundaries: Boundary[] = [];
  readonly #held: Boundary[] = [];
  readonly #demands: Demand[] = [];
  /** FIFO of queued compactions; never rejects, so one failure cannot poison later requests. */
  #compactionTail: Promise<void> = Promise.resolve();
  #pendingCompactions = 0;
  #aborting = false;
  #staged:
    | {
        readonly text: NonNullable<AgenticOptions["prompt"]>;
        readonly images?: ImageContent[];
      }
    | undefined;
  #closing = false;
  #closed = false;
  #close: Promise<void> | undefined;
  /** The graph activation {@link runWithNodeContext} binds for its work. */
  #nodeContext: JuncoAgentNodeContext | undefined;
  /** Checks each hosted `task` launch before admission; see {@link setTaskPolicy}. */
  #taskPolicy: TaskPolicy | undefined;
  /** What graphs do with this agent's failed tasks; see {@link setTaskFailurePolicy}. */
  #taskFailurePolicy: TaskFailurePolicy = { retries: 0 };
  /** This agent's assigned batch was admitted: a host admits it at most once. */
  #taskAdmitted = false;
  /** Sees this agent's subagent acquisitions; see {@link setSubagentObserver}. */
  #subagentObserver: SubagentObserver | undefined;

  protected constructor(
    options: AgenticOptions<S, P, T>,
    owned: OwnedResources = {},
  ) {
    this.#options = options;
    this.collection = options.collection;
    this.#owned = owned;
    this.#releaseTool = options.collection?.tools.find(
      (tool) => tool.name === "release",
    );
    this.#tools = withRequiredTools(
      options.tools ?? [],
      this.#complainTool,
      this.#releaseTool,
    );
    this.#resources = options.resources ?? {};
    if (options.prompt !== undefined) {
      this.#staged = {
        text: options.prompt,
        ...(options.images === undefined ? {} : { images: options.images }),
      };
    }
    // The single borrowing site: every agent over a collection acts as its own owner.
    owned.binding ??= options.collection?.bind();
  }

  /** Complete the asynchronous native acquisition before any caller uses the agent. */
  protected async initialize(): Promise<void> {
    if (this.#harness !== undefined || this.#closing)
      throw new JuncoAgentError(
        "invalid_state",
        "JuncoAgent is already initialized",
      );
    const {
      prompt: _prompt,
      images: _images,
      tools: _tools,
      resources: _resources,
      collection: _collection,
      contract: _contract,
      activeToolNames,
      ...native
    } = this.#options;
    const requested =
      activeToolNames === undefined
        ? undefined
        : withRequiredNames(activeToolNames, this.#releaseTool);
    try {
      validateActiveTools(
        this.#tools,
        requested ?? this.#tools.map((tool) => tool.name),
      );
      const { harness, open } = await AgentHarness.create<undefined>(
        {
          ...native,
          models: this.#captureRequests(native.models),
          tools: this.#tools.map((tool) => this.#adaptTool(tool)),
          resources: this.#resources,
          activeToolNames: requested,
          toolExecution: "sequential",
        },
        BACKGROUND_CONTEXT,
      );
      this.#harness = harness;
      if (open.length > 0) {
        throw new JuncoAgentError(
          "invalid_state",
          "JuncoAgent cannot attach to an open operation",
        );
      }
      this.#lane = await harness.lane("main", BACKGROUND_CONTEXT);
      // A reopened idle lane retains its persisted selection, with no initial config_update event.
      const restored =
        await this.#nativeLane.getActiveTools(BACKGROUND_CONTEXT);
      this.#activeNames = withRequiredNames(restored, this.#releaseTool);
      validateActiveTools(this.#tools, this.#activeNames);
      if (this.#activeNames.length !== restored.length)
        await this.#nativeLane.setActiveTools(
          this.#activeNames,
          BACKGROUND_CONTEXT,
        );
      harness.events.on("entry_added", (event) => this.#onEntryAdded(event));
      harness.events.on("turn_end", (event) => this.#onTurnEnd(event));
      harness.events.on("run_end", ({ lane, runId }) => {
        if (lane === "main") this.#readyYield(this.#runForOperation(runId));
      });
      harness.hooks.on("before_request", async ({ lane, runId }) => {
        if (lane !== "main") return undefined;
        const run = this.#runForOperation(runId);
        this.#readyYield(run);
        if (run?.held !== undefined) await run.held.gate!.promise;
        return undefined;
      });
    } catch (error) {
      this.#closing = true;
      const failures: unknown[] = [];
      try {
        await (this.#harness?.close(BACKGROUND_CONTEXT) ??
          this.#options.session.close(BACKGROUND_CONTEXT));
      } catch (failure) {
        failures.push(failure);
      }
      failures.push(...(await releaseOwned(this.#owned)));
      this.#closed = true;
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          "JuncoAgent initialization cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  get events(): AgentHarness<undefined>["events"] {
    return this.#harness!.events;
  }
  get hooks(): AgentHarness<undefined>["hooks"] {
    return this.#harness!.hooks;
  }
  get status(): AgenticStatus {
    if (this.#closing) return "closed";
    if (this.#boundaries.length > 0) return "pending";
    if (this.#held.length > 0) return "suspended";
    if (this.#operations.size > 0) return "running";
    return this.#staged === undefined ? "idle" : "ready";
  }

  /**
   * `models` with `streamSimple` giving each request's system prompt {@link RELEASE_INSTRUCTION}
   * (once; the supplied context is never mutated) and snapshotting that outgoing request of the
   * current run, after every native context hook and provider conversion. `completeSimple`
   * (compaction and summaries) goes through the same wrapper. Other members pass through.
   */
  #captureRequests(models: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, supplied, options) => {
      const prompt = supplied.systemPrompt ?? "";
      const context = prompt.includes(RELEASE_INSTRUCTION)
        ? supplied
        : {
            ...supplied,
            systemPrompt:
              prompt === ""
                ? RELEASE_INSTRUCTION
                : `${prompt}\n\n${RELEASE_INSTRUCTION}`,
          };
      const run = this.#currentRun;
      if (run !== undefined) {
        try {
          run.prompt = structuredClone(context);
          run.promptCaptureError = undefined;
        } catch (error) {
          run.prompt = undefined;
          run.promptCaptureError = error;
        }
      }
      return models.streamSimple(model, context, options);
    };
    const completeSimple: Models["completeSimple"] = (
      model,
      context,
      options,
    ) => streamSimple(model, context, options).result();
    const bound = new Map<unknown, unknown>();
    return new Proxy(models, {
      get: (target, key) => {
        if (key === "streamSimple") return streamSimple;
        if (key === "completeSimple") return completeSimple;
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        let method = bound.get(value);
        if (method === undefined) {
          method = value.bind(target);
          bound.set(value, method);
        }
        return method;
      },
    });
  }

  #adaptTool(tool: AgentTool): AgentHarnessTool<undefined> {
    const { execute: _execute, prepareArguments, ...fields } = tool;
    return {
      ...fields,
      ...(prepareArguments === undefined
        ? {}
        : { prepareArguments: prepareArguments.bind(tool) }),
      execute: async (
        id,
        params,
        onUpdate,
        _toolContext,
        invocation,
        context,
      ) => {
        const run = this.#runForOperation(invocation.operationId);
        const signal = context.abortSignal;
        if (run === undefined || signal === undefined) {
          throw new JuncoAgentError(
            "invalid_state",
            "Tool invocation has no admitted run or native gate signal",
          );
        }
        this.#runsByToolSignal.set(signal, run);
        if (isYieldTool(tool)) run.batch?.executedYields.set(id, tool);
        try {
          const node = this.#nodeContext;
          const host = node?.task;
          if (host !== undefined && isTaskTool(tool)) {
            const assigned = isAssignedTaskTool(tool);
            return await invokeTaskTool(
              tool,
              async (toolCallId, input, admission) => {
                if ("action" in input)
                  return host(toolCallId, input, admission);
                if (assigned && this.#taskAdmitted)
                  throw new Error(
                    "Task batch already admitted; wait for its results.",
                  );
                this.#taskPolicy?.(input);
                // `task` runs sequentially, so no second launch overlaps this admission.
                const handles = await host(toolCallId, input, admission);
                // Committed before the receipt is checked: a fulfilled host admitted children.
                if (assigned) this.#taskAdmitted = true;
                return handles;
              },
              id,
              params as TaskCall,
              signal,
            );
          }
          const messaging = node?.messaging;
          if (messaging !== undefined) {
            // Each agent's own bound node, whatever host a shared tool was constructed with.
            if (RecvTool.is(tool))
              return await RecvTool.invoke(
                tool,
                messaging,
                id,
                params as Parameters<typeof RecvTool.invoke>[3],
                signal,
              );
            if (SendTool.is(tool))
              return await SendTool.invoke(
                tool,
                messaging,
                id,
                params as Parameters<typeof SendTool.invoke>[3],
                signal,
              );
            if (InfoTool.is(tool))
              return await InfoTool.invoke(
                tool,
                messaging,
                id,
                params as Parameters<typeof InfoTool.invoke>[3],
                signal,
              );
          }
          if (isComplainTool(tool)) {
            if (run.prompt === undefined)
              throw new JuncoAgentError(
                "invalid_state",
                "Cannot record complaint: model request snapshot unavailable",
                { cause: run.promptCaptureError },
              );
            const bound = node?.complaint ?? {
              nodeId: this.nodeId,
              messages: [],
            };
            return await invokeComplainTool(
              tool,
              this,
              { ...bound, prompt: run.prompt },
              id,
              params as Parameters<typeof invokeComplainTool>[4],
              signal,
            );
          }
          // This agent's own owner-bound counterpart of a collection tool.
          return await (this.#owned.binding?.tools.get(tool) ?? tool).execute(
            id,
            params,
            signal,
            (update) => onUpdate(update),
          );
        } catch (error) {
          if (isMarshPolicyDenied(error)) {
            run.batch?.reasons.set(id, {
              kind: "policy",
              toolCallId: id,
              toolName: tool.name,
              reason: error.message,
            });
          }
          throw error;
        }
      },
    };
  }

  #onEntryAdded(event: Extract<HarnessEvent, { type: "entry_added" }>): void {
    if (
      event.lane !== "main" ||
      event.entry.type !== "message" ||
      event.entry.message.role !== "assistant"
    )
      return;
    const run = this.#currentRun;
    if (run === undefined || run.stopping || this.#closing) return;
    const message = event.entry.message;
    const calls = message.content.filter(
      (item): item is AgentToolCall => item.type === "toolCall",
    );
    if (calls.length === 0) return;
    run.batch = { reasons: new Map(), executedYields: new Map() };
    this.observeToolBatch?.(run, message, calls);
  }

  #onTurnEnd(event: Extract<HarnessEvent, { type: "turn_end" }>): void {
    if (event.lane !== "main") return;
    const run = this.#runForOperation(event.runId);
    if (run === undefined) return;
    run.lastMessage = event.message;
    const batch = run.batch;
    run.batch = undefined;
    if (batch === undefined || run.stopping || this.#closing) return;
    for (const result of event.toolResults) {
      if (result.isError) continue;
      const tool = batch.executedYields.get(result.toolCallId);
      if (
        tool === undefined ||
        !isYieldTool(tool) ||
        tool.name !== result.toolName
      )
        continue;
      const details = result.details;
      if (
        typeof details !== "object" ||
        details === null ||
        !("reason" in details) ||
        typeof details.reason !== "string"
      )
        continue;
      batch.reasons.set(result.toolCallId, {
        kind: "tool",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        reason: details.reason,
      });
    }
    const reasons: AgenticYieldReason[] = [];
    // Source order: one boundary per completed native tool batch.
    for (const result of event.toolResults) {
      const reason = batch.reasons.get(result.toolCallId);
      if (reason !== undefined) reasons.push(reason);
    }
    if (reasons.length === 0) return;
    const boundary: Boundary = {
      step: { kind: "yield", reasons },
      run,
      gate: Promise.withResolvers<void>(),
      ready: false,
    };
    run.held = boundary;
    this.#publish(boundary);
  }

  /** The admitted run whose native operation is `operationId`, if it is still current. */
  #runForOperation(operationId: string): RunRecord | undefined {
    const run = this.#currentRun;
    return run?.operationId === operationId ? run : undefined;
  }

  #readyYield(run: RunRecord | undefined): void {
    const boundary = run?.held;
    if (boundary?.ready === false) {
      boundary.ready = true;
      this.#pump();
    }
  }

  // Subclass scheduling hooks --------------------------------------------------------------------
  /** Observe the final committed assistant tool batch before any tool effect. Must not throw. */
  protected observeToolBatch?(
    run: AgenticRun,
    message: AssistantMessage,
    toolCalls: readonly AgentToolCall[],
  ): void;
  protected validateSettlement?(
    run: AgenticRun,
    message: AssistantMessage,
  ): AssistantMessage;
  protected abortDependents(): Promise<void> | undefined {
    return undefined;
  }
  protected closeDependents(): Promise<void> | undefined {
    return undefined;
  }
  protected runForSignal(signal: AbortSignal): AgenticRun {
    const run = this.#runsByToolSignal.get(signal);
    if (run === undefined)
      throw new JuncoAgentError(
        "invalid_state",
        "Unknown JuncoAgent tool signal",
      );
    return run;
  }
  /**
   * Called immediately before every native admission (runs, compaction, navigation); throwing
   * fails that operation before any provider work.
   */
  protected beforeAdmission?(): void;

  // Run admission --------------------------------------------------------------------------------
  prompt(
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<AssistantMessage> {
    return this.#explicitRun({
      kind: "prompt",
      prompt: text,
      ...(options?.images === undefined ? {} : { images: options.images }),
    });
  }
  skill(
    name: string,
    additionalInstructions?: string,
  ): Promise<AssistantMessage> {
    return this.#explicitRun({
      kind: "skill",
      name,
      ...(additionalInstructions === undefined
        ? {}
        : { additionalInstructions }),
    });
  }
  promptFromTemplate(name: string, args?: string[]): Promise<AssistantMessage> {
    return this.#explicitRun({
      kind: "prompt_template",
      name,
      ...(args === undefined ? {} : { args }),
    });
  }
  stagePrompt(
    prompt: NonNullable<AgenticOptions<S, P, T>["prompt"]>,
    options?: { images?: ImageContent[] },
  ): void {
    if (this.#closing) throw closedError();
    if (this.#pendingCompactions > 0)
      throw new JuncoAgentError("busy", "JuncoAgent compaction is pending");
    if (this.status !== "idle" || this.#aborting || this.#demands.length > 0) {
      throw new JuncoAgentError(
        "busy",
        "JuncoAgent already has a pending prompt or run",
      );
    }
    this.#staged = {
      text: prompt,
      ...(options?.images === undefined ? {} : { images: options.images }),
    };
  }
  #explicitRun(request: RunRequest): Promise<AssistantMessage> {
    if (this.#closing) return Promise.reject(closedError());
    if (this.#pendingCompactions > 0) {
      return Promise.reject(
        new JuncoAgentError("busy", "JuncoAgent compaction is pending"),
      );
    }
    if (
      this.#staged !== undefined ||
      this.#aborting ||
      this.#currentRun !== undefined
    ) {
      return Promise.reject(
        new JuncoAgentError(
          "busy",
          "JuncoAgent already has a pending prompt or run",
        ),
      );
    }
    return this.#admit(request);
  }
  #admit(request: RunRequest): Promise<AssistantMessage> {
    const run = new RunRecord(request.kind);
    this.#currentRun = run;
    const settlement = track(
      this.#operations,
      track(this.#drives, this.#driveRun(run, request)),
    );
    settlement.then(
      (message) => this.#settle(run, { kind: "settled", message }),
      (error: unknown) => this.#settle(run, { kind: "failed", error }),
    );
    return settlement;
  }
  async #driveRun(
    run: RunRecord,
    request: RunRequest,
  ): Promise<AssistantMessage> {
    this.beforeAdmission?.();
    const admitted = valueOrThrow(
      await this.#nativeLane.accept(request, run.context),
    );
    run.operationId = admitted.operationId;
    if (run.stopping || this.#closing) {
      // An abort might have seen an idle lane while accept was still pending.
      const repeat = track(
        this.#operations,
        this.#nativeLane.abort(BACKGROUND_CONTEXT),
      );
      const outcome = await repeat;
      if (!outcome.ok && outcome.error._tag !== "NoActiveOperation")
        throw outcome.error;
    }
    let result: Awaited<ReturnType<AgentLane["drive"]>>;
    try {
      result = await this.#nativeLane.drive(
        { operationId: admitted.operationId, waitForRetry: true },
        run.context,
      );
    } catch (error) {
      if (!run.stopping && !this.#closing) throw error;
      // The caller's cancelled drive waiter does not stop Pi's uncancelled native drive.
      result = await this.#nativeLane.drive(
        { operationId: admitted.operationId, waitForRetry: true },
        BACKGROUND_CONTEXT,
      );
    }
    const outcome = valueOrThrow(result);
    if (outcome.kind === "waiting") {
      if (outcome.reason === "deferred") {
        const error = new JuncoAgentError(
          "invalid_state",
          "Provider-deferred runs are not supported by Agentic",
        );
        valueOrThrow(await this.#nativeLane.abort(BACKGROUND_CONTEXT));
        throw error;
      }
      throw new JuncoAgentError(
        "invalid_state",
        "Native retry wait was not driven to settlement",
      );
    }
    if (run.lastMessage === undefined) {
      if (this.#closing) throw closedError();
      throw new JuncoAgentError(
        "invalid_state",
        outcome.outcome.error?.message ??
          `Native run ${outcome.outcome.status} without an assistant message`,
        { cause: outcome.outcome.error },
      );
    }
    return this.validateSettlement?.(run, run.lastMessage) ?? run.lastMessage;
  }
  #settle(run: RunRecord, step: AgenticStep): void {
    this.#readyYield(run);
    if (this.#currentRun === run) this.#currentRun = undefined;
    run.prompt = undefined;
    run.promptCaptureError = undefined;
    this.#publish({ step, run });
  }

  // Configuration and queue operations -----------------------------------------------------------
  #operation<R>(start: () => Promise<R>): Promise<R> {
    if (this.#closing) return Promise.reject(closedError());
    try {
      return track(this.#operations, start());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  getTools(): (T | ComplainTool)[] {
    return [...this.#tools];
  }
  getActiveTools(): (T | ComplainTool)[] {
    return this.#activeNames.map(
      (name) => this.#tools.find((tool) => tool.name === name)!,
    );
  }
  getResources(): AgentHarnessResources<S, P> {
    return this.#resources;
  }
  setResources(resources: AgentHarnessResources<S, P>): Promise<void> {
    return this.#operation(async () => {
      await this.#harness!.setResources(resources, BACKGROUND_CONTEXT);
      this.#resources = resources;
    });
  }
  #mutateTools(work: () => Promise<void>): Promise<void> {
    return this.#operation(() => {
      const pending = this.#toolMutation.then(work);
      this.#toolMutation = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    }).catch(async (error: unknown) => {
      if (!(error instanceof RollbackFailure)) throw error;
      const failures = [...error.errors];
      try {
        await error.closing;
      } catch (closeError) {
        failures.push(
          ...(closeError instanceof AggregateError
            ? closeError.errors
            : [closeError]),
        );
      }
      throw new AggregateError(failures, error.message, { cause: failures[0] });
    });
  }
  setTools(
    tools: (T | ComplainTool)[],
    activeToolNames?: string[],
  ): Promise<void> {
    const nextTools = withRequiredTools(
      tools,
      this.#complainTool,
      this.#releaseTool,
    );
    const names = withRequiredNames(
      activeToolNames ?? nextTools.map((tool) => tool.name),
      this.#releaseTool,
    );
    return this.#mutateTools(async () => {
      if (this.#closing) throw closedError();
      validateActiveTools(nextTools, names);
      const previousTools = await this.#harness!.getTools(BACKGROUND_CONTEXT);
      const previousActive =
        await this.#nativeLane.getActiveTools(BACKGROUND_CONTEXT);
      try {
        await this.#harness!.setTools(
          nextTools.map((tool) => this.#adaptTool(tool)),
          BACKGROUND_CONTEXT,
        );
        await this.#nativeLane.setActiveTools(names, BACKGROUND_CONTEXT);
      } catch (error) {
        if (this.#closing) throw error;
        const failures: unknown[] = [];
        for (const restore of [
          () => this.#harness!.setTools(previousTools, BACKGROUND_CONTEXT),
          () =>
            this.#nativeLane.setActiveTools(previousActive, BACKGROUND_CONTEXT),
        ]) {
          try {
            await restore();
          } catch (failure) {
            failures.push(failure);
          }
        }
        if (failures.length > 0) {
          // Reject the tracked mutation first: close can then join it and queued mutations.
          throw new RollbackFailure([error, ...failures], this.return());
        }
        throw error;
      }
      this.#tools = nextTools;
      this.#activeNames = names;
    });
  }
  setActiveTools(names: string[]): Promise<void> {
    const selection = withRequiredNames(names, this.#releaseTool);
    return this.#mutateTools(async () => {
      if (this.#closing) throw closedError();
      validateActiveTools(this.#tools, selection);
      await this.#nativeLane.setActiveTools(selection, BACKGROUND_CONTEXT);
      this.#activeNames = selection;
    });
  }

  // Subagents ------------------------------------------------------------------------------------
  /**
   * Run `work` with one graph activation bound: `messaging` serves this agent's recv/send/info
   * calls, `task` admits its `task` calls, and `complaint` attributes its complaints (each adds the
   * model request it arose in). Outside a binding, complaints use this agent's own {@link nodeId}
   * and no delivered messages, and graph tools fall back to their own hosts. Binding neither
   * prompts nor resumes the agent; it ends when `work` settles. Only one context binds at a time.
   */
  async runWithNodeContext<N, T, R>(
    context: JuncoAgentNodeContext<N, T>,
    work: () => Promise<R>,
  ): Promise<R> {
    if (this.#nodeContext !== undefined)
      throw new JuncoAgentError("busy", "A node context is already bound");
    this.#nodeContext = context;
    try {
      return await work();
    } finally {
      this.#nodeContext = undefined;
    }
  }

  /**
   * What this agent expects on its incoming graph edge `edgeId`, from its `contract` option. A
   * metadata query: it never starts or resumes a run. Subclasses may override it.
   */
  contract(edgeId: EdgeIdType): Contract {
    const contract = this.#options.contract;
    if (contract === undefined)
      throw new JuncoAgentError(
        "invalid_state",
        `No contract for edge "${edgeId}"`,
      );
    return contract(edgeId);
  }

  /**
   * Check every `task` launch a bound host would admit: `policy` receives the validated, detached
   * batch and throws to reject it, which the model receives as an ordinary tool error before any
   * subagent exists. Decisions about failed tasks are not launches. `undefined` removes the
   * policy. Subagents never inherit it.
   */
  setTaskPolicy(policy: TaskPolicy | undefined): void {
    this.#taskPolicy = policy;
  }

  /**
   * Replace this idle agent's genuine `task` tool, in place and keeping whether it is active, by
   * one that launches a detached copy of `input` when the model calls `task({})`. A host admits
   * that batch at most once per agent: a rejected admission may be retried, an admitted batch can
   * be neither launched again nor replaced. Subagents receive an ordinary `task` tool instead.
   */
  setTaskBatch(input: TaskInput): Promise<void> {
    if (this.#closing) return Promise.reject(closedError());
    const status = this.status;
    if (status !== "idle" && status !== "ready")
      return Promise.reject(
        new JuncoAgentError("busy", "Cannot assign a task batch while running"),
      );
    if (this.#taskAdmitted)
      return Promise.reject(
        new JuncoAgentError("invalid_state", "Task batch already admitted"),
      );
    const index = this.#tools.findIndex(({ name }) => name === "task");
    const current = this.#tools[index];
    if (current === undefined || !isTaskTool(current))
      return Promise.reject(
        new JuncoAgentError("invalid_state", "Agent has no genuine task tool"),
      );
    let assigned: T;
    try {
      assigned = new AssignedTaskTool(input) as AgentTool as T;
    } catch (cause) {
      return Promise.reject(
        new JuncoAgentError(
          "invalid_argument",
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        ),
      );
    }
    const tools = [...this.#tools];
    tools[index] = assigned;
    return this.setTools(tools, [...this.#activeNames]);
  }

  /**
   * Choose what graphs do with this agent's failed tasks, from its next admission on: `"ignore"`
   * drops a failure; `{ retries }` reruns it up to that many times and then asks this agent to
   * retry or ignore it. Default `{ retries: 0 }`. Subagents never inherit it.
   */
  setTaskFailurePolicy(policy: TaskFailurePolicy): void {
    if (policy === "ignore") {
      this.#taskFailurePolicy = policy;
      return;
    }
    const retries: unknown =
      typeof policy === "object" && policy !== null
        ? policy.retries
        : Number.NaN;
    if (
      typeof retries !== "number" ||
      !Number.isSafeInteger(retries) ||
      retries < 0
    )
      throw new JuncoAgentError(
        "invalid_argument",
        "Task retries must be a nonnegative safe integer",
      );
    this.#taskFailurePolicy = { retries };
  }

  getTaskFailurePolicy(): TaskFailurePolicy {
    const policy = this.#taskFailurePolicy;
    return policy === "ignore" ? policy : { retries: policy.retries };
  }

  /**
   * Observe every later {@link createSubagents} batch, including graph task admissions and
   * retries: `observer.acquiring` may reject a batch before acquisition, `observer.acquired` sees
   * (and may attach hooks or listeners to) each child before anything runs it. `undefined`
   * removes it. Subagents never inherit it.
   */
  setSubagentObserver(observer: SubagentObserver | undefined): void {
    this.#subagentObserver = observer;
  }

  /** Append a complete `issue` to the shared {@link issueLog}, then notify `tracer`. */
  complain<N>(
    issue: Issue<N>,
    tracer?: Pick<DataflowTracer, "complain">,
  ): void {
    if (this.#closing) throw closedError();
    issueLog.append(issue, tracer);
  }

  /** The process-wide complaint history every agent and graph shares. */
  get issueLog(): typeof issueLog {
    return issueLog;
  }

  /**
   * Fresh, unstarted agents for one task batch, in `options` order, each with its own in-memory
   * session. They inherit this agent's current model, thinking level, active tools, resources and
   * harness settings unless overridden; a tool subset can only narrow the active tools. Ordinary
   * tools are shared; each MCP definition this agent registered is reconnected for every child,
   * which exposes only the selected original tools, on this agent's collection. Each
   * child holds its own collection lease. Everything is validated before any child is created; on failure or
   * `signal` abort every created child is closed again.
   */
  createSubagents(
    options: readonly TaskAgentOptions[],
    signal?: AbortSignal,
  ): Promise<JuncoAgent<S, P, AgentTool>[]> {
    const requests = options.map(({ model, tools }) => ({
      model: model && { provider: model.provider, modelId: model.modelId },
      tools: tools && [...tools],
    }));
    return this.#operation(async () => {
      if (requests.length === 0) return [];
      const live = (): void => {
        signal?.throwIfAborted();
        if (this.#closing) throw closedError();
      };
      live();
      const observer = this.#subagentObserver;
      observer?.acquiring?.(requests);
      const lane = this.#nativeLane;
      const harness = this.#harness!;
      const models = this.#options.models;
      const active: AgentTool[] = this.getActiveTools();
      const resources = this.#resources;
      // One detached copy of every registered definition serves the whole batch.
      const registrations = (this.#owned.mcpSources ?? []).map(
        (registration) => ({
          ...registration,
          source: registration.source.snapshot(),
        }),
      );
      const inherited = await lane.getModel(BACKGROUND_CONTEXT);
      const thinkingLevel = await lane.getThinkingLevel(BACKGROUND_CONTEXT);
      const streamOptions = await harness.getStreamOptions(BACKGROUND_CONTEXT);
      const retry = await harness.getRetryPolicy(BACKGROUND_CONTEXT);
      const compaction =
        await harness.getCompactionSettings(BACKGROUND_CONTEXT);
      const steeringMode = await harness.getSteeringMode(BACKGROUND_CONTEXT);
      const followUpMode = await harness.getFollowUpMode(BACKGROUND_CONTEXT);
      live();

      type Selection = {
        readonly tool: AgentTool;
        /** The registration whose connection produced `tool`, if it is an MCP wrapper. */
        readonly mcp?: {
          readonly occurrence: number;
          readonly identity: JuncoMcpToolIdentity;
        };
      };
      const plans: { model: Model<Api>; selection: Selection[] }[] = [];
      for (const request of requests) {
        let model: Model<Api>;
        if (request.model === undefined) {
          if (inherited === undefined)
            throw new JuncoAgentError(
              "invalid_state",
              "Caller has no resolved model",
            );
          model = inherited;
        } else {
          const { provider, modelId } = request.model;
          const found = models.getModel(provider, modelId);
          if (found === undefined)
            throw new JuncoAgentError(
              "invalid_argument",
              `Model not found: ${provider}/${modelId}`,
            );
          model = found;
        }
        const label = `${model.provider}/${model.id}`;
        let auth: unknown;
        try {
          auth = await models.getAuth(model);
        } catch (cause) {
          throw new JuncoAgentError(
            "invalid_state",
            `No usable credentials for ${label}`,
            { cause },
          );
        }
        if (auth === undefined)
          throw new JuncoAgentError(
            "invalid_state",
            `No usable credentials for ${label}`,
          );
        if (!getSupportedThinkingLevels(model).includes(thinkingLevel))
          throw new JuncoAgentError(
            "invalid_argument",
            `${label} does not support thinking level ${thinkingLevel}`,
          );
        const names = request.tools ?? active.map((tool) => tool.name);
        validateActiveTools(active, names);
        const selection = names.map((name): Selection => {
          const tool = active.find((candidate) => candidate.name === name)!;
          const occurrence = registrations.findIndex(({ tools }) =>
            tools.includes(tool),
          );
          if (occurrence === -1) return { tool };
          const identity = getJuncoMcpToolIdentity(tool);
          if (identity === undefined)
            throw new JuncoAgentError(
              "invalid_argument",
              `Inherited MCP tool unavailable: ${name}`,
            );
          return { tool, mcp: { occurrence, identity } };
        });
        plans.push({ model, selection });
      }

      const children: JuncoAgent<S, P, AgentTool>[] = [];
      try {
        for (const { model, selection } of plans) {
          live();
          const owned: OwnedResources = {
            repo: new MemorySessionRepo(),
            toolCollection: this.collection,
          };
          let session: Session | undefined;
          let child: JuncoAgent<S, P, AgentTool>;
          try {
            session = await owned.repo!.create({}, BACKGROUND_CONTEXT);
            for (const { source, cwd } of registrations)
              await resolveToolSources(source, cwd, owned, signal);
            live();
            // Rebind each selected MCP tool to the one fresh wrapper of the same operation; an
            // assigned batch belongs to this agent, so a child gets an ordinary task tool.
            const tools = selection.map(({ tool, mcp }) => {
              if (mcp === undefined)
                return isAssignedTaskTool(tool) ? new TaskTool() : tool;
              const { serverName, originalToolName } = mcp.identity;
              const fresh = owned.mcpSources![mcp.occurrence]!.tools.filter(
                (candidate) => {
                  const identity = getJuncoMcpToolIdentity(candidate);
                  return (
                    identity?.serverName === serverName &&
                    identity.originalToolName === originalToolName
                  );
                },
              );
              if (fresh.length !== 1)
                throw new JuncoAgentError(
                  "invalid_argument",
                  `Inherited MCP tool unavailable: ${tool.name}`,
                );
              return fresh[0]!;
            });
            const activeToolNames = tools.map((tool) => tool.name);
            validateActiveTools(tools, activeToolNames);
            child = new JuncoAgent<S, P, AgentTool>(
              {
                session,
                models,
                model,
                collection: owned.toolCollection,
                thinkingLevel,
                systemPrompt: this.#options.systemPrompt,
                toProviderMessages: this.#options.toProviderMessages,
                entryProjectors: this.#options.entryProjectors,
                streamOptions,
                retry,
                compaction,
                steeringMode,
                followUpMode,
                tools,
                activeToolNames,
                resources,
              },
              owned,
            );
          } catch (error) {
            // Awaited here, so a rejection reaches the batch rollback of earlier children.
            return await failBeforeConstruction(
              error,
              session,
              owned,
              "JuncoAgent subagent cleanup failed",
            );
          }
          // Once constructed, initialize() owns its own failure cleanup.
          await child.initialize();
          children.push(child);
        }
        for (const [index, child] of children.entries())
          observer?.acquired?.(child, index);
        live();
        return children;
      } catch (error) {
        const failures: unknown[] = [];
        for (const child of children) {
          try {
            await child.return();
          } catch (failure) {
            failures.push(failure);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(
            [error, ...failures],
            "JuncoAgent.createSubagents cleanup failed",
            { cause: error },
          );
        throw error;
      }
    });
  }
  steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    return this.#operation(async () => {
      valueOrThrow(
        await this.#nativeLane.steer(text, options?.images, BACKGROUND_CONTEXT),
      );
    });
  }
  followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    return this.#operation(async () => {
      valueOrThrow(
        await this.#nativeLane.followUp(
          text,
          options?.images,
          BACKGROUND_CONTEXT,
        ),
      );
    });
  }
  nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    return this.#operation(async () => {
      valueOrThrow(
        await this.#nativeLane.nextRun(
          text,
          options?.images,
          BACKGROUND_CONTEXT,
        ),
      );
    });
  }
  appendMessage(message: AgentMessage): Promise<void> {
    return this.#operation(async () => {
      await this.#nativeLane.appendMessage(message, BACKGROUND_CONTEXT);
    });
  }
  setModel(model: ModelIdentity): Promise<void> {
    return this.#operation(() =>
      this.#nativeLane.setModel(model, BACKGROUND_CONTEXT),
    );
  }
  getModel(): Promise<Model<Api> | undefined> {
    return this.#operation(() => this.#nativeLane.getModel(BACKGROUND_CONTEXT));
  }
  setThinkingLevel(level: ThinkingLevel): Promise<void> {
    return this.#operation(() =>
      this.#nativeLane.setThinkingLevel(level, BACKGROUND_CONTEXT),
    );
  }
  getThinkingLevel(): Promise<ThinkingLevel> {
    return this.#operation(() =>
      this.#nativeLane.getThinkingLevel(BACKGROUND_CONTEXT),
    );
  }
  setStreamOptions(options: AgentHarnessStreamOptions): Promise<void> {
    return this.#operation(() =>
      this.#harness!.setStreamOptions(options, BACKGROUND_CONTEXT),
    );
  }
  setSteeringMode(mode: QueueMode): Promise<void> {
    return this.#operation(() =>
      this.#harness!.setSteeringMode(mode, BACKGROUND_CONTEXT),
    );
  }
  setFollowUpMode(mode: QueueMode): Promise<void> {
    return this.#operation(() =>
      this.#harness!.setFollowUpMode(mode, BACKGROUND_CONTEXT),
    );
  }
  context_size(): Promise<number> {
    return this.#operation(async () => {
      // Newest-first stops at the latest compaction; reversed, it is the context's chronology.
      const entries = await this.#nativeLane.findEntries(
        { stopAtType: "compaction", order: "newestFirst" },
        BACKGROUND_CONTEXT,
      );
      entries.reverse();
      const messages: AgentMessage[] = [];
      let compactedPrefix = 0;
      for (const entry of entries) {
        switch (entry.type) {
          case "message":
            if (isContextMessage(entry.message)) messages.push(entry.message);
            break;
          case "compaction":
            messages.push(
              createCompactionSummaryMessage(
                entry.summary,
                entry.tokensBefore,
                entry.timestamp,
              ),
              ...entry.retainedTail.filter(isContextMessage),
            );
            compactedPrefix = messages.length;
            break;
          case "branch_summary":
            if (entry.summary)
              messages.push(
                createBranchSummaryMessage(
                  entry.summary,
                  entry.fromId,
                  entry.timestamp,
                ),
              );
            break;
          case "custom": {
            const projector = this.#options.entryProjectors?.[entry.customType];
            if (projector !== undefined)
              messages.push(
                ...((await projector(entry, BACKGROUND_CONTEXT)) ?? []),
              );
            break;
          }
        }
      }
      const estimate = estimateContextTokens(messages);
      // Usage retained across a compaction measured the pre-compaction context: estimate instead.
      if (
        estimate.lastUsageIndex !== null &&
        estimate.lastUsageIndex < compactedPrefix
      ) {
        return messages.reduce(
          (tokens, message) => tokens + estimateTokens(message),
          0,
        );
      }
      return estimate.tokens;
    });
  }
  compact(options?: { customInstructions?: string }): Promise<void> {
    const customInstructions = options?.customInstructions;
    return this.#operation(() => {
      this.#pendingCompactions++;
      const job = this.#compactionTail
        .then(() => this.#compactWhenIdle(customInstructions))
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
  async #compactWhenIdle(
    customInstructions: string | undefined,
  ): Promise<void> {
    if (this.#closing) throw closedError();
    // Runs admitted before this request finish first; new runs are busy while it is pending.
    await Promise.allSettled([...this.#drives]);
    if (this.#closing) throw closedError();
    await this.#nativeLane.waitForIdle(BACKGROUND_CONTEXT);
    if (this.#closing) throw closedError();
    // Structural admission and drive only: Pi's compact() wrapper would also start queued input.
    this.beforeAdmission?.();
    const admission = await this.#nativeLane.accept(
      {
        kind: "compaction",
        ...(customInstructions === undefined ? {} : { customInstructions }),
      },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) {
      if (this.#closing) throw closedError();
      if (admission.error._tag === "NothingToCompact") return;
      throw admission.error;
    }
    const result = await this.#driveStructural(admission.value.operationId);
    // Close takes precedence over the outcome of an operation it interrupted or raced.
    if (this.#closing) throw closedError();
    const driven = valueOrThrow(result);
    if (driven.kind !== "settled")
      throw new JuncoAgentError(
        "invalid_state",
        "Native compaction did not settle",
      );
    const { outcome } = driven;
    if (outcome.status !== "completed") {
      throw new JuncoAgentError(
        "invalid_state",
        outcome.error?.message ?? `Native compaction ${outcome.status}`,
        {
          cause: outcome.error,
        },
      );
    }
  }
  /** Drive an accepted structural operation to its native terminal, repeating close's abort if needed. */
  async #driveStructural(
    operationId: string,
  ): Promise<Awaited<ReturnType<AgentLane["drive"]>>> {
    if (this.#closing) {
      // Close's native abort might have seen an idle lane while accept was still pending.
      const repeat = await this.#nativeLane.abort(BACKGROUND_CONTEXT);
      if (!repeat.ok && repeat.error._tag !== "NoActiveOperation")
        throw repeat.error;
    }
    return this.#nativeLane.drive(
      { operationId, waitForRetry: true },
      BACKGROUND_CONTEXT,
    );
  }
  navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      label?: string;
      customInstructions?: string;
    },
  ): Promise<NavigationResult> {
    return this.#operation(async (): Promise<NavigationResult> => {
      if (this.#pendingCompactions > 0)
        throw new JuncoAgentError("busy", "JuncoAgent compaction is pending");
      // Structural admission and drive only: Pi's navigateTree() would also start queued input.
      this.beforeAdmission?.();
      const admission = await this.#nativeLane.accept(
        {
          kind: "navigation",
          targetId,
          ...(options === undefined ? {} : { options }),
        },
        BACKGROUND_CONTEXT,
      );
      if (!admission.ok) {
        if (this.#closing) throw closedError();
        const { error } = admission;
        switch (error._tag) {
          case "LaneBusy":
          case "InvalidNavigation":
          case "UnknownTarget":
          case "Closed":
            return { ok: false, error };
          default:
            throw error;
        }
      }
      const result = await this.#driveStructural(admission.value.operationId);
      if (this.#closing) throw closedError();
      if (!result.ok && result.error._tag === "Closed")
        return { ok: false, error: result.error };
      const driven = valueOrThrow(result);
      if (driven.kind !== "settled")
        throw new JuncoAgentError(
          "invalid_state",
          "Native navigation did not settle",
        );
      return { ok: true, value: { navigation: driven.outcome } };
    });
  }

  // Cancellation ---------------------------------------------------------------------------------
  #suppressGates(run: RunRecord): void {
    const held = run.held;
    run.held = undefined;
    if (held === undefined) return;
    const unread = this.#boundaries.indexOf(held);
    if (unread !== -1) this.#boundaries.splice(unread, 1);
    const consumed = this.#held.indexOf(held);
    if (consumed !== -1) this.#held.splice(consumed, 1);
    held.gate!.resolve();
  }
  #markStopping(): void {
    const run = this.#currentRun;
    if (run === undefined) return;
    run.stopping = true;
    this.#suppressGates(run);
  }
  #cancelRuns(): void {
    this.#currentRun?.cancel(
      this.#closing
        ? closedError()
        : new JuncoAgentError("invalid_state", "JuncoAgent run was aborted"),
    );
    this.#pump();
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
  abort(): Promise<{
    readonly clearedSteer: AgentMessage[];
    readonly clearedFollowUp: AgentMessage[];
  }> {
    if (this.#closing) return Promise.reject(closedError());
    if (this.#aborting)
      return Promise.reject(
        new JuncoAgentError("busy", "JuncoAgent abort is pending"),
      );
    this.#aborting = true;
    this.#markStopping();
    const aborting = this.#nativeLane.abort(BACKGROUND_CONTEXT);
    const dependents = this.#startDependents("abort");
    this.#cancelRuns();
    const joined = (async () => {
      const failures: unknown[] = [];
      let clearedSteer: AgentMessage[] = [];
      let clearedFollowUp: AgentMessage[] = [];
      try {
        const result = await aborting;
        if (result.ok) {
          clearedSteer = result.value.steer;
          clearedFollowUp = result.value.followUp;
        } else if (result.error._tag === "NoActiveOperation") {
          const watch = await this.#nativeLane.watch(BACKGROUND_CONTEXT);
          try {
            for (const item of watch.snapshot.queues) {
              if (item.kind !== "steer" && item.kind !== "followUp") continue;
              const cancelled = valueOrThrow(
                await this.#nativeLane.cancelQueued(
                  item.entryId,
                  BACKGROUND_CONTEXT,
                ),
              );
              if (cancelled.kind !== "cancelled" || item.type !== "message")
                continue;
              if (item.kind === "steer") clearedSteer.push(item.message);
              else clearedFollowUp.push(item.message);
            }
          } finally {
            watch.unsubscribe();
          }
        } else {
          throw result.error;
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        await dependents;
      } catch (error) {
        failures.push(error);
      }
      while (this.#drives.size > 0) await Promise.allSettled([...this.#drives]);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "JuncoAgent abort failed");
      return { clearedSteer, clearedFollowUp };
    })();
    return track(
      this.#operations,
      joined.finally(() => {
        this.#aborting = false;
        this.#pump();
      }),
    );
  }

  // FIFO scheduling iterator ---------------------------------------------------------------------
  [Symbol.asyncIterator](): this {
    return this;
  }
  next(
    inputs?: ParentView<AgenticInput, AssistantMessage>,
  ): Promise<IteratorResult<AgenticStep, void>> {
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    const demand: Demand = {
      ...Promise.withResolvers<IteratorResult<AgenticStep, void>>(),
      acted: false,
      ...(inputs === undefined ? {} : { inputs }),
    };
    this.#demands.push(demand);
    this.#pump();
    return demand.promise;
  }
  #publish(boundary: Boundary): void {
    this.#boundaries.push(boundary);
    this.#pump();
  }
  #pump(): void {
    while (!this.#closing) {
      const demand = this.#demands[0];
      if (demand === undefined) return;
      const boundary = this.#boundaries[0];
      if (boundary !== undefined) {
        if (boundary.ready === false) return;
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
        held.gate!.resolve();
      } else if (this.#staged !== undefined) {
        const { text, images } = this.#staged;
        this.#staged = undefined;
        // An already-pending operation rejects this staged request through the same iterator.
        if (this.#currentRun !== undefined) {
          this.#publish({
            step: {
              kind: "failed",
              error: new JuncoAgentError(
                "busy",
                "JuncoAgent already has a run",
              ),
            },
          });
        } else {
          let prompt: string;
          try {
            prompt = stagedText(text, demand.inputs);
          } catch (error) {
            this.#publish({ step: { kind: "failed", error } });
            return;
          }
          void this.#admit({
            kind: "prompt",
            prompt,
            ...(images === undefined ? {} : { images }),
          }).catch(() => {});
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
          "JuncoAgent closed with errors",
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
    this.#markStopping();
    const aborting = this.#nativeLane.abort(BACKGROUND_CONTEXT);
    const dependents = this.#startDependents("close");
    this.#cancelRuns();
    for (const boundary of this.#held.splice(0)) boundary.gate!.resolve();
    for (let index = this.#boundaries.length - 1; index >= 0; index--) {
      const boundary = this.#boundaries[index]!;
      if (boundary.gate === undefined) continue;
      this.#boundaries.splice(index, 1);
      boundary.gate.resolve();
    }
    this.#close = this.#finishClose(aborting, dependents);
    return this.#close;
  }
  async #finishClose(
    aborting: ReturnType<AgentLane["abort"]>,
    dependents: Promise<void>,
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      const result = await aborting;
      if (!result.ok && result.error._tag !== "NoActiveOperation")
        throw result.error;
    } catch (error) {
      failures.push(error);
    }
    try {
      await dependents;
    } catch (error) {
      failures.push(error);
    }
    // A pending acceptance may start another native abort; await it and all drives before closing.
    while (this.#operations.size > 0)
      await Promise.allSettled([...this.#operations]);
    try {
      await this.#harness!.close(BACKGROUND_CONTEXT);
    } catch (error) {
      failures.push(error);
    }
    failures.push(...(await releaseOwned(this.#owned)));
    this.#closed = true;
    const failure =
      failures.length > 0
        ? new AggregateError(failures, "JuncoAgent close failed")
        : undefined;
    for (const demand of this.#demands.splice(0)) {
      const index = this.#boundaries.findIndex(
        (boundary) => boundary.gate === undefined,
      );
      if (index !== -1)
        demand.resolve({
          value: this.#boundaries.splice(index, 1)[0]!.step,
          done: false,
        });
      else if (failure !== undefined) demand.reject(failure);
      else demand.resolve({ value: undefined, done: true });
    }
    this.#boundaries.length = 0;
    if (failure !== undefined) throw failure;
  }
}
