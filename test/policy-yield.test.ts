import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { JuncoAgent, JuncoAgentError } from "junco-agent";
import { JuncoMcpTools } from "junco-mcp";
import {
  createBashTool,
  createShellMuxOperations,
  isMarshPolicyDenied,
  type NativeModule,
  ToolCollection,
  type ToolCollectionOptions,
} from "junco-tools";
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
  policy: ToolCollectionOptions["policy"],
  body: (seed: string, collection: ToolCollection) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "junco-agency-policy-"));
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
      const operations = createShellMuxOperations({
        mux: collection.mux,
        native: copyTree,
        principal: "other-owner",
      });
      try {
        await createBashTool(seed, { operations }).execute(
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
    withClaimedSeed("GitPolicy", async (seed, collection) => {
      const byName = new Map(collection.tools.map((tool) => [tool.name, tool]));
      const read = await byName
        .get("read")!
        .execute("read", { path: SOURCE }, undefined, undefined);
      const readText = read.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const tag = /#([0-9A-Fa-f]{4})\]/.exec(readText)?.[1];
      assert.ok(tag, readText);

      // Observe each tool's raw rejection before Pi reduces it to a text tool result.
      const raw: unknown[] = [];
      const attempts = new Map<string, number>();
      const observed = collection.tools.map(
        (tool): AgentTool => ({
          ...tool,
          execute: async (...args) => {
            attempts.set(tool.name, (attempts.get(tool.name) ?? 0) + 1);
            try {
              return await tool.execute(...args);
            } catch (error) {
              raw.push(error);
              throw error;
            }
          },
        }),
      );
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
        tools: observed,
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
      assert.equal(raw.length, 3);
      assert.ok(raw.every(isMarshPolicyDenied));
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
      assert.deepEqual(Object.fromEntries(attempts), {
        edit: 1,
        ast_edit: 1,
        bash: 1,
      });
      assert.equal(await readFile(join(seed, SOURCE), "utf8"), OWNED);

      await agent.return();
    }),
  60_000,
);

test(
  "an empty-policy agent publishes over a foreign claim without a policy yield",
  () =>
    withClaimedSeed("EmptyPolicy", async (seed, collection) => {
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
        policy: "EmptyPolicy",
        collection,
        tools: collection.tools.filter((tool) => tool.name === "bash"),
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
  "a mismatched collection is rejected before any MCP server starts and stays usable",
  () =>
    withClaimedSeed("GitPolicy", async (seed, collection) => {
      const marker = join(seed, "started");
      const { options } = await nativeOptions();
      await assert.rejects(
        JuncoAgent.fromResolved({
          ...options,
          policy: "EmptyPolicy",
          collection,
          cwd: seed,
          tools: JuncoMcpTools.add({
            name: "never",
            type: "stdio",
            command: "sh",
            args: ["-c", `touch ${marker}`],
          }),
        }),
        (error: unknown) =>
          error instanceof JuncoAgentError &&
          error.code === "invalid_argument" &&
          error.message === "Collection policy does not match agent policy",
      );
      await assert.rejects(readFile(marker));
      const bash = collection.tools.find((tool) => tool.name === "bash")!;
      const result = await bash.execute(
        "after",
        { command: "printf usable" },
        undefined,
      );
      assert.ok(
        result.content.some(
          (part) => part.type === "text" && part.text.includes("usable"),
        ),
      );
    }),
  60_000,
);
