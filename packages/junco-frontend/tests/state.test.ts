import { expect, test } from "bun:test";
import { EMPTY, isTask, reduce, type State } from "../client/state.ts";
import type { FrontendEvent, FrontendEventBody } from "../server/index.ts";

let seq = 0;
const at = "2026-01-01T00:00:00.000Z";
const step = (state: State, body: FrontendEventBody): State =>
  reduce(state, { seq: ++seq, at, ...body } as FrontendEvent);

const task = {
  kind: "prompt",
  text: "do",
  taskId: "T1",
  spec: "",
  deps: [],
  history: [],
};
const where = { graph: 1, run: 1 };

test("a handed-off task's card moves queued → running → waiting, and a return leaves it waiting", () => {
  let state = step(EMPTY, {
    kind: "graph",
    graph: 1,
    nodes: [
      { id: "a", status: "ready" },
      { id: "b", status: "ready" },
    ],
    links: [{ from: "a", to: "b", id: "e", kind: "message" }],
  });
  state = step(state, {
    kind: "activation",
    ...where,
    node: "a",
    phase: "prime",
    messages: [],
    values: [],
  });
  expect(state.graphs[1]?.nodes.a?.live).toBe("running");
  state = step(state, {
    kind: "step",
    ...where,
    node: "a",
    outcome: "yield",
    messages: [{ edge: "e", payload: task }],
  });
  expect(state.graphs[1]?.nodes.a?.live).toBe("waiting");
  expect(state.cards["T1@b"]?.status).toBe("queued");
  state = step(state, {
    kind: "activation",
    ...where,
    node: "b",
    phase: "resume",
    messages: [{ edge: "e", payloads: [task] }],
    values: [],
  });
  expect(state.cards["T1@b"]?.status).toBe("running");
  state = step(state, {
    kind: "step",
    ...where,
    node: "b",
    outcome: "yield",
    messages: [],
  });
  expect(state.cards["T1@b"]?.status).toBe("waiting");
  state = step(state, {
    kind: "step",
    ...where,
    node: "b",
    outcome: "return",
    value: 2,
  });
  expect(state.cards["T1@b"]).toMatchObject({
    status: "waiting",
    taskId: "T1",
    node: "b",
    summary: "prompt: do",
  });
  expect(state.graphs[1]?.nodes.a?.live).toBe("waiting");
  expect(state.log).toHaveLength(seq);
});

test("a tool start and end fold into one call", () => {
  const call = {
    kind: "tool",
    graph: 1,
    node: "a",
    lane: "main",
    toolCallId: "c1",
    toolName: "read",
  } as const;
  let state = step(EMPTY, { ...call, phase: "start", args: { path: "x" } });
  state = step(state, {
    ...call,
    phase: "end",
    result: { ok: true },
    isError: false,
  });
  expect(state.tools).toEqual([
    expect.objectContaining({
      toolName: "read",
      args: { path: "x" },
      result: { ok: true },
      isError: false,
      endedAt: at,
    }),
  ]);
});

test("only complete tasks are tasks", () => {
  expect(isTask({ role: "assistant" })).toBe(false);
  expect(isTask({ kind: "prompt", text: "x" })).toBe(false);
  expect(isTask({ kind: "prompt", text: "x", taskId: "T1" })).toBe(false);
  expect(
    isTask({
      kind: "prompt",
      text: "x",
      taskId: "T1",
      spec: "",
      deps: [],
      history: [],
    }),
  ).toBe(true);
});
