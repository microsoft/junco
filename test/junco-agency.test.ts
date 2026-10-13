import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { DummyTracer, NodeId, TriggerRule, UNBOUNDED } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticOptions, JuncoAgent } from "junco-agent";
import { PiScheduler } from "junco-scheduler/agent";
import { LockPolicy } from "junco-tools";
import { type AgenticInput, JuncoGraph, LspTool, tools } from "../src/index.ts";
import {
  agencyGraph,
  drive,
  flushMacrotasks,
  leaf,
  nativeOptions,
  type PiGraph,
  runAvailable,
  type Script,
  scheduleCall,
  settledText,
  waitingTool,
} from "./support.ts";

const TIMEOUT_MS = 30_000;
const MEMBER = NodeId.create("0");
const toolTurn = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });
/** A prompt agent, or a nested graph forwarding its member `0`'s result. */
const member = (agent: JuncoAgent | JuncoGraph, description = "member") =>
  agent instanceof JuncoGraph
    ? {
        description,
        trigger: TriggerRule.always(),
        state: agent,
        result: MEMBER,
      }
    : {
        state: agent,
        policy: LockPolicy,
        description,
        trigger: TriggerRule.always(),
      };

/** An agency over `members`, planned by `script`, staged with a prompt unless `idle`. */
async function agency(
  members: readonly (JuncoAgent | JuncoGraph)[],
  script: Script = runAvailable,
  { idle = false } = {},
) {
  const { graph, scheduler, faux } = await agencyGraph(
    script,
    idle ? {} : { prompt: "run the graph" },
  );
  for (const [index, agent] of members.entries())
    graph.addNode(member(agent, `member ${index}`));
  return { graph, scheduler, faux };
}

/** Planned lanes for the first requests, then every available member. */
const plan =
  (...lanes: string[][][]): Script =>
  (info, request) =>
    request < lanes.length ? { lanes: lanes[request]! } : runAvailable(info);

/** The text of member `id`'s result in `graph`. */
function resultText(graph: JuncoGraph, id = "0"): string | undefined {
  const result = graph.result(NodeId.create(id));
  return O.isSome(result)
    ? result.value.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
    : undefined;
}

/** A JuncoAgent recording each public `abort()` and `return()` request into `calls`. */
function counting(
  calls: string[],
  options: AgenticOptions,
): Promise<JuncoAgent> {
  class Counting extends JuncoAgent {
    static async make(): Promise<Counting> {
      const agent = new Counting(options);
      await agent.initialize();
      return agent;
    }
    override abort() {
      calls.push("abort");
      return super.abort();
    }
    override return(value?: void | PromiseLike<void>) {
      calls.push("return");
      return super.return(value);
    }
  }
  return Counting.make();
}

test(
  "thirty-two nested agencies settle while every graph forwards the innermost result",
  async () => {
    const innermost = await leaf([fauxAssistantMessage("deep")], {
      prompt: "go",
    });
    const levels: {
      graph: PiGraph;
      scheduler: PiScheduler<AgenticInput, AssistantMessage>;
    }[] = [];
    let current: JuncoAgent | JuncoGraph = innermost.agent;
    for (let depth = 0; depth < 32; depth++) {
      const level = await agency([current]);
      levels.push(level);
      current = level.graph;
    }
    const root = levels.at(-1)!;

    const last = await drive(root.scheduler);
    assert.equal(settledText(last), "graph quiescent");
    assert.ok(levels.every(({ graph }) => resultText(graph) === "deep"));
    assert.equal(innermost.faux.state.callCount, 1);
    await root.graph.close();
    assert.equal(innermost.agent.status, "closed");
    assert.ok(levels.every(({ scheduler }) => scheduler.status === "closed"));
  },
  TIMEOUT_MS,
);

test(
  "abort and close cascade through 4096 idle nested agencies without growing the stack",
  async () => {
    const innermost = await leaf([]);
    let current: JuncoAgent | JuncoGraph = innermost.agent;
    let root: PiGraph | undefined;
    for (let depth = 0; depth < 4096; depth++) {
      root = (await agency([current], runAvailable, { idle: true })).graph;
      current = root;
    }
    assert.ok(root !== undefined);

    const aborted = root.signal;
    await root.abort();
    assert.ok(aborted.aborted);
    assert.equal(root.signal.aborted, false);
    await root.close();
    assert.ok(root.signal.aborted);
    assert.equal(root.scheduler.status, "closed");
    assert.equal(innermost.agent.status, "closed");
  },
  TIMEOUT_MS * 4,
);

test(
  "a direct root scheduler abort reaches a live grandchild while its sibling still runs",
  async () => {
    const grandchildTool = waitingTool("grandchild_work", { endOnAbort: true });
    const grandchild = await leaf(
      [
        toolTurn(fauxToolCall("grandchild_work", {}, { id: "g1" })),
        fauxAssistantMessage("unused"),
      ],
      {
        prompt: "go",
        tools: [grandchildTool.tool],
      },
    );
    const siblingTool = waitingTool("sibling_work");
    const sibling = await leaf(
      [
        toolTurn(fauxToolCall("sibling_work", {}, { id: "s1" })),
        fauxAssistantMessage("unused"),
      ],
      {
        prompt: "go",
        tools: [siblingTool.tool],
      },
    );
    const child = await agency([grandchild.agent], plan([["0"]], [["0"]]));
    const { scheduler: root } = await agency(
      [child.graph, sibling.agent],
      plan([["0"], ["1"]], [["0"], ["1"]]),
    );
    let finalTurn: AssistantMessage | undefined;
    root.events.on("turn_end", ({ message }) => {
      finalTurn = message;
    });

    // One run: the first window primes both members, the second runs the child (which primes and
    // runs the grandchild within its own run) beside the sibling.
    const running = root.next();
    await Promise.all([grandchildTool.started, siblingTool.started]);

    let aborted = false;
    const aborting = root.abort().then((result) => {
      aborted = true;
      return result;
    });
    await grandchildTool.aborted;
    await siblingTool.aborted;
    await flushMacrotasks();
    assert.equal(aborted, false);
    siblingTool.release();
    assert.deepEqual(await aborting, { clearedSteer: [], clearedFollowUp: [] });
    const settled = (await running).value;
    assert.ok(settled?.kind === "settled" && finalTurn !== undefined);
    if (settled?.kind === "settled")
      assert.deepEqual(settled.message, finalTurn);
  },
  TIMEOUT_MS,
);

test(
  "a failing member abort never skips its gated sibling, and the root reports it",
  async () => {
    const failure = new Error("member abort failed");
    class FailingAbort extends JuncoAgent {
      static async make(options: AgenticOptions): Promise<FailingAbort> {
        const agent = new FailingAbort(options);
        await agent.initialize();
        return agent;
      }
      protected override abortDependents(): Promise<void> {
        return Promise.reject(failure);
      }
    }
    const failing = await FailingAbort.make({
      ...(await nativeOptions([])).options,
      prompt: "go",
    });
    const siblingTool = waitingTool("sibling_work", { endOnAbort: true });
    const sibling = await leaf(
      [
        toolTurn(fauxToolCall("sibling_work", {}, { id: "s1" })),
        fauxAssistantMessage("unused"),
      ],
      {
        prompt: "go",
        tools: [siblingTool.tool],
      },
    );
    const { scheduler: root } = await agency(
      [failing, sibling.agent],
      plan([["0"], ["1"]], [["1"]]),
    );
    let finalTurn: AssistantMessage | undefined;
    root.events.on("turn_end", ({ message }) => {
      finalTurn = message;
    });

    const running = root.next(); // primes both members, then runs the sibling
    await siblingTool.started;

    const error = await root.abort().catch((thrown: unknown) => thrown);
    await siblingTool.aborted;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    const settled = (await running).value;
    assert.ok(settled?.kind === "settled" && finalTurn !== undefined);
    if (settled?.kind === "settled")
      assert.deepEqual(settled.message, finalTurn);
  },
  TIMEOUT_MS,
);

test(
  "closing a running root scheduler closes each member once, without aborting it, and its graph joins",
  async () => {
    const calls: string[] = [];
    const counted = await counting(calls, (await nativeOptions([])).options);
    const grandchild = await leaf(
      [
        toolTurn(fauxToolCall("yield", { reason: "hold" }, { id: "y1" })),
        fauxAssistantMessage("unused"),
      ],
      { prompt: "go" },
    );
    const child = await agency([grandchild.agent], plan([["0"]], [["0"]]));
    // Two windows (prime, then the child's whole nested run), then a request held until close.
    const held = Promise.withResolvers<void>();
    const schedule = (id: string) =>
      fauxAssistantMessage([scheduleCall([["0"]], id)], {
        stopReason: "toolUse",
      });
    const { graph, scheduler: root } = await agency(
      [child.graph, counted],
      [
        schedule("s1"),
        schedule("s2"),
        async (_context, options) => {
          held.resolve();
          const closed = Promise.withResolvers<void>();
          options?.signal?.addEventListener("abort", () => closed.resolve(), {
            once: true,
          });
          await closed.promise;
          return fauxAssistantMessage("aborted", { stopReason: "aborted" });
        },
      ],
    );

    const running = root.next().catch(() => undefined);
    await held.promise;
    assert.equal(root.status, "running");
    assert.equal(grandchild.faux.state.callCount, 2);

    assert.deepEqual(await root.return(), { value: undefined, done: true });
    await running;
    assert.deepEqual(calls, ["return"]);
    for (const agentic of [root, child.scheduler, grandchild.agent, counted])
      assert.equal(agentic.status, "closed");
    assert.deepEqual(await root.next(), { value: undefined, done: true });
    await graph.close();
    assert.deepEqual(calls, ["return"]);
    assert.ok(graph.signal.aborted && child.graph.signal.aborted);
  },
  TIMEOUT_MS,
);

test("graph.close() after a failed direct scheduler return joins that close without duplicating its errors", async () => {
  const failure = new Error("member close failed");
  class FailingClose extends JuncoAgent {
    static async make(options: AgenticOptions): Promise<FailingClose> {
      const agent = new FailingClose(options);
      await agent.initialize();
      return agent;
    }
    override return(value?: void | PromiseLike<void>) {
      return super.return(value).then(() => Promise.reject(failure));
    }
  }
  const failing = await FailingClose.make((await nativeOptions([])).options);
  const { graph, scheduler } = await agency([failing], runAvailable, {
    idle: true,
  });

  const direct = await scheduler.return().then(
    () => assert.fail("the member close failure must surface"),
    (error: unknown) => error,
  );
  assert.equal(scheduler.status, "closed");
  const joined = await graph.close().then(
    () => assert.fail("graph close must join the failed close"),
    (error: unknown) => error,
  );
  assert.equal(joined, direct);
  assert.equal(await graph.close().catch((error: unknown) => error), direct);
});

test("a JuncoGraph over a plain PiScheduler cascades abort and close to shared and cyclic members once each", async () => {
  const calls: string[] = [];
  const counted = await counting(calls, (await nativeOptions([])).options);
  const plain = await PiScheduler.make<AgenticInput, AssistantMessage>(
    (await nativeOptions([])).options,
  );
  const root = new JuncoGraph(
    plain,
    UNBOUNDED,
    UNBOUNDED,
    new DummyTracer(),
    LockPolicy,
  );
  root.addNode(member(counted));
  const child = await agency([counted, root], runAvailable, { idle: true });
  root.addNode(member(child.graph));
  root.addNode(member(child.graph));

  await root.abort();
  assert.deepEqual(calls, ["abort"]);
  assert.equal(root.signal.aborted, false);
  assert.equal(child.graph.signal.aborted, false);

  await root.close();
  assert.deepEqual(calls, ["abort", "return"]);
  for (const actor of [plain, child.scheduler, counted])
    assert.equal(actor.status, "closed");
  assert.ok(root.signal.aborted && child.graph.signal.aborted);
  await root[Symbol.asyncDispose]();
  assert.deepEqual(calls, ["abort", "return"]);
});

test(
  "LspTool delivers successful status and semantic errors through JuncoAgent",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "junco-agency-lsp-"));
    try {
      const lsp = await LspTool.create(directory, { readOnly: true });
      try {
        let status: ToolResultMessage | undefined;
        let failure: ToolResultMessage | undefined;
        const { agent } = await leaf(
          [
            toolTurn(
              fauxToolCall("lsp", { action: "status" }, { id: "lsp-status" }),
            ),
            (context) => {
              status = context.messages.find(
                (message): message is ToolResultMessage =>
                  message.role === "toolResult" &&
                  message.toolCallId === "lsp-status",
              );
              // Schema-valid, but upstream's dispatcher rejects diagnostics without a file.
              return toolTurn(
                fauxToolCall(
                  "lsp",
                  { action: "diagnostics" },
                  { id: "lsp-failure" },
                ),
              );
            },
            (context) => {
              failure = context.messages.find(
                (message): message is ToolResultMessage =>
                  message.role === "toolResult" &&
                  message.toolCallId === "lsp-failure",
              );
              return fauxAssistantMessage("lsp checked");
            },
          ],
          {
            tools: [lsp],
            prompt:
              "Check LSP status, then request diagnostics without a file.",
          },
        );
        try {
          const last = await drive(agent);

          assert.ok(status && failure);
          assert.equal(status.toolName, "lsp");
          assert.equal(status.isError, false);
          assert.ok(
            status.details &&
              typeof status.details === "object" &&
              "action" in status.details,
          );
          assert.equal(status.details.action, "status");
          assert.equal(status.details.success, true);
          assert.equal(failure.toolName, "lsp");
          assert.equal(failure.isError, true);
          assert.equal(settledText(last), "lsp checked");
        } finally {
          await agent.return();
        }

        const { execute } = await tools.LspTool.create(directory, {
          readOnly: true,
        });
        const direct = await execute("direct-status", { action: "status" });
        assert.equal(direct.isError, false);
        assert.equal(direct.details?.action, "status");
        assert.equal(direct.details?.success, true);

        const diagnostics = await execute("direct-diagnostics", {
          action: "diagnostics",
        }).then(
          () => assert.fail("diagnostics without a file must reject"),
          (error: unknown) => error,
        );
        assert.ok(diagnostics instanceof Error);
        const cause = diagnostics.cause as {
          details?: { action?: string; success?: boolean };
        };
        assert.equal(cause.details?.action, "diagnostics");
        assert.equal(cause.details?.success, false);

        for (const action of [
          "code_actions",
          "reload",
          "rename",
          "rename_file",
          "request",
        ] as const) {
          const error = await execute(`write-${action}`, {
            action,
          } as Parameters<typeof execute>[1]).then(
            () => assert.fail(`${action} must reject under readOnly`),
            (rejection: unknown) => rejection,
          );
          assert.ok(error instanceof Error, action);
          assert.equal(error.name, "ToolError", action);
        }

        await LspTool.shutdown();
        await LspTool.shutdown();
        const again = await tools.LspTool.create(directory, { readOnly: true });
        const restarted = await again.execute("restarted-status", {
          action: "status",
        });
        assert.equal(restarted.details?.success, true);
      } finally {
        await LspTool.shutdown();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  TIMEOUT_MS,
);
