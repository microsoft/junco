#!/usr/bin/env bun
/** Offline preparation only. No clients, wall clocks, source writes, or TSDB access. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ProfileEvent } from "junco-tools";
import { ProfileMetricState, type ProfileMetric } from "../src/grafana-recorder.ts";

export const REPLAY_VERSION = "cooperbench-occupied-second-v1";
const SCHEMA = 1;
const DASHBOARD = "junco-cooperbench";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never { throw new Error(`backfill: ${message}`); }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
async function hashFile(path: string) {
  if (!(await lstat(path)).isFile()) fail(`input/output is not a regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function* lines(path: string) {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of reader) { if (!line) fail(`blank row in ${path}`); yield line; } }
  finally { reader.close(); input.destroy(); }
}
function keys(value: Record<string, any>, allowed: string[], context: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unsupported ${context} field ${key}`);
}
function identity(value: unknown, identities: Map<string, object>): object {
  if (!text(value) || !/^object_[1-9][0-9]*$/.test(value)) fail("invalid serialized source identity");
  let found = identities.get(value);
  if (!found) { found = {}; identities.set(value, found); }
  return found;
}
function timestamp(value: unknown): number {
  if (!text(value) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail("invalid ISO receipt timestamp");
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) fail("invalid receipt timestamp");
  return ms;
}
function eventFrom(raw: unknown, identities: Map<string, object>): ProfileEvent<string> {
  if (!object(raw) || !text(raw.kind) || !text(raw.resource) || !raw.resource) fail("invalid event");
  const event = { ...raw };
  if (event.kind === "usage") {
    keys(event, ["kind", "resource", "source", "usage"], "usage");
    if (!["tokens", "cost"].includes(event.resource) || !object(event.usage)) fail("invalid usage resource/schema");
    keys(event.usage, ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"], "usage ledger");
    for (const [key, value] of Object.entries(event.usage)) {
      if (key === "cost") {
        if (!object(value)) fail("invalid cost ledger");
        keys(value, ["input", "output", "cacheRead", "cacheWrite", "total"], "cost ledger");
        if (Object.values(value).some((n) => !finite(n) || n < 0)) fail("invalid cost value");
      } else if (!finite(value) || value < 0) fail("invalid usage value");
    }
    const required = event.resource === "tokens" ? ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] : [];
    if (required.some((key) => !finite(event.usage[key]))) fail("missing committed token ledger field");
    if (event.resource === "cost" && (!object(event.usage.cost) || ["input", "output", "cacheRead", "cacheWrite", "total"].some((key) => !finite(event.usage.cost[key])))) fail("missing committed cost ledger field");
    event.source = identity(event.source, identities);
  } else if (event.kind === "resource") {
    // Native resource events have a separate evolving schema. Never silently omit them.
    fail("unsupported raw resource schema; audited replay has no resource events");
  } else if (event.kind === "probe") {
    // Live probes advance repeated timestamps. Offline replay may not alter source time.
    fail("unsupported raw probe schema; audited replay has no probes");
  } else if (["start", "finish", "metrics"].includes(event.kind)) {
    keys(event, ["kind", "resource", "category", "tool", "operation", "activation", "activation_id", ...(event.kind === "finish" ? ["outcome", "durationMs"] : event.kind === "metrics" ? ["counters", "gauges"] : [])], "operation");
    if (!text(event.category) || !event.category || !text(event.tool) || !text(event.operation) || !event.operation) fail("invalid operation identity");
    if (event.kind === "finish" && (!["success", "error", "cancelled"].includes(event.outcome) || !finite(event.durationMs) || event.durationMs < 0)) fail("invalid finish");
    for (const field of ["counters", "gauges"]) if (event[field] !== undefined) {
      if (!object(event[field])) fail(`invalid ${field}`);
      for (const [name, value] of Object.entries(event[field])) {
        if (!/^[a-z][a-z0-9_]*$/.test(name) || !finite(value)) fail(value === null ? "unsupported stale gauge deletion" : "invalid operation metric");
      }
    }
    if (event.activation !== undefined) {
      const a = event.activation;
      if (!object(a) || !text(a.runId) || !a.runId || !object(a.features)) fail("invalid activation");
      keys(a, ["runId", "firedAt", "features", "agent", "owner"], "activation");
      timestamp(a.firedAt);
      for (const value of Object.values(a.features)) if (!object(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.count) || value.count < 0) fail("invalid activation feature");
      if (a.owner !== undefined && !text(a.owner)) fail("invalid activation owner");
      event.activation = { ...a, ...(a.agent === undefined ? {} : { agent: identity(a.agent, identities) }) };
      identity(event.activation_id, identities);
    } else if (event.activation_id !== undefined) fail("activation_id without activation");
  } else fail(`unsupported event kind ${event.kind}`);
  return event as ProfileEvent<string>;
}
const escapeLabel = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
type Ledger = { tokens: number; cost: number; fields: Record<string, number> };
const ledger = (): Ledger => ({ tokens: 0, cost: 0, fields: Object.create(null) });
function accumulate(target: Ledger, event: any) {
  if (event.kind !== "usage") return;
  const values = event.resource === "tokens" ? event.usage : event.usage.cost;
  for (const [key, value] of Object.entries(values)) if (finite(value)) {
    const field = `${event.resource}.${key}`;
    target.fields[field] = (target.fields[field] ?? 0) + value;
  }
  if (event.resource === "tokens") target.tokens += event.usage.totalTokens;
  else target.cost += event.usage.cost.total;
}

type Input = { path: string; sha256: string };
type Attempt = { attempt: string; classification: string; stream?: string; metadata?: any; raw?: string };
export async function prepareCampaign(campaignPath: string, outputPath: string) {
  const campaign = await import("node:fs/promises").then(({ realpath }) => realpath(campaignPath));
  const out = resolve(outputPath);
  if (out === campaign || out.startsWith(`${campaign}/`)) fail("output must be outside immutable campaign");
  const name = basename(campaign);
  const config = await json(join(campaign, "config.json"));
  if (!object(config) || config.run_name !== name || !Array.isArray(config.tasks) || !config.tasks.length) fail("invalid campaign config");
  const inputs: Input[] = [{ path: "config.json", sha256: await hashFile(join(campaign, "config.json")) }];
  const attempts: Attempt[] = [];
  const planned = new Set<string>();
  const streams = new Set<string>();
  const runs = new Set<string>();
  for (const task of config.tasks) {
    if (!object(task) || !text(task.repo) || !/^[A-Za-z0-9_-]+$/.test(task.repo) || !Number.isSafeInteger(task.task_id) || task.task_id < 0 || !Array.isArray(task.features) || task.features.length !== 2 || task.features.some((n: unknown) => !Number.isSafeInteger(n) || (n as number) < 1) || task.features[0] >= task.features[1]) fail("invalid planned task");
    const attempt = `${task.repo}/${task.task_id}/f${task.features[0]}_f${task.features[1]}`;
    if (planned.has(attempt)) fail(`duplicate planned attempt ${attempt}`);
    planned.add(attempt);
    const directory = join(campaign, "team", attempt);
    const telemetry = join(directory, ".junco/telemetry.json");
    const raw = join(directory, ".junco/profile_events.jsonl");
    const hasRaw = await exists(raw);
    const item: Attempt = { attempt, classification: await exists(directory) ? "attempted-no-raw" : "not-attempted" };
    if (await exists(telemetry)) {
      const metadata = await json(telemetry);
      if (!object(metadata) || metadata.version !== 1 || !text(metadata.run_id) || !/^[a-f0-9]{32}$/.test(metadata.run_id) || typeof metadata.raw_complete !== "boolean" || typeof metadata.profile_complete !== "boolean" || ![true, false, null].includes(metadata.grafana_complete) || !Array.isArray(metadata.errors) || metadata.errors.some((s: unknown) => !text(s))) fail(`invalid telemetry ${attempt}`);
      if (runs.has(metadata.run_id)) fail(`duplicate run metadata ${metadata.run_id}`);
      runs.add(metadata.run_id);
      inputs.push({ path: relative(campaign, telemetry), sha256: await hashFile(telemetry) });
      if (hasRaw) {
        if (!text(metadata.stream_id) || !/^junco_[a-f0-9]{32}$/.test(metadata.stream_id) || streams.has(metadata.stream_id)) fail(`invalid/duplicate stream ${attempt}`);
        streams.add(metadata.stream_id);
        if (!text(metadata.grafana_url) || !text(metadata.dashboard_url)) fail(`missing stream URL ${attempt}`);
        const base = new URL(metadata.grafana_url);
        const dashboard = new URL(metadata.dashboard_url);
        if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || dashboard.origin !== base.origin || dashboard.searchParams.get("var-stream") !== metadata.stream_id) fail(`inconsistent metadata identity ${attempt}`);
        item.metadata = metadata; item.stream = metadata.stream_id; item.raw = raw;
        item.classification = metadata.raw_complete ? "complete" : "partial";
        inputs.push({ path: relative(campaign, raw), sha256: await hashFile(raw) });
      } else if (metadata.raw_complete) fail(`complete metadata without raw ${attempt}`);
    } else if (hasRaw) fail(`raw without metadata ${attempt}`);
    attempts.push(item);
  }
  // Discover unexpected attempts/duplicate metadata rather than silently ignoring unplanned input.
  async function inventory(directory: string, depth: number, parts: string[] = []) {
    if (!(await exists(directory))) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail(`symlink in campaign task tree ${join(directory, entry.name)}`);
      if (!entry.isDirectory()) continue;
      const next = [...parts, entry.name];
      if (depth === 3) { if (!planned.has(next.join("/"))) fail(`unplanned attempt ${next.join("/")}`); }
      else await inventory(join(directory, entry.name), depth + 1, next);
    }
  }
  await inventory(join(campaign, "team"), 1);
  attempts.sort((a, b) => a.attempt.localeCompare(b.attempt, "en"));
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sourceHash = sha(JSON.stringify({ campaign: name, inputs, classifications: attempts.map(({ attempt, classification }) => ({ attempt, classification })) }));
  const backfillId = sha(JSON.stringify({ campaign: name, sourceHash, replayVersion: REPLAY_VERSION }));
  const converterHashes = { converter: await hashFile(import.meta.path), recorder: await hashFile(join(dirname(import.meta.path), "../src/grafana-recorder.ts")) };
  const converterHash = sha(JSON.stringify(converterHashes));
  await mkdir(out, { recursive: true, mode: 0o700 });
  if ((await lstat(out)).isSymbolicLink()) fail("output must not be a symlink");
  const existing = await readdir(out);
  if (existing.length) {
    if (!existing.includes("receipt.json")) fail("nonempty/incomplete output");
    const receipt = await json(join(out, "receipt.json"));
    if (receipt.schema !== SCHEMA || receipt.replayVersion !== REPLAY_VERSION || receipt.backfillId !== backfillId || receipt.sourceHash !== sourceHash || receipt.converterHash !== converterHash) fail("receipt source/converter mismatch; refusing reuse");
    const expected = ["receipt.json", "campaign.openmetrics", "families"];
    if (existing.some((entry) => !expected.includes(entry)) || existing.length !== expected.length) fail("unrelated output files");
    if (await hashFile(join(out, "campaign.openmetrics")) !== receipt.openmetrics.sha256) fail("OpenMetrics hash mismatch");
    const familyFiles = await readdir(join(out, "families"));
    if (familyFiles.length !== receipt.families.length) fail("family inventory mismatch");
    for (const family of receipt.families) if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(family.name) || !familyFiles.includes(`${family.name}.prom`) || await hashFile(join(out, "families", `${family.name}.prom`)) !== family.sha256) fail("family hash mismatch");
    return receipt;
  }
  const familyDirectory = join(out, "families");
  await mkdir(familyDirectory, { mode: 0o700 });
  const families = new Map<string, { name: string; samples: number; minMs: number; maxMs: number }>();
  const total = ledger();
  let rows = 0, snapshots = 0, samples = 0;
  let rawMinMs = Infinity, rawMaxMs = -Infinity, emittedMinMs = Infinity, emittedMaxMs = -Infinity;
  const mappings: any[] = [];
  const spools = new Map<string, FileHandle>();
  try {
  for (const attempt of attempts) {
    if (!attempt.raw) continue;
    const state = new ProfileMetricState(attempt.stream!, DASHBOARD);
    const identities = new Map<string, object>();
    const nodePaths = new Map<string, string>();
    const nodes: Record<string, Ledger> = Object.create(null);
    const usage = ledger();
    const operationLedger: Record<string, { starts: number; finishes: number; durationMs: number }> = {};
    const lastSeries = new Map<string, number>();
    let seq = 0, lastMs: number | undefined, previousSnapshot: number | undefined, streamSnapshots = 0;
    let streamMinMs = Infinity, streamMaxMs = -Infinity, firstSnapshot: number | undefined;
    let finalMetrics: readonly ProfileMetric[] = [];
    const emit = async (metrics: readonly ProfileMetric[], receiptMs: number) => {
      const batches = new Map<string, string[]>();
      for (const metric of [...metrics].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric.name)) fail("invalid metric name");
        for (const point of metric.gauge.dataPoints) {
          if (point.flags || point.asDouble === undefined) fail("unsupported stale sample");
          if (!finite(point.asDouble)) fail("nonfinite sample");
          const nano = BigInt(point.timeUnixNano);
          if (nano !== BigInt(receiptMs) * 1_000_000n) fail("state shifted original receipt timestamp");
          const labels: Record<string, string> = { campaign: name, completion: attempt.classification, backfill_id: backfillId };
          for (const attribute of point.attributes) {
            if (Object.hasOwn(labels, attribute.key) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(attribute.key) || !text(attribute.value.stringValue)) fail("duplicate/invalid label");
            labels[attribute.key] = attribute.value.stringValue;
          }
          if (labels.stream !== attempt.stream || labels.dashboard !== DASHBOARD) fail("state stream identity mismatch");
          const encoded = Object.keys(labels).sort().map((key) => `${key}="${escapeLabel(labels[key]!)}"`).join(",");
          const series = `${metric.name}{${encoded}}`;
          if ((lastSeries.get(series) ?? -Infinity) >= receiptMs) fail("duplicate or nonincreasing series timestamp");
          lastSeries.set(series, receiptMs);
          let batch = batches.get(metric.name); if (!batch) { batch = []; batches.set(metric.name, batch); }
          batch.push(`${series} ${Object.is(point.asDouble, -0) ? "0" : point.asDouble} ${Math.floor(receiptMs / 1000)}.${String(receiptMs % 1000).padStart(3, "0")}\n`);
          let family = families.get(metric.name);
          if (!family) { family = { name: metric.name, samples: 0, minMs: receiptMs, maxMs: receiptMs }; families.set(metric.name, family); }
          family.samples++; family.minMs = Math.min(family.minMs, receiptMs); family.maxMs = Math.max(family.maxMs, receiptMs);
          samples++;
        }
      }
      for (const [family, batch] of batches) {
        let spool = spools.get(family);
        if (!spool) { spool = await open(join(familyDirectory, `${family}.prom`), "wx", 0o600); spools.set(family, spool); }
        await spool.writeFile(batch.sort().join(""));
      }
      emittedMinMs = Math.min(emittedMinMs, receiptMs); emittedMaxMs = Math.max(emittedMaxMs, receiptMs);
    };
    const snapshot = async () => {
      if (lastMs === undefined) return;
      finalMetrics = state.snapshot(lastMs, previousSnapshot === undefined ? 0 : lastMs - previousSnapshot);
      await emit(finalMetrics, lastMs);
      firstSnapshot ??= lastMs;
      previousSnapshot = lastMs; streamSnapshots++; snapshots++;
    };
    for await (const line of lines(attempt.raw)) {
      const row = JSON.parse(line);
      if (!object(row)) fail("invalid raw row");
      keys(row, ["seq", "timestamp", "node", "node_ids", "activation_path", "event"], "raw row");
      if (row.seq !== seq + 1 || !text(row.node) || !Array.isArray(row.node_ids) || row.node_ids.some((id: unknown) => !text(id) || id === "")) fail(`invalid sequence/node ${attempt.attempt}:${seq + 1}`);
      const canonical = row.node_ids.map((id: string) => id.replaceAll("%", "%25").replaceAll(":", "%3A")).join("::");
      if (canonical !== row.node) fail("noncanonical node encoding");
      const encodedIds = JSON.stringify(row.node_ids);
      if (nodePaths.has(row.node) && nodePaths.get(row.node) !== encodedIds) fail("duplicate node metadata");
      nodePaths.set(row.node, encodedIds);
      if (row.activation_path !== undefined) fail("unsupported activation_path raw schema");
      const ms = timestamp(row.timestamp);
      if (lastMs !== undefined && ms < lastMs) fail("receipt clock reversal");
      if (lastMs !== undefined && Math.floor(ms / 1000) !== Math.floor(lastMs / 1000)) await snapshot();
      const event = eventFrom(row.event, identities);
      const probes = state.record(row.node, event, ms);
      if (probes?.length) await emit(probes, ms);
      if (event.kind === "usage") {
        const node = nodes[row.node] ??= ledger();
        accumulate(node, event); accumulate(usage, event); accumulate(total, event);
      } else if (event.kind === "start" || event.kind === "finish") {
        const key = JSON.stringify([row.node, event.resource, event.category, event.tool, event.operation]);
        const op = operationLedger[key] ??= { starts: 0, finishes: 0, durationMs: 0 };
        if (event.kind === "start") op.starts++; else { op.finishes++; op.durationMs += event.durationMs; }
      }
      lastMs = ms; seq++; rows++;
      streamMinMs = Math.min(streamMinMs, ms); streamMaxMs = Math.max(streamMaxMs, ms);
    }
    if (!seq) fail(`empty raw history ${attempt.attempt}`);
    await snapshot(); state.clear();
    const committed = new Map<string, number>();
    for (const metric of finalMetrics) {
      if (/^junco_(total|node)_(tokens_used|cost_total)$/.test(metric.name)) for (const point of metric.gauge.dataPoints) {
        const node = point.attributes.find((a) => a.key === "node")?.value.stringValue ?? "";
        committed.set(`${metric.name}\0${node}`, point.asDouble!);
      }
    }
    const checkUsage = (prefix: string, node: string, expected: Ledger) => {
      for (const [field, value] of [["tokens_used", expected.tokens], ["cost_total", expected.cost]] as const) {
        const actual = committed.get(`${prefix}_${field}\0${node}`);
        if (actual === undefined ? value !== 0 : Math.abs(actual - value) > (field === "tokens_used" ? 0 : 1e-9)) fail(`committed ledger reconciliation mismatch: ${attempt.attempt}/${node}/${field}`);
      }
    };
    checkUsage("junco_total", "", usage);
    for (const [node, expected] of Object.entries(nodes)) checkUsage("junco_node", node === "" ? "::" : node, expected);
    rawMinMs = Math.min(rawMinMs, streamMinMs); rawMaxMs = Math.max(rawMaxMs, streamMaxMs);
    const url = new URL(`/d/${DASHBOARD}`, attempt.metadata.grafana_url);
    url.searchParams.set("var-stream", attempt.stream!); url.searchParams.set("from", String(streamMinMs)); url.searchParams.set("to", String(streamMaxMs));
    mappings.push({ attempt: attempt.attempt, stream: attempt.stream, runId: attempt.metadata.run_id, completion: attempt.classification, rawPath: attempt.raw, dashboardUrl: url.href, rows: seq, snapshots: streamSnapshots, rawMinMs: streamMinMs, rawMaxMs: streamMaxMs, emittedMinMs: firstSnapshot, emittedMaxMs: previousSnapshot, usage, nodes, operations: operationLedger, missingMetrics: ["resources", "memory", "probes", "observed-output"] });
  }
  } finally { await Promise.all([...spools.values()].map((spool) => spool.close())); }
  if (!mappings.length) fail("no replayable histories");
  // Rehash sources before sealing so a concurrent input change cannot produce a receipt.
  const inputPaths = new Set(inputs.map((input) => input.path));
  for (const attempt of attempts) {
    const directory = join(campaign, "team", attempt.attempt);
    if (await exists(join(directory, ".junco/profile_events.jsonl")) !== Boolean(attempt.raw) ||
        await exists(join(directory, ".junco/telemetry.json")) !== inputPaths.has(`team/${attempt.attempt}/.junco/telemetry.json`) ||
        await exists(directory) !== (attempt.classification !== "not-attempted")) fail(`source inventory changed during replay: ${attempt.attempt}`);
  }
  await inventory(join(campaign, "team"), 1);
  for (const input of inputs) if (await hashFile(join(campaign, input.path)) !== input.sha256) fail(`source changed during replay: ${input.path}`);
  const familyManifest = [];
  const output = await open(join(out, "campaign.openmetrics"), "wx", 0o600);
  try {
    for (const family of [...families.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(familyDirectory, `${family.name}.prom`);
      await output.writeFile(`# TYPE ${family.name} gauge\n`);
      for await (const chunk of createReadStream(path)) await output.writeFile(chunk);
      familyManifest.push({ ...family, sha256: await hashFile(path) });
    }
    await output.writeFile("# EOF\n"); await output.sync();
  } finally { await output.close(); }
  const receipt = { schema: SCHEMA, replayVersion: REPLAY_VERSION, campaign, campaignName: name, sourceHash, converterHash, converterHashes, inputs, backfillId, classifications: attempts.map(({ attempt, classification, stream }) => ({ attempt, classification, ...(stream ? { stream } : {}) })), streams: mappings, counts: { planned: attempts.length, streams: mappings.length, rows, snapshots, samples, stale: 0, nonfinite: 0 }, rawMinMs, rawMaxMs, emittedMinMs, emittedMaxMs, usage: total, partialUsage: mappings.filter((s) => s.completion === "partial").reduce((sum, s) => ({ tokens: sum.tokens + s.usage.tokens, cost: sum.cost + s.usage.cost }), { tokens: 0, cost: 0 }), missingMetrics: ["resources", "memory", "probes", "observed-output"], families: familyManifest, openmetrics: { file: "campaign.openmetrics", sha256: await hashFile(join(out, "campaign.openmetrics")), samples } };
  await writeFile(join(out, ".receipt.tmp"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(join(out, ".receipt.tmp"), join(out, "receipt.json"));
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--campaign" || args[2] !== "--out" || !args[1] || !args[3]) throw new Error("Usage: bun run scripts/backfill-cooperbench.ts --campaign <path> --out <new-or-empty-path>");
  const receipt = await prepareCampaign(args[1], args[3]);
  console.log(JSON.stringify({ backfillId: receipt.backfillId, ...receipt.counts, openmetrics: receipt.openmetrics }));
}
