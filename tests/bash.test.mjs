import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NativeMux } from "../target/native-test/index.js";
import { createBashTool, createShellMuxOperations } from "../dist/index.js";

const fixturePrefix = fileURLToPath(new URL("../target/bash-test-", import.meta.url));
const text = (result) => result.content
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("\n");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture() {
  const root = await mkdtemp(fixturePrefix);
  const seed = join(root, "seed");
  try {
    await mkdir(join(seed, "src"), { recursive: true });
    await Promise.all([
      writeFile(join(seed, "src/file0.txt"), "zero\n"),
      writeFile(join(seed, "src/file1.txt"), "one\n"),
    ]);
    const mux = await NativeMux.openCopyTree(seed);
    return { root, seed, mux };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeFixture({ root, mux }, outputFiles = []) {
  try {
    await mux.close();
  } finally {
    await Promise.all([...outputFiles].map((path) => rm(path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
}

test("complete multi-chunk UTF-8 output and final marker precede settlement", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  const outputFiles = new Set();
  try {
    const operations = createShellMuxOperations({ mux: instance.mux, principal: "output-owner" });
    const tool = createBashTool(instance.seed, { operations });
    const expected = "λ🙂".repeat(40000) + "\nFINAL-MARKER-雪\n";
    const producer = "const fs = require('node:fs'); const output = Buffer.from('λ🙂'.repeat(40000) + '\\nFINAL-MARKER-雪\\n'); for (let offset = 0; offset < output.length; offset += 4093) fs.writeSync(1, output.subarray(offset, offset + 4093));";
    const result = await tool.execute("complete-output", {
      command: `${quote(process.execPath)} -e ${quote(producer)}`,
    }, t.signal, (update) => {
      if (update.details?.fullOutputPath) outputFiles.add(update.details.fullOutputPath);
    });
    assert.ok(result.details?.fullOutputPath);
    outputFiles.add(result.details.fullOutputPath);
    assert.equal(await readFile(result.details.fullOutputPath, "utf8"), expected);
    assert.ok(text(result).includes("FINAL-MARKER-雪\n"));
  } finally {
    await closeFixture(instance, outputFiles);
  }
});

test("callback failure rejects without killing Node or disabling the session", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const operations = createShellMuxOperations({ mux: instance.mux, principal: "callback-owner" });
    const tool = createBashTool(instance.seed, { operations });
    let receivedOutput = false;
    await assert.rejects(tool.execute("throwing-consumer", {
      // Readiness comes from the running external, as in marsh's own forced-stop fixtures.
      command: "sh -c 'printf callback-ready; exec sleep 30'",
    }, t.signal, (update) => {
      if (text(update).includes("callback-ready")) {
        receivedOutput = true;
        throw new Error("output consumer failed");
      }
    }), Error);
    assert.equal(receivedOutput, true);
    const result = await tool.execute("reuse-session", { command: "printf 'session survived\\n'" }, t.signal);
    assert.equal(text(result), "session survived\n");
  } finally {
    await closeFixture(instance);
  }
});

test("a zero-exit policy denial leaves all seed contents unchanged", { timeout: 30_000 }, async (t) => {
  const instance = await fixture();
  try {
    const owner = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "file-owner" }),
    });
    const intruder = createBashTool(instance.seed, {
      operations: createShellMuxOperations({ mux: instance.mux, principal: "another-agent" }),
    });
    await owner.execute("claim-file", { command: "printf 'owned\\n' > src/file0.txt" }, t.signal);
    await assert.rejects(intruder.execute("denied-publication", {
      command: "printf 'new\\n' > src/new.txt; printf 'stolen\\n' > src/file0.txt; true",
    }, t.signal), Error);
    assert.equal(await readFile(join(instance.seed, "src/file0.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(instance.seed, "src/file1.txt"), "utf8"), "one\n");
    await assert.rejects(access(join(instance.seed, "src/new.txt")), (error) => error.code === "ENOENT");
  } finally {
    await closeFixture(instance);
  }
});
