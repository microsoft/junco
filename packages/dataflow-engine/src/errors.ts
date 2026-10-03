import type { NodeId } from "./identity.js";

/** A graph wiring / contract violation detected before or between node activations. */
export class DataflowDefinitionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DataflowDefinitionError";
  }
}

/**
 * A hard error raised by a node body and re-raised by the runtime. `error` is the raw thrown
 * value, typed as the graph's `EH` parameter — node bodies are contracted to throw `EH`; the
 * runtime catches `unknown` and asserts that contract at this boundary.
 */
export class DataflowNodeError<EH> extends Error {
  readonly nodeId: NodeId;
  readonly error: EH;

  constructor(nodeId: NodeId, error: EH) {
    super(`Dataflow node "${nodeId}" failed`, { cause: error });
    this.name = "DataflowNodeError";
    this.nodeId = nodeId;
    this.error = error;
  }
}
