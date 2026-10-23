import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import {
  type DataflowGraph,
  type DataflowRunTrace,
  type DataflowTracer,
} from "dataflow-engine";
import type { Sample } from "dataflow-profile";
import { JuncoAgent } from "junco-agent";
import type { NativeResourceEvent } from "junco-tools";
import { isNestedContext, JuncoGraph } from "./junco-graph.js";

export type ProfileRecorderOptions = {
  /** JSONL file appended at every run end and `flush()`. */
  readonly path: string;
  /** Set when the collection monitors: every sample then carries memory in bytes. */
  readonly monitored?: boolean;
};

type Activation = {
  readonly node: string;
  readonly runId: string;
  readonly firedAt: string;
  readonly startedAt: number;
  readonly features: Sample["features"];
  readonly agent: JuncoAgent | undefined;
  readonly tokens0: number;
  peak: number;
  ended:
    | { readonly runtime: number; readonly tokens: number | undefined }
    | undefined;
};

/** Records finished activations as dataflow-profile JSONL, keyed by root/nested node path. */
export class ProfileRecorder implements DataflowTracer {
  readonly #path: string;
  readonly #monitored: boolean;
  readonly #prefixes = new WeakMap<object, string>();
  readonly #live = new Map<string, Activation>();
  // ponytail: late events land on the owner's last activation until it is written; a later one is dropped.
  readonly #latest = new Map<string, Activation>();
  readonly #tracked = new WeakSet<JuncoAgent>();
  readonly #totals = new WeakMap<JuncoAgent, number>();
  #pending: Activation[] = [];
  #writing: Promise<void> = Promise.resolve();
  #failure: unknown;

  constructor(options: ProfileRecorderOptions) {
    this.#path = options.path;
    this.#monitored = options.monitored ?? false;
  }

  readonly onResourceEvent = (event: NativeResourceEvent): void => {
    if (event.owner === undefined || event.sample === undefined) return;
    const act = this.#live.get(event.owner) ?? this.#latest.get(event.owner);
    if (act === undefined) return;
    // ponytail: peak, not the sum of concurrent pipelines; aggregate if concurrent load matters.
    act.peak = Math.max(
      act.peak,
      event.sample.memoryPeakBytes,
      event.sample.memoryBytes,
    );
  };

  startRun<S, N, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const prefix = this.#prefixes.get(graph) ?? "";
    const runId = randomUUID();
    return {
      startNode: (id, phase, inputs) => {
        const node = prefix === "" ? String(id) : `${prefix}/${id}`;
        const state = graph.getNode(id)?.state;
        if (state instanceof JuncoGraph) this.#prefixes.set(state, node);
        else if (isNestedContext(state)) this.#prefixes.set(state.graph, node);
        const agent = state instanceof JuncoAgent ? state : undefined;
        if (agent !== undefined && !this.#tracked.has(agent)) {
          this.#tracked.add(agent);
          agent.events.on("usage", ({ totals }) => {
            this.#totals.set(agent, totals.totalTokens);
          });
        }
        const act: Activation = {
          node,
          runId,
          firedAt: new Date().toISOString(),
          startedAt: performance.now(),
          features:
            inputs === undefined
              ? {}
              : Object.fromEntries(
                  [...inputs.messages.keys()].map((edge) => [
                    String(edge),
                    { count: inputs.messages.get(edge)?.length ?? 0 },
                  ]),
                ),
          agent,
          tokens0: agent ? (this.#totals.get(agent) ?? 0) : 0,
          peak: 0,
          ended: undefined,
        };
        const owner = agent?.owner;
        if (owner !== undefined) this.#live.set(owner, act);
        const settle = () => {
          if (owner !== undefined && this.#live.get(owner) === act) {
            this.#live.delete(owner);
            this.#latest.set(owner, act);
          }
        };
        return {
          end: (result) => {
            settle();
            act.ended = {
              runtime: performance.now() - act.startedAt,
              tokens: agent
                ? (this.#totals.get(agent) ?? 0) - act.tokens0
                : undefined,
            };
            this.#pending.push(act);
          },
          fail: (error) => {
            settle();
          },
        };
      },
      end: () => {
        void this.#write();
      },
      fail: () => {
        void this.#write();
      },
    };
  }

  complain(): void {}

  #write(): Promise<void> {
    const batch = this.#pending;
    this.#pending = [];
    if (batch.length === 0) return this.#writing;
    const lines = batch
      .map((act) => `${JSON.stringify(this.#sampleOf(act))}\n`)
      .join("");
    this.#writing = this.#writing
      .then(() => appendFile(this.#path, lines))
      .catch((error) => {
        this.#failure ??= error;
      });
    return this.#writing;
  }

  #sampleOf(act: Activation): Sample {
    const resources: Partial<Record<keyof Sample["resources"], number>> = {
      runtime: act.ended!.runtime,
    };
    const units: {
      -readonly [R in keyof Sample["units"]]: Sample["units"][R];
    } = { runtime: "ms" };
    if (act.ended!.tokens !== undefined) {
      resources.tokens = act.ended!.tokens;
      units.tokens = "tok";
    }
    if (this.#monitored) {
      resources.memory = act.peak;
      units.memory = "B";
    }
    return {
      node: act.node,
      features: act.features,
      resources,
      units,
      runId: act.runId,
      firedAt: act.firedAt,
    };
  }

  async flush(): Promise<void> {
    await this.#write();
    if (this.#failure !== undefined) throw this.#failure;
  }
}
