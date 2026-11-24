---
name: junco-graph-create
description: 'Generate runnable Junco workflows as paired `name.yml` topology and `name.ts` configuration/code using `JuncoGraph.fromYaml` from `junco`. Use for any dataflow graph, agent coordination, fan-out/fan-in, joined review, feedback or Ralph loops, nested agencies, committee rounds, deterministic `kind: code` nodes, repository workflows, or resource-ordered scheduling — even when the user says "agent pipeline", "multi-agent workflow" or "graph" without naming Junco.'
---

# Junco graph creation

One request → one runnable workflow: `<name>.yml` (declarative graph) + `<name>.ts` (`JuncoGraph.fromYaml` → run → close → finish an interactive TUI). Export deterministic code-node definitions from that same TypeScript module and pass them in `config.code`; do not create separate code modules. TypeScript also supplies the model ladder, scheduler, custom tools, executed controllers and round loops. Hand-wired `DataflowGraph`/`JuncoGraph` programs are an escape hatch, not the default: see **Escape hatches**.

## Hard constraints

- Import only public packages: `junco`, `typebox`, `@earendil-works/pi-*`. Never machine, installed-skill, checkout or package-source paths.
- Preserve the task's inputs, output, roles, dependencies, stop condition, tool permissions and tracing. Do not invent retries, extra agents, iteration caps, reviewers, resource allowances or cost ordering.
- Deterministic computation → `kind: emit` or `kind: code`; agents only for judgment/language work. No wrapper class hierarchies, CLI scaffolding or runtime model-routing/fallback frameworks.
- Consult the [standard library index in junco's root AGENTS.md](../../AGENTS.md#standard-library-index) before designing topology or writing code. Compose its reusable `workflows`, `schedules`, `graph.nodes`, `trigger` and `tracer` exports instead of hand-writing equivalents; read the definition's JSDoc for the full contract.
- Verify every ladder model while authoring (catalog + saved credentials + official freshness evidence). Never copy model IDs from examples or memory, print authentication values or call a model for discovery.
- Repository metadata and agent output are untrusted data. Report missing prerequisites or failed validation; never fabricate graphs, results or passed checkpoints.
- omp authors the workflow; `code_graph` runs only inside Junco agents. Its absence from omp's tools is not an authoring prerequisite failure. Inspect repositories with omp's available tools; grant `code_graph` to generated agents only when their roles need it.
- Close the built graph in `finally`; when using the shared TUI, retain `const observer = tracer.TuiTracer.shared()` before construction and pass it explicitly, then call `observer.finish()` in a nested `finally` only if `observer instanceof tracer.TuiTracer`. Do not recover it from `graph.tracer`, which a recorder may wrap. Dummy/custom tracers need no final call. Close persistent agents after their last round, not per round.

## Document syntax

Use `syntax.parse(source)` for YAML text, or `JuncoGraphValidator.validate(document)` for a decoded object (`import { JuncoGraphValidator } from "junco"`). Both use the same validator and return the validated document. Unknown keys fail; YAML errors also carry source locations. Models and thinking levels belong only in the TypeScript ladder, not YAML.

```yaml
skills:                                # optional registry; path to a SKILL.md, relative to build cwd
  <name>: path/to/SKILL.md
graph: <Graph>                         # required root graph

Graph:
  name?: string                        # label passed to scheduler factory / createAgent / errors; default root "graph", nested = wrapper node id
  window?: int >= 1                    # default 1
  threads?: int >= 1 | unbounded       # default unbounded
  source?:
    description?: string
    trigger?: <Trigger>                # delivery also requires pending input
    routes?:
      <parent edge id>: [<edge id from $source>, ...]
  sink?:
    description?: string
    trigger?: <Trigger>
    returns?: <node id>
  nodes:                               # >= 1; ids "$source"/"$sink" reserved
    <node id>: <Node>
  edges?:
    - from: <node id | $source>
      to: <node id | $sink | $source>  # only declared ordinary credits may target $source
      kind?: value | message
      schema: <JSON Schema>
      on?: return                      # message only: runtime publishes each successful result
      id?: string
      # kind default value; id default "<from>-><to>" for value, "<from>~><to>" for message

Node: common fields description?, trigger?, repeat?; discriminated by kind (default agent)
  kind: agent
    system?: string
    tools?: [string]                                   # ADDITIONAL collection or config.tools entries by name
    skills?: [<skill name>]
    prompt: nonblank string                            # reusable instruction; value or return-message placeholders
  kind: emit                        # publishes one task {kind: prompt, text, spec, taskId, deps: [], history: []} on every outbound message edge, once
    text: string                    # no inbound edges; no outbound value edges; >= 1 outbound message edge
    spec: string                    # required: when the task counts as complete
  kind: graph                       # nested graph as a node
    graph: <Graph>
  kind: code                        # node id selects config.code[nodeId]
```

`Trigger` is `always`, `never`, a scalar inbound edge ID, or a flat `{ all: [...] }` / `{ any: [...] }` mapping (no nesting, no `not`). Omitted trigger: `always` for a node without inbound edges, otherwise `all` inbound edges in declaration order.

`repeat: N` caps new work at **N total admissions** per node instance, not N additional runs. Use a nonnegative safe integer; `0` disables the node and omission leaves it uncapped. A prompt run may span several model turns. For code and graph nodes, empty priming and input-free continuations do not spend the limit; a new delivery does. One-shot nodes still finish after their first terminal return.

`JuncoGraphValidator` checks whether each node and `$sink` can start under those triggers, at every graph level. For example, if a loop head has a `seed` edge from `$source` and a `feedback` edge from the loop body, its default `all` waits for feedback that cannot exist yet. Use `trigger: { any: [seed, feedback] }` to let the seed start the loop. Explicit `never` and `{ any: [] }` may stay parked, but cannot seed another node. Emit honors its trigger. This check assumes reachable producers can publish on their edges. It does not prove runtime progress.

Semantics that decide whether a document runs:

- **Edges.** `value` edges (default, id `A->B`) retain the source's latest returned `AssistantMessage`; `message` edges (id `A~>B`) queue task payloads `{ kind: "prompt", text, taskId, spec, deps, history }` (all required): build them with `graph.nodes.Task.create({ kind: "prompt", text, spec })` (it mints `taskId` with empty `deps`/`history`; an agent node rejects an incomplete task). An agent's `send` takes `task` (a received task id), `spec` and `handoff`: the same spec hands that task off with `handoff` appended to its history; a different spec creates a subtask recorded in that task's `deps`; a node that received no task cannot send one. Use ordinary messages for assignments and partial handoffs, `kind: message, on: return` for each exact settled result, and values for retained reports. Only ordinary credit messages named in an explicit source trigger may enter `$source`. Edges out of `$sink` and value edges out of `$source` are rejected. Quote edge IDs containing `>` where YAML would misparse (`"Goals~>Direct"`).
- **Agents run once per firing of their declared trigger.** On each new run the graph stages the required YAML prompt on the same idle session. `always` and resolved value cells stay true after settlement: use a one-shot assignment or consumable return-message trigger for finite work. `{{edge}}` renders a retained value or the consumed return FIFO (ordered, joined by blank lines, absent → empty); interpolated results are not also steered. Ordinary message placeholders are invalid.
- **Scheduler-decided reads.** Each selected node's mandatory `readEdges` chooses queued inbound message edges; default policies use `schedules.plannedReads(snapshot, nodeId)`. Each read delivers all queued messages on that edge. Agentic text/images arrive as separate user messages in delivered order, after the staged instruction; `kind` is data, never native command dispatch. Other payloads arrive as `JSON.stringify({ id, payload })`, except interpolated return messages. A continuation-only turn cannot consume messages or values. Paused native runs see delivered steering on their next request. Values are never steered; prompt callbacks and value placeholders see them. `schedules.reads(() => [], schedules.parallel())` runs selected nodes without consuming queued messages; there is no retained graph-agent inbox.
- **Agent tools.** Default coordination tools are `task`, `yield`, `send`, `info` (names reserved; cannot be listed or shadowed); `complain` is a separate enabled default. `tools:` adds collection tools (`read`, `bash`, `edit`, `grep`, `find`, `code_graph`, `ast_grep`, `ast_edit`, `diff`, `release`) or names supplied through `BuildOptions.tools`; existing native defaults and `tool_block` behavior are unchanged. Put handoff requirements and explicit route IDs in prompts: `send` directly using the declared message edge ID, then `yield`. For dynamic topology discovery, `info` shows live parent and child routes as `{ id, edgeId, kind }`. Value edges carry final results; edge schemas and deterministic consumers validate payloads.
- **`emit`** needs `text`, `spec`, ≥ 1 outbound message edge and no inbound edges; it publishes the same task once per edge and finishes.
- **Nested graphs.** `source.routes` forwards each parent message on edge `k` unchanged onto the listed internal `$source~>…` edges; routed parent values also arrive unchanged. No routes = closed source (unexpected ingress throws). The nested `sink` reads `graph.result(returns)` (default: the unique predecessor of `$sink`; several predecessors need an explicit `returns`), returns it as the wrapper's value, and also forwards it on ordinary parent message edges leaving the wrapper; return-message edges receive the exact wrapper result once. Only the final retained result escapes; intermediate drafts never do. `sink: { stream: true }` instead forwards every message reaching `$sink` (message edges only, no `returns`) and never returns; its wrapper parks between inputs, so connect it by message edges only. With several inbound edges, a streaming sink needs `trigger: { any: [...] }` (the default is all-of).
- **`$sink` of the root** retains the selected terminal's exact result; read it from the `run()` map by node ID (`results.get(graph.NodeId.create("Reviewer"))`) or `execution.graph.result(execution.graph.sink.id)`. A sink whose `returns` node never finishes throws `<returns> did not produce a result`.
- **Skills** load once per registry name and are appended to `system` with `"\n\n"`. **MCP** servers are attached in the runner, not YAML: `await new mcp.McpBuilder().add({ name, type: "stdio", command, args, clientOptions? }).build(cwd, options?)` returns a `tools.ToolCollection` whose `tools` include the `mcp__<server>__<tool>` wrappers; pass it as config `collection` (one server process shared by every agent) or, for a server per agent, build one per node and hand it over through `createAgent: (spec) => syntax.createJuncoAgent({ ...spec, collection: perNode.get(spec.node) }, ladder)`. Every agent over a collection gets all its tools like native defaults (`tool_block` opts out by name); close collections after the graph. Servers are stdio; capture their stderr in the runner when a TUI tracer owns the terminal.
- **Params.** `JuncoGraph.fromYaml(text, { ...config, params: { description: "review" } })` splices `{{ params.description }}` verbatim into YAML text before parsing (quote the placeholder). Distinct from runtime `{{edge}}` prompt placeholders; params on a parsed object throw. `syntax.parse(text, { params })` supports the same authoring substitution.

## Runner

```ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, JuncoGraph, schedules, syntax, tracer } from "junco";
import source from "./review.yml" with { type: "text" };

/**
 * Review workflow: Goals fan out to Direct and a two-round Ralph; Reviewer joins both.
 * Terminates when Reviewer returns; its result is the root sink's value.
 */
const models = await ModelRuntime.create();      // shared; see Model selection
// Use models verified against the catalog and saved credentials; this rung is illustrative.
const rung = { model: "provider/model-id", thinking: "medium" } as const;
const rungs: schedules.Ladder = { smol: rung, low: rung, med: rung, high: rung, xhigh: rung };
const ladder = new schedules.ModelLadder(models, rungs);
const execution = await JuncoGraph.fromYaml(source, {
  cwd: process.cwd(),                            // skills paths resolve against this
  scheduler: () => schedules.parallel(),         // called once per graph level as (label, graphPath)
  ladder,
  tracer: new tracer.DummyTracer(),              // silent; see shared TUI lifecycle above for interactive runs
  ...schedules.ralph({ rounds: 2 }),             // only for documents containing the standard RalphControl
});
let terminalText: string;
try {
  const results = await execution.run();
  const review = results.get(graph.NodeId.create("Reviewer"));
  terminalText = syntax.finalText(review, "Reviewer");
} finally {
  await execution.graph.close();                // releases built agents, nested graphs, the collection build created
}
console.log(terminalText);                       // only after close (and TUI finish when interactive)
```

`syntax.FromYamlOptions` (all code-side): `cwd`, `scheduler(label, graphPath)` (display label, which may repeat, and unique wrapper path, `""` at the root), `ladder` (`schedules.ModelLadder` pairing the runtime with its five allowed rungs), `code` (node ID → exported `syntax.DeterministicNode`), `policy` (default `tools.LockPolicy`), `collection` (caller-owned; construction otherwise creates one when agents list collection tools), `tracer`, `tools` (name → `AgentTool` for YAML `tools:` entries), `createAgent(spec)` (supply persistent agents by `spec.node`, or by the unique root-relative `spec.path` such as `Child/Worker` when nested graphs reuse IDs; `spec.graph` is the display label), `context` (typed code-node inputs), `signal`, `params`, `loopGuard` (`new agent.LoopGuard(options)` applies to each agent the builder creates; `createAgent` receives it as `spec.loopGuard`), `tool_pruning` (`true` deactivates never-called collection tools after ten settled runs per agent; valid only when the builder creates the collection). `syntax.resolveAgents(document, { cwd })` resolves role prompts/tools without constructing agents. A ladder is required for default agent creation; with `createAgent`, omitting it disables model switching. `new schedules.ModelLadder(models, rungs)` checks all five model identities, catalog presence and supported thinking levels synchronously; credentials/availability still need preflight. `syntax.createJuncoAgent(spec, ladder)` uses the paired runtime and initializes at `med`. Each decision applies its selected rung's model and thinking (default `"off"`); built-in policies select `med`, and `schedules.strength((snapshot, nodeId) => "high", inner)` overrides it per node.

Round loops that are not Ralph (repeat until a typed verdict approves) live in the runner: build a fresh graph per round over the same persistent agents via `createAgent` with `createAgentOwnership: "caller"` (graph close then aborts them without disposing them), pass the verdict tool through `tools`, read the verdict after `run()`, close each round's graph, and close the agents once after the last round. Never add a round cap the task did not state.

## Code nodes

A `kind: code` node is a deterministic coroutine exported from the same-named workflow TypeScript module and supplied as `code: { Goals, Join }` to `JuncoGraph.fromYaml`. Missing definitions fail before agents are created; YAML contains no module-path registry.

```text
export type CodeContext<C = unknown> = {
  readonly graph: JuncoGraph;             // live graph
  readonly label: string;                 // graph name
  readonly node: string;                  // this node's id
  readonly edges: ReadonlyMap<string, Edge>;   // every edge touching this node, by YAML id
  readonly policy: tools.Policy;
  readonly collection?: tools.ToolCollection;
  readonly context: C;                    // BuildOptions.context
  readonly signal?: AbortSignal;
};
export type DeterministicNode<C = unknown> = (context: CodeContext<C>) => Deterministic<TSchema, unknown> | Promise<Deterministic<TSchema, unknown>>;
// graph.nodes.Deterministic: new Deterministic<TSchema, unknown>(
//   async function* (signal, collection?) : NodeGenerator, policy, collection?)
```

```ts
import type { TSchema } from "typebox";
import { graph, syntax } from "junco";

/** Publishes the assignment once to both competitors, then finishes (like `emit`, but text comes from context). */
export const Goals: syntax.DeterministicNode<{ goals: string }> = ({ context, edges, policy }) => {
  const outputs = ["Goals~>Direct", "Goals~>Ralph"].map((id) => edges.get(id)!);
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* (signal) {
    const task = graph.nodes.Task.create({ kind: "prompt", text: context.goals, spec: context.goals }); // one task, both competitors
    signal.throwIfAborted();
    return new graph.FinalMessages(outputs.map((edge) => graph.Message.create(edge, task)));
  }, policy);
};

/** Joins two value reports, validates them, and prepares one assignment message. */
export const Join: syntax.DeterministicNode = ({ edges, policy }) => {
  const a = graph.EdgeId.create("A->Join"), b = graph.EdgeId.create("B->Join");
  return new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const inputs = yield [];                                   // prime; consumes nothing
    const text = [inputs.values.get(a), inputs.values.get(b)].map((m, i) => syntax.finalText(m, i ? b : a)).join("\n\n");
    const task = graph.nodes.Task.create({ kind: "prompt", text, spec: "One merged report covering both inputs." });
    return new graph.FinalMessages([graph.Message.create(edges.get("Join~>Reducer")!, task)]);
  }, policy);
};
```

Rules: start dependent bodies with `const inputs = yield []`; read values with `inputs.values.get(EdgeId)` and messages with `inputs.messages.get(EdgeId)`; emit only on edges the YAML wired from this node; validate upstream reports (`stopReason`, non-empty text, exact message counts) instead of trusting prose; finish message-only publishers with `return new graph.FinalMessages(batch)`; put run-local inputs (request text, feedback, counters) in `config.context`, never module globals. Pass each referenced code node directly in `config.code`, including nodes inside nested graphs.

## Patterns

| Shape | YAML | Code |
|---|---|---|
| Fixed assignment fan-out | `kind: emit` → message edges to each worker; workers `prompt: "Complete the assignment in the user message(s) following this prompt."` | none |
| Assignment from runtime input | `kind: code` publisher reading `context` | `Goals` above |
| Join / review | two return FIFOs with explicit IDs, `trigger: { all: [A->R, B->R] }`, `prompt` with `{{A->R}}`/`{{B->R}}` and report requirements | none; or a code join when reports need validation beyond `finalText` |
| Partial handoff | sender prompt names the outbound message edge ID and payload requirements; receiver `trigger: { any: [partial-message, final-return-event] }` | code receiver when "exactly one partial" must be enforced |
| Fixed-round revision (Ralph) | standalone: `JuncoGraph.fromYaml(workflows.ralph, config)`, assignment on source route `assignment`. Nested: splice `syntax.parse(workflows.ralph).graph` into a `kind: graph` node, preserving `source.trigger` with `{ ...inner.source, routes }` when rekeying `source.routes` to the parent edge; do not re-declare the loop | `...schedules.ralph({ rounds })` in config; rounds only if stated (default two) |
| Repeat until approved | one round graph with a verdict tool in `tools:` | runner loop with `createAgent` + `tools` + verdict take-and-clear; no cap |
| Nested agency | `kind: graph` with `source.routes`/`sink.returns` | none |
| Wait for release | declare a message trigger and send its credit from an executed controller | none in scheduler policies |
| Pick best of candidates | all returned: splice `workflows.allFanIn`; streaming as candidates arrive: splice `workflows.anyFanIn` | `...schedules.anyFanIn()` for AnyFanIn |
| Memory/token/runtime/cost ordering | — | configure `measurementWindows` in TS; rank recorded samples with `schedules.lowest` / `highest` or your own policy |

## Standard library (`src/std`, exported from `junco`)

The [AGENTS.md standard library index](../../AGENTS.md#standard-library-index) is the complete catalog; the table below is only a quick reference. Check the index for matching workflows (including memory variants), companion controllers, schedulers, node bodies and tracers. Preserve their input routes, edge transports and output contracts; write custom topology or code only for requirements the indexed blocks do not cover.

| Namespace | Use in generated workflows |
|---|---|
| `workflows.ralph` | The only Ralph definition: YAML text, source route `assignment`, controller `RalphControl`, output `Ralph->$sink`. Models come from config.ladder. Never hand-write a Ralph graph. |
| `schedules.ralph({ rounds })` / `schedules.ralph({ until, rounds? })` | Round controller; returns `{ code }` for fromYaml config. `until` is a synchronous success check per completed draft (no cap unless `rounds` is given). Register its code for documents containing RalphControl. |
| `workflows.allFanIn` | Select (never synthesize) the best of completed candidates once all returned: source route `candidates`, output `AllFanIn->$sink`. Embedded: wrapper `trigger: { all: [<parent return-message edges>] }`, those edges routed to `$source~>AllFanIn`. Selection criteria go in the agent's `system`. |
| `workflows.anyFanIn` + `schedules.anyFanIn()` | Stream one selection per delivered candidate batch (`Task.create({ kind: "prompt", text, spec })` on route `candidates`) without waiting for parents to return; streamed under `AnyFanInPublish~>$sink`. Embedded: route parent message edges to `$source~>AnyFanIn`, wrapper `trigger: { any: [...] }`, message edges only. Spread `...schedules.anyFanIn()` into config (`{ code }`); combine distinct code entries explicitly when composing controllers. |
| `schedules.parallel()`, `roundRobin()`, `agent()`/`pi(...)`, `choose`, `separate`, `strength`, `reads`, `limit`, `lowest`, `highest` | Scheduler policies for config.scheduler. Default `parallel()` chooses `med` and planned message reads; `strength` assigns a rung per node, `reads` overrides selected message edges. Custom decisions use `select(snapshot, ids, strength?)` or supply mandatory `readEdges`. |
| `schedules.context`, `SchedulerContext` | What `fromYaml` returns (`run()`, `step()`, `.graph`); only hand-wired graphs call `context` themselves. |
| `tracer.DummyTracer`, `tracer.TuiTracer.shared()` | `BuildOptions.tracer`; shared returns `TuiTracer | DummyTracer`. Retain and pass the shared observer explicitly to finish an interactive TUI after all graphs close; print only after terminal restoration. |
| `graph.nodes.Deterministic`, `graph.Message`, `graph.EdgeId`, `graph.NodeId`, `graph.from` | Code-node bodies and result lookup. |
| `graph.trigger.TriggerRule`/`TriggerEntry` | Native declarative node triggers; YAML `trigger:` already compiles to these. |
| `graph.nodes.EmitOnce`, `StepNode`, `ConstFanout`, `ConstFanin`, `Source`, `Sink` | Hand-wired `DataflowGraph` programs only (escape hatch); in YAML use `kind: emit`/`kind: code`. |

## Model selection

Only for documents with agents. Deterministic-only documents skip this.

1. `const models = await ModelRuntime.create({ allowModelNetwork: true, refreshOnCreate: false })` from `@earendil-works/pi-coding-agent`; `const refreshed = await models.refresh({ allowNetwork: true })`; report `refreshed.aborted` and provider-keyed `refreshed.errors`.
2. `await models.getAvailable()` lists chat models; `await models.listCredentials()` returns non-secret `{ providerId, type }`. The chosen provider MUST appear there: default construction uses Pi's saved login; catalog presence is not entitlement.
3. Verify "latest" against official provider docs/release notes with the exact catalog ID. `Model` has no release date; ordering, context size, price and reasoning flags prove no freshness. Select by role capability. Missing freshness evidence or an authenticated suitable model is a prerequisite failure, not a cached choice.
4. Declare a complete five-rung `schedules.Ladder` in `<name>.ts`; each rung is `{ model: "provider/model-id", thinking?: ThinkingLevel }`. User-requested models override. Record verification date/source beside the ladder. Pair it with the runtime via `new schedules.ModelLadder(models, rungs)` and pass the result as `fromYaml`'s `ladder`; construction rejects models absent from the catalog and unsupported thinking (omission means `"off"`). Unused rungs may reuse the nearest used rung. Default agents initialize at `med`; selected agents switch to the scheduler's rung before execution.

## Create a workflow

1. **Extract the shape and select building blocks.** Inputs/output, roles, dependencies, stop condition, tool permissions, tracing. Match these against the standard library index before designing custom topology. Map the remaining roles to a node kind (agent / emit / code / graph) and each dependency to an edge kind (message = assignment or handoff, value = finished report).
2. **Select models** (above).
3. **Write `<name>.yml`.** Top comment: purpose, topology, termination. Per node: `description`, explicit `trigger`, `prompt` placeholders and artifact/acceptance requirements in role or handoff prompts. Name explicit edge IDs for handoffs. Register only `skills`; never YAML model/thinking/code registries. Every finite path must end at `$sink`.
4. **Export code nodes in `<name>.ts`** only when the pattern needs deterministic logic; pass them by node ID in config.code.
5. **Run from `<name>.ts`.** Declare the ladder and call `JuncoGraph.fromYaml(source, config)` → run → read the terminal result → close in `finally`. For the shared TUI, retain and pass the observer explicitly, then guard `observer.finish()` in a nested `finally` after close. Guard live acquisition with `if (import.meta.main)` when exporting a factory for tests. Operational prints go after terminal restoration; under TUI ownership use `log.info` from `junco-tools/log`.
6. **Check offline first.** `syntax.parse(source)` checks schema, reserved IDs, edge direction, dangling edges and triggers. `syntax.resolveAgents` checks role tools/prompts; `schedules.validateLadder` checks model identities. Run these before agent acquisition.
7. **Run and report.** Execute `bun run <name>.ts` when credentials/tools allow; otherwise report the exact limitation. Return the YAML/TypeScript pair, run command with prerequisites, and observed output.

## Escape hatches

Read `references/typescript-api.md` (namespace signature excerpts, composition patterns, hand-wired example) when the document cannot express the task: graph compaction, custom tracer callbacks, non-chat message/result types, or custom native ports. Resource measurement windows and resource-aware scheduling are ordinary `fromYaml` configuration.

Repository work (such as refactor, translate, verify or audit) follows `references/repository-workflows.md`: inspect source with omp's available tools and author task-oriented YAML directly. Generated Junco agents use `code_graph` at execution time when their roles need repository exploration; do not require omp to call it first. Clusters are evidence, not work packages or a schedule. Preserve requested permissions, handoffs and concurrency; route every required report to the requested terminal output.

## Before returning

- [ ] `syntax.parse(source)` succeeds offline; the complete ladder's models and thinking levels are verified.
- [ ] Every agent has a `prompt`; handoff prompts name route IDs and payload requirements; message vs value kind matches assignment vs report.
- [ ] Each `kind: code` ID has a same-named exported `syntax.DeterministicNode` in config.code; message-only publishers return FinalMessages; joins validate stopReason/text.
- [ ] Stop condition matches the task: terminal node wired to `$sink`; Ralph rounds only as stated; no invented caps, retries, reviewers or allowances.
- [ ] Model choices carry catalog + credential + dated freshness evidence beside the TypeScript ladder, or a reported missing prerequisite.
- [ ] Runner passes only needed `BuildOptions`; close in `finally`, then guarded retained TUI `finish()` in nested `finally` when interactive; persistent agents close once after their last round; MCP stderr captured under TUI.
- [ ] Program executed (or offline-parsed when live prerequisites are missing); output observed; exact limits reported.
- [ ] Repository workflows: authoring source evidence covers the requested scope or names inspection gaps; runtime `code_graph` queries are assigned to Junco agents that need them, not claimed as authoring results. Task outcomes define roles and artifact handoffs; permissions and concurrency match the request; all required reports reach the terminal. No generated metadata, topology conversion or code-degree scheduling.
