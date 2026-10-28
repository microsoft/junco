// Recorder evidence for the profile optimizer: canonical JSONL parsing plus the aggregate and
// stability operations its controller scores trials with. Internal: not exported by the barrels.
import { readFile } from "node:fs/promises";
import { parseSamples, type Sample, unitOf } from "dataflow-profile";

export type Metric =
  | { kind: "tokens" }
  | { kind: "cost" }
  | { kind: "result"; name: string }
  | { kind: "memory" }
  | {
      kind: "probe";
      /** The `/`-joined wrapper-node path of the probed edge's graph; `""` at the root. */
      node: string;
      /** The edge's exact local ID. */
      edgeId: string;
      reduce: "single" | "last" | "min" | "max" | "sum" | "mean";
    };
export type MetricSummary = {
  value: number;
  unit: "tok" | "B" | "USD" | null;
  count: number;
};

/** The samples of one JSONL profile; parse failures carry their physical line numbers. */
export async function readProfile(path: string): Promise<Sample[]> {
  return parseSamples(await readFile(path, "utf8"));
}

const finite = (value: number, what: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${what} is not finite`);
  return value;
};

/** Probe values `{edgeId, value}` of one sample; throws on a malformed probe payload. */
function probesOf(sample: Sample): { edgeId: string; value: number }[] {
  const probe = sample.measurement?.probe;
  if (probe === undefined) return [];
  if (!Array.isArray(probe))
    throw new TypeError(
      `probe payload of node "${sample.node}" is not an array`,
    );
  return probe.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("edgeId" in entry) ||
      !("value" in entry) ||
      typeof entry.edgeId !== "string" ||
      typeof entry.value !== "number" ||
      !Number.isFinite(entry.value)
    )
      throw new TypeError(`malformed probe entry at node "${sample.node}"`);
    return { edgeId: entry.edgeId, value: entry.value };
  });
}

/**
 * `metric` over `samples`: summed tokens or USD, peak memory in bytes, a probe reduction, or a
 * fixed completion-receipt result. Zero contributors is an error, never a zero score.
 */
export function summarize(
  samples: readonly Sample[],
  metric: Metric,
  results?: Readonly<Record<string, number>>,
): MetricSummary {
  if (metric.kind === "result") {
    const value = results?.[metric.name];
    if (results === undefined || !Object.hasOwn(results, metric.name))
      throw new Error(`completion receipt records no result "${metric.name}"`);
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new TypeError(`result "${metric.name}" is not a finite number`);
    return { value, unit: null, count: 1 };
  }
  if (
    metric.kind === "tokens" ||
    metric.kind === "memory" ||
    metric.kind === "cost"
  ) {
    const kind = metric.kind;
    let value = kind === "memory" ? Number.NEGATIVE_INFINITY : 0;
    let count = 0;
    for (const sample of samples) {
      const amount = sample.resources[kind];
      if (amount === undefined) continue;
      const unit = sample.units[kind];
      if (unit === undefined)
        throw new TypeError(
          `sample of "${sample.node}" has ${kind} without a unit`,
        );
      const base = amount * unitOf(kind, unit).scale;
      if (kind === "cost" && !(Number.isFinite(base) && base >= 0))
        throw new RangeError("cost must be finite and nonnegative");
      value = kind === "memory" ? Math.max(value, base) : value + base;
      count++;
    }
    if (count === 0) throw new Error(`profile records no ${kind}`);
    return {
      value: finite(value, kind),
      unit: kind === "tokens" ? "tok" : kind === "cost" ? "USD" : "B",
      count,
    };
  }
  const values: number[] = [];
  for (const sample of samples)
    for (const { edgeId, value } of probesOf(sample))
      if (sample.node === metric.node && edgeId === metric.edgeId)
        values.push(value);
  const where = `probe "${metric.edgeId}" at node "${metric.node}"`;
  if (values.length === 0) throw new Error(`profile records no ${where}`);
  let value: number;
  switch (metric.reduce) {
    case "single":
      if (values.length !== 1)
        throw new Error(
          `${where} has ${values.length} values; single requires one`,
        );
      value = values[0] as number;
      break;
    case "last":
      value = values.at(-1) as number;
      break;
    case "min":
      value = Math.min(...values);
      break;
    case "max":
      value = Math.max(...values);
      break;
    case "sum":
      value = values.reduce((total, next) => total + next, 0);
      break;
    case "mean":
      value = values.reduce((total, next) => total + next, 0) / values.length;
      break;
  }
  return { value: finite(value, where), unit: null, count: values.length };
}

/**
 * Whether the last `window` of `values` spread at most
 * `absoluteTolerance + relativeTolerance * max(abs(value))`; false while fewer are observed.
 */
export function isStable(
  values: readonly number[],
  window: number,
  absoluteTolerance: number,
  relativeTolerance: number,
): boolean {
  if (!(Number.isSafeInteger(window) && window >= 2))
    throw new RangeError("stability window must be an integer >= 2");
  for (const [name, tolerance] of [
    ["absolute", absoluteTolerance],
    ["relative", relativeTolerance],
  ] as const)
    if (!(Number.isFinite(tolerance) && tolerance >= 0))
      throw new RangeError(`${name} tolerance must be finite and nonnegative`);
  for (const value of values) finite(value, "observation");
  if (values.length < window) return false;
  const last = values.slice(-window);
  const spread = finite(Math.max(...last) - Math.min(...last), "range");
  const scale = Math.max(...last.map(Math.abs));
  return (
    spread <= finite(absoluteTolerance + relativeTolerance * scale, "tolerance")
  );
}
