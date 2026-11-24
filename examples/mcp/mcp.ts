// # MCP: two agents read this repository through graft
//
// Two live-LLM agents analyze the repository through graft MCP, alongside Junco's builtin tools.
// mcp.yml declares their prompts and graph; this module supplies Reports, LADDER and the graft
// server: one client and process on a shared tool collection, whose tools every agent gets.
// Assignment sends Research one task. Research maps the repository with `mcp__graft__graft_repo_map`
// and selects five central, repository-owned classes, confirming each declaration.
// Dependencies consumes the completed report in its YAML prompt and traces all five classes
// with outbound all-depth `mcp__graft__graft_trace_calls`.
// Reports validates both results and returns Dependencies' exact report.
//
// Prerequisites: junco-tools' Rust toolchain and system libraries (packages/junco-tools/README.md),
// so that `bun install --frozen-lockfile` at the root also builds the production native addon
// (Cargo fetches marsh and junco-policy from GitHub); this checkout inside a Btrfs seed subvolume;
// and a current graft index (`graft build`). Then run it after `pi` → `/login` → GitHub Copilot:
//
//   bun run examples/mcp/mcp.ts

import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agent, graph, JuncoGraph, mcp, schedules, syntax, tools, tracer } from "junco";
import type { TSchema } from "typebox";
import { problemRecorder, runCli, verifiedModels } from "../support.ts";
import source from "./mcp.yml" with { type: "text" };

/** Validate both reports before publishing the dependency report as the graph result. */
export const Reports: syntax.DeterministicNode = ({ policy }) =>
  new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const inputs = yield [];
    syntax.finalText(inputs.values.get(graph.EdgeId.create("Research->Reports")), "Research");
    const result = inputs.values.get(graph.EdgeId.create("Dependencies->Reports"));
    syntax.finalText(result, "Dependencies");
    return result;
  }, policy);


// ## 1. Where the repository is
//
// The logical repository root, from either `examples/mcp/mcp.ts` or its bundle
// `examples/dist/mcp/mcp.js`, independent of the launch directory.

const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot =
  basename(dirname(directory)) === "dist"
    ? resolve(directory, "../../..")
    : resolve(directory, "../..");

// ## 2. The MCP server
//
// One stdio server, launched through npx inside the collection's managed shell and shared by both
// agents: one client and process for the whole run. Every syscall of npx and graft is traced, so
// starting the server alone can take about half a minute: requests, `initialize` included, get
// five minutes instead of pi-mcp's 30-second default.
//
// Graft refreshes its index before a query only when the working tree drifted from the last
// build, so over a current index (`graft build` beforehand) its queries write nothing.

const requiredTools = [
  "mcp__graft__graft_repo_map",
  "mcp__graft__graft_file_api",
  "mcp__graft__graft_find_code",
  "mcp__graft__graft_trace_calls",
] as const;

/**
 * GitHub's supported-models table lists Claude Sonnet 5.5 for Copilot (checked 2026-10-04,
 * https://docs.github.com/en/copilot/reference/ai-models/supported-models); whether this login is
 * entitled to it is decided by `verifiedModels` against the live catalog.
 */
const LADDER = schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" });

/** Run both YAML agents against the same caller-owned Graft collection. */
async function runMcpExample(signal?: AbortSignal): Promise<void> {
  let researchText: string;
  let dependencyText: string;
  {
    // LIFO: close the graph (its agents), finish the TUI, close the collection (graft, then its ShellMux), then the recorder.
    await using lifetime = new AsyncDisposableStack();
    signal?.throwIfAborted();
    const models = await verifiedModels(LADDER.med, signal);
    signal?.throwIfAborted();
    const recorder = lifetime.adopt(await problemRecorder(repositoryRoot), (owned) => owned.close());
    const collection = lifetime.adopt(
      await new mcp.McpBuilder()
        .add({ name: "graft", type: "stdio", command: "npx", args: ["-y", "@nanonets/graft", "mcp"], clientOptions: { requestTimeoutMs: 300_000 } })
        .build(repositoryRoot, { policy: tools.LockPolicy, recorder, signal }),
      (owned) => owned.close(),
    );
    const observer = tracer.TuiTracer.shared();
    lifetime.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
    const execution = await JuncoGraph.fromYaml(source, {
      args: { cwd: repositoryRoot, code: { Reports }, policy: tools.LockPolicy, collection, recorder, tracer: observer, signal },
      parameters: { scheduler: () => schedules.parallel(), ladder: new schedules.ModelLadder(models, LADDER) },
    });
    lifetime.adopt(execution.graph, (g) => g.close());
    for (const id of ["Research", "Dependencies"]) {
      signal?.throwIfAborted();
      const member = execution.graph.getNode(graph.NodeId.create(id))!.state as agent.JuncoAgent;
      const names = new Set(member.getTools().map((tool) => tool.name));
      const missing = requiredTools.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new Error(
          `Graft MCP did not expose required tools: ${missing.join(", ")}. Run graft build in the repository root.`,
        );
      }
    }
    signal?.throwIfAborted();
    const results = await execution.run({ signal });
    signal?.throwIfAborted();
    researchText = syntax.finalText(results.get(graph.NodeId.create("Research")), "Research");
    dependencyText = syntax.finalText(results.get(execution.graph.sink.id), "Dependencies");
  }
  signal?.throwIfAborted();
  console.log(`Central classes:\n${researchText}`);
  console.log(`Dependency chains:\n${dependencyText}`);
}

if (import.meta.main) await runCli(runMcpExample);
