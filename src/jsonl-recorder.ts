import { appendFile } from "node:fs/promises";
import type { Sample } from "dataflow-profile";
import {
  type ProfileActivation,
  type ProfileEvent,
  type ProfileRecorder,
  profileContexts,
} from "junco-tools";

export type JsonlRecorderOptions = {
  /** JSONL file appended at every graph evaluation end and `flush()`. */
  readonly path: string;
  /** Set when the collection monitors: every sample then carries memory in bytes. */
  readonly monitored?: boolean;
};

type Activation = {
  readonly node: string;
  readonly activation: ProfileActivation;
  /** The agent's committed token sum at start; undefined for non-agents. */
  readonly tokens0: number | undefined;
  peak: number;
  ended:
    | { readonly runtime: number; readonly tokens: number | undefined }
    | undefined;
};

/**
 * Projects profile events into dataflow-profile JSONL training samples: one per successful graph
 * activation, keyed by its `/`-joined node IDs.
 */
export class JsonlRecorder implements ProfileRecorder<string> {
  readonly root: object = this;
  readonly path = "";
  readonly #file: string;
  readonly #monitored: boolean;
  readonly #contexts = profileContexts(
    this,
    (ids, _path, event) => this.#reduce(ids, event),
    () => {
      if (this.#closing !== undefined) throw new Error("JsonlRecorder: closed");
    },
  );
  readonly #active = new Map<ProfileActivation, Activation>();
  readonly #live = new Map<string, Activation>();
  // ponytail: late events land on the owner's last activation until it is written; a later one is dropped.
  readonly #latest = new Map<string, Activation>();
  readonly #tokens = new WeakMap<object, number>();
  #pending: Activation[] = [];
  #writing: Promise<void> = Promise.resolve();
  #failure: unknown;
  #closing: Promise<void> | undefined;

  constructor(options: JsonlRecorderOptions) {
    this.#file = options.path;
    this.#monitored = options.monitored ?? false;
  }

  readonly record = (event: ProfileEvent<string>): void =>
    this.#reduce([], event);

  add_context(nodeId: string): ProfileRecorder<string> {
    return this.#contexts.add([], nodeId);
  }

  #reduce(ids: readonly string[], event: ProfileEvent<string>): void {
    if (this.#closing !== undefined) return;
    switch (event.kind) {
      case "usage":
        this.#tokens.set(
          event.source,
          (this.#tokens.get(event.source) ?? 0) + event.usage.totalTokens,
        );
        return;
      case "resource": {
        const { owner, sample } = event.event;
        if (owner === undefined || sample === undefined) return;
        const act = this.#live.get(owner) ?? this.#latest.get(owner);
        if (act === undefined) return;
        // ponytail: peak, not the sum of concurrent pipelines; aggregate if concurrent load matters.
        act.peak = Math.max(
          act.peak,
          sample.memoryPeakBytes,
          sample.memoryBytes,
        );
        return;
      }
      case "start": {
        const { activation } = event;
        if (event.category !== "graph" || activation === undefined) return;
        const act: Activation = {
          node: ids.join("/"),
          activation,
          tokens0:
            activation.agent === undefined
              ? undefined
              : (this.#tokens.get(activation.agent) ?? 0),
          peak: 0,
          ended: undefined,
        };
        this.#active.set(activation, act);
        if (activation.owner !== undefined)
          this.#live.set(activation.owner, act);
        return;
      }
      case "finish": {
        if (event.category !== "graph") return;
        const { activation } = event;
        if (activation === undefined) {
          if (event.operation === "evaluate") void this.#write();
          return;
        }
        const act = this.#active.get(activation);
        if (act === undefined) return;
        this.#active.delete(activation);
        const { owner, agent } = activation;
        if (owner !== undefined && this.#live.get(owner) === act) {
          this.#live.delete(owner);
          this.#latest.set(owner, act);
        }
        if (event.outcome !== "success") return;
        act.ended = {
          runtime: event.durationMs,
          tokens:
            agent === undefined || act.tokens0 === undefined
              ? undefined
              : (this.#tokens.get(agent) ?? 0) - act.tokens0,
        };
        this.#pending.push(act);
        return;
      }
    }
  }

  #write(): Promise<void> {
    const batch = this.#pending;
    this.#pending = [];
    if (batch.length === 0) return this.#writing;
    let lines = "";
    for (const act of batch) {
      const owner = act.activation.owner;
      if (owner !== undefined && this.#latest.get(owner) === act)
        this.#latest.delete(owner);
      const sample = this.#sampleOf(act);
      const invalid = Object.entries(sample.resources).find(
        ([, value]) => !Number.isFinite(value) || value < 0,
      );
      if (invalid === undefined) lines += `${JSON.stringify(sample)}\n`;
      else
        this.#failure ??= new Error(
          `JsonlRecorder: invalid ${invalid[0]} sample`,
        );
    }
    if (lines === "") return this.#writing;
    this.#writing = this.#writing
      .then(() => appendFile(this.#file, lines))
      .catch((error) => {
        this.#failure ??= error;
      });
    return this.#writing;
  }

  #sampleOf(act: Activation): Sample {
    const ended = act.ended ?? { runtime: 0, tokens: undefined };
    const resources: Partial<Record<keyof Sample["resources"], number>> = {
      runtime: ended.runtime,
    };
    const units: {
      -readonly [R in keyof Sample["units"]]: Sample["units"][R];
    } = { runtime: "ms" };
    if (ended.tokens !== undefined) {
      resources.tokens = ended.tokens;
      units.tokens = "tok";
    }
    if (this.#monitored) {
      resources.memory = act.peak;
      units.memory = "B";
    }
    return {
      node: act.node,
      features: act.activation.features,
      resources,
      units,
      runId: act.activation.runId,
      firedAt: act.activation.firedAt,
    };
  }

  async flush(): Promise<void> {
    await this.#write();
    if (this.#failure !== undefined) throw this.#failure;
  }

  close(): Promise<void> {
    this.#closing ??= this.flush().finally(() => {
      this.#contexts.clear();
      this.#active.clear();
      this.#live.clear();
      this.#latest.clear();
    });
    return this.#closing;
  }
}
