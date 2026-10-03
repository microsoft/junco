declare const brand: unique symbol;

/** A value of base type `T` tagged with a compile-time-only brand `B`. */
export type Newtype<T, B extends string> = T & { readonly [brand]: B };
