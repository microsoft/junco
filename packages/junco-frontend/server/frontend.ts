import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Events } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import {
  DataflowGraph,
  type DataflowRunTrace,
  type DataflowStepTrace,
  type DataflowTracer,
  type NodeIdType,
} from "dataflow-engine";
import express, { type Express, type Response } from "express";
import * as E from "fp-ts/lib/Either.js";
import type { TSchema } from "typebox";
import type { FrontendEventBody, GraphNode, Link } from "./events.js";

const serials = new WeakMap<object, number>();
let lastSerial = 0;
/** A process-wide number for each graph. */
const serialOf = (object: object): number => {
  let serial = serials.get(object);
  if (serial === undefined) {
    serial = ++lastSerial;
    serials.set(object, serial);
  }
  return serial;
};

/** A JSON snapshot of `value` (an `Error` as its name, message and stack), so later mutation cannot change the log; unencodable values become a capture error. */
const capture = (value: unknown): unknown => {
  const plain =
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value;
  try {
    return JSON.parse(JSON.stringify(plain) ?? "null");
  } catch (error) {
    return { captureError: String(error) };
  }
};

/** A non-negative integer `after` cursor, or `undefined` when `raw` is not one. */
const cursorOf = (raw: unknown): number | undefined => {
  const after = Number(raw ?? 0);
  return Number.isSafeInteger(after) && after >= 0 ? after : undefined;
};

/** The built client: `dist/client` beside `server/` when run from source, `../client` when run from `dist/server`. */
const clientDir = ["../dist/client/", "../client/"]
  .map((dir) => fileURLToPath(new URL(dir, import.meta.url)))
  .find((dir) => existsSync(`${dir}index.html`));

/**
 * A tracer that logs graph runs, activations, agent tool calls and messages in memory and serves
 * that log (`GET /api/events?after=N`, SSE `GET /api/events/stream`) with the monitoring client.
 */
export class JuncoFrontend implements DataflowTracer {
  // shortcut: the log is unbounded in memory, add a ring buffer when a run outgrows RAM
  /** Serialized events; entry `i` has `seq` `i + 1`. */
  readonly #events: string[] = [];
  readonly #clients = new Set<Response>();
  readonly #nodes = new WeakMap<object, { graph: number; id: string }>();
  #runs = 0;
  #url = "";
  /** Set by `listen`, the only way to construct a frontend. */
  #server!: Server;
  #closing: Promise<void> | undefined;

  private constructor() {}

  /** Start serving on `host:port` (default `127.0.0.1`, an ephemeral port). */
  static async listen(
    options: { port?: number; host?: string } = {},
  ): Promise<JuncoFrontend> {
    const { port = 0, host = "127.0.0.1" } = options;
    const frontend = new JuncoFrontend();
    const app = frontend.#app();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const server = app.listen(port, host, (error) =>
      // Bun's node:http passes `null`, Node `undefined`.
      error ? reject(error) : resolve(),
    );
    await promise;
    frontend.#server = server;
    frontend.#url = `http://${host}:${(server.address() as AddressInfo).port}`;
    return frontend;
  }

  /** The server's base URL, e.g. `http://127.0.0.1:4310`. */
  get url(): string {
    return this.#url;
  }

  #app(): Express {
    const app = express();
    app.get("/api/events", (req, res) => {
      const after = cursorOf(req.query.after);
      if (after === undefined) {
        res.status(400).json({ error: "after must be a non-negative integer" });
        return;
      }
      res.type("json").send(`[${this.#events.slice(after).join(",")}]`);
    });
    app.get("/api/events/stream", (req, res) => {
      const after = cursorOf(req.get("Last-Event-ID") ?? req.query.after);
      if (after === undefined) {
        res.status(400).json({ error: "after must be a non-negative integer" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      for (const [i, data] of this.#events.slice(after).entries())
        res.write(`id: ${after + i + 1}\ndata: ${data}\n\n`);
      this.#clients.add(res);
      req.on("close", () => this.#clients.delete(res));
    });
    if (clientDir !== undefined) app.use(express.static(clientDir));
    return app;
  }

  #push(body: FrontendEventBody): void {
    if (this.#closing !== undefined) return;
    const seq = this.#events.length + 1;
    const data = JSON.stringify({ seq, at: new Date().toISOString(), ...body });
    this.#events.push(data);
    for (const client of this.#clients)
      client.write(`id: ${seq}\ndata: ${data}\n\n`);
  }

  startRun<S, N extends TSchema, T, EH>(
    graph: DataflowGraph<S, N, T, EH>,
  ): DataflowRunTrace<N, T> {
    const g = serialOf(graph);
    const run = ++this.#runs;
    const nodes: GraphNode[] = [];
    graph.forEachNode((id, node) => {
      this.#nodes.set(node, { graph: g, id });
      nodes.push({
        id,
        status: node.status,
        ...(node.description === undefined
          ? {}
          : { description: node.description }),
        ...(node.state instanceof DataflowGraph
          ? { child: serialOf(node.state) }
          : {}),
      });
    });
    const links: Link[] = [];
    graph.forEachLink((from, to, edge) => {
      links.push({
        from,
        to,
        id: edge.id,
        kind: E.isLeft(edge.transport) ? "message" : "value",
      });
    });
    this.#push({ kind: "graph", graph: g, nodes, links });
    this.#push({ kind: "run", graph: g, run, phase: "start" });
    return {
      startNode: (id, phase, inputs): DataflowStepTrace<N, T> => {
        const messages = [...(inputs?.messages.keys() ?? [])].map((edge) => ({
          edge,
          payloads: (inputs?.messages.get(edge) ?? []).map(capture),
        }));
        const values = [...(inputs?.values.keys() ?? [])];
        const at = { graph: g, run, node: id };
        this.#push({ kind: "activation", ...at, phase, messages, values });
        return {
          end: (step) => {
            this.#push(
              step.done === true
                ? {
                    kind: "step",
                    ...at,
                    outcome: "return",
                    value: capture(step.value),
                  }
                : {
                    kind: "step",
                    ...at,
                    outcome: "yield",
                    messages: step.value.map((m) => ({
                      edge: m.id,
                      payload: capture(m.payload),
                    })),
                  },
            );
          },
          fail: (error) => {
            this.#push({
              kind: "step",
              ...at,
              outcome: "error",
              error: capture(error),
            });
          },
        };
      },
      end: (results) => {
        this.#push({
          kind: "run",
          graph: g,
          run,
          phase: "end",
          results: [...results.keys()],
        });
      },
      fail: (error) => {
        this.#push({
          kind: "run",
          graph: g,
          run,
          phase: "fail",
          error: capture(error),
        });
      },
    };
  }

  /** Log the agent's tool calls and finished user/assistant messages under its node; returns the detach. */
  observeAgent(node: { readonly id: NodeIdType }, events: Events): () => void {
    const { graph, id } = this.#nodes.get(node) ?? {
      graph: 0,
      id: String(node.id),
    };
    const off = [
      events.on("tool_start", ({ lane, toolCallId, toolName, args }) =>
        this.#push({
          kind: "tool",
          graph,
          node: id,
          lane,
          toolCallId,
          toolName,
          phase: "start",
          args: capture(args),
        }),
      ),
      events.on("tool_end", ({ lane, toolCallId, toolName, result, isError }) =>
        this.#push({
          kind: "tool",
          graph,
          node: id,
          lane,
          toolCallId,
          toolName,
          phase: "end",
          result: capture(result),
          isError,
        }),
      ),
      events.on("message_end", ({ lane, message }) => {
        if (message.role === "assistant")
          this.#push({
            kind: "message",
            graph,
            node: id,
            lane,
            role: "assistant",
            text: contentText(message.content),
            stopReason: message.stopReason,
            ...(message.errorMessage === undefined
              ? {}
              : { errorMessage: message.errorMessage }),
          });
        else if (message.role === "user")
          this.#push({
            kind: "message",
            graph,
            node: id,
            lane,
            role: "user",
            text: contentText(message.content),
          });
      }),
    ];
    return () => {
      for (const unsubscribe of off.splice(0)) unsubscribe();
    };
  }

  /** Stop logging, end every event stream and stop the server; idempotent. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closing = promise;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    this.#server.close((error) => (error ? reject(error) : resolve()));
    this.#server.closeAllConnections();
    return promise;
  }
}
