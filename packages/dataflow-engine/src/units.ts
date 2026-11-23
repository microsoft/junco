import { makeUnit, type Quantity, type Unit } from "@buge/ts-units";
import { Time } from "@buge/ts-units/time/dimension.js";

/** Dimension of stored information, `[I]`; ts-units has none. */
export type Information = { readonly information: 1 };
export const Information: Information = { information: 1 };
export const bytes: Unit<number, Information> = makeUnit("B", Information);
export const kilobytes = bytes.withSiPrefix("k");
export const megabytes = bytes.withSiPrefix("M");
export const gigabytes = bytes.withSiPrefix("G");
export const kibibytes = bytes.times(1024).withSymbol("KiB");
export const mebibytes = bytes.times(1024 ** 2).withSymbol("MiB");
export const gibibytes = bytes.times(1024 ** 3).withSymbol("GiB");

/** Dimension of language-model tokens, `[Tok]`. */
export type Tokens = { readonly tokens: 1 };
export const Tokens: Tokens = { tokens: 1 };
export const tokens: Unit<number, Tokens> = makeUnit("tok", Tokens);

/** Dimension of monetary cost, `[Money]`. */
export type Money = { readonly money: 1 };
export const Money: Money = { money: 1 };
export const dollars: Unit<number, Money> = makeUnit("USD", Money);

/** Each resource has a fixed dimension, even when quantities use different units. */
export const RESOURCES = {
  memory: Information,
  runtime: Time,
  tokens: Tokens,
  cost: Money,
} as const;
/** Raw measurements use bytes, milliseconds, token counts or micro-USD. */
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
