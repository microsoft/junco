import type * as NativeBindings from "../native/index.js";

/**
 * Shape of the generated NAPI addon.
 *
 * Adapters receive the loaded module by injection so a collection's tools all
 * share exactly one addon instance and one `EditStore`.
 */
export type NativeModule = typeof NativeBindings;
