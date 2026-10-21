import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySourceEdits,
  captureBaseline,
  EmptyPolicy,
  isMarshPolicyDenied,
  isRepoRelativePath,
  LockPolicy,
  type NativeModule,
  type NativeMux,
  repositorySourceReader,
  requireWorkTreeRoot,
  type SourceEdit,
  ToolCollection,
} from "junco-tools";
import {
  parseSnapshot,
  refreshGraftSnapshot,
} from "../examples/yak-shaver/yak-shaver.ts";
import { withNativeCleanup } from "./native-support.ts";

// Real Marsh publication through junco-tools' test addon: a CopyTree fixture with the sandbox
// always on. Build it once in packages/junco-tools with `bun run build:native:test`. Every case
// owns a temporary Git repository; Git setup runs only inside that fixture.
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
  NativeMux: {
    open: (...args: Parameters<NativeModule["NativeMux"]["open"]>) =>
      native.NativeMux.openCopyTree(...args),
  },
} as NativeModule;

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM16 = Buffer.from([0xff, 0xfe]);
const utf16 = (text: string) =>
  Buffer.concat([BOM16, Buffer.from(text, "utf16le")]);

type Fixture = {
  readonly seed: string;
  /** The protected `LockPolicy` mux: the applier's. */
  readonly mux: NativeMux;
  readonly collection: ToolCollection;
  /** The trusted-build `EmptyPolicy` collection: index refresh's. */
  readonly buildCollection: ToolCollection;
  readonly git: (...args: string[]) => string;
};

/** A committed Git repository holding `files`, and Yak Shaver's two collections over it. */
async function withRepository(
  files: Readonly<Record<string, string | Uint8Array>>,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  await withNativeCleanup(async (defer) => {
    const root = await mkdtemp(join(tmpdir(), "junco-agency-yak-"));
    defer(() => rm(root, { recursive: true, force: true }));
    const seed = join(root, "seed");
    await mkdir(seed);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: seed, encoding: "utf8" });
    git("init", "--quiet");
    // Index blobs hold the exact bytes, whatever the user's global line-ending conversion.
    git("config", "core.autocrlf", "false");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(seed, path)), { recursive: true });
      await writeFile(join(seed, path), content);
    }
    git("add", "--all");
    git(
      "-c",
      "user.name=Yak Test",
      "-c",
      "user.email=yak@test.invalid",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    );
    const protectedTools = await ToolCollection.create(seed, {
      native: copyTree,
      policy: LockPolicy,
      sandbox: "always",
    });
    defer(() => protectedTools.close());
    const buildTools = await ToolCollection.create(seed, {
      native: copyTree,
      policy: EmptyPolicy,
      sandbox: "always",
    });
    defer(() => buildTools.close());
    await body({
      seed,
      mux: protectedTools.mux,
      collection: protectedTools,
      buildCollection: buildTools,
      git,
    });
  });
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const replace = (
  path: string,
  startLine: number,
  beforeLines: string[],
  afterLines: string[],
): SourceEdit => ({
  kind: "replace",
  path,
  startLine,
  beforeLines,
  afterLines,
});

/** Applies `edits` against the current bytes of their paths (`null` for each created path). */
async function apply(
  fixture: Fixture,
  rank: number,
  edits: readonly SourceEdit[],
  overrides: Readonly<Record<string, string | null>> = {},
) {
  const baseline = new Map(
    await captureBaseline(fixture.seed, [
      ...new Set(
        edits.map((edit) => edit.path).filter((path) => !(path in overrides)),
      ),
    ]),
  );
  for (const [path, hash] of Object.entries(overrides))
    baseline.set(path, hash);
  return applySourceEdits(fixture.seed, fixture.mux, edits, baseline, {
    label: `candidate-${rank} (rank ${rank})`,
    principal: `yak-apply-${rank}`,
  });
}

/** The repository's observable state: every non-.git file's bytes plus the index and status. */
async function state(fixture: Fixture) {
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`);
      else
        files[path] = entry.isSymbolicLink()
          ? "symlink"
          : sha256(await readFile(join(dir, entry.name)));
    }
  };
  await walk(fixture.seed, "");
  return {
    files,
    index: fixture.git("ls-files", "--stage"),
    status: fixture.git("status", "--porcelain=v1", "--ignored"),
  };
}

const indexBlob = (fixture: Fixture, path: string) =>
  fixture.git("ls-files", "--stage", "--", path).split(/\s+/)[1];
const blobOf = (fixture: Fixture, path: string) =>
  fixture.git("hash-object", "--no-filters", "--", path).trim();

test("repository baselines and Git-root preflight enforce native and source boundaries", async () => {
  await withRepository(
    { "src/wide.ts": utf16("one\r\ntwo\r\n") },
    async (fixture) => {
      const { seed, collection } = fixture;
      await requireWorkTreeRoot(collection);
      const reason = new Error("preflight cancelled");
      await assert.rejects(
        requireWorkTreeRoot(collection, AbortSignal.abort(reason)),
        (error) => error === reason,
      );
      await withNativeCleanup(async (defer) => {
        const nested = await ToolCollection.create(join(seed, "src"), {
          native: copyTree,
          policy: LockPolicy,
          sandbox: "always",
        });
        defer(() => nested.close());
        await assert.rejects(requireWorkTreeRoot(nested), (error: Error) => {
          assert.match(error.message, /Git working-tree root/);
          assert.ok(error.cause instanceof Error);
          assert.match(error.cause.message, /src\//);
          return true;
        });
      });

      const baseline = await captureBaseline(seed, ["src/wide.ts", "new.ts"]);
      assert.equal(
        baseline.get("src/wide.ts"),
        sha256(utf16("one\r\ntwo\r\n")),
      );
      assert.equal(baseline.get("new.ts"), null);
      const read = repositorySourceReader(seed, baseline);
      assert.equal(await read("src/wide.ts"), "one\r\ntwo\r\n");
      assert.equal(await read("new.ts"), undefined);
      await writeFile(join(seed, "new.ts"), "created\n");
      await assert.rejects(read("new.ts"), /changed since/);
      await writeFile(join(seed, "src/wide.ts"), utf16("changed\n"));
      await assert.rejects(read("src/wide.ts"), /changed since/);

      for (const path of [
        "",
        "/tmp/escape.ts",
        "../escape.ts",
        "src/../escape.ts",
        "src\\escape.ts",
        "src//escape.ts",
        "src/\0.ts",
      ]) {
        assert.equal(isRepoRelativePath(path), false);
        await assert.rejects(
          captureBaseline(seed, [path]),
          /not a repo-relative path/,
        );
        await assert.rejects(read(path), /not a repo-relative path/);
      }
      assert.equal(isRepoRelativePath("src/wide.ts"), true);
      const outside = await mkdtemp(join(tmpdir(), "junco-source-outside-"));
      try {
        await writeFile(join(outside, "secret.ts"), "outside\n");
        await symlink(outside, join(seed, "escape"));
        await symlink(join(seed, "missing"), join(seed, "dangling"));
        for (const path of ["escape/secret.ts", "escape/new.ts"]) {
          await assert.rejects(
            captureBaseline(seed, [path]),
            /outside the repository/,
          );
          await assert.rejects(read(path), /outside the repository/);
        }
        for (const path of ["dangling", "dangling/new.ts"]) {
          await assert.rejects(
            captureBaseline(seed, [path]),
            /dangling symlink/,
          );
          await assert.rejects(read(path), /dangling symlink/);
        }
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
}, 60_000);

const QUOTED = 'dir with space/it\'s "q".ts';

test("applies a multi-file refactor in place and releases exactly its paths", async () => {
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
      const indexBefore = git("ls-files", "--stage");

      const paths = await apply(fixture, 1, [
        {
          kind: "replace",
          path: "lf.ts",
          startLine: 1,
          beforeLines: [],
          afterLines: ["top"],
        },
        replace("lf.ts", 2, ["b"], ["B1", "B2"]),
        replace("lf.ts", 3, ["c"], []),
        replace("mixed.ts", 1, ["x"], ["X"]),
        {
          kind: "replace",
          path: "mixed.ts",
          startLine: 4,
          beforeLines: [],
          afterLines: ["w"],
        },
        replace("bom8.ts", 1, ["const é = 1;"], ["const ü = 2;"]),
        replace("wide.ts", 2, ["two"], ["deux"]),
        {
          kind: "replace",
          path: "wide.ts",
          startLine: 3,
          beforeLines: [],
          afterLines: ["trois"],
        },
        replace("emptied.ts", 1, ["gone"], []),
        replace(QUOTED, 1, ["q"], ["Q"]),
        {
          kind: "create",
          path: "new/dir/created.ts",
          startLine: 1,
          beforeLines: [],
          afterLines: ["export {};", "// new"],
        },
      ]);
      assert.deepEqual(paths, [
        "bom8.ts",
        QUOTED,
        "emptied.ts",
        "lf.ts",
        "mixed.ts",
        "new/dir/created.ts",
        "wide.ts",
      ]);

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
      }
      assert.equal((await stat(join(seed, "lf.ts"))).mode & 0o777, 0o755);
      assert.equal(
        await readFile(join(seed, "untouched.ts"), "utf8"),
        "keep\n",
      );
      assert.equal(git("status", "--porcelain=v1", "--", "untouched.ts"), "");
      assert.equal(
        git("ls-files", "--stage"),
        indexBefore,
        "release stages nothing",
      );

      // A fresh owner edits the same file: the first owner's release relinquished it.
      assert.deepEqual(
        await apply(fixture, 2, [replace("lf.ts", 1, ["top"], ["TOP"])]),
        ["lf.ts"],
      );
      assert.equal(
        await readFile(join(seed, "lf.ts"), "utf8"),
        "TOP\na\nB1\nB2\n",
      );
      assert.equal(git("ls-files", "--stage"), indexBefore);
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
      const outside = await mkdtemp(
        join(tmpdir(), "junco-agency-yak-outside-"),
      );
      try {
        await symlink(outside, join(fixture.seed, "escape"));
        await symlink(
          join(fixture.seed, "nowhere"),
          join(fixture.seed, "dangling"),
        );
        const before = await state(fixture);
        const valid = replace("valid.ts", 1, ["one"], ["ONE"]);
        const refusals: readonly [
          string,
          readonly SourceEdit[],
          Record<string, string | null>,
          RegExp,
        ][] = [
          [
            "wrong baseline hash",
            [valid, replace("target.ts", 1, ["alpha"], ["A"])],
            { "target.ts": "0".repeat(64) },
            /changed since its batch baseline/,
          ],
          [
            "wrong before text",
            [valid, replace("target.ts", 2, ["gamma"], ["G"])],
            {},
            /does not match beforeLines/,
          ],
          [
            "out of range",
            [valid, replace("target.ts", 3, ["x"], [])],
            {},
            /outside target\.ts/,
          ],
          [
            "intra-proposal overlap",
            [
              valid,
              replace("target.ts", 1, ["alpha", "beta"], []),
              replace("target.ts", 2, ["beta"], ["b"]),
            ],
            {},
            /overlap/,
          ],
          [
            "create collision",
            [
              valid,
              {
                kind: "create",
                path: "target.ts",
                startLine: 1,
                beforeLines: [],
                afterLines: ["x"],
              },
            ],
            { "target.ts": null },
            /already exists/,
          ],
          [
            "dangling symlink create",
            [
              valid,
              {
                kind: "create",
                path: "dangling",
                startLine: 1,
                beforeLines: [],
                afterLines: ["x"],
              },
            ],
            { dangling: null },
            /already exists/,
          ],
          [
            "dangling symlink ancestor",
            [
              valid,
              {
                kind: "create",
                path: "dangling/x.ts",
                startLine: 1,
                beforeLines: [],
                afterLines: ["x"],
              },
            ],
            { "dangling/x.ts": null },
            /dangling symlink/,
          ],
          [
            "symlink escape",
            [
              valid,
              {
                kind: "create",
                path: "escape/x.ts",
                startLine: 1,
                beforeLines: [],
                afterLines: ["x"],
              },
            ],
            { "escape/x.ts": null },
            /outside the repository/,
          ],
          [
            "UTF-16BE source",
            [valid, replace("be.ts", 1, ["a"], ["b"])],
            {},
            /UTF-16BE source is unsupported/,
          ],
          [
            "malformed UTF-8",
            [valid, replace("bad.ts", 1, ["a"], ["b"])],
            {},
            /malformed UTF-8/,
          ],
        ];
        for (const [name, edits, overrides, message] of refusals) {
          await assert.rejects(
            apply(fixture, 1, edits, overrides),
            (error: Error) => {
              assert.match(error.message, message, name);
              assert.match(error.message, /changes were discarded/, name);
              return true;
            },
          );
          assert.deepEqual(await state(fixture), before, name);
        }
        await assert.rejects(
          apply(fixture, 1, [
            valid,
            {
              kind: "create",
              path: "target.ts",
              startLine: 1,
              beforeLines: [],
              afterLines: ["x"],
            },
          ]),
          /existed at its batch baseline/,
        );
        await assert.rejects(
          apply(fixture, 1, [valid, replace("../outside.ts", 1, ["x"], [])]),
          /not a repo-relative path/,
        );
        assert.deepEqual(await state(fixture), before);
        const aborted = new AbortController();
        aborted.abort(new Error("cancelled before start"));
        await assert.rejects(
          applySourceEdits(
            fixture.seed,
            fixture.mux,
            [valid],
            await captureBaseline(fixture.seed, ["valid.ts"]),
            {
              label: "cancelled application",
              principal: "cancelled",
              signal: aborted.signal,
            },
          ),
          /cancelled before start/,
        );
        assert.deepEqual(await state(fixture), before);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
}, 180_000);

test("a trusted-build owner's lock denies the LockPolicy applier despite a fresh read", async () => {
  await withRepository({ "claimed.ts": "seed\n" }, async (fixture) => {
    // The EmptyPolicy mux grants its own write; the LockPolicy applier must still respect it.
    const claim = fixture.buildCollection.mux.start(
      {
        command: "cat claimed.ts > /dev/null; printf 'owned\\n' > claimed.ts",
        cwd: fixture.seed,
        principal: "other-owner",
        env: { PATH: process.env.PATH ?? "" },
      },
      () => {},
    );
    assert.equal((await claim.wait()).exitCode, 0);
    const before = await state(fixture);
    assert.equal(
      await readFile(join(fixture.seed, "claimed.ts"), "utf8"),
      "owned\n",
    );
    await assert.rejects(
      apply(fixture, 4, [replace("claimed.ts", 1, ["owned"], ["stolen"])]),
      (error: unknown) => {
        assert.ok(isMarshPolicyDenied(error), String(error));
        return true;
      },
    );
    assert.deepEqual(await state(fixture), before);
  });
}, 60_000);

test("refreshGraftSnapshot sees current source and publishes the refreshed Graft cache", async () => {
  await withRepository(
    { ".gitignore": "graft/\n", "src/a.ts": "export class Alpha {}\n" },
    async (fixture) => {
      execFileSync("graft", ["build", fixture.seed], { stdio: "ignore" });
      assert.deepEqual(
        await apply(fixture, 5, [
          {
            kind: "replace",
            path: "src/a.ts",
            startLine: 2,
            beforeLines: [],
            afterLines: ["export class Beta {}"],
          },
        ]),
        ["src/a.ts"],
      );
      const graphPath = join(fixture.seed, "graft/.graph/wiring.json");
      const stale = parseSnapshot(await readFile(graphPath, "utf8"));
      const before = await state(fixture);
      const aborted = new Error("refresh cancelled");
      await assert.rejects(
        refreshGraftSnapshot(
          fixture.seed,
          fixture.buildCollection,
          AbortSignal.abort(aborted),
        ),
        (error: unknown) => error === aborted,
      );
      assert.deepEqual(await state(fixture), before);

      await withNativeCleanup(async (defer) => {
        const failingCollection = await ToolCollection.create(fixture.seed, {
          native: copyTree,
          policy: EmptyPolicy,
          sandbox: "always",
          bash: {
            spawnHook: (context) => ({
              ...context,
              env: { ...context.env, PATH: join(fixture.seed, "missing-bin") },
            }),
          },
        });
        defer(() => failingCollection.close());
        await assert.rejects(
          refreshGraftSnapshot(fixture.seed, failingCollection),
        );
        assert.deepEqual(await state(fixture), before);
        assert.equal(
          await readFile(join(fixture.seed, "src/a.ts"), "utf8"),
          "export class Alpha {}\nexport class Beta {}\n",
        );
      });

      const snapshot = await refreshGraftSnapshot(
        fixture.seed,
        fixture.buildCollection,
      );
      const names = snapshot.nodes
        .filter((node) => node.path === "src/a.ts" && node.kind === "class")
        .map((node) => node.name);
      assert.deepEqual(names.sort(), ["Alpha", "Beta"]);
      assert.equal(
        parseSnapshot(await readFile(graphPath, "utf8")).sha256,
        snapshot.sha256,
      );
      assert.notEqual(snapshot.sha256, stale.sha256);
      const after = await state(fixture);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(after.files).filter(
            ([path]) => !path.startsWith("graft/"),
          ),
        ),
        Object.fromEntries(
          Object.entries(before.files).filter(
            ([path]) => !path.startsWith("graft/"),
          ),
        ),
      );
      assert.equal(after.index, before.index);
      assert.equal(after.status, before.status);
      assert.equal(
        await readFile(join(fixture.seed, "src/a.ts"), "utf8"),
        "export class Alpha {}\nexport class Beta {}\n",
      );
    },
  );
}, 120_000);
