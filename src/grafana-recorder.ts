import { randomUUID } from "node:crypto";
import type * as cog from "@grafana/grafana-foundation-sdk/cog";
import {
  type NativeResourceEvent,
  type ProfileEvent,
  type ProfileRecorder,
  profileContexts,
} from "junco-tools";

export type GrafanaRecorderOptions = {
  /** Grafana base URL, without credentials; default `http://localhost:8000`. */
  readonly url?: string;
  /** Live push interval; default 1000 ms. */
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
  readonly tags: string;
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
};

const DASHBOARD = "junco-telemetry";
const DASHBOARDS =
  "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards";
// ponytail: each Live push is capped at Grafana's 500 KiB; shard streams if a measured snapshot exceeds it.
const PUSH_LIMIT = 500 * 1024;
const TIMEOUT_MS = 5000;
const FIELD = /^[a-z][a-z0-9_]*$/;
const GRAFANA = { type: "grafana", uid: "grafana" };

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
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
] as const;

const within = (path: string, node: Node) =>
  path === "" || node.path === path || node.path.startsWith(`${path}::`);
const label = (path: string) => (path === "" ? "::" : path);
const tag = (value: string) =>
  value
    .replace(/[\\,= ]/g, "\\$&")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");

/** Streams profile events as Grafana Live measurements of one session `streamId`. */
export class GrafanaRecorder implements ProfileRecorder<string> {
  readonly root: object = this;
  readonly path = "";
  /** This session's Live stream; select it with the dashboard's `stream` variable. */
  readonly streamId = `junco_${randomUUID().replaceAll("-", "")}`;
  readonly dashboardUrl: string;
  readonly #base: string;
  readonly #intervalMs: number;
  readonly #contexts = profileContexts(
    this,
    (_ids, path, event) => this.#reduce(path, event),
    () => {
      if (this.#closing !== undefined)
        throw new Error("GrafanaRecorder: closed");
    },
  );
  readonly #nodes = new Map<string, Node>();
  readonly #rollups = new Map<string, Rollup>();
  readonly #operations = new Map<string, Operation>();
  readonly #pipelines = new Map<object, Map<string, Pipeline>>();
  readonly #active = new Set<Pipeline>();
  /** Probe points awaiting their own push, in record order. */
  #probes: string[] = [];
  #peak = 0;
  #clock: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #drain: Promise<void> = Promise.resolve();
  #queued = 0;
  #stopped = false;
  #failure: unknown;
  #closing: Promise<void> | undefined;

  private constructor(base: string, intervalMs: number) {
    this.#base = base;
    this.#intervalMs = intervalMs;
    this.dashboardUrl = `${base}/d/${DASHBOARD}?var-stream=${this.streamId}`;
  }

  /** Validates `options` and provisions the dashboard; rejects before any work on failure. */
  static async create(
    options: GrafanaRecorderOptions = {},
  ): Promise<GrafanaRecorder> {
    const { intervalMs = 1000 } = options;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
      throw new Error("GrafanaRecorder: intervalMs must be positive");
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
    await provision(base);
    return new GrafanaRecorder(base, intervalMs);
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
        this.#nodes.clear();
        this.#rollups.clear();
        this.#operations.clear();
        this.#pipelines.clear();
        this.#active.clear();
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

  #reduce(path: string, event: ProfileEvent<string>): void {
    if (this.#closing !== undefined) return;
    if (this.#clock === undefined) {
      this.#clock = performance.now();
      this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
      this.#timer.unref();
    }
    if (event.kind === "usage") this.#usage(path, event.usage);
    else if (event.kind === "resource")
      this.#resource(path, event.source, event.event);
    else if (event.kind === "probe")
      this.#probe(path, event.edgeId, event.value);
    else this.#operation(path, event);
  }

  /** Queues one `junco_probe` point at receipt time; no later push could carry it once stopped. */
  #probe(path: string, edgeId: string, value: number): void {
    if (this.#stopped) return;
    if (!Number.isFinite(value)) {
      this.#fail(new Error("GrafanaRecorder: invalid probe value"));
      return;
    }
    // Live keeps one point per series and millisecond of a push, so each point is pushed alone.
    this.#probes.push(
      `junco_probe,node=${tag(label(path))},edge_id=${tag(edgeId)} value=${value} ${BigInt(Date.now()) * 1_000_000n}`,
    );
  }

  #usage(
    path: string,
    usage: Extract<ProfileEvent<string>, { kind: "usage" }>["usage"],
  ): void {
    const values: [string, number | undefined][] = [
      ["tokens_used", usage.totalTokens],
      ["input_tokens", usage.input],
      ["output_tokens", usage.output],
      ["cache_read_tokens", usage.cacheRead],
      ["cache_write_tokens", usage.cacheWrite],
      ["cache_write_1h_tokens", usage.cacheWrite1h],
      ["reasoning_tokens", usage.reasoning],
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
      this.#fail(new Error("GrafanaRecorder: invalid usage"));
      return;
    }
    const node = this.#node(path);
    node.usage ??= new Map();
    for (const [field, value] of values)
      if (value !== undefined)
        node.usage.set(field, (node.usage.get(field) ?? 0) + value);
    node.pendingTokens += usage.totalTokens;
  }

  #resource(path: string, source: object, event: NativeResourceEvent): void {
    const { sample } = event;
    if (
      sample !== undefined &&
      SAMPLE_FIELDS.some(
        ([key]) => !Number.isFinite(sample[key]) || sample[key] < 0,
      )
    ) {
      this.#fail(new Error("GrafanaRecorder: invalid resource sample"));
      return;
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
      this.#fail(new Error("GrafanaRecorder: invalid operation labels"));
      return;
    }
    if (
      event.kind === "finish" &&
      (!Number.isFinite(event.durationMs) || event.durationMs < 0)
    ) {
      this.#fail(new Error("GrafanaRecorder: invalid duration"));
      return;
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
        this.#fail(new Error("GrafanaRecorder: invalid metrics"));
        return;
      }
    }
    const key = JSON.stringify([path, resource, category, tool, operation]);
    let op = this.#operations.get(key);
    if (op === undefined) {
      op = {
        tags: `,node=${tag(label(path))},resource=${tag(resource)},category=${tag(category)}${tool === "" ? "" : `,tool=${tag(tool)}`},operation=${tag(operation)}`,
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
    let usage = total;
    for (const node of this.#nodes.values()) {
      if (!contains(node)) continue;
      pending += node.pendingTokens;
      if (node.usage !== undefined) {
        usage = true;
        for (const field of TOKEN_FIELDS) add(field, 0);
        for (const [field, value] of node.usage) add(field, value);
      }
      if (!node.measured) continue;
      measured = true;
      memoryPeak = Math.max(memoryPeak, node.memoryPeak);
      peak = Math.max(peak, node.peak);
      for (const [field, value] of node.finished) add(field, value);
    }
    if (usage) {
      for (const field of TOKEN_FIELDS) add(field, 0);
      fields.set("tokens_per_second", seconds > 0 ? pending / seconds : 0);
    }
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

  /** One Influx line-protocol snapshot; consumes the rate baselines it reports. */
  #snapshot(): string {
    const now = performance.now();
    const seconds = this.#clock === undefined ? 0 : (now - this.#clock) / 1000;
    const time = BigInt(Date.now()) * 1_000_000n;
    const lines: string[] = [];
    const line = (
      measurement: string,
      tags: string,
      fields: Map<string, number>,
    ) => {
      if (fields.size === 0) return;
      const values = [...fields].map(([field, value]) => `${field}=${value}`);
      lines.push(`${measurement}${tags} ${values.join(",")} ${time}`);
    };
    line(
      "junco_total",
      "",
      this.#fields(() => true, this.#peak, seconds, true),
    );
    for (const node of this.#nodes.values())
      line(
        "junco_node",
        `,node=${tag(label(node.path))}`,
        this.#fields((other) => other === node, node.peak, seconds, false),
      );
    for (const rollup of this.#rollups.values())
      line(
        "junco_context",
        `,node=${tag(label(rollup.path))}`,
        this.#fields(
          (node) => within(rollup.path, node),
          rollup.peak,
          seconds,
          false,
        ),
      );
    for (const op of this.#operations.values()) {
      const completed = op.success + op.errors + op.cancelled;
      line(
        "junco_operation",
        op.tags,
        new Map([
          ["calls", op.calls],
          ["inflight", op.inflight],
          ["success", op.success],
          ["errors", op.errors],
          ["cancelled", op.cancelled],
          ["duration_ms_sum", op.durationSum],
          ["duration_ms_max", op.durationMax],
          ["duration_ms_last", op.durationLast],
          [
            "duration_ms_mean",
            completed === 0 ? 0 : op.durationSum / completed,
          ],
          ["calls_per_second", seconds > 0 ? op.pendingCalls / seconds : 0],
          ...op.counters,
          ...op.gauges,
        ]),
      );
    }
    if (seconds > 0) {
      this.#clock = now;
      for (const node of this.#nodes.values()) node.pendingTokens = 0;
      for (const op of this.#operations.values()) op.pendingCalls = 0;
    }
    return `${lines.join("\n")}\n`;
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
      // ponytail: one sequential request per probe point; batch points of distinct series/ms if probe rates outgrow it.
      for (const line of probes) await this.#send("probe", `${line}\n`);
      await this.#send("snapshot", this.#snapshot());
    } catch (error) {
      this.#stopped = true;
      this.#probes = [];
      clearInterval(this.#timer);
      this.#fail(error);
    }
  }

  async #send(kind: "probe" | "snapshot", body: string): Promise<void> {
    if (Buffer.byteLength(body) > PUSH_LIMIT)
      throw new Error(`GrafanaRecorder: ${kind} exceeds 500 KiB`);
    const response = await request(
      `${this.#base}/api/live/push/${this.streamId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
        body,
      },
      "live push",
    );
    await response.body?.cancel();
    if (!response.ok) throw failure("live push", response);
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
async function provision(base: string): Promise<void> {
  const spec = JSON.parse(JSON.stringify(await dashboard())) as Record<
    string,
    unknown
  >;
  const item = `${base}${DASHBOARDS}/${DASHBOARD}`;
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
      method === "POST" ? "dashboard creation" : "dashboard update",
    );
  const found = await request(item, lookup, "dashboard lookup");
  if (found.status === 404) {
    await found.body?.cancel();
    const created = await write("POST", `${base}${DASHBOARDS}`, {
      name: DASHBOARD,
    });
    await created.body?.cancel();
    if (created.ok) return;
    if (created.status !== 409) throw failure("dashboard creation", created);
    const raced = await readDashboard(
      await request(item, lookup, "dashboard lookup"),
      "dashboard lookup",
    );
    if (!tagged(raced) || !matches(raced.spec, spec))
      throw new Error(
        `GrafanaRecorder: dashboard ${DASHBOARD} was concurrently created with a different spec`,
      );
    return;
  }
  const existing = await readDashboard(found, "dashboard lookup");
  if (!tagged(existing))
    throw new Error(
      `GrafanaRecorder: dashboard ${DASHBOARD} exists without tag ${DASHBOARD}`,
    );
  const updated = await write("PUT", item, existing.metadata);
  await updated.body?.cancel();
  if (!updated.ok) throw failure("dashboard update", updated);
}

/** The managed Live dashboard; queries read `stream/${stream}/<measurement>`. */
async function dashboard() {
  const [dashboard, stat, timeseries, table, common] = await Promise.all([
    import("@grafana/grafana-foundation-sdk/dashboard"),
    import("@grafana/grafana-foundation-sdk/stat"),
    import("@grafana/grafana-foundation-sdk/timeseries"),
    import("@grafana/grafana-foundation-sdk/table"),
    import("@grafana/grafana-foundation-sdk/common"),
  ]);
  const query = (
    measurement: string,
    fields?: readonly string[],
    refId = "A",
  ): cog.Builder<cog.Dataquery> => ({
    build: () => {
      const target = {
        refId,
        datasource: GRAFANA,
        queryType: "measurements",
        channel: `stream/\${stream}/${measurement}`,
        ...(fields === undefined
          ? {}
          : { filter: { fields: ["time", ...fields] } }),
        _implementsDataqueryVariant() {},
      };
      return target;
    },
  });
  const memoryScope =
    "Shell-pipeline cgroup memory sampled by the native monitor, not host heap.";
  const stats = [
    {
      title: "Total memory",
      field: "memory_bytes",
      unit: "bytes",
      grid: { x: 0, y: 0, w: 8, h: 4 },
      description: `${memoryScope} Sum of current memory of the session's active pipelines.`,
    },
    {
      title: "Peak memory",
      field: "peak_memory_bytes",
      unit: "bytes",
      grid: { x: 8, y: 0, w: 8, h: 4 },
      description: `${memoryScope} Sampled peak: the maximum active-pipeline sum or single-pipeline high-water mark; samples are independently timed.`,
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
      targets: [query("junco_operation")],
      grid: { x: 0, y: 28, w: 24, h: 12 },
      description:
        "Latest operation counters and gauges by node, resource, category, tool and operation; metric names carry units.",
    },
    {
      title: "Resource and token details",
      targets: [query("junco_node"), query("junco_total", undefined, "B")],
      grid: { x: 0, y: 40, w: 24, h: 10 },
      description:
        "Direct per-node resource and token fields; rows without a node label are session totals.",
    },
    {
      title: "Graph context totals",
      targets: [query("junco_context")],
      grid: { x: 0, y: 50, w: 24, h: 10 },
      description:
        "Inclusive rollups of each evaluated graph context over its descendants.",
    },
  ];
  const board = new dashboard.DashboardBuilder("Junco telemetry")
    .uid(DASHBOARD)
    .tags([DASHBOARD])
    .time({ from: "now-15m", to: "now" })
    .liveNow(true)
    .withVariable(
      new dashboard.TextBoxVariableBuilder("stream")
        .label("Telemetry session")
        .defaultValue("junco")
        .current({ text: "junco", value: "junco" }),
    );
  let id = 0;
  for (const panel of stats)
    board.withPanel(
      new stat.PanelBuilder()
        .id(++id)
        .title(panel.title)
        .description(panel.description)
        .datasource(GRAFANA)
        .gridPos(panel.grid)
        .unit(panel.unit)
        .noValue(panel.unit === "bytes" ? "No measured pipelines" : "0")
        .reduceOptions(
          new common.ReduceDataOptionsBuilder()
            .values(false)
            .calcs(["lastNotNull"]),
        )
        .withTarget(query("junco_total", [panel.field])),
    );
  for (const panel of series)
    board.withPanel(
      new timeseries.PanelBuilder()
        .id(++id)
        .title(panel.title)
        .description(panel.description)
        .datasource(GRAFANA)
        .gridPos(panel.grid)
        .unit(panel.unit)
        .noValue(panel.unit === "bytes" ? "No measured pipelines" : "0")
        .displayName(
          panel.measurement === "junco_node"
            ? `\${__field.labels.node}`
            : panel.title,
        )
        .withTarget(query(panel.measurement, [panel.field])),
    );
  board.withPanel(
    new timeseries.PanelBuilder()
      .id(++id)
      .title("Edge probes")
      .description(
        "Numeric edge values at recorder receipt time, labeled by graph context and edge ID.",
      )
      .datasource(GRAFANA)
      .gridPos({ x: 0, y: 20, w: 24, h: 8 })
      .displayName(`\${__field.labels.node} \${__field.labels.edge_id}`)
      .withTarget(query("junco_probe", ["value"])),
  );
  for (const panel of tables)
    board.withPanel(
      new table.PanelBuilder()
        .id(++id)
        .title(panel.title)
        .description(panel.description)
        .datasource(GRAFANA)
        .gridPos(panel.grid)
        .filterable(true)
        .targets(panel.targets)
        .withTransformation({
          id: "reduce",
          options: {
            reducers: ["lastNotNull"],
            mode: "seriesToRows",
            labelsToFields: true,
          },
        }),
    );
  return board.build();
}
