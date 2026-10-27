import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isUsageLimitError,
  runWithUsageBudgets,
  UsageBudget,
} from "dataflow-engine";
import {
  BashTool,
  LockPolicy,
  ToolCollection,
  YieldTool,
} from "../dist/index.js";
import {
  cleanup,
  copyTreeNative,
  hashlineTag,
  seedFixture,
  text,
} from "./helpers.mjs";

/** `work` under a fresh `agent` activation holding `budget`. */
const within = (budget, work) => runWithUsageBudgets([budget], "agent", work);

/** The usage-limit rejection of `work`. */
async function denied(work) {
  const error = await work.then(
    () => assert.fail("expected a usage limit failure"),
    (failure) => failure,
  );
  assert.ok(isUsageLimitError(error), String(error));
  return error;
}

test("each call reaching a tool's wrapper counts once, success or failure; a denied call never executes", async () => {
  const execs = [];
  const bash = BashTool.create(tmpdir(), {
    operations: {
      async exec(command, _cwd, { onData }) {
        execs.push(command);
        onData(Buffer.from("out\n"));
        return { exitCode: command === "fail" ? 1 : 0 };
      },
    },
  });
  const yieldTool = new YieldTool();
  const budget = new UsageBudget("evaluation", { tools: 3 });
  await within(budget, () =>
    yieldTool.execute("y", { reason: "wait" }, undefined),
  );
  await within(budget, () => bash.execute("ok", { command: "ok" }));
  await within(budget, () => bash.execute("fail", { command: "fail" })).then(
    (result) => assert.equal(result.isError, true),
    () => undefined,
  );
  assert.equal(budget.usedTools, 3);
  const error = await denied(
    within(budget, () => bash.execute("late", { command: "late" })),
  );
  assert.deepEqual(execs, ["ok", "fail"]);
  assert.equal(budget.usedTools, 3);
  assert.equal(error.details.used, 3);
  assert.equal(error.details.attempted, 4);

  // A pre-aborted call still reached its wrapper.
  const aborted = new UsageBudget("activation", { tools: 1 });
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await within(aborted, () =>
    bash.execute("pre", { command: "pre" }, controller.signal),
  ).catch(() => undefined);
  assert.equal(aborted.usedTools, 1);
  await denied(
    within(aborted, () => yieldTool.execute("y", { reason: "again" })),
  );
});

test("collection tools count once, real bash included; close refusals and denied edits change nothing", {
  timeout: 60_000,
}, async () => {
  const { root: scratch, seed: root } = await seedFixture({
    files: { "direct.txt": "a\n", "bound.txt": "b\n" },
  });
  const native = await copyTreeNative();
  const collection = await ToolCollection.create(root, {
    native,
    sandbox: "shared",
    policy: LockPolicy,
  });
  const binding = collection.bind();
  try {
    const own = (name) => collection.tools.find((tool) => tool.name === name);
    const bound = (name) => binding.tools.get(own(name));

    // Shell execution under a tool call is no second call.
    const shell = new UsageBudget("evaluation", { tools: 1 });
    const echoed = await within(shell, () =>
      own("bash").execute("b", { command: "echo hi" }),
    );
    assert.match(text(echoed), /hi/);
    assert.equal(shell.usedTools, 1);

    for (const [file, read, edit] of [
      ["direct.txt", own("read"), own("edit")],
      ["bound.txt", bound("read"), bound("edit")],
    ]) {
      const budget = new UsageBudget("evaluation", { tools: 1 });
      // Provenance reads stay outside the budget.
      const tag = async () =>
        hashlineTag(text(await read.execute("r", { path: file })));
      const first = await tag();
      await within(budget, () =>
        edit.execute("e1", { input: `[${file}#${first}]\nPUT 1.=1:\n+one\n` }),
      );
      const second = await tag();
      const error = await denied(
        within(budget, () =>
          edit.execute("e2", {
            input: `[${file}#${second}]\nPUT 1.=1:\n+two\n`,
          }),
        ),
      );
      assert.equal(error.details.used, 1);
      assert.equal(budget.usedTools, 1);
      assert.equal(await readFile(join(root, file), "utf8"), "one\n");
    }

    // Refused by a closed binding or collection before any wrapper: nothing counts.
    const closed = new UsageBudget("evaluation", { tools: 1 });
    const boundRead = bound("read");
    await binding.close();
    await assert.rejects(
      within(closed, () => boundRead.execute("r", { path: "bound.txt" })),
      /ToolBinding is closed/,
    );
    const ownRead = own("read");
    await collection.close();
    await assert.rejects(
      within(closed, () => ownRead.execute("r", { path: "direct.txt" })),
      /ToolCollection is closed/,
    );
    assert.equal(closed.usedTools, 0);
  } finally {
    await cleanup(
      () => binding.close(),
      () => collection.close(),
      () => rm(scratch, { recursive: true, force: true }),
    );
  }
});
