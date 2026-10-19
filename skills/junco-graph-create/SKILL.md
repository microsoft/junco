---
name: junco-graph-create
description: Generate runnable Junco workflows as junco-syntax YAML documents (`<name>.yml` declaring agents, emit/code/nested-graph nodes, edges, triggers, prompts, contracts, MCP servers and skills) plus a small Bun runner that calls `parse`/`build` from `junco-syntax`. Use for any dataflow graph, agent coordination, fan-out/fan-in, joined review, feedback or Ralph loops, nested agencies, committee rounds, deterministic `kind: code` nodes, Trail/graft repository-derived agentic nodes and checkpoints, or resource-ordered scheduling — even when the user says "agent pipeline", "multi-agent workflow" or "graph" without naming Junco.
---

# Junco graph creation

One request → one runnable workflow: `<name>.yml` (the graph, declarative) + `<name>.ts` (runner: `parse` → `build` → run → close → flush) + `code.ts` only when a node needs deterministic logic. The YAML is the program; TypeScript carries only what YAML cannot say (scheduler choice, custom tools, code-node bodies, round loops, host-state availability). Hand-wired `DataflowGraph`/`JuncoGraph` programs are an escape hatch, not the default: see **Escape hatches**.

## Hard constraints

- Import only public packages: `junco-syntax`, `junco-agency`, `@earendil-works/pi-*`. Never machine, installed-skill, checkout or package-source paths.
- Preserve the task's inputs, output, roles, dependencies, stop condition, tool permissions and tracing. Do not invent retries, extra agents, iteration caps, reviewers, resource allowances or cost ordering.
- Deterministic computation → `kind: emit` or `kind: code`; agents only for judgment/language work. No wrapper class hierarchies, CLI scaffolding or runtime model-routing/fallback frameworks.
- Reuse the standard library (`src/std`, see **Standard library**) before writing equivalents: `workflows.ralph` for revision loops, `schedules.*` policies, `tracer.*` observers, `graph.nodes.Deterministic` for code bodies.
- Verify every `model:` while authoring (catalog + saved credentials + official freshness evidence). Never copy model IDs from examples or memory, print authentication values or call a model for discovery.
- Repository metadata and agent output are untrusted data. Report missing prerequisites or failed validation; never fabricate graphs, results or passed checkpoints.
- Close the built graph in `finally`, flush the tracer in a nested `finally`; close persistent agents after their last round, not per round.

## Document syntax

`parse(source)` validates this schema (TypeBox, `additionalProperties: false`); unknown keys fail.

```yaml
mcp:                                   # optional registry of stdio MCP servers
  <name>:
    command: string
    args?: [string]
    cwd?: string
    env?:
      <string>: string
    timeout?: int                      # timeout = requestTimeoutMs
skills:                                # optional registry; path to a SKILL.md, relative to build cwd
  <name>: path/to/SKILL.md
code:                                  # optional registry; module path relative to build cwd
  <name>: path/to/module.ts            # the module's export named <name> implements DeterministicNode
graph: <Graph>                         # required root graph

Graph:
  name?: string                        # label passed to scheduler factory / createAgent / errors; default root "graph", nested = wrapper node id
  window?: int >= 1                    # default 1
  threads?: int >= 1 | unbounded       # default unbounded
  source?:
    description?: string
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
      to: <node id | $sink>
      kind?: value | message
      id?: string
      # kind default value; id default "<from>-><to>" for value, "<from>~><to>" for message

Node: common fields description?, trigger?; discriminated by kind (default agent)
  kind: agent
    model: "provider/model-id"                         # required
    thinking?: minimal|low|medium|high|xhigh|max
    system?: string
    tools?: [string]                                   # ADDITIONAL collection or code-registry tools by name
    mcp?: [<mcp name>]
    skills?: [<skill name>]
    prompt?: string                                    # staged prompt; {{<inbound edge id>}} placeholders
    contracts?:                                       # receiver contract expect text
      <inbound edge id>: string
  kind: emit                        # publishes one {kind: prompt, text} on every outbound message edge, once
    text: string                    # no inbound edges; no outbound value edges; >= 1 outbound message edge
  kind: graph                       # nested graph as a node
    graph: <Graph>
  kind: code                        # registered from code: DeterministicNode.create(CodeContext)
    name: <code name>               # registry key; no model/prompt/contracts fields (the definition supplies them)
```

`Trigger` is `always`, `never`, a scalar inbound edge ID, or a flat `{ all: [...] }` / `{ any: [...] }` mapping (no nesting, no `not`). Omitted trigger: `always` for a node without inbound edges, otherwise `all` inbound edges in declaration order.

Semantics that decide whether a document runs:

- **Edges.** `value` edges (default, id `A->B`) retain the source's latest returned `AssistantMessage`; `message` edges (id `A~>B`) queue `{ kind: "prompt", text }` payloads. Use message edges for assignments and partial handoffs, value edges for finished reports. Edges into `$source`, out of `$sink`, and value edges out of `$source` are rejected. Quote edge IDs containing `>` where YAML would misparse (`"Goals~>Direct"`).
- **Agents run once per staged prompt.** A YAML `prompt` is staged once at build. `{{edge}}` placeholders make it a callback evaluated when the run starts: value edges insert `finalText(value)` (requires `stopReason === "stop"` and non-empty text, else the node fails), message edges insert delivered texts joined by `"\n\n"`, missing delivery inserts `""`. Delivered messages are data the agent reads with `recv`; without a `prompt`, nothing starts the agent — then code (a `kind: code` node, `createAgent`, or `schedules.ralph`) must stage it. A value self-edge re-arms a returned agent but still needs another staged prompt, so agent loops in pure YAML are Ralph loops only.
- **Agent tools.** Every agent gets `yield`, `info`, `send`, `recv`, `task` (names reserved; cannot be listed or shadowed). `tools:` adds collection tools (`read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`, `release`) or names supplied through `BuildOptions.tools`. An agent `send`s on an outbound message edge discovered with `info`, then `yield`s; the receiver's `contracts` text is what `info` shows the sender as the route expectation. A missing `contracts` entry on a wired inbound edge throws `No contract for edge`; absent `contracts` adds none.
- **`emit`** needs ≥ 1 outbound message edge and no inbound edges; it publishes the same text once per edge and parks.
- **Nested graphs.** `source.routes` forwards each parent message on edge `k` unchanged onto the listed internal `$source~>…` edges; parent values arrive as `{ kind: "prompt", text: finalText(value) }`. No routes = closed source (unexpected ingress throws). The nested `sink` reads `graph.result(returns)` (default: the unique predecessor of `$sink`; several predecessors need an explicit `returns`), returns it as the wrapper's value, and also sends it as a prompt on every parent message edge leaving the wrapper. Only the final retained result escapes; intermediate drafts never do.
- **`$sink` of the root** retains the selected terminal's exact result; read it from the `run()` map by node ID (`results.get(graph.NodeId.create("Reviewer"))`) or `execution.graph.result(execution.graph.sink.id)`. A sink whose `returns` node never finishes throws `<returns> did not produce a result`.
- **Skills** load once per registry name and are appended to `system` with `"\n\n"`. **MCP** servers are stdio; capture their stderr in the runner when a TUI tracer owns the terminal.
- **Params.** `parse(text, { params: { model: "provider/id" } })` splices `{{ params.model }}` verbatim into the YAML text before parsing (quote the placeholder). Distinct from runtime `{{edge}}` prompt placeholders; params on an already-parsed object throw.

## Runner

```ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, schedules, tracer } from "junco-agency";
import { build, parse } from "junco-syntax";
import source from "./review.yml" with { type: "text" };

/**
 * Review workflow: Goals fan out to Direct and a two-round Ralph; Reviewer joins both.
 * Terminates when Reviewer returns; its result is the root sink's value.
 */
const document = parse(source);
const models = await ModelRuntime.create();      // shared; see Model selection
const execution = await build(document, {
  cwd: process.cwd(),                            // `code:`/`skills:` paths resolve against this
  scheduler: () => schedules.parallel(),         // called once per graph level
  models,
  tracer: new tracer.DummyTracer(),              // omit for the automatic TUI tracer
  ...schedules.ralph({ rounds: 2 }),             // only for graphs containing a `Ralph->Ralph` loop
});
try {
  const results = await execution.run();
  const review = results.get(graph.NodeId.create("Reviewer"));
  if (review?.stopReason !== "stop") throw new Error("Reviewer did not finish normally");
  console.log(review.content);                   // print after the TUI has restored the terminal
} finally {
  try { await execution.graph.close(); }         // releases built agents, nested graphs, the collection build created
  finally { await execution.graph.tracer.flush(); }
}
```

`BuildOptions` (all code-side): `cwd`, `scheduler`, `policy` (default `tools.LockPolicy`), `collection` (caller-owned; `build` otherwise creates one when agents list collection tools), `models`, `tracer`, `tools` (name → `AgentTool` for YAML `tools:` entries), `createAgent(spec)` (return persistent `JuncoAgent`s by `spec.node` instead of creating new ones), `available` (node id → `({ graph, edges }) => AvailabilityFn | undefined`, including `$sink`), `context` (typed object handed to code nodes), `signal`. `resolveAgents(document, { cwd })` lists agent specs without creating them; useful to pre-check `model` IDs.

Round loops that are not Ralph (repeat until a typed verdict approves) live in the runner: build a fresh graph per round over the same persistent agents via `createAgent`, pass the verdict tool through `tools`, read the verdict after `run()`, close each round's graph, and close the agents once after the last round. Never add a round cap the task did not state.

## Code nodes

A `kind: code` node is a deterministic coroutine registered from `code.ts`; `build` imports every referenced module before creating any agent, so modules must not top-level-await `build` themselves.

```text
export type CodeContext<C = unknown> = {
  readonly graph: JuncoGraph;             // live graph; getNode(id).status for host-state availability
  readonly label: string;                 // graph name
  readonly node: string;                  // this node's id
  readonly edges: ReadonlyMap<string, Edge>;   // every edge touching this node, by YAML id
  readonly policy: tools.Policy;
  readonly collection?: tools.ToolCollection;
  readonly context: C;                    // BuildOptions.context
  readonly signal?: AbortSignal;
};
export type CodeRegistration = {
  readonly state: Deterministic<AgenticInput, AssistantMessage>;
  readonly is_available?: graph.AvailabilityFn<AgenticInput, AssistantMessage>;  // overrides BuildOptions.available for this id
  readonly contract?: (edgeId: graph.EdgeIdType) => { expect: string };
};
export interface DeterministicNode<C = unknown> {
  create(context: CodeContext<C>): CodeRegistration | Promise<CodeRegistration>;
}
// graph.nodes.Deterministic: new Deterministic<AgenticInput, AssistantMessage>(
//   async function* (signal, collection?) : NodeGenerator, policy, collection?)
```

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import { graph } from "junco-agency";
import type { DeterministicNode } from "junco-syntax";

/** Publishes the assignment once to both competitors, then parks (like `emit`, but text comes from context). */
export const Goals: DeterministicNode<{ goals: string }> = {
  create({ context, edges, policy }) {
    const outputs = ["Goals~>Direct", "Goals~>Ralph"].map((id) => edges.get(id)!);
    let published = false;
    return {
      state: new graph.nodes.Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* (signal) {
        while (true) {
          signal.throwIfAborted();
          published = true;
          yield outputs.map((edge) => graph.Message.create(edge, { kind: "prompt", text: context.goals }));
        }
      }, policy),
      is_available: () => !published,
    };
  },
};

/** Joins two value reports, validates them, and prepares one assignment message. */
export const Join: DeterministicNode = {
  create({ edges, policy }) {
    const a = graph.EdgeId.create("A->Join"), b = graph.EdgeId.create("B->Join");
    let published = false;
    return {
      state: new graph.nodes.Deterministic<graph.nodes.AgenticInput, AssistantMessage>(async function* () {
        const inputs = yield [];                                   // prime; consumes nothing
        const text = [inputs.values.get(a), inputs.values.get(b)].map((m, i) => {
          if (m?.stopReason !== "stop") throw new Error(`${i ? "B" : "A"} did not finish normally`);
          return contentText(m.content).trim();
        }).join("\n\n");
        published = true;
        while (true) yield [graph.Message.create(edges.get("Join~>Reducer")!, { kind: "prompt", text })];
      }, policy),
      is_available: (_view, triggered) => triggered && !published,
      contract: (edgeId) => ({ expect: edgeId === a ? "A's normally completed report." : "B's normally completed report." }),
    };
  },
};
```

Rules: start dependent bodies with `const inputs = yield []`; read values with `inputs.values.get(EdgeId)` and messages with `inputs.messages.get(EdgeId)`; emit only on edges the YAML wired from this node; validate upstream reports (`stopReason`, non-empty text, exact message counts) instead of trusting prose; gate "publish once" with `is_available`, not with an iteration counter; put run-local inputs (request text, feedback, counters) in `BuildOptions.context`, never module globals. The YAML `code:` path is build-cwd-relative; a runner that may execute from another cwd rewrites `document.code` to module-relative absolute paths (`fileURLToPath(new URL("./code.ts", import.meta.url))`).

## Patterns

| Shape | YAML | Code |
|---|---|---|
| Fixed assignment fan-out | `kind: emit` → message edges to each worker; workers `prompt: "{{Emit~>Worker}}"` | none |
| Assignment from runtime input | `kind: code` publisher reading `context` | `Goals` above |
| Join / review | `trigger: { all: [A->R, B->R] }`, `prompt` with `{{A->R}}`/`{{B->R}}`, `contracts` per edge | none; or a code join when reports need validation beyond `finalText` |
| Partial handoff | sender's outbound message edge + receiver `trigger: { any: [partial~>, final->] }` and `contracts` describing the partial route | code receiver when "exactly one partial" must be enforced |
| Fixed-round revision (Ralph) | standalone: `parse(workflows.ralph, { params: { model } })`, assignment enqueued on source route `assignment`. Nested: splice `parse(workflows.ralph, { params: { model } }).graph` in as a `kind: graph` node's `graph` with `source.routes` rekeyed to the parent edge (`{ "<parent>~>Ralph": ["$source~>Ralph"] }`); do not re-declare the loop by hand | `...schedules.ralph({ rounds })` spread into `build`; rounds only if the task states them (default two) |
| Repeat until approved | one round graph with a verdict tool in `tools:` | runner loop with `createAgent` + `tools` + verdict take-and-clear; no cap |
| Nested agency | `kind: graph` with `source.routes`/`sink.returns` | none |
| Host-state gating (pause a member) | — | `BuildOptions.available` or code `is_available` reading `graph.getNode(id).status` |
| Memory/token/runtime ordering | — | escape hatch: `schedules.limit`/`lowest`/`highest` need per-node `profiles`, which YAML has no field for |

## Standard library (`src/std`, exported from `junco-agency`)

Reuse these before writing anything equivalent:

| Namespace | Use in generated workflows |
|---|---|
| `workflows.ralph` | The only Ralph definition: YAML text with `{{ params.model }}`, source route `assignment`, loop `Ralph->Ralph`, output `Ralph->$sink`. Never hand-write a Ralph graph. |
| `schedules.ralph({ rounds })` | Round controller for that loop; returns `{ available }` to spread into `build`. Declines graph levels without `Ralph->Ralph`, so it is safe on a parent document. |
| `schedules.parallel()`, `roundRobin()`, `agent()`/`pi(...)`, `choose`, `separate`, `limit`, `lowest`, `highest` | Scheduler policies for `BuildOptions.scheduler`. Default `parallel()`; others only when the task names an ordering/bound. |
| `schedules.context`, `SchedulerContext` | What `build` returns (`run()`, `step()`, `.graph`); only hand-wired graphs call `context` themselves. |
| `tracer.DummyTracer`, `tracer.TuiTracer.shared()` | `BuildOptions.tracer`; omitting it makes every built `JuncoGraph` use `TuiTracer.shared()` (terminal ownership: print only after `flush()`). |
| `graph.nodes.Deterministic`, `graph.Message`, `graph.EdgeId`, `graph.NodeId`, `graph.from` | Code-node bodies and result lookup. |
| `graph.trigger.TriggerRule`/`TriggerEntry` | Only inside `BuildOptions.available`/code `is_available` logic; YAML `trigger:` already compiles to these. |
| `graph.nodes.EmitOnce`, `StepNode`, `ConstFanout`, `ConstFanin`, `Source`, `Sink` | Hand-wired `DataflowGraph` programs only (escape hatch); in YAML use `kind: emit`/`kind: code`. |

## Model selection

Only for documents with agents. Deterministic-only documents skip this.

1. `const models = await ModelRuntime.create({ allowModelNetwork: true, refreshOnCreate: false })` from `@earendil-works/pi-coding-agent`; `const refreshed = await models.refresh({ allowNetwork: true })`; report `refreshed.aborted` and provider-keyed `refreshed.errors`.
2. `await models.getAvailable()` lists chat models; `await models.listCredentials()` returns non-secret `{ providerId, type }`. The chosen provider MUST appear there: `build` creates agents through Pi's saved login; catalog presence is not entitlement.
3. Verify "latest" against official provider docs/release notes with the exact catalog ID. `Model` has no release date; ordering, context size, price and reasoning flags prove no freshness. Select by role capability. Missing freshness evidence or an authenticated suitable model is a prerequisite failure, not a cached choice.
4. Pin `model: "provider/model-id"` per role; user-requested models override. Record verification date/source in a YAML comment above the node. Set `thinking:` only if `getSupportedThinkingLevels(models.getModel(provider, id))` includes it. Pass the same `models` to `build`.

## Create a workflow

1. **Extract the shape.** Inputs/output, roles, dependencies, stop condition, tool permissions, tracing. Map each role to a node kind (agent / emit / code / graph) and each dependency to an edge kind (message = assignment or handoff, value = finished report).
2. **Select models** (above).
3. **Write `<name>.yml`.** Top comment: purpose, topology, termination. Per node: `description`, explicit `trigger`, `prompt` with placeholders for every inbound edge it consumes, `contracts` for every inbound edge. Register `mcp`/`skills`/`code` entries used. Every finite path must end at `$sink`.
4. **Write `code.ts`** only for nodes the table above sends to code.
5. **Write `<name>.ts`.** `parse` → `build` with the fewest options the document needs → `run` → read the terminal's result by node ID → nested `finally` close/flush. Guard live acquisition with `if (import.meta.main)` when exporting a factory for tests. Operational prints go after `flush()`; under TUI ownership use `log.info` from `junco-tools/log`, never stdout.
6. **Check offline before running.** `parse(source)` throws `DataflowDefinitionError` for schema, reserved-ID, edge-direction, dangling-edge and trigger errors; `resolveAgents(document, { cwd })` lists the model IDs you pinned. Run these in a throwaway `bun -e`/script before any agent acquisition.
7. **Run and report.** Execute `bun run <name>.ts` when credentials/tools allow; otherwise report the exact limitation. Return the YAML, the runner, `code.ts` if any, the run command with prerequisites (Bun, Pi login provider, MCP binaries, language servers), and observed output.

## Escape hatches

Read `references/typescript-api.md` (namespace signature excerpts, composition patterns, hand-wired example) only when the document cannot express the task: resource `profiles` with `schedules.limit`/`lowest`/`highest`, graph compaction, custom tracer callbacks, non-chat message/result types, or availability beyond `available`/`is_available`. Prefer putting the exception in a `kind: code` node over abandoning YAML for the whole graph.

Repository-derived work (Trail map → one node per selected definition, bridge-region checkpoints) follows `references/repository-workflows.md`; the outer graph is mapped from the Trail topology with `JuncoGraph.map`, while each revision child is a YAML Ralph document built with `build`. Bundle `scripts/graft.ts` unchanged beside the workflow.

## Before returning

- [ ] `parse(source)` succeeds offline; `resolveAgents` lists exactly the pinned `provider/model` IDs.
- [ ] Every agent has a `prompt` (or a documented code/Ralph staging path) and a `contracts` entry per inbound edge; message vs value kind matches assignment vs report.
- [ ] Each `kind: code` name has a `code:` registry entry and a same-named `DeterministicNode` export; publishers gate with `is_available`; joins validate `stopReason`/text.
- [ ] Stop condition matches the task: terminal node wired to `$sink`; Ralph rounds only as stated; no invented caps, retries, reviewers or allowances.
- [ ] Model choices carry catalog + credential + dated freshness evidence in a YAML comment, or a reported missing prerequisite.
- [ ] Runner passes only needed `BuildOptions`; close in `finally`, flush in nested `finally`; persistent agents close once after their last round; MCP stderr captured under TUI.
- [ ] Program executed (or offline-parsed when live prerequisites are missing); output observed; exact limits reported.
