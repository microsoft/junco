import { makeUnit, type Unit } from "@buge/ts-units";

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
