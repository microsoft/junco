import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { NodeId, TriggerRule } from "dataflow-engine";
import { JuncoAgent } from "junco-agent";
import {
  BashTool,
  EmptyPolicy,
  LockPolicy,
  type NativeModule,
  ShellMuxOperations,
  ToolCollection,
} from "junco-tools";
import { policyContext, terminalPorts } from "./deterministic-support.ts";
import { flushMacrotasks, nativeOptions } from "./support.ts";

// Real Marsh policy through junco-tools' test addon: a CopyTree fixture filesystem with the sandbox
// always on. Build it once in packages/junco-tools with `bun run build:native:test`. Imported
// dynamically because the test-only addon is a build artifact outside every package export.
const native = await import(
  fileURLToPath(
    new URL(
      "../packages/junco-tools/target/native-test/index.js",
      import.meta.url,
    ),
  )
);
const copyTree = {
  ...native,
  NativeMux: { open: native.NativeMux.openCopyTree.bind(native.NativeMux) },
} as unknown as NativeModule;

const SOURCE = "src/claimed.ts";
const OWNED = "const value = owned;\n";

/**
 * A seed whose SOURCE another principal has claimed through `policy`'s collection; `body` runs
 * with that collection, which is closed before the seed is removed.
 */
async function withClaimedSeed(
  policy: ToolCollection["policy"],
  body: (seed: string, collection: ToolCollection) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "junco-policy-"));
  const seed = join(root, "seed");
  await mkdir(join(seed, "src"), { recursive: true });
  await writeFile(join(seed, SOURCE), "const value = seed;\n");
  try {
    const collection = await ToolCollection.create(seed, {
      native: copyTree,
      policy,
      sandbox: "always",
    });
    try {
      const operations = new ShellMuxOperations({
        mux: collection.mux,
        native: copyTree,
        principal: "other-owner",
      });
      try {
        await BashTool.create(seed, { operations }).execute(
          "claim",
          { command: `printf 'const value = owned;\\n' > ${SOURCE}` },
          undefined,
        );
      } finally {
        await operations.close();
      }
      assert.equal(await readFile(join(seed, SOURCE), "utf8"), OWNED);
      await body(seed, collection);
    } finally {
      await collection.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "a real Marsh denial pauses the run as a policy yield and publishes nothing",
  () =>
    withClaimedSeed(LockPolicy, async (seed, collection) => {
      const byName = new Map(collection.tools.map((tool) => [tool.name, tool]));
      const read = await byName
        .get("read")!
        .execute("read", { path: SOURCE }, undefined, undefined);
      const readText = read.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const tag = /#([0-9A-Fa-f]{4})\]/.exec(readText)?.[1];
      assert.ok(tag, readText);

      const { faux, options } = await nativeOptions([
        fauxAssistantMessage(
          [
            fauxToolCall(
              "edit",
              {
                input: `[${SOURCE}#${tag}]\nPUT 1.=1:\n+const value = stolen;\n`,
              },
              { id: "edit-1" },
            ),
            fauxToolCall(
              "ast_edit",
              { rewrites: { owned: "stolen" }, path: SOURCE, dryRun: false },
              { id: "ast-1" },
            ),
            fauxToolCall(
              "bash",
              { command: `printf 'const value = stolen;\\n' > ${SOURCE}` },
              { id: "bash-1" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("reported denial"),
      ]);
      const agent = await JuncoAgent.fromResolved({
        ...options,
        collection,
        tools: [],
        tool_block: [],
        prompt: "take the file",
      });
      const results = new Map<string, boolean>();
      agent.events.on("tool_end", (event) => {
        results.set(event.toolCallId, event.isError);
      });

      const paused = await agent.next();
      assert.equal(paused.done, false);
      assert.equal(paused.value?.kind, "yield");
      const reasons =
        paused.value?.kind === "yield" ? paused.value.reasons : [];
      assert.deepEqual(
        reasons.map(({ kind, toolCallId, toolName }) => [
          kind,
          toolCallId,
          toolName,
        ]),
        [
          ["policy", "edit-1", "edit"],
          ["policy", "ast-1", "ast_edit"],
          ["policy", "bash-1", "bash"],
        ],
      );
      assert.deepEqual(Object.fromEntries(results), {
        "edit-1": true,
        "ast-1": true,
        "bash-1": true,
      });
      assert.equal(await readFile(join(seed, SOURCE), "utf8"), OWNED);
      await flushMacrotasks();
      assert.equal(faux.state.callCount, 1);

      const settled = await agent.next();
      assert.equal(settled.value?.kind, "settled");
      assert.ok(
        settled.value?.kind === "settled" &&
          settled.value.message.content.some(
            (block) =>
              block.type === "text" && block.text === "reported denial",
          ),
      );
      assert.equal(faux.state.callCount, 2);
      assert.equal(await readFile(join(seed, SOURCE), "utf8"), OWNED);

      await agent.return();
    }),
  60_000,
);

test(
  "an empty-policy agent publishes over a foreign claim without a policy yield",
  () =>
    withClaimedSeed(EmptyPolicy, async (seed, collection) => {
      const { faux, options } = await nativeOptions([
        fauxAssistantMessage(
          fauxToolCall(
            "bash",
            { command: `printf 'const value = stolen;\\n' > ${SOURCE}` },
            { id: "bash-1" },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("published"),
      ]);
      const agent = await JuncoAgent.fromResolved({
        ...options,
        collection,
        tools: [],
        tool_block: [],
        prompt: "take the file",
      });
      try {
        const settled = await agent.next();
        assert.equal(settled.value?.kind, "settled");
        assert.equal(faux.state.callCount, 2);
        assert.equal(
          await readFile(join(seed, SOURCE), "utf8"),
          "const value = stolen;\n",
        );
      } finally {
        await agent.return();
      }
    }),
  60_000,
);

test(
  "node policy validates the agent's collection",
  () =>
    withClaimedSeed(LockPolicy, async (_seed, collection) => {
      const { options } = await nativeOptions([
        fauxAssistantMessage("registered"),
      ]);
      const agent = await JuncoAgent.fromResolved({
        ...options,
        collection,
        tools: [],
        tool_block: [],
      });
      const ports = terminalPorts();
      const graphContext = policyContext(ports.source, ports.sink, "parallel");
      const graph = graphContext.graph;
      try {
        const id = NodeId.create("bound");
        assert.throws(
          () =>
            graph.addNode({
              id,
              policy: EmptyPolicy,
              trigger: TriggerRule.always(),
              state: agent,
            }),
          TypeError,
        );
        agent.stagePrompt("go");
        graph.addNode({
          id,
          policy: LockPolicy,
          trigger: TriggerRule.always(),
          state: agent,
        });
        ports.connect(graph, id);
        const result = await graphContext.run();
        assert.equal(contentText(result.get(id)!.content), "registered");
      } finally {
        await graph.close();
      }
    }),
  60_000,
);
