import { inspect } from "node:util";
import {
  type DataflowGraph,
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  type NodeIdType,
  renderPretty,
} from "dataflow-engine";
import { renderStdoutGraph } from "./stdout-graph.js";

/** Run numbers shared by every StdoutTracer, so interleaved runs stay distinguishable. */
let lastRun = 0;

/**
 * Render one record to a string NOW, so later mutation cannot change what was printed. Application
 * getters and custom inspection hooks are never invoked; continuation lines are indented.
 */
function format(record: unknown): string {
  try {
    return inspect(record, {
      colors: false,
      depth: null,
      maxArrayLength: null,
      maxStringLength: null,
      compact: true,
      breakLength: Number.POSITIVE_INFINITY,
      getters: false,
      customInspect: false,
    }).replaceAll("\n", "\n    ");
  } catch (error) {
    console.warn(
      "[junco-agency] StdoutTracer payload inspection failed",
      error,
    );
    return "[payload inspection failed]";
  }
}

/**
 * A {@link DataflowTracer} printing each `run()`/`step()` to stdout: the graph's topology as Unicode
 * box drawings, then one line per activation start and outcome with full payloads, then the run's
 * outcome. Every line is written as its event happens.
 */
export class StdoutTracer implements DataflowTracer {
  readonly #name: string;

  constructor(name: string = "DataflowGraph.run") {
    this.#name = name;
  }

  startRun<S, N, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const run = ++lastRun;
    let mermaid: string | undefined;
    let drawing: string;
    try {
      mermaid = renderPretty(graph);
      drawing = renderStdoutGraph(mermaid);
    } catch (error) {
      console.warn("[junco-agency] StdoutTracer graph rendering failed", error);
      drawing =
        mermaid === undefined
          ? "(graph rendering failed)"
          : `(graph rendering failed)\n${format(mermaid)}`;
    }
    console.log(`[run ${run}] ${this.#name}\n${drawing}\n\nTrace:`);

    const activations = new Map<string, number>();
    return {
      startNode: (id, phase, inputs): DataflowStepTrace<N, T> => {
        const activation = (activations.get(id) ?? 0) + 1;
        activations.set(id, activation);
        const prefix = `[run ${run}] node=${JSON.stringify(id)} #${activation}`;
        const messages: { id: string; payloads: unknown }[] = [];
        const values: { id: string; value: unknown }[] = [];
        if (inputs !== undefined) {
          for (const edge of inputs.messages.keys())
            messages.push({ id: edge, payloads: inputs.messages.get(edge) });
          for (const edge of inputs.values.keys())
            values.push({ id: edge, value: inputs.values.get(edge) });
        }
        console.log(
          `${prefix} ${phase} inputs=${format({ messages, values })}`,
        );
        return {
          end: (step) => {
            console.log(
              step.done === true
                ? `${prefix} return ${format({ value: step.value })}`
                : `${prefix} yield ${format({ messages: step.value })}`,
            );
          },
          fail: (error) => {
            console.log(`${prefix} error ${format(error)}`);
          },
        };
      },
      end: (results) => {
        const output = {
          results: Array.from(results, ([id, value]) => ({ id, value })),
        };
        console.log(`[run ${run}] end ${format(output)}`);
      },
      fail: (error) => {
        console.log(`[run ${run}] fail ${format(error)}`);
      },
    };
  }

  /** Print one complaint line for `nodeId`, independent of any run. */
  complain(nodeId: NodeIdType, complaint: string): void {
    console.log(
      `[complaint] node=${JSON.stringify(nodeId)} ${format({ complaint })}`,
    );
  }

  /** Resolve once everything already written to stdout has been handed to the stream. */
  async flush(): Promise<void> {
    const stdout = process.stdout;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // Consumes the stream's own `error` event for this barrier's failed write.
    const onError = (error: Error): void => reject(error);
    stdout.once("error", onError);
    try {
      stdout.write("", (error) => {
        if (error == null) {
          stdout.off("error", onError);
          resolve();
        } else {
          reject(error);
        }
      });
    } catch (error) {
      stdout.off("error", onError);
      reject(error);
    }
    await promise;
  }
}
