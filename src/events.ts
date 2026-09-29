/** A mid-run control delivered through `next()`: `steer` interrupts, `followUp` runs after the current work. */
export type JuncoControl = {
  readonly kind: "steer" | "followUp";
  readonly msg: string;
};

/** Hard aborts thrown from the generator instead of returning a completion value. */
export type JuncoAbort =
  | { readonly code: "protocol"; readonly message: string }
  | { readonly code: "invariant"; readonly message: string };

/** The generator's completion value. */
export type JuncoResult = {
  readonly text: string;
  /** Freeform structured prompt-outcome metadata. */
  readonly details?: unknown;
};
