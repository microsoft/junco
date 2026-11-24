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
  type AgentToolResult,
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
  AssistantMessageEventStream,
  ImageContent,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  assertTokenRequestAllowed,
  assertUsageAllowed,
  captureUsageContext,
  chargeTokenUsage,
  isUsageLimitError,
  NodeId,
  type NodeIdType,
  type ParentView,
  recordResourceMeasurement,
  runWithUsageContext,
  type UsageContext,
} from "dataflow-engine";
import {
  getJuncoMcpToolIdentity,
  type JuncoMcpConnection,
  type JuncoMcpToolIdentity,
  JuncoMcpTools,
} from "junco-mcp";
import {
  AssignedTaskTool,
  beginOperation,
  ComplainTool,
  type ComplaintContext,
  hasProfileOwner,
  InfoTool,
  type Issue,
  invokeComplainTool,
  invokeMemoryTool,
  isComplainTool,
  isMemoryTool,
  issueLog,
  isYieldTool,
  type ProfileOperation,
  type ProfileOutcome,
  type ProfileRecorder,
  type Prompt,
  profileOperationOf,
  profileToolCall,
  runWithRecorder,
  SendTool,
  type SendToolHost,
  type TaskCall,
  type TaskInput,
  TaskTool,
  type TaskToolHost,
  type ToolBinding,
  ToolCollection,
  trackPromise,
  YieldTool,
} from "junco-tools";
import {
  disposeThenRethrow,
  errorGraph,
  isMarshPolicyDenied,
} from "junco-tools/errors";
import { log } from "junco-tools/log";
import type { TSchema } from "typebox";
import {
  type Agentic,
  type AgenticOptions,
  type AgenticStatus,
  type AgenticStep,
  type AgenticYieldReason,
  type ErrorHandler,
  resolveStagedPrompt,
  type TaskSchema,
  type TokenMonitorConfig,
  validateActiveTools,
} from "./agentic.js";
import type { LoopGuardCall, LoopGuardVerdict } from "./loop-guard.js";
import { TaskScope } from "./tasks.js";

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
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> = Omit<AgenticOptions<S, P, T, N, V>, "tools"> & {
  readonly tools?: JuncoAgentTools<T>;
};

/** Pi login-backed model resolution and optional owned default tools for {@link JuncoAgent.create}. */
export type JuncoAgentCreateOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> = Omit<
  AgenticOptions<S, P, T, N, V>,
  "session" | "models" | "model" | "tools"
> & {
  readonly provider: string;
  readonly model: string;
  /** Reuse a Pi runtime; otherwise load Pi's saved login and model configuration. */
  readonly models?: ModelRuntime;
  /** Transferred to JuncoAgent; its harness closes the supplied session. */
  readonly session?: Session;
  /**
   * Concrete tools are caller-owned; MCP definitions are connected for, and closed with, this
   * agent. Omitted or empty tools add nothing; enabled defaults are composed during initialization.
   */
  readonly tools?: JuncoAgentTools<T>;
};

/** Per-subagent overrides of {@link JuncoAgent.createSubagents}; omitted values inherit the caller's. */
export type TaskAgentOptions = {
  readonly model?: ModelIdentity;
  /** Additional names selected from the caller; `[]` selects no inherited additions. */
  readonly tools?: readonly string[];
  /** Additional exact tool names to exclude; parent exclusions cannot be undone. */
  readonly tool_block?: readonly string[];
};

/** A task attempt's result after it entered the caller's model context. */
export type TaskResult = {
  readonly id: string;
  readonly name?: string;
  readonly attempt: number;
  readonly status: "completed" | "failed";
  readonly output: string;
  readonly stopReason: AssistantMessage["stopReason"];
  readonly error?: string;
  readonly decisionRequired?: true;
};

/**
 * What one graph activation binds while a {@link JuncoAgent} runs: outgoing routes,
 * topology for send/info, and complaint attribution.
 */
export type JuncoAgentNodeContext<N extends TSchema = TSchema> = {
  /** The host's authoritative NodeId for this activation; absence denies memory access. */
  readonly nodeId?: NodeIdType;
  readonly messaging?: SendToolHost<N> &
    NonNullable<ConstructorParameters<typeof InfoTool>[0]>;
  readonly complaint?: Omit<ComplaintContext<N>, "prompt">;
  /** The graph's own view of the profiling session; the agent records under its node ID there. */
  readonly recorder?: ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  /** This activation's final graph node ID; default the agent's own {@link JuncoAgent.nodeId}. */
  readonly recorderNodeId?: string;
};

/** Checks a hosted `task` launch before admission; throwing rejects it. See {@link JuncoAgent.setTaskPolicy}. */
export type TaskPolicy = (input: TaskInput) => void;

/**
 * What an agent does with its failed tasks: drop them silently, or run each again up to `retries` more
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
  readonly acquired?: (child: AnyJuncoAgent, index: number) => void;
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

const NATIVE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "release",
  "grep",
  "find",
  "ast_grep",
  "ast_edit",
  "diff",
  "code_graph",
] as const;

function normalizeToolBlock(
  names: readonly string[] | undefined,
): ReadonlySet<string> {
  if (names === undefined) return new Set();
  if (!Array.isArray(names))
    throw new JuncoAgentError(
      "invalid_argument",
      "tool_block must be an array of non-blank tool names",
    );
  const blocked = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || name.trim().length === 0)
      throw new JuncoAgentError(
        "invalid_argument",
        "tool_block must be an array of non-blank tool names",
      );
    if (blocked.has(name))
      throw new JuncoAgentError(
        "invalid_argument",
        `Duplicate blocked tool: ${name}`,
      );
    blocked.add(name);
  }
  return blocked;
}

function validateToolBlock(
  tools: readonly AgentTool[],
  blocked: ReadonlySet<string>,
): void {
  for (const tool of tools)
    if (blocked.has(tool.name))
      throw new JuncoAgentError(
        "invalid_argument",
        `tools and tool_block both list "${tool.name}"; remove it from either tools or tool_block`,
      );
}

async function ensureToolCollection(
  owned: OwnedResources,
  cwd: string,
): Promise<ToolCollection> {
  if (owned.toolCollection !== undefined) return owned.toolCollection;
  const collection = await ToolCollection.create(cwd);
  owned.toolCollection = collection;
  owned.collection = collection;
  return collection;
}

async function releaseOwned(owned: OwnedResources): Promise<unknown[]> {
  const failures: unknown[] = [];
  const { binding, collection, repo } = owned;
  for (const release of [
    ...[...(owned.mcp ?? [])]
      .reverse()
      .map((connection) => () => connection.close()),
    binding && (() => binding.close()),
    collection && (() => collection.close()),
    repo && (() => repo.close(BACKGROUND_CONTEXT)),
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
      if (source.size > 0) await ensureToolCollection(owned, cwd);
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

/** A monitor needs at least one threshold, and every supplied threshold positive and finite. */
function validateTokenMonitor({
  tokenThreshold,
  costThreshold,
}: TokenMonitorConfig): void {
  const thresholds = [tokenThreshold, costThreshold].filter(
    (threshold) => threshold !== undefined,
  );
  if (
    thresholds.length === 0 ||
    !thresholds.every(
      (threshold) => Number.isFinite(threshold) && threshold > 0,
    )
  )
    throw new JuncoAgentError(
      "invalid_argument",
      "tokenMonitor needs a positive finite tokenThreshold or costThreshold",
    );
}

/** Enabled defaults followed by concrete additions, preserving genuine supplied default objects. */
function withDefaultTools(
  tools: readonly AgentTool[],
  collection: ToolCollection | undefined,
  blocked: ReadonlySet<string>,
  replaced?: Set<string>,
): AgentTool[] {
  validateToolBlock(tools, blocked);
  const explicit = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (explicit.has(tool.name))
      throw new JuncoAgentError(
        "invalid_argument",
        `Duplicate tool name: ${tool.name}`,
      );
    explicit.set(tool.name, tool);
  }
  const consumed = new Set<string>();
  const result: AgentTool[] = [];
  for (const tool of collection?.tools ?? []) {
    if (blocked.has(tool.name)) continue;
    const supplied = explicit.get(tool.name);
    if (supplied !== undefined) consumed.add(tool.name);
    if (supplied !== undefined && supplied !== tool) replaced?.add(tool.name);
    result.push(supplied ?? tool);
  }
  const append = (
    name: string,
    is: (tool: AgentTool) => boolean,
    create: () => AgentTool,
  ): void => {
    if (blocked.has(name)) return;
    const supplied = explicit.get(name);
    if (supplied !== undefined) consumed.add(name);
    if (supplied !== undefined && !is(supplied)) replaced?.add(name);
    result.push(supplied ?? create());
  };
  append("task", TaskTool.is, () => new TaskTool());
  append("yield", isYieldTool, () => new YieldTool());
  append("send", SendTool.is, () => new SendTool());
  append("info", InfoTool.is, () => new InfoTool());
  result.push(...tools.filter((tool) => !consumed.has(tool.name)));
  if (collection === undefined)
    for (const tool of tools)
      if (NATIVE_TOOL_NAMES.some((name) => name === tool.name))
        replaced?.add(tool.name);
  validateActiveTools(
    result,
    result.map((tool) => tool.name),
  );
  return result;
}

/** Rebind genuine complaints and conditionally require complaint and collection release tools. */
function withRequiredTools(
  tools: readonly AgentTool[],
  own: ComplainTool,
  release: AgentTool | undefined,
  includeComplain: boolean,
  replaced?: Set<string>,
): AgentTool[] {
  const result = tools.map(
    (tool): AgentTool => (isComplainTool(tool) ? own : tool),
  );
  for (const tool of result) {
    if (tool.name === "complain" && !isComplainTool(tool))
      replaced?.add(tool.name);
    if (tool.name === "release" && tool !== release) replaced?.add(tool.name);
  }
  if (includeComplain && !result.some((tool) => tool.name === "complain"))
    result.push(own);
  if (release !== undefined && !result.some((tool) => tool.name === "release"))
    result.push(release);
  return result;
}

/** An active selection with only the enabled required tool names added. */
function withRequiredNames(
  names: readonly string[],
  includeRelease: boolean,
  includeComplain: boolean,
): string[] {
  const result = [...names];
  for (const name of [
    ...(includeComplain ? ["complain"] : []),
    ...(includeRelease ? ["release"] : []),
  ])
    if (!result.includes(name)) result.push(name);
  return result;
}

/** The text every model request's system prompt carries: team guidance, then the release rule. */
export const SYSTEM_INSTRUCTION =
  "You are an expert in a collaborative team. Work arrives as tasks: user messages ending in a `Task:` JSON line with the task's id, spec (when it counts as complete; fixed at creation), deps (its subtasks) and history (who held it before, what they were asked and what they did). Hand tasks to collaborators with the tool send: the payload is what the receiver reads, task names the received task the message comes from, and handoff states what you did. Pass that task's own spec to hand the task off; pass a different spec to create a subtask of it, recorded in its deps. Use yield if you receive a resource-in-use error or if you want to wait for other collaborators to make progress; messages from collaborators arrive as user messages when the scheduler delivers them. Summarize your work (send) to your downstream collaborator before yielding.\n\n" +
  "After you write to a file use release to relinquish ownership";

function valueOrThrow<T, E>(
  result: { ok: true; value: T } | { ok: false; error: E },
): T {
  if (!result.ok) throw result.error;
  return result.value;
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

/** One native operation's usage enforcement: the context it charges and its first budget failure. */
type UsageOwner = {
  readonly operationId: string | undefined;
  /** The caller's usage context captured at admission, used when no activation is bound. */
  readonly usage: UsageContext | undefined;
  /** The first budget failure that stopped this operation. */
  usageFailure: unknown;
  /** The one native abort request that failure started; resolves to its failure, never rejects. */
  usageAbort: Promise<unknown> | undefined;
};

/** The usage failure `error` holds: a `UsageLimitError`, or a failure latched on one of `usage`'s budgets. */
export function usageFailureIn(
  error: unknown,
  usage: UsageContext | undefined,
): unknown {
  for (const value of errorGraph(error))
    if (
      isUsageLimitError(value) ||
      usage?.budgets.some(({ failure }) => failure === value) === true
    )
      return value;
  return undefined;
}

class RunRecord implements AgenticRun, UsageOwner {
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
  held: HeldBoundary | undefined;
  /** The latest model request of this run, snapshotted at the provider boundary. */
  prompt: Prompt | undefined;
  /** Why the latest request could not be snapshotted, when it could not. */
  promptCaptureError: unknown;
  /** Records this run's one terminal outcome; undefined without a recorder. */
  finish: ((outcome: ProfileOutcome) => void) | undefined;
  usageFailure: unknown;
  usageAbort: Promise<unknown> | undefined;
  /** The tasks this run admitted natively, created by its first task request. */
  tasks: TaskScope | undefined;
  /** The first fatal task failure, which stops this run. */
  taskFailure: { readonly error: unknown } | undefined;
  /** The one native abort that failure started; resolves to its failure, never rejects. */
  taskAbort: Promise<unknown> | undefined;
  /** This run's loop-guard fold, created on its first tool result. */
  guard: ((call: LoopGuardCall) => LoopGuardVerdict | undefined) | undefined;

  constructor(
    readonly kind: AgenticRun["kind"],
    readonly usage: UsageContext | undefined,
  ) {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    this.context = context;
    this.cancel = cancel;
    this.signal = context.abortSignal;
  }
}

type BoundaryBase = {
  readonly step: AgenticStep;
  readonly run?: RunRecord;
  /** A turn_end yield becomes readable only after the complete public event has been delivered. */
  ready?: boolean;
};
/** A pause: the run resumes once `gate` resolves. */
type HeldBoundary = BoundaryBase & {
  readonly gate: PromiseWithResolvers<void>;
  /** When and where this yield was recognized, until it resumes or is suppressed. */
  waiting?: {
    readonly recorder: ProfileRecorder<"operations">;
    readonly at: number;
  };
};
type Boundary = (BoundaryBase & { readonly gate?: undefined }) | HeldBoundary;
type Demand<N extends TSchema, V> = PromiseWithResolvers<
  IteratorResult<AgenticStep, void>
> & {
  acted: boolean;
  /** The graph view this `next` carried, read only by a staged prompt function. */
  readonly inputs?: ParentView<N, V>;
};
/** Lifecycle-only storage of agents whose prompt callbacks admit different input domains. */
// biome-ignore lint/suspicious/noExplicitAny: identity-only erasure of the two input domains.
type AnyJuncoAgent = JuncoAgent<Skill, PromptTemplate, AgentTool, any, any>;
const closedError = () => new JuncoAgentError("closed", "JuncoAgent is closed");
const RUN = {
  resource: "operations",
  category: "agent",
  tool: "",
  operation: "run",
} as const;
const TURN = {
  resource: "operations",
  category: "agent",
  tool: "",
  operation: "turn",
} as const;
const HANDOFF = {
  resource: "operations",
  category: "agent",
  tool: "yield",
  operation: "handoff",
} as const;
const LOOP_GUARD = {
  resource: "operations",
  category: "agent",
  tool: "",
  operation: "loop_guard",
} as const;
const TOOL_PRUNING = {
  resource: "operations",
  category: "agent",
  tool: "",
  operation: "tool_pruning",
} as const;
/** Settled runs before a `tool_pruning` collection's never-called tools are pruned (TE `toolprune_evidence`). */
const PRUNE_AFTER = 10;
const MODEL_REQUEST = {
  resource: "tokens",
  category: "agent",
  tool: "",
  operation: "model_request",
} as const;
const MAINTENANCE_REQUEST = {
  resource: "tokens",
  category: "agent",
  tool: "",
  operation: "maintenance_request",
} as const;
const UNREGISTERED = {
  resource: "operations",
  category: "custom",
  tool: "unregistered",
  operation: "invalid",
} as const;

/** A cooperative iterator around a single native Pi lane; the native lane is never public. */
export class JuncoAgent<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
  N extends TSchema = typeof TaskSchema,
  V = AssistantMessage,
> implements Agentic<S, P, AgentTool, N, V>
{
  /**
   * Constructs over resolved concrete/MCP additions. Native defaults are acquired and composed by
   * {@link initialize}; the supplied session is transferred and closed if construction fails.
   */
  static fromResolved<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
    T extends AgentTool = AgentTool,
    N extends TSchema = typeof TaskSchema,
    V = AssistantMessage,
  >(
    options: JuncoAgentResolvedOptions<S, P, T, N, V>,
  ): Promise<JuncoAgent<S, P, T, N, V>>;
  static async fromResolved(
    options: JuncoAgentResolvedOptions<
      Skill,
      PromptTemplate,
      AgentTool,
      TSchema,
      unknown
    >,
  ): Promise<AnyJuncoAgent> {
    const { cwd, tools, collection, ...native } = options;
    const resolvedCwd = resolve(cwd ?? process.cwd());
    const owned: OwnedResources = { toolCollection: collection };
    let agent: AnyJuncoAgent;
    try {
      const additions = await resolveToolSources(tools, resolvedCwd, owned);
      agent = new JuncoAgent(
        {
          ...native,
          cwd: resolvedCwd,
          collection: owned.toolCollection,
          tools: additions,
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
    N extends TSchema = typeof TaskSchema,
    V = AssistantMessage,
  >(
    options: JuncoAgentCreateOptions<S, P, T, N, V> & { readonly tools: T[] },
  ): Promise<JuncoAgent<S, P, T, N, V>>;
  static create<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
    N extends TSchema = typeof TaskSchema,
    V = AssistantMessage,
  >(
    options: JuncoAgentCreateOptions<S, P, AgentTool, N, V>,
  ): Promise<JuncoAgent<S, P, AgentTool, N, V>>;
  static async create(
    options: JuncoAgentCreateOptions<
      Skill,
      PromptTemplate,
      AgentTool,
      TSchema,
      unknown
    >,
  ): Promise<AnyJuncoAgent> {
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
    const resolvedCwd = resolve(cwd ?? process.cwd());
    const owned: OwnedResources = { toolCollection: collection };
    let session: Session | undefined = suppliedSession;
    let agent: AnyJuncoAgent | undefined;
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
      const available = await models.getAvailable(provider);
      if (
        !available.some(
          (candidate) =>
            candidate.provider === provider && candidate.id === modelId,
        )
      ) {
        throw new JuncoAgentError(
          "invalid_argument",
          `Model not available: ${provider}/${modelId}`,
        );
      }
      if (suppliedSession === undefined) {
        owned.repo = new MemorySessionRepo();
        session = await owned.repo.create({}, BACKGROUND_CONTEXT);
      } else {
        session = suppliedSession;
      }
      const additions = await resolveToolSources(tools, resolvedCwd, owned);
      agent = new JuncoAgent(
        {
          ...native,
          cwd: resolvedCwd,
          session,
          models,
          model,
          collection: owned.toolCollection,
          tools: additions,
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

  readonly errorHandler: ErrorHandler<N, V> | undefined;
  readonly #options: AgenticOptions<S, P, T, N, V>;
  /** The immutable exact-name exclusions supplied at construction. */
  readonly #blocked: ReadonlySet<string>;
  /** The collection acquired or borrowed for this agent, if enabled defaults or MCP need one. */
  get collection(): ToolCollection | undefined {
    return this.#owned.toolCollection;
  }
  /** Policy owner of this agent's tools (`NativeResourceEvent.owner`); absent without a collection. */
  get owner(): string | undefined {
    return this.#owned.binding?.owner;
  }
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
  get #nativeHarness(): AgentHarness<undefined> {
    if (this.#harness === undefined)
      throw new JuncoAgentError(
        "invalid_state",
        "JuncoAgent harness is not initialized",
      );
    return this.#harness;
  }
  /** This agent's identity for complaints made outside a bound graph node. */
  readonly nodeId: NodeIdType = NodeId.create(`agent-${crypto.randomUUID()}`);
  /** This agent's complaint tool, present only when not blocked. */
  readonly #complainTool: ComplainTool = new ComplainTool();
  /** The enabled collection release tool, assigned during initialization. */
  #releaseTool: AgentTool | undefined;
  #tools: AgentTool[] = [];
  #activeNames: string[] = [];
  /** Calls per tool name over this agent's lifetime; evidence for `tool_pruning`. */
  readonly #toolCalls = new Map<string, number>();
  #settledRuns = 0;
  #resources: AgentHarnessResources<S, P>;
  #toolMutation: Promise<void> = Promise.resolve();
  readonly #runsByToolSignal = new WeakMap<AbortSignal, RunRecord>();
  /** The one admitted run; admission permits no second until it settles. */
  #currentRun: RunRecord | undefined;
  readonly #drives = new Set<Promise<unknown>>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #boundaries: Boundary[] = [];
  readonly #held: HeldBoundary[] = [];
  readonly #demands: Demand<N, V>[] = [];
  /** FIFO of queued compactions; never rejects, so one failure cannot poison later requests. */
  #compactionTail: Promise<void> = Promise.resolve();
  #pendingCompactions = 0;
  #aborting = false;
  #staged:
    | {
        readonly text: NonNullable<AgenticOptions<S, P, T, N, V>["prompt"]>;
        readonly images?: ImageContent[];
      }
    | undefined;
  #closing = false;
  #closed = false;
  #close: Promise<void> | undefined;
  /** The graph activation {@link runWithNodeContext} binds for its work. */
  #nodeContext: JuncoAgentNodeContext | undefined;
  /** This agent's view of its constructor recorder, used outside graph placements. */
  readonly #ownRecorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
  /** The graph placement {@link runWithNodeContext} binds. */
  #placement:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
  /** Where the latest admitted run started. */
  #runPlacement:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
  /** The bound graph placement, else this agent's own view of its `recorder` option. */
  get recorder():
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined {
    return this.#placement ?? this.#ownRecorder;
  }
  /** Where current work records: the bound placement, else the latest run's, else this agent's own. */
  #currentRecorder():
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined {
    return this.#placement ?? this.#runPlacement ?? this.#ownRecorder;
  }
  /**
   * The usage context {@link runWithNodeContext} captured for its activation. A box whose
   * `context` is undefined is bound and empty: it masks the admission context of a run.
   */
  #usagePlacement: { readonly context: UsageContext | undefined } | undefined;
  /** Explicit compactions and navigations in flight, by native operation. */
  readonly #structural = new Map<string, UsageOwner>();
  /** The accepted model request whose committed usage is charged now, and the budgets it charges. */
  #request:
    | {
        readonly operationId: string;
        readonly context: UsageContext | undefined;
      }
    | undefined;
  /** The budgets `owner`'s work charges now: the bound activation's, else its admission's. */
  #usageOf(owner: UsageOwner): UsageContext | undefined {
    const placement = this.#usagePlacement;
    return placement === undefined ? owner.usage : placement.context;
  }
  /**
   * Latch `owner`'s first usage failure and start, never awaiting, its one native abort: callers
   * run inside Pi tool execution or event delivery, which that abort's commit would wait for.
   */
  #failUsage(owner: UsageOwner, error: unknown): void {
    owner.usageFailure ??= error;
    if (owner instanceof RunRecord) {
      owner.stopping = true;
      this.#suppressGates(owner);
    }
    const { operationId } = owner;
    if (owner.usageAbort !== undefined || operationId === undefined) return;
    owner.usageAbort = this.#nativeLane
      .requestAbort(operationId, BACKGROUND_CONTEXT)
      .then(
        (result) => (result.ok ? undefined : result.error),
        (failure: unknown) => failure,
      );
  }
  /** `owner`'s usage failure after its abort settled, first in an aggregate with any distinct `failures`. */
  async #usageError(
    owner: UsageOwner,
    failures: readonly unknown[],
  ): Promise<unknown> {
    const usage = owner.usageFailure;
    const abort = await owner.usageAbort;
    const distinct = new Set(
      abort === undefined ? failures : [...failures, abort],
    );
    distinct.delete(usage);
    return distinct.size === 0
      ? usage
      : new AggregateError(
          [usage, ...distinct],
          "JuncoAgent stopped at a usage limit, and stopping failed",
          { cause: usage },
        );
  }
  /**
   * Latch `run`'s first fatal task failure and start, never awaiting, its task cleanup and one
   * native abort: callers run inside Pi hooks or task work, which that abort's commit may wait for.
   */
  #failTask(run: RunRecord, error: unknown): void {
    if (run.taskFailure !== undefined) return;
    run.taskFailure = { error };
    run.stopping = true;
    this.#suppressGates(run);
    void run.tasks?.stop(error);
    const { operationId } = run;
    if (operationId === undefined) return;
    run.taskAbort = this.#nativeLane
      .requestAbort(operationId, BACKGROUND_CONTEXT)
      .then(
        // A run that already ended has nothing left to stop.
        (result) =>
          result.ok || result.error._tag === "OperationMismatch"
            ? undefined
            : result.error,
        (failure: unknown) => failure,
      );
  }
  /** `run`'s task scope, created by its first native task request. */
  #taskScope(run: RunRecord): TaskScope {
    if (run.stopping || this.#closing)
      throw new JuncoAgentError("invalid_state", "JuncoAgent run is stopping");
    if (run.tasks === undefined) {
      run.tasks = new TaskScope(this, this.#nativeLane, (error) =>
        this.#failTask(run, error),
      );
      this.#taskResults = run.tasks.results;
    }
    return run.tasks;
  }
  /**
   * Stop and join `run`'s tasks once its native drive ended; then what the run fails with: a
   * latched task failure outranks the induced native outcome unless a usage failure stopped the
   * run, and distinct abort and cleanup failures follow. Undefined when it succeeds.
   */
  async #joinTasks(
    run: RunRecord,
    native: { readonly error: unknown } | undefined,
  ): Promise<{ readonly error: unknown } | undefined> {
    const failures: unknown[] = [];
    try {
      await run.tasks?.stop();
    } catch (error) {
      failures.push(error);
    }
    let primary = native;
    if (run.usageFailure === undefined && run.taskFailure !== undefined) {
      primary = run.taskFailure;
      const abort = await run.taskAbort;
      if (abort !== undefined) failures.unshift(abort);
    }
    if (primary === undefined)
      return failures.length === 0
        ? undefined
        : {
            error:
              failures.length === 1
                ? failures[0]
                : new AggregateError(
                    failures,
                    "JuncoAgent task cleanup failed",
                  ),
          };
    const known = new Set(errorGraph(primary.error));
    const distinct = [...new Set(failures)].filter(
      (error) => !known.has(error),
    );
    return distinct.length === 0
      ? primary
      : {
          error: new AggregateError(
            [primary.error, ...distinct],
            "JuncoAgent run failed, and stopping its tasks failed",
            { cause: primary.error },
          ),
        };
  }
  /** Checks each hosted `task` launch before admission; see {@link setTaskPolicy}. */
  #taskPolicy: TaskPolicy | undefined;
  /** What this agent does with its failed tasks; see {@link setTaskFailurePolicy}. */
  #taskFailurePolicy: TaskFailurePolicy = { retries: 0 };
  /** This agent's assigned batch was admitted: a host admits it at most once. */
  #taskAdmitted = false;
  /** Sees this agent's subagent acquisitions; see {@link setSubagentObserver}. */
  #subagentObserver: SubagentObserver | undefined;
  /** Task results delivered in the current or latest run. */
  #taskResults: readonly TaskResult[] = [];

  protected constructor(
    options: AgenticOptions<S, P, T, N, V>,
    owned: OwnedResources = {},
  ) {
    if (options.tokenMonitor !== undefined)
      validateTokenMonitor(options.tokenMonitor);
    this.#ownRecorder = options.recorder?.add_context(
      options.recorderNodeId ?? this.nodeId,
    );
    this.#blocked = normalizeToolBlock(options.tool_block);
    this.#options = options;
    this.errorHandler = options.errorHandler;
    this.#owned = owned;
    this.#owned.toolCollection ??= options.collection;
    this.#resources = options.resources ?? {};
    if (options.prompt !== undefined) {
      this.#staged = {
        text: options.prompt,
        ...(options.images === undefined ? {} : { images: options.images }),
      };
    }
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
      tools: additions = [],
      toolSource,
      resources: _resources,
      collection: _collection,
      recorder: _recorder,
      recorderNodeId: _recorderNodeId,
      tokenMonitor,
      activeToolNames,
      cwd,
      tool_block: _toolBlock,
      loopGuard,
      ...native
    } = this.#options;
    const includeComplain = !this.#blocked.has("complain");
    const replaced = new Set<string>();
    try {
      validateToolBlock(additions, this.#blocked);
      if (
        this.#owned.toolCollection === undefined &&
        NATIVE_TOOL_NAMES.some(
          (name) =>
            !this.#blocked.has(name) &&
            !additions.some((tool) => tool.name === name),
        )
      )
        await ensureToolCollection(this.#owned, resolve(cwd ?? process.cwd()));
      const collection = this.#owned.toolCollection;
      this.#releaseTool =
        collection === undefined || this.#blocked.has("release")
          ? undefined
          : collection.tools.find((tool) => tool.name === "release");
      this.#tools = withRequiredTools(
        withDefaultTools(additions, collection, this.#blocked, replaced),
        this.#complainTool,
        this.#releaseTool,
        includeComplain,
        replaced,
      );
      this.#owned.binding ??= collection?.bind(() => this.#currentRecorder());
      const requested =
        activeToolNames === undefined
          ? undefined
          : withRequiredNames(
              activeToolNames,
              this.#tools.some((tool) => tool.name === "release"),
              includeComplain,
            );
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
      // Normalize a reopened lane's persisted subset before any model request.
      const restored =
        await this.#nativeLane.getActiveTools(BACKGROUND_CONTEXT);
      const surviving = restored.filter((name) => !this.#blocked.has(name));
      this.#activeNames = withRequiredNames(
        surviving,
        this.#tools.some((tool) => tool.name === "release"),
        includeComplain,
      );
      validateActiveTools(this.#tools, this.#activeNames);
      if (
        this.#activeNames.length !== restored.length ||
        this.#activeNames.some((name, index) => name !== restored[index])
      )
        await this.#nativeLane.setActiveTools(
          this.#activeNames,
          BACKGROUND_CONTEXT,
        );
      harness.events.on("entry_added", (event) => this.#onEntryAdded(event));
      harness.events.on("turn_end", (event) => this.#onTurnEnd(event));
      harness.events.on("run_end", ({ lane, runId }) => {
        if (lane === "main") this.#readyYield(this.#runForOperation(runId));
      });
      // Task reports count as delivered only when the lane consumes their own queued entry.
      harness.events.on("message_end", ({ lane, runId, message, entryId }) => {
        if (
          lane !== "main" ||
          message.role !== "user" ||
          runId === undefined ||
          entryId === undefined
        )
          return;
        this.#runForOperation(runId)?.tasks?.messageEnded(entryId);
      });
      // Pi rereads the inbox after this hook: queued reports renew the run; otherwise it waits
      // here for unresolved tasks. Never throws (Pi isolates hook failures) nor returns a
      // follow-up (a later hook may replace it).
      harness.hooks.on("before_run_end", async ({ lane, runId }, context) => {
        if (lane !== "main") return undefined;
        const run = this.#runForOperation(runId);
        try {
          await run?.tasks?.beforeRunEnd(context.abortSignal);
        } catch (error) {
          if (run !== undefined) this.#failTask(run, error);
        }
        return undefined;
      });
      if (loopGuard !== undefined)
        harness.hooks.on(
          "after_tool",
          ({ lane, runId, toolCallId, toolName, args, content, isError }) => {
            if (lane !== "main") return undefined;
            const run = this.#runForOperation(runId);
            if (run === undefined || run.stopping || this.#closing)
              return undefined;
            run.guard ??= loopGuard.run();
            const text = content
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n");
            const verdict = run.guard({ toolName, args, text, isError });
            if (verdict === undefined) return undefined;
            if (verdict.kind === "redirect") {
              this.#currentRecorder()?.record({
                kind: "metrics",
                counters: { redirects: 1 },
                ...LOOP_GUARD,
              });
              return {
                content: [...content, { type: "text", text: verdict.text }],
              };
            }
            this.#currentRecorder()?.record({
              kind: "metrics",
              counters: { holds: 1 },
              ...LOOP_GUARD,
            });
            // `#onTurnEnd` holds the run after this batch, as for a policy denial.
            if (run.batch !== undefined && !run.batch.reasons.has(toolCallId))
              run.batch.reasons.set(toolCallId, {
                kind: "guard",
                toolCallId,
                toolName,
                reason: verdict.reason,
              });
            return undefined;
          },
        );
      // Pause before Pi drains steering and snapshots the next request.
      harness.hooks.on("after_tool_batch", async ({ lane, runId }) => {
        if (lane !== "main") return;
        const run = this.#runForOperation(runId);
        this.#readyYield(run);
        if (run?.held !== undefined) await run.held.gate.promise;
      });
      harness.hooks.on("before_request", async ({ lane, runId }) => {
        if (lane !== "main") return undefined;
        const run = this.#runForOperation(runId);
        if (run?.taskFailure !== undefined) {
          // Its abort's commit makes Pi skip this request.
          await run.taskAbort;
          return undefined;
        }
        const owner = run ?? this.#structural.get(runId);
        if (owner === undefined) return undefined;
        // Read after a held yield resumed: a resumed run charges its new activation.
        const usage = this.#usageOf(owner);
        try {
          if (owner.usageFailure !== undefined) throw owner.usageFailure;
          runWithUsageContext(usage, () => assertTokenRequestAllowed());
        } catch (error) {
          this.#failUsage(owner, error);
          // Never throw: Pi isolates hook failures. Its commit makes Pi skip this request.
          await owner.usageAbort;
          return undefined;
        }
        this.#request = { operationId: runId, context: usage };
        return undefined;
      });
      // Committed increments only: restored history never replays as a usage event. Neither
      // throws nor awaits: Pi isolates listener failures, and a joined abort would deadlock.
      harness.events.on("usage", ({ lane, row }) => {
        const request = this.#request;
        if (lane !== "main" || request === undefined) return;
        try {
          runWithUsageContext(request.context, () =>
            chargeTokenUsage(row.usage.totalTokens),
          );
        } catch (error) {
          const owner =
            this.#runForOperation(request.operationId) ??
            this.#structural.get(request.operationId);
          if (owner !== undefined) this.#failUsage(owner, error);
        }
        // Pi publishes committed rows, not estimates or totals. Use the accepted request's
        // activation even if delivery runs outside its async context.
        if (request.context?.report !== undefined && !row.adjustment) {
          recordResourceMeasurement(
            "tokens",
            row.usage.totalTokens,
            request.context,
          );
          const usd = row.usage.cost?.total;
          if (typeof usd === "number" && usd >= 0)
            recordResourceMeasurement(
              "cost",
              Math.round(usd * 1_000_000),
              request.context,
            );
        }
      });
      if (tokenMonitor !== undefined)
        await this.#monitorUsage(harness, tokenMonitor);
      if (this.#ownRecorder !== undefined)
        harness.events.on("usage", ({ row }) => {
          const recorder: ProfileRecorder<"tokens" | "cost"> | undefined =
            this.#currentRecorder();
          recorder?.record({
            resource: "tokens",
            kind: "usage",
            source: this,
            usage: row.usage,
          });
          recorder?.record({
            resource: "cost",
            kind: "usage",
            source: this,
            usage: row.usage,
          });
        });
      for (const name of replaced)
        log.info(
          toolSource
            ? `Default tool "${name}" replaced with tool declared in ${toolSource}`
            : `Default tool "${name}" replaced with explicitly supplied tool`,
        );
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

  /**
   * Reports session usage to `onThreshold` whenever tokens or dollars gained since the previous
   * report reach a threshold. The baseline moves before the callback runs, so a throwing callback
   * (isolated by Pi as a `handler_error` event) never re-reports the same growth.
   */
  async #monitorUsage(
    harness: AgentHarness<undefined>,
    {
      tokenThreshold = Infinity,
      costThreshold = Infinity,
      onThreshold,
    }: TokenMonitorConfig,
  ): Promise<void> {
    // A reopened session already carries history: report growth from here, not from zero.
    let mark = (await this.#options.session.getStats(BACKGROUND_CONTEXT)).usage;
    harness.events.on("usage", ({ totals }) => {
      const delta = {
        tokens: totals.totalTokens - mark.totalTokens,
        cost: totals.cost.total - mark.cost.total,
      };
      if (delta.tokens < tokenThreshold && delta.cost < costThreshold) return;
      mark = totals;
      onThreshold(this, totals, delta);
    });
  }

  get events(): AgentHarness<undefined>["events"] {
    return this.#nativeHarness.events;
  }
  get hooks(): AgentHarness<undefined>["hooks"] {
    return this.#nativeHarness.hooks;
  }
  get status(): AgenticStatus {
    if (this.#closing) return "closed";
    if (this.#boundaries.length > 0) return "pending";
    if (this.#held.length > 0) return "suspended";
    if (this.#operations.size > 0) return "running";
    return this.#staged === undefined ? "idle" : "ready";
  }

  /**
   * `models` with `streamSimple` giving each request's system prompt {@link SYSTEM_INSTRUCTION}
   * once, without mutating the supplied context.
   * Snapshots that outgoing request of the current run after every native context hook and provider
   * conversion. `completeSimple` (compaction and summaries) uses the same wrapper; others pass through.
   */
  #captureRequests(models: Models): Models {
    const streamSimple: Models["streamSimple"] = (model, supplied, options) => {
      const prompt = supplied.systemPrompt ?? "";
      const systemPrompt = prompt.includes(SYSTEM_INSTRUCTION)
        ? prompt
        : prompt === ""
          ? SYSTEM_INSTRUCTION
          : `${prompt}\n\n${SYSTEM_INSTRUCTION}`;
      const context =
        systemPrompt === supplied.systemPrompt
          ? supplied
          : { ...supplied, systemPrompt };
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
      const recorder: ProfileRecorder<"tokens"> | undefined =
        this.#currentRecorder();
      const finish = beginOperation(
        recorder,
        run === undefined ? MAINTENANCE_REQUEST : MODEL_REQUEST,
      );
      if (finish === undefined)
        return models.streamSimple(model, context, options);
      let stream: AssistantMessageEventStream;
      try {
        stream = models.streamSimple(model, context, options);
      } catch (error) {
        finish("error");
        throw error;
      }
      // Observes the final message without consuming the caller's iterator.
      stream.result().then(
        ({ stopReason }) =>
          finish(
            stopReason === "aborted"
              ? "cancelled"
              : stopReason === "error"
                ? "error"
                : "success",
          ),
        () => finish("error"),
      );
      return stream;
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

  /**
   * One installed adapter per original tool. Genuine messaging tools read their schemas from the
   * bound activation on every access, so one shared tool serves agents with different edges.
   */
  #adaptTool(tool: AgentTool): AgentHarnessTool<undefined> {
    const { execute: _execute, prepareArguments, ...fields } = tool;
    const adapter: AgentHarnessTool<undefined> = {
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
        this.#toolCalls.set(
          tool.name,
          (this.#toolCalls.get(tool.name) ?? 0) + 1,
        );
        // This agent's own owner-bound counterpart of a collection tool.
        const selected = this.#owned.binding?.tools.get(tool) ?? tool;
        const recorder = this.#currentRecorder();
        // Captured before any await: the activation bound now, never a stale ambient context.
        const usage = this.#usageOf(run);
        const node = this.#nodeContext;
        const dispatch = async (): Promise<AgentToolResult<unknown>> => {
          try {
            if (TaskTool.is(tool)) {
              // A tool's own explicit host, else this run's native tasks.
              const host: TaskToolHost =
                tool.host ??
                ((_toolCallId, input, admission) =>
                  this.#taskScope(run).request(input, admission, {
                    usage,
                    recorder,
                  }));
              const assigned = AssignedTaskTool.is(tool);
              return await tool.invoke(
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
            if (isMemoryTool(tool))
              return await invokeMemoryTool(
                selected,
                node?.nodeId,
                id,
                params,
                signal,
                (update) => onUpdate(update),
              );
            return await selected.execute(id, params, signal, (update) =>
              onUpdate(update),
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
        };
        try {
          // Every call reaches profileToolCall, the one admission against the usage budgets:
          // source-instrumented tools through their own wrapper, every other tool through this one.
          return await runWithUsageContext(usage, () => {
            assertUsageAllowed();
            return runWithRecorder(recorder, () =>
              hasProfileOwner(selected)
                ? dispatch()
                : profileToolCall(
                    recorder,
                    this.#toolOperation(tool),
                    signal,
                    dispatch,
                  ),
            );
          });
        } catch (error) {
          const failure = usageFailureIn(error, usage);
          // Stops the run; Pi still records this call's ordinary tool error.
          if (failure !== undefined) this.#failUsage(run, failure);
          throw error;
        }
      },
    };
    if (SendTool.is(tool)) {
      Object.defineProperty(adapter, "parameters", {
        enumerable: true,
        get: () =>
          this.#nodeContext?.messaging?.sendParameters ?? tool.parameters,
      });
    }
    return adapter;
  }

  /** Generic labels of an unmarked registered tool: genuine MCP wrappers, else custom. */
  #toolOperation(tool: AgentTool): ProfileOperation<"operations"> {
    return {
      resource: "operations",
      category: getJuncoMcpToolIdentity(tool) === undefined ? "custom" : "mcp",
      tool: tool.name,
      operation: "execute",
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
    const recorder = this.#currentRecorder();
    if (recorder !== undefined)
      for (const call of calls) {
        const tool = this.#tools.find(({ name }) => name === call.name);
        const operation =
          tool === undefined
            ? UNREGISTERED
            : (profileOperationOf(
                this.#owned.binding?.tools.get(tool) ?? tool,
                call.arguments,
              ) ?? this.#toolOperation(tool));
        recorder.record({
          kind: "metrics",
          counters: { requested: 1 },
          ...operation,
        });
      }
    this.observeToolBatch?.(run, message, calls);
  }

  #onTurnEnd(event: Extract<HarnessEvent, { type: "turn_end" }>): void {
    if (event.lane !== "main") return;
    // The turn's model and tool-result usage was charged; its next request rebinds.
    if (this.#request?.operationId === event.runId) this.#request = undefined;
    this.#currentRecorder()?.record({
      kind: "metrics",
      counters: { turns_completed: 1 },
      ...TURN,
    });
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
        ...("waitForInput" in details && details.waitForInput === true
          ? { waitForInput: true as const }
          : {}),
      });
    }
    const reasons: AgenticYieldReason[] = [];
    // Source order: one boundary per completed native tool batch.
    for (const result of event.toolResults) {
      const reason = batch.reasons.get(result.toolCallId);
      if (reason !== undefined) reasons.push(reason);
    }
    if (reasons.length === 0) return;
    const boundary: HeldBoundary = {
      step: { kind: "yield", reasons },
      run,
      gate: Promise.withResolvers<void>(),
      ready: false,
    };
    run.held = boundary;
    const recorder = this.#currentRecorder();
    if (recorder !== undefined) {
      boundary.waiting = { recorder, at: performance.now() };
      recorder.record({
        kind: "metrics",
        counters: { yield_recognized: 1 },
        ...HANDOFF,
      });
    }
    this.#publish(boundary);
  }

  /** The admitted run whose native operation is `operationId`, if it is still current. */
  #runForOperation(operationId: string): RunRecord | undefined {
    const run = this.#currentRun;
    return run?.operationId === operationId ? run : undefined;
  }

  /** Counts `boundary`'s yielded turn as `next()` receives it. */
  #handOff(boundary: HeldBoundary): void {
    const { waiting, step } = boundary;
    if (waiting === undefined || step.kind !== "yield") return;
    const tool = step.reasons.filter(({ kind }) => kind === "tool").length;
    const guard = step.reasons.filter(({ kind }) => kind === "guard").length;
    waiting.recorder.record({
      kind: "metrics",
      counters: {
        turns_yielded: 1,
        tool_yield_reasons: tool,
        guard_yield_reasons: guard,
        policy_yield_reasons: step.reasons.length - tool - guard,
      },
      ...HANDOFF,
    });
  }

  /** Ends `boundary`'s wait once: `resumed` by a later `next()`, otherwise suppressed. */
  #endWait(boundary: HeldBoundary, resumed: boolean): void {
    const waiting = boundary.waiting;
    if (waiting === undefined) return;
    boundary.waiting = undefined;
    const waited = performance.now() - waiting.at;
    waiting.recorder.record({
      kind: "metrics",
      counters: resumed
        ? { yield_resumed: 1, yield_wait_ms: waited }
        : { yield_wait_ms: waited },
      ...HANDOFF,
    });
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
    prompt: NonNullable<AgenticOptions<S, P, T, N, V>["prompt"]>,
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
    // A standalone run charges its caller's budgets; a placed run charges each activation's.
    const run = new RunRecord(
      request.kind,
      this.#usagePlacement === undefined ? captureUsageContext() : undefined,
    );
    this.#taskResults = [];
    this.#currentRun = run;
    this.#runPlacement = this.#placement ?? this.#ownRecorder;
    run.finish = beginOperation(this.#runPlacement, RUN);
    const settlement = trackPromise(
      this.#operations,
      trackPromise(this.#drives, this.#driveRun(run, request)),
    );
    settlement.then(
      (message) => this.#settle(run, { kind: "settled", message }),
      (error: unknown) => this.#settle(run, { kind: "failed", error }),
    );
    return settlement;
  }
  /**
   * The native run, then its tasks: every exit stops and joins them, so no report outlives it,
   * and a fatal task failure or required decision fails it before subclass validation.
   */
  async #driveRun(
    run: RunRecord,
    request: RunRequest,
  ): Promise<AssistantMessage> {
    let message: AssistantMessage;
    try {
      message = await this.#driveNative(run, request);
    } catch (error) {
      throw (await this.#joinTasks(run, { error }))?.error;
    }
    const failure = await this.#joinTasks(run, undefined);
    if (failure !== undefined) throw failure.error;
    return this.validateSettlement?.(run, message) ?? message;
  }
  async #driveNative(
    run: RunRecord,
    request: RunRequest,
  ): Promise<AssistantMessage> {
    await this.#pruneUnusedTools(run.context);
    this.beforeAdmission?.();
    const admitted = valueOrThrow(
      await this.#nativeLane.accept(request, run.context),
    );
    run.operationId = admitted.operationId;
    let result: Awaited<ReturnType<AgentLane["drive"]>>;
    try {
      if (run.stopping || this.#closing) {
        // An abort might have seen an idle lane while accept was still pending.
        const repeat = trackPromise(
          this.#operations,
          this.#nativeLane.abort(BACKGROUND_CONTEXT),
        );
        const outcome = await repeat;
        if (!outcome.ok && outcome.error._tag !== "NoActiveOperation")
          throw outcome.error;
      }
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
    } catch (error) {
      if (run.usageFailure !== undefined)
        throw await this.#usageError(run, [error]);
      throw error;
    } finally {
      if (this.#request?.operationId === admitted.operationId)
        this.#request = undefined;
    }
    // The budget failure is why the run stopped: it outranks the native outcome.
    if (run.usageFailure !== undefined)
      throw await this.#usageError(run, result.ok ? [] : [result.error]);
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
    return run.lastMessage;
  }
  /** From the eleventh settled run on, deactivate this agent's never-called tools of a `tool_pruning` collection (TE tool pruning). */
  #pruneUnusedTools(context: RunRecord["context"]): Promise<void> {
    const collection = this.collection;
    if (collection?.tool_pruning !== true || this.#settledRuns < PRUNE_AFTER)
      return Promise.resolve();
    // Queued like a caller's setTools/setActiveTools, never interleaved; the lane is idle before
    // `accept`, so no `#operation` wrapper (it would nest inside this run's own operation).
    const pending = this.#toolMutation.then(async () => {
      // The collection's own tools only: explicit replacements, MCP and coordination tools stay.
      const candidates = new Set(
        this.#tools
          .filter(
            (tool) =>
              tool.name !== "release" && collection.tools.includes(tool),
          )
          .map((tool) => tool.name),
      );
      const selection = this.#activeNames.filter(
        (name) => !candidates.has(name) || this.#toolCalls.has(name),
      );
      const pruned = this.#activeNames.length - selection.length;
      if (pruned === 0) return;
      validateActiveTools(this.#tools, selection);
      await this.#nativeLane.setActiveTools(selection, context);
      this.#activeNames = selection;
      this.#currentRecorder()?.record({
        kind: "metrics",
        counters: { pruned },
        ...TOOL_PRUNING,
      });
    });
    this.#toolMutation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  #settle(run: RunRecord, step: AgenticStep): void {
    if (step.kind === "settled") this.#settledRuns++;
    this.#readyYield(run);
    if (this.#currentRun === run) this.#currentRun = undefined;
    const stopReason =
      step.kind === "settled" ? step.message.stopReason : undefined;
    run.finish?.(
      run.stopping || stopReason === "aborted"
        ? "cancelled"
        : step.kind === "settled" && stopReason !== "error"
          ? "success"
          : "error",
    );
    run.prompt = undefined;
    run.promptCaptureError = undefined;
    this.#publish({ step, run });
  }

  // Configuration and queue operations -----------------------------------------------------------
  #operation<R>(start: () => Promise<R>): Promise<R> {
    if (this.#closing) return Promise.reject(closedError());
    try {
      return trackPromise(this.#operations, start());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  getTools(): AgentTool[] {
    return [...this.#tools];
  }
  getActiveTools(): AgentTool[] {
    return this.#activeNames.flatMap((name) =>
      this.#tools.filter((tool) => tool.name === name),
    );
  }
  getResources(): AgentHarnessResources<S, P> {
    return this.#resources;
  }
  setResources(resources: AgentHarnessResources<S, P>): Promise<void> {
    return this.#operation(async () => {
      await this.#nativeHarness.setResources(resources, BACKGROUND_CONTEXT);
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
  setTools(tools: AgentTool[], activeToolNames?: string[]): Promise<void> {
    const includeComplain = !this.#blocked.has("complain");
    const nextTools = withRequiredTools(
      tools,
      this.#complainTool,
      this.#releaseTool,
      includeComplain,
    );
    const names = withRequiredNames(
      activeToolNames ?? nextTools.map((tool) => tool.name),
      nextTools.some((tool) => tool.name === "release"),
      includeComplain,
    );
    return this.#mutateTools(async () => {
      if (this.#closing) throw closedError();
      validateToolBlock(tools, this.#blocked);
      validateActiveTools(nextTools, names);
      const previousTools =
        await this.#nativeHarness.getTools(BACKGROUND_CONTEXT);
      const previousActive =
        await this.#nativeLane.getActiveTools(BACKGROUND_CONTEXT);
      try {
        await this.#nativeHarness.setTools(
          nextTools.map((tool) => this.#adaptTool(tool)),
          BACKGROUND_CONTEXT,
        );
        await this.#nativeLane.setActiveTools(names, BACKGROUND_CONTEXT);
      } catch (error) {
        if (this.#closing) throw error;
        const failures: unknown[] = [];
        for (const restore of [
          () => this.#nativeHarness.setTools(previousTools, BACKGROUND_CONTEXT),
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
    const selection = withRequiredNames(
      names,
      this.#tools.some((tool) => tool.name === "release"),
      !this.#blocked.has("complain"),
    );
    return this.#mutateTools(async () => {
      if (this.#closing) throw closedError();
      validateActiveTools(this.#tools, selection);
      await this.#nativeLane.setActiveTools(selection, BACKGROUND_CONTEXT);
      this.#activeNames = selection;
    });
  }

  // Subagents ------------------------------------------------------------------------------------
  /**
   * Run `work` with one graph activation bound: `messaging` serves this agent's send/info
   * calls and `complaint` attributes its complaints (each adds the
   * model request it arose in). Outside a binding, complaints use this agent's own {@link nodeId}
   * and no delivered messages, and graph tools fall back to their own hosts. Binding neither
   * prompts nor resumes the agent; it ends when `work` settles. Only one context binds at a time.
   * The caller's usage budgets bind with it: every model request and tool call while it is bound
   * charges them, even of a run admitted in an earlier activation.
   */
  async runWithNodeContext<N extends TSchema, R>(
    context: JuncoAgentNodeContext<N>,
    work: () => Promise<R>,
  ): Promise<R> {
    if (this.#nodeContext !== undefined)
      throw new JuncoAgentError("busy", "A node context is already bound");
    const parent = context.recorder;
    // One profiling session per hierarchy: a placed agent records into the graph's session.
    if (parent !== undefined && parent.root !== this.#options.recorder?.root)
      throw new JuncoAgentError(
        "invalid_argument",
        "ProfileRecorder instance mismatch",
      );
    const placement = parent?.add_context(
      context.recorderNodeId ?? this.nodeId,
    );
    const usage = this.#usagePlacement;
    this.#nodeContext = context;
    this.#placement = placement;
    // Before `work` can release a held run.
    this.#usagePlacement = { context: captureUsageContext() };
    try {
      return await work();
    } finally {
      this.#nodeContext = undefined;
      this.#placement = undefined;
      this.#usagePlacement = usage;
    }
  }

  /**
   * Check every `task` launch this agent would admit: `policy` receives the validated, detached
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
    if (current === undefined || !TaskTool.is(current))
      return Promise.reject(
        new JuncoAgentError("invalid_state", "Agent has no genuine task tool"),
      );
    let assigned: AgentTool;
    try {
      // A context-hosted tool keeps executing through its own explicit host.
      assigned = new AssignedTaskTool(input, current.host);
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
   * Choose what this agent does with its failed tasks, from its next admission on: `"ignore"`
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
   * Task results whose reports entered this agent's context in its current or latest run; a new
   * run or an abort starts empty.
   */
  getTaskResults(): readonly TaskResult[] {
    return this.#taskResults;
  }

  /**
   * Observe every later {@link createSubagents} batch, including task admissions and
   * retries: `observer.acquiring` may reject a batch before acquisition, `observer.acquired` sees
   * (and may attach hooks or listeners to) each child before anything runs it. `undefined`
   * removes it. Subagents never inherit it.
   */
  setSubagentObserver(observer: SubagentObserver | undefined): void {
    this.#subagentObserver = observer;
  }

  /** Append a complete `issue` to the shared {@link issueLog}. */
  complain<N extends TSchema>(issue: Issue<N>): void {
    if (this.#closing) throw closedError();
    issueLog.append(issue);
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
  createSubagents<C extends TSchema = typeof TaskSchema, W = AssistantMessage>(
    options: readonly TaskAgentOptions[],
    signal?: AbortSignal,
  ): Promise<JuncoAgent<S, P, AgentTool, C, W>[]> {
    const requests = options.map(({ model, tools, tool_block }) => ({
      model: model && { provider: model.provider, modelId: model.modelId },
      tools: tools && [...tools],
      tool_block: tool_block && [...tool_block],
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
      const harness = this.#nativeHarness;
      const models = this.#options.models;
      const active: AgentTool[] = this.getActiveTools();
      const resources = this.#resources;
      const defaultNames = new Set<string>([
        ...NATIVE_TOOL_NAMES,
        ...(this.collection?.tools.map((tool) => tool.name) ?? []),
        "task",
        "yield",
        "send",
        "info",
        "complain",
      ]);
      const effective = new Map(active.map((tool) => [tool.name, tool]));
      for (const tool of this.#tools)
        if (defaultNames.has(tool.name)) effective.set(tool.name, tool);
      const candidates = withDefaultTools(
        [...effective.values()],
        this.collection,
        this.#blocked,
      );
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
      const plans: {
        model: Model<Api>;
        selection: Selection[];
        tool_block: string[];
      }[] = [];
      for (const request of requests) {
        const additionalBlock = normalizeToolBlock(request.tool_block);
        const effectiveBlock = new Set([...this.#blocked, ...additionalBlock]);
        if (request.tools !== undefined) {
          for (const name of request.tools)
            if (effectiveBlock.has(name))
              throw new JuncoAgentError(
                "invalid_argument",
                `tools and tool_block both list "${name}"; remove it from either tools or tool_block`,
              );
        }
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
        const available = candidates.filter(
          (tool) => !effectiveBlock.has(tool.name),
        );
        const names =
          request.tools ??
          active
            .map((tool) => tool.name)
            .filter((name) => !effectiveBlock.has(name));
        validateActiveTools(available, names);
        const selectedNames = new Set(names);
        const selection = available
          .filter(
            (tool) =>
              defaultNames.has(tool.name) || selectedNames.has(tool.name),
          )
          .map((tool): Selection => {
            const occurrence = registrations.findIndex(({ tools }) =>
              tools.includes(tool),
            );
            if (occurrence === -1) return { tool };
            const identity = getJuncoMcpToolIdentity(tool);
            if (identity === undefined)
              throw new JuncoAgentError(
                "invalid_argument",
                `Inherited MCP tool unavailable: ${tool.name}`,
              );
            return { tool, mcp: { occurrence, identity } };
          });
        plans.push({ model, selection, tool_block: [...effectiveBlock] });
      }

      const children: JuncoAgent<S, P, AgentTool, C, W>[] = [];
      try {
        for (const { model, selection, tool_block } of plans) {
          live();
          const repo = new MemorySessionRepo();
          const owned: OwnedResources = {
            repo,
            toolCollection: this.collection,
          };
          let session: Session | undefined;
          let child: JuncoAgent<S, P, AgentTool, C, W>;
          try {
            session = await repo.create({}, BACKGROUND_CONTEXT);
            for (const { source, cwd } of registrations)
              await resolveToolSources(source, cwd, owned, signal);
            live();
            // Rebind each selected MCP tool to the one fresh wrapper of the same operation; an
            // assigned batch belongs to this agent, so a child gets an ordinary task tool.
            const reconnected = owned.mcpSources ?? [];
            const tools = selection.map(({ tool, mcp }) => {
              if (mcp === undefined)
                return AssignedTaskTool.is(tool) ? new TaskTool() : tool;
              const { serverName, originalToolName } = mcp.identity;
              const fresh = reconnected[mcp.occurrence].tools.filter(
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
              return fresh[0];
            });
            validateActiveTools(
              tools,
              tools.map((tool) => tool.name),
            );
            child = new JuncoAgent<S, P, AgentTool, C, W>(
              {
                session,
                models,
                model,
                collection: owned.toolCollection,
                thinkingLevel,
                toolSource: this.#options.toolSource,
                systemPrompt: this.#options.systemPrompt,
                toProviderMessages: this.#options.toProviderMessages,
                entryProjectors: this.#options.entryProjectors,
                streamOptions,
                retry,
                compaction,
                steeringMode,
                followUpMode,
                tools,
                tool_block,
                resources,
                tokenMonitor: this.#options.tokenMonitor,
                recorder: this.#options.recorder,
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
        return disposeThenRethrow(
          children,
          error,
          "JuncoAgent.createSubagents cleanup failed",
        );
      }
    });
  }
  #laneResult<R, E>(
    start: () => Promise<{ ok: true; value: R } | { ok: false; error: E }>,
  ): Promise<R> {
    return this.#operation(async () => valueOrThrow(await start()));
  }
  async steer(
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<void> {
    await this.#laneResult(() =>
      this.#nativeLane.steer(text, options?.images, BACKGROUND_CONTEXT),
    );
  }
  async followUp(
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<void> {
    await this.#laneResult(() =>
      this.#nativeLane.followUp(text, options?.images, BACKGROUND_CONTEXT),
    );
  }
  async nextTurn(
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<void> {
    await this.#laneResult(() =>
      this.#nativeLane.nextRun(text, options?.images, BACKGROUND_CONTEXT),
    );
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
      this.#nativeHarness.setStreamOptions(options, BACKGROUND_CONTEXT),
    );
  }
  setSteeringMode(mode: QueueMode): Promise<void> {
    return this.#operation(() =>
      this.#nativeHarness.setSteeringMode(mode, BACKGROUND_CONTEXT),
    );
  }
  setFollowUpMode(mode: QueueMode): Promise<void> {
    return this.#operation(() =>
      this.#nativeHarness.setFollowUpMode(mode, BACKGROUND_CONTEXT),
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
    // The caller's budgets, captured before the queue: the compaction may start much later.
    const placement = this.#usagePlacement;
    const usage =
      placement === undefined ? captureUsageContext() : placement.context;
    return this.#operation(() => {
      this.#pendingCompactions++;
      const job = this.#compactionTail
        .then(() => this.#compactWhenIdle(customInstructions, usage))
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
    usage: UsageContext | undefined,
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
    const result = await this.#driveStructural(
      admission.value.operationId,
      usage,
    );
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
  /**
   * Drive an accepted structural operation to its native terminal, repeating close's abort if
   * needed. Its summary requests charge `usage` unless an activation is bound; a budget failure
   * stops it and rejects with that failure.
   */
  async #driveStructural(
    operationId: string,
    usage: UsageContext | undefined,
  ): Promise<Awaited<ReturnType<AgentLane["drive"]>>> {
    const owner: UsageOwner = {
      operationId,
      usage,
      usageFailure: undefined,
      usageAbort: undefined,
    };
    this.#structural.set(operationId, owner);
    let result: Awaited<ReturnType<AgentLane["drive"]>>;
    try {
      if (this.#closing) {
        // Close's native abort might have seen an idle lane while accept was still pending.
        const repeat = await this.#nativeLane.abort(BACKGROUND_CONTEXT);
        if (!repeat.ok && repeat.error._tag !== "NoActiveOperation")
          throw repeat.error;
      }
      result = await this.#nativeLane.drive(
        { operationId, waitForRetry: true },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      if (owner.usageFailure !== undefined)
        throw await this.#usageError(owner, [error]);
      throw error;
    } finally {
      this.#structural.delete(operationId);
      if (this.#request?.operationId === operationId) this.#request = undefined;
    }
    if (owner.usageFailure !== undefined)
      throw await this.#usageError(owner, result.ok ? [] : [result.error]);
    return result;
  }
  navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      label?: string;
      customInstructions?: string;
    },
  ): Promise<NavigationResult> {
    const placement = this.#usagePlacement;
    const usage =
      placement === undefined ? captureUsageContext() : placement.context;
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
      const result = await this.#driveStructural(
        admission.value.operationId,
        usage,
      );
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
    this.#endWait(held, false);
    held.gate.resolve();
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
    // Each started before any is awaited; joined in this order.
    const tasks = this.#currentRun?.tasks?.stop() ?? Promise.resolve();
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
        await tasks;
      } catch (error) {
        failures.push(error);
      }
      try {
        await dependents;
      } catch (error) {
        failures.push(error);
      }
      while (this.#drives.size > 0) await Promise.allSettled([...this.#drives]);
      this.#taskResults = [];
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "JuncoAgent abort failed");
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

  // FIFO scheduling iterator ---------------------------------------------------------------------
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
        if (boundary.gate !== undefined) {
          this.#held.push(boundary);
          this.#handOff(boundary);
        }
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
        this.#endWait(held, true);
        held.gate.resolve();
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
            prompt = resolveStagedPrompt(text, demand.inputs);
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
    const tasks = this.#currentRun?.tasks?.stop() ?? Promise.resolve();
    const dependents = this.#startDependents("close");
    this.#cancelRuns();
    for (const boundary of this.#held.splice(0)) {
      this.#endWait(boundary, false);
      boundary.gate.resolve();
    }
    for (let index = this.#boundaries.length - 1; index >= 0; index--) {
      const boundary = this.#boundaries[index];
      if (boundary.gate === undefined) continue;
      this.#boundaries.splice(index, 1);
      this.#endWait(boundary, false);
      boundary.gate.resolve();
    }
    this.#close = this.#finishClose(aborting, tasks, dependents);
    return this.#close;
  }
  async #finishClose(
    aborting: ReturnType<AgentLane["abort"]>,
    tasks: Promise<void>,
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
      await tasks;
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
      await this.#nativeHarness.close(BACKGROUND_CONTEXT);
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
          value: this.#boundaries.splice(index, 1)[0].step,
          done: false,
        });
      else if (failure !== undefined) demand.reject(failure);
      else demand.resolve({ value: undefined, done: true });
    }
    this.#boundaries.length = 0;
    if (failure !== undefined) throw failure;
  }
}
