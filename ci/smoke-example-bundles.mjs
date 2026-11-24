import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBtrfsFixture } from "../packages/junco-tools/tests/btrfs-fixture.mjs";

const lane = process.argv[2];
assert.ok(lane === "core" || lane === "native", "Usage: bun ci/smoke-example-bundles.mjs <core|native>");
const root = resolve(import.meta.dir, "..");
const consumer = await mkdtemp(join(tmpdir(), "junco-example-consumer-"));

function run(args, cwd = consumer) {
  const child = spawnSync(process.execPath, ["--no-install", ...args], { cwd, encoding: "utf8" });
  if (child.error) throw child.error;
  return child;
}

try {
  await cp(join(root, "examples/dist"), consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const modules = join(consumer, "node_modules");
  const pi = "@earendil-works";
  await mkdir(join(modules, pi), { recursive: true });
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
    await symlink(await realpath(join(root, "node_modules", pi, name)), join(modules, pi, name), "dir");
  }

  if (lane === "core") {
    // Importing Mixed validates the embedded workflow YAML, without opening an agent collection.
    const mixed = run(["--eval", 'import { goalsPrompt } from "./mixed/mixed.js"; console.log(goalsPrompt);']);
    assert.equal(mixed.status, 0, mixed.stderr);
    assert.equal(mixed.stderr, "");
    const source = Bun.YAML.parse(await Bun.file(join(root, "examples/mixed/mixed.yml")).text());
    assert.equal(source.graph.nodes.Goals.kind, "emit");
    assert.equal(mixed.stdout, `${source.graph.nodes.Goals.text}\n`);

    const committee = run(["oss-committee/oss-committee.js"]);
    assert.equal(committee.status, 1);
    assert.equal(committee.stdout, "");
    assert.match(committee.stderr, /^Usage:/);
    console.log("source-example-bundles: ok");
  } else {
    // Expose the real package's ./native export, not its workspace source or dist entry points.
    const tools = join(modules, "junco-tools");
    const built = join(root, "packages/junco-tools");
    await mkdir(tools);
    await cp(join(built, "package.json"), join(tools, "package.json"));
    await symlink(join(built, "native"), join(tools, "native"), "dir");
    const fixture = await createBtrfsFixture();
    try {
      const recursive = run([join(consumer, "recursive-agency/recursive-agency.js")], fixture.seed);
      assert.equal(recursive.status, 0, recursive.stderr);
      assert.equal(recursive.stderr, "");
      assert.match(recursive.stdout, /^root complete; leaf-result \+ sibling-result; \d+ root decisions\n$/);
      process.stdout.write(recursive.stdout);
    } finally {
      await fixture.close();
    }
  }
} finally {
  await rm(consumer, { recursive: true, force: true });
}
