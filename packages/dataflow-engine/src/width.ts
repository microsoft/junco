import type { Integer, IsNegative, PositiveInfinity } from "type-fest";
import type { Newtype } from "./newtype.js";

/**
 * `W` when it is a legal width — a positive integer or `Infinity` — and `never` otherwise.
 *
 * Order matters twice. `Infinity` is matched FIRST because `Integer<PositiveInfinity>` is `never`.
 * `0` is excluded explicitly because zero IS an integer. What remains rejects fractions via
 * `Integer<W>`, negatives via `IsNegative<W>`, and — because `IsInteger<number>` is `false` — any
 * width that is only known at runtime.
 */
export type ValidWidth<W extends number> = W extends PositiveInfinity
  ? W
  : W extends 0
    ? never
    : IsNegative<W> extends true
      ? never
      : Integer<W>;

/**
 * A scheduler width: a positive integer or `Infinity`. Branded so it cannot be spelled by an
 * unchecked literal — the only way to obtain one is `Width.create`, which checks at compile time.
 */
export type Width = Newtype<number, "Width">;

/** Construction of {@link Width}s. */
export const Width = {
  /**
   * Brand `value` as a {@link Width}, rejecting anything that is not a positive integer or
   * `Infinity`.
   *
   * The double assertion is required: `value`'s type is a deferred conditional, which TypeScript
   * will not narrow to the brand in one step.
   *
   * @example
   * Width.create(4);            // ok
   * Width.create(0);            // compile error: zero is not positive
   * Width.create(1.5);          // compile error: not an integer
   * Width.create(runtimeValue); // compile error: a runtime `number` cannot be checked
   */
  create: <W extends number>(value: ValidWidth<W>): Width =>
    value as number as Width,
};

/** `Infinity` as a {@link Width}: unbounded turns per lane, or unbounded lanes per plan. */
export const UNBOUNDED: Width = Number.POSITIVE_INFINITY as Width;
