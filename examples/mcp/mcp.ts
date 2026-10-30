// # MCP: two agents read this repository through graft
//
// Two live-LLM agents analyze the repository through graft MCP, alongside Junco's builtin tools.
// mcp.yml declares their prompts, graph, and shared server definition; this module supplies Reports
// and LADDER. Each agent owns its graft client and server through the graph's tool collection.
// Research maps the repository with `mcp__graft__graft_repo_map` and selects exactly five
//    central, repository-owned classes, confirming each declaration.
// 3. Dependencies runs once Research's report exists, as a value edge. Its staged prompt callback
//    validates that report and embeds it in the dependency assignment; Dependencies then traces
//    every one of those five classes itself with outbound all-depth
//    `mcp__graft__graft_trace_calls`.
// 4. The runner closes the graph (and with it both agents, their graft servers and, last, the
//    collection's ShellMux), then flushes the tracer.
//
// Prerequisites: junco-tools' Rust toolchain and system libraries (packages/junco-tools/README.md),
// so that `bun install --frozen-lockfile` at the root also builds the production native addon
// (Cargo fetches marsh and junco-policy from GitHub); this checkout inside a Btrfs seed subvolume;
// and a current graft index (`graft build`). Then run it after `pi` → `/login` → GitHub Copilot:
//
//   bun run examples/mcp/mcp.ts

import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agent, graph, JuncoGraph, schedules, syntax, tools } from "junco";
import type { TSchema } from "typebox";
import { problemRecorder, runCli, verifiedModels } from "../support.ts";
import source from "./mcp.yml" with { type: "text" };

/** Validate both reports before publishing the dependency report as the graph result. */
export const Reports: syntax.DeterministicNode = ({ policy }) => {
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const inputs = yield [];
      syntax.finalText(inputs.values.get(graph.EdgeId.create("Research->Reports")), "Research");
      const result = inputs.values.get(graph.EdgeId.create("Dependencies->Reports"));
      syntax.finalText(result, "Dependencies");
      return result;
    }, policy),
  };
};


// ## 1. Where the repository is
//
// The logical repository root, from either `examples/mcp/mcp.ts` or its bundle
// `examples/dist/mcp/mcp.js`, independent of the launch directory.

const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot =
  basename(dirname(directory)) === "dist"
    ? resolve(directory, "../../..")
    : resolve(directory, "../..");

// ## 2. The MCP definition
//
// One stdio server, launched through npx inside the managed shell. Both agents reuse this
// definition; each gets its own client and process. Every syscall of npx and graft is traced,
// so starting the server alone can take about half a minute: requests, `initialize` included,
// get five minutes instead of pi-mcp's 30-second default.
//
// Graft refreshes its index before a query only when the working tree drifted from the last
// build, so over a current index (`graft build` beforehand) its queries write nothing. Over a stale
// one, both servers would rewrite the shared index under `graft/`; the rewrites overlap, and Marsh
// refuses the later one when its server ends.

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

/** The complete application: runs the graph once; closing it also closes its ShellMux. */
async function runMcpExample(signal?: AbortSignal): Promise<void> {
  let researchText: string;
  let dependencyText: string;
  {
    // LIFO: close the graph (its agents, their graft servers and the collection), flush the tracer, then close the recorder.
    await using lifetime = new AsyncDisposableStack();
    signal?.throwIfAborted();
    const models = await verifiedModels(LADDER.med, signal);
    signal?.throwIfAborted();
    const recorder = lifetime.adopt(await problemRecorder(repositoryRoot), (owned) => owned.close());
    const execution = await JuncoGraph.fromYaml(source, {
      cwd: repositoryRoot,
      models,
      ladder: LADDER,
      code: { Reports },
      scheduler: () => schedules.parallel(),
      policy: tools.LockPolicy,
      recorder,
      signal,
    });
    lifetime.defer(() => execution.graph.tracer.flush());
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
