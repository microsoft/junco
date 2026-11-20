import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  DataflowNodeError,
  Edge,
  Message,
  TriggerRule,
  UsageLimitError,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgentError } from "junco-agent";
import {
  LockPolicy,
  type ProfileEvent,
  type ProfileRecorder,
} from "junco-tools";
import {
  errors,
  type JuncoGraph,
  MockAgent,
  type schedules,
  TaskSchema,
} from "../src/index.ts";
import { applyModel } from "../src/node-policy.ts";
import {
  assistant,
  failed,
  pause,
  plainContext,
  reason,
  run,
  STRATEGIES,
  settle,
  terminalPorts,
  textOf,
  userTexts,
} from "./deterministic-support.ts";

const ladder: schedules.Ladder = {
  smol: { model: "p/a" },
  low: { model: "p/a" },
  med: { model: "p/a" },
  high: { model: "p/b" },
  xhigh: { model: "p/b", thinking: "high" },
};
const model = (id: string): Model<Api> => ({
  id,
  name: id,
  api: "mock",
  provider: "p",
  baseUrl: "",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 1000,
  maxTokens: 100,
});
const failure = (
  agent = new MockAgent({ runs: [] }),
): Parameters<errors.ErrorHandler>[0] => ({
  error: new Error("provider down"),
  attempt: 1,
  agent,
  recorder: undefined,
  signal: undefined,
});
const graphs: JuncoGraph[] = [];
afterEach(async () => {
  for (const graph of graphs.splice(0)) await graph.close();
});

// Pure decisions use the same protocol as the driver, without a graph or provider.
test("retry bounds attempts and preserves the original hard failure", async () => {
  const input = failure();
  const handler = errors.retry({ afterMs: 5, times: 2 }, errors.crash());
  for (const attempt of [1, 2])
    assert.deepEqual(await handler({ ...input, attempt }), { retryAfterMs: 5 });
  assert.throws(
    () => handler({ ...input, attempt: 3 }),
    (e) => e === input.error,
  );
  assert.throws(
    () => errors.retry({ afterMs: 0, times: 0 }, errors.crash())(input),
    (e) => e === input.error,
  );
  for (const afterMs of [-1, Infinity, NaN])
    assert.throws(() => errors.retry({ afterMs, times: 1 }, errors.crash()), {
      name: "RangeError",
      message: "retry afterMs must be a non-negative finite number",
    });
  for (const times of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => errors.retry({ afterMs: 0, times }, errors.crash()), {
      name: "RangeError",
      message: "retry times must be a non-negative safe integer",
    });
});

test("escalate skips duplicate rungs, includes thinking, and shares the model cache", async () => {
  const agent = new MockAgent({
    models: [model("a"), model("b")],
    model: { provider: "p", modelId: "a" },
    runs: [],
  });
  const input = failure(agent);
  const handler = errors.escalate({ ladder }, errors.crash());
  await applyModel(agent, { provider: "p", modelId: "a" }, "off");
  assert.deepEqual(await handler(input), { retryAfterMs: 0 });
  assert.deepEqual(agent.calls.slice(-2), [
    { method: "setModel", args: [{ provider: "p", modelId: "b" }] },
    { method: "setThinkingLevel", args: ["off"] },
  ]);
  assert.deepEqual(await handler(input), { retryAfterMs: 0 });
  assert.deepEqual(agent.calls.slice(-2), [
    { method: "setModel", args: [{ provider: "p", modelId: "b" }] },
    { method: "setThinkingLevel", args: ["high"] },
  ]);
  await assert.rejects(
    async () => handler(input),
    (e) => e === input.error,
  );
  await applyModel(agent, { provider: "p", modelId: "a" }, "off");
  assert.equal((await agent.getModel())?.id, "a");
  assert.equal(await agent.getThinkingLevel(), "off");
  for (const missing of [undefined, { provider: "p", modelId: "other" }]) {
    const unknown = failure(
      new MockAgent({ models: [model("other")], model: missing, runs: [] }),
    );
    await assert.rejects(
      async () => handler(unknown),
      (e) => e === unknown.error,
    );
  }
  assert.throws(
    () =>
      errors.escalate(
        { ladder: { ...ladder, high: { model: "bad" } } },
        errors.crash(),
      ),
    DataflowDefinitionError,
  );
});

test("record counts retry, soft and hard decisions without retaining error text", async () => {
  const events: ProfileEvent<string>[] = [];
  const recorder: ProfileRecorder<string> = {
    root: {},
    path: "node",
    add_context: () => recorder,
    record: (event) => events.push(event),
    flush: async () => {},
    close: async () => {},
  };
  const input = { ...failure(), recorder };
  await assert.rejects(
    async () => errors.record(errors.crash())(input),
    (e) => e === input.error,
  );
  assert.deepEqual(
    await errors.record(errors.retry({ afterMs: 5, times: 1 }, errors.crash()))(
      input,
    ),
    { retryAfterMs: 5 },
  );
  assert.deepEqual(await errors.record(() => [])(input), []);
  assert.deepEqual(
    events,
    ["hard_errors", "retries", "soft_errors"].map((decision) => ({
      kind: "metrics",
      resource: "operations",
      category: "agent",
      tool: "",
      operation: "failure",
      counters: { failures: 1, [decision]: 1 },
    })),
  );
  assert.deepEqual(
    await errors.record(errors.retry({ afterMs: 0, times: 1 }, errors.crash()))(
      { ...input, recorder: undefined },
    ),
    { retryAfterMs: 0 },
  );
  assert.equal(events.length, 3);
});

for (const strategy of STRATEGIES) {
  describe(`agent error policies (${strategy})`, () => {
    const setup = (agent: MockAgent) => {
      const ports = terminalPorts();
      const context = plainContext(ports.source, ports.sink, strategy);
      graphs.push(context.graph);
      const id = context.graph.addNode({
        state: agent,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      ports.connect(context.graph, id);
      return { context, graph: context.graph, id };
    };

    test("retries thrown failures with a continuation in the same session", async () => {
      const agent = new MockAgent({
        prompt: "go",
        runs: [
          run([{ step: failed(new Error("down")) }]),
          run([settle(assistant("ok"))]),
        ],
        errorHandler: errors.retry({ afterMs: 1, times: 1 }, errors.crash()),
      });
      const { context, id } = setup(agent);
      assert.equal(textOf((await context.run()).get(id)!), "ok");
      assert.ok(
        agent.calls.some(
          (call) =>
            call.method === "stagePrompt" &&
            call.args[0] ===
              "Your previous attempt ended with an error, not because the work was finished. Continue the same task, building on what you already did, and return the complete answer.",
        ),
      );
    });

    test("exhaustion survives yields and retains the identical failure without a result", async () => {
      const cause = new Error("down");
      const attempts: number[] = [];
      const retry = errors.retry({ afterMs: 0, times: 1 }, errors.crash());
      const agent = new MockAgent({
        prompt: "go",
        runs: [
          run([{ step: failed(cause) }]),
          run([pause([reason("work", "y")]), { step: failed(cause) }]),
        ],
        errorHandler: (input) => {
          attempts.push(input.attempt);
          return retry(input);
        },
      });
      const { context, graph, id } = setup(agent);
      await assert.rejects(
        context.run(),
        (e) =>
          e instanceof DataflowNodeError &&
          e.nodeId === id &&
          e.error === cause,
      );
      assert.deepEqual(attempts, [1, 2]);
      assert.ok(O.isNone(graph.result(id)));
    });

    test("soft errors route to children without producing a parent result", async () => {
      const cause = new Error("down");
      const edge = Edge.message("parent->child", TaskSchema);
      const parent = new MockAgent({
        prompt: "go",
        runs: [run([{ step: failed(cause) }])],
        errorHandler: ({ error }) => [
          Message.create(edge, {
            kind: "error",
            text: String(error),
            taskId: "E1",
            spec: "",
            deps: [],
            history: [],
          }),
        ],
      });
      const child = new MockAgent({
        prompt: "child",
        runs: [run([settle(assistant("received"), { drain: ["steer"] })])],
      });
      const ports = terminalPorts();
      const context = plainContext(ports.source, ports.sink, strategy);
      const graph = context.graph;
      graphs.push(graph);
      const p = graph.addNode({
        state: parent,
        policy: LockPolicy,
        trigger: TriggerRule.always(),
      });
      const c = graph.addNode({
        state: child,
        policy: LockPolicy,
        trigger: TriggerRule.when(edge),
      });
      graph.addEdge(p, c, edge);
      ports.connect(graph, c);
      const results = await context.run();
      assert.ok(
        userTexts(child.requests[0]!.messages).some((text) =>
          text.includes(String(cause)),
        ),
      );
      assert.ok(O.isNone(graph.result(p)));
      assert.equal(textOf(results.get(c)!), "received");
    });

    test("provider error settlements retry, crash with their cause, or remain ordinary results", async () => {
      const boom = assistant("boom", "error");
      for (const mode of ["retry", "crash", "unchanged"] as const) {
        const agent = new MockAgent({
          prompt: "go",
          runs: [run([settle(boom)]), run([settle(assistant("ok"))])],
          errorHandler:
            mode === "retry"
              ? errors.retry({ afterMs: 0, times: 1 }, errors.crash())
              : mode === "crash"
                ? errors.crash()
                : undefined,
        });
        const { context, graph, id } = setup(agent);
        if (mode === "crash") {
          await assert.rejects(
            context.run(),
            (e) =>
              e instanceof DataflowNodeError &&
              e.error instanceof Error &&
              e.error.cause === boom,
          );
          assert.ok(O.isNone(graph.result(id)));
        } else {
          const result = (await context.run()).get(id)!;
          if (mode === "unchanged") assert.equal(result, boom);
          else assert.equal(textOf(result), "ok");
        }
      }
    });

    test("escalation applies the next model before the retried request", async () => {
      const agent = new MockAgent({
        prompt: "go",
        models: [model("a"), model("b")],
        model: { provider: "p", modelId: "a" },
        runs: [
          run([{ step: failed(new Error("down")) }]),
          run([settle(assistant("ok"))]),
        ],
        errorHandler: errors.escalate({ ladder }, errors.crash()),
      });
      const { context, id } = setup(agent);
      assert.equal(textOf((await context.run()).get(id)!), "ok");
      assert.equal(agent.requests[0]!.model?.id, "a");
      assert.equal(agent.requests[1]!.model?.id, "b");
      assert.equal(agent.requests[1]!.thinkingLevel, "off");
      assert.deepEqual(
        agent.calls.filter(
          (call) =>
            call.method === "setModel" || call.method === "setThinkingLevel",
        ),
        [
          { method: "setModel", args: [{ provider: "p", modelId: "b" }] },
          { method: "setThinkingLevel", args: ["off"] },
        ],
      );
    });

    test("definition errors, exhausted budgets and closed agents bypass recovery", async () => {
      const budget = new Error("wrapped budget", {
        cause: new UsageLimitError({
          resource: "tokens",
          scope: "activation",
          limit: 0,
          used: 0,
          requested: 1,
          attempted: 1,
          exceededBy: 1,
          nodePath: [],
        }),
      });
      for (const cause of [
        new DataflowDefinitionError("wiring"),
        new JuncoAgentError("closed", "closed"),
        budget,
      ]) {
        let handled = false;
        const agent = new MockAgent({
          prompt: "go",
          runs: [run([{ step: failed(cause) }])],
          errorHandler: () => {
            handled = true;
            return [];
          },
        });
        const { context } = setup(agent);
        await assert.rejects(
          context.run(),
          (e) =>
            e === cause ||
            (e instanceof DataflowNodeError && e.error === cause),
        );
        assert.equal(handled, false);
      }
    });

    test("cancellation interrupts retry delays instead of staging another request", async () => {
      const controller = new AbortController();
      const reason = new Error("cancel");
      const agent = new MockAgent({
        prompt: "go",
        runs: [run([{ step: failed(new Error("down")) }])],
        errorHandler: () => {
          controller.abort(reason);
          return { retryAfterMs: 60_000 };
        },
      });
      const { context } = setup(agent);
      await assert.rejects(
        context.run({ signal: controller.signal }),
        (e) => e === reason,
      );
      assert.deepEqual(
        agent.calls.filter((call) => call.method === "stagePrompt"),
        [],
      );
    });
  });
}
