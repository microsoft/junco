import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "bun:test";
import { DataflowDefinitionError } from "dataflow-engine";
import { Value } from "typebox/value";
import {
  PinsFileSchema, ProfilesFileSchema, SampleSchema,
  formatProfiles, parsePins, parseProfiles, parseSamples,
} from "../src/schema.js";

const memory = {
  resource: "memory", unit: "MB", features: [], model: { kind: "constant" },
  fit: { n: 10, residP95: 0, fittedAt: "2026-10-12" }, range: [], bound: 100,
};
const profileText = (record: unknown = memory) => JSON.stringify({
  version: 1, nodes: { worker: { memory: record } },
});
const sample = {
  node: "worker", features: { in: { count: 2, bytes: 8, tokens: 2 } },
  resources: { memory: 100 }, units: { memory: "MB" },
};
const pins = {
  version: 1, nodes: {
    worker: {
      memory: {
        model: "linear", features: [{ derived: "sum", ports: ["a", "b"], measure: "count" }],
      }
    }
  },
};

const cost = {
  resource: "cost", unit: "USD", features: [], model: { kind: "constant" },
  fit: { n: 1, residP95: 0, fittedAt: "2026-10-12" }, range: [], bound: 0.125,
};
const costSample = {
  node: "worker", features: {}, resources: { cost: 0.125 }, units: { cost: "USD" },
};
const costPins = {
  version: 1, nodes: { worker: { cost: { model: "constant", features: [] } } },
};

test("round-trips cost profiles, samples, and pins", () => {
  const profiles = { version: 1, nodes: { worker: { cost } } };
  assert.deepEqual(parseProfiles(JSON.stringify(profiles)), profiles);
  assert.deepEqual(parseSamples(JSON.stringify(costSample)), [costSample]);
  assert.deepEqual(parsePins(JSON.stringify(costPins)), costPins);
});

function rejects(action: () => unknown, message: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DataflowDefinitionError);
    assert.match(error.message, message);
    return true;
  });
}

describe("profile JSON validation", () => {
  test("round-trips the golden profile file byte for byte", () => {
    const text = readFileSync(new URL("../fixtures/profiles.json", import.meta.url), "utf8");
    assert.equal(formatProfiles(parseProfiles(text)), text);
  });

  test("exports usable schemas for all three file formats", () => {
    assert.equal(Value.Check(ProfilesFileSchema, JSON.parse(profileText())), true);
    assert.equal(Value.Check(SampleSchema, sample), true);
    assert.equal(Value.Check(PinsFileSchema, pins), true);
  });

  test("rejects a record under the wrong resource key", () => {
    rejects(
      () => parseProfiles(profileText({ ...memory, resource: "runtime", unit: "s" })),
      /key "memory" holds a "runtime" profile.*\/nodes\/worker\/memory\/resource/,
    );
    rejects(
      () => parseProfiles(JSON.stringify({ version: 1, nodes: { worker: { cost: { ...memory, resource: "tokens", unit: "tok" } } } })),
      /key "cost" holds a "tokens" profile.*\/nodes\/worker\/cost\/resource/,
    );
  });

  test("rejects unknown resources, symbols and nonnumeric bounds with field paths", () => {
    rejects(() => parseProfiles(profileText({ ...memory, resource: "disk" })), /\/nodes\/worker\/memory\/resource/);
    rejects(() => parseProfiles(profileText({ ...memory, unit: "MBs" })), /\/nodes\/worker\/memory\/unit/);
    rejects(() => parseProfiles(profileText({ ...memory, bound: "100" })), /\/nodes\/worker\/memory\/bound/);
    rejects(() => parseProfiles(profileText({ ...memory, unit: "s" })), /\/nodes\/worker\/memory\/unit/);
  });

  test("runs semantic model validation after the schema check", () => {
    rejects(() => parseProfiles(profileText({
      ...memory, model: { kind: "linear", base: 0, coef: [1] },
    })), /\/nodes\/worker\/memory.*coef/);
  });

  test("rejects extra properties at the root and in nested profiles", () => {
    rejects(() => parseProfiles(JSON.stringify({
      version: 1, nodes: {}, extra: true,
    })), /profiles:/);
    rejects(() => parseProfiles(profileText({ ...memory, extra: true })), /\/nodes\/worker\/memory/);
    rejects(() => parseProfiles(profileText({
      ...memory, fit: { ...memory.fit, extra: true },
    })), /\/nodes\/worker\/memory\/fit/);
  });

  test("rejects negative values and overflowing JSON numbers", () => {
    rejects(() => parseProfiles(profileText({ ...memory, bound: -1 })), /\/nodes\/worker\/memory\/bound/);
    rejects(() => parseProfiles(profileText().replace('"bound":100', '"bound":1e999')), /\/nodes\/worker\/memory\/bound/);
    rejects(() => parseProfiles(profileText({
      ...memory, fit: { ...memory.fit, n: 1.5 },
    })), /\/nodes\/worker\/memory\/fit\/n/);
  });

  test("wraps malformed JSON as a definition error", () => {
    rejects(() => parseProfiles("{"), /profiles:/);
  });
});

describe("sample JSONL validation", () => {
  test("accepts metadata and skips blank lines without changing row data", () => {
    const row = {
      ...sample, runId: "run-1", firedAt: "2026-10-12T12:00:00Z",
      host: { name: "host", nested: { cpu: 4 } }, measurement: { metric: "rss", value: 100 },
    };
    assert.deepEqual(parseSamples(`\n${JSON.stringify(row)}\r\n \t\n${JSON.stringify(sample)}\n`), [row, sample]);
  });

  test("reports physical line numbers for schema and JSON errors", () => {
    rejects(() => parseSamples(`\n${JSON.stringify(sample)}\n\n${JSON.stringify({
      ...sample, resources: { memory: "100" },
    })}`), /samples line 4:.*\/resources\/memory/);
    rejects(() => parseSamples(`${JSON.stringify(sample)}\n{`), /samples line 2:/);
  });

  test("requires a unit for each reported resource, including zero", () => {
    rejects(() => parseSamples(JSON.stringify({
      ...sample, resources: { memory: 0 }, units: {},
    })), /samples line 1: resource "memory" has no unit/);
    rejects(() => parseSamples(JSON.stringify({
      ...costSample, resources: { cost: 0 }, units: {},
    })), /samples line 1: resource "cost" has no unit/);
    rejects(() => parseSamples(JSON.stringify({
      ...sample, resources: { memory: 100, runtime: 1 },
    })), /resource "runtime" has no unit/);
  });

  test("rejects mismatched unit dimensions and unknown symbols", () => {
    for (const unit of ["s", "MBs"]) {
      rejects(() => parseSamples(JSON.stringify({
        ...sample, units: { memory: unit },
      })), /samples line 1:.*\/units\/memory/);
    }
    rejects(() => parseSamples(JSON.stringify({
      ...costSample, units: { cost: "tok" },
    })), /samples line 1:.*\/units\/cost/);
  });

  test("rejects negative resources, negative features and nonfinite numbers", () => {
    rejects(() => parseSamples(JSON.stringify({
      ...sample, resources: { memory: -1 },
    })), /\/resources\/memory/);
    rejects(() => parseSamples(JSON.stringify({
      ...sample, features: { in: { count: -1 } },
    })), /\/features\/in\/count/);
    rejects(() => parseSamples(JSON.stringify(sample).replace('"memory":100', '"memory":1e999')), /\/resources\/memory/);
    rejects(() => parseSamples(JSON.stringify({
      ...costSample, resources: { cost: -1 },
    })), /\/resources\/cost/);
    rejects(() => parseSamples(JSON.stringify(costSample).replace('"cost":0.125', '"cost":1e999')), /\/resources\/cost/);
  });

  test("rejects extra properties at every structured boundary", () => {
    for (const row of [
      { ...sample, extra: true },
      { ...sample, resources: { memory: 100, disk: 1 } },
      { ...sample, units: { memory: "MB", disk: "B" } },
      { ...sample, features: { in: { count: 1, words: 2 } } },
    ]) rejects(() => parseSamples(JSON.stringify(row)), /samples line 1:/);
  });
});

describe("pin JSON validation", () => {
  test("preserves derived feature pins and accepts direct port features", () => {
    assert.deepEqual(parsePins(JSON.stringify(pins)), pins);
    const direct = {
      version: 1, nodes: {
        worker: {
          runtime: {
            model: "power", features: [{ port: "in", measure: "tokens" }],
          }
        }
      }
    };
    assert.deepEqual(parsePins(JSON.stringify(direct)), direct);
  });

  test("rejects unknown model kinds, resource kinds and feature measures", () => {
    rejects(() => parsePins(JSON.stringify({
      version: 1, nodes: {
        worker: {
          memory: {
            model: "polynomial", features: [],
          }
        }
      }
    })), /\/nodes\/worker\/memory\/model/);
    rejects(() => parsePins(JSON.stringify({
      version: 1, nodes: {
        worker: {
          disk: {
            model: "constant", features: [],
          }
        }
      }
    })), /\/nodes\/worker/);
    rejects(() => parsePins(JSON.stringify({
      version: 1, nodes: {
        worker: {
          memory: {
            model: "linear", features: [{ port: "in", measure: "words" }],
          }
        }
      }
    })), /\/nodes\/worker\/memory\/features\/0/);
  });

  test("rejects extra properties and unsupported versions", () => {
    rejects(() => parsePins(JSON.stringify({ ...pins, version: 2 })), /\/version/);
    rejects(() => parsePins(JSON.stringify({ ...pins, extra: true })), /pins:/);
    rejects(() => parsePins(JSON.stringify({
      version: 1, nodes: {
        worker: {
          memory: {
            model: "constant", features: [], extra: true,
          }
        }
      }
    })), /\/nodes\/worker\/memory/);
    rejects(() => parsePins("{"), /pins:/);
  });
});
