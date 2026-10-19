import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { DummyTracer } from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { LockPolicy } from "junco-tools";
import { graph, trigger } from "../src/index.ts";

const quiet = new DummyTracer();
type Edge = graph.Edge<number, string>;
type Member = graph.nodes.Deterministic<number, string>;

function idle(started: Set<Member>): Member {
  const state: Member = new graph.nodes.Deterministic<number, string>(
    async function* () {
      started.add(state);
      yield [];
      return "idle";
    },
    LockPolicy,
  );
  return state;
}

const closedSource = () =>
  new graph.nodes.Source<number, string>(
    () => {
      throw new graph.DataflowDefinitionError(
        "Spawn fixture does not accept external input",
      );
    },
    { id: graph.NodeId.create("$source") },
  );

type Link = { readonly edge: Edge; readonly queue: number[] };
function linksOf(g: graph.JuncoGraph<number, string>): Map<string, Link> {
  const links = new Map<string, Link>();
  g.forEachLink((from, to, edge) => {
    if (E.isRight(edge.transport)) {
      assert.equal(to, "$sink");
      return;
    }
    links.set(`${from}->${to}`, { edge, queue: edge.transport.left });
  });
  return links;
}
function linkOf(links: Map<string, Link>, name: string): Link {
  const link = links.get(name);
  assert.ok(link, `link ${name} exists`);
  return link;
}

describe("graph.JuncoGraph.spawn", () => {
  test("one child per input, each with its own queue in each direction", async () => {
    const inputs = Object.freeze(["repeat", "repeat"]);
    const calls: string[] = [];
    const started = new Set<Member>();
    const root = idle(started);
    const children: Member[] = [];
    const source = closedSource();
    const final = graph.Edge.value<number, string>("0->$sink");
    const sink: graph.nodes.Sink<number, string> = new graph.nodes.Sink<
      number,
      string
    >(
      async function* (): graph.NodeGenerator<number, string> {
        yield [];
        const result = execution.graph.result(graph.NodeId.create("0"));
        assert.ok(O.isSome(result));
        return result.value;
      },
      {
        id: graph.NodeId.create("$sink"),
        trigger: trigger.TriggerRule.when(final),
      },
    );
    const execution = graph.JuncoGraph.spawn(
      source,
      sink,
      {
        trigger: trigger.TriggerRule.never(),
        state: root,
      },
      inputs,
      (input) => {
        calls.push(input);
        const child = idle(started);
        children.push(child);
        return { trigger: trigger.TriggerRule.never(), state: child };
      },
      quiet,
    );
    const g = execution.graph;
    g.addEdge(graph.NodeId.create("0"), sink.id, final);
    try {
      assert.deepEqual(calls, inputs);
      const nodes: [string, graph.nodes.Agentic<number, string>][] = [];
      g.forEachNode((id, node) => nodes.push([id, node.state]));
      assert.deepEqual(nodes, [
        ["$source", source],
        ["$sink", sink],
        ["0", root],
        ["1", children[0]],
        ["2", children[1]],
      ]);
      assert.notEqual(children[0], children[1]);
      const links = linksOf(g);
      assert.deepEqual([...links.keys()].sort(), [
        "0->1",
        "0->2",
        "1->0",
        "2->0",
      ]);
      const topology: [string, string, string, string][] = [];
      g.forEachLink((from, to, edge) =>
        topology.push([
          from,
          to,
          edge.id,
          E.isLeft(edge.transport) ? "message" : "value",
        ]),
      );
      assert.deepEqual(topology.at(-1), ["0", "$sink", "0->$sink", "value"]);
      const all = [...links.values()];
      assert.equal(new Set(all.map(({ edge }) => edge)).size, 4);
      assert.equal(new Set(all.map(({ queue }) => queue)).size, 4);
      for (const [name, { edge }] of links) assert.equal(edge.id, name);
      const down1 = linkOf(links, "0->1");
      const up1 = linkOf(links, "1->0");
      const down2 = linkOf(links, "0->2");
      const up2 = linkOf(links, "2->0");
      g.emit(graph.NodeId.create("0"), graph.Message.create(down1.edge, 10));
      g.emit(graph.NodeId.create("0"), graph.Message.create(down1.edge, 11));
      g.emit(graph.NodeId.create("1"), graph.Message.create(up1.edge, 20));
      g.emit(graph.NodeId.create("2"), graph.Message.create(up2.edge, 30));
      assert.deepEqual([...down1.queue], [10, 11]);
      assert.deepEqual([...up1.queue], [20]);
      assert.deepEqual([...down2.queue], []);
      assert.deepEqual([...up2.queue], [30]);
      assert.equal(started.size, 0);
    } finally {
      await g.close();
    }
    for (const state of [root, ...children]) assert.ok(state.signal.aborted);
  });

  test("members exchange caller-defined messages over the spawned queues", async () => {
    const names = Object.freeze(["left", "right"] as const);
    type Name = (typeof names)[number];
    const request: Record<Name, Edge> = {
      left: graph.Edge.message("root->left"),
      right: graph.Edge.message("root->right"),
    };
    const reply: Record<Name, Edge> = {
      left: graph.Edge.message("left->root"),
      right: graph.Edge.message("right->root"),
    };
    const received: Record<Name, number[]> = { left: [], right: [] };
    const closed = { root: false, left: false, right: false };
    const rootId = graph.NodeId.create("root");
    const root = new graph.nodes.Deterministic<number, string>(
      async function* () {
        try {
          let view = yield [];
          while (true) {
            for (const name of names)
              received[name].push(...graph.from(view, reply[name]));
            if (received.left.length === 2 && received.right.length === 2)
              return "root-done";
            view = yield [];
          }
        } finally {
          closed.root = true;
        }
      },
      LockPolicy,
    );
    const source = closedSource();
    const final = graph.Edge.value<number, string>("root->$sink");
    const sink: graph.nodes.Sink<number, string> = new graph.nodes.Sink<
      number,
      string
    >(
      async function* (): graph.NodeGenerator<number, string> {
        yield [];
        const result = execution.graph.result(rootId);
        assert.ok(O.isSome(result));
        return result.value;
      },
      {
        id: graph.NodeId.create("$sink"),
        trigger: trigger.TriggerRule.when(final),
      },
    );
    const execution = graph.JuncoGraph.spawn(
      source,
      sink,
      {
        id: rootId,
        trigger: trigger.TriggerRule.anyOf(
          trigger.TriggerEntry.on(reply.left),
          trigger.TriggerEntry.on(reply.right),
        ),
        state: root,
      },
      names,
      (name) => ({
        id: graph.NodeId.create(name),
        trigger: trigger.TriggerRule.when(request[name]),
        state: new graph.nodes.Deterministic<number, string>(
          async function* () {
            try {
              let view = yield [];
              while (true)
                view = yield graph
                  .from(view, request[name])
                  .map((value) => graph.Message.create(reply[name], value + 1));
            } finally {
              closed[name] = true;
            }
          },
          LockPolicy,
        ),
      }),
      quiet,
    );
    const g = execution.graph;
    g.addEdge(rootId, sink.id, final);
    try {
      const links = linksOf(g);
      assert.deepEqual([...links.keys()].sort(), [
        "left->root",
        "right->root",
        "root->left",
        "root->right",
      ]);
      g.emit(rootId, graph.Message.create(request.left, 10));
      g.emit(rootId, graph.Message.create(request.left, 11));
      g.emit(rootId, graph.Message.create(request.right, 20));
      g.emit(rootId, graph.Message.create(request.right, 21));
      const results = await execution.run({
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(results.get(rootId), "root-done");
      assert.equal(results.get(sink.id), results.get(rootId));
      assert.deepEqual(received, { left: [11, 12], right: [21, 22] });
      for (const { queue } of links.values()) assert.deepEqual([...queue], []);
    } finally {
      await g.close();
    }
    assert.deepEqual(closed, { root: true, left: true, right: true });
  });

  test("no inputs leaves the root and its real sink", async () => {
    const calls: string[] = [];
    const root = new graph.nodes.Deterministic<number, string>(
      async function* () {
        yield [];
        return "solo";
      },
      LockPolicy,
    );
    const source = closedSource();
    const final = graph.Edge.value<number, string>("0->$sink");
    const sink: graph.nodes.Sink<number, string> = new graph.nodes.Sink<
      number,
      string
    >(
      async function* (): graph.NodeGenerator<number, string> {
        yield [];
        const result = execution.graph.result(graph.NodeId.create("0"));
        assert.ok(O.isSome(result));
        return result.value;
      },
      {
        id: graph.NodeId.create("$sink"),
        trigger: trigger.TriggerRule.when(final),
      },
    );
    const execution = graph.JuncoGraph.spawn(
      source,
      sink,
      { trigger: trigger.TriggerRule.always(), state: root },
      [] as readonly string[],
      (input) => {
        calls.push(input);
        return { trigger: trigger.TriggerRule.never(), state: idle(new Set()) };
      },
      quiet,
    );
    const g = execution.graph;
    g.addEdge(graph.NodeId.create("0"), sink.id, final);
    try {
      const nodes: string[] = [];
      g.forEachNode((id) => nodes.push(id));
      assert.deepEqual(nodes, ["$source", "$sink", "0"]);
      assert.equal(linksOf(g).size, 0);
      const results = await execution.run({
        signal: AbortSignal.timeout(5000),
      });
      assert.deepEqual(
        [...results],
        [
          ["0", "solo"],
          ["$sink", "solo"],
        ],
      );
      assert.equal(results.get(sink.id), results.get(graph.NodeId.create("0")));
      assert.deepEqual(calls, []);
    } finally {
      await g.close();
    }
  });

  test("a factory error escapes as-is and unpublished ports remain reusable", async () => {
    const failure = new Error("spawn failed");
    const visited: string[] = [];
    const started = new Set<Member>();
    const root = idle(started);
    const created: Member[] = [];
    const source = closedSource();
    const final = graph.Edge.value<number, string>("0->$sink");
    const sink: graph.nodes.Sink<number, string> = new graph.nodes.Sink<
      number,
      string
    >(
      async function* (): graph.NodeGenerator<number, string> {
        yield [];
        const result = retry.graph.result(graph.NodeId.create("0"));
        assert.ok(O.isSome(result));
        return result.value;
      },
      {
        id: graph.NodeId.create("$sink"),
        trigger: trigger.TriggerRule.when(final),
      },
    );
    try {
      assert.throws(
        () =>
          graph.JuncoGraph.spawn(
            source,
            sink,
            { trigger: trigger.TriggerRule.never(), state: root },
            ["a", "b", "c"],
            (input) => {
              visited.push(input);
              if (input === "b") throw failure;
              const child = idle(started);
              created.push(child);
              return { trigger: trigger.TriggerRule.never(), state: child };
            },
            quiet,
          ),
        (error) => error === failure,
      );
      assert.deepEqual(visited, ["a", "b"]);
      assert.equal(created.length, 1);
      for (const state of [root, ...created]) assert.ok(!state.signal.aborted);
      assert.equal(started.size, 0);
    } catch (error) {
      for (const state of [root, ...created]) await state.close();
      throw error;
    }
    const retry = graph.JuncoGraph.spawn(
      source,
      sink,
      { trigger: trigger.TriggerRule.always(), state: root },
      [] as readonly string[],
      () => {
        throw new Error("empty input factory must not run");
      },
      quiet,
    );
    await using g = retry.graph;
    g.addEdge(graph.NodeId.create("0"), sink.id, final);
    assert.equal((await retry.run()).get(sink.id), "idle");
    for (const state of created) await state.close();
  });

  test("a child reusing the root's explicit id is a definition error", async () => {
    const rootId = graph.NodeId.create("root");
    const visited: string[] = [];
    const root = idle(new Set());
    const created: Member[] = [];
    const source = closedSource();
    const final = graph.Edge.value<number, string>("root->$sink");
    const sink: graph.nodes.Sink<number, string> = new graph.nodes.Sink<
      number,
      string
    >(
      async function* (): graph.NodeGenerator<number, string> {
        yield [];
        const result = retry.graph.result(rootId);
        assert.ok(O.isSome(result));
        return result.value;
      },
      {
        id: graph.NodeId.create("$sink"),
        trigger: trigger.TriggerRule.when(final),
      },
    );
    try {
      assert.throws(
        () =>
          graph.JuncoGraph.spawn(
            source,
            sink,
            { id: rootId, trigger: trigger.TriggerRule.never(), state: root },
            ["a", "b"],
            (input) => {
              visited.push(input);
              const child = idle(new Set());
              created.push(child);
              return {
                id: rootId,
                trigger: trigger.TriggerRule.never(),
                state: child,
              };
            },
            quiet,
          ),
        graph.DataflowDefinitionError,
      );
      assert.deepEqual(visited, ["a"]);
      for (const state of [root, ...created])
        assert.equal(state.signal.aborted, false);
    } catch (error) {
      for (const state of [root, ...created]) await state.close();
      throw error;
    }
    const retry = graph.JuncoGraph.spawn(
      source,
      sink,
      { id: rootId, trigger: trigger.TriggerRule.always(), state: root },
      [] as readonly string[],
      () => {
        throw new Error("empty input factory must not run");
      },
      quiet,
    );
    await using g = retry.graph;
    g.addEdge(rootId, sink.id, final);
    assert.equal((await retry.run()).get(sink.id), "idle");
    for (const state of created) await state.close();
  });
});
