import { expect, spyOn, test } from "bun:test";
import {
  DataflowGraph,
  EdgeId,
  NodeId,
  type NodeGenerator,
  TriggerRule,
  Width,
} from "dataflow-engine";
import { Opik } from "opik";
import { Type } from "typebox";
import { OpikTracer } from "../src/index.ts";

type Received = { method: string; path: string; body: Record<string, unknown> };
type Entity = Record<string, unknown> & { id: string };
const Schema = Type.Number();

// Exercise the real SDK REST client against HTTP, without credentials or a backend.
function receiver(status: (record: Received) => number | Promise<number>) {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const record: Received = {
        method: request.method,
        path: new URL(request.url).pathname,
        body: (await request.json()) as Record<string, unknown>,
      };
      received.push(record);
      return new Response(null, { status: await status(record) });
    },
  });
  const client = new Opik({
    apiUrl: `${server.url.href}api`,
    apiKey: "local-test",
    workspaceName: "local-test",
    projectName: "trace-test",
  });
  return { received, server, client };
}

async function runOnce(tracer: OpikTracer) {
  const graph = new DataflowGraph<void, typeof Schema, number, never>(
    Width.create(1),
    Width.create(1),
    tracer,
  );
  const only = graph.addNode({
    id: NodeId.create("only"),
    state: undefined,
    trigger: TriggerRule.always(),
    // biome-ignore lint/correctness/useYield: the body must return on its first activation.
    step: async function* (): NodeGenerator<typeof Schema, number> {
      return 42;
    },
  });
  await graph.evaluate((execute) => execute([[{ id: only, inputs: new Map() }]]));
  return graph.result(only);
}

test("evaluate settles only after the trace, its span and both completions were exported, in order", async () => {
  const { received, server, client } = receiver(() => 204);
  try {
    const result = await runOnce(new OpikTracer(client, "trace-test.run"));
    expect(result).toMatchObject({ _tag: "Some", value: 42 });
    const [trace] = received[0]!.body.traces as [Entity];
    const [span] = received[1]!.body.spans as [Entity];
    expect(received.map((r) => [r.method, r.path])).toEqual([
      ["POST", "/api/v1/private/traces/batch"],
      ["POST", "/api/v1/private/spans/batch"],
      ["PATCH", `/api/v1/private/spans/${span.id}`],
      ["PATCH", `/api/v1/private/traces/${trace.id}`],
    ]);
    expect(trace.name).toBe("trace-test.run");
    expect(trace.project_name).toBe("trace-test");
    expect(typeof trace.start_time).toBe("string");
    expect(trace.metadata).toMatchObject({
      _opik_graph_definition: { format: "mermaid" },
    });
    expect(span.name).toBe("only #1");
    expect(span.trace_id).toBe(trace.id);
    expect(span.project_name).toBe("trace-test");
    expect(typeof span.start_time).toBe("string");
    expect(span.input).toEqual({ messages: [], values: [] });
    expect(received[2]!.body.output).toEqual({ value: 42 });
    expect(received[2]!.body.metadata).toEqual({ outcome: "return", nodeStatus: "done" });
    expect(received[2]!.body.trace_id).toBe(trace.id);
    expect(received[2]!.body.project_name).toBe("trace-test");
    expect(typeof received[2]!.body.end_time).toBe("string");
    expect(received[3]!.body.output).toEqual({ results: [{ id: "only", value: 42 }] });
    expect(received[3]!.body.metadata).toEqual({ nodes: [{ id: "only", status: "done" }] });
    expect(received[3]!.body.project_name).toBe("trace-test");
    expect(typeof received[3]!.body.end_time).toBe("string");
  } finally {
    server.stop(true);
  }
});

for (const status of [400, 503]) {
  test(`a failed span PATCH (${status}) is warned once without retrying and the trace still completes`, async () => {
    const { received, server, client } = receiver((r) =>
      r.method === "PATCH" && r.path.startsWith("/api/v1/private/spans/") ? status : 204,
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runOnce(new OpikTracer(client, "trace-test.run"));
      expect(result).toMatchObject({ _tag: "Some", value: 42 });
      const [trace] = received[0]!.body.traces as [Entity];
      const [span] = received[1]!.body.spans as [Entity];
      expect(received.map((r) => [r.method, r.path])).toEqual([
        ["POST", "/api/v1/private/traces/batch"],
        ["POST", "/api/v1/private/spans/batch"],
        ["PATCH", `/api/v1/private/spans/${span.id}`],
        ["PATCH", `/api/v1/private/traces/${trace.id}`],
      ]);
      expect(warn.mock.calls.map(([first]) => first)).toEqual([
        `[dataflow-engine-opik] span ${span.id} update failed`,
      ]);
    } finally {
      warn.mockRestore();
      server.stop(true);
    }
  });
}

test("startNode snapshots mutable inputs before a blocked trace create lets the span reach HTTP", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { received, server, client } = receiver(async (r) => {
    if (r.path === "/api/v1/private/traces/batch") {
      started.resolve();
      await release.promise;
    }
    return 204;
  });
  try {
    const Payload = Type.Object({ count: Type.Number() });
    const graph = new DataflowGraph<void, typeof Payload, number, never>(
      Width.create(1),
      Width.create(1),
    );
    const only = NodeId.create("only");
    const messageEdge = EdgeId.create("messages");
    const valueEdge = EdgeId.create("values");
    const payload = { count: 1 };
    const batch = [payload];
    const values = new Map([[valueEdge, 7]]);
    const run = new OpikTracer(client).startRun(graph);
    const step = run.startNode(only, "resume", {
      messages: new Map([[messageEdge, batch]]),
      values,
    });
    await started.promise;
    expect(received).toHaveLength(1);
    payload.count = 99;
    batch.push({ count: 2 });
    values.set(valueEdge, 99);
    const stepDone = step.end({ done: true, value: 42 });
    const runDone = run.end(new Map([[only, 42]]));
    release.resolve();
    await Promise.all([stepDone, runDone]);
    expect(received).toHaveLength(4);
    const [span] = received[1]!.body.spans as [Entity];
    expect(span.input).toEqual({
      messages: [{ id: "messages", payloads: [{ count: 1 }] }],
      values: [{ id: "values", value: 7 }],
    });
  } finally {
    release.resolve();
    server.stop(true);
  }
});
