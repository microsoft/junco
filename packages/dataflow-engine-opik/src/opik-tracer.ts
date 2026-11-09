import type { Events, HarnessEvent } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type {
  DataflowGraph,
  DataflowRunTrace,
  DataflowStepTrace,
  DataflowTracer,
  NodeIdType,
  NodeStatus,
  ParentView,
} from "dataflow-engine";
import { renderPretty } from "dataflow-engine";
import { generateId, isTracingActive, type Opik } from "opik";

/** Opik's error record, with the message always present. */
type ErrorInfo = { exceptionType: string; message: string; traceback: string };

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
function nodeStatuses<S, N extends TSchema, T, EH>(
  graph: DataflowGraph<S, N, T, EH>,
): { id: NodeIdType; status: NodeStatus }[] {
  const nodes: { id: NodeIdType; status: NodeStatus }[] = [];
  graph.forEachNode((id, node) => {
    nodes.push({ id, status: node.status });
  });
  return nodes;
}

/** The delivered batch and resolved values of one activation; both empty for a prime. */
function activationInput<N extends TSchema, T>(
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
 * topology as Opik's native graph definition, with one direct child span per generator activation
 * and agent model turns exported as `llm` children through `observeAgent`.
 *
 * Requests bypass the SDK's timer-driven batch queues: each goes straight to the REST client in one
 * FIFO chain, so every create precedes its update and nothing stays buffered or armed on a timer.
 * Each completion returns its position in the chain, which `evaluate()` joins. A failed request is
 * warned and skipped, never retried or rethrown, so a settled run proves attempted delivery, not
 * ingestion. The caller owns the `Opik` client's configuration and lifetime; `OPIK_TRACK_DISABLE`
 * (the SDK's `isTracingActive`) suppresses every request, as the SDK's own tracer would.
 */
export class OpikTracer implements DataflowTracer {
  readonly #client: Opik;
  readonly #name: string;
  /** Every request so far, in order; each link settles after warning on failure, so the chain never breaks. */
  #chain: Promise<void> = Promise.resolve();
  /** The run being exported, for agent spans created outside `startRun`'s closure. */
  #run: { traceId: string; projectName: string | undefined; environment: Record<string, string>; requestOptions: Opik["api"]["requestOptions"] } | undefined;
  /** Open activation span per node id: the parent of that node's `llm` spans. */
  readonly #activations = new Map<string, string>();

  constructor(client: Opik, name: string = "DataflowGraph.run") {
    this.#client = client;
    this.#name = name;
  }

  /** Append `request` after every earlier one; resolves once it settled, warning instead of rejecting. */
  #send(label: string, request: () => Promise<unknown>): Promise<void> {
    if (!isTracingActive()) return Promise.resolve();
    this.#chain = this.#chain.then(request).then(
      () => undefined,
      (error) => {
        console.warn(`[dataflow-engine-opik] ${label} failed`, error);
      },
    );
    return this.#chain;
  }

  startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const { api, config } = this.#client;
    const requestOptions = { ...api.requestOptions, maxRetries: 0 };
    const { projectName } = config;
    const environment: Record<string, string> =
      config.environment === undefined ? {} : { environment: config.environment };
    const traceId = generateId();
    const startTime = new Date();
    const metadata: Record<string, unknown> = { nodes: nodeStatuses(graph) };
    const mermaid = renderPretty(graph);
    if (mermaid !== "")
      metadata._opik_graph_definition = { format: "mermaid", data: mermaid };
    this.#run = { traceId, projectName, environment, requestOptions };
    this.#send(`trace ${traceId} create`, () =>
      api.traces.createTraces(
        {
          traces: [
            {
              id: traceId,
              name: this.#name,
              startTime,
              projectName,
              source: "sdk",
              metadata,
              input: capturePayload({ nodes: metadata.nodes }),
              ...environment,
            },
          ],
        },
        requestOptions,
      ),
    );
    const updateTrace = (body: {
      endTime: Date;
      output?: Record<string, unknown>;
      errorInfo?: ErrorInfo;
      metadata: Record<string, unknown>;
    }) =>
      this.#send(`trace ${traceId} update`, () =>
        api.traces.updateTrace(
          traceId,
          { body: { projectName, ...body } },
          requestOptions,
        ),
      );

    const activations = new Map<NodeIdType, number>();
    return {
      startNode: (id, phase, inputs): DataflowStepTrace<N, T> => {
        const activation = (activations.get(id) ?? 0) + 1;
        activations.set(id, activation);
        const spanId = generateId();
        this.#activations.set(String(id), spanId);
        const startTime = new Date();
        const input = capturePayload(activationInput(inputs));
        this.#send(`span ${spanId} create`, () =>
          api.spans.createSpans(
            {
              spans: [
                {
                  id: spanId,
                  traceId,
                  name: `${id} #${activation}`,
                  type: "general",
                  startTime,
                  projectName,
                  source: "sdk",
                  input,
                  metadata: { nodeId: id, activation, phase, nodeStatus: "running" },
                  ...environment,
                },
              ],
            },
            requestOptions,
          ),
        );
        const updateSpan = (body: {
          endTime: Date;
          output?: Record<string, unknown>;
          errorInfo?: ErrorInfo;
          metadata: Record<string, unknown>;
        }) =>
          this.#send(`span ${spanId} update`, () =>
            api.spans.updateSpan(
              spanId,
              { body: { traceId, projectName, ...body } },
              requestOptions,
            ),
          );
        return {
          end: (step) => {
            this.#activations.delete(String(id));
            return updateSpan(
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
          },
          fail: (error) => {
            this.#activations.delete(String(id));
            return updateSpan({
              endTime: new Date(),
              errorInfo: toErrorInfo(error),
              metadata: { outcome: "error", nodeStatus: "done" },
            });
          },
        };
      },
      end: (results) => {
        const done = updateTrace({
          endTime: new Date(),
          output: capturePayload({
            results: Array.from(results, ([id, value]) => ({ id, value })),
          }),
          metadata: { nodes: nodeStatuses(graph) },
        });
        this.#run = undefined;
        return done;
      },
      fail: (error) => {
        const done = updateTrace({
          endTime: new Date(),
          errorInfo: toErrorInfo(error),
          metadata: { nodes: nodeStatuses(graph) },
        });
        this.#run = undefined;
        return done;
      },
    };
  }

  /**
   * One `llm` child span per model turn under the node's open activation span, with Pi's model,
   * provider, OpenAI-shaped usage and USD cost. Input is user messages since the previous turn
   * and its tool results; output is assistant content and stop reason. No active run → ignored.
   */
  observeAgent(node: { readonly id: NodeIdType }, events: Events): () => void {
    const api = this.#client.api;
    const subscriptions: (() => void)[] = [];
    const on = <E extends HarnessEvent["type"]>(
      type: E,
      listener: (event: Extract<HarnessEvent, { type: E }>) => void,
    ) => subscriptions.push(events.on(type, (event) => listener(event)));
    const starts = new Map<string, Date>();
    const pending = new Map<string, unknown[]>();
    const carried = new Map<string, unknown[]>();
    let turn = 0;
    on("message_start", ({ lane, message }) => {
      if (message.role === "assistant") starts.set(lane, new Date());
    });
    on("message_end", ({ lane, message }) => {
      if (message.role === "user")
        (pending.get(lane) ?? pending.set(lane, []).get(lane)!).push(message);
    });
    on("turn_end", ({ lane, runId, turnId, message, toolResults }) => {
      const run = this.#run;
      if (run === undefined) return;
      const u = message.usage;
      const input = [...(carried.get(lane) ?? []), ...(pending.get(lane) ?? [])];
      pending.delete(lane);
      carried.set(lane, toolResults);
      const startTime = starts.get(lane) ?? new Date();
      starts.delete(lane);
      const spanId = generateId();
      const parent = this.#activations.get(String(node.id));
      const span = {
        id: spanId, traceId: run.traceId,
        ...(parent === undefined ? {} : { parentSpanId: parent }),
        name: `${node.id} llm #${++turn}`, type: "llm" as const,
        startTime, endTime: new Date(), projectName: run.projectName, source: "sdk" as const,
        model: message.model, provider: message.provider,
        input: capturePayload({ messages: input }),
        output: capturePayload({ content: message.content, stopReason: message.stopReason }),
        usage: {
          prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
          completion_tokens: u.output, total_tokens: u.totalTokens,
          cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite,
          ...(u.reasoning === undefined ? {} : { reasoning_tokens: u.reasoning }),
        },
        totalEstimatedCost: u.cost.total,
        metadata: {
          nodeId: String(node.id), lane, runId, turnId,
          ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
          ...(message.thinkingLevel === undefined ? {} : { thinkingLevel: message.thinkingLevel }),
        },
        ...(message.stopReason === "error" ? { errorInfo: {
          exceptionType: "ModelError", message: message.errorMessage ?? "model error", traceback: "",
        } } : {}),
        ...run.environment,
      };
      this.#send(`span ${spanId} create`, () =>
        api.spans.createSpans({ spans: [span] }, run.requestOptions));
    });
    return () => {
      for (const unsubscribe of subscriptions.splice(0).reverse()) unsubscribe();
    };
  }
}
