import type { ValidWidth } from "../src/index.ts";
import { DataflowGraph, UNBOUNDED, Width } from "../src/index.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Exported so `noUnusedLocals` — which guards this project against orphaned imports — does not
// report the assertions themselves as dead. Nothing imports this file; it exists to be compiled.
export type _positiveIntegerSurvives = Expect<Equal<ValidWidth<64>, 64>>;
export type _infinitySurvives = Expect<Equal<ValidWidth<1e999>, 1e999>>;
export type _zeroRejected = Expect<Equal<ValidWidth<0>, never>>;
export type _fractionRejected = Expect<Equal<ValidWidth<1.5>, never>>;
export type _negativeRejected = Expect<Equal<ValidWidth<-3>, never>>;
export type _runtimeNumberRejected = Expect<Equal<ValidWidth<number>, never>>;

// Accepted: a positive integer literal, and the sanctioned spelling of Infinity.
new DataflowGraph<void, number, string, never>(
  Width.create(1),
  UNBOUNDED,
);
new DataflowGraph<void, number, string, never>(
  Width.create(64),
  Width.create(8),
);

declare const runtimeValue: number;

// @ts-expect-error zero is not a positive width.
Width.create(0);
// @ts-expect-error a fractional width is not an integer.
Width.create(1.5);
// @ts-expect-error a negative width is not positive.
Width.create(-3);
// @ts-expect-error -Infinity is not a positive width.
// biome-ignore lint/correctness/noPrecisionLoss: 1e999 is the only literal spelling of Infinity, which this negative case needs.
Width.create(-1e999);
// @ts-expect-error a width computed at runtime cannot be checked at compile time.
Width.create(runtimeValue);
new DataflowGraph<void, number, string, never>(
  // @ts-expect-error a bare number bypasses the check; widths must be minted by Width.create().
  1,
  UNBOUNDED,
);
