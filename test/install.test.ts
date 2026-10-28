import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "../install.ts";

const skill = "junco-example";

async function sourceTree(root: string) {
  const source = join(root, "source");
  const payload = join(source, skill);
  await mkdir(join(payload, "references"), { recursive: true });
  await mkdir(join(payload, "evals"));
  await writeFile(join(payload, "SKILL.md"), "# Example skill\n");
  await writeFile(
    join(payload, "references", "guide.md"),
    "reference payload\n",
  );
  await writeFile(
    join(payload, "evals", "cases.json"),
    '{"case":"preserved"}\n',
  );
  await mkdir(join(source, "evaluation-workspace"));
  return source;
}

test("managed skills replace stale files and retain whole payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "junco-install-"));
  try {
    const source = await sourceTree(root);
    const target = join(root, "harness", "skills");
    const installed = join(target, skill);
    await installSkills(source, [target]);
    await writeFile(join(installed, "obsolete.txt"), "stale managed file\n");
    await writeFile(join(source, skill, "SKILL.md"), "# Updated skill\n");
    await installSkills(source, [target, target]);
    assert.equal(
      await readFile(join(installed, "SKILL.md"), "utf8"),
      "# Updated skill\n",
    );
    assert.equal(
      await readFile(join(installed, ".junco-installed"), "utf8"),
      "junco\n",
    );
    assert.equal(
      await readFile(join(installed, "references", "guide.md"), "utf8"),
      "reference payload\n",
    );
    assert.equal(
      await readFile(join(installed, "evals", "cases.json"), "utf8"),
      '{"case":"preserved"}\n',
    );
    await assert.rejects(lstat(join(installed, "obsolete.txt")), {
      code: "ENOENT",
    });
    await assert.rejects(lstat(join(target, "evaluation-workspace")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a foreign skill collision leaves every destination unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "junco-install-"));
  try {
    const source = await sourceTree(root);
    const first = join(root, "first", "skills");
    const second = join(root, "second", "skills");
    const managed = join(first, skill);
    const foreign = join(second, skill);
    await mkdir(managed, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await writeFile(join(managed, ".junco-installed"), "junco\n");
    await writeFile(join(managed, "SKILL.md"), "previous managed skill\n");
    await writeFile(join(foreign, "sentinel"), "foreign skill stays\n");
    await assert.rejects(
      installSkills(source, [first, second]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(foreign),
    );
    assert.equal(
      await readFile(join(managed, "SKILL.md"), "utf8"),
      "previous managed skill\n",
    );
    assert.equal(
      await readFile(join(managed, ".junco-installed"), "utf8"),
      "junco\n",
    );
    assert.equal(
      await readFile(join(foreign, "sentinel"), "utf8"),
      "foreign skill stays\n",
    );
    await assert.rejects(lstat(join(managed, "references")), {
      code: "ENOENT",
    });
    await assert.rejects(lstat(join(foreign, ".junco-installed")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skill symlink is refused even when its target has a Junco marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "junco-install-"));
  try {
    const source = await sourceTree(root);
    const target = join(root, "harness", "skills");
    const foreign = join(root, "foreign");
    await mkdir(target, { recursive: true });
    await mkdir(foreign);
    await writeFile(join(foreign, ".junco-installed"), "junco\n");
    await writeFile(join(foreign, "sentinel"), "do not follow this link\n");
    const alias = join(target, skill);
    await symlink(foreign, alias);
    await assert.rejects(
      installSkills(source, [target]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(alias),
    );
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal(
      await readFile(join(foreign, "sentinel"), "utf8"),
      "do not follow this link\n",
    );
    await assert.rejects(lstat(join(foreign, "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
