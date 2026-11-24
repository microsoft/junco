import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Context,
  contentText,
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type DataflowGraph,
  DataflowNodeError,
  type DataflowRunTrace,
} from "dataflow-engine";
import { type TSchema, Type } from "typebox";
import {
  prepareVerusSource,
  runVerusLoop,
  type VerusRole,
  type VerusWorkspace,
} from "../examples/verus/verus.ts";
import {
  agent,
  graph,
  schedules,
  syntax,
  tools,
  tracer,
} from "../src/index.ts";
import { userTexts } from "./deterministic-support.ts";
import { copyTreeNative, fauxRuntime, waitingTool } from "./support.ts";

const TIMEOUT_MS = 10_000;
const seed = await mkdtemp(join(tmpdir(), "junco-verus-"));
afterAll(() => rm(seed, { recursive: true, force: true }));
const workspace: VerusWorkspace = {
  source: "/original/max.rs",
  outputDir: seed,
  target: join(seed, "max.rs"),
  spec: "max_u32 returns an argument greater than or equal to both inputs, without preconditions.",
  rustFiles: ["max.rs"],
  cargoManifests: [],
};

const verifyCall = (id: string) =>
  fauxAssistantMessage(
    [
      fauxToolCall(
        "mcp__verus__lsp_diagnostics",
        { file_path: workspace.target },
        { id },
      ),
    ],
    {
      stopReason: "toolUse",
    },
  );

const latestInput = (context: Context): string =>
  userTexts(context.messages).at(-1)!;

function rootCause(error: unknown): unknown {
  while (error instanceof DataflowNodeError) error = error.cause;
  return error;
}

type Scripts = Record<VerusRole, readonly FauxResponseStep[]>;
/** The YAML system prompt, not parallel request order, selects each persistent role's script. */
async function runScript(
  scripts: Scripts,
  tool: AgentTool,
  observer: tracer.DataflowTracer,
  signal?: AbortSignal,
  maxTokens?: number,
) {
  const roles = ["Verifier", "Reviewer", "Cleanup"] as const;
  const next = { Verifier: 0, Reviewer: 0, Cleanup: 0 };
  const { models, faux } = await fauxRuntime([], "faux", [
    { id: "verus", maxTokens },
  ]);
  const respond: FauxResponseFactory = (context, ...rest) => {
    const system = context.messages
      .filter((m) => m.role === "system")
      .map((m) =>
        typeof m.content === "string" ? m.content : contentText(m.content),
      )
      .join("\n");
    const role = roles.find((role) => system.includes(`You are ${role}`));
    if (!role) throw new Error("Unknown Verus role");
    const answer = scripts[role][next[role]++];
    if (!answer) throw new Error(`Unexpected ${role} turn`);
    faux.appendResponses([respond]);
    return typeof answer === "function" ? answer(context, ...rest) : answer;
  };
  faux.setResponses([respond]);
  const ladder = new schedules.ModelLadder(
    models,
    schedules.uniformLadder({ model: "faux/verus" }),
  );
  await using resources = new AsyncDisposableStack();
  const native = await copyTreeNative();
  const collections = new Map<graph.NodeIdType, tools.ToolCollection>();
  for (const role of roles) {
    const collection = await tools.ToolCollection.create(seed, {
      native,
      extend: async () => ({ tools: [tool], close: async () => {} }),
    });
    collections.set(
      graph.NodeId.create(role),
      resources.adopt(collection, (c) => c.close()),
    );
  }
  await runVerusLoop(workspace, {
    tools: collections,
    ladder,
    tracer: observer,
    signal,
  });
}

/** Script compiler/prover feedback without treating proof failures as MCP transport failures. */
function scriptedVerification(exitCodes: readonly number[]) {
  const observed: number[] = [];
  const tool: AgentTool = {
    name: "mcp__verus__lsp_diagnostics",
    label: "Verus diagnostics",
    description: "Read the scripted Verus diagnostics for the output",
    parameters: Type.Object(
      { file_path: Type.String() },
      { additionalProperties: false },
    ),
    execute: async () => {
      const exitCode = exitCodes[observed.length];
      assert.notEqual(
        exitCode,
        undefined,
        "unexpected verification invocation",
      );
      const results = [
        {
          command: "verus",
          args: ["--crate-type", "lib", workspace.target, "--expand-errors"],
          cwd: workspace.outputDir,
          exitCode,
          stdout:
            exitCode === 0 ? "1 verified, 0 errors" : "0 verified, 1 error",
          stderr: exitCode === 0 ? "" : "max.rs: postcondition not satisfied",
        },
      ];
      observed.push(exitCode!);
      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: results,
      };
    },
  };
  return { tool, observed };
}

/** Observe actual settled graph nodes, not model statements that a role completed. */
class RoleTracer extends tracer.DummyTracer {
  readonly completed: string[] = [];
  readonly members = new Map<string, Set<unknown>>();

  constructor(private readonly onComplete: (role: string) => void = () => {}) {
    super();
  }

  override startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    return {
      startNode: (id) => ({
        end: (step) => {
          const role = String(id);
          if (["Verifier", "Reviewer", "Cleanup"].includes(role)) {
            if (!step.done) return;
            const members = this.members.get(role) ?? new Set();
            members.add(graph.getNode(id)!.state);
            this.members.set(role, members);
          } else if (
            !(
              role.startsWith("Prepare") &&
              !step.done &&
              Array.isArray(step.value) &&
              step.value.length
            ) &&
            role !== "$sink"
          )
            return;
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
  test(
    "success and nonzero feedback both continue through two ordered rounds until caller cancellation",
    async () => {
      const controller = new AbortController();
      const reason = new Error("two cleanup completions observed");
      const verification = scriptedVerification([0, 1]);
      const activated: VerusRole[] = [];
      const verifierPrompts: string[] = [];
      const cleanupPrompts: string[] = [];
      const reviewerResults: string[] = [];
      const observer = new RoleTracer((role) => {
        if (
          role === "Cleanup" &&
          observer.completed.filter((value) => value === "Cleanup").length === 2
        ) {
          controller.abort(reason);
        }
      });
      const verifier: FauxResponseFactory = (context) => {
        activated.push("Verifier");
        verifierPrompts.push(latestInput(context));
        assert.equal(
          userTexts(context.messages).filter((text) =>
            text.startsWith("Translate or repair the current output"),
          ).length,
          verifierPrompts.length,
        );
        if (verifierPrompts.length === 2)
          assert.ok(
            context.messages.some(
              (m) =>
                m.role === "assistant" &&
                contentText(m.content).includes("translated round 1"),
            ),
          );
        return fauxAssistantMessage(
          `max.rs: translated round ${verifierPrompts.length}`,
        );
      };
      const scripts: Scripts = {
        Verifier: [verifier, verifier],
        Reviewer: [0, 1].flatMap((round) => [
          () => {
            activated.push("Reviewer");
            return verifyCall(`review-${round}`);
          },
          (context: Context) => {
            const result = context.messages.at(-1);
            assert.ok(result?.role === "toolResult");
            reviewerResults.push(contentText(result.content));
            return fauxAssistantMessage(
              round === 0
                ? "max.rs: verification passed; review approved, strengthen membership specification."
                : "max.rs: nonzero proof failure: postcondition not satisfied; retain the strict contract.",
            );
          },
        ]),
        Cleanup: [0, 1].map((round) => (context: Context) => {
          activated.push("Cleanup");
          cleanupPrompts.push(latestInput(context));
          return fauxAssistantMessage(
            `max.rs: cleanup round ${round + 1}; preserve both lower-bound obligations.`,
          );
        }),
      };
      await assert.rejects(
        runScript(scripts, verification.tool, observer, controller.signal),
        (error: unknown) => rootCause(error) === reason,
      );
      const expected = [
        "Verifier",
        "Reviewer",
        "Cleanup",
        "Verifier",
        "Reviewer",
        "Cleanup",
      ];
      assert.deepEqual(observer.completed, [
        "Verifier",
        "PrepareReviewer",
        "Reviewer",
        "PrepareCleanup",
        "Cleanup",
        "Verifier",
        "PrepareReviewer",
        "Reviewer",
        "PrepareCleanup",
        "Cleanup",
      ]);
      assert.deepEqual(activated, expected);
      assert.deepEqual(verification.observed, [0, 1]);
      assert.match(reviewerResults[0]!, /1 verified, 0 errors/);
      assert.match(reviewerResults[1]!, /postcondition not satisfied/);
      assert.match(cleanupPrompts[1]!, /nonzero proof failure/);
      assert.match(verifierPrompts[1]!, /strengthen membership specification/);
      assert.match(
        verifierPrompts[1]!,
        /cleanup round 1; preserve both lower-bound obligations/,
      );
      for (const role of ["Verifier", "Reviewer", "Cleanup"]) {
        const members = observer.members.get(role)!;
        assert.equal(members.size, 1, `${role} was replaced between rounds`);
        const [member] = members;
        assert.ok(
          member instanceof agent.JuncoAgent && member.status === "closed",
        );
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a Verifier invocation cannot satisfy a Reviewer that never calls MCP diagnostics",
    async () => {
      const verification = scriptedVerification([0]);
      let reviewerActivations = 0;
      let cleanupActivations = 0;
      const observer = new RoleTracer();
      await assert.rejects(
        runScript(
          {
            Verifier: [
              verifyCall("writer-check"),
              fauxAssistantMessage("max.rs: writer verified the translation."),
            ],
            Reviewer: [
              () => {
                reviewerActivations++;
                return fauxAssistantMessage(
                  "max.rs: looks verified; no independent tool invocation.",
                );
              },
            ],
            Cleanup: [
              () => {
                cleanupActivations++;
                return fauxAssistantMessage("must not activate");
              },
            ],
          },
          verification.tool,
          observer,
        ),
        (error: unknown) =>
          rootCause(error) instanceof Error &&
          (rootCause(error) as Error).message ===
            "Reviewer did not obtain Verus MCP diagnostics in this round",
      );
      assert.deepEqual(verification.observed, [0]);
      assert.equal(reviewerActivations, 1);
      assert.equal(cleanupActivations, 0);
      assert.deepEqual(observer.completed, [
        "Verifier",
        "PrepareReviewer",
        "Reviewer",
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    "the two preparation gates attach the current assignment and each exact upstream report",
    async () => {
      const verification = scriptedVerification([0]);
      const controller = new AbortController();
      const reason = new Error("one round complete");
      const observer = new RoleTracer((role) => {
        if (role === "Cleanup") controller.abort(reason);
      });
      let assignment = "";
      await assert.rejects(
        runScript(
          {
            Verifier: [
              (context: Context) => {
                const text = latestInput(context);
                assignment = text.split("\n\nTask: ")[0]!;
                assert.ok(assignment.includes(workspace.spec));
                assert.ok(assignment.includes(workspace.outputDir));
                return fauxAssistantMessage("max.rs: translation ready.");
              },
            ],
            Reviewer: [
              (context: Context) => {
                const work = JSON.parse(latestInput(context));
                assert.equal(work.id, "PrepareReviewer~>Reviewer");
                assert.equal(
                  work.payload.assignment.trimEnd(),
                  assignment.trimEnd(),
                );
                assert.equal(
                  syntax.finalText(work.payload.report, "Verifier"),
                  "max.rs: translation ready.",
                );
                return verifyCall("fresh-review");
              },
              fauxAssistantMessage("max.rs: independent review ready."),
            ],
            Cleanup: [
              (context: Context) => {
                const work = JSON.parse(latestInput(context));
                assert.equal(work.id, "PrepareCleanup~>Cleanup");
                assert.equal(
                  work.payload.assignment.trimEnd(),
                  assignment.trimEnd(),
                );
                assert.equal(
                  syntax.finalText(work.payload.report, "Reviewer"),
                  "max.rs: independent review ready.",
                );
                return fauxAssistantMessage("max.rs: cleanup ready.");
              },
            ],
          },
          verification.tool,
          observer,
          controller.signal,
        ),
        (error: unknown) => rootCause(error) === reason,
      );
      assert.deepEqual(verification.observed, [0]);
    },
    TIMEOUT_MS,
  );

  test(
    "a prior Reviewer round cannot satisfy the next round without fresh diagnostics",
    async () => {
      const verification = scriptedVerification([0]);
      let cleanupActivations = 0;
      const observer = new RoleTracer();
      await assert.rejects(
        runScript(
          {
            Verifier: [0, 1].map(() =>
              fauxAssistantMessage("max.rs: translation ready."),
            ),
            Reviewer: [
              verifyCall("first-round-only"),
              fauxAssistantMessage(
                "max.rs: independently verified first round.",
              ),
              fauxAssistantMessage(
                "max.rs: reusing the prior round's diagnostics.",
              ),
            ],
            Cleanup: [
              () => {
                cleanupActivations++;
                return fauxAssistantMessage("max.rs: first cleanup ready.");
              },
            ],
          },
          verification.tool,
          observer,
        ),
        (error: unknown) => {
          assert.ok(error instanceof DataflowNodeError);
          assert.equal(String(error.nodeId), "PrepareCleanup");
          assert.equal(
            (rootCause(error) as Error).message,
            "Reviewer did not obtain Verus MCP diagnostics in this round",
          );
          return true;
        },
      );
      assert.deepEqual(verification.observed, [0]);
      assert.equal(cleanupActivations, 1);
      assert.deepEqual(observer.completed, [
        "Verifier",
        "PrepareReviewer",
        "Reviewer",
        "PrepareCleanup",
        "Cleanup",
        "Verifier",
        "PrepareReviewer",
        "Reviewer",
      ]);
    },
    TIMEOUT_MS,
  );

  for (const role of ["Verifier", "Reviewer"] as const) {
    for (const invalid of [
      {
        message: fauxAssistantMessage("   "),
        reason: `${role} produced an empty report`,
      },
      {
        message: fauxAssistantMessage("part", {
          stopReason: "length",
        }),
        reason: `${role} did not finish normally: length`,
      },
    ]) {
      test(
        `${role}'s invalid report fails its code gate: ${invalid.reason}`,
        async () => {
          const verification = scriptedVerification([0]);
          let reviewerActivations = 0;
          let cleanupActivations = 0;
          await assert.rejects(
            runScript(
              {
                Verifier: [
                  role === "Verifier"
                    ? invalid.message
                    : fauxAssistantMessage("max.rs: translation ready."),
                ],
                Reviewer: [
                  () => {
                    reviewerActivations++;
                    return verifyCall("invalid-review");
                  },
                  invalid.message,
                ],
                Cleanup: [
                  () => {
                    cleanupActivations++;
                    return fauxAssistantMessage("must not activate");
                  },
                ],
              },
              verification.tool,
              new RoleTracer(),
              undefined,
              invalid.message.stopReason === "length" ? 1 : undefined,
            ),
            (error: unknown) => {
              assert.ok(error instanceof DataflowNodeError);
              assert.equal(
                String(error.nodeId),
                role === "Verifier" ? "PrepareReviewer" : "PrepareCleanup",
              );
              assert.equal((rootCause(error) as Error).message, invalid.reason);
              return true;
            },
          );
          assert.equal(reviewerActivations, role === "Verifier" ? 0 : 1);
          assert.equal(cleanupActivations, 0);
          assert.deepEqual(
            verification.observed,
            role === "Verifier" ? [] : [0],
          );
        },
        TIMEOUT_MS,
      );
    }
  }

  test(
    "source preparation mirrors the input without overwriting originals or existing output",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "junco-verus-copy-"));
      try {
        const source = join(root, "input");
        const original = "pub fn identity(value: u32) -> u32 { value }\n";
        await mkdir(source);
        await writeFile(join(source, "lib.rs"), original);
        const outputDir = join(root, "output");
        const copy = await prepareVerusSource({
          source,
          outputDir,
          spec: workspace.spec,
        });
        assert.equal(
          await readFile(join(copy.outputDir, "lib.rs"), "utf8"),
          original,
        );
        await writeFile(join(copy.outputDir, "lib.rs"), "changed copy");
        assert.equal(await readFile(join(source, "lib.rs"), "utf8"), original);
        await assert.rejects(
          prepareVerusSource({ source, outputDir, spec: workspace.spec }),
          /empty directory/,
        );
        assert.equal(
          await readFile(join(copy.outputDir, "lib.rs"), "utf8"),
          "changed copy",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "an MCP failure cannot be reported as a successful independent review",
    async () => {
      const verification = scriptedVerification([0]);
      const tool = {
        ...verification.tool,
        execute: async () => {
          throw new Error("bridge disconnected");
        },
      };
      await assert.rejects(
        runScript(
          {
            Verifier: [fauxAssistantMessage("max.rs: translation ready.")],
            Reviewer: [
              verifyCall("failed-diagnostics"),
              fauxAssistantMessage(
                "max.rs: completed despite the failed bridge.",
              ),
            ],
            Cleanup: [],
          },
          tool,
          new RoleTracer(),
        ),
        (error: unknown) =>
          rootCause(error) instanceof Error &&
          /bridge disconnected/.test((rootCause(error) as Error).message),
      );
    },
    TIMEOUT_MS,
  );

  test(
    "caller abort inside Reviewer verification drains the tool without Cleanup or another Verifier",
    async () => {
      const controller = new AbortController();
      const reason = new Error("cancel during Reviewer verification");
      const hold = waitingTool("mcp__verus__lsp_diagnostics", {
        endOnAbort: true,
      });
      let drained = false;
      let runs = 0;
      const verify: AgentTool = {
        ...hold.tool,
        parameters: Type.Object({ file_path: Type.String() }),
        execute: async (id, params, signal, onUpdate) => {
          try {
            const result = await hold.tool.execute(
              id,
              params,
              signal,
              onUpdate,
            );
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
      const running = runScript(
        {
          Verifier: [
            () => {
              activated.push("Verifier");
              return fauxAssistantMessage("max.rs: translation ready.");
            },
          ],
          Reviewer: [
            () => {
              activated.push("Reviewer");
              return verifyCall("blocked-review");
            },
          ],
          Cleanup: [
            () => {
              activated.push("Cleanup");
              return fauxAssistantMessage("must not activate");
            },
          ],
        },
        verify,
        observer,
        controller.signal,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          hold.started,
          running.then((error) => {
            throw (
              error ?? new Error("loop returned before verification started")
            );
          }),
        ]);
        controller.abort(reason);
        await hold.aborted;
        assert.equal(rootCause(await running), reason);
        assert.equal(drained, true);
        assert.equal(runs, 0);
        assert.deepEqual(activated, ["Verifier", "Reviewer"]);
        assert.ok(!observer.completed.includes("Cleanup"));
      } finally {
        controller.abort(reason);
        hold.release();
        await running;
      }
    },
    TIMEOUT_MS,
  );
});
