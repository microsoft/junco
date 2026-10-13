import { expect, test } from "bun:test";
import { Opik } from "opik";
import { NodeId } from "dataflow-engine";
import { OpikDataflowTracer } from "../src/index.ts";

// The real Opik SDK exporting over HTTP to a local receiver: no credentials, no recording fake.

type ExportedTrace = Record<string, unknown> & {
  id: string;
  name: string;
  start_time?: string;
  end_time?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

test("each complaint exports one distinct completed trace carrying only node and complaint", async () => {
  const name = "complain-test.run";
  const exported: ExportedTrace[] = [];
  const received = Promise.withResolvers<void>();
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const body = (await request.json()) as { traces?: unknown };
        if (Array.isArray(body.traces)) {
          exported.push(...(body.traces as ExportedTrace[]));
          if (exported.filter((item) => item.name === `${name}.complain`).length >= 2)
            received.resolve();
        }
      }
      return new Response(null, { status: 204 });
    },
  });
  try {
    const tracer = new OpikDataflowTracer(
      new Opik({
        apiUrl: `${receiver.url.href}api`,
        apiKey: "local-test",
        workspaceName: "local-test",
        projectName: "complain-test",
        holdUntilFlush: true,
      }),
      name,
    );
    const node = NodeId.create("worker");
    const complaint = "I cannot reach the coordinator.\nRetries exhausted.";
    tracer.complain(node, complaint);
    tracer.complain(node, complaint);
    await tracer.flush();

    // A real-time bound is the point here: export happens over actual HTTP, so receipt is awaited
    // directly and the deadline only turns a lost request into a failure instead of a hang.
    const deadline = AbortSignal.timeout(5000);
    await Promise.race([
      received.promise,
      new Promise<never>((_, reject) => {
        deadline.addEventListener(
          "abort",
          () => reject(new Error("No Opik complaint traces received")),
          { once: true },
        );
      }),
    ]);

    const records = exported.filter((item) => item.name === `${name}.complain`);
    expect(records).toHaveLength(2);
    expect(new Set(records.map((item) => item.id)).size).toBe(2);
    for (const record of records) {
      expect(record.input).toEqual({ nodeId: "worker" });
      expect(record.output).toEqual({ complaint });
      expect(record.metadata).toEqual({ nodeId: "worker" });
      expect(typeof record.end_time).toBe("string");
      expect(record.end_time).toBe(record.start_time);
      expect(record).not.toHaveProperty("prompt");
      expect(record).not.toHaveProperty("messages");
      expect(record).not.toHaveProperty("parent_span_id");
    }
    expect(exported.filter((item) => item.name !== `${name}.complain`)).toEqual([]);
  } finally {
    receiver.stop(true);
  }
});
