import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DataflowDefinitionError, EdgeId, type PortFeature } from "dataflow-engine";
import { fitProfiles } from "../src/fit.js";
import { evaluate } from "../src/predict.js";
import { parsePins, parseProfiles, parseSamples } from "../src/schema.js";
import type { Pin, PinsFile, Sample } from "../src/types.js";

const fittedAt = "2026-10-12";
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const samples = parseSamples(fixture("samples.jsonl"));
const feature = (port: string, measure: "bytes" | "count" | "tokens" = "count"): PortFeature => ({ port: EdgeId.create(port), measure });
const pinsFor = (pin: Pin): PinsFile => ({ version: 1, nodes: { work: { memory: pin } } });
const rowsOf = (n: number, y: (x: number) => number): Sample[] => Array.from({ length: n }, (_, i) => ({
  node: "work", features: { in: { count: i + 1 } }, resources: { memory: y(i + 1) }, units: { memory: "MB" },
}));
const near = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

// The literal auto-enumerator cannot combine candidates:count with query:tokens.
// Coefficient recovery therefore uses a diagnostic pin, not a hidden extra candidate.
test("seeded fixtures reproduce the golden, model choices, report and sample counts", () => {
  const result = fitProfiles(samples, { fittedAt });
  assert.deepEqual(result.file, parseProfiles(fixture("profiles.json")));
  assert.deepEqual(result.underSampled, ["rare/memory"]);
  assert.deepEqual(result.report.map(row => [row.node, row.resource, row.model, row.n]), [
    ["rerank", "memory", "linear", 53], ["rerank", "runtime", "linear", 53],
    ["summarize", "runtime", "table", 53], ["classify", "tokens", "constant", 53], ["rare", "memory", "linear", 3],
  ]);
  assert.equal(result.file.nodes.rerank!.memory!.unit, "MB");
  assert.equal(result.file.nodes.rare!.memory!.unit, "MiB");
  assert.deepEqual(result.file.nodes.rerank!.memory!.features, [feature("candidates", "bytes")]);
  assert.equal(result.report[0]!.features, "candidates:bytes");
  assert.equal(result.report[0]!.bound, result.file.nodes.rerank!.memory!.bound);
  assert.equal(result.report[0]!.residP95, result.file.nodes.rerank!.memory!.fit.residP95);
});

test("explicit diagnostic pin recovers both rerank memory effects", () => {
  const pins: PinsFile = { version: 1, nodes: { rerank: { memory: {
    model: "linear", features: [feature("candidates"), feature("query", "tokens")],
  } } } };
  const record = fitProfiles(samples, { fittedAt, pins }).file.nodes.rerank!.memory!;
  assert.equal(record.model.kind, "linear");
  if (record.model.kind !== "linear") return;
  near(record.model.base, 220, 220 * 0.15);
  near(record.model.coef[0]!, 1.8, 1.8 * 0.15);
  near(record.model.coef[1]!, 0.04, 0.04 * 0.15);
});

test("fixture power pin overrides automatic selection", () => {
  const pins = parsePins(fixture("pins.json"));
  const result = fitProfiles(samples, { fittedAt, pins });
  assert.equal(result.file.nodes.rerank!.runtime!.model.kind, "power");
  assert.deepEqual(result.file.nodes.rerank!.runtime!.features, [feature("candidates")]);
});

test("mixed units convert into the first resource row's unit", () => {
  const rows: Sample[] = Array.from({ length: 20 }, (_, i) => ({
    node: "work", features: { in: { count: i + 1 } },
    resources: { memory: i % 2 === 0 ? i + 1 : (i + 1) * 1000 },
    units: { memory: i % 2 === 0 ? "GB" : "MB" },
  }));
  const record = fitProfiles(rows, { fittedAt }).file.nodes.work!.memory!;
  assert.equal(record.unit, "GB");
  near(record.bound, 20);
  assert.equal(record.model.kind, "linear");
  if (record.model.kind === "linear") near(record.model.coef[0]!, 1);
});

test("random independent low-signal data selects constant", () => {
  let state = 42;
  const random = () => {
    let t = state += 0x6d2b79f5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const rows: Sample[] = Array.from({ length: 20 }, () => ({
    node: "work", features: { in: { count: random() * 100 } }, resources: { memory: 5 + 2 * random() - 1 }, units: { memory: "MB" },
  }));
  const record = fitProfiles(rows, { fittedAt }).file.nodes.work!.memory!;
  assert.equal(record.model.kind, "constant");
  assert.equal(record.fit.r2, undefined);
  assert.equal(record.fit.residP95, 0);
  assert.deepEqual(record.features, []);
  assert.deepEqual(record.range, []);
});

test("linear OLS recovers intercept and multiple independent features with pivoting", () => {
  const rows = rowsOf(30, x => 17 + 2 * x + 3 * (x % 7));
  rows.forEach((row, i) => { rows[i] = { ...row, features: { ...row.features, other: { count: (i + 1) % 7 } } }; });
  const record = fitProfiles(rows, { fittedAt }).file.nodes.work!.memory!;
  assert.equal(record.model.kind, "linear");
  assert.deepEqual(record.features, [feature("in"), feature("other")]);
  if (record.model.kind === "linear") {
    near(record.model.base, 17);
    near(record.model.coef[0]!, 2);
    near(record.model.coef[1]!, 3);
  }
  assert.deepEqual(record.range, [[1, 30], [0, 6]]);
});

test("power fitting uses log OLS and scores residuals on original scale", () => {
  const rows = rowsOf(20, x => 3 * x ** 1.7);
  const record = fitProfiles(rows, { fittedAt, pins: pinsFor({ model: "power", features: [feature("in")] }) }).file.nodes.work!.memory!;
  assert.equal(record.model.kind, "power");
  if (record.model.kind === "power") {
    near(record.model.coef, 3);
    near(record.model.exp, 1.7);
  }
  near(record.fit.r2!, 1);
  near(record.fit.residP95, 0);
});

test("derived pinned sum and max resolve each port's measure", () => {
  for (const derived of ["sum", "max"] as const) {
    const rows: Sample[] = Array.from({ length: 20 }, (_, i) => {
      const a = i + 1, b = (i * 3) % 11;
      return { node: "work", features: { a: { tokens: a }, b: { tokens: b } }, resources: { memory: 5 + 2 * (derived === "sum" ? a + b : Math.max(a, b)) }, units: { memory: "MB" } };
    });
    const features: PortFeature[] = [{ derived, ports: [EdgeId.create("a"), EdgeId.create("b")], measure: "tokens" }];
    const result = fitProfiles(rows, { fittedAt, pins: pinsFor({ model: "linear", features }) });
    const record = result.file.nodes.work!.memory!;
    assert.equal(record.model.kind, "linear");
    if (record.model.kind === "linear") { near(record.model.base, 5); near(record.model.coef[0]!, 2); }
    assert.equal(result.report[0]!.features, `${derived}(a,b):tokens`);
  }
});

test("table bins use mean coordinates and merge adjacent duplicate x", () => {
  const rows = rowsOf(20, x => x <= 10 ? 10 : 20).map((row, i) => ({ ...row, features: { in: { count: i < 10 ? 1 : 2 } } }));
  const record = fitProfiles(rows, { fittedAt, pins: pinsFor({ model: "table", features: [feature("in")] }) }).file.nodes.work!.memory!;
  assert.equal(record.model.kind, "table");
  if (record.model.kind === "table") assert.deepEqual(record.model.points, [[1, 10], [2, 20]]);
  near(record.fit.r2!, 1);
});

test("nearest-rank residual percentile is computed from positive original-scale residuals", () => {
  const rows = rowsOf(20, x => 7 + 2 * x + (x % 3 === 0 ? 3 : -1));
  const record = fitProfiles(rows, { fittedAt, pins: pinsFor({ model: "linear", features: [feature("in")] }) }).file.nodes.work!.memory!;
  const model = record.model;
  assert.notEqual(model.kind, "constant");
  if (model.kind === "constant") return;
  const residuals = rows.map((row, i) => Math.max(0, row.resources.memory! - evaluate(model, [i + 1]))).sort((a, b) => a - b);
  assert.equal(record.fit.residP95, residuals[18]);
});

test("singular and constant-output auto candidates fall back to constant", () => {
  for (const rows of [rowsOf(20, () => 5), rowsOf(20, x => x).map(row => ({ ...row, features: { in: { count: 1 } } }))])
    assert.equal(fitProfiles(rows, { fittedAt }).file.nodes.work!.memory!.model.kind, "constant");
});

test("unfittable and unavailable pins fail rather than silently changing models", () => {
  const rows = rowsOf(20, x => x);
  const cases: Pin[] = [
    { model: "linear", features: [feature("missing")] },
    { model: "linear", features: [feature("in"), feature("in")] },
    { model: "power", features: [] },
    { model: "table", features: [feature("in"), feature("in")] },
    { model: "constant", features: [feature("in")] },
    { model: "linear", features: [{ derived: "sum", ports: [EdgeId.create("missing")], measure: "bytes" }] },
  ];
  for (const pin of cases)
    assert.throws(() => fitProfiles(rows, { fittedAt, pins: pinsFor(pin) }), error => error instanceof DataflowDefinitionError && error.message.includes("work/memory"));
  assert.throws(() => fitProfiles(rowsOf(3, x => x), { fittedAt, pins: pinsFor({ model: "table", features: [feature("in")] }) }), /cannot be fitted/);
  assert.throws(() => fitProfiles(rowsOf(20, x => x - 10), { fittedAt, pins: pinsFor({ model: "power", features: [feature("in")] }) }), /cannot be fitted/);
  assert.throws(() => fitProfiles(rows.map(row => ({ ...row, features: { in: { count: 1 } } })), { fittedAt, pins: pinsFor({ model: "table", features: [feature("in")] }) }), /cannot be fitted/);
});

test("empty input and empty resource rows are deterministic", () => {
  assert.deepEqual(fitProfiles([], { fittedAt }), { file: { version: 1, nodes: {} }, report: [], underSampled: [] });
  assert.deepEqual(fitProfiles([{ node: "idle", features: {}, resources: {}, units: {} }], { fittedAt }).file.nodes, { idle: {} });
});
