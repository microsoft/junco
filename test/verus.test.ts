import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Context,
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type DataflowGraph,
  DataflowNodeError,
  type DataflowRunTrace,
} from "dataflow-engine";
import { tracer } from "../src/index.ts";
import {
  prepareVerusSource,
  runVerusLoop,
  type VerusRole,
  type VerusWorkspace,
} from "../examples/verus.ts";
import { Type } from "typebox";
import { leaf, waitingTool } from "./support.ts";

const TIMEOUT_MS = 10_000;
const workspace: VerusWorkspace = {
  source: "/original/max.rs",
  outputDir: "/output",
  target: "/output/max.rs",
  spec: "max_u32 returns an argument greater than or equal to both inputs, without preconditions.",
  rustFiles: ["max.rs"],
  cargoManifests: [],
};

const verifyCall = (id: string) =>
  fauxAssistantMessage([fauxToolCall("mcp__verus__lsp_diagnostics", { file_path: workspace.target }, { id })], {
    stopReason: "toolUse",
  });

const userText = (context: Context): string => context.messages
  .filter((message) => message.role === "user")
  .map((message) => typeof message.content === "string" ? message.content : contentText(message.content))
  .join("\n");

function rootCause(error: unknown): unknown {
  while (error instanceof DataflowNodeError) error = error.cause;
  return error;
}

/** Script compiler/prover feedback without treating proof failures as MCP transport failures. */
function scriptedVerification(exitCodes: readonly number[]) {
  const observed: number[] = [];
  const tool: AgentTool = {
    name: "mcp__verus__lsp_diagnostics",
    label: "Verus diagnostics",
    description: "Read the scripted Verus diagnostics for the output",
    parameters: Type.Object({ file_path: Type.String() }, { additionalProperties: false }),
    execute: async () => {
      const exitCode = exitCodes[observed.length];
      assert.notEqual(exitCode, undefined, "unexpected verification invocation");
      const results = [{
        command: "verus",
        args: ["--crate-type", "lib", workspace.target, "--expand-errors"],
        cwd: workspace.outputDir,
        exitCode,
        stdout: exitCode === 0 ? "1 verified, 0 errors" : "0 verified, 1 error",
        stderr: exitCode === 0 ? "" : "max.rs: postcondition not satisfied",
      }];
      observed.push(exitCode!);
      return { content: [{ type: "text", text: JSON.stringify(results) }], details: results };
    },
  };
  return { tool, observed };
}

/** Observe actual settled graph nodes, not model statements that a role completed. */
class RoleTracer extends tracer.DummyTracer {
  readonly completed: string[] = [];

  constructor(private readonly onComplete: (role: string) => void = () => {}) {
    super();
  }

  override startRun<S, N, T, EH>(
    _graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    return {
      startNode: (id) => ({
        end: (step) => {
          if (!step.done) return;
          const role = String(id);
          this.completed.push(role);
          this.onComplete(role);
        },
        fail: () => {},
      }),
      end: () => {},
      fail: () => {},
    };
  }
}

describe("Verus loop", () => {
  test("success and nonzero feedback both continue through two ordered rounds until caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("two cleanup completions observed");
    const verification = scriptedVerification([0, 1]);
    const activated: VerusRole[] = [];
    const verifierPrompts: string[] = [];
    const cleanupPrompts: string[] = [];
    const reviewerResults: string[] = [];
    const observer = new RoleTracer((role) => {
      if (role === "Cleanup" && observer.completed.filter((value) => value === "Cleanup").length === 2) {
        controller.abort(reason);
      }
    });
    await using verifier = (await leaf([0, 1, 2].map((round) => (context: Context) => {
      activated.push("Verifier");
      verifierPrompts.push(userText(context));
      return fauxAssistantMessage(`max.rs: translated round ${round + 1}`);
    }))).agent;
    await using reviewer = (await leaf([0, 1].flatMap((round) => [
      () => {
        activated.push("Reviewer");
        return verifyCall(`review-${round}`);
      },
      (context: Context) => {
        const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
        assert.ok(result && result.role === "toolResult");
        reviewerResults.push(contentText(result.content));
        return fauxAssistantMessage(round === 0
          ? "max.rs: verification passed; review approved, strengthen membership specification."
          : "max.rs: nonzero proof failure: postcondition not satisfied; retain the strict contract.");
      },
    ]), { tools: [verification.tool] })).agent;
    await using cleanup = (await leaf([0, 1].map((round) => (context: Context) => {
      activated.push("Cleanup");
      cleanupPrompts.push(userText(context));
      return fauxAssistantMessage(`max.rs: cleanup round ${round + 1}; preserve both lower-bound obligations.`);
    }))).agent;
    try {
      await assert.rejects(
        runVerusLoop(workspace, { Verifier: verifier, Reviewer: reviewer, Cleanup: cleanup }, controller.signal, observer),
        (error: unknown) => rootCause(error) === reason,
      );
      const expected = ["Verifier", "Reviewer", "Cleanup", "Verifier", "Reviewer", "Cleanup"];
      assert.deepEqual(observer.completed, expected);
      assert.deepEqual(activated, expected);
      assert.deepEqual(verification.observed, [0, 1]);
      assert.match(reviewerResults[0]!, /1 verified, 0 errors/);
      assert.match(reviewerResults[1]!, /postcondition not satisfied/);
      assert.match(cleanupPrompts[1]!, /nonzero proof failure/);
      assert.match(verifierPrompts[1]!, /strengthen membership specification/);
      assert.match(verifierPrompts[1]!, /cleanup round 1; preserve both lower-bound obligations/);
      for (const member of [verifier, reviewer, cleanup]) assert.notEqual(member.status, "closed");
    } finally {
      await observer.flush();
    }
  }, TIMEOUT_MS);

  test("a Verifier invocation cannot satisfy a Reviewer that never calls MCP diagnostics", async () => {
    const verification = scriptedVerification([0]);
    let reviewerActivations = 0;
    let cleanupActivations = 0;
    const observer = new RoleTracer();
    await using verifier = (await leaf([
      verifyCall("writer-check"),
      fauxAssistantMessage("max.rs: writer verified the translation."),
    ], { tools: [verification.tool] })).agent;
    await using reviewer = (await leaf([() => {
      reviewerActivations++;
      return fauxAssistantMessage("max.rs: looks verified; no independent tool invocation.");
    }], { tools: [verification.tool] })).agent;
    await using cleanup = (await leaf([() => {
      cleanupActivations++;
      return fauxAssistantMessage("must not activate");
    }])).agent;
    try {
      await assert.rejects(
        runVerusLoop(workspace, { Verifier: verifier, Reviewer: reviewer, Cleanup: cleanup }, undefined, observer),
        (error: unknown) => rootCause(error) instanceof Error && (rootCause(error) as Error).message === "Reviewer did not obtain Verus MCP diagnostics in this round",
      );
      assert.deepEqual(verification.observed, [0]);
      assert.equal(reviewerActivations, 1);
      assert.equal(cleanupActivations, 0);
      assert.deepEqual(observer.completed, ["Verifier", "Reviewer"]);
    } finally {
      await observer.flush();
    }
  }, TIMEOUT_MS);

  test("source preparation mirrors the input without overwriting originals or existing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "junco-verus-copy-"));
    try {
      const source = join(root, "input");
      const original = "pub fn identity(value: u32) -> u32 { value }\n";
      await mkdir(source);
      await writeFile(join(source, "lib.rs"), original);
      const outputDir = join(root, "output");
      const copy = await prepareVerusSource({ source, outputDir, spec: workspace.spec });
      assert.equal(await readFile(join(copy.outputDir, "lib.rs"), "utf8"), original);
      await writeFile(join(copy.outputDir, "lib.rs"), "changed copy");
      assert.equal(await readFile(join(source, "lib.rs"), "utf8"), original);
      await assert.rejects(prepareVerusSource({ source, outputDir, spec: workspace.spec }), /empty directory/);
      assert.equal(await readFile(join(copy.outputDir, "lib.rs"), "utf8"), "changed copy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("an MCP failure cannot be reported as a successful independent review", async () => {
    const verification = scriptedVerification([0]);
    const tool = { ...verification.tool, execute: async () => { throw new Error("bridge disconnected"); } };
    await using verifier = (await leaf([fauxAssistantMessage("max.rs: translation ready.")])).agent;
    await using reviewer = (await leaf([
      verifyCall("failed-diagnostics"),
      fauxAssistantMessage("max.rs: review completed despite the failed bridge."),
    ], { tools: [tool] })).agent;
    await using cleanup = (await leaf([fauxAssistantMessage("must not activate")])).agent;
    await assert.rejects(
      runVerusLoop(workspace, { Verifier: verifier, Reviewer: reviewer, Cleanup: cleanup }, undefined, new RoleTracer()),
      (error: unknown) => rootCause(error) instanceof Error && /bridge disconnected/.test((rootCause(error) as Error).message),
    );
  }, TIMEOUT_MS);

  test("caller abort inside Reviewer verification drains the tool without Cleanup or another Verifier", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel during Reviewer verification");
    const hold = waitingTool("mcp__verus__lsp_diagnostics", { endOnAbort: true });
    let drained = false;
    let runs = 0;
    const verify: AgentTool = {
      ...hold.tool,
      parameters: Type.Object({ file_path: Type.String() }),
      execute: async (id, params, signal, onUpdate) => {
        try {
          const result = await hold.tool.execute(id, params, signal, onUpdate);
          signal?.throwIfAborted();
          runs++;
          return result;
        } finally {
          drained = true;
        }
      },
    };
    const activated: VerusRole[] = [];
    const observer = new RoleTracer();
    await using verifier = (await leaf([0, 1].map(() => () => {
      activated.push("Verifier");
      return fauxAssistantMessage("max.rs: translation ready.");
    }))).agent;
    await using reviewer = (await leaf([
      () => {
        activated.push("Reviewer");
        return verifyCall("blocked-review");
      },
      fauxAssistantMessage("must not report after cancellation"),
    ], { tools: [verify] })).agent;
    await using cleanup = (await leaf([() => {
      activated.push("Cleanup");
      return fauxAssistantMessage("must not activate");
    }])).agent;
    const running = runVerusLoop(workspace, { Verifier: verifier, Reviewer: reviewer, Cleanup: cleanup }, controller.signal, observer)
      .then(() => undefined, (error: unknown) => error);
    try {
      await Promise.race([
        hold.started,
        running.then((error) => { throw error ?? new Error("loop returned before verification started"); }),
      ]);
      controller.abort(reason);
      await hold.aborted;
      assert.equal(rootCause(await running), reason);
      assert.equal(drained, true);
      assert.equal(runs, 0);
      assert.deepEqual(activated, ["Verifier", "Reviewer"]);
      assert.ok(!observer.completed.includes("Cleanup"));
      for (const member of [verifier, reviewer, cleanup]) assert.notEqual(member.status, "closed");
    } finally {
      controller.abort(reason);
      hold.release();
      await running;
      await observer.flush();
    }
  }, TIMEOUT_MS);
});
