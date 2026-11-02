import { inspect } from "node:util";
import { isNativeError } from "node:util/types";
import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { Message } from "dataflow-engine";
import {
  type DataflowGraph,
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  DummyTracer,
  type Node,
} from "dataflow-engine";
import type { JuncoAgent } from "junco-agent";
import { flushLog, redirectLog } from "junco-tools/log";
import type {
  NativeTui,
  NativeTuiNode,
  NativeTuiTrace,
} from "junco-tools/native";
import type { TSchema } from "typebox";
import { nodePolicies } from "./node-policy.js";

const TERMINAL_ERROR =
  "TuiTracer requires an interactive terminal on stdin and stdout";
const OWNERSHIP_ERROR = "A TUI session already owns this terminal";
const quiet = new DummyTracer();
const graphSerials = new WeakMap<object, number>();
let lastGraphSerial = 0;
let lastRunSerial = 0;
const interactive = (): boolean =>
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true &&
  process.env.TERM !== "dumb";
const serialOf = (graph: object): number => {
  let serial = graphSerials.get(graph);
  if (serial === undefined) {
    serial = ++lastGraphSerial;
    graphSerials.set(graph, serial);
  }
  return serial;
};

/** ASCII cell spelling shared by node identities and trace labels. */
const escapeTuiLabel = (decoded: string): string =>
  JSON.stringify(decoded)
    .slice(1, -1)
    .replace(
      /[^\x20-\x7e]/g,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );

/** Inspect NOW without calling application getters or custom inspection hooks. */
export function formatTuiPayload(record: unknown): string {
  if (isNativeError(record)) {
    // inspect's special Error path reads name/message accessors even with getters:false.
    const snapshots = new WeakMap<object, object>();
    const snapshot = (error: object): object => {
      const previous = snapshots.get(error);
      if (previous !== undefined) return previous;
      const plain = Object.create(null) as object;
      snapshots.set(error, plain);
      const descriptors = Object.getOwnPropertyDescriptors(error);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (
          key === "message" ||
          key === "name" ||
          key === "stack" ||
          key === "cause" ||
          key === "errors"
        )
          descriptor.enumerable = true;
        if ("value" in descriptor && isNativeError(descriptor.value))
          descriptor.value = snapshot(descriptor.value);
      }
      return Object.defineProperties(plain, descriptors);
    };
    record = snapshot(record);
  }
  return inspect(record, {
    colors: false,
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    compact: true,
    breakLength: Number.POSITIVE_INFINITY,
    getters: false,
    customInspect: false,
  });
}

type Graph = DataflowGraph<unknown, TSchema, unknown, unknown>;
type Metadata = { node: NativeTuiNode; rawId: string; agent: boolean };
type Activation = { key: string; token: symbol };
type PendingRecord = {
  record: NativeTuiTrace;
  indexKey?: string;
  badgeBytes: number;
  bytes: number;
  truncated: boolean;
};
type AgentRunTrace = {
  sequence: number;
  message?: { seen: Set<string> };
};

// ponytail: startup mirrors native's 4 MiB/4,096 records/32 KiB entry ceilings; persist history if these in-memory ceilings become limiting.
const HISTORY_BYTES = 4 * 1024 * 1024;
const HISTORY_RECORDS = 4096;
const ENTRY_BYTES = 32 * 1024;
const TRUNCATED = "[display truncated]";
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  let end = Math.min(Math.max(0, bytes), buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) --end;
  return buffer.toString("utf8", 0, end);
}
function badgeBytes(node?: NativeTuiNode): number {
  const badge =
    node === undefined ? "[system] " : `[${node.scope}:${node.nodeId}] `;
  const maximum = ENTRY_BYTES - byteLength(TRUNCATED) - 1;
  return byteLength(badge) <= maximum
    ? byteLength(badge)
    : byteLength(
        `${utf8Prefix(badge, maximum - byteLength(TRUNCATED))}${TRUNCATED} `,
      );
}

/** One lazily acquired, terminal-owning display shared by synchronous graph observers. */
export class TuiTracer implements DataflowTracer {
  static #shared: TuiTracer | undefined;

  /** Select Dummy off-terminal; selecting the lazy interactive default performs no I/O. */
  static shared(): DataflowTracer {
    if (!interactive()) return quiet;
    if (TuiTracer.#shared === undefined || TuiTracer.#shared.#released) {
      TuiTracer.#shared = new TuiTracer("JuncoGraph.run");
    }
    return TuiTracer.#shared;
  }

  /** Await exclusive acquisition, adopting an unused shared default when one exists. */
  static async create(name: string = "JuncoGraph.run"): Promise<TuiTracer> {
    if (!interactive()) throw new Error(TERMINAL_ERROR);
    let tracer = TuiTracer.#shared;
    if (tracer !== undefined && !tracer.#released && tracer.#started) {
      throw new Error(OWNERSHIP_ERROR);
    }
    if (tracer === undefined || tracer.#released) tracer = new TuiTracer(name);
    else tracer.#name = name;
    TuiTracer.#shared = tracer;
    await tracer.#initialize();
    if (tracer.#failure !== undefined) {
      await tracer.close();
      throw tracer.#failure;
    }
    return tracer;
  }

  #name: string;
  #started = false;
  #closed = false;
  #released = false;
  #finishing = false;
  #closeRequested = false;
  #signalDelivered = false;
  #failure: unknown;
  #native: NativeTui | undefined;
  #initialization: Promise<void> | undefined;
  #rawExit: Promise<"dismissed" | "interrupted" | "closed"> | undefined;
  #exitMonitor: Promise<void> | undefined;
  #nativeFinish: Promise<void> | undefined;
  #finishPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #releaseLog: (() => void) | undefined;
  readonly #signals = new Map<NodeJS.Signals, () => void>();
  readonly #subscriptions = new Set<() => void>();
  readonly #agentRuns = new Map<string, Map<string, AgentRunTrace>>();
  readonly #active = new Map<string, Set<symbol>>();
  #nodeKeys = new WeakMap<object, string>();
  readonly #metadata = new Map<string, Metadata>();
  readonly #pending = new Map<number, PendingRecord>();
  readonly #pendingIndex = new Map<string, number>();
  #pendingSerial = 0;
  #pendingBytes = 0;
  #omitted = 0;

  private constructor(name: string) {
    this.#name = name;
  }

  #latch(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure =
      error === undefined
        ? new Error("TuiTracer display failed", { cause: error })
        : error;
  }

  #guard(action: () => void): void {
    if (this.#closed) return;
    try {
      action();
    } catch (error) {
      this.#diagnose(error);
    }
  }

  #diagnose(error: unknown, message = "TuiTracer display failed"): void {
    this.#latch(error);
    if (this.#closed) return;
    let detail = "[payload inspection failed]";
    try {
      detail = formatTuiPayload(error);
    } catch {
      // Even a hostile error object cannot escape an observer or its diagnostic path.
    }
    this.#record({ text: `${message}: ${detail}`, tone: "error" });
  }

  #initialize(): Promise<void> {
    if (this.#initialization !== undefined) return this.#initialization;
    if (this.#closed) return Promise.resolve();
    this.#started = true;
    const pending = Promise.withResolvers<void>();
    this.#initialization = pending.promise;
    // Consume background rejection while preserving the rejecting promise for lifecycle callers.
    void pending.promise.catch(() => {});
    let stdoutBarrier: Promise<void>;
    try {
      // Capture stdout's barrier before redirecting; new operational records are buffered now.
      stdoutBarrier = flushLog();
      void stdoutBarrier.catch(() => {});
      this.#releaseLog = redirectLog({
        write: (line) => this.#guard(() => this.#record({ text: line })),
        flush: () => this.#logBarrier(),
      });
      this.#installSignals();
    } catch (error) {
      const failure = new Error("failed to initialize TuiTracer", {
        cause: error,
      });
      this.#latch(failure);
      this.#release();
      pending.reject(failure);
      return pending.promise;
    }
    this.#open(stdoutBarrier).then(pending.resolve, pending.reject);
    return pending.promise;
  }

  async #open(stdoutBarrier: Promise<void>): Promise<void> {
    try {
      await stdoutBarrier;
      if (this.#closeRequested) {
        this.#release();
        return;
      }
      // Platform addon may be absent: static import would break native-free imports and Dummy runs.
      const { NativeTui } = await import("junco-tools/native");
      if (this.#closeRequested) {
        this.#release();
        return;
      }
      const native = await NativeTui.open(this.#name);
      this.#native = native;
      // The raw termination promise is never replaced by a finalizer awaiting public lifecycle.
      this.#rawExit = native.waitForExit();
      this.#exitMonitor = this.#rawExit
        .then(
          (reason) => {
            this.#release();
            if (reason === "interrupted" && !this.#signalDelivered) {
              process.kill(process.pid, "SIGINT");
            }
          },
          (error) => {
            this.#latch(error);
            this.#release();
          },
        )
        .catch((error) => {
          this.#latch(error);
          this.#release();
        });
      if (this.#closeRequested) {
        await native.close();
        await this.#exitMonitor;
        return;
      }
      for (const { node } of this.#metadata.values()) native.setNode(node);
      for (const { record } of this.#pending.values()) native.trace(record);
      if (this.#omitted !== 0) {
        native.trace({
          text: `${this.#omitted} startup trace records omitted`,
        });
      }
      this.#pending.clear();
      this.#pendingIndex.clear();
      this.#pendingBytes = 0;
      for (const key of this.#active.keys()) native.setActive(key, true);
      if (this.#finishing) this.#beginFinish();
    } catch (error) {
      const failure = new Error("failed to initialize TuiTracer", {
        cause: error,
      });
      this.#latch(failure);
      if (this.#native !== undefined) {
        try {
          await this.#native.close();
        } catch (cleanup) {
          this.#latch(cleanup);
        }
        await this.#exitMonitor;
      }
      this.#release();
      throw failure;
    }
  }

  async #logBarrier(): Promise<void> {
    try {
      // This sink is deliberately a draw barrier, never interactive finish or flushLog recursion.
      await this.#initialization;
      if (!this.#closed && this.#native !== undefined)
        await this.#native.flush();
    } catch (error) {
      this.#latch(error);
      this.#stopDisplay();
    }
  }

  #stopDisplay(): void {
    this.#closed = true;
    this.#closeRequested = true;
    if (this.#native === undefined) return;
    try {
      void this.#native.close().catch((error) => this.#latch(error));
    } catch (error) {
      this.#latch(error);
    }
  }

  #installSignals(): void {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const listener = (): void => {
        const handled = process
          .listeners(signal)
          .some((candidate) => candidate !== listener);
        this.#signalDelivered = true;
        const reemit = (): void => {
          if (!handled) {
            try {
              process.kill(process.pid, signal);
            } catch (error) {
              this.#latch(error);
            }
          }
        };
        void this.close().then(reemit, reemit);
      };
      this.#signals.set(signal, listener);
      process.on(signal, listener);
    }
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#closed = true;
    try {
      this.#releaseLog?.();
    } catch (error) {
      this.#latch(error);
    }
    this.#releaseLog = undefined;
    for (const [signal, listener] of this.#signals) {
      try {
        process.off(signal, listener);
      } catch (error) {
        this.#latch(error);
      }
    }
    this.#signals.clear();
    for (const detach of this.#subscriptions) {
      try {
        detach();
      } catch (error) {
        this.#latch(error);
      }
    }
    this.#subscriptions.clear();
    this.#agentRuns.clear();
    this.#nodeKeys = new WeakMap();
    this.#metadata.clear();
    this.#active.clear();
    this.#pending.clear();
    this.#pendingIndex.clear();
    this.#pendingBytes = 0;
    this.#native = undefined;
    if (TuiTracer.#shared === this) TuiTracer.#shared = undefined;
  }

  #registerNode<S, N extends TSchema, T>(
    graph: Graph,
    id: string,
    node: Node<S, N, T>,
  ): string {
    const serial = serialOf(graph);
    const key = JSON.stringify([serial, id]);
    if (!this.#metadata.has(key)) {
      const metadata = {
        node: { key, nodeId: escapeTuiLabel(id), scope: `g${serial}` },
        rawId: id,
        agent: nodePolicies.get(node.step)?.agent !== undefined,
      };
      this.#metadata.set(key, metadata);
      this.#native?.setNode(metadata.node);
    }
    this.#nodeKeys.set(node, key);
    return key;
  }

  #record(record: NativeTuiTrace): void {
    if (this.#closed) return;
    if (this.#native !== undefined) {
      try {
        this.#native.trace(record);
      } catch (error) {
        this.#latch(error);
        this.#stopDisplay();
      }
      return;
    }
    const indexKey =
      record.recordId === undefined
        ? undefined
        : JSON.stringify([record.nodeKey, record.recordId]);
    const previousSerial =
      indexKey === undefined ? undefined : this.#pendingIndex.get(indexKey);
    let entry =
      previousSerial === undefined
        ? undefined
        : this.#pending.get(previousSerial);
    if (entry === undefined) {
      entry = {
        record: { ...record, text: "", mode: "replace" },
        indexKey,
        badgeBytes: badgeBytes(
          record.nodeKey === undefined
            ? undefined
            : this.#metadata.get(record.nodeKey)?.node,
        ),
        bytes: 0,
        truncated: false,
      };
      const serial = ++this.#pendingSerial;
      this.#pending.set(serial, entry);
      if (indexKey !== undefined) this.#pendingIndex.set(indexKey, serial);
    } else {
      this.#pendingBytes -= entry.bytes;
      if (record.mode === "replace") {
        entry.record.text = "";
        entry.truncated = false;
      }
      entry.record.tone = record.tone;
    }
    if (!entry.truncated) {
      // Bound escaping itself: a huge payload never becomes a huge retained startup copy.
      const maximum = ENTRY_BYTES - entry.badgeBytes;
      let bytes = byteLength(entry.record.text);
      const parts = [entry.record.text];
      for (const character of record.text) {
        // UTF-16 unit: an astral character's high surrogate escapes exactly like its code point.
        const code = character.charCodeAt(0);
        const escaped =
          character === "\n"
            ? character
            : character === "\t"
              ? "    "
              : code < 0x20 || (code >= 0x7f && code <= 0x9f)
                ? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`
                : character;
        const size = byteLength(escaped);
        if (bytes + size > maximum) {
          entry.record.text =
            utf8Prefix(parts.join(""), maximum - byteLength(TRUNCATED)) +
            TRUNCATED;
          entry.truncated = true;
          break;
        }
        parts.push(escaped);
        bytes += size;
      }
      if (!entry.truncated) entry.record.text = parts.join("");
    }
    entry.bytes = entry.badgeBytes + byteLength(entry.record.text);
    this.#pendingBytes += entry.bytes;
    for (const [serial, pending] of this.#pending) {
      if (
        this.#pendingBytes <= HISTORY_BYTES &&
        this.#pending.size <= HISTORY_RECORDS
      )
        break;
      this.#pending.delete(serial);
      this.#pendingBytes -= pending.bytes;
      if (pending.indexKey !== undefined)
        this.#pendingIndex.delete(pending.indexKey);
      ++this.#omitted;
    }
  }

  #setActive(key: string, active: boolean): void {
    try {
      this.#native?.setActive(key, active);
    } catch (error) {
      this.#latch(error);
      this.#stopDisplay();
    }
  }

  #activate(key: string, token: symbol): void {
    let owners = this.#active.get(key);
    if (owners === undefined) {
      owners = new Set();
      this.#active.set(key, owners);
    }
    const wasActive = owners.size !== 0;
    owners.add(token);
    if (!wasActive) this.#setActive(key, true);
  }

  #deactivate(activation: Activation): void {
    const owners = this.#active.get(activation.key);
    if (owners === undefined) return;
    owners.delete(activation.token);
    if (owners.size === 0) {
      this.#active.delete(activation.key);
      this.#setActive(activation.key, false);
    }
  }

  startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    if (this.#closed) return quiet.startRun(graph);
    const current = graph as unknown as Graph;
    const run = ++lastRunSerial;
    const activations = new Set<Activation>();
    let ended = false;
    this.#guard(() => {
      this.#initialize();
      if (this.#closed) return;
      current.forEachNode((id, node) => this.#registerNode(current, id, node));
      this.#record({ text: `run ${run} start g${serialOf(graph)}` });
    });
    const finishRun = (): void => {
      if (ended) return;
      ended = true;
      for (const activation of activations) this.#deactivate(activation);
      activations.clear();
    };
    return {
      startNode: (id, phase, inputs): DataflowStepTrace<N, T> => {
        if (this.#closed || ended)
          return quiet.startRun(graph).startNode(id, phase, inputs);
        let activation: Activation | undefined;
        let settled = false;
        this.#guard(() => {
          const node = graph.getNode(id);
          if (node === undefined)
            throw new Error(
              `TuiTracer cannot map scheduled node ${escapeTuiLabel(id)}`,
            );
          const key = this.#registerNode(current, id, node);
          activation = { key, token: Symbol() };
          activations.add(activation);
          this.#activate(key, activation.token);
          const messages =
            inputs === undefined
              ? []
              : Array.from(inputs.messages.keys(), (edge) => ({
                  id: edge,
                  count: inputs.messages.get(edge)?.length ?? 0,
                }));
          const values =
            inputs === undefined ? [] : Array.from(inputs.values.keys());
          this.#record({
            nodeKey: key,
            text: `run ${run} ${phase} inputs=${formatTuiPayload({ messages, values })}`,
          });
        });
        const settle = (
          result:
            | { step: IteratorResult<readonly Message<N>[], T> }
            | { error: unknown },
        ): void => {
          if (settled || this.#closed) return;
          settled = true;
          this.#guard(() => {
            if (activation !== undefined) {
              this.#deactivate(activation);
              activations.delete(activation);
            }
            const key = activation?.key;
            if ("error" in result) {
              this.#record({
                nodeKey: key,
                text: `run ${run} error ${formatTuiPayload(result.error)}`,
                tone: "error",
              });
            } else if (key !== undefined && this.#metadata.get(key)?.agent) {
              if (result.step.done === true) {
                const value = result.step.value;
                const reason =
                  value !== null && typeof value === "object"
                    ? Object.getOwnPropertyDescriptor(value, "stopReason")
                        ?.value
                    : undefined;
                this.#record({
                  nodeKey: key,
                  text: `run ${run} return ${formatTuiPayload({ outcome: "return", stopReason: reason })}`,
                });
              } else {
                this.#record({
                  nodeKey: key,
                  text: `run ${run} yield ${formatTuiPayload({ edges: result.step.value.map((message) => message.id) })}`,
                });
              }
            } else {
              this.#record({
                nodeKey: key,
                text:
                  result.step.done === true
                    ? `run ${run} return ${formatTuiPayload({ value: result.step.value })}`
                    : `run ${run} yield ${formatTuiPayload({ messages: result.step.value })}`,
              });
            }
          });
        };
        return {
          end: (step) => settle({ step }),
          fail: (error) => settle({ error }),
        };
      },
      end: (results) =>
        this.#guard(() => {
          if (ended) return;
          finishRun();
          this.#record({
            text: `run ${run} end completed=${formatTuiPayload(Array.from(results.keys()))}`,
          });
        }),
      fail: (error) =>
        this.#guard(() => {
          if (ended) return;
          finishRun();
          this.#record({
            text: `run ${run} fail ${formatTuiPayload(error)}`,
            tone: "error",
          });
        }),
    };
  }

  /** Observe only the concrete scheduled member; subscriptions never own agent execution. */
  observeAgent<S, N extends TSchema, T>(
    node: Node<S, N, T>,
    events: JuncoAgent["events"],
  ): () => void {
    const subscriptions: (() => void)[] = [];
    let detached = false;
    const detach = (): void => {
      if (detached) return;
      detached = true;
      this.#subscriptions.delete(detach);
      for (const unsubscribe of subscriptions.splice(0).reverse()) {
        try {
          unsubscribe();
        } catch (error) {
          this.#diagnose(error, "TuiTracer agent detachment failed");
        }
      }
    };
    this.#guard(() => {
      const nodeKey = this.#nodeKeys.get(node);
      if (nodeKey === undefined)
        throw new Error("TuiTracer cannot map observed agent node");
      const runs =
        this.#agentRuns.get(nodeKey) ?? new Map<string, AgentRunTrace>();
      this.#agentRuns.set(nodeKey, runs);
      const runKey = (lane: string, runId: string | undefined): string =>
        JSON.stringify([lane, runId]);
      const runFor = (
        lane: string,
        runId: string | undefined,
      ): AgentRunTrace => {
        const key = runKey(lane, runId);
        let run = runs.get(key);
        if (run === undefined) {
          run = { sequence: 0 };
          runs.set(key, run);
        }
        return run;
      };
      const messageFor = (
        run: AgentRunTrace,
      ): NonNullable<AgentRunTrace["message"]> => {
        if (run.message === undefined) {
          ++run.sequence;
          run.message = { seen: new Set() };
        }
        return run.message;
      };
      const laneLabel = (lane: string | undefined): string =>
        lane === undefined || lane === "main"
          ? ""
          : `[lane ${escapeTuiLabel(lane)}] `;
      const streamId = (
        lane: string,
        runId: string | undefined,
        run: AgentRunTrace,
        index: number,
        kind: string,
      ): string =>
        JSON.stringify([nodeKey, lane, runId, run.sequence, index, kind]);
      const prefix = (lane: string, kind: "text" | "thinking"): string =>
        `${laneLabel(lane)}${kind === "text" ? "assistant" : "thinking"}: `;
      const on = <E extends HarnessEvent["type"]>(
        type: E,
        listener: (event: Extract<HarnessEvent, { type: E }>) => void,
      ): void => {
        subscriptions.push(
          events.on(type, (event) => {
            if (!detached) this.#guard(() => listener(event));
          }),
        );
      };
      this.#subscriptions.add(detach);
      try {
        on("message_start", ({ lane, runId, message }) => {
          if (message.role !== "assistant") return;
          const run = runFor(lane, runId);
          ++run.sequence;
          run.message = { seen: new Set() };
        });
        on("message_update", ({ lane, runId, event }) => {
          if (event.type !== "text_delta" && event.type !== "thinking_delta")
            return;
          const kind = event.type === "text_delta" ? "text" : "thinking";
          const run = runFor(lane, runId);
          const message = messageFor(run);
          const contentKey = JSON.stringify([event.contentIndex, kind]);
          const first = !message.seen.has(contentKey);
          message.seen.add(contentKey);
          this.#record({
            nodeKey,
            recordId: streamId(lane, runId, run, event.contentIndex, kind),
            text: (first ? prefix(lane, kind) : "") + event.delta,
            tone: kind === "thinking" ? "thinking" : "normal",
          });
        });
        on("message_end", ({ lane, runId, message }) => {
          if (message.role === "user") {
            const text = contentText(message.content);
            if (text !== "")
              this.#record({
                nodeKey,
                text: `${laneLabel(lane)}user: ${text}`,
              });
            return;
          }
          if (message.role !== "assistant") return;
          const run = runFor(lane, runId);
          const current = messageFor(run);
          try {
            if (current.seen.size === 0) {
              const text = contentText(message.content);
              if (text !== "")
                this.#record({ nodeKey, text: prefix(lane, "text") + text });
            } else {
              for (const [index, block] of message.content.entries()) {
                if (block.type !== "text" && block.type !== "thinking")
                  continue;
                const kind = block.type;
                this.#record({
                  nodeKey,
                  recordId: streamId(lane, runId, run, index, kind),
                  mode: "replace",
                  text:
                    prefix(lane, kind) +
                    (block.type === "text" ? block.text : block.thinking),
                  tone: kind === "thinking" ? "thinking" : "normal",
                });
              }
            }
            if (message.errorMessage !== undefined) {
              this.#record({
                nodeKey,
                text: `${laneLabel(lane)}assistant ${message.stopReason}: ${message.errorMessage}`,
                tone: "error",
              });
            }
          } finally {
            // Keep the sequence across node advancements, but never retain growing message snapshots.
            run.message = undefined;
          }
        });
        const recordTool = (
          lane: string | undefined,
          runId: unknown,
          toolCallId: string,
          toolName: string,
          phase: "args" | "progress" | "result" | "error",
          value: unknown,
        ): void => {
          this.#record({
            nodeKey,
            recordId: JSON.stringify([
              nodeKey,
              lane,
              runId,
              toolCallId,
              phase === "args" ? "start" : "progress",
            ]),
            ...(phase === "args" ? {} : { mode: "replace" as const }),
            text: `${laneLabel(lane)}tool ${escapeTuiLabel(toolName)} ${phase} ${formatTuiPayload(value)}`,
            ...(phase === "result" || phase === "error"
              ? { tone: phase === "error" ? "error" : "normal" }
              : {}),
          });
        };
        on("tool_start", ({ lane, runId, toolCallId, toolName, args }) =>
          recordTool(lane, runId, toolCallId, toolName, "args", args),
        );
        on(
          "tool_update",
          ({ lane, runId, toolCallId, toolName, partialResult }) =>
            recordTool(
              lane,
              runId,
              toolCallId,
              toolName,
              "progress",
              partialResult,
            ),
        );
        on(
          "tool_end",
          ({ lane, runId, toolCallId, toolName, result, isError }) =>
            recordTool(
              lane,
              runId,
              toolCallId,
              toolName,
              isError ? "error" : "result",
              result,
            ),
        );
        on("run_end", (event) => {
          runs.delete(runKey(event.lane, event.runId));
          this.#record({
            nodeKey,
            text: `${laneLabel(event.lane)}agent run ${event.status}${event.status === "failed" ? ` ${formatTuiPayload(event.error)}` : ""}`,
            tone: event.status === "completed" ? "normal" : "error",
          });
        });
        on("fault", ({ code, message }) => {
          this.#record({
            nodeKey,
            text: `agent fault ${escapeTuiLabel(code)}: ${message}`,
            tone: "error",
          });
        });
        on("handler_error", (event) => {
          this.#record({
            nodeKey,
            text: `${laneLabel(event.lane)}agent ${event.kind} handler ${escapeTuiLabel(event.kind === "hook" ? event.hook : event.event)}: ${event.error}${event.stack === undefined ? "" : `\n${event.stack}`}`,
            tone: "error",
          });
        });
      } catch (error) {
        detach();
        throw error;
      }
    });
    return detach;
  }

  #beginFinish(): Promise<void> {
    if (this.#nativeFinish !== undefined) return this.#nativeFinish;
    try {
      this.#nativeFinish =
        this.#native === undefined ? Promise.resolve() : this.#native.finish();
    } catch (error) {
      this.#latch(error);
      this.#stopDisplay();
      this.#nativeFinish = Promise.reject(error);
    }
    void this.#nativeFinish.catch((error) => this.#latch(error));
    return this.#nativeFinish;
  }

  /** After every shared graph stops, retain its final screen until q/Esc restores the terminal. */
  flush(): Promise<void> {
    if (this.#finishPromise !== undefined) return this.#finishPromise;
    if (!this.#started) {
      this.#release();
      this.#finishPromise = Promise.resolve();
      return this.#finishPromise;
    }
    this.#finishing = true;
    const pending = Promise.withResolvers<void>();
    this.#finishPromise = pending.promise;
    void pending.promise.catch(() => {});
    // Ready sessions mark the final frame synchronously, before any await/microtask suspension.
    const finish =
      this.#native !== undefined && !this.#closed
        ? this.#beginFinish()
        : undefined;
    if (finish !== undefined) void finish.catch(() => {});
    this.#settleLifecycle(finish, false).then(pending.resolve, pending.reject);
    return pending.promise;
  }

  /** Restore without dismissal; report latched display errors only after restoration. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closeRequested = true;
    this.#closed = true;
    if (!this.#started) {
      this.#release();
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    const pending = Promise.withResolvers<void>();
    this.#closePromise = pending.promise;
    void pending.promise.catch(() => {});
    let close: Promise<void> | undefined;
    try {
      close = this.#native?.close();
    } catch (error) {
      this.#latch(error);
    }
    if (close !== undefined) void close.catch(() => {});
    this.#settleLifecycle(close, true).then(pending.resolve, pending.reject);
    return pending.promise;
  }

  async #settleLifecycle(
    operation: Promise<void> | undefined,
    closing: boolean,
  ): Promise<void> {
    try {
      await this.#initialization;
      if (operation !== undefined) await operation;
      else if (closing && this.#native !== undefined)
        await this.#native.close();
      else if (this.#rawExit !== undefined) await this.#rawExit;
    } catch (error) {
      this.#latch(error);
      if (this.#native !== undefined) {
        try {
          await this.#native.close();
        } catch (cleanup) {
          this.#latch(cleanup);
        }
      }
    }
    await this.#exitMonitor;
    this.#release();
    if (this.#failure !== undefined) throw this.#failure;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
