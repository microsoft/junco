import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { bytes, tokens } from "dataflow-engine";
import { Deterministic, JuncoGraph, schedules, syntax, tracer } from "junco";

type OptimizerLimits = {
  memoryBytes?: number;
  tokens?: number;
  tools?: number;
  scope?: "evaluation" | "batch" | "activation";
};

// junco-profile-optimizer:start scheduler
const optimizerScheduler = (label: string) => schedules.parallel();
// junco-profile-optimizer:end scheduler
// junco-profile-optimizer:start ladder
const optimizerLadder: schedules.Ladder | undefined = schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" });
const optimizerStrength = undefined;
// junco-profile-optimizer:end ladder
// junco-profile-optimizer:start limits
const optimizerLimits: OptimizerLimits = {};
// junco-profile-optimizer:end limits

/** The workflow's original hard ceiling, outermost around every candidate. */
const HARD_LIMITS: schedules.LimitOptions | undefined = { tools: 40 };

export const code: Record<string, syntax.DeterministicNode> = {
  Quality: ({ policy }) => ({
    state: new Deterministic(async function* () {
      const view = yield [];
      const report = view.values.get("Writer->Quality") as { content: Parameters<typeof contentText>[0] };
      return contentText(report.content).includes("## Highlights") ? 0.95 : 0.5;
    }, policy),
  }),
};

type ProfileRun = {
  version: 1;
  nonce: string;
  monitored: boolean;
  probes: { node: string; edgeId: string }[];
  expectedGraphHash: string | null;
  allowedModels: { model: string; thinking?: string }[];
  limitBounds: { memoryBytes?: number; tokens?: number; tools?: number };
};
const RUN_DIR = process.env.JUNCO_PROFILE_RUN_DIR;
const RUN_KEYS = "allowedModels,expectedGraphHash,limitBounds,monitored,nonce,probes,version";

async function profileRun(): Promise<ProfileRun | undefined> {
  if (RUN_DIR === undefined) return undefined;
  const run = JSON.parse(await readFile(join(RUN_DIR, "request.json"), "utf8"));
  if (
    Object.keys(run).sort().join() !== RUN_KEYS ||
    run.version !== 1 ||
    typeof run.nonce !== "string" ||
    typeof run.monitored !== "boolean" ||
    !Array.isArray(run.probes) ||
    !Array.isArray(run.allowedModels)
  )
    throw new Error("invalid profile run request");
  return run;
}

/** Deterministic JSON: object keys sorted recursively, array order kept. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;

/** `document` with probe: true on each requested existing numeric edge, revalidated. */
function withProbes(document: syntax.JuncoDocument, probes: ProfileRun["probes"]): syntax.JuncoDocument {
  const copy = structuredClone(document);
  for (const { node, edgeId } of probes) {
    let spec = copy.graph;
    for (const segment of node === "" ? [] : node.split("/")) {
      const wrapper = spec.nodes[segment];
      if (wrapper?.kind !== "graph") throw new Error(`probe path "${node}" names no graph node`);
      spec = wrapper.graph;
    }
    const edges = (spec.edges ?? []).filter(
      (edge) => (edge.id ?? `${edge.from}${edge.kind === "message" ? "~>" : "->"}${edge.to}`) === edgeId,
    );
    const type = edges.length === 1 ? (edges[0].schema as { type?: unknown }).type : undefined;
    if (type !== "number" && type !== "integer")
      throw new Error(`probe "${node}" / "${edgeId}" is not exactly one existing numeric edge`);
    edges[0].probe = true;
  }
  return syntax.parse(copy);
}

/** The candidate's concrete ladder and extra limits stay inside the run's authorized domain. */
function checkTuning(run: ProfileRun): void {
  for (const [name, rung] of Object.entries(optimizerLadder ?? {}))
    if (!run.allowedModels.some((allowed) => allowed.model === rung.model && allowed.thinking === rung.thinking))
      throw new Error(`ladder rung ${name} uses unauthorized ${rung.model}`);
  const bounds: Record<string, number | undefined> = { ...run.limitBounds };
  for (const [key, value] of Object.entries(optimizerLimits)) {
    if (key === "scope") {
      if (!["evaluation", "batch", "activation"].includes(String(value))) throw new Error(`invalid limit scope ${value}`);
      continue;
    }
    if (!["memoryBytes", "tokens", "tools"].includes(key)) throw new Error(`unknown limit ${key}`);
    const bound = bounds[key];
    if (
      typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (key === "tools" && !Number.isInteger(value)) || (bound !== undefined && value > bound)
    )
      throw new Error(`limit ${key}=${value} is outside its bound ${bound}`);
  }
}

/** The candidate policy: tuned scheduler, optional strength, extra limits, hard limits outermost. */
function tunedScheduler(label: string) {
  let policy = optimizerScheduler(label);
  if (optimizerStrength !== undefined) policy = schedules.strength(optimizerStrength, policy);
  const { memoryBytes, tokens: tokenCap, tools, scope } = optimizerLimits;
  if (memoryBytes !== undefined || tokenCap !== undefined || tools !== undefined)
    policy = schedules.limit(
      {
        ...(memoryBytes === undefined ? {} : { memory: bytes(memoryBytes) }),
        ...(tokenCap === undefined ? {} : { tokens: tokens(tokenCap) }),
        ...(tools === undefined ? {} : { tools }),
        ...(scope === undefined ? {} : { scope }),
      },
      policy,
    );
  return HARD_LIMITS === undefined ? policy : schedules.limit(HARD_LIMITS, policy);
}

const run = await profileRun();
const yamlText = await readFile(new URL("./report.yml", import.meta.url), "utf8");
const document = syntax.parse(yamlText, { sourceName: "report.yml" });
const graphHash = createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex");
if (run?.expectedGraphHash != null && run.expectedGraphHash !== graphHash)
  throw new Error("the runtime graph document drifted from the baseline's");
if (run !== undefined) checkTuning(run);
const recorder =
  run === undefined
    ? undefined
    : new tracer.JsonlRecorder({ path: join(RUN_DIR as string, "samples.jsonl"), monitored: run.monitored });
const observer = new tracer.DummyTracer();
const failures: unknown[] = [];
let execution: Awaited<ReturnType<typeof JuncoGraph.fromYaml>> | undefined;
try {
  execution = await JuncoGraph.fromYaml(run === undefined ? document : withProbes(document, run.probes), {
    cwd: import.meta.dir,
    scheduler: tunedScheduler,
    ladder: optimizerLadder,
    code,
    tracer: observer,
    ...(recorder === undefined ? {} : { recorder }),
  });
  await execution.run();
  const result = execution.graph.result(execution.graph.sink.id);
  if (result._tag !== "Some" || typeof result.value !== "number") throw new Error("no quality score");
  console.log(JSON.stringify({ quality: result.value }));
} catch (error) {
  failures.push(error);
}
for (const close of [() => execution?.graph.close(), () => observer.flush(), () => recorder?.close()])
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
if (failures.length > 0) throw new AggregateError(failures, "workflow run failed");
if (run !== undefined) {
  const receipt = join(RUN_DIR as string, "completion.json");
  await writeFile(`${receipt}.tmp`, JSON.stringify({ version: 1, nonce: run.nonce, terminal: true, graphHash, resourceEvents: 0 }), { flag: "wx" });
  await rename(`${receipt}.tmp`, receipt);
}
