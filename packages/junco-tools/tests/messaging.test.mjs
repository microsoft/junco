import assert from "node:assert/strict";
import test from "node:test";
import {
  DataflowGraph,
  EdgeId,
  messageEdge,
  NodeId,
  UNBOUNDED,
  valueEdge,
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
      [EdgeId("b"), ["b1", "b2"]],
      [EdgeId("a"), ["a1"]],
    ],
    [
      [EdgeId("v"), { text: "parent" }],
      [EdgeId("u"), undefined],
    ],
  );
  const tool = RecvTool(host);
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
    const host = inbox([[EdgeId("m"), [payload]]]);
    await assert.rejects(call(RecvTool(host)), TypeError);
    assert.equal(host.consumed, 0);
    assert.equal(host.view.messages.get("m")[0], payload);
  }

  const host = inbox([[EdgeId("m"), ["kept"]]]);
  const aborted = AbortSignal.abort(new Error("stop"));
  await assert.rejects(call(RecvTool(host), {}, aborted), /stop/);
  await assert.rejects(
    call(RecvTool(host), { extra: 1 }),
    /^Error: Invalid recv input/,
  );
  await assert.rejects(
    call(RecvTool()),
    /recv requires an agentNode graph host/,
  );
  assert.equal(host.consumed, 0);
  assert.deepEqual(host.view.messages.get("m"), ["kept"]);
});

function wiredGraph() {
  // Admission only: emit never consults the scheduler, so it is never driven.
  const graph = new DataflowGraph({ create() {} }, Width(1), UNBOUNDED);
  const step = async function* () {
    yield [];
  };
  const a = graph.addNode({ id: NodeId("a"), state: undefined, step });
  const b = graph.addNode({ id: NodeId("b"), state: undefined, step });
  const out = messageEdge("a->b");
  graph.addEdge(a, b, out);
  graph.addEdge(a, b, valueEdge("a=>b"));
  graph.addEdge(b, a, messageEdge("b->a"));
  return { graph, out, host: { send: (message) => graph.emit(a, message) } };
}

test("send admits one message on a real outgoing message edge, keeping the payload reference", async () => {
  const { out, host } = wiredGraph();
  const payload = { kind: "prompt", text: "go" };
  const result = await call(SendTool(host), { id: "a->b", payload });
  assert.equal(result.content[0].text, "Message sent.");
  assert.equal(result.details, undefined);
  assert.equal(out.transport.left.length, 1);
  assert.equal(out.transport.left[0], payload);
});

test("send propagates admission errors for unwired, incoming-only and value edges", async () => {
  const { out, host } = wiredGraph();
  const tool = SendTool(host);
  for (const id of ["nowhere", "b->a"])
    await assert.rejects(call(tool, { id, payload: 1 }), /unwired edge/);
  await assert.rejects(call(tool, { id: "a=>b", payload: 1 }), /value edge/);
  assert.equal(out.transport.left.length, 0);
});

test("send rejects invalid, unhosted and cancelled calls without emitting", async () => {
  const { out, host } = wiredGraph();
  await assert.rejects(
    call(SendTool(host), { id: "a->b" }),
    /^Error: Invalid send input/,
  );
  await assert.rejects(
    call(SendTool(host), { id: "a->b", payload: 1, to: "b" }),
    /^Error: Invalid send input/,
  );
  await assert.rejects(
    call(SendTool(), { id: "a->b", payload: 1 }),
    /send requires an agentNode graph host/,
  );
  await assert.rejects(
    call(SendTool(host), { id: "a->b", payload: 1 }, AbortSignal.abort()),
    { name: "AbortError" },
  );
  assert.equal(out.transport.left.length, 0);
});

test("info rejects model-supplied identity and absent hosts, and preserves host errors", async () => {
  let calls = 0;
  const details = { parents: [], children: [] };
  const tool = InfoTool({
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
  await assert.rejects(
    call(InfoTool()),
    /info requires an agentNode graph host/,
  );
  const failure = new Error("no contract");
  await assert.rejects(
    call(
      InfoTool({
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
  const host = inbox([[EdgeId("m"), ["kept"]]]);
  const recv = RecvTool();
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
      { ...SendTool() },
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
      { ...InfoTool() },
      { info: () => assert.fail("host reached") },
      "c",
      {},
      new AbortController().signal,
    ),
    TypeError,
  );
});
