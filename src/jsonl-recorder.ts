import { appendFile } from "node:fs/promises";
import type { Sample } from "dataflow-profile";
import {
  type ProfileActivation,
  type ProfileEvent,
  type ProfileRecorder,
  profileContexts,
} from "junco-tools";

/** Options of `new JsonlRecorder`. */
export type JsonlRecorderOptions = {
  /** JSONL file appended at every graph evaluation end and `flush()`. */
  readonly path: string;
  /** Set when the collection monitors: activation samples then carry memory in bytes. */
  readonly monitored?: boolean;
  /** `usage` records each cost increment, including outside activations, instead of activation rollups. */
  readonly costMode?: "activation" | "usage";
};

/** One activation's `edits`/`operations` events with the same labels, summed. */
type Operation = {
  readonly resource: string;
  readonly category: string;
  readonly tool: string;
  readonly operation: string;
  calls: number;
  /** Finish counts by {@link ProfileEvent} outcome. */
  success: number;
  error: number;
  cancelled: number;
  durationMs: number;
  readonly counters: Record<string, number>;
  /** Latest values. */
  readonly gauges: Record<string, number>;
};

type Activation = {
  readonly node: string;
  readonly activation: ProfileActivation;
  /** The agent's committed token sum at start; undefined for non-agents. */
  readonly tokens0: number | undefined;
  /** The agent's committed cost sum at start; undefined for non-agents. */
  readonly cost0: number | undefined;
  peak: number;
  /** By JSON-encoded `[resource, category, tool, operation]`. */
  readonly operations: Map<string, Operation>;
  ended:
    | {
        readonly runtime: number;
        readonly tokens: number | undefined;
        readonly cost: number | undefined;
      }
    | undefined;
};

/**
 * Projects profile events into dataflow-profile JSONL training samples: one per successful graph
 * activation, keyed by its `/`-joined node IDs, plus standalone probe samples. In `usage` cost mode,
 * each cost usage event contributes its own USD sample and activation samples omit cost.
 */
export class JsonlRecorder implements ProfileRecorder<string> {
  readonly root: object = this;
  readonly path = "";
  readonly #file: string;
  readonly #monitored: boolean;
  readonly #costMode: "activation" | "usage";
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
  readonly #cost = new WeakMap<object, number>();
  /** Ended activations and standalone usage/probe samples, in record order. */
  #pending: (Activation | Sample)[] = [];
  #writing: Promise<void> = Promise.resolve();
  #failure: unknown;
  #closing: Promise<void> | undefined;

  constructor(options: JsonlRecorderOptions) {
    this.#file = options.path;
    this.#monitored = options.monitored ?? false;
    this.#costMode = options.costMode ?? "activation";
  }

  readonly record = (event: ProfileEvent<string>): void =>
    this.#reduce([], event);

  add_context(nodeId: string): ProfileRecorder<string> {
    return this.#contexts.add([], nodeId);
  }

  #reduce(ids: readonly string[], event: ProfileEvent<string>): void {
    if (this.#closing !== undefined) return;
    switch (event.kind) {
      case "probe":
        if (!Number.isFinite(event.value)) {
          this.#failure ??= new Error("JsonlRecorder: invalid probe value");
          return;
        }
        this.#pending.push({
          node: ids.join("/"),
          features: {},
          resources: {},
          units: {},
          firedAt: new Date().toISOString(),
          measurement: {
            probe: [{ edgeId: event.edgeId, value: event.value }],
          },
        });
        return;
      case "usage":
        if (event.resource === "tokens")
          this.#tokens.set(
            event.source,
            (this.#tokens.get(event.source) ?? 0) + event.usage.totalTokens,
          );
        else if (this.#costMode === "usage") {
          const cost = event.usage.cost?.total;
          if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
            this.#failure ??= new Error("JsonlRecorder: invalid cost sample");
            return;
          }
          this.#pending.push({
            node: ids.join("/"),
            features: {},
            resources: { cost },
            units: { cost: "USD" },
            firedAt: new Date().toISOString(),
            measurement: { usage: event.usage },
          });
        } else
          this.#cost.set(
            event.source,
            (this.#cost.get(event.source) ?? 0) +
              (event.usage.cost?.total ?? Number.NaN),
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
        if (event.category === "graph" && activation !== undefined) {
          const act: Activation = {
            node: ids.join("/"),
            activation,
            tokens0:
              activation.agent === undefined
                ? undefined
                : (this.#tokens.get(activation.agent) ?? 0),
            cost0:
              activation.agent === undefined
                ? undefined
                : (this.#cost.get(activation.agent) ?? 0),
            peak: 0,
            operations: new Map(),
            ended: undefined,
          };
          this.#active.set(activation, act);
          if (activation.owner !== undefined)
            this.#live.set(activation.owner, act);
        }
        this.#operation(ids, event);
        return;
      }
      case "finish": {
        this.#operation(ids, event);
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
          cost:
            agent === undefined || act.cost0 === undefined
              ? undefined
              : (this.#cost.get(agent) ?? 0) - act.cost0,
        };
        this.#pending.push(act);
        return;
      }
      case "metrics":
        this.#operation(ids, event);
        return;
    }
  }

  /** Sums an `edits`/`operations` event into its own activation, else the only live one at its node. */
  #operation(
    ids: readonly string[],
    event: Exclude<
      ProfileEvent<string>,
      { kind: "usage" | "resource" | "probe" }
    >,
  ): void {
    const { resource, category, tool, operation } = event;
    if (resource !== "edits" && resource !== "operations") return;
    const act =
      event.activation === undefined
        ? this.#onlyLive(ids.join("/"))
        : this.#active.get(event.activation);
    if (act === undefined) return;
    const key = JSON.stringify([resource, category, tool, operation]);
    let op = act.operations.get(key);
    if (op === undefined) {
      op = {
        resource,
        category,
        tool,
        operation,
        calls: 0,
        success: 0,
        error: 0,
        cancelled: 0,
        durationMs: 0,
        counters: {},
        gauges: {},
      };
      act.operations.set(key, op);
    }
    switch (event.kind) {
      case "start":
        op.calls += 1;
        return;
      case "finish":
        op[event.outcome] += 1;
        op.durationMs += event.durationMs;
        return;
      case "metrics":
        for (const [field, value] of Object.entries(event.counters ?? {}))
          op.counters[field] = (op.counters[field] ?? 0) + value;
        for (const [field, value] of Object.entries(event.gauges ?? {}))
          if (value === null) delete op.gauges[field];
          else op.gauges[field] = value;
        return;
    }
  }

  // ponytail: O(live) scan; concurrent same-path activations drop unstamped events, stamp producers with `activation` if that matters.
  #onlyLive(node: string): Activation | undefined {
    let found: Activation | undefined;
    for (const act of this.#active.values())
      if (act.node === node) {
        if (found !== undefined) return undefined;
        found = act;
      }
    return found;
  }

  #write(): Promise<void> {
    const batch = this.#pending;
    this.#pending = [];
    if (batch.length === 0) return this.#writing;
    let lines = "";
    for (const entry of batch) {
      if (!("activation" in entry)) {
        lines += `${JSON.stringify(entry)}\n`;
        continue;
      }
      const owner = entry.activation.owner;
      if (owner !== undefined && this.#latest.get(owner) === entry)
        this.#latest.delete(owner);
      const sample = this.#sampleOf(entry);
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
    const ended = act.ended ?? {
      runtime: 0,
      tokens: undefined,
      cost: undefined,
    };
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
    if (this.#costMode === "activation" && ended.cost !== undefined) {
      resources.cost = ended.cost;
      units.cost = "USD";
    }
    if (this.#monitored) {
      resources.memory = act.peak;
      units.memory = "B";
    }
    const measurement: Record<string, Omit<Operation, "resource">[]> = {};
    for (const { resource, ...row } of act.operations.values()) {
      const rows = measurement[resource] ?? [];
      rows.push(row);
      measurement[resource] = rows;
    }
    return {
      node: act.node,
      features: act.activation.features,
      resources,
      units,
      runId: act.activation.runId,
      firedAt: act.activation.firedAt,
      ...(act.operations.size === 0 ? {} : { measurement }),
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
