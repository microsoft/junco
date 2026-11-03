<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->

## Standard library index

`import { graph, schedules, tracer, trigger, workflows } from "junco"` (`src/index.ts`). Each summary is the first sentence of the export's JSDoc; the JSDoc at the definition is the full reference. `test/std-namespaces.test.ts` fails when a runtime export of these namespaces has no row here. Human version: https://github.com/microsoft/junco/wiki/Standard-Library.

### `workflows` — graph documents for `JuncoGraph.fromYaml(text, config)`

Reuse these instead of hand-writing the topology. Source routes are the keys of `source.routes`; feed a root graph with `execution.graph.source.enqueue({ messages: new Map([[graph.EdgeId.create("<route>"), [{ kind: "prompt", text }]]]), values: new Map() })`, or route a parent edge onto them when embedding (`kind: graph`).

| Export | Source | Summary | Routes / output | Drive with |
| --- | --- | --- | --- | --- |
| `workflows.ralph` | `src/std/workflows/ralph.yml` | Ralph: one agent revising its complete answer in a `Ralph -> Ralph` loop; drive with `schedules.ralph`. | `assignment` → `$source~>Ralph`; result `Ralph->$sink` | `...schedules.ralph({ rounds })` or `({ until, rounds? })` |
| `workflows.allFanIn` | `src/std/workflows/all-fan-in.yml` | One selection of the best candidate once every candidate has returned. | `candidates` → `$source~>AllFanIn`; `sink.returns: AllFanIn` | any scheduler; selection criteria in the agent's `system` |
| `workflows.anyFanIn` | `src/std/workflows/any-fan-in.yml` | One streamed selection per newly delivered candidate batch; drive with `schedules.anyFanIn`. | `candidates` → `$source~>AnyFanIn`; `sink.stream: true`, output `AnyFanInPublish~>$sink` | `...schedules.anyFanIn()` |
| `workflows.memoryRalphLoop` | `src/std/workflows/memory.ts` (JSON text) | Ralph revisions persisted before decisions, with fresh recall before each round. | `assignment` → `$source~>Memory`; `sink.returns: Ralph` after `Memory~>$sink` flushes | `...schedules.memory({ memory, ralph? })` |
| `workflows.memoryFanIn` | `src/std/workflows/memory.ts` (JSON text) | Persistent streaming best-so-far selection; candidates must arrive on message edges. | `candidates` → `$source~>MemoryCandidates`; `sink.stream: true`, output `Memory~>$sink`; nested `Select` = AnyFanIn with memory tools blocked | `...schedules.memory({ memory })` |
| `workflows.memoryFanOut` | `src/std/workflows/memory.ts` (JSON text) | Recall assignments and broadcast already-persisted selections to caller-owned workers. | `assignment` → `$source~>MemoryAssignment`, `updates` → `$source~>MemoryUpdate`; `sink.stream: true`, output `Memory~>$sink` | `...schedules.memory({ memory })` |
| `workflows.optimizer` | `src/std/workflows/optimizer.yml` | The profile optimizer: measures a prepared target and edits its tuning regions; drive with `schedules.runOptimizer`. | no routes; result edge `result` (`Final->$sink`) | `schedules.runOptimizer(request, options?)` loads and runs it itself |

### `schedules` — policies, combinators and workflow controllers

`config.scheduler: (label, graphPath) => policy`; controllers are spread into the `fromYaml` config (`{ available }` / `{ available, code }`).

| Export | Kind | Source | Summary |
| --- | --- | --- | --- |
| `schedules.parallel` | fn | `packages/junco-scheduler/src/parallel.ts` | Select every available owned node in candidate order; native capacity stays authoritative. |
| `schedules.roundRobin` | fn | `packages/junco-scheduler/src/round-robin.ts` | Up to `width` available nodes per decision, in rotation order (`order`, or sorted owned node ids) starting after the last selected node. |
| `schedules.agent` | fn | `packages/junco-scheduler/src/scheduler.ts` | Normalize this invocation's first applicable speculative wave; retain no future plan. |
| `schedules.pi` | fn | `packages/junco-scheduler/src/agent.ts` | One request per current decision, without sessions, resources or graph binding. |
| `schedules.choose` | fn | `packages/junco-scheduler/src/scheduler.ts` | Rank only available, owned work; equal ranks use raw JavaScript string order. |
| `schedules.separate` | fn | `packages/junco-scheduler/src/scheduler.ts` | Split exclusive selection authority, not work, effects or JavaScript memory. |
| `schedules.strength` | fn | `packages/junco-scheduler/src/scheduler.ts` | Override the strength of every node `inner` selects; `assign` names the rung per node. |
| `schedules.limit` | fn | `packages/junco-scheduler/src/resources.ts` | Bound `scheduler`'s work by `limits`. |
| `schedules.lowest` | fn | `packages/junco-scheduler/src/resources.ts` | Rank for `choose`: lower predicted `kind` cost first (the profile's `safe` estimate, base units). |
| `schedules.highest` | fn | `packages/junco-scheduler/src/resources.ts` | Rank for `choose`: higher predicted `kind` cost first, e.g. `highest("runtime")` starts the longest work first. |
| `schedules.select` | const | `packages/junco-scheduler/src/scheduler.ts` | Work-only policies select at the default strength. |
| `schedules.nodeIds` | const | `packages/junco-scheduler/src/scheduler.ts` | The node ids of `selected`, in order. |
| `schedules.MODEL_STRENGTHS` | const | `packages/junco-scheduler/src/scheduler.ts` | The five model strengths, weakest first; a `Ladder` names one model per strength. |
| `schedules.DEFAULT_MODEL_STRENGTH` | const | `packages/junco-scheduler/src/scheduler.ts` | `2` (`"med"`): the strength work-only policies select at. |
| `schedules.context` | fn | `src/node-policy.ts` | Pair a passive agency graph with policy, sidecar metadata and agency input semantics. |
| `schedules.drain` | fn | `packages/junco-scheduler/src/context.ts` | Run to quiescence as separate steps, retaining trace and cancellation boundaries between them. |
| `schedules.triggerInputs` | const | `packages/dataflow-engine/src/scheduler.ts` | The default read plan for a node: every edge an `"all"` rule fires on, or only the first satisfied edge of an `"any"` rule, each read WHOLE. |
| `schedules.uniformLadder` | const | `src/node-policy.ts` | The same rung at every strength. |
| `schedules.ModelLadder` | class | `src/node-policy.ts` | Every available model (`models`) and the five rungs this ladder allows (`rungs`), checked against the catalog. |
| `schedules.validateLadder` | fn | `src/node-policy.ts` | Reject a ladder unless all five rungs name a `"provider/model-id"` model; throws `DataflowDefinitionError`. |
| `schedules.ralph` | fn | `src/std/schedules/ralph.ts` | Availability hooks for the original, non-memory Ralph workflow. |
| `schedules.anyFanIn` | fn | `src/std/schedules/any-fan-in.ts` | Hooks and code for `JuncoGraph.fromYaml(workflows.anyFanIn, { ...options, ...anyFanIn() })`. |
| `schedules.memory` | fn | `src/std/schedules/memory.ts` | Borrowed-memory controllers for all three standard memory workflow topologies. |
| `schedules.runOptimizer` | fn | `src/std/schedules/optimizer.ts` | Optimize the prepared target `request` names until every requested stop predicate holds on a confirmed incumbent, a caller budget or cancellation stops it, or a prerequisite blocks it. |
| `schedules.Scheduler` | type | `packages/junco-scheduler/src/scheduler.ts` | A policy: from a `Snapshot` of the graph (and an optional cancellation signal) to one `Decision`. |
| `schedules.Snapshot` | type | `packages/junco-scheduler/src/scheduler.ts` | Native containers are detached; opaque state, messages, results and metadata are borrowed. |
| `schedules.Decision` | type | `packages/junco-scheduler/src/scheduler.ts` | One scheduler answer: the nodes that run together in the next column, each at a strength. |
| `schedules.NodeModel` | type | `packages/junco-scheduler/src/scheduler.ts` | One selected node and the strength it runs at. |
| `schedules.ModelStrength` | type | `packages/junco-scheduler/src/scheduler.ts` | Index into MODEL_STRENGTHS: 0 = smol … 4 = xhigh. |
| `schedules.ModelStrengthName` | type | `packages/junco-scheduler/src/scheduler.ts` | A strength by name, `"smol"` … `"xhigh"`. |
| `schedules.SchedulerContext` | type | `packages/junco-scheduler/src/context.ts` | A graph paired with its policy: `step()` runs one decision, `run()` repeats decisions to quiescence; both resolve to the results map. |
| `schedules.DataflowObservation` | type | `packages/dataflow-engine/src/dataflow-graph.ts` | A policy's read-only view of the graph: node status/state/profiles, links, pending inputs, results and a change `version`. |
| `schedules.Schedule` | type | `packages/dataflow-engine/src/scheduler.ts` | A planned window, lanes x turns. |
| `schedules.NodeSchedule` | type | `packages/dataflow-engine/src/scheduler.ts` | One node occupying one turn of one lane, plus how much it reads on entry. |
| `schedules.InputSchedule` | type | `packages/dataflow-engine/src/scheduler.ts` | Per-edge read plan for one node occurrence. |
| `schedules.MessageSchedule` | type | `packages/dataflow-engine/src/scheduler.ts` | How many messages to pop from one inbound edge: a positive integer, the whole queue, or none. |
| `schedules.NodeAvailability` | type | `packages/dataflow-engine/src/scheduler.ts` | What the runtime knows about one available node when it asks for a plan. |
| `schedules.LimitOptions` | type | `packages/junco-scheduler/src/resources.ts` | Allowances for `limit`: a per-decision memory admission bound and token/tool budgets per `scope`. |
| `schedules.UsageLimitScope` | type | `packages/dataflow-engine/src/usage-limits.ts` | How long one usage ledger lives: a whole `run()`/`step()`, one scheduler decision, or one node activation. |
| `schedules.PiOptions` | type | `packages/junco-scheduler/src/agent.ts` | What `pi` needs: a Pi `models` runtime, the `model` to ask, and optional system prompt, prompt and stream options. |
| `schedules.SchedulerRequest` | type | `packages/junco-scheduler/src/agent.ts` | Candidate-only wire data. |
| `schedules.Ladder` | type | `src/node-policy.ts` | Every strength's model; all five rungs are required. |
| `schedules.LadderRung` | type | `src/node-policy.ts` | One rung: a "provider/model-id" and its reasoning effort (`"off"` when omitted). |
| `schedules.AgencyNodeMetadata` | type | `src/node-policy.ts` | Source-derived policy metadata; native descriptions remain on native observations. |
| `schedules.RalphOptions` | type | `src/std/schedules/ralph.ts` | Round control of `schedules.ralph`: a fixed `rounds` count, or an `until` success check with an optional `rounds` cap. |
| `schedules.RalphPredicate` | type | `src/std/schedules/ralph.ts` | Synchronous success check of one completed Ralph result; `round` is one-based, `label` is the graph level's. |
| `schedules.MemoryScheduleOptions` | interface | `src/std/schedules/memory.ts` | Options of `schedules.memory`: the borrowed `JuncoMemory` store and the Ralph round options of the memory Ralph loop. |
| `schedules.OptimizationRequest` | type | `src/std/schedules/optimizer.ts` | What `runOptimizer` optimizes: the prepared target, objective, constraints, stop predicates, tuning axes and budgets. |
| `schedules.OptimizationState` | type | `src/std/schedules/optimizer.ts` | `runOptimizer`'s result and resumable state: current and anchor candidates, trial/edit history and the stop reason (`null` while running). |

### `graph` — the dataflow engine and the agency graph

| Export | Kind | Source | Summary |
| --- | --- | --- | --- |
| `graph.JuncoGraph` | class | `src/junco-graph.ts` | A passive native work graph owning its agents, child graphs and coroutines. `fromYaml(source, config)` builds the workflow a YAML document and its config define. |
| `graph.MockJuncoGraph` | class | `src/mock-junco-graph.ts` | A JuncoGraph whose every node is profiled: a MockAgent member gets the constant profiles of its transcript's `usage`, any other node without `profiles` gets zero memory and zero tokens. |
| `graph.DataflowGraph` | class | `packages/dataflow-engine/src/dataflow-graph.ts` | Native work topology and concrete lanes-by-turns executor; policy lives outside the graph. |
| `graph.Edge` | const | `packages/dataflow-engine/src/edges.ts` | Construction of `Edge`s (`Edge.message`, `Edge.value`). |
| `graph.EdgeId` | const | `packages/dataflow-engine/src/identity.ts` | Construction of `EdgeId`s. |
| `graph.NodeId` | const | `packages/dataflow-engine/src/identity.ts` | Construction of `NodeId`s. |
| `graph.Message` | const | `packages/dataflow-engine/src/node.ts` | Construction of `Message`s. |
| `graph.Queue` | const | `packages/dataflow-engine/src/queue.ts` | Construction of `Queue`s. |
| `graph.Width` | const | `packages/dataflow-engine/src/width.ts` | Construction of `Width`s. |
| `graph.UNBOUNDED` | const | `packages/dataflow-engine/src/width.ts` | `Infinity` as a `Width`: unbounded turns per lane, or unbounded lanes per plan. |
| `graph.from` | const | `packages/dataflow-engine/src/builders.ts` | This turn's batch from `edge`, empty when it did not fire. |
| `graph.constantProfile` | fn | `packages/dataflow-engine/src/profile.ts` | A fixed per-activation cost, expressed in the supplied quantity's unit. |
| `graph.renderPretty` | fn | `packages/dataflow-engine/src/pretty.ts` | Render `value.pretty()` to a string. |
| `graph.isUsageLimitError` | fn | `packages/dataflow-engine/src/usage-limits.ts` | Whether `error` is a usage-limit failure, by its exact code, never its message text. |
| `graph.UsageLimitError` | class | `packages/dataflow-engine/src/usage-limits.ts` | A token or tool budget was hit; `details` and `toJSON()` carry the limit and the amount that hit it. |
| `graph.DataflowDefinitionError` | class | `packages/dataflow-engine/src/errors.ts` | A graph wiring / contract violation detected before or between node activations. |
| `graph.DataflowNodeError` | class | `packages/dataflow-engine/src/errors.ts` | A hard error raised by a node body and re-raised by the runtime. |
| `graph.AvailabilityFn` | type | `packages/dataflow-engine/src/node.ts` | Availability hook, consulted only for a node that is not `done`, after the runtime has evaluated its trigger. |
| `graph.ErrorFn` | type | `packages/dataflow-engine/src/node.ts` | Failure hook of a node whose body threw. |
| `graph.StepFn` | type | `packages/dataflow-engine/src/node.ts` | A node body. |
| `graph.NodeGenerator` | type | `packages/dataflow-engine/src/node.ts` | The generator a node body returns: yields message batches, is resumed with views, returns `T`. |
| `graph.Node` | type | `packages/dataflow-engine/src/node.ts` | A registered graph node: its programmable state, lifecycle, trigger, body and live generator. |
| `graph.NodeOptions` | type | `packages/dataflow-engine/src/node.ts` | Registration options common to every node kind: identity, optional prose, firing rule and availability. |
| `graph.NodeSpec` | type | `packages/dataflow-engine/src/node.ts` | What a caller passes to `DataflowGraph.addNode`: common options plus state, body and failure hook. |
| `graph.NodeStatus` | type | `packages/dataflow-engine/src/node.ts` | Lifecycle of a node: never activated, mid-generator, or returned (a value self-edge delivery re-arms it to `ready`). |
| `graph.ParentView` | type | `packages/dataflow-engine/src/node.ts` | What the runtime hands a running node on each input-delivery turn. |
| `graph.Lookup` | type | `packages/dataflow-engine/src/node.ts` | Keyed read access to one side of a node's inbound state. |
| `graph.EdgeIdType` | type | `packages/dataflow-engine/src/identity.ts` | Branded identifier of a graph edge. |
| `graph.NodeIdType` | type | `packages/dataflow-engine/src/identity.ts` | Branded identifier of a graph node. |
| `graph.Identifiable` | type | `packages/dataflow-engine/src/identifiable.ts` | A value carrying a stable identity of type `Id`. |
| `graph.WidthType` | type | `packages/dataflow-engine/src/width.ts` | A scheduler width: a positive integer or `Infinity`. |
| `graph.ValidWidth` | type | `packages/dataflow-engine/src/width.ts` | `W` when it is a legal width — a positive integer or `Infinity` — and `never` otherwise. |
| `graph.DataflowRunOptions` | type | `packages/dataflow-engine/src/dataflow-graph.ts` | Cancellation for one scoped evaluation, including planning and concrete execution. |
| `graph.DataflowObservation` | type | `packages/dataflow-engine/src/dataflow-graph.ts` | A policy's read-only view of the graph: node status/state/profiles, links, pending inputs, results and a change `version`. |
| `graph.DataflowExecution` | type | `packages/dataflow-engine/src/dataflow-graph.ts` | Executes one planned `Schedule` inside `evaluate`; options resolve each entry's inputs, observe columns and add per-node usage budgets. |
| `graph.Pretty` | interface | `packages/dataflow-engine/src/pretty.ts` | Renderable as a prettier-printer document; `renderPretty` turns it into text. |
| `graph.ProfileData` | interface | `packages/dataflow-engine/src/profile.ts` | A per-node cost model for one resource: its unit, the port features it reads, and `predict` for a batch. |
| `graph.ProfileSet` | type | `packages/dataflow-engine/src/profile.ts` | Kind-erased view handed to observers and schedulers. |
| `graph.ResourceKind` | type | `packages/dataflow-engine/src/profile.ts` | A profiled resource: `"memory"`, `"runtime"`, `"tokens"` or `"cost"`. |
| `graph.ResourceQuantity` | type | `packages/dataflow-engine/src/profile.ts` | An amount of resource `R` in a unit of its dimension (e.g. `bytes(…)`, `tokens(…)`). |
| `graph.UsageLimitDetails` | type | `packages/dataflow-engine/src/usage-limits.ts` | What a `UsageLimitError` carries: which budget, its scope and limit, the usage that hit it, and the node path. |

### `graph.nodes` — node specs and bodies

| Export | Kind | Source | Summary |
| --- | --- | --- | --- |
| `graph.nodes.Deterministic` | class | `src/deterministic.ts` | A deterministic graph node body: one async generator speaking the engine's own yield/view/result protocol, plus a cooperative abort signal and close. |
| `graph.nodes.EmitOnce` | class | `packages/dataflow-engine/src/builders.ts` | A complete source spec: emit one batch, then finish with `ret`. |
| `graph.nodes.StepNode` | class | `packages/dataflow-engine/src/builders.ts` | A complete node spec whose body never terminates: after its priming yield, `fn` maps the registered node's current state plus each delivered view to the messages emitted that turn. |
| `graph.nodes.ConstFanout` | class | `packages/dataflow-engine/src/stdlib.ts` | A complete source spec that sends one constant `payload` once on every edge in `outputs`, then finishes with `options.ret`. |
| `graph.nodes.ConstFanin` | class | `packages/dataflow-engine/src/stdlib.ts` | A complete collector spec that waits until every edge in `inputs` has delivered its constant, sends them as ONE list message on `output`, then finishes with `options.ret`. |
| `graph.nodes.Source` | class | `packages/dataflow-engine/src/stdlib.ts` | Externally queued native ingress; one detached delivery per selected activation. |
| `graph.nodes.Sink` | class | `packages/dataflow-engine/src/stdlib.ts` | Native egress: yielded and explicitly sent messages await acknowledged external delivery. |
| `graph.nodes.Agentic` | type | `src/agentic.ts` | Native work states; policies and execution contexts are never graph members. |
| `graph.nodes.AgenticNode` | type | `src/agentic.ts` | Complete bodies require their authorization policy. |
| `graph.nodes.AgenticInput` | type | `packages/junco-agent/src/agentic.ts` | The message payload of agent graphs. |
| `graph.nodes.CompactionPolicy` | type | `src/agentic.ts` | Which direct prompt-agent node states `JuncoGraph.compact` compacts. |

### `trigger` (also `graph.trigger`) — readiness rules over inbound edges

| Export | Kind | Source | Summary |
| --- | --- | --- | --- |
| `trigger.TriggerRule` | const | `packages/dataflow-engine/src/trigger.ts` | Construction of `TriggerRule`s: `allOf`, `anyOf`, `when(edge)`, `always()`, `never()`. |
| `trigger.TriggerEntry` | const | `packages/dataflow-engine/src/trigger.ts` | Construction of `TriggerEntry`s (`TriggerEntry.on(edge)`). |
| `trigger.evaluateTrigger` | const | `packages/dataflow-engine/src/trigger.ts` | Whether `trigger` fires right now against `nodeId`'s inbound edges. |
| `trigger.satisfiedEdges` | const | `packages/dataflow-engine/src/trigger.ts` | Edge ids with something to offer right now, in rule insertion order. |
| `trigger.TriggerKind` | type | `packages/dataflow-engine/src/trigger.ts` | Conjunction (`"all"`) or ordered disjunction (`"any"`) over a rule's entries. |

### `tracer` — execution observers and profile recorders

| Export | Kind | Source | Summary |
| --- | --- | --- | --- |
| `tracer.DummyTracer` | class | `packages/dataflow-engine/src/dummy-tracer.ts` | A `DataflowTracer` that deliberately traces nothing: no serialization, timestamps, retained payloads, logging or I/O. |
| `tracer.TuiTracer` | class | `src/tui-tracer.ts` | One lazily acquired, terminal-owning display shared by synchronous graph observers (`TuiTracer.shared()` is the `JuncoGraph` default). |
| `tracer.JsonlRecorder` | class | `src/jsonl-recorder.ts` | Projects profile events into dataflow-profile JSONL training samples: one per successful graph activation, keyed by its `/`-joined node IDs, plus standalone probe samples. |
| `tracer.GrafanaRecorder` | class | `src/grafana-recorder.ts` | Persists profile events as metrics of one session `streamId`. |
| `tracer.DataflowTracer` | interface | `packages/dataflow-engine/src/dataflow-tracer.ts` | Pluggable execution observer. |
| `tracer.DataflowRunTrace` | type | `packages/dataflow-engine/src/dataflow-tracer.ts` | Observer for one evaluation scope. |
| `tracer.DataflowStepTrace` | type | `packages/dataflow-engine/src/dataflow-tracer.ts` | Observer for one generator activation. |
| `tracer.ProfileRecorder` | interface | `packages/junco-tools/ts/profile-recorder.ts` | One profiling session (`root`) seen at one node context (`path`), able to record only the resource singletons in `R`. |
| `tracer.ProfileEvent` | type | `packages/junco-tools/ts/profile-recorder.ts` | One event a `ProfileRecorder` records: a usage increment, a native resource event, a probe value, or an operation's start/finish/metrics. |
| `tracer.ProfileOperation` | type | `packages/junco-tools/ts/profile-recorder.ts` | Labels of one recorded operation: resource, category, tool, operation name, and the activation it ran in. |
| `tracer.ProfileActivation` | type | `packages/junco-tools/ts/profile-recorder.ts` | One graph activation of a node, shared by its start and finish events. |
| `tracer.JsonlRecorderOptions` | type | `src/jsonl-recorder.ts` | Options of `new JsonlRecorder`. |
| `tracer.GrafanaRecorderOptions` | type | `src/grafana-recorder.ts` | Options of `GrafanaRecorder.create`. |

### Root exports

Also exported directly from `junco`: `JuncoGraph`, `MockJuncoGraph`, `Deterministic`, `Agentic`, `AgenticInput`, `AgenticNode`, `CompactionPolicy` (rows above), and:

| Export | Kind | Source | Summary |
| --- | --- | --- | --- |
| `AgenticInputSchema` | const | `packages/junco-agent/src/agentic.ts` | Runtime schema of AgenticInput. |
| `AssistantMessageSchema` | const | `packages/junco-agent/src/agentic.ts` | Runtime schema of Pi's native AssistantMessage: its content, usage/cost, diagnostics and deferred handle, with required fields, literal alternatives and optional fields. |
| `MockAgent` | class | `src/mock-agent.ts` | A scripted `JuncoAgentProtocol` replaying its `MockTranscript`: no model requests; profiles come from declared usage. |
| `MockTranscript` | type | `src/mock-agent.ts` | Everything a `MockAgent` will do, fixed at construction. |
| `MockRun` | type | `src/mock-agent.ts` | One admitted run: zero or more yields then exactly one terminal, and its cancellation outcome. |
| `MockFrame` | type | `src/mock-agent.ts` | One scripted request of a run, ending at boundary `step`. |
| `MockTerminal` | type | `src/mock-agent.ts` | A run's last boundary: its settlement or failure. |
| `MockHook` | type | `src/mock-agent.ts` | One scripted hook invocation, with the results its registered handlers must return in order. |
| `MockHookResult` | type | `src/mock-agent.ts` | The results the registered handlers returned for one scripted hook. |
| `MockMaintenance` | type | `src/mock-agent.ts` | One scripted `compact` (its queued outcome) or `navigateTree` call (its native result). |
| `MockRequest` | type | `src/mock-agent.ts` | What one frame's request would have sent, captured after its queue drains and hooks. |
| `MockCall` | type | `src/mock-agent.ts` | One command, as called. |
| `MockUsage` | type | `src/mock-agent.ts` | Declared constant memory and token usage of a mock activation. |
| `constantProfiles` | fn | `src/mock-agent.ts` | Constant per-activation profiles for declared mock usage; no runtime measurement. |
| `NO_USAGE` | const | `src/mock-agent.ts` | Zero memory and zero tokens: the profiles of a mock that declares no usage. |

Whole-package namespaces, documented in their own trees: `agent` (`packages/junco-agent/README.md`), `tools` (`packages/junco-tools/README.md`), `mcp` (`packages/junco-mcp`), `syntax` (`src/syntax/`; YAML schema and `FromYamlOptions` in `skills/junco-graph-create/SKILL.md`).
