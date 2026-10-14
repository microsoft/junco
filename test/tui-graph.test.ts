import { test } from "bun:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  DataflowGraph,
  DummyTracer,
  Edge,
  EmitOnce,
  NodeId,
  renderPretty,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import { ParallelScheduler } from "junco-scheduler";
import mermaidAscii from "mermaid-ascii";
import { escapeTuiLabel, renderTuiGraph } from "../src/tui-graph.ts";
import { formatTuiPayload } from "../src/tui-tracer.ts";

const graph = () =>
  new DataflowGraph<unknown, unknown, string, unknown>(
    new ParallelScheduler(),
    Width.create(1),
    UNBOUNDED,
    new DummyTracer(),
  );
const add = (
  g: ReturnType<typeof graph>,
  id: string,
  state: unknown = undefined,
) =>
  g.addNode(
    new EmitOnce(() => [], "done", {
      id: NodeId.create(id),
      state,
      trigger: TriggerRule.always(),
    }),
  );

test("layout rectangles identify exact escaped labels, not drawing substrings", () => {
  const g = graph();
  const ids = ["A", "AA", 'A"#\n', "分析🤖"];
  const nodes = ids.map((id) => add(g, id));
  g.addEdge(nodes[0]!, nodes[1]!, Edge.message("A"));
  g.addEdge(nodes[0]!, nodes[1]!, Edge.value("parallel"));
  g.addEdge(nodes[1]!, nodes[1]!, Edge.message("self"));
  const [section] = renderTuiGraph(renderPretty(g));
  assert.ok(section);
  assert.deepEqual(
    section.boxes.map((box) => box.id),
    ids,
  );
  for (const box of section.boxes) {
    const inside = section.lines
      .slice(box.y, box.y + box.height)
      .map((line) => line.slice(box.x, box.x + box.width))
      .join("\n");
    assert.ok(inside.includes(escapeTuiLabel(box.id)), inside);
    assert.ok(box.width > 0 && box.height > 0);
    assert.match(inside, /[┌┐└┘]/u);
  }
  const canvas = section.lines.join("\n");
  assert.ok(canvas.includes("A (message) / parallel (value)"));
  assert.ok(canvas.includes("self (message)"));
  assert.ok(!canvas.includes("分析"));
});

test("shared nested scopes, empty scopes and recursion retain preorder geometry", () => {
  const root = graph();
  const shared = graph();
  add(shared, "A");
  add(root, "Left", shared);
  add(root, "Right", shared);
  add(root, "Empty", graph());
  const rec = graph();
  add(rec, "Back", root);
  add(root, "Rec", rec);
  const sections = renderTuiGraph(renderPretty(root));
  assert.deepEqual(
    sections.map((s) => s.path),
    [[], ["Left"], ["Right"], ["Empty"], ["Rec"], ["Rec", "Back"]],
  );
  assert.equal(sections[1]!.boxes[0]!.id, "A");
  assert.equal(sections[2]!.boxes[0]!.id, "A");
  assert.ok(sections[3]!.lines.join("\n").includes("(empty graph)"));
  assert.ok(sections[5]!.lines.join("\n").includes("(recursive reference)"));
  assert.deepEqual(renderTuiGraph(""), [
    { path: [], lines: ["(empty graph)"], boxes: [] },
  ]);
});

test("long layouts restore library settings on success and validation failure", () => {
  const g = graph();
  let previous = add(g, "node-0");
  for (let i = 1; i < 40; i++) {
    const next = add(g, `node-${i}`);
    g.addEdge(previous, next, Edge.value(`edge-${i}`));
    previous = next;
  }
  const direction = mermaidAscii.graphDirection;
  const ascii = mermaidAscii.useAscii;
  mermaidAscii.setGraphDirection("LR");
  mermaidAscii.setUseAscii(true);
  try {
    assert.equal(renderTuiGraph(renderPretty(g))[0]!.boxes.length, 40);
    assert.equal(mermaidAscii.graphDirection, "LR");
    assert.equal(mermaidAscii.useAscii, true);
    assert.throws(() =>
      renderTuiGraph('graph TD;\nn0["A"];\nn0 -->|"edge"| n1;'),
    );
    assert.equal(mermaidAscii.graphDirection, "LR");
    assert.equal(mermaidAscii.useAscii, true);
    assert.throws(() => renderTuiGraph('graph TD;\nn0["A"];\nn0["B"];'));
  } finally {
    mermaidAscii.setGraphDirection(direction);
    mermaidAscii.setUseAscii(ascii);
  }
});

test("payload formatting snapshots immediately without application hooks", () => {
  let hooks = 0;
  const payload = {
    value: "before",
    bigint: 12345678901234567890n,
    long: "x".repeat(100_000),
    get computed() {
      hooks++;
      return "unsafe";
    },
    [inspect.custom]() {
      hooks++;
      return "unsafe";
    },
    cycle: undefined as unknown,
  };
  payload.cycle = payload;
  const formatted = formatTuiPayload(payload);
  payload.value = "after";
  assert.ok(formatted.includes("before"));
  assert.ok(!formatted.includes("after"));
  assert.ok(formatted.includes("12345678901234567890n"));
  assert.ok(formatted.includes(payload.long));
  assert.match(formatted, /Circular/);
  assert.equal(hooks, 0);
});

test("Error diagnostics retain data messages even when stack headers omit them", () => {
  const error = new Error("retained failure message");
  error.stack = "Error\n    at consumer";
  assert.ok(formatTuiPayload(error).includes("retained failure message"));
  let getters = 0;
  Object.defineProperty(error, "message", {
    get() {
      getters++;
      return "unsafe";
    },
  });
  formatTuiPayload(error);
  assert.equal(getters, 0);
});
