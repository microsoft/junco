import type { Newtype } from "./newtype.js";

/**
 * Newtype-branded mutable array. Prevents a bare `X[]` from being accepted where a
 * queue is expected. Mutable base preserves in-place `.push` / `.splice` at write
 * sites; readers use `.length`, `.slice`, indexing, iteration exactly like a
 * normal array.
 */
export type Queue<X> = Newtype<X[], "Queue">;

/** Wrap an array as a `Queue<X>`. Does NOT copy. */
export const Queue = <X>(items: X[]): Queue<X> => items as Queue<X>;

/** Empty `Queue<X>`. Freshly allocated per call. */
export const emptyQueue = <X>(): Queue<X> => [] as X[] as Queue<X>;
