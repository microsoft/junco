# Sealed Agentic members and ordinary graph composition

## Context

Replace junco-agency's current member typing with a sealed `Agentic` set containing exactly `JuncoAgent`, `JuncoGraph`, `MockAgent`, and a new `Deterministic` general coroutine. Make `JuncoGraph` a self-contained nominal class, a subclass of `DataflowGraph`, that carries its own `id` and `description` and describes its members to its own Pi scheduler. dataflow-engine is not changed. Compose graphs with ordinary `addNode`; remove `attachAgency` rather than preserving a separate attachment/ownership model. Export the shared graph/node contracts and migrate existing examples and callers, with no open native-agent-protocol branch or compatibility alias. Compaction must recursively descend into selected nested graphs and compact their model-bearing descendants, including each descended graph's own `JuncoAgent` scheduler. Removing ownership must not leave callers without a working abort or close path for nested runs.

The deterministic member must support the general coroutine pattern used by dataflow-engine's Fibonacci example, not mimic a prompted model agent. `MockAgent` remains an explicitly admitted test implementation.

## Approach

### 1. Publish the closed member set and the general coroutine

Create `src/agentic.ts` as the canonical type module; no equivalent exists in the current source tree. Move the existing `AgenticInput` definition unchanged from `src/agent-node.ts` into it, then define and export these types (all dependencies of this module are type-only imports, including `JuncoGraph` from `./junco-graph.js`):

```ts
export type Agentic<N = AgenticInput, T = AssistantMessage> =
  | JuncoAgent
  | JuncoGraph<N, T>
  | MockAgent
  | Deterministic<N, T>;

export type AgenticNode<N = AgenticInput, T = AssistantMessage> = NodeSpec<Agentic<N, T>, N, T> & {
  /** Shown to the owning JuncoGraph's Pi scheduler; defaults to a JuncoGraph state's own description. */
  readonly description?: string;
  /** Extra JSON-serializable scheduler details, read at each SchedulerInfo snapshot. */
  readonly details?: () => Readonly<Record<string, unknown>>;
};
```

The union is closed by its four concrete nominal classes. Do not introduce an extensible `Agentic` interface, native-agent-protocol branch, implementation registry, or fifth case. A plain `DataflowGraph` is **not** a member; only a `JuncoGraph` is. A `PiScheduler` remains valid through its existing `JuncoAgent` inheritance. Do not retain `AgenticGraph` or `MixedNode` aliases.

Create `src/junco-graph.ts` with the graph class. It is a nominal subclass of `DataflowGraph`, not a wrapper: callers keep the engine's full API (`addEdge`, `step`, `run`, `getNode`, `result`, `forEachNode`, `available`, `scheduler`).

```ts
export type JuncoGraphOptions<Q> = {
  readonly id: string;
  readonly description: string;
  readonly scheduler: Q;
  readonly window: WidthType;
  readonly threads: WidthType;
  readonly tracer?: DataflowTracer;
};

export class JuncoGraph<
  N = AgenticInput,
  T = AssistantMessage,
  Q extends DataflowScheduler<N, T> = DataflowScheduler<N, T>,
> extends DataflowGraph<Agentic<N, T>, N, T, unknown, Q> {
  declare private readonly juncoGraph: void;
  readonly id: NodeIdType;
  readonly description: string;
  readonly #members = new Map<NodeIdType, AgenticNode<N, T>>();
  constructor(options: JuncoGraphOptions<Q>);
  override addNode(spec: AgenticNode<N, T>): NodeIdType;
  describe(id: NodeIdType): Readonly<Record<string, unknown>> | undefined;
  static parallel<N = AgenticInput, T = AssistantMessage>(options: { readonly id: string; readonly description: string; readonly tracer?: DataflowTracer }): JuncoGraph<N, T, ParallelScheduler<N, T>>;
  static pi<N = AgenticInput, T = AssistantMessage, S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>(options: { readonly id: string; readonly description: string; readonly window?: WidthType; readonly threads?: WidthType } & Omit<PiSchedulerOptions<N, T, S, P>, "adapter">): Promise<JuncoGraph<N, T, PiScheduler<N, T, S, P>>>;
  static opus<N = AgenticInput, T = AssistantMessage, S extends Skill = Skill, P extends PromptTemplate = PromptTemplate>(options: { readonly id: string; readonly description: string; readonly window?: WidthType; readonly threads?: WidthType } & Omit<OpusSchedulerOptions<N, T, S, P>, "adapter">): Promise<JuncoGraph<N, T, PiScheduler<N, T, S, P>>>;
}
```

(`ParallelScheduler<N, T>` names `ReturnType<typeof createParallelScheduler<N, T>>`.)

- **Nominality:** the declaration-only private brand, as on `Deterministic`, rejects structural lookalikes and other `DataflowGraph` subclasses. `Q` preserves the concrete scheduler, and `JuncoGraph<N, T, PiScheduler<…>>` is still assignable to the member case `JuncoGraph<N, T>`.
- **Constructor:** calls `super(scheduler, window, threads, tracer)` and stores `id` as `NodeId(id)` together with `description`. Neither field is passed to or stored in dataflow-engine.
- **`addNode`:** when `spec.id` is omitted and `spec.state` is a `JuncoGraph`, the node ID defaults to that graph's `id`; an explicit `spec.id` always wins. Otherwise it delegates to `super.addNode` unchanged, so duplicate IDs still raise `DataflowDefinitionError`. After a successful add it records the spec under the returned ID. The engine still drops the extra spec fields from its own `Node`.
- **`describe(id)`:** returns `undefined` for an unknown ID. Otherwise it merges `description` (the spec's own, else a `JuncoGraph` state's `description`) with `spec.details?.()`, and returns `undefined` when the merge is empty. It never throws for missing details.
- **`JuncoGraph.parallel`:** replaces `createParallelAgentGraph`, using a fresh `createParallelScheduler()`, `Width(1)`, `UNBOUNDED`, and the optional tracer.
- **`JuncoGraph.pi` / `JuncoGraph.opus`:**
  - Each builds its scheduler through `PiScheduler.make` / `PiScheduler.opus`, passing the remaining native options plus an internal adapter `{ describeNode: (nodeId) => graph?.describe(nodeId) }`. The adapter is bound late, after the graph is constructed.
  - The adapter's only job is describing members: no guard, no input override, no abort/close dependents. Callers cannot supply their own adapter (`Omit<…, "adapter">`).
  - `window` and `threads` default to `UNBOUNDED`.
  - If graph construction throws after the scheduler exists, close that scheduler, then rethrow with any close failure attached.
- **Ownership:** a `JuncoGraph` owns neither its scheduler nor its node states. Callers close `graph.scheduler` and their agents explicitly (see §2).
- **Custom schedulers:** a `PiScheduler` built separately and passed to `new JuncoGraph(...)` gets no member details. Document this; it is not an error.

Create `src/deterministic.ts` with exactly this coroutine-bearing class; no existing junco-agency member represents arbitrary deterministic generator code:

```ts
export class Deterministic<N = AgenticInput, T = AssistantMessage> {
  declare private readonly deterministic: void;
  constructor(readonly step: (this: void) => NodeGenerator<N, T>) {}
}
```

The declaration-only private member provides nominal typing without a runtime branding field. The supplied factory captures ordinary coroutine state in its closure; `this: void` rejects factories requiring an unrelated node receiver. Install the factory directly as a node's `step`, so the engine creates and advances the real generator without another wrapper. Preserve `NodeGenerator`'s priming, input batches, arbitrary message/result types, thrown errors, and nonterminating sinks. Do not add fake prompting, context, compaction, status, or lifecycle methods. Use explicit channel parameters when constructing examples, e.g. `new Deterministic<number, string>(...)`, and add it with `graph.addNode({ state: coroutine, trigger, step: coroutine.step })` typed as `AgenticNode<number, string>`.

Move `test/mock-agent.ts` to `src/mock-agent.ts` using the language server's file move/refactoring support, after references discovery. Reuse its entire replay implementation, public observations, maintenance queue, cancellation, hooks, and disposal behavior; do not rewrite the mock. Keep its compile-time conformance to junco-agent's native member interface, but import it under an alias so it cannot collide with the new union: `import type { Agentic as NativeAgentic } from "junco-agent"`. Rename the existing type queries (`NativeAgentic["compact"]`, `NativeAgentic["navigateTree"]`, `NativeAgentic["events"]`, `NativeAgentic["hooks"]`) and keep `implements NativeAgentic<S, P, T>`. Implementing that interface only checks the mock's shape; it does not add a branch to the closed `Agentic` union. The mock remains its own nominal class, not a subclass that needs a live JuncoAgent harness. Remove the old test module rather than leaving a re-export shim.

Export `Agentic`, `AgenticInput`, `AgenticNode`, `JuncoGraph`, `JuncoGraphOptions`, `Deterministic`, and `MockAgent` from `src/index.ts`; export the mock's existing public transcript/observation types (`MockTerminal`, `MockHook`, `MockFrame`, `MockRun`, `MockMaintenance`, `MockTranscript`, `MockRequest`, `MockCall`, `MockHookResult`) there as well. Migrate test imports from the old mock module to the package's existing source entrypoint, `../src/index.ts`. `src` must not import anything under `test`.

The moved mock uses `Promise.withResolvers` at its real boundary/iterator sites. Set `tsconfig.json`'s `compilerOptions.lib` to `["ES2024", "DOM", "DOM.Iterable"]`, retaining the existing `target: "ES2022"`; this supplies the runtime capability's types without changing emitted syntax or adding Bun-only globals to production compilation. A strict planning probe exposed the missing Promise declaration under the old production libs and passed with this setting.

### 2. Use ordinary graph nodes instead of attachment

Cut over the adapter, graph factory, deleted attachment APIs, and every affected caller together; do not leave a compiling library with examples/tests still depending on attachment.

- In `src/agent-node.ts`, import `AgenticInput` and `AgenticNode` from `./agentic.js`. Change the public signature to `agentNode<A extends JuncoAgent | MockAgent>(agent: A, options: AgentNodeOptions): AgenticNode & NodeSpec<A, AgenticInput, AssistantMessage>`. The generator closes over `agent` and never uses `this.state`: infer its no-`this` function type instead of annotating it `StepFn<A, ...>`. This makes the same returned spec valid for both a `JuncoGraph` and existing concrete-state engine graphs, without casts or another runtime adapter. Preserve prompt admission, dispatch order, fresh-value delivery, yield routing, settlement, and original failures.
- Remove `AgentNodeRecord`, `agentNodeRecord`, and their WeakMap. Keep `started`, `seenValues`, and `lastYield` as ordinary per-node closure state. Make `AgentNodeOptions.description` optional and copy it into the returned spec's `description`. Also return `details: () => ({ agentStatus: agent.status, ...(lastYield === undefined ? {} : { lastYield }) })`. Together these reproduce the existing SchedulerInfo `details` shape `{ description, agentStatus, lastYield }` with no registry. A concrete-state engine graph ignores both fields; only `JuncoGraph` reads them.
- Preserve the removed adapter's `anyOf` fairness in the ordinary node itself. For an `"any"` trigger, allocate one node-owned mutable copy of `trigger.rule` and install `{ kind: "any", rule: remainingEdges }`; never mutate the caller's trigger. The engine stores the installed trigger by reference (`DataflowGraph.addNode`) and re-evaluates it at every admission, so this needs no engine change. Extend private `unseenValues` with an optional `EdgeId[]` retirement list. Whenever it first records a resolved parent value in `seenValues`, remove that ID from the owned list if present, **unless it is the last remaining edge**. An empty `"any"` rule never fires, so retiring the last edge would also stop `triggered` from admitting a not-yet-started member that later becomes `ready`. A retained last value edge only re-reads a value edge, which pops nothing, and `hasFreshInput` already ignores it. The value still reaches `receive` once. Later default scheduler reads select fresh message edges instead of the permanently resolved value; priming retires nothing, and `started` still permits final resumption. Leave `"all"` triggers unchanged so cached parent values continue satisfying their conjunction and message reads remain atomic. Do not add scheduler adapters or change dataflow-engine's global trigger semantics.
- Delete `src/parallel-agent-graph.ts` and its `createParallelAgentGraph` export; `JuncoGraph.parallel` replaces it.
- Delete `src/agency.ts` and `src/agency-membership.ts` and remove `attachAgency`, `createAgencyScheduler`, and `AgencyGraph` from the public entrypoint. Use `JuncoGraph.pi` or `JuncoGraph.opus` where model-driven scheduling is needed. The engine constructor already configures and binds the scheduler; no explicit or hidden attachment, owner registry, graph monkey-patch, or topology freeze replaces the deleted layer.
- A `JuncoGraph` does not own its scheduler or node states. Callers own their agents and Pi schedulers (`graph.scheduler`); each native actor still owns its transferred session. For callers currently relying on agency ownership, track and explicitly close every successfully created actor, including construction/assertion/run failure paths. Start closes for all locally tracked actors before joining them, so closing a scheduler cannot wait indefinitely for a descendant that has not yet been closed. Join all outcomes and report cleanup failures. Preserve the already explicit `await using` scopes and member disposers in the mixed/committee examples. Do not close graphs or close transferred sessions a second time; closing the root scheduler does not close descendant actors. This is caller-local resource management, not a replacement ownership registry.
- **Abort follows the same caller-local rule.** Without `abortDependents`, `JuncoAgent.abort()` still waits for its in-flight schedule-tool windows, and the engine checks the graph signal only between steps. Aborting only the root scheduler therefore waits for any descendant whose `next()` is pending, possibly forever for a suspended member. A caller that aborts a nested run starts `abort()` on every tracked live actor (root scheduler, child schedulers, leaves) before joining any. It joins every outcome and reports failures as one `AggregateError`, in tracking order. Put one caller-local helper, `stopAll(kind: "abort" | "return", actors: readonly JuncoAgent[]): Promise<void>`, in `test/support.ts` and use it for both test abort and cleanup. `examples/recursive-agency.ts` writes the same start-all-then-join cleanup inline. Do not export it from `src`: it is not an ownership model.
- **Pi scheduler member details come from the graph.** `JuncoGraph.pi`/`opus` install `describeNode` → `graph.describe(id)`. The scheduler's model therefore sees each candidate's `description`, `agentStatus` and `lastYield` again, for both leaves and nested graphs, with no caller-written adapter.

#### Complete caller migration

Keep the implementation inside junco-agency. The existing installed dataflow-engine, junco-agent, and junco-scheduler APIs suffice; do not change those libraries or add dependencies.

- **`examples/mixed.ts`:** remove its local `Agentic`, `AgenticGraph`, and `MixedNode` declarations and the two `as MixedNode` casts. Build both graphs with `JuncoGraph.parallel({ id, description })`: Ralph's child graph as `id: "Ralph"`, and the outer graph. Use `AgenticNode` for the explicit Ralph node spec, whose state is now the Ralph `JuncoGraph`. Direct and Reviewer use inferred `agentNode(...)` and keep their existing `description` options. Preserve Ralph's one child step per parent activation, primary/feedback/update queues, final-result gating, goal reporting, and existing `await using` cleanup. Do not replace Ralph's graph state with a scheduler or agent wrapper.
- **`examples/oss-committee.ts`:** remove the imported native `Agentic` interface. Its role members are created as `JuncoAgent`s, so set `Members = Readonly<Record<MemberId, JuncoAgent>>`; do not broaden a role record that requires model-agent operations to graph/coroutine variants. Replace `createParallelAgentGraph(tracer)` with `JuncoGraph.parallel({ id: <per-round id>, description: <round purpose>, tracer })`. Remove every `agentNode<Agentic>` type argument but keep the node `description`s. Preserve all prompts, tools, rounds, and existing member disposal.
- **`test/oss-committee.fixture.ts`:** make its successful-creation list `JuncoAgent[]` and remove the native `Agentic` import. Keep the current construction-failure cleanup and async disposer. The scripted models and returned committee fields do not change.
- **`test/support.ts`:**
  - Replace `newScheduler`/`agencyGraph` with one helper that calls `JuncoGraph.pi<AgenticInput, AssistantMessage>({ id, description, session, models, model, prompt?, systemPrompt?, window, threads })` over the existing explicit faux model/session. It returns `{ graph, scheduler: graph.scheduler, faux, session }`, typed `JuncoGraph<AgenticInput, AssistantMessage, PiScheduler<AgenticInput, AssistantMessage>>`.
  - Remove attachment language.
  - Narrow `drive` to `JuncoAgent` (PiScheduler inherits it); it must not accept the broad graph/coroutine union.
  - Add `stopAll` (above). Keep `waitingTool`: the retained abort fan-out case uses it.
  - Remove imports left unused; retain `nativeOptions`, `leaf`, `scripted`, `schedulerModel`, `runAvailable`, `scheduleCall`, `settledText`, and `flushMacrotasks`.
- **`examples/recursive-agency.ts` and `test/junco-agency.test.ts`:**
  - Change each local `agency` construction helper to `JuncoGraph.pi({ id: name, description: ..., ... })` returning the graph, never an `agency` alias. Its input members are the concrete subset `JuncoAgent | JuncoGraph<AgenticInput, AssistantMessage, PiScheduler<AgenticInput, AssistantMessage>>`.
  - For a leaf, use `agentNode(leaf, { description: \`${name} member ${index}\`, trigger })`.
  - For a child, close the body over `child.scheduler` but install `child` (the `JuncoGraph`) as the node state, as shown below. Its node ID and description default to the child graph's own.
  - Pass child **graphs** at every nesting level; drive the root scheduler's iterator, and read member results from retained graphs.
  - Keep the recursive example's interleaving, one-window-per-schedule behavior, two leaf provider requests, one sibling request, and eight root windows.
  - Track every created scheduler and leaf for explicit cleanup, including failed construction and assertions.
  - `resultOf`/`resultText` need only a `JuncoGraph` argument because they read results, not scheduler-specific methods.

```ts
// child: JuncoGraph<AgenticInput, AssistantMessage, PiScheduler<…>> keeps its PiScheduler through Q.
const node: AgenticNode = { ...agentNode(child.scheduler, { trigger: always() }), state: child };
parent.addNode(node); // node id = child.id; SchedulerInfo details = { description: child.description, agentStatus: child.scheduler.status, ... }
```

This is an ordinary node spec, not a new public adapter. The body never reads `this.state`. Do not substitute `child.graph.run()` for the Pi iterator: the Pi scheduler obtains its plan from its active schedule-tool call. The parallel child in `mixed.ts` continues to use `child.graph.step()`.

- **`test/deterministic-support.ts`:** remove `MockAgencyOwner`, `isMockOwner`, `MockAgency`, `mockAgency`, and the production membership import, including all guards and scheduler monkey-patches. Keep the real `policy` factories, transcript builders, and observation helpers. Keep the concrete `MockAgent` state of `MockGraph`, but give its fifth type parameter `PolicyScheduler` so the round-robin test can still inspect `graph.scheduler.state`. Extend the existing helper to `plainGraph(strategy: Strategy, { threads }: { readonly threads?: WidthType } = {}): MockGraph`, using the existing `bounds` function. It must return the real graph, not a guarded proxy.
- **`test/deterministic-agency.fixture.ts`:** retain `runDeterministicFixture(strategy): Promise<DeterministicSummary>` and all summary fields. Use `plainGraph`, `graph.run`, and explicit producer/worker cleanup; remove the owner and `attach`. Keep producer `seed`, worker `done`, input order `['upstream: seed', 'context first', 'then work']`, and `closed: true` for both policies.
- **`test/deterministic-agency.test.ts`:** replace retained `mockAgency` uses with `plainGraph`, and pass a `MockGraph` to `stepUntil`. Use the graph directly for `step`, `run`, `getNode`, results, and scheduler state. `MockGraph` stays a concrete-state engine graph, so its `member` helper's `description` argument is now just ignored there; keep the helper's signature and callers unchanged. Keep `DRIVE`, `gatedRun`, and the start/release barrier needed by the retained cancellation/concurrency cases; remove the cancellation-observation branches and helpers used only by deleted owner-cascade tests. The exact keep/delete boundary is below.
- **`test/pi-scheduler.test.ts`:** build graphs with the `JuncoGraph.pi` helper, use `graph.scheduler` directly, remove attachment and `agentNode<Agentic>`, and narrow `toolErrors` to `PiScheduler<AgenticInput, AssistantMessage>`. Return the created leaf from `singleMember` so its callers can close both actors. Keep the test `SchedulerInfo describes only candidate members: description, Agentic status and pause reasons` and its exact `details` assertions: `JuncoGraph` now produces them. Preserve candidate availability/status transitions, hidden idle members, non-disclosure of completed results, retained results after repeated node occurrences, window-start candidate validation, and `anyOf` input fairness. All created actors must be explicitly disposed.
- **`test/agent-node.test.ts`:** import `MockAgent` through the public source entrypoint; keep the existing node `description` options. Preserve all existing prompt, priming, input-order, quiescence, yield, result, failure, and member-reuse scenarios over both real policies. No new node wrapper or member protocol is introduced for tests.
- **Mock module move consumers:** rewrite imports in exactly `test/mock-agent.test.ts`, `test/agent-node.test.ts`, `test/agentic.types.ts`, `test/compaction.test.ts`, `test/deterministic-support.ts`, `test/deterministic-agency.fixture.ts`, and `test/deterministic-agency.test.ts` to `../src/index.ts`, including the public mock transcript/observation types they use. Preserve the replay behavior suite; update comments that incorrectly describe the whole new `Agentic` union as a model-agent interface.
- **`test/agentic.types.ts`:** replace native-interface and attachment proofs with the public closed-union contracts. Keep specialized JuncoAgent skill/template/tool fields, and call `JuncoGraph.pi` and `JuncoGraph.opus` with their explicit channel/skill/template generics. Prove:
  - `JuncoGraph` preserves a specialized `PiScheduler` through `Q` and is still assignable to `Agentic`;
  - `agentNode` preserves concrete JuncoAgent/MockAgent state and fits both a `JuncoGraph` and a concrete MockAgent graph without casts;
  - the child-graph node spec above compiles.

  Keep maintenance return-type proofs only on JuncoAgent, MockAgent, and PiScheduler, not on the broad union. Add positive cases for all four members and non-agent numeric/string channels. Add `@ts-expect-error` consumers rejecting:
  - a plain `DataflowGraph<Agentic, …>` as a member;
  - a structural `JuncoGraph` lookalike (`{ ...graph }`);
  - a structural fifth member;
  - a receiver-dependent Deterministic factory;
  - graphs/coroutines passed to `agentNode`;
  - model maintenance called on an unnarrowed `Agentic`.
- **Intentionally unchanged behavior suites:** `test/mixed.test.ts`, `test/oss-committee.test.ts`, and `test/policy-yield.test.ts`. Their real-agent/scripted-tool/native-policy behavior remains in scope for verification; do not rewrite their assertions merely to accommodate a typing cutover.
- **Existing documentation/configuration:** update `README.md`'s introduction, Usage, API, Members, Scheduling, Attachment/ownership, Compaction, and Verification sections to the new contracts. Show the four public cases, the `JuncoGraph` class with its `id`/`description` and `parallel`/`pi`/`opus` factories, and ordinary `addNode`. Remove the old attachment, implicit descendant-close/abort, `createParallelAgentGraph`, and direct-only compaction claims. Document:
  - caller-owned actors (including `graph.scheduler`), with the start-all-then-join pattern for both `abort()` and `return()` on nested runs;
  - SchedulerInfo `details` coming from `AgenticNode.description`/`details` and child graphs' own descriptions, only under `JuncoGraph.pi`/`opus`;
  - per-level recursive compaction selection, including descended graphs' `JuncoAgent` schedulers and slash-joined node paths in errors.

  Point mock documentation to `src/mock-agent.ts`. Make `package.json`'s description cover composable agent/coroutine graphs; retain its existing exports, dependency versions, and test scripts. `tsconfig.typecheck.json` already covers the source, examples, and tests and needs no new include path. `.github/workflows/ci.yml` runs only the existing scripts and needs no change. Apply the README/package-description changes after the implementation smoke proof.
- **Emitted artifacts:** `dist/` is gitignored and already holds stale output with no source: `graph-info.*` and `pi-scheduler.*` in addition to `agency.*` and `agency-membership.*`, all naming deleted symbols. `tsc` never removes outputs. Run `rm -rf dist` immediately before `bun run build` instead of deleting individual files, so the `dist` cutover search below can reach zero matches.

#### Existing test keep/delete boundary

In `test/deterministic-agency.test.ts`, retain these named behaviors and re-express them over ordinary graphs:

1. `a suspended member stays schedulable with its policy reasons until it settles` — capture reasons through the existing `emit` callback instead of owner metadata; keep availability, dependent gating, result, and resumed-input assertions.
2. `an any trigger reads a newer message although a delivered result stays satisfied`.
3. `an all trigger reads both message edges together or neither`.
4. `graph-signal cancellation drains the active column and starts no later window` — preserve the graph's cancellation error and explicit gate release; do not turn it into actor-cascade cancellation.
5. `advances one id per window in string order and keeps its cursor`.
6. `runs every available member in one window and settles them together`.
7. `rejects a plan wider than its finite threads before any member starts`.

Delete these tests from that file because their **contract**, not just their setup, is being removed:

- `attachment validates the whole membership before claiming any of it`.
- `a topology changed after attachment fails every drive before any member starts`.
- `a root abort reaches every owned descendant and joins a cooperative sibling`.
- `a failing member abort never skips its gated sibling, and the root reports it`.
- `closing a suspended root closes each member once, without aborting it`.
- `abort and close cascade through 4096 idle nested agencies without growing the stack`.
- `a member whose close fails is released by its owner and can join another`.

In `test/junco-agency.test.ts`, retain the saved-login Opus acquisition/session-ownership case using `JuncoGraph.opus`, and the 32-level nested execution/result-retention case using `JuncoGraph` states. In the Opus case, remove the forced-adapter override setup/assertions; `JuncoGraph.opus`'s option type now forbids a caller adapter. Prove that closing `graph.scheduler` closes its own session but leaves its never-started leaf ready until the caller closes that leaf. The deep case must still retain `deep` in the innermost graph and `graph quiescent` in each enclosing graph, with one leaf provider call and every explicitly tracked actor eventually closed.

Re-express `a root abort reaches a live grandchild while its sibling still runs` as `caller abort fan-out reaches a live grandchild while its sibling still runs`, using child `JuncoGraph` states and `stopAll("abort", [root.scheduler, child.scheduler, grandchild.agent, sibling.agent])`. Keep its existing observations: both tools observe their abort signals; the joined abort stays pending until the sibling's cooperative release; it then resolves; and the root's pending `next()` settles with its final turn. If a retained observation fails, fix the cutover, not the assertion.

Add `compaction descends into a selected child graph and compacts its scheduler, not the root's` there too. Use a two-level `JuncoGraph.pi` nesting fixture, one scripted faux summarization response for the child scheduler, and none for the root. After driving to quiescence, `new All().compact(root)` compacts the leaf and the child scheduler once each: the child scheduler's session gains a compaction entry and consumes its scripted response. The root scheduler's session and faux request count are unchanged.

Delete these ownership-only tests from that file, plus helpers/imports left without callers:

- `attachment validates the whole membership before claiming any of it`.
- `attachment requires a createAgencyScheduler scheduler and claims nothing otherwise`.
- `an attached child cannot be adopted through its scheduler alias or claim a failed parent's other member`.
- `a graph changed after attachment fails its next run before any provider call or node activation`.
- `abort and close cascade through 4096 idle nested agencies without growing the stack`.
- `a failing member abort never skips its gated sibling, and the root reports it`.
- `closing a suspended root closes each member once, without aborting it, before the root is closed`.

Do not delete independent MockAgent lifecycle tests, native policy-yield tests, or generic scheduling/delivery tests just because an old fixture attached its graph. Do not replace the deleted expectations with new hidden attachment machinery.

### 3. Compact selected graph descendants, not graph containers

This step depends on the closed member types, not on the removal of attachment. In `src/compaction.ts`, change `CompactionAlgorithm.compact`, all four implementations, and `compactGraph` to use the following generic constraint while preserving their arguments and `Promise<void>` result:

```ts
compact<A extends Agentic<N, T>, N, T, EH, Q extends DataflowScheduler<N, T>>(
  graph: DataflowGraph<A, N, T, EH, Q>,
): Promise<void>;
```

Replace the current direct-only candidate scan with one private, synchronous collector in the same file. No recursive traversal utility exists; keep this collector specific to compaction rather than creating a new ownership/graph framework.

1. Traverse depth-first in graph node insertion order using an explicit stack of frames, each containing its snapshotted selected entries and next-entry index. Do not use recursive function calls: deeply nested `JuncoGraph`s must not overflow the stack.
2. Snapshot each visited graph's node-state references and, for available-only policies, call that graph's `available()` exactly once when taking its snapshot. Finish the entire reachable selection before the first `await` or context measurement. A graph container is visited only if its parent node was selected. `AllAvailable`/`MoreThanFourtyAvailable` therefore require availability at every enclosing level and at the leaf; an unavailable container prunes its subtree.
3. Initialize a graph-identity set with the root. On a selected `JuncoGraph` state, descend only on its first encounter. This handles shared subgraphs and cycles without claiming ownership or altering topology. The root may be any `DataflowGraph` (e.g. a concrete-state `MockGraph`), but only `JuncoGraph` states are descended. When descending into a **non-root** graph whose `scheduler` is `instanceof JuncoAgent` (a `PiScheduler`), add that scheduler as a candidate at the container's position, before the container's own nodes, under the container's path. It shares the container node's selection: an available-only policy requires only that the container node was available, since a scheduler is not itself a graph node. Never add the root graph's scheduler: compacting it remains the caller's direct choice, as today. Non-agent schedulers (parallel, round-robin, policy) are ignored.
4. Skip `Deterministic` states: they have no model conversation to compact, and their generators must not execute during selection. After these two class checks, the closed union leaves exactly `JuncoAgent | MockAgent`. Deduplicate model-bearing identities, leaves and descended schedulers alike, in a second set; a scheduler that is also an explicit node state compacts once. Retain each one's first-encounter path and traversal position. A path is the slash-joined node IDs from the root (`0` at root level, `child/0` one level down), because IDs repeat across nesting levels. An unavailable encounter must not suppress a later selected encounter of the same member/container.
5. Keep `All` and `AllAvailable` as unconditional requests on the selected unique model-bearing candidates. For both `MoreThanFourty` policies, reuse the existing concurrent `context_size()`/`getModel()` measurements for every selected candidate, the strict `tokens > 0.4 * contextWindow` boundary, and finite-positive-window validation. A selected invalid descendant rejects the whole operation before any compaction requests, preserving the existing `JuncoAgentError` code `invalid_state` and message `Cannot determine context fullness for node "<path>"`. A root-level node's path is its bare ID, so existing direct-case messages are unchanged. Only available-only policies prune unavailable descendants without measuring them; `MoreThanFourty` still measures unavailable and finished descendants. Keep the existing `MoreThanFourty` spelling.
6. Reuse the existing ordered all-settled request logic in `src/agent-operations.ts`. Generalize its helper to `settleAll<A>(members: readonly A[], request: (member: A) => Promise<unknown>, message: string): Promise<void>` and remove its native-agent import. Remove the obsolete ownership-depth comment and leading `await undefined`: traversal is now iterative and complete before requests begin. Pass candidate records directly with `({ agent }) => agent.compact()`, without a projected member array. Preserve synchronous-throw capture, concurrent request start, waiting for every request, original error values, and `AggregateError(failures, "Graph compaction failed")` in first-encounter order.

Empty graphs, deterministic-only graphs, and empty selections resolve without model operations. Compaction neither drives a graph nor resumes/aborts an agent; the existing per-agent queued compaction still waits for admitted runs to settle normally. No traversal state persists between policy calls.

### 4. Extend the existing compaction behavior tests

Use `test/compaction.test.ts`, its `policyGraph`, `COMPACTED` maintenance record, and existing MockAgent history/request assertions. Keep the direct-policy baselines: `All → a,b,c,d,e,f`; `MoreThanFourty → b,d,e`; `AllAvailable → a,b,f`; `MoreThanFourtyAvailable → b`. Keep the existing exact-40% boundary, invalid-window cases, unavailable-member exclusion, invocation snapshot, deferred compaction, and ordered-failure regressions.

Add recursive cases using public `JuncoGraph`/`AgenticNode` types, actual `JuncoGraph` states (`new JuncoGraph({ ..., scheduler: policy(strategy) })` or `JuncoGraph.parallel`), and actual MockAgent maintenance transcripts. A graph added twice to the same parent needs explicit node IDs, because its default ID is its own `id`. A graph/coroutine node that compaction must not execute should have a throwing generator, not a no-op that could conceal accidental execution.

| Case | Required observation |
| --- | --- |
| Depth-first selection, shared leaf/subgraph, back-edge cycle, Deterministic state | Each reachable unique model-bearing leaf consumes one real compaction record; histories change in first-encounter order; graph/coroutine bodies never execute; traversal terminates. |
| 4096-level `JuncoGraph` chain | The leaf compacts once without synchronous stack overflow; no agent-owner cascade is involved. |
| Availability at every level | An unavailable graph node prunes its subtree; an unavailable leaf is excluded even in an available graph; an earlier unavailable alias does not suppress a later selected path to the same graph/leaf. Cover both available-only policies with below/above-threshold leaves so their expected selections differ. |
| Recursive fullness and validation | A 40%-full descendant is skipped and a 41%-full one selected; an invalid selected descendant rejects before any history changes or compact requests, including to valid earlier leaves, and its message names its slash-joined path (e.g. `child/bad`). An invalid pruned descendant is not measured. |
| Recursive invocation snapshot | Gate a descendant's measurement, then change root/child readiness and add nodes; only the initially collected leaves compact. |
| Shared admitted run | A selected yielded leaf, reachable by multiple paths, receives one queued request; an idle sibling compacts while it waits; normal driving of the child graph settles the held leaf and releases compaction. The policy itself neither resumes nor aborts it. |
| Ordered recursive failures | Include synchronous throw, asynchronous rejection, and successful maintenance at different levels. All selected unique requests finish; the original failures appear in depth-first request order, not completion order; successful leaves retain their real history changes. |

The descended-scheduler rule needs a real `PiScheduler`, so it is covered by the integration case added to `test/junco-agency.test.ts` above, not by this MockAgent suite.

Do not add source-text, branding-implementation, generator-forwarding, or adapter-metadata tests. The general coroutine's integration is proved by the standalone Fibonacci smoke below; its consumer type boundaries belong in the existing compile-only file.

## Verification

### Execute once after the full source/caller integration

```sh
bun run build
bun run typecheck
bun run test:all
bun run smoke
bun run smoke:pi
node --input-type=module -e 'await import("./dist/index.js")'
```

The existing scripts include the affected `agent-node`, deterministic graph, compaction, native Pi, mixed, committee, and native policy suites. Do not run build/test/format cycles while independent implementation slices are still editing. `test:native` requires the existing junco-tools native-test addon documented in README Setup; if that prerequisite fails, report the exact failure rather than silently excluding the suite.

Required standalone results:

- `bun run smoke`: one JSON row for each of `round-robin` and `parallel`, with producer `seed`, worker `done`, inputs `['upstream: seed', 'context first', 'then work']`, and `closed: true`.
- `bun run smoke:pi`: `root complete; leaf-result + sibling-result; 8 root windows`, with its interleaving, provider-call, retained-result, and explicit-closure assertions still active.

Also run throwaway scripts against the **implemented public exports**, not locally copied type or traversal prototypes:

1. **General coroutine:** construct `JuncoGraph.parallel<number, string>({ id: "fib", description: "Fibonacci feedback loop" })`; add Deterministic seed, feedback-loop Fibonacci, and nonterminating sink nodes through ordinary `addNode`. Seed `[0, 1]`; observe `[0,1,1,2,3,5,8,13,21,34]`, producer result `seeded`, Fibonacci result `emitted 10 fibs`, and graph quiescence despite the suspended sink. The strict check must use the production-compatible ES2024 libs and Node types, not rely on Bun ambient types to type the promoted MockAgent.
2. **Recursive compaction:** root insertion order is `root-a`, `child`, `shared`, `root-b`, `child-again`, `deterministic`; child order is `child-a`, the same `shared` leaf, then a back-reference to root. Give each leaf initial history `[user('before <name>')]` and exactly one successful compact maintenance record replacing it with `[user('compacted')]`. `new All().compact(root)` must produce invocation order `['root-a','child-a','shared','root-b']`, one consumed compact record per leaf, and exactly `[user('compacted')]` as each leaf's history. The cycle terminates; deterministic and graph bodies do not run. Explicitly close the leaves afterward.
3. **Native nesting with descriptions:** create child/root graphs with `JuncoGraph.pi` and independent faux models/sessions; put the child graph itself in the parent node's state using the spec above.
   - Drive the root iterator to `root complete`, retain `leaf-result` in the child, and observe four root windows for this two-level fixture.
   - The root scheduler's first SchedulerInfo lists the child node under the child graph's `id`, with `details.description` equal to the child's `description` and an `agentStatus`.
   - The child scheduler's SchedulerInfo shows the leaf's `agentNode` description.
   - Then call `new All().compact(root)` with one scripted faux summarization response each for the child scheduler and the leaf: both compact once, and the root scheduler makes no request.
   - Finally `stopAll("return", ...)` both schedulers and the leaf. No attachment, caller adapter, model fallback, or live credentials are involved.
4. **Nested abort fan-out:** in the same two-level shape, start the root while the leaf blocks in a waiting tool. First show that `root.scheduler.abort()` alone is still pending after a bounded macrotask flush. Then `stopAll("abort", [root, child, leaf])` resolves and the root's pending `next()` settles. Close all actors afterward.

### Cutover completeness checks

Use language-server references before changing exported symbols and its file-move operation for MockAgent. Supplement references with these exact repository text searches: the build tsconfig includes only `src`, so a source-project reference result alone does not enumerate every example/test consumer.

- Run `rm -rf dist && bun run build` first. Then, on `src;examples;test;README.md;dist`, with ignored files included, search `\b(?:attachAgency|createAgencyScheduler|AgencyGraph|AgenticGraph|MixedNode|AgentNodeRecord|agentNodeRecord|attachAgencyMembers|createAgencyAdapter|registerAgencyOwner|MockAgencyOwner|MockAgency|mockAgency|isMockOwner|createParallelAgentGraph|parallel-agent-graph)\b`: **zero matches**.
- On `src;examples`, search `\bnew DataflowGraph\b`: **zero matches**. `JuncoGraph` reaches the engine constructor only through `super(...)`. Concrete-state engine graphs in `test/` (e.g. `MockGraph`) are allowed.
- On `src;examples;test`, search `\b(?:import|export)(?:[ \t]|\n)+(?:type\s+)?\{[^}]*\bAgentic\b(?!\s+as\s)[^}]*\}\s+from\s+["']junco-agent["']`: **zero matches**. This bans only an unaliased import. The mock's `Agentic as NativeAgentic` conformance import is allowed, and other junco-agent types such as `AgenticStep`, `AgenticStatus`, and `JuncoAgent` remain legitimate dependencies.
- On `test;examples;README.md`, search `(?:\./mock-agent\.ts|test/mock-agent\.ts)`: **zero matches**.
- On `src;examples;test`, search `\bagentNode\s*<\s*Agentic\s*>`: **zero matches**.
- On `src;examples;test`, search `\b(?:type|interface)\s+Agentic\b`: **only the canonical declaration in `src/agentic.ts`**.

The public API must contain no compatibility re-exports from the old modules, and production compilation must not reach `test`. Keep the examples' model prompts and output semantics unchanged; if a retained behavior fails, fix the cutover rather than re-pinning the test to the regression.

### Planning evidence already observed

These are isolated feasibility probes, not a claim that the public cutover is implemented or its repository suites have passed:

- A strict TypeScript probe using `--types node --lib ES2024,DOM,DOM.Iterable` accepts the closed recursive types, concrete/mixed node intersection, and the child-graph node spread without casts. Its negative coroutine-shape, graph-to-agentNode, and receiver-dependent-factory assertions are active. That probe used the earlier interface form of `JuncoGraph`; the class form was re-probed below.
- A `JuncoGraph` subclass prototype (deleted) passed strict `tsc` with ES2024 libs:
  - `JuncoGraph<…, PiScheduler<…>>` is assignable to `Agentic`, and `graph.scheduler` stays `PiScheduler`;
  - `@ts-expect-error` held for a plain `DataflowGraph<Agentic, …>` member and a `{ ...graph }` lookalike;
  - `{ ...noThisBody, state: childGraph, details }` was accepted by the overridden `addNode`.

  At runtime, `JuncoGraph.parallel` defaulted a nested graph's node ID to its `id` (`"inner"`), `describe` merged spec and graph descriptions, and `run()` returned both results. Through `JuncoGraph.pi` with a faux model, the scheduler's SchedulerInfo carried `{"id":"worker","status":"ready","details":{"description":"does work","extra":1}}`, then `running`, then empty at quiescence.
- The Deterministic Fibonacci prototype ran and printed `{"fibonacci":[0,1,1,2,3,5,8,13,21,34],"result":"emitted 10 fibs"}`.
- The direct native Pi nesting probe ran and printed `{"final":"root complete","leafResult":"leaf-result","windows":4,"rawGraphState":true,"closed":true}`.
- The ordinary-graph `anyOf` probe delivered only `['the value']` without retirement, then `['the value','first','second']` with the proposed node-owned retirement; the caller's original trigger remained unchanged.
- The iterative collector probe compacted actual MockAgent histories once per leaf in `['root-a','child-a','shared','root-b']` order, skipped the deterministic state, and terminated the cycle.
- A strict `tsc` probe with ES2024 libs accepted `JuncoAgent<TaggedSkill, TaggedTemplate, TaggedTool>` → `JuncoAgent`, `PiScheduler<AgenticInput, AssistantMessage, TaggedSkill, TaggedTemplate>` → `JuncoAgent`, and `(this: void) => NodeGenerator<number, string>` → `StepFn<unknown, number, string>`. The installed tree has one copy each of `junco-agent` and `dataflow-engine`, so the `instanceof` checks are sound.
- **Not yet probed:** compacting a descended `PiScheduler`, nested abort fan-out, keeping the last `anyOf` edge, slash-joined compaction paths, the aliased mock conformance import, `JuncoGraph.opus`, and `agentNode`'s `details` (`agentStatus`/`lastYield`) under a real nested run. Verification item 3, item 4, the retained `pi-scheduler.test.ts` details test, and the two new `junco-agency.test.ts` cases are their first evidence.

## Critical files for implementation

1. `src/junco-graph.ts` — the nominal `DataflowGraph` subclass: `id`/`description`, `addNode` recording and default IDs, `describe`, and the `parallel`/`pi`/`opus` factories with their late-bound describe-only adapter.
2. `src/agent-node.ts` — preserve priming, prompt admission, input delivery, resumability, and value/message fairness while removing attachment records, returning `description`/`details`, and widening the callable node spec safely.
3. `../dataflow-engine/src/node.ts` — authoritative `NodeGenerator`/`StepFn` contract; the deterministic body is a real engine coroutine, not a model-agent imitation. Read-only dependency reference.
4. `../junco-scheduler/src/pi-scheduler.ts` — authoritative native scheduler binding, `PiSchedulerAdapter.describeNode`, and schedule-tool/iterator lifecycle; nested `JuncoGraph` state must not change how its Pi plan is driven. Read-only dependency reference.
5. `src/compaction.ts` — invocation-time recursive selection, identity guards, per-level availability, threshold validation, and model-only requests.
6. `test/compaction.test.ts` — real maintenance/history fixtures and the retained policy, queueing, and failure-order contracts; extend these instead of testing copied implementation details.

