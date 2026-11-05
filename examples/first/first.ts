// My first Junco workflow (README): two Playwright-browsing agents in parallel, one reviewer. Run from inside a seed
// after `pi` → `/login` → GitHub Copilot:
//
//   bun run /path/to/junco/examples/first/first.ts

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, JuncoGraph, schedules, syntax, tracer } from "junco";
import source from "./first.yml" with { type: "text" };

const models = await ModelRuntime.create();
const observer = tracer.TuiTracer.shared();
const execution = await JuncoGraph.fromYaml(source, {
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  ladder: new schedules.ModelLadder(models, schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" })),
  tracer: observer,
});
let answer: string;
try {
  const results = await execution.run();
  answer = syntax.finalText(results.get(graph.NodeId.create("Reviewer")), "Reviewer");
} finally {
  await execution.graph.close();
  if (observer instanceof tracer.TuiTracer) await observer.finish();
}
console.log(answer);
