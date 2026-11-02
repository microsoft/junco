/** Frontier single-agent SWE-bench baseline; the runner supplies guarded models and container operations. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, TSchema } from "@earendil-works/pi-ai";
import { graph, JuncoGraph, schedules, syntax } from "junco";
import source from "./solo.yml" with { type: "text" };

export type Problem = { instance_id: string; repo: string; base_commit: string; problem_statement: string };
export type Branch = "A" | "B";
export const ROLES = [
  "canonical",
  "trace",
  "reproduce",
  "contracts",
  "candidateA",
  "candidateB",
  "acceptA",
  "acceptB",
  "acceptFinal",
] as const;
export type Role = (typeof ROLES)[number];
export type Exec = { readonly exit_code: number; readonly output: string };
export type Host = {
  readonly problem: Problem;
  readonly sandbox: {
    run(role: Role, command: string, timeout: number): Promise<Exec>;
    capture(role: Role): Promise<string>;
    apply(role: Role, patch: string): Promise<Exec>;
    reset(role: Role): Promise<void>;
  };
  save(name: string, data: string): string;
  cancel(branch: Branch): Promise<readonly string[]>;
};

export const SANDBOX: Readonly<Record<string, Role>> = { Solo: "candidateA" };
export const BRANCHES = { A: { agent: "Solo", sandboxes: ["candidateA", "acceptA"] } } as const;
// User-selected baseline; the runner checks live availability and supported thinking before acquiring Solo.
export const ladder = schedules.uniformLadder({ model: "github-copilot/claude-opus-5.5", thinking: "high" });
export const strengthOf = (_path: string): schedules.ModelStrengthName => "med";
export const scheduler: syntax.BuildOptions["scheduler"] = () => schedules.strength(() => "med", schedules.parallel());

type Code = syntax.DeterministicNode<Host>;
const prompt = (text: string) => ({ kind: "prompt", text }) as const;
const tail = (text: string, size = 4000): string => (text.length <= size ? text : `…${text.slice(-size)}`);
const issueText = ({ repo, base_commit, problem_statement }: Problem): string =>
  `Repository: ${repo} (base commit ${base_commit})\n\n${problem_statement}`;

/** A code node's terminal report in the assistant-message form the sink and finalText accept. */
function reply(text: string): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "junco-code",
    provider: "junco",
    model: "Finish",
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Publishes the issue once without the instance ID, which could invite recall of published fixes. */
export const Input: Code = ({ context, edges, policy }) => {
  const output = edges.get("Input~>Solo");
  if (output === undefined) throw new Error("solo.yml declares no edge Input~>Solo");
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* (signal) {
      while (true) {
        signal.throwIfAborted();
        published = true;
        yield [graph.Message.create(output, prompt(issueText(context.problem)))];
      }
    }, policy),
    is_available: () => !published,
  };
};

/** A useful sandbox change survives an abnormal agent stop; only the official evaluator judges resolution. */
export const Deliver: Code = ({ context, policy }) => ({
  state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const inputs = yield [];
    const report = inputs.values.get(graph.EdgeId.create("Solo->Deliver")) as AssistantMessage | undefined;
    const patch = await context.sandbox.capture("candidateA");
    if (!patch.trim()) throw new Error("Solo left no change in /testbed");
    const applied = await context.sandbox.apply("canonical", patch);
    if (applied.exit_code !== 0) throw new Error(`Solo patch does not apply to canonical: ${tail(applied.output)}`);
    const path = context.save("solo.patch", patch);
    const text = report?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    context.save("solo.md", text || `Solo stopped: ${report?.stopReason ?? "missing result"}`);
    const files = [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
    return reply(`Solo patch delivered: ${files.length} file${files.length === 1 ? "" : "s"} (${files.join(", ")}); ${path}\nLimitation: only the official evaluation decides resolution.`);
  }, policy),
});

/** sha256 of the parsed document with object keys sorted recursively: a topology's identity. */
function hashDocument(document: syntax.JuncoDocument): string {
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
  return createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex");
}

export type GraphRun = { dir: string; nonce: string; expectedGraphHash: string };

/** The measurement request of `JUNCO_GRAPH_RUN_DIR`; undefined outside measurement. */
export async function readGraphRun(): Promise<GraphRun | undefined> {
  const dir = process.env.JUNCO_GRAPH_RUN_DIR;
  if (dir === undefined) return undefined;
  const request = JSON.parse(await readFile(join(dir, "request.json"), "utf8"));
  if (
    Object.keys(request).sort().join() !== "expectedGraphHash,nonce,version" ||
    request.version !== 1 ||
    typeof request.nonce !== "string" ||
    typeof request.expectedGraphHash !== "string"
  )
    throw new Error("invalid graph run request");
  return { dir, nonce: request.nonce, expectedGraphHash: request.expectedGraphHash };
}

export const document = syntax.parse(source);
export const code = { Input, Deliver };
const graphRun = await readGraphRun();
export const graphHash = hashDocument(document);
if (graphRun !== undefined && graphRun.expectedGraphHash !== graphHash)
  throw new Error("the candidate graph differs from its run request");
export const profileRun = graphRun === undefined ? undefined : { nonce: graphRun.nonce };

function unfinished(g: JuncoGraph<TSchema, unknown>): string {
  const pending: string[] = [];
  g.forEachNode((id, node) => {
    if (node.status !== "done") pending.push(`${id} (${node.status})`);
  });
  return pending.join(", ") || "none";
}

export type RunOptions = Omit<syntax.FromYamlOptions<Host>, "ladder" | "scheduler" | "code" | "context"> & { readonly context: Host };

/** Builds and runs the baseline, returning Deliver's terminal report after closing graph resources. */
export async function run(config: RunOptions): Promise<string> {
  const execution = await JuncoGraph.fromYaml<Host>(document, { ...config, ladder, scheduler, code });
  try {
    await execution.run({ signal: config.signal });
    const terminal = execution.graph.result(execution.graph.sink.id);
    if (terminal._tag !== "Some") throw new Error(`workflow stopped without a terminal report; unfinished: ${unfinished(execution.graph)}`);
    return syntax.finalText(terminal.value, "Deliver");
  } finally {
    await execution.graph.close();
  }
}
