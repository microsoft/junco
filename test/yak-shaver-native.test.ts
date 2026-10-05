import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMarshPolicyDenied, type NativeMux } from "junco-tools";
import { type AcceptedRefactor, applyRefactor, refreshGraftSnapshot, type SourceEdit } from "../examples/yak-shaver.ts";
import { withNativeCleanup } from "./native-support.ts";

// Real Marsh publication through junco-tools' test addon: a CopyTree fixture with the sandbox
// always on. Build it once in packages/junco-tools with `bun run build:native:test`. Every case
// owns a temporary Git repository; Git setup runs only inside that fixture.
const native = await import(
  fileURLToPath(new URL("../packages/junco-tools/target/native-test/index.js", import.meta.url))
);

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM16 = Buffer.from([0xff, 0xfe]);
const utf16 = (text: string) => Buffer.concat([BOM16, Buffer.from(text, "utf16le")]);

type Fixture = { readonly seed: string; readonly mux: NativeMux; readonly git: (...args: string[]) => string };

/** A committed Git repository holding `files`, and the one native mux over it. */
async function withRepository(
  files: Readonly<Record<string, string | Uint8Array>>,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  await withNativeCleanup(async (defer) => {
    const root = await mkdtemp(join(tmpdir(), "junco-agency-yak-"));
    defer(() => rm(root, { recursive: true, force: true }));
    const seed = join(root, "seed");
    await mkdir(seed);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: seed, encoding: "utf8" });
    git("init", "--quiet");
    // Index blobs hold the exact bytes, whatever the user's global line-ending conversion.
    git("config", "core.autocrlf", "false");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(seed, path)), { recursive: true });
      await writeFile(join(seed, path), content);
    }
    git("add", "--all");
    git("-c", "user.name=Yak Test", "-c", "user.email=yak@test.invalid", "commit", "--quiet", "-m", "baseline");
    const mux: NativeMux = await native.NativeMux.openCopyTree(seed, { sandbox: "always" });
    defer(() => mux.close());
    await body({ seed, mux, git });
  });
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function baselineOf(seed: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const baseline = new Map<string, string | null>();
  for (const path of paths) {
    try {
      baseline.set(path, sha256(await readFile(join(seed, path))));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      baseline.set(path, null);
    }
  }
  return baseline;
}

/** A reviewed refactor carrying `edits`; the applier reads only its rank and proposal edits. */
function accepted(rank: number, edits: readonly SourceEdit[]): AcceptedRefactor {
  const refactor: unknown = { rank, candidate: {}, verdict: {}, proposal: { candidateId: `candidate-${rank}`, kind: "proposal", edits } };
  // Fabricated: candidate/verdict/metrics are irrelevant to application and not built here.
  return refactor as AcceptedRefactor;
}

const replace = (path: string, startLine: number, beforeLines: string[], afterLines: string[]): SourceEdit => ({
  kind: "replace",
  path,
  startLine,
  beforeLines,
  afterLines,
});

/** Applies `edits` against the current bytes of their paths (`null` for each created path). */
async function apply(fixture: Fixture, rank: number, edits: readonly SourceEdit[], overrides: Readonly<Record<string, string | null>> = {}) {
  const baseline = await baselineOf(fixture.seed, [...new Set(edits.map((edit) => edit.path))]);
  for (const [path, hash] of Object.entries(overrides)) baseline.set(path, hash);
  return applyRefactor(fixture.seed, fixture.mux, accepted(rank, edits), baseline);
}

/** The repository's observable state: every non-.git file's bytes plus the index and status. */
async function state(fixture: Fixture) {
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`);
      else files[path] = entry.isSymbolicLink() ? "symlink" : sha256(await readFile(join(dir, entry.name)));
    }
  };
  await walk(fixture.seed, "");
  return { files, index: fixture.git("ls-files", "--stage"), status: fixture.git("status", "--porcelain=v1", "--ignored") };
}

const indexBlob = (fixture: Fixture, path: string) => fixture.git("ls-files", "--stage", "--", path).split(/\s+/)[1];
const blobOf = (fixture: Fixture, path: string) => fixture.git("hash-object", "--no-filters", "--", path).trim();

const QUOTED = "dir with space/it's \"q\".ts";

test("applies a multi-file refactor in place and stages exactly its paths", async () => {
  await withRepository(
    {
      "lf.ts": "a\nb\nc\n",
      "mixed.ts": "x\r\ny\nz",
      "bom8.ts": Buffer.concat([BOM8, Buffer.from("const é = 1;\n")]),
      "wide.ts": utf16("one\r\ntwo\r\n"),
      "emptied.ts": Buffer.concat([BOM8, Buffer.from("gone\n")]),
      [QUOTED]: "q\n",
      "staged.txt": "base\n",
      "untouched.ts": "keep\n",
    },
    async (fixture) => {
      const { seed, git } = fixture;
      await chmod(join(seed, "lf.ts"), 0o755);
      git("add", "lf.ts");
      await writeFile(join(seed, "staged.txt"), "staged change\n");
      git("add", "staged.txt");
      const stagedBefore = indexBlob(fixture, "staged.txt");

      const paths = await apply(fixture, 1, [
        { kind: "replace", path: "lf.ts", startLine: 1, beforeLines: [], afterLines: ["top"] },
        replace("lf.ts", 2, ["b"], ["B1", "B2"]),
        replace("lf.ts", 3, ["c"], []),
        replace("mixed.ts", 1, ["x"], ["X"]),
        { kind: "replace", path: "mixed.ts", startLine: 4, beforeLines: [], afterLines: ["w"] },
        replace("bom8.ts", 1, ["const é = 1;"], ["const ü = 2;"]),
        replace("wide.ts", 2, ["two"], ["deux"]),
        { kind: "replace", path: "wide.ts", startLine: 3, beforeLines: [], afterLines: ["trois"] },
        replace("emptied.ts", 1, ["gone"], []),
        replace(QUOTED, 1, ["q"], ["Q"]),
        { kind: "create", path: "new/dir/created.ts", startLine: 1, beforeLines: [], afterLines: ["export {};", "// new"] },
      ]);
      assert.deepEqual(paths, ["bom8.ts", QUOTED, "emptied.ts", "lf.ts", "mixed.ts", "new/dir/created.ts", "wide.ts"]);

      const expected: Record<string, Buffer> = {
        "lf.ts": Buffer.from("top\na\nB1\nB2\n"),
        "mixed.ts": Buffer.from("X\r\ny\nz\r\nw"),
        "bom8.ts": Buffer.concat([BOM8, Buffer.from("const ü = 2;\n")]),
        "wide.ts": utf16("one\r\ndeux\r\ntrois\r\n"),
        "emptied.ts": BOM8,
        [QUOTED]: Buffer.from("Q\n"),
        "new/dir/created.ts": Buffer.from("export {};\n// new\n"),
      };
      for (const [path, bytes] of Object.entries(expected)) {
        assert.deepEqual(await readFile(join(seed, path)), bytes, path);
        assert.equal(indexBlob(fixture, path), blobOf(fixture, path), `${path} is staged`);
      }
      assert.equal((await stat(join(seed, "lf.ts"))).mode & 0o777, 0o755);
      assert.match(git("ls-files", "--stage", "--", "lf.ts"), /^100755 /);
      assert.equal(indexBlob(fixture, "staged.txt"), stagedBefore);
      assert.equal(await readFile(join(seed, "untouched.ts"), "utf8"), "keep\n");
      assert.equal(git("status", "--porcelain=v1", "--", "untouched.ts"), "");
      assert.equal(git("diff", "--name-only"), "", "nothing touched is left unstaged");

      // A fresh owner edits and stages the same file: the first owner's Stage released it.
      assert.deepEqual(await apply(fixture, 2, [replace("lf.ts", 1, ["top"], ["TOP"])]), ["lf.ts"]);
      assert.equal(await readFile(join(seed, "lf.ts"), "utf8"), "TOP\na\nB1\nB2\n");
      assert.equal(indexBlob(fixture, "lf.ts"), blobOf(fixture, "lf.ts"));
    },
  );
}, 120_000);

test("refused proposals change neither source nor index", async () => {
  await withRepository(
    {
      "valid.ts": "one\n",
      "target.ts": "alpha\nbeta\n",
      "be.ts": Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a]),
      "bad.ts": Buffer.from([0x61, 0xff, 0x0a]),
    },
    async (fixture) => {
      const outside = await mkdtemp(join(tmpdir(), "junco-agency-yak-outside-"));
      try {
        await symlink(outside, join(fixture.seed, "escape"));
        await symlink(join(fixture.seed, "nowhere"), join(fixture.seed, "dangling"));
        const before = await state(fixture);
        const valid = replace("valid.ts", 1, ["one"], ["ONE"]);
        const refusals: readonly [string, readonly SourceEdit[], Record<string, string | null>, RegExp][] = [
          ["wrong baseline hash", [valid, replace("target.ts", 1, ["alpha"], ["A"])], { "target.ts": "0".repeat(64) }, /changed since its batch baseline/],
          ["wrong before text", [valid, replace("target.ts", 2, ["gamma"], ["G"])], {}, /does not match beforeLines/],
          ["out of range", [valid, replace("target.ts", 3, ["x"], [])], {}, /outside target\.ts/],
          ["intra-proposal overlap", [valid, replace("target.ts", 1, ["alpha", "beta"], []), replace("target.ts", 2, ["beta"], ["b"])], {}, /overlap/],
          ["create collision", [valid, { kind: "create", path: "target.ts", startLine: 1, beforeLines: [], afterLines: ["x"] }], { "target.ts": null }, /already exists/],
          ["dangling symlink create", [valid, { kind: "create", path: "dangling", startLine: 1, beforeLines: [], afterLines: ["x"] }], {}, /already exists/],
          ["dangling symlink ancestor", [valid, { kind: "create", path: "dangling/x.ts", startLine: 1, beforeLines: [], afterLines: ["x"] }], {}, /dangling symlink/],
          ["symlink escape", [valid, { kind: "create", path: "escape/x.ts", startLine: 1, beforeLines: [], afterLines: ["x"] }], {}, /outside the repository/],
          ["UTF-16BE source", [valid, replace("be.ts", 1, ["a"], ["b"])], {}, /UTF-16BE source is unsupported/],
          ["malformed UTF-8", [valid, replace("bad.ts", 1, ["a"], ["b"])], {}, /malformed UTF-8/],
        ];
        for (const [name, edits, overrides, message] of refusals) {
          await assert.rejects(apply(fixture, 1, edits, overrides), (error: Error) => {
            assert.match(error.message, message, name);
            assert.match(error.message, /changes were discarded/, name);
            return true;
          });
          assert.deepEqual(await state(fixture), before, name);
        }
        await assert.rejects(
          apply(fixture, 1, [valid, { kind: "create", path: "target.ts", startLine: 1, beforeLines: [], afterLines: ["x"] }]),
          /existed at its batch baseline/,
        );
        await assert.rejects(apply(fixture, 1, [valid, replace("../outside.ts", 1, ["x"], [])]), /not a repo-relative path/);
        assert.deepEqual(await state(fixture), before);
        const aborted = new AbortController();
        aborted.abort(new Error("cancelled before start"));
        await assert.rejects(
          applyRefactor(fixture.seed, fixture.mux, accepted(1, [valid]), await baselineOf(fixture.seed, ["valid.ts"]), aborted.signal),
          /cancelled before start/,
        );
        assert.deepEqual(await state(fixture), before);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
}, 180_000);

test("a failed git add aborts the command and publishes neither private edit", async () => {
  await withRepository({ ".gitignore": "ignored/\n", "tracked.ts": "one\n" }, async (fixture) => {
    const before = await state(fixture);
    await assert.rejects(
      apply(fixture, 3, [
        replace("tracked.ts", 1, ["one"], ["ONE"]),
        { kind: "create", path: "ignored/new.ts", startLine: 1, beforeLines: [], afterLines: ["x"] },
      ]),
      /git add exited 1; its changes were discarded[\s\S]*ignored/,
    );
    assert.deepEqual(await state(fixture), before);
  });
}, 60_000);

test("a foreign unstaged owner's lock denies application despite a fresh read", async () => {
  await withRepository({ "claimed.ts": "seed\n" }, async (fixture) => {
    const claim = fixture.mux.start(
      { command: "cat claimed.ts > /dev/null; printf 'owned\\n' > claimed.ts", cwd: fixture.seed, principal: "other-owner", env: { PATH: process.env.PATH ?? "" } },
      () => {},
    );
    assert.equal((await claim.wait()).exitCode, 0);
    const before = await state(fixture);
    assert.equal(await readFile(join(fixture.seed, "claimed.ts"), "utf8"), "owned\n");
    await assert.rejects(apply(fixture, 4, [replace("claimed.ts", 1, ["owned"], ["stolen"])]), (error: unknown) => {
      assert.ok(isMarshPolicyDenied(error), String(error));
      return true;
    });
    assert.deepEqual(await state(fixture), before);
  });
}, 60_000);

test("refreshGraftSnapshot sees current source without publishing the Graft cache", async () => {
  await withRepository({ ".gitignore": "graft/\n", "src/a.ts": "export class Alpha {}\n" }, async (fixture) => {
    execFileSync("graft", ["build", fixture.seed], { stdio: "ignore" });
    assert.deepEqual(await apply(fixture, 5, [{ kind: "replace", path: "src/a.ts", startLine: 2, beforeLines: [], afterLines: ["export class Beta {}"] }]), [
      "src/a.ts",
    ]);
    const before = await state(fixture);
    const snapshot = await refreshGraftSnapshot(fixture.seed, fixture.mux);
    const names = snapshot.nodes.filter((node) => node.path === "src/a.ts" && node.kind === "class").map((node) => node.name);
    assert.deepEqual(names.sort(), ["Alpha", "Beta"]);
    assert.deepEqual(await state(fixture), before, "the rebuilt cache stays private");
  });
}, 120_000);
