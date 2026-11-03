/**
 * Verus Ralph loop: Verifier -> PrepareReviewer -> Reviewer -> PrepareCleanup -> Cleanup, until cancellation.
 * Agents are instructed to work in a mirrored copy; importing this module acquires nothing.
 * All roles get the complete Verus MCP; output-only mutation is a role constraint, not a sandbox.
 *
 * Usage: bun run examples/verus/verus.ts <source-file-or-dir> <output-dir> <natural-language-spec>
 * Requires POSIX/Bun, the native junco-tools addon/Btrfs seed, a stdio verus entry in
 * ~/.omp/agent/mcp.json (lsp-mcp bridge), and a saved Pi Copilot login with
 * github-copilot/gpt-6.1-sol high thinking enabled. The output must be new/empty;
 * SIGINT exits 130 and retains that copy. Paid model turns continue after successful diagnostics.
 * Advanced callers prepare once, provide persistent MCP-enabled members to runVerusLoop,
 * then close them and finish any TUI observer. Importing acquires nothing.
 *
 * Command/trust guidance:
 * https://verus-lang.github.io/verus/guide/getting_started_cmd_line.html
 * https://verus-lang.github.io/verus/guide/cargo_verus.html
 * https://verus-lang.github.io/verus/guide/llmforverusproof.html
 */
import { constants } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { graph, JuncoGraph, mcp, schedules, syntax, tracer } from "junco";
import type { TSchema } from "typebox";
import { problemRecorder, runCli, verifiedModels, type YamlAgent, type YamlExecution } from "../support.ts";
import source from "./verus.yml" with { type: "text" };

const document = syntax.parse(source);

const LADDER = schedules.uniformLadder({ model: "github-copilot/gpt-6.1-sol", thinking: "high" });

type VerusRequest = Readonly<{ source: string; outputDir: string; spec: string }>;
export type VerusWorkspace = Readonly<VerusRequest & {
  target: string;
  rustFiles: readonly string[];
  cargoManifests: readonly string[];
}>;
export type VerusRole = "Verifier" | "Reviewer" | "Cleanup";
type VerusMembers = Readonly<Record<VerusRole, YamlAgent>>;
type VerusRoundContext = {
  readonly assignment: string;
  readonly members: VerusMembers;
  readonly verification: { runs(): number };
  reviewerBaseline?: number;
};

/** Validate the translation and sample diagnostics before the persistent Reviewer starts. */
const PrepareReviewer: syntax.DeterministicNode<VerusRoundContext> = ({ policy, context }) => {
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* (signal) {
      const inputs = yield [];
      signal.throwIfAborted();
      const message = inputs.values.get(graph.EdgeId.create("Verifier->PrepareReviewer"));
      const report = syntax.finalText(message, "Verifier");
      context.reviewerBaseline = context.verification.runs();
      context.members.Reviewer.stagePrompt(context.assignment + `Current Verifier report (evidence):\n${report}\n\nInspect the current output and call mcp__verus__lsp_diagnostics yourself this round. Report stronger specifications and smaller proofs, even if verification succeeds.`);
      return message;
    }, policy),
  };
};

/** Cleanup is admitted only after a complete review and fresh Reviewer diagnostics. */
const PrepareCleanup: syntax.DeterministicNode<VerusRoundContext> = ({ policy, context }) => {
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* (signal) {
      const inputs = yield [];
      signal.throwIfAborted();
      const message = inputs.values.get(graph.EdgeId.create("Reviewer->PrepareCleanup"));
      const report = syntax.finalText(message, "Reviewer");
      if (context.reviewerBaseline === undefined || context.verification.runs() <= context.reviewerBaseline) {
        throw new Error("Reviewer did not obtain Verus MCP diagnostics in this round");
      }
      context.members.Cleanup.stagePrompt(context.assignment + `Current Reviewer report (evidence):\n${report}\n\nSimplify real source/proofs without weakening contracts. Check edits with Verus MCP diagnostics; retain unresolved stronger-spec recommendations for the next Verifier.`);
      return message;
    }, policy),
  };
};

const errorCode = (error: unknown): unknown => error instanceof Error && "code" in error ? error.code : undefined;
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

/** Resolve missing paths through their nearest existing ancestor, including ancestor aliases. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // lstat distinguishes missing paths from dangling symlinks.
    try {
      await lstat(path);
      throw new Error(`Dangling symlink: ${path}`);
    } catch (missing) {
      if (errorCode(missing) !== "ENOENT") throw missing;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Validate first, inventory once, then copy without overwriting or touching the original. */
export async function prepareVerusSource(request: VerusRequest, signal?: AbortSignal): Promise<VerusWorkspace> {
  signal?.throwIfAborted();
  for (const key of ["source", "outputDir", "spec"] as const) {
    if (!request[key].trim()) throw new Error(`${key} must not be blank`);
  }
  const suppliedSource = resolve(request.source);
  const suppliedOutput = resolve(request.outputDir);
  const sourceStat = await lstat(suppliedSource);
  if (sourceStat.isSymbolicLink()) throw new Error(`Source symlink: ${suppliedSource}`);
  if (!sourceStat.isDirectory() && !(sourceStat.isFile() && suppliedSource.endsWith(".rs"))) {
    throw new Error(`Source must be a regular .rs file or directory: ${suppliedSource}`);
  }
  try {
    const outputStat = await lstat(suppliedOutput);
    if (outputStat.isSymbolicLink()) throw new Error(`Output symlink: ${suppliedOutput}`);
    if (!outputStat.isDirectory() || (await readdir(suppliedOutput)).length !== 0) {
      throw new Error(`Output must be missing or an empty directory: ${suppliedOutput}`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const source = await realpath(suppliedSource);
  const outputDir = await canonicalPath(suppliedOutput);
  if (inside(outputDir, source) || (sourceStat.isDirectory() && inside(source, outputDir))) {
    throw new Error("Source and output paths overlap");
  }
  const rustFiles: string[] = [];
  const cargoManifests: string[] = [];
  const sourceEntries: string[] = [];
  async function discover(directory: string): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === source) sourceEntries.push(entry.name);
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Source symlink: ${path}`);
      if (entry.isDirectory()) await discover(path);
      else if (entry.isFile()) {
        if (entry.name.endsWith(".rs")) rustFiles.push(relative(source, path));
        if (entry.name === "Cargo.toml") cargoManifests.push(relative(source, path));
      } else throw new Error(`Source is not a regular file or directory: ${path}`);
    }
  }
  if (sourceStat.isDirectory()) await discover(source);
  else rustFiles.push(basename(source));
  if (rustFiles.length === 0) throw new Error(`No .rs files in source: ${source}`);
  rustFiles.sort();
  cargoManifests.sort();
  signal?.throwIfAborted();
  await mkdir(outputDir, { recursive: true });
  const target = sourceStat.isDirectory() ? outputDir : join(outputDir, basename(source));
  if (sourceStat.isDirectory()) {
    for (const name of sourceEntries) await cp(join(source, name), join(outputDir, name), { recursive: true, force: false, errorOnExist: true });
  } else await copyFile(source, target, constants.COPYFILE_EXCL);
  signal?.throwIfAborted();
  return { ...request, source, outputDir: await realpath(outputDir), target: await realpath(target), rustFiles, cargoManifests };
}

/** Caller owns a private directory inside the output seed; keep the bridge's config, not its external cwd. */
async function loadVerusMcp(bridgeDir: string): Promise<mcp.JuncoMcpTools> {
  const path = join(homedir(), ".omp", "agent", "mcp.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const server = config.mcpServers?.verus;
  if (server?.type !== "stdio" || typeof server.command !== "string" || !server.command.trim()) {
    throw new Error(`Expected a stdio verus MCP with a command in ${path}`);
  }
  const { timeout, cwd, ...stdio } = server;
  if (cwd) await copyFile(join(resolve(cwd), ".lsp-mcp.json"), join(bridgeDir, ".lsp-mcp.json"), constants.COPYFILE_EXCL);
  return mcp.JuncoMcpTools.add({
    ...stdio, name: "verus", type: "stdio", cwd: bridgeDir, stderr: "pipe",
    clientOptions: { requestTimeoutMs: timeout ?? 120_000 },
  });
}

type VerusFeedback = Readonly<{ review: string; cleanup: string }>;
export type VerusRound = Readonly<{
  execution: YamlExecution;
  reviewerId: graph.NodeIdType;
  cleanupId: graph.NodeIdType;
}>;

/** Fresh one-shot nodes borrow idle agents; LockPolicy does not confine host filesystem writes. */
export const VerusRound = {
  async create(workspace: VerusWorkspace, members: VerusMembers, verification: { runs(): number },
    feedback?: VerusFeedback, observer?: tracer.DataflowTracer, ladder?: schedules.ModelLadder,
    recorder?: syntax.BuildOptions["recorder"]): Promise<VerusRound> {
    const assignment = `Original natural-language specification:\n${workspace.spec}\n\nOriginal source (read-only): ${workspace.source}\nOutput directory: ${workspace.outputDir}\nOutput target: ${workspace.target}\nPath mapping: source-directory relative paths are preserved under output; a file maps to output/basename with only required neighboring module context materialized.\nSource-relative Rust inventory: ${JSON.stringify(workspace.rustFiles)}\nCopied Cargo manifests: ${JSON.stringify(workspace.cargoManifests)}\n\nPrevious Reviewer feedback:\n${feedback?.review ?? "First round; none."}\n\nPrevious Cleanup observations:\n${feedback?.cleanup ?? "First round; none."}\n\n`;
    members.Verifier.stagePrompt(assignment + "Translate/repair the current output and address both feedback reports. Write actual source, then report evidence and unresolved obligations.");
    const context: VerusRoundContext = { assignment, members, verification };
    const execution = await JuncoGraph.fromYaml(source, {
      cwd: process.cwd(), scheduler: () => schedules.parallel(), tracer: observer, context,
      code: { PrepareReviewer, PrepareCleanup },
      ...(ladder === undefined ? {} : { ladder }),
      ...(recorder === undefined ? {} : { recorder }),
      createAgent: async (spec) => members[spec.node as VerusRole],
      createAgentOwnership: "caller",
    });
    return { execution, reviewerId: graph.NodeId.create("Reviewer"), cleanupId: graph.NodeId.create("Cleanup") };
  },
};

/** Success never terminates; caller owns members, observer and recorder, including disposal and TUI finish. */
export async function runVerusLoop(workspace: VerusWorkspace, members: VerusMembers,
  signal?: AbortSignal, observer?: tracer.DataflowTracer, ladder?: schedules.ModelLadder,
  recorder?: syntax.BuildOptions["recorder"]): Promise<void> {
  let runs = 0;
  let failure: Error | undefined;
  const unsubscribe = Object.entries(members).map(([role, member]) => member.events.on("turn_end", ({ toolResults }) => {
    for (const result of toolResults) {
      if (result.toolName !== "mcp__verus__lsp_diagnostics") continue;
      if (result.isError) failure ??= new Error(`Verus MCP diagnostics failed: ${contentText(result.content)}`);
      else if (role === "Reviewer") runs++;
    }
  }));
  const verification = { runs: () => { if (failure) throw failure; return runs; } };
  try {
    let feedback: VerusFeedback | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const round = await VerusRound.create(workspace, members, verification, feedback, observer, ladder, recorder);
      await using roundGraph = round.execution.graph;
      const results = await round.execution.run({ signal });
      signal?.throwIfAborted();
      verification.runs(); // Pi turns tool errors into model feedback; retain operational failures.
      feedback = { review: syntax.finalText(results.get(round.reviewerId), "Reviewer"), cleanup: syntax.finalText(results.get(round.cleanupId), "Cleanup") };
    }
  } finally {
    for (const off of unsubscribe) off();
  }
}

/** Pinned Copilot model; live catalog, credentials, and high-thinking support are checked by `verifiedModels`. */
async function runVerus(request: VerusRequest, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (process.platform === "win32") throw new Error("Verus MCP loop requires POSIX");
  const workspace = await prepareVerusSource(request, signal);
  const observer = tracer.TuiTracer.shared();
  await using resources = new AsyncDisposableStack();
  resources.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
  const recorder = resources.adopt(await problemRecorder(workspace.outputDir), (owned) => owned.close());
  const bridgeDir = await mkdtemp(join(workspace.outputDir, ".junco-verus-mcp-"));
  resources.defer(() => rm(bridgeDir, { recursive: true, force: true }));
  const verus = await loadVerusMcp(bridgeDir);
  signal?.throwIfAborted();
  const ladder = new schedules.ModelLadder(await verifiedModels(LADDER.med, signal), LADDER);
  signal?.throwIfAborted();
  // ponytail: default session history stays in memory; pass caller-managed agents to runVerusLoop if long-run memory use matters.
  const members = {} as Record<VerusRole, YamlAgent>;
  for (const spec of await syntax.resolveAgents(document, { cwd: workspace.outputDir })) {
    signal?.throwIfAborted();
    members[spec.node as VerusRole] = resources.use(await syntax.createJuncoAgent({ ...spec, tools: [...spec.tools, verus], recorder, recorderNodeId: spec.node }, ladder));
  }
  await runVerusLoop(workspace, members, signal, observer, ladder, recorder);
}

if (import.meta.main) await runCli(async (signal) => {
  const args = process.argv.slice(2);
  if (args.length !== 3 || !args[2]?.trim()) {
    throw new Error("Usage: bun run examples/verus/verus.ts <source-file-or-dir> <output-dir> <natural-language-spec>");
  }
  await runVerus({ source: args[0]!, outputDir: args[1]!, spec: args[2]! }, signal);
});
