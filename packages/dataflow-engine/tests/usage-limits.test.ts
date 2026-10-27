import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  admitToolCall,
  assertTokenRequestAllowed,
  assertUsageAllowed,
  captureUsageContext,
  chargeTokenUsage,
  DataflowDefinitionError,
  isUsageLimitError,
  runWithUsageBudgets,
  runWithUsageContext,
  UsageBudget,
  type UsageLimitDetails,
  UsageLimitError,
} from "../src/index.ts";

/** The usage failure `work` throws. */
function denial(work: () => void): UsageLimitError {
  try {
    work();
  } catch (error) {
    assert.ok(isUsageLimitError(error));
    return error;
  }
  assert.fail("expected a usage limit failure");
}

test("tool admission is check-then-commit: a denial counts nowhere and reports the attempt", async () => {
  const budget = new UsageBudget("evaluation", { tools: 2 });
  let executed = 0;
  const outcomes = await runWithUsageBudgets([budget], "agent", () =>
    Promise.allSettled(
      [0, 1, 2].map(async () => {
        await Promise.resolve();
        admitToolCall();
        executed++;
      }),
    ),
  );
  assert.equal(executed, 2);
  assert.equal(budget.usedTools, 2);
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(rejected.length, 1);
  const error = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(error instanceof UsageLimitError);
  assert.equal(error.code, "JUNCO_USAGE_LIMIT_EXCEEDED");
  const details: UsageLimitDetails = {
    resource: "tools",
    scope: "evaluation",
    limit: 2,
    used: 2,
    requested: 1,
    attempted: 3,
    exceededBy: 1,
    nodePath: ["agent"],
  };
  assert.deepEqual(error.details, details);
  assert.equal(
    error.message,
    'Usage limit hit: resource=tools scope=evaluation node=["agent"] limit=2 used=2 requested=1 attempted=3 exceededBy=1',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {
    code: "JUNCO_USAGE_LIMIT_EXCEEDED",
    message: error.message,
    ...details,
  });
  // Latched: the next admission fails with the first error, still counting nothing.
  assert.equal(
    denial(() => runWithUsageBudgets([budget], "agent", admitToolCall)),
    error,
  );
  assert.equal(budget.usedTools, 2);
});

test("a nested denial leaves its ancestors uncounted and unpoisoned", () => {
  const outer = new UsageBudget("evaluation", { tools: 5 });
  const inner = new UsageBudget("activation", { tools: 0 });
  runWithUsageBudgets([outer], "graph", () => {
    const error = denial(() =>
      runWithUsageBudgets([inner], "child", admitToolCall),
    );
    assert.deepEqual(error.details.nodePath, ["graph", "child"]);
    assert.equal(error.details.scope, "activation");
    assert.equal(outer.usedTools, 0);
    assert.equal(outer.failure, undefined);
    assert.equal(inner.failure, error);
    admitToolCall();
  });
  assert.equal(outer.usedTools, 1);
  assert.equal(inner.usedTools, 0);
});

test("committed tokens count in every ledger; each newly overrun ledger latches its first hit", () => {
  const outer = new UsageBudget("evaluation", { tokens: 10 });
  const inner = new UsageBudget("activation", { tokens: 8 });
  runWithUsageBudgets([outer], "a", () =>
    runWithUsageBudgets([inner], "b", () => {
      chargeTokenUsage(6);
      const error = denial(() => chargeTokenUsage(5));
      // Outermost failure first.
      assert.equal(error, outer.failure);
      assert.deepEqual(
        { ...error.details },
        {
          resource: "tokens",
          scope: "evaluation",
          limit: 10,
          used: 6,
          requested: 5,
          attempted: 11,
          exceededBy: 1,
          nodePath: ["a", "b"],
        },
      );
      assert.ok(isUsageLimitError(inner.failure));
      assert.equal(inner.failure.details.exceededBy, 3);
      const first = inner.failure;
      // Already-admitted work keeps counting; the diagnostics stay the first hit.
      assert.equal(
        denial(() => chargeTokenUsage(4)),
        error,
      );
      assert.equal(outer.usedTokens, 15);
      assert.equal(inner.usedTokens, 15);
      assert.equal(inner.failure, first);
    }),
  );
});

test("an exactly exhausted token cap admits the response but not the next request; zero denies the first", () => {
  const budget = new UsageBudget("batch", { tokens: 10, tools: 1 });
  runWithUsageBudgets([budget], "n", () => {
    assertTokenRequestAllowed();
    chargeTokenUsage(10);
    admitToolCall();
    // An exhausted tool cap never blocks a final model response.
    assert.equal(budget.failure, undefined);
    const error = denial(() => assertTokenRequestAllowed());
    assert.equal(error.details.requested, 0);
    assert.equal(error.details.attempted, 10);
    assert.equal(error.details.exceededBy, 0);
  });
  const zero = new UsageBudget("evaluation", { tokens: 0 });
  runWithUsageBudgets([zero], "n", () =>
    denial(() => assertTokenRequestAllowed()),
  );
  assert.equal(zero.usedTokens, 0);
});

test("an explicit empty context masks an enclosing exhausted one", () => {
  const spent = new UsageBudget("evaluation", { tools: 0, tokens: 0 });
  runWithUsageBudgets([spent], "n", () => {
    denial(admitToolCall);
    runWithUsageContext(undefined, () => {
      assert.equal(captureUsageContext(), undefined);
      admitToolCall();
      assertTokenRequestAllowed();
      assertUsageAllowed();
      chargeTokenUsage(100);
    });
  });
  assert.equal(spent.usedTools, 0);
  assert.equal(spent.usedTokens, 0);
});

test("invalid limits and usage never raise available quota", () => {
  for (const limits of [
    {},
    { tools: -1 },
    { tools: 1.5 },
    { tokens: Number.NaN },
    { tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(
      () => new UsageBudget("evaluation", limits),
      DataflowDefinitionError,
    );
  assert.throws(
    () => new UsageBudget("global" as "evaluation", { tools: 1 }),
    DataflowDefinitionError,
  );
  const limits: { tools?: number } = { tools: 1 };
  const budget = new UsageBudget("evaluation", limits);
  limits.tools = 5;
  assert.deepEqual(budget.limits, { tools: 1 });

  const tokens = new UsageBudget("evaluation", { tokens: 10 });
  runWithUsageBudgets([tokens], "n", () => {
    chargeTokenUsage(4);
    assert.throws(() => chargeTokenUsage(-3), DataflowDefinitionError);
    assert.equal(tokens.usedTokens, 4);
    assert.ok(tokens.failure instanceof DataflowDefinitionError);
    assert.throws(() => assertTokenRequestAllowed(), DataflowDefinitionError);
  });
  // Without a token budget, provider usage is not inspected.
  runWithUsageBudgets([budget], "n", () => chargeTokenUsage(Number.NaN));
});
