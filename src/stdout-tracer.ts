import { inspect } from "node:util";
import {
  type DataflowGraph,
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  type NodeIdType,
  renderPretty,
} from "dataflow-engine";
import { flushLog, log } from "junco-tools/log";
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
    log.warn("[junco-agency] StdoutTracer payload inspection failed", error);
    return "[payload inspection failed]";
  }
}

/**
 * A {@link DataflowTracer} printing each `run()`/`step()` at INFO through the shared stdout
 * logger: the graph's topology as Unicode box drawings, then one line per activation start and
 * outcome with full payloads, then the run's outcome. Every line is written as its event happens.
 */
export class StdoutTracer implements DataflowTracer {
  static #shared: StdoutTracer | undefined;

  /**
   * The shared default tracer: one `StdoutTracer` named `JuncoGraph.run` per process, built on
   * first use. Pass any other {@link DataflowTracer} explicitly instead.
   */
  static shared(): StdoutTracer {
    StdoutTracer.#shared ??= new StdoutTracer("JuncoGraph.run");
    return StdoutTracer.#shared;
  }

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
      log.warn("[junco-agency] StdoutTracer graph rendering failed", error);
      drawing =
        mermaid === undefined
          ? "(graph rendering failed)"
          : `(graph rendering failed)\n${format(mermaid)}`;
    }
    log.info(`[run ${run}] ${this.#name}\n${drawing}\n\nTrace:`);

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
        log.info(`${prefix} ${phase} inputs=${format({ messages, values })}`);
        return {
          end: (step) => {
            log.info(
              step.done === true
                ? `${prefix} return ${format({ value: step.value })}`
                : `${prefix} yield ${format({ messages: step.value })}`,
            );
          },
          fail: (error) => {
            log.info(`${prefix} error ${format(error)}`);
          },
        };
      },
      end: (results) => {
        const output = {
          results: Array.from(results, ([id, value]) => ({ id, value })),
        };
        log.info(`[run ${run}] end ${format(output)}`);
      },
      fail: (error) => {
        log.info(`[run ${run}] fail ${format(error)}`);
      },
    };
  }

  /** Log one complaint line for `nodeId`, independent of any run. */
  complain(nodeId: NodeIdType, complaint: string): void {
    log.info(
      `[complaint] node=${JSON.stringify(nodeId)} ${format({ complaint })}`,
    );
  }

  /** Resolve once everything already written to stdout has been handed to the stream. */
  flush(): Promise<void> {
    return flushLog();
  }
}
