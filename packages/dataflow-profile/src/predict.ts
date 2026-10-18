import { constantProfile, DataflowDefinitionError, type Estimate, type FeatureVector, type ResourceKind } from "dataflow-engine";
import { THRESHOLDS, type Model, type Profile, type ProfileRecord, type ProfilesFile } from "./types.js";
import { unitOf } from "./units.js";

/** Evaluate a fitted model in its profile's own unit. */
export function evaluate(model: Exclude<Model, { kind: "constant" }>, x: FeatureVector): number {
  switch (model.kind) {
    case "linear": {
      let value = model.base;
      for (let i = 0; i < model.coef.length; i++) value += model.coef[i]! * x[i]!;
      return value;
    }
    case "power": return model.coef * x[0]! ** model.exp;
    case "table": {
      const points = model.points;
      const value = x[0]!;
      if (value <= points[0]![0]) return points[0]![1];
      const last = points.length - 1;
      if (value >= points[last]![0]) return points[last]![1];
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >>> 1;
        if (points[mid]![0] <= value) lo = mid;
        else hi = mid;
      }
      const left = points[lo]!;
      const right = points[hi]!;
      return left[1] + (right[1] - left[1]) * (value - left[0]) / (right[0] - left[0]);
    }
  }
}

/** Validate once; constant models reuse their frozen estimate. */
export function makeProfile<R extends ResourceKind>(record: ProfileRecord<R>): Profile<R> {
  const { resource, features, model, fit, range, bound } = record;
  const unit = unitOf(resource, record.unit);
  const fail = (field: string, detail: string): never => {
    throw new DataflowDefinitionError(`profile ${resource}: ${field} ${detail}`);
  };
  if (model.kind === "linear") {
    if (model.coef.length !== features.length) fail("model.coef", "length must match features");
    if (!Number.isFinite(model.base) || model.coef.some(n => !Number.isFinite(n))) fail("model", "coefficients must be finite");
  } else if (model.kind === "constant") {
    if (features.length !== 0) fail("features", "must be empty for constant models");
  } else {
    if (features.length !== 1) fail("features", `must contain one feature for ${model.kind} models`);
    if (model.kind === "power" && (!Number.isFinite(model.coef) || !Number.isFinite(model.exp))) fail("model", "coefficients must be finite");
    if (model.kind === "table") {
      if (model.points.length < 2) fail("model.points", "must contain at least two points");
      for (let i = 0; i < model.points.length; i++) {
        const point = model.points[i]!;
        if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) fail("model.points", "must be finite");
        if (i > 0 && point[0] <= model.points[i - 1]![0]) fail("model.points", "x values must be strictly increasing");
      }
    }
  }
  if (range.length !== features.length) fail("range", "length must match features");
  for (const [lo, hi] of range)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) fail("range", "must contain finite ordered bounds");
  if (!Number.isInteger(fit.n) || fit.n < 0) fail("fit.n", "must be a non-negative integer");
  if (!Number.isFinite(bound) || bound < 0) fail("bound", "must be finite and non-negative");
  if (!Number.isFinite(fit.residP95) || fit.residP95 < 0) fail("fit.residP95", "must be finite and non-negative");
  if (fit.r2 !== undefined && !Number.isFinite(fit.r2)) fail("fit.r2", "must be finite");
  const constant = model.kind === "constant" ? constantProfile(resource, unit(bound)) : undefined;

  const predict = (x: FeatureVector): Estimate => {
    if (x.length !== features.length) fail("features", `expected ${features.length} values, got ${x.length}`);
    for (let i = 0; i < x.length; i++)
      if (!Number.isFinite(x[i])) fail("features", "values must be finite");
    if (model.kind === "constant") return constant!.predict(x);
    const value = Math.max(0, evaluate(model, x));
    if (!Number.isFinite(value)) fail("model", "prediction must be finite");
    let reason: Estimate["reason"];
    if (fit.n < THRESHOLDS.N_MIN) reason = "few_samples";
    else if (fit.r2 !== undefined && fit.r2 < THRESHOLDS.R2_MIN) reason = "low_r2";
    else {
      for (let i = 0; i < range.length; i++) {
        const lo = range[i]![0];
        const hi = range[i]![1];
        const tolerance = THRESHOLDS.RANGE_TOLERANCE * (hi === lo ? Math.abs(hi) : hi - lo);
        if (x[i]! < lo - tolerance || x[i]! > hi + tolerance) {
          reason = "out_of_range";
          break;
        }
      }
    }
    return reason === undefined
      ? Object.freeze({ value, safe: value + fit.residP95, source: "model" })
      : Object.freeze({ value, safe: Math.max(bound, value), source: "fallback", reason });
  };
  return Object.freeze({ ...record, unit, predict });
}

/** Load only requested kinds; extra profiles in a file are deliberately ignored. */
export function profilesOf<K extends ResourceKind>(file: ProfilesFile, node: string, kinds: readonly K[]): { readonly [R in K]: Profile<R> } {
  if (!Object.hasOwn(file.nodes, node))
    throw new DataflowDefinitionError(`profiles: node "${node}" is not in the file`);
  const records = file.nodes[node]!;
  const profiles: { [R in K]?: Profile<R> } = {};
  for (const kind of kinds) {
    const record = records[kind];
    if (record === undefined)
      throw new DataflowDefinitionError(`profiles: node "${node}" has no "${kind}" profile`);
    if (record.resource !== kind)
      throw new DataflowDefinitionError(`profiles: node "${node}" key "${kind}" holds a "${record.resource}" profile`);
    profiles[kind] = makeProfile(record) as Profile<K> & typeof profiles[K];
  }
  return Object.freeze(profiles) as { readonly [R in K]: Profile<R> };
}
