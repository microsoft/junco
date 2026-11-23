import { setImmediate } from "node:timers/promises";
import {
  type AgentLane,
  BACKGROUND_CONTEXT,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import {
  NodeId,
  runWithUsageBudgets,
  runWithUsageContext,
  type UsageContext,
} from "dataflow-engine";
import {
  type ProfileRecorder,
  type TaskDecision,
  type TaskInput,
  type TaskToolDetails,
  trackPromise,
} from "junco-tools";
import { disposeThenRethrow, errorGraph } from "junco-tools/errors";
// Runtime bindings of this import are read only inside methods, never during module evaluation:
// junco-agent.ts imports this module back.
import {
  type JuncoAgent,
  JuncoAgentError,
  type TaskAgentOptions,
  type TaskFailurePolicy,
  type TaskResult,
  usageFailureIn,
} from "./junco-agent.js";

/** What a scope queues for its caller, one native follow-up each. */
export type TaskNotice =
  | (TaskResult & { readonly type: "task_result" })
  | { readonly type: "task_batch_complete"; readonly ids: readonly string[] };

/** Where an admission placed its work: the ledgers and recorder it captured. */
export type TaskPlacement = {
  readonly usage: UsageContext | undefined;
  readonly recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
};

/** The tasks one launch admitted, in admission order, and how many are not yet resolved. */
type TaskBatch = { readonly ids: readonly string[]; open: number };

/** One logical task across its attempts. */
type TaskRecord = {
  readonly id: string;
  readonly name?: string;
  readonly prompt: string;
  /** The first attempt's resolved model and active tools; every retry uses exactly these. */
  readonly selection: TaskAgentOptions;
  readonly policy: TaskFailurePolicy;
  /** Automatic retries left. */
  retries: number;
  attempt: number;
  state: "running" | "retrying" | "awaiting-decision" | "terminal";
  readonly batch: TaskBatch;
  /** The admission's placement; an explicit retry replaces it with its decision's. */
  placement: TaskPlacement;
};

/** One owned subagent run of a task. */
type Attempt = {
  /** The task ID for the first attempt, then `<taskId>:attempt:<n>`. */
  readonly id: string;
  readonly number: number;
  readonly record: TaskRecord;
  readonly child: JuncoAgent;
  readonly placement: TaskPlacement;
  /** Its scope stopped: it never reports or retries. */
  cancelled: boolean;
  closing: Promise<void> | undefined;
};

type Settlement =
  | { readonly ok: true; readonly message: AssistantMessage }
  | { readonly ok: false; readonly error: unknown };

const TASK_LIFECYCLE = {
  resource: "operations",
  category: "task",
  tool: "task",
  operation: "lifecycle",
} as const;

/**
 * The tasks one native run admitted: fresh subagents started at admission and run in the
 * background, their retries and decisions, and the reports they queue for the caller. Reports
 * count as delivered only when the caller's lane consumes their own entry.
 */
export class TaskScope {
  /** Reports that entered the caller's context, in delivery order. */
  readonly results: TaskResult[] = [];
  /** Aborted once stopping: cancels preparation, acquisitions and background resumes. */
  readonly #controller = new AbortController();
  #stopping = false;
  #stopped: Promise<void> | undefined;
  /** Every admitted task by handle ID, in admission order. */
  readonly #tasks = new Map<string, TaskRecord>();
  /** Attempts this scope owns until they are closed. */
  readonly #attempts = new Set<Attempt>();
  /** Runners, retries and notifications; none rejects. */
  readonly #work = new Set<Promise<void>>();
  /** Notifications scheduled and not yet admitted natively. */
  #inflight = 0;
  /** User entries the lane consumed while some notification's entry ID was still unknown. */
  readonly #early = new Set<string>();
  /** Admitted notifications not yet consumed, by native entry ID. */
  readonly #queued = new Map<string, TaskNotice>();
  /** Serializes admission, so reports precede their batch marker. */
  #tail: Promise<void> = Promise.resolve();
  #progress: PromiseWithResolvers<void> | undefined;

  /** Reports are queued on, and withdrawn from, the caller's `lane`; `fail` fails its run. */
  constructor(
    private readonly owner: Pick<
      JuncoAgent,
      "createSubagents" | "getTaskFailurePolicy"
    >,
    private readonly lane: Pick<AgentLane, "followUp" | "cancelQueued">,
    private readonly fail: (error: unknown) => void,
  ) {}

  /** Admits a launch or applies a decision; rejection means nothing was admitted. */
  request(
    input: TaskInput | TaskDecision,
    signal: AbortSignal,
    placement: TaskPlacement,
  ): Promise<TaskToolDetails["tasks"]> {
    return "action" in input
      ? this.#decide(input, signal, placement)
      : this.#launch(input, signal, placement);
  }

  /** The caller's lane consumed user entry `entryId`. */
  messageEnded(entryId: string): void {
    const notice = this.#queued.get(entryId);
    if (notice !== undefined) {
      this.#queued.delete(entryId);
      this.#delivered(notice);
    } else if (this.#inflight > 0) this.#early.add(entryId);
  }

  /**
   * Resolves when the caller's run may end or must replan: every notification was admitted and
   * either some is still queued, or no task is unresolved. A delivered failure still awaiting a
   * decision fails the run instead. Cancellation resolves it; it never rejects.
   */
  async beforeRunEnd(signal: AbortSignal | undefined): Promise<void> {
    while (!this.#stopping && signal?.aborted !== true) {
      if (this.#inflight === 0) {
        if (this.#queued.size > 0) return;
        const records = [...this.#tasks.values()];
        const undecided = records.filter(
          ({ state }) => state === "awaiting-decision",
        );
        if (undecided.length > 0) {
          this.fail(
            new JuncoAgentError(
              "invalid_state",
              `Task failure decisions required: ${undecided.map(({ id }) => id).join(", ")}`,
            ),
          );
          return;
        }
        if (records.every(({ state }) => state === "terminal")) return;
      }
      await this.#change(signal);
    }
  }

  /**
   * Refuse new work, cancel every attempt, then close and join all of it and withdraw reports
   * still queued. Idempotent; never awaits from inside its own work.
   */
  stop(reason?: unknown): Promise<void> {
    if (this.#stopped !== undefined) return this.#stopped;
    this.#stopping = true;
    for (const attempt of this.#attempts) attempt.cancelled = true;
    this.#changed();
    this.#stopped = this.#drain(reason);
    void this.#stopped.catch(() => {});
    return this.#stopped;
  }

  async #drain(reason: unknown): Promise<void> {
    this.#controller.abort(reason);
    const failures: unknown[] = [];
    for (const result of await Promise.allSettled(
      [...this.#attempts].map((attempt) => this.#close(attempt)),
    ))
      if (result.status === "rejected") failures.push(result.reason);
    while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
    for (const entryId of this.#queued.keys())
      try {
        const cancelled = await this.lane.cancelQueued(
          entryId,
          BACKGROUND_CONTEXT,
        );
        if (!cancelled.ok) failures.push(cancelled.error);
      } catch (error) {
        failures.push(error);
      }
    this.#queued.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Task cleanup failed");
  }

  #live(): void {
    if (this.#stopping)
      throw new JuncoAgentError("invalid_state", "Tasks are stopping");
  }

  /** Acquires and prepares every subagent, then registers and starts them all at once. */
  async #launch(
    input: TaskInput,
    signal: AbortSignal,
    placement: TaskPlacement,
  ): Promise<TaskToolDetails["tasks"]> {
    this.#live();
    const policy = this.owner.getTaskFailurePolicy();
    const admission = AbortSignal.any([signal, this.#controller.signal]);
    const children = await this.owner.createSubagents(
      input.tasks.map(({ model, tools, tool_block }) => ({
        model,
        tools,
        tool_block,
      })),
      admission,
    );
    const batch: TaskBatch = {
      ids: children.map(() => `task-${crypto.randomUUID()}`),
      open: children.length,
    };
    const records: TaskRecord[] = [];
    try {
      for (const [index, child] of children.entries()) {
        const { name, task } = input.tasks[index];
        const model = await child.getModel();
        if (model === undefined)
          throw new JuncoAgentError("invalid_state", "Subagent has no model");
        records.push({
          id: batch.ids[index],
          ...(name === undefined ? {} : { name }),
          prompt: `${input.context}\n\n${task}`,
          selection: {
            model: { provider: model.provider, modelId: model.id },
            tools: child.getActiveTools().map((tool) => tool.name),
            ...(input.tasks[index].tool_block === undefined
              ? {}
              : { tool_block: [...input.tasks[index].tool_block] }),
          },
          policy,
          retries: policy === "ignore" ? 0 : policy.retries,
          attempt: 1,
          state: "running",
          batch,
          placement,
        });
      }
      admission.throwIfAborted();
      this.#live();
    } catch (error) {
      return disposeThenRethrow(
        children,
        error,
        "Staged subagent cleanup failed",
      );
    }
    // No await from here: the whole batch is admitted, or none of it.
    for (const record of records) this.#tasks.set(record.id, record);
    const attempts = records.map((record, index) =>
      this.#own(record, children[index]),
    );
    this.#lifecycle(placement, {
      batches_admitted: 1,
      tasks_admitted: records.length,
      attempts_admitted: records.length,
    });
    for (const attempt of attempts)
      trackPromise(this.#work, this.#run(attempt));
    return records.map(({ id, name }) =>
      name === undefined ? { id } : { id, name },
    );
  }

  /** Retries or ignores a failed task awaiting the caller's decision about its current attempt. */
  async #decide(
    { action, id, attempt }: TaskDecision,
    signal: AbortSignal,
    placement: TaskPlacement,
  ): Promise<TaskToolDetails["tasks"]> {
    this.#live();
    const record = this.#tasks.get(id);
    if (record === undefined) throw new Error(`Unknown task ${id}`);
    if (record.state !== "awaiting-decision")
      throw new Error(`Task ${id} is not awaiting a decision`);
    if (attempt !== record.attempt)
      throw new Error(
        `Task ${id} awaits a decision about attempt ${record.attempt}, not ${attempt}`,
      );
    if (action === "ignore") {
      this.#resolve(record, { tasks_ignored: 1 });
      return [];
    }
    // Reserved while acquiring, so a concurrent decision cannot start a second attempt.
    record.state = "retrying";
    let next: Attempt;
    try {
      next = await this.#acquire(
        record,
        AbortSignal.any([signal, this.#controller.signal]),
        placement,
      );
    } catch (error) {
      record.state = "awaiting-decision";
      this.#changed();
      throw error;
    }
    this.#lifecycle(placement, { attempts_admitted: 1, retry_attempts: 1 });
    trackPromise(this.#work, this.#run(next));
    return [record.name === undefined ? { id } : { id, name: record.name }];
  }

  /** A fresh, owned attempt of `record` with its pinned model, tools and prompt. */
  async #acquire(
    record: TaskRecord,
    signal: AbortSignal,
    placement: TaskPlacement,
  ): Promise<Attempt> {
    const [child] = await this.owner.createSubagents(
      [record.selection],
      signal,
    );
    if (child === undefined)
      throw new JuncoAgentError("invalid_state", "No subagent acquired");
    try {
      signal.throwIfAborted();
      this.#live();
    } catch (error) {
      return disposeThenRethrow(
        [child],
        error,
        "Staged subagent cleanup failed",
      );
    }
    record.attempt += 1;
    record.state = "running";
    record.placement = placement;
    return this.#own(record, child);
  }

  #own(record: TaskRecord, child: JuncoAgent): Attempt {
    const attempt: Attempt = {
      id:
        record.attempt === 1
          ? record.id
          : `${record.id}:attempt:${record.attempt}`,
      number: record.attempt,
      record,
      child,
      placement: record.placement,
      cancelled: false,
      closing: undefined,
    };
    this.#attempts.add(attempt);
    return attempt;
  }

  #close(attempt: Attempt): Promise<void> {
    attempt.closing ??= attempt.child.return().then(() => undefined);
    return attempt.closing;
  }

  /** Runs one attempt to settlement, closes its subagent, then reports, retries or fails. */
  async #run(attempt: Attempt): Promise<void> {
    try {
      let settlement: Settlement;
      try {
        settlement = { ok: true, message: await this.#execute(attempt) };
      } catch (error) {
        settlement = { ok: false, error };
      }
      let cleanup: { readonly error: unknown } | undefined;
      try {
        await this.#close(attempt);
      } catch (error) {
        cleanup = { error };
      }
      this.#attempts.delete(attempt);
      if (attempt.cancelled || this.#stopping) return;
      // A teardown failure is no task outcome: it fails the caller, even under "ignore".
      // Closing a faulted agent rethrows the fault that failed it: no separate cleanup failure.
      let added = settlement.ok;
      if (cleanup !== undefined && !settlement.ok) {
        const seen = new Set(errorGraph(settlement.error));
        const pending = [cleanup.error];
        while (!added && pending.length > 0) {
          const value = pending.pop();
          if (seen.has(value)) continue;
          seen.add(value);
          if (value instanceof AggregateError) pending.push(...value.errors);
          else added = true;
        }
      }
      if (cleanup !== undefined && added) {
        this.fail(
          settlement.ok
            ? cleanup.error
            : new AggregateError(
                [settlement.error, cleanup.error],
                "Task subagent execution and cleanup failed",
                { cause: settlement.error },
              ),
        );
        return;
      }
      // An exhausted usage budget is no task failure: never a retry or ignore decision.
      if (
        !settlement.ok &&
        usageFailureIn(settlement.error, attempt.placement.usage) !== undefined
      ) {
        this.fail(settlement.error);
        return;
      }
      await this.#outcome(attempt, settlement);
    } catch (error) {
      if (!this.#stopping) this.fail(error);
    } finally {
      this.#changed();
    }
  }

  /** The child's final message, run under its admission's ledgers and recorder. */
  #execute({
    id,
    record,
    child,
    placement,
  }: Attempt): Promise<AssistantMessage> {
    const { usage, recorder } = placement;
    const nodeId = NodeId.create(id);
    return runWithUsageContext(usage, () =>
      runWithUsageBudgets(
        [],
        id,
        () =>
          child.runWithNodeContext(
            {
              nodeId,
              ...(recorder === undefined
                ? {}
                : { recorder, recorderNodeId: id }),
              complaint: { nodeId, messages: [] },
            },
            async () => {
              child.stagePrompt(record.prompt);
              while (true) {
                const result = await child.next();
                if (result.done === true)
                  throw new JuncoAgentError(
                    "closed",
                    "Subagent closed before settlement",
                  );
                const step = result.value;
                if (step.kind === "settled") return step.message;
                if (step.kind === "failed") throw step.error;
                // A background subagent resumes its own pauses; only cancellation stops it.
                await setImmediate(undefined, {
                  signal: this.#controller.signal,
                });
              }
            },
          ),
        // Tasks run inside the admitting graph node; they have no scheduler history of their own.
        usage?.report,
      ),
    );
  }

  /** Reports a closed attempt's outcome, or retries it under its task's failure policy. */
  async #outcome(attempt: Attempt, settlement: Settlement): Promise<void> {
    const { record } = attempt;
    if (record.state !== "running" || record.attempt !== attempt.number)
      throw new JuncoAgentError(
        "invalid_state",
        `Stale task attempt ${attempt.id}`,
      );
    const base = {
      type: "task_result" as const,
      id: record.id,
      ...(record.name === undefined ? {} : { name: record.name }),
      attempt: attempt.number,
    };
    let report: TaskNotice & { readonly type: "task_result" };
    // A thrown fault, tagged so that even `throw undefined` is reported.
    let fault: { readonly error: unknown } | undefined;
    if (settlement.ok) {
      const { message } = settlement;
      report = {
        ...base,
        status: message.stopReason === "stop" ? "completed" : "failed",
        output: contentText(message.content),
        stopReason: message.stopReason,
        ...(message.errorMessage === undefined
          ? {}
          : { error: message.errorMessage }),
      };
    } else {
      report = { ...base, status: "failed", output: "", stopReason: "error" };
      fault = settlement;
    }
    if (report.status === "completed") {
      this.#notify(report);
      this.#resolve(record, { tasks_completed: 1 });
      return;
    }
    this.#lifecycle(record.placement, { tasks_failed: 1 });
    if (record.policy === "ignore") {
      this.#resolve(record, { tasks_ignored: 1 });
      return;
    }
    while (record.retries > 0) {
      record.retries -= 1;
      record.state = "retrying";
      try {
        const next = await this.#acquire(
          record,
          this.#controller.signal,
          record.placement,
        );
        this.#lifecycle(record.placement, {
          attempts_admitted: 1,
          retry_attempts: 1,
        });
        trackPromise(this.#work, this.#run(next));
        return;
      } catch (failure) {
        if (this.#stopping) return;
        fault = { error: failure };
      }
    }
    record.state = "awaiting-decision";
    // Every distinct error reachable from the fault, one `name: message` (or `String(value)` for a
    // non-Error) per line; else the assistant's own error message.
    let { error } = report;
    if (fault !== undefined) {
      const lines: string[] = [];
      for (const value of errorGraph(fault.error)) {
        try {
          lines.push(
            !(value instanceof Error)
              ? String(value)
              : value.message === ""
                ? value.name
                : `${value.name}: ${value.message}`,
          );
        } catch {
          lines.push("Unprintable subagent error");
        }
      }
      error = lines.join("\n");
    }
    this.#notify({
      ...report,
      ...(error === undefined ? {} : { error }),
      decisionRequired: true,
    });
  }

  /**
   * Ends `record` as completed or ignored, recording `counters` with its resolution; its batch's
   * last resolution queues its completion marker.
   */
  #resolve(record: TaskRecord, counters: Readonly<Record<string, number>>) {
    record.state = "terminal";
    record.batch.open -= 1;
    const complete = record.batch.open === 0;
    this.#lifecycle(record.placement, {
      ...counters,
      tasks_resolved: 1,
      ...(complete ? { batches_completed: 1 } : {}),
    });
    if (complete)
      this.#notify({ type: "task_batch_complete", ids: record.batch.ids });
    this.#changed();
  }

  /** Task commits, at `placement` with the current outstanding count. */
  #lifecycle(
    placement: TaskPlacement,
    counters: Readonly<Record<string, number>>,
  ): void {
    let outstanding = 0;
    for (const { state } of this.#tasks.values())
      if (state !== "terminal") outstanding += 1;
    const recorder: ProfileRecorder<"operations"> | undefined =
      placement.recorder;
    recorder?.record({
      kind: "metrics",
      ...TASK_LIFECYCLE,
      counters,
      gauges: { tasks_outstanding: outstanding },
    });
  }

  /** Queues `notice` natively after every earlier one; its admission failure is fatal. */
  #notify(notice: TaskNotice): void {
    this.#inflight += 1;
    const admitted = (async () => {
      try {
        await this.#tail;
        if (this.#stopping) return;
        const queued = await this.lane.followUp(
          JSON.stringify(notice),
          undefined,
          BACKGROUND_CONTEXT,
        );
        if (!queued.ok) throw queued.error;
        const { entryId } = queued.value;
        // The lane may consume the entry before its ID returns.
        if (this.#early.delete(entryId)) this.#delivered(notice);
        else this.#queued.set(entryId, notice);
      } catch (error) {
        if (!this.#stopping) this.fail(error);
      } finally {
        this.#inflight -= 1;
        if (this.#inflight === 0) this.#early.clear();
        this.#changed();
      }
    })();
    this.#tail = admitted;
    trackPromise(this.#work, admitted);
  }

  #delivered(notice: TaskNotice): void {
    if (!this.#stopping && notice.type === "task_result") {
      const { type: _type, ...result } = notice;
      this.results.push(result);
    }
    this.#changed();
  }

  /** The next state change, or `signal`'s abort. */
  #change(signal: AbortSignal | undefined): Promise<void> {
    this.#progress ??= Promise.withResolvers<void>();
    const progress = this.#progress.promise;
    if (signal === undefined) return progress;
    const { promise, resolve } = Promise.withResolvers<void>();
    const wake = () => {
      signal.removeEventListener("abort", wake);
      resolve();
    };
    signal.addEventListener("abort", wake, { once: true });
    void progress.then(wake);
    return promise;
  }

  #changed(): void {
    const progress = this.#progress;
    this.#progress = undefined;
    progress?.resolve();
  }
}
