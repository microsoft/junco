import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const reference = await readFile(new URL("../references/optimization.md", import.meta.url), "utf8");
const fences = [...reference.matchAll(/^```ts measure\.ts\r?\n([\s\S]*?)^```\s*$/gm)];
assert.equal(fences.length, 1, "expected one shipped measure.ts fence");
const session = await mkdtemp(join(tmpdir(), "junco-measure-check-"));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

try {
  await mkdir(join(session, "node_modules"));
  await symlink(repo, join(session, "node_modules", "junco"), "dir");
  await mkdir(join(session, "candidates"));
  await writeFile(join(session, "measure.ts"), fences[0][1]);

  const yamlPath = join(session, "workflow.yml");
  const tsPath = join(session, "workflow.ts");
  const marker = join(session, "spawned-target.txt");
  const baselineYaml = `graph:
  name: MeasurementCheck
  nodes:
    Output:
      kind: code
      trigger: always
  edges:
    - from: Output
      to: $sink
      schema: { type: string }
`;
  const baselineTs = `const bindings = { Output: "complete" };
await Bun.write(${JSON.stringify(marker)}, Object.keys(bindings)[0]);
`;
  const campaign = {
    target: { yaml: yamlPath, ts: tsPath, cwd: session, argv: [process.execPath, "run", tsPath] },
    workloadId: "offline-measure-check",
    expectedTsSha256: "",
    parse: { sourceName: "workflow.yml" },
    quality: "quality",
    secondary: "cost",
  };

  async function archive(name: string, yaml: string, ts: string) {
    await writeFile(join(session, "candidates", `${name}.yml`), yaml);
    await writeFile(join(session, "candidates", `${name}.ts`), ts);
  }

  async function stage(name: string) {
    const archivedTs = join(session, "candidates", `${name}.ts`);
    await copyFile(join(session, "candidates", `${name}.yml`), yamlPath);
    await copyFile(archivedTs, tsPath);
    campaign.expectedTsSha256 = sha256(await readFile(archivedTs, "utf8"));
    await writeFile(join(session, "campaign.json"), JSON.stringify(campaign));
  }

  function measure(...args: string[]) {
    const result = Bun.spawnSync([process.execPath, join(session, "measure.ts"), ...args], {
      cwd: session,
      env: { ...process.env, NODE_PATH: join(repo, "node_modules") },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  function check(yaml: string, ts: string) {
    const result = measure("check");
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.yamlSha256, sha256(yaml));
    assert.equal(output.tsSha256, sha256(ts));
    assert.match(output.graphHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(output.agents, []);
    assert.equal(existsSync(marker), false, "check executed the target");
    return output;
  }

  await archive("incumbent-0", baselineYaml, baselineTs);
  await stage("incumbent-0");
  const baseline = check(baselineYaml, baselineTs);

  const variantYaml = baselineYaml.replaceAll("Output", "Result");
  const variantTs = baselineTs.replaceAll("Output", "Result");
  await archive("binding-variant", variantYaml, variantTs);
  await stage("binding-variant");
  const variant = check(variantYaml, variantTs);
  assert.notEqual(variant.tsSha256, baseline.tsSha256);
  assert.notEqual(variant.yamlSha256, baseline.yamlSha256);
  assert.notEqual(variant.graphHash, baseline.graphHash);

  const driftTs = `${variantTs}// outside edit\n`;
  await writeFile(tsPath, driftTs);
  const rejected = measure("check");
  assert.notEqual(rejected.code, 0, "check accepted TS drift");
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(session, "runs")), false);

  const drift = measure("run", "drift", "1");
  assert.equal(drift.code, 2, `${drift.stdout}\n${drift.stderr}`);
  const batch = JSON.parse(drift.stdout);
  assert.equal(batch.valid, false);
  assert.equal(batch.name, "drift");
  assert.equal(batch.repeats, 1);
  const rows = (await readFile(join(session, "ledger.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.ok, false);
  assert.equal(row.name, "drift");
  assert.equal(row.repeat, 1);
  assert.equal(row.tsBefore, sha256(driftTs));
  assert.equal(row.tsAfter, sha256(driftTs));
  assert.equal(row.yamlSha256, variant.yamlSha256);
  assert.equal(row.graphHash, variant.graphHash);
  assert.equal(row.runDir, undefined);
  assert.equal(existsSync(marker), false, "run spawned a target with TS drift");
  assert.equal(existsSync(join(session, "runs")), false, "run created a directory before rejecting TS drift");

  await stage("incumbent-0");
  assert.deepEqual(check(baselineYaml, baselineTs), baseline);
  console.log("measure.ts CLI regression passed");
} finally {
  await rm(session, { recursive: true, force: true });
}
