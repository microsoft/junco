---
name: junco-graph-create
description: Create succinct, literate TypeScript Junco workflows using the public graph, agent, tools, mcp, schedulers, compaction, and tracer namespaces. Use whenever a user asks to build a Junco workflow or dataflow graph, coordinate agents, implement fan-out/fan-in or feedback loops, or compose deterministic nodes and nested agencies.
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
import { graph, agent, tools, schedulers, compaction, tracer } from "junco-agency";
```

Import only the namespaces a program uses. Spell node constructors as `graph.nodes.*` and trigger rules as `graph.trigger.*`. Model, session, and content APIs are not re-exported by `agent`; import them from `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-coding-agent`.

The fenced blocks below are **verbatim signature excerpts**, not executable declarations: documentation comments and implementation bodies are omitted. Junco types named in an excerpt under a namespace heading are exported from that namespace (for example `graph.Message`, `graph.ParentView`, `graph.NodeGenerator`, `graph.NodeOptions`, `schedulers.Schedule`) unless marked implementation-local or attributed to a Pi package. Inside excerpts, the branded types are spelled `NodeId`, `EdgeId`, and `Width`; through the namespace, their *type* names are `graph.NodeIdType`, `graph.EdgeIdType`, and `graph.WidthType` (the unsuffixed names are the brand-constructor values).

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
export const NodeId = (value: string): NodeId =>

export type EdgeId = Newtype<string, "EdgeId">;
export const EdgeId = (value: string): EdgeId =>

export type ValidWidth<W extends number> = W extends PositiveInfinity
  ? W
  : W extends 0
    ? never
    : IsNegative<W> extends true
      ? never
      : Integer<W>;

export type Width = Newtype<number, "Width">;
export const Width = <W extends number>(value: ValidWidth<W>): Width =>
export const UNBOUNDED: Width = Number.POSITIVE_INFINITY as Width;

export const messageEdge = <N, T>(id: string): Edge<N, T> =>
export const valueEdge = <N, T>(id: string): Edge<N, T> =>

export const msg = <N, T>(edge: Edge<N, T>, payload: N): Message<N> =>
export const from = <N, T>(
  view: ParentView<N, T>,
  edge: Edge<N, T>,
): readonly N[] =>
```

Verbatim signature excerpts (`graph.JuncoGraph`, `graph.createParallelAgentGraph`):

```text
export class JuncoGraph<
  N = AgenticInput,
  T = AssistantMessage,
  EH = unknown,
  Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>,
> extends DataflowGraph<Agentic<N, T>, N, T, EH, Q>

  constructor(scheduler: Q, window: Width, threads: Width, tracer?: DataflowTracer)
  get signal(): AbortSignal
  abort(reason: unknown = new DOMException("Graph aborted", "AbortError")): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>

export function createParallelAgentGraph<N = AgenticInput, T = AssistantMessage>(
  tracer?: DataflowTracer,
): JuncoGraph<N, T>
```

Construction rules:

- **Choose the graph class by node state.** `graph.DataflowGraph<S, N, T, EH>` holds ordinary state such as `undefined`. `graph.JuncoGraph` / `graph.createParallelAgentGraph()` hold lifecycle-owned states only: prompt agents, nested `JuncoGraph`s, and `graph.nodes.Deterministic` coroutines. Never cast `{ state: undefined }` into a `JuncoGraph`.
- **`graph.nodes.Agentic` is the graph-state union**, not the cooperative agent interface `agent.Agentic`.
- **Edges.** Message edges queue emitted `N`; value edges receive the source's returned `T` once. Read message batches with `graph.from(view, edge)` or `view.messages`; read parent results through `view.values.get(edge.id)`. `msg`/`emit` target wired message edges, never value edges. Edge IDs must be unique per source-outbound and per target-inbound set. Register both endpoints before `addEdge`. Never mutate an edge's transport.
- **Generator protocol.** A dependent body starts with `let view = yield []`; priming does not consume its queued inputs. Each activation advances the generator once. Returning `T` marks the node done and resolves its value edges. Annotate a hand-written body as `async function* (): graph.NodeGenerator<N, T> { … }`.
- **Generic inference.** `emitOnce`, `stepNode`, and `msg` infer `N` from their arguments. When the graph's `N` is a union, pass explicit generics (`graph.nodes.emitOnce<void, Payload, string>(…)`, `graph.nodes.stepNode<void, Payload, string>(…)`). `graph.from(view, edge)` returns the view's (graph-wide) `N`, not the edge's narrower type: narrow each payload with a type guard instead of casting.
- **Agent graphs use `AgenticInput` messages and `AssistantMessage` results** (the `JuncoGraph` defaults). A deterministic node feeding an agent emits `{ kind: "prompt", text }`.
- **Closing.** `JuncoGraph.close()` recursively and terminally closes every member: agents, nested graphs, Pi schedulers, coroutines. Results stay readable. Registering an agent therefore hands its lifetime to the graph; before registration, the acquirer closes it (`await using`, or `await member[Symbol.asyncDispose]()` for each earlier acquisition when a later one fails). Repeated close is safe. A graph whose members must outlive it (persistent agents across rounds) is not closed per round; close the members once at the end.
- **Execution.** `run()` returns cumulative completed-node results when nothing is available; it does not prove every node finished, and a streaming sink may legitimately stay unfinished. `step()` runs at most one window. Never overlap `step`/`run` on one graph. Do not catch and silence `DataflowDefinitionError`, `DataflowNodeError`, or cancellation.

### graph.nodes

Verbatim signature excerpts (body helpers and constant factories; `ConstNodeOptions` and `ConstNodeSpec` are implementation-local supporting types):

```text
export const emitOnce = <S, N, T>(
  batch: () => Message<N>[],
  ret: T,
): StepFn<S, N, T> =>

export const stepNode = <S, N, T>(
  fn: (state: S, view: ParentView<N, T>) => Message<N>[],
): StepFn<S, N, T> =>

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

export const ConstFanout = <S, N, T>(
  payload: N,
  outputs: readonly Edge<N, T>[],
  options: ConstNodeOptions<S, T>,
): ConstNodeSpec<S, N, T> =>

export const ConstFanin = <S, C, T>(
  inputs: readonly Edge<C, T>[],
  output: Edge<C[], T>,
  options: ConstNodeOptions<S, T>,
): ConstNodeSpec<S, C | C[], T> =>
```

- `emitOnce` emits its batch, then returns `ret` on the next activation. `stepNode` never returns: use it for a streaming sink.
- A finite generator's trigger/availability must still admit the activation that performs its final `return`. Bound feedback loops by the task's actual stop condition.
- Constant factories return complete specs; `{ state, ret }` is required (`undefined` only where the graph's types allow it). Invoke a factory once per node.
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

export type AgenticNode<N = AgenticInput, T = AssistantMessage> = NodeSpec<Agentic<N, T>, N, T>;

export type AgentNodeBinding = {
  readonly prompt?: string;
  readonly receive?: (view: ParentView<AgenticInput, AssistantMessage>) => readonly AgenticInput[];
  readonly emit?: (step: Extract<AgenticStep, { kind: "yield" }>) => Message<AgenticInput>[];
};

export type GraphNodeBinding<N = AgenticInput, T = AssistantMessage> = {
  readonly result: NodeIdType;
  readonly receive?: (view: ParentView<N, T>) => void | Promise<void>;
  readonly afterStep?: () => void | Promise<void>;
};

export function agentNode(
  agent: JuncoAgent | MockAgent,
  options: NodeOptions<AgenticInput, AssistantMessage>,
  binding: AgentNodeBinding = {},
): AgenticNode

export function deterministicNode<N, T>(state: Deterministic<N, T>, options: NodeOptions<N, T>): AgenticNode<N, T>

export function graphNode<N, T, EH, Q extends DataflowScheduler<N, T>>(
  graph: JuncoGraph<N, T, EH, Q>,
  options: NodeOptions<N, T>,
  binding: GraphNodeBinding<N, T>,
): AgenticNode<N, T>

export class Deterministic<N = AgenticInput, T = AssistantMessage> implements NodeGenerator<N, T>
  constructor(body: (signal: AbortSignal) => NodeGenerator<N, T>)
  abort(reason: unknown = new DOMException("Deterministic aborted", "AbortError")): Promise<void>
  close(): Promise<void>
```

- `agentNode` runs **one prompt** per node and returns when that run settles, so a source node with `trigger: always()` and `binding.prompt` runs exactly once. Start an idle agent with `binding.prompt` or a `{ kind: "prompt" }` input from `receive`. While the run is in progress, each resume activation calls `receive` again with only new data (`values` hold parent results not delivered before), so return `[]` when nothing new arrived. `emit` receives a `yield` boundary carrying `reasons`, not an assistant message; it is called only when the agent pauses. A settled run becomes the node's `AssistantMessage` result; a failed run throws its native error.
- Never separately iterate an agent the graph is driving.
- `deterministicNode` registers a `Deterministic` coroutine whose `body(signal)` speaks the same generator protocol; a coroutine has one consumer, so register it once. Honor `signal` in long loops.
- `graphNode` requires `binding.result` to name an **already registered** child node; a child that quiesces without that result fails. Use `receive` to feed the child (for example by queuing an input on a source the child exposes) and select only the deliberate final node, so intermediate drafts never escape.

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

export const on = <N, T>(edge: Edge<N, T>): TriggerEntry<N, T> =>
export function allOf<
  const Entries extends readonly TriggerEntry<unknown, unknown>[],
>(...entries: Entries): TriggerRule<
  Entries[number][typeof triggerEntry][0],
  Entries[number][typeof triggerEntry][1]
>;
export function allOf<N = never, T = never>(
  ...entries: readonly TriggerEntry<N, T>[]
): TriggerRule<N, T>;
export function anyOf<
  const Entries extends readonly TriggerEntry<unknown, unknown>[],
>(...entries: Entries): TriggerRule<
  Entries[number][typeof triggerEntry][0],
  Entries[number][typeof triggerEntry][1]
>;
export function anyOf<N = never, T = never>(
  ...entries: readonly TriggerEntry<N, T>[]
): TriggerRule<N, T>;
export const when = <N, T>(edge: Edge<N, T>): TriggerRule<N, T> =>
export const always = <N = never, T = never>(): TriggerRule<N, T> =>
export const never = <N = never, T = never>(): TriggerRule<N, T> =>
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

- Spell conjunction `allOf(on(a), on(b))` and disjunction `anyOf(on(a), on(b))`; never arrays, bare edges or bare `EdgeId`s (`triggerEntry` is an implementation-local type-only brand; an entry is the edge id string at runtime).
- Entries carry their edge's message and result types: an unannotated `allOf`/`anyOf` infers the union of every entry's payloads, and a rule only fits a node whose payload types include them. A narrow rule serves a wider-payload graph; a wrong-payload rule is a compile error.
- `anyOf` is ordered: ordinary trigger-driven reads take only the first satisfied entry. `when(edge)` is a single-edge conjunction. `always()` is the empty conjunction (sources); `never()` the empty disjunction. Without type arguments, empty rules fit every graph.
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
  readonly prompt?: string;
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
  next(): Promise<IteratorResult<AgenticStep, void>>
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
  runWithTaskHost<R>(host: TaskToolHost, work: () => Promise<R>): Promise<R>
  createSubagents(options: readonly TaskAgentOptions[], signal?: AbortSignal): Promise<JuncoAgent<S, P, AgentTool>[]>

export type TaskAgentOptions = { readonly model?: ModelIdentity; readonly tools?: readonly string[] };

export class JuncoAgentError extends Error
  constructor(
    readonly code: "invalid_argument" | "invalid_state" | "busy" | "closed",
    message: string,
    options?: ErrorOptions,
  )
```

The voluntary-suspension tool lives under **`tools`** (see below), not `agent`.

- **Construct with the static factories.** The constructor is protected: `await agent.JuncoAgent.create(...)`, never `new agent.JuncoAgent(...)`.
- **Normal construction:** `create({ models, provider, model, systemPrompt, tools })`. It resolves the exact IDs, checks the saved login, and owns its default in-memory session. A supplied `session` transfers to the agent.
- **Pre-resolved construction:** `fromResolved({ models, model, session, tools })` only with an already resolved native `Model<Api>` and a Pi core `Session`; the session transfers.
- **MCP tool sources:** both factories accept `mcp.JuncoMcpTools` definitions in `tools`, alone or mixed with concrete tools (`tools: [servers, lsp, ...collection.tools]`), connected from `cwd`. Each agent gets fresh MCP clients and server processes, closed with it; discovered names are `mcp__<server>__<tool>`. A definition is a factory-only source: `setTools` takes concrete tools only.
- **Three model argument shapes; never substitute one for another:** `create` takes a model ID *string* in `model`; `fromResolved` takes a resolved `Model<Api>` in `model`; `setModel` takes `{ provider, modelId }` (`ModelIdentity`).
- **Final text:** use `contentText(message.content)` from `@earendil-works/pi-ai`; require `message.stopReason === "stop"` and nonblank trimmed text before forwarding a report.
- **Iterator boundaries:** preserve `yield` / `settled` / `failed`; rethrow a failed boundary's `error`. `return()` and an early `for await` break close the agent terminally; to reuse an agent across rounds drive it with explicit `next()` (or let `agentNode` drive it).

### tools

Verbatim signature excerpts (`NativeMux`, `NativeModule`, `EditStore` are native-addon contracts exported as types only — `tools.NativeMux`, `tools.NativeModule`, `tools.EditStore` — whose runtime constructors live only behind the `junco-tools/native` subpath; `BashToolOptions`, `BashOperations` are Pi coding-agent types re-exported as types):

```text
export interface ToolCollectionOptions {
  bash?: BashToolOptions;
  mux?: NativeMux;
  native?: NativeModule;
  sandbox?: "shared" | "always";
  principal?: string;
}

export class ToolCollection
  readonly tools: AgentTool<any>[];
  static async create(cwd: string, options: ToolCollectionOptions = {}): Promise<ToolCollection>
  async close(): Promise<void>

export interface LspToolOptions {
  readonly readOnly?: boolean;
}
export type LspToolInput = Parameters<UpstreamLspTool["execute"]>[1];
export type LspToolDetails = UpstreamLspToolDetails;
export type LspTool = AgentTool<TUnsafe<LspToolInput>, LspToolDetails | undefined> & LspToolFields;
export const LspTool = {
  async create(cwd: string, options: LspToolOptions = {}): Promise<LspTool>
  async shutdown(): Promise<void>

export type ShellMuxOperations = BashOperations & { close(): Promise<void> };
export function createShellMuxOperations(options?: {
  readonly native?: NativeModule;
  readonly mux?: NativeMux;
  readonly sandbox?: "shared" | "always";
  principal?: string;
}): ShellMuxOperations

export interface ShellMuxLease {
  readonly mux: NativeMux;
  readonly native: NativeModule;
  readonly closed: boolean;
  release(): void;
}
export function acquireShellMux(
  cwd: string,
  options?: { readonly native?: NativeModule; readonly mux?: NativeMux; readonly sandbox?: "shared" | "always" },
): Promise<ShellMuxLease>
export function shutdownShellMux(): Promise<void>

export const MARSH_POLICY_DENIED = "MARSH_POLICY_DENIED";
export interface MarshPolicyDeniedError extends Error {
  readonly code: typeof MARSH_POLICY_DENIED;
}
export function isMarshPolicyDenied(error: unknown): error is MarshPolicyDeniedError

export type YieldToolDetails = { readonly reason: string };
export type YieldTool = AgentTool<typeof yieldParameters, YieldToolDetails>;
export function createYieldTool(): YieldTool
export function isYieldTool(tool: object): boolean

export type TaskToolDetails = {
  readonly tasks: readonly { readonly id: string; readonly name?: string }[];
};
export type TaskToolHost = (
  toolCallId: string,
  input: Static<typeof taskParameters>,
  signal: AbortSignal,
) => Promise<TaskToolDetails["tasks"]>;
export function createTaskTool(host?: TaskToolHost): AgentTool<typeof taskParameters, TaskToolDetails>
export function isTaskTool(tool: object): tool is AgentTool<typeof taskParameters, TaskToolDetails>
export function invokeTaskTool(tool, host: TaskToolHost, toolCallId: string, input, signal: AbortSignal): Promise<AgentToolResult<TaskToolDetails>>
```

(`yieldParameters` is implementation-local: `{ reason: string }`, non-empty, no extra properties. `isYieldTool` is true only for a tool object returned by `createYieldTool()`; a same-named tool or a spread copy is not one. `taskParameters` is implementation-local: `{ context: string; tasks: { name?: string; task: string; model?: { provider: string; modelId: string }; tools?: string[] }[] }`, required shared `context` prepended to every task, at least one task, non-blank strings, no extra properties. The same branding rule applies to `isTaskTool`.)

(`UpstreamLspTool`, `UpstreamLspToolDetails`, `LspToolFields`, `TUnsafe` are implementation-local. `LspTool` is a factory object plus a tool type, not a constructible class.)

Native tool factories, by capability (`read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`). Verbatim signature excerpts; the return-type aliases (`ReadToolDetails`, `NativeGrepToolDetails`, `FindToolDetails`, `BoundedToolDetails`, `Ast*Result`, `DiffStreamResult`, the `*Schema` values, and the `createPi*` upstream factories) are signature references, not importable namespace types; `HashlineEditDetails` is exported:

```text
export function createReadTool(
  cwd: string,
  store: EditStore,
  native: NativeModule,
  mux: NativeMux,
): AgentTool<ReturnType<typeof createPiReadTool>["parameters"], ReadToolDetails | undefined>

export const createBashTool: typeof createPiBashTool = (cwd, options) =>

export function createEditTool(
  cwd: string,
  store: EditStore,
  native: NativeModule,
  mux: NativeMux,
): AgentTool<typeof editSchema, HashlineEditDetails>

export function createGrepTool(
  cwd: string,
  store: EditStore,
  native: NativeModule,
  mux: NativeMux,
): AgentTool<ReturnType<typeof createPiGrepToolDefinition>["parameters"], NativeGrepToolDetails>

export function createFindTool(
  cwd: string,
  native: NativeModule,
  mux: NativeMux,
): AgentTool<ReturnType<typeof createPiFindTool>["parameters"], FindToolDetails | undefined>

export function createAstGrepTool(
  cwd: string,
  native: NativeModule,
  mux: NativeMux,
): AgentTool<typeof astGrepSchema, BoundedToolDetails<AstFindResult>>

export function createAstEditTool(
  cwd: string,
  native: NativeModule,
  mux: NativeMux,
): AgentTool<typeof astEditSchema, BoundedToolDetails<AstReplaceResult>>

export function createDiffTool(
  native: NativeModule,
): AgentTool<typeof diffSchema, BoundedToolDetails<DiffStreamResult>>
```

Prefer `tools.ToolCollection.create(cwd)` over assembling these factories by hand: it builds all eight tools, and its `read`, `grep`, and `edit` share one provenance store. LSP is not in the collection. There is no `tools.write` or `tools.ls`.

Tool selection and ownership:

- **Pure prompt/review agents get explicit `tools: []`.** Omitting `tools` makes `create` acquire the native collection plus `task` and `yield`. Explicit arrays replace defaults.
- **Voluntary suspension** needs the real `tools.createYieldTool()` in the explicit array; an arbitrary tool named `yield` is not the scheduling primitive. Executing it only returns its reason; a `JuncoAgent` pauses at it, while a plain Pi agent continues.
- **Subagents** need the real `tools.createTaskTool()` among the caller's tools and the caller driven by `agentNode`. A successful call returns handles immediately; at the following pause the node's state becomes a `graph.Spawn` graph rooted at the same caller, one child per task, and each child's final `task_result` report reaches the caller as a follow-up. The node returns the caller's answer only after every report was answered. Children inherit the caller's model, active tools and registered MCP definitions (fresh servers each) unless a task names a `model` or narrower `tools`. Outside `agentNode` the call fails as an ordinary tool error.
- **Semantic navigation:** `await tools.LspTool.create(process.cwd(), { readOnly: true })` for read-only roles; enable mutating LSP only for a role that edits. Requires Bun and caller-installed language-server binaries. LSP uses host filesystem/process access, not the native sandbox.
- **Native coding tools** need the built native addon and an existing dedicated Btrfs seed (writable parent, `user_subvol_rm_allowed`). `ToolCollection.create` and omitted agent `tools` both require it, with no ordinary-filesystem fallback. Do not silently swap in other tools when prerequisites are missing; report them.
- **Ownership.** Explicit tool arrays remain caller-owned. Acquire in a guarded sequence so a later constructor failure still closes earlier acquisitions. Drain/close graph members first, then call `LspTool.shutdown()` once after every process-wide LSP user has finished, then close each owned collection. Every agent, graph, collection, operations owner and MCP connection in the process shares one ShellMux automatically; closing any of them never closes it. The application calls `tools.shutdownShellMux()` exactly once, last, after every user has stopped. Keep these resources outside multi-round loops when agents persist.

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
  connect(options?: JuncoMcpConnectOptions): Promise<JuncoMcpConnection>;
  snapshot(): JuncoMcpTools; // detached copy; acquires nothing
}
```

- **Declare a server** with `mcp.JuncoMcpTools.add({ name, type: "stdio", command, args })`; chain `.add(...)` on the result to put several servers in one definition. `command` is resolved through `PATH`, and `args` reach the program literally, never through a shell. Optional fields: `cwd` (resolved against the connecting agent's `cwd`; it must exist inside the seed), `env` (merged over the parent environment; `inheritEnv: false` passes only `env`), `stderr`/`onStderr`, `closeTimeoutMs`, and `clientOptions` (for example `{ requestTimeoutMs: 300_000 }` for a slow-starting server; pi-mcp's default is 30 seconds). `name` must be nonblank and unique within a definition, and becomes the `<server>` of each tool name.
- **Pass the definition to an agent factory:** `tools: [servers]` (or mixed with concrete tools). Defining starts nothing; each agent connects its own client and server process from its `cwd` and closes them when the agent closes. Subagents reconnect fresh servers from a snapshot of the caller's definitions. Select MCP tools by their published `mcp__<server>__<tool>` names in `activeToolNames`.
- **Direct use** outside an agent: `const connection = await servers.connect({ cwd, signal })`, use `connection.tools`, and `await connection.close()` in `finally`. `signal` cancels only acquisition (rejecting with `McpAbortError`) and stops any server already started; a returned connection ignores it.
- **Stdio only.** Every server runs as an audited job of the shared ShellMux (needs the native addon and a Btrfs seed containing `cwd`); its effects publish only when it ends, and a refused publication rejects the closing agent or connection with `MARSH_POLICY_DENIED`. A reply is not proof of publication. Each server works on a snapshot taken when it starts: once another server publishes a change to a path this one has read or written, this server's close is refused, even if it wrote nothing itself. Prepare shared state before starting servers, and do not count on a server that stays running while another publishes to close cleanly.

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

export function createScheduler<State, N = unknown, T = unknown>(
  options: SchedulerOptions<State, N, T>,
): DataflowScheduler<N, T> & {
  state: State;
}

export function createRoundRobinScheduler<N = unknown, T = unknown>(): DataflowScheduler<N, T> & {
  state: NodeId | undefined;
}

export function createParallelScheduler<N = unknown, T = unknown>(): DataflowScheduler<N, T>
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
  "tools" | "activeToolNames" | "model" | "models" | "session"
> & {
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

export async function createAgencyScheduler<
  S extends Skill = Skill,
  P extends PromptTemplate = PromptTemplate,
  N = AgenticInput,
  T = AssistantMessage,
>(
  getGraph: () => JuncoGraph<N, T> | undefined,
  options: Omit<PiSchedulerOptions<N, T, S, P>, "adapter"> = {},
): Promise<PiScheduler<N, T, S, P>>
```

`ScheduleTool` is the Pi scheduler's sole model tool, with the fixed protocol `schedule({ lanes })` where `lanes: string[][]` are node IDs; each successful call runs exactly one bounded graph window and returns a fresh `SchedulerInfo`.

| Requirement | Construction and drive |
|---|---|
| Ordinary independent agent or mixed work | `graph.createParallelAgentGraph()`; `await workflow.run()`. Its agency-aware live reads avoid redelivering retained values. |
| Pure deterministic parallel graph | `schedulers.createParallelScheduler()`, `graph.Width(1)`, `graph.UNBOUNDED`; `run()` or `step()`. One lane per available node; a finite thread bound does not throttle it and can reject the plan. |
| One-node-at-a-time deterministic fairness | `schedulers.createRoundRobinScheduler()`, `graph.Width(1)`, `graph.Width(1)`; `run()` or `step()`. Rotation follows string ID order, so `"1" < "10" < "2"`. |
| Custom or model-driven scheduling | `createScheduler` only for a requested policy; `createAgencyScheduler` when a model must judge scheduling. Drive with the Pi protocol below. |

**Custom policies.** A `Schedule` is lanes × turns; same-column lanes run concurrently; input reads are explicit (`triggerInputs(candidate)` for ordinary reads); `state` is a value, not a factory, and persists across calls. A repeated-batch policy must supply a live `resolveInputs`. One scheduler belongs to one graph. An empty plan while work is available, duplicate IDs in a column, unavailable nodes, invalid reads, and exceeded bounds are errors. There are no exported `RoundRobin` or `Parallel` classes.

**Model-driven agency.** Construction is a cycle:

1. Declare `let workflow: graph.JuncoGraph | undefined`.
2. Create a native session: `const repo = new MemorySessionRepo()` and `const session = await repo.create({}, BACKGROUND_CONTEXT)` (both from `@earendil-works/pi-agent-core`; not the coding-agent `SessionManager`).
3. `const scheduler = await schedulers.createAgencyScheduler(() => workflow, { model, models, session, systemPrompt, prompt })`, passing the currently resolved `Model<Api>`, the runtime, and the session so the factory uses `PiScheduler.make`. Never rely on the factory's fixed-model default when `model` is omitted.
4. `const constructed = new graph.JuncoGraph(scheduler, graph.UNBOUNDED, graph.UNBOUNDED, tracer.createTracer())`, register and wire nodes, then `workflow = constructed`.
5. Drive only the scheduler: loop `await scheduler.next()`; continue after `kind === "yield"`, throw the error after `kind === "failed"`, finish after `kind === "settled"` (require `message.stopReason === "stop"`); `done` before settlement is an error. Do not start a competing `workflow.run()`: the scheduler's synchronous `schedule()` only consumes the model's staged decision.
6. Read results with `workflow.result(id)`, which returns an fp-ts `Option` (no fp-ts import needed): `const r = workflow.result(id); if (r._tag !== "Some") throw …; use(r.value)`.
7. In `finally`, `await workflow.close()` (cascades to the scheduler, which owns the transferred session, and to every member), then `await repo.close(BACKGROUND_CONTEXT)`.

**Multiple model-scheduled rounds with persistent agents.** Closing a graph *or* its scheduler closes every member, so never close a round's graph or scheduler when the round ends. Build each round as a fresh `JuncoGraph` plus its own agency scheduler (one scheduler per graph; each with its own session from the shared repository) whose nodes reuse the persistent agents, staged with that round's `prompt`. Keep every round graph in a list. After a round settles, compact *that* round graph (each persistent agent appears there once). In the outer `finally`, close every round graph (agent close is idempotent), flush each distinct tracer, then close the repository.

Quiescence is not universal node completion, and the runtime rejects a normal scheduler settlement while graph work remains available.

### compaction

Verbatim signature excerpts:

```text
export type CompactionPolicy = "all" | "more-than-forty" | "all-available" | "more-than-forty-available";

export async function compactGraph<A extends Agentic<N, T>, N, T, EH, Q extends DataflowScheduler<N, T>>(
  graph: DataflowGraph<A, N, T, EH, Q>,
  policy: CompactionPolicy,
): Promise<void>
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

export class StdoutTracer implements DataflowTracer
  constructor(name: string = "DataflowGraph.run")
  startRun<S, N, T, EH>(graph: DataflowGraph<S, N, T, EH>): DataflowRunTrace<N, T>
  complain(nodeId: NodeIdType, complaint: string): void
  flush(): Promise<void>

export function createTracer(): DataflowTracer
```

`DataflowTracer` is an interface a backend implements; never `new` it.

- **A `JuncoGraph` always has a tracer.** A direct `new graph.JuncoGraph(...)` requires one as its fourth argument (omitting it throws `TypeError`); `createParallelAgentGraph()` (and `graph.Spawn`) default to `tracer.createTracer()`. A generic `DataflowGraph` without an observer is untraced. `new tracer.DummyTracer()` explicitly disables tracing; pass the same choice to every separately constructed child graph.
- **Backend selection.** `tracer.createTracer()` returns one shared backend per process: `tracer.StdoutTracer` by default, which prints each run's topology as a Unicode graph followed by every activation's full inputs and outcomes (payloads may be sensitive); or, when the user wants Opik, run with `bun run --feature=opik …` (needs the optional `dataflow-engine-opik` and `opik` modules). Any `tracer.DataflowTracer` passed explicitly always wins. The Opik adapter is not a namespace export; never silently fall back to another backend after a configuration failure.
- **Callbacks** are synchronous and read-only. `startRun` fires once per `run()`/`step()`; `startNode` fires per activation with phase `"prime"` (no view, `inputs === undefined`) or `"resume"` (the delivered view); run `end` receives cumulative results; `fail` reports the exact rejection or raw activation cause. `complain` fires when an agent node's always-on `complain` tool records an issue (node ID and text only; the full issue is in `tools.issueLog`), at any time. Views and result maps are live: snapshot anything retained. The engine warns about and ignores observer exceptions.
- **Flushing** is caller-owned and separate from disposal:
  `try { … } finally { try { await workflow.close(); } finally { await workflow.tracer.flush(); } }`.
  `workflow.tracer` exposes the supplied or automatic backend; every graph given `createTracer()` shares a single backend instance. Share one backend across child graphs and flush each distinct backend once after all users stop (collect them in a `Set`). A successful flush does not prove remote ingestion.

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

**Feedback recurrence.** A source (`emitOnce`, trigger `always()`) seeds the recurrence; the recurrence node's trigger `anyOf(on(seed), on(loop))` takes seed or feedback; a self-edge (`addEdge(id, id, loop)`) carries the next state; the task's finite count ends production with a `return`. A generator cannot emit and return in one activation, so the activation that emits the last value still sends feedback; the next activation checks the count and returns. Assert the recurrence's result in the `run()` map to prove completion. A `stepNode` sink drains the output and quiesces without returning. Read the delivered pair with `graph.from` and check its length/types before use instead of non-null assertions. Ten Fibonacci values from seeds `0, 1` are `[0,1,1,2,3,5,8,13,21,34]`.

**Research/review committee.** Agents and their sessions persist; each round builds a fresh `createParallelAgentGraph()`. Value edges fan final reports out, and an `allOf` reviewer fans them in. An optional message edge carries a real `yield` reason (via `agentNode`'s `emit`) as a partial handoff. A structured verdict tool (an `AgentTool` that records `{ approved, feedback }`) decides the next round: take-and-clear exactly one verdict per round and fail when it is missing; never infer approval from prose. Keep the requested stop rule; do not add a round cap. Do not close the per-round graph (that would close the shared agents); close the agents once when orchestration finishes, and flush the shared tracer once.

**Mixed nested work.** A deterministic source (`Deterministic` + `deterministicNode`, `is_available: () => !published`) publishes one `{ kind: "prompt", text }` to an agent and to a nested graph. The nested `JuncoGraph` is registered with `graph.nodes.graphNode(child, options, { result: finalId, receive })`, exposing only its deliberately selected final node, so intermediate drafts never escape. A reviewer joins the required finals with `allOf`. Close the root (recursive) and flush separately.

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
    schedulers.createParallelScheduler(),
    graph.Width(1),
    graph.UNBOUNDED,
    observer,
  );
  const leftEdge = graph.messageEdge<number, string>("left");
  const rightEdge = graph.messageEdge<number, string>("right");
  const collectedEdge = graph.messageEdge<number[], string>("collected");
  const captured: number[] = [];

  /** Sources: each publishes one constant once, then returns its name. */
  const left = workflow.addNode(graph.nodes.ConstFanout(7, [leftEdge], { state: undefined, ret: "left" }));
  const right = workflow.addNode(graph.nodes.ConstFanout(9, [rightEdge], { state: undefined, ret: "right" }));

  /** Collector: emits one list in input order once every input has delivered. */
  const collector = workflow.addNode(
    graph.nodes.ConstFanin([rightEdge, leftEdge], collectedEdge, { state: undefined, ret: "collected" }),
  );

  /** Sink: streams every delivered list into `captured`; never returns. */
  const sink = workflow.addNode({
    state: undefined,
    trigger: graph.trigger.when(collectedEdge),
    step: graph.nodes.stepNode<void, number | number[], string>((_state, view) => {
      for (const payload of graph.from(view, collectedEdge)) {
        if (!Array.isArray(payload)) throw new Error("Collector emitted a non-array payload");
        captured.push(...payload);
      }
      return [];
    }),
  });

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
- [ ] Every name used exists in the namespace it is spelled from (`graph`, `graph.nodes`, `graph.trigger`, `agent`, `tools`, `mcp`, `schedulers`, `compaction`, `tracer`, or a Pi package).
- [ ] Agent workflows pin models verified *now* (catalog + credentials + official freshness source, dated in JSDoc), or the missing prerequisite is reported. No model IDs were copied from memory or this skill.
- [ ] Tools are explicit per role, with owners, prerequisites (Bun, language servers, native addon, Btrfs seed), and release order stated.
- [ ] The stop condition is intentional and matches the task; finite generators can reach their `return`; no added retries, caps, or agents.
- [ ] Every edge is wired exactly once with the right kind (message vs value); no `msg` on value edges; no duplicate trigger entries.
- [ ] The generated program was executed (or typechecked offline) and its output observed; limitations are stated precisely.
- [ ] Graphs close in `finally`, tracer flush runs even if close fails, shared agents are released only after their last round (by the owning graph close or once by their acquirer), LSP shuts down once, collections and session repos close after their users.
