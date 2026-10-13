import type { Newtype } from "./newtype.js";

/** Branded identifier of a graph node. */
export type NodeId = Newtype<string, "NodeId">;
/** Construction of {@link NodeId}s. */
export const NodeId = {
  /** Brand `value` as a {@link NodeId}; returns exactly `value`. */
  create: (value: string): NodeId => value as NodeId,
};

/** Branded identifier of a graph edge. */
export type EdgeId = Newtype<string, "EdgeId">;
/** Construction of {@link EdgeId}s. */
export const EdgeId = {
  /** Brand `value` as an {@link EdgeId}; returns exactly `value`. */
  create: (value: string): EdgeId => value as EdgeId,
};
