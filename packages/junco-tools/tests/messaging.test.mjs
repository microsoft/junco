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
import { InfoTool, RecvTool, SendTool } from "../dist/messaging.js";

// Native-free: only dist/messaging.js plus the engine for real send admission.

/** A retained inbox shaped like AgentDriver's: ordered per-edge batches and value cells. */
function inbox(messages = [], values = []) {
  const host = {
    consumed: 0,
    view: { messages: new Map(messages), values: new Map(values) },
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

test("recv flattens per-edge FIFO messages and value envelopes, then drains", async () => {
  const host = inbox(
    [
      [EdgeId.create("b"), ["b1", "b2"]],
      [EdgeId.create("a"), ["a1"]],
    ],
    [
      [EdgeId.create("v"), { text: "parent" }],
      [EdgeId.create("u"), undefined],
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
  assert.deepEqual(JSON.parse(first.content[0].text), {
    messages: first.details.messages,
    values: [{ id: "v", payload: { text: "parent" } }, { id: "u" }],
  });
  const second = await call(tool);
  assert.equal(second.content[0].text, '{"messages":[],"values":[]}');
  assert.equal(host.consumed, 2);
});

test("recv leaves the inbox intact when rendering, cancellation, validation or hosting fails", async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const payload of [cyclic, 1n]) {
    const host = inbox([[EdgeId.create("m"), [payload]]]);
    await assert.rejects(call(new RecvTool(host)), TypeError);
    assert.equal(host.consumed, 0);
    assert.equal(host.view.messages.get("m")[0], payload);
  }

  const host = inbox([[EdgeId.create("m"), ["kept"]]]);
  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(call(new RecvTool(host), {}, aborted), /stop/);
  await assert.rejects(
    call(new RecvTool(host), { extra: 1 }),
    /^Error: Invalid recv input/,
  );
  await assert.rejects(call(new RecvTool()));
  assert.equal(host.consumed, 0);
  assert.deepEqual(host.view.messages.get("m"), ["kept"]);
});

function wiredGraph() {
  // Admission only: the passive graph is never driven.
  const graph = new DataflowGraph(Width.create(1), UNBOUNDED);
  const step = async function* () {
    yield [];
  };
  const a = graph.addNode({ id: NodeId.create("a"), state: undefined, step });
  const b = graph.addNode({ id: NodeId.create("b"), state: undefined, step });
  const out = Edge.message("a->b");
  graph.addEdge(a, b, out);
  graph.addEdge(a, b, Edge.value("a=>b"));
  graph.addEdge(b, a, Edge.message("b->a"));
  return { graph, out, host: { send: (message) => graph.emit(a, message) } };
}

test("send admits one message on a real outgoing message edge, keeping the payload reference", async () => {
  const { out, host } = wiredGraph();
  const payload = { kind: "prompt", text: "go" };
  const result = await call(new SendTool(host), { id: "a->b", payload });
  assert.equal(result.content[0].text, "Message sent.");
  assert.equal(result.details, undefined);
  assert.equal(out.transport.left.length, 1);
  assert.equal(out.transport.left[0], payload);
});

test("send propagates admission errors for unwired, incoming-only and value edges", async () => {
  const { out, host } = wiredGraph();
  const tool = new SendTool(host);
  for (const id of ["nowhere", "b->a"])
    await assert.rejects(call(tool, { id, payload: 1 }), /unwired edge/);
  await assert.rejects(call(tool, { id: "a=>b", payload: 1 }), /value edge/);
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
  const failure = new Error("no contract");
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
  const host = inbox([[EdgeId.create("m"), ["kept"]]]);
  const recv = new RecvTool();
  assert.equal(RecvTool.is(recv), true);
  const copy = { ...recv };
  assert.equal(RecvTool.is(copy), false);
  await assert.rejects(
    RecvTool.invoke(copy, host, "c", {}, new AbortController().signal),
    TypeError,
  );
  assert.equal(host.consumed, 0);
  const result = await RecvTool.invoke(
    recv,
    host,
    "c",
    {},
    new AbortController().signal,
  );
  assert.deepEqual(result.details.messages, [{ id: "m", payload: "kept" }]);

  const { out, host: sendHost } = wiredGraph();
  await assert.rejects(
    SendTool.invoke(
      { ...new SendTool() },
      sendHost,
      "c",
      { id: "a->b", payload: 1 },
      new AbortController().signal,
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
      new AbortController().signal,
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
    [[EdgeId.create("a"), ["a1", "a2"]]],
    [[EdgeId.create("v"), undefined]],
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
        parents: [{ id: "p", edgeId: "e1", kind: "message", expect: "x" }],
        children: [
          { id: "c", edgeId: "e2", kind: "value", expect: "y" },
          { id: "d", edgeId: "e3", kind: "message", expect: "z" },
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
