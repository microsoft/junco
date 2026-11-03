# Repository workflows authored from code evidence

omp inspects the repository with its available tools, chooses work packages and authors the YAML/TypeScript pair. `code_graph` is a Junco agent runtime tool, not an omp authoring tool. Code dependencies describe the implementation; workflow edges describe required artifact handoffs. They are not interchangeable.

## 1. Extract the request

Record the task, requested scope, output, permissions, parallelism, handoffs and stop condition before exploring. Preserve named work packages and explicit model/cost requirements. Do not invent reviewers, retries, loops or implementation work for a read-only request. Generated workers receive `code_graph` only when their roles need repository exploration.

## 2. Establish prerequisites

Require Bun, a resolvable public `junco` package and an absolute repository root for validation and execution. Do not require `code_graph` in omp's tool inventory or stop authoring because it is absent. Use omp's available file, search and semantic-navigation tools to inspect README scope, source and interfaces. Do not install anything or invoke `code_graph` through a CLI or host-side substitute; configure it in the relevant Junco agents' YAML `tools:` instead. A failure to resolve a configured tool during build or execution is a runtime prerequisite failure; report it without fabricating graph evidence.

Follow SKILL.md **Model selection** unchanged: catalog, saved credentials, dated official freshness evidence, supported thinking levels and user overrides. Declare the complete five-rung ladder in the paired TypeScript; catalog presence alone does not establish authorization. Report missing prerequisites rather than invent model identities or claim live execution.

## 3. Assign task-relevant graph exploration to Junco agents

The following instructions apply to generated Junco agents with `code_graph`, not to omp while authoring. Put task-relevant exploration instructions in those agents' prompts; do not add an exploration agent solely to make the tool available. At execution time, start with a map and task-relevant search, then browse clusters associated with relevant directories. These are Junco agent tool arguments, not shell commands or authoring prerequisites:

```json
{"action":"map","path":"<repo>"}
{"action":"search","path":"<repo>","query":"<task-relevant symbol>"}
{"action":"cluster","path":"<repo>","directory":"src"}
{"action":"cluster","path":"<repo>","clusterView":"members","clusterId":"<returned-id>"}
{"action":"cluster","path":"<repo>","clusterView":"neighbors","clusterId":"<returned-id>","direction":"out"}
```

`path` is always the repository root; `directory` is a root-relative POSIX selector. Keep the root, `maxSize` and `omnipresent` fixed while browsing. Defaults are list view, `maxSize: 20`, automatic omnipresent threshold, `offset: 0`, `limit: 20`; page limits are 1–100. These options tune evidence, not agent count. IDs are handles for the same graph snapshot/options, not durable identifiers: after edits or option changes, restart from list rather than guessing stale IDs.

- **List:** includes every cluster touching the directory, including cross-directory clusters. `matching_files` counts matching files; `contained` means the entire cluster is inside the selection. Directory filtering projects complete-repository clustering; it does not recompute local memberships. An absent directory returns an empty list.
- **Members:** returns actual symbol nodes, including source spans, ordered by ID. Use the returned ID, not a map bucket or guessed name.
- **Neighbors:** returns one-hop symbol-dependency neighbors. `out` follows selected-cluster calls/references to their targets; `in` finds consumers; `both` is their union and the default. Each neighbor appears once, with actual `incoming` (other→selected) and `outgoing` (selected→other) edges when present, even when selection used just one direction. Edges can cycle. They count distinct symbol pairs (`edges`) and distinct target symbols (`targets`), not repeated relations. File import edges are not expanded onto clusters.

Results use snake_case fields. `sample_files` is only the first five sorted distinct paths; `file_count` is the complete count. Each view returns `total`, `offset` and nullable `next_offset`. Follow `next_offset` using `offset` until the relevant evidence is covered, not automatically the whole repository. If the tool's byte bound truncates a result, reduce `limit`; missing visible rows are not evidence of absence.

## 4. Read source and establish contracts

During authoring, read relevant source spans and use omp's available semantic-navigation tools to establish producer/consumer contracts. At execution time, Junco agents can use `code_graph` `deps` on relevant symbols; file deps with `direction: "out", relations: ["contains"]` lists definitions, and ordinary deps handles file imports. Trace interfaces needed by the requested task, not every edge in the repository.

Map directory buckets are not cluster IDs. Directories and symbol clusters have many-to-many membership: one directory can touch several clusters, and one cluster can cross directories. Keep concise source references in descriptions, prompts and the authoring report instead of copying exhaustive inventories.

## 5. Cross-check coverage against the scope

Zero symbols, no matching cluster, sparse/disconnected edges, macros and unsupported syntax or languages are not proof that requested implementation is absent. Inspect missing areas with `read`/`find`/`grep`, state extraction limits explicitly and ground every work package in inspected source. Include requested unsupported source in the workflow; never silently replace it with benchmarks or tests. Do not expand the extractor as part of authoring. If source really cannot be inspected, report that exact missing prerequisite rather than inventing responsibilities or results.

## 6. Choose task work packages and handoffs

Choose responsibilities from requested outcomes and interfaces. Combine related small clusters or split a large cluster by task responsibility. There is no one-agent-per-cluster rule or symbol-count agent cap. Add an edge only when its receiver needs the sender's artifact. Name the artifact and acceptance condition in role/handoff prompts, and use the explicit edge ID for routing. Do not automatically reverse code edges into workflow edges.

Cyclic code does not require cyclic execution. Settle a shared interface first or keep a cross-directory cycle in one coherent implementation responsibility. Add review/iteration only when requested; nesting alone is neither a review nor a loop.

## 7. Author valid YAML directly

Use task-oriented names, brief source-grounded responsibilities, explicit triggers and staged prompts containing artifact and acceptance requirements, following SKILL.md syntax. Include only permitted tools. A read-only role has no edit, release or change-report instructions; constrain any shell access to read-only operations. Editing roles coordinate shared-file handoffs without claiming exclusive ownership or inventing hard file boundaries beyond the user's restrictions.

Prefer flat workers unless a requested loop or nested agency needs wrappers. Use the standard Ralph pattern when appropriate. Write valid runtime YAML from the outset: no `files` metadata, post-processing pass, intermediate workflow schema, topology generator or exhaustive repository manifest.

## 8. Route all required output

Choose the terminal from the requested output, never from the first code-graph root. Every required report must reach it. For deterministic aggregation, reuse SKILL.md's `kind: code` join pattern in the paired TypeScript: wait for all required values, validate normal completion and nonblank `contentText`, then retain each report exactly once in the combined terminal output. Register exported code definitions in `config.code`. Use an agent synthesizer only for a real judgment task, not merely because several reports exist. Set `sink.returns` explicitly when needed.

## 9. Use task-based scheduling

Reuse the standard runner. Default to `schedules.parallel()` and its `med` rung; select stronger/weaker roles from task needs and explicit model/cost requests, not code in-degree or critical-path formulas.

For a finite, flat workflow with at most N simultaneous agents:

```ts
const scheduler = () => schedules.choose({ rank: () => 0, width: () => N });
```

When nesting is necessary, give every graph level a unique explicit YAML `name`. Match the root's exact name, not whether the label happens to be a node key. For example, a root named `Task` may also contain an emit node named `Task`:

```ts
const ROOT_NAME = "Task"; // exact graph.name in the authored YAML
const scheduler = (label: string) => schedules.choose({
  rank: () => 0,
  width: () => label === ROOT_NAME ? N : 1,
});
```

Use width N only at that root and width 1 at every inner level. Each active subtree then contributes at most one agent, preserving the overall bound. Keep inner graph names unique and different from `Task`; do not infer graph levels from node IDs or add wrappers just to use this recipe.

## 10. Validate, run when allowed, then report

Run `syntax.parse(source)` and `schedules.validateLadder(ladder)` before agent acquisition. Resolve collection tool names through the existing collection when needed (`syntax.resolveAgents` with the collection), not a new tools adapter. Preserve an offline-only or do-not-run stop condition. Offline parsing does not prove live credentials, agent quality or runtime success.

Adapt SKILL.md's runner with the authored scheduler, verified models/ladder and any exported code nodes. An exported runner must also return the terminal text. This lifecycle helper uses the root sink selection rather than an arbitrary graph root:

```ts
import { contentText } from "@earendil-works/pi-ai";
import { JuncoGraph, syntax } from "junco";
import source from "./<name>.yml" with { type: "text" };

export async function run(config: syntax.FromYamlOptions): Promise<string> {
  const document = syntax.parse(source);
  const execution = await JuncoGraph.fromYaml(document, config);
  let terminalText: string;
  try {
    await execution.run();
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag !== "Some" || terminal.value.stopReason !== "stop")
      throw new Error("Terminal did not finish normally");
    terminalText = contentText(terminal.value.content).trim();
    if (!terminalText) throw new Error("Terminal returned an empty report");
  } finally {
    await execution.graph.close();
  }
  console.log(terminalText);
  return terminalText;
}
```

In the delivered pair, supply `cwd: "<repo>"`, the chosen scheduler, verified shared models/ladder and required `code` definitions to `run`; guard live acquisition/invocation with `if (import.meta.main)` when exporting for tests. Do not leave illustrative placeholders in delivered files. Execute `bun run <name>.ts` only when permissions and prerequisites allow. The helper leaves caller-supplied tracer lifetime to the caller. For an interactive runner, retain `const observer = tracer.TuiTracer.shared()` before construction, pass it as `tracer: observer`, and after graph close call `observer.finish()` in a nested `finally` only if `observer instanceof tracer.TuiTracer` (import `tracer` from `junco`). Keep operational prints after terminal restoration; never retrieve the observer through `graph.tracer`, which a recorder may wrap.

Return the pair and run command, concise authoring source evidence and coverage limits, the requested permission/concurrency choices, and actual output or the exact missing prerequisite. Distinguish runtime graph exploration assigned in prompts from queries actually executed by Junco agents. Never substitute a CLI summary or unobserved success for the requested result.
