import type { Quantity, Unit } from "@buge/ts-units";
import { Time } from "@buge/ts-units/time/dimension.js";
import { DataflowDefinitionError } from "./errors.js";
import type { EdgeId } from "./identity.js";
import { Information, Money, Tokens } from "./units.js";

/** Each resource name has a fixed dimension; profiles and budgets choose their units. */
export const RESOURCES = {
  memory: Information,
  runtime: Time,
  tokens: Tokens,
  cost: Money,
} as const;
export type ResourceKind = keyof typeof RESOURCES;
export const RESOURCE_KINDS = Object.freeze(
  Object.keys(RESOURCES) as ResourceKind[],
);
export type DimensionOf<R extends ResourceKind> = (typeof RESOURCES)[R];
export type ResourceUnit<R extends ResourceKind> = Unit<number, DimensionOf<R>>;
export type ResourceQuantity<R extends ResourceKind> = Quantity<
  number,
  DimensionOf<R>
>;
export type Measure = "bytes" | "count" | "tokens";
export type PortFeature =
  | { readonly port: EdgeId; readonly measure: Measure }
  | {
      readonly derived: "sum" | "max";
      readonly measure: Measure;
      readonly ports: readonly EdgeId[];
    };
/** Each feature's value from per-port `read`s, folding derived features from 0; `undefined` if any read is. */
export function measureFeatures(
  features: readonly PortFeature[],
  read: (port: EdgeId, measure: Measure) => number | undefined,
): number[] | undefined {
  const values: number[] = [];
  for (const feature of features) {
    if ("port" in feature) {
      const value = read(feature.port, feature.measure);
      if (value === undefined) return undefined;
      values.push(value);
      continue;
    }
    let value = 0;
    for (const port of feature.ports) {
      const next = read(port, feature.measure);
      if (next === undefined) return undefined;
      value = feature.derived === "sum" ? value + next : Math.max(value, next);
    }
    values.push(value);
  }
  return values;
}
/** Index-aligned with `ProfileData.features`. */
export type FeatureVector = readonly number[];
/** Numbers are in the owning profile's unit. */
export type Estimate = {
  readonly value: number;
  readonly safe: number;
  readonly source: "model" | "fallback";
  readonly reason?: "out_of_range" | "low_r2" | "few_samples" | "constant";
};
export interface ProfileData<R extends ResourceKind = ResourceKind> {
  readonly resource: R;
  readonly unit: ResourceUnit<R>;
  readonly features: readonly PortFeature[];
  predict(x: FeatureVector): Estimate;
}

/** A fixed per-activation cost, expressed in the supplied quantity's unit. */
export function constantProfile<R extends ResourceKind>(
  resource: R,
  quantity: ResourceQuantity<NoInfer<R>>,
): ProfileData<R> {
  const { amount, unit } = quantity;
  if (!Number.isFinite(amount) || amount < 0)
    throw new DataflowDefinitionError(
      `constantProfile: ${resource} must be a finite non-negative quantity`,
    );
  const estimate = Object.freeze({
    value: amount,
    safe: amount,
    source: "fallback" as const,
    reason: "constant" as const,
  });
  return { resource, unit, features: [], predict: () => estimate };
}

export type Profiles<K extends ResourceKind> = {
  readonly [R in K]: ProfileData<R>;
};
export type ProfilesOption<K extends ResourceKind> = [K] extends [never]
  ? { readonly profiles?: Profiles<never> }
  : { readonly profiles: Profiles<K> };
/** Kind-erased view handed to observers and schedulers. */
export type ProfileSet = { readonly [R in ResourceKind]?: ProfileData<R> };
export const NO_PROFILES: Profiles<never> = Object.freeze({});
export const COMPOSE: Readonly<
  Record<
    ResourceKind,
    { readonly parallel: "sum" | "max"; readonly sequential: "sum" | "max" }
  >
> = {
  memory: { parallel: "sum", sequential: "max" },
  runtime: { parallel: "max", sequential: "sum" },
  tokens: { parallel: "sum", sequential: "sum" },
  cost: { parallel: "sum", sequential: "sum" },
};
