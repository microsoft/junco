import { expect, test } from "bun:test";
import type { Events } from "@earendil-works/pi-agent-core";
import {
  DataflowGraph,
  Edge,
  Message,
  type NodeGenerator,
  NodeId,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import { context, parallel } from "junco-scheduler";
import { Type } from "typebox";
import { type FrontendEvent, JuncoFrontend } from "../server/index.ts";

const Schema = Type.Object({
  kind: Type.String(),
  text: Type.String(),
  taskId: Type.String(),
  spec: Type.String(),
  deps: Type.Array(Type.String()),
  history: Type.Array(
    Type.Object({
      node: Type.String(),
      desc: Type.String(),
      handoff: Type.String(),
    }),
  ),
});
type S = typeof Schema;

const newGraph = (frontend: JuncoFrontend) =>
  new DataflowGraph<void, S, number, never>(
    Width.create(1),
    UNBOUNDED,
    frontend,
  );

/** `a` hands task T1 to `b` on edge `e`; both then return. */
async function runHandoff(frontend: JuncoFrontend): Promise<void> {
  const graph = newGraph(frontend);
  const e = Edge.message<S, number>("e", Schema);
  const a = graph.addNode({
    id: NodeId.create("a"),
    state: undefined,
    trigger: TriggerRule.always(),
    step: async function* (): NodeGenerator<S, number> {
      yield [
        Message.create(e, {
          kind: "prompt",
          text: "do",
          taskId: "T1",
          spec: "",
          deps: [],
          history: [],
        }),
      ];
      return 1;
    },
  });
  const b = graph.addNode({
    id: NodeId.create("b"),
    state: undefined,
    trigger: TriggerRule.when(e),
    step: async function* (): NodeGenerator<S, number> {
      yield []; // prime; the delivery resumes it
      return 2;
    },
  });
  graph.addEdge(a, b, e);
  await context({ graph, scheduler: parallel() }).run();
}

const eventsOf = async (
  frontend: JuncoFrontend,
  query = "",
): Promise<FrontendEvent[]> =>
  (await fetch(`${frontend.url}/api/events${query}`)).json() as Promise<
    FrontendEvent[]
  >;

test("a run's topology, activations and steps are served in order", async () => {
  const frontend = await JuncoFrontend.listen();
  try {
    await runHandoff(frontend);
    const log = await eventsOf(frontend);
    expect(log.map((event) => event.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log[0]).toMatchObject({ kind: "graph", seq: 1 });
    if (log[0]?.kind !== "graph") throw new Error("first event is not graph");
    expect(log[0].nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(log[0].links[0]).toMatchObject({
      from: "a",
      to: "b",
      kind: "message",
    });
    expect(log).toContainEqual(
      expect.objectContaining({ kind: "run", phase: "start" }),
    );
    expect(log).toContainEqual(
      expect.objectContaining({
        kind: "activation",
        node: "a",
        phase: "prime",
      }),
    );
    const yielded = log.find(
      (event) =>
        event.kind === "step" &&
        event.node === "a" &&
        event.outcome === "yield",
    );
    if (yielded?.kind !== "step" || yielded.outcome !== "yield")
      throw new Error("a never yielded");
    expect(yielded.messages[0]?.payload).toMatchObject({ taskId: "T1" });
    const delivered = log.find(
      (event) =>
        event.kind === "activation" &&
        event.node === "b" &&
        event.phase === "resume",
    );
    if (delivered?.kind !== "activation") throw new Error("b never activated");
    expect(delivered.messages[0]?.payloads[0]).toMatchObject({ taskId: "T1" });
    expect(delivered.seq).toBeGreaterThan(yielded.seq);
    expect(log).toContainEqual(
      expect.objectContaining({
        kind: "step",
        node: "b",
        outcome: "return",
        value: 2,
      }),
    );
    const end = log.find(
      (event) => event.kind === "run" && event.phase === "end",
    );
    if (end?.kind !== "run" || end.phase !== "end")
      throw new Error("run never ended");
    expect(end.results.toSorted()).toEqual(["a", "b"]);

    const after = await eventsOf(frontend, "?after=1");
    expect(after.map((event) => event.seq)).toEqual(
      log.slice(1).map((event) => event.seq),
    );
    expect((await fetch(`${frontend.url}/api/events?after=x`)).status).toBe(
      400,
    );
  } finally {
    await frontend.close();
  }
});

test("the event stream replays the log as SSE frames and ends on close", async () => {
  const frontend = await JuncoFrontend.listen();
  await runHandoff(frontend);
  const response = await fetch(`${frontend.url}/api/events/stream?after=0`);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  expect(text.startsWith("id: 1\ndata: ")).toBe(true);
  expect(
    JSON.parse(text.split("\n\n")[0]!.split("\ndata: ")[1]!),
  ).toMatchObject({
    seq: 1,
    kind: "graph",
  });
  const url = frontend.url;
  await frontend.close();
  let chunk = await reader.read();
  while (!chunk.done) chunk = await reader.read(); // close ends the stream
  await expect(fetch(`${url}/api/events`)).rejects.toThrow();
});

test("observeAgent logs tool calls and finished messages under the node until detached", async () => {
  const frontend = await JuncoFrontend.listen();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const events = {
    on(type: string, listener: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  } as unknown as Events;
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const call = {
    lane: "main",
    runId: "r",
    turnId: "t",
    toolCallId: "c1",
    toolName: "read",
  };
  const emitAll = () => {
    emit("tool_start", { ...call, args: { path: "x" } });
    emit("tool_end", { ...call, result: { ok: true }, isError: false });
    emit("message_end", {
      lane: "main",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
    });
  };
  try {
    const graph = newGraph(frontend);
    graph.addNode({
      id: NodeId.create("only"),
      state: undefined,
      trigger: TriggerRule.always(),
      // biome-ignore lint/correctness/useYield: the body returns on its first activation.
      step: async function* (): NodeGenerator<S, number> {
        // The registered node object, as the agent node passes it.
        const detach = frontend.observeAgent(this, events);
        emitAll();
        detach();
        emitAll();
        return 0;
      },
    });
    await context({ graph, scheduler: parallel() }).run();
    const log = await eventsOf(frontend);
    const serial = log[0]?.kind === "graph" ? log[0].graph : -1;
    const agent = log.filter(
      (event) => event.kind === "tool" || event.kind === "message",
    );
    expect(agent).toEqual([
      expect.objectContaining({
        kind: "tool",
        phase: "start",
        graph: serial,
        node: "only",
        args: { path: "x" },
      }),
      expect.objectContaining({
        kind: "tool",
        phase: "end",
        graph: serial,
        node: "only",
        result: { ok: true },
        isError: false,
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        graph: serial,
        node: "only",
        text: "done",
        stopReason: "stop",
      }),
    ]);
  } finally {
    await frontend.close();
  }
});
