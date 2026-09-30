import { resolve } from "node:path";
import {
  AgentHarness,
  AgentHarnessError,
  InMemorySessionRepo,
  type AbortResult,
  type AgentMessage,
  type AgentTool,
  type AgentToolCall,
  type ExecutionEnv,
  type NavigateTreeResult,
  type PromptTemplate,
  type QueueMode,
  type Session,
  type Skill,
  type ThinkingLevel,
  type AgentHarnessResources,
  type AgentHarnessStreamOptions,
} from "@earendil-works/pi-agent-core";
import {
  AGENTIC_INTEGRATION_REVISION,
  type AgentRunIntegration,
  type AgentRunKind,
} from "@earendil-works/pi-agent-core/agentic-integration";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { isMarshPolicyDenied } from "junco-tools/errors";
import type { ModelId, ModelProvider } from "model-auth";
import type {
  Agentic,
  AgenticOptions,
  AgenticStatus,
  AgenticStep,
  AgenticYieldReason,
} from "./agentic.js";
import { createYieldTool, isYieldTool } from "./yield-tool.js";

const REQUIRED_INTEGRATION_REVISION = "junco-agentic-integration/1";
const installedRevision: string = AGENTIC_INTEGRATION_REVISION;
if (installedRevision !== REQUIRED_INTEGRATION_REVISION) {
  throw new Error(
    `junco-agent requires the ${REQUIRED_INTEGRATION_REVISION} patch of @earendil-works/pi-agent-core@0.80.6; found ${installedRevision}`,
  );
}

/** A subclass's view of one admitted native run. */
export interface AgenticRun {
  readonly kind: AgentRunKind;
  /** The run's original native abort signal, once Pi installed its controller. */
  readonly signal: AbortSignal | undefined;
  /** Abort or terminal close was requested while this run was admitted. */
  readonly stopping: boolean;
}

/** Options of {@link JuncoAgent.create}: native configuration plus model resolution and defaults. */
export type JuncoAgentCreateOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Omit<AgenticOptions<S, P, T>, "env" | "session" | "models" | "model" | "tools"> & {
  readonly provider: ModelProvider;
  readonly model: ModelId;
  /** Caller-owned session; defaults to a fresh in-memory session. */
  readonly session?: Session;
} & (
    | {
        /** Caller-owned environment. Its tools must be explicit: default tools are local Marsh tools. */
        readonly env: ExecutionEnv;
        readonly cwd?: undefined;
        readonly tools: T[];
      }
    | {
        readonly env?: undefined;
        /** Local working directory of the owned environment and default tools; defaults to `process.cwd()`. */
        readonly cwd?: string;
        /** Explicit tools, caller-owned; omitted means an owned junco-tools collection plus `yield`. */
        readonly tools?: T[];
      }
  );

/** Resources a factory acquired for one agent; released exactly once by terminal close. */
type OwnedResources = {
  collection?: { close(): Promise<void> };
  env?: ExecutionEnv;
};

/** Attempt every owned release in order, returning each failure. */
async function releaseOwned(owned: OwnedResources): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const release of [owned.collection && (() => owned.collection!.close()), owned.env && (() => owned.env!.cleanup())]) {
    if (!release) continue;
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** Factory-created resources, handed to the constructor keyed by its exact options object. */
const factoryOwned = new WeakMap<object, OwnedResources>();

class RunRecord implements AgenticRun {
  signal: AbortSignal | undefined;
  stopping = false;
  abandoned = false;
  /** The current tool batch: its assistant message and the reasons recorded against its calls. */
  batch: { readonly message: AssistantMessage; readonly reasons: Map<string, AgenticYieldReason> } | undefined;
  /** The published yield whose gate currently holds this run. */
  held: Boundary | undefined;

  constructor(readonly kind: AgentRunKind) {}
}

type Boundary = {
  readonly step: AgenticStep;
  readonly run?: RunRecord;
  /** Present on a yield: resolving it resumes the run. */
  readonly gate?: PromiseWithResolvers<void>;
};

type Demand = PromiseWithResolvers<IteratorResult<AgenticStep, void>> & {
  /** This demand already resumed a run or started the staged prompt and now awaits a boundary. */
  acted: boolean;
};

const closedError = (): AgentHarnessError =>
  new AgentHarnessError("invalid_state", "JuncoAgent is closed");

function track<T>(pending: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  pending.add(promise);
  const settled = () => {
    pending.delete(promise);
  };
  promise.then(settled, settled);
  return promise;
}

/**
 * The pinned Pi `AgentHarness`, unchanged as the conversation/control plane, plus a cooperative
 * lifetime iterator: `next()` returns the next scheduling boundary — a voluntary `yield`, a typed
 * Marsh policy denial, or a run's native settlement — and a consumed yield holds its run before
 * the next model request until a later `next()` resumes it. `return()`/`throw()` terminally close
 * the agent and release only resources its factory created.
 */
export class JuncoAgent<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
    T extends AgentTool = AgentTool,
  >
  extends AgentHarness<S, P, T>
  implements Agentic<S, P, T>
{
  /**
   * Resolve the model through `provider`, then construct an agent owning whatever this factory
   * created: the default environment and, when `tools` is omitted, one junco-tools collection
   * (opened over `cwd`, which must lie in a Marsh seed) plus a `yield` tool. Supplied session,
   * environment and tools stay caller-owned.
   */
  static create<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
    T extends AgentTool = AgentTool,
  >(options: JuncoAgentCreateOptions<S, P, T> & { readonly tools: T[] }): Promise<JuncoAgent<S, P, T>>;
  static create<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>(
    options: JuncoAgentCreateOptions<S, P, AgentTool> & {
      readonly env?: undefined;
      readonly tools?: undefined;
    },
  ): Promise<JuncoAgent<S, P, AgentTool>>;
  static async create(options: JuncoAgentCreateOptions): Promise<JuncoAgent> {
    const { provider, model: modelId, session: suppliedSession, env: suppliedEnv, cwd, tools, ...native } =
      options;
    if (suppliedEnv !== undefined && (tools === undefined || cwd !== undefined)) {
      throw new AgentHarnessError(
        "invalid_argument",
        "JuncoAgent.create takes either a local cwd or a supplied env with explicit tools",
      );
    }
    const owned: OwnedResources = {};
    try {
      const { models, model } = await provider.resolveModel(modelId);
      const session = suppliedSession ?? (await new InMemorySessionRepo().create());
      const root = resolve(cwd ?? process.cwd());
      const env = suppliedEnv ?? (owned.env = new NodeExecutionEnv({ cwd: root }));
      let agentTools: AgentTool[] | undefined = tools;
      if (agentTools === undefined) {
        // Dynamic by design: explicit tools never load junco-tools or its native addon.
        const { ToolCollection } = await import("junco-tools");
        const collection = await ToolCollection.create(root);
        owned.collection = collection;
        agentTools = [...collection.tools, createYieldTool()];
      }
      const agentOptions = { ...native, env, session, models, model, tools: agentTools };
      factoryOwned.set(agentOptions, owned);
      return new JuncoAgent(agentOptions);
    } catch (error) {
      const failures = await releaseOwned(owned);
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures],
          "JuncoAgent.create failed and releasing its resources failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  readonly #owned: OwnedResources | undefined;
  /** Synchronous native invocation scopes; an admitted run fills the innermost one. */
  readonly #scopes: { run?: RunRecord }[] = [];
  readonly #runsBySignal = new WeakMap<AbortSignal, RunRecord>();
  /** Admitted runs whose settlement has not been published. */
  readonly #activeRuns = new Set<RunRecord>();
  /** Admitted native operation promises, runs included, until they settle. */
  readonly #operations = new Set<Promise<unknown>>();
  /** Started tool workers and update emissions, until they settle. */
  readonly #work = new Set<Promise<unknown>>();
  /** Published, unread boundaries, oldest first. */
  readonly #boundaries: Boundary[] = [];
  /** Consumed yields whose gate still holds their run, oldest first. */
  readonly #held: Boundary[] = [];
  /** Iterator demands, served strictly in order. */
  readonly #demands: Demand[] = [];
  #staged: { readonly text: string; readonly images?: ImageContent[] } | undefined;
  #closing = false;
  #closed = false;
  #close: Promise<void> | undefined;

  constructor(options: AgenticOptions<S, P, T>) {
    const { prompt, images, ...native } = options;
    super(native);
    this.#owned = factoryOwned.get(options);
    factoryOwned.delete(options);
    if (prompt !== undefined) this.#staged = images === undefined ? { text: prompt } : { text: prompt, images };
  }

  get status(): AgenticStatus {
    if (this.#closing) return "closed";
    if (this.#boundaries.length > 0) return "pending";
    if (this.#held.length > 0) return "suspended";
    if (this.#operations.size > 0 || this.#work.size > 0) return "running";
    return this.#staged !== undefined ? "ready" : "idle";
  }

  // ---------------------------------------------------------------------------------------------
  // Native run admission

  override prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
    return this.#explicitRun(() => super.prompt(text, options));
  }

  override skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
    return this.#explicitRun(() => super.skill(name, additionalInstructions));
  }

  override promptFromTemplate(name: string, args?: string[]): Promise<AssistantMessage> {
    return this.#explicitRun(() => super.promptFromTemplate(name, args));
  }

  #explicitRun(start: () => Promise<AssistantMessage>): Promise<AssistantMessage> {
    if (this.#closing) return Promise.reject(closedError());
    if (this.#staged !== undefined) {
      return Promise.reject(new AgentHarnessError("busy", "JuncoAgent initial prompt is pending"));
    }
    return this.#admit(start).settlement;
  }

  /**
   * Call a native run-starting method inside a synchronous invocation scope. Pi's integration hook
   * fills the scope before the method's first await; a call its busy guard rejects fills nothing
   * and keeps its native promise.
   */
  #admit(start: () => Promise<AssistantMessage>): { admitted: boolean; settlement: Promise<AssistantMessage> } {
    const scope: { run?: RunRecord } = {};
    this.#scopes.push(scope);
    let native: Promise<AssistantMessage>;
    try {
      native = start();
    } finally {
      this.#scopes.pop();
    }
    const run = scope.run;
    if (run === undefined) return { admitted: false, settlement: native };
    const validate = this.validateSettlement;
    const settlement =
      validate === undefined ? native : native.then((message) => validate.call(this, run, message));
    this.#operations.add(settlement);
    settlement.then(
      (message) => this.#settle(run, settlement, { kind: "settled", message }),
      (error: unknown) => this.#settle(run, settlement, { kind: "failed", error }),
    );
    return { admitted: true, settlement };
  }

  #settle(run: RunRecord, settlement: Promise<unknown>, step: AgenticStep): void {
    this.#activeRuns.delete(run);
    this.#operations.delete(settlement);
    this.#publish({ step, run });
  }

  protected override createRunIntegration(kind: AgentRunKind): AgentRunIntegration {
    const scope = this.#scopes.at(-1);
    if (scope === undefined || scope.run !== undefined) {
      throw new AgentHarnessError("invalid_state", "JuncoAgent admitted a run outside its invocation scope");
    }
    const run = new RunRecord(kind);
    scope.run = run;
    this.#activeRuns.add(run);
    return {
      controller: (signal) => {
        run.signal = signal;
        this.#runsBySignal.set(signal, run);
      },
      beforeTools: (message, toolCalls) => {
        if (run.abandoned) return;
        run.batch = { message, reasons: new Map() };
        this.observeToolBatch?.(run, message, toolCalls);
      },
      toolOutcome: (message, tool, toolCall, args, outcome) => {
        const batch = run.batch;
        if (run.abandoned || batch?.message !== message) return;
        if (outcome.ok) {
          if (!isYieldTool(tool)) return;
          const { reason } = args as { readonly reason: string };
          batch.reasons.set(toolCall.id, { kind: "tool", toolCallId: toolCall.id, toolName: toolCall.name, reason });
        } else if (isMarshPolicyDenied(outcome.error)) {
          batch.reasons.set(toolCall.id, {
            kind: "policy",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            reason: outcome.error.message,
          });
        }
      },
      track: (work) => {
        track(this.#work, work);
      },
      afterTurn: (message, toolResults) => {
        const batch = run.batch;
        run.batch = undefined;
        if (batch?.message !== message || run.abandoned || run.stopping || this.#closing) return undefined;
        const reasons = toolResults.flatMap((result) => batch.reasons.get(result.toolCallId) ?? []);
        if (reasons.length === 0) return undefined;
        const boundary: Boundary = { step: { kind: "yield", reasons }, run, gate: Promise.withResolvers<void>() };
        run.held = boundary;
        this.#publish(boundary);
        return boundary.gate!.promise;
      },
      abandoned: () => {
        run.abandoned = true;
        run.batch = undefined;
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Subclass hooks

  /** Observe one run's complete tool batch before its first tool is prepared. Must not throw. */
  protected observeToolBatch?(run: AgenticRun, message: AssistantMessage, toolCalls: readonly AgentToolCall[]): void;

  /**
   * Validate a normally settled run. When present, admitted runs return a derived promise that
   * resolves to this result (or rejects with what it throws), and the iterator observes the same
   * settlement. Absent, the native promise is returned unchanged.
   */
  protected validateSettlement?(run: AgenticRun, message: AssistantMessage): AssistantMessage;

  /**
   * Start terminal close of dependents owned by this agent. Called synchronously when terminal
   * close begins, after native abort was started; joined before owned resources are released.
   */
  protected closeDependents(): Promise<void> | undefined {
    return undefined;
  }

  /** The admitted run whose original native signal is `signal`. */
  protected runForSignal(signal: AbortSignal): AgenticRun {
    const run = this.#runsBySignal.get(signal);
    if (run === undefined) throw new AgentHarnessError("invalid_state", "Unknown JuncoAgent run signal");
    return run;
  }

  /**
   * Record `reason` as a scheduling boundary of the run owning `signal`, for its current tool
   * batch. The run pauses after that batch, ordered with other reasons by the batch's tool results.
   */
  protected requestYield(reason: AgenticYieldReason, signal: AbortSignal): void {
    const run = this.runForSignal(signal) as RunRecord;
    if (run.abandoned || run.batch === undefined) return;
    run.batch.reasons.set(reason.toolCallId, reason);
  }

  // ---------------------------------------------------------------------------------------------
  // Native control operations: rejected once terminal close began, tracked while pending

  #operation<R>(start: () => Promise<R>): Promise<R> {
    if (this.#closing) return Promise.reject(closedError());
    return track(this.#operations, start());
  }

  override steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    return this.#operation(() => super.steer(text, options));
  }

  override followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    return this.#operation(() => super.followUp(text, options));
  }

  override nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    return this.#operation(() => super.nextTurn(text, options));
  }

  override appendMessage(message: AgentMessage): Promise<void> {
    return this.#operation(() => super.appendMessage(message));
  }

  override compact(customInstructions?: string): ReturnType<AgentHarness["compact"]> {
    return this.#operation(() => super.compact(customInstructions));
  }

  override navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
  ): Promise<NavigateTreeResult> {
    return this.#operation(() => super.navigateTree(targetId, options));
  }

  override setModel(model: Parameters<AgentHarness["setModel"]>[0]): Promise<void> {
    return this.#operation(() => super.setModel(model));
  }

  override setThinkingLevel(level: ThinkingLevel): Promise<void> {
    return this.#operation(() => super.setThinkingLevel(level));
  }

  override setTools(tools: T[], activeToolNames?: string[]): Promise<void> {
    return this.#operation(() => super.setTools(tools, activeToolNames));
  }

  override setActiveTools(toolNames: string[]): Promise<void> {
    return this.#operation(() => super.setActiveTools(toolNames));
  }

  override setSteeringMode(mode: QueueMode): Promise<void> {
    return this.#operation(() => super.setSteeringMode(mode));
  }

  override setFollowUpMode(mode: QueueMode): Promise<void> {
    return this.#operation(() => super.setFollowUpMode(mode));
  }

  override setResources(resources: AgentHarnessResources<S, P>): Promise<void> {
    return this.#operation(() => super.setResources(resources));
  }

  override setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
    return this.#operation(() => super.setStreamOptions(streamOptions));
  }

  /**
   * Native abort of the currently admitted runs. Their signal is notified first, then every gate
   * they hold or would publish is released; the native promise, result and error are returned.
   */
  override abort(): Promise<AbortResult> {
    const runs = [...this.#activeRuns];
    for (const run of runs) run.stopping = true;
    const aborting = super.abort();
    for (const run of runs) this.#suppressGates(run);
    track(this.#operations, aborting);
    this.#pump();
    return aborting;
  }

  /** Release `run`'s gate and drop its unread yield: a stopping run publishes no pause. */
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

  // ---------------------------------------------------------------------------------------------
  // Scheduling iterator

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<AgenticStep, void>> {
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    const demand: Demand = { ...Promise.withResolvers<IteratorResult<AgenticStep, void>>(), acted: false };
    this.#demands.push(demand);
    this.#pump();
    return demand.promise;
  }

  #publish(boundary: Boundary): void {
    this.#boundaries.push(boundary);
    this.#pump();
  }

  /**
   * Serve demands in order. A demand takes the oldest unread boundary; with none, it resumes the
   * oldest consumed yield or starts the staged prompt, then waits. Consuming a boundary never
   * releases anything by itself.
   */
  #pump(): void {
    while (!this.#closing) {
      const demand = this.#demands[0];
      if (demand === undefined) return;
      const boundary = this.#boundaries.shift();
      if (boundary !== undefined) {
        this.#demands.shift();
        if (boundary.gate !== undefined) this.#held.push(boundary);
        demand.resolve({ value: boundary.step, done: false });
        continue;
      }
      if (demand.acted) return;
      demand.acted = true;
      const held = this.#held.shift();
      if (held !== undefined) {
        if (held.run?.held === held) held.run.held = undefined;
        held.gate!.resolve();
      } else if (this.#staged !== undefined) {
        this.#startStaged();
      }
      return;
    }
  }

  #startStaged(): void {
    const { text, images } = this.#staged!;
    this.#staged = undefined;
    const { admitted, settlement } = this.#admit(() =>
      super.prompt(text, images === undefined ? undefined : { images }),
    );
    // A native busy guard (a pending compaction, say) rejects the staged prompt at admission.
    if (!admitted) settlement.catch((error: unknown) => this.#publish({ step: { kind: "failed", error } }));
  }

  return(value?: void | PromiseLike<void>): Promise<IteratorResult<AgenticStep, void>> {
    return this.#beginClose().then(async () => ({ value: await value, done: true }));
  }

  throw(error: unknown): Promise<IteratorResult<AgenticStep, void>> {
    return this.#beginClose().then(
      () => {
        throw error;
      },
      (failure: AggregateError) => {
        throw new AggregateError([error, ...failure.errors], "JuncoAgent closed with errors", { cause: error });
      },
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.return();
  }

  /**
   * The single terminal close. Synchronously rejects new native operations, starts native abort
   * and dependent close, and releases every gate; then joins admitted operations, workers and
   * listeners before flushing session writes and releasing owned resources exactly once.
   */
  #beginClose(): Promise<void> {
    if (this.#close !== undefined) return this.#close;
    this.#closing = true;
    this.#staged = undefined;
    const runs = [...this.#activeRuns];
    for (const run of runs) run.stopping = true;
    const aborting = super.abort().then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    let dependents: Promise<{ error: unknown } | undefined> | undefined;
    try {
      dependents = this.closeDependents()?.then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      dependents = Promise.resolve({ error });
    }
    for (const run of runs) this.#suppressGates(run);
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
    aborting: Promise<{ error: unknown } | undefined>,
    dependents: Promise<{ error: unknown } | undefined> | undefined,
  ): Promise<void> {
    while (this.#operations.size > 0 || this.#work.size > 0) {
      await Promise.allSettled([...this.#operations, ...this.#work]);
    }
    const failures: unknown[] = [];
    for (const outcome of [await aborting, await dependents]) {
      if (outcome !== undefined) failures.push(outcome.error);
    }
    // Late workers from a fail-fast native settlement may outlive the abort; join them too.
    while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
    try {
      await this.flushPendingSessionWrites();
    } catch (error) {
      failures.push(error);
    }
    if (this.#owned !== undefined) failures.push(...(await releaseOwned(this.#owned)));
    this.#closed = true;
    const failure = failures.length > 0 ? new AggregateError(failures, "JuncoAgent close failed") : undefined;
    for (const demand of this.#demands.splice(0)) {
      const index = this.#boundaries.findIndex((boundary) => boundary.gate === undefined);
      if (index !== -1) {
        demand.resolve({ value: this.#boundaries.splice(index, 1)[0]!.step, done: false });
      } else if (failure !== undefined) {
        demand.reject(failure);
      } else {
        demand.resolve({ value: undefined, done: true });
      }
    }
    this.#boundaries.length = 0;
    if (failure !== undefined) throw failure;
  }
}
