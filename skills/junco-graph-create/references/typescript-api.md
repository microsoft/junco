# Junco TypeScript API reference

Escape hatch for what Junco YAML cannot express: `kind: code` node bodies (`graph.nodes.Deterministic`, `graph.Message`, `graph.from`, `TriggerRule`), resource scheduling with `schedules.limit`/`lowest`/`highest`, graph compaction, tracer internals, and hand-wired `DataflowGraph`/`JuncoGraph` programs. Read only the heading you need.

Contents: `## Public API` → `### graph`, `### graph.nodes`, `### workflows and schedules.ralph`, `### graph.trigger`, `### agent`, `### tools`, `### mcp`, `### schedules`, `### Resource profiles and schedules`, `### Graph compaction`, `### tracer`, `### Supporting Pi APIs`; `## Composition patterns`; `## Executable example` (hand-wired `DataflowGraph`).

## Public API

```text
import { graph, agent, tools, schedules, tracer } from "junco-agency";
```

Import only the namespaces a program uses. Spell node constructors as `graph.nodes.*` and trigger rules as `graph.trigger.*`. Model, session, and content APIs are not re-exported by `agent`; import them from `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-coding-agent`.

Fences are **signature excerpts**, not executable declarations; bodies/JSDoc are omitted. Types are exported under their heading unless marked implementation-local or attributed elsewhere. Native `Schedule`/`InputSchedule` formats come from `dataflow-engine` (also `graph`), not policies. Excerpt brands `NodeId`, `EdgeId`, `Width` become `graph.NodeIdType`, `graph.EdgeIdType`, `graph.WidthType`; constructors remain `graph.NodeId.create`, `graph.EdgeId.create`, `graph.Width.create`.

### graph

Verbatim signature excerpts (`graph.DataflowGraph`, `graph.DataflowRunOptions`):

```text
export type DataflowRunOptions = {
  readonly signal?: AbortSignal;
};

export type DataflowObservation<S, N, T> = {
  readonly nodes: ReadonlyMap<NodeId, Readonly<Pick<Node<S, N, T>, "id" | "status" | "description" | "state"> & { readonly profiles: ProfileSet }>>;
  readonly links: readonly (readonly [from: NodeId, to: NodeId, id: EdgeId, kind: "message" | "value"])[];
  readonly inputs: ReadonlyMap<NodeId, ParentView<N, T>>;
  readonly results: ReadonlyMap<NodeId, T>;
  readonly version: number;
};

export type DataflowExecution<N, T> = (
  schedule: Schedule,
  options?: {
    readonly resolveInputs?: (entry: NodeSchedule, live: NodeAvailability<N, T>) => InputSchedule;
    readonly onColumn?: (selected: readonly NodeId[]) => void;
  },
) => Promise<void>;

export class DataflowGraph<S, N, T, EH, K extends ResourceKind = never> implements Pretty
  constructor(readonly window: Width, readonly threads: Width, readonly tracer?: DataflowTracer)
  addNode(spec: NodeSpec<S, N, T, K>): NodeId
  addEdge(from: NodeId, to: NodeId, edge: Edge<N, T>): this
  getNode(id: NodeId): Node<S, N, T, K> | undefined
  result(id: NodeId): O.Option<T>
  results(): ReadonlyMap<NodeId, T>
  observe(): DataflowObservation<S, N, T>
  available(): ReadonlyMap<NodeId, NodeAvailability<N, T>>
  evaluate<R>(
    operation: (execute: DataflowExecution<N, T>, signal?: AbortSignal) => R | Promise<R>,
    options?: DataflowRunOptions,
  ): Promise<R>
  emit(fromId: NodeId, message: Message<N>): void
```

`O.Option` is fp-ts's `Option`; use `O.isSome(result)` (or its `_tag`) to distinguish a present `undefined` from absence. Context `run()`/`step()` return the cumulative native result map. `Edge<N,T>` and `Node<S,N,T>` are native graph types. Graphs own no policy or drive loop: pair one externally with a scheduler context. `workflow.tracer` remains the constructor's readonly observer (on a `JuncoGraph`, possibly automatic). `K` lists the resource kinds every node must profile (`"memory" | "runtime" | "tokens"`); the default `never` makes `profiles` optional. `JuncoGraph` fixes `K = never`, so agency registrations profile nodes individually.

Verbatim signature excerpts (node protocol types):

```text
export type Message<N> = { readonly id: EdgeId; readonly payload: N };

export type Lookup<K, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  keys(): Iterable<K>;
};

export type ParentView<N, T> = {
  readonly messages: Lookup<EdgeId, readonly N[]>;
  readonly values: Lookup<EdgeId, T>;
};

export type NodeGenerator<N, T> = AsyncGenerator<
  Message<N>[],
  T,
  ParentView<N, T>
>;

export type StepFn<S, N, T> = (this: Node<S, N, T>) => NodeGenerator<N, T>;

export type AvailabilityFn<N, T> = (
  view: ParentView<N, T>,
  triggered: boolean,
) => boolean;

export type NodeOptions<N, T, K extends ResourceKind = never> = {
  readonly id?: NodeId;
  readonly description?: string;
  readonly trigger: TriggerRule<N, T>;
  readonly is_available?: AvailabilityFn<N, T>;
} & ProfilesOption<K>;

export type NodeSpec<S, N, T, K extends ResourceKind = never> = NodeOptions<N, T, K> & {
  readonly state: S;
  readonly step: StepFn<S, N, T>;
  readonly on_error?: ErrorFn<S, N, T>;
};
```

Verbatim signature excerpts (identity, width, edges, message helpers; `Newtype` is implementation-local):

```text
export type NodeId = Newtype<string, "NodeId">;
export const NodeId = {
  create: (value: string): NodeId =>
};

export type EdgeId = Newtype<string, "EdgeId">;
export const EdgeId = {
  create: (value: string): EdgeId =>
};

export type ValidWidth<W extends number> = W extends PositiveInfinity
  ? W
  : W extends 0
    ? never
    : IsNegative<W> extends true
      ? never
      : Integer<W>;

export type Width = Newtype<number, "Width">;
export const Width = {
  create: <W extends number>(value: ValidWidth<W>): Width =>
};
export const UNBOUNDED: Width = Number.POSITIVE_INFINITY as Width;

export const Edge = {
  message: <N, T>(id: string): Edge<N, T> =>
  value: <N, T>(id: string): Edge<N, T> =>
};

export const Message = {
  create: <N, T>(edge: Edge<N, T>, payload: N): Message<N> =>
};
export const from = <N, T>(
  view: ParentView<N, T>,
  edge: Edge<N, T>,
): readonly N[] =>
```

Verbatim signature excerpts (`graph.JuncoGraph`):

```text
export class JuncoGraph<N = AgenticInput, T = AssistantMessage, EH = never>
  extends DataflowGraph<Agentic<N, T>, N, T, EH>

  constructor(
    source: Source<N, T>,
    sink: Sink<NoInfer<N>, NoInfer<T>>,
    window: Width,
    threads: Width,
    tracer: DataflowTracer | undefined,
    policy: ToolCollection["policy"],
    collection?: ToolCollection,
  )
  readonly source: Source<N, T>
  readonly sink: Sink<N, T>
  static async create<N, T, EH, C = AgencyNodeMetadata>(
    cwd: string,
    options: ToolCollectionOptions,
    build: (collection: ToolCollection) =>
      SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>> |
      Promise<SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>>,
  ): Promise<SchedulerContext<Agentic<N, T>, N, T, C, JuncoGraph<N, T, EH>>>
  readonly policy: ToolCollection["policy"]
  get collection(): ToolCollection | undefined
  get signal(): AbortSignal
  abort(reason: unknown = new DOMException("Graph aborted", "AbortError")): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
  compact(policy: CompactionPolicy): Promise<void>

  static map<S, L, N = AgenticInput, T = AssistantMessage>(
    skeleton: Pick<Graph<S, L>, "forEachNode" | "forEachLink" | "getLinks">,
    f: (state: S) => Agentic<N, T> | AgenticNode<N, T>,
    options: {
      readonly source: Source<N, T>;
      readonly sink: Sink<N, T>;
      readonly policy: ToolCollection["policy"];
      readonly tracer?: DataflowTracer;
    },
  ): SchedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, JuncoGraph<N, T>>
  static spawn<Input, N = AgenticInput, T = AssistantMessage>(
    source: Source<N, T>,
    sink: Sink<N, T>,
    root: AgenticNode<N, T>,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
    tracer: DataflowTracer = TuiTracer.shared(),
  ): SchedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, JuncoGraph<N, T>>
  appendChildren<Input>(
    rootId: NodeIdType,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
  ): void
```

Construction rules:

- **Choose by native state.** `graph.DataflowGraph<S,N,T,EH>` holds ordinary states (e.g. `undefined`); `graph.JuncoGraph` holds agents, nested native graphs, `Deterministic` coroutines and Source/Sink states, never contexts or policies. Never cast plain state into `Agentic`.
- **`graph.nodes.Agentic` is the graph-state union**, not the cooperative agent interface `agent.Agentic`.
- **Edges.** Message edges queue emitted `N`; value edges retain the source's latest returned `T`, replacing the previous value on each return. Agency delivery freshness is keyed by edge ID and `!==` value identity: a changed retained value is fresh again, not a deep comparison. Read batches with `graph.from(view, edge)` or `view.messages`, results with `view.values.get(edge.id)`. `Message.create`/`emit` target wired message edges, never value edges. IDs must be unique within each source-outbound and target-inbound set. Register endpoints before `addEdge`; never mutate transport.
- **Generator protocol.** Start dependent bodies with `let view = yield []`; priming consumes no queued inputs. Each activation advances once; returning `T` marks done and updates all outbound value edges. Only delivery on the returning node's own value self-edge re-arms it: a new `step()` generator, same state. Message self-edges, non-self value updates and multi-node cycles do not re-arm returned nodes. Bound re-runs through availability; results retain the latest return. Annotate hand-written bodies `async function* (): graph.NodeGenerator<N, T> { … }`.
- **Generic inference.** `new StepNode` / `new EmitOnce` infer `S`, `N`, `T` from arguments including `options` (`state: undefined` infers `S = undefined`). If these differ from graph types (e.g. `void` state, union `N`, narrower trigger), pass explicit generics: `new graph.nodes.StepNode<void, Payload, string>(…)`. `Message.create` infers from arguments. `graph.from(view, edge)` returns graph-wide `N`, not the edge's narrower type; narrow payloads with type guards, never casts.
- **Agent graphs use `AgenticInput` messages and `AssistantMessage` results** (the `JuncoGraph` defaults). A deterministic node feeding an agent emits `{ kind: "prompt", text }`.
- **Closing.** `JuncoGraph.close()` recursively closes agents, graphs and coroutines, joining active evaluations (provider/port work included) before releasing collection holds. Source/Sink states own no independent lifecycle resources. Results remain readable; repeated close is safe. Until successful registration, acquirers own resources and must close earlier acquisitions on failure. Close persistent round members once at the end, not per round.
- **Spawn policy.** `JuncoGraph.spawn(source,sink,root,inputs,child)` returns a parallel context under root authorization. Ports precede root/children; explicit port names consume no automatic work IDs. Native root/child message pairs remain bidirectional; callers wire terminal work to the sink. Construction failure leaves members caller-owned; unpublished factory failures also release port claims, allowing untouched-port retry.
- **Execution.** Pair `new graph.JuncoGraph(source,sink,window,threads,observer,policy)` with `schedules.context({ graph: workflow, scheduler: schedules.parallel() })`; drive the context, inspect/close `.graph`. Plain native graphs use `context` from `junco-scheduler`. Context `run()` returns cumulative results at quiescence, not proof all members finished; `step()` makes at most one current decision. Native single-flight evaluation rejects overlapping drives before planning.

### graph.nodes

Each agency needs fresh, distinct deterministic ports with explicit branded IDs. Register source then sink as ordinary native work nodes: topology, availability, thread capacity, history and tracing include them. Their `step` closures have no state-specific `this` and assign directly under the full `Agentic` union.

```text
export class Source<N, T> implements NodeSpec<Source<N, T>, N, T>
  constructor(route: (view: ParentView<N, T>) => Message<N>[],
    options: Pick<NodeOptions<N, T>, "description"> & { readonly id: NodeId })
  readonly id: NodeId
  readonly description?: string
  readonly state: Source<N, T>
  readonly trigger: TriggerRule<N, T>
  readonly is_available: AvailabilityFn<N, T>
  readonly step: () => NodeGenerator<N, T>
  readonly revision: number
  enqueue(view: ParentView<N, T>): void
  peek(): ParentView<N, T> | undefined

export class Sink<N, T> implements NodeSpec<Sink<N, T>, N, T>
  constructor(body: (sink: Sink<N, T>) => NodeGenerator<N, T>,
    options: Omit<NodeOptions<N, T>, "id"> & { readonly id: NodeId })
  readonly id: NodeId
  readonly description?: string
  readonly state: Sink<N, T>
  readonly trigger: TriggerRule<N, T>
  readonly is_available?: AvailabilityFn<N, T>
  readonly step: () => NodeGenerator<N, T>
  send(message: Message<N>): void
  drain(deliver: (message: Message<N>) => void): void
```

`enqueue` detaches each native edge-addressed `ParentView` into FIFO delivery, preserving message keys/batch order, empty message keys and present values (including `undefined`), while borrowing opaque payload identities. Ignore views without queued messages or present values. `peek` never consumes; revision advances only on admission/consumption. On its first activation a scheduled Source consumes one delivery and calls synchronous `route`: no initial empty yield or scheduler-side routing. Without ingress it stays dormant; route exceptions fail the native node. Closed-input workflows must reject unexpected non-empty ingress, never discard it. Receiving routes validate/convert original parent edge IDs and emit only on explicitly wired child edges.

A Sink delegates an ordinary generator, collecting yielded messages in an ordered outbox and internally yielding `[]`: those IDs address the enclosing graph. `send` uses the same outbox, permitting final messages and exact `return T` in one activation. `drain` removes items only after successful synchronous delivery; failure retains the remaining suffix, never replays successful prefixes. Trigger/availability must not readmit already-handled retained values; unwired sinks are dormant. Only the sink's native retained result is nested output. Failed/aborted ordinary child work never drains; promoted tasks keep their specified already-accepted-send exception.

Before collection holds, construction validates Source/Sink instance types and distinct runtime string IDs (`""` allowed), then claims port identities for the graph lifetime. Reusing a claimed pair fails. Source inbound, sink outbound and source outbound value edges are rejected before effects. Successful/public graphs retain claims after close; failed unpublished map/spawn construction releases claims without closing caller-owned members. Source/Sink states own no coroutine/agent resources.


Verbatim signature excerpts (body and constant node classes; `ConstNodeOptions` and `ConstNodeSpec` are implementation-local supporting types):

```text
export class StepNode<S, N, T> implements NodeSpec<S, N, T>
  constructor(
    fn: (state: S, view: ParentView<N, T>) => Message<N>[],
    options: Omit<NodeSpec<S, N, T>, "step">,
  )

export class EmitOnce<S, N, T> implements NodeSpec<S, N, T>
  constructor(
    batch: () => Message<N>[],
    ret: T,
    options: Omit<NodeSpec<S, N, T>, "step">,
  )

type ConstNodeOptions<S, T> = Pick<
  NodeOptions<never, never>,
  "id" | "description"
> & {
  readonly state: S;
  readonly ret: T;
};

type ConstNodeSpec<S, N, T> = Omit<
  NodeSpec<S, N, T>,
  "step" | "is_available"
> & {
  readonly step: () => NodeGenerator<N, T>;
  readonly is_available?: AvailabilityFn<unknown, unknown>;
};

export class ConstFanout<S, N, T> implements ConstNodeSpec<S, N, T>
  constructor(
    payload: N,
    outputs: readonly Edge<N, T>[],
    options: ConstNodeOptions<S, T>,
  )

export class ConstFanin<S, C, T> implements ConstNodeSpec<S, C | C[], T>
  constructor(
    inputs: readonly Edge<C, T>[],
    output: Edge<C[], T>,
    options: ConstNodeOptions<S, T>,
  )
```

- `EmitOnce` emits its batch, returning `ret` next activation. `StepNode` never returns; use it for streaming sinks. Both are complete specs: `options` supplies all but `step` (`{ state, trigger, … }`).
- A finite generator's trigger/availability must still admit the activation that performs its final `return`. Bound feedback loops by the task's actual stop condition.
- Constant classes are complete specs requiring `{ state, ret }` (`undefined` only if graph types allow). Construct with `new` once per node.
- `ConstFanout` sends one shared payload reference on each distinct message edge, in `outputs` order, then completes. Zero outputs still complete.
- `ConstFanin` accumulates all messages from every input across activations, emits one list in *input order*, not arrival order, then completes next activation. Array payloads stay one element; zero inputs emit one `[]`. Graph messages must admit `C` and `C[]`.
- Value-edge arguments and duplicate edges are definition errors.

Verbatim signature excerpts (Junco node states and bindings; `ImageContent` and `AssistantMessage` come from `@earendil-works/pi-ai`, `AgentMessage` from `@earendil-works/pi-agent-core`; `MockAgent` is a test double exported only at the package top level, and generated workflows use `agent.JuncoAgent`):

```text
export type AgenticInput =
  | {
      readonly kind: "prompt" | "steer" | "followUp" | "nextTurn" | "error"; // error: delivered via followUp
      readonly text: string;
      readonly images?: ImageContent[];
    }
  | { readonly kind: "appendMessage"; readonly message: AgentMessage };

export type Agentic<N = AgenticInput, T = AssistantMessage> =
  | JuncoAgent
  | JuncoGraph<N, T>
  | MockAgent
  | Deterministic<N, T>
  | Source<N, T>
  | Sink<N, T>;

export type AgenticNode<N = AgenticInput, T = AssistantMessage> = (
  | (NodeSpec<Agentic<N, T>, N, T> & { readonly policy: ToolCollection["policy"] })
  | ((Source<N, T> | Sink<N, T>) & { readonly policy?: never })
  | (StepLess<N, T> & {
      readonly state: Deterministic<N, T>;
      readonly step?: never;
      readonly policy?: never;
    })
  | (StepLess<N, T> & {
      readonly state: SchedulerContext<Agentic<N, T>, N, T, never, JuncoGraph<N, T>>;
      readonly step?: never;
      readonly policy?: never;
    })
  | (StepLess<N, T> & {
      readonly state: JuncoAgent | MockAgent; // chat wires only
      readonly step?: never;
      readonly policy: ToolCollection["policy"];
    })
) & { readonly contract?: (edgeId: EdgeIdType) => Contract };
// StepLess (NodeSpec minus state/step) is implementation-local.
// Register agents with policy, coroutines with their own policy, and nested work as
// { ...nodeOptions, state: childContext, contract? }; no own policy on the latter two.
// A nested native state is childContext.graph, never the context itself.
// Source/Sink are complete native specs authorized under the graph's policy.

export class Deterministic<N = AgenticInput, T = AssistantMessage> implements NodeGenerator<N, T>
  constructor(
    body: (
      signal: AbortSignal,
      collection?: ToolCollection,
    ) => NodeGenerator<N, T>,
    policy: ToolCollection["policy"],
    collection?: ToolCollection,
  )
  abort(reason: unknown = new DOMException("Deterministic aborted", "AbortError")): Promise<void>
  close(): Promise<void>
```

- A registered agent (`workflow.addNode({ ...options, policy, state: agent })`) runs **one staged prompt per run** and returns when it settles; without a value self-edge a staged-prompt source with `trigger: TriggerRule.always()` runs once. Prompts belong to the agent: `JuncoAgent.create({ prompt })` (one-shot), or `agent.stagePrompt(prompt)` while idle before another admitted run (`busy` unless idle). A `prompt` callback `(inputs: graph.ParentView<AgenticInput, AssistantMessage>) => string` runs once synchronously when its staged prompt starts with the undrained retained inbox; throws fail the node unchanged. A value self-edge re-arms the returned node with the same agent/session and inbox; another staged prompt is still required. Never register `prompt`. Delivered messages and unseen parent values are **data**, retained per edge until `recv`; they never start, steer or prompt the agent. Input without a prompt leaves an idle agent quiescent. Use `send({ id: edgeId, payload })` for outgoing message edges and `info({})` for routes/receivers' expectations; value edges carry the latest returned result. Only `yield` and Marsh policy denial pause runs; native yields resume the same run, not another round. Settlement returns the node's `AssistantMessage`; failure throws the native error.
- **Contracts.** `info` reports the *receiving* node's `Contract.expect` for every parent/child edge. Set `contract` on receiver registration (`{ ...options, state, contract }`) for agents, coroutines or nested graphs, or use `JuncoAgent.create({ contract: (edgeId) => ... })` as an agent default; registration overrides that default. Unknown edges on finite receivers throw `JuncoAgentError("invalid_state", \`No contract for edge "${edgeId}"\`)`; `info` fails, never omits them.
- **Validated handoffs.** Build checked upstream assignments in the consumer's prompt callback: read `inputs.messages.get(edgeId)` / `inputs.values.get(edgeId)`, throw on invalid data and return assignment text (`examples/mixed.ts` Reviewer, `examples/mcp.ts` Dependencies). No consumer `recv` is needed. Wire/trigger upstream edges directly into the consumer and register its incoming-edge `contract`. Never add a deterministic node solely to prepare a prompt message.
- Never separately iterate an agent the graph is driving.
- `{ ...options, state: coroutine }` registers a `Deterministic` whose `body(signal)` uses the same generator protocol. Register each single-consumer coroutine once; honor `signal` in long loops.
- **Nested boundaries.** Register `{ ...nodeOptions, state: childContext, contract? }`, never a bare graph. Parent priming makes no child decision. Each later activation enqueues edge-addressed batches and fresh retained values into `childContext.graph.source`, advances at most one child decision, then drains the sink only on success. Value freshness is edge ID plus `!==` identity. Only the sink's retained `T` is the nested result (present `undefined` included); quiescence without it fails. Completing sinks stage final parent messages before returning; intermediate drafts never escape. Validate/convert/route in port bodies, never policies.

### workflows and schedules.ralph

`workflows.ralph` is YAML text exported from `junco-agency`. It declares an ordinary agent `Ralph`, assignment ingress `$source~>Ralph`, value feedback `Ralph->Ralph` and final output `Ralph->$sink`. Construct it with `JuncoGraph.fromYaml`; its models come from a TypeScript ladder and round control from `schedules.ralph` availability hooks.

```ts
import { graph, JuncoGraph, schedules, workflows } from "junco-agency";

// ladder has all five authoring-verified rungs; share acquired models/observer.
const childContext = await JuncoGraph.fromYaml(workflows.ralph, {
  cwd,
  models,
  ladder,
  tracer: observer,
  scheduler: () => schedules.parallel(),
  ...schedules.ralph({ rounds: 2 }),
});
try {
  childContext.graph.source.enqueue({
    messages: new Map([[graph.EdgeId.create("assignment"), [{ kind: "prompt", text: assignment }]]]),
    values: new Map(),
  });
  await childContext.run();
  // childContext.graph.result(childContext.graph.sink.id) is the final round's message.
} finally {
  try { await childContext.graph.close(); } finally { await observer.flush(); }
}
```

`fromYaml(source, { ...config, params })` (or `syntax.parse`) substitutes generic `{{ params.name }}` text before parsing YAML; quote placeholders because substitution is verbatim. Missing params fail; parsed objects reject params. Ralph itself has no model parameter: pass a complete ladder. `schedules.ralph({ rounds })` returns availability factories for Ralph and $sink; factories decline levels without Ralph->Ralph. Rounds must be positive safe integers (default two). Admit exactly one image-free prompt on the assignment source route. The first prompt is the assignment; later rounds retain it and only the immediately preceding complete draft. Blank or non-normal intermediate drafts fail before the next round; the controller does not validate the final draft. Native yields continue the current round. Only the final round reaches the sink.

For nesting, pre-acquire the built context and register `{ ...nodeOptions, state: childContext, contract? }`, with no own spec-level policy; the native state is its graph. A direct assignment can be enqueued once on the child's `assignment` route before registration. For parent-edge ingress, build a document copy whose `graph.source.routes` maps that parent edge ID to `["$source~>Ralph"]`; do not mutate the parsed document or assume topology edges forward assignments automatically. If final output must be sent on a parent message edge, configure a nested Sink that sends the validated final prompt on that edge before returning the exact final message; the stock Ralph sink only returns its value. Close through the owning root recursively, then flush shared tracing once after all users stop. Do not stage the Ralph worker yourself: its availability hooks stage each round.

### graph.trigger

Verbatim signature excerpts:

```text
export type TriggerKind = "all" | "any";

export type TriggerEntry<N, T> = EdgeId & {
  readonly [triggerEntry]: readonly [message: N, result: T];
};

export type TriggerRule<N, T> = {
  readonly kind: TriggerKind;
  readonly rule: readonly TriggerEntry<N, T>[];
};

export const TriggerEntry = {
  on: <N, T>(edge: Edge<N, T>): TriggerEntry<N, T> =>
};

function allOf<const Entries extends readonly TriggerEntry<unknown, unknown>[]>(
  ...entries: Entries
): TriggerRule<
  Entries[number][typeof triggerEntry][0],
  Entries[number][typeof triggerEntry][1]
>;
function allOf<N = never, T = never>(
  ...entries: readonly TriggerEntry<N, T>[]
): TriggerRule<N, T>;
function anyOf<const Entries extends readonly TriggerEntry<unknown, unknown>[]>(
  ...entries: Entries
): TriggerRule<
  Entries[number][typeof triggerEntry][0],
  Entries[number][typeof triggerEntry][1]
>;
function anyOf<N = never, T = never>(
  ...entries: readonly TriggerEntry<N, T>[]
): TriggerRule<N, T>;

export const TriggerRule = {
  allOf,
  anyOf,
  when: <N, T>(edge: Edge<N, T>): TriggerRule<N, T> =>
  always: <N = never, T = never>(): TriggerRule<N, T> => allOf<N, T>(),
  never: <N = never, T = never>(): TriggerRule<N, T> => anyOf<N, T>(),
};
export const satisfiedEdges = <N, T>(
  trigger: TriggerRule<N, T>,
  inbound: ReadonlyMap<EdgeId, Edge<N, T>>,
  nodeId: NodeId,
): readonly EdgeId[] =>
export const evaluateTrigger = <N, T>(
  trigger: TriggerRule<N, T>,
  inbound: ReadonlyMap<EdgeId, Edge<N, T>>,
  nodeId: NodeId,
): boolean =>
```

- Conjunction: `TriggerRule.allOf(TriggerEntry.on(a), TriggerEntry.on(b))`; disjunction: `TriggerRule.anyOf(TriggerEntry.on(a), TriggerEntry.on(b))`. Never arrays, bare edges or bare `EdgeId`s. `triggerEntry` is an implementation-local type-only brand; runtime entries are edge id strings.
- Entries carry edge message/result types; unannotated `allOf`/`anyOf` infer their payload union. Node payload types must include it: narrow rules fit wider-payload graphs; wrong-payload rules fail compilation.
- Ordered `TriggerRule.anyOf`: ordinary trigger-driven reads take only the first satisfied entry. `TriggerRule.when(edge)` is single-edge conjunction; `TriggerRule.always()` empty conjunction (sources); `TriggerRule.never()` empty disjunction. Untyped empty rules fit every graph.
- A rule naming an unwired inbound edge, or repeating an entry, is a definition error.
- A trigger says *which* edges must carry something; `is_available` may further restrict or extend readiness (e.g. "publish once": `is_available: () => !published`).

### agent

Verbatim signature excerpts: `Skill`, `PromptTemplate`, `AgentTool`, `AgentHarnessOptions`, `AgentHarnessResources`, `Session` are from `@earendil-works/pi-agent-core`; `ModelRuntime` from `@earendil-works/pi-coding-agent`; `OwnedResources` is implementation-local. `AgentHarnessOptions` supplies `session`, `models`, `model`, `systemPrompt`, `thinkingLevel`, `streamOptions`, `retry`, `compaction`, `steeringMode`, `followUpMode`. `ModelRuntime` has no close method:

```text
export type AgenticStatus = "ready" | "pending" | "running" | "suspended" | "idle" | "closed";

export type AgenticYieldReason = {
  readonly kind: "tool" | "policy";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: string;
};

export type AgenticStep =
  | { readonly kind: "yield"; readonly reasons: readonly AgenticYieldReason[] }
  | { readonly kind: "settled"; readonly message: AssistantMessage }
  | { readonly kind: "failed"; readonly error: unknown };

export type AgenticOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Omit<AgentHarnessOptions<undefined>, "tools" | "resources" | "toolExecution"> & {
  readonly tools?: T[];
  readonly resources?: AgentHarnessResources<S, P>;
  readonly prompt?: string | ((inputs: ParentView<AgenticInput, AssistantMessage>) => string); // one-shot staged prompt
  readonly images?: ImageContent[];
};

export type JuncoAgentCreateOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Omit<AgenticOptions<S, P, T>, "session" | "models" | "model" | "tools"> & {
  readonly provider: string;
  readonly model: string;
  readonly models?: ModelRuntime;
  readonly session?: Session;
  readonly cwd?: string;
  readonly tools?: JuncoAgentTools<T>;
};

export type JuncoAgentTools<T extends AgentTool = AgentTool> =
  | JuncoMcpTools
  | readonly (T | JuncoMcpTools)[];

export type JuncoAgentResolvedOptions<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> = Omit<AgenticOptions<S, P, T>, "tools"> & {
  readonly cwd?: string;
  readonly tools?: JuncoAgentTools<T>;
};

export class JuncoAgent<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  T extends AgentTool = AgentTool,
> implements Agentic<S, P, T>

  static fromResolved<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate, T extends AgentTool = AgentTool>(
    options: AgenticOptions<S, P, T> & { readonly cwd?: string },
  ): Promise<JuncoAgent<S, P, T>>;
  static fromResolved<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>(
    options: JuncoAgentResolvedOptions<S, P, AgentTool>,
  ): Promise<JuncoAgent<S, P, AgentTool>>;
  static create<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate, T extends AgentTool = AgentTool>(
    options: JuncoAgentCreateOptions<S, P, T> & { readonly tools: T[] },
  ): Promise<JuncoAgent<S, P, T>>;
  static create<S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>(
    options: JuncoAgentCreateOptions<S, P, AgentTool>,
  ): Promise<JuncoAgent<S, P, AgentTool>>;
  protected constructor(options: AgenticOptions<S, P, T>, owned: OwnedResources = {})

  get status(): AgenticStatus
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage>
  stagePrompt(prompt: string | ((inputs: ParentView<AgenticInput, AssistantMessage>) => string), options?: { images?: ImageContent[] }): void // closed; busy unless idle with no queued demand
  next(inputs?: ParentView<AgenticInput, AssistantMessage>): Promise<IteratorResult<AgenticStep, void>> // callback stage without inputs: failed invalid_state; throw: failed with that error; non-string: failed invalid_argument
  return(value?: void | PromiseLike<void>): Promise<IteratorResult<AgenticStep, void>>
  async [Symbol.asyncDispose](): Promise<void>
  steer(text: string, options?: { images?: ImageContent[] }): Promise<void>
  followUp(text: string, options?: { images?: ImageContent[] }): Promise<void>
  nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void>
  appendMessage(message: AgentMessage): Promise<void>
  setModel(model: ModelIdentity): Promise<void>
  getModel(): Promise<Model<Api> | undefined>
  getTools(): T[]
  getActiveTools(): T[]
  setTools(tools: T[], activeToolNames?: string[]): Promise<void>
  setActiveTools(names: string[]): Promise<void>
  context_size(): Promise<number>
  compact(options?: { customInstructions?: string }): Promise<void>
  abort(): Promise<{ readonly clearedSteer: AgentMessage[]; readonly clearedFollowUp: AgentMessage[] }>
  // JuncoAgent only, not Agentic:
  runWithNodeContext<N, T, R>(context: JuncoAgentNodeContext<N, T>, work: () => Promise<R>): Promise<R> // { messaging?, task?, complaint? }; overlapping binding rejects busy; graph-registered agents do this
  contract(edgeId: EdgeIdType): Contract // from the `contract` option; else invalid_state; never starts a run
  setTaskPolicy(policy: TaskPolicy | undefined): void // throw to reject a hosted task launch (not a decision) as a tool error
  setTaskBatch(input: TaskInput): Promise<void> // idle only; model launches the stored batch once with task({}); children get an ordinary task tool
  setTaskFailurePolicy(policy: TaskFailurePolicy): void // default { retries: 0 }; snapshotted per admitted task; not inherited
  getTaskFailurePolicy(): TaskFailurePolicy
  setSubagentObserver(observer: SubagentObserver | undefined): void // sees every createSubagents batch, incl. graph launches/retries
  createSubagents(options: readonly TaskAgentOptions[], signal?: AbortSignal): Promise<JuncoAgent<S, P, AgentTool>[]>

export type TaskAgentOptions = { readonly model?: ModelIdentity; readonly tools?: readonly string[] };
export type TaskPolicy = (input: TaskInput) => void; // TaskInput from junco-tools
// "ignore": drop failures silently; { retries: n }: rerun up to n times, then ask the caller (task decision).
// n must be a nonnegative safe integer, else invalid_argument "Task retries must be a nonnegative safe integer".
export type TaskFailurePolicy = "ignore" | { readonly retries: number };
export type SubagentObserver = {
  readonly acquiring?: (options: readonly TaskAgentOptions[]) => void; // throw: reject, nothing created
  readonly acquired?: (child: JuncoAgent, index: number) => void; // throw: fail batch, children closed
};

export class JuncoAgentError extends Error
  constructor(
    readonly code: "invalid_argument" | "invalid_state" | "busy" | "closed",
    message: string,
    options?: ErrorOptions,
  )
```

The voluntary-suspension tool lives under **`tools`** (see below), not `agent`.

- **Use static factories.** Protected constructor: `await agent.JuncoAgent.create(...)`, never `new agent.JuncoAgent(...)`.
- **Policy and collection:** agents take no `policy`. Optional `collection` authorizes via `collection.policy`; an agent-owned lease binds its native lifetime, not its tools. Implicit collections (omitted `tools`, or nonempty MCP definitions without a collection) use `ToolCollection.create(cwd)` with default `tools.LockPolicy`; open/pass a collection for other policies. Registered agents and all explicit-`step` raw specs require node-spec `policy`: the identical object (identity comparison) as a real agent's `collection.policy`, if present, or the coroutine/child graph's policy when held by the raw spec. Step-less coroutines/nested graphs use their constructor policy; spec `policy` throws `TypeError`.
- **Normal construction:** `create({ models, provider, model, systemPrompt, tools })` resolves exact IDs, checks saved login and owns its default in-memory session. Supplied `session` transfers to the agent.
- **Pre-resolved:** `fromResolved({ models, model, session, tools })` requires a resolved native `Model<Api>` and Pi core `Session`; the session transfers.
- **MCP sources:** both factories accept `mcp.JuncoMcpTools` in `tools`, alone or mixed with concrete tools (`tools: [servers, lsp, ...collection.tools]`), connected from `cwd`. Agents get fresh MCP clients/server processes, closed with them; names are `mcp__<server>__<tool>`. Definitions are factory-only; `setTools` accepts concrete tools only.
- **Never interchange model shapes:** `create` takes a model ID *string* in `model`; `fromResolved` takes a resolved `Model<Api>` in `model`; `setModel` takes `{ provider, modelId }` (`ModelIdentity`).
- **Final text:** use `contentText(message.content)` from `@earendil-works/pi-ai`; forward reports only with `message.stopReason === "stop"` and nonblank trimmed text.
- **Iterator boundaries:** preserve `yield` / `settled` / `failed`; rethrow failed `error`. `return()` or early `for await` break closes terminally. For round reuse, drive explicit `next()` or graph-register and `stagePrompt` each round.

### tools

Verbatim signature excerpts (`NativeMux`, `NativeModule`, `EditStore` are native-addon contracts exported as types only — `tools.NativeMux`, `tools.NativeModule`, `tools.EditStore` — whose runtime constructors live only behind the `junco-tools/native` subpath; `BashToolOptions`, `BashOperations` are Pi coding-agent types re-exported as types):

```text
export interface ToolCollectionOptions {
  bash?: BashToolOptions;
  native?: NativeModule;
  sandbox?: "shared" | "always";
  policy?: Policy; // default LockPolicy
  principal?: string;
}

export class ToolCollection
  readonly tools: AgentTool<any>[];
  readonly policy: Policy;
  readonly mux: NativeMux;
  readonly native: NativeModule;
  static async create(cwd: string, options?: ToolCollectionOptions): Promise<ToolCollection>
  lease(): { close(): Promise<void> }
  close(): Promise<void>

export interface Policy { toNative(native: NativeModule): NativePolicy } // open: implement it for a new policy
export const LockPolicy: Policy;  // a write owns its file until released or deleted
export const EmptyPolicy: Policy; // grants every capability
export const Policy = {
  and(left: Policy, right: Policy): Policy, // grants what both grant
  or(left: Policy, right: Policy): Policy,  // grants what either grants
  not(policy: Policy): Policy,              // grants what `policy` denies
};

export interface LspToolOptions {
  readonly readOnly?: boolean;
}
export type LspToolInput = Parameters<UpstreamLspTool["execute"]>[1];
export type LspToolDetails = UpstreamLspToolDetails;
export type LspTool = AgentTool<TUnsafe<LspToolInput>, LspToolDetails | undefined> & LspToolFields;
export const LspTool = {
  async create(cwd: string, options: LspToolOptions = {}): Promise<LspTool>
  async shutdown(): Promise<void>

export class ShellMuxOperations implements BashOperations
  constructor(options?: {
    readonly native?: NativeModule;
    readonly mux?: NativeMux;
    readonly sandbox?: "shared" | "always";
    readonly policy?: Policy; // only without `mux`: a borrowed mux keeps its own
    principal?: string;
  })
  close(): Promise<void>

export interface ShellMuxLease {
  readonly mux: NativeMux;
  readonly native: NativeModule;
  readonly policy: Policy;
  readonly closed: boolean;
  release(): Promise<void>;
}
export const ShellMuxLease = {
  async create(
    cwd: string,
    options: {
      readonly native?: NativeModule;
      readonly sandbox?: "shared" | "always";
      readonly policy?: Policy;
    } = {},
  ): Promise<ShellMuxLease>
};

export const MARSH_POLICY_DENIED = "MARSH_POLICY_DENIED";
export interface MarshPolicyDeniedError extends Error {
  readonly code: typeof MARSH_POLICY_DENIED;
}
export function isMarshPolicyDenied(error: unknown): error is MarshPolicyDeniedError

export type YieldToolDetails = { readonly reason: string };
export type YieldTool = AgentTool<typeof yieldParameters, YieldToolDetails>;
export const YieldTool: new () => YieldTool
export function isYieldTool(tool: object): boolean

export type Contract = { readonly expect: string };
export class RecvTool<N = unknown, T = unknown>
  constructor(host?: { readonly view: ParentView<N, T>; consume(): void }) // recv({}): drains retained { messages, values }
export class SendTool<N = unknown>
  constructor(host?: { send(message: Message<N>): void })                // send({ id: edgeId, payload }): one message on an outgoing message edge
export class InfoTool                                                     // info({}): { parents, children: { id, edgeId, kind, expect }[] }
// Each has static companions: RecvTool.is(tool) / RecvTool.invoke(tool, host, toolCallId, input, signal), likewise SendTool/InfoTool.

export type TaskToolDetails = {
  readonly tasks: readonly { readonly id: string; readonly name?: string }[];
};
export type TaskInput = Static<typeof launchSchema>;
export type TaskDecision = { readonly action: "retry" | "ignore"; readonly id: string; readonly attempt: number };
export type TaskRequest = TaskInput | TaskDecision;
export type TaskCall = TaskRequest | Readonly<Record<string, never>>;
export type TaskToolHost = (
  toolCallId: string,
  input: TaskRequest, // discriminate with "action" in input
  signal: AbortSignal,
) => Promise<TaskToolDetails["tasks"]>; // launch: one handle per task; retry: the task's handle; ignore: none. Reject only if nothing was admitted.
export type TaskTool = AgentTool<typeof taskParameters, TaskToolDetails>;
export type AssignedTaskTool = AgentTool<typeof assignedParameters, TaskToolDetails>;
export const TaskTool: new (host?: TaskToolHost) => TaskTool
export const AssignedTaskTool: new (input: TaskInput) => AssignedTaskTool // model launches the stored batch with task({})
export function isTaskTool(tool: object): tool is TaskTool | AssignedTaskTool
export function isAssignedTaskTool(tool: object): tool is AssignedTaskTool
export function invokeTaskTool(tool: TaskTool | AssignedTaskTool, host: TaskToolHost, toolCallId: string, input: TaskCall, signal: AbortSignal): Promise<AgentToolResult<TaskToolDetails>>
```

(`yieldParameters` is implementation-local: `{ reason: string }`, non-empty, no extras. `isYieldTool` requires an object constructed by `new YieldTool()`, not a same-named tool or spread copy; the same branding applies to `isTaskTool`/`isAssignedTaskTool`. Implementation-local `launchSchema`: `{ context: string; tasks: { name?: string; task: string; model?: { provider: string; modelId: string }; tools?: string[] }[] }`; required shared `context` prefixes each task, at least one task, non-blank strings, no extras. `taskParameters`/`assignedParameters` form one model-facing object with optional launch and/or decision fields (`action`, `id`, `attempt`). Validate each call against the exact launch (free-form only), `{}` (assigned only) or decision shape (`attempt`: positive safe integer).)

(`UpstreamLspTool`, `UpstreamLspToolDetails`, `LspToolFields`, `TUnsafe` are implementation-local. `LspTool` is a factory object plus a tool type, not a constructible class.)

Native factories by capability: `read`, `bash`, `edit`, `release`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`. Verbatim signature excerpts: `ReadToolDetails`, `NativeGrepToolDetails`, `FindToolDetails`, `BoundedToolDetails`, `Ast*Result`, `DiffStreamResult`, `*Schema` values and `createPi*` upstream factories are signature references, not importable namespace types. `HashlineEditDetails` is exported:

```text
export const ReadTool = {
  create(
    cwd: string,
    store: EditStore,
    native: NativeModule,
    mux: NativeMux,
  ): AgentTool<
    ReturnType<typeof createPiReadTool>["parameters"],
    ReadToolDetails | undefined
  >
};

export const BashTool = {
  create(
    cwd: string,
    options: BashToolOptions & {
      operations: NonNullable<BashToolOptions["operations"]>;
    },
  ): AgentTool<any>
};

export const EditTool = {
  create(
    cwd: string,
    store: EditStore,
    native: NativeModule,
    mux: NativeMux,
  ): AgentTool<typeof editSchema, HashlineEditDetails>
};

export const ReleaseTool = {
  create(
    cwd: string,
    mux: NativeMux,
  ): AgentTool<typeof releaseSchema, undefined>
};

export const GrepTool = {
  create(
    cwd: string,
    store: EditStore,
    native: NativeModule,
    mux: NativeMux,
  ): AgentTool<
    ReturnType<typeof createPiGrepToolDefinition>["parameters"],
    NativeGrepToolDetails
  >
};

export const FindTool = {
  create(
    cwd: string,
    native: NativeModule,
    mux: NativeMux,
  ): AgentTool<
    ReturnType<typeof createPiFindTool>["parameters"],
    FindToolDetails | undefined
  >
};

export const AstGrepTool = {
  create(
    cwd: string,
    native: NativeModule,
    mux: NativeMux,
  ): AgentTool<typeof astGrepSchema, BoundedToolDetails<AstFindResult>>
};

export const AstEditTool = {
  create(
    cwd: string,
    native: NativeModule,
    mux: NativeMux,
  ): AgentTool<typeof astEditSchema, BoundedToolDetails<AstReplaceResult>>
};

export const DiffTool = {
  create(
    native: NativeModule,
  ): AgentTool<typeof diffSchema, BoundedToolDetails<DiffStreamResult>>
};
```

Prefer `tools.ToolCollection.create(cwd, { policy })`: it builds all eight tools; `read`, `grep`, `edit` share one provenance store. Policies compare by identity: compose once (`tools.Policy.and(tools.LockPolicy, custom)`) and pass that object to the collection and every using node/graph. LSP is separate; `tools.write` and `tools.ls` do not exist.

Tool selection and ownership:

- **Pure prompt/review agents: explicit `tools: []`.** Omitted `tools` acquires the native collection plus `task`, `yield`, `recv`, `send`, `info`. Arrays replace defaults: input-consuming graph agents need `new tools.RecvTool()`; senders need `new tools.SendTool()` and usually `new tools.InfoTool()`.
- **Voluntary suspension** requires real `new tools.YieldTool()` in explicit arrays, never a same-named tool. Execution returns only its reason; `JuncoAgent` pauses, plain Pi agents continue. Only this tool pauses voluntarily; `task`, `recv`, `send`, `info`, `schedule` never pause.
- **Subagents** require real `new tools.TaskTool()` and a graph-registered caller; outside graphs, calls fail as ordinary tool errors. Success returns handles immediately and continues the run; children start at the caller's next `yield`, policy pause or run completion. Instruct callers awaiting reports to `yield`. Then node state becomes a `graph.JuncoGraph.spawn` graph rooted at the same caller, one child per task. Completed `task_result` reports (`id`, `attempt`, …) arrive as follow-ups; one `task_batch_complete` follows once all launch tasks complete or are ignored. The node returns the caller's answer only after it answers every delivered report/marker. Children inherit caller model, active tools and registered MCP definitions (fresh servers each), unless tasks specify `model` or narrower `tools`. For workflow-owned assignments, `await agent.setTaskBatch(input)` then instruct `task({})`: admitted at most once, no copied payload. `agent.setTaskFailurePolicy(...)`: `"ignore"` silently drops failures; `{ retries: n }` (default `n = 0`) retries only the failed task in fresh children, then sends `decisionRequired`. Before finishing, resolve it with `task({ action: "retry" | "ignore", id, attempt })` or get `Task failure decisions required: …`. Dispose failed attempts once; teardown failure (`JuncoAgentCleanupError`) and cancellation propagate.
- **Semantic navigation:** `await tools.LspTool.create(process.cwd(), { readOnly: true })` for read-only roles; mutating LSP only for editing roles. Requires Bun and caller-installed language-server binaries; uses host filesystem/process access, not the native sandbox.
- **Native coding tools** require the built native addon and existing dedicated Btrfs seed (writable parent, `user_subvol_rm_allowed`). Both `ToolCollection.create` and omitted agent `tools` require it; no ordinary-filesystem fallback. Report missing prerequisites, never silently substitute tools.
- **Ownership.** Explicit arrays are caller-owned. Guard sequential acquisition so later constructor failures close earlier resources. Drain/close graph members first; after all process-wide LSP users finish call `LspTool.shutdown()` once; then close owned collections. Each `ToolCollection` owns its ShellMux/policy; borrowing agents, graphs, coroutines and MCP connections take their own `lease()` and release only that hold, never close the collection. Final release (usually creator `close()` or root graph of `graph.JuncoGraph.create`) closes the mux. Keep resources outside multi-round loops with persistent agents.

### mcp

Verbatim signature excerpts (`StdioTransportOptions` and `McpClientOptions` are `@earendil-works/pi-mcp` types):

```text
export type JuncoMcpServerOptions = {
  readonly name: string;
  readonly type: "stdio";
  readonly clientOptions?: Omit<McpClientOptions, "name" | "version">;
} & StdioTransportOptions;

export interface JuncoMcpConnectOptions {
  readonly cwd?: string;
  readonly collection?: ToolCollection; // required by a nonempty definition; borrowed via lease()
  readonly signal?: AbortSignal; // cancels acquisition only (McpAbortError)
  readonly discardOnClose?: boolean; // close by cancelling: server effects never publish
}

export type JuncoMcpToolIdentity = { readonly serverName: string; readonly originalToolName: string };
export function getJuncoMcpToolIdentity(tool: AgentTool): JuncoMcpToolIdentity | undefined;

export interface JuncoMcpConnection {
  readonly tools: AgentTool[];
  close(): Promise<void>;
}

export class JuncoMcpTools {
  constructor();
  static add(options: JuncoMcpServerOptions): JuncoMcpTools;
  add(options: JuncoMcpServerOptions): this;
  get size(): number;
  connect(options?: JuncoMcpConnectOptions): Promise<JuncoMcpConnection>;
  snapshot(): JuncoMcpTools; // detached copy; acquires nothing
}
```

- **Declare a server** with `mcp.JuncoMcpTools.add({ name, type: "stdio", command, args })`; chain `.add(...)` for multiple servers. `command` resolves through `PATH`; `args` pass literally, never through a shell. Optional: `cwd` (relative to the connecting agent's `cwd`, must exist inside the seed), `env` (merged over parent environment; `inheritEnv: false` passes only `env`), `stderr`/`onStderr`, `closeTimeoutMs`, `clientOptions` (e.g. `{ requestTimeoutMs: 300_000 }` for slow startup; pi-mcp defaults to 30 seconds). `name` must be nonblank and unique per definition; it supplies `<server>` in tool names.
- **Pass the definition to an agent factory:** `tools: [servers]`, optionally mixed with concrete tools. Definition starts nothing; each agent connects its own client/server from its `cwd` and closes both on agent close. Subagents reconnect fresh servers from caller-definition snapshots. Use published `mcp__<server>__<tool>` names in `activeToolNames`.
- **Direct use:** `const connection = await servers.connect({ cwd, signal, collection })`; use `connection.tools`, then `await connection.close()` in `finally`. `signal` cancels acquisition only (`McpAbortError`), stopping already-started servers; returned connections ignore it.
- **Stdio only.** Each server is an audited job under the supplied collection's ShellMux/policy (requires the native addon and a Btrfs seed containing `cwd`); nonempty definitions without a collection reject with `TypeError`. Effects publish only at server exit; refused publication rejects agent/connection close with `MARSH_POLICY_DENIED`. Replies do not prove publication. Servers snapshot state at startup: another server publishing to a path this server read or wrote makes its close fail, even if it wrote nothing. Prepare shared state before startup; a server kept running across another's publication may not close cleanly.

### schedules

Core `junco-scheduler` exports work-selection operators, the `strength` model-rung combinator, derived policies, resource combinator `limit`, comparators `lowest`/`highest`, decision helpers, the context pair/factory and types (including native `DataflowObservation`), with no runtime Pi peers. `junco-agency`'s `schedules` adds the agency-aware context bridge and optional `pi`. Native matrix/read types are engine execution formats, not another policy API.

Verbatim signature excerpts (core language):

```text
export const MODEL_STRENGTHS = ["smol", "low", "med", "high", "xhigh"] as const;
export type ModelStrengthName = (typeof MODEL_STRENGTHS)[number];
export type ModelStrength = 0 | 1 | 2 | 3 | 4;
export const DEFAULT_MODEL_STRENGTH: ModelStrength = 2;
export type NodeModel = { readonly nodeId: NodeIdType; readonly modelStrength: ModelStrength };
export type Decision = { readonly selected: readonly NodeModel[] };
export const select: (ids: Iterable<NodeIdType>, modelStrength?: ModelStrength) => NodeModel[];
export const nodeIds: (selected: readonly NodeModel[]) => NodeIdType[];
export function strength<S, N, T, C>(
  assign: (snapshot: Snapshot<S, N, T, C>, nodeId: NodeIdType) => ModelStrengthName,
  inner: Scheduler<S, N, T, C>,
): Scheduler<S, N, T, C>;

export type Snapshot<S, N, T, C> = DataflowObservation<S, N, T> & {
  readonly available: ReadonlySet<NodeIdType>;
  readonly owned: ReadonlySet<NodeIdType>;
  readonly context: ReadonlyMap<NodeIdType, C>;
  /** Input consumption planned for each available node in this decision. */
  readonly plans: ReadonlyMap<NodeIdType, InputSchedule>;
  readonly history: readonly Decision[];
  readonly threads: number;
};

export type Scheduler<S, N, T, C> = (
  snapshot: Snapshot<S, N, T, C>, signal?: AbortSignal,
) => Decision | Promise<Decision>;

export function choose<S, N, T, C>(options: {
  readonly where?: (snapshot: Snapshot<S, N, T, C>, node: NodeIdType) => boolean;
  readonly rank: (snapshot: Snapshot<S, N, T, C>, left: NodeIdType, right: NodeIdType) => number;
  readonly width?: (snapshot: Snapshot<S, N, T, C>) => number;
}): Scheduler<S, N, T, C>;

export function separate<S, N, T, C>(
  leftOwns: (snapshot: Snapshot<S, N, T, C>, node: NodeIdType) => boolean,
  left: Scheduler<S, N, T, C>, right: Scheduler<S, N, T, C>,
): Scheduler<S, N, T, C>;

export function agent<S, N, T, C>(invoke: (
  snapshot: Snapshot<S, N, T, C>, signal?: AbortSignal,
) => Promise<readonly (readonly NodeIdType[])[]>): Scheduler<S, N, T, C>;

export function parallel(): <S, N, T, C>(
  snapshot: Snapshot<S, N, T, C>, signal?: AbortSignal,
) => Decision | Promise<Decision>;

export function roundRobin(order?: readonly NodeIdType[], width?: number): ReturnType<typeof parallel>;

export type SchedulerContext<S, N, T, C, G extends DataflowGraph<S, N, T, never>> = {
  readonly scheduler: Scheduler<S, N, T, C>;
  readonly graph: G;
  step(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeIdType, T>>;
  run(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeIdType, T>>;
};

export function context<
  S, N, T, C = never,
  G extends DataflowGraph<S, N, T, never> = DataflowGraph<S, N, T, never>,
>(options: {
  readonly scheduler: Scheduler<NoInfer<S>, NoInfer<N>, NoInfer<T>, NoInfer<C>>;
  readonly graph: G & DataflowGraph<S, N, T, never>;
  readonly describeNode?: (id: NodeIdType, candidate: NodeAvailability<N, T>) => C | undefined;
  readonly readInputs?: (id: NodeIdType, candidate: NodeAvailability<N, T>) => InputSchedule;
  readonly prepare?: (selected: readonly NodeModel[], signal?: AbortSignal) => void | Promise<void>;
}): SchedulerContext<S, N, T, C, G>;
```

`S/N/T` and concrete `G` infer from the graph; metadata `C` from `describeNode`. Policies cannot widen them. Without a hook, metadata defaults to empty `ReadonlyMap<NodeIdType,never>`; explicit metadata types also allow empty maps. Only `undefined` omits metadata; `0`, `false`, `null`, `""` remain values. Native state/message/result types cannot be erased. A universally callable `parallel()` or `roundRobin()` works across graph/metadata domains. Standalone data-aware policies need contextual `Scheduler<S,N,T,C>` typing or all four type arguments.

**Decisions.** `choose` filters/ranks available owned candidates and takes width (default 1), evaluated once: a non-negative integer or positive Infinity. Comparators must return numbers other than NaN; ties use JavaScript string `<`/`>` order, never locale collation. `parallel` selects all candidates in insertion order, unsorted/unthrottled. `roundRobin` copies a duplicate-free explicit order or sorts owned native IDs; its cursor comes from the latest ordered selection in projected history, never mutable policy state. Empty explicit orders abstain. Priority/FIFO use caller-metadata rankings; descending score: `(s,a,b) => score(s,b)-score(s,a)`. Nondeterministic choice and `await primary(snapshot,signal)` plus conditional fallback need no new operator.

**Authority, not effects.** `separate` partitions each incoming owned ID once before either child starts. Children receive complementary ownership and ordered history projected to their domains, dropping empty events; native node/input/result maps, links, availability, metadata, version and threads stay shared. Both start as promise jobs even on synchronous throws, and both drain before the leftmost failure propagates or selections concatenate left then right. Cancellation checks precede invocation and follow draining; the exact signal reason wins.

Exclusive selection authority is the separation resource: disjoint domains union; empty authority is the unit. Successful children must return well-shaped, unique, available owned IDs; sibling-authority escapes fail even when globally available. Ordered concatenation is observable/noncommutative. Authority safety guarantees neither thread feasibility, non-empty progress, fairness nor effect/JavaScript-memory/service isolation. Frame and ordered associativity/unit laws require total deterministic owned-local readonly callbacks; global observations or mutated borrowed values may break frame stability. Empty-domain children still run and may throw. The fast-check CSL suite seeks law counterexamples, not proof of purity or universal liveness.

**Observation ceiling.** `graph.observe()` includes done/unavailable nodes, empty descriptions, every link tuple, input membership/order and retained results. Containers, primitives, input queue arrays and history are detached readonly snapshots; opaque `S/N/T` values are borrowed identities, never deep-cloned/frozen. Metadata is trusted readonly application data. Policies only read borrowed values; use immutable data to preserve historical contents. Native mutations/admission/settlement advance version (Source admission/consumption also advances agency observations); reads do not. Direct writes through retained native nodes/transports or opaque objects are untracked. Metadata is fresh each decision, independent of native caching.

**Driving.** Pairing captures only `{ scheduler, graph }` and fresh context-local history: no observation, binding, provider request, work registration or graph backreference. `step()` makes at most one current decision; `run()` repeats until native availability is empty; neither invokes policies at quiescence. Each complete drive enters `graph.evaluate` before planning, tracing provider/node/port lifetime under the native single-flight gate. Contexts may share graphs, but overlapping drives reject before competing policies run; reused policies retain independent context histories. After pure read lowering, stale versions/live availability reject without retry or consuming inputs. Shape, duplicate, authority, availability, native capacity and read errors precede effects. Empty top-level decisions with available work fail; abstaining branches with progressing siblings are valid. Each decision lowers to one native column; actual started IDs commit once after draining, even on node failure. Native `Schedule` is lanes × turns for direct serial scope-bound executor calls, with native validation/draining—not a second policy language.

**Agency bridge.** Below, `context` means `schedules.context`, not the native core factory. It preserves concrete graph subtypes, uses agency unseen-value/task-inbox reads and real agent-sidecar metadata; ports get no invented agent metadata. `NodePolicy` is implementation-local; `AgencyNodeMetadata` is public:

```text
export type AgencyNodeMetadata = Readonly<Pick<NodePolicy, "lastYield"> & {
  agentStatus?: NonNullable<NodePolicy["agent"]>["status"];
}>;

export function context<N, T, G extends JuncoGraph<N, T, never>>(options: {
  readonly scheduler: Scheduler<NoInfer<Agentic<N, T>>, NoInfer<N>, NoInfer<T>, AgencyNodeMetadata>;
  readonly graph: G & JuncoGraph<N, T, never>;
  readonly ladder?: Ladder;
}): SchedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, G>;
```

`Ladder` is `Readonly<Record<ModelStrengthName, LadderRung>>`; each rung is `{ readonly model: string; readonly thinking?: ThinkingLevel }`. `validateLadder` checks all five model identities. Selected prompt agents receive their rung before execution; omitted thinking means `"off"`. Without a ladder the context leaves models untouched.

**Stateless model oracle.** `junco-scheduler/agent` exports only `pi`, `PiOptions`, `SchedulerRequest`; `schedules.pi` reexports them for agency callers. `Models`, `Model`, `Api` and stream option types come from `@earendil-works/pi-ai`:

```text
export type PiOptions = {
  readonly models: Pick<Models, "completeSimple">;
  readonly model: Model<Api>;
  readonly systemPrompt?: string;
  readonly prompt?: string;
  readonly streamOptions?: Omit<ModelsSimpleStreamOptions, "signal">;
};

export type SchedulerRequest<C> = {
  readonly version: number;
  readonly threads: number | null;
  readonly nodes: readonly Readonly<Pick<Node<never, never, never>, "id" | "status" | "description">>[];
  readonly context: readonly (readonly [NodeIdType, C])[];
  readonly history: readonly Decision[];
};

export function pi(options: PiOptions): ReturnType<typeof parallel>;
```

`pi` uses core `agent(invoke)`: one `models.completeSimple(model,context,options)` per current decision, forwarding the graph signal. It owns no model runtime, session, iterator, persistent conversation or lifecycle resource and has no fixed/default model. The final user message starts exactly `SchedulerSnapshot:\n`, preceded by any caller prompt. Encoding includes only available-owned native IDs/status/defined descriptions (including `""`), defined external `[id,C]` metadata, projected history, version and threads (`null` for Infinity)—never native state, inputs, retained results or queues. Metadata must be JSON-serializable; stringify failures precede provider calls. For data-aware models use `agent` with an intentional summary.

Require exactly one `schedule({ waves: string[][] })` tool call and native `stopReason === "toolUse"`. Strict schemas reject numeric IDs, unknown/extra keys and malformed calls before graph work. `agent` scans waves in order, stable-deduplicates/filters to available owned IDs and selects the first non-empty wave; later waves are never cached. No available owned work means no oracle call. Provider errors/cancellation propagate: no retries, text-only completions, silent repair or fallback. Judge models/random oracles by each actual normalized response, not equality across independent invocations.

For a model-driven agency with an already-acquired `worker` and resolved `models`/`model`, build its real boundary explicitly:

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as O from "fp-ts/lib/Option.js";
import { graph, schedules, tools } from "junco-agency";

const terminal = graph.NodeId.create("worker");
const final = graph.Edge.value<graph.nodes.AgenticInput, AssistantMessage>("worker->$sink");
const source = new graph.nodes.Source<graph.nodes.AgenticInput, AssistantMessage>(() => {
  throw new graph.DataflowDefinitionError("Worker workflow does not accept external input");
}, { id: graph.NodeId.create("$source") });
const sink = new graph.nodes.Sink<graph.nodes.AgenticInput, AssistantMessage>(async function* (): graph.NodeGenerator<graph.nodes.AgenticInput, AssistantMessage> {
  yield [];
  const result = execution.graph.result(terminal);
  if (!O.isSome(result)) throw new Error("Worker did not produce a result");
  return result.value;
}, { id: graph.NodeId.create("$sink"), trigger: graph.trigger.TriggerRule.when(final) });
const execution = schedules.context({
  graph: new graph.JuncoGraph(source, sink, graph.Width.create(1), graph.UNBOUNDED, undefined, tools.LockPolicy),
  scheduler: schedules.pi({ models, model, systemPrompt: "Coordinate the work.", prompt: "Complete the assignment." }),
});
execution.graph.addNode({ id: terminal, state: worker, policy: tools.LockPolicy,
  trigger: graph.trigger.TriggerRule.always() });
execution.graph.addEdge(terminal, sink.id, final);
try { await execution.run(); }
finally {
  try { await execution.graph.close(); } finally { await execution.graph.tracer.flush(); }
}
```

Use `schedules.parallel()` in the same external pair for deterministic select-all; `schedules.roundRobin()` with thread bound 1 for one-at-a-time fairness. Never pass policies to graph constructors. Manually orchestrated persistent-agent rounds may use fresh graph/context/ports and reuse members; close round graphs only after members' final owning use. The Ralph workflow instead re-arms one agent in the same graph/session through its value self-edge and `schedules.ralph` hooks. Compact only the requested settled round graph; close resources and flush shared tracing once at orchestration end. Scheduling needs no session acquisition/close.

### Resource profiles and schedules

A profile predicts one node activation's cost in a fixed dimension; resource policies read snapshot predictions. Import constructors, units and profile types from `dataflow-engine` (a public `junco-agency` dependency, not re-exported by `graph`); policies are `schedules.limit`, `schedules.lowest`, `schedules.highest`.

Verbatim signature excerpts (`dataflow-engine`; `Quantity`/`Unit` are `@buge/ts-units` types, `seconds` for runtime comes from `@buge/ts-units/time`):

```text
export const RESOURCES = { memory: Information, runtime: Time, tokens: Tokens } as const;
export type ResourceKind = keyof typeof RESOURCES;
export type ResourceUnit<R extends ResourceKind> = Unit<number, DimensionOf<R>>;
export type ResourceQuantity<R extends ResourceKind> = Quantity<number, DimensionOf<R>>;
export type Measure = "bytes" | "count" | "tokens";
export type PortFeature =
  | { readonly port: EdgeId; readonly measure: Measure }
  | { readonly derived: "sum" | "max"; readonly measure: Measure; readonly ports: readonly EdgeId[] };
export type FeatureVector = readonly number[];
export type Estimate = {
  readonly value: number;
  readonly safe: number;
  readonly source: "model" | "fallback";
  readonly reason?: "out_of_range" | "low_r2" | "few_samples" | "constant";
};
export interface ProfileData<R extends ResourceKind = ResourceKind> {
  readonly resource: R;
  readonly unit: ResourceUnit<R>;
  readonly features: readonly PortFeature[];
  predict(x: FeatureVector): Estimate;
}
export type Profiles<K extends ResourceKind> = { readonly [R in K]: ProfileData<R> };
export type ProfilesOption<K extends ResourceKind> =
  [K] extends [never] ? { readonly profiles?: Profiles<never> } : { readonly profiles: Profiles<K> };
export type ProfileSet = { readonly [R in ResourceKind]?: ProfileData<R> };
export function constantProfile<R extends ResourceKind>(resource: R, quantity: ResourceQuantity<NoInfer<R>>): ProfileData<R>;
export const bytes: Unit<number, Information>; // also kilobytes, megabytes, gigabytes, kibibytes, mebibytes, gibibytes
export const tokens: Unit<number, Tokens>;
```

Units are callable: `megabytes(3000)` is a `ResourceQuantity<"memory">`; `megabytes(3000).in(gigabytes).amount` is `3`.

Verbatim signature excerpts (`junco-scheduler`, re-exported by `schedules`; `Rank` is implementation-local):

```text
type Rank = <S, N, T, C>(snapshot: Snapshot<S, N, T, C>, left: NodeIdType, right: NodeIdType) => number;
export function lowest(kind: ResourceKind): Rank;
export function highest(kind: ResourceKind): Rank;
export function limit<S, N, T, C>(
  limits: { readonly memory: ResourceQuantity<"memory"> },
  scheduler: Scheduler<S, N, T, C>,
): Scheduler<S, N, T, C>;
```

Verbatim signature excerpts (package top level; test doubles for credential-free resource runs, not for generated workflows):

```text
export type MockUsage = { readonly [R in "memory" | "tokens"]?: ResourceQuantity<R> };
export function constantProfiles(usage: MockUsage): ProfileSet;
export const NO_USAGE: ProfileSet; // zero memory and zero tokens
export class MockJuncoGraph<N = AgenticInput, T = AssistantMessage, EH = never> extends JuncoGraph<N, T, EH>
  override addNode(spec: AgenticNode<N, T>): NodeIdType
```

- **Profiles are registration data.** Put `profiles` beside `trigger` in `NodeOptions`: `{ ...options, state, policy, profiles: { memory: constantProfile("memory", megabytes(3000)) } }`. Keys must match profile `resource`; otherwise `addNode` throws `Dataflow node "<id>" maps resource "<kind>" to a profile for "<resource>"`. Native `DataflowGraph<…, K>` with `K = "memory"` requires every node's `profiles.memory` at compile time. `JuncoGraph` uses `K = never`: agents, coroutines, nested contexts and full specs from `JuncoGraph.map`/`spawn` opt in individually, without completeness checks. `Source` accepts no `profiles`; `Sink` discards its options' `profiles`. Neither port, `JuncoAgent` nor `Deterministic` carries its own profiles. `graph.observe().nodes` exposes node `profiles` as `ProfileSet`.
- **Constant costs.** The engine's only constructor, `constantProfile(kind, quantity)`, takes a finite non-negative amount (including zero) in its own unit; it has `features: []` and every `predict` returns the same frozen `{ value, safe, source: "fallback", reason: "constant" }`. Invalid amounts throw `DataflowDefinitionError("constantProfile: <kind> must be a finite non-negative quantity")`. Dimensions are typed: `constantProfile("memory", tokens(1))` cannot compile. Task-supplied predictors may use hand-written `ProfileData`; keep `predict` pure.
- **Fitted costs.** Add separate workspace package `dataflow-profile` to workflow dependencies; `junco-agency` does not depend on it. `profilesOf(parseProfiles(readFileSync(path, "utf8")), "<node>", ["memory"]).memory` loads a fitted record whose `features` name inbound **message** edge IDs measured by `count`. Evaluation rejects ports other than that node's inbound message edges. Estimating `bytes`/`tokens` throws `estimate: node "<id>" profile "<kind>" measures "<measure>" on port "<port>"; only "count" features can be estimated from a planned batch`. Counts use `snapshot.plans` (this decision's planned consumption), not whole queues.
- **`limit({ memory }, inner)`.** Calls `inner`, validates its decision, then visits selected IDs in order, admitting nodes whose `safe` memory in base units (`safe * unit.scale`) fits with prior admissions: Σ safe ≤ allowance per concurrent column. Nonfitting nodes stay available; if none fit, throws `limit: node "<id>" needs memory=<quantity> alone, exceeding <allowance>`. Every selected node requires a `memory` profile (`limit: node "<id>" has no memory profile`); allowance must be finite/positive (`limit: memory must be a positive quantity`). Retained memory across yields is untracked: leave headroom. Wrap the outermost policy; wrapping one `separate` branch gives that branch the whole allowance.
- **`choose({ rank: lowest(kind) })` / `highest(kind)`.** Rank available owned work by predicted `safe` base-unit cost, breaking ties by raw ID. Comparators cache one prediction/node/snapshot and are reusable across decisions. Comparing an unprofiled candidate throws `lowest: node "<id>" has no <kind> profile` (or `highest: …`); lone candidates require no comparison, so this cannot check completeness. `width: () => 1` starts only the cheapest. With positive-cost racers, a zero-cost `anyOf` consumer wins the next decision once a racer emits; losers gated on the winner never start.
- **Agency graphs: separate the ports.** Unprofiled `$source`/`$sink` fail `limit` when selected and `lowest`/`highest` when compared. Partition authority: `schedules.separate((_snapshot, id) => id === source.id || id === sink.id, schedules.parallel(), <limited or ranked policy>)`. Ports run unbounded (zero cost); members obey the bound, with the limited branch retaining the full allowance. Put task-uncosted members in the unbounded branch too; never fabricate policy-satisfying costs.
- **Credential-free resource behavior.** `new MockAgent({ runs, usage: { memory: megabytes(3000), tokens: tokens(100) } })` exposes constant `.profiles`; invalid amounts throw `JuncoAgentError` `invalid_argument`. `MockJuncoGraph` attaches mock members' declared profiles and `NO_USAGE` to all other unprofiled nodes, including ports: `limit`/`lowest`/`highest` can select these memory/tokens zero-cost defaults. Explicit non-empty `profiles` replace defaults wholesale; partial sets never merge and must cover the policy's resource. Tests/demos only; generated workflows register `agent.JuncoAgent` with explicit `profiles`.

For an agency whose members `a`–`d` (already-acquired `agent.JuncoAgent`s with staged prompts, held in `members: Record<"a" | "b" | "c" | "d", agent.JuncoAgent>`) peak at 3000/3000/2000/1000 MB under a 4 GB allowance:

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { constantProfile, gigabytes, megabytes } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { graph, schedules, tools } from "junco-agency";

type Policy = schedules.Scheduler<graph.nodes.Agentic, graph.nodes.AgenticInput, AssistantMessage, schedules.AgencyNodeMetadata>;
const costs = { a: 3000, b: 3000, c: 2000, d: 1000 } as const;
const terminal = graph.NodeId.create("d");
const final = graph.Edge.value<graph.nodes.AgenticInput, AssistantMessage>("d->$sink");
const source = new graph.nodes.Source<graph.nodes.AgenticInput, AssistantMessage>(() => {
  throw new graph.DataflowDefinitionError("Bounded workflow does not accept external input");
}, { id: graph.NodeId.create("$source") });
const sink = new graph.nodes.Sink<graph.nodes.AgenticInput, AssistantMessage>(async function* (): graph.NodeGenerator<graph.nodes.AgenticInput, AssistantMessage> {
  yield [];
  const result = execution.graph.result(terminal);
  if (!O.isSome(result)) throw new Error("d did not produce a result");
  return result.value;
}, { id: graph.NodeId.create("$sink"), trigger: graph.trigger.TriggerRule.when(final) });
// Ports carry no profiles: they schedule in the unbounded branch, members under the 4 GB column bound.
const scheduler: Policy = schedules.separate(
  (_snapshot, id) => id === source.id || id === sink.id,
  schedules.parallel(),
  schedules.limit({ memory: gigabytes(4) }, schedules.parallel()),
);
const execution = schedules.context({
  graph: new graph.JuncoGraph(source, sink, graph.Width.create(1), graph.UNBOUNDED, undefined, tools.LockPolicy),
  scheduler,
});
for (const [name, megabyteCost] of Object.entries(costs) as [keyof typeof costs, number][]) {
  execution.graph.addNode({
    id: graph.NodeId.create(name), state: members[name], policy: tools.LockPolicy,
    trigger: graph.trigger.TriggerRule.always(),
    profiles: { memory: constantProfile("memory", megabytes(megabyteCost)) },
  });
}
execution.graph.addEdge(terminal, sink.id, final);
try { await execution.run(); }
finally {
  try { await execution.graph.close(); } finally { await execution.graph.tracer.flush(); }
}
```

Member columns admit `a` and `d` together (4000 MB), then `b`, then `c`; `a` and `b` never share a column. Cheapest-first racing swaps the limited branch for `schedules.choose({ rank: schedules.lowest("tokens"), width: () => 1 })` with `profiles: { tokens: constantProfile("tokens", tokens(n)) }` on each racer and `tokens(0)` on the `anyOf` join; the runnable native versions of both graphs are `packages/dataflow-engine/examples/resource-scenarios.ts` (reading material, never an import path).

### Graph compaction

Verbatim signature excerpts (`CompactionPolicy` is exported at the package root and as `graph.nodes.CompactionPolicy`):

```text
export type CompactionPolicy =
  | "all"
  | "more-than-forty"
  | "all-available"
  | "more-than-forty-available";

// graph.JuncoGraph:
  static async compact<
    A extends Agentic<N, T>,
    N,
    T,
    EH,
  >(
    graph: DataflowGraph<A, N, T, EH>,
    policy: CompactionPolicy,
  ): Promise<void>
  compact(policy: CompactionPolicy): Promise<void> // JuncoGraph.compact(this, policy)
```

- `"all"`: every direct prompt-agent node state. `"more-than-forty"`: those whose context is strictly above 40% of their model's context window. `"all-available"`: direct agents in one current `available()` snapshot. `"more-than-forty-available"`: the intersection.
- Selection is frozen before dispatch; successful siblings stay compacted if another fails; failures aggregate as `AggregateError("Graph compaction failed")`. An unknown policy or unmeasurable context capacity fails rather than falling back.
- Not recursive into child graphs. Contexts/policies are not work nodes or compaction targets.
- Perform requested maintenance between settled rounds. Compaction sends each selected agent a model summarization request. Running agents compact only after their run ends: drive suspended/running members to settlement before awaiting queued compaction. Never add compaction to short workflows by default.

### tracer

Verbatim signature excerpts:

```text
export interface DataflowTracer {
  startRun<S, N, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T>;
  complain(nodeId: NodeId, complaint: string): void;
  flush(): Promise<void>;
}

export type DataflowRunTrace<N, T> = {
  startNode(
    id: NodeId,
    phase: "prime" | "resume",
    inputs: ParentView<N, T> | undefined,
  ): DataflowStepTrace<N, T>;
  end(results: ReadonlyMap<NodeId, T>): void;
  fail(error: unknown): void;
};

export type DataflowStepTrace<N, T> = {
  end(step: IteratorResult<readonly Message<N>[], T>): void;
  fail(error: unknown): void;
};

export class DummyTracer implements DataflowTracer
  startRun<S, N, T, EH>(
    _graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T>
  complain(_nodeId: NodeId, _complaint: string): void
  flush(): Promise<void>

export class TuiTracer implements DataflowTracer
  private constructor(name: string)
  static shared(): DataflowTracer
  static create(name: string = "JuncoGraph.run"): Promise<TuiTracer>
  startRun<S, N, T, EH>(graph: DataflowGraph<S, N, T, EH>): DataflowRunTrace<N, T>
  complain(nodeId: NodeIdType, complaint: string): void
  flush(): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
```

`DataflowTracer` is an interface a backend implements; never `new` it.

- **A `JuncoGraph` always has a tracer.** Argument five (after source, sink, window, threads) is `DataflowTracer` or `undefined`, then authorization policy. `undefined` selects `tracer.TuiTracer.shared()`; explicit Dummy/custom/Opik observers win. Plain `DataflowGraph` accepts an optional observer third. Opik is a separate package, never a namespace export. Ordinary runtime tests, even in real terminals, use explicit `new tracer.DummyTracer()`.
- **Backend selection and acquisition.** `tracer.TuiTracer.shared()` returns a lazy shared `JuncoGraph.run` TUI only with TTY stdin/stdout and `TERM !== "dumb"`; otherwise a silent stateless Dummy. Passive construction/`spawn` are synchronous, acquiring no terminal/native resources and emitting nothing; the first callback initializes. Explicit `await tracer.TuiTracer.create("My workflow")` rejects unsuitable terminals before native import; initialization errors surface, never fall back. Only one TUI owns the terminal. Later acquisition may create a fresh shared instance; old callbacks never reopen it.
- **Display and children.** Stacked panes show `JuncoGraph` topology above live `Agent traces`; layout persists until topology changes. Stable identity colors and scoped `[g<serial>:<NodeId>]` badges distinguish duplicate local IDs. Green means currently executing scheduled nodes, not merely available/yielded. Live member text, thinking, tool progress, outcomes and complaints ignore `LOG_LEVEL`. Snapshotted payloads may be sensitive; bounded display history is not persisted history. Ralph/promoted task children inherit parent tracing. Share the explicit instance with separately constructed nested graphs; explicitly different child observers remain unchanged.
- **Terminal ownership and operational logs.** Never write directly to stdout/stderr under TUI ownership. Capture MCP stderr (`stderr: "pipe"`, after config spreads); print final results after restoration. Admitted `junco-tools/log` records go exclusively to the trace pane. `LOG_LEVEL` controls operational/policy logs, not TUI lifecycle/agent records: default INFO; trimmed case-insensitive `SILLY`, `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`; invalid/numeric names reject at startup. Policy violations stay INFO, tentative grants DEBUG. `flushLog()` is a draw barrier, not interactive completion: tool cleanup never waits for dismissal.
- **Callbacks** are synchronous readonly observers. `startRun` fires once/native `evaluate` scope, including complete context drives/planning; `startNode` per activation, phase `"prime"` (no input view) or `"resume"` (delivered view). `end` receives cumulative results; `fail` the exact rejection/raw activation cause. `complain` reports agent issues independently of drives. Unlike detached policy containers, tracer views/result maps are live: snapshot retained data. Observer exceptions warn without changing computation.
- **Flushing** is caller-owned, separate from disposal:
  `try { await execution.run(); } finally { try { await execution.graph.close(); } finally { await execution.graph.tracer.flush(); } }`.
  Share observers across children; flush each distinct observer once after all users stop (collect in a `Set`). TUI `flush()` draws the final frame, awaiting `q`/Esc to restore the terminal. Early `q`/Esc dismisses without cancellation; Ctrl-C restores before application cancellation. `await tui.close()`/async disposal restores without keyboard dismissal. Unused lazy flush/close is I/O-free; dismissed tracers never reopen. Tab switches pane focus; arrows, PageUp/PageDown, Home/End pan/scroll; End restores trace tail-follow. Successful flush does not prove remote ingestion. `bun run smoke:tui` is a credential-free production-addon smoke (no Btrfs mount). Real Linux PTY coverage: `test/tui-tracer.test.ts` in `test:native`, not ordinary Dummy-backed runtime tests.

### Supporting Pi APIs

Verbatim signature excerpts (`ModelRuntime` from `@earendil-works/pi-coding-agent`):

```text
static create(options?: CreateModelRuntimeOptions): Promise<ModelRuntime>;
refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;
getModel(providerId: string, modelId: string): Model<Api> | undefined;
listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;
```

Verbatim signature excerpts (`@earendil-works/pi-ai`):

```text
export interface ModelsRefreshResult {
    aborted: boolean;
    errors: ReadonlyMap<string, Error>;
}
export interface CredentialInfo {
    providerId: string;
    type: Credential["type"];
}
export declare function contentText(content: string | readonly Content[], separator?: string): string;
export declare function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[];
```

Verbatim signature excerpts (`@earendil-works/pi-agent-core`; `BACKGROUND_CONTEXT` is also exported there):

```text
export interface ModelIdentity {
    provider: string;
    modelId: string;
}
```

```text
constructor(options?: MemorySessionRepoOptions);
create(options: SessionCreateOptions, context: Context): Promise<Session>;
close(context: Context): Promise<void>;
```

(The last three are `MemorySessionRepo` members.)

## Composition patterns

**Feedback recurrence.** Seed with `new EmitOnce(…)`, `TriggerRule.always()`; receive seed/feedback with `TriggerRule.anyOf(TriggerEntry.on(seed), TriggerEntry.on(loop))`; wire `addEdge(id, id, loop)`. The task's finite count ends with `return`: emitting the last value still sends feedback because emit/return require separate activations; the next activation checks the count and returns. Assert the result in the `run()` map. A `new StepNode(…)` sink drains and quiesces without returning. Read the pair with `graph.from`; validate length/types, not non-null assertions. Ten Fibonacci values from `0, 1`: `[0,1,1,2,3,5,8,13,21,34]`.

**Research/review committee.** Persist agents/sessions; each round uses fresh Source/Sink ports and a passive graph with `schedules.parallel()`. Reject source ingress; return final work through the sink. Value edges feed reports to validating staged assignment callbacks; register receiver contracts. For partial handoff, discover the message edge with `info`, `send` by its ID, then `yield`; consume with `anyOf(partial,final)`. A typed verdict tool records `{ approved,feedback }`: take-and-clear once per round; missing verdict fails, prose is not approval. Preserve the requested stop rule without a round cap. Close persistent members after their last owning use, not per-round graphs; flush shared tracing once afterward.

**Mixed nested work.** Emit one `{ kind: "prompt", text }` to an agent and nested wrapper; register `{ ...nodeOptions, state: childContext, contract }` (native state is the actual graph). The child's scheduled Source validates/routes edge-addressed ingress; its Sink waits on final work, stages only final parent-edge messages and returns the exact result, never intermediate drafts. Reviewer uses `TriggerRule.allOf` on required finals and a validating staged assignment callback. Use fresh positional ports per graph and reject outer source ingress. Close the root recursively, then flush separately.

## Executable example

Valid quiescence with a non-returning sink, ordered fan-in, and optional tracing:

```ts
import { graph, schedules, tracer } from "junco-agency";
import { context } from "junco-scheduler";

/**
 * Collects two constants through an ordered fan-in and returns the collected list.
 *
 * Topology: Left --left--> Collector <--right-- Right, then Collector --collected--> Sink.
 * The collector lists inputs in declared order (right, then left), not arrival order.
 * Termination: sources and collector return; the sink never returns, so `run()` ends at valid
 * quiescence with the sink unfinished.
 *
 * @param observer Optional tracer; flushed here because graphs never flush it.
 * @returns The collected numbers, `[9, 7]`.
 */
async function collectPair(observer?: tracer.DataflowTracer): Promise<number[]> {
  const workflow = new graph.DataflowGraph<void, number | number[], string, never>(
    graph.Width.create(1),
    graph.UNBOUNDED,
    observer,
  );
  const execution = context({ graph: workflow, scheduler: schedules.parallel() });
  const leftEdge = graph.Edge.message<number, string>("left");
  const rightEdge = graph.Edge.message<number, string>("right");
  const collectedEdge = graph.Edge.message<number[], string>("collected");
  const captured: number[] = [];

  /** Sources: each publishes one constant once, then returns its name. */
  const left = workflow.addNode(new graph.nodes.ConstFanout(7, [leftEdge], { state: undefined, ret: "left" }));
  const right = workflow.addNode(new graph.nodes.ConstFanout(9, [rightEdge], { state: undefined, ret: "right" }));

  /** Collector: emits one list in input order once every input has delivered. */
  const collector = workflow.addNode(
    new graph.nodes.ConstFanin([rightEdge, leftEdge], collectedEdge, { state: undefined, ret: "collected" }),
  );

  /** Sink: streams every delivered list into `captured`; never returns. */
  const sink = workflow.addNode(
    new graph.nodes.StepNode<void, number | number[], string>(
      (_state, view) => {
        for (const payload of graph.from(view, collectedEdge)) {
          if (!Array.isArray(payload)) throw new Error("Collector emitted a non-array payload");
          captured.push(...payload);
        }
        return [];
      },
      { state: undefined, trigger: graph.trigger.TriggerRule.when(collectedEdge) },
    ),
  );

  workflow
    .addEdge(left, collector, leftEdge)
    .addEdge(right, collector, rightEdge)
    .addEdge(collector, sink, collectedEdge);

  try {
    await execution.run();
    return captured;
  } finally {
    await observer?.flush();
  }
}

console.log(JSON.stringify(await collectPair()));
```

Run with `bun run <file>.ts`; it prints `[9,7]`.
