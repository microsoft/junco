import { test } from "bun:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { DataflowDefinitionError, EdgeId, gibibytes, megabytes } from "dataflow-engine";
import { evaluate, makeProfile, profilesOf } from "../src/predict.ts";
import { symbolOf, unitOf } from "../src/units.ts";
import { type ProfileRecord, type ProfilesFile } from "../src/types.ts";

const feature = { port: EdgeId.create("in"), measure: "count" as const };
function record(overrides: Partial<ProfileRecord<"memory">> = {}): ProfileRecord<"memory"> {
  return { resource: "memory", unit: "MB", features: [feature], model: { kind: "linear", base: 2, coef: [3] }, fit: { n: 10, r2: 0.99, residP95: 2, fittedAt: "2026-10-12" }, range: [[0, 10]], bound: 40, ...overrides };
}

const invalid: readonly [string, Partial<ProfileRecord<"memory">>][] = [
  ["unit", { unit: "MBs" as never }],
  ["model.coef", { model: { kind: "linear", base: 0, coef: [] } }],
  ["features", { model: { kind: "constant" } }],
  ["features", { model: { kind: "power", coef: 1, exp: 2 }, features: [], range: [] }],
  ["features", { model: { kind: "table", points: [[0, 0], [1, 1]] }, features: [], range: [] }],
  ["range", { range: [] }],
  ["range", { range: [[2, 1]] }],
  ["model.points", { model: { kind: "table", points: [[0, 0]] } }],
  ["model.points", { model: { kind: "table", points: [[1, 1], [0, 0]] } }],
  ["model.points", { model: { kind: "table", points: [[1, 1], [1, 2]] } }],
  ["fit.n", { fit: { n: -1, residP95: 0, fittedAt: "date" } }],
  ["fit.n", { fit: { n: 1.5, residP95: 0, fittedAt: "date" } }],
  ["bound", { bound: -1 }],
  ["bound", { bound: Infinity }],
  ["fit.residP95", { fit: { n: 5, residP95: -1, fittedAt: "date" } }],
  ["fit.residP95", { fit: { n: 5, residP95: NaN, fittedAt: "date" } }],
];
for (const [field, overrides] of invalid)
  test(`makeProfile rejects invalid ${field}: ${JSON.stringify(overrides)}`, () => {
    assert.throws(() => makeProfile(record(overrides)), error => error instanceof DataflowDefinitionError && error.message.includes("memory") && error.message.includes(field));
  });

test("profiles resolve units by identity and reject unsupported symbols/units", () => {
  assert.equal(makeProfile(record({ unit: "GiB" })).unit, gibibytes);
  assert.equal(unitOf("memory", "MB"), megabytes);
  assert.equal(symbolOf("memory", megabytes), "MB");
  assert.throws(() => unitOf("memory", "constructor"), DataflowDefinitionError);
  assert.throws(() => symbolOf("memory", megabytes.times(2)), DataflowDefinitionError);
});

test("linear models with nonnegative coefficients are monotone per feature", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 6 }),
    fc.integer({ min: -100, max: 100 }), fc.integer({ min: 0, max: 100 }),
    (coef, base, delta) => {
      const x = coef.map(() => 10);
      const model = { kind: "linear" as const, base, coef };
      const before = evaluate(model, x);
      for (let i = 0; i < x.length; i++) {
        const next = [...x];
        next[i]! += delta;
        assert.ok(evaluate(model, next) >= before);
      }
    },
  ));
});

test("fallback thresholds have fixed precedence and never underestimate the model", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 15 }),
    fc.option(fc.integer({ min: 0, max: 100 }).map(n => n / 100), { nil: undefined }),
    fc.integer({ min: -20, max: 20 }), fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: -50, max: 50 }), fc.integer({ min: 0, max: 100 }),
    (n, r2, lo, span, x, bound) => {
      const hi = lo + span;
      const tolerance = 0.1 * (span === 0 ? Math.abs(hi) : span);
      const reason = n < 5 ? "few_samples" : r2 !== undefined && r2 < 0.7 ? "low_r2"
        : x < lo - tolerance || x > hi + tolerance ? "out_of_range" : undefined;
      const profile = makeProfile(record({ fit: { n, ...(r2 === undefined ? {} : { r2 }), residP95: 2, fittedAt: "date" }, range: [[lo, hi]], bound }));
      const estimate = profile.predict([x]);
      assert.equal(estimate.source, reason === undefined ? "model" : "fallback");
      assert.equal(estimate.reason, reason);
      assert.equal(estimate.safe, reason === undefined ? estimate.value + 2 : Math.max(bound, estimate.value));
      assert.ok(estimate.safe >= estimate.value);
      assert.ok(Object.isFrozen(estimate));
    },
  ));
});

test("constant profiles use their bound without features", () => {
  const profile = makeProfile(record({ features: [], range: [], model: { kind: "constant" }, bound: 100 }));
  assert.deepEqual(profile.predict([]), { value: 100, safe: 100, source: "fallback", reason: "constant" });
  assert.throws(() => profile.predict([1]), DataflowDefinitionError);
});

test("table models interpolate exactly and clamp to the end points", () => {
  const model = { kind: "table" as const, points: [[1, 3], [3, 11], [10, 18]] as const };
  for (const [x, y] of model.points) assert.equal(evaluate(model, [x]), y);
  assert.equal(evaluate(model, [-100]), 3);
  assert.equal(evaluate(model, [100]), 18);
  assert.equal(evaluate(model, [2]), 7);
  assert.equal(evaluate(model, [7]), 15);
  assert.equal(evaluate({ kind: "power", coef: 2, exp: 3 }, [4]), 128);
});

test("profilesOf loads requested kinds, ignoring extras and rejecting missing/mismatched records", () => {
  const file: ProfilesFile = { version: 1, nodes: { node: { memory: record(), runtime: { ...record(), resource: "runtime", unit: "s" } } } };
  const profiles = profilesOf(file, "node", ["memory"]);
  assert.deepEqual(Object.keys(profiles), ["memory"]);
  assert.equal(profiles.memory.unit, megabytes);
  assert.ok(Object.isFrozen(profiles));
  assert.throws(() => profilesOf(file, "node", ["tokens"]), /has no "tokens" profile/);
  assert.throws(() => profilesOf(file, "absent", ["memory"]), /not in the file/);
  assert.throws(() => profilesOf(file, "constructor", ["memory"]), /not in the file/);
  const bad: ProfilesFile = { version: 1, nodes: { node: { memory: { ...record(), resource: "runtime" } as never } } };
  assert.throws(() => profilesOf(bad, "node", ["memory"]), /key "memory" holds a "runtime" profile/);
});
