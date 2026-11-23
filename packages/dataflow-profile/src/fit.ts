import { DataflowDefinitionError, EdgeId, type EdgeIdType, RESOURCE_KINDS, type ResourceKind } from "dataflow-engine";
import { evaluate } from "./predict.js";
import { THRESHOLDS, type Measure, type Model, type Pin, type PinsFile, type PortFeature, type ProfileRecord, type ProfilesFile, type Sample } from "./types.js";
import { unitOf, type UnitSymbol } from "./units.js";

export type FitRow = {
  node: string;
  resource: ResourceKind;
  unit: string;
  model: Model["kind"];
  features: string;
  n: number;
  r2: number | undefined;
  residP95: number;
  bound: number;
};

type Candidate = { model: Model; features: readonly PortFeature[]; x: number[][]; r2?: number; score: number };

/** Read or fold a sample's port features; a missing input makes the vector unavailable. */
function measureFeatures(features: readonly PortFeature[], read: (port: EdgeIdType, measure: Measure) => number | undefined): number[] | undefined {
  const values: number[] = [];
  for (const feature of features) {
    if ("port" in feature) {
      const value = read(feature.port, feature.measure);
      if (value === undefined) return undefined;
      values.push(value);
    } else {
      let value = 0;
      for (const port of feature.ports) {
        const next = read(port, feature.measure);
        if (next === undefined) return undefined;
        value = feature.derived === "sum" ? value + next : Math.max(value, next);
      }
      values.push(value);
    }
  }
  return values;
}

/** Normal equations with partial pivoting; singular candidates are not usable. */
function linear(x: readonly (readonly number[])[], y: readonly number[]): Extract<Model, { kind: "linear" }> | undefined {
  const width = x[0]!.length + 1;
  const matrix = Array.from({ length: width }, () => new Array<number>(width + 1).fill(0));
  for (let row = 0; row < x.length; row++) {
    for (let i = 0; i < width; i++) {
      const xi = i === 0 ? 1 : x[row]![i - 1]!;
      for (let j = 0; j < width; j++) matrix[i]![j]! += xi * (j === 0 ? 1 : x[row]![j - 1]!);
      matrix[i]![width]! += xi * y[row]!;
    }
  }
  for (let i = 0; i < width; i++) {
    let pivot = i;
    for (let j = i + 1; j < width; j++)
      if (Math.abs(matrix[j]![i]!) > Math.abs(matrix[pivot]![i]!)) pivot = j;
    if (Math.abs(matrix[pivot]![i]!) < 1e-12) return undefined;
    [matrix[i], matrix[pivot]] = [matrix[pivot]!, matrix[i]!];
    for (let j = i + 1; j < width; j++) {
      const factor = matrix[j]![i]! / matrix[i]![i]!;
      for (let k = i; k <= width; k++) matrix[j]![k]! -= factor * matrix[i]![k]!;
    }
  }
  const coefficients = new Array<number>(width);
  for (let i = width - 1; i >= 0; i--) {
    let value = matrix[i]![width]!;
    for (let j = i + 1; j < width; j++) value -= matrix[i]![j]! * coefficients[j]!;
    coefficients[i] = value / matrix[i]![i]!;
  }
  if (!coefficients.every(Number.isFinite)) return undefined;
  return { kind: "linear", base: coefficients[0]!, coef: coefficients.slice(1) };
}

function fitModel(kind: Model["kind"], x: number[][], y: number[]): Model | undefined {
  if (kind === "constant") return { kind };
  if (kind === "linear") return linear(x, y);
  if (kind === "power") {
    if (x.some(row => row[0]! <= 0) || y.some(value => value <= 0)) return undefined;
    const logFit = linear(x.map(row => [Math.log(row[0]!)]), y.map(Math.log));
    if (!logFit) return undefined;
    const coef = Math.exp(logFit.base);
    return Number.isFinite(coef) ? { kind, coef, exp: logFit.coef[0]! } : undefined;
  }
  const order = x.map((row, i) => [row[0]!, y[i]!] as const).sort((a, b) => a[0] - b[0]);
  const k = Math.min(8, Math.floor(y.length / 5));
  const points: [number, number][] = [];
  const counts: number[] = [];
  for (let i = 0; i < k; i++) {
    const lo = Math.floor(i * y.length / k), hi = Math.floor((i + 1) * y.length / k);
    let sx = 0, sy = 0;
    for (let j = lo; j < hi; j++) { sx += order[j]![0]; sy += order[j]![1]; }
    const px = sx / (hi - lo), py = sy / (hi - lo);
    const last = points.length - 1;
    if (last >= 0 && points[last]![0] === px) {
      points[last]![1] = (points[last]![1] * counts[last]! + py) / (counts[last]! + 1);
      counts[last]!++;
    } else { points.push([px, py]); counts.push(1); }
  }
  return points.length >= 2 ? { kind, points } : undefined;
}

function fitCandidate(pin: Pin, rows: readonly Sample[], y: number[], total: number): Candidate | undefined {
  const x: number[][] = [];
  for (const row of rows) {
    const values = measureFeatures(pin.features, (port, measure) => row.features[port]?.[measure]);
    if (values === undefined) return undefined;
    x.push(values);
  }
  const model = fitModel(pin.model, x, y);
  if (!model) return undefined;
  if (model.kind === "constant") return { model, features: pin.features, x, score: 0 };
  if (total === 0) return undefined;
  const p = model.kind === "linear" ? model.coef.length : model.kind === "power" ? 1 : model.points.length;
  if (y.length - p - 1 <= 0) return undefined;
  let residual = 0;
  for (let i = 0; i < y.length; i++) {
    const predicted = evaluate(model, x[i]!);
    if (!Number.isFinite(predicted)) return undefined;
    residual += (y[i]! - predicted) ** 2;
  }
  const r2 = 1 - residual / total;
  return { model, features: pin.features, x, r2, score: 1 - (1 - r2) * (y.length - 1) / (y.length - p - 1) };
}

function renderFeatures(features: readonly PortFeature[]): string {
  return features.map(feature => "port" in feature
    ? `${feature.port}:${feature.measure}`
    : `${feature.derived}(${feature.ports.join(",")}):${feature.measure}`).join("+");
}

function fitResource<R extends ResourceKind>(node: string, resource: R, rows: readonly Sample[], pin: Pin | undefined, fittedAt: string): ProfileRecord<R> {
  const symbol = rows[0]!.units[resource];
  if (symbol === undefined) throw new DataflowDefinitionError(`fit ${node}/${resource}: resource has no unit`);
  const unit = unitOf(resource, symbol);
  const y = rows.map(row => {
    const inputUnit = row.units[resource];
    if (inputUnit === undefined) throw new DataflowDefinitionError(`fit ${node}/${resource}: resource has no unit`);
    return unitOf(resource, inputUnit)(row.resources[resource]!).in(unit).amount;
  });
  const mean = y.reduce((sum, value) => sum + value, 0) / y.length;
  const total = y.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const bound = y.reduce((largest, value) => Math.max(largest, value), -Infinity);
  const constant = fitCandidate({ model: "constant", features: [] }, rows, y, total)!;
  let best = constant;
  if (pin) {
    if ((pin.model === "constant" && pin.features.length !== 0)
      || ((pin.model === "power" || pin.model === "table") && pin.features.length !== 1))
      throw new DataflowDefinitionError(`fit ${node}/${resource}: pinned ${pin.model} has invalid features`);
    for (const row of rows)
      for (const feature of pin.features)
        if (measureFeatures([feature], (port, measure) => row.features[port]?.[measure]) === undefined)
          throw new DataflowDefinitionError(`fit ${node}/${resource}: pinned feature ${renderFeatures([feature])} is not defined on every row`);
    const fitted = fitCandidate(pin, rows, y, total);
    if (!fitted) throw new DataflowDefinitionError(`fit ${node}/${resource}: pinned ${pin.model} cannot be fitted (singular or insufficient data)`);
    best = fitted;
  } else {
    const consider = (model: Model["kind"], features: readonly PortFeature[]) => {
      const candidate = fitCandidate({ model, features }, rows, y, total);
      if (candidate && candidate.score > best.score) best = candidate;
    };
    const ports = [...new Set(rows.flatMap(row => Object.keys(row.features)))].sort();
    for (const port of ports) {
      for (const measure of ["bytes", "count", "tokens"] as const) {
        if (!rows.every(row => row.features[port]?.[measure] !== undefined)) continue;
        const features: PortFeature[] = [{ port: EdgeId.create(port), measure }];
        consider("linear", features);
        if (rows.every(row => row.features[port]![measure]! > 0) && y.every(value => value > 0)) consider("power", features);
        if (rows.length >= 10) consider("table", features);
      }
    }
    const counted = ports.filter(port => rows.every(row => row.features[port]?.count !== undefined));
    if (counted.length >= 2) consider("linear", counted.map(port => ({ port: EdgeId.create(port), measure: "count" })));
    if (best.score < 0.1) best = constant;
  }
  const residuals = y.map((value, i) => Math.max(0, value - (best.model.kind === "constant" ? bound : evaluate(best.model, best.x[i]!)))).sort((a, b) => a - b);
  const range = best.features.map((_, i) => {
    let lo = Infinity, hi = -Infinity;
    for (const row of best.x) { lo = Math.min(lo, row[i]!); hi = Math.max(hi, row[i]!); }
    return [lo, hi] as const;
  });
  return {
    resource, unit: symbol as UnitSymbol<R>, features: best.features, model: best.model,
    fit: { n: rows.length, ...(best.r2 === undefined ? {} : { r2: best.r2 }), residP95: residuals[Math.ceil(0.95 * y.length) - 1]!, fittedAt },
    range, bound,
  };
}

export function fitProfiles(samples: readonly Sample[], options: { readonly pins?: PinsFile; readonly fittedAt: string }): { file: ProfilesFile; report: FitRow[]; underSampled: string[] } {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.node);
    if (group) group.push(sample); else groups.set(sample.node, [sample]);
  }
  const nodes: Record<string, { [R in ResourceKind]?: ProfileRecord<R> }> = {};
  const report: FitRow[] = [], underSampled: string[] = [];
  function add<R extends ResourceKind>(node: string, resource: R, rows: Sample[]) {
    const record = fitResource(node, resource, rows, options.pins?.nodes[node]?.[resource], options.fittedAt);
    nodes[node]![resource] = record as (typeof nodes)[string][R];
    report.push({ node, resource, unit: record.unit, model: record.model.kind, features: renderFeatures(record.features), n: record.fit.n, r2: record.fit.r2, residP95: record.fit.residP95, bound: record.bound });
    if (rows.length < THRESHOLDS.N_MIN) underSampled.push(`${node}/${resource}`);
  }
  for (const [node, group] of groups) {
    Object.defineProperty(nodes, node, { value: {}, enumerable: true, configurable: true, writable: true });
    for (const resource of RESOURCE_KINDS) {
      const rows = group.filter(row => row.resources[resource] !== undefined);
      if (rows.length) add(node, resource, rows);
    }
  }
  return { file: { version: 1, nodes }, report, underSampled };
}
