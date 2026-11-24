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
let answer: string;
{
  await using lifetime = new AsyncDisposableStack();
  const observer = tracer.TuiTracer.shared();
  lifetime.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
  const browsers = new Map<graph.NodeIdType, tools.ToolCollection>();
  for (const node of ["Bun", "Rust"]) {
    const collection = await new mcp.McpBuilder().add(playwright).build(process.cwd());
    browsers.set(graph.NodeId.create(node), lifetime.adopt(collection, (c) => c.close()));
  }
  const execution = await JuncoGraph.fromYaml(source, {
    args: { cwd: process.cwd(), tools: browsers, tracer: observer },
    parameters: { scheduler: () => schedules.parallel(), ladder },
  });
  lifetime.defer(() => execution.graph.close());
  const results = await execution.run();
  answer = syntax.finalText(results.get(graph.NodeId.create("Reviewer")), "Reviewer");
}
console.log(answer);
