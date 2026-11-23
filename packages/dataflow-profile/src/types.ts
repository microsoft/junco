import type { EdgeIdType, ResourceKind, ResourceUnit } from "dataflow-engine";
import type { UnitSymbol } from "./units.js";

export type Measure = "bytes" | "count" | "tokens";
export type PortFeature =
  | { readonly port: EdgeIdType; readonly measure: Measure }
  | { readonly derived: "sum" | "max"; readonly measure: Measure; readonly ports: readonly EdgeIdType[] };
export type FeatureVector = readonly number[];
export type Estimate = {
  readonly value: number;
  readonly safe: number;
  readonly source: "model" | "fallback";
  readonly reason?: "out_of_range" | "low_r2" | "few_samples" | "constant";
};

export type Model =
  | { readonly kind: "constant" }
  | { readonly kind: "linear"; readonly base: number; readonly coef: readonly number[] }
  | { readonly kind: "power"; readonly coef: number; readonly exp: number }
  | { readonly kind: "table"; readonly points: readonly (readonly [number, number])[] };
export type FitInfo = { readonly n: number; readonly r2?: number; readonly residP95: number; readonly fittedAt: string };
/** Serialisable profile; unit is a symbol in UNITS[resource]. */
export type ProfileRecord<R extends ResourceKind = ResourceKind> = {
  readonly resource: R;
  readonly unit: UnitSymbol<R>;
  readonly features: readonly PortFeature[];
  readonly model: Model;
  readonly fit: FitInfo;
  readonly range: readonly (readonly [number, number])[];
  /** Largest observed per-activation value; the fallback floor. */
  readonly bound: number;
};
export type Profile<R extends ResourceKind = ResourceKind> = Omit<ProfileRecord<R>, "unit"> & {
  readonly unit: ResourceUnit<R>;
  predict(x: FeatureVector): Estimate;
};
export type ProfilesFile = {
  readonly version: 1;
  readonly measured?: { readonly metric: string; readonly host: string; readonly fittedAt: string };
  readonly nodes: Readonly<Record<string, { readonly [R in ResourceKind]?: ProfileRecord<R> }>>;
};
export type Sample = {
  readonly node: string;
  readonly features: Readonly<Record<string, Readonly<Partial<Record<Measure, number>>>>>;
  /** Peak usage of ONE activation (the batch in `features`); memory retained across yields is not a sample. */
  readonly resources: Readonly<Partial<Record<ResourceKind, number>>>;
  readonly units: { readonly [R in ResourceKind]?: UnitSymbol<R> };
  readonly runId?: string;
  readonly firedAt?: string;
  readonly host?: Readonly<Record<string, unknown>>;
  readonly measurement?: Readonly<Record<string, unknown>>;
};
export type Pin = { readonly model: Model["kind"]; readonly features: readonly PortFeature[] };
export type PinsFile = { readonly version: 1; readonly nodes: Readonly<Record<string, Readonly<Partial<Record<ResourceKind, Pin>>>>> };
export const THRESHOLDS = { N_MIN: 5, R2_MIN: 0.7, RANGE_TOLERANCE: 0.1 } as const;
