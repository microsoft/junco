import type { NativePolicy } from "../native/index.js";
import type { NativeModule } from "./native.js";

/**
 * An authorization policy for a mux's managed commands. An implementation builds the native
 * policy it denotes with one addon, since each addon build has its own `NativePolicy`; a new
 * policy only implements this interface, and `Policy.and`, `Policy.or` and `Policy.not` compose any
 * policies. Policies compare by identity: share one object wherever one policy is meant.
 */
export interface Policy {
  toNative(native: NativeModule): NativePolicy;
}

/** The ownership-lock policy: a write owns its file until released; others' edits are denied. */
export const LockPolicy: Policy = Object.freeze({
  toNative: (native: NativeModule) => native.NativePolicy.lock(),
});

/** Grants every capability; snapshots, freshness and publication still apply. */
export const EmptyPolicy: Policy = Object.freeze({
  toNative: (native: NativeModule) => native.NativePolicy.empty(),
});

/** Composition of {@link Policy} objects; each composite is a fresh frozen policy. */
export const Policy = {
  /** Grants exactly what both grant. */
  and(left: Policy, right: Policy): Policy {
    return Object.freeze({
      toNative: (native: NativeModule) =>
        native.NativePolicy.and(left.toNative(native), right.toNative(native)),
    });
  },
  /** Grants what either grants. */
  or(left: Policy, right: Policy): Policy {
    return Object.freeze({
      toNative: (native: NativeModule) =>
        native.NativePolicy.or(left.toNative(native), right.toNative(native)),
    });
  },
  /** Grants exactly what `policy` denies. */
  not(policy: Policy): Policy {
    return Object.freeze({
      toNative: (native: NativeModule) =>
        native.NativePolicy.not(policy.toNative(native)),
    });
  },
};
