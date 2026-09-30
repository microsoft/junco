import type { StopReason } from "@earendil-works/pi-ai";
import type { NodeStatus } from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { AgenticStatus, AgenticYieldReason } from "junco-agent";
import { type AgencyGraph, agentNodeRecord } from "./agent-node.js";

/** One member as the scheduler sees it. */
export type GraphInfoNode = {
  readonly id: string;
  readonly description: string;
  readonly status: NodeStatus;
  readonly agentStatus: AgenticStatus;
  /** Selectable in the next window. */
  readonly available: boolean;
  /** Reasons of the member's latest pause. */
  readonly lastYield?: readonly AgenticYieldReason[];
  /** The member's native final message, reduced to its text. */
  readonly result?: { readonly stopReason: StopReason; readonly text: string };
};

/** One wire: a message queue or a write-once result cell. */
export type GraphInfoEdge = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "message" | "value";
  /** Queued messages on a message edge; whether the result is written on a value edge. */
  readonly queued?: number;
  readonly resolved?: boolean;
};

/** A fresh snapshot of an agency's graph, given to its scheduler as data. */
export type GraphInfo = {
  /** Most columns per window; `null` is unbounded. */
  readonly window: number | null;
  /** Most lanes per window; `null` is unbounded. */
  readonly threads: number | null;
  /** Nothing is available. Finished and blocked members may remain. */
  readonly quiescent: boolean;
  readonly nodes: readonly GraphInfoNode[];
  readonly edges: readonly GraphInfoEdge[];
};

const bound = (width: number): number | null => (Number.isFinite(width) ? width : null);

/** Snapshot `graph`, planned within `bounds`, in node insertion order. Reads no queue. */
export function graphInfo(
  graph: AgencyGraph,
  bounds: { readonly window: number; readonly threads: number },
): GraphInfo {
  const available = graph.available();
  const nodes: GraphInfoNode[] = [];
  graph.forEachNode((id, node) => {
    const record = agentNodeRecord(node.step);
    const result = graph.result(id);
    nodes.push({
      id,
      description: record?.description ?? "",
      status: node.status,
      agentStatus: node.state.status,
      available: available.has(id),
      ...(record?.lastYield === undefined ? {} : { lastYield: record.lastYield }),
      ...(O.isSome(result)
        ? {
            result: {
              stopReason: result.value.stopReason,
              text: result.value.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
            },
          }
        : {}),
    });
  });
  const edges: GraphInfoEdge[] = [];
  graph.forEachLink((from, to, edge) => {
    edges.push(
      E.isLeft(edge.transport)
        ? { id: edge.id, from, to, kind: "message", queued: edge.transport.left.length }
        : { id: edge.id, from, to, kind: "value", resolved: O.isSome(edge.transport.right) },
    );
  });
  return {
    window: bound(bounds.window),
    threads: bound(bounds.threads),
    quiescent: available.size === 0,
    nodes,
    edges,
  };
}
