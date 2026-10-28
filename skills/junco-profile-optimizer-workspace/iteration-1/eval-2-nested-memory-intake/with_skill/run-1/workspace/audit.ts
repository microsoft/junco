import { readFile } from "node:fs/promises";
import { contentText } from "@earendil-works/pi-ai";
import { Deterministic, graph, JuncoGraph, schedules, syntax, tracer } from "junco";

const ladder = schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" });
export const code: Record<string, syntax.DeterministicNode> = {
  Collect: ({ edges, policy }) => {
    let emitted = false;
    return {
      state: new Deterministic(async function* () {
        emitted = true;
        yield [];
        return import.meta.dir;
      }, policy),
      is_available: () => !emitted,
    };
  },
  Score: ({ policy }) => ({
    state: new Deterministic(async function* () {
      const view = yield [];
      const report = view.values.get("Check->Score") as { content: Parameters<typeof contentText>[0] };
      const text = contentText(report.content);
      return text.includes("FAIL") ? 0.4 : 0.9;
    }, policy),
  }),
  Publish: ({ policy }) => ({
    state: new Deterministic(async function* () {
      const view = yield [];
      const score = view.values.get("Review->Publish");
      if (typeof score !== "number") throw new Error("missing review score");
      return score;
    }, policy),
  }),
};
const observer = new tracer.DummyTracer();
const execution = await JuncoGraph.fromYaml(await readFile(new URL("./audit.yml", import.meta.url), "utf8"), {
  cwd: import.meta.dir,
  scheduler: () => schedules.parallel(),
  ladder,
  code,
  tracer: observer,
});
try {
  await execution.run();
  const result = execution.graph.result(execution.graph.sink.id);
  if (result._tag !== "Some" || typeof result.value !== "number") throw new Error("no audit score");
  console.log(JSON.stringify({ score: result.value }));
} finally {
  try {
    await execution.graph.close();
  } finally {
    await observer.flush();
  }
}
