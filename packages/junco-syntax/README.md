# junco-syntax

YAML syntax and `parse()` + `build()` for runnable JuncoGraphs. Declarative: graph, agents' model/system/tools/MCP/skills registered by name. Code: scheduler, custom tools, host-state availability, loops.

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
  kind: ralph                       # Ralph.register; trigger fixed to its inbound edge
    (same agent fields, no trigger) + rounds?: int >= 1 (default 2); exactly 1 inbound message edge, exactly 1 outbound message edge
  kind: emit                        # publishes one {kind: prompt, text} on every outbound message edge, once
    text: string                    # no inbound edges; no outbound value edges; >= 1 outbound message edge
  kind: graph                       # nested graph as a node
    graph: <Graph>
```

`Trigger` is `always`, `never`, a scalar inbound edge ID, or one of the flat mappings below. Omitted: always when the node has no inbound edges, otherwise all inbound edges in declaration order.

```yaml
trigger:
  all: ["<edge id>", ...]
```

```yaml
trigger:
  any: ["<edge id>", ...]
```

Every graph gets fresh `$source` and `$sink` ports. Edges into `$source`, out of `$sink`, and value edges out of `$source` are rejected by `parse`. Trigger rules are flat engine rules: no nesting or `not`.

- `source.routes`: every message on parent edge `k` is forwarded unchanged onto each listed internal edge; a value is forwarded as `{kind:"prompt", text: finalText(value)}`. Unrouted ingress throws `DataflowDefinitionError('<name> does not accept input on edge "<id>"')`. No routes means a closed source: `DataflowDefinitionError("<name> does not accept external input")`.
- `sink`: yields `[]`, reads `graph.result(returns)`, throws `Error("<returns> did not produce a result")` if absent, then returns that result. Nested sinks also send `{kind:"prompt", text: finalText(result)}` on every parent message edge leaving the wrapper. Parent value edges resolve from the returned result. `returns` defaults to the unique predecessor of `$sink`; several distinct predecessors require an explicit choice.
- `finalText`: requires `stopReason === "stop"`, otherwise throws `"<who> did not finish normally: <reason|no final message>"`. Uses `contentText(message.content).trim()` and rejects empty text with `"<who> produced an empty report"`.
- YAML `prompt` is always applied with `instance.stagePrompt` after the factory returns. Template `/\{\{\s*([^}]+?)\s*\}\}/g` replaces value edges with `finalText(value, id)`, message edges with delivered messages' text joined by `"\n\n"`, and missing delivery with `""`. Without placeholders, the prompt stays a plain string. Inbound messages are data, not implicit assignments: absent a YAML prompt, code must stage the agent's assignment.
- `contracts` map incoming edge ids to receiver `expect` text. A missing contract throws `JuncoAgentError("invalid_state", 'No contract for edge "<id>"')`. Absent `contracts` adds no receiver contract.
- Triggers map to `TriggerRule.always`, `never`, `when`, `allOf(...entries.map(TriggerEntry.on))`, or `anyOf`.
- Every agent spec receives fresh `YieldTool`, `InfoTool`, `SendTool`, `RecvTool`, `TaskTool` in that order. `tools` and `mcp` only add tools. Builtin names `yield`, `info`, `send`, `recv`, `task` cannot be listed or shadowed. Collection names include `read`, `bash`, `edit`, `grep`, `find`, `ast_grep`, `ast_edit`, `diff`, `release`; other names are code-registered tools.
- Skills are loaded once per referenced registry name, attached as `resources.skills`, and advertised with `formatSkillsForSystemPrompt`, appended to YAML `system` using `"\n\n"`.

```ts
import { parse, build } from "junco-syntax";
import { schedulers, tracer } from "junco-agency";

const document = parse(source); // YAML string or already-parsed object
const execution = await build(document, {
  cwd: process.cwd(),
  scheduler: () => schedulers.parallel(), // called once per graph
  tracer: new tracer.DummyTracer(),
});
try { await execution.run(); }
finally {
  try { await execution.graph.close(); }
  finally { await execution.graph.tracer.flush(); }
}
```

Code supplies `scheduler`, custom `tools`, optional `createAgent`, per-node `available` hooks (including `$sink`), `tracer`, `policy`, caller-owned `collection`, and `models`. `resolveAgents(document, {cwd, tools?, collection?})` returns agent/ralph specs in depth-first declaration order without creating agents. `createJuncoAgent(spec, models?)` creates one default agent.

`execution.graph.close()` releases all registered agents, including factory-returned agents, and the collection if `build` created it. A caller-supplied collection stays caller-owned. If default-factory construction fails, acquired agents are returned in reverse order and partial graphs release their borrowed collection leases, including nested graphs. Cleanup attempts all releases, preserving the construction error before any distinct cleanup failures. A custom factory owns its failure cleanup. Persistent agents must not have an intermediate round graph closed while they are still needed.

The runtime requires Bun's YAML parser. This package uses TypeBox 1.x `Type.Cyclic` for recursive schemas (`Type.Recursive` is not available). Local development uses a `file:../..` root dependency and a root override because Bun does not resolve the workspace root as `workspace:*`.

Examples use block YAML mappings; flow sequences and legacy flow mappings remain accepted. Prompt placeholders remain `{{edge}}`.

Run `bun run --cwd packages/junco-syntax test:coverage` for deterministic offline parser, trigger, graph-boundary and faux-agent resource checks. Package-local coverage excludes workspace dependencies and emits text plus `coverage/lcov.info`; CI enforces 98% lines/functions. No saved login, live MCP server or native tool acquisition is required.

The build suite groups resolution, MockAgent runtime, and faux default-agent cases around shared helpers. The parser suite shares mutation fixtures and path-rejection checks, with trigger rules grouped together.
