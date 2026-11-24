// Goals assigns each browser agent the question once. Reviewer runs when it can consume both reports.
// Run from inside a seed after `pi` → `/login` → GitHub Copilot:
//
//   bun run /path/to/junco/examples/first/first.ts

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, JuncoGraph, mcp, schedules, syntax, type tools, tracer } from "junco";
import source from "./first.yml" with { type: "text" };

const models = await ModelRuntime.create();
const ladder = new schedules.ModelLadder(models, schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" }));
const playwright = { name: "playwright", type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] } as const;
/** One Playwright server, and so one browser, per browsing agent: its own collection. */
const browsers = new Map<string, tools.ToolCollection>();
const observer = tracer.TuiTracer.shared();
let answer: string;
try {
  for (const node of ["Bun", "Rust"]) browsers.set(node, await new mcp.McpBuilder().add(playwright).build(process.cwd()));
  const execution = await JuncoGraph.fromYaml(source, {
    cwd: process.cwd(),
    scheduler: () => schedules.parallel(),
    ladder,
    createAgent: (spec) => syntax.createJuncoAgent({ ...spec, collection: browsers.get(spec.node) }, ladder),
    tracer: observer,
  });
  try {
    const results = await execution.run();
    answer = syntax.finalText(results.get(graph.NodeId.create("Reviewer")), "Reviewer");
  } finally {
    await execution.graph.close();
  }
} finally {
  for (const collection of browsers.values()) await collection.close();
  if (observer instanceof tracer.TuiTracer) await observer.finish();
}
console.log(answer);
