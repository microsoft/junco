import type {
  DataflowGraph,
  DataflowRunTrace,
  DataflowStepTrace,
  DataflowTracer,
  NodeIdType,
  NodeStatus,
  ParentView,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import type { Opik } from "opik";

/** Opik's error record, with the message always present. */
type ErrorInfo = { exceptionType: string; message: string; traceback: string };

/** Characters Mermaid would read as markup, entities, comments/directives, math or label ends. */
const MERMAID_SPECIAL = /[&#%$"<>\\`|\r\n]/g;

/** Encode `value` for a quoted Mermaid label using decimal entity codes (`#34;` for `"`, …). */
function escapeMermaidLabel(value: string): string {
  return value.replace(
    MERMAID_SPECIAL,
    (character) => `#${character.codePointAt(0)};`,
  );
}

/** Normalize any thrown value into an Opik error record. */
function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return {
      exceptionType: error.name,
      message: error.message,
      traceback: error.stack ?? "",
    };
  }
  let message: string;
  try {
    message = JSON.stringify(error) ?? String(error);
  } catch {
    try {
      message = String(error);
    } catch {
      message = "Unserializable thrown value";
    }
  }
  return { exceptionType: "NonError", message, traceback: "" };
}

/**
 * Snapshot `value` through one synchronous JSON round-trip, so later mutation by a node body cannot
 * change what was traced. A value JSON cannot encode yields an explicit capture error instead.
 */
function capturePayload(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn("[dataflow-engine-opik] Payload capture failed", error);
    return { captureError: toErrorInfo(error).message };
  }
}

/** Every registered node's current lifecycle status, in graph iteration order. */
function nodeStatuses<S, N, T, EH>(
  graph: DataflowGraph<S, N, T, EH>,
): { id: NodeIdType; status: NodeStatus }[] {
  const nodes: { id: NodeIdType; status: NodeStatus }[] = [];
  graph.forEachNode((id, node) => {
    nodes.push({ id, status: node.status });
  });
  return nodes;
}

/**
 * The graph's current topology as a Mermaid flowchart, or `undefined` for an empty graph. Nodes get
 * synthetic ids `n0, n1, …` with the real id as a quoted label; every link is drawn, since edge ids
 * are only unique per node-side.
 */
function mermaidOf<S, N, T, EH>(
  graph: DataflowGraph<S, N, T, EH>,
): string | undefined {
  const synthetic = new Map<NodeIdType, string>();
  const lines = ["graph TD;"];
  graph.forEachNode((id) => {
    const key = `n${synthetic.size}`;
    synthetic.set(id, key);
    lines.push(`${key}["${escapeMermaidLabel(id)}"];`);
  });
  if (synthetic.size === 0) return undefined;
  graph.forEachLink((from, to, edge) => {
    const transport = E.isLeft(edge.transport) ? "message" : "value";
    const label = escapeMermaidLabel(`${edge.id} (${transport})`);
    lines.push(
      `${synthetic.get(from)} -->|"${label}"| ${synthetic.get(to)};`,
    );
  });
  return lines.join("\n");
}

/** The delivered batch and resolved values of one activation; both empty for a prime. */
function activationInput<N, T>(
  inputs: ParentView<N, T> | undefined,
): Record<string, unknown> {
  const messages: { id: string; payloads: unknown }[] = [];
  const values: { id: string; value: unknown }[] = [];
  if (inputs !== undefined) {
    for (const id of inputs.messages.keys())
      messages.push({ id, payloads: inputs.messages.get(id) });
    for (const id of inputs.values.keys())
      values.push({ id, value: inputs.values.get(id) });
  }
  return { messages, values };
}

/**
 * A {@link DataflowTracer} exporting each `run()` as one Opik trace, carrying the graph's Mermaid
 * topology as Opik's native graph definition, with one direct child span per generator activation.
 *
 * The caller owns the `Opik` client's configuration and lifetime, and must `await flush()` before
 * exiting. A resolved flush is NOT proof of ingestion: the SDK logs transport failures.
 */
export class OpikDataflowTracer implements DataflowTracer {
  readonly #client: Opik;
  readonly #name: string;

  constructor(client: Opik, name: string = "DataflowGraph.run") {
    this.#client = client;
    this.#name = name;
  }

  startRun<S, N, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const metadata: Record<string, unknown> = { nodes: nodeStatuses(graph) };
    const mermaid = mermaidOf(graph);
    if (mermaid !== undefined)
      metadata._opik_graph_definition = { format: "mermaid", data: mermaid };
    const trace = this.#client.trace({ name: this.#name, metadata });
    void this.flush();

    const activations = new Map<NodeIdType, number>();
    return {
      startNode: (id, phase, inputs): DataflowStepTrace<N, T> => {
        const activation = (activations.get(id) ?? 0) + 1;
        activations.set(id, activation);
        const span = trace.span({
          name: `${id} #${activation}`,
          type: "general",
          input: capturePayload(activationInput(inputs)),
          metadata: { nodeId: id, activation, phase, nodeStatus: "running" },
        });
        void this.flush();
        return {
          end: (step) => {
            span.update(
              step.done === true
                ? {
                    endTime: new Date(),
                    output: capturePayload({ value: step.value }),
                    metadata: { outcome: "return", nodeStatus: "done" },
                  }
                : {
                    endTime: new Date(),
                    output: capturePayload({ messages: step.value }),
                    metadata: { outcome: "yield", nodeStatus: "running" },
                  },
            );
            void this.flush();
          },
          fail: (error) => {
            span.update({
              endTime: new Date(),
              errorInfo: toErrorInfo(error),
              metadata: { outcome: "error", nodeStatus: "done" },
            });
            void this.flush();
          },
        };
      },
      end: (results) => {
        trace.update({
          endTime: new Date(),
          output: capturePayload({
            results: Array.from(results, ([id, value]) => ({ id, value })),
          }),
          metadata: { nodes: nodeStatuses(graph) },
        });
        void this.flush();
      },
      fail: (error) => {
        trace.update({
          endTime: new Date(),
          errorInfo: toErrorInfo(error),
          metadata: { nodes: nodeStatuses(graph) },
        });
        void this.flush();
      },
    };
  }

  async flush(): Promise<void> {
    try {
      await this.#client.flush({ silent: true });
    } catch (error) {
      console.warn("[dataflow-engine-opik] Trace export failed", error);
    }
  }
}
