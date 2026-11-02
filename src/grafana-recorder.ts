import { randomUUID } from "node:crypto";
import type { VariableModel } from "@grafana/grafana-foundation-sdk/dashboard";
import {
  type NativeResourceEvent,
  type ProfileEvent,
  type ProfileRecorder,
  profileContexts,
} from "junco-tools";

/** Options of `GrafanaRecorder.create`. */
export type GrafanaRecorderOptions = {
  /** Grafana base URL, without credentials; default `http://localhost:8000`. */
  readonly url?: string;
  /** Managed dashboard UID; default `junco-telemetry`. */
  readonly dashboard?: string;
  /** Metrics push interval; default 1000 ms. */
  readonly intervalMs?: number;
};

type Sample = NonNullable<NativeResourceEvent["sample"]>;

type Node = {
  readonly path: string;
  /** Finished pipelines' cumulative values, by wire field. */
  readonly finished: Map<string, number>;
  /** Maximum reported single-pipeline peak. */
  memoryPeak: number;
  /** Maximum of sampled active-memory sums and single-pipeline peaks. */
  peak: number;
  measured: boolean;
  /** Committed usage sums, by wire field; undefined until usage is observed. */
  usage: Map<string, number> | undefined;
  pendingTokens: number;
};

type Pipeline = { readonly node: Node; last: Sample | undefined };

type Rollup = { readonly path: string; peak: number };

type Operation = {
  readonly attributes: ReturnType<typeof attribute>[];
  calls: number;
  inflight: number;
  success: number;
  errors: number;
  cancelled: number;
  durationSum: number;
  durationMax: number;
  durationLast: number;
  pendingCalls: number;
  readonly counters: Map<string, number>;
  readonly gauges: Map<string, number>;
  exportedFields: Set<string>;
};

const DASHBOARD = "junco-telemetry";
const BENCHMARK_DASHBOARDS = new Set([
  "junco-cooperbench",
  "junco-swebench",
  "junco-msbench",
]);
const DASHBOARDS =
  "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards";
const PUSH_LIMIT = 500 * 1024;
const TIMEOUT_MS = 5000;
const FIELD = /^[a-z][a-z0-9_]*$/;
const PROMETHEUS = { type: "prometheus", uid: "junco-prometheus" };

/** Native sample fields and their wire names; `memory_bytes`/`pids` are current, others cumulative. */
const SAMPLE_FIELDS = [
  ["elapsedMs", "elapsed_ms"],
  ["memoryBytes", "memory_bytes"],
  ["memoryPeakBytes", "memory_peak_bytes"],
  ["cpuUsageMs", "cpu_usage_ms"],
  ["cpuUserMs", "cpu_user_ms"],
  ["cpuSystemMs", "cpu_system_ms"],
  ["cpuThrottledMs", "cpu_throttled_ms"],
  ["pids", "pids"],
  ["oomKills", "oom_kills"],
] as const;
const CUMULATIVE = SAMPLE_FIELDS.filter(
  ([, field]) =>
    field !== "memory_bytes" &&
    field !== "pids" &&
    field !== "memory_peak_bytes",
);
const TOKEN_FIELDS = [
  "tokens_used",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;
const COST_FIELDS = [
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
] as const;

const within = (path: string, node: Node) =>
  path === "" || node.path === path || node.path.startsWith(`${path}::`);
const label = (path: string) => (path === "" ? "::" : path);
const attribute = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

export type ProfileMetricPoint = {
  attributes: { key: string; value: { stringValue: string } }[];
  timeUnixNano: string;
  asDouble?: number;
  flags?: number;
};
export type ProfileMetric = {
  name: string;
  gauge: { dataPoints: ProfileMetricPoint[] };
};
function* payload(
  metrics: readonly ProfileMetric[],
  kind: "probe" | "snapshot",
): Generator<string> {
  const start = '{"resourceMetrics":[{"scopeMetrics":[{"metrics":[';
  const end = "]}]}]}";
  const metricEnd = "]}}";
  const envelopeBytes = start.length + end.length;
  let chunks: string[] = [];
  let bytes = envelopeBytes;
  for (const metric of metrics) {
    const head = `{"name":${JSON.stringify(metric.name)},"gauge":{"dataPoints":[`;
    const metricBytes = Buffer.byteLength(head) + metricEnd.length;
    let points: string[] = [];
    for (const point of metric.gauge.dataPoints) {
      const text = JSON.stringify(point);
      const pointBytes = Buffer.byteLength(text);
      let extra =
        pointBytes +
        (points.length === 0 ? metricBytes + Number(chunks.length > 0) : 1);
      if (bytes + extra > PUSH_LIMIT) {
        if (points.length > 0) chunks.push(head + points.join(",") + metricEnd);
        if (chunks.length > 0) yield start + chunks.join(",") + end;
        chunks = [];
        points = [];
        bytes = envelopeBytes;
        extra = metricBytes + pointBytes;
        if (bytes + extra > PUSH_LIMIT)
          throw new Error(`GrafanaRecorder: ${kind} exceeds 500 KiB`);
      }
      points.push(text);
      bytes += extra;
    }
    if (points.length > 0) chunks.push(head + points.join(",") + metricEnd);
  }
  yield start + chunks.join(",") + end;
}

/** Shared validation for live recording and dashboard-only provisioning. */
function configuration(options: GrafanaRecorderOptions) {
  const { intervalMs = 1000, dashboard = DASHBOARD } = options;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new Error("GrafanaRecorder: intervalMs must be positive");
  if (typeof dashboard !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(dashboard))
    throw new Error(
      "GrafanaRecorder: dashboard must match ^[A-Za-z0-9_-]{1,40}$",
    );
  const url = URL.parse(options.url ?? "http://localhost:8000");
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error(
      "GrafanaRecorder: url must be an http(s) URL without credentials",
    );
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { base, intervalMs, dashboard };
}

/** Provisions a managed dashboard without creating a telemetry session or recording metrics. */
export async function provisionGrafanaDashboard(
  options: GrafanaRecorderOptions = {},
): Promise<void> {
  const { base, dashboard } = configuration(options);
  await provision(base, dashboard);
}

/** Clock-free accounting shared by live recording and offline receipt-time replay. */
export class ProfileMetricState {
  readonly #streamId: string;
  readonly #dashboard: string;
  readonly #nodes = new Map<string, Node>();
  readonly #rollups = new Map<string, Rollup>();
  readonly #operations = new Map<string, Operation>();
  readonly #pipelines = new Map<object, Map<string, Pipeline>>();
  readonly #active = new Set<Pipeline>();
  readonly #probeTimes = new Map<string, number>();
  #snapshotMs = 0;
  #peak = 0;

  constructor(streamId: string, dashboard: string) {
    this.#streamId = streamId;
    this.#dashboard = dashboard;
  }

  /** Reduces an event once; probe points are returned for immediate live delivery. */
  record(
    path: string,
    event: ProfileEvent<string>,
    receiptMs: number,
  ): readonly ProfileMetric[] | undefined {
    if (event.kind === "usage") this.#usage(path, event.resource, event.usage);
    else if (event.kind === "resource")
      this.#resource(path, event.source, event.event);
    else if (event.kind === "probe")
      return this.#probe(path, event.edgeId, event.value, receiptMs);
    else this.#operation(path, event);
  }

  clear(): void {
    this.#nodes.clear();
    this.#rollups.clear();
    this.#operations.clear();
    this.#pipelines.clear();
    this.#active.clear();
    this.#probeTimes.clear();
    this.#snapshotMs = 0;
    this.#peak = 0;
  }

  #node(path: string): Node {
    let node = this.#nodes.get(path);
    if (node === undefined) {
      node = {
        path,
        finished: new Map(),
        memoryPeak: 0,
        peak: 0,
        measured: false,
        usage: undefined,
        pendingTokens: 0,
      };
      this.#nodes.set(path, node);
    }
    return node;
  }

  #probe(
    path: string,
    edgeId: string,
    value: number,
    receiptMs: number,
  ): readonly ProfileMetric[] {
    if (!Number.isFinite(value))
      throw new Error("GrafanaRecorder: invalid probe value");
    const key = JSON.stringify([path, edgeId]);
    // ponytail: collision bursts advance this series by 1ms per point, without creating new series.
    const ms = Math.max(receiptMs, (this.#probeTimes.get(key) ?? 0) + 1);
    this.#probeTimes.set(key, ms);
    return [
      {
        name: "junco_probe_value",
        gauge: {
          dataPoints: [
            {
              attributes: [
                attribute("stream", this.#streamId),
                attribute("dashboard", this.#dashboard),
                attribute("node", label(path)),
                attribute("edge_id", edgeId),
              ],
              timeUnixNano: String(BigInt(ms) * 1_000_000n),
              asDouble: value,
            },
          ],
        },
      },
    ];
  }

  #usage(
    path: string,
    resource: "tokens" | "cost",
    usage: Extract<ProfileEvent<string>, { kind: "usage" }>["usage"],
  ): void {
    const values: [string, number | undefined][] =
      resource === "tokens"
        ? [
            ["tokens_used", usage.totalTokens],
            ["input_tokens", usage.input],
            ["output_tokens", usage.output],
            ["cache_read_tokens", usage.cacheRead],
            ["cache_write_tokens", usage.cacheWrite],
            ["cache_write_1h_tokens", usage.cacheWrite1h],
            ["reasoning_tokens", usage.reasoning],
          ]
        : [
            ["cost_input", usage.cost?.input],
            ["cost_output", usage.cost?.output],
            ["cost_cache_read", usage.cost?.cacheRead],
            ["cost_cache_write", usage.cost?.cacheWrite],
            ["cost_total", usage.cost?.total],
          ];
    // Only the one-hour cache split and reasoning are optional; both are subsets, never zero-filled.
    if (
      values.some(([field, value]) =>
        value === undefined
          ? field !== "cache_write_1h_tokens" && field !== "reasoning_tokens"
          : !Number.isFinite(value),
      )
    ) {
      throw new Error("GrafanaRecorder: invalid usage");
    }
    const node = this.#node(path);
    node.usage ??= new Map();
    for (const [field, value] of values)
      if (value !== undefined)
        node.usage.set(field, (node.usage.get(field) ?? 0) + value);
    if (resource === "tokens") node.pendingTokens += usage.totalTokens;
  }

  #resource(path: string, source: object, event: NativeResourceEvent): void {
    const { sample } = event;
    if (
      sample !== undefined &&
      SAMPLE_FIELDS.some(
        ([key]) => !Number.isFinite(sample[key]) || sample[key] < 0,
      )
    ) {
      throw new Error("GrafanaRecorder: invalid resource sample");
    }
    let pipelines = this.#pipelines.get(source);
    if (pipelines === undefined) {
      pipelines = new Map();
      this.#pipelines.set(source, pipelines);
    }
    const key = `${event.owner ?? ""}\0${event.pipelineId}`;
    let pipeline = pipelines.get(key);
    if (pipeline === undefined) {
      pipeline = { node: this.#node(path), last: undefined };
      pipelines.set(key, pipeline);
      this.#active.add(pipeline);
    }
    if (sample !== undefined) this.#sample(pipeline, sample);
    if (event.kind !== "finished") return;
    const { node, last } = pipeline;
    if (last !== undefined)
      for (const [key, field] of CUMULATIVE)
        node.finished.set(field, (node.finished.get(field) ?? 0) + last[key]);
    pipelines.delete(key);
    this.#active.delete(pipeline);
  }

  #sample(pipeline: Pipeline, sample: Sample): void {
    pipeline.last = sample;
    const { node } = pipeline;
    node.measured = true;
    node.memoryPeak = Math.max(node.memoryPeak, sample.memoryPeakBytes);
    const peak = (current: number, contains: (node: Node) => boolean) => {
      let sum = 0;
      for (const { node, last } of this.#active)
        if (contains(node)) sum += last?.memoryBytes ?? 0;
      return Math.max(current, sample.memoryPeakBytes, sum);
    };
    node.peak = peak(node.peak, (other) => other === node);
    this.#peak = peak(this.#peak, () => true);
    for (const rollup of this.#rollups.values())
      if (within(rollup.path, node))
        rollup.peak = peak(rollup.peak, (other) => within(rollup.path, other));
  }

  #operation(
    path: string,
    event: Exclude<
      ProfileEvent<string>,
      { kind: "usage" | "resource" | "probe" }
    >,
  ): void {
    const { resource, category, tool, operation } = event;
    if (resource === "" || category === "" || operation === "") {
      throw new Error("GrafanaRecorder: invalid operation labels");
    }
    if (
      event.kind === "finish" &&
      (!Number.isFinite(event.durationMs) || event.durationMs < 0)
    ) {
      throw new Error("GrafanaRecorder: invalid duration");
    }
    if (event.kind === "metrics") {
      const entries = [
        ...Object.entries(event.counters ?? {}),
        ...Object.entries(event.gauges ?? {}),
      ];
      if (
        entries.some(
          ([field, value]) =>
            !FIELD.test(field) || (value !== null && !Number.isFinite(value)),
        )
      ) {
        throw new Error("GrafanaRecorder: invalid metrics");
      }
    }
    const key = JSON.stringify([path, resource, category, tool, operation]);
    let op = this.#operations.get(key);
    if (op === undefined) {
      op = {
        attributes: [
          attribute("node", label(path)),
          attribute("resource", resource),
          attribute("category", category),
          ...(tool === "" ? [] : [attribute("tool", tool)]),
          attribute("operation", operation),
        ],
        calls: 0,
        inflight: 0,
        success: 0,
        errors: 0,
        cancelled: 0,
        durationSum: 0,
        durationMax: 0,
        durationLast: 0,
        pendingCalls: 0,
        counters: new Map(),
        gauges: new Map(),
        exportedFields: new Set(),
      };
      this.#operations.set(key, op);
    }
    switch (event.kind) {
      case "start":
        op.calls += 1;
        op.inflight += 1;
        op.pendingCalls += 1;
        if (
          category === "graph" &&
          operation === "evaluate" &&
          !this.#rollups.has(path)
        )
          this.#rollups.set(path, { path, peak: 0 });
        return;
      case "finish":
        op.inflight -= 1;
        if (event.outcome === "success") op.success += 1;
        else if (event.outcome === "error") op.errors += 1;
        else op.cancelled += 1;
        op.durationSum += event.durationMs;
        op.durationMax = Math.max(op.durationMax, event.durationMs);
        op.durationLast = event.durationMs;
        return;
      case "metrics":
        for (const [field, value] of Object.entries(event.counters ?? {}))
          op.counters.set(field, (op.counters.get(field) ?? 0) + value);
        for (const [field, value] of Object.entries(event.gauges ?? {}))
          if (value === null) op.gauges.delete(field);
          else op.gauges.set(field, value);
        return;
    }
  }

  /** Resource and token fields of the nodes `contains` selects, whose sampled peak is `peak`. */
  #fields(
    contains: (node: Node) => boolean,
    peak: number,
    seconds: number,
    total: boolean,
  ): Map<string, number> {
    const fields = new Map<string, number>();
    const add = (field: string, value: number) =>
      fields.set(field, (fields.get(field) ?? 0) + value);
    let measured = false;
    let memoryPeak = 0;
    let pending = 0;
    let tokens = total;
    let costs = total;
    for (const node of this.#nodes.values()) {
      if (!contains(node)) continue;
      pending += node.pendingTokens;
      if (node.usage !== undefined) {
        const hasTokens = node.usage.has("tokens_used");
        const hasCosts = node.usage.has("cost_total");
        tokens ||= hasTokens;
        costs ||= hasCosts;
        if (hasTokens) for (const field of TOKEN_FIELDS) add(field, 0);
        if (hasCosts) for (const field of COST_FIELDS) add(field, 0);
        for (const [field, value] of node.usage) add(field, value);
      }
      if (!node.measured) continue;
      measured = true;
      memoryPeak = Math.max(memoryPeak, node.memoryPeak);
      peak = Math.max(peak, node.peak);
      for (const [field, value] of node.finished) add(field, value);
    }
    if (tokens) {
      for (const field of TOKEN_FIELDS) add(field, 0);
      fields.set("tokens_per_second", seconds > 0 ? pending / seconds : 0);
    }
    if (costs) for (const field of COST_FIELDS) add(field, 0);
    if (!measured) return fields;
    for (const [, field] of SAMPLE_FIELDS) add(field, 0);
    for (const { node, last } of this.#active)
      if (last !== undefined && contains(node))
        for (const [key, field] of SAMPLE_FIELDS)
          if (field !== "memory_peak_bytes") add(field, last[key]);
    fields.set("memory_peak_bytes", memoryPeak);
    fields.set("peak_memory_bytes", peak);
    return fields;
  }

  /** One OTLP snapshot; positive elapsed time consumes the rate baselines it reports. */
  snapshot(receiptMs: number, elapsedMs: number): readonly ProfileMetric[] {
    const seconds = elapsedMs / 1000;
    this.#snapshotMs = Math.max(receiptMs, this.#snapshotMs + 1);
    const timeUnixNano = String(BigInt(this.#snapshotMs) * 1_000_000n);
    const metrics = new Map<string, ProfileMetric>();
    const point = (
      measurement: string,
      field: string,
      attributes: ReturnType<typeof attribute>[],
      value?: number,
    ) => {
      const name = `${measurement}_${field}`;
      let metric = metrics.get(name);
      if (metric === undefined) {
        metric = { name, gauge: { dataPoints: [] } };
        metrics.set(name, metric);
      }
      metric.gauge.dataPoints.push({
        attributes: [
          attribute("stream", this.#streamId),
          attribute("dashboard", this.#dashboard),
          ...attributes,
        ],
        timeUnixNano,
        ...(value === undefined ? { flags: 1 } : { asDouble: value }),
      });
    };
    const line = (
      measurement: string,
      attributes: ReturnType<typeof attribute>[],
      fields: Map<string, number>,
    ) => {
      for (const [field, value] of fields)
        point(measurement, field, attributes, value);
    };
    line(
      "junco_total",
      [],
      this.#fields(() => true, this.#peak, seconds, true),
    );
    for (const node of this.#nodes.values())
      line(
        "junco_node",
        [attribute("node", label(node.path))],
        this.#fields((other) => other === node, node.peak, seconds, false),
      );
    for (const rollup of this.#rollups.values())
      line(
        "junco_context",
        [attribute("node", label(rollup.path))],
        this.#fields(
          (node) => within(rollup.path, node),
          rollup.peak,
          seconds,
          false,
        ),
      );
    for (const op of this.#operations.values()) {
      const completed = op.success + op.errors + op.cancelled;
      const fields = new Map<string, number>([
        ["calls", op.calls],
        ["inflight", op.inflight],
        ["success", op.success],
        ["errors", op.errors],
        ["cancelled", op.cancelled],
        ["duration_ms_sum", op.durationSum],
        ["duration_ms_max", op.durationMax],
        ["duration_ms_last", op.durationLast],
        ["duration_ms_mean", completed === 0 ? 0 : op.durationSum / completed],
        ["calls_per_second", seconds > 0 ? op.pendingCalls / seconds : 0],
        ...op.counters,
        ...op.gauges,
      ]);
      line("junco_operation", op.attributes, fields);
      for (const field of op.exportedFields)
        if (!fields.has(field)) point("junco_operation", field, op.attributes);
      op.exportedFields = new Set(fields.keys());
    }
    if (seconds > 0) {
      for (const node of this.#nodes.values()) node.pendingTokens = 0;
      for (const op of this.#operations.values()) op.pendingCalls = 0;
    }
    return [...metrics.values()];
  }
}

/** Persists profile events as metrics of one session `streamId`. */
export class GrafanaRecorder implements ProfileRecorder<string> {
  readonly root: object = this;
  readonly path = "";
  /** This session's metrics; select them with the dashboard's `stream` variable. */
  readonly streamId = `junco_${randomUUID().replaceAll("-", "")}`;
  readonly dashboardUrl: string;
  readonly #base: string;
  readonly #state: ProfileMetricState;
  readonly #intervalMs: number;
  readonly #contexts = profileContexts(
    this,
    (_ids, path, event) => this.#reduce(path, event),
    () => {
      if (this.#closing !== undefined)
        throw new Error("GrafanaRecorder: closed");
    },
  );
  /** Probe points awaiting their own push, in record order. */
  #probes: (readonly ProfileMetric[])[] = [];
  #clock: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #drain: Promise<void> = Promise.resolve();
  #queued = 0;
  #stopped = false;
  #failure: unknown;
  #closing: Promise<void> | undefined;

  private constructor(base: string, intervalMs: number, dashboard: string) {
    this.#base = base;
    this.#state = new ProfileMetricState(this.streamId, dashboard);
    this.#intervalMs = intervalMs;
    this.dashboardUrl = `${base}/d/${dashboard}?var-stream=${this.streamId}`;
  }

  /** Validates `options` and provisions the dashboard; rejects before any work on failure. */
  static async create(
    options: GrafanaRecorderOptions = {},
  ): Promise<GrafanaRecorder> {
    const { base, intervalMs, dashboard } = configuration(options);
    const recorder = new GrafanaRecorder(base, intervalMs, dashboard);
    await provision(base, dashboard, recorder.streamId);
    return recorder;
  }

  readonly record = (event: ProfileEvent<string>): void =>
    this.#reduce("", event);

  add_context(nodeId: string): ProfileRecorder<string> {
    return this.#contexts.add([], nodeId);
  }

  flush(): Promise<void> {
    return this.#closing ?? this.#flush();
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      clearInterval(this.#timer);
      try {
        await this.#flush();
      } finally {
        this.#contexts.clear();
        this.#state.clear();
        this.#probes = [];
      }
    })();
    return this.#closing;
  }

  async #flush(): Promise<void> {
    await this.#enqueue();
    if (this.#failure !== undefined) throw this.#failure;
  }

  #fail(error: unknown): void {
    this.#failure ??= error;
  }

  #reduce(path: string, event: ProfileEvent<string>): void {
    if (this.#closing !== undefined) return;
    if (this.#clock === undefined) {
      this.#clock = performance.now();
      this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
      this.#timer.unref();
    }
    if (event.kind === "probe" && this.#stopped) return;
    try {
      const metrics = this.#state.record(path, event, Date.now());
      if (metrics !== undefined) this.#probes.push(metrics);
    } catch (error) {
      this.#fail(error);
    }
  }

  #snapshot(): readonly ProfileMetric[] {
    const now = performance.now();
    const elapsedMs = this.#clock === undefined ? 0 : now - this.#clock;
    const metrics = this.#state.snapshot(Date.now(), elapsedMs);
    if (elapsedMs > 0) this.#clock = now;
    return metrics;
  }

  #tick(): void {
    if (this.#queued === 0 && !this.#stopped) void this.#enqueue();
  }

  #enqueue(): Promise<void> {
    this.#queued += 1;
    this.#drain = this.#drain
      .then(() => this.#push())
      .finally(() => {
        this.#queued -= 1;
      });
    return this.#drain;
  }

  /** Pushes the queued probe points one request each, then the snapshot; any failure stops pushing. */
  async #push(): Promise<void> {
    if (this.#stopped) return;
    const probes = this.#probes;
    this.#probes = [];
    try {
      // ponytail: one sequential request per probe point; batch distinct series if probe rates outgrow it.
      for (const metrics of probes) await this.#send("probe", metrics);
      await this.#send("snapshot", this.#snapshot());
    } catch (error) {
      this.#stopped = true;
      this.#probes = [];
      clearInterval(this.#timer);
      this.#fail(error);
    }
  }

  async #send(
    kind: "probe" | "snapshot",
    metrics: readonly ProfileMetric[],
  ): Promise<void> {
    for (const body of payload(metrics, kind)) {
      if (Buffer.byteLength(body) > PUSH_LIMIT)
        throw new Error(`GrafanaRecorder: ${kind} exceeds 500 KiB`);
      const response = await request(
        `${this.#base}/api/telemetry/metrics`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body,
        },
        "metrics push",
      );
      await response.body?.cancel();
      if (!response.ok) throw failure("metrics push", response);
    }
  }
}

const failure = (operation: string, response: Response) =>
  new Error(
    `GrafanaRecorder: ${operation} failed with status ${response.status}`,
  );

/** `fetch` without redirects, bounded by the timeout; errors name only `operation` and cause kind. */
async function request(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `GrafanaRecorder: ${operation} failed (${error instanceof Error ? error.name : "error"})`,
    );
  }
}

type DashboardResource = {
  readonly metadata?: Record<string, unknown>;
  readonly spec?: { readonly tags?: unknown } & Record<string, unknown>;
};

async function readDashboard(
  response: Response,
  operation: string,
): Promise<DashboardResource> {
  if (!response.ok) {
    await response.body?.cancel();
    throw failure(operation, response);
  }
  try {
    return (await response.json()) as DashboardResource;
  } catch {
    throw new Error(`GrafanaRecorder: ${operation} returned invalid JSON`);
  }
}

const tagged = (resource: DashboardResource) =>
  Array.isArray(resource.spec?.tags) && resource.spec.tags.includes(DASHBOARD);

/** Whether `actual` has every value of `expected`, recursively; extra server fields are ignored. */
const matches = (actual: unknown, expected: unknown): boolean =>
  typeof expected !== "object" || expected === null
    ? Object.is(actual, expected)
    : typeof actual === "object" &&
      actual !== null &&
      Array.isArray(actual) === Array.isArray(expected) &&
      (!Array.isArray(expected) ||
        (actual as unknown[]).length === expected.length) &&
      Object.entries(expected).every(([key, value]) =>
        matches((actual as Record<string, unknown>)[key], value),
      );

/**
 * Creates or updates the managed dashboard; an existing untagged or differing raced dashboard
 * at its UID is a conflict, never overwritten.
 */
async function provision(
  base: string,
  dashboardUid: string,
  streamId = "junco_00000000000000000000000000000000",
): Promise<void> {
  const spec = JSON.parse(
    JSON.stringify(await dashboard(dashboardUid, streamId)),
  ) as Record<string, unknown>;
  const item = `${base}${DASHBOARDS}/${dashboardUid}`;
  const lookup = {
    headers: { Accept: "application/json" },
  };
  const write = (method: string, url: string, metadata: unknown) =>
    request(
      url,
      {
        method,
        headers: { ...lookup.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          apiVersion: "dashboard.grafana.app/v1",
          kind: "Dashboard",
          metadata,
          spec,
        }),
      },
      `${method === "POST" ? "dashboard creation" : "dashboard update"} (${dashboardUid})`,
    );
  const lookupOperation = `dashboard lookup (${dashboardUid})`;
  const found = await request(item, lookup, lookupOperation);
  if (found.status === 404) {
    await found.body?.cancel();
    const created = await write("POST", `${base}${DASHBOARDS}`, {
      name: dashboardUid,
    });
    await created.body?.cancel();
    if (created.ok) return;
    if (created.status !== 409)
      throw failure(`dashboard creation (${dashboardUid})`, created);
    const raced = await readDashboard(
      await request(item, lookup, lookupOperation),
      lookupOperation,
    );
    // Only the generated stream textbox selection may differ between concurrent sessions.
    const variable = (
      raced.spec?.templating as { list?: Partial<VariableModel>[] } | undefined
    )?.list?.[0];
    const current = variable?.current;
    if (
      variable?.name === "stream" &&
      variable.type === "textbox" &&
      typeof variable.query === "string" &&
      /^junco_[0-9a-f]{32}$/.test(variable.query) &&
      current != null &&
      current.text === variable.query &&
      current.value === variable.query
    ) {
      variable.query = streamId;
      current.text = streamId;
      current.value = streamId;
    }
    if (
      !tagged(raced) ||
      !matches(raced.spec, spec) ||
      !matches(spec.templating, raced.spec?.templating)
    )
      throw new Error(
        `GrafanaRecorder: dashboard ${dashboardUid} was concurrently created with a different spec`,
      );
    return;
  }
  const existing = await readDashboard(found, lookupOperation);
  if (!tagged(existing))
    throw new Error(
      `GrafanaRecorder: dashboard ${dashboardUid} exists without tag ${DASHBOARD}`,
    );
  const updated = await write("PUT", item, existing.metadata);
  await updated.body?.cancel();
  if (!updated.ok) throw failure(`dashboard update (${dashboardUid})`, updated);
}

/** The managed dashboard queries persisted session metrics. */
async function dashboard(dashboardUid: string, streamId: string) {
  const [dashboard, stat, timeseries, table, common, prometheus] =
    await Promise.all([
      import("@grafana/grafana-foundation-sdk/dashboard"),
      import("@grafana/grafana-foundation-sdk/stat"),
      import("@grafana/grafana-foundation-sdk/timeseries"),
      import("@grafana/grafana-foundation-sdk/table"),
      import("@grafana/grafana-foundation-sdk/common"),
      import("@grafana/grafana-foundation-sdk/prometheus"),
    ]);
  const benchmark = BENCHMARK_DASHBOARDS.has(dashboardUid);
  const selector = benchmark
    ? `dashboard="${dashboardUid}",stream=~"\${stream:regex}"`
    : `${dashboardUid === DASHBOARD ? "" : `dashboard="${dashboardUid}",`}stream="$stream"`;
  const history =
    "Historical backfills are reconstructed receipt-time snapshots and rates, not original Grafana Live samples. Missing memory, probes, and output observations are not recorded.";
  const query = (expr: string, instant = false) => {
    const builder = new prometheus.DataqueryBuilder()
      .refId("A")
      .datasource(PROMETHEUS)
      .expr(expr)
      .format(prometheus.PromQueryFormat.TimeSeries);
    if (benchmark) builder.legendFormat("{{stream}} {{node}} {{__name__}}");
    return instant ? builder.instant() : builder.range();
  };
  const memoryScope =
    "Shell-pipeline cgroup memory sampled by the native monitor, not host heap.";
  const containerPeak = `junco_operation_peak_memory_bytes{${selector},resource="memory",category="benchmark",operation="container_memory",node="::"}`;
  const pipelinePeak = `junco_total_peak_memory_bytes{${selector}}`;
  // Select the whole-container HWM before aggregation; pipeline peaks overlap it.
  const sessionPeak = `(max without (node, resource, category, tool, operation) (${benchmark ? `max_over_time(${containerPeak}[$__range])` : containerPeak}) or on (dashboard, stream) ${benchmark ? `max_over_time(${pipelinePeak}[$__range])` : pipelinePeak})`;
  const peakScope =
    "Kernel-measured whole-container high-water mark when recorded, including all processes and cache; not attributable to nodes. Otherwise the sampled pipeline aggregate: maximum active-pipeline sum or single-pipeline high-water mark, with independently timed samples.";
  const stats = [
    {
      title: "Current pipeline memory",
      field: "memory_bytes",
      unit: "bytes",
      grid: { x: 0, y: 0, w: 8, h: 4 },
      description: `${memoryScope} Sum of current memory of the session's active pipelines.`,
    },
    {
      title: "Session memory peak",
      field: "peak_memory_bytes",
      unit: "bytes",
      grid: { x: 8, y: 0, w: 8, h: 4 },
      description: peakScope,
    },
    {
      title: "Total tokens used",
      field: "tokens_used",
      unit: "suffix:tokens",
      grid: { x: 16, y: 0, w: 8, h: 4 },
      description:
        "Committed provider-reported tokens of this session, excluding restored history.",
    },
  ];
  const series = [
    {
      title: "Memory per node",
      measurement: "junco_node",
      field: "memory_bytes",
      unit: "bytes",
      grid: { x: 0, y: 4, w: 12, h: 8 },
      description: `${memoryScope} Direct per-node values; parents do not include children here.`,
    },
    {
      title: "Tokens per node",
      measurement: "junco_node",
      field: "tokens_used",
      unit: "suffix:tokens",
      grid: { x: 12, y: 4, w: 12, h: 8 },
      description: "Committed tokens recorded directly at each node.",
    },
    {
      title: "Tokens/sec",
      measurement: "junco_total",
      field: "tokens_per_second",
      unit: "suffix:tokens/s",
      grid: { x: 0, y: 12, w: 12, h: 8 },
      description:
        "Committed tokens per reporting interval second, not model decode speed.",
    },
    {
      title: "Tokens/node/sec",
      measurement: "junco_node",
      field: "tokens_per_second",
      unit: "suffix:tokens/s",
      grid: { x: 12, y: 12, w: 12, h: 8 },
      description:
        "Committed tokens per reporting interval second recorded directly at each node.",
    },
  ];
  const tables = [
    {
      title: "Tool and execution metrics",
      targets: [
        query(
          `last_over_time({__name__=~"junco_operation_.+",${selector}}[$__range])`,
          true,
        ),
      ],
      grid: { x: 0, y: 28, w: 24, h: 12 },
      description:
        "Latest operation counters and gauges by node, resource, category, tool and operation; metric names carry units.",
    },
    {
      title: "Resource and token details",
      targets: [
        query(
          `last_over_time({__name__=~"junco_(node|total)_.+",${selector}}[$__range])`,
          true,
        ),
      ],
      grid: { x: 0, y: 40, w: 24, h: 10 },
      description:
        "Direct per-node resource and token fields; rows without a node label are session totals.",
    },
    {
      title: "Graph context totals",
      targets: [
        query(
          `last_over_time({__name__=~"junco_context_.+",${selector}}[$__range])`,
          true,
        ),
      ],
      grid: { x: 0, y: 50, w: 24, h: 10 },
      description:
        "Inclusive rollups of each evaluated graph context over its descendants.",
    },
  ];
  const board = new dashboard.DashboardBuilder(
    benchmark ? dashboardUid : "Junco telemetry",
  )
    .uid(dashboardUid)
    .tags([DASHBOARD])
    .time({ from: benchmark ? "now-15d" : "now-15m", to: "now" })
    .refresh(benchmark ? "30s" : "1s");
  let id = 0;
  if (benchmark) {
    const discovery = `query_result(last_over_time(junco_total_tokens_used{dashboard="${dashboardUid}"}[$__range]))`;
    const lifetime =
      "Recorded lifetime totals of sessions observed in the selected range, not usage increments earned only within that range.";
    board.description(`${lifetime} ${history}`).withVariable(
      new dashboard.QueryVariableBuilder("stream")
        .label("Telemetry session")
        .datasource(PROMETHEUS)
        .query(discovery)
        .definition(discovery)
        .regex('/stream="([^"]+)"/')
        .multi(true)
        .includeAll(true)
        .allValue(".*")
        .allowCustomValue(false)
        .refresh(dashboard.VariableRefresh.OnTimeRangeChanged)
        .sort(dashboard.VariableSort.AlphabeticalAsc)
        .options([{ text: "All", value: "$__all", selected: true }])
        .current({ text: "All", value: "$__all" }),
    );
    const overview = [
      {
        title: "Recorded sessions",
        expr: `count(last_over_time(junco_total_tokens_used{${selector}}[$__range]))`,
        unit: "short",
        description:
          "Sessions with recorded committed-token totals observed in the selected range.",
      },
      {
        title: "Committed lifetime tokens",
        expr: `sum(last_over_time(junco_total_tokens_used{${selector}}[$__range]))`,
        unit: "suffix:tokens",
        description: lifetime,
      },
      {
        title: "Recorded lifetime cost",
        expr: `sum(last_over_time(junco_total_cost_total{${selector}}[$__range]))`,
        unit: "currencyUSD",
        description: `${lifetime} Recorded cost ledger, not inferred billed expenditure.`,
      },
      {
        title: "Largest individual-session memory peak",
        expr: `max(${sessionPeak})`,
        unit: "bytes",
        description: `${peakScope} Largest individual-session peak, never a sum of session peaks or simultaneous campaign memory.`,
      },
    ];
    for (const [index, panel] of overview.entries()) {
      const builder = new stat.PanelBuilder()
        .id(++id)
        .title(panel.title)
        .description(`${panel.description} ${history}`)
        .datasource(PROMETHEUS)
        .gridPos({ x: index * 6, y: 0, w: 6, h: 4 })
        .unit(panel.unit)
        .noValue(index === 0 ? "No recorded sessions" : "Not recorded")
        .reduceOptions(
          new common.ReduceDataOptionsBuilder()
            .values(false)
            .calcs(["lastNotNull"]),
        )
        .withTarget(query(panel.expr, true));
      if (index === 2) builder.decimals(9);
      board.withPanel(builder);
    }
    board.withPanel(
      new table.PanelBuilder()
        .id(++id)
        .title("Per-session lifetime totals")
        .description(
          `${lifetime} Stream, campaign and completion labels identify reconstructed complete and partial sessions. Missing measurements stay absent. ${peakScope} ${history}`,
        )
        .datasource(PROMETHEUS)
        .gridPos({ x: 0, y: 4, w: 24, h: 10 })
        .filterable(true)
        .noValue("Not recorded")
        .targets(
          ["tokens_used", "cost_total", "peak_memory_bytes"].map(
            (field, index) =>
              query(
                field === "peak_memory_bytes"
                  ? sessionPeak
                  : `last_over_time(junco_total_${field}{${selector}}[$__range])`,
                true,
              )
                .refId(String.fromCharCode(65 + index))
                .format(prometheus.PromQueryFormat.Table),
          ),
        )
        .withTransformation({
          id: "filterFieldsByName",
          options: { include: { pattern: "^(?!__name__$).*" } },
        })
        .withTransformation({ id: "merge", options: {} })
        .withTransformation({
          id: "organize",
          options: {
            excludeByName: { Time: true },
            renameByName: {
              "Value #A": "Committed tokens",
              "Value #B": "Recorded cost (USD)",
              "Value #C": "Measured session peak (bytes)",
            },
          },
        }),
    );
  } else {
    board.withVariable(
      new dashboard.TextBoxVariableBuilder("stream")
        .label("Telemetry session")
        .defaultValue(streamId)
        .current({ text: streamId, value: streamId }),
    );
  }
  const row = benchmark
    ? new dashboard.RowBuilder(
        "Session drill-down — select a session before expanding",
      )
        .id(++id)
        .collapsed(true)
        .gridPos({ x: 0, y: 14, w: 24, h: 1 })
    : undefined;
  const details = row ?? board;
  const offset = benchmark ? 15 : 0;
  for (const panel of stats)
    details.withPanel(
      new stat.PanelBuilder()
        .id(++id)
        .title(panel.title)
        .description(
          benchmark ? `${panel.description} ${history}` : panel.description,
        )
        .datasource(PROMETHEUS)
        .gridPos({ ...panel.grid, y: panel.grid.y + offset })
        .unit(panel.unit)
        .noValue(
          benchmark
            ? "Not recorded"
            : panel.unit === "bytes"
              ? panel.field === "peak_memory_bytes"
                ? "No memory measurement"
                : "No measured pipelines"
              : "0",
        )
        .reduceOptions(
          new common.ReduceDataOptionsBuilder()
            .values(false)
            .calcs(["lastNotNull"]),
        )
        .withTarget(
          query(
            panel.field === "peak_memory_bytes"
              ? sessionPeak
              : benchmark
                ? `last_over_time(junco_total_${panel.field}{${selector}}[$__range])`
                : `junco_total_${panel.field}{${selector}}`,
            benchmark,
          ),
        ),
    );
  for (const panel of series)
    details.withPanel(
      new timeseries.PanelBuilder()
        .id(++id)
        .title(panel.title)
        .description(
          benchmark ? `${panel.description} ${history}` : panel.description,
        )
        .datasource(PROMETHEUS)
        .gridPos({ ...panel.grid, y: panel.grid.y + offset })
        .unit(panel.unit)
        .noValue(
          benchmark
            ? "Not recorded"
            : panel.unit === "bytes"
              ? "No measured pipelines"
              : "0",
        )
        .displayName(
          benchmark
            ? `\${__field.labels.stream} \${__field.labels.node}`
            : panel.measurement === "junco_node"
              ? `\${__field.labels.node}`
              : panel.title,
        )
        .withTarget(query(`${panel.measurement}_${panel.field}{${selector}}`)),
    );
  const probes = new timeseries.PanelBuilder()
    .id(++id)
    .title("Edge probes")
    .description(
      `Numeric edge values at recorder receipt time, labeled by graph context and edge ID.${benchmark ? ` ${history}` : ""}`,
    )
    .datasource(PROMETHEUS)
    .gridPos({ x: 0, y: 20 + offset, w: 24, h: 8 })
    .displayName(
      `${benchmark ? `\${__field.labels.stream} ` : ""}\${__field.labels.node} \${__field.labels.edge_id}`,
    )
    .withTarget(query(`junco_probe_value{${selector}}[$__range]`, true));
  if (benchmark) probes.noValue("Not recorded");
  details.withPanel(probes);
  for (const panel of tables) {
    const builder = new table.PanelBuilder()
      .id(++id)
      .title(panel.title)
      .description(
        benchmark ? `${panel.description} ${history}` : panel.description,
      )
      .datasource(PROMETHEUS)
      .gridPos({ ...panel.grid, y: panel.grid.y + offset })
      .filterable(true)
      .targets(panel.targets)
      .withTransformation({
        id: "reduce",
        options: {
          reducers: ["lastNotNull"],
          mode: "seriesToRows",
          labelsToFields: true,
        },
      });
    if (benchmark) builder.noValue("Not recorded");
    details.withPanel(builder);
  }
  if (row !== undefined) board.withRow(row);
  return board.build();
}
