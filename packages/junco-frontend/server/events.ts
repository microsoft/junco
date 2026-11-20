import type { Usage } from "@earendil-works/pi-ai";

/** A graph link as the client draws it. */
export type Link = {
  from: string;
  to: string;
  id: string;
  kind: "message" | "value";
};

/** A node as of its graph's latest `startRun`; `child` is the serial of a nested graph it holds. */
export type GraphNode = {
  id: string;
  status: "ready" | "running" | "done";
  description?: string;
  child?: number;
};

/** A profile event with its opaque object identities replaced by per-server numbers. */
export type ProfileWire =
  | { resource: string; kind: "usage"; source: number; usage: Usage }
  | { resource: string; kind: "resource"; source: number; event: unknown }
  | {
      resource: string;
      kind: "probe";
      edgeId: string;
      value: number;
      unit?: string;
    }
  | ({ kind: "start" } & OperationWire)
  | ({
      kind: "finish";
      outcome: "success" | "error" | "cancelled";
      durationMs: number;
    } & OperationWire)
  | ({
      kind: "metrics";
      counters?: Record<string, number>;
      gauges?: Record<string, number | null>;
    } & OperationWire);

type OperationWire = {
  resource: string;
  category: string;
  tool: string;
  operation: string;
  activation?: {
    runId: string;
    firedAt: string;
    features: Record<string, { count: number }>;
    agent: number | undefined;
    owner: string | undefined;
  };
};

/**
 * One entry of the server's event log. `seq` is its 1-based position, `at` its ISO time; `graph` is
 * the per-process serial of the graph it belongs to (`0` when unknown).
 */
export type FrontendEvent = { seq: number; at: string } & FrontendEventBody;

/** A {@link FrontendEvent} before the server stamps it. */
export type FrontendEventBody =
  | { kind: "graph"; graph: number; nodes: GraphNode[]; links: Link[] }
  | { kind: "run"; graph: number; run: number; phase: "start" }
  | {
      kind: "run";
      graph: number;
      run: number;
      phase: "end";
      results: string[];
    }
  | { kind: "run"; graph: number; run: number; phase: "fail"; error: unknown }
  | {
      kind: "activation";
      graph: number;
      run: number;
      node: string;
      phase: "prime" | "resume";
      messages: { edge: string; payloads: unknown[] }[];
      values: string[];
    }
  | {
      kind: "step";
      graph: number;
      run: number;
      node: string;
      outcome: "yield";
      messages: { edge: string; payload: unknown }[];
    }
  | {
      kind: "step";
      graph: number;
      run: number;
      node: string;
      outcome: "return";
      value: unknown;
    }
  | {
      kind: "step";
      graph: number;
      run: number;
      node: string;
      outcome: "error";
      error: unknown;
    }
  | {
      kind: "tool";
      graph: number;
      node: string;
      lane: string;
      toolCallId: string;
      toolName: string;
      phase: "start";
      args: unknown;
    }
  | {
      kind: "tool";
      graph: number;
      node: string;
      lane: string;
      toolCallId: string;
      toolName: string;
      phase: "end";
      result: unknown;
      isError: boolean;
    }
  | {
      kind: "message";
      graph: number;
      node: string;
      lane: string;
      role: "user" | "assistant";
      text: string;
      stopReason?: string;
      errorMessage?: string;
    }
  | { kind: "profile"; path: string[]; event: ProfileWire };
