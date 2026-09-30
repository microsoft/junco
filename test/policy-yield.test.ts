import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { JuncoAgent } from "junco-agent";
import { createBashTool, createShellMuxOperations, isMarshPolicyDenied, ToolCollection } from "junco-tools";
import { flushMacrotasks, nativeOptions } from "./support.ts";

// Real Marsh policy through junco-tools' test addon: a CopyTree fixture filesystem with the sandbox
// always on. Build it once in ../junco-tools with `npm run build:native:test`.
const toolsRoot = dirname(dirname(fileURLToPath(import.meta.resolve("junco-tools"))));
const native = await import(join(toolsRoot, "target/native-test/index.js"));

const SOURCE = "src/claimed.ts";
const OWNED = "const value = owned;\n";

test(
  "a real Marsh denial pauses the run as a policy yield and publishes nothing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "junco-agency-policy-"));
    const seed = join(root, "seed");
    await mkdir(join(seed, "src"), { recursive: true });
    await writeFile(join(seed, SOURCE), "const value = seed;\n");
    const mux = await native.NativeMux.openCopyTree(seed, { sandbox: "always" });
    try {
      // Borrowed: the mux's sandbox was fixed when it opened.
      const collection = await ToolCollection.create(seed, { mux, native });
      const claim = createBashTool(seed, { operations: createShellMuxOperations({ mux, principal: "other-owner" }) });
      await claim.execute("claim", { command: `printf 'const value = owned;\\n' > ${SOURCE}` }, undefined);
      assert.equal(await readFile(join(seed, SOURCE), "utf8"), OWNED);

      const byName = new Map(collection.tools.map((tool) => [tool.name, tool]));
      const read = await byName.get("read")!.execute("read", { path: SOURCE }, undefined, undefined);
      const readText = read.content.map((part) => (part.type === "text" ? part.text : "")).join("");
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
            fauxToolCall("edit", { input: `[${SOURCE}#${tag}]\nPUT 1.=1:\n+const value = stolen;\n` }, { id: "edit-1" }),
            fauxToolCall("ast_edit", { rewrites: { owned: "stolen" }, path: SOURCE, dryRun: false }, { id: "ast-1" }),
            fauxToolCall("bash", { command: `printf 'const value = stolen;\\n' > ${SOURCE}` }, { id: "bash-1" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("reported denial"),
      ]);
      const agent = new JuncoAgent({ ...options, tools: observed, prompt: "take the file" });
      const results = new Map<string, boolean>();
      agent.subscribe((event) => {
        if (event.type === "tool_execution_end") results.set(event.toolCallId, event.isError);
      });

      const paused = await agent.next();
      assert.equal(paused.done, false);
      assert.equal(paused.value?.kind, "yield");
      const reasons = paused.value?.kind === "yield" ? paused.value.reasons : [];
      assert.deepEqual(
        reasons.map(({ kind, toolCallId, toolName }) => [kind, toolCallId, toolName]),
        [
          ["policy", "edit-1", "edit"],
          ["policy", "ast-1", "ast_edit"],
          ["policy", "bash-1", "bash"],
        ],
      );
      assert.equal(raw.length, 3);
      assert.ok(raw.every(isMarshPolicyDenied));
      assert.deepEqual(Object.fromEntries(results), { "edit-1": true, "ast-1": true, "bash-1": true });
      assert.equal(await readFile(join(seed, SOURCE), "utf8"), OWNED);
      await flushMacrotasks();
      assert.equal(faux.state.callCount, 1);

      const settled = await agent.next();
      assert.equal(settled.value?.kind, "settled");
      assert.ok(
        settled.value?.kind === "settled" &&
          settled.value.message.content.some((block) => block.type === "text" && block.text === "reported denial"),
      );
      assert.equal(faux.state.callCount, 2);
      assert.deepEqual(Object.fromEntries(attempts), { edit: 1, ast_edit: 1, bash: 1 });
      assert.equal(await readFile(join(seed, SOURCE), "utf8"), OWNED);

      await agent.return();
      await collection.close();
    } finally {
      await mux.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
