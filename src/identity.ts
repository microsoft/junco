import type { Newtype } from "share/newtype";

/** Branded identifier of a graph node. */
export type NodeId = Newtype<string, "NodeId">;
/** Brand `value` as a {@link NodeId}. */
export const NodeId = (value: string): NodeId => value as NodeId;

/** Branded identifier of a graph edge. */
export type EdgeId = Newtype<string, "EdgeId">;
/** Brand `value` as an {@link EdgeId}. */
export const EdgeId = (value: string): EdgeId => value as EdgeId;
