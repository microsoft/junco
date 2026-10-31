// Two JuncoAgents sharing one ToolCollection over a CopyTree seed of the test-fs addon: each
// agent (and each child) acts as its own policy owner across tool calls and prompts, and only
// that owner's `release` relinquishes what it wrote. The model is Pi's faux provider.

import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  type Context,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { LockPolicy, type NativeModule, ToolCollection } from "junco-tools";
import * as testAddon from "../../../junco-tools/target/native-test/index.js";
import { JuncoAgent } from "../../src/index.ts";
import { scripted } from "../../../../test/support.ts";

const TIMEOUT = 60_000;

const copyTree = {
  ...testAddon,
  NativeMux: { open: testAddon.NativeMux.openCopyTree.bind(testAddon.NativeMux) },
} as unknown as NativeModule;

let root: string;
let seed: string;
let collection: ToolCollection;

beforeAll(async () => {
  root = await mkdtemp(
    fileURLToPath(new URL("../../../junco-tools/target/agent-owner-", import.meta.url)),
  );
  seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, "f.txt"), "seed\n");
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

type Outcome = { readonly isError: boolean; readonly text: string };
type Step = readonly [name: string, args: (previous: Outcome | undefined) => object];

/** The latest tool result of `context`. */
function lastResult(context: Context): Outcome {
  const result = context.messages.findLast((message) => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  return {
    isError: result.isError,
    text: result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(""),
  };
}

/** Prompts `agent` to make each step's tool call in its own turn; resolves every result in order. */
async function drive(
  agent: JuncoAgent,
  faux: FauxProviderHandle,
  steps: readonly Step[],
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  faux.setResponses([
    ...steps.map(([name, args], index) => (context: Context) => {
      const previous = index === 0 ? undefined : lastResult(context);
      if (previous !== undefined) outcomes.push(previous);
      return fauxAssistantMessage([fauxToolCall(name, args(previous), { id: `t${index}` })], {
        stopReason: "toolUse",
      });
    }),
    (context: Context) => {
      outcomes.push(lastResult(context));
      return fauxAssistantMessage("done");
    },
  ]);
  // A policy denial pauses the run as a yield; each next() resumes it until it settles.
  const prompted = agent.prompt("work");
  for (;;) {
    const step = await agent.next();
    assert.equal(step.done, false);
    if (step.value?.kind === "settled") break;
  }
  assert.equal((await prompted).stopReason, "stop");
  return outcomes;
}

const read = (path: string): Step => ["read", () => ({ path })];
const bash = (command: string): Step => ["bash", () => ({ command })];
const release = (file: string): Step => ["release", () => ({ file })];
/** A hashline edit replacing line 1 of `path`, anchored on the previous read's tag. */
const edit = (path: string, line: string): Step => [
  "edit",
  (previous) => {
    const tag = /#([0-9A-Fa-f]{4})\]/.exec(previous?.text ?? "")?.[1];
    assert.ok(tag, `no hashline tag in ${previous?.text}`);
    return { input: `[${path}#${tag}]\nPUT 1.=1:\n+${line}\n` };
  },
];

async function agentOn(faux = scripted([])) {
  const agent = await JuncoAgent.fromResolved({
    session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
    models: faux.models,
    model: faux.model,
    systemPrompt: "sys",
    collection,
    tools: collection.tools,
  });
  return { agent, faux: faux.faux };
}

const errors = (outcomes: readonly Outcome[]) => outcomes.map(({ isError }) => isError);

test(
  "each agent and child owns what it writes until its own release, across prompts",
  async () => {
    const a = await agentOn();
    const b = await agentOn();
    try {
      // A writes through hashline edit and bash.
      assert.deepEqual(
        errors(await drive(a.agent, a.faux, [read("f.txt"), edit("f.txt", "A"), bash("printf a > g.txt")])),
        [false, false, false],
      );
      // B's managed edit and release of A's file are denied.
      const denied = await drive(b.agent, b.faux, [read("f.txt"), edit("f.txt", "B"), release("f.txt")]);
      assert.deepEqual(errors(denied), [false, true, true]);
      assert.equal(await readFile(join(seed, "f.txt"), "utf8"), "A\n");

      // A child of A is its own owner: A's file is foreign to it.
      const [child] = await a.agent.createSubagents([{}]);
      assert.ok(child);
      try {
        assert.ok(child.getActiveTools().some((tool) => tool.name === "release"));
        assert.deepEqual(errors(await drive(child, a.faux, [bash("printf c > g.txt")])), [true]);

        // A, in a later prompt, releases both files.
        assert.deepEqual(
          errors(await drive(a.agent, a.faux, [release("f.txt"), release("g.txt")])),
          [false, false],
        );
        // Native reads supply anchors but deliberately bypass marsh; obtain the fresh Read through bash.
        assert.deepEqual(
          errors(await drive(b.agent, b.faux, [bash("cat f.txt >/dev/null"), read("f.txt"), edit("f.txt", "B")])),
          [false, false, false],
        );
        assert.deepEqual(errors(await drive(child, a.faux, [bash("cat g.txt >/dev/null && printf c > g.txt")])), [false]);
      } finally {
        await child.return();
      }
      assert.equal(await readFile(join(seed, "f.txt"), "utf8"), "B\n");
      assert.equal(await readFile(join(seed, "g.txt"), "utf8"), "c");
    } finally {
      await a.agent.return();
      await b.agent.return();
    }
  },
  TIMEOUT,
);

test(
  "a narrowed tool selection requires release and accepts a custom implementation",
  async () => {
    const { agent, faux } = await agentOn();
    try {
      const genuine = collection.tools.find((tool) => tool.name === "release")!;
      await agent.setActiveTools(["read"]);
      assert.deepEqual(
        agent.getActiveTools().map((tool) => tool.name),
        ["read", "complain", "release"],
      );
      assert.ok(agent.getTools().includes(genuine));
      assert.deepEqual(errors(await drive(agent, faux, [release("unowned.txt")])), [false]);
      let executed = false;
      const custom = { ...genuine, execute: async () => {
        executed = true;
        return { content: [{ type: "text" as const, text: "custom-release" }], details: undefined };
      } };
      await agent.setTools([...collection.tools.filter((tool) => tool !== genuine), custom], ["read"]);
      assert.ok(agent.getActiveTools().includes(custom));
      assert.deepEqual(errors(await drive(agent, faux, [release("unowned.txt")])), [false]);
      assert.equal(executed, true);
    } finally {
      await agent.return();
    }
  },
  TIMEOUT,
);
