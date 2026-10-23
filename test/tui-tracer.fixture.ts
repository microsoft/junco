import assert from "node:assert/strict";
import { appendFileSync, readFileSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  type AssistantMessage,
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  DataflowNodeError,
  type DataflowTracer,
  Edge,
  NodeId,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { LockPolicy } from "junco-tools";
import { flushLog, log, redirectLog } from "junco-tools/log";
import { ctrlC } from "../examples/support.ts";
import {
  type AgenticInput,
  agent,
  Deterministic,
  JuncoGraph,
  schedules,
  tools,
  tracer,
} from "../src/index.ts";
import { terminalPorts } from "./deterministic-support.ts";
import { withNativeCleanup } from "./native-support.ts";
import { leaf, nativeOptions } from "./support.ts";

const flags = new Set(process.argv.slice(2));
const stateFile = process.env.JUNCO_TUI_SMOKE_STATE;
const commandFile = process.env.JUNCO_TUI_SMOKE_COMMAND;
const signalCounts = () =>
  ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) =>
    process.listenerCount(signal),
  );
let signalBaseline: readonly number[];
const phase = (name: string, data: Record<string, unknown> = {}) => {
  if (stateFile)
    appendFileSync(
      stateFile,
      `${JSON.stringify({ phase: name, pid: process.pid, ...data })}\n`,
    );
};

function modes(): string {
  const child = Bun.spawnSync(["stty", "-g"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, new TextDecoder().decode(child.stderr));
  return new TextDecoder().decode(child.stdout).trim();
}

/** Commands are file-only: nothing competes with Crossterm for terminal input. */
function commands() {
  const queued: string[] = [];
  let consumed = 0;
  let notify: (() => void) | undefined;
  const read = () => {
    if (!commandFile) return;
    const lines = readFileSync(commandFile, "utf8").split("\n").slice(0, -1);
    for (const line of lines.slice(consumed))
      queued.push(JSON.parse(line).command);
    consumed = lines.length;
    if (queued.length > 0) notify?.();
  };
  const watcher = commandFile ? watch(dirname(commandFile), read) : undefined;
  read();
  return {
    async next(expected: string) {
      assert.ok(commandFile, `${expected} requires JUNCO_TUI_SMOKE_COMMAND`);
      while (queued.length === 0)
        await new Promise<void>((resolve) => {
          notify = resolve;
          read();
        });
      notify = undefined;
      assert.equal(queued.shift(), expected);
    },
    [Symbol.dispose]() {
      watcher?.close();
    },
  };
}

function cancelled(error: unknown, signal: AbortSignal): boolean {
  while (error instanceof DataflowNodeError) error = error.cause;
  return signal.aborted && error === signal.reason;
}

async function restored(before: string, marker: string) {
  assert.equal(modes(), before, "terminal modes must be restored exactly");
  assert.deepEqual(
    signalCounts(),
    signalBaseline,
    "TUI restoration removes only its temporary signal listeners",
  );
  phase("restored", { marker, modes: before });
  console.log(marker);
}

async function finish(tui: tracer.TuiTracer) {
  let settled = false;
  const pending = tui.flush();
  phase("awaiting-dismissal", { settled });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // A microtask is enough to distinguish an interactive finish from a resolved barrier.
  await Promise.resolve();
  if (!flags.has("--early-dismiss")) assert.equal(settled, false);
  if (flags.has("--close")) {
    await Promise.all([tui.close(), tui.close(), tui[Symbol.asyncDispose]()]);
  }
  await pending;
  await tui.close();
  await tui.close();
}

async function missingBinding(before: string, lazy: boolean) {
  await withNativeCleanup(async (defer) => {
    if (lazy) {
      const tui = tracer.TuiTracer.shared();
      assert.ok(tui instanceof tracer.TuiTracer);
      const forgetTui = defer(() => tui.close());
      const graphPorts = terminalPorts<string, string>();
      const graph = new JuncoGraph(
        graphPorts.source,
        graphPorts.sink,
        Width.create(1),
        UNBOUNDED,
        undefined,
        LockPolicy,
      );
      const graphContext = schedules.context({
        graph: graph,
        scheduler: schedules.parallel(),
      });
      const forgetGraph = defer(() => graph.close());
      const id = graph.addNode({
        id: NodeId.create("missing-binding"),
        trigger: TriggerRule.always(),
        state: new Deterministic<string, string>(async function* () {
          yield [];
          return "computed";
        }, LockPolicy),
      });
      graphPorts.connect(graph, id);
      assert.equal(
        (await graphContext.run()).get(id),
        "computed",
        "display startup must not affect computation",
      );
      await graph.close().finally(forgetGraph);
      await assert.rejects(tui.flush(), (error: unknown) => {
        assert.ok(
          error instanceof Error &&
            error.message === "failed to initialize TuiTracer",
        );
        assert.ok(error.cause instanceof Error);
        return true;
      });
      await assert
        .rejects(tui.close(), /failed to initialize TuiTracer/)
        .finally(forgetTui);
    } else {
      await assert.rejects(tracer.TuiTracer.create(), (error: unknown) => {
        assert.ok(
          error instanceof Error &&
            error.message === "failed to initialize TuiTracer",
        );
        assert.ok(error.cause instanceof Error);
        return true;
      });
    }
    assert.equal(modes(), before);
    // A fresh redirect proves the failed initializer released exclusive logger ownership.
    const records: string[] = [];
    const release = redirectLog({
      write: (line) => {
        records.push(line);
      },
      flush: async () => {},
    });
    try {
      log.error("TUI_STARTUP_LOG_RELEASED");
      await flushLog();
    } finally {
      release();
    }
    assert.ok(
      records.some((line) => line.includes("TUI_STARTUP_LOG_RELEASED")),
    );
  });
  await restored(
    before,
    lazy ? "TUI_LAZY_FAILURE_OK" : "TUI_STARTUP_FAILURE_OK",
  );
}

async function nativeDisplay(before: string) {
  using control = commands();
  // Loading-boundary cases share this fixture; a static addon import would invalidate their native-free checks.
  const { NativeTui } = await import("junco-tools/native");
  await withNativeCleanup(async (defer) => {
    const tui = await NativeTui.open("Native proof");
    defer(() => tui.close());
    await assert.rejects(
      NativeTui.open("second"),
      /A TUI session already owns this terminal/,
    );
    tui.setGraph(
      [
        { key: "left", nodeId: "A", scope: "g1" },
        { key: "right", nodeId: "A", scope: "g2" },
      ],
      ["A --- A", "0123456789".repeat(14)],
      [
        { nodeKey: "left", x: 0, y: 0, width: 1, height: 1 },
        { nodeKey: "right", x: 6, y: 0, width: 1, height: 1 },
      ],
    );
    tui.setActive("left", true);
    tui.setActive("right", true);
    tui.trace({ nodeKey: "left", recordId: "stream", text: "streamed " });
    tui.trace({ nodeKey: "right", text: "native second" });
    await tui.flush();
    phase("active", { stage: "native-both" });
    await control.next("yield");
    tui.setActive("left", false);
    tui.trace({ nodeKey: "left", recordId: "stream", text: "complete" });
    await tui.flush();
    phase("active", { stage: "native-right" });
    await control.next("fail");
    tui.setActive("right", false);
    tui.trace({ nodeKey: "right", text: "native failure", tone: "error" });
    for (let i = 0; i < 80; i++) tui.trace({ text: `scroll record ${i}` });
    await tui.flush();
    phase("active", { stage: "keyboard" });
    await control.next("tiny");
    assert.equal(
      Bun.spawnSync(["stty", "rows", "2", "cols", "2"], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
      0,
    );
    tui.trace({ text: "tiny viewport" });
    await tui.flush();
    phase("active", { stage: "tiny" });
    await control.next("resize");
    assert.equal(
      Bun.spawnSync(["stty", "rows", "30", "cols", "100"], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
      0,
    );
    tui.trace({ text: "resized safely" });
    await tui.flush();
    phase("active", { stage: "resized" });
    await control.next("finish");
    assert.throws(() => tui.setActive("unknown", true));
    assert.throws(() =>
      tui.trace({ nodeKey: "unknown", text: "not a fabricated agent" }),
    );
    assert.throws(() =>
      tui.trace({ text: "invalid", mode: "invalid" as never }),
    );
    assert.throws(() =>
      tui.trace({ text: "invalid", tone: "invalid" as never }),
    );
    for (const x of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32]) {
      assert.throws(() =>
        tui.setGraph(
          [],
          ["invalid geometry"],
          [{ nodeKey: "left", x, y: 0, width: 1, height: 1 }],
        ),
      );
    }
    assert.throws(() =>
      tui.setGraph(
        [],
        [],
        [{ nodeKey: "left", x: 0, y: 0, width: 0, height: 1 }],
      ),
    );
    const pending = tui.finish();
    phase("awaiting-dismissal", { settled: false });
    await pending;
    assert.equal(await tui.waitForExit(), "dismissed");
    await Promise.all([tui.close(), tui.close(), tui.flush()]);
    // Fenced updates, even invalid ones, are discarded after intentional restoration.
    tui.setActive("unknown", true);
    tui.trace({ nodeKey: "unknown", text: "discarded" });
  });
  const fresh = await NativeTui.open("Fresh reservation");
  await fresh.close();
  await restored(before, "TUI_NATIVE_OK");
}

async function renderingFailure(before: string) {
  using control = commands();
  await withNativeCleanup(async (defer) => {
    const tui = await tracer.TuiTracer.create();
    const forgetTui = defer(() => tui.close());
    const graphPorts = terminalPorts<string, string>();
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      tui,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    const forgetGraph = defer(() => graph.close());
    const failure = new Error("tui retained rendering failure");
    // Fail only the TUI layout walk; scheduler observations use the same link iterator.
    const forEachLink = graph.forEachLink.bind(graph);
    graph.forEachLink = (callback) => {
      if (new Error().stack?.includes("frameOf")) throw failure;
      forEachLink(callback);
    };
    const id = graph.addNode({
      id: NodeId.create("RenderFailure"),
      trigger: TriggerRule.always(),
      state: new Deterministic<string, string>(async function* () {
        yield [];
        return "computed";
      }, LockPolicy),
    });
    graphPorts.connect(graph, id);
    assert.equal((await graphContext.run()).get(id), "computed");
    await graph.close().finally(forgetGraph);
    phase("active", { stage: "render-failure" });
    await control.next("finish");
    const pending = tui.flush();
    phase("awaiting-dismissal", { settled: false });
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(error, failure);
      return true;
    });
    await assert
      .rejects(tui.close(), (error: unknown) => {
        assert.equal(error, failure);
        return true;
      })
      .finally(forgetTui);
  });
  assert.equal(modes(), before);
  const records: string[] = [];
  const release = redirectLog({
    write: (line) => {
      records.push(line);
    },
    flush: async () => {},
  });
  try {
    log.error("TUI_RENDER_LOG_RELEASED");
    await flushLog();
  } finally {
    release();
  }
  assert.ok(records.some((line) => line.includes("TUI_RENDER_LOG_RELEASED")));
  await restored(before, "TUI_DISPLAY_FAILURE_OK");
}

async function scopes(tui: tracer.TuiTracer, signal: AbortSignal) {
  using control = commands();
  await withNativeCleanup(async (defer) => {
    const gates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const entered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const roots = gates.map((gate, index) => {
      const rootPorts = terminalPorts<string, string>();
      const root = new JuncoGraph(
        rootPorts.source,
        rootPorts.sink,
        Width.create(1),
        UNBOUNDED,
        tui,
        LockPolicy,
      );
      const rootContext = schedules.context({
        graph: root,
        scheduler: schedules.parallel(),
      });
      defer(() => root.close());
      root.addNode({
        id: NodeId.create("A"),
        trigger: TriggerRule.always(),
        state: new Deterministic<string, string>(async function* () {
          yield [];
          entered[index]!.resolve();
          await gate.promise;
          return index === 0 ? "left result" : "right result";
        }, LockPolicy),
      });
      rootPorts.connect(root, NodeId.create("A"));
      return rootContext;
    });
    defer(() => {
      for (const gate of gates) gate.resolve();
    });
    const runs = roots.map((execution) => execution.run({ signal }));
    // Attach rejection handlers before waiting for control commands.
    const completion = Promise.all(runs);
    completion.catch(() => {});
    await Promise.all(entered.map((entry) => entry.promise));
    phase("active", { stage: "scoped-both" });
    await control.next("left");
    gates[0]!.resolve();
    assert.equal((await runs[0]!).get(NodeId.create("A")), "left result");
    phase("active", { stage: "scoped-right" });
    await control.next("right");
    gates[1]!.resolve();
    await completion;
    for (const execution of roots) await execution.graph.close();
    const replacementPorts = terminalPorts<string, string>();
    const replacement = new JuncoGraph(
      replacementPorts.source,
      replacementPorts.sink,
      Width.create(1),
      UNBOUNDED,
      tui,
      LockPolicy,
    );
    const replacementContext = schedules.context({
      graph: replacement,
      scheduler: schedules.parallel(),
    });
    defer(() => replacement.close());
    replacement.addNode({
      id: NodeId.create("Replacement"),
      trigger: TriggerRule.always(),
      state: new Deterministic<string, string>(async function* () {
        yield [];
        return "new result";
      }, LockPolicy),
    });
    replacementPorts.connect(replacement, NodeId.create("Replacement"));
    await replacementContext.run({ signal });
    await replacement.close();
    phase("active", { stage: "replacement" });
  });
}

async function tasksScenario(tui: tracer.TuiTracer, signal: AbortSignal) {
  using control = commands();
  const { faux, options } = await nativeOptions();
  const worker = fauxProvider({
    api: "tui-worker",
    provider: "tui-worker",
    tokenSize: { min: 4, max: 4 },
  });
  options.models.setProvider(worker.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "task",
          {
            context: "TUI task context",
            tasks: [
              {
                name: "worker",
                task: "Return worker done",
                model: {
                  provider: "tui-worker",
                  modelId: worker.getModel().id,
                },
                tools: [],
              },
            ],
          },
          { id: "spawn-worker" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("waiting for worker"),
    fauxAssistantMessage("combined: worker done"),
  ]);
  worker.setResponses([
    async () => {
      phase("active", { stage: "worker" });
      await Bun.sleep(500);
      if (commandFile) await control.next("worker");
      return fauxAssistantMessage("worker done");
    },
  ]);
  await withNativeCleanup(async (defer) => {
    const caller = await agent.JuncoAgent.fromResolved({
      ...options,
      systemPrompt: "sys",
      tools: [new tools.TaskTool()],
    });
    const forgetCaller = defer(() => caller.return());
    caller.stagePrompt("Start");
    const outerPorts = terminalPorts<AgenticInput, AssistantMessage>();
    const outer = new JuncoGraph(
      outerPorts.source,
      outerPorts.sink,
      Width.create(1),
      UNBOUNDED,
      tui,
      LockPolicy,
    );
    const outerContext = schedules.context({
      graph: outer,
      scheduler: schedules.parallel(),
    });
    defer(() => outer.close());
    const id = outer.addNode({
      id: NodeId.create("caller"),
      policy: LockPolicy,
      trigger: TriggerRule.always(),
      state: caller,
    });
    forgetCaller();
    outerPorts.connect(outer, id);
    const results = await outerContext.run({ signal });
    assert.equal(
      contentText(results.get(id)!.content),
      "combined: worker done",
    );
    const inner = outer.getNode(id)?.state;
    assert.ok(
      inner instanceof JuncoGraph,
      "task promotion must retain the real nested graph",
    );
    const children: string[] = [];
    inner.forEachNode((childId) => {
      if (!["$source", "root", "$sink"].includes(childId))
        children.push(childId);
    });
    assert.equal(children.length, 1);
    assert.ok(children[0]!.startsWith("task-"));
    const result = inner.result(NodeId.create(children[0]!));
    assert.ok(O.isSome(result));
    assert.equal(contentText(result.value.content), "worker done");
    phase("tasks-complete", { childId: children[0] });
  });
}

async function agentsScenario(
  selected: DataflowTracer,
  before: string,
  signal: AbortSignal,
) {
  const explicit = flags.has("--explicit");
  const constructionModes = modes();
  const graphPorts = terminalPorts();
  const graph = new JuncoGraph(
    graphPorts.source,
    graphPorts.sink,
    Width.create(1),
    UNBOUNDED,
    explicit ? selected : undefined,
    LockPolicy,
  );
  const graphContext = schedules.context({
    graph,
    scheduler: schedules.parallel(),
  });
  assert.equal(
    modes(),
    constructionModes,
    "synchronous graph construction must not change terminal modes",
  );
  phase("constructed", { modes: constructionModes });
  const failure = new Error("tui smoke failure");
  let sawFailure = false;
  await withNativeCleanup(async (defer) => {
    const forgetGraph = defer(() => graph.close());
    const response = (node: string, text: string) => async () => {
      phase("active", { node });
      await Bun.sleep(500);
      if (!flags.has("--early-dismiss"))
        assert.notEqual(modes(), before, "first step must open lazily");
      return fauxAssistantMessage(text);
    };
    const alpha = await leaf([response("Alpha", "alpha done")], {
      prompt: "Alpha",
    });
    const forgetAlpha = defer(() => alpha.agent.return());
    const beta = await leaf([response("Beta", "beta done")], {
      prompt: "Beta",
    });
    const forgetBeta = defer(() => beta.agent.return());
    const edge = Edge.value<AgenticInput, AssistantMessage>("alpha=>beta");
    const a = graph.addNode({
      id: NodeId.create("Alpha"),
      policy: LockPolicy,
      trigger: TriggerRule.always(),
      state: alpha.agent,
    });
    forgetAlpha();
    const b = graph.addNode({
      id: NodeId.create("Beta"),
      policy: LockPolicy,
      trigger: TriggerRule.when(edge),
      state: beta.agent,
    });
    forgetBeta();
    graph.addEdge(a, b, edge);
    graphPorts.connect(graph, b);
    if (flags.has("--fail")) {
      const done = Edge.value<AgenticInput, AssistantMessage>("beta=>failure");
      const fail = graph.addNode({
        id: NodeId.create("Failure"),
        trigger: TriggerRule.when(done),
        state: new Deterministic<AgenticInput, AssistantMessage>(
          async function* () {
            yield [];
            throw failure;
          },
          LockPolicy,
        ),
      });
      graph.addEdge(b, fail, done);
    }
    try {
      while (graph.available().size > 0) {
        const step = graphContext.step({ signal });
        if (flags.has("--second-session")) {
          await assert.rejects(
            tracer.TuiTracer.create(),
            /A TUI session already owns this terminal/,
          );
        }
        await step;
      }
    } catch (error) {
      if (cancelled(error, signal)) throw error;
      assert.ok(flags.has("--fail"));
      assert.ok(error instanceof DataflowNodeError);
      assert.equal(error.error, failure);
      assert.equal(error.cause, failure);
      sawFailure = true;
    }
    assert.equal(sawFailure, flags.has("--fail"));
    for (const [id, text] of [
      [a, "alpha done"],
      [b, "beta done"],
    ] as const) {
      const result = graph.result(id);
      assert.ok(O.isSome(result));
      assert.equal(contentText(result.value.content), text);
    }
    await graph.close().finally(forgetGraph);
  });
}

async function quietTerminal(before: string, dumb: boolean) {
  const loaded = Object.keys(createRequire(import.meta.url).cache).filter(
    (path) => path.endsWith(".node"),
  );
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) =>
    process.listenerCount(signal),
  );
  const selected = tracer.TuiTracer.shared();
  if (dumb) {
    assert.ok(selected instanceof tracer.DummyTracer);
    const graphPorts = terminalPorts<string, string>();
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      undefined,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    await withNativeCleanup(async (defer) => {
      defer(() => graph.close());
      const id = graph.addNode({
        id: NodeId.create("quiet"),
        trigger: TriggerRule.always(),
        state: new Deterministic<string, string>(async function* () {
          yield [];
          return "done";
        }, LockPolicy),
      });
      graphPorts.connect(graph, id);
      assert.equal((await graphContext.run()).get(id), "done");
    });
    await assert.rejects(
      tracer.TuiTracer.create(),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "TuiTracer requires an interactive terminal on stdin and stdout",
    );
  } else {
    assert.ok(selected instanceof tracer.TuiTracer);
    const graphPorts = terminalPorts<string, string>();
    const graph = new JuncoGraph(
      graphPorts.source,
      graphPorts.sink,
      Width.create(1),
      UNBOUNDED,
      undefined,
      LockPolicy,
    );
    const graphContext = schedules.context({
      graph: graph,
      scheduler: schedules.parallel(),
    });
    assert.equal(modes(), before);
    await graph.close();
    await selected.flush();
    await selected.close();
    const fresh = tracer.TuiTracer.shared();
    assert.ok(fresh instanceof tracer.TuiTracer && fresh !== selected);
    await fresh.close();
  }
  assert.deepEqual(
    Object.keys(createRequire(import.meta.url).cache).filter((path) =>
      path.endsWith(".node"),
    ),
    loaded,
  );
  assert.deepEqual(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) =>
      process.listenerCount(signal),
    ),
    listeners,
  );
  await restored(before, dumb ? "TUI_DUMB_OK" : "TUI_UNUSED_OK");
}

async function main() {
  using cancellation = ctrlC();
  signalBaseline = signalCounts();
  const before = modes();
  phase("imported", { modes: before });
  if (flags.has("--dumb") || flags.has("--unused"))
    return await quietTerminal(before, flags.has("--dumb"));
  if (flags.has("--missing") || flags.has("--missing-lazy"))
    return await missingBinding(before, flags.has("--missing-lazy"));
  if (flags.has("--native")) return await nativeDisplay(before);
  if (flags.has("--display-failure")) return await renderingFailure(before);
  const require = createRequire(import.meta.url);
  const loadedBefore = Object.keys(require.cache).filter((path) =>
    path.endsWith(".node"),
  );
  let cancellationError: unknown;
  let marker = "TUI_SMOKE_OK";
  await withNativeCleanup(async (defer) => {
    const selected = flags.has("--explicit")
      ? await tracer.TuiTracer.create()
      : tracer.TuiTracer.shared();
    assert.ok(
      selected instanceof tracer.TuiTracer,
      "a real terminal must select TuiTracer",
    );
    defer(() => selected.close());
    if (!flags.has("--explicit")) {
      assert.equal(modes(), before);
      assert.deepEqual(
        Object.keys(require.cache).filter((path) => path.endsWith(".node")),
        loadedBefore,
      );
    }
    try {
      if (flags.has("--tasks")) {
        await tasksScenario(selected, cancellation.signal);
        marker = "TUI_TASKS_OK";
      } else if (flags.has("--scopes")) {
        await scopes(selected, cancellation.signal);
        marker = "TUI_SCOPES_OK";
      } else {
        await agentsScenario(selected, before, cancellation.signal);
        if (flags.has("--fail")) marker = "TUI_FAILURE_OK";
      }
      await finish(selected);
    } catch (error) {
      if (!cancelled(error, cancellation.signal)) throw error;
      cancellationError = error;
      marker = "TUI_CANCELLED";
      throw error;
    }
  }).catch((error) => {
    if (marker !== "TUI_CANCELLED" || error !== cancellationError) throw error;
  });
  await restored(before, marker);
}

await main();
