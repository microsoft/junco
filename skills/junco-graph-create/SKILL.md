---
name: junco-graph-create
description: Create succinct, literate TypeScript Junco workflows using the public graph, agent, tools, mcp, schedulers, and tracer namespaces. Use whenever a user asks to build a Junco workflow or dataflow graph, coordinate agents, implement fan-out/fan-in or feedback loops, or compose deterministic nodes and nested agencies.
---

# Junco graph creation

A Junco workflow is a dataflow graph: nodes are async generators (deterministic code, prompt agents, or nested graphs), edges carry messages or return values, triggers decide readiness, and a scheduler plans which available nodes advance. Generate one short, literate TypeScript program per request.

## Create a workflow

1. **Extract the task shape.** Requested inputs, output, node roles, dependencies, stop condition, tool permissions, and tracing. Use a deterministic node for deterministic computation; use an agent only for judgment or language work. Do not add retries, extra agents, or iteration limits the task did not ask for.
2. **Discover models now, if agents or a Pi scheduler are needed.** Do this while authoring the workflow, never from model IDs in examples or memory. Purely deterministic workflows skip this step.
   1. `const models = await ModelRuntime.create({ allowModelNetwork: true, refreshOnCreate: false })` (from `@earendil-works/pi-coding-agent`).
   2. `const refreshed = await models.refresh({ allowNetwork: true })`; inspect `refreshed.aborted` and the provider-keyed `refreshed.errors` and report a failed provider refresh instead of ignoring it.
   3. `await models.getAvailable()` enumerates available chat models; `await models.listCredentials()` returns non-secret `{ providerId, type }` metadata. A candidate provider MUST appear in the credential metadata: `JuncoAgent.create` requires a saved Pi login. Availability is not an entitlement probe.
   4. Never print authentication values. Never call a model merely to discover it.
3. **Resolve "latest" from evidence.** Use current official provider model documentation or release notes, cross-checked against exact IDs in the available catalog and any user provider/model constraint. Array order, context size, reasoning support, price, and ID sorting do not prove freshness; the public `Model` type has no release date. Match capabilities to each role without inventing a ranking algorithm. A rolling alias is usable only when it exists in the catalog and its meaning is documented; do not require a `-latest` alias. If freshness cannot be verified or no suitable authenticated model exists, report that prerequisite; do not invent an ID or claim a cached choice is latest.
4. **Pin the verified choice in the generated program.** Write the concrete provider/model IDs into the workflow with a short JSDoc note giving the verification date and freshness source. An explicit model requested by the user wins over automatic selection. When one credentialed provider serves several vendors' models, pick per role from the newest documented releases and state the choice. Do not add a runtime model-routing or fallback framework. If a pinned ID appeared only after the network refresh, the generated program repeats the same `create` + `refresh({ allowNetwork: true })` (checking `aborted`/`errors`) before constructing agents. Set `thinkingLevel` only when `getSupportedThinkingLevels(model)` includes it. Share one `ModelRuntime` across all agents of the workflow.
5. **Build the graph in execution order.** Declare typed edges, create node states and specs, register nodes, wire edges, drive the graph, then extract the selected result. Identity, description, trigger, and availability belong in `NodeOptions`; delivery and emission behavior belong in bindings.
6. **Release and report.** Close owned resources in dependency order and flush tracing separately (nested `finally`). Return runnable TypeScript, a short execution/prerequisite instruction, and the observed result or the precise verification limitation.

### Literate program shape

Read top to bottom in execution order: a JSDoc header stating purpose, topology, data, and termination; setup; typed edges; node roles; wiring; execution; selected output; disposal. Put JSDoc on the workflow factory, nontrivial helpers, node roles, and any meaningful stop or availability policy. Explain *why*, not every assignment. No wrapper class hierarchies or large CLI scaffolding. Keep live agent acquisition behind `if (import.meta.main)` when the factory is also importable.

## Public API

```text
import { graph, agent, tools, schedulers, tracer } from "junco-agency";
```

Import only the namespaces a program uses. Spell node constructors as `graph.nodes.*` and trigger rules as `graph.trigger.*`. Model, session, and content APIs are not re-exported by `agent`; import them from `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-coding-agent`.

The fenced blocks below are **verbatim signature excerpts**, not executable declarations: documentation comments and implementation bodies are omitted. Junco types named in an excerpt under a namespace heading are exported from that namespace (for example `graph.Message`, `graph.ParentView`, `graph.NodeGenerator`, `graph.NodeOptions`, `schedulers.Schedule`) unless marked implementation-local or attributed to a Pi package. Inside excerpts, the branded types are spelled `NodeId`, `EdgeId`, and `Width`; through the namespace, their *type* names are `graph.NodeIdType`, `graph.EdgeIdType`, and `graph.WidthType` (the unsuffixed names are the construction objects `graph.NodeId.create`, `graph.EdgeId.create`, `graph.Width.create`).

### graph

Verbatim signature excerpts (`graph.DataflowGraph`, `graph.DataflowRunOptions`):

```text
export type DataflowRunOptions = {
  readonly signal?: AbortSignal;
};

export class DataflowGraph<
  S,
  N,
  T,
  EH,
  Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>,
> implements Pretty

  constructor(
    readonly scheduler: Q,
    readonly window: Width,
    readonly threads: Width,
    readonly tracer?: DataflowTracer,
  )
  addNode(spec: NodeSpec<S, N, T>): NodeId
  addEdge(from: NodeId, to: NodeId, edge: Edge<N, T>): this
  getNode(id: NodeId): Node<S, N, T> | undefined
  result(id: NodeId): O.Option<T>
  available(): ReadonlyMap<NodeId, NodeAvailability<N, T>>
  step(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeId, T>>
  run(options?: DataflowRunOptions): Promise<ReadonlyMap<NodeId, T>>
  emit(fromId: NodeId, message: Message<N>): void
```

`O.Option` is fp-ts's `Option`; prefer the map returned by `run()`/`step()` (`results.get(id)`). `Edge<N, T>` is `graph.Edge`; `Node` is `graph.Node`. `workflow.tracer` is the constructor's `readonly tracer` parameter property (on a `JuncoGraph`, possibly the automatic backend).

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

export type NodeOptions<N, T> = {
  readonly id?: NodeId;
  readonly description?: string;
  readonly trigger: TriggerRule<N, T>;
  readonly is_available?: AvailabilityFn<N, T>;
};

export type NodeSpec<S, N, T> = NodeOptions<N, T> & {
  readonly state: S;
  readonly step: StepFn<S, N, T>;
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
export class JuncoGraph<
  N = AgenticInput,
  T = AssistantMessage,
  EH = unknown,
  Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>,
> extends DataflowGraph<Agentic<N, T>, N, T, EH, Q>

  constructor(
    scheduler: Q,
    window: Width,
    threads: Width,
    tracer: DataflowTracer,
    policy: ToolCollection["policy"],
    collection?: ToolCollection,
  )
  static async create<N, T, EH, Q extends DataflowScheduler<N, T>>(
    cwd: string,
    options: ToolCollectionOptions,
    build: (collection: ToolCollection) =>
      JuncoGraph<N, T, EH, Q> | Promise<JuncoGraph<N, T, EH, Q>>,
  ): Promise<JuncoGraph<N, T, EH, Q>>
  readonly policy: ToolCollection["policy"]
  get collection(): ToolCollection | undefined
  get signal(): AbortSignal
  abort(reason: unknown = new DOMException("Graph aborted", "AbortError")): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
  compact(policy: CompactionPolicy): Promise<void>

  static parallel<N = AgenticInput, T = AssistantMessage>(
    policy: ToolCollection["policy"],
    tracer: DataflowTracer = TuiTracer.shared(),
    collection?: ToolCollection,
  ): JuncoGraph<N, T>
  static spawn<Input, N = AgenticInput, T = AssistantMessage>(
    root: AgenticNode<N, T>,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
    tracer: DataflowTracer = TuiTracer.shared(),
  ): JuncoGraph<N, T>
  appendChildren<Input>(
    rootId: NodeIdType,
    inputs: readonly Input[],
    child: (input: Input) => AgenticNode<N, T>,
  ): void
```

Construction rules:

- **Choose the graph class by node state.** `graph.DataflowGraph<S, N, T, EH>` holds ordinary state such as `undefined`. `graph.JuncoGraph` / `graph.JuncoGraph.parallel(policy)` hold lifecycle-owned states only: prompt agents, nested `JuncoGraph`s, and `graph.nodes.Deterministic` coroutines. Never cast `{ state: undefined }` into a `JuncoGraph`.
- **`graph.nodes.Agentic` is the graph-state union**, not the cooperative agent interface `agent.Agentic`.
- **Edges.** Message edges queue emitted `N`; value edges receive the source's returned `T` once. Read message batches with `graph.from(view, edge)` or `view.messages`; read parent results through `view.values.get(edge.id)`. `Message.create`/`emit` target wired message edges, never value edges. Edge IDs must be unique per source-outbound and per target-inbound set. Register both endpoints before `addEdge`. Never mutate an edge's transport.
- **Generator protocol.** A dependent body starts with `let view = yield []`; priming does not consume its queued inputs. Each activation advances the generator once. Returning `T` marks the node done and resolves its value edges. Annotate a hand-written body as `async function* (): graph.NodeGenerator<N, T> { … }`.
- **Generic inference.** `new StepNode` / `new EmitOnce` infer `S`, `N`, `T` from their arguments, including `options` (`state: undefined` infers `S = undefined`). When that differs from the registering graph's types (a `void`-state graph, a union `N`, a trigger narrower than the graph), pass explicit generics: `new graph.nodes.StepNode<void, Payload, string>(…)`. `Message.create` infers from its arguments. `graph.from(view, edge)` returns the view's (graph-wide) `N`, not the edge's narrower type: narrow each payload with a type guard instead of casting.
- **Agent graphs use `AgenticInput` messages and `AssistantMessage` results** (the `JuncoGraph` defaults). A deterministic node feeding an agent emits `{ kind: "prompt", text }`.
- **Closing.** `JuncoGraph.close()` recursively and terminally closes every member: agents, nested graphs, Pi schedulers, coroutines. Results stay readable. Registering an agent therefore hands its lifetime to the graph; before registration, the acquirer closes it (`await using`, or `await member[Symbol.asyncDispose]()` for each earlier acquisition when a later one fails). Repeated close is safe. A graph whose members must outlive it (persistent agents across rounds) is not closed per round; close the members once at the end.
- **Spawn policy.** `JuncoGraph.spawn(root, inputs, child)` builds `JuncoGraph.parallel` under the root's registration policy: a step-less coroutine's or nested graph's own state policy (such a root takes no `policy` field), otherwise the root spec's required `policy`. `appendChildren` registers every child through `addNode`, so each child follows the same branch rules.
- **Execution.** `run()` returns cumulative completed-node results when nothing is available; it does not prove every node finished, and a streaming sink may legitimately stay unfinished. `step()` runs at most one window. Never overlap `step`/`run` on one graph. Do not catch and silence `DataflowDefinitionError`, `DataflowNodeError`, or cancellation.

### graph.nodes

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

- `EmitOnce` emits its batch, then returns `ret` on the next activation. `StepNode` never returns: use it for a streaming sink. Both are complete specs: `options` supplies everything but `step` (`{ state, trigger, … }`).
- A finite generator's trigger/availability must still admit the activation that performs its final `return`. Bound feedback loops by the task's actual stop condition.
- Constant node classes construct complete specs; `{ state, ret }` is required (`undefined` only where the graph's types allow it). Construct one with `new` once per node.
- `ConstFanout` sends one shared payload reference on each distinct message edge, in `outputs` order, then completes. Zero outputs still complete.
- `ConstFanin` accumulates every message from every input across activations, emits one list in the supplied *input order* (not arrival order), and completes on its next activation. An array-valued payload stays one element. Zero inputs emit one `[]`. The graph's message type must admit both `C` and `C[]`.
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
  | Deterministic<N, T>;

export type AgenticNode<N = AgenticInput, T = AssistantMessage> = (
  | (NodeSpec<Agentic<N, T>, N, T> &
      NotNested & { readonly policy: ToolCollection["policy"] }) // raw spec with step
  | (StepLess<N, T> &
      NotNested & {
        readonly state: Deterministic<N, T>;
        readonly step?: never;
        readonly policy?: never; // authorized by the coroutine's own policy
      })
  | (StepLess<N, T> & {
      readonly state: JuncoGraph<N, T>;
      readonly step?: never;
      readonly policy?: never; // authorized by the child graph's own policy
      readonly result: NodeIdType;
      readonly receive?: (view: ParentView<N, T>) => void | Promise<void>;
      readonly afterStep?: () => void | Promise<void>;
    })
  | (StepLess<N, T> &
      NotNested & {
        readonly state: JuncoAgent | MockAgent; // chat wires only (N = AgenticInput, T = AssistantMessage)
        readonly step?: never;
        readonly policy: ToolCollection["policy"];
      })
) & {
  readonly contract?: (edgeId: EdgeIdType) => Contract;
};
// `NotNested` (result/receive/afterStep?: never) and `StepLess` (NodeSpec minus state/step) are implementation-local.
// Register step-less: graph.addNode({ ...options, policy, state: agent }), { ...options, state: coroutine },
// or { ...options, state: childGraph, result, receive?, afterStep? }. A step-less coroutine or nested
// graph spec takes no `policy`: any own `policy` field (even a matching or `undefined` one) throws TypeError.
// Each addNode builds its own driver; a step-less spec with any other state throws TypeError.

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

- A registered agent (`workflow.addNode({ ...options, policy, state: agent })`) runs **one prompt** per node and returns when that run settles, so a source node with `trigger: TriggerRule.always()` and a staged prompt runs exactly once. The prompt belongs to the agent: `JuncoAgent.create({ prompt })` (one-shot) or `agent.stagePrompt(prompt)` before a later round's registration (throws `busy` unless idle). `prompt` may be `(inputs: graph.ParentView<AgenticInput, AssistantMessage>) => string`: it runs once, synchronously, on the node's first activation with the retained inbox (not drained), and a throw fails the node with that error. Never put `prompt` on the registration object; delivered messages and unseen parent values are **data**, retained per edge in the node's inbox until the model calls `recv` — they never start, steer or prompt the agent. An idle agent with input but no prompt stays quiescent. The model sends on outgoing message edges with `send({ id: edgeId, payload })` and discovers routes and receivers' expectations with `info({})`; value edges carry only the final result. Only `yield` and a Marsh policy denial pause a run. A settled run becomes the node's `AssistantMessage` result; a failed run throws its native error.
- **Contracts.** `info` reports, for every parent and child edge, the *receiving* node's `Contract.expect`. Supply it beside the receiver: `contract` on the receiving node's registration (`{ ...options, state, contract }`, for agents, coroutines and nested graphs alike; an agent registration's contract replaces the agent's own), or `JuncoAgent.create({ contract: (edgeId) => ... })` as an agent's default. A finite receiver throws `JuncoAgentError("invalid_state", \`No contract for edge "${edgeId}"\`)` for an unknown edge; `info` fails rather than omitting it.
- **Validated handoffs.** When a consumer's assignment must be built from a checked upstream result, give the consumer a prompt callback that reads `inputs.messages.get(edgeId)` / `inputs.values.get(edgeId)`, throws on invalid data and returns the assignment text (`examples/mixed.ts` Reviewer, `examples/mcp.ts` Dependencies; the consumer needs no `recv`). Wire the upstream edges straight into the consumer, trigger it on them, and put each incoming edge's `contract` on the consumer's registration. Never insert a separate deterministic node just to prepare a prompt message.
- Never separately iterate an agent the graph is driving.
- `{ ...options, state: coroutine }` registers a `Deterministic` coroutine whose `body(signal)` speaks the same generator protocol; a coroutine has one consumer, so register it once. Honor `signal` in long loops.
- `{ ...options, state: childGraph, result }` requires `result` to name an **already registered** child node (missing → `TypeError("A nested graph node requires a result")`; unknown → `DataflowDefinitionError`); a child that quiesces without that result fails. Use `receive` to feed the child (for example by queuing an input on a source the child exposes) and select only the deliberate final node, so intermediate drafts never escape.

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

- Spell conjunction `TriggerRule.allOf(TriggerEntry.on(a), TriggerEntry.on(b))` and disjunction `TriggerRule.anyOf(TriggerEntry.on(a), TriggerEntry.on(b))`; never arrays, bare edges or bare `EdgeId`s (`triggerEntry` is an implementation-local type-only brand; an entry is the edge id string at runtime).
- Entries carry their edge's message and result types: an unannotated `allOf`/`anyOf` infers the union of every entry's payloads, and a rule only fits a node whose payload types include them. A narrow rule serves a wider-payload graph; a wrong-payload rule is a compile error.
- `TriggerRule.anyOf` is ordered: ordinary trigger-driven reads take only the first satisfied entry. `TriggerRule.when(edge)` is a single-edge conjunction. `TriggerRule.always()` is the empty conjunction (sources); `TriggerRule.never()` the empty disjunction. Without type arguments, empty rules fit every graph.
- A rule naming an unwired inbound edge, or repeating an entry, is a definition error.
- A trigger says *which* edges must carry something; `is_available` may further restrict or extend readiness (e.g. "publish once": `is_available: () => !published`).

### agent

Verbatim signature excerpts (`Skill`, `PromptTemplate`, `AgentTool`, `AgentHarnessOptions`, `AgentHarnessResources`, `Session` come from `@earendil-works/pi-agent-core`; `ModelRuntime` from `@earendil-works/pi-coding-agent`; `OwnedResources` is implementation-local). `AgentHarnessOptions` supplies `session`, `models`, `model`, `systemPrompt`, `thinkingLevel`, `streamOptions`, `retry`, `compaction`, `steeringMode`, and `followUpMode`; `ModelRuntime` has no close method:

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

- **Construct with the static factories.** The constructor is protected: `await agent.JuncoAgent.create(...)`, never `new agent.JuncoAgent(...)`.
- **Policy and collection:** agents take no `policy`; an optional `collection` selects their authorization (`collection.policy`) and is borrowed through the agent's own lease, binding its native lifetime, not its tools. An implicit collection (omitted `tools`, or nonempty MCP definitions without a collection) is `ToolCollection.create(cwd)` under the default `tools.LockPolicy`; for any other policy open and pass the collection yourself. Registered agents and every explicit-`step` raw spec require `policy` on their node spec: the very object (policies compare by identity) of a real agent's `collection.policy` when it has one, and of a coroutine's or child graph's when the raw spec holds one. A step-less coroutine or nested graph is authorized by its own constructor policy and its spec takes no `policy` (supplying one throws `TypeError`).
- **Normal construction:** `create({ models, provider, model, systemPrompt, tools })`. It resolves the exact IDs, checks the saved login, and owns its default in-memory session. A supplied `session` transfers to the agent.
- **Pre-resolved construction:** `fromResolved({ models, model, session, tools })` only with an already resolved native `Model<Api>` and a Pi core `Session`; the session transfers.
- **MCP tool sources:** both factories accept `mcp.JuncoMcpTools` definitions in `tools`, alone or mixed with concrete tools (`tools: [servers, lsp, ...collection.tools]`), connected from `cwd`. Each agent gets fresh MCP clients and server processes, closed with it; discovered names are `mcp__<server>__<tool>`. A definition is a factory-only source: `setTools` takes concrete tools only.
- **Three model argument shapes; never substitute one for another:** `create` takes a model ID *string* in `model`; `fromResolved` takes a resolved `Model<Api>` in `model`; `setModel` takes `{ provider, modelId }` (`ModelIdentity`).
- **Final text:** use `contentText(message.content)` from `@earendil-works/pi-ai`; require `message.stopReason === "stop"` and nonblank trimmed text before forwarding a report.
- **Iterator boundaries:** preserve `yield` / `settled` / `failed`; rethrow a failed boundary's `error`. `return()` and an early `for await` break close the agent terminally; to reuse an agent across rounds drive it with explicit `next()` (or register it in a graph and `stagePrompt` each round).

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

(`yieldParameters` is implementation-local: `{ reason: string }`, non-empty, no extra properties. `isYieldTool` is true only for a tool object constructed by `new YieldTool()`; a same-named tool or a spread copy is not one. `launchSchema` is implementation-local: `{ context: string; tasks: { name?: string; task: string; model?: { provider: string; modelId: string }; tools?: string[] }[] }`, required shared `context` prepended to every task, at least one task, non-blank strings, no extra properties. `taskParameters`/`assignedParameters` are one model-facing object (launch fields and/or decision fields `action`, `id`, `attempt`, all optional); each call is checked against the exact launch (free-form only), `{}` (assigned only) or decision shape (`attempt` a positive safe integer). The same branding rule applies to `isTaskTool` and `isAssignedTaskTool`.)

(`UpstreamLspTool`, `UpstreamLspToolDetails`, `LspToolFields`, `TUnsafe` are implementation-local. `LspTool` is a factory object plus a tool type, not a constructible class.)

Native tool factories, by capability (`read`, `bash`, `edit`, `release`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`). Verbatim signature excerpts; the return-type aliases (`ReadToolDetails`, `NativeGrepToolDetails`, `FindToolDetails`, `BoundedToolDetails`, `Ast*Result`, `DiffStreamResult`, the `*Schema` values, and the `createPi*` upstream factories) are signature references, not importable namespace types; `HashlineEditDetails` is exported:

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

Prefer `tools.ToolCollection.create(cwd, { policy })` over assembling these factories by hand: it builds all eight tools, and its `read`, `grep`, and `edit` share one provenance store. Policies compare by identity, so build a composed policy (`tools.Policy.and(tools.LockPolicy, custom)`) once and pass that same object to the collection and to every node and graph using it. LSP is not in the collection. There is no `tools.write` or `tools.ls`.

Tool selection and ownership:

- **Pure prompt/review agents get explicit `tools: []`.** Omitting `tools` makes `create` acquire the native collection plus `task`, `yield`, `recv`, `send` and `info`. Explicit arrays replace defaults: a graph agent that consumes inputs needs `new tools.RecvTool()`, one that sends needs `new tools.SendTool()` and usually `new tools.InfoTool()`.
- **Voluntary suspension** needs the real `new tools.YieldTool()` in the explicit array; an arbitrary tool named `yield` is not the scheduling primitive. Executing it only returns its reason; a `JuncoAgent` pauses at it, while a plain Pi agent continues. It is the only voluntary pause: `task`, `recv`, `send`, `info` and `schedule` never pause.
- **Subagents** need the real `new tools.TaskTool()` among the caller's tools and the caller registered as a graph node. A successful call returns handles immediately and the run continues; the children start when the caller next calls `yield` (or hits a policy pause) or finishes its run, so instruct a caller that needs reports before continuing to `yield`. At that point the node's state becomes a `graph.JuncoGraph.spawn` graph rooted at the same caller, one child per task. Completed `task_result` reports (`id`, `attempt`, …) reach the caller as follow-ups, then one `task_batch_complete` marker once every task of the launch is completed or ignored. The node returns the caller's answer only after every delivered report and marker was answered. Children inherit the caller's model, active tools and registered MCP definitions (fresh servers each) unless a task names a `model` or narrower `tools`. Outside a graph the call fails as an ordinary tool error. For workflow-owned assignments, `await agent.setTaskBatch(input)` and tell the model to call `task({})` (admitted at most once; no payload to copy). Failures follow `agent.setTaskFailurePolicy(...)`: `"ignore"` drops them silently; `{ retries: n }` (default `n = 0`) reruns the failed task alone in a fresh child, then delivers a `decisionRequired` report the caller must resolve with `task({ action: "retry" | "ignore", id, attempt })` before finishing (else `Task failure decisions required: …`). Failed attempts are disposed once; a teardown failure (`JuncoAgentCleanupError`) and cancellation propagate.
- **Semantic navigation:** `await tools.LspTool.create(process.cwd(), { readOnly: true })` for read-only roles; enable mutating LSP only for a role that edits. Requires Bun and caller-installed language-server binaries. LSP uses host filesystem/process access, not the native sandbox.
- **Native coding tools** need the built native addon and an existing dedicated Btrfs seed (writable parent, `user_subvol_rm_allowed`). `ToolCollection.create` and omitted agent `tools` both require it, with no ordinary-filesystem fallback. Do not silently swap in other tools when prerequisites are missing; report them.
- **Ownership.** Explicit tool arrays remain caller-owned. Acquire in a guarded sequence so a later constructor failure still closes earlier acquisitions. Drain/close graph members first, then call `LspTool.shutdown()` once after every process-wide LSP user has finished, then close each owned collection. Each `ToolCollection` owns its own ShellMux and policy; agents, graphs, coroutines and MCP connections given that collection borrow it through their own `lease()` and release only that hold. The final release (usually the creator's `close()` or the root graph of `graph.JuncoGraph.create`) closes the mux. Borrowers never close the collection itself. Keep these resources outside multi-round loops when agents persist.

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

- **Declare a server** with `mcp.JuncoMcpTools.add({ name, type: "stdio", command, args })`; chain `.add(...)` on the result to put several servers in one definition. `command` is resolved through `PATH`, and `args` reach the program literally, never through a shell. Optional fields: `cwd` (resolved against the connecting agent's `cwd`; it must exist inside the seed), `env` (merged over the parent environment; `inheritEnv: false` passes only `env`), `stderr`/`onStderr`, `closeTimeoutMs`, and `clientOptions` (for example `{ requestTimeoutMs: 300_000 }` for a slow-starting server; pi-mcp's default is 30 seconds). `name` must be nonblank and unique within a definition, and becomes the `<server>` of each tool name.
- **Pass the definition to an agent factory:** `tools: [servers]` (or mixed with concrete tools). Defining starts nothing; each agent connects its own client and server process from its `cwd` and closes them when the agent closes. Subagents reconnect fresh servers from a snapshot of the caller's definitions. Select MCP tools by their published `mcp__<server>__<tool>` names in `activeToolNames`.
- **Direct use** outside an agent: `const connection = await servers.connect({ cwd, signal, collection })`, use `connection.tools`, and `await connection.close()` in `finally`. `signal` cancels only acquisition (rejecting with `McpAbortError`) and stops any server already started; a returned connection ignores it.
- **Stdio only.** Every server runs as an audited job of the supplied collection's ShellMux under its policy (needs the native addon and a Btrfs seed containing `cwd`); a nonempty definition without a collection rejects with `TypeError`; its effects publish only when it ends, and a refused publication rejects the closing agent or connection with `MARSH_POLICY_DENIED`. A reply is not proof of publication. Each server works on a snapshot taken when it starts: once another server publishes a change to a path this one has read or written, this server's close is refused, even if it wrote nothing itself. Prepare shared state before starting servers, and do not count on a server that stays running while another publishes to close cleanly.

### schedulers

Verbatim signature excerpts (engine contract):

```text
export type MessageSchedule = number | "all" | "none";

export type InputSchedule = ReadonlyMap<EdgeId, MessageSchedule>;

export type NodeSchedule = {
  readonly id: NodeId;
  readonly inputs: InputSchedule;
};

export type Schedule = readonly (readonly NodeSchedule[])[];

export type NodeAvailability<N, T> = {
  readonly view: ParentView<N, T>;
  readonly trigger: TriggerRule<N, T>;
  readonly satisfied: readonly EdgeId[];
  readonly status: "ready" | "running";
};

export type DataflowScheduler<N, T> = {
  create(window: number, threads: number): void;
  bind?(
    available: () => ReadonlyMap<NodeId, NodeAvailability<N, T>>,
    step: (signal?: AbortSignal) => Promise<void>,
  ): void;
  schedule(available: ReadonlyMap<NodeId, NodeAvailability<N, T>>): Schedule;
  resolveInputs?(
    entry: NodeSchedule,
    live: NodeAvailability<N, T>,
  ): InputSchedule;
};

export const triggerInputs = <N, T>({
  trigger,
  satisfied,
}: NodeAvailability<N, T>): InputSchedule =>
```

Verbatim signature excerpts (policy factories):

```text
export type SchedulerOptions<State, N = unknown, T = unknown> = {
  readonly state: State;
  readonly schedule: (
    available: ReadonlyMap<NodeId, NodeAvailability<N, T>>,
    state: State,
    window: number,
    threads: number,
  ) => Schedule;
  readonly resolveInputs?: (
    entry: NodeSchedule,
    live: NodeAvailability<N, T>,
    state: State,
  ) => InputSchedule;
};

export class Scheduler<State, N = unknown, T = unknown>
  implements DataflowScheduler<N, T>
  state: State;
  constructor(options: SchedulerOptions<State, N, T>)

export class RoundRobinScheduler<N = unknown, T = unknown> extends Scheduler<
  NodeId | undefined,
  N,
  T
>
  constructor()

export class ParallelScheduler<N = unknown, T = unknown> extends Scheduler<
  undefined,
  N,
  T
>
  constructor()
```

Verbatim signature excerpts (Pi scheduler; `scheduleParameters` is implementation-local):

```text
export type SchedulerInfo = {
  readonly window: number | null;
  readonly threads: number | null;
  readonly quiescent: boolean;
  readonly nodes: readonly {
    readonly id: string;
    readonly status: "ready" | "running";
    readonly details?: unknown;
  }[];
};

export type ScheduleTool = AgentTool<typeof scheduleParameters, SchedulerInfo>;

export type PiSchedulerAdapter<N, T> = {
  readonly describeNode?: (id: NodeIdType, node: NodeAvailability<N, T>) => unknown;
  readonly readInputs?: (id: NodeIdType, node: NodeAvailability<N, T>) => InputSchedule;
  readonly beforeSchedule?: () => void;
  readonly abortDependents?: () => Promise<void> | undefined;
  readonly closeDependents?: () => Promise<void> | undefined;
};

export type PiSchedulerOptions<
  N = unknown,
  T = unknown,
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
> = Omit<
  AgenticOptions<S, P, ScheduleTool>,
  "tools" | "activeToolNames" | "model" | "models" | "session" | "prompt"
> & {
  readonly prompt?: string; // string-only: no prompt callback for schedulers
  readonly model?: AgenticOptions<S, P, ScheduleTool>["model"];
  readonly models?: AgenticOptions<S, P, ScheduleTool>["models"] | ModelRuntime;
  readonly session?: Session;
  readonly adapter?: PiSchedulerAdapter<N, T>;
};

export class PiScheduler<
    N = unknown,
    T = unknown,
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
  >
  extends JuncoAgent<S, P, ScheduleTool>
  implements DataflowScheduler<N, T>

  static async make<N = unknown, T = unknown, S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>(
    options: PiSchedulerOptions<N, T, S, P>,
  ): Promise<PiScheduler<N, T, S, P>>

// graph.JuncoGraph:
  static async pi<
    S extends Skill = Skill,
    P extends PromptTemplate = PromptTemplate,
    N = AgenticInput,
    T = AssistantMessage,
  >(
    options: Omit<PiSchedulerOptions<N, T, S, P>, "adapter"> & {
      readonly policy: ToolCollection["policy"];
      readonly tracer?: DataflowTracer;
      readonly window?: Width;
      readonly threads?: Width;
    },
  ): Promise<JuncoGraph<N, T, unknown, PiScheduler<N, T, S, P>>>
```

`ScheduleTool` is the Pi scheduler's sole model tool, with the fixed protocol `schedule({ lanes })` where `lanes: string[][]` are node IDs; each successful call runs exactly one bounded graph window and returns a fresh `SchedulerInfo`.

| Requirement | Construction and drive |
|---|---|
| Ordinary independent agent or mixed work | `graph.JuncoGraph.parallel(policy)`; `await workflow.run()`. Its agency-aware live reads avoid redelivering retained values. |
| Pure deterministic parallel graph | `new schedulers.ParallelScheduler()`, `graph.Width.create(1)`, `graph.UNBOUNDED`; `run()` or `step()`. One lane per available node; a finite thread bound does not throttle it and can reject the plan. |
| One-node-at-a-time deterministic fairness | `new schedulers.RoundRobinScheduler()`, `graph.Width.create(1)`, `graph.Width.create(1)`; `run()` or `step()`. Rotation follows string ID order, so `"1" < "10" < "2"`. |
| Custom or model-driven scheduling | `new schedulers.Scheduler({ state, schedule, resolveInputs? })` only for a requested policy; `graph.JuncoGraph.pi(...)` when a model must judge scheduling. Drive with the Pi protocol below. |

**Custom policies.** A `Schedule` is lanes × turns; same-column lanes run concurrently; input reads are explicit (`triggerInputs(candidate)` for ordinary reads); `state` is a value, not a factory, and persists across calls. A repeated-batch policy must supply a live `resolveInputs`. One scheduler belongs to one graph. An empty plan while work is available, duplicate IDs in a column, unavailable nodes, invalid reads, and exceeded bounds are errors. `RoundRobinScheduler` and `ParallelScheduler` extend `Scheduler` and expose its `.state`.

**Model-driven agency.** Construction:

1. Create a native session: `const repo = new MemorySessionRepo()` and `const session = await repo.create({}, BACKGROUND_CONTEXT)` (both from `@earendil-works/pi-agent-core`; not the coding-agent `SessionManager`).
2. `const workflow = await graph.JuncoGraph.pi({ model, models, session, systemPrompt, prompt, policy })`, passing the currently resolved `Model<Api>`, the runtime, and the session so it uses `PiScheduler.make`. Never rely on the fixed-model default (`PiScheduler.opus`) when `model` is omitted. `tracer` defaults to `tracer.TuiTracer.shared()` (lazy interactive TUI or silent Dummy), `window`/`threads` to `graph.UNBOUNDED`. This adds no terminal acquisition to Pi's existing factory promise. Then `const scheduler = workflow.scheduler`, and register and wire nodes.
3. Drive only the scheduler: loop `await scheduler.next()`; continue after `kind === "yield"`, throw the error after `kind === "failed"`, finish after `kind === "settled"` (require `message.stopReason === "stop"`); `done` before settlement is an error. Do not start a competing `workflow.run()`: the scheduler's synchronous `schedule()` only consumes the model's staged decision.
4. Read results with `workflow.result(id)`, which returns an fp-ts `Option` (no fp-ts import needed): `const r = workflow.result(id); if (r._tag !== "Some") throw …; use(r.value)`.
5. In `finally`, `await workflow.close()` (cascades to the scheduler, which owns the transferred session, and to every member), then `await repo.close(BACKGROUND_CONTEXT)`.

**Multiple model-scheduled rounds with persistent agents.** Closing a graph *or* its scheduler closes every member, so never close a round's graph or scheduler when the round ends. Build each round as a fresh `graph.JuncoGraph.pi(...)` graph (one scheduler per graph; each with its own session from the shared repository) whose nodes reuse the persistent agents, staged with that round's `agent.stagePrompt(prompt)`. Keep every round graph in a list. After a round settles, compact *that* round graph (`await roundGraph.compact(policy)`; each persistent agent appears there once). In the outer `finally`, close every round graph (agent close is idempotent), flush each distinct tracer, then close the repository.

Quiescence is not universal node completion, and the runtime rejects a normal scheduler settlement while graph work remains available.

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
    Q extends DataflowScheduler<N, T>,
  >(
    graph: DataflowGraph<A, N, T, EH, Q>,
    policy: CompactionPolicy,
  ): Promise<void>
  compact(policy: CompactionPolicy): Promise<void> // JuncoGraph.compact(this, policy)
```

- `"all"`: every direct prompt-agent node state. `"more-than-forty"`: those whose context is strictly above 40% of their model's context window. `"all-available"`: direct agents in one current `available()` snapshot. `"more-than-forty-available"`: the intersection.
- Selection is frozen before dispatch; successful siblings stay compacted if another fails; failures aggregate as `AggregateError("Graph compaction failed")`. An unknown policy or unmeasurable context capacity fails rather than falling back.
- Not recursive into child graphs; the graph's own scheduler is compacted only if it is itself a node.
- Call requested maintenance between settled rounds. Compaction sends a summarization request to each selected agent's model. A running agent compacts only after its run ends, so never await queued compaction ahead of driving a suspended or running member to settlement. Do not add compaction to short workflows by default.

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

- **A `JuncoGraph` always has a tracer.** A direct `new graph.JuncoGraph(...)` requires one as its fourth argument (omitting it throws `TypeError`) and a policy as its fifth; `JuncoGraph.parallel(policy)`, `JuncoGraph.spawn` and `JuncoGraph.pi` default to `tracer.TuiTracer.shared()`. A generic `DataflowGraph` without an observer is untraced. Explicit Dummy, custom and Opik observers always win; the Opik adapter (`dataflow-engine-opik`) is not a namespace export. Use `new tracer.DummyTracer()` explicitly in ordinary runtime tests, including tests run in real terminals.
- **Backend selection and acquisition.** `tracer.TuiTracer.shared()` returns a shared lazy TUI named `JuncoGraph.run` only when both stdin and stdout are TTYs and `TERM !== "dumb"`; otherwise it returns a silent stateless `DummyTracer`. `parallel` and `spawn` stay synchronous. Imports, factory construction and shared selection do not load native bindings, enter terminal modes, install handlers or write output; the first observer call starts initialization. For awaited explicit acquisition use `const tui = await tracer.TuiTracer.create("My workflow")` (name optional) and pass it to the graph. Unsuitable terminals reject before native import; interactive initialization failures surface from explicit creation or lazy flush/close, never through fallback. One TUI owns the terminal at a time; after restoration a later factory may select a fresh shared instance, but old callbacks never reopen it.
- **Display and children.** The two vertically stacked panes show `JuncoGraph` topology above live `Agent traces`. Layout persists across steps unless topology changes. Stable identity colors and scoped `[g<serial>:<NodeId>]` badges distinguish duplicate local IDs; green highlights only currently executing scheduled nodes, not all available or yielded nodes. Live member text, thinking, tool progress, outcomes and complaints are independent of `LOG_LEVEL`. Snapshotted payloads may contain sensitive data; bounded display history is not persisted history. Ralph and promoted task children inherit their parent's tracer. Pass the same explicit instance to separately constructed nested graphs; an explicitly different child observer is not overridden.
- **Terminal ownership and operational logs.** Do not write directly to stdout/stderr while the TUI owns them. Capture MCP stderr (`stderr: "pipe"`, after any config spread) and print final results after restoration. Admitted `junco-tools/log` records are redirected exclusively into the trace pane. `LOG_LEVEL` still controls operational/policy logs, not TUI lifecycle or agent records: default INFO, trimmed case-insensitive names `SILLY`, `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`; invalid/numeric names reject at startup. Policy violations remain INFO and tentative grants DEBUG. `flushLog()` is a draw barrier, not interactive completion, so tool cleanup does not wait for dismissal.
- **Callbacks** are synchronous and read-only. `startRun` fires once per `run()`/`step()`; `startNode` fires per activation with phase `"prime"` (no view, `inputs === undefined`) or `"resume"` (the delivered view); run `end` receives cumulative results; `fail` reports the exact rejection or raw activation cause. `complain` fires when an agent node's always-on `complain` tool records an issue (node ID and text only; the full issue is in `tools.issueLog`), at any time. Views and result maps are live: snapshot anything retained. The engine warns about and ignores observer exceptions.
- **Flushing** is caller-owned and separate from disposal:
  `try { … } finally { try { await workflow.close(); } finally { await workflow.tracer.flush(); } }`.
  Share one observer across child graphs and flush each distinct observer once after all users stop (collect them in a `Set`). TUI `flush()` draws the final frame and waits for `q`/Esc to restore the terminal. Early `q`/Esc dismisses without cancelling computation; Ctrl-C restores before application cancellation. `await tui.close()` or async disposal restores without keyboard dismissal. Unused lazy flush/close is I/O-free; an old dismissed tracer never reopens. Tab changes pane focus; arrows, PageUp/PageDown and Home/End pan/scroll, with End restoring trace tail-follow. A successful flush does not prove remote ingestion. `bun run smoke:tui` is a credential-free production-addon smoke (no Btrfs mount); real Linux PTY coverage belongs to `test/tui-tracer.test.ts` in `test:native`, not ordinary Dummy-backed runtime tests.

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

**Feedback recurrence.** A source (`new EmitOnce(…)`, trigger `TriggerRule.always()`) seeds the recurrence; the recurrence node's trigger `TriggerRule.anyOf(TriggerEntry.on(seed), TriggerEntry.on(loop))` takes seed or feedback; a self-edge (`addEdge(id, id, loop)`) carries the next state; the task's finite count ends production with a `return`. A generator cannot emit and return in one activation, so the activation that emits the last value still sends feedback; the next activation checks the count and returns. Assert the recurrence's result in the `run()` map to prove completion. A `new StepNode(…)` sink drains the output and quiesces without returning. Read the delivered pair with `graph.from` and check its length/types before use instead of non-null assertions. Ten Fibonacci values from seeds `0, 1` are `[0,1,1,2,3,5,8,13,21,34]`.

**Research/review committee.** Agents and their sessions persist; each round builds a fresh `graph.JuncoGraph.parallel(policy)`. Value edges fan final reports straight into each consumer, whose staged prompt callback validates them and composes its assignment; the consumer's registration carries the receiver contracts. An optional partial handoff is a real message: the producer calls `info`, picks the child entry with `kind === "message"`, `send`s on its `edgeId`, then calls `yield`; the consumer triggers on `anyOf(partial, final)` and its callback reads whichever arrived. A structured verdict tool (an `AgentTool` that records `{ approved, feedback }`) decides the next round: take-and-clear exactly one verdict per round and fail when it is missing; never infer approval from prose. Keep the requested stop rule; do not add a round cap. Do not close the per-round graph (that would close the shared agents); close the agents once when orchestration finishes, and flush the shared tracer once.

**Mixed nested work.** A deterministic source (a `Deterministic` registered as `{ ...options, state: coroutine }`, `is_available: () => !published`) publishes one `{ kind: "prompt", text }` to an agent (which `recv`s it from its start prompt) and to a nested graph. The nested `JuncoGraph` is registered as `{ ...options, state: child, result: finalId, receive, contract }`, exposing only its deliberately selected final node, so intermediate drafts never escape. The reviewer joins the required finals with `TriggerRule.allOf`, and its staged prompt callback validates them and composes its assignment. Close the root (recursive) and flush separately.

## Executable example

Valid quiescence with a non-returning sink, ordered fan-in, and optional tracing:

```ts
import { graph, schedulers, tracer } from "junco-agency";

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
    new schedulers.ParallelScheduler(),
    graph.Width.create(1),
    graph.UNBOUNDED,
    observer,
  );
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
    await workflow.run();
    return captured;
  } finally {
    await observer?.flush();
  }
}

console.log(JSON.stringify(await collectPair()));
```

Run with `bun run <file>.ts`; it prints `[9,7]`.

## Before returning

- [ ] No checkout, source, example, or machine paths anywhere; only package imports.
- [ ] Every name used exists in the namespace it is spelled from (`graph`, `graph.nodes`, `graph.trigger`, `agent`, `tools`, `mcp`, `schedulers`, `tracer`, or a Pi package).
- [ ] Agent workflows pin models verified *now* (catalog + credentials + official freshness source, dated in JSDoc), or the missing prerequisite is reported. No model IDs were copied from memory or this skill.
- [ ] Tools are explicit per role, with owners, prerequisites (Bun, language servers, native addon, Btrfs seed), and release order stated.
- [ ] The stop condition is intentional and matches the task; finite generators can reach their `return`; no added retries, caps, or agents.
- [ ] Every edge is wired exactly once with the right kind (message vs value); no `Message.create` on value edges; no duplicate trigger entries.
- [ ] The generated program was executed (or typechecked offline) and its output observed; limitations are stated precisely.
- [ ] Graphs close in `finally`, tracer flush runs even if close fails, shared agents are released only after their last round (by the owning graph close or once by their acquirer), LSP shuts down once, collections and session repos close after their users.
