// Real native MCP stdio servers on the shared Junco ShellMux, over a CopyTree seed of the
// test-fs addon. Every server is the fixture in ../stdio-server.ts, launched by Marsh's managed
// `exec` in a forced-sandbox pipe shell; nothing here spawns a host child.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { McpAbortError, McpConnectionClosedError } from "@earendil-works/pi-mcp";
import { LockPolicy, type NativeModule, type NativeMux, type NativeProcess, ToolCollection, ShellMuxOperations } from "junco-tools";
import { errorGraph, isMarshPolicyDenied } from "junco-tools/errors";
import * as testAddon from "../../../junco-tools/target/native-test/index.js";
import {
  getJuncoMcpToolIdentity,
  type JuncoMcpConnection,
  type JuncoMcpServerOptions,
  JuncoMcpTools,
  McpBuilder,
} from "../../src/index.ts";
import { ShellMuxStdioTransport } from "../../src/stdio.ts";
import { withNativeCleanup } from "../../../../test/native-support.ts";

const SERVER = fileURLToPath(new URL("../stdio-server.ts", import.meta.url));
const TIMEOUT = 60_000;

// Node's async assertions avoid Bun 1.4.2's nested native TSFN matcher loop.
// https://github.com/oven-sh/bun/issues/36828

/** The real test addon whose `NativeMux.open` opens a CopyTree seed. */
const copyTree = {
  ...testAddon,
  NativeMux: { open: testAddon.NativeMux.openCopyTree.bind(testAddon.NativeMux) },
} as unknown as NativeModule;

let root: string;
let seed: string;
let collection: ToolCollection;

beforeAll(async () => {
  root = await mkdtemp(
    fileURLToPath(new URL("../../../junco-tools/target/mcp-test-", import.meta.url)),
  );
  seed = join(root, "seed");
  await mkdir(join(seed, "sub"), { recursive: true });
  collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy });
});

afterAll(async () => {
  try {
    await collection?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function server(
  name: string,
  extra: Partial<JuncoMcpServerOptions> = {},
): JuncoMcpServerOptions {
  return {
    name,
    type: "stdio",
    command: process.execPath,
    args: [SERVER],
    ...extra,
  } as JuncoMcpServerOptions;
}

function tool(connection: JuncoMcpConnection, name: string): AgentTool {
  const found = connection.tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

async function call(
  connection: JuncoMcpConnection,
  name: string,
  params: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean; structured: unknown }> {
  const result = (await tool(connection, name).execute(
    "call",
    params as never,
  )) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: unknown;
  };
  return {
    text: result.content.map((part) => part.text ?? "").join(""),
    isError: result.isError === true,
    structured: result.structuredContent,
  };
}

async function state(
  connection: JuncoMcpConnection,
  server: string,
  params: Record<string, unknown> = {},
) {
  const { text } = await call(connection, `mcp__${server}__read_state`, params);
  return JSON.parse(text) as {
    pid: number;
    cwd: string;
    argv: string[];
    marker: string | null;
    env: Record<string, string | null>;
    calls: number;
    file: string | null;
  };
}

/** A server's stderr: its start-up pid and a readiness cue. */
function watchStderr(cue?: string) {
  let buffer = "";
  const ready = Promise.withResolvers<void>();
  return {
    ready: ready.promise,
    onStderr(chunk: string) {
      buffer += chunk;
      if (cue !== undefined && buffer.includes(`${cue}\n`)) ready.resolve();
    },
    get text() {
      return buffer;
    },
    pids(): number[] {
      return [...buffer.matchAll(/junco-mcp fixture (\d+): started in/g)].map((match) => Number(match[1]));
    },
    pid(): number {
      const match = /junco-mcp fixture (\d+): started in/.exec(buffer);
      assert.ok(match, `no start-up line in ${JSON.stringify(buffer)}`);
      return Number(match[1]);
    },
  };
}

/** Whether `pid` is a live (not exited) fixture process. */
function fixtureRunning(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(SERVER);
  } catch {
    return false;
  }
}

/** Every message in `error`, its causes, and any aggregated errors. */
function failureMessages(error: unknown): string[] {
  return [...errorGraph(error)].filter((v): v is Error => v instanceof Error).map((e) => e.message);
}

async function rejection(promise: Promise<unknown>): Promise<string[]> {
  const error = await promise.then(
    () => assert.fail("expected a rejection"),
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof Error, String(error));
  return failureMessages(error);
}

async function absent(path: string): Promise<boolean> {
  return access(path).then(
    () => false,
    () => true,
  );
}

const DISCARD_EXIT = "MCP stdio server exited before its effects could be discarded";

describe("native MCP stdio on the shared ShellMux", () => {
  test("servers share the one mux, run concurrently under distinct principals, and keep ordinary work available", async () => {
    const connection = await JuncoMcpTools.add(server("one"))
      .add(server("two", { cwd: "sub", env: { JUNCO_MCP_FIXTURE_MARKER: "second" } }))
      .connect({ cwd: seed, collection });
    try {
      const [first, second] = await Promise.all([
        state(connection, "one"),
        state(connection, "two", { env: ["JUNCO_MCP_FIXTURE_MARKER"] }),
      ]);
      expect(first.pid).not.toBe(second.pid);
      expect(second.marker).toBe("second");
      // The managed view is a private snapshot path; only its seed-relative tail is stable.
      expect(second.cwd.endsWith("/sub")).toBe(true);
      // Successive and concurrent RPCs on one server keep their own process-local count.
      const counts = await Promise.all(
        [1, 2, 3].map(() => state(connection, "one")),
      );
      expect(counts.map((item) => item.pid)).toEqual([first.pid, first.pid, first.pid]);
      expect(new Set(counts.map((item) => item.calls)).size).toBe(3);

      // Ordinary bash on the same collection mux while both servers are live.
      const operations = new ShellMuxOperations({ native: copyTree, mux: collection.mux });
      try {
        const chunks: Buffer[] = [];
        const result = await operations.exec("printf ordinary", seed, {
          onData: (data) => chunks.push(data),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
        });
        expect(result.exitCode).toBe(0);
        expect(Buffer.concat(chunks).toString()).toBe("ordinary");
      } finally {
        await operations.close();
      }
    } finally {
      await connection.close();
    }
  }, TIMEOUT);

  test("argv reaches the program literally through managed exec, including a PATH program named git", async () => {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const git = join(bin, "git");
    await writeFile(
      git,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)} "$@"\n`,
    );
    await chmod(git, 0o755);
    const literal = ["a b", "", "it's \"quoted\"", "; echo injected", "$(id)", "`id`", "*"];
    const connection = await JuncoMcpTools.add(
      server("git", {
        command: "git",
        args: literal,
        env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      }),
    ).connect({ cwd: seed, collection });
    try {
      expect((await state(connection, "git")).argv).toEqual(literal);
    } finally {
      await connection.close();
    }
  }, TIMEOUT);

  test("environment replacement and override reach the server", async () => {
    const connection = await JuncoMcpTools.add(
      server("env", {
        inheritEnv: false,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          JUNCO_MCP_FIXTURE_MARKER: "replaced",
        },
      }),
    ).connect({ cwd: seed, collection });
    try {
      const observed = await state(connection, "env", {
        env: ["JUNCO_MCP_FIXTURE_MARKER", "BUN_INSTALL_CACHE_DIR", "HOME"],
      });
      expect(observed.marker).toBe("replaced");
      expect(observed.env.HOME).toBe(root);
      // Not inherited from this process.
      expect(observed.env.BUN_INSTALL_CACHE_DIR ?? null).toBe(null);
    } finally {
      await connection.close();
    }
  }, TIMEOUT);

  test("split, coalesced and CRLF frames reassemble UTF-8 while stderr stays separate", async () => {
    const stderr: string[] = [];
    const connection = await JuncoMcpTools.add(
      server("split", {
        env: { JUNCO_MCP_FIXTURE_MODE: "split" },
        onStderr: (chunk) => stderr.push(chunk),
      }),
    )
      .add(server("coalesce", { env: { JUNCO_MCP_FIXTURE_MODE: "coalesce" } }))
      .add(server("crlf", { env: { JUNCO_MCP_FIXTURE_MODE: "crlf" } }))
      .connect({ cwd: seed, collection });
    try {
      for (const name of ["split", "coalesce", "crlf"]) {
        const replies = await Promise.all(
          ["héllo wörld – ✓ 🌍", "plain"].map((text) =>
            call(connection, `mcp__${name}__echo`, { text }),
          ),
        );
        expect(replies.map((reply) => reply.text)).toEqual(["héllo wörld – ✓ 🌍", "plain"]);
      }
      expect(stderr.join("")).toContain("started in");
    } finally {
      await connection.close();
    }
  }, TIMEOUT);

  test("a final reply written just before exit reaches its pending call", async () => {
    const connection = await JuncoMcpTools.add(server("final")).connect({ cwd: seed, collection });
    try {
      const reply = await call(connection, "mcp__final__misbehave", {
        kind: "reply-then-exit",
      });
      expect(reply.text).toBe("final reply");
      // The server is gone: a retained tool now rejects instead of reconnecting.
      await assert.rejects(call(connection, "mcp__final__echo"), Error);
    } finally {
      await connection.close();
    }
  }, TIMEOUT);

  test("malformed, oversized and incomplete output reject pending work and drain the job", async () => {
    for (const [kind, extra] of [
      ["malformed", {}],
      ["incomplete", {}],
      ["oversized", { bytes: 4096 }],
    ] as const) {
      const connection = await JuncoMcpTools.add(
        server(kind, { maxMessageBytes: 2048 }),
      ).connect({ cwd: seed, collection });
      await assert.rejects(call(connection, `mcp__${kind}__misbehave`, { kind, ...extra }), Error);
      // The fatal frame is the connection's failure; close joins the job's teardown.
      await assert.rejects(connection.close(), Error);
    }
  }, TIMEOUT);

  test("early exit and list failure reject initialization and leave the collection usable", async () => {
    await assert.rejects(JuncoMcpTools.add(
      server("early", { env: { JUNCO_MCP_FIXTURE_MODE: "exit-on-start" } }),
    ).connect({ cwd: seed, collection }), (error) => error instanceof Error && error.message.includes('JuncoMcpTools: failed to initialize server "early"'));
    const failed = await JuncoMcpTools.add(server("good"))
      .add(server("listing", { env: { JUNCO_MCP_FIXTURE_MODE: "list-failure" } }))
      .connect({ cwd: seed, collection })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(failed instanceof Error);
    expect(failed.message).toContain('failed to initialize server "listing"');
    expect(String((failed.cause as Error).message)).toContain("fixture list failure");
    const after = await JuncoMcpTools.add(server("after")).connect({ cwd: seed, collection });
    try {
      expect((await call(after, "mcp__after__echo", { text: "ok" })).text).toBe("ok");
    } finally {
      await after.close();
    }
  }, TIMEOUT);

  test("invalid definitions and NUL arguments fail before anything launches", async () => {
    await assert.rejects(JuncoMcpTools.add(server("timeout", { closeTimeoutMs: -1 })).connect({ cwd: seed, collection }), (error) => error instanceof Error && error.message.includes("JuncoMcpTools: closeTimeoutMs must be finite and non-negative"));
    await assert.rejects(JuncoMcpTools.add(server("missing", { cwd: "absent" })).connect({ cwd: seed, collection }), (error) => error instanceof Error && error.message.includes('JuncoMcpTools: failed to initialize server "missing"'));
    const nul = await JuncoMcpTools.add(server("nul", { args: [SERVER, "a\0b"] }))
      .connect({ cwd: seed, collection })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(nul instanceof Error);
    expect(String((nul.cause as Error)?.message)).toContain("NUL");
  }, TIMEOUT);

  test("McpBuilder publishes server tools in a collection whose close stops the server", () =>
    withNativeCleanup(async (defer) => {
      const watch = watchStderr();
      const built = await new McpBuilder()
        .add(server("fx", { onStderr: watch.onStderr }))
        .build(seed, { native: copyTree, policy: LockPolicy });
      const forgetBuilt = defer(() => built.close());
      const read = built.tools.find((candidate) => candidate.name === "mcp__fx__read_state");
      assert.ok(read);
      assert.ok(getJuncoMcpToolIdentity(read));
      const binding = built.bind();
      const forgetBinding = defer(() => binding.close());
      // Shared as is: an owner binding has no counterpart of an extension tool.
      assert.equal(binding.tools.get(read), undefined);
      const result = (await read.execute("call", {} as never)) as { content: { text?: string }[] };
      assert.ok(Number.isInteger(JSON.parse(result.content[0]?.text ?? "{}").pid));
      const pid = watch.pid();
      expect(fixtureRunning(pid)).toBe(true);
      await binding.close().finally(forgetBinding);
      await built.close().finally(forgetBuilt);
      expect(fixtureRunning(pid)).toBe(false);
      await assert.rejects(read.execute("call", {} as never));
      await assert.rejects(built.mux.validateCwd(seed));
      await assert.rejects(
        new McpBuilder().add(server("missing", { cwd: "absent" })).build(seed, { native: copyTree, policy: LockPolicy }),
        (error) => error instanceof Error && error.message.includes('failed to initialize server "missing"'),
      );
    }), TIMEOUT);

  test("held RPCs on one connection survive another connection's close", async () => {
    const holder = await JuncoMcpTools.add(server("holder")).connect({ cwd: seed, collection });
    const other = await JuncoMcpTools.add(server("other")).connect({ cwd: seed, collection });
    try {
      const progress: string[] = [];
      const held = tool(holder, "mcp__holder__hold").execute(
        "held",
        { key: "k", progress: ["step one"] } as never,
        undefined,
        (update) => {
          progress.push(
            (update.content[0] as { text: string } | undefined)?.text ?? "",
          );
        },
      );
      await other.close();
      await call(holder, "mcp__holder__release", { key: "k" });
      await held;
      expect(progress).toEqual(["step one"]);
      expect((await call(holder, "mcp__holder__echo", { text: "still" })).text).toBe("still");
    } finally {
      await holder.close();
    }
  }, TIMEOUT);

  test("cancellation through the tool signal never becomes success", async () => {
    const connection = await JuncoMcpTools.add(server("cancel")).connect({ cwd: seed, collection });
    try {
      const controller = new AbortController();
      const held = tool(connection, "mcp__cancel__hold").execute(
        "held",
        { key: "never" } as never,
        controller.signal,
      );
      // The server parks the request; the read proves it is held before cancelling.
      for (;;) {
        const observed = JSON.parse(
          (await call(connection, "mcp__cancel__read_state")).text,
        ) as { held: string[] };
        if (observed.held.includes("never")) break;
      }
      controller.abort();
      await assert.rejects(held, Error);
    } finally {
      await connection.close();
    }
  }, TIMEOUT);

  test("a server that ignores TERM, or stops reading stdin, still closes without a hang", () =>
    withNativeCleanup(async (defer) => {
      const stubborn = await JuncoMcpTools.add(
        server("stubborn", {
          env: { JUNCO_MCP_FIXTURE_MODE: "ignore-term" },
          closeTimeoutMs: 200,
        }),
      ).connect({ cwd: seed, collection });
      const forgetStubborn = defer(() => stubborn.close());
      await call(stubborn, "mcp__stubborn__echo");
      // Forced cancellation discards the command: an unpublished close, never a success.
      await assert.rejects(stubborn.close().finally(forgetStubborn), Error);

      const stalled = await JuncoMcpTools.add(
        server("stalled", { closeTimeoutMs: 200 }),
      ).connect({ cwd: seed, collection });
      const forgetStalled = defer(() => stalled.close());
      await call(stalled, "mcp__stalled__misbehave", { kind: "stall-stdin" });
      // Queue more than a pipe buffer behind the stopped reader.
      const queued = [1, 2, 3, 4].map(() =>
        call(stalled, "mcp__stalled__echo", { text: "x".repeat(256 * 1024) }).then(
          () => "replied",
          () => "rejected",
        ),
      );
      await stalled
        .close()
        .finally(forgetStalled)
        .catch(() => {});
      expect(await Promise.all(queued)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    }), TIMEOUT);

  test("close during start still stops the admitted process", async () => {
    const lease = collection.lease();
    try {
      const transport = new ShellMuxStdioTransport(collection.mux, {
        command: process.execPath,
        args: [SERVER],
        cwd: seed,
      });
      const started = transport.start().then(
        () => "started",
        () => "rejected",
      );
      const closing = transport.close();
      expect(await started).toBe("rejected");
      await closing;
      await transport.closed;
    } finally {
      await lease.close();
    }
  }, TIMEOUT);

  test("an asynchronous finish rejection still aborts and closes its process", () =>
    withNativeCleanup(async (defer) => {
      const directory = join(root, "rejected-finish");
      await mkdir(directory);
      const local = await ToolCollection.create(directory, { native: copyTree, policy: LockPolicy });
      defer(() => local.close());
      const transport = new ShellMuxStdioTransport(local.mux, {
        command: process.execPath,
        args: [SERVER],
        cwd: directory,
        closeTimeoutMs: -1,
      });
      await transport.start();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await assert.rejects(Promise.race([
          transport.close(),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("transport did not close")), 5_000);
          }),
        ]), (error) => error instanceof Error && error.message.includes("closeTimeoutMs"));
        await assert.rejects(transport.closed, (error) => error instanceof Error && error.message.includes("closeTimeoutMs"));
      } finally {
        clearTimeout(deadline);
      }
    }), TIMEOUT);

  test("Marsh authority: a lone server's unauthorized overwrite is denied at finalization", () =>
    withNativeCleanup(async (defer) => {
      const owner = await JuncoMcpTools.add(server("owner")).connect({ cwd: seed, collection });
      const forgetOwner = defer(() => owner.close());
      await call(owner, "mcp__owner__write_file", {
        path: "owned.txt",
        content: "first\n",
        staged: true,
      });
      await owner.close().finally(forgetOwner);
      expect(await readFile(join(seed, "owned.txt"), "utf8")).toBe("first\n");

      for (const via of ["write_file", "descendant_write"] as const) {
        const intruder = await JuncoMcpTools.add(server(`intruder_${via}`)).connect({
          cwd: seed,
          collection,
        });
        const forgetIntruder = defer(() => intruder.close());
        const reply = await call(intruder, `mcp__intruder_${via}__${via}`, {
          path: "owned.txt",
          content: "stolen\n",
        });
        // The reply is not commit evidence: authority decides when the server ends.
        expect(reply.isError).toBe(false);
        const closed = await intruder
          .close()
          .finally(forgetIntruder)
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        assert.ok(closed instanceof AggregateError);
        assert.ok(closed.errors.some(isMarshPolicyDenied), String(closed));
        expect(await readFile(join(seed, "owned.txt"), "utf8")).toBe("first\n");
      }
    }), TIMEOUT);

  test("overlapping snapshots do not merge: the later publication is refused", () =>
    withNativeCleanup(async (defer) => {
      const first = await JuncoMcpTools.add(server("left")).connect({ cwd: seed, collection });
      const forgetFirst = defer(() => first.close());
      const second = await JuncoMcpTools.add(server("right")).connect({ cwd: seed, collection });
      const forgetSecond = defer(() => second.close());
      await call(first, "mcp__left__write_file", { path: "race.txt", content: "left\n" });
      await call(second, "mcp__right__write_file", { path: "race.txt", content: "right\n" });
      await first.close().finally(forgetFirst);
      await assert.rejects(second.close().finally(forgetSecond), Error);
      expect(await readFile(join(seed, "race.txt"), "utf8")).toBe("left\n");
    }), TIMEOUT);
});

describe("discard-only MCP connections", () => {
  test("a discarded server's file and cache writes never reach the seed; a default one publishes", async () => {
    const discarded = await JuncoMcpTools.add(server("discard")).connect({
      cwd: seed,
      collection,
      discardOnClose: true,
    });
    try {
      const plain = await call(discarded, "mcp__discard__write_file", {
        path: "discarded.txt",
        content: "private\n",
      });
      const cache = await call(discarded, "mcp__discard__write_file", {
        path: "sub/discard-cache.json",
        content: "{\"cache\":true}\n",
        staged: true,
      });
      expect([plain.isError, cache.isError]).toEqual([false, false]);
      // The writes are real inside the server's private view.
      expect((await state(discarded, "discard", { path: "discarded.txt" })).file).toBe(
        "private\n",
      );
    } finally {
      await discarded.close();
    }
    expect(await absent(join(seed, "discarded.txt"))).toBe(true);
    expect(await absent(join(seed, "sub/discard-cache.json"))).toBe(true);

    const published = await JuncoMcpTools.add(server("publish")).connect({ cwd: seed, collection });
    try {
      await call(published, "mcp__publish__write_file", {
        path: "published.txt",
        content: "public\n",
      });
    } finally {
      await published.close();
    }
    expect(await readFile(join(seed, "published.txt"), "utf8")).toBe("public\n");
  }, TIMEOUT);

  test("a discarded server that exits on its own fails close instead of claiming a discard", async () => {
    const connection = await JuncoMcpTools.add(server("exits")).connect({
      cwd: seed,
      collection,
      discardOnClose: true,
    });
    // The pending call fails only once the transport has the native verdict, so the exit
    // (even a successful one) has already won against close's cancellation.
    await assert.rejects(call(connection, "mcp__exits__misbehave", { kind: "exit", code: 0 }), Error);
    expect(await rejection(connection.close())).toContain(DISCARD_EXIT);
  }, TIMEOUT);

  test("fatal frames still fail a discarded connection", async () => {
    const connection = await JuncoMcpTools.add(server("broken")).connect({
      cwd: seed,
      collection,
      discardOnClose: true,
    });
    await assert.rejects(call(connection, "mcp__broken__misbehave", { kind: "malformed" }), Error);
    const messages = await rejection(connection.close());
    expect(messages).toContain("MCP stdio server sent a malformed JSON-RPC message");
    expect(messages).not.toContain(DISCARD_EXIT);
  }, TIMEOUT);

  test("abort during initialize still rejects and stops a discard-only server", async () => {
    const watch = watchStderr("hold-initialize-ready");
    const controller = new AbortController();
    const connecting = JuncoMcpTools.add(
      server("held_discard", {
        env: { JUNCO_MCP_FIXTURE_MODE: "hold-initialize" },
        onStderr: watch.onStderr,
      }),
    ).connect({ cwd: seed, collection, signal: controller.signal, discardOnClose: true });
    await Promise.race([
      watch.ready,
      connecting.then(() => assert.fail("connected without holding")),
    ]);
    const pid = watch.pid();
    controller.abort();
    await assert.rejects(connecting, McpAbortError);
    expect(fixtureRunning(pid)).toBe(false);
  }, TIMEOUT);

  test("direct transport: close discards, external cancellation and early exit stay failures", async () => {
    const lease = collection.lease();
    try {
      const options = {
        command: process.execPath,
        args: [SERVER],
        cwd: seed,
        discardOnClose: true,
      };

      // Requested discard: cancellation is the successful outcome.
      const requested = new ShellMuxStdioTransport(collection.mux, options);
      await requested.start();
      await requested.close();
      await requested.closed;
      expect(requested.terminalError).toBeUndefined();

      // Cancellation the transport did not request is never a successful discard.
      let spawned: NativeProcess | undefined;
      const observed = {
        async spawn(...args: Parameters<NativeMux["spawn"]>) {
          spawned = await collection.mux.spawn(...args);
          return spawned;
        },
      } as unknown as NativeMux;
      const external = new ShellMuxStdioTransport(observed, options);
      await external.start();
      assert.ok(spawned);
      spawned.abort();
      expect(await rejection(external.closed)).toContain("MCP stdio server was cancelled");
      await external.close().catch(() => {});

      // A natural exit may have published: it fails even though it exited with code 3.
      const early = new ShellMuxStdioTransport(collection.mux, {
        ...options,
        env: { JUNCO_MCP_FIXTURE_MODE: "exit-on-start" },
      });
      await early.start();
      expect(await rejection(early.closed)).toContain(DISCARD_EXIT);
      expect(early.terminalError?.message).toContain("MCP stdio server exited with code 3");
      await early.close().catch(() => {});
    } finally {
      await lease.close();
    }
  }, TIMEOUT);
});

describe("MCP acquisition cancellation", () => {
  test("an already aborted signal starts no server", async () => {
    const controller = new AbortController();
    controller.abort();
    const watch = watchStderr();
    await assert.rejects(JuncoMcpTools.add(server("aborted", { onStderr: watch.onStderr })).connect({
      cwd: seed,
      collection,
      signal: controller.signal,
    }), McpAbortError);
    expect(watch.text).toBe("");
  }, TIMEOUT);

  test("abort during initialize or tool listing stops the server; the mux and other connections stay usable", async () => {
    const existing = await JuncoMcpTools.add(server("existing")).connect({ cwd: seed, collection });
    try {
      for (const phase of ["initialize", "list"] as const) {
        const watch = watchStderr(`hold-${phase}-ready`);
        const controller = new AbortController();
        const connecting = JuncoMcpTools.add(
          server(`held_${phase}`, {
            env: { JUNCO_MCP_FIXTURE_MODE: `hold-${phase}` },
            onStderr: watch.onStderr,
          }),
        ).connect({ cwd: seed, collection, signal: controller.signal });
        // A connection settling before the cue fails the test instead of hanging it.
        await Promise.race([
          watch.ready,
          connecting.then(() => assert.fail("connected without holding")),
        ]);
        const pid = watch.pid();
        expect(fixtureRunning(pid)).toBe(true);
        controller.abort();
        await assert.rejects(connecting, McpAbortError);
        // The rejection joined cleanup: the process has already exited.
        expect(fixtureRunning(pid)).toBe(false);
      }
      expect((await call(existing, "mcp__existing__echo", { text: "still" })).text).toBe(
        "still",
      );
      const fresh = await JuncoMcpTools.add(server("fresh")).connect({ cwd: seed, collection });
      try {
        expect((await call(fresh, "mcp__fresh__echo", { text: "fresh" })).text).toBe("fresh");
      } finally {
        await fresh.close();
      }
    } finally {
      await existing.close();
    }
  }, TIMEOUT);

  test("abort while the second server starts also stops the first", async () => {
    const first = watchStderr();
    const second = watchStderr("hold-initialize-ready");
    const controller = new AbortController();
    const connecting = JuncoMcpTools.add(server("first", { onStderr: first.onStderr }))
      .add(
        server("second", {
          env: { JUNCO_MCP_FIXTURE_MODE: "hold-initialize" },
          onStderr: second.onStderr,
        }),
      )
      .connect({ cwd: seed, collection, signal: controller.signal });
    await Promise.race([
      second.ready,
      connecting.then(() => assert.fail("connected without holding")),
    ]);
    const pids = [first.pid(), second.pid()];
    expect(pids.map(fixtureRunning)).toEqual([true, true]);
    controller.abort();
    await assert.rejects(connecting, McpAbortError);
    expect(pids.map(fixtureRunning)).toEqual([false, false]);
  }, TIMEOUT);

  test("a returned connection ignores a later abort of its acquisition signal", async () => {
    const controller = new AbortController();
    const connection = await JuncoMcpTools.add(server("kept")).connect({
      cwd: seed,
      collection,
      signal: controller.signal,
    });
    try {
      controller.abort();
      expect((await call(connection, "mcp__kept__echo", { text: "kept" })).text).toBe("kept");
    } finally {
      await connection.close();
    }
  }, TIMEOUT);
});

describe("MCP definitions and tool identity over real servers", () => {
  test("a snapshot connects its own args, env and static roots while sharing callbacks", async () => {
    const watch = watchStderr();
    let rootCalls = 0;
    const args = [SERVER, "admitted"];
    const env: Record<string, string> = { JUNCO_MCP_FIXTURE_MARKER: "admitted" };
    const roots = [{ uri: "file:///admitted", name: "admitted" }];
    const original = JuncoMcpTools.add(server("statics", { args, env, clientOptions: { roots } }))
      .add(
        server("dynamic", {
          onStderr: watch.onStderr,
          clientOptions: {
            roots: () => {
              rootCalls += 1;
              return [{ uri: "file:///dynamic", name: "dynamic" }];
            },
          },
        }),
      );
    const copy = original.snapshot();
    args.push("later");
    env.JUNCO_MCP_FIXTURE_MARKER = "later";
    roots.push({ uri: "file:///later", name: "later" });
    original.add(server("added"));

    const connection = await copy.connect({ cwd: seed, collection });
    try {
      expect(connection.tools.some((item) => item.name.startsWith("mcp__added__"))).toBe(false);
      const observed = await state(connection, "statics");
      expect(observed.argv).toEqual(["admitted"]);
      expect(observed.marker).toBe("admitted");
      expect(JSON.parse((await call(connection, "mcp__statics__list_roots")).text)).toEqual({
        roots: [{ uri: "file:///admitted", name: "admitted" }],
      });
      expect(JSON.parse((await call(connection, "mcp__dynamic__list_roots")).text)).toEqual({
        roots: [{ uri: "file:///dynamic", name: "dynamic" }],
      });
      // The snapshot's server reports through the original's callbacks.
      expect(rootCalls).toBe(1);
      expect(watch.text).toContain("started in");
    } finally {
      await connection.close();
    }

    const later = await original.connect({ cwd: seed, collection });
    try {
      const observed = await state(later, "statics");
      expect(observed.argv).toEqual(["admitted", "later"]);
      expect(observed.marker).toBe("later");
      expect((await call(later, "mcp__added__echo", { text: "added" })).text).toBe("added");
    } finally {
      await later.close();
    }
  }, TIMEOUT);

  test("colliding originals a-b and a_b publish distinct names and dispatch their own operation", async () => {
    const connection = await JuncoMcpTools.add(
      server("alias", { env: { JUNCO_MCP_FIXTURE_MODE: "alias-both" } }),
    ).connect({ cwd: seed, collection });
    try {
      const aliases = connection.tools.filter((item) =>
        ["a-b", "a_b"].includes(getJuncoMcpToolIdentity(item)?.originalToolName ?? ""),
      );
      expect(aliases.map((item) => getJuncoMcpToolIdentity(item))).toEqual([
        { serverName: "alias", originalToolName: "a-b" },
        { serverName: "alias", originalToolName: "a_b" },
      ]);
      expect(new Set(aliases.map((item) => item.name)).size).toBe(2);
      expect(aliases.some((item) => item.name === "mcp__alias__a_b")).toBe(false);
      const replies = await Promise.all(
        aliases.map(async (item) => (await call(connection, item.name)).text),
      );
      expect(replies).toEqual(["a-b", "a_b"]);
    } finally {
      await connection.close();
    }
  }, TIMEOUT);
});

describe("call-scoped MCP lifetime", () => {
  test("discovery and every call stop before returning and see the latest seed", () =>
    withNativeCleanup(async (defer) => {
      const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-fresh-"));
      defer(() => rm(root, { recursive: true, force: true }));
      const seed = join(root, "seed");
      await mkdir(seed);
      await writeFile(join(seed, "source.txt"), "Alpha\n");
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      const forgetCollection = defer(() => collection.close());
      const watch = watchStderr();
      const connection = await JuncoMcpTools.add(server("fresh", { onStderr: watch.onStderr })).connect({
        cwd: seed, collection, toolLifetime: "call", discardOnClose: true,
      });
      defer(() => connection.close());
      expect(fixtureRunning(watch.pid())).toBe(false);
      const first = await state(connection, "fresh", { path: "source.txt" });
      expect(first.file).toBe("Alpha\n");
      expect(fixtureRunning(first.pid)).toBe(false);
      await writeFile(join(seed, "source.txt"), "Alpha\nBeta\n");
      const second = await state(connection, "fresh", { path: "source.txt" });
      expect(second.file).toBe("Alpha\nBeta\n");
      expect(second.pid).not.toBe(first.pid);
      expect(fixtureRunning(second.pid)).toBe(false);
      expect((await call(connection, "mcp__fresh__write_file", { path: "private-cache.txt", content: "private\n" })).isError).toBe(false);
      expect(await absent(join(seed, "private-cache.txt"))).toBe(true);
      await collection.close().finally(forgetCollection);
      expect((await state(connection, "fresh", { path: "source.txt" })).file).toBe("Alpha\nBeta\n");
      await connection.close();
      await assert.rejects(call(connection, "mcp__fresh__read_state"), McpConnectionClosedError);
    }), TIMEOUT);
  test("call lifetime publishes by default before the call settles", () =>
    withNativeCleanup(async (defer) => {
      const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-publish-"));
      defer(() => rm(seed, { recursive: true, force: true }));
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      defer(() => collection.close());
      const watch = watchStderr();
      const connection = await JuncoMcpTools.add(server("publish", { onStderr: watch.onStderr })).connect({
        cwd: seed, collection, toolLifetime: "call",
      });
      defer(() => connection.close());
      expect((await call(connection, "mcp__publish__write_file", { path: "published.txt", content: "public\n" })).isError).toBe(false);
      expect(await readFile(join(seed, "published.txt"), "utf8")).toBe("public\n");
      expect(watch.pids().map(fixtureRunning)).toEqual([false, false]);
    }), TIMEOUT);

  test("original identities survive collisions and captured configuration excludes unrelated servers", () =>
    withNativeCleanup(async (defer) => {
      const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-identity-"));
      defer(() => rm(seed, { recursive: true, force: true }));
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      defer(() => collection.close());
      const first = watchStderr();
      const second = watchStderr();
      const args = [SERVER, "captured"];
      const env = { JUNCO_MCP_FIXTURE_MODE: "alias-both", JUNCO_MCP_FIXTURE_MARKER: "captured" };
      const roots = [{ uri: "file:///captured", name: "captured" }];
      const definition = JuncoMcpTools.add(server("alias", { args, env, onStderr: first.onStderr, clientOptions: { roots } }))
        .add(server("unrelated", { onStderr: second.onStderr }));
      const connection = await definition.connect({ cwd: seed, collection, toolLifetime: "call", discardOnClose: true });
      defer(() => connection.close());
      expect([first.pid(), second.pid()].map(fixtureRunning)).toEqual([false, false]);
      args.push("mutated");
      env.JUNCO_MCP_FIXTURE_MODE = "alias-underscore";
      env.JUNCO_MCP_FIXTURE_MARKER = "mutated";
      roots.push({ uri: "file:///mutated", name: "mutated" });
      definition.add(server("later"));
      const aliases = connection.tools.filter((candidate) => {
        const identity = getJuncoMcpToolIdentity(candidate);
        return identity?.serverName === "alias" && ["a-b", "a_b"].includes(identity.originalToolName);
      });
      expect(aliases).toHaveLength(2);
      expect(new Set(aliases.map((candidate) => candidate.name)).size).toBe(2);
      for (const candidate of aliases) {
        const identity = getJuncoMcpToolIdentity(candidate)!;
        expect(Object.isFrozen(identity)).toBe(true);
        expect((await call(connection, candidate.name)).text).toBe(identity.originalToolName);
        expect(getJuncoMcpToolIdentity(candidate)).toBe(identity);
      }
      const captured = await state(connection, "alias");
      expect(captured.argv).toEqual(["captured"]);
      expect(captured.marker).toBe("captured");
      expect(JSON.parse((await call(connection, "mcp__alias__list_roots")).text)).toEqual({ roots: [{ uri: "file:///captured", name: "captured" }] });
      expect(connection.tools.some((candidate) => candidate.name.startsWith("mcp__later__"))).toBe(false);
      expect(second.pids()).toHaveLength(1);
      expect(first.pids().map(fixtureRunning)).toEqual(first.pids().map(() => false));
    }), TIMEOUT);

  test("identity drift cannot dispatch a different original under the captured published name", () =>
    withNativeCleanup(async (defer) => {
      const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-drift-"));
      defer(() => rm(seed, { recursive: true, force: true }));
      await writeFile(join(seed, "mcp-mode.txt"), "alias-dash");
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      defer(() => collection.close());
      const watch = watchStderr();
      const connection = await JuncoMcpTools.add(server("alias", {
        env: { JUNCO_MCP_FIXTURE_MODE_FILE: "mcp-mode.txt" }, onStderr: watch.onStderr,
      })).connect({ cwd: seed, collection, toolLifetime: "call", discardOnClose: true });
      defer(() => connection.close());
      const dash = connection.tools.find((candidate) => getJuncoMcpToolIdentity(candidate)?.originalToolName === "a-b");
      assert.ok(dash);
      const identity = getJuncoMcpToolIdentity(dash);
      expect(Object.isFrozen(identity)).toBe(true);
      await writeFile(join(seed, "mcp-mode.txt"), "alias-underscore");
      await assert.rejects(dash.execute("drift", {}), (error) => error instanceof Error && error.message.includes('expected one tool "alias/a-b", found 0'));
      expect(watch.pids().map(fixtureRunning)).toEqual([false, false]);
      await writeFile(join(seed, "mcp-mode.txt"), "alias-both");
      expect((await call(connection, dash.name)).text).toBe("a-b");
      expect(getJuncoMcpToolIdentity(dash)).toBe(identity);
      expect(watch.pids().map(fixtureRunning)).toEqual([false, false, false]);
    }), TIMEOUT);

  test("same-ID overlapping calls isolate abort, and logical close joins all physical processes", () =>
    withNativeCleanup(async (defer) => {
      const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-overlap-"));
      defer(() => rm(seed, { recursive: true, force: true }));
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      defer(() => collection.close());
      const watch = watchStderr();
      const acquisition = new AbortController();
      const connection = await JuncoMcpTools.add(server("overlap", { onStderr: watch.onStderr })).connect({
        cwd: seed, collection, toolLifetime: "call", discardOnClose: true, signal: acquisition.signal,
      });
      defer(() => connection.close());
      acquisition.abort();
      expect((await call(connection, "mcp__overlap__echo", { text: "still open" })).text).toBe("still open");
      const preaborted = new AbortController();
      preaborted.abort();
      const before = watch.pids().length;
      await assert.rejects(tool(connection, "mcp__overlap__hold").execute("same-id", { key: "pre" }, preaborted.signal), McpAbortError);
      expect(watch.pids()).toHaveLength(before);
      const firstReady = Promise.withResolvers<void>();
      const secondReady = Promise.withResolvers<void>();
      const caller = new AbortController();
      const first = tool(connection, "mcp__overlap__hold").execute("same-id", { key: "first", progress: ["ready"] }, caller.signal, () => firstReady.resolve());
      const firstOutcome = first.then(() => assert.fail("held call returned"), (error: unknown) => error);
      await Promise.race([firstReady.promise, firstOutcome.then((error) => { throw error; })]);
      const firstPid = watch.pids().at(-1)!;
      const second = tool(connection, "mcp__overlap__hold").execute("same-id", { key: "second", progress: ["ready"] }, undefined, () => secondReady.resolve());
      const secondOutcome = second.then(() => assert.fail("held call returned"), (error: unknown) => error);
      await Promise.race([secondReady.promise, secondOutcome.then((error) => { throw error; })]);
      const secondPid = watch.pids().at(-1)!;
      expect(firstPid).not.toBe(secondPid);
      expect([firstPid, secondPid].map(fixtureRunning)).toEqual([true, true]);
      caller.abort();
      expect(await firstOutcome).toBeInstanceOf(McpAbortError);
      expect([firstPid, secondPid].map(fixtureRunning)).toEqual([false, true]);
      const closing = connection.close();
      expect(connection.close()).toBe(closing);
      await closing;
      expect(await secondOutcome).toBeInstanceOf(McpAbortError);
      expect(watch.pids().map(fixtureRunning)).toEqual(watch.pids().map(() => false));
      const count = watch.pids().length;
      await assert.rejects(call(connection, "mcp__overlap__echo"), McpConnectionClosedError);
      expect(watch.pids()).toHaveLength(count);
    }), TIMEOUT);

  test("cancelled discovery stops its process and releases the logical lease", () =>
    withNativeCleanup(async (defer) => {
      const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-discovery-"));
      defer(() => rm(seed, { recursive: true, force: true }));
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      const forgetCollection = defer(() => collection.close());
      const watch = watchStderr("hold-initialize-ready");
      const controller = new AbortController();
      const connecting = JuncoMcpTools.add(server("discovery", {
        env: { JUNCO_MCP_FIXTURE_MODE: "hold-initialize" }, onStderr: watch.onStderr,
      })).connect({ cwd: seed, collection, toolLifetime: "call", discardOnClose: true, signal: controller.signal });
      const outcome = connecting.then((connection) => { defer(() => connection.close()); assert.fail("discovery did not hold"); }, (error: unknown) => error);
      await Promise.race([watch.ready, outcome.then((error) => { throw error; })]);
      controller.abort();
      expect(await outcome).toBeInstanceOf(McpAbortError);
      expect(fixtureRunning(watch.pid())).toBe(false);
      await collection.close().finally(forgetCollection);
      expect(() => collection.lease()).toThrow();
    }), TIMEOUT);

  for (const terminal of ["abort", "close"] as const) {
    test(`${terminal} during call acquisition stops and joins the admitted process`, () =>
      withNativeCleanup(async (defer) => {
        const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", `mcp-call-acquire-${terminal}-`));
        defer(() => rm(seed, { recursive: true, force: true }));
        await writeFile(join(seed, "mcp-mode.txt"), "");
        const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
        defer(() => collection.close());
        const watch = watchStderr("hold-initialize-ready");
        const connection = await JuncoMcpTools.add(server("acquire", {
          env: { JUNCO_MCP_FIXTURE_MODE_FILE: "mcp-mode.txt" }, onStderr: watch.onStderr,
        })).connect({ cwd: seed, collection, toolLifetime: "call", discardOnClose: true });
        defer(() => connection.close());
        await writeFile(join(seed, "mcp-mode.txt"), "hold-initialize");
        const controller = new AbortController();
        const invocation = tool(connection, "mcp__acquire__echo").execute("acquire", { text: "held" }, controller.signal);
        const outcome = invocation.then(() => assert.fail("acquisition did not hold"), (error: unknown) => error);
        await Promise.race([watch.ready, outcome.then((error) => { throw error; })]);
        const pid = watch.pids().at(-1)!;
        expect(fixtureRunning(pid)).toBe(true);
        if (terminal === "abort") controller.abort();
        else await connection.close();
        expect(await outcome).toBeInstanceOf(McpAbortError);
        expect(fixtureRunning(pid)).toBe(false);
        if (terminal === "abort") {
          await writeFile(join(seed, "mcp-mode.txt"), "");
          expect((await call(connection, "mcp__acquire__echo", { text: "recovered" })).text).toBe("recovered");
        }
      }), TIMEOUT);
  }

  test("logical close preserves cleanup failures from a physical acquisition that never returned", () =>
    withNativeCleanup(async (defer) => {
      const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-cleanup-"));
      defer(() => rm(seed, { recursive: true, force: true }));
      await writeFile(join(seed, "mcp-mode.txt"), "");
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      defer(() => collection.close());
      const watch = watchStderr("hold-initialize-ready");
      const connection = await JuncoMcpTools.add(server("cleanup", {
        env: { JUNCO_MCP_FIXTURE_MODE_FILE: "mcp-mode.txt" }, onStderr: watch.onStderr,
      })).connect({ cwd: seed, collection, toolLifetime: "call", discardOnClose: true });
      const forgetConnection = defer(() => connection.close());
      const marker = new Error("physical lease cleanup marker");
      const originalLease = collection.lease;
      collection.lease = function () {
        const lease = originalLease.call(this);
        return { async close() { await lease.close(); throw marker; } };
      };
      defer(() => { collection.lease = originalLease; });
      await writeFile(join(seed, "mcp-mode.txt"), "hold-initialize");
      const invocation = call(connection, "mcp__cleanup__echo");
      const outcome = invocation.then(() => assert.fail("acquisition did not hold"), (error: unknown) => error);
      await Promise.race([watch.ready, outcome.then((error) => { throw error; })]);
      const pid = watch.pids().at(-1)!;
      const closed = await connection.close().then(() => assert.fail("cleanup succeeded"), (error: unknown) => error).finally(forgetConnection);
      const failed = await outcome;
      expect(failureMessages(failed)).toContain(marker.message);
      expect(failureMessages(closed)).toContain(marker.message);
      assert.ok(closed instanceof AggregateError);
      expect(closed.errors).toContain(marker);
      expect(fixtureRunning(pid)).toBe(false);
      collection.lease = originalLease;
    }), TIMEOUT);

  test("unsafe natural exit is retained by the call and not replayed by later logical close", () =>
    withNativeCleanup(async (defer) => {
      const seed = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-call-exit-"));
      defer(() => rm(seed, { recursive: true, force: true }));
      const collection = await ToolCollection.create(seed, { native: copyTree, policy: LockPolicy, sandbox: "always" });
      defer(() => collection.close());
      const watch = watchStderr();
      const connection = await JuncoMcpTools.add(server("exit", { onStderr: watch.onStderr })).connect({
        cwd: seed, collection, toolLifetime: "call", discardOnClose: true,
      });
      const forgetConnection = defer(() => connection.close());
      const messages = await rejection(call(connection, "mcp__exit__misbehave", { kind: "exit", code: 0 }));
      expect(messages).toContain(DISCARD_EXIT);
      expect(watch.pids().map(fixtureRunning)).toEqual([false, false]);
      await connection.close().finally(forgetConnection);
    }), TIMEOUT);
});
