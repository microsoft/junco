import { DataflowDefinitionError, RESOURCE_KINDS, type ResourceKind } from "dataflow-engine";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { makeProfile } from "./predict.js";
import type { PinsFile, ProfilesFile, Sample } from "./types.js";
import { UNITS } from "./units.js";

const strict = { additionalProperties: false } as const;
const finite = () => Type.Number({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
const nonnegative = () => Type.Number({ minimum: 0, maximum: Number.MAX_VALUE });
const measure = Type.Union([Type.Literal("bytes"), Type.Literal("count"), Type.Literal("tokens")]);
const feature = Type.Union([
  Type.Object({ port: Type.String(), measure }, strict),
  Type.Object({
    derived: Type.Union([Type.Literal("sum"), Type.Literal("max")]),
    measure,
    ports: Type.Array(Type.String()),
  }, strict),
]);
const model = Type.Union([
  Type.Object({ kind: Type.Literal("constant") }, strict),
  Type.Object({ kind: Type.Literal("linear"), base: finite(), coef: Type.Array(finite()) }, strict),
  Type.Object({ kind: Type.Literal("power"), coef: finite(), exp: finite() }, strict),
  Type.Object({
    kind: Type.Literal("table"),
    points: Type.Array(Type.Tuple([nonnegative(), nonnegative()])),
  }, strict),
]);
const unitSymbols = (resource: ResourceKind) =>
  Type.Union(Object.keys(UNITS[resource]).map(symbol => Type.Literal(symbol)));
const profile = Type.Union(RESOURCE_KINDS.map(resource => Type.Object({
  resource: Type.Literal(resource),
  unit: unitSymbols(resource),
  features: Type.Array(feature),
  model,
  fit: Type.Object({
    n: Type.Integer({ minimum: 0, maximum: Number.MAX_VALUE }),
    r2: Type.Optional(finite()),
    residP95: nonnegative(),
    fittedAt: Type.String(),
  }, strict),
  range: Type.Array(Type.Tuple([nonnegative(), nonnegative()])),
  bound: nonnegative(),
}, strict)));

export const ProfilesFileSchema = Type.Object({
  version: Type.Literal(1),
  measured: Type.Optional(Type.Object({
    metric: Type.String(), host: Type.String(), fittedAt: Type.String(),
  }, strict)),
  nodes: Type.Record(Type.String(), Type.Object({
    memory: Type.Optional(profile),
    runtime: Type.Optional(profile),
    tokens: Type.Optional(profile),
    cost: Type.Optional(profile),
  }, strict), strict),
}, strict);

export const SampleSchema = Type.Object({
  node: Type.String(),
  features: Type.Record(Type.String(), Type.Object({
    bytes: Type.Optional(nonnegative()),
    count: Type.Optional(nonnegative()),
    tokens: Type.Optional(nonnegative()),
  }, strict), strict),
  resources: Type.Object({
    memory: Type.Optional(nonnegative()),
    runtime: Type.Optional(nonnegative()),
    tokens: Type.Optional(nonnegative()),
    cost: Type.Optional(nonnegative()),
  }, strict),
  units: Type.Object({
    memory: Type.Optional(unitSymbols("memory")),
    runtime: Type.Optional(unitSymbols("runtime")),
    tokens: Type.Optional(unitSymbols("tokens")),
    cost: Type.Optional(unitSymbols("cost")),
  }, strict),
  runId: Type.Optional(Type.String()),
  firedAt: Type.Optional(Type.String()),
  host: Type.Optional(Type.Record(Type.String(), Type.Unknown(), strict)),
  measurement: Type.Optional(Type.Record(Type.String(), Type.Unknown(), strict)),
}, strict);

const pin = Type.Object({
  model: Type.Union([
    Type.Literal("constant"), Type.Literal("linear"), Type.Literal("power"), Type.Literal("table"),
  ]),
  features: Type.Array(feature),
}, strict);
export const PinsFileSchema = Type.Object({
  version: Type.Literal(1),
  nodes: Type.Record(Type.String(), Type.Object({
    memory: Type.Optional(pin),
    runtime: Type.Optional(pin),
    tokens: Type.Optional(pin),
    cost: Type.Optional(pin),
  }, strict), strict),
}, strict);

function parse(text: string, schema: TSchema, context: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new DataflowDefinitionError(`${context}: ${error.message}`);
  }
  if (!Value.Check(schema, value)) {
    const [error] = Value.Errors(schema, value);
    throw new DataflowDefinitionError(
      `${context}: ${error ? `${error.instancePath || "/"} ${error.message}` : "invalid value"}`,
    );
  }
  return value;
}

const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

export function parseProfiles(text: string): ProfilesFile {
  // JSON schemas validate string ports; the engine's branded ids enter only at this boundary.
  const file = parse(text, ProfilesFileSchema, "profiles") as ProfilesFile;
  for (const [node, profiles] of Object.entries(file.nodes)) {
    for (const kind of RESOURCE_KINDS) {
      const record = profiles[kind];
      if (record === undefined) continue;
      const path = `/nodes/${pointer(node)}/${kind}`;
      if (record.resource !== kind)
        throw new DataflowDefinitionError(
          `profiles: node "${node}" key "${kind}" holds a "${record.resource}" profile (${path}/resource)`,
        );
      try {
        makeProfile(record);
      } catch (error) {
        if (!(error instanceof DataflowDefinitionError)) throw error;
        throw new DataflowDefinitionError(`profiles: ${path} ${error.message}`);
      }
    }
  }
  return file;
}

export function formatProfiles(file: ProfilesFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

export function parseSamples(text: string): Sample[] {
  const samples: Sample[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const context = `samples line ${index + 1}`;
    const sample = parse(line, SampleSchema, context) as Sample;
    for (const kind of RESOURCE_KINDS) {
      if (Object.hasOwn(sample.resources, kind) && !Object.hasOwn(sample.units, kind))
        throw new DataflowDefinitionError(`${context}: resource "${kind}" has no unit`);
    }
    samples.push(sample);
  }
  return samples;
}

export function parsePins(text: string): PinsFile {
  return parse(text, PinsFileSchema, "pins") as PinsFile;
}
