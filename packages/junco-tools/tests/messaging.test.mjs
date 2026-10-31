import assert from "node:assert/strict";
import test from "node:test";
import {
  DataflowGraph,
  Edge,
  EdgeId,
  NodeId,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { InfoTool, RecvTool, SendTool } from "../dist/messaging.js";

// Native-free: only dist/messaging.js plus the engine for real send admission.

const route = ([id, , schema]) => [EdgeId.create(id), schema];

/**
 * A retained inbox shaped like AgentDriver's: ordered per-edge batches and value cells, each
 * `[id, payloads | value, schema]`, with the recv output schema of those routes.
 */
function inbox(messages = [], values = []) {
  const host = {
    consumed: 0,
    view: {
      messages: new Map(
        messages.map(([id, payloads]) => [EdgeId.create(id), payloads]),
      ),
      values: new Map(values.map(([id, value]) => [EdgeId.create(id), value])),
    },
    recvOutputSchema: RecvTool.outputSchemaFor(
      messages.map(route),
      values.map(route),
    ),
    consume() {
      host.consumed++;
      host.view.messages.clear();
      host.view.values.clear();
    },
  };
  return host;
}

const call = (tool, input = {}, signal) =>
  tool.execute("call-1", input, signal);
const never = () => new AbortController().signal;

/** A schema whose payload sits behind a local `$defs` entry named `P`, scoped by a real edge. */
const scoped = (id, inner) =>
  Edge.message(id, { $defs: { P: inner }, $ref: "#/$defs/P" }).schema;

test("recv flattens per-edge FIFO messages and value envelopes, then drains", async () => {
  const parent = { text: "parent" };
  const host = inbox(
    [
      ["b", ["b1", "b2"], Type.String()],
      ["a", ["a1"], Type.String()],
    ],
    [
      ["v", parent, Type.Object({ text: Type.String() })],
      ["u", undefined, Type.Unknown()],
    ],
  );
  const tool = new RecvTool(host);
  const first = await call(tool);
  assert.deepEqual(first.details, {
    messages: [
      { id: "b", payload: "b1" },
      { id: "b", payload: "b2" },
      { id: "a", payload: "a1" },
    ],
    values: [
      { id: "v", payload: { text: "parent" } },
      { id: "u", payload: undefined },
    ],
  });
  assert.equal(first.details.values[0].payload, parent);
  const json = {
    messages: first.details.messages,
    values: [{ id: "v", payload: { text: "parent" } }, { id: "u" }],
  };
  assert.deepEqual(JSON.parse(first.content[0].text), json);
  assert.deepEqual(first.structuredContent, json);
  const second = await call(tool);
  assert.equal(second.content[0].text, '{"messages":[],"values":[]}');
  assert.equal(host.consumed, 2);
});

test("recv leaves the inbox intact when rendering, cancellation, validation or hosting fails", async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const payload of [cyclic, 1n]) {
    const host = inbox([["m", [payload], Type.Unknown()]]);
    await assert.rejects(call(new RecvTool(host)), TypeError);
    assert.equal(host.consumed, 0);
    assert.equal(host.view.messages.get("m")[0], payload);
  }

  const host = inbox([["m", ["kept"], Type.String()]]);
  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(call(new RecvTool(host), {}, aborted), /stop/);
  await assert.rejects(
    call(new RecvTool(host), { extra: 1 }),
    /^Error: Invalid recv input/,
  );
  await assert.rejects(call(new RecvTool()), /requires a JuncoGraph host/);
  assert.equal(host.consumed, 0);
  assert.deepEqual(host.view.messages.get("m"), ["kept"]);
});

test("recv correlates each message and value route with its own schema and keeps a mismatch unconsumed", async () => {
  const routes = (n, s, vn, vs) => [
    [
      ["n", [n], Type.Number()],
      ["s", [s], Type.String()],
    ],
    [
      ["vn", vn, Type.Number()],
      ["vs", vs, Type.String()],
    ],
  ];
  const ok = inbox(...routes(7, "7", 8, "8"));
  const result = await call(new RecvTool(ok));
  assert.deepEqual(result.structuredContent, {
    messages: [
      { id: "n", payload: 7 },
      { id: "s", payload: "7" },
    ],
    values: [
      { id: "vn", payload: 8 },
      { id: "vs", payload: "8" },
    ],
  });
  assert.equal(ok.consumed, 1);

  for (const swapped of [
    routes("7", "7", 8, "8"),
    routes(7, 7, 8, "8"),
    routes(7, "7", "8", "8"),
    routes(7, "7", 8, 8),
  ]) {
    const host = inbox(...swapped);
    await assert.rejects(
      call(new RecvTool(host)),
      /^Error: Invalid recv output/,
    );
    assert.equal(host.consumed, 0);
    assert.equal(host.view.messages.size, 2);
    assert.equal(host.view.values.size, 2);
  }
});

test("recv omits an undefined payload only where its route's schema admits undefined", async () => {
  const optional = inbox([], [["u", undefined, Type.Unknown()]]);
  const result = await call(new RecvTool(optional));
  assert.deepEqual(result.structuredContent, {
    messages: [],
    values: [{ id: "u" }],
  });

  const required = inbox([], [["n", undefined, Type.Number()]]);
  await assert.rejects(
    call(new RecvTool(required)),
    /^Error: Invalid recv output/,
  );
  assert.equal(required.consumed, 0);
  assert.equal(
    Value.Check(
      RecvTool.outputSchemaFor([], [[EdgeId.create("n"), Type.Number()]]),
      {
        messages: [],
        values: [{ id: "n" }],
      },
    ),
    false,
  );
});

test("unhosted tools announce no routes and still refuse to run", async () => {
  const send = new SendTool();
  for (const input of [{ id: "a", payload: 1 }, {}])
    assert.equal(Value.Check(send.parameters, input), false);
  assert.equal(SendTool.parametersFor([]), send.parameters);
  await assert.rejects(
    call(send, { id: "a", payload: 1 }),
    /send requires a JuncoGraph host/,
  );

  const recv = new RecvTool();
  const empty = { messages: [], values: [] };
  assert.equal(Value.Check(recv.outputSchema, empty), true);
  assert.equal(
    Value.Check(recv.outputSchema, {
      messages: [{ id: "a", payload: 1 }],
      values: [],
    }),
    false,
  );
  assert.deepEqual(recv.outputSchema, RecvTool.outputSchemaFor([], []));
  assert.equal(recv.description, RecvTool.describe(recv.outputSchema));
});

test("hosted tools expose their host's schemas and recv describes its output", () => {
  const sendParameters = SendTool.parametersFor([
    [EdgeId.create("n"), Type.Number()],
  ]);
  assert.equal(
    new SendTool({ sendParameters, send() {} }).parameters,
    sendParameters,
  );
  const host = inbox([["n", [], Type.Number()]]);
  const recv = new RecvTool(host);
  assert.equal(recv.outputSchema, host.recvOutputSchema);
  assert.equal(
    recv.description,
    `Consumes messages and parent values retained for the current graph node. Returns JSON matching: ${JSON.stringify(host.recvOutputSchema)}`,
  );
});

function wiredGraph(routes = [["a->b", Type.Unknown()]]) {
  // Admission only: the passive graph is never driven.
  const graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  const step = async function* () {
    yield [];
  };
  const a = graph.addNode({ id: NodeId.create("a"), state: undefined, step });
  const b = graph.addNode({ id: NodeId.create("b"), state: undefined, step });
  const edges = routes.map(([id, schema]) => Edge.message(id, schema));
  for (const edge of edges) graph.addEdge(a, b, edge);
  const value = Edge.value("a=>b", Type.Number());
  graph.addEdge(a, b, value);
  graph.addEdge(b, a, Edge.message("b->a", Type.Number()));
  const host = (sent = edges) => ({
    sendParameters: SendTool.parametersFor(
      sent.map((edge) => [edge.id, edge.schema]),
    ),
    send: (message) => graph.emit(a, message),
  });
  return { graph, edges, value, out: edges[0], host: host(), hostFor: host };
}

test("send admits one message on a real outgoing message edge, keeping the payload reference", async () => {
  const { out, host } = wiredGraph([
    ["a->b", Type.Object({ kind: Type.Literal("prompt"), text: Type.String() })],
  ]);
  const payload = { kind: "prompt", text: "go" };
  const { id, payload: payloadDomain } = host.sendParameters.properties;
  assert.equal(Value.Check(payloadDomain, payload), true);
  assert.equal(Value.Check(payloadDomain, JSON.stringify(payload)), false);
  assert.equal(Value.Check(id, "a->b"), true);
  assert.equal(Value.Check(id, "nowhere"), false);
  await assert.rejects(
    call(new SendTool(host), { id: "a->b", payload: JSON.stringify(payload) }),
    /^Error: Invalid send input/,
  );
  const result = await call(new SendTool(host), { id: "a->b", payload });
  assert.equal(result.content[0].text, "Message sent.");
  assert.equal(result.details, undefined);
  assert.equal(out.transport.left.length, 1);
  assert.equal(out.transport.left[0], payload);
});

test("send correlates each route's ID with its schema", async () => {
  const { edges, host } = wiredGraph([
    ["n", Type.Number()],
    ["s", Type.String()],
  ]);
  const tool = new SendTool(host);
  const { id, payload } = tool.parameters.properties;
  assert.equal(Value.Check(payload, 7), true);
  assert.equal(Value.Check(payload, "7"), true);
  assert.equal(Value.Check(payload, {}), false);
  assert.equal(Value.Check(id, "n"), true);
  assert.equal(Value.Check(id, "s"), true);
  assert.equal(Value.Check(id, "nowhere"), false);
  await call(tool, { id: "n", payload: 7 });
  await call(tool, { id: "s", payload: "7" });
  for (const input of [
    { id: "n", payload: "7" },
    { id: "s", payload: 7 },
  ])
    await assert.rejects(call(tool, input), /^Error: Invalid send input/);
  assert.deepEqual(
    edges.map((edge) => edge.transport.left),
    [[7], ["7"]],
  );
});

test("send routes cover only outgoing message edges; the engine still guards a wider host", async () => {
  const { out, value, host, hostFor } = wiredGraph();
  const tool = new SendTool(host);
  for (const id of ["nowhere", "b->a", "a=>b"])
    await assert.rejects(
      call(tool, { id, payload: 1 }),
      /^Error: Invalid send input/,
    );
  // A host announcing the value edge as a route still meets the engine's routing check.
  await assert.rejects(
    call(new SendTool(hostFor([out, value])), { id: "a=>b", payload: 1 }),
    /value edge/,
  );
  assert.equal(out.transport.left.length, 0);
});

test("send rejects invalid, unhosted and cancelled calls without emitting", async () => {
  const { out, host } = wiredGraph();
  await assert.rejects(
    call(new SendTool(host), { id: "a->b" }),
    /^Error: Invalid send input/,
  );
  await assert.rejects(
    call(new SendTool(host), { id: "a->b", payload: 1, to: "b" }),
    /^Error: Invalid send input/,
  );
  await assert.rejects(call(new SendTool(), { id: "a->b", payload: 1 }));
  await assert.rejects(
    call(new SendTool(host), { id: "a->b", payload: 1 }, AbortSignal.abort()),
    { name: "AbortError" },
  );
  assert.equal(out.transport.left.length, 0);
});

test("identically named local $defs stay isolated per edge through send and recv", async () => {
  const { edges, host } = wiredGraph([
    ["n", { $defs: { P: Type.Number() }, $ref: "#/$defs/P" }],
    ["s", { $defs: { P: Type.String() }, $ref: "#/$defs/P" }],
  ]);
  const send = new SendTool(host);
  const { payload } = send.parameters.properties;
  assert.equal(Value.Check(payload, 7), true);
  assert.equal(Value.Check(payload, "7"), true);
  assert.equal(Value.Check(payload, {}), false);
  await call(send, { id: "n", payload: 7 });
  await call(send, { id: "s", payload: "7" });
  for (const input of [
    { id: "n", payload: "7" },
    { id: "s", payload: 7 },
  ])
    await assert.rejects(call(send, input), /^Error: Invalid send input/);
  assert.deepEqual(
    edges.map((edge) => edge.transport.left),
    [[7], ["7"]],
  );

  const n = scoped("n", Type.Number());
  const s = scoped("s", Type.String());
  const good = inbox([
    ["n", [7], n],
    ["s", ["7"], s],
  ]);
  await call(new RecvTool(good));
  assert.equal(good.consumed, 1);
  const crossed = inbox([
    ["n", ["7"], n],
    ["s", [7], s],
  ]);
  await assert.rejects(
    call(new RecvTool(crossed)),
    /^Error: Invalid recv output/,
  );
  assert.equal(crossed.consumed, 0);
});

test("invoke validates against the supplied host's schemas, not the construction host's", async () => {
  const numeric = wiredGraph([["e", Type.Number()]]);
  const text = wiredGraph([["e", Type.String()]]);
  const send = new SendTool(numeric.host);
  await assert.rejects(
    call(send, { id: "e", payload: "7" }),
    /Invalid send input/,
  );
  await SendTool.invoke(
    send,
    text.host,
    "c",
    { id: "e", payload: "7" },
    never(),
  );
  await assert.rejects(
    SendTool.invoke(send, text.host, "c", { id: "e", payload: 7 }, never()),
    /Invalid send input/,
  );
  assert.deepEqual(numeric.out.transport.left, []);
  assert.deepEqual(text.out.transport.left, ["7"]);

  const recv = new RecvTool(inbox([["e", ["7"], Type.Number()]]));
  const host = inbox([["e", ["7"], Type.String()]]);
  const result = await RecvTool.invoke(recv, host, "c", {}, never());
  assert.deepEqual(result.details.messages, [{ id: "e", payload: "7" }]);
  assert.equal(host.consumed, 1);
  await assert.rejects(call(recv), /Invalid recv output/);
});

test("info rejects model-supplied identity and absent hosts, and preserves host errors", async () => {
  let calls = 0;
  const details = { parents: [], children: [] };
  const tool = new InfoTool({
    info() {
      calls++;
      return details;
    },
  });
  await assert.rejects(
    call(tool, { nodeId: "other" }),
    /^Error: Invalid info input/,
  );
  assert.equal(calls, 0);
  const result = await call(tool);
  assert.equal(result.details, details);
  assert.equal(result.content[0].text, '{"parents":[],"children":[]}');
  await assert.rejects(call(new InfoTool()));
  const failure = new Error("host failed");
  await assert.rejects(
    call(
      new InfoTool({
        info() {
          throw failure;
        },
      }),
    ),
    (error) => error === failure,
  );
  await assert.rejects(call(tool, {}, AbortSignal.abort()), {
    name: "AbortError",
  });
});

test("a copied tool cannot acquire graph authority through companion invoke", async () => {
  const host = inbox([["m", ["kept"], Type.String()]]);
  const recv = new RecvTool();
  assert.equal(RecvTool.is(recv), true);
  const copy = { ...recv };
  assert.equal(RecvTool.is(copy), false);
  await assert.rejects(
    RecvTool.invoke(copy, host, "c", {}, never()),
    TypeError,
  );
  assert.equal(host.consumed, 0);
  const result = await RecvTool.invoke(recv, host, "c", {}, never());
  assert.deepEqual(result.details.messages, [{ id: "m", payload: "kept" }]);

  const { out, host: sendHost } = wiredGraph();
  const send = new SendTool();
  assert.equal(SendTool.is({ ...send }), false);
  await assert.rejects(
    SendTool.invoke(
      { ...send },
      sendHost,
      "c",
      { id: "a->b", payload: 1 },
      never(),
    ),
    TypeError,
  );
  assert.equal(out.transport.left.length, 0);
  await assert.rejects(
    InfoTool.invoke(
      { ...new InfoTool() },
      { info: () => assert.fail("host reached") },
      "c",
      {},
      never(),
    ),
    TypeError,
  );
});

/** A tiny ProfileRecorder collecting events; `sum`/`gauge` read one operation's metrics. */
function profileRecorder() {
  const events = [];
  const recorder = {
    path: "",
    add_context: () => recorder,
    record: (event) => events.push(event),
    flush: async () => {},
    close: async () => {},
    events,
    of: (operation) => events.filter((e) => e.operation === operation),
    count: (operation, kind, outcome) =>
      recorder
        .of(operation)
        .filter(
          (e) =>
            e.kind === kind && (outcome === undefined || e.outcome === outcome),
        ).length,
    sum: (operation, field) =>
      recorder
        .of(operation)
        .reduce((total, e) => total + (e.counters?.[field] ?? 0), 0),
  };
  recorder.root = recorder;
  return recorder;
}

test("messaging tools count each send, recv and info call once, direct or invoked", async () => {
  const recorder = profileRecorder();
  const sent = [];
  const sendHost = {
    sendParameters: SendTool.parametersFor(
      ["ok", "missing"].map((id) => [EdgeId.create(id), Type.Number()]),
    ),
    send(message) {
      if (message.id !== EdgeId.create("ok")) throw new Error("no such route");
      sent.push(message);
    },
  };
  const send = new SendTool(sendHost, recorder);
  await call(send, { id: "ok", payload: 1 });
  await SendTool.invoke(
    send,
    sendHost,
    "c",
    { id: "ok", payload: 2 },
    new AbortController().signal,
  );
  await assert.rejects(
    call(send, { id: "missing", payload: 3 }),
    /no such route/,
  );
  assert.equal(sent.length, 2);
  assert.equal(recorder.sum("execute", "messages_sent"), 2);
  assert.equal(
    recorder.events.filter((e) => e.tool === "send" && e.kind === "start")
      .length,
    3,
  );
  assert.equal(
    recorder.events.filter((e) => e.tool === "send" && e.outcome === "error")
      .length,
    1,
  );

  const recvEvents = () => recorder.events.filter((e) => e.tool === "recv");
  const host = inbox(
    [["a", ["a1", "a2"], Type.String()]],
    [["v", undefined, Type.Unknown()]],
  );
  const recv = new RecvTool(host, () => recorder);
  await call(recv);
  await RecvTool.invoke(recv, host, "c", {}, new AbortController().signal);
  const sum = (field) =>
    recvEvents().reduce((t, e) => t + (e.counters?.[field] ?? 0), 0);
  assert.equal(sum("messages_received"), 2);
  assert.equal(sum("values_received"), 1);
  assert.equal(
    recvEvents().filter((e) => e.kind === "finish" && e.outcome === "success")
      .length,
    2,
  );
  await assert.rejects(
    call(new RecvTool(undefined, recorder)),
    /requires a JuncoGraph host/,
  );
  assert.equal(recvEvents().filter((e) => e.outcome === "error").length, 1);
  assert.equal(sum("messages_received"), 2);

  const info = new InfoTool(
    {
      info: () => ({
        parents: [{ id: "p", edgeId: "e1", kind: "message" }],
        children: [
          { id: "c", edgeId: "e2", kind: "value" },
          { id: "d", edgeId: "e3", kind: "message" },
        ],
      }),
    },
    recorder,
  );
  await call(info);
  const metrics = recorder.events.find(
    (e) => e.tool === "info" && e.counters?.parents !== undefined,
  );
  assert.deepEqual(metrics.counters, {
    parents: 1,
    children: 2,
    message_routes: 2,
    value_routes: 1,
  });
});
