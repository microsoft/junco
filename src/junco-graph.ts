import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  type DataflowExecution,
  DataflowGraph,
  type DataflowObservation,
  type DataflowRunOptions,
  type DataflowTracer,
  Edge,
  type EdgeIdType,
  type Message,
  type NodeGenerator,
  NodeId,
  type NodeIdType,
  type NodeSpec,
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
import { JuncoAgent, JuncoAgentError } from "junco-agent";
import { parallel, type SchedulerContext } from "junco-scheduler";
import {
  type Contract,
  issueLog,
  ToolCollection,
  type ToolCollectionOptions,
} from "junco-tools";
import type { Graph } from "ngraph.graph";
import { AgentDriver } from "./agent-node.js";
import { cancellation, settleAll } from "./agent-operations.js";
import type {
  Agentic,
  AgenticInput,
  AgenticNode,
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
  unseenValues,
} from "./node-policy.js";
import { build, type FromYamlOptions } from "./syntax/build.js";
import { parse } from "./syntax/parse.js";
import { TuiTracer } from "./tui-tracer.js";

type NestedContext<N, T> = SchedulerContext<
  Agentic<N, T>,
  N,
  T,
  never,
  JuncoGraph<N, T>
>;
type NestedNode<N, T> = Extract<
  AgenticNode<N, T>,
  { readonly state: NestedContext<N, T>; readonly step?: never }
>;

export function isNestedContext<N, T>(
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

/** A complete spec as the native graph registers it, with this graph's policy and contract. */
type CompleteNode<N, T> = NodeSpec<Agentic<N, T>, N, T> & {
  readonly policy: ToolCollection["policy"];
  readonly contract?: (edgeId: EdgeIdType) => Contract;
};

/** Resource operations can be awaited inside a drive without joining that drive's own gate. */
type Cascade = {
  readonly promise: Promise<void>;
  readonly joined: Promise<void>;
};

/** A prompt agent or coroutine a cascade operates on directly. */
type Resource<N, T> = JuncoAgent | MockAgent | Deterministic<N, T>;

type Kind = "abort" | "close";

const closedGraph = (): JuncoAgentError =>
  new JuncoAgentError("closed", "Graph is closed");

/** A member is full when its context holds strictly more than this fraction of its window. */
const FULLNESS_THRESHOLD = 0.4;

/** One hold on a collection, released once. */
type Hold = { close(): Promise<void> };

/** A passive native work graph owning its agents, child graphs and coroutines. */
export class JuncoGraph<
  N = AgenticInput,
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
    super(window, threads, tracer ?? TuiTracer.shared());
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
    if (to === this.source.id)
      throw new DataflowDefinitionError(
        "Graph source cannot have inbound edges",
      );
    if (from === this.sink.id)
      throw new DataflowDefinitionError(
        "Graph sink cannot have outbound edges",
      );
    if (from === this.source.id && E.isRight(edge.transport))
      throw new DataflowDefinitionError(
        "Graph source cannot produce value edges",
      );
    return super.addEdge(from, to, edge);
  }

  /**
   * The workflow a YAML document (text or parsed object) and its config define; see `syntax`.
   * Prepared agents transfer ownership at entry, including when parsing fails.
   */
  static async fromYaml<C = unknown>(
    source: string | object,
    config: FromYamlOptions<C>,
  ): Promise<
    SchedulerContext<
      Agentic,
      AgenticInput,
      AssistantMessage,
      AgencyNodeMetadata,
      JuncoGraph
    >
  > {
    await using prepared = new AsyncDisposableStack();
    for (const instance of new Set(Object.values(config.agents ?? {})))
      prepared.use(instance);
    const { params, ...options } = config;
    const doc = parse(source, params === undefined ? {} : { params });
    prepared.move();
    return build(doc, options);
  }

  /** Build and return the caller's context, adopting its graph into one owned collection. */
  static async create<N, T, EH, C = AgencyNodeMetadata>(
    cwd: string,
    options: ToolCollectionOptions,
    build: (
      collection: ToolCollection,
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
      execution = await build(collection);
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

  /** Map work in insertion order, preserving skeleton IDs and allocating fresh transports. */
  static map<S, L, N = AgenticInput, T = AssistantMessage>(
    skeleton: Pick<Graph<S, L>, "forEachNode" | "forEachLink" | "getLinks">,
    f: (state: S) => Agentic<N, T> | AgenticNode<N, T>,
    options: {
      readonly source: Source<N, T>;
      readonly sink: Sink<N, T>;
      readonly policy: ToolCollection["policy"];
      readonly tracer?: DataflowTracer;
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
    );
    try {
      const edges = new Map<string, Edge<N, T>>();
      skeleton.forEachLink((link) => {
        edges.set(link.id, Edge.message<N, T>(link.id));
      });
      skeleton.forEachNode((node) => {
        const inputs: TriggerEntry<N, T>[] = [];
        for (const link of skeleton.getLinks(node.id) ?? [])
          if (link.toId === node.id)
            inputs.push(TriggerEntry.on(edges.get(link.id)!));
        const mapped = f(node.data);
        if (mapped instanceof JuncoGraph)
          throw new TypeError("Nested graph node requires a SchedulerContext");
        const spec =
          mapped instanceof JuncoAgent || mapped instanceof MockAgent
            ? { state: mapped, policy: options.policy }
            : mapped instanceof Deterministic
              ? { state: mapped }
              : mapped;
        graph.addNode({
          trigger:
            inputs.length === 0
              ? TriggerRule.always<N, T>()
              : TriggerRule.anyOf(...inputs),
          ...spec,
          id: NodeId.create(String(node.id)),
        } as AgenticNode<N, T>);
      });
      skeleton.forEachLink((link) => {
        graph.addEdge(
          NodeId.create(String(link.fromId)),
          NodeId.create(String(link.toId)),
          edges.get(link.id)!,
        );
      });
      return context({ scheduler: parallel(), graph });
    } catch (error) {
      claimedPorts.delete(options.source);
      claimedPorts.delete(options.sink);
      throw error;
    }
  }

  /** Register a root and its paired task children; members remain caller-owned on failure. */
  static spawn<Input, N = AgenticInput, T = AssistantMessage>(
    source: Source<N, T>,
    sink: Sink<N, T>,
    root: AgenticNode<N, T>,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
    tracer: DataflowTracer = TuiTracer.shared(),
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
    );
    try {
      graph.appendChildren(graph.addNode(root), inputs, child);
      return context({ scheduler: parallel(), graph });
    } catch (error) {
      claimedPorts.delete(source);
      claimedPorts.delete(sink);
      throw error;
    }
  }

  /** Resolve managed-state authorization without binding a policy to any graph. */
  static #nodePolicy<N, T>(
    spec: AgenticNode<N, T> | CompleteNode<N, T>,
    graphPolicy?: ToolCollection["policy"],
  ): ToolCollection["policy"] {
    const state = spec.state;
    const nested = isNestedContext<N, T>(state) ? state : undefined;
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
  static async compact<A extends Agentic<N, T>, N, T, EH>(
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

  /** Aborted by {@link abort} (then replaced once that settles) and, terminally, by {@link close}. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The process-wide complaint history every agent and graph shares. */
  get issueLog(): typeof issueLog {
    return issueLog;
  }

  /** Register native work, preserving its actual state and this registration's sender identity. */
  override addNode(spec: AgenticNode<N, T>): NodeIdType;
  // The complete-spec branch alone keeps this override compatible with the native signature.
  override addNode(spec: CompleteNode<N, T>): NodeIdType;
  override addNode(spec: AgenticNode<N, T>): NodeIdType {
    const state = spec.state;
    const nested = isNestedContext<N, T>(state);
    const policy = JuncoGraph.#nodePolicy(spec, this.policy);
    let complete: CompleteNode<N, T>;
    if (spec.step !== undefined) {
      const port =
        state instanceof Source || state instanceof Sink ? state : undefined;
      let contract = spec.contract;
      if (
        port !== undefined &&
        spec.step === port.step &&
        contract === undefined
      ) {
        const expect =
          port.description ||
          (port instanceof Source
            ? "Externally queued graph input."
            : "Graph output consumes final work results and publishes messages.");
        contract = () => ({ expect });
      }
      complete = {
        ...spec,
        policy,
        ...(contract === undefined ? {} : { contract }),
      };
    } else if (state instanceof Deterministic)
      complete = { ...spec, policy, state, step: state.step };
    else if (nested)
      complete = this.#graphNode(spec as NestedNode<N, T>, policy);
    else if (state instanceof JuncoAgent || state instanceof MockAgent)
      // The step-less agent branch exists only on chat wires, where N/T are AgenticInput/AssistantMessage.
      complete = AgentDriver.node(state, {
        ...(spec as unknown as Parameters<typeof AgentDriver.node>[1]),
        policy,
      }) as unknown as CompleteNode<N, T>;
    else throw new TypeError("An agentic node requires a step");
    const id = super.addNode(complete);
    const current = (): AbortSignal => this.signal;
    const { contract } = complete;
    registeredNodeContexts.set(this.getNode(id)!, {
      tracer: this.tracer,
      get signal() {
        return current();
      },
      assertSend: (edgeId) => {
        this.signal.throwIfAborted();
        this.messageQueue(id, edgeId);
      },
      send: (message) => {
        this.signal.throwIfAborted();
        this.emit(id, message as Message<N>);
      },
      info: () => this.#nodeInfo(id),
      ...(contract === undefined ? {} : { contract }),
    });
    return id;
  }

  /**
   * Register one child per element of `inputs` under the already registered `rootId`, each with
   * two fresh message edges: `${rootId}->${childId}` from the root and `${childId}->${rootId}` back
   * to it; children are never linked to each other. Errors propagate synchronously; children
   * registered before the failure stay in this graph.
   */
  appendChildren<Input>(
    rootId: NodeIdType,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
  ): void {
    for (const input of inputs) {
      const childId = this.addNode(child(input));
      this.addEdge(
        rootId,
        childId,
        Edge.message<N, T>(`${rootId}->${childId}`),
      ).addEdge(childId, rootId, Edge.message<N, T>(`${childId}->${rootId}`));
    }
  }

  /** Prime without input consumption; each resume admits input and advances one child decision. */
  #graphNode(
    spec: NestedNode<N, T>,
    policy: ToolCollection["policy"],
  ): CompleteNode<N, T> {
    const { state: execution, ...options } = spec;
    const graph = execution.graph;
    const parent = this;
    const seenValues = new Map<EdgeIdType, unknown>();
    let started = false;
    const step: StepFn<Agentic<N, T>, N, T> = async function* (): NodeGenerator<
      N,
      T
    > {
      let view = yield [];
      started = true;
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
            await execution.step({ signal });
          } catch (error) {
            throw cancellation(signal, error);
          }
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
        graph.sink.drain((message) => parent.emit(this.id, message));
        signal.throwIfAborted();
        if (graph.available().size === 0) {
          const retained = graph.result(graph.sink.id);
          if (O.isSome(retained)) {
            started = false;
            return retained.value;
          }
          throw new JuncoAgentError(
            "invalid_state",
            "Nested graph quiesced without a sink result",
          );
        }
        view = yield [];
      }
    };
    nodePolicies.set(step, { seenValues });
    return {
      ...options,
      policy,
      state: graph,
      step,
      is_available:
        options.is_available ?? ((_view, triggered) => started || triggered),
    };
  }

  /**
   * Node `id`'s parent and child routes, one entry per actual edge, each with the contract its
   * receiving node in this graph declares for it. Fails rather than omit or invent a contract.
   */
  #nodeInfo(id: NodeIdType): ReturnType<NodeRegistration["info"]> {
    this.signal.throwIfAborted();
    const parents: ReturnType<NodeRegistration["info"]>["parents"][number][] =
      [];
    const children: typeof parents = [];
    // ponytail: info scans graph links; add an adjacency index only if large graphs make this hot.
    this.forEachLink((from, to, edge) => {
      if (from !== id && to !== id) return;
      const receiver = registeredNodeContexts.get(this.getNode(to)!)?.contract;
      if (receiver === undefined)
        throw new JuncoAgentError(
          "invalid_state",
          `No contract for edge "${edge.id}" at node "${to}"`,
        );
      const contract: unknown = receiver(edge.id);
      const expect =
        typeof contract === "object" &&
        contract !== null &&
        "expect" in contract
          ? contract.expect
          : undefined;
      if (
        typeof expect !== "string" ||
        expect.trim() === "" ||
        /[\r\n\u2028\u2029]/u.test(expect)
      )
        throw new JuncoAgentError(
          "invalid_state",
          `Invalid contract for edge "${edge.id}" at node "${to}"`,
        );
      const kind = E.isLeft(edge.transport) ? "message" : "value";
      if (to === id) parents.push({ id: from, edgeId: edge.id, kind, expect });
      if (from === id) children.push({ id: to, edgeId: edge.id, kind, expect });
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
    const graphs: JuncoGraph<N, T, never>[] = [];
    const requests: (() => unknown)[] = [];
    const gates = new Set<Promise<void>>();
    const seenGraphs = new Set<object>();
    /** Each resource reached, and whether any registration of it is graph-owned. */
    const resources = new Map<Resource<N, T>, boolean>();
    const joined = new Set<Promise<void>>();
    const stack: JuncoGraph<N, T, never>[] = [this];
    while (stack.length > 0) {
      const graph = stack.pop()!;
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
      const children: JuncoGraph<N, T, never>[] = [];
      graph.forEachNode((_, node) => {
        const state = node.state;
        const policy = nodePolicies.get(node.step);
        if (kind === "close" && policy?.closedTaskState === state) return;
        if (state instanceof JuncoGraph) children.push(state);
        else if (
          state instanceof JuncoAgent ||
          state instanceof MockAgent ||
          state instanceof Deterministic
        )
          resources.set(
            state,
            resources.get(state) === true ||
              policy?.agentOwnership !== "caller",
          );
      });
      for (let index = children.length - 1; index >= 0; index--)
        stack.push(children[index]!);
    }
    // Graph ownership dominates whatever the traversal order; caller-owned agents are only aborted.
    for (const [member, owned] of resources) {
      if (kind === "close" && owned)
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
