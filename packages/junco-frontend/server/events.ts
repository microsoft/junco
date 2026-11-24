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
      outcome: "yield" | "final";
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
    };
