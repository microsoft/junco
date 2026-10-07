import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// StdoutTracer and the default tracer, observed through real subprocesses: each script drives real
// graphs and the real renderer, so stdout stays isolated from this runner.

const root = join(import.meta.dir, "..");

async function script(
  source: string,
  { env = {} }: { env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, "--no-install", "--eval", source],
    {
      cwd: root,
      // Explicit, so an inherited developer setting cannot change the case.
      env: { ...process.env, LOG_LEVEL: "INFO", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${stderr}\n${stdout}`);
  return { stdout, stderr };
}

/** The drawing printed for one run: everything between its header and its `Trace:` line. */
function graphSection(stdout: string, run: number): string {
  const start = stdout.indexOf(`[run ${run}] `);
  assert.ok(start >= 0, `run ${run} missing`);
  const end = stdout.indexOf("\nTrace:\n", start);
  assert.ok(end > start, `run ${run} has no Trace: line`);
  return stdout.slice(start, end);
}

/**
 * The records containing `pattern`, each required to be logged at `level`, without that prefix.
 */
function lines(stdout: string, pattern: string, level = "INFO"): string[] {
  const found = stdout.split("\n").filter((line) => line.includes(pattern));
  for (const line of found)
    assert.ok(line.startsWith(`${level} `), `not at ${level}: ${line}`);
  return found.map((line) => line.slice(level.length + 1));
}

const GENERIC = `
import assert from "node:assert/strict";
import {
  always, DataflowGraph, emitOnce, messageEdge, msg, NodeId, UNBOUNDED, valueEdge, when, Width,
} from "dataflow-engine";
import { createParallelScheduler } from "junco-scheduler";
import { tracer } from "junco-agency";
const newGraph = (observer) =>
  new DataflowGraph(createParallelScheduler(), Width(1), UNBOUNDED, observer);
const add = (graph, id, state = undefined) =>
  graph.addNode({ id: NodeId(id), state, policy: "LockPolicy", trigger: always(), step: emitOnce(() => [], "done") });
`;

test("the graph section draws every engine Mermaid form as Unicode before any interaction", async () => {
  const { stdout, stderr } = await script(String.raw`${GENERIC}
const inner = newGraph();
inner.addEdge(add(inner, "A"), add(inner, "B"), messageEdge("ab"));
const group = newGraph();
group.addEdge(add(group, "Top"), add(group, "Inner", inner), valueEdge("inner"));
const shared = newGraph();
shared.addEdge(add(shared, "S1"), add(shared, "S2"), valueEdge("s12"));
const root = newGraph(new tracer.StdoutTracer("pretty"));
const a = add(root, 'A"#\n');
const b = add(root, "B&" + String.fromCharCode(124));
root.addEdge(a, b, messageEdge("m%"));
root.addEdge(a, b, valueEdge("v" + String.fromCharCode(124)));
root.addEdge(b, b, messageEdge("self"));
const left = add(root, "Left", shared);
const right = add(root, "Right", shared);
root.addEdge(left, right, messageEdge("between"));
root.addEdge(a, add(root, "Group", group), messageEdge("into"));
add(root, "Empty", newGraph());
const recursive = newGraph();
add(recursive, "Back", root);
add(root, "Rec", recursive);
add(root, "Isolated");
const results = await root.run();
assert.equal(results.size, 8);
await root.tracer.flush();
await new DataflowGraph(createParallelScheduler(), Width(1), UNBOUNDED, new tracer.StdoutTracer("empty")).run();
`);
  assert.equal(stderr, "");
  const drawing = graphSection(stdout, 1);
  const [rootCanvas = ""] = drawing.split("\nSubgraph ");
  for (const label of [
    String.raw`A\"#\n`,
    "B&|",
    "m% (message)",
    "v| (value)",
    "self (message)",
    "Left",
    "Right",
    "between (message)",
    "Group",
    "into (message)",
    "Empty",
    "Rec",
    "Isolated",
  ]) {
    assert.ok(rootCanvas.includes(label), `root canvas lacks ${label}`);
  }
  const headings = drawing
    .split("\n")
    .filter((line) => line.startsWith("Subgraph "));
  assert.deepEqual(headings, [
    'Subgraph ["Left"]:',
    'Subgraph ["Right"]:',
    'Subgraph ["Group"]:',
    'Subgraph ["Group","Inner"]:',
    'Subgraph ["Empty"]:',
    'Subgraph ["Rec"]:',
    'Subgraph ["Rec","Back"]:',
  ]);
  const children = drawing.split("\nSubgraph ").slice(1);
  for (const [index, labels] of [
    ["S1", "S2", "s12 (value)"],
    ["S1", "S2", "s12 (value)"],
    ["Top", "Inner", "inner (value)"],
    ["A", "B", "ab (message)"],
    ["(empty graph)"],
    ["Back"],
    ["(recursive reference)"],
  ].entries()) {
    for (const label of labels) {
      assert.ok(
        children[index]!.includes(label),
        `${headings[index]} lacks ${label}`,
      );
    }
  }
  assert.match(drawing, /[┌┐└┘│─▼]/u);
  assert.doesNotMatch(
    drawing,
    /graph TD|subgraph |\bn\d+\[|-->|end;|#\d+;|rendering failed/,
  );
  assert.doesNotMatch(stdout, /Self-reference|Directions:|Preferred path/);

  const empty = graphSection(stdout, 2);
  assert.ok(empty.endsWith("\n(empty graph)\n"));
  assert.deepEqual(lines(stdout, "[run 2] end"), [
    "[run 2] end { results: [] }",
  ]);
});

test("a 40-node chain renders in Unicode even after another caller selected ASCII", async () => {
  const { stdout, stderr } = await script(`${GENERIC}
import mermaidAscii from "mermaid-ascii";
mermaidAscii.setGraphDirection("LR");
mermaidAscii.setUseAscii(true);
const chain = newGraph(new tracer.StdoutTracer());
let previous = add(chain, "Node0");
for (let index = 1; index < 40; index++) {
  const next = add(chain, "Node" + index);
  chain.addEdge(previous, next, messageEdge("e" + index));
  previous = next;
}
assert.equal((await chain.run()).size, 40);
assert.equal(mermaidAscii.useAscii, true);
assert.equal(mermaidAscii.graphDirection, "LR");
`);
  assert.equal(stderr, "");
  const drawing = graphSection(stdout, 1);
  for (let index = 0; index < 40; index++) {
    assert.match(drawing, new RegExp(`│\\s*Node${index}\\s*│`));
    if (index > 0)
      assert.ok(drawing.includes(`e${index} (message)`), `e${index}`);
  }
  assert.ok(drawing.includes("▼"));
  assert.doesNotMatch(drawing, /\+-|rendering failed/);
});

test("each record is snapshotted when it happens and prints full payloads without application hooks", async () => {
  const { stdout, stderr } = await script(`
import assert from "node:assert/strict";
import { DummyTracer } from "dataflow-engine";
import { graph, schedulers, tracer } from "junco-agency";
let hooks = 0;
function build(observer) {
  const workflow = new graph.JuncoGraph(
    schedulers.createRoundRobinScheduler(), graph.Width(1), graph.Width(1), observer, "LockPolicy",
  );
  const feed = graph.messageEdge("feed");
  const payload = {
    marker: "before",
    big: 12345678901234567890n,
    list: Array.from({ length: 150 }, (_, index) => index),
    text: "x".repeat(20000) + "UNIQUE_SUFFIX",
    get trap() { hooks++; return "trapped"; },
    [Symbol.for("nodejs.util.inspect.custom")]() { hooks++; return "custom"; },
  };
  payload.self = payload;
  const source = workflow.addNode(graph.nodes.deterministicNode(
    new graph.nodes.Deterministic(async function* () {
      yield [graph.msg(feed, payload)];
      return "sent";
    }, "LockPolicy"),
    { id: graph.NodeId("source"), trigger: graph.trigger.always(), policy: "LockPolicy" },
  ));
  const sink = workflow.addNode(graph.nodes.deterministicNode(
    new graph.nodes.Deterministic(async function* () {
      const inputs = yield [];
      const [received] = graph.from(inputs, feed);
      received.marker = "after";
      return received;
    }, "LockPolicy"),
    { id: graph.NodeId("sink"), trigger: graph.trigger.when(feed), policy: "LockPolicy" },
  ));
  workflow.addEdge(source, sink, feed);
  return workflow;
}
const summary = (results) =>
  [...results].map(([id, value]) => [id, typeof value === "string" ? value : value.marker + ":" + value.list.length]);
const quiet = build(new DummyTracer());
const expected = summary(await quiet.run());
const loud = build(new tracer.StdoutTracer());
assert.deepEqual(summary(await loud.run()), expected);
assert.deepEqual(expected, [["source", "sent"], ["sink", "after:150"]]);
assert.equal(hooks, 0);
await loud.tracer.flush();
`);
  assert.equal(stderr, "");
  const [yielded] = lines(stdout, 'node="source" #1 yield');
  const [delivered] = lines(stdout, 'node="sink" #2 resume');
  const [returned] = lines(stdout, 'node="sink" #2 return');
  for (const line of [yielded, delivered]) {
    assert.ok(line?.includes("marker: 'before'"), line);
    assert.ok(line.includes("12345678901234567890n"));
    assert.ok(line.includes("<ref *1>") && line.includes("[Circular *1]"));
    assert.ok(line.includes(" 148, 149 ]"));
    assert.ok(line.includes(`${"x".repeat(20000)}UNIQUE_SUFFIX`));
    assert.ok(line.includes("trap: [Getter]"));
    assert.doesNotMatch(line, /more items|more characters|'trapped'|'custom'/);
  }
  assert.ok(returned?.includes("marker: 'after'"));
  assert.ok(lines(stdout, "[run 1] end")[0]?.includes("marker: 'after'"));
});

test("complaints print one escaped line per node, before, during, and after any graph run", async () => {
  const { stdout, stderr } = await script(`${GENERIC}
const observer = new tracer.StdoutTracer();
observer.complain(NodeId('quoted "id"\\nsecond'), "line one\\nline two\\n  indented");
observer.complain(NodeId(""), "no run is active");
const graph = newGraph(observer);
graph.addNode({
  id: NodeId("busy"), state: undefined, trigger: always(),
  policy: "LockPolicy",
  step: async function* () { observer.complain(NodeId("busy"), "during the run"); return "done"; },
});
await graph.run();
observer.complain(NodeId("busy"), "after the run");
await observer.flush();
`);
  assert.equal(stderr, "");
  const complaints = lines(stdout, "[complaint]");
  assert.deepEqual(complaints, [
    `[complaint] node=${JSON.stringify('quoted "id"\nsecond')} { complaint: 'line one\\nline two\\n  indented' }`,
    `[complaint] node="" { complaint: 'no run is active' }`,
    `[complaint] node="busy" { complaint: 'during the run' }`,
    `[complaint] node="busy" { complaint: 'after the run' }`,
  ]);
  assert.ok(stdout.indexOf(complaints[1]!) < stdout.indexOf("[run "));
  assert.ok(stdout.indexOf(complaints[3]!) > stdout.indexOf("] end"));
});

test("above INFO, trace records are suppressed while operational warnings still reach stdout", async () => {
  const { stdout, stderr } = await script(
    `${GENERIC}
const observer = new tracer.StdoutTracer();
class Unrenderable extends DataflowGraph {
  constructor() { super(createParallelScheduler(), Width(1), UNBOUNDED, observer); }
  pretty() { throw new Error("pretty exploded"); }
}
const graph = new Unrenderable();
add(graph, "only");
assert.deepEqual([...await graph.run()], [["only", "done"]]);
observer.complain(NodeId("only"), "hidden");
await observer.flush();
`,
    { env: { LOG_LEVEL: "WARN" } },
  );
  assert.equal(stderr, "");
  assert.equal(stdout.includes("[run 1]"), false);
  assert.equal(stdout.includes("[complaint]"), false);
  assert.equal(
    lines(stdout, "StdoutTracer graph rendering failed", "WARN").length,
    1,
  );
  assert.ok(stdout.includes("pretty exploded"));
});

test("LOG_LEVEL is parsed once at startup: missing or blank is INFO, names are case-insensitive, others refuse", async () => {
  // Child imports are dynamic on purpose: LOG_LEVEL is read when the logger module loads.
  const printed = async (value: string | undefined): Promise<string[]> => {
    const { stdout, stderr } = await script(
      `${value === undefined ? "delete process.env.LOG_LEVEL;" : ""}
const { log, flushLog } = await import("junco-tools/log");
log.debug("LEVEL_SENTINEL debug");
log.info("LEVEL_SENTINEL info");
log.warn("LEVEL_SENTINEL warn");
await flushLog();
`,
      value === undefined ? {} : { env: { LOG_LEVEL: value } },
    );
    assert.equal(stderr, "");
    return stdout.split("\n").filter((line) => line.includes("LEVEL_SENTINEL"));
  };
  const infoAndUp = ["INFO LEVEL_SENTINEL info", "WARN LEVEL_SENTINEL warn"];
  assert.deepEqual(await printed(undefined), infoAndUp);
  assert.deepEqual(await printed("   "), infoAndUp);
  assert.deepEqual(await printed("  dEbUg  "), [
    "DEBUG LEVEL_SENTINEL debug",
    ...infoAndUp,
  ]);
  assert.deepEqual(await printed("WARN"), ["WARN LEVEL_SENTINEL warn"]);
  for (const value of ["2", "BOGUS"]) {
    const { stdout, stderr } = await script(
      `import assert from "node:assert/strict";
await assert.rejects(import("junco-tools/log"), {
  message: "Junco LOG_LEVEL must be one of SILLY, TRACE, DEBUG, INFO, WARN, ERROR, FATAL",
});
`,
      { env: { LOG_LEVEL: value } },
    );
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  }
});

test("a failing complaint observer warns on stdout at WARN, is silent at ERROR, and the issue is kept", async () => {
  const source = `
import assert from "node:assert/strict";
import { NodeId } from "dataflow-engine";
import { issueLog } from "junco-tools";
import { flushLog } from "junco-tools/log";
issueLog.append(
  { nodeId: NodeId("warning-check"), messages: [], prompt: { systemPrompt: "check", messages: [] }, complaint: "kept" },
  { complain() { throw new Error("complaint-observer-smoke"); } },
);
assert.equal(issueLog.snapshot().at(-1).complaint, "kept");
await flushLog();
`;
  const warned = await script(source, { env: { LOG_LEVEL: "WARN" } });
  assert.equal(warned.stderr, "");
  assert.equal(
    lines(warned.stdout, "DataflowTracer callback failed", "WARN").length,
    1,
  );
  assert.ok(warned.stdout.includes("complaint-observer-smoke"));
  const silent = await script(source, { env: { LOG_LEVEL: "ERROR" } });
  assert.deepEqual(silent, { stdout: "", stderr: "" });
});

test("activation errors, handled recoveries, run failures, and rendering failures are all printed", async () => {
  const { stdout, stderr } = await script(`${GENERIC}
const cause = new Error("source exploded");
function failing(observer, handled) {
  const notice = messageEdge("notice");
  const graph = newGraph(observer);
  const source = graph.addNode({
    id: NodeId("source"),
    state: undefined,
    trigger: always(),
    policy: "LockPolicy",
    async *step() { throw cause; },
    ...(handled ? { on_error: () => [msg(notice, 5)] } : {}),
  });
  const sink = graph.addNode({
    id: NodeId("sink"),
    state: undefined,
    trigger: when(notice),
    policy: "LockPolicy",
    async *step() { yield []; return "sink"; },
  });
  graph.addEdge(source, sink, notice);
  return graph;
}
const observer = new tracer.StdoutTracer();
assert.deepEqual([...await failing(observer, true).run()], [["sink", "sink"]]);
const rejected = await failing(observer, false).run().then(() => undefined, (error) => error);
assert.ok(rejected instanceof Error);
console.log("REJECTION " + rejected.name);

class Unrenderable extends DataflowGraph {
  constructor(kind) { super(createParallelScheduler(), Width(1), UNBOUNDED, observer); this.kind = kind; }
  pretty() {
    if (this.kind === "throw") throw new Error("pretty exploded");
    return "graph LR;";
  }
}
for (const kind of ["throw", "unsupported"]) {
  const graph = new Unrenderable(kind);
  add(graph, "only");
  assert.deepEqual([...await graph.run()], [["only", "done"]]);
}
`);
  // Run 1: the handled failure.
  const handled = stdout.slice(
    stdout.indexOf("[run 1] "),
    stdout.indexOf("[run 2] "),
  );
  assert.equal(lines(handled, 'node="source" #1 error').length, 1);
  assert.ok(
    lines(handled, 'node="source" #1 error')[0]!.includes("source exploded"),
  );
  assert.equal(lines(handled, 'node="source"').length, 2);
  assert.ok(
    lines(handled, 'node="sink" #2 resume')[0]!.includes(
      "messages: [ { id: 'notice', payloads: [ 5 ] } ]",
    ),
  );
  assert.deepEqual(lines(handled, "[run 1] end"), [
    "[run 1] end { results: [ { id: 'sink', value: 'sink' } ] }",
  ]);
  assert.equal(lines(handled, "[run 1] fail").length, 0);
  // Run 2: the unhandled failure rejects the graph and is printed twice: raw and escaping.
  const unhandled = stdout.slice(
    stdout.indexOf("[run 2] "),
    stdout.indexOf("[run 3] "),
  );
  assert.ok(
    lines(unhandled, 'node="source" #1 error')[0]!.includes("source exploded"),
  );
  assert.equal(lines(unhandled, "[run 2] fail").length, 1);
  assert.equal(lines(unhandled, "[run 2] end").length, 0);
  assert.ok(stdout.includes("REJECTION "));
  // Runs 3 and 4: rendering diagnostics, with usable interaction traces.
  assert.equal(
    lines(stdout, "[junco-agency] StdoutTracer graph rendering failed", "WARN")
      .length,
    2,
  );
  assert.equal(stderr, "");
  assert.ok(stdout.includes("pretty exploded"));
  assert.ok(stdout.includes("Unsupported DataflowGraph Mermaid output"));
  assert.ok(graphSection(stdout, 3).endsWith("\n(graph rendering failed)\n"));
  assert.ok(
    graphSection(stdout, 4).includes("(graph rendering failed)\n'graph LR;'"),
  );
  for (const run of [3, 4]) {
    assert.equal(lines(stdout, `[run ${run}] node="only" #1 prime`).length, 1);
    assert.deepEqual(lines(stdout, `[run ${run}] end`), [
      `[run ${run}] end { results: [ { id: 'only', value: 'done' } ] }`,
    ]);
  }
});

test("every invocation prints its own block once, and shared tracers keep run identity in settlement order", async () => {
  const { stdout, stderr } = await script(`${GENERIC}
const observer = new tracer.StdoutTracer();
const feed = messageEdge("feed");
let primes = 0;
const graph = newGraph(observer);
const source = graph.addNode({
  id: NodeId("source"),
  state: undefined,
  trigger: always(),
  policy: "LockPolicy",
  async *step() { primes++; yield [msg(feed, 1)]; return 7; },
});
const sink = graph.addNode({
  id: NodeId("sink"),
  state: undefined,
  trigger: when(feed),
  policy: "LockPolicy",
  async *step() { const view = yield []; return view.messages.get(feed.id).length; },
});
graph.addEdge(source, sink, feed);
await graph.step();
await graph.run();
await graph.step();
assert.equal(primes, 1);
await observer.flush();
await observer.flush();
console.log("FLUSHED");

const gates = { alpha: Promise.withResolvers(), beta: Promise.withResolvers() };
const gated = (name) => {
  const g = newGraph(observer);
  g.addNode({
    id: NodeId(name),
    state: undefined,
    trigger: always(),
    policy: "LockPolicy",
    async *step() { await gates[name].promise; return name + "-result"; },
  });
  return g;
};
const alpha = gated("alpha").run();
const beta = gated("beta").run();
gates.beta.resolve();
await beta;
gates.alpha.resolve();
await alpha;
`);
  assert.equal(stderr, "");
  const headers = lines(stdout, "] DataflowGraph.run");
  assert.deepEqual(headers, [
    "[run 1] DataflowGraph.run",
    "[run 2] DataflowGraph.run",
    "[run 3] DataflowGraph.run",
    "[run 4] DataflowGraph.run",
    "[run 5] DataflowGraph.run",
  ]);
  assert.equal(
    lines(stdout, 'node="source"').filter((line) => line.includes(" prime "))
      .length,
    1,
  );
  assert.equal(lines(stdout, "[run 3] node=").length, 0);
  assert.deepEqual(lines(stdout, "[run 3] end"), [
    "[run 3] end { results: [ { id: 'source', value: 7 }, { id: 'sink', value: 1 } ] }",
  ]);
  assert.ok(stdout.indexOf("FLUSHED") > stdout.indexOf("[run 3] end"));
  assert.equal(stdout.split("FLUSHED")[1]!.includes("[run 3]"), false);

  for (const [run, name] of [
    [4, "alpha"],
    [5, "beta"],
  ] as const) {
    assert.ok(graphSection(stdout, run).includes(name));
    const nodeLines = lines(stdout, `node="${name}"`);
    assert.deepEqual(
      nodeLines.map((line) => line.split(" ")[4]),
      ["prime", "return"],
    );
    assert.ok(nodeLines.every((line) => line.startsWith(`[run ${run}] `)));
  }
  assert.ok(stdout.indexOf("[run 5] end") < stdout.indexOf("[run 4] end"));
  assert.ok(lines(stdout, "[run 4] end")[0]!.includes("'alpha-result'"));
  assert.ok(lines(stdout, "[run 5] end")[0]!.includes("'beta-result'"));
});

const AGENCY = `
import assert from "node:assert/strict";
import { DummyTracer } from "dataflow-engine";
import { graph, schedulers, tracer } from "junco-agency";
async function deterministic(observer) {
  const workflow = new graph.JuncoGraph(
    schedulers.createRoundRobinScheduler(), graph.Width(1), graph.Width(1), observer, "LockPolicy",
  );
  workflow.addNode(graph.nodes.deterministicNode(
    new graph.nodes.Deterministic(async function* () { return 3; }, "LockPolicy"),
    { id: graph.NodeId("only"), trigger: graph.trigger.always(), policy: "LockPolicy" },
  ));
  const factory = graph.createParallelAgentGraph("LockPolicy", observer);
  assert.equal(factory.tracer, observer);
  try {
    assert.deepEqual([...await workflow.run()], [["only", 3]]);
  } finally {
    await workflow.close();
    await factory.close();
  }
}
`;

test("JuncoGraph requires a tracer; the factory default is the shared StdoutTracer", async () => {
  const { stdout } = await script(`${AGENCY}
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { agent as agentApi } from "junco-agency";
import { ralph } from "junco-agency/workflows";
const selected = tracer.createTracer();
assert.ok(selected instanceof tracer.StdoutTracer);
assert.equal(tracer.createTracer(), selected);
const direct = new graph.JuncoGraph(
  schedulers.createRoundRobinScheduler(), graph.Width(1), graph.Width(1), tracer.createTracer(), "LockPolicy",
);
assert.equal(direct.tracer, selected);
const factory = graph.createParallelAgentGraph("LockPolicy");
assert.equal(factory.tracer, selected);

const scheduler = schedulers.createRoundRobinScheduler();
let binds = 0;
const bind = scheduler.bind;
scheduler.bind = (...args) => { binds++; return bind?.apply(scheduler, args); };
for (const args of [[], [undefined], [null]]) {
  assert.throws(
    () => new graph.JuncoGraph(scheduler, graph.Width(1), graph.Width(1), ...args),
    (error) => error instanceof TypeError && error.message === "JuncoGraph requires a tracer",
  );
}
assert.equal(binds, 0);

const faux = fauxProvider({ api: "stdout-tracer-ralph", provider: "stdout-tracer-ralph" });
const models = createModels();
models.setProvider(faux.provider);
const agent = await agentApi.JuncoAgent.fromResolved({
  session: await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT),
  models,
  model: faux.getModel(),
  tools: [],
  policy: "LockPolicy",
});
const parent = graph.createParallelAgentGraph("LockPolicy", new tracer.StdoutTracer("parent"));
const id = ralph(parent, agent, { input: graph.messageEdge("in"), output: graph.messageEdge("out"), policy: "LockPolicy" });
assert.equal(parent.getNode(id).state.tracer, parent.tracer);
await parent.close();
await Promise.all([direct.close(), factory.close()]);
console.log("SELECTED");
await deterministic(new DummyTracer());
`);
  assert.equal(stdout, "SELECTED\n");
});
