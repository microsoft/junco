import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { NodeId, TriggerRule } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticOptions, JuncoAgent } from "junco-agent";
import { LockPolicy } from "junco-tools";
import { tools } from "../src/index.ts";
import { resultText, terminalPorts } from "./deterministic-support.ts";
import {
  type AgencyContext,
  agencyGraph,
  drive,
  flushMacrotasks,
  leaf,
  nativeOptions,
  runAvailable,
  type Script,
  scheduleCall,
  settledText,
  toolTurn,
  waitingTool,
} from "./support.ts";

const TIMEOUT_MS = 30_000;
const MEMBER = NodeId.create("0");
/** Nested consumers retain the context while native node state remains its actual graph. */
const member = (state: JuncoAgent | AgencyContext, description = "member") =>
  state instanceof JuncoAgent
    ? { state, policy: LockPolicy, description, trigger: TriggerRule.always() }
    : { state, description, trigger: TriggerRule.always() };

async function agency(
  members: readonly (JuncoAgent | AgencyContext)[],
  script: Script = runAvailable,
  { idle = false } = {},
) {
  const ports = terminalPorts();
  const fixture = await agencyGraph(
    ports.source,
    ports.sink,
    script,
    idle ? {} : { prompt: "run the graph" },
  );
  const graph = fixture.context.graph;
  for (const [index, state] of members.entries())
    graph.addNode(member(state, `member ${index}`));
  ports.connect(graph, MEMBER);
  return fixture;
}

const plan =
  (...waves: string[][][]): Script =>
  (request, index) =>
    index < waves.length ? { waves: waves[index]! } : runAvailable(request);

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
  "thirty-two nested agencies forward the identical innermost sink result",
  async () => {
    const innermost = await leaf([fauxAssistantMessage("deep")], {
      prompt: "go",
    });
    const levels: AgencyContext[] = [];
    let current: JuncoAgent | AgencyContext = innermost.agent;
    for (let depth = 0; depth < 32; depth++) {
      const level = await agency([current]);
      levels.push(level.context);
      current = level.context;
    }
    const root = levels.at(-1)!;
    try {
      await root.run();
      assert.ok(
        levels.every(({ graph }) => resultText(graph, MEMBER) === "deep"),
      );
      const final = levels[0]!.graph.result(MEMBER);
      assert.ok(O.isSome(final));
      for (const { graph } of levels) {
        const sink = graph.result(graph.sink.id);
        assert.ok(O.isSome(sink));
        assert.equal(sink.value, final.value);
      }
      assert.equal(innermost.faux.state.callCount, 1);
    } finally {
      await root.graph.close();
    }
    assert.equal(innermost.agent.status, "closed");
    assert.ok(levels.every(({ graph }) => graph.signal.aborted));
  },
  TIMEOUT_MS,
);

test(
  "abort and close traverse 4096 idle nested agencies without growing the stack",
  async () => {
    const innermost = await leaf([]);
    let current: JuncoAgent | AgencyContext = innermost.agent;
    let root: AgencyContext | undefined;
    for (let depth = 0; depth < 4096; depth++) {
      root = (await agency([current], runAvailable, { idle: true })).context;
      current = root;
    }
    assert.ok(root !== undefined);
    const aborted = root.graph.signal;
    await root.graph.abort();
    assert.ok(aborted.aborted);
    assert.equal(root.graph.signal.aborted, false);
    await root.graph.close();
    assert.ok(root.graph.signal.aborted);
    assert.equal(innermost.agent.status, "closed");
  },
  TIMEOUT_MS * 4,
);

test(
  "root graph abort reaches a live grandchild and joins its gated sibling",
  async () => {
    const grandchildTool = waitingTool("grandchild_work", { endOnAbort: true });
    const grandchild = await leaf(
      [
        toolTurn(fauxToolCall("grandchild_work", {}, { id: "g1" })),
        fauxAssistantMessage("unused"),
      ],
      { prompt: "go", tools: [grandchildTool.tool] },
    );
    const siblingTool = waitingTool("sibling_work");
    const sibling = await leaf(
      [
        toolTurn(fauxToolCall("sibling_work", {}, { id: "s1" })),
        fauxAssistantMessage("unused"),
      ],
      { prompt: "go", tools: [siblingTool.tool] },
    );
    const child = await agency([grandchild.agent]);
    const { context: root } = await agency(
      [child.context, sibling.agent],
      plan([["0", "1"]], [["0"]], [["0", "1"]]),
    );
    const signal = root.graph.signal;
    const running = root.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.all([grandchildTool.started, siblingTool.started]);
      let aborted = false;
      const aborting = root.graph.abort().then(() => {
        aborted = true;
      });
      await Promise.all([grandchildTool.aborted, siblingTool.aborted]);
      await flushMacrotasks();
      assert.equal(aborted, false);
      siblingTool.release();
      await aborting;
      assert.equal(await running, signal.reason);
      assert.equal(root.graph.signal.aborted, false);
    } finally {
      grandchildTool.release();
      siblingTool.release();
      await running;
      await root.graph.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "a failing member abort never skips its gated sibling",
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
    const failing = await FailingAbort.make((await nativeOptions([])).options);
    const siblingTool = waitingTool("sibling_work", { endOnAbort: true });
    const sibling = await leaf(
      [
        toolTurn(fauxToolCall("sibling_work", {}, { id: "s1" })),
        fauxAssistantMessage("unused"),
      ],
      { prompt: "go", tools: [siblingTool.tool] },
    );
    const { context: root } = await agency(
      [failing, sibling.agent],
      plan([["0", "1"]], [["1"]]),
    );
    const running = root.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await siblingTool.started;
      const error = await root.graph.abort().catch((thrown: unknown) => thrown);
      await siblingTool.aborted;
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      await running;
    } finally {
      siblingTool.release();
      await running;
      await root.graph.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "closing a graph during an oracle joins cleanup and closes each member once",
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
    const child = await agency([grandchild.agent]);
    const held = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    const schedule = (id: string) =>
      fauxAssistantMessage([scheduleCall([["0"]], id)], {
        stopReason: "toolUse",
      });
    const { context: root } = await agency(
      [child.context, counted],
      [
        schedule("s1"),
        schedule("s2"),
        schedule("s3"),
        async (_request, options) => {
          held.resolve();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          cleaned.resolve();
          return fauxAssistantMessage("aborted", { stopReason: "aborted" });
        },
      ],
    );
    const signal = root.graph.signal;
    const running = root.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    await held.promise;
    assert.equal(grandchild.agent.status, "suspended");
    await root.graph.close();
    await cleaned.promise;
    assert.equal(await running, signal.reason);
    assert.deepEqual(calls, ["return"]);
    for (const agent of [grandchild.agent, counted])
      assert.equal(agent.status, "closed");
    await root.graph.close();
    assert.deepEqual(calls, ["return"]);
    assert.ok(root.graph.signal.aborted && child.context.graph.signal.aborted);
  },
  TIMEOUT_MS,
);

test("repeated graph.close joins a failed close without duplicating its error", async () => {
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
  const { context } = await agency([failing], runAvailable, { idle: true });
  const direct = await context.graph.close().then(
    () => assert.fail("member close failure must surface"),
    (error: unknown) => error,
  );
  assert.equal(failing.status, "closed");
  assert.equal(
    await context.graph.close().catch((error: unknown) => error),
    direct,
  );
  assert.equal(
    await context.graph.close().catch((error: unknown) => error),
    direct,
  );
});

test("shared and cyclic native member graphs cascade abort and close once each", async () => {
  const calls: string[] = [];
  const counted = await counting(calls, (await nativeOptions([])).options);
  const { context: root } = await agency([counted], runAvailable, {
    idle: true,
  });
  const child = await agency([counted, root], runAvailable, { idle: true });
  root.graph.addNode(member(child.context));
  root.graph.addNode(member(child.context));
  await root.graph.abort();
  assert.deepEqual(calls, ["abort"]);
  assert.equal(root.graph.signal.aborted, false);
  assert.equal(child.context.graph.signal.aborted, false);
  await root.graph.close();
  assert.deepEqual(calls, ["abort", "return"]);
  assert.equal(counted.status, "closed");
  assert.ok(root.graph.signal.aborted && child.context.graph.signal.aborted);
  await root.graph[Symbol.asyncDispose]();
  assert.deepEqual(calls, ["abort", "return"]);
});

test(
  "LspTool delivers successful status and semantic errors through JuncoAgent",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "junco-lsp-"));
    const directory = join(scratch, "seed");
    await mkdir(directory);
    const nativePath = new URL(
      "../packages/junco-tools/target/native-test/index.js",
      import.meta.url,
    ).href;
    const native = await import(nativePath);
    const mux = (
      await native.NativeMux.openCopyTree(directory, { sandbox: "always" })
    ).forkOwner();
    const options = { readOnly: true, trustedWorkspace: true, mux, native };
    try {
      const lsp = await tools.LspTool.create(directory, options);
      assert.equal(lsp.name, "lsp");
      assert.equal(lsp.label, "LSP");
      assert.equal(lsp.strict, true);
      assert.equal(lsp.loadMode, "discoverable");
      assert.equal(lsp.approval({ action: "HOVER" }), "read");
      assert.equal(lsp.approval({ action: "rename" }), "write");
      assert.deepEqual(
        lsp.formatApprovalDetails({ action: "hover", file: "a.ts" }),
        ["Action: hover", "File: a.ts"],
      );
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
              // Schema-valid, but the native dispatcher requires a diagnostics file.
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

        const { execute } = await tools.LspTool.create(directory, options);
        const direct = await execute("direct-status", { action: "status" });
        assert.equal(direct.isError, false);
        assert.equal(direct.details?.action, "status");
        assert.equal(direct.details?.success, true);
        const aborted = new AbortController();
        aborted.abort();
        await assert.rejects(
          execute("already-aborted", { action: "status" }, aborted.signal),
          /Operation aborted/,
        );

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

        await tools.LspTool.shutdown();
        await tools.LspTool.shutdown();
        const again = await tools.LspTool.create(directory, options);
        const restarted = await again.execute("restarted-status", {
          action: "status",
        });
        assert.equal(restarted.details?.success, true);
      } finally {
        await tools.LspTool.shutdown();
      }
    } finally {
      await mux.close();
      await rm(scratch, { recursive: true, force: true });
    }
  },
  TIMEOUT_MS,
);
