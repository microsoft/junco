import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { constants as osConstants, homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The repository checkout and its `target/`, derived from this module, never from a caller. */
const checkout = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const targetDir = fileURLToPath(new URL("../target", import.meta.url));

/** Every automatically allocated fixture root is `target/btrfs-test-<random>`. */
const FIXTURE_PREFIX = "btrfs-test-";

/** btrfs gives every subvolume root object id 256; ordinary directories never get it. */
const SUBVOLUME_INO = 256n;

const PREREQUISITE =
  "Automatic btrfs fixture requires target/ on a writable btrfs mount with user_subvol_rm_allowed.";

const OWNED_CWD =
  "Run npm run test:btrfs; this suite requires its automatically created fixture working directory.";

const isAncestor = (candidate, descendant) =>
  descendant === candidate || descendant.startsWith(candidate.endsWith(sep) ? candidate : `${candidate}${sep}`);

/** Run a utility through argument arrays; never a shell string. Failures name the command. */
async function utility(command, args) {
  try {
    return await execFileAsync(command, args, { encoding: "utf8" });
  } catch (error) {
    const detail = `${error.stderr ?? ""}`.trim() || error.message;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

/** The mount carrying `path`, parsed as JSON so paths containing whitespace survive. */
async function mountOf(path) {
  const { stdout } = await utility("findmnt", [
    "--json",
    "--first-only",
    "--target",
    path,
    "--output",
    "FSTYPE,OPTIONS,TARGET",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`findmnt produced invalid JSON for ${path}: ${stdout}`, { cause });
  }
  const entry = parsed?.filesystems?.[0];
  if (!entry || typeof entry.fstype !== "string" || typeof entry.options !== "string") {
    throw new Error(`findmnt reported no usable filesystem for ${path}: ${stdout}`);
  }
  return entry;
}

const describeMount = (path, mount) =>
  `${path} is on ${mount.target} (${mount.fstype}, ${mount.options}).`;

/** The btrfs root id owning `path`. Unprivileged, and a hard failure anywhere but btrfs. */
async function subvolumeId(path) {
  const { stdout } = await utility("btrfs", ["inspect-internal", "rootid", path]);
  const id = Number.parseInt(stdout.trim(), 10);
  if (!Number.isSafeInteger(id)) throw new Error(`btrfs reported no root id for ${path}: ${stdout}`);
  return id;
}

/** A btrfs mount that permits unprivileged subvolume removal, or a hard prerequisite failure. */
async function requireDisposableMount(path) {
  const mount = await mountOf(path);
  if (mount.fstype !== "btrfs" || !mount.options.split(",").includes("user_subvol_rm_allowed")) {
    throw new Error(`${PREREQUISITE} ${describeMount(path, mount)}`);
  }
  return mount;
}

/**
 * The canonical `target/` this module owns fixtures under. `create` is set only by allocation:
 * reading a fixture must never bring the parent into existence.
 */
async function resolveTarget(create) {
  if (create) await mkdir(targetDir, { recursive: true });
  const canonical = await realpath(targetDir);
  await requireDisposableMount(canonical);
  try {
    await access(canonical, constants.W_OK | constants.X_OK);
  } catch (cause) {
    throw new Error(`${PREREQUISITE} ${canonical} is not writable and searchable.`, { cause });
  }
  return canonical;
}

/**
 * The single validation both entry points use: an owned root directly under `target/`, holding a
 * canonical, genuinely empty seed subvolume and an ordinary `tmp` directory. Nothing here accepts a
 * caller-supplied path, so there is no configurable-seed surface.
 */
async function assertOwnedFixture({ root, seed, tmpdir }, target) {
  if (dirname(root) !== target || !basename(root).startsWith(FIXTURE_PREFIX)) {
    throw new Error(`${root} is not an automatically allocated ${join(target, `${FIXTURE_PREFIX}*`)} fixture`);
  }
  if ((await realpath(root)) !== root) throw new Error(`fixture root is not canonical: ${root}`);
  const rootStats = await lstat(root, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.ino === SUBVOLUME_INO) {
    throw new Error(`fixture root is not an ordinary directory: ${root}`);
  }
  if (seed !== join(root, "seed")) throw new Error(`seed must be ${join(root, "seed")}, not ${seed}`);
  if (tmpdir !== join(root, "tmp")) throw new Error(`tmpdir must be ${join(root, "tmp")}, not ${tmpdir}`);

  if ((await realpath(seed)) !== seed) throw new Error(`seed is not canonical: ${seed}`);
  const seedStats = await lstat(seed, { bigint: true });
  if (!seedStats.isDirectory()) throw new Error(`seed is not a directory: ${seed}`);
  if (seedStats.ino !== SUBVOLUME_INO) throw new Error(`seed is not a subvolume root: ${seed}`);
  // `btrfs subvolume show` needs CAP_SYS_ADMIN for its B-tree search, and this lane never sudos.
  // `inspect-internal rootid` is the unprivileged equivalent: it fails outright off btrfs, and a
  // root id distinct from the parent's — with the subvolume's own anonymous device — proves the
  // seed is a genuine separate subvolume rather than a directory that merely holds object id 256.
  const [seedRoot, parentRoot] = await Promise.all([subvolumeId(seed), subvolumeId(root)]);
  if (seedRoot === parentRoot || seedStats.dev === rootStats.dev) {
    throw new Error(`seed is not a distinct subvolume: ${seed} shares root id ${seedRoot} with ${root}`);
  }
  const mount = await requireDisposableMount(seed);
  if (mount.target === seed) throw new Error(`seed must be a subvolume, not a mount root: ${seed}`);
  const entries = await readdir(seed);
  if (entries.length) throw new Error(`seed must start empty: ${seed} holds ${entries.join(", ")}`);

  const tmpStats = await lstat(tmpdir, { bigint: true });
  if (!tmpStats.isDirectory() || tmpStats.ino === SUBVOLUME_INO) {
    throw new Error(`fixture tmpdir is not an ordinary directory: ${tmpdir}`);
  }

  try {
    await access(root, constants.W_OK | constants.X_OK);
  } catch (cause) {
    throw new Error(`the seed's parent is not writable and searchable: ${root}`, { cause });
  }

  const home = await realpath(homedir());
  for (const [label, path] of [["the filesystem root", sep], ["the home directory", home], ["the checkout", checkout]]) {
    for (const [name, owned] of [["root", root], ["seed", seed]]) {
      if (owned === path || isAncestor(owned, path)) {
        throw new Error(`fixture ${name} must not be or contain ${label}: ${owned}`);
      }
    }
  }
}

/** `lstat` with ENOENT as the one absence. Every other error is a real failure. */
async function lstatOrNull(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Owned subvolumes in post-order: every subvolume's children precede it, so teardown deletes
 * the list as it stands and needs no global depth sort over unrelated branches. Symlinks are
 * never followed out of the owned tree.
 */
async function collectSubvolumes(dir, found = []) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const stats = await lstatOrNull(path);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) continue;
    await collectSubvolumes(path, found);
    if (stats.ino === SUBVOLUME_INO) found.push(path);
  }
  return found;
}

/**
 * Reclaim exactly the allocated root. The identity captured at allocation is re-checked, so a
 * replaced directory or a symlink standing in its place is refused rather than removed.
 */
async function teardown(root, identity) {
  const current = await lstatOrNull(root);
  if (current === null) return;
  if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`Refusing to remove ${root}: it is no longer the directory this fixture allocated`);
  }
  // Collected whole before anything is deleted: a traversal failure must never fall through to
  // a broad recursive removal of a tree this module has not finished inspecting.
  const subvolumes = await collectSubvolumes(root);
  for (const path of subvolumes) {
    try {
      await utility("btrfs", ["subvolume", "delete", path]);
    } catch (error) {
      if ((await lstatOrNull(path)) === null) continue;
      throw new Error(`Retained btrfs fixture ${root}: subvolume ${path} could not be deleted`, { cause: error });
    }
  }
  await rm(root, { recursive: true, force: true });
}

/**
 * Allocate a fresh disposable fixture under the repository's `target/`: an ordinary private root
 * holding a real, empty `seed` subvolume and an ordinary `tmp` directory. Accepts nothing; there is
 * no path, option, or environment input, and no fallback when the filesystem is unsuitable.
 */
export async function createBtrfsFixture() {
  const target = await resolveTarget(true);
  const root = await mkdtemp(join(target, FIXTURE_PREFIX));
  // Strict on purpose: an absence here is a setup failure, not a successful cleanup, and an
  // unverified replacement must never be removed.
  let identity;
  try {
    identity = await lstat(root, { bigint: true });
  } catch (cause) {
    throw new Error(`Btrfs fixture identity check failed for ${root}; cleanup refused`, { cause });
  }
  const seed = join(root, "seed");
  const tmpdir = join(root, "tmp");
  // One cached closure over the captured root and identity, used by setup failure and by the
  // caller alike, so neither can reclaim anything the other did not allocate.
  let closing;
  const close = () => (closing ??= teardown(root, identity));
  try {
    await utility("btrfs", ["subvolume", "create", seed]);
    await mkdir(tmpdir);
    await assertOwnedFixture({ root, seed, tmpdir }, target);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to create and reclaim the btrfs fixture at ${root}`);
    }
    throw error;
  }
  return { root, seed, tmpdir, close };
}

/**
 * The fixture a child was handed through its working directory. Only the owned layout is accepted:
 * a general cwd, a seed argument, or an environment setting is never an alternative fixture.
 */
export async function readBtrfsFixture() {
  const target = await resolveTarget(false);
  let root;
  let fixture;
  try {
    root = await realpath(process.cwd());
    fixture = { root, seed: join(root, "seed"), tmpdir: join(root, "tmp") };
    await assertOwnedFixture(fixture, target);
  } catch (cause) {
    throw new Error(OWNED_CWD, { cause });
  }
  return fixture;
}

const SIGNAL_STATUS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
/** Escalation and drain budget: five seconds each, per the lifecycle contract. */
const GRACE_MS = 5_000;
const POLL_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signal one owned process group: `true` when it was delivered, `false` only for `ESRCH`.
 * Every other error propagates with the operation, the group and the original cause, because a
 * refused signal is not a disappearance.
 *
 * `group` is always the positive pid of a detached child this module spawned successfully —
 * never a name, a cwd-derived pid, `0`, or anything a caller supplied.
 */
function signalGroup(group, signal) {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error(`Failed to send ${signal} to btrfs fixture process group ${group}`, { cause: error });
  }
}

/** Poll `signal 0` until the group is gone or the grace budget expires. */
async function waitForGroupExit(group) {
  const deadline = Date.now() + GRACE_MS;
  for (;;) {
    if (!signalGroup(group, 0)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * Prove one owned group is gone: TERM, wait, KILL, wait. An unconfirmed disappearance throws
 * rather than resolving, because subvolumes must not be reclaimed under a process still writing
 * into them. An unexpected probe or signal error ends the drain as unsafe for the same reason.
 */
async function drainGroup(group) {
  if (!signalGroup(group, 0)) return;
  signalGroup(group, "SIGTERM");
  if (await waitForGroupExit(group)) return;
  signalGroup(group, "SIGKILL");
  if (await waitForGroupExit(group)) return;
  throw new Error(`btrfs fixture process group ${group} did not exit within ${GRACE_MS}ms`);
}

/**
 * Own one disposable fixture for the lifetime of one child command. The child is handed the fixture
 * only as its working directory: the environment is passed through untouched.
 */
export async function runBtrfsFixtureCommand(executable, args) {
  const owner = { interrupted: null, group: null, escalation: null, failures: [] };

  const forward = (group, signal) => {
    try {
      signalGroup(group, signal);
    } catch (error) {
      owner.failures.push(error);
    }
  };

  const onSignal = (signal) => {
    owner.interrupted ??= signal;
    const group = owner.group;
    // Before a group exists — and after one was proved gone — an interruption is only recorded:
    // an in-flight allocation and its cleanup finish, and the command is then never launched.
    if (group === null) return;
    forward(group, signal);
    // Armed even when the attempt above failed: the group may well still be there.
    owner.escalation ??= setTimeout(() => forward(group, "SIGKILL"), GRACE_MS);
  };

  const handlers = new Map(Object.keys(SIGNAL_STATUS).map((signal) => [signal, () => onSignal(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);

  let fixture = null;
  let setupError = null;
  let outcome = null;
  let teardownError = null;
  try {
    try {
      fixture = await createBtrfsFixture();
    } catch (error) {
      setupError = error;
    }

    if (fixture && !owner.interrupted) {
      try {
        // One Linux process-group path, as package.json's `os` field declares: a second
        // single-process fallback would be a second shutdown policy. `spawn` can also throw
        // before any child exists, and that failure belongs inside this same boundary.
        const child = spawn(executable, args, {
          cwd: fixture.root,
          stdio: "inherit",
          shell: false,
          detached: true,
        });
        owner.group = typeof child.pid === "number" ? child.pid : null;
        outcome = await new Promise((resolve) => {
          let failure = null;
          // Recorded, never resolved early: the close fence is what says the child is over.
          child.once("error", (error) => {
            failure = error;
          });
          child.once("close", (code, signal) => resolve({ code, signal, failure }));
        });
        if (outcome.failure) setupError = outcome.failure;
      } catch (error) {
        setupError = error;
      }
    }

    if (owner.group !== null) {
      // Nothing of the child's own making may still be writing when the subvolumes go away.
      try {
        await drainGroup(owner.group);
        // Cleared only once absence is proved, which also makes a later signal or escalation
        // callback a no-op beyond recording the interruption.
        owner.group = null;
      } catch (error) {
        teardownError = error;
      }
    }

    if (fixture) {
      if (owner.group === null) {
        try {
          await fixture.close();
        } catch (error) {
          teardownError ??= error;
        }
      } else {
        teardownError = new Error(
          `Retained btrfs fixture ${fixture.root}: process group ${owner.group} is still alive`,
          { cause: teardownError ?? undefined },
        );
      }
    }
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (owner.escalation !== null) {
      clearTimeout(owner.escalation);
      owner.escalation = null;
    }
  }

  let status;
  if (owner.interrupted) status = SIGNAL_STATUS[owner.interrupted];
  else if (setupError) status = 1;
  else if (outcome?.signal) status = 128 + (osConstants.signals[outcome.signal] ?? 0);
  else status = outcome?.code ?? 1;

  if (setupError) {
    // Named with the allocation it belonged to, so a failure with no child at all still
    // identifies the exact root this invocation owned.
    const where = fixture ? ` in ${fixture.root}` : "";
    console.error(`btrfs fixture command failed${where}:`, setupError);
  }
  for (const failure of owner.failures) console.error("btrfs fixture signalling failed:", failure);
  if (teardownError) console.error("btrfs fixture cleanup failed:", teardownError);
  if (status === 0 && (teardownError || owner.failures.length)) status = 1;
  return status;
}
