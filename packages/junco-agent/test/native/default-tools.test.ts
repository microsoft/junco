import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  type Context,
  contentText,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { LockPolicy, type NativeModule, ToolCollection } from "junco-tools";
import { Type } from "typebox";
import * as testAddon from "../../../junco-tools/target/native-test/index.js";
import {
  type AgenticOptions,
  JuncoAgent,
  JuncoAgentError,
} from "../../src/index.ts";
import { fauxRuntime, scripted } from "../../../../test/support.ts";
import { withNativeCleanup } from "../../../../test/native-support.ts";

const TIMEOUT = 60_000;
const NATIVE = [
  "read",
  "bash",
  "edit",
  "release",
  "grep",
  "find",
  "ast_grep",
  "ast_edit",
  "diff",
  "code_graph",
] as const;
const DEFAULTS = [...NATIVE, "task", "yield", "send", "info", "complain"];
const copyTree = {
  ...testAddon,
  NativeMux: { open: testAddon.NativeMux.openCopyTree.bind(testAddon.NativeMux) },
} as unknown as NativeModule;

let root: string;
let seed: string;
let collection: ToolCollection;

beforeAll(async () => {
  root = await mkdtemp(
    fileURLToPath(new URL("../../../junco-tools/target/default-tools-", import.meta.url)),
  );
  seed = join(root, "seed");
  await mkdir(join(seed, "src"), { recursive: true });
  await writeFile(join(seed, "src/a.ts"), "export function foo() { return 1 }\n");
  collection = await ToolCollection.create(seed, {
    native: copyTree,
    policy: LockPolicy,
    sandbox: "always",
  });
});

afterAll(async () => {
  try {
    await collection?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const foo: AgentTool = {
  name: "foo",
  label: "foo",
  description: "extra tool",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "extra-ok" }], details: undefined }),
};

function latest(context: Context) {
  const result = context.messages.findLast((message) => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  return result;
}

class Derived extends JuncoAgent {
  static async make(options: AgenticOptions): Promise<Derived> {
    const agent = new Derived(options);
    await agent.initialize();
    return agent;
  }
}

async function resolved(tools?: AgentTool[], tool_block?: readonly string[]) {
  const runtime = scripted([]);
  return JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models: runtime.models,
    model: runtime.model,
    systemPrompt: "sys",
    collection,
    ...(tools === undefined ? {} : { tools }),
    ...(tool_block === undefined ? {} : { tool_block }),
  });
}

test("create, fromResolved and protected initialization compose additive defaults", async () => {
  await withNativeCleanup(async (defer) => {
    const { models } = await fauxRuntime([]);
    const created = await JuncoAgent.create({
      models,
      provider: "faux",
      model: "faux-1",
      collection,
      tools: [],
    });
    defer(() => created.return());
    const direct = await resolved([foo]);
    defer(() => direct.return());
    const runtime = scripted([]);
    const derived = await Derived.make({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models: runtime.models,
      model: runtime.model,
      collection,
      tools: [],
    });
    defer(() => derived.return());

    assert.deepEqual(created.getTools().map(({ name }) => name), DEFAULTS);
    assert.deepEqual(derived.getTools().map(({ name }) => name), DEFAULTS);
    assert.deepEqual(direct.getTools().map(({ name }) => name), [...DEFAULTS.slice(0, -1), "foo", "complain"]);
    assert.equal(new Set(direct.getTools().map(({ name }) => name)).size, direct.getTools().length);
  });
}, TIMEOUT);

test("added tools execute while an exact blocked native name is absent", async () => {
  await withNativeCleanup(async (defer) => {
    const declarations: string[][] = [];
    const runtime = scripted([
      (context) => {
        declarations.push(getCurrentTools(context.messages).map(({ name }) => name));
        return fauxAssistantMessage(fauxToolCall("read", { path: "src/a.ts" }), { stopReason: "toolUse" });
      },
      (context) => {
        assert.match(contentText(latest(context).content), /return 1/);
        return fauxAssistantMessage(fauxToolCall("foo", {}), { stopReason: "toolUse" });
      },
      (context) => {
        assert.equal(contentText(latest(context).content), "extra-ok");
        return fauxAssistantMessage(
          fauxToolCall("bash", { command: "printf forbidden > blocked.txt" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        assert.equal(latest(context).isError, true);
        return fauxAssistantMessage("done");
      },
    ]);
    const agent = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models: runtime.models,
      model: runtime.model,
      collection,
      tools: [foo],
      tool_block: ["bash"],
    });
    defer(() => agent.return());
    assert.equal(contentText((await agent.prompt("go")).content), "done");
    assert.ok(!agent.getTools().some(({ name }) => name === "bash"));
    assert.ok(!declarations[0]!.includes("bash"));
    await assert.rejects(access(join(seed, "blocked.txt")), { code: "ENOENT" });
  });
}, TIMEOUT);

test("all ten native defaults execute through one agent run", async () => {
  await withNativeCleanup(async (defer) => {
    await writeFile(join(seed, "src/a.ts"), "export function foo() { return 1 }\n");
    let tag = "";
    const calls: [string, object][] = [
      ["read", { path: "src/a.ts" }],
      ["edit", {}],
      ["grep", { pattern: "return 2", path: "src" }],
      ["find", { pattern: "*.ts", path: "src" }],
      ["ast_grep", { patterns: ["2"], path: "src", lang: "typescript" }],
      ["ast_edit", { rewrites: { "2": "3" }, path: "src/a.ts", dryRun: true }],
      ["code_graph", { action: "search", query: "foo" }],
      ["diff", { oldText: "old\n", newText: "new\n", context: 0 }],
      ["bash", { command: "printf native-default-ok" }],
      ["release", { file: "src/a.ts" }],
    ];
    const runtime = scripted([
      ...calls.map(([name, base], index) => (context: Context) => {
        if (index > 0) {
          const result = latest(context);
          assert.equal(result.isError, false, `${calls[index - 1]![0]} failed: ${contentText(result.content)}`);
          const text = contentText(result.content);
          if (index === 1) {
            tag = /#([0-9A-Fa-f]{4})\]/.exec(text)?.[1] ?? "";
            assert.ok(tag, text);
          }
        }
        const args = name === "edit"
          ? { input: `[src/a.ts#${tag}]\nPUT 1.=1:\n+export function foo() { return 2 }\n` }
          : base;
        return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
      }),
      (context) => {
        const result = latest(context);
        assert.equal(result.isError, false, contentText(result.content));
        return fauxAssistantMessage("native complete");
      },
    ]);
    const agent = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models: runtime.models,
      model: runtime.model,
      collection,
    });
    defer(() => agent.return());
    assert.equal(contentText((await agent.prompt("exercise defaults")).content), "native complete");
    assert.equal(await readFile(join(seed, "src/a.ts"), "utf8"), "export function foo() { return 2 }\n");
  });
}, TIMEOUT);

test("custom defaults execute and survive inactive inheritance and atomic mutations", async () => {
  await withNativeCleanup(async (defer) => {
    const nativeBash = collection.tools.find((tool) => tool.name === "bash")!;
    const customBash: AgentTool = {
      ...nativeBash,
      execute: async () => {
        await writeFile(join(seed, "custom-marker.txt"), "custom");
        return { content: [{ type: "text", text: "custom-bash" }], details: undefined };
      },
    };
    const customComplain = { ...foo, name: "complain" };
    const customRelease = { ...foo, name: "release" };
    const runtime = scripted([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf forbidden > forbidden-marker.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const parent = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models: runtime.models, model: runtime.model, collection,
      tools: [customBash, customComplain, customRelease],
    });
    defer(() => parent.return());
    await parent.prompt("custom shell");
    assert.equal(await readFile(join(seed, "custom-marker.txt"), "utf8"), "custom");
    await assert.rejects(access(join(seed, "forbidden-marker.txt")), { code: "ENOENT" });
    assert.equal(collection.tools.find((tool) => tool.name === "bash"), nativeBash);
    await parent.setActiveTools([]);
    const children = await parent.createSubagents([{}, { tools: [] }, { tool_block: ["bash", "complain", "release"] }]);
    for (const child of children) defer(() => child.return());
    for (const child of children.slice(0, 2))
      for (const tool of [customBash, customComplain, customRelease])
        assert.ok(child.getActiveTools().includes(tool));
    assert.ok(!children[2]!.getTools().some((tool) => ["bash", "complain", "release"].includes(tool.name)));
    await rm(join(seed, "custom-marker.txt"));
    runtime.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf forbidden > forbidden-marker.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await children[1]!.prompt("empty selection shell");
    assert.equal(await readFile(join(seed, "custom-marker.txt"), "utf8"), "custom");
    await assert.rejects(access(join(seed, "forbidden-marker.txt")), { code: "ENOENT" });
    const nextBash = { ...foo, name: "bash" };
    await parent.setTools([nextBash, customComplain, customRelease], []);
    await assert.rejects(parent.setTools([customBash, customComplain, customRelease], ["unknown"]), /Unknown active tool/);
    const [committed] = await parent.createSubagents([{ tools: [] }]);
    defer(() => committed!.return());
    assert.deepEqual(committed!.getTools().filter((tool) => tool.name === "bash"), [nextBash]);
    const collectionless = await resolvedCollectionless(customRelease);
    defer(() => collectionless.return());
    assert.equal(collectionless.collection, undefined);
    await collectionless.setActiveTools([]);
    assert.ok(collectionless.getActiveTools().includes(customRelease));
    assert.equal(contentText((await collectionless.prompt("custom release")).content), "released");
    await collectionless.setTools([], []);
    assert.ok(!collectionless.getTools().some((tool) => tool.name === "release"));
  });
}, TIMEOUT);

async function resolvedCollectionless(release: AgentTool) {
  const runtime = scripted([
    fauxAssistantMessage(fauxToolCall("release", {}), { stopReason: "toolUse" }),
    (context) => {
      assert.equal(contentText(latest(context).content), "extra-ok");
      return fauxAssistantMessage("released");
    },
  ]);
  return JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models: runtime.models, model: runtime.model, tools: [release],
    tool_block: NATIVE.filter((name) => name !== "release"),
  });
}

test("blocking native defaults avoids collection acquisition and all defaults may be empty", async () => {
  await withNativeCleanup(async (defer) => {
    const directory = await mkdtemp(join(root, "ordinary-"));
    defer(() => rm(directory, { recursive: true, force: true }));
    const runtime = scripted([fauxAssistantMessage("tool-free")]);
    const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
    const agent = await JuncoAgent.fromResolved({
      session,
      models: runtime.models,
      model: runtime.model,
      cwd: directory,
      tools: [],
      tool_block: [...DEFAULTS],
    });
    defer(() => agent.return());
    assert.equal(agent.collection, undefined);
    assert.deepEqual(agent.getTools(), []);
    assert.equal(contentText((await agent.prompt("go")).content), "tool-free");

  });
}, TIMEOUT);

test("conflicts and blocked mutations fail without changing usable state", async () => {
  await assert.rejects(resolved([foo], ["foo"]), /tools and tool_block both list "foo"/);
  const read = collection.tools.find((tool) => tool.name === "read")!;
  const same = await resolved([read]);
  try {
    assert.equal(same.getTools().filter((tool) => tool === read).length, 1);
  } finally {
    await same.return();
  }
  const customRead = { ...read };
  const replaced = await resolved([customRead]);
  try {
    assert.deepEqual(replaced.getTools().filter((tool) => tool.name === "read"), [customRead]);
    assert.ok(collection.tools.includes(read));
  } finally {
    await replaced.return();
  }
  await assert.rejects(resolved([read, customRead]), /Duplicate tool name: read/);

  const blocked = await resolved(undefined, ["bash", "complain", "release"]);
  try {
    const before = blocked.getTools();
    assert.ok(!before.some(({ name }) => ["bash", "complain", "release"].includes(name)));
    await assert.rejects(blocked.setTools([foo, { ...foo, name: "bash" }]), /tools and tool_block/);
    assert.deepEqual(blocked.getTools(), before);
  } finally {
    await blocked.return();
  }
}, TIMEOUT);

test("tool_pruning deactivates never-called collection tools from the eleventh run on", async () => {
  await withNativeCleanup(async (defer) => {
    const pruning = await ToolCollection.create(seed, {
      native: copyTree,
      policy: LockPolicy,
      sandbox: "always",
      tool_pruning: true,
    });
    defer(() => pruning.close());
    const offered: string[][] = [];
    const answer = (context: Context) => {
      offered.push(getCurrentTools(context.messages).map(({ name }) => name).sort());
      return fauxAssistantMessage("answered");
    };
    const runtime = scripted([
      () => fauxAssistantMessage(fauxToolCall("read", { path: "src/a.ts" }), { stopReason: "toolUse" }),
      answer,
      ...Array.from({ length: 10 }, () => answer),
    ]);
    const agent = await JuncoAgent.fromResolved({
      session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
      models: runtime.models,
      model: runtime.model,
      collection: pruning,
    });
    defer(() => agent.return());
    for (let run = 1; run <= 11; run++) await agent.prompt(`run ${run}`);
    const unused = ["bash", "edit", "grep", "find", "ast_grep", "ast_edit", "diff", "code_graph"];
    assert.equal(offered.length, 11);
    assert.deepEqual(offered[9], [...DEFAULTS].sort());
    assert.deepEqual(offered[10], offered[9]!.filter((name) => !unused.includes(name)));
    assert.deepEqual(
      agent.getActiveTools().map(({ name }) => name),
      ["read", "release", "task", "yield", "send", "info", "complain"],
    );
  });
}, TIMEOUT);
