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
import { McpAbortError } from "@earendil-works/pi-mcp";
import {
  acquireShellMux,
  createShellMuxOperations,
  type NativeModule,
  type NativeMux,
  type NativeProcess,
  type ShellMuxLease,
  shutdownShellMux,
} from "junco-tools";
import { isMarshPolicyDenied } from "junco-tools/errors";
import * as testAddon from "../../../junco-tools/target/native-test/index.js";
import {
  getJuncoMcpToolIdentity,
  type JuncoMcpConnection,
  type JuncoMcpServerOptions,
  JuncoMcpTools,
} from "../../src/index.ts";
import { ShellMuxStdioTransport } from "../../src/stdio.ts";
import { withNativeCleanup } from "../../../../test/native-support.ts";

const SERVER = fileURLToPath(new URL("../stdio-server.ts", import.meta.url));
const TIMEOUT = 60_000;

/** The real test addon whose `NativeMux.open` opens a CopyTree seed, counting raw opens. */
const opens: string[] = [];
const copyTree = {
  ...testAddon,
  NativeMux: {
    async open(...args: Parameters<NativeModule["NativeMux"]["open"]>) {
      opens.push(args[0]);
      return testAddon.NativeMux.openCopyTree(...args);
    },
  },
} as unknown as NativeModule;

let root: string;
let seed: string;
let observer: ShellMuxLease;

beforeAll(async () => {
  root = await mkdtemp(
    fileURLToPath(new URL("../../../junco-tools/target/mcp-test-", import.meta.url)),
  );
  seed = join(root, "seed");
  await mkdir(join(seed, "sub"), { recursive: true });
  // The first acquisition selects the CopyTree addon; every connection inherits it.
  observer = await acquireShellMux(seed, { native: copyTree });
});

afterAll(async () => {
  observer?.release();
  try {
    await shutdownShellMux();
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
function failureMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (!(error instanceof Error) || seen.has(error)) return [];
  seen.add(error);
  return [
    error.message,
    ...(error instanceof AggregateError
      ? error.errors.flatMap((inner) => failureMessages(inner, seen))
      : []),
    ...failureMessages(error.cause, seen),
  ];
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
      .connect({ cwd: seed });
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

      // Ordinary bash on the same singleton while both servers are live.
      const operations = createShellMuxOperations();
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
    // Every acquisition shared the observer's one raw open.
    expect(opens).toEqual([seed]);
    const again = await acquireShellMux(seed);
    try {
      expect(again.mux).toBe(observer.mux);
    } finally {
      again.release();
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
    ).connect({ cwd: seed });
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
    ).connect({ cwd: seed });
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
      .connect({ cwd: seed });
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
    const connection = await JuncoMcpTools.add(server("final")).connect({ cwd: seed });
    try {
      const reply = await call(connection, "mcp__final__misbehave", {
        kind: "reply-then-exit",
      });
      expect(reply.text).toBe("final reply");
      // The server is gone: a retained tool now rejects instead of reconnecting.
      await expect(call(connection, "mcp__final__echo")).rejects.toThrow();
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
      ).connect({ cwd: seed });
      await expect(
        call(connection, `mcp__${kind}__misbehave`, { kind, ...extra }),
      ).rejects.toThrow();
      // The fatal frame is the connection's failure; close joins the job's teardown.
      await expect(connection.close()).rejects.toThrow();
    }
  }, TIMEOUT);

  test("early exit and list failure reject initialization and leave the singleton usable", async () => {
    await expect(
      JuncoMcpTools.add(
        server("early", { env: { JUNCO_MCP_FIXTURE_MODE: "exit-on-start" } }),
      ).connect({ cwd: seed }),
    ).rejects.toThrow('JuncoMcpTools: failed to initialize server "early"');
    const failed = await JuncoMcpTools.add(server("good"))
      .add(server("listing", { env: { JUNCO_MCP_FIXTURE_MODE: "list-failure" } }))
      .connect({ cwd: seed })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(failed instanceof Error);
    expect(failed.message).toContain('failed to initialize server "listing"');
    expect(String((failed.cause as Error).message)).toContain("fixture list failure");
    const after = await JuncoMcpTools.add(server("after")).connect({ cwd: seed });
    try {
      expect((await call(after, "mcp__after__echo", { text: "ok" })).text).toBe("ok");
    } finally {
      await after.close();
    }
  }, TIMEOUT);

  test("invalid definitions and NUL arguments fail before anything launches", async () => {
    await expect(
      JuncoMcpTools.add(server("timeout", { closeTimeoutMs: -1 })).connect({ cwd: seed }),
    ).rejects.toThrow("JuncoMcpTools: closeTimeoutMs must be finite and non-negative");
    await expect(
      JuncoMcpTools.add(server("missing", { cwd: "absent" })).connect({ cwd: seed }),
    ).rejects.toThrow('JuncoMcpTools: failed to initialize server "missing"');
    const nul = await JuncoMcpTools.add(server("nul", { args: [SERVER, "a\0b"] }))
      .connect({ cwd: seed })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(nul instanceof Error);
    expect(String((nul.cause as Error)?.message)).toContain("NUL");
  }, TIMEOUT);

  test("held RPCs on one connection survive another connection's close", async () => {
    const holder = await JuncoMcpTools.add(server("holder")).connect({ cwd: seed });
    const other = await JuncoMcpTools.add(server("other")).connect({ cwd: seed });
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
    const connection = await JuncoMcpTools.add(server("cancel")).connect({ cwd: seed });
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
      await expect(held).rejects.toThrow();
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
      ).connect({ cwd: seed });
      const forgetStubborn = defer(() => stubborn.close());
      await call(stubborn, "mcp__stubborn__echo");
      // Forced cancellation discards the command: an unpublished close, never a success.
      await expect(stubborn.close().finally(forgetStubborn)).rejects.toThrow();

      const stalled = await JuncoMcpTools.add(
        server("stalled", { closeTimeoutMs: 200 }),
      ).connect({ cwd: seed });
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
    const lease = await acquireShellMux(seed);
    try {
      const transport = new ShellMuxStdioTransport(lease.mux, {
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
      lease.release();
    }
  }, TIMEOUT);

  test("Marsh authority: a lone server's unauthorized overwrite is denied at finalization", () =>
    withNativeCleanup(async (defer) => {
      const owner = await JuncoMcpTools.add(server("owner")).connect({ cwd: seed });
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
      const first = await JuncoMcpTools.add(server("left")).connect({ cwd: seed });
      const forgetFirst = defer(() => first.close());
      const second = await JuncoMcpTools.add(server("right")).connect({ cwd: seed });
      const forgetSecond = defer(() => second.close());
      await call(first, "mcp__left__write_file", { path: "race.txt", content: "left\n" });
      await call(second, "mcp__right__write_file", { path: "race.txt", content: "right\n" });
      await first.close().finally(forgetFirst);
      await expect(second.close().finally(forgetSecond)).rejects.toThrow();
      expect(await readFile(join(seed, "race.txt"), "utf8")).toBe("left\n");
    }), TIMEOUT);
});

describe("discard-only MCP connections", () => {
  test("a discarded server's file and cache writes never reach the seed; a default one publishes", async () => {
    const discarded = await JuncoMcpTools.add(server("discard")).connect({
      cwd: seed,
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

    const published = await JuncoMcpTools.add(server("publish")).connect({ cwd: seed });
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
      discardOnClose: true,
    });
    // The pending call fails only once the transport has the native verdict, so the exit
    // (even a successful one) has already won against close's cancellation.
    await expect(
      call(connection, "mcp__exits__misbehave", { kind: "exit", code: 0 }),
    ).rejects.toThrow();
    expect(await rejection(connection.close())).toContain(DISCARD_EXIT);
  }, TIMEOUT);

  test("fatal frames still fail a discarded connection", async () => {
    const connection = await JuncoMcpTools.add(server("broken")).connect({
      cwd: seed,
      discardOnClose: true,
    });
    await expect(
      call(connection, "mcp__broken__misbehave", { kind: "malformed" }),
    ).rejects.toThrow();
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
    ).connect({ cwd: seed, signal: controller.signal, discardOnClose: true });
    await Promise.race([
      watch.ready,
      connecting.then(() => assert.fail("connected without holding")),
    ]);
    const pid = watch.pid();
    controller.abort();
    await expect(connecting).rejects.toBeInstanceOf(McpAbortError);
    expect(fixtureRunning(pid)).toBe(false);
  }, TIMEOUT);

  test("direct transport: close discards, external cancellation and early exit stay failures", async () => {
    const lease = await acquireShellMux(seed);
    try {
      const options = {
        command: process.execPath,
        args: [SERVER],
        cwd: seed,
        discardOnClose: true,
      };

      // Requested discard: cancellation is the successful outcome.
      const requested = new ShellMuxStdioTransport(lease.mux, options);
      await requested.start();
      await requested.close();
      await requested.closed;
      expect(requested.terminalError).toBeUndefined();

      // Cancellation the transport did not request is never a successful discard.
      let spawned: NativeProcess | undefined;
      const observed = {
        async spawn(...args: Parameters<NativeMux["spawn"]>) {
          spawned = await lease.mux.spawn(...args);
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
      const early = new ShellMuxStdioTransport(lease.mux, {
        ...options,
        env: { JUNCO_MCP_FIXTURE_MODE: "exit-on-start" },
      });
      await early.start();
      expect(await rejection(early.closed)).toContain(DISCARD_EXIT);
      expect(early.terminalError?.message).toContain("MCP stdio server exited with code 3");
      await early.close().catch(() => {});
    } finally {
      lease.release();
    }
  }, TIMEOUT);
});

describe("MCP acquisition cancellation", () => {
  test("an already aborted signal starts no server", async () => {
    const controller = new AbortController();
    controller.abort();
    const watch = watchStderr();
    await expect(
      JuncoMcpTools.add(server("aborted", { onStderr: watch.onStderr })).connect({
        cwd: seed,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(McpAbortError);
    expect(watch.text).toBe("");
  }, TIMEOUT);

  test("abort during initialize or tool listing stops the server; the mux and other connections stay usable", async () => {
    const existing = await JuncoMcpTools.add(server("existing")).connect({ cwd: seed });
    try {
      for (const phase of ["initialize", "list"] as const) {
        const watch = watchStderr(`hold-${phase}-ready`);
        const controller = new AbortController();
        const connecting = JuncoMcpTools.add(
          server(`held_${phase}`, {
            env: { JUNCO_MCP_FIXTURE_MODE: `hold-${phase}` },
            onStderr: watch.onStderr,
          }),
        ).connect({ cwd: seed, signal: controller.signal });
        // A connection settling before the cue fails the test instead of hanging it.
        await Promise.race([
          watch.ready,
          connecting.then(() => assert.fail("connected without holding")),
        ]);
        const pid = watch.pid();
        expect(fixtureRunning(pid)).toBe(true);
        controller.abort();
        await expect(connecting).rejects.toBeInstanceOf(McpAbortError);
        // The rejection joined cleanup: the process has already exited.
        expect(fixtureRunning(pid)).toBe(false);
      }
      expect((await call(existing, "mcp__existing__echo", { text: "still" })).text).toBe(
        "still",
      );
      const fresh = await JuncoMcpTools.add(server("fresh")).connect({ cwd: seed });
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
      .connect({ cwd: seed, signal: controller.signal });
    await Promise.race([
      second.ready,
      connecting.then(() => assert.fail("connected without holding")),
    ]);
    const pids = [first.pid(), second.pid()];
    expect(pids.map(fixtureRunning)).toEqual([true, true]);
    controller.abort();
    await expect(connecting).rejects.toBeInstanceOf(McpAbortError);
    expect(pids.map(fixtureRunning)).toEqual([false, false]);
  }, TIMEOUT);

  test("a returned connection ignores a later abort of its acquisition signal", async () => {
    const controller = new AbortController();
    const connection = await JuncoMcpTools.add(server("kept")).connect({
      cwd: seed,
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

    const connection = await copy.connect({ cwd: seed });
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

    const later = await original.connect({ cwd: seed });
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
    ).connect({ cwd: seed });
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
