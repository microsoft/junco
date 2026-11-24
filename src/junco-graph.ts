import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  type DataflowExecution,
  DataflowGraph,
  type DataflowObservation,
  type DataflowRunOptions,
  type DataflowRunTrace,
  type DataflowTracer,
  Edge,
  type EdgeIdType,
  FinalMessages,
  type NodeGenerator,
  NodeId,
  type NodeIdType,
  type NodeSpec,
  type ParentView,
  Sink,
  Source,
  type StepFn,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent, JuncoAgentError, type TaskSchema } from "junco-agent";
import { parallel, type SchedulerContext } from "junco-scheduler";
import {
  beginOperation,
  issueLog,
  type ProfileActivation,
  type ProfileRecorder,
  SendTool,
  ToolCollection,
  type ToolCollectionOptions,
} from "junco-tools";
import type { Graph } from "ngraph.graph";
import type { TSchema } from "typebox";
import { AgentDriver, withoutProvenance } from "./agent-node.js";
import { cancellation, settleAll } from "./agent-operations.js";
import type {
  Agentic,
  AgenticNode,
  AnyJuncoAgent,
  AnyMockAgent,
  CompactionPolicy,
} from "./agentic.js";
import { Deterministic } from "./deterministic.js";
import { MockAgent } from "./mock-agent.js";
import {
  type AgencyNodeMetadata,
  checkPolicy,
  context,
  type NodeRegistration,
  nodePolicies,
  registeredNodeContexts,
  rethrowControllerFailure,
  unseenValues,
} from "./node-policy.js";
import { buildYaml, type FromYamlOptions } from "./syntax/build.js";
import { TuiTracer } from "./tui-tracer.js";

type NestedContext<N extends TSchema, T> = SchedulerContext<
  Agentic<N, T>,
  N,
  T,
  never,
  JuncoGraph<N, T>
>;
type NestedNode<N extends TSchema, T> = Extract<
  AgenticNode<N, T>,
  { readonly state: NestedContext<N, T>; readonly step?: never }
>;

export function isNestedContext<N extends TSchema, T>(
  value: unknown,
): value is NestedContext<N, T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "graph" in value &&
    value.graph instanceof JuncoGraph &&
    "scheduler" in value &&
    typeof value.scheduler === "function" &&
    "step" in value &&
    typeof value.step === "function"
  );
}

/** Identity-only lifetime claims; no graph, policy or payload registry. */
const claimedPorts = new WeakSet<object>();

/** A complete spec as the native graph registers it, with this graph's policy. */
type CompleteNode<N extends TSchema, T> = NodeSpec<Agentic<N, T>, N, T> & {
  readonly policy: ToolCollection["policy"];
};

/** Resource operations can be awaited inside a drive without joining that drive's own gate. */
type Cascade = {
  readonly promise: Promise<void>;
  readonly joined: Promise<void>;
};

/** A prompt agent or coroutine a cascade operates on directly. */
type Resource = AnyJuncoAgent | AnyMockAgent | Deterministic<TSchema, unknown>;

/** Any graph a cascade reaches; it reads only domain-free lifecycle fields, never payloads. */
// biome-ignore lint/suspicious/noExplicitAny: graphs are invariant in their domains; lifecycle storage only.
type AnyGraph = JuncoGraph<any, any, any>;

type Kind = "abort" | "close";

const closedGraph = (): JuncoAgentError =>
  new JuncoAgentError("closed", "Graph is closed");

/** A member is full when its context holds strictly more than this fraction of its window. */
const FULLNESS_THRESHOLD = 0.4;

/** One hold on a collection, released once. */
type Hold = { close(): Promise<void> };

/** Thrown when one hierarchy mixes recorder sessions, or omits one where its parent records. */
const recorderMismatch = (): TypeError =>
  new TypeError("ProfileRecorder instance mismatch");

/** Rejects two recorders of different sessions; an absent one matches anything. */
export function checkRecorder(
  expected: { readonly root: object } | undefined,
  actual: { readonly root: object } | undefined,
): void {
  if (
    expected !== undefined &&
    actual !== undefined &&
    expected.root !== actual.root
  )
    throw recorderMismatch();
}

/** Isolates one observer callback exactly as the engine does. */
function observe<U>(callback: () => U): U | undefined {
  try {
    return callback();
  } catch (error) {
    console.warn("[dataflow-engine] DataflowTracer callback failed", error);
    return undefined;
  }
}

const EVALUATE = {
  resource: "operations",
  category: "graph",
  tool: "",
  operation: "evaluate",
} as const;

/**
 * A graph's tracer when it has a recorder: forwards every callback to the caller's tracer and,
 * isolated from it, records graph evaluation and node activations at the graph's current view.
 */
class RecorderBridge implements DataflowTracer {
  constructor(readonly delegate: DataflowTracer) {}

  startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const run = observe(() => this.delegate.startRun(graph));
    const view: ProfileRecorder<"operations"> | undefined =
      graph instanceof JuncoGraph ? graph.recorder : undefined;
    const finish = observe(() => beginOperation(view, EVALUATE));
    const runId = randomUUID();
    const outcome = (error: unknown) =>
      (graph instanceof JuncoGraph && graph.signal.aborted) ||
      (error instanceof Error && error.name === "AbortError")
        ? "cancelled"
        : "error";
    return {
      startNode: (id, phase, inputs) => {
        const step = observe(() => run?.startNode(id, phase, inputs));
        const activation = observe(() =>
          startActivation(graph, view, runId, id, phase, inputs),
        );
        return {
          end: (result) => {
            const pending = observe(() => step?.end(result));
            observe(() => activation?.(result));
            return pending;
          },
          fail: (error) => {
            const pending = observe(() => step?.fail(error));
            observe(() => activation?.(outcome(error)));
            return pending;
          },
        };
      },
      end: (results) => {
        const pending = observe(() => run?.end(results));
        observe(() => {
          view?.record({
            kind: "metrics",
            ...EVALUATE,
            gauges: { retained_results_last: results.size },
          });
          finish?.("success");
        });
        return pending;
      },
      fail: (error) => {
        const pending = observe(() => run?.fail(error));
        observe(() => finish?.(outcome(error)));
        return pending;
      },
    };
  }
}

/**
 * Records one activation's start at node `id` of `graphView` and returns its completion: a step
 * result succeeds, an outcome fails.
 */
function startActivation<S, N extends TSchema, T, EH>(
  graph: DataflowGraph<S, N, T, EH>,
  graphView: ProfileRecorder<"operations"> | undefined,
  runId: string,
  id: NodeIdType,
  phase: "prime" | "resume",
  inputs: ParentView<N, T> | undefined,
):
  | ((
      end: IteratorResult<readonly unknown[], T | FinalMessages<N>> | "error" | "cancelled",
    ) => void)
  | undefined {
  const view = graphView?.add_context(String(id));
  if (view === undefined) return undefined;
  // The registered body's policy names its prompt agent, whatever the node's state.
  const node = graph.getNode(id);
  const candidate = node && nodePolicies.get(node.step)?.agent;
  const agent = candidate instanceof JuncoAgent ? candidate : undefined;
  const activation: ProfileActivation = {
    runId,
    firedAt: new Date().toISOString(),
    features:
      inputs === undefined
        ? {}
        : Object.fromEntries(
            [...inputs.messages.keys()].map((edge) => [
              String(edge),
              { count: inputs.messages.get(edge)?.length ?? 0 },
            ]),
          ),
    agent,
    owner: agent?.owner,
  };
  const operation = {
    resource: "operations",
    category: "graph",
    tool: "",
    operation: phase,
    activation,
  } as const;
  const finish = beginOperation(view, operation);
  if (inputs !== undefined) {
    let messages = 0;
    for (const edge of inputs.messages.keys())
      messages += inputs.messages.get(edge)?.length ?? 0;
    view.record({
      kind: "metrics",
      ...operation,
      counters: {
        input_messages: messages,
        input_values: [...inputs.values.keys()].length,
      },
    });
  }
  return (end) => {
    if (typeof end === "string") return finish?.(end);
    view.record({
      kind: "metrics",
      ...operation,
      counters: end.done
        ? end.value instanceof FinalMessages
          ? { activations_returned: 1, output_messages: end.value.messages.length }
          : { activations_returned: 1, output_values: 1 }
        : { activations_yielded: 1, output_messages: end.value.length },
    });
    finish?.("success");
  };
}

/** A passive native work graph owning its agents, child graphs and coroutines. */
export class JuncoGraph<
  N extends TSchema = typeof TaskSchema,
  T = AssistantMessage,
  EH = never,
> extends DataflowGraph<Agentic<N, T>, N, T, EH> {
  #controller = new AbortController();
  /** Default run options, replaced with the controller. */
  #options: DataflowRunOptions = { signal: this.#controller.signal };
  #abort: Cascade | undefined;
  /** Terminal once set, even if it failed. */
  #close: Cascade | undefined;
  #collection: ToolCollection | undefined;
  #lease: Hold | undefined;
  /** The creator hold this graph owns, when {@link create} built it. */
  #owned: Hold | undefined;
  #observation: DataflowObservation<Agentic<N, T>, N, T> | undefined;
  /** The caller's tracer; {@link tracer} is a recorder bridge around it when a recorder is set. */
  readonly #delegate: DataflowTracer;
  /** This graph's recorder when no drive placement is active. */
  readonly #recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
  /** The placement of the drive {@link runWithRecorder} brackets. */
  #placement:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;

  readonly source: Source<N, T>;
  readonly sink: Sink<N, T>;

  /** The execution observer, shared by native work and agency members. */
  declare readonly tracer: DataflowTracer;
  readonly policy: ToolCollection["policy"];

  constructor(
    source: Source<N, T>,
    sink: Sink<NoInfer<N>, NoInfer<T>>,
    window: Width,
    threads: Width,
    tracer: DataflowTracer | undefined,
    policy: ToolCollection["policy"],
    collection?: ToolCollection,
    recorder?: ProfileRecorder<
      "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
    >,
  ) {
    if (!(source instanceof Source) || !(sink instanceof Sink))
      throw new TypeError("JuncoGraph requires Source and Sink ports");
    if (typeof source.id !== "string" || typeof sink.id !== "string")
      throw new TypeError("Graph port IDs must be strings");
    if (source.id === sink.id)
      throw new DataflowDefinitionError(
        "Graph source and sink must have distinct IDs",
      );
    if (claimedPorts.has(source) || claimedPorts.has(sink))
      throw new TypeError("Graph ports are already owned by a JuncoGraph");
    checkPolicy(policy, collection);
    checkRecorder(recorder, collection?.recorder);
    const delegate =
      tracer instanceof RecorderBridge
        ? tracer.delegate
        : (tracer ?? TuiTracer.shared());
    super(
      window,
      threads,
      recorder === undefined ? delegate : new RecorderBridge(delegate),
    );
    this.#delegate = delegate;
    this.#recorder = recorder?.add_context("");
    this.policy = policy;
    this.source = source;
    this.sink = sink;
    this.addNode(source);
    this.addNode(sink);
    this.#collection = collection;
    this.#lease = collection?.lease();
    claimedPorts.add(source);
    claimedPorts.add(sink);
  }

  override observe(): DataflowObservation<Agentic<N, T>, N, T> {
    const base = super.observe();
    const version = base.version + this.source.revision;
    if (this.#observation?.version === version) return this.#observation;
    this.#observation = Object.freeze({ ...base, version });
    return this.#observation;
  }

  override addEdge(from: NodeIdType, to: NodeIdType, edge: Edge<N, T>): this {
    if (from === this.sink.id)
      throw new DataflowDefinitionError(
        "Graph sink cannot have outbound edges",
      );
    if (edge.onReturn) {
      const producer = this.getNode(from);
      if (producer && nodePolicies.get(producer.step)?.persistent === true)
        throw new DataflowDefinitionError(
          `Node "${from}" cannot produce return messages`,
        );
    }
    if (
      E.isRight(edge.transport) &&
      [from, to].some((id) => {
        const node = this.getNode(id);
        return (
          node !== undefined && nodePolicies.get(node.step)?.persistent === true
        );
      })
    )
      throw new DataflowDefinitionError(
        "Persistent graph nodes require message edges",
      );
    return super.addEdge(from, to, edge);
  }

  /**
   * Load a YAML workflow with its program inputs (`args`) and execution settings (`parameters`).
   * Supplied sessions transfer ownership at entry, including when parsing fails. Its schemas are
   * loaded at runtime, so its domains are `TSchema`/`unknown`; consumers narrow with `Value.Check`.
   */
  static async fromYaml<C = unknown>(
    source: string | object,
    config: FromYamlOptions<C>,
  ): Promise<
    SchedulerContext<
      Agentic<TSchema, unknown>,
      TSchema,
      unknown,
      AgencyNodeMetadata,
      JuncoGraph<TSchema, unknown>
    >
  > {
    return buildYaml(source, config);
  }

  /**
   * Build and return the caller's context, adopting its graph into one owned collection; the
   * collection and `build` receive `options.recorder`.
   */
  static async create<N extends TSchema, T, EH, C = AgencyNodeMetadata>(
    cwd: string,
    options: ToolCollectionOptions,
    build: (
      collection: ToolCollection,
      recorder:
        | ProfileRecorder<
            "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
          >
        | undefined,
    ) =>
      | SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>
      | Promise<SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>>,
  ): Promise<SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>> {
    const collection = await ToolCollection.create(cwd, options);
    const failures: unknown[] = [];
    let execution:
      | SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>
      | undefined;
    try {
      execution = await build(collection, options.recorder);
      execution.graph.#adopt(collection);
      return execution;
    } catch (error) {
      failures.push(error);
    }
    try {
      await execution?.graph.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await collection.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Graph construction failed");
  }

  /**
   * Map work in insertion order, preserving skeleton IDs and allocating fresh transports, each a
   * message edge of the source's schema.
   */
  static map<S, L, N extends TSchema = typeof TaskSchema, T = AssistantMessage>(
    skeleton: Pick<Graph<S, L>, "forEachNode" | "forEachLink" | "getLinks">,
    f: (state: S) => Deterministic<N, T> | AgenticNode<N, T>,
    options: {
      readonly source: Source<N, T>;
      readonly sink: Sink<N, T>;
      readonly policy: ToolCollection["policy"];
      readonly tracer?: DataflowTracer;
      readonly recorder?: ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >;
    },
  ): SchedulerContext<
    Agentic<N, T>,
    N,
    T,
    AgencyNodeMetadata,
    JuncoGraph<N, T>
  > {
    const graph = new JuncoGraph(
      options.source,
      options.sink,
      Width.create(1),
      UNBOUNDED,
      options.tracer,
      options.policy,
      undefined,
      options.recorder,
    );
    try {
      const edges = new Map<string, Edge<N, T>>();
      const wired: [from: string, to: string, edge: Edge<N, T>][] = [];
      skeleton.forEachLink((link) => {
        const edge = Edge.message<N, T>(link.id, options.source.schema);
        edges.set(link.id, edge);
        wired.push([String(link.fromId), String(link.toId), edge]);
      });
      skeleton.forEachNode((node) => {
        const inputs: TriggerEntry<N, T>[] = [];
        for (const link of skeleton.getLinks(node.id) ?? [])
          if (link.toId === node.id) {
            const edge = edges.get(link.id);
            if (edge === undefined)
              throw new TypeError(`Graph link "${link.id}" has no edge`);
            inputs.push(TriggerEntry.on(edge));
          }
        const mapped = f(node.data);
        if (mapped instanceof JuncoGraph)
          throw new TypeError("Nested graph node requires a SchedulerContext");
        if (mapped instanceof JuncoAgent || mapped instanceof MockAgent)
          throw new DataflowDefinitionError("Map a prompt agent with its state, prompt, policy and trigger");
        const spec = mapped instanceof Deterministic ? { state: mapped } : mapped;
        graph.addNode({
          trigger:
            inputs.length === 0
              ? TriggerRule.always<N, T>()
              : TriggerRule.anyOf(...inputs),
          ...spec,
          id: NodeId.create(String(node.id)),
        } as AgenticNode<N, T>);
      });
      for (const [from, to, edge] of wired)
        graph.addEdge(NodeId.create(from), NodeId.create(to), edge);
      return context({ scheduler: parallel(), graph });
    } catch (error) {
      claimedPorts.delete(options.source);
      claimedPorts.delete(options.sink);
      throw error;
    }
  }

  /**
   * Register a root and its paired task children; members remain caller-owned on failure. The
   * synthetic edges carry `messageSchema`, the source's schema by default.
   */
  static spawn<
    Input,
    N extends TSchema = typeof TaskSchema,
    T = AssistantMessage,
  >(
    source: Source<N, T>,
    sink: Sink<N, T>,
    root: AgenticNode<N, T>,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
    tracer: DataflowTracer = TuiTracer.shared(),
    recorder?: ProfileRecorder<
      "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
    >,
    messageSchema: N = source.schema,
  ): SchedulerContext<
    Agentic<N, T>,
    N,
    T,
    AgencyNodeMetadata,
    JuncoGraph<N, T>
  > {
    const graph = new JuncoGraph(
      source,
      sink,
      Width.create(1),
      UNBOUNDED,
      tracer,
      JuncoGraph.#nodePolicy(root),
      undefined,
      recorder,
    );
    try {
      graph.appendChildren(graph.addNode(root), inputs, child, messageSchema);
      return context({ scheduler: parallel(), graph });
    } catch (error) {
      claimedPorts.delete(source);
      claimedPorts.delete(sink);
      throw error;
    }
  }

  /** Resolve managed-state authorization without binding a policy to any graph. */
  static #nodePolicy<N extends TSchema, T>(
    spec: AgenticNode<N, T> | CompleteNode<N, T>,
    graphPolicy?: ToolCollection["policy"],
  ): ToolCollection["policy"] {
    const state = spec.state;
    const nested = isNestedContext<N, T>(state) ? state : undefined;
    if (
      "persistent" in spec &&
      (spec.persistent !== true ||
        nested === undefined ||
        spec.step !== undefined)
    )
      throw new TypeError(
        "persistent is supported only as true on nested graph nodes",
      );
    if (state instanceof JuncoGraph || nested !== undefined) {
      if (
        Object.hasOwn(spec, "result") ||
        Object.hasOwn(spec, "receive") ||
        Object.hasOwn(spec, "afterStep")
      )
        throw new TypeError(
          "Nested graph nodes use source and sink, not result, receive or afterStep",
        );
      if (spec.step === undefined && nested === undefined)
        throw new TypeError("Nested graph node requires a SchedulerContext");
      if (nested !== undefined && spec.step !== undefined)
        throw new TypeError("Nested graph nodes must not supply a step");
    }
    const child = nested?.graph;
    const managed = state instanceof Deterministic ? state : child;
    let policy = spec.policy;
    if (
      (state instanceof Source || state instanceof Sink) &&
      spec.step === state.step &&
      graphPolicy !== undefined
    ) {
      if (policy !== undefined && policy !== graphPolicy)
        throw new TypeError("Builtin port policy does not match its graph");
      policy = graphPolicy;
    }
    if (spec.step === undefined && managed !== undefined) {
      if (Object.hasOwn(spec, "policy"))
        throw new TypeError("Node policy is owned by its state");
      policy = managed.policy;
    }
    checkPolicy(
      policy,
      state instanceof JuncoAgent ? state.collection : undefined,
    );
    if (
      (state instanceof Deterministic || state instanceof JuncoGraph) &&
      state.policy !== policy
    )
      throw new TypeError("Node policy does not match its state");
    return policy;
  }

  /**
   * Request compaction of the direct prompt-agent node states of `graph` that `policy` selects.
   * Selection is a snapshot taken when called; each selected agent gets one queued `compact()`
   * request, all dispatched without waiting for one another. An agent with an admitted run compacts
   * only after that run ends, so keep driving its context while awaiting compaction. It never runs
   * the graph, consumes messages or results, or descends into child graphs; nested graphs, ports
   * and deterministic coroutines are skipped. `graph` may be any native graph of Agentic states.
   *
   * @throws {JuncoAgentError} `invalid_argument` for an unknown policy; `invalid_state` when a
   *   fullness policy cannot measure a candidate's context window.
   */
  static async compact<A extends Agentic<N, T>, N extends TSchema, T, EH>(
    graph: DataflowGraph<A, N, T, EH>,
    policy: CompactionPolicy,
  ): Promise<void> {
    let availableOnly: boolean;
    let fullOnly: boolean;
    switch (policy) {
      case "all":
        [availableOnly, fullOnly] = [false, false];
        break;
      case "more-than-forty":
        [availableOnly, fullOnly] = [false, true];
        break;
      case "all-available":
        [availableOnly, fullOnly] = [true, false];
        break;
      case "more-than-forty-available":
        [availableOnly, fullOnly] = [true, true];
        break;
      default:
        policy satisfies never;
        throw new JuncoAgentError(
          "invalid_argument",
          "Unknown compaction policy",
        );
    }
    // Snapshot before the first await: later readiness or topology changes do not alter selection.
    const available = availableOnly ? graph.available() : undefined;
    const candidates: {
      readonly id: NodeIdType;
      readonly agent: JuncoAgent | MockAgent;
    }[] = [];
    graph.forEachNode((id, node) => {
      const state: unknown = node.state;
      if (!(state instanceof JuncoAgent || state instanceof MockAgent)) return;
      if (available === undefined || available.has(id))
        candidates.push({ id, agent: state });
    });
    let selected = candidates;
    if (fullOnly) {
      // Every decision precedes the first request, so an unmeasurable member changes nothing.
      const full = await Promise.all(
        candidates.map(async ({ id, agent }) => {
          const [tokens, model] = await Promise.all([
            agent.context_size(),
            agent.getModel(),
          ]);
          const capacity = model?.contextWindow;
          if (
            capacity === undefined ||
            !Number.isFinite(capacity) ||
            capacity <= 0
          ) {
            throw new JuncoAgentError(
              "invalid_state",
              `Cannot determine context fullness for node "${id}"`,
            );
          }
          return tokens > FULLNESS_THRESHOLD * capacity;
        }),
      );
      selected = candidates.filter((_, index) => full[index]);
    }
    // Requests start one microtask after selection.
    await undefined;
    await settleAll(
      selected,
      ({ agent }) => agent.compact(),
      "Graph compaction failed",
    );
  }

  /** The borrowed collection this graph holds a lease on, if any. */
  get collection(): ToolCollection | undefined {
    return this.#collection;
  }

  /** The current drive's placement, else this graph's own recorder context. */
  get recorder():
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined {
    return this.#placement ?? this.#recorder;
  }

  /**
   * Run `work` with this graph placed at `recorder`, a view of its own recorder session: a parent
   * drives a reused or prebuilt child at the child's actual position.
   */
  async runWithRecorder<T>(
    recorder: ProfileRecorder<
      "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
    >,
    work: () => T | Promise<T>,
  ): Promise<T> {
    if (this.#recorder === undefined || this.#recorder.root !== recorder.root)
      throw recorderMismatch();
    if (this.#placement !== undefined)
      throw new JuncoAgentError(
        "invalid_state",
        "Graph recorder placement is already active",
      );
    this.#placement = recorder;
    try {
      return await work();
    } finally {
      this.#placement = undefined;
    }
  }

  /** Aborted by {@link abort} (then replaced once that settles) and, terminally, by {@link close}. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The process-wide complaint history every agent and graph shares. */
  get issueLog(): typeof issueLog {
    return issueLog;
  }

  /** Register native work, preserving its actual state and this registration's sender identity. */
  override addNode(spec: Extract<AgenticNode<N, T>, { readonly prompt: unknown }>): NodeIdType;
  override addNode(spec: AgenticNode<N, T>): NodeIdType;
  // The complete-spec branch alone keeps this override compatible with the native signature.
  override addNode(spec: CompleteNode<N, T>): NodeIdType;
  override addNode(spec: AgenticNode<N, T>): NodeIdType {
    if ("is_available" in spec)
      throw new DataflowDefinitionError("is_available was removed; declare a trigger instead");
    const state = spec.state;
    const nested = isNestedContext<N, T>(state);
    const policy = JuncoGraph.#nodePolicy(spec, this.policy);
    if (this.#recorder !== undefined) {
      const child = nested
        ? state.graph
        : state instanceof JuncoGraph
          ? state
          : undefined;
      const member =
        child === undefined
          ? state instanceof JuncoAgent
            ? state.recorder
            : this.#recorder
          : child.#recorder;
      if (member === undefined) throw recorderMismatch();
      checkRecorder(this.#recorder, member);
    }
    let complete: CompleteNode<N, T>;
    let repeatOnReturn = false;
    if (spec.step !== undefined) complete = { ...spec, policy };
    else if (state instanceof Deterministic)
      complete = { ...spec, policy, state, step: state.step };
    else if (nested)
      complete = this.#graphNode(spec as NestedNode<N, T>, policy);
    else if (state instanceof JuncoAgent || state instanceof MockAgent) {
      if (!("prompt" in spec))
        throw new DataflowDefinitionError("A graph-managed agent requires a prompt");
      complete = AgentDriver.node<N, T>(state, { ...spec, policy });
      repeatOnReturn = true;
    } else throw new TypeError("An agentic node requires a step");
    const id = this.registerNode(complete, repeatOnReturn);
    const graph = this;
    const registration: NodeRegistration<N> = {
      tracer: this.#delegate,
      get recorder() {
        return graph.recorder?.add_context(id);
      },
      get signal() {
        return graph.signal;
      },
      get sendParameters() {
        return graph.#sendParameters(id);
      },
      send: (message) => {
        this.signal.throwIfAborted();
        this.emit(id, message);
      },
      info: () => this.#nodeInfo(id),
    };
    const node = this.getNode(id);
    if (node === undefined)
      throw new JuncoAgentError("invalid_state", `Node "${id}" not registered`);
    registeredNodeContexts.set(node, registration);
    return id;
  }

  /**
   * Register one child per element of `inputs` under the already registered `rootId`, each with
   * two fresh message edges of `messageSchema` (the source's by default): `${rootId}->${childId}`
   * from the root and `${childId}->${rootId}` back to it; children are never linked to each other.
   * Errors propagate synchronously; children registered before the failure stay in this graph.
   */
  appendChildren<Input>(
    rootId: NodeIdType,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
    messageSchema: N = this.source.schema,
  ): void {
    for (const input of inputs) {
      const childId = this.addNode(child(input));
      this.addEdge(
        rootId,
        childId,
        Edge.message<N, T>(`${rootId}->${childId}`, messageSchema),
      ).addEdge(
        childId,
        rootId,
        Edge.message<N, T>(`${childId}->${rootId}`, messageSchema),
      );
    }
  }

  /** Node `id`'s send schema over outbound message links, computed live to include late edges; task provenance is the node's to attach. */
  #sendParameters(id: NodeIdType): NodeRegistration<N>["sendParameters"] {
    const routes: (readonly [EdgeIdType, TSchema])[] = [];
    this.forEachLink((from, _to, edge) => {
      if (from === id && E.isLeft(edge.transport) && !edge.onReturn)
        routes.push([edge.id, withoutProvenance(edge.schema)]);
    });
    return SendTool.parametersFor(routes);
  }

  /** Prime without input consumption; each resume admits input and advances one child decision. */
  #graphNode(
    spec: NestedNode<N, T>,
    policy: ToolCollection["policy"],
  ): CompleteNode<N, T> {
    const { state: execution, persistent, ...options } = spec;
    const graph = execution.graph;
    const parent = this;
    const seenValues = new Map<EdgeIdType, unknown>();
    const step: StepFn<Agentic<N, T>, N, T> = async function* (): NodeGenerator<
      N,
      T
    > {
      let view = yield [];
      while (true) {
        const signal = graph.signal;
        signal.throwIfAborted();
        graph.source.enqueue({
          messages: view.messages,
          values: unseenValues(view.values, seenValues),
        });
        signal.throwIfAborted();
        if (graph.available().size > 0) {
          try {
            const placement = parent.recorder?.add_context(String(this.id));
            const drive = () => execution.step({ signal });
            await (placement === undefined
              ? drive()
              : graph.runWithRecorder(placement, drive));
          } catch (error) {
            rethrowControllerFailure(graph, parent);
            throw cancellation(signal, error);
          }
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
        graph.sink.drain((message) => parent.emit(this.id, message));
        signal.throwIfAborted();
        const pending = graph.available().size > 0;
        if (persistent !== true && !pending) {
          const retained = graph.result(graph.sink.id);
          if (O.isSome(retained)) return retained.value;
          throw new JuncoAgentError(
            "invalid_state",
            "Nested graph quiesced without a sink result",
          );
        }
        view = yield pending ? { resume: [] } : [];
      }
    };
    if (persistent) nodePolicies.set(step, { persistent });
    return { ...options, policy, state: graph, step };
  }

  /** Node `id`'s parent and child routes, one entry per actual edge. */
  #nodeInfo(id: NodeIdType): ReturnType<NodeRegistration["info"]> {
    this.signal.throwIfAborted();
    const parents: ReturnType<NodeRegistration["info"]>["parents"][number][] =
      [];
    const children: typeof parents = [];
    // ponytail: info scans graph links; add an adjacency index only if large graphs make this hot.
    this.forEachLink((from, to, edge) => {
      if (from !== id && to !== id) return;
      const kind = E.isLeft(edge.transport) ? "message" : "value";
      if (to === id) parents.push({ id: from, edgeId: edge.id, kind });
      if (from === id) children.push({ id: to, edgeId: edge.id, kind });
    });
    this.signal.throwIfAborted();
    return { parents, children };
  }

  /**
   * Validate {@link create}'s returned graph against `collection`, then bind it and take the
   * creator hold.
   */
  #adopt(collection: ToolCollection): void {
    if (this.#close !== undefined) throw closedGraph();
    if (this.policy !== collection.policy)
      throw new TypeError(
        "Collection policy does not match the selected policy",
      );
    checkRecorder(this.#recorder, collection.recorder);
    const seen = new Set<object>();
    const stack: unknown[] = [this];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member instanceof JuncoGraph) {
        if (seen.has(member)) continue;
        seen.add(member);
        member.forEachNode((_, node) => stack.push(node.state));
      }
      if (
        member instanceof JuncoAgent
          ? member.collection !== collection
          : (member instanceof JuncoGraph || member instanceof Deterministic) &&
            member.collection !== undefined &&
            member.collection !== collection
      )
        throw new TypeError("Graph member does not use the graph's collection");
    }
    if (this.#collection === undefined) {
      this.#lease = collection.lease();
      this.#collection = collection;
    }
    this.#owned = collection;
  }

  /** Keep caller cancellation attached through native planning and outstanding-work draining. */
  override async evaluate<R>(
    operation: (
      execute: DataflowExecution<N, T>,
      signal?: AbortSignal,
    ) => R | Promise<R>,
    options?: DataflowRunOptions,
  ): Promise<R> {
    if (this.#close !== undefined) {
      this.signal.throwIfAborted();
      throw closedGraph();
    }
    const caller = options?.signal;
    const runOptions = this.#runOptions(options);
    const signal = runOptions.signal;
    let aborting: Promise<unknown> | undefined;
    let abortFailed = false;
    const interrupt = () => {
      if (this.#abort !== undefined || this.#close !== undefined) return;
      // joined also waits on the active native gate; cancellation must await only resources here.
      aborting = this.#cascade("abort", caller?.reason).promise.catch(
        (error: unknown) => {
          abortFailed = true;
          return error;
        },
      );
    };
    try {
      const result = await super.evaluate((execute, signal) => {
        caller?.throwIfAborted();
        rethrowControllerFailure(this);
        if (caller !== undefined && caller !== this.signal)
          caller.addEventListener("abort", interrupt, { once: true });
        return operation(execute, signal);
      }, runOptions);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      caller?.removeEventListener("abort", interrupt);
      const abortError = await aborting;
      const failure =
        signal === undefined ? error : cancellation(signal, error);
      if (abortFailed)
        throw new AggregateError(
          [failure, abortError],
          "Graph evaluation and abort failed",
        );
      rethrowControllerFailure(this);
      throw failure;
    } finally {
      caller?.removeEventListener("abort", interrupt);
    }
  }

  /** Abort resources and join active planning/work before replacing the graph signals. */
  abort(
    reason: unknown = new DOMException("Graph aborted", "AbortError"),
  ): Promise<void> {
    if (this.#close !== undefined) return Promise.reject(closedGraph());
    return (this.#abort ?? this.#cascade("abort", reason)).joined;
  }

  /** Close resources, join active evaluations, then release owned and borrowed collection holds. */
  close(): Promise<void> {
    return (this.#close ?? this.#cascade("close", undefined)).joined;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #runOptions(options: DataflowRunOptions | undefined): DataflowRunOptions {
    const own = this.#controller.signal;
    const caller = options?.signal;
    if (caller === undefined || caller === own) return this.#options;
    return { signal: AbortSignal.any([own, caller]) };
  }

  #replaceController(reason?: unknown): void {
    const controller = new AbortController();
    if (reason !== undefined) controller.abort(reason);
    this.#controller = controller;
    this.#options = { signal: controller.signal };
  }

  /** Iterative native-state traversal keeps shared and cyclic graph ownership stack-safe. */
  #cascade(kind: Kind, reason: unknown): Cascade {
    const graphs: AnyGraph[] = [];
    const requests: (() => unknown)[] = [];
    const gates = new Set<Promise<void>>();
    const seenGraphs = new Set<object>();
    const resources = new Set<Resource>();
    const joined = new Set<Promise<void>>();
    const stack: AnyGraph[] = [this];
    for (let graph = stack.pop(); graph !== undefined; graph = stack.pop()) {
      if (seenGraphs.has(graph)) continue;
      seenGraphs.add(graph);
      if (graph !== this) {
        if (kind === "abort" && graph.#close !== undefined) continue;
        const current = kind === "abort" ? graph.#abort : graph.#close;
        if (current !== undefined) {
          if (!joined.has(current.joined)) {
            joined.add(current.joined);
            requests.push(() => current.joined);
          }
          continue;
        }
      }
      graphs.push(graph);
      const active = graph.activeEvaluation;
      if (active !== undefined) gates.add(active);
      const children: AnyGraph[] = [];
      graph.forEachNode((_, node) => {
        const state = node.state;
        if (state instanceof JuncoGraph) children.push(state);
        else if (
          state instanceof JuncoAgent ||
          state instanceof MockAgent ||
          state instanceof Deterministic
        )
          resources.add(state);
      });
      for (let index = children.length - 1; index >= 0; index--)
        stack.push(children[index]);
    }
    for (const member of resources) {
      if (kind === "close")
        requests.push(() => member[Symbol.asyncDispose]());
      else if (member instanceof Deterministic)
        requests.push(() => member.abort(reason));
      else if (member.status !== "closed") requests.push(() => member.abort());
    }

    const operations = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    const cascade: Cascade = {
      promise: operations.promise,
      joined: completion.promise,
    };
    // Internal cancellation awaits promise; keep joined observed without redelivering run errors.
    void cascade.joined.catch(() => {});
    for (const graph of graphs) {
      if (kind === "abort") graph.#abort = cascade;
      else graph.#close = cascade;
    }
    const message =
      kind === "abort" ? "Graph abort failed" : "Graph close failed";
    settleAll(requests, (request) => request(), message).then(
      operations.resolve,
      operations.reject,
    );
    if (kind === "abort") {
      for (const graph of graphs) graph.#controller.abort(reason);
    } else {
      const closed = new DOMException("Graph closed", "AbortError");
      for (const graph of graphs) {
        if (graph.#controller.signal.aborted) graph.#replaceController(closed);
        else graph.#controller.abort(closed);
      }
    }
    const finish = async (): Promise<void> => {
      const failures: unknown[] = [];
      await cascade.promise.catch((error: AggregateError) =>
        failures.push(...error.errors),
      );
      await settleAll([...gates], (gate) => gate, message).catch(
        (error: AggregateError) => failures.push(...error.errors),
      );
      if (kind === "close") {
        const holds = new Set(
          graphs
            .flatMap((graph) => [graph.#lease, graph.#owned])
            .filter((hold) => hold !== undefined),
        );
        await settleAll([...holds], (hold) => hold.close(), message).catch(
          (error: AggregateError) => failures.push(...error.errors),
        );
      } else {
        for (const graph of graphs) {
          if (graph.#abort !== cascade) continue;
          graph.#abort = undefined;
          if (graph.#close === undefined) graph.#replaceController();
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, message);
    };
    finish().then(completion.resolve, completion.reject);
    return cascade;
  }
}
