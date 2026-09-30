/** The `code` of every error a Marsh policy denial of publication rejects with. */
export const MARSH_POLICY_DENIED = "MARSH_POLICY_DENIED";

/** A native rejection caused by a Marsh policy denial; its message is the diagnostic. */
export interface MarshPolicyDeniedError extends Error {
  readonly code: typeof MARSH_POLICY_DENIED;
}

/** Whether `error` is a Marsh policy denial, by its exact code, never its message text. */
export function isMarshPolicyDenied(error: unknown): error is MarshPolicyDeniedError {
  return error instanceof Error && "code" in error && error.code === MARSH_POLICY_DENIED;
}
